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
