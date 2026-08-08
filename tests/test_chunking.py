"""Tests for the chunk planner (chunking.py)."""

import json

from ChaoticMinimaxH3Director.chunking import (
    align_frame_count,
    build_tag_map,
    plan_chunks,
    split_beat_text,
)
from ChaoticMinimaxH3Director.timeline import assign_global_tags, default_timeline_dict, parse_timeline


def make_timeline(shots, refs=None, fps=24):
    data = default_timeline_dict()
    data["fps"] = fps
    data["shots"] = shots
    data["refs"] = refs or []
    return parse_timeline(json.dumps(data))


def test_align_frame_count():
    assert align_frame_count(120) == 124
    assert align_frame_count(5) == 5
    assert align_frame_count(124) == 124
    assert align_frame_count(0) == 5


def test_three_shots_split_into_chunks():
    shots = [
        {"id": "s1", "start": 0.0, "duration": 3.0, "text": "[Shot 1] Alpha action."},
        {"id": "s2", "start": 3.0, "duration": 3.0, "text": "[Shot 2] Beta action."},
        {"id": "s3", "start": 6.0, "duration": 3.0, "text": "[Shot 3] Gamma action."},
    ]
    timeline = make_timeline(shots)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    assert len(plans) == 3
    assert [len(p.shots) for p in plans] == [1, 1, 1]
    # each chunk's frames land on the 17k+5 grid
    for plan in plans:
        assert plan.frames % 17 == 5
    # second+ chunk carries an anchor tag
    assert plans[0].anchor_tag is None
    assert plans[1].anchor_tag == "<Picture 1>"
    assert plans[2].anchor_tag == "<Picture 1>"


def test_short_shots_pack_into_one_chunk():
    shots = [
        {"id": "s1", "start": 0.0, "duration": 2.0, "text": "One."},
        {"id": "s2", "start": 2.0, "duration": 2.0, "text": "Two."},
    ]
    timeline = make_timeline(shots)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    assert len(plans) == 1
    assert len(plans[0].shots) == 2


def test_long_shot_sentence_split():
    text = ("[Shot 1] A long establishing shot. "
            "The camera drifts across the plaza. "
            "Dust motes hang in the amber light. "
            "A distant siren fades in and out. "
            "Two figures emerge from the archway. "
            "They stop, facing each other. "
            "The taller one speaks first. "
            "The other listens, unmoving.")
    shots = [{"id": "s1", "start": 0.0, "duration": 20.0, "text": text}]
    timeline = make_timeline(shots)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    assert len(plans) > 1
    for plan in plans:
        assert plan.duration_sec <= 124 / 24 + 1e-6 or len(plan.shots) == 1
    # no mid-word splits: every beat ends with a sentence terminator
    for plan in plans:
        for shot in plan.shots:
            stripped = shot.text.rstrip()
            assert stripped.endswith((".", "!", "?", "…"))


def test_split_beat_text_respects_budget():
    text = "Alpha. Bravo. Charlie. Delta. Echo. Foxtrot. Golf. Hotel."
    pieces = split_beat_text(text, max_sec=3.0, beat_sec=12.0)
    total_dur = sum(d for _, d in pieces)
    assert abs(total_dur - 12.0) < 1e-3
    # sentence boundaries are approximate; allow a little over the nominal
    # budget so the split never lands mid-sentence
    assert all(d <= 3.0 * 1.2 + 1e-6 for _, d in pieces)


def test_pinned_boundary_forces_split():
    shots = [
        {"id": "s1", "start": 0.0, "duration": 5.0, "text": "First half of the scene."},
        {"id": "s2", "start": 5.0, "duration": 5.0, "text": "Second half."},
    ]
    data = default_timeline_dict()
    data["shots"] = shots
    data["boundaries"] = [3.0]
    timeline = parse_timeline(json.dumps(data))
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    # The pin at 3s cuts shot 1 mid-way and chunks never cross a pin:
    # [0, 3) | [3, 5) | [5, 10)
    assert len(plans) == 3
    assert plans[0].start_sec == 0.0
    assert abs(plans[1].start_sec - 3.0) < 1e-6
    assert abs(plans[2].start_sec - 5.0) < 1e-6


def test_ref_tags_renumbered_per_chunk():
    shots = [
        {"id": "s1", "start": 0.0, "duration": 3.0, "text": "Uses <Picture 1>."},
        {"id": "s2", "start": 3.0, "duration": 3.0, "text": "Uses <Picture 2>."},
        {"id": "s3", "start": 6.0, "duration": 3.0, "text": "Uses <Picture 3>."},
    ]
    refs = [
        {"id": "r1", "kind": "picture", "file": "a.png", "start": 0.0, "duration": 1.5},
        {"id": "r2", "kind": "picture", "file": "b.png", "start": 3.5, "duration": 1.5},
        {"id": "r3", "kind": "picture", "file": "c.png", "start": 6.5, "duration": 1.5},
    ]
    timeline = make_timeline(shots, refs)
    global_tags = assign_global_tags(timeline)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    assert len(plans) == 3
    # Each chunk sees only its own ref, so every ref is chunk-local <Picture 1>,
    # but r2's GLOBAL tag is <Picture 2> — the tag map must bridge the two.
    assert global_tags["r2"] == "<Picture 2>"
    mapping_chunk1 = build_tag_map(timeline, plans[1], global_tags)
    assert mapping_chunk1["<Picture 2>"] == "<Picture 1>"
    for plan in plans:
        real = [e for e in plan.ref_entries if e.ref is not None]
        assert len(real) == 1
        assert real[0].tag == "<Picture 1>"


def test_video_context_adds_synthetic_video_ref():
    shots = [
        {"id": "s1", "start": 0.0, "duration": 3.0, "text": "One."},
        {"id": "s2", "start": 3.0, "duration": 3.0, "text": "Two."},
    ]
    timeline = make_timeline(shots)
    plans = plan_chunks(timeline, target_frames=124, fps=24, video_context=True)
    assert len(plans) == 2
    context = [e for e in plans[1].ref_entries if e.is_context]
    assert len(context) == 1
    assert context[0].tag == "<Video 1>"
    assert plans[0].ref_entries == []


def test_empty_timeline_raises():
    timeline = parse_timeline(json.dumps(default_timeline_dict()))
    timeline.shots = []
    import pytest

    with pytest.raises(ValueError):
        plan_chunks(timeline, target_frames=124, fps=24)
