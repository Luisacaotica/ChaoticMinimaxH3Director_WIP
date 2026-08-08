"""Chaotic MinimaxH3 Director — chunk render engine (ComfyUI-dependent).

Replicates the stock MiniMax H3 conditioning path (comfy_extras.nodes_minimax_h3
MiniMaxH3ReferenceToVideo) so that the Director produces exactly the same kind
of conditioning bundles the reference workflow feeds the sampler — plus the
I2VA-style keyframe anchor that guarantees frame-accurate continuity at chunk
seams (the "last-frame glitch" class of bug from LTXTwoStageSampler is avoided
here because H3 keyframes are re-injected during sampling, never appended to
the latent tail, so no trailing guide frames need cropping).

The engine treats the MODEL/CLIP/VAE/SAMPLER objects as opaque: every patch
the user has wired upstream (turbo LoRA, sigma shift, sage attention, block
swap, chunked feed-forward, ...) is already baked into them.
"""

from __future__ import annotations

import io as _io
import math
import os
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch

from .chunking import ChunkPlan

H3_FPS = 24
REF_MIN_FRAMES = 5


def _import_h3_helpers():
    """Import stock H3 helpers lazily (keeps module import side-effect free)."""
    from comfy_extras.nodes_minimax_h3 import (  # noqa: PLC0415
        CANVAS_MULTIPLE,
        FPS,
        REF_IMAGE_SHORT_EDGE,
        _empty_av_latent,
        _resize,
        adapt_canvas,
    )

    return CANVAS_MULTIPLE, FPS, REF_IMAGE_SHORT_EDGE, _empty_av_latent, _resize, adapt_canvas


# --------------------------------------------------------------------------- #
# Media loading (folder_paths input directory + av)
# --------------------------------------------------------------------------- #


def _resolve_input_path(path: str) -> Optional[str]:
    try:
        import folder_paths  # noqa: PLC0415

        annotated = folder_paths.get_annotated_filepath(path)
        if os.path.exists(annotated):
            return annotated
        base = os.path.join(folder_paths.get_input_directory(), path)
        if os.path.exists(base):
            return base
    except Exception:
        pass
    if os.path.exists(path):
        return path
    return None


def _load_image_tensor(path: str) -> torch.Tensor:
    from PIL import Image, ImageOps  # noqa: PLC0415

    resolved = _resolve_input_path(path)
    if resolved is None:
        raise FileNotFoundError(f"Chaotic H3 Director: reference image not found: {path}")
    with Image.open(resolved) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        arr = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def _decode_audio_from_buffer(buffer, target_sr: int, trim_start: float, trim_end: Optional[float]) -> Optional[Tuple[torch.Tensor, int]]:
    """Decode any audio stream from an av buffer to [1, C, L] at target_sr."""
    import av  # noqa: PLC0415

    chunks: List[torch.Tensor] = []
    with av.open(buffer) as container:
        if not container.streams.audio:
            return None
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=target_sr)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                arr = out.to_ndarray()
                chunks.append(torch.from_numpy(arr.copy()))
        for out in resampler.resample(None):
            arr = out.to_ndarray()
            chunks.append(torch.from_numpy(arr.copy()))
    if not chunks:
        return None
    waveform = torch.cat(chunks, dim=1)  # [2, L]
    start = max(0, int(round(trim_start * target_sr)))
    end = None if trim_end is None else int(round(trim_end * target_sr))
    if end is not None:
        waveform = waveform[:, start:end]
    else:
        waveform = waveform[:, start:]
    if waveform.shape[1] == 0:
        return None
    return waveform.unsqueeze(0), target_sr


def _load_audio(path: str, target_sr: int, trim_start: float = 0.0, trim_end: Optional[float] = None):
    resolved = _resolve_input_path(path)
    if resolved is None:
        raise FileNotFoundError(f"Chaotic H3 Director: reference audio not found: {path}")
    with open(resolved, "rb") as handle:
        result = _decode_audio_from_buffer(_io.BytesIO(handle.read()), target_sr, trim_start, trim_end)
    if result is None:
        raise ValueError(f"Chaotic H3 Director: no audio stream decoded from {path}")
    return result


def _load_video(path: str, trim_start: float = 0.0, trim_end: Optional[float] = None,
                max_frames: int = 362) -> torch.Tensor:
    """Load video frames [N, H, W, 3] at the H3 convention (24 fps).

    Frames are streamed and kept raw; the caller resizes/encodes.  The frame
    count is capped to max_frames to bound memory for long reference clips.
    """
    import av  # noqa: PLC0415

    resolved = _resolve_input_path(path)
    if resolved is None:
        raise FileNotFoundError(f"Chaotic H3 Director: reference video not found: {path}")

    start_idx = max(0, int(round(trim_start * H3_FPS)))
    end_idx = None if trim_end is None else int(round(trim_end * H3_FPS))

    frames: List[torch.Tensor] = []
    with av.open(resolved) as container:
        if not container.streams.video:
            raise ValueError(f"Chaotic H3 Director: no video stream in {path}")
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        index = 0
        for frame in container.decode(stream):
            if index < start_idx:
                index += 1
                continue
            if end_idx is not None and index > end_idx:
                break
            arr = frame.to_ndarray(format="rgb24")  # [H, W, 3] uint8
            frames.append(torch.from_numpy(arr.astype(np.float32) / 255.0))
            index += 1
            if len(frames) >= max_frames:
                break
    if not frames:
        raise ValueError(f"Chaotic H3 Director: no frames decoded from {path}")
    return torch.stack(frames)  # [N, H, W, 3]


def _video_audio(path: str, target_sr: int, trim_start: float = 0.0, trim_end: Optional[float] = None):
    """Extract a video file's soundtrack as an audio bundle."""
    resolved = _resolve_input_path(path)
    if resolved is None:
        raise FileNotFoundError(f"Chaotic H3 Director: reference video not found: {path}")
    with open(resolved, "rb") as handle:
        result = _decode_audio_from_buffer(_io.BytesIO(handle.read()), target_sr, trim_start, trim_end)
    if result is None:
        raise ValueError(f"Chaotic H3 Director: no audio stream in video {path}")
    return result


# --------------------------------------------------------------------------- #
# Renderer
# --------------------------------------------------------------------------- #


class ChunkRenderer:
    """Renders one chunk plan against the wired-in model stack."""

    def __init__(
        self,
        model,
        clip,
        vae,
        audio_vae,
        width: int,
        height: int,
        fps: int = 24,
        sampler_obj=None,
        sampler_name: str = "exp_heun_2_x0_sde",
        scheduler: str = "sgm_uniform",
        steps: int = 8,
        cfg: float = 1.0,
        ref_image_size: str = "match",
        sigmas=None,
    ):
        self.model = model
        self.clip = clip
        self.vae = vae
        self.audio_vae = audio_vae
        self.width = int(width)
        self.height = int(height)
        self.fps = max(1, int(fps))
        self.sampler_obj = sampler_obj
        self.sampler_name = sampler_name
        self.scheduler = scheduler
        self.steps = max(1, int(steps))
        self.cfg = float(cfg)
        self.ref_image_size = ref_image_size if ref_image_size in ("match", "max") else "match"
        self.sigmas = sigmas

        self._h3 = None
        self._audio_sr = int(getattr(
            audio_vae, "audio_sample_rate", getattr(audio_vae, "audio_sample_rate_output", 32000),
        ) or 32000)

    # ---- helpers ------------------------------------------------------------

    def _h3_helpers(self):
        if self._h3 is None:
            self._h3 = _import_h3_helpers()
        return self._h3

    def _encode_audio_ref(self, audio) -> Tuple[torch.Tensor, int]:
        waveform = audio["waveform"]
        sr = int(audio["sample_rate"])
        if sr != self._audio_sr:
            import torchaudio  # noqa: PLC0415

            waveform = torchaudio.functional.resample(waveform, sr, self._audio_sr)
        z = self.audio_vae.encode(waveform[:1].movedim(1, -1))  # [1, 32, 2, T]
        return z, int(z.shape[-1])

    def _encode_image_ref(self, image: torch.Tensor):
        CANVAS_MULTIPLE, _, REF_IMAGE_SHORT_EDGE, _, _resize, _ = self._h3_helpers()
        width, height = self.width, self.height
        h, w = image.shape[1], image.shape[2]
        if self.ref_image_size == "match":
            scale = min(1.0, math.sqrt((width * height) / (w * h)))
        else:
            scale = min(1.0, REF_IMAGE_SHORT_EDGE / min(w, h))
        tw = max(CANVAS_MULTIPLE, round(w * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        th = max(CANVAS_MULTIPLE, round(h * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        resized = _resize(image[:1], tw, th, "disabled")
        z = self.vae.encode(resized)
        item = {"type": "image", "data": resized}
        block = {"kind": "image", "latent_h": th // 16, "latent_w": tw // 16, "latent": z}
        return item, block

    def _encode_video_ref(self, frames: torch.Tensor, frame_count: int, audio=None):
        """Replicates the stock ref2va video encode path (incl. 2fps Qwen view)."""
        CANVAS_MULTIPLE, _, _, _, _resize, adapt_canvas = self._h3_helpers()
        vh, vw = frames.shape[1], frames.shape[2]
        cw, ch = adapt_canvas(vw, vh)
        if vw * vh < cw * ch:
            cw = max(CANVAS_MULTIPLE, round(vw / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
            ch = max(CANVAS_MULTIPLE, round(vh / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        frames = _resize(frames, cw, ch, "disabled")
        if frames.shape[0] > frame_count:
            frames = frames[:frame_count]
        n = frames.shape[0]
        if n < REF_MIN_FRAMES:
            raise ValueError(
                f"Chaotic H3 Director: reference video needs at least {REF_MIN_FRAMES} frames "
                f"(~0.2s at 24fps), got {n}. Trim it or use a longer clip."
            )
        while n % 17 != 5:
            n -= 1
        frames = frames[:n]
        z = self.vae.encode(frames)

        audio_latent, ref_audio_t = None, 0
        ref_items: List[dict] = []
        if audio is not None:
            audio_latent, ref_audio_t = self._encode_audio_ref(audio)
            ref_items.append({"type": "audio"})

        sample_idx = list(range(0, frames.shape[0], H3_FPS // 2))
        qwen_frames = frames[sample_idx]
        ref_items.append({
            "type": "video",
            "data": qwen_frames,
            "timestamps": [i / 2.0 for i in range(len(sample_idx))],
        })
        block = {
            "kind": "video_audio" if ref_audio_t else "video",
            "latent_t": z.shape[2],
            "latent_h": ch // 16,
            "latent_w": cw // 16,
            "ref_audio_t": ref_audio_t,
            "latent": z,
            "audio_latent": audio_latent,
        }
        return ref_items, block

    # ---- main render ----------------------------------------------------------

    def render_chunk(
        self,
        plan: ChunkPlan,
        prompt: str,
        seed: int,
        anchor_image: Optional[torch.Tensor],
        video_context_frames: Optional[torch.Tensor],
        use_keyframe: bool = False,
        storyboard_frames: Optional[torch.Tensor] = None,
    ) -> Dict:
        """Render one chunk; returns frames [F,H,W,3] + audio dict + log lines."""
        import comfy.model_management as mm  # noqa: PLC0415
        import comfy.sample  # noqa: PLC0415
        import comfy.samplers  # noqa: PLC0415
        import latent_preview  # noqa: PLC0415
        import node_helpers  # noqa: PLC0415

        log: List[str] = []
        _, _, _, _empty_av_latent, _, _ = self._h3_helpers()

        latent, frame_count = _empty_av_latent(self.width, self.height, plan.frames)
        log.append(f"chunk latent: {frame_count} frames @ {self.width}x{self.height}")

        ref_items: List[dict] = []
        ref_blocks: List[dict] = []
        keyframes: List[dict] = []

        for entry in plan.ref_entries:
            if entry.is_anchor:
                if anchor_image is not None and entry.kind == "picture":
                    item, block = self._encode_image_ref(anchor_image)
                    ref_items.append(item)
                    ref_blocks.append(block)
                continue
            if entry.is_storyboard:
                if storyboard_frames is not None and entry.kind == "video":
                    ref_items_v, block = self._encode_video_ref(storyboard_frames, frame_count)
                    ref_items.extend(ref_items_v)
                    ref_blocks.append(block)
                continue
            if entry.ref is None:
                if entry.kind == "video" and video_context_frames is not None:
                    ref_items_v, block = self._encode_video_ref(video_context_frames, frame_count)
                    ref_items.extend(ref_items_v)
                    ref_blocks.append(block)
                continue

            ref = entry.ref
            if entry.kind == "picture":
                image = _load_image_tensor(ref.file)
                item, block = self._encode_image_ref(image)
                ref_items.append(item)
                ref_blocks.append(block)
            elif entry.kind == "video":
                frames = _load_video(ref.file, ref.trim_start, ref.trim_end, max_frames=frame_count)
                audio = None
                if ref.use_soundtrack:
                    audio = _video_audio(ref.file, self._audio_sr, ref.trim_start, ref.trim_end)
                ref_items_v, block = self._encode_video_ref(frames, frame_count, audio)
                ref_items.extend(ref_items_v)
                ref_blocks.append(block)
            elif entry.kind == "audio":
                audio = _load_audio(ref.file, self._audio_sr, ref.trim_start, ref.trim_end)
                z, t = self._encode_audio_ref(audio)
                ref_items.append({"type": "audio"})
                ref_blocks.append({"kind": "audio", "ref_audio_t": t, "audio_latent": z})

        # --- I2VA-style keyframe seam anchor (frame-accurate continuity) -------
        if use_keyframe and anchor_image is not None and plan.anchor_tag is not None:
            z = self.vae.encode(anchor_image)
            keyframes.append({"resolved_frame_index": 0, "image": anchor_image, "latent": z})

        tokens = self.clip.tokenize(prompt, minimax_ref_items=ref_items)
        cond = self.clip.encode_from_tokens_scheduled(tokens)
        if ref_blocks:
            cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": ref_blocks})
        if keyframes:
            cond = node_helpers.conditioning_set_values(
                cond,
                {"minimax_keyframes": keyframes, "minimax_frame_count": frame_count},
            )

        # --- sampling (stock SamplerCustomAdvanced path) -----------------------
        device = mm.get_torch_device()
        sampler = self.sampler_obj
        if sampler is None:
            sampler = comfy.samplers.KSampler(
                self.model,
                steps=self.steps,
                device=device,
                sampler=self.sampler_name,
                scheduler=self.scheduler,
                denoise=1.0,
                model_options=self.model.model_options,
            )
        if self.sigmas is not None:
            sigmas = self.sigmas.to(device)
        else:
            sigmas = getattr(sampler, "sigmas", None)
            if sigmas is None:
                # External sampler objects without a precomputed schedule (rare;
                # MiniMaxH3TurboSampler returns a KSampler that has one). Fall
                # back to a plain KSampler schedule so a missing sigmas input
                # never turns into an opaque AttributeError.
                sampler = comfy.samplers.KSampler(
                    self.model,
                    steps=self.steps,
                    device=device,
                    sampler=self.sampler_name,
                    scheduler=self.scheduler,
                    denoise=1.0,
                    model_options=self.model.model_options,
                )
                sigmas = sampler.sigmas
            sigmas = sigmas.to(device)

        noise = comfy.sample.prepare_noise(latent["samples"], seed)
        noise = noise.to(device)

        callback = latent_preview.prepare_callback(self.model, max(1, len(sigmas) - 1))
        samples = comfy.samplers.sample(
            self.model,
            noise,
            [cond],
            [],
            self.cfg,
            device,
            sampler,
            sigmas,
            latent_image=latent["samples"],
            callback=callback,
            seed=seed,
        )

        # --- decode -------------------------------------------------------------
        video_t, audio_t = samples.unbind()
        frames = self.vae.decode(video_t)  # [1, F, H, W, 3]
        audio_wave = self.audio_vae.decode(audio_t).movedim(-1, 1)  # [1, C, L]
        std = torch.std(audio_wave, dim=[1, 2], keepdim=True) * 5.0
        std[std < 1.0] = 1.0
        audio_wave = audio_wave / std
        sample_rate = int(getattr(
            self.audio_vae, "audio_sample_rate_output",
            getattr(self.audio_vae, "audio_sample_rate", 44100),
        ) or 44100)

        log.append(f"decoded {frames.shape[1]} frames, audio {audio_wave.shape[-1]} samples @ {sample_rate}Hz")
        return {
            "frames": frames[0],
            "audio": {"waveform": audio_wave, "sample_rate": sample_rate},
            "log": log,
            "keyframed": bool(keyframes),
        }
