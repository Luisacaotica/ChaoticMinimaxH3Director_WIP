"""Tests for the Chaotic H3 Video Edit utilities (video_edit.py)."""

from __future__ import annotations

import base64
import io
import json

import pytest
import torch

from ChaoticMinimaxH3Director.video_edit import (
    apply_render_window,
    build_masks,
    checkerboard_preview,
    chroma_key,
    composite_patch,
    crop_plate,
    decode_refs,
    default_edit_dict,
    detect_key_color,
    effective_mask,
    mask_bbox,
    masked_plate,
    overlay_preview,
    parse_edit_data,
    reframe_plate,
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


def test_tracked_mask_keys_move_the_region():
    """A client-side track writes translated keys — the renderer must move the
    masked region with them (the mask follows the subject)."""
    gw, gh = 32, 24
    rect_a = _mask_png(gw, gh, (4, 4, 12, 12))    # subject at grid 4..12
    rect_b = _mask_png(gw, gh, (12, 8, 20, 16))   # translated +8,+4, like a track
    edit = _edit_with_mask([
        {"t": 0.0, "grid_w": gw, "grid_h": gh, "png": rect_a},
        {"t": 1.0, "grid_w": gw, "grid_h": gh, "png": rect_b},
    ])
    masks = build_masks(edit, 2, 4, 96, 128)      # t = 0, 0.5, 1.0, 1.5
    # video grid = 128//4 x 96//4 = 32x24 -> 4 video px per grid cell
    assert mask_bbox(masks[0]) == (16, 16, 32, 32)   # rect_a at t=0
    assert mask_bbox(masks[2]) == (48, 32, 32, 32)   # rect_b at t=1.0 exactly
    mid = mask_bbox(masks[1])                        # t=0.5: cross-fade spans both
    assert mid == (16, 16, 64, 48), mid
    # the region really moved: a cell inside B (but outside A) is masked only later
    assert masks[0, 40, 60].item() == pytest.approx(0.0)   # not in A at t=0
    assert masks[2, 40, 60].item() == pytest.approx(1.0)   # inside B at t=1
    assert masks[0, 30, 30].item() == pytest.approx(1.0)   # inside A at t=0
    assert masks[2, 30, 30].item() == pytest.approx(0.0)   # left behind at t=1


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


def test_detect_key_color_finds_dominant_backdrop():
    # blue screen with a red subject in the middle
    frame = torch.zeros(64, 96, 3)
    frame[..., 2] = 1.0
    frame[20:44, 30:66] = torch.tensor([0.9, 0.1, 0.1])
    color, frac = detect_key_color(frame)
    assert color[2] > 0.8 and color[0] < 0.2, color
    assert frac > 0.5

    # green screen
    frame2 = torch.zeros(48, 64, 3)
    frame2[..., 1] = 1.0
    frame2[16:32, 20:44] = torch.tensor([0.2, 0.2, 0.8])
    color2, frac2 = detect_key_color(frame2)
    assert color2[1] > 0.8 and color2[2] < 0.3, color2
    assert frac2 > 0.5

    # magenta backdrop
    frame3 = torch.zeros(48, 64, 3)
    frame3[..., 0] = 1.0
    frame3[..., 2] = 1.0
    color3, _ = detect_key_color(frame3)
    assert color3[0] > 0.8 and color3[2] > 0.8, color3

    # 4D batch input -> first frame
    color4, _ = detect_key_color(frame.unsqueeze(0))
    assert color4[2] > 0.8, color4

    # RGBA insurance — extra channel is sliced off, not a reshape crash
    rgba = torch.cat([frame, torch.ones(64, 96, 1)], dim=-1)
    color5, _ = detect_key_color(rgba)
    assert color5[2] > 0.8, color5


def test_parse_edit_data_preserves_chroma_auto():
    d = parse_edit_data(json.dumps({
        "mode": "chroma",
        "chroma": {"color": [0, 0, 1], "similarity": 0.3, "smooth": 0.1, "spill": 0.2, "auto": True},
    }))
    assert d["chroma"]["auto"] is True
    assert d["chroma"]["color"] == [0.0, 0.0, 1.0]
    d2 = parse_edit_data(json.dumps({
        "mode": "chroma",
        "chroma": {"color": [0, 0, 1], "similarity": 0.3, "smooth": 0.1, "spill": 0.2},
    }))
    assert d2["chroma"]["auto"] is False
    assert default_edit_dict()["chroma"]["auto"] is False


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


def test_reframe_plate_vertical_to_horizontal():
    # 32x64 vertical source -> 96x54 (16:9) target, centered, black void
    vid = _video(frames=2, h=64, w=32, value=0.5)
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": 96, "target_h": 54, "feather": 8, "align_x": 0.5, "align_y": 0.5})
    plate, eff, box = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    assert tuple(plate.shape) == (2, 54, 96, 3), plate.shape
    assert tuple(eff.shape) == (2, 54, 96), eff.shape
    x, y, w, h = box
    assert w == 27 and h == 54, box  # 32/64 * 0.84375
    assert x == 34 and y == 0, box
    # source fills the window, void everywhere else
    assert float(plate[0, 20, 40, 0]) > 0.45, "window should keep the source"
    assert float(plate[0, 20, 10, 0]) < 0.05, "outside should be void"
    # eff: 0 inside the window (kept), 1 outside (outpaint) — sample window center
    assert float(eff[0, 27, 47]) < 0.1, "inside should not be outpainted"
    assert float(eff[0, 20, 5]) > 0.9, "outside should be outpainted"


def test_reframe_plate_align_and_preserve():
    vid = _video(frames=2, h=64, w=32, value=0.5)
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": 96, "target_h": 54, "feather": 0, "align_x": 0.0, "align_y": 0.5})
    plate, eff, box = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    assert box[0] == 0, "align_x=0 pins the window to the left edge"
    # a brush stroke OUTSIDE the window preserves that spot (not outpainted)
    preserve = torch.zeros(2, 64, 32)
    preserve[:, 0:10, 0:10] = 1.0  # top-left of the source -> top-left of window
    plate2, eff2, box2 = reframe_plate(vid, rf, (0.0, 0.0, 0.0), preserve)
    assert box2 == box
    assert float(eff2[0, 4, 4]) < 0.1, "preserved brush stroke must stay intact"
    assert float(eff2[0, 20, 40]) > 0.9, "rest of the outside still outpaints"


def test_reframe_plate_feather_softens_edge():
    vid = _video(frames=1, h=16, w=8, value=0.5)
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": 24, "target_h": 24, "feather": 2, "align_x": 0.5, "align_y": 0.5})
    _, eff, _ = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    vals = sorted(float(v) for v in eff[0].unique().tolist())
    assert len(vals) >= 3, "feathered edge should produce intermediate values"
    assert vals[0] < 0.05 and vals[-1] > 0.95


def test_parse_edit_data_reframe_refs_video_fps():
    d = parse_edit_data(json.dumps({
        "mode": "reframe",
        "reframe": {"target_w": 1920, "target_h": 1080, "feather": 12, "align_x": 0, "align_y": 1},
        "refs": [{"src": "QUJD", "at": 1.5}],
        "video_fps": 29.97,
    }))
    assert d["mode"] == "reframe"
    assert d["reframe"]["target_w"] == 1920 and d["reframe"]["feather"] == 12
    assert d["reframe"]["align_x"] == 0.0 and d["reframe"]["align_y"] == 1.0
    assert len(d["refs"]) == 1 and d["refs"][0]["src"] == "QUJD" and d["refs"][0]["at"] == 1.5
    assert d["video_fps"] == 29.97
    # clamps + defaults survive old scenes
    d2 = parse_edit_data(json.dumps({"mode": "reframe", "reframe": {"feather": 999}}))
    assert d2["reframe"]["feather"] == 64
    d3 = parse_edit_data(json.dumps({"mode": "inpaint"}))
    assert d3["reframe"]["target_w"] == 1280 and d3["refs"] == [] and d3["video_fps"] is None


def test_decode_refs_roundtrip():
    from PIL import Image

    img = Image.new("RGB", (6, 4), (120, 40, 220))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    out = decode_refs([{"src": b64}, {"src": ""}, {"src": "not-base64!!"}])
    assert len(out) == 1, "empty and corrupt entries are skipped"
    assert tuple(out[0].shape) == (4, 6, 3)
    r, g, b = out[0][2, 3].tolist()
    assert abs(r - 120 / 255) < 0.02 and abs(g - 40 / 255) < 0.02 and abs(b - 220 / 255) < 0.02
    assert decode_refs([]) == []


def test_reframe_plate_free_position_align():
    # free-drag contract: any align fraction in [0, 1] maps to a clamped placement
    vid = _video(frames=2, h=64, w=32, value=0.5)  # 32x64 vertical
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": 96, "target_h": 54, "feather": 0, "align_x": 0.25, "align_y": 0.75})
    _, eff, box = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    x, y, w, h = box
    # sw=27, sh=54; sx = round((96-27)*0.25)=17, sy = round((54-54)*0.75)=0
    assert (x, y, w, h) == (17, 0, 27, 54), box
    # extreme fractions clamp to the edges
    rf.update({"align_x": -0.5, "align_y": 1.75})
    _, eff2, box2 = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    x2, y2, _, _ = box2
    assert x2 == 0 and y2 == 0, box2  # clamped: left + top
    rf.update({"align_x": 2.0, "align_y": 0.0})
    _, eff3, box3 = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    assert box3[0] == 96 - 27, box3  # clamped: right edge


def test_apply_render_window_crops_and_shifts_keys():
    edit = parse_edit_data(json.dumps({
        "mode": "inpaint",
        "render_in": 1.0,
        "render_out": 3.0,
        "mask": {"type": "rect", "keys": [{"t": 0.5, "grid_w": 64, "grid_h": 64, "png": ""}, {"t": 2.5, "grid_w": 64, "grid_h": 64, "png": ""}]},
        "reframe": {"track": [{"t": 1.5, "ax": 0.2, "ay": 0.8}]},
    }))
    i0, i1 = apply_render_window(edit, 24, 120)
    # 1.0s..3.0s @ 24fps -> source frames 24..72
    assert (i0, i1) == (24, 72)
    # key times shift so they stay aligned after the crop (clip now starts at 1.0s)
    assert [k["t"] for k in edit["mask"]["keys"]] == [0.0, 1.5]
    assert edit["reframe"]["track"][0]["t"] == 0.5
    # no window -> full range, keys untouched
    edit2 = parse_edit_data(json.dumps({"mode": "inpaint", "mask": {"keys": [{"t": 0.5, "grid_w": 8, "grid_h": 8, "png": ""}]}}))
    assert apply_render_window(edit2, 24, 120) == (0, 120)
    assert edit2["mask"]["keys"][0]["t"] == 0.5
    # empty window raises (when the parser hasn't already normalized it away)
    with pytest.raises(ValueError):
        apply_render_window({"render_in": 5.0, "render_out": 5.0}, 24, 120)
    with pytest.raises(ValueError):
        apply_render_window({"render_in": 6.0, "render_out": 3.0}, 24, 120)


def test_parse_edit_data_render_window():
    d = parse_edit_data(json.dumps({"mode": "inpaint", "render_in": 2.5, "render_out": 9.0}))
    assert d["render_in"] == 2.5 and d["render_out"] == 9.0
    # reversed window is dropped by the parser
    d2 = parse_edit_data(json.dumps({"mode": "inpaint", "render_in": 9.0, "render_out": 2.5}))
    assert d2["render_in"] is None and d2["render_out"] is None
    # defaults survive old projects
    d3 = parse_edit_data(json.dumps({"mode": "inpaint"}))
    assert d3["render_in"] is None and d3["render_out"] is None
    assert default_edit_dict()["render_in"] is None and default_edit_dict()["render_out"] is None
