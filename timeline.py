"""Chaotic MinimaxH3 Director — timeline data contract.

This module is deliberately FREE of any ComfyUI / torch imports so it can be
unit-tested with a plain interpreter. It defines the single source of truth
between the JavaScript timeline widget (which serializes `timeline_data` into
a hidden STRING widget) and the Python node (which re-parses it).

The JSON produced by the widget:

    {
      "version": 1,
      "fps": 24,
      "project": {
        "format": "official" | "narrative",
        "lora_trigger": "",
        "style_clarification": "",
        "official": {
          "subject_definitions": "", "summary": "", "retention_analysis": "",
          "style_line": "", "overall_soundscape": "", "non_diegetic_music": ""
        },
        "narrative": { "scene": "", "subjects": "", "lighting": "", "music": "" }
      },
      "shots": [ { "id": "...", "start": 0.0, "duration": 5.0, "text": "...",
                   "format": "auto" | "official" | "narrative" } ],
      "refs": [ { "id": "...", "kind": "video" | "audio" | "picture" | "subject",
                  "name": "...", "file": "...", "start": 0.0, "duration": 5.0,
                  "trim_start": 0.0, "trim_end": null, "strength": 0.9,
                  "role": "reference" | "source", "annotation": "",
                  "tag_type": "picture" | "subject" } ],
      "boundaries": [ 0.0, 5.0, 10.0 ]
    }

Tag assignment (must be mirrored exactly by the JS widget):

  * Picture + Subject refs share ONE image sequence: numbered <Picture 1..N>
    ordered by (start, insertion index).  Subject refs additionally carry a
    persistent shorthand "S1..SK" (their order among subject refs only), which
    the emitted prompt keeps verbatim (per the MiniMax guide, subjects are
    referred to by shorthand).
  * Video refs -> <Video 1..K>, audio refs -> <Audio 1..J>, same ordering.
  * These GLOBAL tags are what the user types in the text track.  Per chunk the
    assembly layer re-maps tags to chunk-local numbers (refs out of a chunk's
    time range are omitted, so numbering restarts at 1 inside every chunk).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

TIMELINE_VERSION = 1

REF_KINDS = ("video", "audio", "picture", "subject")
ROLES = ("reference", "source")
FORMATS = ("official", "narrative")


# --------------------------------------------------------------------------- #
# Domain model
# --------------------------------------------------------------------------- #


@dataclass
class ProjectSettings:
    """Project-wide prompt scaffolding shared by every chunk."""

    format: str = "official"
    lora_trigger: str = ""
    style_clarification: str = ""
    official: Dict[str, str] = field(default_factory=dict)
    narrative: Dict[str, str] = field(default_factory=dict)

    def official_field(self, key: str) -> str:
        value = self.official.get(key, "")
        return value.strip() if isinstance(value, str) else ""

    def narrative_field(self, key: str) -> str:
        value = self.narrative.get(key, "")
        return value.strip() if isinstance(value, str) else ""


@dataclass
class Shot:
    id: str
    start: float
    duration: float
    text: str
    format: str = "auto"  # "auto" inherits project format

    @property
    def end(self) -> float:
        return self.start + self.duration

    def overlaps(self, start: float, end: float) -> bool:
        """True when this shot's span intersects [start, end)."""
        return self.end > start and self.start < end


@dataclass
class Ref:
    id: str
    kind: str
    file: str
    start: float
    duration: float
    name: str = ""
    trim_start: float = 0.0
    trim_end: Optional[float] = None
    strength: float = 1.0
    role: str = "reference"
    annotation: str = ""
    tag_type: str = "picture"  # only meaningful for kind in ("picture", "subject")
    use_soundtrack: bool = False  # video refs: carry their audio track as <Audio j>
    _index: int = 0  # insertion index in the JSON array (stable tie-break)

    @property
    def end(self) -> float:
        return self.start + self.duration

    def overlaps(self, start: float, end: float) -> bool:
        """True when this reference's active range intersects [start, end)."""
        return self.end > start and self.start < end


@dataclass
class Timeline:
    fps: int = 24
    project: ProjectSettings = field(default_factory=ProjectSettings)
    shots: List[Shot] = field(default_factory=list)
    refs: List[Ref] = field(default_factory=list)
    pinned_boundaries: List[float] = field(default_factory=list)

    @property
    def duration_sec(self) -> float:
        end = 0.0
        for shot in self.shots:
            end = max(end, shot.end)
        for ref in self.refs:
            end = max(end, ref.end)
        return end

    def shot_at(self, t: float) -> Optional[Shot]:
        for shot in self.shots:
            if shot.start <= t < shot.end:
                return shot
        return None


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_str(value: Any, default: str = "") -> str:
    return value.strip() if isinstance(value, str) else default


def parse_timeline(json_text: str) -> Timeline:
    """Parse the widget's JSON text into a validated Timeline model.

    Raises ValueError with a human-readable message on structurally invalid
    input.  Unknown fields are ignored so the widget can grow without breaking
    older serialized workflows.
    """
    if json_text is None:
        json_text = ""
    try:
        data = json.loads(json_text) if json_text.strip() else {}
    except json.JSONDecodeError as exc:
        raise ValueError(f"Chaotic H3 Director: timeline_data is not valid JSON ({exc})") from exc
    if not isinstance(data, dict):
        raise ValueError("Chaotic H3 Director: timeline_data must be a JSON object")

    project_raw = data.get("project") or {}
    if not isinstance(project_raw, dict):
        project_raw = {}

    fmt = project_raw.get("format", "official")
    if fmt not in FORMATS:
        fmt = "official"

    official_raw = project_raw.get("official")
    if not isinstance(official_raw, dict):
        official_raw = {}
    narrative_raw = project_raw.get("narrative")
    if not isinstance(narrative_raw, dict):
        narrative_raw = {}

    project = ProjectSettings(
        format=fmt,
        lora_trigger=_as_str(project_raw.get("lora_trigger")),
        style_clarification=_as_str(project_raw.get("style_clarification")),
        official={
            key: _as_str(official_raw.get(key))
            for key in ("subject_definitions", "summary", "retention_analysis",
                        "style_line", "overall_soundscape", "non_diegetic_music")
        },
        narrative={
            key: _as_str(narrative_raw.get(key))
            for key in ("scene", "subjects", "lighting", "music")
        },
    )

    shots: List[Shot] = []
    shot_raw = data.get("shots")
    if isinstance(shot_raw, list):
        for index, entry in enumerate(shot_raw):
            if not isinstance(entry, dict):
                continue
            text = entry.get("text")
            if not isinstance(text, str) or not text.strip():
                continue  # empty shots are skipped (they carry no content)
            fmt_override = entry.get("format", "auto")
            if fmt_override not in ("auto", "official", "narrative"):
                fmt_override = "auto"
            shots.append(Shot(
                id=str(entry.get("id") or f"shot_{index}"),
                start=round(_as_float(entry.get("start")), 6),
                duration=max(0.1, _as_float(entry.get("duration"), 1.0)),
                text=text,
                format=fmt_override,
            ))

    refs: List[Ref] = []
    ref_raw = data.get("refs")
    if isinstance(ref_raw, list):
        for index, entry in enumerate(ref_raw):
            if not isinstance(entry, dict):
                continue
            kind = entry.get("kind")
            if kind not in REF_KINDS:
                continue
            file_path = _as_str(entry.get("file"))
            if not file_path:
                continue
            refs.append(Ref(
                id=str(entry.get("id") or f"ref_{index}"),
                kind=kind,
                file=file_path,
                start=round(_as_float(entry.get("start")), 6),
                duration=max(0.1, _as_float(entry.get("duration"), 1.0)),
                name=_as_str(entry.get("name")),
                trim_start=_as_float(entry.get("trim_start")),
                trim_end=entry.get("trim_end"),
                strength=min(1.0, max(0.0, _as_float(entry.get("strength"), 1.0))),
                role=entry.get("role") if entry.get("role") in ROLES else "reference",
                annotation=_as_str(entry.get("annotation")),
                tag_type=entry.get("tag_type") if entry.get("tag_type") in ("picture", "subject") else "picture",
                use_soundtrack=bool(entry.get("use_soundtrack", False)),
                _index=index,
            ))

    boundaries_raw = data.get("boundaries")
    boundaries: List[float] = []
    if isinstance(boundaries_raw, list):
        for value in boundaries_raw:
            try:
                t = float(value)
            except (TypeError, ValueError):
                continue
            if t > 0.0 and t not in boundaries:
                boundaries.append(t)
    boundaries.sort()

    fps = int(_as_float(data.get("fps"), 24) or 24)
    fps = max(1, min(120, fps))

    return Timeline(fps=fps, project=project, shots=shots, refs=refs,
                    pinned_boundaries=boundaries)


# --------------------------------------------------------------------------- #
# Global tag assignment (mirrored by the JS widget for display + validation)
# --------------------------------------------------------------------------- #


def _ordered_images(refs: List[Ref]) -> List[Ref]:
    return sorted(
        (ref for ref in refs if ref.kind in ("picture", "subject")),
        key=lambda r: (r.start, r._index),
    )


def _ordered_videos(refs: List[Ref]) -> List[Ref]:
    return sorted(
        (ref for ref in refs if ref.kind == "video"),
        key=lambda r: (r.start, r._index),
    )


def _ordered_audios(refs: List[Ref]) -> List[Ref]:
    return sorted(
        (ref for ref in refs if ref.kind == "audio"),
        key=lambda r: (r.start, r._index),
    )


def assign_global_tags(timeline: Timeline) -> Dict[str, str]:
    """Return {ref_id: "<Picture N>" | "<Video N>" | "<Audio N>"} for every ref.

    Picture and Subject refs share one image sequence (the H3 model sees them
    through the same <Picture i> channel; <Subject N> stays a text-level alias
    that the user ties to a picture in subject_definitions).
    """
    tags: Dict[str, str] = {}
    for index, ref in enumerate(_ordered_images(timeline.refs), start=1):
        tags[ref.id] = f"<Picture {index}>"
    for index, ref in enumerate(_ordered_videos(timeline.refs), start=1):
        tags[ref.id] = f"<Video {index}>"
    for index, ref in enumerate(_ordered_audios(timeline.refs), start=1):
        tags[ref.id] = f"<Audio {index}>"
    return tags


def subject_shorthands(timeline: Timeline) -> Dict[str, str]:
    """Return {ref_id: "S1"..} for subject refs (their order among subjects)."""
    subjects = sorted(
        (ref for ref in timeline.refs if ref.kind == "subject"),
        key=lambda r: (r.start, r._index),
    )
    return {ref.id: f"S{index}" for index, ref in enumerate(subjects, start=1)}


# --------------------------------------------------------------------------- #
# Defaults (used by the node INPUT_TYPES and the JS widget for a fresh node)
# --------------------------------------------------------------------------- #


def default_project_json() -> Dict[str, Any]:
    return {
        "format": "official",
        "lora_trigger": "",
        "style_clarification": "",
        "official": {
            "subject_definitions": "",
            "summary": "",
            "retention_analysis": "",
            "style_line": "",
            "overall_soundscape": "",
            "non_diegetic_music": "N/A",
        },
        "narrative": {"scene": "", "subjects": "", "lighting": "", "music": "N/A"},
    }


def default_timeline_dict() -> Dict[str, Any]:
    return {
        "version": TIMELINE_VERSION,
        "fps": 24,
        "project": default_project_json(),
        "shots": [
            {
                "id": "shot_1",
                "start": 0.0,
                "duration": 5.0,
                "text": (
                    "[Shot 1] Live-action, cinematic. A wide establishing shot "
                    "frames the scene; the camera slowly pushes in."
                ),
                "format": "auto",
            }
        ],
        "refs": [],
        "boundaries": [],
    }


def default_timeline_json() -> str:
    return json.dumps(default_timeline_dict(), ensure_ascii=False, indent=2)


def timeline_issues(timeline: Timeline) -> List[str]:
    """Human-readable problems with the timeline (validation surface for the UI).

    Mirrors the JS widget's live validation so the Python side can surface the
    same class of mistakes (unreferenced media, orphaned refs, empty shots)
    before a single frame is rendered.
    """
    issues: List[str] = []
    if not timeline.shots:
        issues.append("The timeline has no shots — add at least one block to the prompt track.")
        return issues

    ordered = sorted(timeline.shots, key=lambda s: s.start)
    for index, shot in enumerate(ordered):
        if not shot.text.strip():
            issues.append(f"Shot {index + 1} (at {shot.start:.2f}s) has empty prompt text.")
        if shot.duration <= 0.0:
            issues.append(f"Shot {index + 1} (at {shot.start:.2f}s) has zero duration.")
        if index > 0 and shot.start < ordered[index - 1].end - 1e-6:
            issues.append(
                f"Shot {index + 1} overlaps the previous shot (starts at {shot.start:.2f}s)."
            )

    for ref in timeline.refs:
        if not any(shot.overlaps(ref.start, ref.end) for shot in timeline.shots):
            issues.append(
                f"Reference {ref.name or ref.file} is active but no shot covers its range — "
                "it will never reach the prompt and any typed tag for it would be a dangling reference."
            )

    tags = assign_global_tags(timeline)
    for ref in timeline.refs:
        if ref.kind == "video" and ref.role == "source" and ref.strength < 1.0:
            issues.append(
                f"Source clip {ref.name or ref.file} has strength {ref.strength:.2f} — "
                "editing a clip below full preservation may drift from the original."
            )
    return issues
