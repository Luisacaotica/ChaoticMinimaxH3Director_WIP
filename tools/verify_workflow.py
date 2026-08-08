#!/usr/bin/env python3
"""Strict structural validation of workflows/ChaoticDirector_H3.json.

Checks every link resolves, every input/output is consistent, the Director node
is fully wired, no stale sampling/decoding nodes remain, and the api_prompt
mirrors the graph.  Exit code 0 = valid.

Usage:  python tools/verify_workflow.py [path/to/ChaoticDirector_H3.json]
"""

from __future__ import annotations

import json
import os
import sys

PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT = os.path.join(PACK_ROOT, "workflows", "ChaoticDirector_H3.json")

# Node types that must NOT survive into the Director workflow.
FORBIDDEN_TYPES = {
    "SamplerCustomAdvanced", "BasicGuider", "RandomNoise", "DisableNoise",
    "LTXVSeparateAVLatent", "LTXVConcatAVLatent", "VAEDecode", "VAEDecodeAudio",
    "easy clearCacheAll", "easy cleanGpuUsed", "ComfySwitchNode",
    "DenoMiniMaxH3ReferenceToVideo", "MiniMaxH3ReferenceToVideo",
    "DenoMiniMaxH3ReferenceImageLoader", "SplitSigmas",
}

# ChaoticH3Director required/optional inputs, in INPUT_TYPES order.
DIRECTOR_REQUIRED = [
    "model", "clip", "vae", "audio_vae", "seed", "steps", "cfg", "sampler_name",
    "scheduler", "width", "height", "fps", "chunk_mode", "chunk_seconds",
    "continuity", "video_context", "ref_image_size", "timeline_data",
]
DIRECTOR_OPTIONAL = ["sampler", "sigmas"]
DIRECTOR_LINKED = {"model", "clip", "vae", "audio_vae", "seed", "width", "height"}

errors: list[str] = []
warnings: list[str] = []


def error(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def main(path: str) -> int:
    if not os.path.exists(path):
        print(f"Workflow not found: {path}")
        return 1
    with open(path, "r", encoding="utf-8") as handle:
        wf = json.load(handle)

    nodes = {n["id"]: n for n in wf["nodes"]}
    links = {l[0]: l for l in wf.get("links") or []}

    # 1. Every link must resolve to existing nodes with valid indices.
    for lid, link in links.items():
        _, src_id, src_out, dst_id, dst_in, ltype = link
        if src_id not in nodes:
            error(f"link {lid}: unknown source node {src_id}")
            continue
        if dst_id not in nodes:
            error(f"link {lid}: unknown destination node {dst_id}")
            continue
        src_node, dst_node = nodes[src_id], nodes[dst_id]
        outs = src_node.get("outputs") or []
        ins = dst_node.get("inputs") or []
        if src_out >= len(outs):
            error(f"link {lid}: source output index {src_out} out of range on {src_node['type']} ({src_id})")
        if dst_in >= len(ins):
            error(f"link {lid}: destination input index {dst_in} out of range on {dst_node['type']} ({dst_id})")
            continue
        if not any(out.get("type") == ltype for out in outs):
            warn(f"link {lid}: type {ltype} not found among {src_node['type']} outputs")
        if ins[dst_in].get("type") != ltype:
            error(
                f"link {lid}: {dst_node['type']}.{ins[dst_in]['name']} expects "
                f"{ins[dst_in].get('type')}, link carries {ltype}"
            )

    # 2. Node input links must exist and point at this node.
    for nid, node in nodes.items():
        for idx, inp in enumerate(node.get("inputs") or []):
            lid = inp.get("link")
            if lid is not None:
                if lid not in links:
                    error(f"{node['type']} ({nid}) input '{inp['name']}' references missing link {lid}")
                    continue
                link = links[lid]
                if link[3] != nid or link[4] != idx:
                    error(
                        f"{node['type']} ({nid}) input '{inp['name']}' link {lid} "
                        f"points at ({link[3]}, {link[4]}) not ({nid}, {idx})"
                    )

    # 3. Node output links must exist and point from this node.
    for nid, node in nodes.items():
        for oidx, out in enumerate(node.get("outputs") or []):
            for lid in out.get("links") or []:
                if lid not in links:
                    error(f"{node['type']} ({nid}) output {oidx} references missing link {lid}")
                    continue
                link = links[lid]
                if link[1] != nid or link[2] != oidx:
                    error(f"{node['type']} ({nid}) output {oidx} link {lid} originates at ({link[1]}, {link[2]})")

    # 4. No forbidden sampling/decoding nodes survive.
    for nid, node in nodes.items():
        if node["type"] in FORBIDDEN_TYPES:
            error(f"stale node survived: {node['type']} ({nid})")

    # 5. Director node specifics.
    directors = [n for n in wf["nodes"] if n["type"] == "ChaoticH3Director"]
    if len(directors) != 1:
        error(f"expected exactly 1 ChaoticH3Director, found {len(directors)}")
    else:
        director = directors[0]
        dins = director.get("inputs") or []
        dnames = [i["name"] for i in dins]
        for name in DIRECTOR_REQUIRED:
            if name not in dnames:
                error(f"Director missing required input '{name}'")
        for name in DIRECTOR_OPTIONAL:
            if name not in dnames:
                warn(f"Director missing optional input '{name}'")
        for name in DIRECTOR_LINKED:
            inp = next((i for i in dins if i["name"] == name), None)
            if inp is None or inp.get("link") is None:
                error(f"Director input '{name}' is not linked")
        douts = director.get("outputs") or []
        if len(douts) != 5:
            error(f"Director expects 5 outputs, found {len(douts)}")

        # Director feeds CreateVideo.
        for out in douts[:2]:
            for lid in out.get("links") or []:
                link = links.get(lid)
                if link is None:
                    continue
                dst = nodes.get(link[3])
                if dst is None or dst["type"] not in ("CreateVideo",):
                    error(f"Director output '{out['name']}' feeds {dst and dst['type']} instead of CreateVideo")

        # Director model input must be fed by the final patched model (not the raw loader).
        model_in = next((i for i in dins if i["name"] == "model"), None)
        if model_in and model_in.get("link") is not None:
            src_id = links[model_in["link"]][1]
            src = nodes.get(src_id)
            if src is not None and src["type"] in ("UNETLoader", "MiniMaxH3ReferenceToVideo"):
                error(f"Director.model fed directly by {src['type']} — the patch chain is bypassed")

    # 6. CreateVideo + SaveVideo exist and are linked.
    cv = [n for n in wf["nodes"] if n["type"] == "CreateVideo"]
    sv = [n for n in wf["nodes"] if n["type"] == "SaveVideo"]
    if not cv:
        error("no CreateVideo node")
    if not sv:
        error("no SaveVideo node")

    # 7. api_prompt consistency: every node has an entry, references resolve.
    api = wf.get("api_prompt") or {}
    for nid, node in nodes.items():
        entry = api.get(str(nid))
        if entry is None:
            error(f"api_prompt missing entry for node {nid} ({node['type']})")
            continue
        if entry.get("class_type") != node["type"]:
            error(f"api_prompt class_type mismatch for node {nid}: {entry.get('class_type')} vs {node['type']}")
        for name, value in (entry.get("inputs") or {}).items():
            if isinstance(value, list):
                if value[0] not in nodes:
                    error(f"api_prompt {node['type']} ({nid}).{name} references unknown node {value[0]}")

    # 8. Loader chain sanity: the model patch chain nodes still present.
    chain_types = [
        "MiniMaxH3TurboLoRA", "DenoMultiLoraLoader", "EasyCache",
        "SpectrumApplyMiniMaxH3", "PathchSageAttentionKJ", "MiniMaxH3ScheduledSolAttentionPatch",
        "MiniMaxH3PreviewOverride", "UniBlockSwap", "MiniMaxH3SigmaShift", "MiniMaxH3ChunkFeedForward",
    ]
    present = [t for t in chain_types if any(n["type"] == t for n in wf["nodes"])]
    if not present:
        warn("no model patch chain nodes found in the output")

    print(f"Verified {len(nodes)} nodes, {len(links)} links, {len(api)} api entries")
    for w in warnings:
        print(f"  WARN: {w}")
    for e in errors:
        print(f"  ERROR: {e}")
    if errors:
        print(f"FAILED with {len(errors)} errors")
        return 1
    print("OK — workflow is structurally valid")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT))
