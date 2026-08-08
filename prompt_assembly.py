"""Chaotic MinimaxH3 Director — prompt assembly (pure, no ComfyUI imports).

Implements MiniMax H3's official full-reference (ref2va) prompt format and the
looser narrative scene-block format, per the official H3 prompting guide:

    subject_definitions:  ->  summary:  ->  retention_analysis:  ->
    detailed_description: ([Shot N] blocks, "At MM:SS.mmm," cut timestamps) ->
    overall_soundscape:   ->  non_diegetic_music:

Every chunk's prompt is self-contained: shot blocks are renumbered to start at
[Shot 1] and cut timestamps are relative to the chunk's own start, so each
rendered chunk reads like a complete clip that happens to continue the last.

The anchor (the previous chunk's final frame) is auto-defined as the next free
<Picture N>, stated in subject_definitions and locked with fully_preserved in
retention_analysis, exactly like the official FL2VA hand-off convention.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .timeline import Ref, Shot, Timeline

# --------------------------------------------------------------------------- #
# Retention markers (official guide taxonomy)
# --------------------------------------------------------------------------- #

VISUAL_MARKERS = ("fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference")
AUDIO_MARKERS = ("fully_copy", "partially_copy", "reference", "weak_reference")

_TAG_RE = re.compile(r"<([A-Za-z]+)\s+(\d+)>")
_REMAP_FAMILIES = ("Picture", "Video", "Audio")

_WEAK_CLAUSE = (
    " Its exact content is explicitly NOT copied; only broad atmosphere, "
    "energy, or style is borrowed."
)


def fmt_timestamp(sec: float) -> str:
    """Format seconds as MM:SS.mmm (official cut-timestamp syntax)."""
    sec = max(0.0, float(sec))
    mm = int(sec // 60)
    rest = sec - mm * 60
    ss = int(rest)
    mmm = round((rest - ss) * 1000)
    if mmm == 1000:
        mmm = 0
        ss += 1
    if ss == 60:
        ss = 0
        mm += 1
    return f"{mm:02d}:{ss:02d}.{mmm:03d}"


def strength_to_marker(kind: str, strength: float) -> str:
    """Map a 0..1 strength slider onto H3's discrete retention vocabulary.

    Visual: fully_preserved >= .85, partially_preserved >= .6,
            attribute_transfer >= .35, else weak_reference.
    Audio:  fully_copy >= .85, partially_copy >= .6, reference >= .35,
            else weak_reference.
    """
    if kind == "audio":
        if strength >= 0.85:
            return "fully_copy"
        if strength >= 0.6:
            return "partially_copy"
        if strength >= 0.35:
            return "reference"
        return "weak_reference"
    if strength >= 0.85:
        return "fully_preserved"
    if strength >= 0.6:
        return "partially_preserved"
    if strength >= 0.35:
        return "attribute_transfer"
    return "weak_reference"


def marker_for_role(role: str, kind: str) -> str:
    """Marker for source clips (the base being edited) vs mood donors."""
    if role == "source":
        return "fully_copy" if kind == "audio" else "fully_preserved"
    return strength_to_marker(kind, 1.0)


# --------------------------------------------------------------------------- #
# Text utilities
# --------------------------------------------------------------------------- #


def split_shot_beats(text: str) -> List[str]:
    """Split shot text into [Shot N]-delimited beats.

    A shot block may contain several "[Shot N] ..." paragraphs (e.g. a user
    pasting a whole detailed_description into one block).  Every "[Shot N]"
    marker starts a new beat; text before the first marker is beat 0.
    """
    text = text.strip()
    if not text:
        return []
    parts = re.split(r"(?=\[Shot\s+\d+\])", text)
    beats = [part.strip() for part in parts if part.strip()]
    return beats if beats else [text]


def renumber_shot_markers(text: str, start_number: int = 1) -> str:
    """Replace leading "[Shot N]" markers so the first beat becomes
    [Shot {start_number}] and every following marker is renumbered
    sequentially."""
    markers = list(re.finditer(r"\[Shot\s+\d+\]", text))
    if not markers:
        return text
    out = []
    last = 0
    for offset, match in enumerate(markers):
        out.append(text[last:match.start()])
        out.append(f"[Shot {start_number + offset}]")
        last = match.end()
    out.append(text[last:])
    return "".join(out)


_CUT_RE = re.compile(r"\bAt\s+\d{2}:\d{2}\.\d{3}\b")


def _beat_timestamp_prefix(beat_index: int, shot_time: float) -> str:
    """Official syntax: [Shot 1] carries no timestamp, later shots do."""
    if beat_index == 0:
        return ""
    if _CUT_RE.search(beat):
        return ""
    return f"At {fmt_timestamp(shot_time)}, "


def remap_tags(text: str, mapping: Dict[str, str], issues: List[str]) -> str:
    """Rewrite <Picture N>/<Video N>/<Audio N> tags from their global numbers
    to this chunk's local numbers.

    Tags with no mapping entry are left untouched (they reference media that is
    out of scope for this chunk) and reported as issues — this is the exact
    dangling-reference class the UI warns about.
    """
    if not text or not mapping:
        return text

    def _replace(match: "re.Match[str]") -> str:
        family = match.group(1)
        global_tag = f"<{family} {match.group(2)}>"
        if family not in _REMAP_FAMILIES:
            # <Subject N> is a text-level alias, never renumbered.
            return global_tag
        local = mapping.get(global_tag)
        if local is None:
            issues.append(f"Tag {global_tag} is not active in this chunk and was left as-is.")
            return global_tag
        return local

    return _TAG_RE.sub(_replace, text)


# --------------------------------------------------------------------------- #
# Chunk prompt bundle
# --------------------------------------------------------------------------- #


@dataclass
class PromptBundle:
    prompt: str = ""
    issues: List[str] = field(default_factory=list)
    tag_map: Dict[str, str] = field(default_factory=dict)


def _auto_subject_definition(entry, tag: str) -> Optional[str]:
    """Auto subject_definitions line for a ref when the user left the field bare."""
    ref = entry.ref
    if ref.kind == "video":
        role = "the base clip being edited" if ref.role == "source" else "a structural video reference"
        return f"{tag} is {role} for the target video."
    if ref.kind == "audio":
        return f"{tag} is the reference audio track."
    return None  # pictures/subjects are described by the user


def _auto_retention_line(entry, tag: str, shot_nums: List[int]) -> str:
    ref = entry.ref
    kind = "audio" if ref is not None and ref.kind == "audio" else "visual"
    if entry.is_anchor:
        return (
            f"{tag} (appears in [Shot {shot_nums[0]}]): fully_preserved - "
            "the literal final frame of the previous segment; the first frame "
            "of this segment anchors exactly onto it."
        )
    if ref is None:
        return ""
    marker = strength_to_marker(kind, ref.strength)
    note = (ref.annotation or "").strip()
    if ref.role == "source":
        note = note or ("the base clip being edited; framing, motion, and pacing retained.")
    elif ref.kind == "picture":
        note = note or "the reference image's composition and content are retained."
    elif ref.kind == "subject":
        note = note or "the subject keeps its defined identity."
    elif ref.kind == "video":
        note = note or "the reference video's motion, pacing, and cut timing are retained."
    else:
        note = note or "the reference audio's character is retained."
    if marker == "weak_reference" and "not copied" not in note.lower():
        note += _WEAK_CLAUSE
    context = f" (appears in {', '.join(f'[Shot {n}]' for n in shot_nums)})"
    return f"{tag}{context}: {marker} - {note}"


def _audio_line_for_video(entry, audio_tag: str, shot_nums: List[int]) -> str:
    """Retention line for a video ref's soundtrack (<Audio j>)."""
    ref = entry.ref
    marker = "fully_copy" if ref.role == "source" else strength_to_marker("audio", ref.strength)
    note = "the original soundtrack is reused 1:1 as this segment's audio." if ref.role == "source" \
        else "the soundtrack's character is referenced and re-performed."
    context = f" (appears in {', '.join(f'[Shot {n}]' for n in shot_nums)})"
    return f"{audio_tag}{context}: {marker} - {note}"


# --------------------------------------------------------------------------- #
# Official-format assembly
# --------------------------------------------------------------------------- #


def _shot_lines(chunk_shots: List[Shot], chunk_start_sec: float, tag_map: Dict[str, str], issues: List[str]) -> List[str]:
    """Flatten chunk shots into [Shot i] beat lines with cut timestamps.

    Timestamps are relative to the chunk start (each rendered chunk is its own
    complete clip); shot.start is global, so the offset is subtracted here.
    """
    lines: List[str] = []
    beat_index = 0
    for shot in chunk_shots:
        for beat in split_shot_beats(shot.text):
            body = renumber_shot_markers(beat).strip()
            if not body:
                continue
            marker_match = re.match(r"\[Shot\s+(\d+)\]\s*(.*)", body, re.S)
            if marker_match:
                body = marker_match.group(2).strip()
            body = remap_tags(body, tag_map, issues)
            relative = max(0.0, shot.start - chunk_start_sec)
            prefix = _beat_timestamp_prefix(beat_index, relative)
            lines.append(f"[Shot {beat_index + 1}] {prefix}{body}".rstrip())
            beat_index += 1
    return lines


def _retention_context(chunk_shots: List[Shot]) -> Dict[str, List[int]]:
    """Map a shot id -> the [Shot N] numbers it occupies in this chunk."""
    mapping: Dict[str, List[int]] = {}
    n = 0
    for shot in chunk_shots:
        beat_count = len(split_shot_beats(shot.text))
        mapping[shot.id] = list(range(n + 1, n + beat_count + 1))
        n += beat_count
    return mapping


def build_official_prompt(
    timeline: Timeline,
    chunk_index: int,
    chunk_start_sec: float,
    chunk_shots: List[Shot],
    entries,  # list[ChunkRefEntry] from chunking
    anchor_tag: Optional[str],
    global_tags: Dict[str, str],
    tag_map: Dict[str, str],
    issues: List[str],
) -> str:
    project = timeline.project
    parts: List[str] = []

    trigger = project.lora_trigger
    if trigger:
        head = trigger.rstrip(".") + "."
        if project.style_clarification:
            head += " " + project.style_clarification
        parts.append(head)

    # --- subject_definitions -------------------------------------------------
    lines = []
    user_defs = project.official_field("subject_definitions")
    if user_defs:
        lines.append(remap_tags(user_defs, tag_map, issues))
    for entry in entries:
        if entry.tag == anchor_tag and anchor_tag is not None:
            lines.append(
                f"{anchor_tag} is the literal final frame of the previous segment — "
                "the first-frame anchor this segment starts from."
            )
        elif entry.is_context:
            lines.append(
                f"{entry.tag} is a weak reference to the previous segment's footage — "
                "its exact content is explicitly NOT copied; only broad motion, "
                "energy, and lighting carry over."
            )
        elif entry.is_storyboard:
            lines.append(
                f"{entry.tag} is the storyboard mockup for this segment — its composition, "
                "character positions, scale, layering, and motion are the authoritative "
                "staging that this segment must realize faithfully."
            )
        elif entry.ref is not None and entry.ref.kind in ("video", "audio") and not entry.ref.annotation:
            auto = _auto_subject_definition(entry, entry.tag)
            if auto and entry.tag not in user_defs:
                lines.append(auto)
        elif entry.ref is not None and entry.ref.strength < 0.35 and entry.tag not in user_defs:
            # weak_reference must be stated in BOTH subject_definitions and
            # retention_analysis with an explicit not-copied clause, or its
            # influence leaks into composition anyway.
            lines.append(
                f"{entry.tag} is a weak reference for broad atmosphere only"
                f"{_WEAK_CLAUSE}"
            )
    parts.append("subject_definitions:\n" + "\n".join(lines))

    # --- summary -------------------------------------------------------------
    summary = project.official_field("summary")
    if chunk_index > 0:
        if summary.startswith("["):
            inner = summary[1:summary.find("]")] if "]" in summary else ""
            summary = f"[{inner.strip() or 'reference generation'} + video continuation]{summary[summary.find(']') + 1:]}"
        else:
            summary = f"[reference generation + video continuation] {summary}"
    if not summary.strip():
        summary = (
            "[reference generation + video continuation] The scene continues "
            "from the final frame of the previous segment with the same "
            "subjects, location, lighting, and energy."
        )
    parts.append("summary:\n" + remap_tags(summary, tag_map, issues))

    # --- retention_analysis --------------------------------------------------
    lines = []
    user_retention = project.official_field("retention_analysis")
    covered_tags = set(re.findall(r"<[A-Za-z]+\s+\d+>", user_retention))
    if user_retention:
        lines.append(remap_tags(user_retention, tag_map, issues))
    ctx = _retention_context(chunk_shots)
    for entry in entries:
        if entry.is_anchor:
            if anchor_tag not in covered_tags:
                lines.append(_auto_retention_line(entry, anchor_tag, [1]))
            continue
        if entry.is_context:
            if entry.tag not in covered_tags:
                lines.append(
                    f"{entry.tag} (appears in all shots of this segment): weak_reference - "
                    "carries motion, energy, and lighting from the previous segment; "
                    "explicitly not copied."
                )
            continue
        if entry.is_storyboard:
            if entry.tag not in covered_tags:
                lines.append(
                    f"{entry.tag} (appears in all shots of this segment): fully_preserved - "
                    "reproduce the mockup's layout, positions, and motion exactly; "
                    "it is the blueprint for this segment."
                )
            continue
        if entry.tag in covered_tags:
            continue
        lines.append(_auto_retention_line(entry, entry.tag, _context_for_entry(entry, chunk_shots, ctx)))
        if entry.ref is not None and entry.ref.kind == "video" and entry.ref.use_soundtrack:
            lines.append(_audio_line_for_video(entry, entry.audio_tag, _context_for_entry(entry, chunk_shots, ctx)))
    parts.append("retention_analysis:\n" + "\n".join(lines))

    # --- detailed_description -------------------------------------------------
    dd_lines = []
    style_line = project.official_field("style_line")
    if style_line:
        dd_lines.append(remap_tags(style_line, tag_map, issues))
    dd_lines.extend(_shot_lines(chunk_shots, chunk_start_sec, tag_map, issues))
    parts.append("detailed_description:\n" + "\n".join(dd_lines))

    # --- audio sections -------------------------------------------------------
    soundscape = project.official_field("overall_soundscape")
    parts.append(f"overall_soundscape:\n{soundscape}" if soundscape else "overall_soundscape:\nN/A")
    music = project.official_field("non_diegetic_music")
    parts.append(f"non_diegetic_music:\n{music}" if music else "non_diegetic_music:\nN/A")

    return "\n\n".join(parts)


def _context_for_entry(entry, chunk_shots: List[Shot], ctx: Dict[str, List[int]]) -> List[int]:
    if entry.ref is None:
        return [1]
    nums: List[int] = []
    for shot in chunk_shots:
        if shot.id in ctx and entry.ref.overlaps(shot.start, shot.end):
            nums.extend(ctx[shot.id])
    return nums or [1]


# --------------------------------------------------------------------------- #
# Narrative-format assembly
# --------------------------------------------------------------------------- #


def build_narrative_prompt(
    timeline: Timeline,
    chunk_index: int,
    chunk_shots: List[Shot],
    issues: List[str],
) -> str:
    project = timeline.project
    parts: List[str] = []

    trigger = project.lora_trigger
    if trigger:
        head = trigger.rstrip(".") + "."
        if project.style_clarification:
            head += " " + project.style_clarification
        parts.append(head)

    if chunk_index > 0:
        parts.append(
            "The scene continues directly from the previous segment: the first "
            "frame is exactly the previous segment's final frame, and the action "
            "picks up from that instant without a jump."
        )

    header = []
    for key, label in (("scene", "Scene"), ("subjects", "Subjects"), ("lighting", "Lighting")):
        value = project.narrative_field(key)
        if value:
            header.append(f"{label}: {value}")
    if header:
        parts.append("\n".join(header))

    for shot in chunk_shots:
        text = shot.text.strip()
        if text:
            parts.append(text)

    return "\n\n".join(parts)


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #


def assemble_chunk_prompt(
    timeline: Timeline,
    chunk_index: int,
    chunk_start_sec: float,
    chunk_shots: List[Shot],
    entries,
    anchor_tag: Optional[str],
    global_tags: Dict[str, str],
    tag_map: Dict[str, str],
    format_override: Optional[str] = None,
) -> PromptBundle:
    """Build the full prompt for one chunk in the project's chosen format."""
    issues: List[str] = []
    fmt = format_override or timeline.project.format
    if fmt == "narrative":
        prompt = build_narrative_prompt(timeline, chunk_index, chunk_shots, issues)
    else:
        prompt = build_official_prompt(
            timeline, chunk_index, chunk_start_sec, chunk_shots, entries, anchor_tag,
            global_tags, tag_map, issues,
        )
    return PromptBundle(prompt=prompt.strip(), issues=issues, tag_map=tag_map)
