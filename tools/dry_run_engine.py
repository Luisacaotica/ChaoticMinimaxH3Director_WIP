#!/usr/bin/env python3
"""Dry-run the Chaotic H3 Director render engine WITHOUT a GPU.

Exercises ChunkRenderer.render_chunk end-to-end against the REAL installed
comfy modules (comfy_extras.nodes_minimax_h3 helpers, node_helpers,
comfy.samplers, latent_preview, comfy.sample) with mocked model/clip/vae/
sampler objects.  This is the cheapest way to prove the risky assumptions the
engine makes actually hold on YOUR install:

  * the underscore-prefixed stock helpers import with the expected signatures
    (_empty_av_latent, _resize, adapt_canvas, CANVAS_MULTIPLE, ...),
  * the conditioning keys ("minimax_refs", "minimax_keyframes",
    "minimax_frame_count") are accepted and land on the conditioning,
  * the keyframe payload matches what comfy/model_base.py consumes
    (resolved_frame_index / image / latent),
  * comfy.samplers.sample is invoked with the same argument contract as the
    stock SamplerCustomAdvanced path,
  * the decode path produces the [F, H, W, 3] frames + {waveform, sample_rate}
    audio contract.

Run under ComfyUI's python so the comfy modules are real:
    cd <ComfyUI>
    ../python_embeded/python.exe custom_nodes/ChaoticMinimaxH3Director/tools/dry_run_engine.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from types import SimpleNamespace

PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(PACK_ROOT))  # custom_nodes on sys.path

import numpy as np  # noqa: PLC0415
import torch  # noqa: PLC0415

FAILURES: list[str] = []
CHECKS = 0


def check(condition: bool, label: str) -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok   {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL {label}")


# --------------------------------------------------------------------------- #
# Mock model / clip / vae / audio_vae / sampler
# --------------------------------------------------------------------------- #


class MockVideoVae:
    """Video VAE: decode -> [1, F, H, W, 3] (stock MiniMax H3 video VAE shape)."""

    def encode(self, image):
        return torch.zeros(1, 24, 4, 8, 8)

    def decode(self, latent):
        return torch.rand(1, 6, 64, 96, 3)


class MockAudioVae:
    """Audio VAE: decode -> [1, T, C] (stock MiniMax H3 audio VAE shape)."""

    def __init__(self, sample_rate: int = 32000):
        self.audio_sample_rate = sample_rate
        self.audio_sample_rate_output = sample_rate

    def encode(self, waveform):
        return torch.zeros(1, 32, 2, 8)

    def decode(self, latent):
        return torch.rand(1, 6, 2)  # [1, T, C]


def make_clip(captured):
    def tokenize(prompt, minimax_ref_items=None):
        captured["ref_items"] = minimax_ref_items
        return {"tokens": ["mock"]}

    def encode_from_tokens_scheduled(tokens):
        return [(torch.zeros(1, 4), {"pooled_output": torch.zeros(1, 768)})]

    return SimpleNamespace(tokenize=tokenize, encode_from_tokens_scheduled=encode_from_tokens_scheduled)


def run_case(name, plan, prompt, use_keyframe, anchor_image, with_picture_ref=False):
    print(f"\n=== case: {name} ===")
    captured: dict = {}
    cond_capture: dict = {}

    model = SimpleNamespace(model_options={}, load_device="cpu")
    clip = make_clip(captured)
    vae = MockVideoVae()
    audio_vae = MockAudioVae()
    sampler_obj = SimpleNamespace(sigmas=torch.linspace(14.6, 0.03, 9))

    import comfy.model_management as mm  # noqa: PLC0415
    import comfy.sample  # noqa: PLC0415
    import comfy.samplers  # noqa: PLC0415
    import latent_preview  # noqa: PLC0415
    import node_helpers  # noqa: PLC0415

    real_prepare_noise = comfy.sample.prepare_noise
    real_sample = comfy.samplers.sample
    real_prepare_callback = latent_preview.prepare_callback
    real_cond_set = node_helpers.conditioning_set_values

    sample_call: dict = {}

    def fake_prepare_noise(latent, seed):
        return torch.zeros(1, 56, 4, 8, 8)

    def fake_sample(model_, noise, positive, negative, cfg, device, sampler, sigmas,
                    model_options={}, latent_image=None, denoise_mask=None,
                    callback=None, disable_pbar=False, seed=None):
        sample_call.update(
            noise=noise, positive=positive, negative=negative, cfg=cfg,
            device=device, sampler=sampler, sigmas=sigmas, latent_image=latent_image,
            seed=seed,
        )
        return torch.zeros(2, 1, 24, 8, 8)  # [video, audio] first dim for unbind()

    try:
        comfy.sample.prepare_noise = fake_prepare_noise
        comfy.samplers.sample = fake_sample
        latent_preview.prepare_callback = lambda model_, steps, x0_output_dict=None: None

        from ChaoticMinimaxH3Director.engine import ChunkRenderer  # noqa: PLC0415

        renderer = ChunkRenderer(
            model, clip, vae, audio_vae,
            width=1344, height=768, fps=24,
            sampler_obj=sampler_obj, sampler_name="exp_heun_2_x0_sde",
            scheduler="sgm_uniform", steps=8, cfg=1.0,
            ref_image_size="match", sigmas=None,
        )

        # Optional picture reference entry.
        ref_entries = []
        if with_picture_ref:
            handle, tmp_img = tempfile.mkstemp(suffix=".png")
            os.close(handle)
            from PIL import Image  # noqa: PLC0415

            Image.new("RGB", (64, 64), (120, 40, 60)).save(tmp_img)
            ref = SimpleNamespace(
                file=tmp_img, name="ref", trim_start=0.0, trim_end=None,
                use_soundtrack=False, id="r1", start=0.0, duration=1.0,
                strength=1.0, role="reference", annotation="", tag_type="picture",
                _index=0,
            )
            ref_entries = [SimpleNamespace(
                is_anchor=False, kind="picture", ref=ref, tag="<Picture 1>",
                audio_tag=None,
            )]
        else:
            tmp_img = None

        plan = SimpleNamespace(frames=124, ref_entries=ref_entries, anchor_tag="<Picture 9>")
        result = renderer.render_chunk(
            plan, "[Shot 1] A dry-run shot.", 42, anchor_image, None,
            use_keyframe=use_keyframe,
        )

        # 1. helper contract: _empty_av_latent produced the expected frame count
        from ChaoticMinimaxH3Director.engine import _import_h3_helpers  # noqa: PLC0415

        _, _, _, _empty_av_latent, _, _ = _import_h3_helpers()
        latent, frame_count = _empty_av_latent(1344, 768, 124)
        check(frame_count > 0, f"_empty_av_latent(1344,768,124) -> {frame_count} frames")
        check("samples" in latent and hasattr(latent["samples"], "unbind"),
              "empty AV latent is a NestedTensor-style dict")

        # 2. conditioning keys landed
        check(sample_call.get("positive") is not None, "sample() called with positive conditioning")
        cond = sample_call["positive"][0] if sample_call.get("positive") else None
        if cond is not None:
            payload = cond[0][1]  # first conditioning entry is [tensor, dict]
            if use_keyframe:
                check("minimax_keyframes" in payload, "'minimax_keyframes' key set on conditioning")
                check("minimax_frame_count" in payload, "'minimax_frame_count' key set on conditioning")
                kfs = payload.get("minimax_keyframes") or []
                check(len(kfs) == 1 and kfs[0].get("resolved_frame_index") == 0,
                      "keyframe carries resolved_frame_index=0")
                check(kfs and "image" in kfs[0] and "latent" in kfs[0],
                      "keyframe carries image + latent (model_base consumer contract)")
            if with_picture_ref:
                refs = payload.get("minimax_refs") or []
                check(len(refs) == 1 and refs[0].get("kind") == "image",
                      "'minimax_refs' block present with kind=image")
                check(captured.get("ref_items") is not None and len(captured["ref_items"]) == 1,
                      "clip.tokenize received minimax_ref_items with the picture item")

        # 3. sample() contract matches the stock SamplerCustomAdvanced path
        check("sampler" in sample_call and sample_call["sampler"] is sampler_obj,
              "external sampler object forwarded to sample()")
        check("sigmas" in sample_call and sample_call["sigmas"].shape[0] == 9,
              "sigma schedule (9 steps) forwarded to sample()")
        check("seed" in sample_call and sample_call["seed"] == 42, "seed forwarded to sample()")
        check("latent_image" in sample_call, "latent_image forwarded to sample()")

        # 4. decode contract
        check(result["frames"].ndim == 4 and result["frames"].shape[1:] == (64, 96, 3),
              f"frames [F,H,W,3] shape {tuple(result['frames'].shape)}")
        check(result["audio"]["sample_rate"] == 32000, "audio sample_rate = 32000")
        check(result["audio"]["waveform"].ndim == 3, "audio waveform [1, C, L]")

        if tmp_img:
            os.remove(tmp_img)
    finally:
        comfy.sample.prepare_noise = real_prepare_noise
        comfy.samplers.sample = real_sample
        latent_preview.prepare_callback = real_prepare_callback


def main() -> int:
    anchor = torch.rand(1, 768, 1344, 3)
    run_case("keyframe anchor, no refs", SimpleNamespace(), "[Shot 1] dry run", True, anchor)
    run_case("picture reference, no keyframe", SimpleNamespace(), "[Shot 1] dry run", False, None,
             with_picture_ref=True)
    run_case("both: keyframe + picture ref", SimpleNamespace(), "[Shot 1] dry run", True, anchor,
             with_picture_ref=True)

    print(f"\n{CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("FAILED:")
        for f in FAILURES:
            print("  -", f)
        return 1
    print("DRY RUN OK — engine conditioning path matches the installed ComfyUI")
    return 0


if __name__ == "__main__":
    sys.exit(main())
