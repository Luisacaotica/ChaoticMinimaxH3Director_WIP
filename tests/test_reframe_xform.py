"""Tests for the reframe window transform: scale + rotation handles.

`reframe_plate` keeps an exact axis-aligned fast path for the default
(scale=1, rotation=0) geometry — those semantics are covered in
test_video_edit.py.  These tests cover the scaled and rotated paths.
"""

from __future__ import annotations

import json

import torch

from ChaoticMinimaxH3Director.video_edit import (
    default_edit_dict,
    parse_edit_data,
    reframe_plate,
)


def _video(frames=2, h=64, w=32, value=0.5):
    return torch.full((frames, h, w, 3), value)


def test_reframe_plate_scaled_window():
    # scale 2 on a 32x64 portrait -> 54x108 window centered, overflowing the
    # 96x54 target vertically (center stays pinned, edges clip cleanly)
    vid = _video(value=0.5)
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": 96, "target_h": 54, "feather": 0, "scale": 2.0})
    plate, eff, box = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    assert tuple(plate.shape) == (2, 54, 96, 3), plate.shape
    assert box == (21, -27, 54, 108), box  # sw=54, sh=108; center-pinned
    assert float(eff[0, 27, 48]) < 0.1, "window center is covered"
    assert float(eff[0, 27, 5]) > 0.9, "left of the window is outpaint"
    assert float(eff[0, 27, 90]) > 0.9, "right of the window is outpaint"
    assert float(plate[0, 27, 48, 0]) > 0.45, "covered area keeps the source"
    assert float(plate[0, 27, 5, 0]) < 0.05, "outside stays void"


def test_reframe_plate_rotation_90_direction():
    # half-and-half source: left = dark, right = bright.  A +90° rotation is
    # clockwise, so the right (bright) half must land at the BOTTOM of the
    # footprint and the left (dark) half at the TOP.
    vid = _video(value=0.5)
    vid[:, :, :16] = 0.2
    vid[:, :, 16:] = 0.8
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": 96, "target_h": 54, "feather": 0, "rotation": 90.0})
    plate, eff, box = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    assert tuple(plate.shape) == (2, 54, 96, 3), plate.shape
    assert abs(box[0] - 20) <= 1 and abs(box[1] - 13) <= 1, box
    assert abs(box[2] - 54) <= 1 and abs(box[3] - 27) <= 1, box
    # footprint after 90° is 54 wide x 27 tall around the center — sample well
    # inside the regions (the outer ~1px has a soft coverage edge)
    assert float(eff[0, 27, 48]) < 0.1, "center is covered"
    assert float(eff[0, 5, 48]) > 0.9, "above the footprint is outpaint"
    assert float(eff[0, 27, 5]) > 0.9, "left of the footprint is outpaint"
    assert float(eff[0, 35, 48]) < 0.1, "inside the footprint is covered"
    # bright half rotated down, dark half rotated up
    assert float(plate[0, 35, 48, 0]) > 0.7, "bottom = bright (right) half"
    assert float(plate[0, 20, 48, 0]) < 0.3, "top = dark (left) half"


def test_reframe_plate_scale_preserve_still_works():
    # scale 0.5 shrinks the source window; a brush stroke outside the window
    # still preserves its spot (not outpainted)
    vid = _video(value=0.5)
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": 96, "target_h": 54, "feather": 0, "scale": 0.5})
    _, eff, box = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    # sw = round(32 * 0.84375 * 0.5) = round(13.5) = 14; sh = 27
    assert box == (41, 14, 14, 27), box
    assert float(eff[0, 6, 43]) > 0.9, "above the small window = outpaint"
    preserve = torch.zeros(2, 64, 32)
    preserve[:, 0:10, 0:10] = 1.0  # source top-left -> window top-left
    _, eff2, _ = reframe_plate(vid, rf, (0.0, 0.0, 0.0), preserve)
    assert float(eff2[0, 16, 43]) < 0.1, "preserved spot is kept, not outpainted"
    assert float(eff2[0, 6, 43]) > 0.9, "unpainted outside stays outpaint"


def test_parse_reframe_scale_rotation_clamps():
    d = parse_edit_data(json.dumps({
        "mode": "reframe",
        "reframe": {"target_w": 96, "target_h": 54, "scale": 9, "rotation": 500},
    }))
    assert d["reframe"]["scale"] == 4.0
    assert d["reframe"]["rotation"] == 180.0
    d2 = parse_edit_data(json.dumps({
        "mode": "reframe",
        "reframe": {"scale": -1, "rotation": -500},
    }))
    assert d2["reframe"]["scale"] == 0.1
    assert d2["reframe"]["rotation"] == -180.0
    d3 = parse_edit_data("")
    assert d3["reframe"]["scale"] == 1.0
    assert d3["reframe"]["rotation"] == 0.0


def test_default_fit_is_contain():
    rf = default_edit_dict()["reframe"]
    assert rf["fit"] == "contain"
    assert rf["track"] == []


def _track_rf(target_w=96, target_h=54, scale=1.0, fit="smaller"):
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": target_w, "target_h": target_h, "feather": 0, "scale": scale, "fit": fit})
    return rf


def test_reframe_plate_track_keyframes_move_window():
    # source 64x32 (landscape) -> target 96x54, fit smaller: sw=77, sh=38,
    # x travel = 19.  Track animates align_x 0 -> 1 over the first second, so
    # the window slides from flush-left to flush-right across the clip.
    vid = _video(frames=25, h=32, w=64, value=0.5)
    rf = _track_rf()
    rf["track"] = [{"t": 0.0, "ax": 0.0, "ay": 0.5}, {"t": 1.0, "ax": 1.0, "ay": 0.5}]
    plate, eff, box = reframe_plate(vid, rf, (0.0, 0.0, 0.0), fps=24)
    assert box == (0, 8, 77, 38), box  # frame-0 window
    # frame 0 (t=0): window flush left -> x=3 covered, x=90 is void
    assert float(eff[0, 27, 3]) < 0.1, "frame 0 window covers the left"
    assert float(eff[0, 27, 90]) > 0.9, "frame 0 right side is outpaint"
    assert float(plate[0, 27, 3, 0]) > 0.45, "frame 0 keeps the source on the left"
    # frame 24 (t=1): window flush right -> x=90 covered, x=3 is void
    assert float(eff[24, 27, 90]) < 0.1, "frame 24 window covers the right"
    assert float(eff[24, 27, 3]) > 0.9, "frame 24 left side is outpaint"
    assert float(plate[24, 27, 90, 0]) > 0.45, "frame 24 keeps the source on the right"
    # frame 12 (t=0.5): window centered (sx=round(19*0.5)=10) -> middle covered
    assert float(eff[12, 27, 48]) < 0.1, "frame 12 window covers the middle"
    assert float(eff[12, 27, 5]) > 0.9, "frame 12 x=5 is left of the window (void)"


def test_reframe_plate_track_fps_maps_frames_to_seconds():
    vid = _video(frames=49, h=32, w=64, value=0.5)
    rf = _track_rf()
    rf["track"] = [{"t": 0.0, "ax": 0.0, "ay": 0.5}, {"t": 1.0, "ax": 1.0, "ay": 0.5}]
    # fps=48: frame 24 -> t=0.5 (window centered); fps=12: frame 6 -> t=0.5
    _, eff48, _ = reframe_plate(vid, rf, (0.0, 0.0, 0.0), fps=48)
    _, eff12, _ = reframe_plate(vid, rf, (0.0, 0.0, 0.0), fps=12)
    for eff in (eff48[24], eff12[6]):
        assert float(eff[27, 48]) < 0.1, "t=0.5 window covers the middle"
        assert float(eff[27, 5]) > 0.9, "t=0.5 x=5 stays void"


def test_reframe_plate_track_extrapolation_clamps():
    # keys before/after the clip extrapolate to the nearest key, never NaN
    vid = _video(frames=6, h=32, w=64, value=0.5)
    rf = _track_rf()
    rf["track"] = [{"t": 5.0, "ax": 1.0, "ay": 0.0}]  # all frames before the key
    plate, eff, box = reframe_plate(vid, rf, (0.0, 0.0, 0.0), fps=24)
    assert box == (19, 0, 77, 38), box  # clamped to the only key (flush right/top)
    assert float(eff[0, 27, 90]) < 0.1, "window sits right even before the key"
    assert float(eff[0, 27, 3]) > 0.9, "left side is void"
    assert torch.isfinite(plate).all(), "no NaN from extrapolation"


def test_parse_reframe_track_validation():
    d = parse_edit_data(json.dumps({
        "mode": "reframe",
        "reframe": {"track": [
            {"t": 2, "ax": 9, "ay": -1},   # clamped
            {"t": 0.5, "ax": 0.25, "ay": 0.75},
            {"t": 0.5, "ax": 1, "ay": 0},   # same t as previous -> deduped
            {"ax": 0.5},                      # no t -> dropped
            {"t": -1, "ax": 0, "ay": 0},     # negative t -> dropped
            "junk",                           # not a dict -> dropped
        ]},
    }))
    tr = d["reframe"]["track"]
    assert [k["t"] for k in tr] == [0.5, 2.0], "sorted + deduped"
    assert tr[0] == {"t": 0.5, "ax": 1.0, "ay": 0.0}, "last survivor at a time kept (matches the JS upsert)"
    assert tr[1]["ax"] == 1.0 and tr[1]["ay"] == 0.0, "clamped to [0,1]"
    d2 = parse_edit_data(json.dumps({"mode": "reframe", "reframe": {"track": "nope"}}))
    assert d2["reframe"]["track"] == []
    d3 = parse_edit_data(json.dumps({"mode": "reframe"}))
    assert d3["reframe"]["track"] == []


def test_parse_reframe_fit_validation():
    ok = parse_edit_data(json.dumps({"mode": "reframe", "reframe": {"fit": "smaller"}}))
    assert ok["reframe"]["fit"] == "smaller"
    for bad in ("huge", "fill", "", 1, None):
        d = parse_edit_data(json.dumps({"mode": "reframe", "reframe": {"fit": bad}}))
        assert d["reframe"]["fit"] == "contain", f"fit={bad!r} must fall back to contain"
    missing = parse_edit_data(json.dumps({"mode": "reframe"}))
    assert missing["reframe"]["fit"] == "contain"


def test_reframe_plate_fit_smaller_keeps_both_axis_margin():
    # same-aspect source into the target: contain fills the tight axis with
    # zero travel on it; smaller (x SMALLER_FACTOR) leaves room on BOTH axes
    # at scale 1, which is what unlocks free 2D placement for the move tool.
    vid = _video(h=32, w=64, value=0.5)  # landscape 64x32, same 16:9 as the target
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": 96, "target_h": 54, "feather": 0, "scale": 1.0})
    _, _, box_fit = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    assert box_fit[2] == 96, "contain fills the width (tight axis)"
    rf["fit"] = "smaller"
    plate, eff, box_small = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    # s = 1.5 * 0.8 = 1.2 -> sw=round(76.8)=77, sh=round(38.4)=38
    assert box_small == (10, 8, 77, 38), box_small
    assert box_small[2] < 96 and box_small[3] < 54, "both axes have travel room"
    assert float(eff[0, 0, 0]) > 0.9, "outside the smaller window is outpaint"
    assert float(eff[0, 27, 48]) < 0.1, "window center stays covered"
    assert float(plate[0, 27, 48, 0]) > 0.45, "covered area keeps the source"


def test_reframe_plate_fit_smaller_free_placement_geometry():
    # portrait source in a landscape target: with smaller, moving the window
    # horizontally actually travels (contain would pin it flush left/right).
    vid = _video(value=0.5)
    rf = default_edit_dict()["reframe"]
    rf.update({"target_w": 96, "target_h": 54, "feather": 0, "scale": 1.0, "fit": "smaller",
               "align_x": 0.0, "align_y": 0.0})
    _, _, box_l = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    rf["align_x"] = 1.0
    _, _, box_r = reframe_plate(vid, rf, (0.0, 0.0, 0.0))
    assert box_l[2] == box_r[2], "same window size either placement"
    travel = box_r[0] - box_l[0]
    assert travel > 0, "free horizontal travel exists"
    assert box_r[0] + box_r[2] <= 96 and box_l[0] >= 0, "both placements stay inside"
