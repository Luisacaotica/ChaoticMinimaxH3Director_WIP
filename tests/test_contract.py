"""JS widget ↔ Python data contract round-trip tests.

The timeline widget (web/js/chaotic_director.js) serializes a JSON blob into
the hidden `timeline_data` widget; the Python side re-parses it.  This file
feeds the Python parser a dict shaped EXACTLY like the widget's serialize()
output (same keys, same nesting, same value types) and asserts the round trip
survives all the way through chunk planning and prompt assembly — the failure
mode a key mismatch would silently trigger at render time.

It also locks in the video output convention: the Director must emit
[1, F, H, W, 3] (the stock VAEDecode shape) so CreateVideo/SaveVideo and
classic video nodes consume it unchanged.
"""

from __future__ import annotations

import json

import pytest

from ChaoticMinimaxH3Director.chunking import plan_chunks
from ChaoticMinimaxH3Director.prompt_assembly import assemble_chunk_prompt
from ChaoticMinimaxH3Director.stitching import as_video_batch, stitch_chunks
from ChaoticMinimaxH3Director.timeline import (
    assign_global_tags,
    parse_timeline,
    subject_shorthands,
    timeline_issues,
)


def js_serialized_timeline():
    """Mirror of what chaotic_director.js `serialize()` emits for a sample scene.

    Keep keys/order/typing identical to the widget's output so this test guards
    the real contract, not a sanitized version of it.
    """
    return {
        "version": 1,
        "fps": 24,
        "project": {
            "format": "official",
            "lora_trigger": "",
            "style_clarification": "",
            "official": {
                "subject_definitions": (
                    "<Subject 1> is a woman with curly red-orange hair, referred to as S1.\n"
                    "<Subject 2> is the Hulk, a hulking green giant, referred to as S2."
                ),
                "summary": "[reference generation] S1 confronts S2.",
                "retention_analysis": "",
                "style_line": "Gritty superhero-drama style, handheld energy.",
                "overall_soundscape": "A wet tearing sound, then near silence.",
                "non_diegetic_music": "A harsh orchestral stinger at the impact.",
            },
            "narrative": {"scene": "", "subjects": "", "lighting": "", "music": "N/A"},
        },
        "shots": [
            {
                "id": "shot_1",
                "start": 0.0,
                "duration": 3.5,
                "text": "[Shot 1] A tight two-shot frames S1 and S2 nose-to-nose. S1's face is contorted with rage.",
                "format": "auto",
            },
            {
                "id": "shot_2",
                "start": 3.5,
                "duration": 3.5,
                "text": "[Shot 2] Wide angle as S1 lunges forward, ripping into the center of S2's chest.",
                "format": "auto",
            },
        ],
        "refs": [
            {
                "id": "ref_1",
                "kind": "subject",
                "file": "luisa_sheet.png",
                "name": "S1 reference",
                "start": 0.0,
                "duration": 7.0,
                "trim_start": 0,
                "trim_end": None,
                "strength": 0.9,
                "role": "reference",
                "annotation": "Gravel voice, smug smirk.",
                "tag_type": "subject",
                "use_soundtrack": False,
            },
            {
                "id": "ref_2",
                "kind": "video",
                "file": "hulk_footage.mp4",
                "name": "S2 motion",
                "start": 0.0,
                "duration": 7.0,
                "trim_start": 0.5,
                "trim_end": 6.0,
                "strength": 0.5,
                "role": "reference",
                "annotation": "",
                "tag_type": "picture",
                "use_soundtrack": True,
            },
        ],
        "boundaries": [],
    }


def test_js_serialized_timeline_round_trips_through_assembly():
    """A JS-authored timeline parses, plans, tags, and assembles without loss."""
    timeline = parse_timeline(json.dumps(js_serialized_timeline()))

    assert timeline.fps == 24
    assert [s.id for s in timeline.shots] == ["shot_1", "shot_2"]
    assert len(timeline.refs) == 2
    assert timeline.project.format == "official"

    # Tag assignment mirrors the JS widget's assignGlobalTags.
    tags = assign_global_tags(timeline)
    assert tags["ref_1"] == "<Picture 1>"   # subjects share the picture sequence
    assert tags["ref_2"] == "<Video 1>"
    sh = subject_shorthands(timeline)
    assert sh["ref_1"] == "S1"

    # No validation issues from the untouched JS data.
    assert timeline_issues(timeline) == []

    # Planner + assembler consume the parsed model end to end.
    plans = plan_chunks(timeline, 124, 24, "keyframe+picture", False)
    assert len(plans) >= 1
    bundle = assemble_chunk_prompt(
        timeline, 0, 0.0, plans[0].shots, plans[0].ref_entries,
        plans[0].anchor_tag, tags, {},
    )
    assert "<Picture 1>" in bundle.prompt
    assert "<Video 1>" in bundle.prompt
    assert "S1" in bundle.prompt
    assert "[Shot 1]" in bundle.prompt
    assert "subject_definitions:" in bundle.prompt


def test_video_output_convention_is_vae_decode_shape():
    """Director output must be [1, F, H, W, 3] — the stock VAEDecode shape."""
    chunk1 = {"frames": _frames(10), "audio": None}
    chunk2 = {"frames": _frames(12), "audio": None}
    stitched = stitch_chunks([chunk1, chunk2], 24, drop_seam_frame=True)
    # Internal stitching works on flat [F, H, W, 3]...
    assert stitched["frames"].ndim == 4
    assert stitched["frames"].shape[0] == 10 + 12 - 1  # one seam frame dropped
    # ...and the node wraps to the batch convention before returning.
    batched = as_video_batch(stitched["frames"])
    assert batched.ndim == 5
    assert batched.shape == (1, 10 + 12 - 1, 64, 96, 3)
    # 5D input passes through unchanged; garbage raises.
    assert as_video_batch(batched).shape == batched.shape
    with pytest.raises(ValueError):
        as_video_batch(stitched["frames"][0])  # [H, W, 3] is not batchable


def _frames(n: int):
    import torch

    return torch.zeros(n, 64, 96, 3)
