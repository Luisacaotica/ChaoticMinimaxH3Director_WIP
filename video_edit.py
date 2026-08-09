"""Chaotic MinimaxH3 Director — Video Edit utilities (pure torch/PIL).

The "Chaotic H3 Video Edit" node turns a video + a keyframed mask into the
*plates* a video-inpainting model (or the Director / stock H3 reference nodes)
consumes, plus the alpha/keying tools for green-screen work.  It never runs a
diffusion model itself — the user routes the plates through their existing H3
graph and composites the patched clip back with `composite_patch`.

Data contract (mirrored by web/js/chaotic_video_edit.js):

  * mode        "inpaint" | "chroma"
  * edit        "inside" (edit the masked region) | "outside" (edit everything
                around it — the mask becomes the voided region)
  * plate_color "black" | "green"  — void color for the full-frame plate
  * output      "full" (full-frame void plate) | "crop" (selection-only plate)
  * crop_scale  multiplier on the selection's native resolution (1.0 = the
                selection's exact pixels; aspect is always preserved)
  * outpaint    when true, the model may extend past the selection (Composite
                Patch then pastes the whole patch, not just the masked part)
  * prompt      the edit instruction ("what to do in this region")
  * mask.keys   [{t, grid_w, grid_h, png}] — keyframed mask bitmaps (base64 PNG
                of the mask at a low-res grid); masks between keys cross-fade
  * chroma      {color, similarity, smooth, spill} — green-screen settings

All functions are free of ComfyUI imports (torch/PIL/numpy only) so the whole
node is unit-testable in a plain interpreter.
"""

from __future__ import annotations

import base64
import io
import json
import math
from typing import Any, Dict, List, Optional, Tuple

import torch

EDIT_VERSION = 1
# Mask bitmaps are authored at video/GRID_DIVISOR resolution: coarse enough to
# stay tiny in the workflow JSON, fine enough for brush/rect selections.
GRID_DIVISOR = 4
VOID_COLORS = {
    "black": (0.0, 0.0, 0.0),
    "green": (0.0, 1.0, 0.0),
}


# --------------------------------------------------------------------------- #
# Data model / parsing
# --------------------------------------------------------------------------- #


def default_edit_dict() -> Dict[str, Any]:
    return {
        "version": EDIT_VERSION,
        "mode": "inpaint",
        "edit": "inside",
        "plate_color": "black",
        "output": "full",
        "crop_scale": 1.0,
        "outpaint": False,
        "prompt": "",
        "video_file": "",
        "mask": {"type": "rect", "keys": []},
        "chroma": {"color": [0.0, 1.0, 0.0], "similarity": 0.35, "smooth": 0.12, "spill": 0.15, "auto": False},
        # reframe: outpaint the outside of a target canvas (e.g. 9:16 -> 16:9).
        # align_x/align_y place the source window inside the target (0..1).
        "reframe": {
            "target_w": 1280,
            "target_h": 720,
            "feather": 8,
            "align_x": 0.5,
            "align_y": 0.5,
            "scale": 1.0,       # source window size multiplier (0.1..4)
            "rotation": 0.0,    # source window rotation in degrees (-180..180)
            "fit": "contain",   # contain = fill the tight axis at scale 1;
                                 # smaller  = base fit x SMALLER_FACTOR so the
                                 # window keeps margin on BOTH axes at scale 1,
                                 # unlocking free 2D placement with the move tool
            "track": [],         # subject-tracking position keyframes:
                                 # [{t: seconds, ax: 0..1, ay: 0..1}] — the
                                 # window interpolates align per frame so it
                                 # follows a tracked subject across the clip
        },
        "refs": [],            # copy-to-reference crops: [{"src": b64png, "at": sec}]
        "video_fps": None,     # the source file's real framerate (widget estimate)
    }


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def default_edit_json() -> str:
    return json.dumps(default_edit_dict(), ensure_ascii=False, indent=2)


def parse_edit_data(json_text: str) -> Dict[str, Any]:
    """Parse the widget's edit_data JSON into a validated dict (unknown kept)."""
    if json_text is None:
        json_text = ""
    try:
        data = json.loads(json_text) if json_text.strip() else {}
    except json.JSONDecodeError as exc:
        raise ValueError(f"Chaotic H3 Video Edit: edit_data is not valid JSON ({exc})") from exc
    if not isinstance(data, dict):
        raise ValueError("Chaotic H3 Video Edit: edit_data must be a JSON object")
    d = default_edit_dict()
    d["mode"] = data.get("mode") if data.get("mode") in ("inpaint", "chroma", "reframe") else "inpaint"
    d["edit"] = data.get("edit") if data.get("edit") in ("inside", "outside") else "inside"
    d["plate_color"] = data.get("plate_color") if data.get("plate_color") in VOID_COLORS else "black"
    d["output"] = data.get("output") if data.get("output") in ("full", "crop") else "full"
    d["crop_scale"] = max(0.1, min(4.0, _as_float(data.get("crop_scale"), 1.0)))
    d["outpaint"] = bool(data.get("outpaint", False))
    d["prompt"] = data.get("prompt") if isinstance(data.get("prompt"), str) else ""
    d["video_file"] = data.get("video_file") if isinstance(data.get("video_file"), str) else ""
    raw_mask = data.get("mask")
    if isinstance(raw_mask, dict):
        mtype = raw_mask.get("type") if raw_mask.get("type") in ("rect", "brush") else "rect"
        keys = []
        raw_keys = raw_mask.get("keys")
        if isinstance(raw_keys, list):
            for k in raw_keys:
                if not isinstance(k, dict):
                    continue
                keys.append({
                    "t": max(0.0, _as_float(k.get("t"))),
                    "grid_w": max(8, int(_as_float(k.get("grid_w"), 64))),
                    "grid_h": max(8, int(_as_float(k.get("grid_h"), 64))),
                    "png": k.get("png") if isinstance(k.get("png"), str) else "",
                })
        keys.sort(key=lambda k: k["t"])
        d["mask"] = {"type": mtype, "keys": keys}
    raw_chroma = data.get("chroma")
    if isinstance(raw_chroma, dict):
        color = raw_chroma.get("color")
        if isinstance(color, (list, tuple)) and len(color) >= 3:
            color = [min(1.0, max(0.0, _as_float(c))) for c in color[:3]]
        else:
            color = [0.0, 1.0, 0.0]
        d["chroma"] = {
            "color": color,
            "similarity": min(0.95, max(0.0, _as_float(raw_chroma.get("similarity"), 0.35))),
            "smooth": min(0.5, max(0.0, _as_float(raw_chroma.get("smooth"), 0.12))),
            "spill": min(0.9, max(0.0, _as_float(raw_chroma.get("spill"), 0.15))),
            "auto": bool(raw_chroma.get("auto")),
        }
    raw_rf = data.get("reframe")
    if isinstance(raw_rf, dict):
        d["reframe"] = {
            "target_w": max(16, min(4096, int(_as_float(raw_rf.get("target_w"), 1280)))),
            "target_h": max(16, min(4096, int(_as_float(raw_rf.get("target_h"), 720)))),
            "feather": max(0, min(64, int(_as_float(raw_rf.get("feather"), 8)))),
            "align_x": min(1.0, max(0.0, _as_float(raw_rf.get("align_x"), 0.5))),
            "align_y": min(1.0, max(0.0, _as_float(raw_rf.get("align_y"), 0.5))),
            "scale": min(4.0, max(0.1, _as_float(raw_rf.get("scale"), 1.0))),
            "rotation": min(180.0, max(-180.0, _as_float(raw_rf.get("rotation"), 0.0))),
            "fit": raw_rf.get("fit") if raw_rf.get("fit") in ("contain", "smaller") else "contain",
        }
        raw_track = raw_rf.get("track")
        track: List[Dict[str, float]] = []
        if isinstance(raw_track, list):
            for k in raw_track:
                if not isinstance(k, dict):
                    continue
                raw_t = k.get("t")
                if isinstance(raw_t, bool) or not isinstance(raw_t, (int, float)):
                    continue  # no explicit time -> drop (don't default to 0)
                t = _as_float(raw_t)
                if not math.isfinite(t) or t < 0:
                    continue
                track.append({
                    "t": round(t, 3),
                    "ax": min(1.0, max(0.0, _as_float(k.get("ax"), 0.5))),
                    "ay": min(1.0, max(0.0, _as_float(k.get("ay"), 0.5))),
                })
            track.sort(key=lambda k: k["t"])
            dedup: List[Dict[str, float]] = []
            for k in track:
                if dedup and abs(dedup[-1]["t"] - k["t"]) <= 1e-6:
                    dedup[-1] = k  # keep the LAST at a time (matches the JS upsert)
                else:
                    dedup.append(k)
            track = dedup
        d["reframe"]["track"] = track
    raw_refs = data.get("refs")
    if isinstance(raw_refs, list):
        refs = []
        for r in raw_refs:
            if not isinstance(r, dict):
                continue
            src = r.get("src")
            if not isinstance(src, str) or not src:
                continue
            refs.append({
                "src": src,
                "at": max(0.0, _as_float(r.get("at"), 0.0)),
                "note": r.get("note") if isinstance(r.get("note"), str) else "",
            })
        d["refs"] = refs
    vfps = _as_float(data.get("video_fps"), 0.0)
    if 1.0 <= vfps <= 240.0:
        d["video_fps"] = vfps
    return d


# --------------------------------------------------------------------------- #
# Masks
# --------------------------------------------------------------------------- #


def _decode_mask_key(key: Dict[str, Any], grid_w: int, grid_h: int) -> torch.Tensor:
    """Base64 PNG mask -> float [grid_h, grid_w] 0..1 (1 = masked)."""
    png = key.get("png") or ""
    if not png:
        return torch.zeros(grid_h, grid_w)
    try:
        from PIL import Image  # noqa: PLC0415

        raw = base64.b64decode(png)
        img = Image.open(io.BytesIO(raw)).convert("L")
        img = img.resize((grid_w, grid_h), Image.NEAREST)
        arr = torch.from_numpy(__import__("numpy").asarray(img, dtype="float32")) / 255.0
        return arr
    except Exception:  # noqa: BLE001 — a corrupt key must not kill the render
        return torch.zeros(grid_h, grid_w)


def build_masks(
    edit: Dict[str, Any],
    fps: float,
    frame_count: int,
    video_h: int,
    video_w: int,
) -> torch.Tensor:
    """Per-frame masks [F, H, W] float 0..1 at full video resolution.

    Mask bitmaps are authored at a low-res grid and nearest-upscaled; between
    keyframes they cross-fade linearly (a box mask grows/shrinks smoothly, a
    brush mask morphs).
    """
    fps = max(1.0, float(fps))
    frame_count = max(1, int(frame_count))
    video_h, video_w = max(1, int(video_h)), max(1, int(video_w))
    grid_w = max(16, video_w // GRID_DIVISOR)
    grid_h = max(16, video_h // GRID_DIVISOR)
    keys = sorted(edit["mask"]["keys"], key=lambda k: k["t"])
    if not keys:
        return torch.zeros(frame_count, video_h, video_w)
    decoded = [_decode_mask_key(k, grid_w, grid_h) for k in keys]

    masks: List[torch.Tensor] = []
    for frame_index in range(frame_count):
        t = frame_index / fps
        grid = _mask_at(decoded, keys, t, grid_w, grid_h)  # [grid_h, grid_w]
        masks.append(_upsample_nearest(grid.unsqueeze(0).unsqueeze(0), video_h, video_w)[0, 0])
    return torch.stack(masks)


def _mask_at(
    decoded: List[torch.Tensor],
    keys: List[Dict[str, Any]],
    t: float,
    grid_w: int,
    grid_h: int,
) -> torch.Tensor:
    if t < keys[0]["t"]:
        return decoded[0]
    if t >= keys[-1]["t"]:
        return decoded[-1]
    before_idx = max(i for i, k in enumerate(keys) if k["t"] <= t)
    after_idx = before_idx + 1
    if after_idx >= len(keys):
        return decoded[before_idx]
    span = max(1e-6, keys[after_idx]["t"] - keys[before_idx]["t"])
    f = (t - keys[before_idx]["t"]) / span
    return decoded[before_idx] * (1 - f) + decoded[after_idx] * f


def _upsample_nearest(grid: torch.Tensor, h: int, w: int) -> torch.Tensor:
    return torch.nn.functional.interpolate(grid, size=(h, w), mode="nearest")


def effective_mask(mask: torch.Tensor, edit_mode: str) -> torch.Tensor:
    """The region that gets EDITED: the mask (inside) or its inverse (outside)."""
    if edit_mode == "outside":
        return 1.0 - mask
    return mask


# --------------------------------------------------------------------------- #
# Plates
# --------------------------------------------------------------------------- #


def masked_plate(
    video: torch.Tensor,
    eff_mask: torch.Tensor,
    color: Tuple[float, float, float],
) -> torch.Tensor:
    """Full-frame plate: the edited region keeps the video, the rest is void."""
    video = video.float()
    m = eff_mask.unsqueeze(-1)  # [F, H, W, 1]
    void = torch.tensor(color, dtype=video.dtype, device=video.device).reshape(1, 1, 1, 3)
    return video * m + void * (1 - m)


def mask_bbox(mask: torch.Tensor) -> Tuple[int, int, int, int]:
    """Union bounding box of masked pixels across all frames -> (x, y, w, h)."""
    if mask.dim() == 4:
        mask = mask.squeeze(0)
    acc = mask.max(dim=0).values if mask.dim() == 3 else mask
    idx = acc.nonzero()
    if idx.numel() == 0:
        return (0, 0, 0, 0)
    y0 = int(idx[:, 0].min().item())
    y1 = int(idx[:, 0].max().item())
    x0 = int(idx[:, 1].min().item())
    x1 = int(idx[:, 1].max().item())
    return (x0, y0, x1 - x0 + 1, y1 - y0 + 1)


def crop_plate(
    plate: torch.Tensor,
    bbox: Tuple[int, int, int, int],
    scale: float = 1.0,
    color: Tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> torch.Tensor:
    """Selection-only plate: the bbox crop, uniformly scaled by `scale`, padded
    with void to a 64-multiple so the model receives a clean canvas.  The
    content's aspect ratio is always preserved; the 64-padding only adds void
    margin (which the model may outpaint into when `outpaint` is on)."""
    x, y, w, h = bbox
    if w < 1 or h < 1:
        raise ValueError("masked region is empty — draw a mask first")
    F = plate.shape[0]
    crop = plate[:, y:y + h, x:x + w, :].clone()
    sw = max(8, round(w * scale))
    sh = max(8, round(h * scale))
    crop = _resize(crop, sh, sw)
    tw = int(math.ceil(sw / 64.0) * 64)
    th = int(math.ceil(sh / 64.0) * 64)
    if tw != sw or th != sh:
        void = torch.tensor(color, dtype=crop.dtype, device=crop.device)
        padded = void.reshape(1, 1, 1, 3).expand(F, th, tw, 3).clone()
        px = (tw - sw) // 2
        py = (th - sh) // 2
        padded[:, py:py + sh, px:px + sw] = crop
        crop = padded
    return crop


def _resize(t: torch.Tensor, h: int, w: int) -> torch.Tensor:
    """Bilinear resize for [F, H, W, C] (channels-last) tensors."""
    return torch.nn.functional.interpolate(
        t.permute(0, 3, 1, 2), size=(h, w), mode="bilinear", align_corners=False
    ).permute(0, 2, 3, 1)


def _feather_mask(mask: torch.Tensor, px: int) -> torch.Tensor:
    """Soft ramp over a 0/1 mask boundary via a box blur (px >= 0)."""
    px = max(0, int(px))
    if px <= 0 or mask.numel() == 0:
        return mask
    m = mask.unsqueeze(1).float()  # [F, 1, H, W]
    k = 2 * px + 1
    m = torch.nn.functional.avg_pool2d(m, kernel_size=k, stride=1, padding=px, count_include_pad=False)
    return m[:, 0]


# "fit smaller" base factor: at scale 1 the contain-fit window touches the
# target's tight axis, leaving no travel on it.  Multiplying the base fit by
# this factor keeps a margin on BOTH axes so the move tool can place the window
# anywhere in 2D (picture-in-picture / free composition) instead of being
# pinned against an edge.
SMALLER_FACTOR = 0.8


def reframe_plate(
    video: torch.Tensor,
    reframe: Dict[str, Any],
    color: Tuple[float, float, float],
    preserve: Optional[torch.Tensor] = None,
    fps: float = 24.0,
) -> Tuple[torch.Tensor, torch.Tensor, Tuple[int, int, int, int]]:
    """Reframe canvas: place the source inside a target-aspect canvas and
    produce the outpaint mask (1 = outside the source window = to be outpainted).

    `preserve` (optional [F, H, W] 0..1 in *source* coordinates) marks regions
    that must NOT be outpainted even though they lie outside the window — brush
    people/objects crossing the boundary so the model keeps them instead of
    hallucinating over them.

    `reframe["track"]` (optional [{t, ax, ay}], t in seconds) animates the
    window placement: each frame's align_x/align_y are interpolated from the
    keyframes, so the window follows a tracked subject across the clip.  With
    no track the window is static (the historical behavior).  The returned
    `box` is the window at frame 0.

    Returns (plate [F, th, tw, 3], eff [F, th, tw], box (x, y, w, h) of the
    placed source window in target coordinates).
    """
    video = video.float()
    F, H, W = video.shape[0], video.shape[1], video.shape[2]
    tw = max(16, int(reframe["target_w"]))
    th = max(16, int(reframe["target_h"]))
    feather = max(0, int(reframe["feather"]))
    ax = min(1.0, max(0.0, float(reframe["align_x"])))
    ay = min(1.0, max(0.0, float(reframe["align_y"])))
    scale = min(4.0, max(0.1, float(reframe.get("scale") or 1.0)))
    rot_deg = min(180.0, max(-180.0, float(reframe.get("rotation") or 0.0)))
    fit = reframe.get("fit") if reframe.get("fit") in ("contain", "smaller") else "contain"
    track = [k for k in (reframe.get("track") or []) if isinstance(k, dict)]

    # window geometry: contain-fit the source, then multiply by `scale`.  A
    # window that fits keeps its old fully-inside clamp; one that outgrows the
    # canvas (scale > 1) pins its CENTER inside instead, so the view stays
    # anchored while it overflows the edges.
    s = min(tw / W, th / H)  # contain-fit the source
    if fit == "smaller":
        s *= SMALLER_FACTOR  # keep margin on both axes at scale 1 -> free 2D placement
    k = s * scale
    sw, sh = max(1, int(round(W * k))), max(1, int(round(H * k)))

    def align_at(frame_idx: int) -> Tuple[float, float]:
        """(ax, ay) for frame `frame_idx`: interpolated from the track keys
        (t in seconds via `fps`), else the static align."""
        if not track:
            return ax, ay
        t = frame_idx / max(1e-6, float(fps))
        first, last = track[0], track[-1]
        if t <= first["t"]:
            return float(first.get("ax", ax)), float(first.get("ay", ay))
        if t >= last["t"]:
            return float(last.get("ax", ax)), float(last.get("ay", ay))
        for i in range(len(track) - 1):
            a, b = track[i], track[i + 1]
            if a["t"] <= t <= b["t"]:
                span = b["t"] - a["t"]
                if span < 1e-9:
                    return float(a.get("ax", ax)), float(a.get("ay", ay))
                u = (t - a["t"]) / span
                aax, aay = float(a.get("ax", ax)), float(a.get("ay", ay))
                bax, bay = float(b.get("ax", ax)), float(b.get("ay", ay))
                return aax + (bax - aax) * u, aay + (bay - aay) * u
        return float(last.get("ax", ax)), float(last.get("ay", ay))

    def window_rect(axf: float, ayf: float) -> Tuple[int, int]:
        """(sx, sy) for a given align, with the same clamps as the static path."""
        axc = min(1.0, max(0.0, float(axf)))
        ayc = min(1.0, max(0.0, float(ayf)))
        sx = int(round((tw - sw) * axc))
        sy = int(round((th - sh) * ayc))
        if sw <= tw:
            sx = min(max(0, sx), tw - sw)
        else:
            sx = min(max(0, sx + sw // 2), tw) - sw // 2
        if sh <= th:
            sy = min(max(0, sy), th - sh)
        else:
            sy = min(max(0, sy + sh // 2), th) - sh // 2
        return sx, sy

    if track:
        pos = [window_rect(*align_at(f)) for f in range(F)]
    else:
        pos = [window_rect(ax, ay)] * F
    sx, sy = pos[0]
    cx = sx + sw / 2.0
    cy = sy + sh / 2.0

    void = torch.tensor(color, dtype=video.dtype, device=video.device).reshape(1, 1, 1, 3)
    plate = void.expand(F, th, tw, 3).clone()

    if abs(rot_deg) < 1e-6:
        # axis-aligned fast path (identity or pure scale) — exact slicing, and
        # bounds-safe so a scaled-up window that overflows the canvas clips
        # cleanly instead of wrapping via negative indices
        src = _resize(video, sh, sw)
        if not track:
            # single static window (the hot path): one exact slice for all frames
            if sx < tw and sy < th and sx + sw > 0 and sy + sh > 0:
                x0 = max(0, sx); y0 = max(0, sy)
                x1 = min(tw, sx + sw); y1 = min(th, sy + sh)
                plate[:, y0:y1, x0:x1, :] = src[:, y0 - sy:y1 - sy, x0 - sx:x1 - sx, :]
            eff = torch.ones(F, th, tw, dtype=video.dtype, device=video.device)
            if sx < tw and sy < th and sx + sw > 0 and sy + sh > 0:
                x0 = max(0, sx); y0 = max(0, sy)
                eff[:, y0:min(th, sy + sh), x0:min(tw, sx + sw)] = 0.0
            if preserve is not None:
                p = preserve.float()[:F]  # truncate if longer; shorter stays and is skipped
                if p.shape[0] == F:
                    p_resized = _resize(p.unsqueeze(-1), sh, sw)[..., 0]
                    placed = torch.zeros(F, th, tw, dtype=video.dtype, device=video.device)
                    if sx < tw and sy < th and sx + sw > 0 and sy + sh > 0:
                        x0 = max(0, sx); y0 = max(0, sy)
                        placed[:, y0:min(th, sy + sh), x0:min(tw, sx + sw)] = (
                            p_resized[:, y0 - sy:min(th, sy + sh) - sy, x0 - sx:min(tw, sx + sw) - sx]
                        )
                    eff = eff * (1.0 - placed.clamp(0, 1))  # painted = preserved
            eff = _feather_mask(eff, feather)
            return plate, eff, (sx, sy, sw, sh)
        # tracked window: place the source per frame (the window follows the
        # subject, so each frame may slice a different region of the target)
        for f, (sxf, syf) in enumerate(pos):
            if sxf < tw and syf < th and sxf + sw > 0 and syf + sh > 0:
                x0 = max(0, sxf); y0 = max(0, syf)
                x1 = min(tw, sxf + sw); y1 = min(th, syf + sh)
                plate[f, y0:y1, x0:x1, :] = src[f, y0 - syf:y1 - syf, x0 - sxf:x1 - sxf, :]
        eff = torch.ones(F, th, tw, dtype=video.dtype, device=video.device)
        for f, (sxf, syf) in enumerate(pos):
            if sxf < tw and syf < th and sxf + sw > 0 and syf + sh > 0:
                x0 = max(0, sxf); y0 = max(0, syf)
                eff[f, y0:min(th, syf + sh), x0:min(tw, sxf + sw)] = 0.0
        if preserve is not None:
            p = preserve.float()[:F]
            if p.shape[0] == F:
                p_resized = _resize(p.unsqueeze(-1), sh, sw)[..., 0]
                placed = torch.zeros(F, th, tw, dtype=video.dtype, device=video.device)
                for f, (sxf, syf) in enumerate(pos):
                    if sxf < tw and syf < th and sxf + sw > 0 and syf + sh > 0:
                        x0 = max(0, sxf); y0 = max(0, syf)
                        placed[f, y0:min(th, syf + sh), x0:min(tw, sxf + sw)] = (
                            p_resized[f, y0 - syf:min(th, syf + sh) - syf,
                                      x0 - sxf:min(tw, sxf + sw) - sxf]
                        )
                eff = eff * (1.0 - placed.clamp(0, 1))
        eff = _feather_mask(eff, feather)
        return plate, eff, (sx, sy, sw, sh)

    # rotated path: affine warp of the source into the target canvas.  The grid
    # maps each target pixel back to its source coordinate (inverse rotate,
    # unscale, translate), so grid_sample picks the right source color.
    import torch.nn.functional as F_nn  # noqa: PLC0415

    theta = math.radians(rot_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    dev = video.device

    ty, tx = torch.meshgrid(torch.arange(th), torch.arange(tw), indexing="ij")
    if all(p == pos[0] for p in pos[1:]):
        # static window (the common case): one grid, expanded as a view
        cxf = pos[0][0] + sw / 2.0
        cyf = pos[0][1] + sh / 2.0
        dx = (tx.to(dev) - cxf) / k
        dy = (ty.to(dev) - cyf) / k
        rx = dx * cos_t + dy * sin_t  # R(-theta) on the target offset
        ry = -dx * sin_t + dy * cos_t
        sx_ = rx + W / 2.0
        sy_ = ry + H / 2.0
        gx = sx_ / max(1, W - 1) * 2.0 - 1.0
        gy = sy_ / max(1, H - 1) * 2.0 - 1.0
        grid = torch.stack([gx, gy], dim=-1).unsqueeze(0).to(video.dtype).expand(F, -1, -1, -1)
    else:
        # tracked window: per-frame grid (the center moves every frame)
        grids = []
        for (sxf, syf) in pos:
            cxf = sxf + sw / 2.0
            cyf = syf + sh / 2.0
            dx = (tx.to(dev) - cxf) / k
            dy = (ty.to(dev) - cyf) / k
            rx = dx * cos_t + dy * sin_t
            ry = -dx * sin_t + dy * cos_t
            sx_ = rx + W / 2.0
            sy_ = ry + H / 2.0
            gx = sx_ / max(1, W - 1) * 2.0 - 1.0
            gy = sy_ / max(1, H - 1) * 2.0 - 1.0
            grids.append(torch.stack([gx, gy], dim=-1).unsqueeze(0))
        grid = torch.cat(grids, dim=0).to(video.dtype)

    video_n = video.permute(0, 3, 1, 2)
    plate = F_nn.grid_sample(
        video_n, grid, mode="bilinear", padding_mode="zeros", align_corners=True
    ).permute(0, 2, 3, 1)

    # coverage mask: sampling a constant-1 source through the same warp gives
    # the soft footprint (anti-aliased edges); outside = the outpaint region
    ones = torch.ones(F, 1, H, W, dtype=video.dtype, device=dev)
    cov = F_nn.grid_sample(ones, grid, mode="bilinear", padding_mode="zeros", align_corners=True)[:, 0]
    eff = (1.0 - cov).clamp(0, 1)

    if preserve is not None:
        p = preserve.float()[:F]
        if p.shape[0] == F:
            placed = F_nn.grid_sample(
                p.unsqueeze(1), grid, mode="bilinear", padding_mode="zeros", align_corners=True
            )[:, 0]
            eff = eff * (1.0 - placed.clamp(0, 1))

    eff = _feather_mask(eff, feather)

    # axis-aligned box of the rotated window, clipped to the canvas
    hw, hh = sw / 2.0, sh / 2.0
    xs, ys = [], []
    for lx, ly in ((hw, hh), (hw, -hh), (-hw, hh), (-hw, -hh)):
        xs.append(cx + lx * cos_t - ly * sin_t)
        ys.append(cy + lx * sin_t + ly * cos_t)
    x0 = int(round(max(0.0, min(xs))))
    y0 = int(round(max(0.0, min(ys))))
    x1 = int(round(min(float(tw), max(xs))))
    y1 = int(round(min(float(th), max(ys))))
    box = (x0, y0, max(1, x1 - x0), max(1, y1 - y0))
    return plate, eff, box


def decode_refs(refs: List[Dict[str, Any]]) -> List[torch.Tensor]:
    """Copy-to-reference crops (base64 PNG strings) -> [N, H, W, 3] float 0..1.

    Corrupt entries are skipped; an empty list means "no references".
    """
    from PIL import Image  # noqa: PLC0415

    out: List[torch.Tensor] = []
    for r in refs:
        src = (r or {}).get("src") or ""
        if not src:
            continue
        try:
            img = Image.open(io.BytesIO(base64.b64decode(src))).convert("RGB")
            arr = torch.from_numpy(__import__("numpy").asarray(img, dtype="float32")) / 255.0
            out.append(arr)
        except Exception:  # noqa: BLE001 — a bad crop must not kill the render
            continue
    return out


# --------------------------------------------------------------------------- #
# Chroma key
# --------------------------------------------------------------------------- #


def detect_key_color(
    frame: torch.Tensor,
    margin: float = 0.12,
    bins: int = 6,
) -> Tuple[List[float], float]:
    """Dominant backing color of a frame -> ([r, g, b] 0..1, coverage fraction).

    In a chroma setup the screen fills the frame's border ring, so the key color
    is the most frequent quantized color among the outer `margin` of the frame
    (mirrors `veDetectKeyColor` in web/js/chaotic_video_edit.js exactly — same
    ring, same quantization, same first-max tie-break).  Works for green, blue,
    magenta, or any other flat backdrop.
    """
    frame = frame.float()
    if frame.dim() == 4:
        frame = frame[0]
    if frame.shape[-1] > 3:  # RGBA insurance — keying only needs RGB
        frame = frame[..., :3]
    h, w = int(frame.shape[0]), int(frame.shape[1])
    mh = max(1, int(round(h * margin)))
    mw = max(1, int(round(w * margin)))
    border = torch.cat([
        frame[:mh].reshape(-1, 3),    # top ring
        frame[-mh:].reshape(-1, 3),   # bottom ring
        frame[:, :mw].reshape(-1, 3),  # left ring
        frame[:, -mw:].reshape(-1, 3),  # right ring
    ])
    q = (border * bins).floor().clamp(0, bins - 1).long()
    idx = q[:, 0] * bins * bins + q[:, 1] * bins + q[:, 2]
    counts = torch.bincount(idx, minlength=bins ** 3)
    best = int(counts.argmax().item())
    frac = float(counts[best].item() / max(1, idx.numel()))
    color = border[idx == best].mean(dim=0).tolist()
    return color, frac


def chroma_key(
    video: torch.Tensor,
    color: List[float],
    similarity: float = 0.35,
    smooth: float = 0.12,
    spill: float = 0.15,
) -> Tuple[torch.Tensor, torch.Tensor]:
    """Green-screen keying -> (rgba [F,H,W,4], alpha [F,H,W] float 0..1).

    alpha is 1 on the foreground (subject) and 0 on the keyed background, with
    a soft transition band of width `smooth` around `similarity` (Euclidean RGB
    distance).  `spill` suppresses green spill on the subject's edges.
    """
    video = video.float()
    color_t = torch.tensor(color, dtype=video.dtype, device=video.device).reshape(1, 1, 1, 3)
    dist = (video - color_t).pow(2).sum(-1).sqrt()  # [F, H, W]
    low = max(1e-6, similarity - smooth)
    high = max(similarity + smooth, low + 1e-6)  # never invert the ramp
    alpha = (dist - low) / (high - low)
    alpha = alpha.clamp(0.0, 1.0)
    # Spill suppression: remove green cast from foreground pixels that are
    # greener than red/blue (the classic "green fringe" fix).
    if spill > 0.0:
        r, g, b = video[..., 0], video[..., 1], video[..., 2]
        spill_f = (g - torch.maximum(r, b)).clamp(0.0, 1.0) * spill * alpha
        r = (r + spill_f).clamp(0.0, 1.0)
        b = (b + spill_f).clamp(0.0, 1.0)
        g = (g * (1 - spill_f * 0.8)).clamp(0.0, 1.0)
        video = torch.stack([r, g, b], dim=-1)
    rgba = torch.cat([video, alpha.unsqueeze(-1)], dim=-1)
    return rgba, alpha


# --------------------------------------------------------------------------- #
# Previews
# --------------------------------------------------------------------------- #


def overlay_preview(video: torch.Tensor, eff_mask: torch.Tensor) -> torch.Tensor:
    """The non-AI view: source video with the edited region tinted red."""
    video = video.float()
    m = eff_mask.unsqueeze(-1)
    tint = torch.tensor([1.0, 0.25, 0.25], dtype=video.dtype, device=video.device).reshape(1, 1, 1, 3)
    return video * (1 - m) + (video * 0.35 + tint * 0.65) * m


def checkerboard_preview(rgba: torch.Tensor, cell: int = 16) -> torch.Tensor:
    """Composite RGBA over a checkerboard so transparency is visible."""
    rgba = rgba.float()
    F, H, W = rgba.shape[0], rgba.shape[1], rgba.shape[2]
    yy = (torch.arange(H, device=rgba.device).unsqueeze(1) // cell) % 2
    xx = (torch.arange(W, device=rgba.device).unsqueeze(0) // cell) % 2
    board = ((yy + xx) % 2).to(rgba.dtype)  # 1 = light square
    board = torch.stack([board * 0.85 + 0.15] * 3, dim=-1)  # [H, W, 3] light/dark gray
    a = rgba[..., 3:4]
    return rgba[..., :3] * a + board.unsqueeze(0) * (1 - a)


# --------------------------------------------------------------------------- #
# Compositing the AI patch back
# --------------------------------------------------------------------------- #


def load_video_file(path: str, max_frames: int = 0) -> torch.Tensor:
    """Load a video file into [F, H, W, 3] float 0..1 (av + PIL)."""
    import av  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    frames: List[torch.Tensor] = []
    with av.open(path) as container:
        stream = next((s for s in container.streams if s.type == "video"), None)
        if stream is None:
            raise ValueError(f"no video stream in {path}")
        stream.thread_type = "AUTO"
        for frame in container.decode(stream):
            arr = frame.to_ndarray(format="rgb24")
            frames.append(torch.from_numpy(np.asarray(arr, dtype=np.float32) / 255.0))
            if max_frames and len(frames) >= max_frames:
                break
    if not frames:
        raise ValueError(f"no frames decoded from {path}")
    return torch.stack(frames)


def composite_patch(
    base: torch.Tensor,
    patch: torch.Tensor,
    mask: Optional[torch.Tensor],
    box: Tuple[int, int, int, int],
    use_mask: bool = True,
) -> torch.Tensor:
    """Paste an AI-patched clip back onto the source.

    * full-frame patches (full-plate output): pass box (0, 0, W, H) — the patch
      is resized to the full frame and pasted.
    * cropped patches (crop-plate output): pass the node's `crop_box`; the
      patch is resized to the box and pasted.  With `use_mask` (default), only
      the effective-mask region is replaced (inpaint-inside); with outpaint
      (use_mask=False) the whole patch is pasted so new content outside the old
      mask survives.
    """
    base = base.float()
    patch = patch.float()
    if base.dim() == 5:
        base = base[0]
    if patch.dim() == 5:
        patch = patch[0]
    F, H, W = base.shape[0], base.shape[1], base.shape[2]
    if patch.shape[0] != F:
        raise ValueError(f"Composite Patch: base has {F} frames, patch has {patch.shape[0]}")
    x, y, w, h = box
    if w <= 0 or h <= 0:
        x, y, w, h = 0, 0, W, H
    x = max(0, min(W - 1, int(x)))
    y = max(0, min(H - 1, int(y)))
    w = max(1, min(W - x, int(w)))
    h = max(1, min(H - y, int(h)))
    out = base.clone()
    resized = _resize(patch, h, w)
    if use_mask and mask is not None:
        m = mask.float()
        if m.dim() == 4:
            m = m.squeeze(0)
        if m.shape[0] != F:
            if m.dim() == 2:
                m = m.unsqueeze(0).expand(F, -1, -1)
            else:
                raise ValueError(
                    f"Composite Patch: mask has {m.shape[0]} frames but base has {F} — "
                    "feed the alpha MASK output of ChaoticH3VideoEdit so frame counts match"
                )
        region = m[:, y:y + h, x:x + w].unsqueeze(-1)
        region = _resize(region, h, w)
    else:
        region = torch.ones(F, h, w, 1, dtype=base.dtype, device=base.device)
    out[:, y:y + h, x:x + w] = base[:, y:y + h, x:x + w] * (1 - region) + resized * region
    return out
