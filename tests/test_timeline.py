"""Tests for the timeline data contract (timeline.py)."""

import json

import pytest

from ChaoticMinimaxH3Director.timeline import (
    assign_global_tags,
    default_timeline_dict,
    parse_timeline,
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
