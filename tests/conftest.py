import os
import shutil
import sys

# ComfyUI imports node packs by their folder name (custom_nodes on sys.path).
# Mirror that here so tests use the same canonical import.
_CUSTOM_NODES = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _CUSTOM_NODES)

# The import package name is fixed (ChaoticMinimaxH3Director) but the checkout
# folder may differ — the GitHub repo is `ChaoticMinimaxH3Director_WIP`, and
# CI checks it out under that name, so `import ChaoticMinimaxH3Director` would
# fail.  When the folder doesn't already match, alias it (symlink; copy on
# platforms without symlink privileges) so the canonical import always resolves.
_PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if os.path.basename(_PACK_ROOT) != "ChaoticMinimaxH3Director":
    _alias = os.path.join(_CUSTOM_NODES, "ChaoticMinimaxH3Director")
    if not os.path.exists(_alias):
        try:
            os.symlink(_PACK_ROOT, _alias)
        except OSError:
            try:
                shutil.copytree(
                    _PACK_ROOT,
                    _alias,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".git"),
                )
            except OSError:
                pass  # best-effort — a correct checkout needs no alias
