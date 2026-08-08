import os
import sys

# ComfyUI imports node packs by their folder name (custom_nodes on sys.path).
# Mirror that here so tests use the same canonical import.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
