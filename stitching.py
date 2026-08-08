"""Chaotic MinimaxH3 Director — chunk stitching (torch only).

When chunk N+1 is anchored with an I2VA-style keyframe, its decoded first
frame is the *same* picture as chunk N's last frame (the anchor, re-encoded
and decoded).  Merging naively would produce two near-identical frames in a
row at every seam.  This module drops that duplicate frame plus the matching
1/fps seconds of audio from the head of every anchored chunk, keeping audio
and video in sync across the whole clip.
"""

from __future__ import annotations

from typing import Dict, List, Optional

import torch


def stitch_chunks(
    chunk_results: List[Dict],
    fps: int = 24,
    drop_seam_frame: bool = True,
) -> Dict:
    """Merge rendered chunks into (frames, audio).

    Args:
        chunk_results: list of dicts with keys
            frames: torch.Tensor [F, H, W, 3] float32 in [0, 1]
            audio:  Optional[dict] {"waveform": [1, C, L], "sample_rate": int}
        fps: frames per second (for the seam audio trim).
        drop_seam_frame: when True, remove chunk[i>0]'s first frame and the
            matching head audio (must match the anchor mode of the renderer).
    """
    if not chunk_results:
        raise ValueError("Chaotic H3 Director: no chunk results to stitch.")

    all_frames: List[torch.Tensor] = []
    all_audio: List[Dict] = []
    dropped_frames = 0

    for index, result in enumerate(chunk_results):
        frames = result.get("frames")
        if frames is None or frames.shape[0] == 0:
            continue
        audio = result.get("audio")

        if index > 0 and drop_seam_frame and frames.shape[0] > 1:
            frames = frames[1:]
            dropped_frames += 1
            if audio is not None:
                sample_rate = int(audio.get("sample_rate") or 0)
                waveform = audio["waveform"]
                if sample_rate > 0 and waveform.shape[-1] > 0:
                    cut = max(1, int(round(sample_rate / max(1, fps))))
                    if waveform.shape[-1] > cut:
                        waveform = waveform[..., cut:]
                        audio = {"waveform": waveform, "sample_rate": sample_rate}

        if frames.shape[0] > 0:
            all_frames.append(frames)
        if audio is not None and audio["waveform"].shape[-1] > 0:
            all_audio.append(audio)

    if not all_frames:
        raise ValueError("Chaotic H3 Director: stitching produced zero frames.")

    merged_frames = torch.cat(all_frames, dim=0)

    merged_audio: Optional[Dict] = None
    if all_audio:
        target_sr = max(int(a["sample_rate"]) for a in all_audio if a.get("sample_rate"))
        waves: List[torch.Tensor] = []
        for audio in all_audio:
            waveform = audio["waveform"]
            sample_rate = int(audio.get("sample_rate") or target_sr)
            if sample_rate != target_sr:
                try:
                    import torchaudio

                    waveform = torchaudio.functional.resample(waveform, sample_rate, target_sr)
                except ImportError:
                    raise RuntimeError(
                        "Chaotic H3 Director: chunk audio sample rates differ and "
                        "torchaudio is unavailable for resampling."
                    )
            waves.append(waveform)
        merged_audio = {
            "waveform": torch.cat(waves, dim=-1),
            "sample_rate": target_sr,
        }

    return {
        "frames": merged_frames,
        "audio": merged_audio,
        "dropped_seam_frames": dropped_frames,
    }


def as_video_batch(frames: torch.Tensor) -> torch.Tensor:
    """Wrap flat frames [F, H, W, 3] into the stock VAEDecode convention [1, F, H, W, 3].

    The reference workflow feeds VAEDecode's 5D output straight into the video
    muxer; the Director must emit the same shape so classic and io-based video
    nodes (CreateVideo / SaveVideo / VHS) consume it unchanged.
    """
    if frames.ndim == 5:
        return frames
    if frames.ndim == 4:
        return frames[None, ...]
    raise ValueError(f"Chaotic H3 Director: cannot batch frames with shape {tuple(frames.shape)}")
