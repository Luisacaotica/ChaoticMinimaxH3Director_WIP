"""Tests for the Mockup Editor scene renderer (mockup.py) and the Director
storyboard integration (chunking.attach_storyboard + prompt_assembly lines)."""

from __future__ import annotations

import json

import pytest

from ChaoticMinimaxH3Director.chunking import attach_storyboard, plan_chunks
from ChaoticMinimaxH3Director.mockup import (
    default_scene_dict,
    parse_scene,
    props_at,
    render_scene,
)
from ChaoticMinimaxH3Director.prompt_assembly import assemble_chunk_prompt
from ChaoticMinimaxH3Director.timeline import (
    assign_global_tags,
    default_timeline_dict,
    parse_timeline,
)


def _color_scene(layers, bg=(16, 18, 22)):
    scene = default_scene_dict()
    scene["bg"] = {"type": "color", "color": list(bg)}
    scene["layers"] = layers
    return scene


def _solid_layer(color, size=64, **props):
    import os
    import tempfile
    from PIL import Image

    sprite = Image.new("RGBA", (size, size), color + (255,))
    handle, path = tempfile.mkstemp(suffix=".png")
    os.close(handle)
    sprite.save(path)
    layer = {
        "id": f"l_{color[0]}_{color[1]}_{color[2]}",
        "type": "image",
        "name": f"c{color}",
        "file": path,
        "fit": "contain",
        "x": 0.5,
        "y": 0.5,
        "scale": 1.0,
        "rotation": 0,
        "opacity": 1.0,
        "text": "",
        "color": "#ffffff",
        "font_size": 0.06,
        "trim_start": 0,
        "keys": [],
    }
    layer.update(props)
    return layer


def test_props_interpolation_and_visibility():
    layer = {
        "id": "a", "type": "image", "name": "", "file": "",
        "fit": "contain", "x": 0.5, "y": 0.5, "scale": 1.0,
        "rotation": 0, "opacity": 1.0, "text": "", "color": "#fff",
        "font_size": 0.06, "trim_start": 0,
        "keys": [
            {"t": 0.0, "x": 0.0, "y": 0.0, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
            {"t": 2.0, "x": 1.0, "y": 1.0, "scale": 2.0, "rotation": 90.0, "opacity": 0.0},
        ],
    }
    assert props_at(layer, -0.1) is None          # hidden before first key
    assert props_at(layer, 2.1) is None           # hidden after last key
    mid = props_at(layer, 1.0)
    assert mid is not None
    assert mid["x"] == pytest.approx(0.5)         # linear lerp
    assert mid["scale"] == pytest.approx(1.5)
    assert mid["opacity"] == pytest.approx(0.5)
    assert props_at(layer, 2.0)["rotation"] == pytest.approx(90.0)

    static = dict(layer, keys=[])
    assert props_at(static, 999.0) is not None    # no keys => always visible
    assert props_at(static, 999.0)["x"] == 0.5


def test_render_shape_and_range():
    scene = _color_scene([])
    frames, warnings = render_scene(scene, 128, 96, fps=12, duration_sec=1.0)
    assert frames.shape == (1, 12, 96, 128, 3)
    assert frames.min() >= 0.0 and frames.max() <= 1.0
    assert warnings == []


def test_opacity_blends_toward_background():
    # bg medium gray, black square at 50% opacity covering the stage -> ~0.25 gray
    scene = _color_scene([_solid_layer((0, 0, 0), opacity=0.5)], bg=(128, 128, 128))
    frames, _ = render_scene(scene, 64, 64, fps=2, duration_sec=0.5)
    center = frames[0, 0, 32, 32].tolist()
    assert abs(center[0] - 0.25) < 0.02, center
    assert abs(center[1] - 0.25) < 0.02, center


def test_layer_order_top_draws_last():
    # layers list is top-first: index 0 is the TOP layer (Photoshop style)
    scene = _color_scene([
        _solid_layer((0, 255, 0)),   # green — top
        _solid_layer((255, 0, 0)),   # red — bottom
    ])
    frames, _ = render_scene(scene, 64, 64, fps=1, duration_sec=0.5)
    px = frames[0, 0, 32, 32].tolist()
    assert px[1] > 0.95 and px[0] < 0.05, px  # green wins


def test_text_layer_renders_content():
    scene = default_scene_dict()
    scene["layers"] = [{
        "id": "t", "type": "text", "name": "Title", "file": "",
        "fit": "contain", "x": 0.5, "y": 0.5, "scale": 1.0, "rotation": 0,
        "opacity": 1.0, "text": "HELLO", "color": "#ffffff", "font_size": 0.4,
        "trim_start": 0, "keys": [],
    }]
    frames, _ = render_scene(scene, 128, 128, fps=1, duration_sec=0.5)
    frame = frames[0, 0]
    assert frame.max() > 0.9                      # bright glyphs on dark bg
    assert float(frame.std()) > 0.05              # ...and they are not uniform
    # Text must NOT be contain-fitted to the stage: a font_size=0.4 title stays
    # a small centered overlay (a contain-fitted title would cover most of the frame).
    bright_frac = float((frame > 0.5).float().mean())
    assert bright_frac < 0.5, f"text covers {bright_frac:.2%} of the frame"


def test_keyframe_easing_modes():
    base = {
        "id": "e", "type": "image", "name": "", "file": "",
        "fit": "contain", "x": 0.0, "y": 0.5, "scale": 1.0,
        "rotation": 0, "opacity": 1.0, "text": "", "color": "#fff",
        "font_size": 0.06, "trim_start": 0,
        "keys": [
            {"t": 0.0, "ease": "out", "x": 0.0, "y": 0.5, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
            {"t": 2.0, "x": 1.0, "y": 0.5, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
        ],
    }
    # ease-out: fast start, slow end -> x(0.75) > linear x(0.5) at the midpoint
    assert props_at(base, 1.0)["x"] == pytest.approx(0.75)

    # ease-in: slow start, fast end -> x(0.25) < linear at the midpoint
    ease_in = dict(base, keys=[dict(base["keys"][0], ease="in"), base["keys"][1]])
    assert props_at(ease_in, 1.0)["x"] == pytest.approx(0.25)

    # inout smoothstep is symmetric: still 0.5 at the midpoint, but the curve differs
    inout = dict(base, keys=[dict(base["keys"][0], ease="inout"), base["keys"][1]])
    assert props_at(inout, 1.0)["x"] == pytest.approx(0.5)
    f = 0.25 / 2.0  # linear progress over the 2 s segment
    f2 = f * f * (3 - 2 * f)  # smoothstep
    assert props_at(inout, 0.25)["x"] == pytest.approx(f2)

    # missing ease defaults to linear
    lin = dict(base, keys=[dict(base["keys"][0], ease="linear"), base["keys"][1]])
    assert props_at(lin, 1.0)["x"] == pytest.approx(0.5)

    # hold: the pose stays at key A for the whole segment, then jumps at key B
    hold = dict(base, keys=[
        {"t": 0.0, "ease": "hold", "x": 0.2, "y": 0.5, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
        {"t": 2.0, "x": 0.9, "y": 0.5, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
    ])
    assert props_at(hold, 0.5)["x"] == pytest.approx(0.2)
    assert props_at(hold, 1.5)["x"] == pytest.approx(0.2)
    assert props_at(hold, 2.0)["x"] == pytest.approx(0.9)


def test_parse_scene_validates_key_ease():
    scene = {
        "version": 1, "aspect": "16:9",
        "bg": {"type": "color", "color": [0, 0, 0]},
        "layers": [{
            "id": "l", "type": "image", "name": "", "file": "", "fit": "contain",
            "x": 0.5, "y": 0.5, "scale": 1, "rotation": 0, "opacity": 1,
            "text": "", "color": "#fff", "font_size": 0.06, "trim_start": 0,
            "keys": [
                {"t": 0.0, "ease": "inout", "x": 0.1, "y": 0.5, "scale": 1, "rotation": 0, "opacity": 1},
                {"t": 1.0, "ease": "bogus", "x": 0.9, "y": 0.5, "scale": 1, "rotation": 0, "opacity": 1},
                {"t": 2.0, "x": 0.5, "y": 0.5, "scale": 1, "rotation": 0, "opacity": 1},
            ],
        }],
        "audio": {"file": "", "trim_start": 0, "trim_end": None},
    }
    keys = parse_scene(json.dumps(scene))["layers"][0]["keys"]
    assert keys[0]["ease"] == "inout"   # valid mode kept
    assert keys[1]["ease"] == "linear"  # unknown mode -> linear
    assert keys[2]["ease"] == "linear"  # missing -> linear


def test_aspect_round_trips_through_parse_and_default():
    default = default_scene_dict()
    assert default["aspect"] == "16:9"

    parsed = parse_scene(json.dumps(default))
    assert parsed["aspect"] == "16:9"

    # A portrait scene from the widget keeps its aspect through parse.
    scene = dict(default, aspect="9:16")
    assert parse_scene(json.dumps(scene))["aspect"] == "9:16"

    # Unknown/absent aspect falls back to landscape.
    assert parse_scene("{}")["aspect"] == "16:9"


def test_missing_assets_warn_not_crash():
    scene = _color_scene([
        {"id": "bad", "type": "image", "name": "missing", "file": "/nonexistent/x.png",
         "fit": "contain", "x": 0.5, "y": 0.5, "scale": 1.0, "rotation": 0,
         "opacity": 1.0, "text": "", "color": "#fff", "font_size": 0.06,
         "trim_start": 0, "keys": []},
        {"id": "badvid", "type": "video", "name": "missing video", "file": "/nonexistent/v.mp4",
         "fit": "contain", "x": 0.5, "y": 0.5, "scale": 1.0, "rotation": 0,
         "opacity": 1.0, "text": "", "color": "#fff", "font_size": 0.06,
         "trim_start": 0, "keys": [{"t": 0.0, "x": 0.5, "y": 0.5, "scale": 1.0, "rotation": 0.0, "opacity": 1.0}]},
    ])
    frames, warnings = render_scene(scene, 64, 64, fps=2, duration_sec=0.5)
    assert frames.shape[1] == 1                   # still rendered (bg only)
    assert len(warnings) >= 1


def test_attach_storyboard_tags_after_real_videos_and_flows_into_prompt():
    data = default_timeline_dict()
    data["shots"] = [
        {"id": "s1", "start": 0.0, "duration": 4.0, "text": "[Shot 1] Follow the storyboard.", "format": "auto"},
    ]
    data["refs"] = [
        {"id": "clip", "kind": "video", "file": "clip.mp4", "name": "Clip",
         "start": 0.0, "duration": 4.0, "strength": 0.6, "timed": True},
    ]
    timeline = parse_timeline(json.dumps(data))
    plans = plan_chunks(timeline, 124, 24, "keyframe+picture", False)
    attach_storyboard(plans)

    storyboard_entries = [e for e in plans[0].ref_entries if e.is_storyboard]
    assert len(storyboard_entries) == 1
    assert storyboard_entries[0].tag == "<Video 2>"   # after the real <Video 1>
    assert plans[0].storyboard_tag == "<Video 2>"

    bundle = assemble_chunk_prompt(
        timeline, 0, 0.0, plans[0].shots, plans[0].ref_entries,
        plans[0].anchor_tag, assign_global_tags(timeline), {},
    )
    assert "storyboard" in bundle.prompt
    assert "<Video 2>" in bundle.prompt
    assert "fully_preserved" in bundle.prompt


def _speed_layer(speed=None):
    layer = {
        "id": "sp", "type": "image", "name": "", "file": "",
        "fit": "contain", "x": 0.3, "y": 0.6, "scale": 1.0,
        "rotation": 0, "opacity": 1.0, "text": "", "color": "#fff",
        "font_size": 0.06, "trim_start": 0,
        "keys": [
            {"t": 0.0, "x": 0.3, "y": 0.6, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
            {"t": 2.0, "x": 0.7, "y": 0.4, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
        ],
    }
    if speed is not None:
        layer["speed"] = speed
    return layer


def test_parse_scene_defaults_and_validates_layer_speed():
    scene = _color_scene([_speed_layer()])
    assert parse_scene(json.dumps(scene))["layers"][0]["speed"] == 1.0

    scene = _color_scene([_speed_layer(2.5)])
    assert parse_scene(json.dumps(scene))["layers"][0]["speed"] == 2.5

    scene = _color_scene([_speed_layer(99)])
    assert parse_scene(json.dumps(scene))["layers"][0]["speed"] == 4.0   # clamped

    scene = _color_scene([_speed_layer("bogus")])
    assert parse_scene(json.dumps(scene))["layers"][0]["speed"] == 1.0   # sanitized


def test_props_at_speed_warps_motion():
    # keys are authored in LAYER time: project_t = key_t / speed
    fast = _speed_layer(2.0)
    assert props_at(fast, 1.0)["x"] == pytest.approx(0.7)   # local t=2 -> final key
    assert props_at(fast, 0.5)["x"] == pytest.approx(0.5)   # local t=1 -> midpoint
    assert props_at(fast, 1.5) is None                       # local t=3 -> outside window

    slow = _speed_layer(0.5)
    assert props_at(slow, 2.0)["x"] == pytest.approx(0.5)   # local t=1 -> midpoint
    assert props_at(slow, 4.0)["x"] == pytest.approx(0.7)   # local t=2 -> final key

    # speed 1 == the classic behavior, byte for byte
    assert props_at(_speed_layer(1.0), 1.0)["x"] == pytest.approx(0.5)


def test_render_scene_two_layers_at_different_speeds():
    # two solid sprites drifting right at different speeds; non-overlapping rows
    fast = _solid_layer((200, 40, 40), size=32)   # red, y=0.25 (top)
    fast["id"] = "fast"
    fast["speed"] = 2.0
    fast["keys"] = [
        {"t": 0.0, "x": 0.25, "y": 0.25, "scale": 0.5, "rotation": 0.0, "opacity": 1.0},
        {"t": 2.0, "x": 0.75, "y": 0.25, "scale": 0.5, "rotation": 0.0, "opacity": 1.0},
    ]
    slow = _solid_layer((40, 40, 200), size=32)   # blue, y=0.85 (bottom)
    slow["id"] = "slow"
    slow["speed"] = 0.5
    slow["keys"] = [
        {"t": 0.0, "x": 0.25, "y": 0.85, "scale": 0.5, "rotation": 0.0, "opacity": 1.0},
        {"t": 2.0, "x": 0.75, "y": 0.85, "scale": 0.5, "rotation": 0.0, "opacity": 1.0},
    ]
    scene = _color_scene([fast, slow])
    frames, warnings = render_scene(scene, 128, 128, fps=4, duration_sec=1.0)
    assert frames.shape == (1, 4, 128, 128, 3)
    assert len(warnings) == 0
    mid = frames[0, 2]  # t=0.5, values are float 0..1
    # fast: local t=1 -> x=0.5 -> cx=64, cy=32 (red)
    # slow: local t=0.25 -> x=0.3125 -> cx=40, cy=109 (blue)
    assert mid[32, 64, 0].item() > 0.6 and mid[32, 64, 2].item() < 0.4   # red sprite at cx=64
    assert mid[109, 40, 2].item() > 0.6 and mid[109, 40, 0].item() < 0.4  # blue sprite at cx=40
    assert mid[70, 10, 0].item() < 0.2                                     # empty corner stays bg
