"""Tests for the timeline data contract (timeline.py)."""

import json

import pytest

from ChaoticMinimaxH3Director.chunking import plan_chunks
from ChaoticMinimaxH3Director.timeline import (
    assign_global_tags,
    default_timeline_dict,
    parse_timeline,
    resolve_render_window,
    slice_timeline,
    subject_shorthands,
    timeline_issues,
)


def make_timeline_json(shots=None, refs=None, boundaries=None, fps=24):
    data = default_timeline_dict()
    data["fps"] = fps
    if shots is not None:
        data["shots"] = shots
    if refs is not None:
        data["refs"] = refs
    if boundaries is not None:
        data["boundaries"] = boundaries
    return json.dumps(data)


def test_parse_default():
    timeline = parse_timeline(json.dumps(default_timeline_dict()))
    assert len(timeline.shots) == 1
    assert timeline.fps == 24
    assert timeline.project.format == "official"


def test_parse_empty_is_valid_but_flagged():
    timeline = parse_timeline("")
    assert timeline.shots == []
    issues = timeline_issues(timeline)
    assert any("no shots" in issue for issue in issues)


def test_parse_invalid_json_raises():
    with pytest.raises(ValueError):
        parse_timeline("{not json")


def test_global_tags_shared_image_sequence():
    refs = [
        {"id": "a", "kind": "picture", "file": "a.png", "start": 2.0, "duration": 2.0},
        {"id": "b", "kind": "subject", "file": "b.png", "start": 0.0, "duration": 2.0},
        {"id": "c", "kind": "video", "file": "c.mp4", "start": 1.0, "duration": 2.0},
        {"id": "d", "kind": "audio", "file": "d.wav", "start": 0.0, "duration": 2.0},
        {"id": "e", "kind": "audio", "file": "e.wav", "start": 3.0, "duration": 2.0},
    ]
    timeline = parse_timeline(make_timeline_json(refs=refs))
    tags = assign_global_tags(timeline)
    assert tags["a"] == "<Picture 2>"     # ordered by start: b (0s) then a (2s)
    assert tags["b"] == "<Picture 1>"
    assert tags["c"] == "<Video 1>"
    assert tags["d"] == "<Audio 1>"
    assert tags["e"] == "<Audio 2>"
    sh = subject_shorthands(timeline)
    assert sh["b"] == "S1"


def test_orphaned_ref_flagged():
    refs = [{"id": "x", "kind": "picture", "file": "x.png", "start": 50.0, "duration": 2.0}]
    timeline = parse_timeline(make_timeline_json(refs=refs))
    issues = timeline_issues(timeline)
    assert any("no shot covers" in issue for issue in issues)


def test_overlapping_shots_flagged():
    shots = [
        {"id": "s1", "start": 0.0, "duration": 3.0, "text": "One"},
        {"id": "s2", "start": 2.5, "duration": 3.0, "text": "Two"},
    ]
    timeline = parse_timeline(make_timeline_json(shots=shots))
    issues = timeline_issues(timeline)
    assert any("overlaps" in issue for issue in issues)


def test_trim_and_strength_parsing():
    refs = [{
        "id": "r", "kind": "video", "file": "v.mp4", "start": 0.0, "duration": 5.0,
        "trim_start": 1.5, "trim_end": 6.5, "strength": 0.42, "use_soundtrack": True,
        "role": "source",
    }]
    timeline = parse_timeline(make_timeline_json(refs=refs))
    ref = timeline.refs[0]
    assert ref.trim_start == 1.5
    assert ref.trim_end == 6.5
    assert ref.strength == 0.42
    assert ref.use_soundtrack is True
    assert ref.role == "source"


def test_strength_clamped():
    refs = [{"id": "r", "kind": "audio", "file": "a.wav", "start": 0.0, "duration": 1.0, "strength": 5.0}]
    timeline = parse_timeline(make_timeline_json(refs=refs))
    assert timeline.refs[0].strength == 1.0


def _timeline_with_library_ref():
    """A 10s timeline whose single shot spans 0..10, with one library (untimed)
    picture ref and one timed video ref."""
    shots = [{"id": "s1", "start": 0.0, "duration": 10.0, "text": "[Shot 1] A calm establishing shot."}]
    refs = [
        {
            "id": "lib_pic", "kind": "picture", "file": "look.png", "name": "Look",
            "start": 999.0, "duration": 2.0, "strength": 0.8, "timed": False,
        },
        {
            "id": "clip", "kind": "video", "file": "clip.mp4", "name": "Clip",
            "start": 2.0, "duration": 4.0, "strength": 1.0, "timed": True,
        },
    ]
    return make_timeline_json(shots=shots, refs=refs)


def test_library_ref_is_always_in_scope_and_never_flagged():
    timeline = parse_timeline(_timeline_with_library_ref())
    lib = timeline.refs[0]
    assert lib.timed is False

    # Library refs never extend the authored duration and are not flagged as orphaned.
    assert timeline.duration_sec == 10.0
    issues = timeline_issues(timeline)
    assert all("no shot covers" not in issue for issue in issues)

    # A library ref must appear in EVERY chunk, no matter the window.
    plans = plan_chunks(timeline, 124, 24, "keyframe+picture", False)
    assert len(plans) >= 1
    for plan in plans:
        ids = [e.ref.id for e in plan.ref_entries if e.ref is not None]
        assert "lib_pic" in ids, f"library ref missing from chunk {plan.index}"


def test_library_refs_tagged_after_timeline_refs():
    """Timed refs keep their numbering; library refs follow — adding a library
    ref never renumbers existing timeline tags."""
    refs = [
        {"id": "lib_a", "kind": "picture", "file": "a.png", "start": 0.0, "duration": 1.0, "timed": False},
        {"id": "t_b", "kind": "picture", "file": "b.png", "start": 5.0, "duration": 1.0, "timed": True},
        {"id": "lib_c", "kind": "subject", "file": "c.png", "start": 0.0, "duration": 1.0, "timed": False},
    ]
    timeline = parse_timeline(make_timeline_json(refs=refs))
    tags = assign_global_tags(timeline)
    assert tags["t_b"] == "<Picture 1>"   # timed first, even though lib_a comes earlier in the array
    assert tags["lib_a"] == "<Picture 2>"
    assert tags["lib_c"] == "<Picture 3>"
    sh = subject_shorthands(timeline)
    assert sh["lib_c"] == "S1"


def test_render_window_slices_and_rebases():
    timeline = parse_timeline(_timeline_with_library_ref())
    sliced = slice_timeline(timeline, 3.0, 9.0)

    assert sliced.render_in is None and sliced.render_out is None  # already applied
    assert len(sliced.shots) == 1
    assert sliced.shots[0].start == 0.0
    assert sliced.shots[0].duration == 6.0  # 3.0 -> 9.0 window

    # The timed video ref (2.0..6.0) partially overlaps the window: clipped + re-based.
    clip = next(r for r in sliced.refs if r.id == "clip")
    assert clip.start == 0.0
    assert clip.duration == 3.0             # 6.0 - 3.0
    assert clip.trim_start == 1.0           # media advanced by (3.0 - 2.0)
    # The library ref passes through untouched.
    lib = next(r for r in sliced.refs if r.id == "lib_pic")
    assert lib.timed is False
    assert lib.start == 999.0


def test_render_window_slices_with_boundaries():
    timeline = parse_timeline(make_timeline_json(boundaries=[2.0, 5.0, 12.0]))
    sliced = slice_timeline(timeline, 3.0, 10.0)
    assert sliced.pinned_boundaries == [2.0]  # 5.0-3.0=2.0 kept; others out of window


def test_render_range_parsed_from_serialized_widget():
    data = default_timeline_dict()
    data["render_in"] = 2.5
    data["render_out"] = 8.0
    timeline = parse_timeline(json.dumps(data))
    assert timeline.render_in == 2.5
    assert timeline.render_out == 8.0

    # The default 0..5s shot is clipped to the 2.5..8.0 window.
    sliced = slice_timeline(timeline, timeline.render_in, timeline.render_out)
    assert sliced.shots and sliced.shots[0].duration == pytest.approx(2.5, abs=1e-3)


def test_resolve_render_window_node_input_overrides():
    # resolve_render_window MUTATES its timeline (the node parses a fresh one
    # each render), so build a fresh copy per case.
    def with_window():
        data = default_timeline_dict()
        data["render_in"] = 2.5
        data["render_out"] = 8.0
        return parse_timeline(json.dumps(data))

    # widget -1 (default) leaves the timeline's own window alone
    tl, warn = resolve_render_window(with_window(), -1.0, -1.0)
    assert warn is None
    assert tl.render_in == 2.5 and tl.render_out == 8.0
    # node input >= 0 overrides the timeline window
    tl, warn = resolve_render_window(with_window(), 1.0, 5.0)
    assert warn is None and tl.render_in == 1.0 and tl.render_out == 5.0
    # open-ended window: render_in only
    tl, warn = resolve_render_window(with_window(), 3.0, -1.0)
    assert warn is None and tl.render_in == 3.0 and tl.render_out is None
    # open-ended window: render_out only
    tl, warn = resolve_render_window(with_window(), -1.0, 4.0)
    assert warn is None and tl.render_in is None and tl.render_out == 4.0
    # inverted window is rejected with a warning, timeline untouched
    tl, warn = resolve_render_window(with_window(), 9.0, 3.0)
    assert warn is not None and "OUT" in warn
    assert tl.render_in == 2.5 and tl.render_out == 8.0
    # None values behave like -1
    tl, warn = resolve_render_window(with_window(), None, None)
    assert warn is None and tl.render_in == 2.5 and tl.render_out == 8.0
