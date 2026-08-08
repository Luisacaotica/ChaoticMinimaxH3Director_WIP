"""Tests for the prompt assembly layer (prompt_assembly.py)."""

import json

from ChaoticMinimaxH3Director.chunking import build_tag_map, plan_chunks
from ChaoticMinimaxH3Director.prompt_assembly import (
    assemble_chunk_prompt,
    fmt_timestamp,
    renumber_shot_markers,
    split_shot_beats,
    strength_to_marker,
)
from ChaoticMinimaxH3Director.timeline import assign_global_tags, default_timeline_dict, parse_timeline


def make_timeline(shots, refs=None, project=None, fps=24):
    data = default_timeline_dict()
    data["fps"] = fps
    data["shots"] = shots
    data["refs"] = refs or []
    if project:
        data["project"] = project
    return parse_timeline(json.dumps(data))


OFFICIAL_PROJECT = {
    "format": "official",
    "lora_trigger": "",
    "style_clarification": "",
    "official": {
        "subject_definitions": "<Subject 1> is the woman in <Picture 1>, referred to as S1.",
        "summary": "[reference generation] S1 confronts S2.",
        "retention_analysis": "<Subject 1> (appears in [Shot 1]): fully_preserved - retained exactly.",
        "style_line": "Gritty, high-budget drama, handheld energy.",
        "overall_soundscape": "A sharp tearing sound, then silence.",
        "non_diegetic_music": "A single orchestral stinger.",
    },
    "narrative": {},
}


def test_official_format_section_order():
    shots = [{"id": "s1", "start": 0.0, "duration": 5.0, "text": "[Shot 1] S1 steps forward."}]
    timeline = make_timeline(shots, project=OFFICIAL_PROJECT)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    bundle = assemble_chunk_prompt(
        timeline, plans[0].index, plans[0].start_sec, plans[0].shots,
        plans[0].ref_entries, plans[0].anchor_tag, assign_global_tags(timeline), {},
    )
    prompt = bundle.prompt
    order = [prompt.index(s) for s in
             ("subject_definitions:", "summary:", "retention_analysis:",
              "detailed_description:", "overall_soundscape:", "non_diegetic_music:")]
    assert all(o >= 0 for o in order)
    assert order == sorted(order)
    assert "[Shot 1] S1 steps forward." in prompt


def test_timestamps_relative_to_chunk_start():
    shots = [
        {"id": "s1", "start": 0.0, "duration": 3.0, "text": "[Shot 1] Opening."},
        {"id": "s2", "start": 3.0, "duration": 3.0, "text": "[Shot 2] Middle."},
    ]
    timeline = make_timeline(shots, project=OFFICIAL_PROJECT)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    assert len(plans) == 2
    # chunk 2's [Shot 1] carries no timestamp; its text is the second shot
    bundle = assemble_chunk_prompt(
        timeline, plans[1].index, plans[1].start_sec, plans[1].shots,
        plans[1].ref_entries, plans[1].anchor_tag, assign_global_tags(timeline), {},
    )
    assert "[Shot 1] Middle." in bundle.prompt


def test_anchor_definition_in_continuation():
    shots = [
        {"id": "s1", "start": 0.0, "duration": 3.0, "text": "One."},
        {"id": "s2", "start": 3.0, "duration": 3.0, "text": "Two."},
    ]
    timeline = make_timeline(shots, project=OFFICIAL_PROJECT)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    bundle = assemble_chunk_prompt(
        timeline, plans[1].index, plans[1].start_sec, plans[1].shots,
        plans[1].ref_entries, plans[1].anchor_tag, assign_global_tags(timeline), {},
    )
    assert plans[1].anchor_tag == "<Picture 1>"
    assert "<Picture 1>" in bundle.prompt
    assert "final frame of the previous segment" in bundle.prompt
    assert "fully_preserved" in bundle.prompt


def test_tag_remap_changes_numbering():
    # r2 (global <Picture 2>) sits alone in chunk 1, so the user's global tag
    # must be rewritten to the chunk-local <Picture 1> in the emitted prompt.
    shots = [
        {"id": "s1", "start": 0.0, "duration": 3.0, "text": "Opening."},
        {"id": "s2", "start": 3.0, "duration": 3.0, "text": "Uses <Picture 2> here."},
    ]
    refs = [
        {"id": "r1", "kind": "picture", "file": "a.png", "start": 3.5, "duration": 1.5},
        {"id": "r2", "kind": "picture", "file": "b.png", "start": 0.5, "duration": 1.5},
    ]
    timeline = make_timeline(shots, refs, project=OFFICIAL_PROJECT)
    global_tags = assign_global_tags(timeline)
    assert global_tags["r1"] == "<Picture 2>"   # r2 starts earlier → Picture 1
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    plan = plans[1]                               # contains only r1
    tag_map = build_tag_map(timeline, plan, global_tags)
    assert tag_map["<Picture 2>"] == "<Picture 1>"
    bundle = assemble_chunk_prompt(
        timeline, plan.index, plan.start_sec, plan.shots, plan.ref_entries,
        plan.anchor_tag, global_tags, tag_map,
    )
    assert "Uses <Picture 1> here." in bundle.prompt


def test_retention_bands():
    assert strength_to_marker("visual", 0.9) == "fully_preserved"
    assert strength_to_marker("visual", 0.7) == "partially_preserved"
    assert strength_to_marker("visual", 0.4) == "attribute_transfer"
    assert strength_to_marker("visual", 0.2) == "weak_reference"
    assert strength_to_marker("audio", 0.9) == "fully_copy"
    assert strength_to_marker("audio", 0.7) == "partially_copy"
    assert strength_to_marker("audio", 0.4) == "reference"
    assert strength_to_marker("audio", 0.2) == "weak_reference"


def test_auto_retention_for_weak_reference_has_not_copied_clause():
    shots = [{"id": "s1", "start": 0.0, "duration": 5.0, "text": "Scene."}]
    refs = [{"id": "r1", "kind": "picture", "file": "a.png", "start": 0.0, "duration": 5.0, "strength": 0.15}]
    timeline = make_timeline(shots, refs, project=OFFICIAL_PROJECT)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    bundle = assemble_chunk_prompt(
        timeline, plans[0].index, plans[0].start_sec, plans[0].shots,
        plans[0].ref_entries, plans[0].anchor_tag, assign_global_tags(timeline), {},
    )
    assert "weak_reference" in bundle.prompt
    assert "NOT copied" in bundle.prompt or "not copied" in bundle.prompt


def test_narrative_format():
    project = {
        "format": "narrative",
        "lora_trigger": "GalaxyAce",
        "style_clarification": "Style only, not wardrobe.",
        "official": {},
        "narrative": {"scene": "A rainy alley.", "subjects": "", "lighting": "", "music": "N/A"},
    }
    shots = [
        {"id": "s1", "start": 0.0, "duration": 5.0, "text": "Scene: Two figures face off.\nAction timeline: S1 steps forward."},
    ]
    timeline = make_timeline(shots, project=project)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    bundle = assemble_chunk_prompt(
        timeline, plans[0].index, plans[0].start_sec, plans[0].shots,
        plans[0].ref_entries, plans[0].anchor_tag, assign_global_tags(timeline), {},
    )
    assert bundle.prompt.startswith("GalaxyAce.")
    assert "Style only, not wardrobe." in bundle.prompt
    assert "Scene: Two figures face off." in bundle.prompt


def test_lora_trigger_prefix():
    project = dict(OFFICIAL_PROJECT)
    project["lora_trigger"] = "GalaxyAce style"
    shots = [{"id": "s1", "start": 0.0, "duration": 5.0, "text": "Scene."}]
    timeline = make_timeline(shots, project=project)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    bundle = assemble_chunk_prompt(
        timeline, plans[0].index, plans[0].start_sec, plans[0].shots,
        plans[0].ref_entries, plans[0].anchor_tag, assign_global_tags(timeline), {},
    )
    assert bundle.prompt.startswith("GalaxyAce style.")


def test_fmt_timestamp():
    assert fmt_timestamp(0) == "00:00.000"
    assert fmt_timestamp(2.5) == "00:02.500"
    assert fmt_timestamp(65.4) == "01:05.400"


def test_split_beats_and_renumber():
    text = "[Shot 1] First.\n[Shot 3] Third.\n[Shot 2] Second."
    beats = split_shot_beats(text)
    assert len(beats) == 3
    assert beats[0].startswith("[Shot 1]")
    renumbered = renumber_shot_markers(text, start_number=1)
    assert "[Shot 1]" in renumbered
    assert "[Shot 2]" in renumbered
    assert "[Shot 3]" in renumbered


def test_summary_continuation_prefix():
    shots = [
        {"id": "s1", "start": 0.0, "duration": 3.0, "text": "One."},
        {"id": "s2", "start": 3.0, "duration": 3.0, "text": "Two."},
    ]
    timeline = make_timeline(shots, project=OFFICIAL_PROJECT)
    plans = plan_chunks(timeline, target_frames=124, fps=24)
    bundle = assemble_chunk_prompt(
        timeline, plans[1].index, plans[1].start_sec, plans[1].shots,
        plans[1].ref_entries, plans[1].anchor_tag, assign_global_tags(timeline), {},
    )
    assert "+ video continuation" in bundle.prompt
