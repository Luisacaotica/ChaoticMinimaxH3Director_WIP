"""Chaotic MinimaxH3 Director — ComfyUI node classes.

ChaoticDirector: the timeline orchestrator.  Renders the whole authored scene
one VRAM-safe chunk at a time (strict unload/reload between chunks), stitches
the result into one continuous clip, and outputs IMAGE + AUDIO exactly like
the reference workflow's VAEDecode + VAEDecodeAudio chain, so the standard
CreateVideo / SaveVideo nodes consume it unchanged.

ChaoticPromptAssembler: pure, no-model companion node that shows the exact
per-chunk prompts the Director would emit — for testing prompt quality without
spending a single GPU cycle.
"""

from __future__ import annotations

import copy
import json
from typing import Optional

import comfy.samplers
import nodes
import torch

from .chunking import (
    align_frame_count,
    attach_storyboard,
    build_tag_map,
    plan_chunks,
)
from .engine import ChunkRenderer
from .mockup import default_scene_json, parse_scene, render_scene
from .prompt_assembly import assemble_chunk_prompt
from .radio_play import DEFAULT_RADIO_SCRIPT, plan_radio_play
from .stitching import as_video_batch, stitch_chunks
from .video_edit import (
    VOID_COLORS,
    build_masks,
    checkerboard_preview,
    chroma_key,
    composite_patch,
    crop_plate,
    decode_refs,
    default_edit_json,
    detect_key_color,
    effective_mask,
    load_video_file,
    mask_bbox,
    masked_plate,
    overlay_preview,
    parse_edit_data,
    reframe_plate,
)
from .timeline import (
    assign_global_tags,
    default_timeline_json,
    parse_timeline,
    slice_timeline,
    timeline_issues,
)
from . import vrma


def _log(message: str) -> None:
    print(f"[Chaotic H3 Director] {message}", flush=True)


def _sub_timeline_from(timeline, start_sec: float):
    """A timeline copy covering only [start_sec, end), with times re-based."""
    sub = copy.deepcopy(timeline)
    sub.shots = [shot for shot in sub.shots if shot.end > start_sec + 1e-6]
    for shot in sub.shots:
        shot.start = max(0.0, shot.start - start_sec)
    sub.refs = [ref for ref in sub.refs if (not ref.timed) or ref.end > start_sec + 1e-6]
    for ref in sub.refs:
        ref.start = max(0.0, ref.start - start_sec)
    sub.pinned_boundaries = [b - start_sec for b in sub.pinned_boundaries if b > start_sec + 1e-6]
    return sub


class ChaoticDirector:
    """Full timeline → chunked render → stitched clip (see module docstring)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 1000}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "round": 0.01}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "exp_heun_2_x0_sde"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "sgm_uniform"}),
                "width": ("INT", {"default": 1344, "min": 32, "max": nodes.MAX_RESOLUTION, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": nodes.MAX_RESOLUTION, "step": 32}),
                "fps": ("INT", {"default": 24, "min": 1, "max": 120}),
                "chunk_mode": (["fixed", "auto"], {"default": "fixed"}),
                "chunk_seconds": ("FLOAT", {"default": 5.0, "min": 0.5, "max": 60.0, "step": 0.5}),
                "continuity": (
                    ["keyframe+picture", "picture", "keyframe", "none"],
                    {
                        "default": "keyframe+picture",
                        "tooltip": (
                            "How chunk seams are bridged. keyframe+picture: previous chunk's last "
                            "frame is both a geometric I2VA keyframe (frame 0 is pixel-exact) and a "
                            "<Picture N> ref. picture: ref only (softer, matches classic H3 workflows). "
                            "keyframe: geometry only. none: no anchor, hard cut."
                        ),
                    },
                ),
                "video_context": ("BOOLEAN", {"default": False}),
                "ref_image_size": (["match", "max"], {"default": "match"}),
                "timeline_data": (
                    "STRING",
                    {"default": default_timeline_json(), "multiline": True, "hidden": True},
                ),
            },
            "optional": {
                "sampler": ("SAMPLER",),
                "sigmas": ("SIGMAS",),
                "mockup": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "Optional storyboard from the Chaotic H3 Mockup Editor ([1, F, H, W, 3] "
                            "frames). When wired, every chunk gets its slice of the mockup as a "
                            "fully_preserved <Video N> reference that H3 must interpret faithfully."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "STRING", "INT", "INT")
    RETURN_NAMES = ("images", "audio", "chunk_prompts_json", "total_frames", "chunk_count")
    FUNCTION = "render"
    CATEGORY = "Chaotic/H3 Director"
    DESCRIPTION = (
        "Timeline-based MiniMax H3 director. Renders a full multi-shot scene as "
        "sequential VRAM-safe chunks (with a full model unload + cache clear "
        "between every chunk), auto-anchors each seam to the previous chunk's "
        "final frame, and stitches the result into one continuous video+audio clip."
    )

    def render(
        self,
        model, clip, vae, audio_vae,
        seed, steps, cfg, sampler_name, scheduler,
        width, height, fps,
        chunk_mode, chunk_seconds, continuity, video_context, ref_image_size,
        timeline_data,
        sampler=None, sigmas=None, mockup=None,
    ):
        fps = max(1, min(120, int(fps)))
        timeline = parse_timeline(timeline_data)
        if timeline.render_in is not None or timeline.render_out is not None:
            _log(
                f"render window set: {timeline.render_in or 0.0:.2f}s → "
                f"{timeline.render_out if timeline.render_out is not None else 'end'}"
                "s — slicing the timeline for this render"
            )
            timeline = slice_timeline(timeline, timeline.render_in, timeline.render_out)
        for issue in timeline_issues(timeline):
            _log(f"WARNING: {issue}")

        if chunk_mode == "auto":
            target_frames = vrma.choose_auto_frames(fps)
            _log(
                f"auto chunk sizing: {target_frames} frames (~{target_frames / fps:.2f}s) "
                "- learned from this session's runs"
            )
        else:
            target_frames = align_frame_count(max(5, int(round(float(chunk_seconds) * fps))))
            _log(f"fixed chunk sizing: {target_frames} frames (~{target_frames / fps:.2f}s)")

        plans = plan_chunks(timeline, target_frames, fps, continuity, video_context)
        storyboard_feed = None
        if mockup is not None:
            if getattr(mockup, "ndim", 0) != 5:
                raise ValueError(
                    "Chaotic H3 Director: `mockup` must be the Mockup Editor's "
                    "[1, F, H, W, 3] IMAGE output "
                    f"(got shape {tuple(mockup.shape)})."
                )
            storyboard_feed = mockup[0].detach().cpu().float()  # [F, H, W, 3]
            attach_storyboard(plans)
            total_needed = sum(p.frames for p in plans)
            if storyboard_feed.shape[0] < total_needed:
                _log(
                    f"WARNING: mockup has {storyboard_feed.shape[0]} frames but this render needs "
                    f"{total_needed} — the final chunk(s) will render without the storyboard."
                )
            else:
                _log(
                    f"mockup storyboard wired: {len(plans)} chunks will interpret its "
                    f"composition/motion (total {total_needed} frames used)."
                )
        _log("planned chunks: " + ", ".join(
            f"#{p.index + 1} start={p.start_sec:.2f}s frames={p.frames}" for p in plans
        ))

        global_tags = assign_global_tags(timeline)
        renderer = ChunkRenderer(
            model, clip, vae, audio_vae, width, height, fps,
            sampler_obj=sampler, sampler_name=sampler_name, scheduler=scheduler,
            steps=steps, cfg=cfg, ref_image_size=ref_image_size,
            sigmas=sigmas,
        )
        use_keyframe = continuity in ("keyframe+picture", "keyframe")
        drop_seam = use_keyframe
        seed = int(seed)

        completed = []
        chunk_prompts = []
        anchor_image = None
        prev_chunk_frames = None
        all_log = []
        shrink_count = 0
        current_plans = plans
        failed_start: float = 0.0
        total_chunks = len(plans)

        while current_plans:
            try:
                for plan_chunk in current_plans:
                    failed_start = plan_chunk.start_sec
                    mockup_slice = None
                    if storyboard_feed is not None:
                        cum = sum(r["frames"].shape[0] for r in completed)
                        if cum + plan_chunk.frames <= storyboard_feed.shape[0]:
                            mockup_slice = storyboard_feed[cum:cum + plan_chunk.frames]
                        else:
                            # Mockup ran out: drop the storyboard entry for this
                            # chunk so its prompt never references a video that
                            # is not actually provided.
                            plan_chunk.ref_entries = [
                                e for e in plan_chunk.ref_entries if not e.is_storyboard
                            ]
                            plan_chunk.storyboard_tag = None
                    tag_map = build_tag_map(timeline, plan_chunk, global_tags)
                    bundle = assemble_chunk_prompt(
                        timeline, plan_chunk.index, plan_chunk.start_sec,
                        plan_chunk.shots, plan_chunk.ref_entries,
                        plan_chunk.anchor_tag, global_tags, tag_map,
                    )
                    chunk_prompts.append({
                        "chunk": plan_chunk.index + 1,
                        "start_sec": plan_chunk.start_sec,
                        "duration_sec": plan_chunk.duration_sec,
                        "frames": plan_chunk.frames,
                        "prompt": bundle.prompt,
                        "issues": bundle.issues + plan_chunk.issues,
                    })
                    for issue in bundle.issues + plan_chunk.issues:
                        _log(f"  chunk {plan_chunk.index + 1}: {issue}")

                    vrma.reset_peak_stats()
                    result = renderer.render_chunk(
                        plan_chunk, bundle.prompt, seed + plan_chunk.index,
                        anchor_image, prev_chunk_frames if video_context else None,
                        use_keyframe,
                        storyboard_frames=mockup_slice,
                    )
                    peak = vrma.peak_allocated_bytes()
                    free, _ = vrma.probe_free_bytes()
                    vrma.record_success(plan_chunk.frames, peak, free)
                    all_log.extend(f"  chunk {plan_chunk.index + 1}: {line}" for line in result["log"])

                    # Detach to CPU before the next chunk so VRAM returns to baseline.
                    result["frames"] = result["frames"].detach().cpu()
                    result["audio"]["waveform"] = result["audio"]["waveform"].detach().cpu()
                    anchor_image = result["frames"][-1][None, ...]
                    prev_chunk_frames = result["frames"]
                    completed.append(result)

                    _log(
                        f"chunk {plan_chunk.index + 1}/{total_chunks} rendered OK "
                        f"(peak {peak / 1e9:.2f} GB VRAM, free {free / 1e9:.2f} GB)"
                        if free else f"chunk {plan_chunk.index + 1}/{total_chunks} rendered OK"
                    )

                    if plan_chunk is not current_plans[-1]:
                        vrma.unload_for_next_chunk()
                current_plans = []
            except Exception as exc:
                if not vrma.is_oom(exc) or shrink_count >= 2:
                    _log(f"render failed: {exc}")
                    raise
                shrink_count += 1
                _log(f"OUT OF MEMORY on chunk starting at {failed_start:.2f}s — shrinking chunks and retrying remaining timeline")
                vrma.unload_for_next_chunk()
                new_target = vrma.shrink_frames(target_frames)
                target_frames = new_target
                sub = _sub_timeline_from(timeline, failed_start)
                new_plans = plan_chunks(sub, new_target, fps, continuity, video_context)
                for index, plan_chunk in enumerate(new_plans):
                    plan_chunk.index = len(completed) + index
                if storyboard_feed is not None:
                    attach_storyboard(new_plans)
                current_plans = new_plans

        stitched = stitch_chunks(completed, fps, drop_seam)
        if stitched["dropped_seam_frames"]:
            _log(
                f"stitched {len(completed)} chunks into {stitched['frames'].shape[0]} frames "
                f"(dropped {stitched['dropped_seam_frames']} seam duplicates)"
            )
        else:
            _log(f"stitched {len(completed)} chunks into {stitched['frames'].shape[0]} frames")

        total_frames = int(stitched["frames"].shape[0])
        report = {
            "chunks": chunk_prompts,
            "total_frames": total_frames,
            "total_seconds": round(total_frames / fps, 3),
            "log": all_log,
        }
        return (
            as_video_batch(stitched["frames"]),  # [1, F, H, W, 3] — VAEDecode convention
            stitched["audio"],
            json.dumps(report, ensure_ascii=False, indent=2),
            total_frames,
            len(chunk_prompts),
        )


class ChaoticH3MockupEditor:
    """2.5D puppet stage: compose sprites/text/video layers, keyframe their
    transforms over time, and render the animation to frames that the Director
    consumes as a storyboard `mockup` — MiniMax H3 then interprets the mockup's
    composition, positions, layering and motion as the authoritative staging.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1280, "min": 64, "max": nodes.MAX_RESOLUTION, "step": 64}),
                "height": ("INT", {"default": 720, "min": 64, "max": nodes.MAX_RESOLUTION, "step": 64}),
                "fps": ("INT", {"default": 24, "min": 1, "max": 120}),
                "duration_sec": ("FLOAT", {"default": 6.0, "min": 0.5, "max": 120.0, "step": 0.5}),
                "scene_data": (
                    "STRING",
                    {"default": default_scene_json(), "multiline": True, "hidden": True},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "INT")
    RETURN_NAMES = ("images", "scene_json", "frame_count")
    FUNCTION = "render"
    CATEGORY = "Chaotic/H3 Director"
    DESCRIPTION = (
        "Mockup/puppet stage: layer PNG sprites, text, and video clips, keyframe "
        "their position/scale/rotation/opacity over time, and render the crude "
        "animation to frames. Wire the IMAGE output into the Director's `mockup` "
        "input so MiniMax H3 interprets it as the storyboard for the final clip."
    )

    def render(self, width, height, fps, duration_sec, scene_data):
        scene = parse_scene(scene_data)
        frames, warnings = render_scene(scene, width, height, fps, duration_sec)
        for warning in warnings:
            _log("WARNING: " + warning)
        return (
            frames,              # [1, F, H, W, 3] — Director mockup convention
            scene_data,
            int(frames.shape[1]),
        )


class ChaoticH3VideoEdit:
    """Video editing assistant: keyframed masks (brush/rect), masked plates
    (black/green void, full-frame or selection-crop), green-screen chroma keying
    to RGBA, and inspectable previews.  It never renders with a diffusion model
    itself — wire the plates into your existing H3 graph (or the Director) and
    put the patched clip back with the ChaoticH3CompositePatch node.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "fps": ("INT", {"default": 24, "min": 1, "max": 120}),
                "edit_data": (
                    "STRING",
                    {"default": default_edit_json(), "multiline": True, "hidden": True},
                ),
            },
            "optional": {
                "video": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "The video to edit ([B,F,H,W,3] or [F,H,W,3]). "
                            "When omitted, the widget's loaded file is used."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "IMAGE", "INT", "INT", "INT", "INT", "STRING", "IMAGE")
    RETURN_NAMES = (
        "images", "crop_images", "mask", "masked_preview",
        "box_x", "box_y", "box_w", "box_h", "meta", "ref_images",
    )
    FUNCTION = "render"
    CATEGORY = "Chaotic/H3 Director"
    DESCRIPTION = (
        "Keyframed mask + plate builder for video editing: brush/rect masks over "
        "time, masked plates on a black/green void (full-frame or selection-crop), "
        "reframe mode (outpaint the outside of a target aspect ratio — 9:16 to "
        "16:9 and beyond, with brush-preserved edge crossings), green-screen chroma "
        "key to RGBA, copy-to-reference region grabs on `ref_images`, and previews. "
        "The fps widget is the fixed latent frame rate (default 24) — keep it in "
        "sync with your source clip. Feed the plates into an H3 graph, then "
        "composite the patch back with ChaoticH3CompositePatch."
    )

    def render(self, fps, edit_data, video=None):
        import folder_paths  # noqa: PLC0415

        edit = parse_edit_data(edit_data)
        fps = max(1, min(120, int(fps)))
        if video is not None:
            vid = video.float()
            if vid.dim() == 5:
                vid = vid[0]
            if vid.dim() != 4 or vid.shape[3] not in (3, 4):
                raise ValueError(
                    "Chaotic H3 Video Edit: `video` must be [B,F,H,W,C] or [F,H,W,C] "
                    f"(got shape {tuple(video.shape)})"
                )
            vid = vid.detach().cpu()
        elif edit.get("video_file"):
            path = folder_paths.get_annotated_filepath(edit["video_file"])
            vid = load_video_file(path)
        else:
            raise ValueError(
                "Chaotic H3 Video Edit: wire a `video` input or load a file in the widget first."
            )
        F, H, W = vid.shape[0], vid.shape[1], vid.shape[2]
        vfps = edit.get("video_fps")
        if vfps and abs(float(vfps) - fps) > 1.0:
            _log(
                f"WARNING: source video runs at ~{vfps:g} fps but the node renders at "
                f"{fps} fps — mask key times will drift. Set the fps widget to match "
                "the file, or re-encode the clip."
            )
        meta = {
            "mode": edit["mode"],
            "fps": fps,
            "video_fps": vfps,
            "frames": F,
            "width": W,
            "height": H,
        }
        refs = decode_refs(edit.get("refs", []))
        if refs:
            ref_images = torch.stack(refs)
            meta["ref_count"] = len(refs)
            _log(f"copy-to-reference: {len(refs)} reference crop(s) on the `ref_images` output")
        else:
            ref_images = torch.zeros(1, 1, 1, 3)

        if edit["mode"] == "reframe":
            color = VOID_COLORS[edit["plate_color"]]
            # painted strokes = preserve regions (people/objects crossing the edge)
            preserve = effective_mask(build_masks(edit, fps, F, H, W), "inside")
            plate, eff, box = reframe_plate(vid, edit["reframe"], color, preserve, fps)
            preview = overlay_preview(plate, eff)
            track = edit["reframe"].get("track") or []
            meta.update({
                "target_w": edit["reframe"]["target_w"],
                "target_h": edit["reframe"]["target_h"],
                "feather": edit["reframe"]["feather"],
                "align_x": edit["reframe"]["align_x"],
                "align_y": edit["reframe"]["align_y"],
                "scale": edit["reframe"]["scale"],
                "rotation": edit["reframe"]["rotation"],
                "fit": edit["reframe"].get("fit", "contain"),
                "track_keys": len(track),
                "track": track if track else None,
                "source_box": list(box),
                "note": (
                    "reframed canvas — outpaint the outside window (mask=1). "
                    "Brush preserve strokes over people/objects crossing the edge. "
                    "Composite the result back with ChaoticH3CompositePatch, box (0,0,tw,th)."
                ),
            })
            return (
                plate, plate, eff, preview,
                box[0], box[1], box[2], box[3],
                json.dumps(meta, ensure_ascii=False, indent=2),
                ref_images,
            )

        if edit["mode"] == "chroma":
            color = edit["chroma"]["color"]
            auto = bool(edit["chroma"].get("auto"))
            coverage: Optional[float] = None
            if auto and vid.shape[0] > 0:
                color, coverage = detect_key_color(vid[0])
                _log(
                    f"auto key color {[round(c, 3) for c in color]} — "
                    f"dominant on {coverage * 100:.0f}% of the frame border"
                )
                if coverage < 0.2:
                    _log("WARNING: low key-color coverage — is the backdrop flat and consistent?")
            rgba, alpha = chroma_key(
                vid, color,
                edit["chroma"]["similarity"], edit["chroma"]["smooth"], edit["chroma"]["spill"],
            )
            preview = checkerboard_preview(rgba)
            note = "chroma keyed — RGBA IMAGE on `images`, alpha MASK on `mask`"
            if auto and coverage is not None:
                note += f" | auto key color {color} ({coverage * 100:.0f}% coverage)"
            meta.update({"note": note, "key_color": color, "auto": auto, "coverage": coverage})
            return (
                rgba, rgba, alpha, preview,
                0, 0, W, H,
                json.dumps(meta, ensure_ascii=False, indent=2),
                ref_images,
            )

        masks = build_masks(edit, fps, F, H, W)
        eff = effective_mask(masks, edit["edit"])
        color = VOID_COLORS[edit["plate_color"]]
        plate = masked_plate(vid, eff, color)
        preview = overlay_preview(vid, eff)
        box = mask_bbox(eff)
        if box == (0, 0, 0, 0):
            _log("WARNING: no masked region found — check the mask keyframes")
        if edit["output"] == "crop" and box != (0, 0, 0, 0):
            crop = crop_plate(plate, box, edit["crop_scale"], color)
        else:
            crop = plate
        meta.update({
            "edit": edit["edit"],
            "plate_color": edit["plate_color"],
            "output": edit["output"],
            "crop_scale": edit["crop_scale"],
            "outpaint": edit["outpaint"],
            "crop_box": list(box),
        })
        return (
            plate, crop, eff, preview,
            box[0], box[1], box[2], box[3],
            json.dumps(meta, ensure_ascii=False, indent=2),
            ref_images,
        )


class ChaoticH3CompositePatch:
    """Paste an AI-patched clip back onto the source video.

    * Full-frame patches: box (0, 0, 0, 0) pastes over the whole frame.
    * Cropped patches: pass the Video Edit node's box_x/y/w/h (its crop_box);
      the patch is resized to that box.
    * Wire the Video Edit node's `mask` output to only replace the edited
      region; leave `mask` unwired to paste the entire patch (outpainting).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base": ("IMAGE",),
                "patch": ("IMAGE",),
                "box_x": ("INT", {"default": 0, "min": 0, "max": nodes.MAX_RESOLUTION}),
                "box_y": ("INT", {"default": 0, "min": 0, "max": nodes.MAX_RESOLUTION}),
                "box_w": ("INT", {"default": 0, "min": 0, "max": nodes.MAX_RESOLUTION}),
                "box_h": ("INT", {"default": 0, "min": 0, "max": nodes.MAX_RESOLUTION}),
            },
            "optional": {
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "composite"
    CATEGORY = "Chaotic/H3 Director"

    def composite(self, base, patch, box_x, box_y, box_w, box_h, mask=None):
        out = composite_patch(base, patch, mask, (box_x, box_y, box_w, box_h))
        _log(f"composited patch ({patch.shape[0]} frames) over {box_w}x{box_h} at ({box_x},{box_y})")
        return (out,)


class ChaoticPromptAssembler:
    """Inspect the exact prompts the Director would emit, without rendering."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "timeline_data": (
                    "STRING",
                    {"default": default_timeline_json(), "multiline": True},
                ),
                "fps": ("INT", {"default": 24, "min": 1, "max": 120}),
                "chunk_seconds": ("FLOAT", {"default": 5.0, "min": 0.5, "max": 60.0, "step": 0.5}),
                "continuity": (["keyframe+picture", "picture", "keyframe", "none"], {"default": "keyframe+picture"}),
                "video_context": ("BOOLEAN", {"default": False}),
                "format_override": (["from_timeline", "official", "narrative"], {"default": "from_timeline"}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = ("assembled_prompt", "chunk_plan_json", "chunk_count", "issues")
    FUNCTION = "assemble"
    CATEGORY = "Chaotic/H3 Director"

    def assemble(self, timeline_data, fps, chunk_seconds, continuity, video_context, format_override):
        fps = max(1, min(120, int(fps)))
        timeline = parse_timeline(timeline_data)
        if timeline.render_in is not None or timeline.render_out is not None:
            timeline = slice_timeline(timeline, timeline.render_in, timeline.render_out)
        target_frames = align_frame_count(max(5, int(round(float(chunk_seconds) * fps))))
        plans = plan_chunks(timeline, target_frames, fps, continuity, video_context)
        global_tags = assign_global_tags(timeline)

        assembled = []
        plan_view = []
        all_issues = list(timeline_issues(timeline))
        for plan_chunk in plans:
            fmt = None if format_override == "from_timeline" else format_override
            tag_map = build_tag_map(timeline, plan_chunk, global_tags)
            bundle = assemble_chunk_prompt(
                timeline, plan_chunk.index, plan_chunk.start_sec,
                plan_chunk.shots, plan_chunk.ref_entries,
                plan_chunk.anchor_tag, global_tags, tag_map, fmt,
            )
            assembled.append({
                "chunk": plan_chunk.index + 1,
                "start_sec": plan_chunk.start_sec,
                "duration_sec": plan_chunk.duration_sec,
                "frames": plan_chunk.frames,
                "prompt": bundle.prompt,
                "issues": bundle.issues + plan_chunk.issues,
            })
            plan_view.append({
                "chunk": plan_chunk.index + 1,
                "start_sec": plan_chunk.start_sec,
                "frames": plan_chunk.frames,
                "shots": [shot.text[:80] for shot in plan_chunk.shots],
                "refs": [entry.tag for entry in plan_chunk.ref_entries],
                "anchor": plan_chunk.anchor_tag,
            })
            all_issues.extend(bundle.issues + plan_chunk.issues)

        issues_text = "\n".join(all_issues) if all_issues else "No issues."
        return (
            json.dumps(assembled, ensure_ascii=False, indent=2),
            json.dumps(plan_view, ensure_ascii=False, indent=2),
            len(plans),
            issues_text,
        )


class ChaoticRadioPlayPlanner:
    """Audio-only MiniMax H3 radio-play recipe planner (zero GPU).

    Turns a radio-play script into the community "radio play" recipe:
    32x32 audio-only latents, the script split into <=15 s segments on the
    17k+5 frame grid, word-budgeted dialogue (~2.5 words/s), voices bound to
    the reference-video *soundtrack* slots (<Video N>) with ref_audio left
    empty, and a full six-part Ref2VA prompt per segment with a
    byte-identical overall_soundscape so the seams hide.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "script": (
                    "STRING",
                    {"default": DEFAULT_RADIO_SCRIPT, "multiline": True},
                ),
                "fps": ("INT", {"default": 24, "min": 1, "max": 60}),
                "max_segment_seconds": ("FLOAT", {"default": 15.0, "min": 4.0, "max": 15.0, "step": 0.5}),
                "words_per_second": ("FLOAT", {"default": 2.5, "min": 1.5, "max": 4.0, "step": 0.1}),
                "voice_slots": ("INT", {"default": 3, "min": 1, "max": 6}),
                "music": ("STRING", {"default": "", "multiline": True}),
                "final_event": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = ("recipe_json", "segment_prompts", "segment_count", "issues")
    FUNCTION = "plan"
    CATEGORY = "Chaotic/H3 Director"

    def plan(self, script, fps, max_segment_seconds, words_per_second,
             voice_slots, music, final_event):
        recipe_json, prompts, count, issues = plan_radio_play(
            script_text=script,
            fps=int(fps),
            max_segment_seconds=float(max_segment_seconds),
            words_per_second=float(words_per_second),
            voice_slots=int(voice_slots),
            final_event=bool(final_event),
            music=music,
        )
        return (recipe_json, prompts, count, issues)


NODE_CLASS_MAPPINGS = {
    "ChaoticH3Director": ChaoticDirector,
    "ChaoticH3MockupEditor": ChaoticH3MockupEditor,
    "ChaoticH3VideoEdit": ChaoticH3VideoEdit,
    "ChaoticH3CompositePatch": ChaoticH3CompositePatch,
    "ChaoticH3PromptAssembler": ChaoticPromptAssembler,
    "ChaoticH3RadioPlayPlanner": ChaoticRadioPlayPlanner,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ChaoticH3Director": "Chaotic H3 Director (Timeline)",
    "ChaoticH3MockupEditor": "Chaotic H3 Mockup Editor",
    "ChaoticH3VideoEdit": "Chaotic H3 Video Edit",
    "ChaoticH3CompositePatch": "Chaotic H3 Composite Patch",
    "ChaoticH3PromptAssembler": "Chaotic H3 Prompt Assembler",
    "ChaoticH3RadioPlayPlanner": "Chaotic H3 Radio Play Planner",
}


# --------------------------------------------------------------------------- #
# Shared crops bundle API
# --------------------------------------------------------------------------- #
# The Video Edit widget exports its ⧉ Copy-to-ref crops here (POST); the
# Director and Mockup widgets fetch them (GET) to drop the crops into the
# reference library / stage as layers.  The manifest lives in the input dir so
# it survives reloads, and the uploads behind it use the same `/upload/image`
# endpoint the import buttons already use — so no crop is ever duplicated.


def _register_crops_api() -> None:
    """Attach the /chaotic_h3/crops routes to the live ComfyUI server.

    ComfyUI's main creates the PromptServer before custom nodes are imported,
    so `instance` is set exactly when these routes can be attached.  Outside a
    server (unit tests, standalone scripts) this is a clean no-op.
    """
    try:
        from aiohttp import web  # noqa: PLC0415
        from server import PromptServer  # noqa: PLC0415
    except Exception:  # noqa: BLE001 — no server in this environment
        return

    srv = getattr(PromptServer, "instance", None)
    if srv is None:
        return

    try:
        from .crops import load_crops_bundle, save_crops_bundle  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001 — a real pack bug; say so
        print(f"[ChaoticMinimaxH3Director] crops API disabled: {e}")
        return

    @srv.routes.post("/chaotic_h3/crops")
    async def _save_crops(request):
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response(
                {"status": "error", "message": "invalid JSON body"}, status=400
            )
        crops = data.get("crops") if isinstance(data, dict) else None
        result = save_crops_bundle(crops)
        status = 200 if result.get("status") == "ok" else 500
        return web.json_response(result, status=status)

    @srv.routes.get("/chaotic_h3/crops")
    async def _load_crops(request):  # noqa: ARG001
        return web.json_response(load_crops_bundle())


_register_crops_api()
