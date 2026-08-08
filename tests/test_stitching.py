"""Tests for chunk stitching (stitching.py) — requires torch."""

import pytest

pytest.importorskip("torch")

import torch  # noqa: E402

from ChaoticMinimaxH3Director.stitching import stitch_chunks  # noqa: E402


def _chunk(frames, samples=1000, sr=32000):
    return {
        "frames": torch.rand(frames, 64, 96, 3),
        "audio": {"waveform": torch.rand(1, 2, samples), "sample_rate": sr},
    }


def test_seam_duplicate_frame_dropped():
    a = _chunk(3, samples=3200)   # 0.1s @32k
    b = _chunk(3, samples=3200)
    out = stitch_chunks([a, b], fps=24, drop_seam_frame=True)
    assert out["frames"].shape[0] == 5          # 3 + 3 - 1 seam dup
    assert out["dropped_seam_frames"] == 1
    # one frame of audio (1/24s @32k = 1333 samples) dropped from chunk b's head
    assert out["audio"]["waveform"].shape[-1] == 3200 + (3200 - 1333)


def test_no_drop_when_disabled():
    a = _chunk(3)
    b = _chunk(3)
    out = stitch_chunks([a, b], fps=24, drop_seam_frame=False)
    assert out["frames"].shape[0] == 6
    assert out["dropped_seam_frames"] == 0


def test_single_chunk_passthrough():
    a = _chunk(5)
    out = stitch_chunks([a], fps=24, drop_seam_frame=True)
    assert out["frames"].shape[0] == 5


def test_audio_sample_rate_unification():
    a = _chunk(2, samples=3200, sr=32000)
    b = _chunk(2, samples=1600, sr=16000)
    out = stitch_chunks([a, b], fps=24, drop_seam_frame=False)
    assert out["audio"]["sample_rate"] == 32000
    assert out["audio"]["waveform"].shape[-1] == 3200 + 3200


def test_empty_input_raises():
    with pytest.raises(ValueError):
        stitch_chunks([], fps=24)
