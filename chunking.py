"""Chaotic MinimaxH3 Director — VRAM-safe chunk planning (pure).

Turns the authored timeline (which may describe a 15s+ multi-shot scene) into
a sequence of sequentially renderable chunks:

  * chunks break at [Shot N] beat / shot boundaries wherever possible,
  * a beat longer than the chunk budget is split at sentence boundaries
    (falling back to word boundaries — never mid-word),
  * pinned boundaries (dragged by the user on the timeline) force a break,
    splitting a beat mid-text when the user explicitly pins an intentional
    hard cut,
  * every chunk's refs are re-tagged to local numbers starting at 1
    (<Picture 1>, <Video 1>, <Audio 1> ...) so the prompt text always matches
    the conditioning bundle the engine pushes for that chunk,
  * chunk > 0 carries a seam anchor: the previous chunk's final frame,
    auto-tagged as the next free <Picture N>.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .timeline import Ref, Shot, Timeline

GRID = 17
GRID_OFFSET = 5


def align_frame_count(n: int) -> int:
    """Snap to the H3 17k+5 frame grid (same as comfy_extras.nodes_minimax_h3)."""
    n = max(GRID_OFFSET, int(n))
    while n % GRID != GRID_OFFSET:
        n += 1
    return n


def _split_sentences(text: str) -> List[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?…])\s+", text) if s.strip()]


def _word_split(text: str, target_chars: int) -> List[str]:
    """Split text into word-boundary chunks each around target_chars long."""
    words = text.split()
    if not words:
        return []
    pieces: List[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip() if current else word
        if current and len(candidate) > target_chars:
            pieces.append(current)
            current = word
        else:
            current = candidate
    if current:
        pieces.append(current)
    return pieces


def split_beat_text(text: str, max_sec: float, beat_sec: float) -> List[Tuple[str, float]]:
    """Split a beat's text into (text, duration) pieces that fit max_sec.

    Prefers sentence boundaries; a single over-long sentence is split at word
    boundaries.  Durations are proportional to text length so the overall
    timeline length is preserved.
    """
    total_chars = max(1, len(text))
    target_chars = max(1, int(total_chars * (max_sec / max(beat_sec, 1e-6))))
    sentences = _split_sentences(text)
    if len(sentences) > 1:
        pieces: List[str] = []
        current = ""
        for sentence in sentences:
            candidate = f"{current} {sentence}".strip() if current else sentence
            if current and len(candidate) > target_chars and current.endswith((".", "!", "?", "…")):
                pieces.append(current)
                current = sentence
            else:
                current = candidate
        if current:
            pieces.append(current)
    else:
        pieces = _word_split(text, target_chars)
    if not pieces:
        pieces = [text]

    out: List[Tuple[str, float]] = []
    pieces_total = max(1, sum(len(p) for p in pieces))
    for piece in pieces:
        share = len(piece) / pieces_total
        out.append((piece, round(beat_sec * share, 6)))
    return out


# --------------------------------------------------------------------------- #
# Beat model
# --------------------------------------------------------------------------- #


@dataclass
class _Beat:
    id: str
    text: str
    start: float  # global seconds
    duration: float
    format: str

    @property
    def end(self) -> float:
        return self.start + self.duration


def _flatten_beats(timeline: Timeline) -> List[_Beat]:
    beats: List[_Beat] = []
    for shot in sorted(timeline.shots, key=lambda s: s.start):
        pieces = _beat_pieces(shot.text)
        if not pieces:
            continue
        total_chars = max(1, sum(len(p) for p in pieces))
        cursor = shot.start
        for index, piece in enumerate(pieces):
            duration = shot.duration * (len(piece) / total_chars)
            beats.append(_Beat(
                id=f"{shot.id}#{index}",
                text=piece,
                start=round(cursor, 6),
                duration=round(duration, 6),
                format=shot.format,
            ))
            cursor += duration
    return beats


def _beat_pieces(text: str) -> List[str]:
    """Beat pieces for a shot: [Shot N]-delimited paragraphs."""
    text = text.strip()
    if not text:
        return []
    parts = re.split(r"(?=\[Shot\s+\d+\])", text)
    return [p.strip() for p in parts if p.strip()]


# --------------------------------------------------------------------------- #
# Chunk plan model
# --------------------------------------------------------------------------- #


@dataclass
class ChunkRefEntry:
    """One reference bundled into a chunk, with its chunk-local tag."""

    ref: Optional[Ref]          # None => synthesized seam anchor / context video
    kind: str                   # "picture" | "video" | "audio"
    tag: str                    # chunk-local "<Picture 2>" etc.
    audio_tag: str = ""         # video-with-soundtrack's "<Audio j>"
    is_anchor: bool = False
    is_context: bool = False    # synthesized <Video N> of the previous chunk


@dataclass
class ChunkPlan:
    index: int
    start_sec: float
    duration_sec: float
    frames: int
    shots: List[Shot]           # global starts; assembly offsets by chunk start
    ref_entries: List[ChunkRefEntry]
    anchor_tag: Optional[str]
    issues: List[str] = field(default_factory=list)

    @property
    def end_sec(self) -> float:
        return self.start_sec + self.duration_sec


# --------------------------------------------------------------------------- #
# Pinned boundary splitting
# --------------------------------------------------------------------------- #


def _split_beats_at_pins(beats: List[_Beat], pins: List[float]) -> List[_Beat]:
    if not pins:
        return beats
    out: List[_Beat] = []
    for beat in beats:
        cut_points = sorted(p for p in pins if beat.start < p < beat.end)
        if not cut_points:
            out.append(beat)
            continue
        cursor = beat.start
        remaining = beat.text
        for pin in cut_points:
            if pin <= cursor:
                continue
            # Split at the word boundary nearest the proportional text position;
            # the DURATION of each side is pinned exactly (hard cut at `pin`).
            fraction = (pin - beat.start) / max(beat.duration, 1e-6)
            target_chars = int(len(remaining) * fraction)
            pieces = _word_split(remaining, max(1, target_chars))
            if not pieces:
                break
            head_text = pieces[0]
            rest = remaining[len(head_text):].lstrip()
            head_dur = pin - cursor
            out.append(_Beat(beat.id, head_text, round(cursor, 6), round(head_dur, 6), beat.format))
            cursor = pin
            remaining = rest
            if not remaining:
                break
        if remaining:
            rest_dur = beat.end - cursor
            out.append(_Beat(beat.id, remaining, round(cursor, 6), round(max(rest_dur, 0.05), 6), beat.format))
    return out


# --------------------------------------------------------------------------- #
# Tag assignment per chunk (must mirror the engine's ref_items order)
# --------------------------------------------------------------------------- #


def _in_scope_refs(timeline: Timeline, start: float, end: float) -> List[Ref]:
    """Refs active in [start, end): timed refs overlapping the window, PLUS every
    untimed (library) ref — library references are always in scope so they can
    be tagged from any shot, without ever appearing on the timeline."""
    timed = sorted(
        (ref for ref in timeline.refs if ref.timed and ref.overlaps(start, end)),
        key=lambda r: (r.start, r._index),
    )
    untimed = sorted(
        (ref for ref in timeline.refs if not ref.timed),
        key=lambda r: r._index,
    )
    return timed + untimed


def _chunk_ref_entries(timeline: Timeline, start: float, end: float, has_anchor: bool, video_context: bool = False) -> List[ChunkRefEntry]:
    refs = _in_scope_refs(timeline, start, end)
    entries: List[ChunkRefEntry] = []
    soundtracks = [ref for ref in refs if ref.kind == "video" and ref.use_soundtrack]
    standalone_audios = [ref for ref in refs if ref.kind == "audio"]

    picture_index = 0
    video_index = 0
    for ref in refs:
        if ref.kind in ("picture", "subject"):
            picture_index += 1
            entries.append(ChunkRefEntry(ref=ref, kind="picture", tag=f"<Picture {picture_index}>"))
    for ref in refs:
        if ref.kind == "video":
            video_index += 1
            entry = ChunkRefEntry(ref=ref, kind="video", tag=f"<Video {video_index}>")
            if ref.use_soundtrack:
                entry.audio_tag = f"<Audio {soundtracks.index(ref) + 1}>"
            entries.append(entry)
    if video_context and start > 0.0:
        video_index += 1
        entries.append(ChunkRefEntry(
            ref=None, kind="video", tag=f"<Video {video_index}>", is_context=True,
        ))

    anchor_tag = None
    if has_anchor:
        anchor_tag = f"<Picture {picture_index + 1}>"
        entries.append(ChunkRefEntry(ref=None, kind="picture", tag=anchor_tag, is_anchor=True))

    audio_index = 0
    for ref in standalone_audios:
        audio_index += 1
        entries.append(ChunkRefEntry(
            ref=ref, kind="audio",
            tag=f"<Audio {len(soundtracks) + audio_index}>",
        ))
    return entries, anchor_tag


# --------------------------------------------------------------------------- #
# Public planner
# --------------------------------------------------------------------------- #


def plan_chunks(
    timeline: Timeline,
    target_frames: int,
    fps: int = 24,
    continuity: str = "keyframe+picture",
    video_context: bool = False,
) -> List[ChunkPlan]:
    """Split the timeline into renderable chunks.

    Args:
        timeline: parsed Timeline model.
        target_frames: chunk budget in frames (grid-aligned by the caller for
            fixed mode; raw for auto mode — always clamped here).
        fps: frames per second (default 24).
        continuity: "keyframe+picture" | "picture" | "keyframe" | "none".
    """
    if not timeline.shots:
        raise ValueError(
            "Chaotic H3 Director: the timeline has no shots. Add prompt blocks "
            "to the prompt track before rendering."
        )

    target_frames = max(align_frame_count(5), int(target_frames))
    max_sec = max(0.25, target_frames / max(1, fps))
    total_sec = timeline.duration_sec
    pins = [p for p in timeline.pinned_boundaries if 0.0 < p < total_sec]

    beats = _split_beats_at_pins(_flatten_beats(timeline), pins)
    if not beats:
        raise ValueError("Chaotic H3 Director: no shot text found after flattening.")

    # --- greedy pack ---------------------------------------------------------
    chunks: List[ChunkPlan] = []
    current_beats: List[_Beat] = []
    chunk_start = 0.0
    chunk_sec = 0.0
    next_pin_idx = 0

    def _budget() -> float:
        if next_pin_idx < len(pins):
            return min(max_sec, pins[next_pin_idx] - chunk_start)
        return max_sec

    for beat in beats:
        if chunk_sec > 0.0 and chunk_sec + beat.duration > _budget() + 1e-6:
            _close_chunk(chunks, timeline, chunk_start, chunk_sec, current_beats,
                         len(chunks), fps, continuity, video_context)
            chunk_start = chunk_start + chunk_sec
            chunk_sec = 0.0
            current_beats = []
            while next_pin_idx < len(pins) and pins[next_pin_idx] <= chunk_start + 1e-6:
                next_pin_idx += 1

        if beat.duration > max_sec + 1e-6:
            for text, duration in split_beat_text(beat.text, max_sec, beat.duration):
                sub = _Beat(beat.id, text, round(chunk_start + chunk_sec, 6), round(duration, 6), beat.format)
                if chunk_sec > 0.0 and chunk_sec + sub.duration > _budget() + 1e-6:
                    _close_chunk(chunks, timeline, chunk_start, chunk_sec, current_beats,
                                 len(chunks), fps, continuity, video_context)
                    chunk_start = chunk_start + chunk_sec
                    chunk_sec = 0.0
                    current_beats = []
                    while next_pin_idx < len(pins) and pins[next_pin_idx] <= chunk_start + 1e-6:
                        next_pin_idx += 1
                current_beats.append(sub)
                chunk_sec += sub.duration
        else:
            current_beats.append(beat)
            chunk_sec += beat.duration

    if current_beats:
        _close_chunk(chunks, timeline, chunk_start, chunk_sec, current_beats,
                     len(chunks), fps, continuity, video_context)

    if not chunks:
        raise ValueError("Chaotic H3 Director: chunk planning produced no chunks.")

    _renumber_chunk_shots(chunks)
    _validate_plan(chunks, timeline)
    return chunks


def _close_chunk(
    chunks: List[ChunkPlan],
    timeline: Timeline,
    start: float,
    duration: float,
    beats: List[_Beat],
    index: int,
    fps: int,
    continuity: str,
    video_context: bool = False,
) -> None:
    duration = max(duration, 1e-6)
    frames = align_frame_count(max(5, int(round(duration * fps))))
    # Re-derive the chunk duration from the aligned frame count (the rendered
    # clip is exactly frames/fps long — H3 snaps anyway).
    duration = frames / max(1, fps)
    has_anchor = index > 0 and continuity in ("keyframe+picture", "keyframe", "picture")
    entries, anchor_tag = _chunk_ref_entries(timeline, start, start + duration, has_anchor, video_context)
    shots = [_beat_to_shot(b) for b in beats]
    chunks.append(ChunkPlan(
        index=index,
        start_sec=round(start, 6),
        duration_sec=round(duration, 6),
        frames=frames,
        shots=shots,
        ref_entries=entries,
        anchor_tag=anchor_tag if continuity != "none" else None,
    ))


def _beat_to_shot(beat: _Beat) -> Shot:
    return Shot(
        id=beat.id,
        start=round(beat.start, 6),
        duration=round(beat.duration, 6),
        text=beat.text,
        format=beat.format,
    )


def _renumber_chunk_shots(chunks: List[ChunkPlan]) -> None:
    """Sequential ids per chunk (stable, for retention context mapping)."""
    for plan in chunks:
        for index, shot in enumerate(plan.shots, start=1):
            shot.id = f"c{plan.index}s{index}"


def _validate_plan(chunks: List[ChunkPlan], timeline: Timeline) -> None:
    issues: List[str] = []
    for plan in chunks:
        if plan.frames < align_frame_count(5):
            issues.append(f"Chunk {plan.index + 1} is below the minimum frame count.")
        for entry in plan.ref_entries:
            if entry.ref is not None and entry.ref.kind == "video" and entry.ref.use_soundtrack and not entry.audio_tag:
                issues.append(f"Video ref {entry.ref.name or entry.ref.file} lost its soundtrack tag.")
        for shot in plan.shots:
            if not shot.text.strip():
                issues.append(f"Chunk {plan.index + 1} contains an empty shot block.")
    for issue in issues:
        chunks[0].issues.append(issue)


# --------------------------------------------------------------------------- #
# Global -> chunk-local tag map (for rewriting user-authored text)
# --------------------------------------------------------------------------- #


def build_tag_map(
    timeline: Timeline,
    plan: ChunkPlan,
    global_tags: Dict[str, str],
) -> Dict[str, str]:
    """Map global tags ("<Picture 3>") to this chunk's local tags.

    The seam anchor has no global tag, so user text can never refer to it —
    its definition line is generated by the assembler instead.
    """
    mapping: Dict[str, str] = {}
    for entry in plan.ref_entries:
        if entry.ref is None or entry.is_anchor:
            continue
        global_tag = global_tags.get(entry.ref.id)
        if global_tag and global_tag != entry.tag:
            mapping[global_tag] = entry.tag
    return mapping
