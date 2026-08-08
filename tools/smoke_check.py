#!/usr/bin/env python3
"""Import smoke check for the Chaotic MinimaxH3 Director pack.

Runs under the ComfyUI python (python_embeded) to prove the pack imports cleanly
against the real installed ComfyUI, registers both nodes, resolves the stock H3
helpers, and that the built workflow passes structural validation.

Usage:
    cd <ComfyUI>
    ../python_embeded/python.exe custom_nodes/ChaoticMinimaxH3Director/tools/smoke_check.py
"""

from __future__ import annotations

import json
import os
import sys
import time

PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(PACK_ROOT))  # custom_nodes on sys.path


def main() -> int:
    failures: list[str] = []

    t0 = time.time()
    import ChaoticMinimaxH3Director.nodes as nodes_mod  # noqa: PLC0415
    print(f"nodes import OK in {time.time() - t0:.1f}s -> {list(nodes_mod.NODE_CLASS_MAPPINGS)}")
    if "ChaoticH3Director" not in nodes_mod.NODE_CLASS_MAPPINGS:
        failures.append("ChaoticH3Director not registered")

    import ChaoticMinimaxH3Director.engine as engine  # noqa: PLC0415
    helpers = engine._import_h3_helpers()
    print("h3 helpers OK ->", [getattr(x, "__name__", str(x)) for x in helpers[:4]])

    req = nodes_mod.ChaoticDirector.INPUT_TYPES()
    required = list(req["required"])
    optional = list(req["optional"])
    print("required:", required)
    print("optional:", optional)
    if "timeline_data" not in required or "sigmas" not in optional:
        failures.append("Director INPUT_TYPES shape wrong")

    from ChaoticMinimaxH3Director.timeline import parse_timeline  # noqa: PLC0415
    tl = parse_timeline(nodes_mod.ChaoticDirector.INPUT_TYPES()["required"]["timeline_data"][1]["default"])
    print(f"default timeline parses OK: {len(tl.shots)} shots, {len(tl.refs)} refs")

    wf_path = os.path.join(PACK_ROOT, "workflows", "ChaoticDirector_H3.json")
    if os.path.exists(wf_path):
        import subprocess  # noqa: PLC0415

        result = subprocess.run(
            [sys.executable, os.path.join(PACK_ROOT, "tools", "verify_workflow.py"), wf_path],
            capture_output=True, text=True,
        )
        print(result.stdout.strip())
        if result.returncode != 0:
            failures.append("workflow verification failed")

    if failures:
        print("SMOKE CHECK FAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print("SMOKE CHECK OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
