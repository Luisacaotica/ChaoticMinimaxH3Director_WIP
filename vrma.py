"""Chaotic MinimaxH3 Director — VRAM management for 8GB-class GPUs.

The whole premise of the node pack is that a long H3 clip cannot render in one
pass on 8GB.  This module owns:

  * auto chunk-duration selection: probe free VRAM at run time and pick the
    largest chunk frame count that the *previous successful run this session*
    proved safe, falling back to a conservative default (~5s) on the first run,
  * the strict unload/clear cycle between chunks (model unload + ComfyUI cache
    clear + torch cache clear — the spec's "full unload/reload cycle"),
  * learning from real runs: peak VRAM per chunk render is recorded and used to
    re-estimate the per-frame cost for the next auto decision.
"""

from __future__ import annotations

import gc
from typing import Optional, Tuple

DEFAULT_SAFE_FRAMES = 124          # ~5.2s @24fps — conservative first-run default
MAX_FRAMES = 362                   # top of the trained 124-362 frame range
FLOOR_FRAMES = 39                  # smallest legal chunk (~1.6s @24fps)
SAFETY_RATIO = 0.55                # never budget more than 55% of free VRAM
MAX_GROWTH = 1.5                   # don't overreach beyond the last proven size


class VramSession:
    """Per-process session memory of what has actually fit this session."""

    def __init__(self) -> None:
        self.safe_frames: Optional[int] = None
        self.est_bytes_per_frame: Optional[float] = None
        self.peak_allocated: int = 0
        self.last_free: Optional[int] = None

    def reset(self) -> None:
        self.__init__()


_SESSION = VramSession()


def get_session() -> VramSession:
    return _SESSION


def reset_session() -> None:
    _SESSION.reset()


def probe_free_bytes() -> Tuple[Optional[int], Optional[int]]:
    """Return (free_bytes, total_bytes) or (None, None) when not on CUDA."""
    try:
        import torch

        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            return int(free), int(total)
    except Exception:
        pass
    return None, None


def choose_auto_frames(fps: int = 24) -> int:
    """Pick the largest chunk frame count we believe fits, from session memory.

    First run: conservative default (124 frames / ~5s).  After that, scale the
    proven per-frame cost against current free VRAM, capped by what has worked
    before (grown at most 1.5x) and by the model's trained range.
    """
    if _SESSION.safe_frames is None:
        _SESSION.safe_frames = DEFAULT_SAFE_FRAMES

    free, _ = probe_free_bytes()
    if free is None:
        return _SESSION.safe_frames

    frames = _SESSION.safe_frames
    if _SESSION.est_bytes_per_frame and _SESSION.est_bytes_per_frame > 0:
        budget = free * SAFETY_RATIO
        candidate = int(budget / _SESSION.est_bytes_per_frame)
        if candidate > 0:
            frames = min(
                candidate,
                int(_SESSION.safe_frames * MAX_GROWTH),
            )
    return max(FLOOR_FRAMES, min(MAX_FRAMES, frames))


def record_success(frames: int, peak_bytes: int, free_bytes: Optional[int] = None) -> None:
    """Learn from a completed chunk render."""
    _SESSION.safe_frames = max(FLOOR_FRAMES, frames)
    _SESSION.peak_allocated = int(peak_bytes)
    if frames > 0 and peak_bytes > 0:
        _SESSION.est_bytes_per_frame = peak_bytes / frames
    _SESSION.last_free = free_bytes


def record_failure(frames: int) -> None:
    """Shrink the safe size after an out-of-memory chunk."""
    _SESSION.safe_frames = max(FLOOR_FRAMES, int(frames * 2 // 3))


def shrink_frames(frames: int) -> int:
    """Shrink a chunk frame count to retry an OOM'd render."""
    return max(FLOOR_FRAMES, int(frames * 2 // 3))


# --------------------------------------------------------------------------- #
# Strict unload / clear cycle
# --------------------------------------------------------------------------- #


def unload_for_next_chunk() -> None:
    """Full unload/reload cycle between chunks.

    ComfyUI keeps its own model cache (model_management.current_loaded_models);
    a naive torch.cuda.empty_cache() alone does NOT evict resident weights, so
    we go through ComfyUI's own unload path first, then clear the torch cache.
    """
    try:
        import comfy.model_management as mm

        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception:
        pass
    try:
        import torch

        torch.cuda.empty_cache()
    except Exception:
        pass
    gc.collect()


def reset_peak_stats() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        pass


def peak_allocated_bytes() -> int:
    try:
        import torch

        if torch.cuda.is_available():
            return int(torch.cuda.max_memory_allocated())
    except Exception:
        pass
    return 0


def is_oom(exc: BaseException) -> bool:
    """Best-effort detection of CUDA out-of-memory errors."""
    message = str(exc).lower()
    if "out of memory" in message or "cuda out of memory" in message:
        return True
    try:
        import torch

        return isinstance(exc, torch.cuda.OutOfMemoryError)
    except Exception:
        return False
