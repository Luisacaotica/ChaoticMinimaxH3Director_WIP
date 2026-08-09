"""Radio Play planner — audio-only MiniMax H3 recipe generation.

Implements the community "radio play" recipe for MiniMax H3, as
reverse-engineered in the widely-shared write-up:

  * Drive the video latent down to 32x32 so the model's capacity goes
    almost entirely into the audio stream (the visual track becomes a
    static placeholder that is cheap to compute).
  * Split the script into segments of <= 15 s (H3's native output window),
    each snapped to the 17k+5 frame grid at the target fps.
  * Budget spoken words at ~2-2.5 words/second so dialogue never sounds
    rushed (over budget) or invented/mumbling (under budget).
  * Bind each character's voice into the *soundtrack* slots of reference
    videos (<Video 1/2/3> ...) and leave ref_audio EMPTY — the accidental
    fix that restored a continuous ambient bed under referenced voices.
  * Emit the six-part Ref2VA prompt per segment (subject_definitions /
    summary / retention_analysis / detailed_description / overall_soundscape
    / non_diegetic_music), keeping overall_soundscape byte-identical across
    segments to hide the seams.
  * Always end each segment with an explicit final event ("...this is the
    final sound. No speech occurs after this.") instead of a timestamp.
  * Post-production recipe: trim 50-200 ms off every segment head (the
    boundary ghost) and crossfade ~150 ms on the joins.

Pure Python - no torch, no ComfyUI imports - so it can be unit-tested
standalone and previewed without spending a single GPU cycle.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .chunking import align_frame_count

# --------------------------------------------------------------------------- #
# Constants (the article's verified numbers)
# --------------------------------------------------------------------------- #

DEFAULT_FPS = 24
DEFAULT_MAX_SEGMENT_SECONDS = 15.0  # H3 native output window is ~4-15 s
DEFAULT_WORDS_PER_SECOND = 2.5      # natural conversation pacing
DEFAULT_VOICE_SLOTS = 3             # refvideoaudios 0/1/2 -> <Video 1/2/3>
AUDIO_LATENT = {"width": 32, "height": 32}  # audio-only mode
RENDER_RECIPE = {
    "sampler": "res_multistep",
    "scheduler": "beta",
    "steps": 30,
    "audio_vae": "fp32",
}
FRAME_GRID_EXPRESSION = (
    "max(5, round(seconds * fps)) + "
    "(5 - (max(5, round(seconds * fps)) % 17)) % 17"
)

DEFAULT_AMBIENCE = (
    "Continuous campfire crackle, light wind through pine trees, occasional "
    "insects, and distant nocturnal birds are audible throughout the entire "
    "clip, beneath all speech, and never fully stop. Voices remain clear, "
    "crisp, and forward in the mix above the ambience."
)

DEFAULT_SCENE = (
    "Realistic, intimate nighttime dialogue scene around a small campfire "
    "beside a remote forest cabin, recorded in high fidelity with clear, "
    "present, studio-quality voices."
)

DEFAULT_RADIO_SCRIPT = """# Cast
S1: Priya, a warm, teasing woman in her late twenties.
S2: Marcus, a deep-voiced, gravelly older man.
S3: Ethan, a younger man with a dry, deadpan delivery.

# Scene
Three friends camped by a small fire in a pine forest at night. The conversation is relaxed and playful.

# Ambience
Continuous campfire crackle, light wind through pine trees, occasional insects, and distant nocturnal birds are audible throughout the entire clip, beneath all speech, and never fully stop. Voices remain clear, crisp, and forward in the mix above the ambience.

# Music
N/A

# Dialogue
Priya (S1) says, [teasing, bright]: "You were the one who said, let's experience the wilderness." [giggles]
Marcus (S2) replies, [gravelly, amused]: "And I stand by it."
[The fire pops and a log settles with a soft thump.]
Ethan (S3) mutters, [dry]: "At least it's quiet."
[An owl screeches close by, startling all three.]
Priya (S1) says, [gasping, then laughing]: "Okay, that was a real sound."
[Everyone laughs together, then settles back into the crackle.]
Marcus (S2) says, [warm, low]: "Rain says it's moving in by morning."
[Two seconds of only fire and wind, no voices.]
Ethan (S3) says, [deadpan]: "The tent leaks."
[All three laugh again, warm and easy.]
Priya (S1) says, [soft]: "Still the best night I've had all year."
Finally, the fire crackles low and the wind gentles. This is the final sound. No speech occurs after this.
"""


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #

@dataclass
class Beat:
    """One parseable unit: a spoken line or a stage direction."""
    kind: str            # "dialogue" | "stage"
    speaker: Optional[str]   # display name (dialogue only)
    sid: Optional[str]       # "S1" ... (dialogue only)
    direction: Optional[str]  # bracketed delivery cue, e.g. "teasing, bright"
    line: str                # spoken words (dialogue) or stage text
    cue: Optional[str]       # trailing bracketed vocalization, e.g. "giggles"
    words: int = 0
    duration: float = 1.0    # estimated seconds
    raw: str = ""


@dataclass
class CastEntry:
    name: Optional[str]
    description: str


@dataclass
class Script:
    cast: Dict[str, CastEntry] = field(default_factory=dict)  # sid -> entry
    scene: str = DEFAULT_SCENE
    ambience: str = DEFAULT_AMBIENCE
    music: str = "N/A"
    beats: List[Beat] = field(default_factory=list)
    issues: List[str] = field(default_factory=list)


@dataclass
class SegmentRecipe:
    index: int
    start_sec: float
    duration_sec: float
    frames: int
    word_count: int
    word_budget: float
    speakers: List[str]
    beats: List[Beat]
    prompt: str
    final_event: str


# --------------------------------------------------------------------------- #
# Parser
# --------------------------------------------------------------------------- #

_SECTIONS = {
    "cast": "cast", "characters": "cast",
    "scene": "scene", "setting": "scene",
    "ambience": "ambience", "soundscape": "ambience",
    "music": "music",
    "dialogue": "dialogue", "script": "dialogue",
}

_HEADER_RE = re.compile(r"^\s*#\s*([A-Za-z][A-Za-z _-]*)\s*(?::\s*(.*))?$")
_DIALOGUE_RE = re.compile(
    r'^\s*(?P<speaker>[^()\[\]:"]+?)\s*\((?P<sid>S?\d+)\)\s*'
    r"(?P<pre>[^:\[\]\"]*?)"
    r"(?:\[(?P<dir>[^\]]*)\])?\s*:\s*"
    r'["“](?P<line>.*?)["”]\s*'
    r"(?:\[(?P<cue>[^\]]*)\])?\s*$",
    re.DOTALL,
)
_STAGE_RE = re.compile(r"^\s*\[(?P<stage>[^\]]+)\]\s*$")
_CAST_RE = re.compile(r"^\s*S?(\d+)\s*[:|]\s*(.*)$")
_SECONDS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b", re.IGNORECASE)

# Written-out durations: "[Two seconds of only fire and wind.]"
_WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
}
_WORD_SECONDS_RE = re.compile(
    r"\b([a-z]+)\s+(?:seconds?|secs?|s)\b", re.IGNORECASE
)


def _explicit_duration(text: str) -> Optional[float]:
    m = _SECONDS_RE.search(text)
    if m:
        return max(0.3, float(m.group(1)))
    m = _WORD_SECONDS_RE.search(text)
    if m:
        n = _WORD_NUMBERS.get(m.group(1).lower())
        if n is not None:
            return max(0.3, float(n))
    return None


def _count_words(text: str) -> int:
    return len(text.split())


def _parse_cast_line(text: str) -> Optional[CastEntry]:
    m = _CAST_RE.match(text.strip())
    if not m:
        return None
    desc = m.group(2).strip()
    if not desc:
        return None
    # "Name, description" / "Name - description" / bare "description".
    parts = re.split(r"\s*[,—]\s*|\s+-\s+", desc, maxsplit=1)
    if len(parts) > 1:
        return CastEntry(name=parts[0].strip(), description=parts[1].strip())
    if re.match(r"^(a|an|the)\s+", desc, re.IGNORECASE):
        return CastEntry(name=None, description=desc)
    return CastEntry(name=desc.split()[0] if desc.split() else None,
                     description=" ".join(desc.split()[1:]))


def _beat_duration(beat: Beat, words_per_second: float) -> float:
    if beat.kind == "dialogue":
        return max(0.7, beat.words / words_per_second)
    d = _explicit_duration(beat.line)
    if d is not None:
        return d
    return 1.5  # default pause / sound-effect length


def parse_script(text: str, words_per_second: float = DEFAULT_WORDS_PER_SECOND) -> Script:
    """Parse the authoring format into a Script.

    Sections (case-insensitive, '# Name' or '# Name: ...'):
      # Cast / # Characters   S1: Name, description
      # Scene / # Setting     free text (one paragraph)
      # Ambience / Soundscape free text (kept identical across segments)
      # Music                 free text (non_diegetic_music, default "N/A")
      # Dialogue / # Script   beats (default section)
    Beats:
      Priya (S1) says, [direction]: "spoken words" [vocalization]
      [A stage direction / sound effect.]
    """
    script = Script()
    section = "dialogue"
    seen_sids: set = set()

    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue

        hm = _HEADER_RE.match(line)
        if hm:
            name = hm.group(1).strip().lower()
            if name in _SECTIONS:
                section = _SECTIONS[name]
                rest = (hm.group(2) or "").strip()
                if rest:  # "# Scene: Campfire at night..."
                    if section == "scene":
                        script.scene = rest
                    elif section == "ambience":
                        script.ambience = rest
                    elif section == "music":
                        script.music = rest
                elif section == "scene" and script.scene == DEFAULT_SCENE:
                    script.scene = ""  # user section replaces the default
                elif section == "ambience" and script.ambience == DEFAULT_AMBIENCE:
                    script.ambience = ""
                continue
            script.issues.append(f"line {lineno}: unknown section '# {name}' ignored")
            continue

        dm = _DIALOGUE_RE.match(line)
        if dm:
            sid = "S" + dm.group("sid").lstrip("S")
            line_text = dm.group("line").strip()
            beat = Beat(
                kind="dialogue",
                speaker=dm.group("speaker").strip(),
                sid=sid,
                direction=(dm.group("dir") or "").strip() or None,
                line=line_text,
                cue=(dm.group("cue") or "").strip() or None,
                words=_count_words(line_text),
                raw=line,
            )
            beat.duration = _beat_duration(beat, words_per_second)
            script.beats.append(beat)
            seen_sids.add(sid)
            continue

        sm = _STAGE_RE.match(line)
        if sm:
            stage_text = sm.group("stage").strip()
            beat = Beat(kind="stage", speaker=None, sid=None,
                        direction=None, line=stage_text, cue=None,
                        words=_count_words(stage_text), raw=line)
            beat.duration = _beat_duration(beat, words_per_second)
            script.beats.append(beat)
            continue

        # A prose explicit-ending line (the article's "finally..." closer) is
        # a legitimate stage beat even without brackets.
        if "this is the final sound" in line.lower():
            beat = Beat(kind="stage", speaker=None, sid=None,
                        direction=None, line=line, cue=None,
                        words=_count_words(line), raw=line)
            beat.duration = _beat_duration(beat, words_per_second)
            script.beats.append(beat)
            continue

        cm = _parse_cast_line(line)
        if cm is not None and section in ("cast", "dialogue"):
            sid = "S" + (re.match(r"^\s*S?(\d+)", line).group(1))
            script.cast[sid] = cm
            continue

        if section in ("scene", "ambience", "music"):
            if section == "scene":
                script.scene = (script.scene + " " + line).strip()
            elif section == "ambience":
                script.ambience = (script.ambience + " " + line).strip()
            else:
                script.music = (script.music + " " + line).strip()
            continue

        script.issues.append(
            f"line {lineno}: unparsed line skipped - {line[:60]!r}"
        )

    # Backfill names for cast entries declared without one, and auto-register
    # speakers that appeared in dialogue but were never declared.
    for beat in script.beats:
        if beat.kind != "dialogue" or beat.sid is None:
            continue
        entry = script.cast.get(beat.sid)
        if entry is None:
            script.cast[beat.sid] = CastEntry(name=beat.speaker,
                                              description="a distinct voice")
            script.issues.append(
                f"{beat.sid} ({beat.speaker}) was not declared under # Cast; "
                "added with a generic description. Add 'Sx: Name, description' "
                "to lock in the voice reference."
            )
        elif entry.name is None:
            entry.name = beat.speaker

    if not script.beats:
        script.issues.append("no dialogue or stage beats found in the script")
    return script


# --------------------------------------------------------------------------- #
# Segmentation (the article's word-budget + 15 s window)
# --------------------------------------------------------------------------- #

def _spoken_words(beats: List[Beat]) -> int:
    """Spoken word count - stage directions don't consume the word budget."""
    return sum(b.words for b in beats if b.kind == "dialogue")


def _pack_segments(beats: List[Beat], max_sec: float) -> List[tuple]:
    """Greedily pack beats into <= max_sec segments.

    A single beat longer than the window gets its own segment (the planner
    flags it below rather than splitting a speech mid-line).
    """
    segments: List[tuple] = []  # (beats, seconds, words)
    cur: List[Beat] = []
    cur_sec, cur_words = 0.0, 0
    for beat in beats:
        if cur and cur_sec + beat.duration > max_sec + 1e-6:
            segments.append((cur, cur_sec, cur_words))
            cur, cur_sec, cur_words = [], 0.0, 0
        cur.append(beat)
        cur_sec += beat.duration
        if beat.kind == "dialogue":
            cur_words += beat.words
    if cur:
        segments.append((cur, cur_sec, cur_words))
    return segments


def _final_event(last: Beat) -> str:
    """Generate the explicit final-event clause the article recommends."""
    if last.kind == "stage":
        return (f"Finally, {last.line}. This is the final sound. "
                "No speech occurs after this.")
    name = last.speaker or "The speaker"
    return (f"Finally, {name}'s last words fade into the ambience. "
            "This is the final sound. No speech occurs after this.")


def _has_explicit_ending(text: str) -> bool:
    lowered = text.lower()
    return ("this is the final sound" in lowered or
            ("finally" in lowered and "no speech" in lowered))


def build_segment_prompt(recipe: "SegmentRecipe", script: Script,
                         segment_count: int, voice_slots: int,
                         words_per_second: float,
                         music: Optional[str] = None) -> str:
    """Six-part Ref2VA prompt for one segment (article's exact structure)."""
    slots = [f"<Video {i}>" for i in range(1, voice_slots + 1)]
    bound = [s for s in script.cast.keys()]
    bound_tags = ", ".join(slots[:max(1, len(bound))])

    # subject_definitions --------------------------------------------------
    sd_lines = []
    for i, sid in enumerate(script.cast.keys()):
        entry = script.cast[sid]
        tag = slots[i] if i < len(slots) else slots[-1]
        name = entry.name or sid
        desc = entry.description or "a distinct voice"
        sd_lines.append(
            f"{tag} is the voice timbre reference for {name} ({sid}), {desc}. "
            "Their dialogue content is not carried into the target."
        )
    subject_definitions = "\n".join(sd_lines) if sd_lines else (
        "No cast declared - no voice references are bound.")

    # summary --------------------------------------------------------------
    summary = (
        f"[radio play segment {recipe.index} of {segment_count} + voice "
        f"references + ambience] {script.scene} Voices reference the timbres "
        f"heard in {bound_tags}; their original words are not reused. "
        f"{script.ambience.split('.')[0]}."
    )

    # retention_analysis ---------------------------------------------------
    retention = (
        f"{bound_tags}: reference - only voice timbre and delivery style are "
        "referenced from their audio tracks; their dialogue content is not "
        "carried into the target."
    )

    # detailed_description -------------------------------------------------
    dd_lines = [
        "Radio play, audio only.",
        script.scene,
    ]
    for i, beat in enumerate(recipe.beats, start=1):
        if beat.kind == "dialogue":
            dir_part = f", [{beat.direction}]" if beat.direction else ""
            cue_part = f" [{beat.cue}]" if beat.cue else ""
            dd_lines.append(
                f"[Shot {i}] {beat.speaker} ({beat.sid}){dir_part}: "
                f'"{beat.line}"{cue_part}'
            )
        elif _has_explicit_ending(beat.raw):
            dd_lines.append(f"[Shot {i}] {beat.line}")
        else:
            dd_lines.append(f"[Shot {i}] {beat.line} (a sound effect; no voices)")
    if recipe.final_event:
        dd_lines.append(recipe.final_event)
    detailed_description = "\n".join(dd_lines)

    # soundscape / music ---------------------------------------------------
    soundscape = script.ambience
    # A bare "N/A" in the node's music input means "use the script's # Music".
    music_text = (music if music and music.strip() and music != "N/A"
                  else script.music or "N/A")

    return "\n\n".join([
        f"subject_definitions:\n{subject_definitions}",
        f"summary:\n{summary}",
        f"retention_analysis:\n{retention}",
        f"detailed_description:\n{detailed_description}",
        f"overall_soundscape:\n{soundscape}",
        f"non_diegetic_music:\n{music_text}",
    ])


def plan_radio_play(
    script_text: str,
    fps: int = DEFAULT_FPS,
    max_segment_seconds: float = DEFAULT_MAX_SEGMENT_SECONDS,
    words_per_second: float = DEFAULT_WORDS_PER_SECOND,
    voice_slots: int = DEFAULT_VOICE_SLOTS,
    final_event: bool = True,
    music: Optional[str] = None,
) -> tuple:
    """Turn a radio-play script into the per-segment audio-only recipe.

    Returns (segments_json, prompts_text, segment_count, issues_text).
    """
    fps = max(1, min(60, int(fps)))
    max_segment_seconds = max(4.0, min(15.0, float(max_segment_seconds)))
    words_per_second = max(1.5, min(4.0, float(words_per_second)))
    voice_slots = max(1, min(6, int(voice_slots)))

    script = parse_script(script_text, words_per_second)
    issues = list(script.issues)

    # --- word-budget audit ------------------------------------------------
    total_words = _spoken_words(script.beats)
    est_speech = total_words / words_per_second
    if not script.ambience.strip():
        issues.append(
            "no ambience: the bed comes from the prompt text alone — an empty "
            "overall_soundscape risks a dry, studio-like result with no bed "
            "under the voices."
        )
    if total_words:
        issues.append(
            f"script word count: ~{total_words} spoken words "
            f"(~{est_speech:.1f}s of speech at {words_per_second}/s). "
            "Count words before you count segments."
        )

    # --- cast vs. available soundtrack slots -------------------------------
    cast_size = len(script.cast)
    if cast_size > voice_slots:
        issues.append(
            f"cast has {cast_size} characters but only {voice_slots} "
            "soundtrack slot(s). A character beyond the slots must ride in "
            "as a reference video's soundtrack, or the binding falls back to "
            "the last slot."
        )

    # --- pack beats into segments ------------------------------------------
    packed = _pack_segments(script.beats, max_segment_seconds)
    recipes: List[SegmentRecipe] = []
    start_sec = 0.0
    for seg_idx, (beats, sec, words) in enumerate(packed, start=1):
        frames = align_frame_count(max(5, round(sec * fps)))
        budget = words_per_second * max_segment_seconds
        speakers = []
        for b in beats:
            if b.kind == "dialogue" and b.sid not in speakers:
                speakers.append(b.sid)
        last = beats[-1]
        if final_event and _has_explicit_ending(last.raw):
            # The user already wrote the explicit closer - keep it and do not
            # double it with an auto-generated final event.
            fe = ""
        elif final_event:
            fe = _final_event(last)
        else:
            fe = ""  # final events disabled - nothing auto-generated

        recipe = SegmentRecipe(
            index=seg_idx, start_sec=round(start_sec, 3),
            duration_sec=round(sec, 3), frames=frames,
            word_count=words, word_budget=round(budget, 1),
            speakers=speakers, beats=beats, prompt="", final_event=fe,
        )
        if words > budget * 1.02:
            issues.append(
                f"segment {seg_idx}: {words} words exceeds the dialogue "
                f"budget ({budget:.0f}) - speech will sound rushed and lines "
                "may clip into each other. Shorten the lines or raise "
                "words_per_second."
            )
        if words < budget * 0.35:
            issues.append(
                f"segment {seg_idx}: only {words} words in ~{sec:.1f}s - the "
                "model may invent mumbling to fill the time. Describe the "
                "ending explicitly (the final event is auto-appended)."
            )
        if sec > max_segment_seconds + 1e-6:
            issues.append(
                f"segment {seg_idx}: a single beat is {sec:.1f}s, longer than "
                f"the {max_segment_seconds:.0f}s window - quality may degrade "
                "past H3's native range."
            )
        recipes.append(recipe)
        start_sec += sec

    # --- prompts ------------------------------------------------------------
    for recipe in recipes:
        recipe.prompt = build_segment_prompt(
            recipe, script, len(recipes), voice_slots, words_per_second, music
        )

    # --- output JSON ---------------------------------------------------------
    segment_payload = []
    for recipe in recipes:
        beat_view = []
        for b in recipe.beats:
            if b.kind == "dialogue":
                view = {
                    "kind": "dialogue",
                    "speaker": b.speaker,
                    "sid": b.sid,
                    "direction": b.direction,
                    "line": b.line,
                    "cue": b.cue,
                    "words": b.words,
                    "duration_sec": round(b.duration, 2),
                }
            else:
                view = {"kind": "stage", "line": b.line,
                        "duration_sec": round(b.duration, 2)}
            beat_view.append(view)
        segment_payload.append({
            "index": recipe.index,
            "start_sec": recipe.start_sec,
            "duration_sec": recipe.duration_sec,
            "frames": recipe.frames,
            "word_count": recipe.word_count,
            "word_budget": recipe.word_budget,
            "speakers": recipe.speakers,
            "final_event": recipe.final_event,
            "beats": beat_view,
        })

    recipe_json = json.dumps({
        "mode": "radio-play (audio-only)",
        "latent": AUDIO_LATENT,
        "fps": fps,
        "frame_grid": {"expression": FRAME_GRID_EXPRESSION, "grid": "17k+5"},
        "words_per_second": words_per_second,
        "wiring": {
            "ref_audio": [],
            "ref_video_audio": [
                f"<Video {i}>" for i in range(1, voice_slots + 1)
            ],
            "note": "bind each character's voice to a soundtrack slot; "
                    "keep ref_audio EMPTY or the ambience bed collapses.",
        },
        "render_recipe": RENDER_RECIPE,
        "post": {
            "trim_head_ms": 150,
            "crossfade_ms": 150,
            "note": "every generation starts with a millisecond-scale ghost "
                    "word; trim 50-200 ms off every segment head and "
                    "crossfade ~150 ms on the joins.",
        },
        "totals": {
            "words": total_words,
            "est_speech_sec": round(est_speech, 1),
            "segments": len(recipes),
        },
        "segments": segment_payload,
    }, ensure_ascii=False, indent=2)

    prompts_text = "\n\n" + "\n\n".join(
        f"================ SEGMENT {r.index} / {len(recipes)} "
        f"({r.duration_sec}s, {r.frames} frames, {r.word_count} words) "
        f"================" + "\n\n" + r.prompt
        for r in recipes
    ) + "\n"

    issues_text = "\n".join(issues) if issues else "No issues."
    return recipe_json, prompts_text, len(recipes), issues_text
