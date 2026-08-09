"""Tests for the Chaotic H3 Video Edit utilities (video_edit.py)."""

from __future__ import annotations

import base64
import io
import json

import pytest
import torch

from ChaoticMinimaxH3Director.video_edit import (
    build_masks,
    checkerboard_preview,
    chroma_key,
    composite_patch,
    crop_plate,
    default_edit_dict,
    effective_mask,
    mask_bbox,
    masked_plate,
    overlay_preview,
    parse_edit_data,
)


def _mask_png(tensor_w: int, tensor_h: int, rect):
    """Encode a [tensor_h, tensor_w] 0..1 mask as a base64 PNG (white = masked)."""
    from PIL import Image

    img = Image.new("L", (tensor_w, tensor_h), 0)
    x0, y0, x1, y1 = rect
    for yy in range(max(0, y0), min(tensor_h, y1)):
        for xx in range(max(0, x0), min(tensor_w, x1)):
            img.putpixel((xx, yy), 255)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _edit_with_mask(keys):
    d = default_edit_dict()
    d["mask"] = {"type": "rect", "keys": keys}
    return d


def _video(frames=4, h=64, w=96, value=0.5):
    return torch.full((frames, h, w, 3), value)


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #


def test_parse_edit_data_validates():
    d = parse_edit_data(json.dumps({
        "mode": "chroma",
        "edit": "outside",
        "plate_color": "green",
        "output": "crop",
        "crop_scale": 2.0,
        "outpaint": True,
        "prompt": "fix the face",
        "video_file": "in/clip.mp4",
        "mask": {"type": "brush", "keys": [
            {"t": 2.0, "grid_w": 24, "grid_h": 16, "png": "a"},
            {"t": 0.5, "grid_w": 24, "grid_h": 16, "png": "b"},
        ]},
        "chroma": {"color": [0, 1, 0], "similarity": 0.4, "smooth": 0.1, "spill": 0.2},
    }))
    assert d["mode"] == "chroma"
    assert d["edit"] == "outside"
    assert d["plate_color"] == "green"
    assert d["output"] == "crop"
    assert d["crop_scale"] == pytest.approx(2.0)
    assert d["outpaint"] is True
    assert d["mask"]["keys"][0]["t"] == pytest.approx(0.5)  # sorted
    assert d["chroma"]["similarity"] == pytest.approx(0.4)


def test_parse_edit_data_defaults_and_clamps():
    d = parse_edit_data("{}")
    assert d["mode"] == "inpaint"
    assert d["edit"] == "inside"
    assert d["plate_color"] == "black"
    assert d["output"] == "full"
    assert d["mask"]["keys"] == []
    d = parse_edit_data(json.dumps({"crop_scale": 99, "mode": "bogus", "chroma": {"similarity": 2.0}}))
    assert d["crop_scale"] == pytest.approx(4.0)
    assert d["mode"] == "inpaint"
    assert d["chroma"]["similarity"] == pytest.approx(0.95)
    with pytest.raises(ValueError):
        parse_edit_data("{not json")


# --------------------------------------------------------------------------- #
# Masks
# --------------------------------------------------------------------------- #


def test_build_masks_no_keys_is_empty():
    edit = default_edit_dict()
    masks = build_masks(edit, 24, 8, 64, 96)
    assert masks.shape == (8, 64, 96)
    assert masks.max() == 0.0


def test_build_masks_cross_fades_between_keys():
    gw, gh = 24, 16
    small = _mask_png(gw, gh, (2, 2, 8, 8))    # small white square
    big = _mask_png(gw, gh, (1, 1, 23, 15))    # big white square
    edit = _edit_with_mask([
        {"t": 0.0, "grid_w": gw, "grid_h": gh, "png": small},
        {"t": 2.0, "grid_w": gw, "grid_h": gh, "png": big},
    ])
    masks = build_masks(edit, 1, 3, 64, 96)   # t = 0, 1, 2 (frame 1 = midpoint)
    assert masks.shape == (3, 64, 96)
    # grid (4,4) is inside BOTH squares -> stays 1.0 at any blend
    assert masks[0, 16, 16].item() == pytest.approx(1.0)
    assert masks[1, 16, 16].item() == pytest.approx(1.0)
    # grid (12,8) is only in the big square -> half mask at the midpoint
    assert masks[1, 32, 48].item() == pytest.approx(0.5)
    # holds before first key / after last key
    masks_hold = build_masks(edit, 1, 4, 64, 96)  # t = 0,1,2,3
    assert masks_hold[3, 32, 48].item() == pytest.approx(1.0)


def test_effective_mask_inverts_for_outside():
    m = torch.zeros(4, 8, 8)
    m[:, 2:6, 2:6] = 1.0
    assert effective_mask(m, "inside") is m
    out = effective_mask(m, "outside")
    assert out[0, 4, 4] == pytest.approx(0.0)
    assert out[0, 0, 0] == pytest.approx(1.0)


# --------------------------------------------------------------------------- #
# Plates
# --------------------------------------------------------------------------- #


def test_masked_plate_voids_unmasked_region():
    video = _video(value=0.5)
    m = torch.zeros(4, 64, 96)
    m[:, 10:20, 10:20] = 1.0
    black = masked_plate(video, m, (0.0, 0.0, 0.0))
    assert black[0, 15, 15].tolist() == pytest.approx([0.5, 0.5, 0.5])
    assert black[0, 0, 0].tolist() == pytest.approx([0.0, 0.0, 0.0])
    green = masked_plate(video, m, (0.0, 1.0, 0.0))
    assert green[0, 0, 0].tolist() == pytest.approx([0.0, 1.0, 0.0])
    assert green[0, 15, 15].tolist() == pytest.approx([0.5, 0.5, 0.5])
    # outside mode: the mask region is voided, everything else keeps the video
    out = masked_plate(video, effective_mask(m, "outside"), (0.0, 0.0, 0.0))
    assert out[0, 15, 15].tolist() == pytest.approx([0.0, 0.0, 0.0])
    assert out[0, 0, 0].tolist() == pytest.approx([0.5, 0.5, 0.5])


def test_mask_bbox_union_across_frames():
    m = torch.zeros(4, 64, 96)
    m[0, 10:20, 10:20] = 1.0
    m[2, 30:40, 50:60] = 1.0
    assert mask_bbox(m) == (10, 10, 50, 30)


def test_crop_plate_scales_and_pads_to_64():
    plate = _video(frames=2, value=0.7)
    bbox = (16, 8, 40, 24)  # 40x24 content
    crop = crop_plate(plate, bbox, scale=1.0)
    assert crop.shape[0] == 2
    assert crop.shape[2] % 64 == 0 and crop.shape[1] % 64 == 0
    # content aspect preserved: content region is 40x24 scaled by 1 -> 40x24,
    # centered inside the 64x64 pad
    assert crop.shape[1:3] == (64, 64)
    # center of the crop holds the plate content
    assert crop[0, 32, 32, 0].item() == pytest.approx(0.7)
    # corners are void
    assert crop[0, 0, 0, 0].item() == pytest.approx(0.0)
    # scaled crop keeps content proportionally
    crop2 = crop_plate(plate, bbox, scale=2.0)
    assert crop2.shape[1:3] == (64, 128)  # 80x48 -> padded to 64x128
    with pytest.raises(ValueError):
        crop_plate(plate, (0, 0, 0, 0))


# --------------------------------------------------------------------------- #
# Chroma key
# --------------------------------------------------------------------------- #


def test_chroma_key_removes_green_and_keeps_subject():
    video = torch.zeros(2, 16, 16, 3)
    video[:, :, :, 1] = 1.0          # pure green background
    video[:, 4:12, 4:12, :] = torch.tensor([0.8, 0.2, 0.2])  # reddish subject
    rgba, alpha = chroma_key(video, [0.0, 1.0, 0.0], similarity=0.35, smooth=0.12, spill=0.2)
    assert rgba.shape == (2, 16, 16, 4)
    assert alpha[0, 2, 2].item() == pytest.approx(0.0)     # background keyed out
    assert alpha[0, 8, 8].item() == pytest.approx(1.0)     # subject kept
    # spill suppression reduces the green cast on the subject
    assert rgba[0, 8, 8, 1].item() < 0.35


def test_chroma_key_survives_zero_similarity_and_smooth():
    # degenerate sliders must not invert the alpha ramp (regression)
    video = torch.zeros(2, 8, 8, 3)
    video[:, :, :, 1] = 1.0
    rgba, alpha = chroma_key(video, [0.0, 1.0, 0.0], similarity=0.0, smooth=0.0)
    assert rgba.shape == (2, 8, 8, 4)
    assert float(alpha.min()) >= 0.0 and float(alpha.max()) <= 1.0
    # everything is exactly the key color -> fully keyed out
    assert float(alpha.max()) < 0.01


def test_composite_rejects_mismatched_mask_frames():
    base = _video(frames=2, value=0.2)
    patch = _video(frames=2, value=0.9)
    m = torch.zeros(3, 64, 96)   # 3 frames vs base 2 -> clear error, not silent
    with pytest.raises(ValueError, match="mask has 3 frames"):
        composite_patch(base, patch, m, (10, 10, 10, 10), use_mask=True)


def test_checkerboard_preview_shows_alpha():
    rgba = torch.zeros(1, 8, 8, 4)
    rgba[..., 3] = 1.0        # opaque black
    rgba[0, 0, 0, 3] = 0.0    # one transparent pixel
    preview = checkerboard_preview(rgba)
    assert preview.shape == (1, 8, 8, 3)
    assert preview[0, 0, 0, 0].item() > 0.15  # board shows through


def test_overlay_preview_tints_edited_region():
    video = _video(frames=2, value=0.5)
    m = torch.zeros(2, 64, 96)
    m[:, 10:20, 10:20] = 1.0
    preview = overlay_preview(video, m)
    # tint is 65% red over a 0.5 gray video -> 0.5*0.35 + 1.0*0.65 = 0.825
    assert preview[0, 15, 15, 0].item() == pytest.approx(0.825)
    assert preview[0, 0, 0, 0].item() == pytest.approx(0.5)


# --------------------------------------------------------------------------- #
# Composite
# --------------------------------------------------------------------------- #


def test_composite_full_frame():
    base = _video(frames=3, value=0.2)
    patch = _video(frames=3, value=0.9)
    out = composite_patch(base, patch, None, (0, 0, 0, 0), use_mask=True)
    assert out.shape == base.shape
    assert out[0, 0, 0].tolist() == pytest.approx([0.9, 0.9, 0.9])


def test_composite_crop_box_with_mask():
    base = _video(frames=2, value=0.2)
    patch = _video(frames=2, value=0.9)
    m = torch.zeros(2, 64, 96)
    m[:, 10:20, 10:20] = 1.0
    box = (10, 10, 10, 10)
    out = composite_patch(base, patch, m, box, use_mask=True)
    assert out[0, 15, 15].tolist() == pytest.approx([0.9, 0.9, 0.9])   # masked -> patched
    assert out[0, 0, 0].tolist() == pytest.approx([0.2, 0.2, 0.2])     # outside untouched
    # with use_mask off, the whole box is pasted
    out2 = composite_patch(base, patch, m, box, use_mask=False)
    assert out2[0, 12, 12].tolist() == pytest.approx([0.9, 0.9, 0.9])


def test_composite_handles_5d_and_bad_frames():
    base = _video(frames=2, value=0.2).unsqueeze(0)
    patch = _video(frames=3, value=0.9)
    with pytest.raises(ValueError):
        composite_patch(base[0], patch, None, (0, 0, 0, 0))
    out = composite_patch(base, _video(frames=2, value=0.9), None, (0, 0, 0, 0))
    assert out.dim() == 4
