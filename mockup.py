"""Chaotic MinimaxH3 Director — Mockup Editor scene renderer (pure-ish).

Implements the "bad mockup blueprint" idea: a 2.5D puppet stage where the user
composes PNG/JPEG sprites, text, and video clips as layers, keyframes their
transform (position / scale / rotation / opacity) over time, and the node
renders that animation into a real frame sequence.  That sequence is then fed
to the Director as the `mockup` storyboard — MiniMax H3 interprets the
composition, positions, and motion as the authoritative staging and turns the
mockup into a finished clip.

Coordinate model (mirrored exactly by web/js/chaotic_puppet.js):

  * x, y        — layer center as a fraction of the stage (0..1); (0.5, 0.5)
                  is dead center.
  * fit         — how a sprite is initially sized to the stage: "contain"
                  letterboxes while preserving aspect (default).
  * scale       — multiplier on the fitted size (1.0 = fits the stage).
  * rotation    — degrees (clockwise when rendered top-down, i.e. PIL).
  * opacity     — 0..1; also the *visual* reference strength (a 40% character
                  literally shows the background through it, exactly like a
                  weak reference).
  * keyframes   — snapshots of {t, ease, x, y, scale, rotation, opacity}; the
                  layer is visible only inside [first.t, last.t].  `ease`
                  (linear | in | out | inout | hold) shapes the outgoing motion
                  toward the next key; hold steps (the pose holds until the
                  next key's time, then jumps).  A layer with no keyframes is
                  static and visible for the whole scene.

The renderer is deliberately free of ComfyUI imports (torch only, for the
output tensor) so the whole pipeline is unit-testable in a plain interpreter.
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Optional, Tuple

SCENE_VERSION = 1

LAYER_TYPES = ("image", "video", "text")
FITS = ("contain",)

# Keyframe easing modes.  `ease` on a key shapes the OUTGOING motion toward the
# next key: linear | in (ease-in) | out (ease-out) | inout (smoothstep) | hold
# (step — the key's pose holds until the next key's time, then jumps).
EASE_MODES = ("linear", "in", "out", "inout", "hold")
_TRANSFORM_PROPS = ("x", "y", "scale", "rotation", "opacity")


# --------------------------------------------------------------------------- #
# Scene model / parsing
# --------------------------------------------------------------------------- #


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_str(value: Any, default: str = "") -> str:
    return value.strip() if isinstance(value, str) else default


def default_scene_dict() -> Dict[str, Any]:
    return {
        "version": SCENE_VERSION,
        "aspect": "16:9",
        "bg": {"type": "color", "color": [16, 18, 22]},
        "layers": [],
        "audio": {"file": "", "trim_start": 0.0, "trim_end": None},
    }


def default_scene_json() -> str:
    return json.dumps(default_scene_dict(), ensure_ascii=False, indent=2)


def parse_scene(json_text: str) -> Dict[str, Any]:
    """Parse the widget's scene JSON into a validated dict (unknown fields kept)."""
    if json_text is None:
        json_text = ""
    try:
        data = json.loads(json_text) if json_text.strip() else {}
    except json.JSONDecodeError as exc:
        raise ValueError(f"Chaotic H3 Mockup Editor: scene_data is not valid JSON ({exc})") from exc
    if not isinstance(data, dict):
        raise ValueError("Chaotic H3 Mockup Editor: scene_data must be a JSON object")

    bg = data.get("bg") or {"type": "color", "color": [16, 18, 22]}
    if not isinstance(bg, dict):
        bg = {"type": "color", "color": [16, 18, 22]}

    layers: List[Dict[str, Any]] = []
    raw_layers = data.get("layers")
    if isinstance(raw_layers, list):
        for index, entry in enumerate(raw_layers):
            if not isinstance(entry, dict):
                continue
            ltype = entry.get("type")
            if ltype not in LAYER_TYPES:
                continue
            layer = {
                "id": str(entry.get("id") or f"layer_{index}"),
                "type": ltype,
                "name": _as_str(entry.get("name")),
                "file": _as_str(entry.get("file")),
                "fit": entry.get("fit") if entry.get("fit") in FITS else "contain",
                "x": _as_float(entry.get("x"), 0.5),
                "y": _as_float(entry.get("y"), 0.5),
                "scale": max(0.01, _as_float(entry.get("scale"), 1.0)),
                "rotation": _as_float(entry.get("rotation")),
                "opacity": min(1.0, max(0.0, _as_float(entry.get("opacity"), 1.0))),
                "text": _as_str(entry.get("text")),
                "color": _as_str(entry.get("color"), "#ffffff"),
                "font_size": max(0.01, _as_float(entry.get("font_size"), 0.06)),
                "trim_start": max(0.0, _as_float(entry.get("trim_start"))),
                "speed": min(4.0, max(0.05, _as_float(entry.get("speed"), 1.0))),
                "keys": [],
            }
            raw_keys = entry.get("keys")
            if isinstance(raw_keys, list):
                for raw_key in raw_keys:
                    if not isinstance(raw_key, dict):
                        continue
                    ease = raw_key.get("ease")
                    layer["keys"].append({
                        "t": max(0.0, _as_float(raw_key.get("t"))),
                        "ease": ease if ease in EASE_MODES else "linear",
                        "x": _as_float(raw_key.get("x"), layer["x"]),
                        "y": _as_float(raw_key.get("y"), layer["y"]),
                        "scale": max(0.01, _as_float(raw_key.get("scale"), layer["scale"])),
                        "rotation": _as_float(raw_key.get("rotation"), layer["rotation"]),
                        "opacity": min(1.0, max(0.0, _as_float(raw_key.get("opacity"), layer["opacity"]))),
                    })
                layer["keys"].sort(key=lambda k: k["t"])
            layers.append(layer)

    audio = data.get("audio") or {}
    if not isinstance(audio, dict):
        audio = {}

    return {
        "version": SCENE_VERSION,
        "aspect": _as_str(data.get("aspect"), "16:9"),
        "bg": bg,
        "layers": layers,
        "audio": {
            "file": _as_str(audio.get("file")),
            "trim_start": max(0.0, _as_float(audio.get("trim_start"))),
            "trim_end": audio.get("trim_end"),
        },
    }


# --------------------------------------------------------------------------- #
# Keyframe interpolation
# --------------------------------------------------------------------------- #


def _lerp(a: float, b: float, f: float) -> float:
    return a + (b - a) * f


def _ease_progress(f: float, mode: str) -> float:
    """Map linear progress f (0..1) through the easing curve (mirrors easeF in JS)."""
    if mode == "in":
        return f * f
    if mode == "out":
        return 1 - (1 - f) * (1 - f)
    if mode == "inout":
        return f * f * (3 - 2 * f)
    if mode == "hold":
        return 0.0
    return f


def props_at(layer: Dict[str, Any], t: float) -> Optional[Dict[str, float]]:
    """Interpolated transform at scene time t, or None when the layer is hidden.

    A layer without keyframes is a static, always-visible sprite.  A keyframed
    layer is visible only inside [first.t, last.t].

    Per-layer `speed` (0.05..4, default 1) is a time-warp: the layer's local
    clock runs at `speed` times the project timeline, so keys are authored in
    *layer* time and the whole animation plays in project window
    [first.t/speed, last.t/speed] (After-Effects style stretch).  Mirrors the
    JS `propsAt` in web/js/chaotic_puppet.js exactly.
    """
    t = t * float(layer.get("speed", 1.0))
    keys = layer["keys"]
    if not keys:
        return {
            "x": layer["x"], "y": layer["y"],
            "scale": layer["scale"], "rotation": layer["rotation"],
            "opacity": layer["opacity"],
        }
    if t < keys[0]["t"] - 1e-6 or t > keys[-1]["t"] + 1e-6:
        return None
    if len(keys) == 1 or t <= keys[0]["t"] + 1e-6:
        return {k: keys[0][k] for k in ("x", "y", "scale", "rotation", "opacity")}
    if t >= keys[-1]["t"] - 1e-6:
        return {k: keys[-1][k] for k in ("x", "y", "scale", "rotation", "opacity")}
    after = next(k for k in keys if k["t"] >= t - 1e-6)
    before = keys[keys.index(after) - 1]
    span = max(1e-6, after["t"] - before["t"])
    f = (t - before["t"]) / span
    mode = before.get("ease", "linear")
    if mode not in EASE_MODES:
        mode = "linear"
    if mode == "hold":
        # Step: the outgoing key's pose holds until the next key's time, then jumps.
        src = after if f >= 1 - 1e-9 else before
        return {p: src[p] for p in _TRANSFORM_PROPS}
    f2 = _ease_progress(f, mode)
    return {
        "x": _lerp(before["x"], after["x"], f2),
        "y": _lerp(before["y"], after["y"], f2),
        "scale": _lerp(before["scale"], after["scale"], f2),
        "rotation": _lerp(before["rotation"], after["rotation"], f2),
        "opacity": _lerp(before["opacity"], after["opacity"], f2),
    }


# --------------------------------------------------------------------------- #
# Sprite loading (PIL + av, lazily imported)
# --------------------------------------------------------------------------- #


class _VideoSource:
    """Decode-on-demand video frames, advancing only forward per render pass."""

    def __init__(self, path: str):
        import av  # noqa: PLC0415

        self._av = av
        self._container = av.open(path)
        stream = next((s for s in self._container.streams if s.type == "video"), None)
        if stream is None:
            raise ValueError(f"no video stream in {path}")
        self._stream = stream
        self._stream.thread_type = "AUTO"
        self._frames = self._container.decode(stream)
        self._cur_time = -1.0
        self._cur_frame = None
        self._done = False
        # Chroma-keyed / alpha-bearing clips (ProRes 4444, PNG-in-MOV, ...) carry
        # an alpha channel — decode it so transparency survives into the stage.
        try:
            fmt = stream.codec_context.format
            self._has_alpha = bool(fmt) and "a" in getattr(fmt, "name", "")
        except Exception:  # noqa: BLE001
            self._has_alpha = False

    def frame_at(self, media_sec: float):
        """Nearest decoded frame at or before media_sec (may be None)."""
        if self._done and self._cur_frame is None:
            return None
        while not self._done:
            frame = next(self._frames, None)
            if frame is None:
                self._done = True
                break
            t = frame.pts * float(frame.time_base) if frame.pts is not None else self._cur_time
            if self._cur_frame is None or t >= self._cur_time:
                if self._cur_frame is None or abs(t - media_sec) < abs(self._cur_time - media_sec):
                    self._cur_time = t
                    self._cur_frame = frame
            if t >= media_sec:
                break
        if self._cur_frame is None:
            return None
        return self._cur_frame.to_ndarray(format="rgba" if self._has_alpha else "rgb24")


class _SpriteCache:
    """Caches loaded sprites per render so images/containers open once."""

    def __init__(self):
        self._images: Dict[str, Any] = {}
        self._videos: Dict[str, _VideoSource] = {}

    def image(self, path: str):
        from PIL import Image  # noqa: PLC0415

        if path not in self._images:
            with Image.open(path) as source:
                self._images[path] = source.convert("RGBA").copy()
        return self._images[path]

    def video_frame(self, path: str, media_sec: float):
        if path not in self._videos:
            self._videos[path] = _VideoSource(path)
        arr = self._videos[path].frame_at(media_sec)
        if arr is None:
            return None
        from PIL import Image  # noqa: PLC0415

        return Image.fromarray(arr).convert("RGBA")


def _hex_color(value: str) -> Tuple[int, int, int]:
    from PIL import ImageColor  # noqa: PLC0415

    try:
        rgb = ImageColor.getrgb(value)
    except ValueError:
        rgb = (255, 255, 255)
    return (rgb[0], rgb[1], rgb[2])


def _text_sprite(text: str, color: str, px: int, cache: Dict[int, Any]):
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415

    if px in cache:
        return cache[px]
    try:
        font = ImageFont.load_default(size=max(8, int(px)))
    except TypeError:  # pragma: no cover — ancient Pillow fallback
        font = ImageFont.load_default()
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    tw, th = right - left, bottom - top
    sprite = Image.new("RGBA", (max(1, tw + 8), max(1, th + 8)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(sprite)
    draw.text((4 - left, 4 - top), text, font=font, fill=_hex_color(color) + (255,))
    cache[px] = sprite
    return sprite


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #


def _load_bg(scene: Dict[str, Any], width: int, height: int, cache: _SpriteCache):
    from PIL import Image  # noqa: PLC0415

    bg = scene.get("bg") or {}
    btype = bg.get("type", "color")
    if btype == "image" and bg.get("file"):
        try:
            sprite = cache.image(bg["file"])
            return _fit_sprite(sprite, width, height, 1.0, (0, 0, 0, 255))
        except Exception:
            pass  # fall through to color
    color = bg.get("color") or [16, 18, 22]
    if isinstance(color, (list, tuple)) and len(color) >= 3:
        r, g, b = int(color[0]) & 255, int(color[1]) & 255, int(color[2]) & 255
    else:
        r, g, b = 16, 18, 22
    return Image.new("RGBA", (width, height), (r, g, b, 255))


def _fit_sprite(sprite, width: int, height: int, scale: float, pad_color):
    """Contain-fit the sprite to the stage, multiplied by `scale`, on a pad of
    `pad_color` so the layer still covers the full stage (matches JS preview)."""
    from PIL import Image  # noqa: PLC0415

    sw, sh = sprite.size
    s = min(width / sw, height / sh) * scale
    tw, th = max(1, round(sw * s)), max(1, round(sh * s))
    resized = sprite.resize((tw, th), _resample(sprite))
    canvas = Image.new("RGBA", (width, height), pad_color)
    canvas.alpha_composite(resized, ((width - tw) // 2, (height - th) // 2))
    return canvas


def _resample(image) -> int:
    from PIL import Image  # noqa: PLC0415

    if image.mode in ("RGBA", "LA"):
        return Image.BILINEAR
    return Image.BILINEAR


def _render_layer_sprite(
    layer: Dict[str, Any],
    props: Dict[str, float],
    width: int,
    height: int,
    cache: _SpriteCache,
    text_cache: Dict[int, Any],
    warnings: List[str],
):
    """Sprite for image/text layers, transformed (scale/rotation/opacity).

    IMAGE sprites are contain-fitted to the stage (scale=1 fills it), exactly
    like the JS preview.  TEXT sprites are NOT contain-fitted — they render at
    their font-size scale (font_size * width) multiplied by the layer scale,
    matching the JS `ctx.fillText` preview, otherwise a small title would be
    blown up to fill the whole stage.
    """
    from PIL import Image  # noqa: PLC0415

    try:
        if layer["type"] == "image":
            sprite = cache.image(layer["file"]).copy()
            fitted = _fit_sprite(sprite, width, height, props["scale"], (0, 0, 0, 0))
        elif layer["type"] == "text":
            px = max(8, layer["font_size"] * width)
            sprite = _text_sprite(layer["text"], layer["color"], px, text_cache).copy()
            s = max(0.01, props["scale"])
            tw = max(1, int(sprite.size[0] * s))
            th = max(1, int(sprite.size[1] * s))
            fitted = sprite.resize((tw, th), Image.BILINEAR)
        else:  # pragma: no cover
            return None

        if abs(props["rotation"]) > 0.5:
            fitted = fitted.rotate(props["rotation"], resample=Image.BILINEAR, expand=True)
        opacity = min(1.0, max(0.0, props["opacity"]))
        if opacity < 1.0:
            fitted.putalpha(fitted.getchannel("A").point(lambda a: int(a * opacity)))
        return fitted
    except FileNotFoundError:
        warnings.append(f"Mockup: asset not found — skipped {layer.get('file')}")
        return None
    except Exception as exc:  # noqa: BLE001 — a bad sprite must not kill the render
        warnings.append(f"Mockup: layer {layer.get('name') or layer.get('id')} skipped ({exc})")
        return None


def render_scene(
    scene: Dict[str, Any],
    width: int,
    height: int,
    fps: int = 24,
    duration_sec: float = 6.0,
) -> Tuple[Any, List[str]]:
    """Render the scene to frames [1, F, H, W, 3] float32 0..1 (torch tensor).

    Returns (tensor, warnings).  torch is the only heavy dependency.
    """
    import numpy as np  # noqa: PLC0415
    import torch  # noqa: PLC0415

    width, height = max(8, int(width)), max(8, int(height))
    fps = max(1, min(120, int(fps)))
    duration_sec = max(0.1, float(duration_sec))
    frame_count = max(1, round(duration_sec * fps))
    warnings: List[str] = []

    cache = _SpriteCache()
    text_cache: Dict[int, Any] = {}
    bg = _load_bg(scene, width, height, cache)

    frames: List[Any] = []
    layers = scene.get("layers") or []
    # Panel order is top-first (Photoshop style): index 0 draws on top.
    draw_order = list(reversed(layers))

    for frame_index in range(frame_count):
        t = frame_index / fps
        canvas = bg.copy()
        for layer in draw_order:
            props = props_at(layer, t)
            if props is None or props["opacity"] <= 0.001:
                continue
            if layer["type"] == "video":
                keys = layer["keys"]
                t0 = keys[0]["t"] if keys else 0.0
                # local layer time, so the clip inside also plays at `speed`
                media_t = layer["trim_start"] + (t * float(layer.get("speed", 1.0)) - t0)
                try:
                    sprite = cache.video_frame(layer["file"], media_t)
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"Mockup: video layer {layer.get('name') or layer.get('id')} skipped ({exc})")
                    continue
                if sprite is None:
                    continue
                fitted = _fit_sprite(sprite, width, height, props["scale"], (0, 0, 0, 0))
                if abs(props["rotation"]) > 0.5:
                    fitted = fitted.rotate(props["rotation"], resample=_resample(fitted), expand=True)
                opacity = min(1.0, max(0.0, props["opacity"]))
                if opacity < 1.0:
                    fitted.putalpha(fitted.getchannel("A").point(lambda a: int(a * opacity)))
                sprite_out = fitted
            else:
                sprite_out = _render_layer_sprite(
                    layer, props, width, height, cache, text_cache, warnings
                )
                if sprite_out is None:
                    continue
            # center placement in normalized coordinates
            cx = int(round(props["x"] * width))
            cy = int(round(props["y"] * height))
            w2, h2 = sprite_out.size[0] // 2, sprite_out.size[1] // 2
            canvas.alpha_composite(sprite_out, (cx - w2, cy - h2))
        rgb = canvas.convert("RGB")
        arr = np.asarray(rgb, dtype=np.float32) / 255.0
        frames.append(torch.from_numpy(arr))
    if not frames:
        frames.append(torch.zeros(height, width, 3))
    video = torch.stack(frames)  # [F, H, W, 3]
    return video.unsqueeze(0), warnings  # [1, F, H, W, 3]
