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
        "chroma": {"color": [0.0, 1.0, 0.0], "similarity": 0.35, "smooth": 0.12, "spill": 0.15},
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
    d["mode"] = data.get("mode") if data.get("mode") in ("inpaint", "chroma") else "inpaint"
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
        }
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


# --------------------------------------------------------------------------- #
# Chroma key
# --------------------------------------------------------------------------- #


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
