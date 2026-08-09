"""Shared crops bundle — the bridge that moves ⧉ Copy-to-ref crops *between* nodes.

The Video Edit widget uploads every crop to ComfyUI's input folder and exports a
small JSON manifest (``input/chaotic_h3_crops.json``) through the
``/chaotic_h3/crops`` API.  The Chaotic H3 Director and the Mockup Editor fetch
that manifest and add each entry as a `<Picture N>` library card (draggable into
any prompt or onto the timeline) / a stage layer — without re-uploading, because
the crops already live in the shared input folder.

This module is deliberately dependency-light (no torch) so the pack's unit tests
can exercise it without a ComfyUI runtime.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

BUNDLE_FILENAME = "chaotic_h3_crops.json"


def _input_dir(directory: Optional[str]) -> str:
    """Resolve where the bundle lives — the ComfyUI input dir by default."""
    if directory:
        return directory
    try:
        import folder_paths  # noqa: PLC0415 — ComfyUI runtime

        return folder_paths.get_input_directory()
    except Exception:  # noqa: BLE001 — outside ComfyUI, fall back to ./input
        return "input"


def save_crops_bundle(
    crops: Optional[List[Dict[str, Any]]],
    directory: Optional[str] = None,
) -> Dict[str, Any]:
    """Persist a crops manifest into the input dir (last export wins).

    Only dict entries are kept — a corrupt entry must never poison the bundle.
    """
    clean = [c for c in (crops or []) if isinstance(c, dict)]
    payload = {"version": 1, "crops": clean}
    path = os.path.join(_input_dir(directory), BUNDLE_FILENAME)
    tmp_path = path + ".tmp"
    try:
        # write-then-rename: an import (GET) racing an export never sees a
        # half-written file — it either reads the old bundle or the new one
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp_path, path)
        return {"status": "ok", "count": len(clean), "path": BUNDLE_FILENAME}
    except Exception as e:  # noqa: BLE001
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:  # noqa: BLE001 — cleanup best-effort
            pass
        return {"status": "error", "message": str(e)}


def load_crops_bundle(directory: Optional[str] = None) -> Dict[str, Any]:
    """Read the crops manifest; a missing or corrupt file yields no crops."""
    path = os.path.join(_input_dir(directory), BUNDLE_FILENAME)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:  # noqa: BLE001
        return {"crops": []}
    crops = data.get("crops") if isinstance(data, dict) else None
    if not isinstance(crops, list):
        return {"crops": []}
    return {"crops": [c for c in crops if isinstance(c, dict)]}
