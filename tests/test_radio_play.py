"""Tests for the Radio Play planner (audio-only MiniMax H3 recipe).

Covers the parser (cast / dialogue / stage beats), the article's word-budget
segmentation (<=15 s segments on the 17k+5 grid, ~2.5 words/s), the six-part
prompt structure with byte-identical overall_soundscape, the soundtrack-slot
wiring (ref_audio empty), and the issue flags.
"""

from __future__ import annotations

import json

from ChaoticMinimaxH3Director.chunking import align_frame_count
from ChaoticMinimaxH3Director.radio_play import (
    DEFAULT_RADIO_SCRIPT,
    DEFAULT_WORDS_PER_SECOND,
    parse_script,
    plan_radio_play,
)

CAMPFIRE_SCRIPT = """# Cast
S1: Priya, a warm, teasing woman in her late twenties.
S2: Marcus, a deep-voiced, gravelly older man.

# Scene
Two friends camped by a small fire in a pine forest at night.

# Ambience
Continuous campfire crackle, light wind through pine trees.

# Music
N/A

Priya (S1) says, [teasing, bright]: "You were the one who said, let's experience the wilderness." [giggles]
Marcus (S2) replies, [gravelly, amused]: "And I stand by it."
[An owl screeches close by, startling all three.]
Marcus (S2) says, [warm, low]: "Rain says it's moving in by morning."
[Two seconds of only fire and wind, no voices.]
Priya (S1) says, [soft]: "Still the best night I've had all year."
"""


def test_parse_script_cast_and_beats():
    script = parse_script(CAMPFIRE_SCRIPT)
    assert set(script.cast.keys()) == {"S1", "S2"}
    assert script.cast["S1"].name == "Priya"
    assert "teasing" in script.cast["S1"].description
    assert script.scene.startswith("Two friends")
    assert "campfire crackle" in script.ambience

    kinds = [b.kind for b in script.beats]
    assert kinds == ["dialogue", "dialogue", "stage", "dialogue", "stage", "dialogue"]
    beat = script.beats[0]
    assert beat.speaker == "Priya"
    assert beat.sid == "S1"
    assert beat.direction == "teasing, bright"
    assert beat.line == "You were the one who said, let's experience the wilderness."
    assert beat.cue == "giggles"
    assert beat.words == 10


def test_parse_script_auto_registers_undeclared_speaker():
    script = parse_script(
        "Rita (S7) says: \"Hello.\"\n"
    )
    assert script.cast["S7"].name == "Rita"
    assert any("S7 (Rita) was not declared" in i for i in script.issues)


def test_parse_stage_direction_duration():
    script = parse_script(
        "[Two seconds of only fire and wind.]\n"
        "[A log pops.]\n"
    )
    assert script.beats[0].duration == 2.0
    assert script.beats[1].duration == 1.5  # default


def test_default_script_parses_cleanly():
    script = parse_script(DEFAULT_RADIO_SCRIPT)
    assert len(script.beats) >= 10
    # The default script's final line carries its own explicit ending, so
    # parse should keep it as a dialogue beat (or stage line) without errors.
    assert not [i for i in script.issues if "unparsed line" in i]


def test_segmentation_60s_script_fits_window():
    # A 60-second script of dense dialogue must split into <=15s segments
    # on the grid, with every frame count satisfying the 17k+5 rule.
    line = 'Speaker (S1) says: "The fire crackles and the wind picks up through the pines tonight."\n'
    long_script = line * 12
    recipe_json, prompts, count, issues = plan_radio_play(long_script, fps=24)
    data = json.loads(recipe_json)
    segs = data["segments"]
    assert count == len(segs)
    assert count >= 3
    for seg in segs:
        assert seg["duration_sec"] <= 15.0 + 1e-6
        assert seg["frames"] == align_frame_count(max(5, round(seg["duration_sec"] * 24)))
        assert seg["frames"] % 17 == 5
    assert data["totals"]["segments"] == count


def test_15s_segment_is_362_frames():
    # The article's anchor number: 15 s @ 24 fps snaps to 362 frames.
    # ~35 words at 2.5/s = 14 s of speech + a 1.5 s stage beat = 15.5 s...
    # instead assert the grid math directly and that any segment at 15 s
    # maps to 362 frames through the planner.
    assert align_frame_count(max(5, round(15.0 * 24))) == 362
    # A script tuned to ~15 s (35 words -> 14 s + 1 s stage beat).
    recipe_json, _, _, _ = plan_radio_play(
        'Speaker (S1) says: "' + " ".join(f"w{i}" for i in range(35)) + '"\n'
        "[One second of only fire and wind.]\n",
        fps=24, max_segment_seconds=15.0,
    )
    data = json.loads(recipe_json)
    seg = data["segments"][0]
    assert 14.0 <= seg["duration_sec"] <= 15.0
    assert seg["frames"] == align_frame_count(max(5, round(seg["duration_sec"] * 24)))


def test_recipe_wiring_ref_audio_empty():
    recipe_json, _, _, _ = plan_radio_play(CAMPFIRE_SCRIPT, voice_slots=3)
    data = json.loads(recipe_json)
    wiring = data["wiring"]
    assert wiring["ref_audio"] == []
    assert wiring["ref_video_audio"] == ["<Video 1>", "<Video 2>", "<Video 3>"]
    assert data["mode"] == "radio-play (audio-only)"
    assert data["latent"] == {"width": 32, "height": 32}
    assert data["render_recipe"]["sampler"] == "res_multistep"
    assert data["render_recipe"]["scheduler"] == "beta"
    assert data["post"]["trim_head_ms"] == 150
    assert data["post"]["crossfade_ms"] == 150


def test_prompt_six_part_structure_and_identical_soundscape():
    recipe_json, prompts, count, _ = plan_radio_play(
        'Speaker (S1) says: "Hello."\n[An owl screeches.]\n' * 8, fps=24,
    )
    data = json.loads(recipe_json)
    prompts_list = prompts.split("================ SEGMENT ")
    assert count >= 2
    # Every segment prompt contains all six sections.
    for seg in data["segments"]:
        prompt = seg["prompt"] if "prompt" in seg else None
    # prompts_text carries the prompts; check the first full block.
    for block in prompts_list[1:]:
        for section in ("subject_definitions:", "summary:", "retention_analysis:",
                        "detailed_description:", "overall_soundscape:",
                        "non_diegetic_music:"):
            assert section in block
    # overall_soundscape must be byte-identical across segments.
    soundscapes = set()
    for block in prompts_list[1:]:
        m = block.split("overall_soundscape:\n", 1)
        soundscapes.add(m[1].split("\nnon_diegetic_music:")[0].strip())
    assert len(soundscapes) == 1


def test_prompt_binds_voices_to_soundtrack_tags():
    recipe_json, prompts, _, _ = plan_radio_play(CAMPFIRE_SCRIPT)
    assert "<Video 1> is the voice timbre reference for Priya (S1)" in prompts
    assert "<Video 2> is the voice timbre reference for Marcus (S2)" in prompts
    assert "their dialogue content is not carried into the target" in prompts
    assert "ref_audio EMPTY" in recipe_json


def test_final_event_appended_when_missing():
    _, prompts, _, _ = plan_radio_play(
        'Speaker (S1) says: "Hello."\n', final_event=True,
    )
    assert "This is the final sound. No speech occurs after this." in prompts


def test_final_event_respected_when_user_wrote_it():
    _, prompts, _, _ = plan_radio_play(
        'Speaker (S1) says: "Hello."\n'
        "Finally, the fire crackles low. This is the final sound. No speech occurs after this.\n",
        final_event=True,
    )
    # The user's own explicit ending is kept (no doubled "Finally, Finally").
    assert prompts.count("Finally") == 1


def test_word_budget_flags_rushed_segment():
    _, _, _, issues = plan_radio_play(
        'Speaker (S1) says: "' + " ".join(f"word{i}" for i in range(80)) + '"\n',
        max_segment_seconds=15.0, words_per_second=2.5,
    )
    assert "exceeds the dialogue budget" in issues


def test_voice_slots_shortfall_flagged():
    _, _, _, issues = plan_radio_play(
        "# Cast\nS1: A, one.\nS2: B, two.\nS3: C, three.\nS4: D, four.\n\n"
        'A (S1) says: "Hi."\nB (S2) says: "Hi."\nC (S3) says: "Hi."\nD (S4) says: "Hi."\n',
        voice_slots=3,
    )
    assert "only 3 soundtrack slot" in issues


def test_single_long_beat_flagged():
    _, _, _, issues = plan_radio_play(
        'Speaker (S1) says: "' + " ".join(f"word{i}" for i in range(60)) + '"\n',
        max_segment_seconds=5.0, words_per_second=2.5,
    )
    assert "longer than the 5s window" in issues


def test_no_dialogue_flagged():
    _, _, count, issues = plan_radio_play("# Scene\nEmpty.\n\n# Music\nN/A\n")
    assert count == 0
    assert "no dialogue or stage beats" in issues


def test_music_input_does_not_shadow_script_section():
    # The node's music input defaults to "" so a # Music section wins;
    # a literal "N/A" in the input must not shadow the script's section.
    script = "# Music\nA soft underscore hum under the dialogue.\n\n" + \
        'Speaker (S1) says: "Hello."\n'
    _, prompts, _, _ = plan_radio_play(script, music="N/A")
    assert "A soft underscore hum under the dialogue." in prompts
    # A real music override still wins.
    _, prompts2, _, _ = plan_radio_play(script, music="Epic orchestral swell.")
    assert "Epic orchestral swell." in prompts2
    assert "underscore hum" not in prompts2


def test_final_event_disabled_injects_nothing():
    _, prompts, _, _ = plan_radio_play(
        'Speaker (S1) says: "Hello."\n[An owl screeches.]\n',
        final_event=False,
    )
    assert "final sound" not in prompts
    assert "trails off" not in prompts
    # The stage beat is still rendered exactly once.
    assert prompts.count("owl screeches") == 1


def test_empty_ambience_flagged():
    _, _, _, issues = plan_radio_play(
        "# Ambience\n\n" + 'Speaker (S1) says: "Hello."\n'
    )
    assert "no ambience" in issues


def test_stage_only_script_no_cast():
    _, prompts, count, _ = plan_radio_play(
        "[Wind through pines.]\n[An owl screeches.]\n[Fire crackles.]\n"
    )
    assert count >= 1
    assert "No cast declared" in prompts


def test_words_per_second_pacing():
    # 30 words at 2.5/s = 12s of speech -> comfortably inside 15s.
    script = 'Speaker (S1) says: "' + " ".join(f"w{i}" for i in range(30)) + '"\n'
    data = json.loads(plan_radio_play(script, words_per_second=2.5)[0])
    seg = data["segments"][0]
    assert seg["duration_sec"] <= 15.0
    # At 4.0/s the same script reads faster (shorter estimated duration).
    data_fast = json.loads(plan_radio_play(script, words_per_second=4.0)[0])
    assert data_fast["segments"][0]["duration_sec"] < seg["duration_sec"]
