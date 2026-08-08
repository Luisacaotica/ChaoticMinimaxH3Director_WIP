#!/usr/bin/env python3
"""Build workflows/ChaoticDirector_H3.json from a working single-pass H3 graph.

Takes the user's working MiniMax H3 workflow (the one attached to the spec —
MiniMax_H3_MYWFEXAMPLE.json — which drives the local pruned-nvfp4 + turbo +
sage-attention + sigma-shift + chunk-feedforward stack) and rewires it into a
single ChaoticH3Director node:

    model  : 127 UNETLoader -> 942/961 TurboLoRA -> 963 MultiLoRA -> 907 EasyCache
             -> 868 Spectrum -> 851/142 SageAttention -> 844 ScheduledSolAttn
             -> 852 PreviewOverride -> 856 UniBlockSwap -> 960 SigmaShift
             -> 846 ChunkFFN  ──►  Director.model
    clip   : 910 CLIPLoaderGGUF -> 850 UniBlockSwapTE ──► Director.clip
    vae    : 119 ──► Director.vae         audio_vae: 120 ──► Director.audio_vae
    sampler: 962 MiniMaxH3TurboSampler ──► Director.sampler
    sigmas : 886 BasicScheduler ──► Director.sigmas
    seed   : 837 PixaromaSeed ──► Director.seed
    res    : 115 ResolutionSelector ──► Director.width/height
    output : Director.images/audio ──► 130 CreateVideo ──► 92 SaveVideo

Discovery is dynamic (type- and link-driven, not hard-coded ids) so it works on
any single-pass ref2va workflow.  The prompt text, duration math, ref-image
loader, ref2va conditioning node, noise/guider/sampler chain, AV split/VAE
decode chain and the manual cache-clear nodes are removed — the Director owns
all of that now (chunked sequential render with unload/clear between chunks,
seam anchoring, stitching).

Requires a SINGLE-PASS workflow (exactly one *ReferenceToVideo node).  The
manual 3-chunk workflows (MinimaxLuisa_Chunked.json) are the exact thing this
pack automates and are not a valid source.

Usage:  python tools/build_workflow.py [path/to/single_pass_h3_workflow.json]
"""

from __future__ import annotations

import copy
import json
import os
import sys

PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(PACK_ROOT, "workflows", "ChaoticDirector_H3.json")

# Candidate sources, in priority order (the user's attached workflow first).
_CANDIDATES = [
    os.path.normpath(os.environ.get(
        "CHAOTIC_SOURCE_WORKFLOW",
        r"C:\Users\Pichau\Downloads\MiniMax_H3_MYWFEXAMPLE.json",
    )),
    os.path.normpath(os.path.join(PACK_ROOT, "..", "..", "..", "MinimaxLuisa.json")),
]

# Node types the Director replaces outright.
_SAMPLER_TYPES = {"SamplerCustomAdvanced"}
_GUIDER_TYPES = {"BasicGuider"}
_NOISE_TYPES = {"RandomNoise", "DisableNoise"}
_CACHE_CLEAR_TYPES = {"easy clearCacheAll", "easy cleanGpuUsed"}
_SWITCH_TYPES = {"ComfySwitchNode"}
_SEPARATOR_TYPES = {"LTXVSeparateAVLatent"}
_CONCAT_TYPES = {"LTXVConcatAVLatent"}
_DECODER_TYPES = {"VAEDecode", "VAEDecodeAudio"}
_SPLIT_TYPES = {"SplitSigmas"}

# Example scene: the user's S1-vs-S2 prompt as a 3-shot, 10.5s timeline that
# demonstrates automatic chunking at 5s chunks (4 chunks, seams auto-bridged).
EXAMPLE_TIMELINE = {
    "version": 1,
    "fps": 24,
    "project": {
        "format": "official",
        "lora_trigger": "",
        "style_clarification": "",
        "official": {
            "subject_definitions": (
                "<Subject 1> is a woman with curly red-orange hair and a "
                "red-and-blue caped super-suit, referred to as S1.\n"
                "<Subject 2> is the Hulk, a hulking green giant, referred to as S2."
            ),
            "summary": "[reference generation] S1 confronts S2 in a heated argument "
                       "that escalates into violence.",
            "retention_analysis": (
                "<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - "
                "S1's face, hair, and suit are retained exactly.\n"
                "<Subject 2> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - "
                "S2 keeps his hulking green physique and gravel voice."
            ),
            "style_line": "Gritty, high-budget superhero-drama style, harsh practical "
                          "feeling lighting, handheld energy, hard cuts.",
            "overall_soundscape": (
                "A sharp wet tearing sound cuts through the tension, followed by a "
                "heavy impact and body collapse, then falling debris settling into "
                "near silence."
            ),
            "non_diegetic_music": (
                "A single harsh orchestral stinger hits at the moment of impact, "
                "then cuts to near silence."
            ),
        },
        "narrative": {"scene": "", "subjects": "", "lighting": "", "music": "N/A"},
    },
    "shots": [
        {
            "id": "shot_1",
            "start": 0.0,
            "duration": 3.5,
            "text": (
                "[Shot 1] A tight two-shot frames S1 and S2 nose-to-nose in a "
                "cracked concrete lot at dusk. S1's face is contorted with rage, "
                "jaw clenched, fists trembling at her sides. S2 sneers, grey lips "
                "peeling back, green eyes flaring, goading her."
            ),
            "format": "auto",
        },
        {
            "id": "shot_2",
            "start": 3.5,
            "duration": 3.5,
            "text": (
                "[Shot 2] The shot cuts to a wide static angle as S1 lunges "
                "forward, driving both hands into the center of S2's chest and "
                "ripping outward in one violent motion."
            ),
            "format": "auto",
        },
        {
            "id": "shot_3",
            "start": 7.0,
            "duration": 3.5,
            "text": (
                "[Shot 3] The shot cuts to S2 falling to the ground with a heavy "
                "thud and strong camera shake, blood splattering toward the camera."
            ),
            "format": "auto",
        },
    ],
    "refs": [],
    "boundaries": [],
}

DIRECTOR_ID = 990


def _find_source() -> str:
    for candidate in _CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return _CANDIDATES[0]


def _inputs(node) -> dict:
    return {inp["name"]: inp for inp in node.get("inputs") or []}


def _outputs(node) -> dict:
    return {out["name"]: out for out in node.get("outputs") or []}


def _link_source(links_by_id, node_input, nodes):
    """Return (src_node_dict, src_output_index) for a node input with a link."""
    lid = node_input.get("link")
    if lid is None:
        return None, None
    link = links_by_id.get(lid)
    if link is None:
        return None, None
    src = nodes.get(link[1])
    return (src, link[2]) if src is not None else (None, None)


def main(source_path: str | None) -> int:
    source_path = source_path or _find_source()
    if not os.path.exists(source_path):
        print(f"Source workflow not found: {source_path}")
        print("Pass the path to your single-pass H3 workflow as an argument.")
        return 1

    with open(source_path, "r", encoding="utf-8") as handle:
        wf = json.load(handle)

    nodes = {n["id"]: n for n in wf["nodes"]}
    links_by_id = {l[0]: l for l in (wf.get("links") or [])}

    # ------------------------------------------------------------------ #
    # 1. Locate the render chain by structure (not hard-coded ids).      #
    # ------------------------------------------------------------------ #
    ref2va_nodes = [n for n in wf["nodes"] if n["type"].endswith("ReferenceToVideo")]
    if len(ref2va_nodes) != 1:
        print(
            f"Found {len(ref2va_nodes)} *ReferenceToVideo nodes — the source must be a "
            "single-pass workflow (the Director replaces manual chunking; feeding it a "
            "pre-chunked workflow like MinimaxLuisa_Chunked.json is not supported)."
        )
        return 1
    ref2va = ref2va_nodes[0]

    separators = [n for n in wf["nodes"] if n["type"] in _SEPARATOR_TYPES]
    if not separators:
        print("No LTXVSeparateAVLatent found — cannot locate the decode path.")
        return 1

    # The AV separator whose outputs lead to the video+audio decoders.
    separator = separators[0]
    for sep in separators:
        decs = [
            n for n in wf["nodes"]
            if n["type"] in _DECODER_TYPES and any(
                _link_source(links_by_id, i, nodes)[0] is sep for i in (n.get("inputs") or [])
            )
        ]
        if decs:
            separator = sep
            break

    sam_in = _inputs(separator).get("av_latent")
    final_sampler, _ = _link_source(links_by_id, sam_in, nodes)
    if final_sampler is None or final_sampler["type"] not in _SAMPLER_TYPES:
        print("Could not resolve the final SamplerCustomAdvanced from the AV separator.")
        return 1

    guider_id, _ = _link_source(links_by_id, _inputs(final_sampler).get("guider"), nodes)
    if guider_id is None or guider_id["type"] not in _GUIDER_TYPES:
        print("Could not resolve the BasicGuider feeding the final sampler.")
        return 1

    # ---- sources for every Director input ----------------------------- #
    def source_of(node, name):
        src, idx = _link_source(links_by_id, _inputs(node).get(name), nodes)
        return (src, idx) if src is not None else (None, None)

    chain_end, chain_idx = source_of(guider_id, "model")
    clip_src, _ = source_of(ref2va, "clip")
    vae_src, _ = source_of(ref2va, "vae")
    audio_vae_src, _ = source_of(ref2va, "audio_vae")
    width_src, width_idx = source_of(ref2va, "width")
    height_src, height_idx = source_of(ref2va, "height")
    sampler_src, sampler_idx = source_of(final_sampler, "sampler")
    sigmas_src, sigmas_idx = source_of(final_sampler, "sigmas")
    noise_src, _ = source_of(final_sampler, "noise")
    seed_src = None
    if noise_src is not None and noise_src["type"] in _NOISE_TYPES:
        seed_src, _ = _link_source(links_by_id, _inputs(noise_src).get("noise_seed"), nodes)

    missing = [
        name for name, src in [
            ("model", chain_end), ("clip", clip_src), ("vae", vae_src),
            ("audio_vae", audio_vae_src), ("width", width_src), ("height", height_src),
            ("sampler", sampler_src), ("sigmas", sigmas_src),
        ] if src is None
    ]
    if missing:
        print(f"Could not resolve required sources: {missing}")
        return 1

    print(f"Discovered: ref2va={ref2va['id']} sampler={final_sampler['id']} "
          f"guider={guider_id['id']} chain_end={chain_end['id']} seed={seed_src and seed_src['id']}")

    # ------------------------------------------------------------------ #
    # 2. Compute the removal set (everything the Director replaces).     #
    # ------------------------------------------------------------------ #
    remove_ids = {
        final_sampler["id"], guider_id["id"], ref2va["id"],
        separator["id"],
    }
    if noise_src is not None:
        remove_ids.add(noise_src["id"])
    if seed_src is not None and seed_src["type"] in _NOISE_TYPES:
        remove_ids.add(seed_src["id"])

    # Decoders fed by the separator + their cache-clear chains.
    for node in wf["nodes"]:
        if node["type"] in _DECODER_TYPES and any(
            _link_source(links_by_id, i, nodes)[0] is separator for i in (node.get("inputs") or [])
        ):
            remove_ids.add(node["id"])
            # follow any cache-clear chain
            frontier = [node]
            while frontier:
                cur = frontier.pop()
                for out in cur.get("outputs") or []:
                    for lid in out.get("links") or []:
                        link = links_by_id.get(lid)
                        if not link:
                            continue
                        dst = nodes.get(link[3])
                        if dst and dst["type"] in _CACHE_CLEAR_TYPES:
                            remove_ids.add(dst["id"])
                            frontier.append(dst)

    # All cache-clear nodes anywhere (they were only for the manual chunk loop).
    remove_ids.update(n["id"] for n in wf["nodes"] if n["type"] in _CACHE_CLEAR_TYPES)

    # Prompt + duration-math feeding the ref2va node.
    for feed_name in ("prompt", "length"):
        feed, _ = source_of(ref2va, feed_name)
        if feed is not None:
            remove_ids.add(feed["id"])
            for inp in feed.get("inputs") or []:
                src, _ = _link_source(links_by_id, inp, nodes)
                if src is not None and src["type"] in {
                    "PrimitiveFloat", "PrimitiveInt", "ComfyMathExpression",
                    "PrimitiveStringMultiline", "PrimitiveString",
                }:
                    remove_ids.add(src["id"])

    # Ref-image loader(s) feeding the ref2va node.
    for name in _inputs(ref2va):
        if name.startswith("ref_images"):
            feed, _ = source_of(ref2va, name)
            if feed is not None:
                remove_ids.add(feed["id"])

    # Orphaned concat / sigma-split nodes (leftover from removed chains).
    for node in wf["nodes"]:
        if node["type"] in (_CONCAT_TYPES | _SPLIT_TYPES | _SWITCH_TYPES):
            connected = any(
                (inp.get("link") is not None and inp["link"] in links_by_id)
                or (out.get("links") or []) for inp in (node.get("inputs") or [])
                for out in (node.get("outputs") or [])
            )
            # keep only if it still talks to a kept node (rare); drop otherwise
            alive = False
            for out in node.get("outputs") or []:
                for lid in out.get("links") or []:
                    link = links_by_id.get(lid)
                    if link and link[3] not in remove_ids:
                        alive = True
            if not alive:
                remove_ids.add(node["id"])

    # ------------------------------------------------------------------ #
    # 3. Keep nodes / links, drop everything else.                       #
    # ------------------------------------------------------------------ #
    kept = [copy.deepcopy(n) for n in wf["nodes"] if n["id"] not in remove_ids]
    kept_by_id = {n["id"]: n for n in kept}

    kept_links = []
    for link in wf.get("links") or []:
        lid, src_id, _, dst_id, _, _ = link
        if src_id in remove_ids or dst_id in remove_ids:
            continue
        if src_id not in kept_by_id or dst_id not in kept_by_id:
            continue
        kept_links.append(list(link))
    kept_link_ids = {l[0] for l in kept_links}

    # Strip stale link references from the kept node defs (links whose other
    # end was removed) so the output only refers to links that still exist.
    for node in kept:
        for inp in node.get("inputs") or []:
            if inp.get("link") not in kept_link_ids:
                inp["link"] = None
        for out in node.get("outputs") or []:
            out["links"] = [lid for lid in (out.get("links") or []) if lid in kept_link_ids]

    # ------------------------------------------------------------------ #
    # 4. Add the Director node.                                          #
    # ------------------------------------------------------------------ #
    timeline_json = json.dumps(EXAMPLE_TIMELINE, ensure_ascii=False, indent=1)

    def input_entry(name, ntype, widget_name=None, link=None):
        entry = {"name": name, "type": ntype, "link": link}
        if widget_name is not None:
            entry["widget"] = {"name": widget_name}
        return entry

    director_inputs = [
        input_entry("model", "MODEL"),
        input_entry("clip", "CLIP"),
        input_entry("vae", "VAE"),
        input_entry("audio_vae", "VAE"),
        input_entry("seed", "INT", "seed"),
        input_entry("steps", "INT", "steps"),
        input_entry("cfg", "FLOAT", "cfg"),
        input_entry("sampler_name", "STRING", "sampler_name"),
        input_entry("scheduler", "STRING", "scheduler"),
        input_entry("width", "INT", "width"),
        input_entry("height", "INT", "height"),
        input_entry("fps", "INT", "fps"),
        input_entry("chunk_mode", "COMBO", "chunk_mode"),
        input_entry("chunk_seconds", "FLOAT", "chunk_seconds"),
        input_entry("continuity", "COMBO", "continuity"),
        input_entry("video_context", "BOOLEAN", "video_context"),
        input_entry("ref_image_size", "COMBO", "ref_image_size"),
        input_entry("timeline_data", "STRING", "timeline_data"),
        input_entry("sampler", "SAMPLER"),
        input_entry("sigmas", "SIGMAS"),
    ]
    director_outputs = [
        {"name": "images", "type": "IMAGE", "links": []},
        {"name": "audio", "type": "AUDIO", "links": []},
        {"name": "chunk_prompts_json", "type": "STRING", "links": []},
        {"name": "total_frames", "type": "INT", "links": []},
        {"name": "chunk_count", "type": "INT", "links": []},
    ]
    director = {
        "id": DIRECTOR_ID,
        "type": "ChaoticH3Director",
        "pos": [420, 3900],
        "size": [860, 640],
        "flags": {},
        "order": 60,
        "mode": 0,
        "inputs": director_inputs,
        "outputs": director_outputs,
        "title": "Chaotic H3 Director (Timeline)",
        "properties": {"Node name for S&R": "ChaoticH3Director"},
        "widgets_values": [
            67, 8, 1.0, "exp_heun_2_x0_sde", "sgm_uniform",
            1344, 768, 24, "fixed", 5.0, "keyframe+picture", False,
            "match", timeline_json,
        ],
        "color": "#4a3fcf",
        "bgcolor": "#2a283e",
    }
    kept.append(director)
    kept_by_id[DIRECTOR_ID] = director

    # ------------------------------------------------------------------ #
    # 5. Wire the Director in.                                           #
    # ------------------------------------------------------------------ #
    next_link = (max(kept_link_ids) + 1) if kept_link_ids else 3000
    new_links = []

    def connect(src_id, src_out_idx, dst_id, dst_in_idx, ltype):
        nonlocal next_link
        lid = next_link
        next_link += 1
        src_node, dst_node = kept_by_id[src_id], kept_by_id[dst_id]
        src_node["outputs"][src_out_idx]["links"] = (
            src_node["outputs"][src_out_idx].get("links") or []
        ) + [lid]
        dst_node["inputs"][dst_in_idx]["link"] = lid
        new_links.append([lid, src_id, src_out_idx, dst_id, dst_in_idx, ltype])

    def out_index(node, idx):
        return idx if idx is not None else 0

    connect(chain_end["id"], out_index(chain_end, chain_idx), DIRECTOR_ID, 0, "MODEL")
    connect(clip_src["id"], 0, DIRECTOR_ID, 1, "CLIP")
    connect(vae_src["id"], 0, DIRECTOR_ID, 2, "VAE")
    connect(audio_vae_src["id"], 0, DIRECTOR_ID, 3, "VAE")
    connect(seed_src["id"], 0, DIRECTOR_ID, 4, "INT")
    connect(width_src["id"], width_idx, DIRECTOR_ID, 9, "INT")
    connect(height_src["id"], height_idx, DIRECTOR_ID, 10, "INT")
    connect(sampler_src["id"], sampler_idx, DIRECTOR_ID, 18, "SAMPLER")
    connect(sigmas_src["id"], sigmas_idx, DIRECTOR_ID, 19, "SIGMAS")

    # Director outputs -> CreateVideo (find or create), -> SaveVideo (find or create).
    create_video = next((n for n in kept if n["type"] == "CreateVideo"), None)
    if create_video is None:
        create_video = {
            "id": max(kept_by_id) + 1,
            "type": "CreateVideo",
            "pos": [700, 4400],
            "size": [270, 110],
            "flags": {},
            "order": 61,
            "mode": 0,
            "inputs": [
                {"name": "images", "type": "IMAGE", "link": None},
                {"name": "audio", "type": "AUDIO", "link": None},
            ],
            "outputs": [{"name": "VIDEO", "type": "VIDEO", "links": []}],
            "widgets_values": [24, 8],
        }
        kept.append(create_video)
        kept_by_id[create_video["id"]] = create_video

    cv_ins = {i["name"]: i for i in create_video["inputs"]}
    connect(DIRECTOR_ID, 0, create_video["id"], cv_ins["images"] and create_video["inputs"].index(cv_ins["images"]), "IMAGE")
    connect(DIRECTOR_ID, 1, create_video["id"], create_video["inputs"].index(cv_ins["audio"]), "AUDIO")

    save_video = next((n for n in kept if n["type"] == "SaveVideo"), None)
    if save_video is None:
        save_video = {
            "id": max(kept_by_id) + 1,
            "type": "SaveVideo",
            "pos": [1040, 4400],
            "size": [280, 100],
            "flags": {},
            "order": 62,
            "mode": 0,
            "inputs": [{"name": "video", "type": "VIDEO", "link": None}],
            "outputs": [{"name": "video", "type": "VIDEO", "links": []}],
            "widgets_values": ["chaotic_director", "mp4", "h264", "auto", "16"],
        }
        kept.append(save_video)
        kept_by_id[save_video["id"]] = save_video

    sv_ins = {i["name"]: i for i in save_video["inputs"]}
    # Keep the original CreateVideo -> SaveVideo link if present, else add one.
    existing_sv_link = None
    for out in create_video["outputs"]:
        for lid in out.get("links") or []:
            if lid in kept_link_ids:
                link = next(l for l in kept_links if l[0] == lid)
                if link[3] == save_video["id"]:
                    existing_sv_link = link
    if existing_sv_link is None:
        connect(create_video["id"], 0, save_video["id"], save_video["inputs"].index(sv_ins["video"]), "VIDEO")

    all_links = kept_links + new_links

    # ------------------------------------------------------------------ #
    # 6. api_prompt (for S&R / API use).                                 #
    # ------------------------------------------------------------------ #
    api = {}
    for node in kept:
        nid = node["id"]
        inputs = {}
        for inp in node.get("inputs") or []:
            name = inp["name"]
            if inp.get("link") is not None:
                link = next((l for l in all_links if l[0] == inp["link"]), None)
                if link is not None:
                    inputs[name] = [link[1], link[2]]
            else:
                widget = inp.get("widget") or {}
                wname = widget.get("name", name)
                if node is director and wname in director_api_values():
                    inputs[wname] = director_api_values()[wname]
        if node is director:
            inputs.update(director_api_values())
        entry = {"inputs": inputs, "class_type": node["type"]}
        title = node.get("title")
        if title and title != node["type"]:
            entry["_meta"] = {"title": title}
        api[str(nid)] = entry

    out = {
        "id": wf.get("id", "chaotic-director-h3"),
        "revision": 0,
        "last_node_id": max(kept_by_id),
        "last_link_id": max(l[0] for l in all_links),
        "nodes": kept,
        "links": all_links,
        "groups": wf.get("groups", []),
        "config": wf.get("config", {}),
        "extra": wf.get("extra", {}),
        "version": wf.get("version", 0.4),
        "api_prompt": api,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=2)
    print(f"Wrote {OUT_PATH}")
    print(f"  kept {len(kept)} nodes ({len(wf['nodes']) - len(kept)} removed), "
          f"{len(all_links)} links, {len(api)} api entries")
    return 0


def director_api_values() -> dict:
    return {
        "steps": 8,
        "cfg": 1.0,
        "sampler_name": "exp_heun_2_x0_sde",
        "scheduler": "sgm_uniform",
        "fps": 24,
        "chunk_mode": "fixed",
        "chunk_seconds": 5.0,
        "continuity": "keyframe+picture",
        "video_context": False,
        "ref_image_size": "match",
        "timeline_data": json.dumps(EXAMPLE_TIMELINE, ensure_ascii=False, indent=1),
    }


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
