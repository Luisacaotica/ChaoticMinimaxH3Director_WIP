"""Chaotic MinimaxH3 Director — timeline-based MiniMax H3 orchestration.

A ComfyUI node pack that does for MiniMax H3 what LTX's "Director" does for
LTX-Video: a timeline editor driving a full multi-shot scene, silently chopped
into VRAM-safe chunks (with strict model unload + cache clears between each),
anchored frame-accurately at every seam, and stitched into one continuous
video+audio clip.

Nodes:
  * ChaoticH3Director           — the timeline editor + chunked renderer
  * ChaoticH3PromptAssembler    — pure prompt/plan preview (no GPU)

Category: Chaotic/H3 Director
"""

try:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:  # comfy not on path (unit tests / standalone import)
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
