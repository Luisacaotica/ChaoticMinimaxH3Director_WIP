/* Chaotic H3 Mockup Editor — 2.5D puppet stage widget.
 *
 * Compose PNG/JPEG sprites, text, and video clips as layers, keyframe their
 * transform (position / scale / rotation / opacity) over time, and scrub the
 * result with an audio track.  The scene serializes into the hidden
 * `scene_data` STRING widget and renders server-side into [1, F, H, W, 3]
 * frames the Director consumes as a storyboard `mockup`.
 *
 * Data contract mirrors mockup.py exactly:
 *   - x, y       layer center as a fraction of the stage (0..1)
 *   - fit        "contain" (letterboxed to the stage, aspect preserved)
 *   - scale      multiplier on the fitted size (1.0 = fits the stage)
 *   - rotation   degrees (JS preview negates it to match PIL's direction)
 *   - opacity    0..1, the visual reference strength
 *   - keys       [{t, ease, x, y, scale, rotation, opacity}] — layer is visible
 *                only inside [first.t, last.t]. `ease` (linear|in|out|inout|hold)
 *                shapes the outgoing motion toward the next key (hold = step).
 *                A layer without keys is static and always visible.
 *   - speed      per-layer time-warp (0.05..4, default 1): the layer's local
 *                clock runs at `speed` × the project timeline, so keys are
 *                authored in LAYER time and the strip shows them at t/speed.
 *   - layers[0]  is the TOP layer (Photoshop style)
 */
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */
const STAGE_ASPECT = 16 / 9;  // fallback when the render-size widgets are unavailable
const ASPECT_PRESETS = [
  ["16:9", 1280, 720],
  ["9:16", 720, 1280],
  ["1:1", 1024, 1024],
];
const KEYSTRIP_RULER_H = 16;   // top ruler row (project seconds)
const KEYSTRIP_LANE_H = 16;    // one lane per layer (top = front)
const KEYSTRIP_GUTTER = 54;    // name column on the left of the strip
const AUDIO_H = 84;

const CSS = `
.pup-wrap{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:row;gap:0;width:100%;box-sizing:border-box;color:#dcdcdc;font-size:11px;min-height:400px}
.pup-left{display:flex;flex-direction:column;gap:6px;width:300px;min-width:260px;max-width:360px;flex-shrink:0;overflow-y:auto;overflow-x:hidden;padding-right:8px;border-right:1px solid #2a2a2a;scrollbar-width:thin;scrollbar-color:#3c3c3c transparent}
.pup-left::-webkit-scrollbar{width:5px}
.pup-left::-webkit-scrollbar-thumb{background:#3c3c3c;border-radius:3px}
.pup-right{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0;overflow:hidden}
.pup-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:2px 0}
.pup-btn{background:#232323;color:#ddd;border:1px solid #2e2e2e;border-radius:4px;padding:5px 9px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:5px;transition:background .15s,border-color .15s;font-family:inherit}
.pup-btn:hover{background:#333;border-color:#555}
.pup-btn.danger:hover{background:#4a1515;border-color:#cc4444;color:#ffb0b0}
.pup-btn.active{background:#1c2b22;border-color:#2f7a50;color:#7ee2a8}
.pup-stage-box{position:relative;background:#000;border:1px solid #1c1c1c;border-radius:6px;overflow:hidden;flex:none}
.pup-canvas{display:block;width:100%;cursor:crosshair;outline:none;background:#101214}
.pup-stage-label{position:absolute;top:4px;left:6px;font-size:9px;color:#888;font-family:ui-monospace,Menlo,monospace;pointer-events:none;text-shadow:0 1px 2px #000}
.pup-stage-time{position:absolute;top:4px;right:6px;font-size:10px;color:#ffd479;font-family:ui-monospace,Menlo,monospace;pointer-events:none;text-shadow:0 1px 2px #000}
.pup-keystrip{background:#181818;border:1px solid #1c1c1c;border-radius:6px;display:block;width:100%;cursor:pointer;flex:none}
.pup-panel{background:#1b1b1b;border:1px solid #2a2a2a;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px}
.pup-panel-title{font-size:10px;font-weight:700;color:#8a8a8a;text-transform:uppercase;letter-spacing:.07em;display:flex;justify-content:space-between;align-items:center}
.pup-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pup-label{font-size:10px;color:#9a9a9a;white-space:nowrap}
.pup-input{background:#141414;color:#e8e8e8;border:1px solid #333;border-radius:4px;padding:3px 6px;font-size:11px;font-family:inherit}
.pup-input[type=number]{width:58px}
.pup-input[type=text]{flex:1;min-width:60px}
.pup-input[type=color]{width:34px;height:22px;padding:0;border:1px solid #333;background:#141414}
.pup-input:focus{outline:none;border-color:#5a8f7a}
.pup-layer-row{display:flex;gap:6px;align-items:center;background:#141414;border:1px solid #262626;border-radius:5px;padding:4px 6px;cursor:pointer;transition:border-color .12s,background .12s}
.pup-layer-row:hover{background:#1a1a1a}
.pup-layer-row.sel{border-color:#4aa47f;background:#15231c}
.pup-layer-thumb{width:34px;height:26px;object-fit:cover;border-radius:3px;background:#000;flex:none}
.pup-layer-thumb-canvas{flex:none}
.pup-layer-name{flex:1;min-width:0;font-size:10.5px;color:#e8e8e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pup-layer-type{font-size:9px;color:#7ea0b8;font-family:ui-monospace,Menlo,monospace;flex:none}
.pup-drag-handle{cursor:grab;color:#555;font-size:12px;padding:0 3px;user-select:none;flex:none}
.pup-layer-row.dragover{border-color:#4aa47f;background:rgba(74,164,127,.10)}
.pup-keystrip-hint{font-size:10px;color:#666;padding:2px 2px}
.pup-hint{font-size:10px;color:#8a8a8a;line-height:1.5}
.pup-drop{border:1.5px dashed #444;border-radius:6px;padding:8px;text-align:center;color:#777;font-size:10px;cursor:pointer;transition:all .15s}
.pup-drop.drag-over{border-color:#4aa47f;background:rgba(74,164,127,.08);color:#7ee2a8}
.pup-audio{display:flex;flex-direction:column;gap:5px}
.pup-wave{background:#101214;border:1px solid #1c1c1c;border-radius:5px;display:block;width:100%;cursor:pointer;flex:none}
.pup-statusline{font-size:10px;color:#9a9a9a;min-height:14px}
.pup-overlay{position:absolute;top:8px;right:8px;bottom:8px;left:8px;z-index:60;background:rgba(14,16,20,.97);border:1px solid #383838;border-radius:8px;padding:14px 16px;overflow:auto;display:none;box-shadow:0 6px 24px rgba(0,0,0,.5)}
.pup-overlay.open{display:block}
.pup-overlay h3{margin:0 0 10px;font-size:12px;letter-spacing:.4px;color:#ffcf5a;font-weight:600}
.pup-overlay .row{display:flex;justify-content:space-between;gap:18px;padding:3px 0;border-bottom:1px solid #222;font-size:11px;line-height:1.5}
.pup-overlay .row kbd{background:#262626;border:1px solid #3d3d3d;border-bottom-width:2px;border-radius:4px;padding:0 6px;font:11px ui-monospace,Menlo,monospace;color:#ffd97a;white-space:nowrap}
.pup-overlay .row .d{color:#9a9a9a;text-align:right}
.pup-overlay .x{position:absolute;top:8px;right:10px;cursor:pointer;color:#888;font-size:14px;line-height:1;padding:2px}
.pup-overlay .x:hover{color:#fff}
.pup-keystrip-legend{font-size:9px;color:#777;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:2px 2px;line-height:1.4}
.pup-ease-swatch{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:3px;vertical-align:middle}
`;

if (!document.getElementById("chaotic-puppet-styles")) {
  const el = document.createElement("style");
  el.id = "chaotic-puppet-styles";
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ------------------------------------------------------------------ */
/* Pure helpers (mirror mockup.py)                                    */
/* ------------------------------------------------------------------ */
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function fmtTimestamp(sec) {
  sec = Math.max(0, sec);
  const mm = Math.floor(sec / 60);
  const rest = sec - mm * 60;
  const ss = Math.floor(rest);
  const mmm = Math.round((rest - ss) * 1000);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(mmm).padStart(3, "0")}`;
}
function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function lerp(a, b, f) { return a + (b - a) * f; }

const EASE_MODES = ["linear", "in", "out", "inout", "hold"];
const EASE_COLORS = { linear: "#3a3a3a", in: "#e07b39", out: "#3fb8c4", inout: "#9b6bff", hold: "#d84a4a" };
/* Progress-curve for a segment whose outgoing key has the given ease (mirrors mockup.py). */
function easeF(f, mode) {
  if (mode === "in") return f * f;
  if (mode === "out") return 1 - (1 - f) * (1 - f);
  if (mode === "inout") return f * f * (3 - 2 * f);
  if (mode === "hold") return 0;
  return f;
}
function normalizeEase(e) { return EASE_MODES.indexOf(e) >= 0 ? e : "linear"; }

function propsAt(layer, t) {
  /* per-layer speed: evaluate in LAYER-local time (mirrors mockup.py props_at) */
  t = t * (layer.speed || 1);
  const keys = (layer.keys || []).slice().sort((a, b) => a.t - b.t);
  if (keys.length === 0) {
    return { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation, opacity: layer.opacity };
  }
  if (t < keys[0].t - 1e-6 || t > keys[keys.length - 1].t + 1e-6) return null;
  if (keys.length === 1 || t <= keys[0].t + 1e-6) return { x: keys[0].x, y: keys[0].y, scale: keys[0].scale, rotation: keys[0].rotation, opacity: keys[0].opacity };
  if (t >= keys[keys.length - 1].t - 1e-6) {
    const k = keys[keys.length - 1];
    return { x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity };
  }
  let after = keys[0];
  for (const k of keys) { if (k.t >= t - 1e-6) { after = k; break; } }
  const before = keys[keys.indexOf(after) - 1];
  const span = Math.max(1e-6, after.t - before.t);
  const f = (t - before.t) / span;
  if (normalizeEase(before.ease) === "hold") {
    /* Step: the outgoing key's pose holds until the next key's time, then jumps. */
    const src = f >= 1 - 1e-9 ? after : before;
    return { x: src.x, y: src.y, scale: src.scale, rotation: src.rotation, opacity: src.opacity };
  }
  const f2 = easeF(f, normalizeEase(before.ease));
  return {
    x: lerp(before.x, after.x, f2),
    y: lerp(before.y, after.y, f2),
    scale: lerp(before.scale, after.scale, f2),
    rotation: lerp(before.rotation, after.rotation, f2),
    opacity: lerp(before.opacity, after.opacity, f2),
  };
}

/* ------------------------------------------------------------------ */
/* Editor                                                             */
/* ------------------------------------------------------------------ */
class ChaoticPuppetEditor {
  constructor(node, container, domWidget) {
    this.node = node;
    this.container = container;
    this.domWidget = domWidget;

    this.state = { bg: { type: "color", color: [16, 18, 22] }, layers: [], lib: [], audio: { file: "", trim_start: 0, trim_end: null } };
    this.playhead = 0;
    this.playing = false;
    this.selectedId = null;
    this.renderIn = null;        // render window IN (seconds), null = start
    this.renderOut = null;       // render window OUT (seconds), null = end
    this.snapOn = false;
    this._selKeys = new Set();   // "layerId@t" — multi-select keyframes
    this._drag = null;
    this._lastWidth = 0;
    this._lastScale = 0;
    this._raf = null;
    this._lastTick = 0;
    this._imgCache = {};
    this._videoEls = {};
    this._peaks = null;
    this._audioBuf = null;
    this._audioReady = false;
    /* mouse recording (Cappuccino-style): REC arms, the next drag on a layer
       records a take, writing keys only for the enabled channels */
    this._recArmed = false;
    this._recCapturing = false;
    this._recChannels = { pos: true, size: false, rot: false };
    this._recStart = 0;
    this._recStartPlayhead = 0;
    this._recLastSample = 0;
    this._recStartY = 0;
    this._recStartX = 0;
    this._recBaseCenter = null;
    this._recBaseScale = 1;

    this.sceneDataWidget = node.widgets.find(w => w.name === "scene_data");
    this.fpsWidget = node.widgets.find(w => w.name === "fps");
    this.durationWidget = node.widgets.find(w => w.name === "duration_sec");
    this.widthWidget = node.widgets.find(w => w.name === "width");
    this.heightWidget = node.widgets.find(w => w.name === "height");
    this.aspectBtns = {};
    this.aspectDims = null;

    this.wireSizeWidgets();
    this.loadState();
    this.buildDOM();
    this._raf = requestAnimationFrame(() => this.checkResize());
  }

  get fps() { return parseInt((this.fpsWidget && this.fpsWidget.value) || 24, 10) || 24; }
  get durationSec() {
    const d = parseFloat(this.durationWidget && this.durationWidget.value);
    return isNaN(d) ? 6 : Math.max(0.5, d);
  }
  set durationSec(v) {
    if (this.durationWidget && this.durationWidget.value !== undefined) this.durationWidget.value = clamp(parseFloat(v) || 6, 0.5, 120);
  }

  defaultScene() {
    return { aspect: "16:9", bg: { type: "color", color: [16, 18, 22] }, layers: [], audio: { file: "", trim_start: 0, trim_end: null } };
  }

  loadState() {
    let raw = this.sceneDataWidget ? this.sceneDataWidget.value : "";
    let data = {};
    try { if (raw) data = JSON.parse(raw); } catch (e) { /* defaults */ }
    this._applyState(data);
  }

  _applyState(raw, opts) {
    const applySize = !!(opts && opts.applySize);
    const rawAspect = (raw && typeof raw.aspect === "string") ? raw.aspect : "";
    const knownPreset = ASPECT_PRESETS.some(([id]) => id === rawAspect);
    this.state = {
      aspect: knownPreset ? rawAspect : (rawAspect || "16:9"),
      bg: (raw.bg && typeof raw.bg === "object") ? raw.bg : { type: "color", color: [16, 18, 22] },
      layers: Array.isArray(raw.layers) ? raw.layers.map((l, i) => this.normalizeLayer(l, i)) : [],
      audio: (raw.audio && typeof raw.audio === "object")
        ? { file: raw.audio.file || "", trim_start: Number(raw.audio.trim_start) || 0, trim_end: raw.audio.trim_end == null ? null : Number(raw.audio.trim_end) }
        : { file: "", trim_start: 0, trim_end: null },
      lib: Array.isArray(raw.lib) ? raw.lib.filter(x => x && x.file) : [],
    };
    this.renderIn = raw.render_in == null ? null : Number(raw.render_in);
    this.renderOut = raw.render_out == null ? null : Number(raw.render_out);
    if (this.renderIn != null && this.renderOut != null && this.renderOut <= this.renderIn) {
      this.renderIn = null;
      this.renderOut = null;
    }
    /* Only a project file that actually DECLARES a preset aspect restores the
       preset's render size. A plain node load — or an old project saved before
       this feature (no `aspect` field) — leaves the width/height widgets alone,
       so manual/legacy sizes survive untouched. */
    if (applySize && knownPreset) {
      const preset = ASPECT_PRESETS.find(([id]) => id === rawAspect);
      if (preset && this.widthWidget && this.heightWidget) {
        this.widthWidget.value = preset[1];
        this.heightWidget.value = preset[2];
      }
    }
    this._imgCache = {};
    this._videoEls = {};
    this._peaks = null;
    this._audioReady = false;
    this.state.layers.forEach(l => this.preloadSprite(l));
    if (this.state.audio.file) this.loadAudioPeaks(this.state.audio.file);
  }

  normalizeLayer(l, i) {
    return {
      id: l.id || uid("layer"),
      type: ["image", "video", "text"].includes(l.type) ? l.type : "image",
      name: l.name || "",
      file: l.file || "",
      fit: l.fit === "contain" ? "contain" : "contain",
      x: clamp(Number(l.x) != null ? Number(l.x) : 0.5, 0, 1),
      y: clamp(Number(l.y) != null ? Number(l.y) : 0.5, 0, 1),
      scale: Math.max(0.01, Number(l.scale) || 1),
      rotation: Number(l.rotation) || 0,
      opacity: clamp(Number(l.opacity) != null ? Number(l.opacity) : 1, 0, 1),
      text: typeof l.text === "string" ? l.text : "",
      color: l.color || "#ffffff",
      font_size: Math.max(0.01, Number(l.font_size) || 0.06),
      trim_start: Math.max(0, Number(l.trim_start) || 0),
      speed: isFinite(Number(l.speed)) ? clamp(Number(l.speed), 0.05, 4) : 1,
      pivot: (l.pivot && typeof l.pivot === "object")
        ? { x: clamp(Number(l.pivot.x) != null ? Number(l.pivot.x) : 0.5, 0, 1), y: clamp(Number(l.pivot.y) != null ? Number(l.pivot.y) : 0.5, 0, 1) }
        : { x: 0.5, y: 0.5 },
      keys: Array.isArray(l.keys)
        ? l.keys.map(k => ({
            t: Math.max(0, Number(k.t) || 0),
            ease: normalizeEase(k.ease),
            x: Number(k.x) != null ? Number(k.x) : 0.5,
            y: Number(k.y) != null ? Number(k.y) : 0.5,
            scale: Math.max(0.01, Number(k.scale) || 1),
            rotation: Number(k.rotation) || 0,
            opacity: clamp(Number(k.opacity) != null ? Number(k.opacity) : 1, 0, 1),
          })).sort((a, b) => a.t - b.t)
        : [],
      _index: i,
      _thumb: null,
    };
  }

  serialize() {
    return JSON.stringify({
      version: 1,
      render_in: this.renderIn,
      render_out: this.renderOut,
      aspect: this.stateAspectLabel(),
      bg: this.state.bg,
      layers: this.state.layers.map(l => ({
        id: l.id, type: l.type, name: l.name, file: l.file, fit: l.fit,
        x: l.x, y: l.y, scale: l.scale, rotation: l.rotation, opacity: l.opacity,
        text: l.text, color: l.color, font_size: l.font_size, trim_start: l.trim_start,
        speed: l.speed || 1,
        pivot: l.pivot || { x: 0.5, y: 0.5 },
        keys: l.keys.map(k => ({ t: k.t, ease: normalizeEase(k.ease), x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity })),
      })),
      lib: this.state.lib,
      audio: this.state.audio,
    }, null, 1);
  }

  commitChanges() {
    if (this.sceneDataWidget) this.sceneDataWidget.value = this.serialize();
    if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    this.drawStage();
    this.drawKeyStrip();
    this.refreshLayerList();
  }

  layerById(id) { return this.state.layers.find(l => l.id === id); }

  reorderLayer(fromId, toIndex) {
    const from = this.state.layers.findIndex(l => l.id === fromId);
    if (from < 0) return;
    const target = Math.max(0, Math.min(this.state.layers.length - 1, toIndex));
    if (from === target) return;
    const [layer] = this.state.layers.splice(from, 1);
    this.state.layers.splice(target, 0, layer);
    this.state.layers.forEach((l, idx) => { if (l._index !== undefined) l._index = idx; });
    this.commitChanges();
  }

  clearDragOver() {
    if (!this.layersList) return;
    const rows = this.layersList.querySelectorAll ? this.layersList.querySelectorAll(".pup-layer-row") : [];
    (rows || []).forEach(r => r.classList.remove("dragover"));
  }

  /* ---------------- aspect / stage size ---------------- */
  wireSizeWidgets() {
    [this.widthWidget, this.heightWidget].forEach(w => {
      if (!w) return;
      const prev = w.callback;
      w.callback = function () {
        this.onRenderSizeChanged();
        if (typeof prev === "function") prev.apply(this, arguments);
      }.bind(this);
    });
  }

  stateAspectLabel() { return this.state.aspect || "16:9"; }

  stageAspect() {
    const w = this.widthWidget ? parseInt(this.widthWidget.value, 10) : 0;
    const h = this.heightWidget ? parseInt(this.heightWidget.value, 10) : 0;
    if (w > 0 && h > 0) return w / h;
    return STAGE_ASPECT;
  }

  applyAspectPreset(id) {
    const preset = ASPECT_PRESETS.find(([pid]) => pid === id);
    if (!preset) return;
    this.state.aspect = id;
    if (this.widthWidget) this.widthWidget.value = preset[1];
    if (this.heightWidget) this.heightWidget.value = preset[2];
    this.commitChanges();
    this.refreshAspectButtons();
    this._lastWidth = 0; // force the stage to reshape to the new aspect
    this.checkResize();
    this.recomputeSize();
    this.updateStatus(`Stage aspect set to ${id} (${preset[1]}×${preset[2]}) — layers keep their normalized positions.`);
  }

  onRenderSizeChanged() {
    const w = this.widthWidget ? parseInt(this.widthWidget.value, 10) : 0;
    const h = this.heightWidget ? parseInt(this.heightWidget.value, 10) : 0;
    /* Typing exact preset dimensions re-labels the preset; anything else is custom. */
    const match = ASPECT_PRESETS.find(([id, pw, ph]) => w === pw && h === ph);
    this.state.aspect = match ? match[0] : "custom";
    this.refreshAspectButtons();
    this._lastWidth = 0;
    this.checkResize();
    this.recomputeSize();
    const label = match ? match[0] : `Custom ${w}×${h}`;
    this.updateStatus(`${label} — the stage follows the width/height widgets.`);
    this.commitChanges();
  }

  refreshAspectButtons() {
    const label = this.stateAspectLabel();
    Object.keys(this.aspectBtns).forEach(id => {
      this.aspectBtns[id].classList.toggle("active", id === label);
    });
    this.updateAspectDims();
  }

  updateAspectDims() {
    if (!this.aspectDims) return;
    const w = this.widthWidget ? this.widthWidget.value : "?";
    const h = this.heightWidget ? this.heightWidget.value : "?";
    this.aspectDims.textContent = `${this.stateAspectLabel()} · ${w}×${h}`;
  }

  viewUrl(file) {
    if (!file) return "";
    const parts = file.split("/");
    const filename = parts[parts.length - 1];
    const subfolder = parts.slice(0, -1).join("/");
    return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
  }

  /* ---------------- sprites ---------------- */
  preloadSprite(layer) {
    if (layer.type === "image" && layer.file && !this._imgCache[layer.id]) {
      const img = new Image();
      img.onload = () => { this._imgCache[layer.id] = img; this.drawStage(); this.refreshLayerList(); };
      img.src = this.viewUrl(layer.file);
    }
    if (layer.type === "video" && layer.file && !this._videoEls[layer.id]) {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.addEventListener("loadedmetadata", () => { this._videoEls[layer.id] = v; this.drawStage(); });
      v.src = this.viewUrl(layer.file);
    }
  }

  spriteSize(layer) {
    if (layer.type === "image" && this._imgCache[layer.id]) {
      return [this._imgCache[layer.id].naturalWidth || this._imgCache[layer.id].width, this._imgCache[layer.id].naturalHeight || this._imgCache[layer.id].height];
    }
    if (layer.type === "video" && this._videoEls[layer.id]) {
      return [this._videoEls[layer.id].videoWidth || 640, this._videoEls[layer.id].videoHeight || 360];
    }
    if (layer.type === "text") {
      return [600, 120];
    }
    return [256, 256];
  }

  fittedSize(layer, props, W, H) {
    const [sw, sh] = this.spriteSize(layer);
    const s = Math.min(W / Math.max(1, sw), H / Math.max(1, sh)) * props.scale;
    return [sw * s, sh * s];
  }

  /* ---------------- DOM ---------------- */
  buildDOM() {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "pup-wrap";

    /* toolbar */
    const toolbar = document.createElement("div");
    toolbar.className = "pup-toolbar";
    const btnImg = this.btn("⬆ Image", () => this.pickFiles("image"));
    const btnVid = this.btn("⬆ Video", () => this.pickFiles("video"));
    const btnCrops = this.btn("📥 Crops", () => this.importCrops());
    btnCrops.title = "import the crops exported from Chaotic H3 Video Edit (⤴ Export crops) as image layers — pose them on the stage.";
    const btnText = this.btn("T Text", () => this.addTextLayer());
    const btnSave = this.btn("Save", () => this.saveProject());
    const btnLoad = this.btn("Load", () => this.loadProject());
    const btnPlay = this.btn("▶", () => this.togglePlay());
    btnPlay.className = "pup-btn";
    this.playBtn = btnPlay;
    const btnKey = this.btn("Key", () => this.addKeyAtPlayhead());
    const btnDelKey = this.btn("Del Key", () => this.delKeyAtPlayhead());
    const btnSnap = this.btn("🧲 Snap", () => {
      this.snapOn = !this.snapOn;
      btnSnap.classList.toggle("active", this.snapOn);
      this.updateStatus(this.snapOn ? "Snap ON — layer drags and key times land on the frame grid." : "Snap off — free placement.");
    });
    btnSnap.title = "snap layer drags to the frame grid";
    const btnLib = this.btn("🧰 Library", () => this.toggleLibPanel());
    btnLib.title = "sprite library — every imported file; drag a card back onto the stage to re-add it";
    const btnBg = this.btn("Bg", () => this.pickBackground());
    btnBg.title = "pick a background image for the stage (keyframable from the Background panel)";
    const aspectLab = document.createElement("span");
    aspectLab.className = "pup-label";
    aspectLab.textContent = "Aspect";
    const aspectBtns = ASPECT_PRESETS.map(([id, pw, ph]) => {
      const b = this.btn(id, () => this.applyAspectPreset(id));
      b.className = "pup-btn";
      b.title = `${id} → ${pw}×${ph}`;
      this.aspectBtns[id] = b;
      return b;
    });
    const aspectDims = document.createElement("span");
    aspectDims.className = "pup-label";
    aspectDims.style.fontFamily = "ui-monospace,Menlo,monospace";
    aspectDims.style.color = "#7ea0b8";
    aspectDims.textContent = "";
    this.aspectDims = aspectDims;
    const btnClear = this.btn("✕ Layers", () => { this.state.layers = []; this.selectedId = null; this.commitChanges(); this.buildInspector(); });
    /* mouse recording controls */
    const btnRec = this.btn("● REC", () => this.toggleRec());
    btnRec.className = "pup-btn";
    this.recBtn = btnRec;
    const recPos = this.btn("Pos", () => this.toggleRecChannel("pos"));
    const recSize = this.btn("Size", () => this.toggleRecChannel("size"));
    const recRot = this.btn("Rot", () => this.toggleRecChannel("rot"));
    recPos.className = recSize.className = recRot.className = "pup-btn";
    this.recChanBtns = { pos: recPos, size: recSize, rot: recRot };
    const btnHelp = this.btn("? Help", () => this.toggleShortcuts());
    btnHelp.title = "show the stage/keyframe keyboard shortcuts (? toggles)";
    toolbar.append(btnImg, btnVid, btnText, btnBg, aspectLab, ...aspectBtns, aspectDims, btnKey, btnDelKey, btnSnap, btnLib, btnPlay, btnRec, recPos, recSize, recRot, btnSave, btnLoad, btnClear, btnHelp);
    /* left sidebar */
    const leftPanel = document.createElement("div");
    leftPanel.className = "pup-left";

    /* right main — stage + key strip */
    const rightPanel = document.createElement("div");
    rightPanel.className = "pup-right";

    leftPanel.appendChild(toolbar);

    /* stage */
    this.stageBox = document.createElement("div");
    this.stageBox.className = "pup-stage-box";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pup-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.stageLabel = document.createElement("div");
    this.stageLabel.className = "pup-stage-label";
    this.stageLabel.textContent = "mockup stage — drag layers to move · drag on ruler to scrub";
    this.stageTime = document.createElement("div");
    this.stageTime.className = "pup-stage-time";
    this.stageBox.appendChild(this.canvas);
    this.stageBox.appendChild(this.stageLabel);
    this.stageBox.appendChild(this.stageTime);
    rightPanel.appendChild(this.stageBox);

    /* keyframe strip */
    this.keyCanvas = document.createElement("canvas");
    this.keyCanvas.className = "pup-keystrip";
    this.keyCanvas.style.flex = "1";
    this.keyCtx = this.keyCanvas.getContext("2d");
    rightPanel.appendChild(this.keyCanvas);
    const keyLegend = document.createElement("div");
    keyLegend.className = "pup-keystrip-legend";
    keyLegend.innerHTML = EASE_MODES.map(m =>
      `<span><span class="pup-ease-swatch" style="background:${EASE_COLORS[m]}"></span>${m}</span>`
    ).join("") + `<span style="margin-left:auto">each row = a layer (top = front) · ease colors the outgoing motion · click a row to select it</span>`;
    rightPanel.appendChild(keyLegend);

    /* layers panel */
    this.layersPanel = document.createElement("div");
    this.layersPanel.className = "pup-panel";
    const layersTitle = document.createElement("div");
    layersTitle.className = "pup-panel-title";
    layersTitle.innerHTML = "<span>Layers (top first)</span><span style='color:#666'>drag rows to reorder · drag the stage to move</span>";
    this.layersList = document.createElement("div");
    this.layersList.className = "pup-row";
    this.layersList.style.flexDirection = "column";
    this.layersList.style.alignItems = "stretch";
    this.layersPanel.appendChild(layersTitle);
    this.layersPanel.appendChild(this.layersList);
    leftPanel.appendChild(this.layersPanel);

    /* sprite library — every imported file, re-draggable onto the stage */
    this.libPanel = document.createElement("div");
    this.libPanel.className = "pup-panel";
    this.libPanel.style.display = "none";
    const libTitle = document.createElement("div");
    libTitle.className = "pup-panel-title";
    libTitle.innerHTML = "<span>Sprite library</span><span style='color:#666'>drag a card onto the stage to add it as a layer</span>";
    this.libList = document.createElement("div");
    this.libList.className = "pup-row";
    this.libList.style.flexDirection = "column";
    this.libList.style.alignItems = "stretch";
    this.libPanel.appendChild(libTitle);
    this.libPanel.appendChild(this.libList);
    leftPanel.appendChild(this.libPanel);

    /* inspector */
    this.inspector = document.createElement("div");
    this.inspector.className = "pup-panel";
    this.inspector.style.display = "none";
    leftPanel.appendChild(this.inspector);

    /* audio */
    this.audioPanel = document.createElement("div");
    this.audioPanel.className = "pup-panel pup-audio";
    const audioTitle = document.createElement("div");
    audioTitle.className = "pup-panel-title";
    audioTitle.innerHTML = "<span>Audio scrub</span>";
    const audioBtnRow = document.createElement("div");
    audioBtnRow.className = "pup-row";
    const btnAudio = this.btn("⬆ Audio", () => this.pickAudio());
    const btnAudioClear = this.btn("✕", () => { this.state.audio.file = ""; this._peaks = null; this._audioReady = false; if (this.audioEl) this.audioEl.pause(); this.commitChanges(); this.buildAudioPanel(); });
    const audioFileLabel = document.createElement("span");
    audioFileLabel.className = "pup-label";
    audioFileLabel.style.flex = "1";
    audioFileLabel.style.overflow = "hidden";
    audioFileLabel.style.textOverflow = "ellipsis";
    audioFileLabel.style.whiteSpace = "nowrap";
    this.audioFileLabel = audioFileLabel;
    audioBtnRow.appendChild(btnAudio);
    audioBtnRow.appendChild(btnAudioClear);
    audioBtnRow.appendChild(audioFileLabel);
    this.audioPanel.appendChild(audioTitle);
    this.audioPanel.appendChild(audioBtnRow);
    this.audioWave = document.createElement("canvas");
    this.audioWave.className = "pup-wave";
    this.audioWave.style.height = "40px";
    this.audioPanel.appendChild(this.audioWave);
    const audioCtl = document.createElement("div");
    audioCtl.className = "pup-row";
    this.audioPlayBtn = this.btn("▶", () => this.toggleAudioPlay());
    this.audioSeek = document.createElement("input");
    this.audioSeek.className = "pup-input";
    this.audioSeek.type = "range";
    this.audioSeek.min = "0";
    this.audioSeek.max = "100";
    this.audioSeek.value = "0";
    this.audioSeek.style.flex = "1";
    this.audioSeek.style.accentColor = "#4aa47f";
    this.audioSeek.addEventListener("input", () => this.onAudioSeek());
    this.audioTime = document.createElement("span");
    this.audioTime.className = "pup-label";
    this.audioTime.style.fontFamily = "monospace";
    this.audioTime.textContent = "--:--.---";
    audioCtl.appendChild(this.audioPlayBtn);
    audioCtl.appendChild(this.audioSeek);
    audioCtl.appendChild(this.audioTime);
    this.audioPanel.appendChild(audioCtl);
    this.audioTrim = document.createElement("div");
    this.audioTrim.className = "pup-row";
    this.audioTrim.innerHTML = '<span class="pup-label">Trim in</span>';
    const trimIn = document.createElement("input");
    trimIn.className = "pup-input";
    trimIn.type = "number";
    trimIn.step = "0.1";
    trimIn.value = this.state.audio.trim_start;
    trimIn.addEventListener("change", () => { this.state.audio.trim_start = Math.max(0, Number(trimIn.value) || 0); this.commitChanges(); });
    const trimOut = document.createElement("input");
    trimOut.className = "pup-input";
    trimOut.type = "number";
    trimOut.step = "0.1";
    trimOut.value = this.state.audio.trim_end == null ? "" : this.state.audio.trim_end;
    trimOut.placeholder = "end";
    trimOut.addEventListener("change", () => {
      this.state.audio.trim_end = trimOut.value === "" ? null : Math.max(this.state.audio.trim_start + 0.1, Number(trimOut.value) || 0);
      this.commitChanges();
    });
    this.audioTrim.appendChild(trimIn);
    this.audioTrim.appendChild(document.createTextNode(""));
    const outLab = document.createElement("span");
    outLab.className = "pup-label";
    outLab.textContent = "out";
    this.audioTrim.appendChild(outLab);
    this.audioTrim.appendChild(trimOut);
    this.audioPanel.appendChild(this.audioTrim);
    leftPanel.appendChild(this.audioPanel);

    /* background timeline */
    this.bgPanel = document.createElement("div");
    this.bgPanel.className = "pup-panel";
    leftPanel.appendChild(this.bgPanel);
    this.buildBgPanel();

    /* status */
    this.statusLine = document.createElement("div");
    this.statusLine.className = "pup-statusline";
    this.wrapper.style.position = "relative";
    this.helpOverlay = this.buildShortcutsOverlay();
    leftPanel.appendChild(this.helpOverlay);
    leftPanel.appendChild(this.statusLine);

    this.wrapper.appendChild(leftPanel);
    this.wrapper.appendChild(rightPanel);
    this.container.appendChild(this.wrapper);

    /* interactions */
    this.canvas.addEventListener("mousedown", e => this.onStageDown(e));
    this.canvas.addEventListener("mousemove", e => this.onStageMove(e));
    this.canvas.addEventListener("mouseup", e => this.onStageUp(e));
    this.canvas.addEventListener("contextmenu", e => {
      e.preventDefault();
      const layer = this.hitLayerAt(this.canvasEventPos(e).x, this.canvasEventPos(e).y);
      if (layer) {
        this.selectedId = layer.id;
        this.buildInspector();
        this.refreshLayerList();
        this.drawStage();
        this.updateStatus("Selected. Drag to move · corner/edge handles scale · ⭘ above rotates · the small dot moves the pivot point (the pin everything spins around).");
      } else {
        this.updateStatus("Right-click on a layer to select it. Drag it to move; use the gizmo handles to scale/rotate; drag the pivot dot to re-pin. Delete = remove layer / selected keyframe.");
      }
    });
    this.canvas.addEventListener("keydown", e => this.onKeyDown(e));
    this.canvas.tabIndex = 0;
    if (typeof document.addEventListener === "function") {
      /* only act when THIS editor is focused — keeps per-node keydown from
         firing while another Chaotic node (or a ComfyUI widget) has focus */
      document.addEventListener("keydown", e => {
        if (this.wrapper && this.wrapper.contains(e.target)) this.onKeyDown(e);
      });
    }
    this.keyCanvas.addEventListener("mousedown", e => this.onKeyStripDown(e));
    this.wrapper.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
    this.wrapper.addEventListener("drop", e => this.onDrop(e));

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.style.display = "none";
    this.wrapper.appendChild(this.fileInput);

    /* hidden audio element */
    this.audioEl = document.createElement("audio");
    this.audioEl.addEventListener("timeupdate", () => this.onAudioTime());

    this.refreshLayerList();
    this.buildInspector();
    this.drawStage();
    this.drawKeyStrip();
    this.buildAudioPanel();
    this.refreshAspectButtons();
    recPos.classList.add("active");
    this.updateStatus("Compose layers on the stage. Select a layer, move the playhead, press Key, then drag/move to animate. Wire the IMAGE output into the Director's mockup input.");
  }

  btn(label, fn) {
    const b = document.createElement("button");
    b.className = "pup-btn";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  updateStatus(text) { this.statusLine.textContent = text; }

  /* ---------------- shortcuts overlay (? key / ? Help button) ---------------- */
  buildShortcutsOverlay() {
    const ov = document.createElement("div");
    ov.className = "pup-overlay";
    const title = document.createElement("h3");
    title.textContent = "⌨️ Stage & keyframe shortcuts";
    ov.appendChild(title);
    const close = document.createElement("span");
    close.className = "x";
    close.textContent = "✕";
    close.title = "close (Esc or ?)";
    close.addEventListener("click", () => this.closeShortcuts());
    ov.appendChild(close);
    [
      ["← → ↑ ↓", "nudge the layer 1 px on stage (Shift = 10 px)"],
      ["← → on keys", "move selected keyframes in time by 1 frame"],
      ["↑ ↓ on keys", "move selected keyframe positions"],
      ["S", "key the selected layer at the playhead (the cut)"],
      ["R", "render window — only [IN → OUT] renders"],
      ["Key / Del Key", "add / remove a keyframe at the playhead"],
      ["Del", "delete selected keyframes, else the selected layer"],
      ["Esc", "clear selection, close menus / this overlay"],
      ["Drag", "move · Shift-drag = keyframe · Alt-drag the ⭘ pin = pivot"],
    ].forEach(([k, d]) => {
      const row = document.createElement("div");
      row.className = "row";
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      const desc = document.createElement("span");
      desc.className = "d";
      desc.textContent = d;
      row.appendChild(kbd);
      row.appendChild(desc);
      ov.appendChild(row);
    });
    return ov;   /* hidden by the base CSS rule; the .open class shows it */
  }

  toggleShortcuts() {
    if (!this.helpOverlay) return;
    const open = this.helpOverlay.classList.toggle("open");
    if (open) this.updateStatus("Shortcuts — press ? or Esc to close.");
  }

  closeShortcuts() {
    if (this.helpOverlay) this.helpOverlay.classList.remove("open");
  }

  getRenderScale() {
    let gs = 1;
    try {
      if (window.app && window.app.canvas && window.app.canvas.ds && window.app.canvas.ds.scale) {
        gs = window.app.canvas.ds.scale;
      }
    } catch (e) {}
    return (window.devicePixelRatio || 1) * Math.max(1, gs);
  }

  checkResize() {
    const w = this.canvas ? this.canvas.clientWidth : 0;
    const scale = this.getRenderScale();
    if (w > 0 && (w !== this._lastWidth || scale !== this._lastScale)) {
      this._lastWidth = w;
      this._lastScale = scale;
      const aspect = this.stageAspect();
      const h = Math.max(60, Math.round((w * scale) / aspect));
      this.canvas.width = Math.round(w * scale);
      this.canvas.height = h;
      this.canvas.style.height = (w / aspect) + "px";
      this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const kw = this.keyCanvas.clientWidth || w;
      this.keyCanvas.width = Math.round(kw * scale);
      this.keyCanvas.height = Math.round(this.keyStripHeight() * scale);
      this.keyCtx.setTransform(scale, 0, 0, scale, 0, 0);
      const aw = this.audioWave.clientWidth || w;
      this.audioWave.width = Math.round(aw * scale);
      this.audioWave.height = Math.round(40 * scale);
      this.audioCtx = this.audioWave.getContext("2d");
      this.audioCtx.setTransform(scale, 0, 0, scale, 0, 0);
      this.drawStage();
      this.drawKeyStrip();
      this.drawAudioWave();
    }
    if (this.playing) this._raf = requestAnimationFrame(() => this.checkResize());
    else this._raf = requestAnimationFrame(() => this.checkResize());
  }

  /* ---------------- stage drawing ---------------- */
  stageSize() {
    const w = this.canvas ? this.canvas.clientWidth : 800;
    return [Math.max(120, w), Math.max(67, w / this.stageAspect())];
  }

  drawStage() {
    if (!this.canvas || !this.ctx) return;
    const ctx = this.ctx;
    const [W, H] = this.stageSize();
    ctx.clearRect(0, 0, W, H);
    this.drawBackground(ctx, W, H);
    const layers = this.state.layers.slice().reverse(); // top first -> draw bottom first
    layers.forEach(layer => this.drawLayer(ctx, layer, W, H));
    /* playhead */
    const x = (this.playhead / this.durationSec) * W;
    ctx.strokeStyle = "#ff5a5a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.lineWidth = 1;
    this.stageTime.textContent = fmtTimestamp(this.playhead) + " / " + fmtTimestamp(this.durationSec);
  }

  drawBackground(ctx, W, H) {
    const bg = this.bgAt(this.playhead) || this.state.bg || {};
    if (bg.type === "image" && bg.file) {
      const key = "bg:" + bg.file;
      let img = this._imgCache[key];
      if (!img) {
        img = new Image();
        img.onload = () => { this._imgCache[key] = img; this.drawStage(); };
        img.src = this.viewUrl(bg.file);
      } else {
        const s = Math.max(W / Math.max(1, img.naturalWidth), H / Math.max(1, img.naturalHeight));
        const tw = img.naturalWidth * s, th = img.naturalHeight * s;
        ctx.drawImage(img, (W - tw) / 2, (H - th) / 2, tw, th);
        return;
      }
    }
    const color = bg.color || [16, 18, 22];
    ctx.fillStyle = `rgb(${color[0] | 0}, ${color[1] | 0}, ${color[2] | 0})`;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------------- background timeline ---------------- */
  bgAt(t) {
    const frames = Array.isArray(this.state.bg && this.state.bg.frames) ? this.state.bg.frames : [];
    if (!frames.length) return this.state.bg;
    let cur = this.state.bg;
    for (const e of frames) {
      if (e.t <= t + 1e-6) cur = e;
      else break;
    }
    return cur;
  }

  setBgKeyAtPlayhead() {
    if (!this.state.bg.frames) this.state.bg.frames = [];
    const t = Math.round(this.playhead * 1000) / 1000;
    const cur = this.bgAt(this.playhead);
    const entry = {
      t,
      type: cur.type || "color",
      ...(cur.type === "image" && cur.file ? { file: cur.file } : { color: (cur.color || [16, 18, 22]).slice() }),
    };
    this.state.bg.frames = this.state.bg.frames.filter(e => Math.abs(e.t - t) > 1e-6);
    this.state.bg.frames.push(entry);
    this.state.bg.frames.sort((a, b) => a.t - b.t);
    this.commitChanges();
    this.refreshBgPanel();
    this.updateStatus(`Background key set at ${t.toFixed(2)}s — scrub to see the background change.`);
  }

  buildBgPanel() {
    const bgTitle = document.createElement("div");
    bgTitle.className = "pup-panel-title";
    bgTitle.innerHTML = "<span>Background timeline</span><span style='color:#666'>key the background like a layer</span>";
    this.bgPanel.appendChild(bgTitle);
    const bgRow = document.createElement("div");
    bgRow.className = "pup-row";
    const btnBgKey = this.btn("● Key BG at playhead", () => this.setBgKeyAtPlayhead());
    btnBgKey.title = "snapshot the current background into a keyframe at the playhead";
    const btnBgClear = this.btn("✕ Keys", () => { this.state.bg.frames = []; this.commitChanges(); this.refreshBgPanel(); });
    bgRow.appendChild(btnBgKey);
    bgRow.appendChild(btnBgClear);
    this.bgPanel.appendChild(bgRow);
    this.bgList = document.createElement("div");
    this.bgList.className = "pup-row";
    this.bgList.style.flexDirection = "column";
    this.bgList.style.alignItems = "stretch";
    this.bgPanel.appendChild(this.bgList);
    this.refreshBgPanel();
  }

  refreshBgPanel() {
    if (!this.bgList) return;
    this.bgList.innerHTML = "";
    const frames = (this.state.bg && this.state.bg.frames) || [];
    if (!frames.length) {
      const d = document.createElement("div");
      d.className = "pup-hint";
      d.textContent = "No background keys — the background is constant. Set the playhead, pick a color or image, then press ● Key BG at playhead to animate it.";
      this.bgList.appendChild(d);
      return;
    }
    frames.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "pup-layer-row";
      row.title = "click to jump the playhead";
      const lab = document.createElement("span");
      lab.className = "pup-layer-name";
      lab.textContent = f.t.toFixed(2) + "s · " + (f.type === "image" ? String(f.file || "image").split("/").pop() : "color " + JSON.stringify(f.color || []));
      row.appendChild(lab);
      const del = document.createElement("button");
      del.className = "pup-btn danger";
      del.textContent = "✕";
      del.addEventListener("click", ev => { ev.stopPropagation(); this.state.bg.frames.splice(i, 1); this.commitChanges(); this.refreshBgPanel(); });
      row.appendChild(del);
      row.addEventListener("click", () => this.setPlayhead(f.t));
      this.bgList.appendChild(row);
    });
  }

  toggleLibPanel() {
    this.libPanel.style.display = this.libPanel.style.display === "none" ? "" : "none";
    if (this.libPanel.style.display !== "none") this.refreshLibPanel();
  }

  refreshLibPanel() {
    if (!this.libList) return;
    this.libList.innerHTML = "";
    if (!this.state.lib.length) {
      const d = document.createElement("div");
      d.className = "pup-hint";
      d.textContent = "Empty — every image/video you import lands here so you can re-add it later by dragging the card onto the stage.";
      this.libList.appendChild(d);
      return;
    }
    this.state.lib.forEach(entry => {
      const card = document.createElement("div");
      card.className = "pup-layer-row";
      card.draggable = true;
      card.title = "drag onto the stage to add this as a layer";
      const name = document.createElement("span");
      name.className = "pup-layer-name";
      name.textContent = String(entry.name || entry.file || "sprite").slice(-34);
      const type = document.createElement("span");
      type.className = "pup-layer-type";
      type.textContent = entry.kind || "image";
      card.appendChild(name);
      card.appendChild(type);
      card.addEventListener("dragstart", ev => {
        ev.dataTransfer.setData("text/pup-lib", entry.file);
        ev.dataTransfer.effectAllowed = "copy";
      });
      this.libList.appendChild(card);
    });
  }

  addToLib(file, name, kind) {
    if (!file || this.state.lib.some(x => x.file === file)) return;
    this.state.lib.push({ id: uid("lib"), file, name: name || file, kind: kind || "image" });
  }

  addSpriteLayer(file, name, kind, x, y) {
    const layer = this.normalizeLayer({
      id: uid("layer"),
      type: kind === "video" ? "video" : "image",
      name: name || "sprite",
      file,
      x: x != null ? clamp(x, 0, 1) : 0.5,
      y: y != null ? clamp(y, 0, 1) : 0.5,
      scale: 1,
      rotation: 0,
      opacity: 1,
      keys: [],
    }, this.state.layers.length);
    this.state.layers.unshift(layer); // new layers land on top
    this.selectedId = layer.id;
    this.preloadSprite(layer);
    this.commitChanges();
    this.refreshLayerList();
    this.buildInspector();
  }

  drawLayer(ctx, layer, W, H) {
    const props = propsAt(layer, this.playhead);
    if (!props || props.opacity <= 0.001) return;
    const [sw, sh] = this.spriteSize(layer);
    const s = Math.min(W / Math.max(1, sw), H / Math.max(1, sh)) * props.scale;
    const tw = sw * s, th = sh * s;
    const cx = props.x * W, cy = props.y * H;
    const isSel = this.selectedId === layer.id;
    const px = (layer.pivot && layer.pivot.x != null) ? layer.pivot.x : 0.5;
    const py = (layer.pivot && layer.pivot.y != null) ? layer.pivot.y : 0.5;
    ctx.save();
    ctx.translate(cx, cy);
    /* pivot-aware transform: the pivot point lands exactly on (cx, cy) and
       everything rotates around it (the "pin point") */
    ctx.translate((0.5 - px) * tw, (0.5 - py) * th);
    if (Math.abs(props.rotation) > 0.1) ctx.rotate(-props.rotation * Math.PI / 180);
    ctx.globalAlpha = props.opacity;

    if (layer.type === "image") {
      const img = this._imgCache[layer.id];
      if (img) ctx.drawImage(img, -px * tw, -py * th, tw, th);
    } else if (layer.type === "video") {
      const v = this._videoEls[layer.id];
      if (v) {
        const keys = layer.keys;
        const t0 = keys.length ? keys[0].t : 0;
        const mediaT = layer.trim_start + (this.playhead * (layer.speed || 1) - t0);
        if (v.readyState >= 1 && Math.abs(v.currentTime - mediaT) > 0.08) v.currentTime = mediaT;
        ctx.drawImage(v, -px * tw, -py * th, tw, th);
      } else {
        this.drawPlaceholder(ctx, tw, th, layer);
      }
    } else if (layer.type === "text") {
      const px2 = Math.max(8, layer.font_size * W);
      ctx.font = `600 ${px2}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,.8)";
      ctx.shadowBlur = 4;
      ctx.fillStyle = layer.color || "#ffffff";
      ctx.fillText(layer.text || "Text", 0, 0);
      ctx.shadowBlur = 0;
    } else {
      this.drawPlaceholder(ctx, tw, th, layer);
    }
    ctx.restore();

    if (isSel) {
      this.drawGizmo(ctx, layer, props, W, H);
    }
  }

  /* ---------------- Photoshop-style gizmo (scale / rotate / pivot) ---------------- */
  gizmoRects(layer, props, W, H) {
    const [tw, th] = this.fittedSize(layer, props, W, H);
    const cx = props.x * W, cy = props.y * H;
    const px = (layer.pivot && layer.pivot.x != null) ? layer.pivot.x : 0.5;
    const py = (layer.pivot && layer.pivot.y != null) ? layer.pivot.y : 0.5;
    return { cx, cy, tw, th, px, py };
  }

  pointerLocal(layer, props, W, H, mx, my) {
    /* map a stage point into layer-local coords (origin = pivot, +y down),
       inverting the draw transform */
    const g = this.gizmoRects(layer, props, W, H);
    const pvx = g.cx + (0.5 - g.px) * g.tw;
    const pvy = g.cy + (0.5 - g.py) * g.th;
    const dx = mx - pvx, dy = my - pvy;
    const th0 = (props.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(th0), sin = Math.sin(th0);
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  gizmoHandleAt(layer, props, W, H, mx, my) {
    const g = this.gizmoRects(layer, props, W, H);
    const lp = this.pointerLocal(layer, props, W, H, mx, my);
    const HIT = 9;
    const x0 = -g.px * g.tw, y0 = -g.py * g.th;
    const x1 = (1 - g.px) * g.tw, y1 = (1 - g.py) * g.th;
    const corners = {
      nw: [x0, y0], n: [(x0 + x1) / 2, y0], ne: [x1, y0],
      e: [x1, (y0 + y1) / 2], se: [x1, y1], s: [(x0 + x1) / 2, y1],
      sw: [x0, y1], w: [x0, (y0 + y1) / 2],
    };
    for (const k of Object.keys(corners)) {
      const [hx, hy] = corners[k];
      if (Math.abs(lp.x - hx) <= HIT && Math.abs(lp.y - hy) <= HIT) return "scale:" + k;
    }
    /* rotate knob floats above the top edge — at the box midpoint, matching drawGizmo */
    const midX = (0.5 - g.px) * g.tw;
    if (Math.hypot(lp.x - midX, lp.y - (y0 - 20)) <= 13) return "rotate";
    /* pivot dot at the origin */
    if (Math.hypot(lp.x, lp.y) <= 8) return "pivot";
    if (lp.x >= x0 - 4 && lp.x <= x1 + 4 && lp.y >= y0 - 4 && lp.y <= y1 + 4) return "move";
    return null;
  }

  drawGizmo(ctx, layer, props, W, H) {
    const g = this.gizmoRects(layer, props, W, H);
    const pvx = g.cx + (0.5 - g.px) * g.tw;
    const pvy = g.cy + (0.5 - g.py) * g.th;
    const rot = (props.rotation || 0) * Math.PI / 180;
    ctx.save();
    ctx.translate(pvx, pvy);
    if (Math.abs(rot) > 0.001) ctx.rotate(-rot);
    ctx.strokeStyle = "rgba(126,226,168,.95)";
    ctx.lineWidth = 1;
    ctx.strokeRect(-g.px * g.tw, -g.py * g.th, g.tw, g.th);
    ctx.fillStyle = "#7ee2a8";
    /* 8 scale handles */
    const hs = 4.5;
    const midX = (0.5 - g.px) * g.tw;
    const midY = (0.5 - g.py) * g.th;
    [[-g.px * g.tw, -g.py * g.th], [midX, -g.py * g.th], [(1 - g.px) * g.tw, -g.py * g.th],
     [(1 - g.px) * g.tw, midY], [(1 - g.px) * g.tw, (1 - g.py) * g.th], [midX, (1 - g.py) * g.th],
     [-g.px * g.tw, (1 - g.py) * g.th], [-g.px * g.tw, midY]].forEach(([hx, hy]) => {
      ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
    });
    /* rotate arm + knob */
    ctx.strokeStyle = "#ffb454";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(midX, -g.py * g.th);
    ctx.lineTo(midX, -g.py * g.th - 20);
    ctx.stroke();
    ctx.fillStyle = "#ffb454";
    ctx.beginPath();
    ctx.arc(midX, -g.py * g.th - 20, 5, 0, Math.PI * 2);
    ctx.fill();
    /* pivot dot (the pin point) */
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(0, 0, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ff5a5a";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, 5.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawPlaceholder(ctx, tw, th, layer) {
    ctx.fillStyle = "rgba(90,120,150,.35)";
    ctx.fillRect(-tw / 2, -th / 2, tw, th);
    ctx.strokeStyle = "rgba(150,190,220,.6)";
    ctx.strokeRect(-tw / 2, -th / 2, tw, th);
    ctx.fillStyle = "rgba(220,235,250,.8)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((layer.name || layer.type).slice(0, 18), 0, 0);
  }

  /* ---------------- keyframe strip (multi-track lanes) ---------------- */
  keyStripHeight() {
    return KEYSTRIP_RULER_H + Math.max(1, this.state.layers.length) * KEYSTRIP_LANE_H;
  }

  stripX(t, w) {
    /* project-time x on the strip; a layer at speed s shows its keys at t/s. */
    const track = Math.max(1, w - KEYSTRIP_GUTTER);
    return KEYSTRIP_GUTTER + (clamp(t, 0, this.durationSec) / Math.max(0.001, this.durationSec)) * track;
  }

  drawKeyStrip() {
    if (!this.keyCanvas || !this.keyCtx) return;
    const ctx = this.keyCtx;
    const w = this.keyCanvas.clientWidth || 800;
    const h = this.keyStripHeight();
    const dur = this.durationSec;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, w, h);
    /* render window: shade everything outside [renderIn, renderOut) */
    if (this.renderIn != null || this.renderOut != null) {
      const track = Math.max(1, w - KEYSTRIP_GUTTER);
      const xIn = this.renderIn != null ? this.stripX(this.renderIn, w) : 0;
      const xOut = this.renderOut != null ? this.stripX(this.renderOut, w) : w;
      ctx.fillStyle = "rgba(0,0,0,.45)";
      if (xIn > 0) ctx.fillRect(0, 0, xIn, h);
      if (xOut < w) ctx.fillRect(xOut, 0, w - xOut, h);
    }
    const sel = this.selectedId ? this.layerById(this.selectedId) : null;
    /* ruler row (project seconds) */
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, w, KEYSTRIP_RULER_H);
    const step = dur <= 10 ? 1 : dur <= 30 ? 5 : 10;
    for (let t = 0; t <= dur + 1e-6; t += step) {
      const x = this.stripX(t, w);
      ctx.fillStyle = "#555";
      ctx.fillRect(x, KEYSTRIP_RULER_H - 5, 1, 5);
      ctx.fillStyle = "#9a9a9a";
      ctx.font = "8px ui-monospace, monospace";
      ctx.fillText(t.toFixed(0) + "s", x + 2, KEYSTRIP_RULER_H - 2);
    }
    ctx.strokeStyle = "#333";
    ctx.beginPath();
    ctx.moveTo(KEYSTRIP_GUTTER, 0);
    ctx.lineTo(KEYSTRIP_GUTTER, h);
    ctx.stroke();
    /* one lane per layer, top-first (layer index 0 = front) */
    this.state.layers.forEach((layer, i) => {
      const laneY = KEYSTRIP_RULER_H + i * KEYSTRIP_LANE_H;
      const isSel = sel && sel.id === layer.id;
      const speed = layer.speed && layer.speed !== 1 ? layer.speed : 1;
      ctx.fillStyle = isSel ? "rgba(74,164,127,.13)" : (i % 2 === 0 ? "#161616" : "#181818");
      ctx.fillRect(0, laneY, w, KEYSTRIP_LANE_H);
      ctx.fillStyle = isSel ? "#7ee2a8" : "#777";
      ctx.font = "8px ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const label = (layer.name || layer.type).slice(0, speed !== 1 ? 6 : 10) + (speed !== 1 ? " ×" + speed : "");
      ctx.fillText(label, KEYSTRIP_GUTTER - 5, laneY + KEYSTRIP_LANE_H / 2 + 0.5);
      const keys = (layer.keys || []).slice().sort((a, b) => a.t - b.t);
      /* eased interpolation curve for THIS layer's lane */
      if (keys.length > 1) {
        ctx.lineWidth = 1;
        for (let i2 = 0; i2 < keys.length - 1; i2++) {
          const a = keys[i2], b = keys[i2 + 1];
          const span = Math.max(1e-6, b.t - a.t);
          ctx.strokeStyle = isSel ? "rgba(155,107,255,.95)" : "rgba(155,107,255,.32)";
          ctx.beginPath();
          for (let s = 0; s <= 16; s++) {
            const f = s / 16;
            const f2 = easeF(f, normalizeEase(a.ease));
            const x = this.stripX((a.t + f * span) / speed, w);
            const y = laneY + KEYSTRIP_LANE_H / 2 - (f2 - 0.5) * (KEYSTRIP_LANE_H - 7);
            if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      /* key markers (fill = outgoing ease, ring = selected layer) */
      keys.forEach(k => {
        const x = this.stripX(k.t / speed, w);
        ctx.fillStyle = EASE_COLORS[normalizeEase(k.ease)] || EASE_COLORS.linear;
        ctx.beginPath();
        ctx.arc(x, laneY + KEYSTRIP_LANE_H / 2, 2.8, 0, Math.PI * 2);
        ctx.fill();
        if (isSel) {
          ctx.strokeStyle = "#4aa47f";
          ctx.beginPath();
          ctx.arc(x, laneY + KEYSTRIP_LANE_H / 2, 4.2, 0, Math.PI * 2);
          ctx.stroke();
        }
        /* yellow ring: this layer's key is under the playhead (speed-adjusted) */
        if (isSel && Math.abs(k.t - this.playhead * speed) < 0.02) {
          ctx.strokeStyle = "#ffd479";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, laneY + KEYSTRIP_LANE_H / 2, 5.6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        /* bright ring: this key is part of the multi-selection (Del removes all) */
        if (this._selKeys && this._selKeys.has(layer.id + "@" + k.t)) {
          ctx.strokeStyle = "#7ee2a8";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(x, laneY + KEYSTRIP_LANE_H / 2, 6.6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
      });
    });
    /* playhead */
    const x = this.stripX(this.playhead, w);
    ctx.strokeStyle = "#ff5a5a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  onKeyStripDown(e) {
    const rect = this.keyCanvas.getBoundingClientRect();
    const w = this.keyCanvas.clientWidth || 1;
    const track = Math.max(1, w - KEYSTRIP_GUTTER);
    const cx0 = e.clientX - rect.left;
    const cy0 = e.clientY - rect.top;
    const t = clamp(((cx0 - KEYSTRIP_GUTTER) / track) * this.durationSec, 0, this.durationSec);
    const laneIdx = Math.floor((cy0 - KEYSTRIP_RULER_H) / KEYSTRIP_LANE_H);
    /* keyframe click = select it (Shift toggles multi-select, Del removes) */
    if (laneIdx >= 0 && laneIdx < this.state.layers.length) {
      const layer = this.state.layers[laneIdx];
      const laneY = KEYSTRIP_RULER_H + laneIdx * KEYSTRIP_LANE_H;
      const speed = layer.speed && layer.speed !== 1 ? layer.speed : 1;
      const keys = (layer.keys || []).slice().sort((a, b) => a.t - b.t);
      let hitKey = null;
      for (const k of keys) {
        const kx = this.stripX(k.t / speed, w);
        if (Math.abs(kx - cx0) <= 6 && Math.abs(cy0 - (laneY + KEYSTRIP_LANE_H / 2)) <= 7) { hitKey = k; break; }
      }
      if (hitKey) {
        const sig = layer.id + "@" + hitKey.t;
        if (e.shiftKey) {
          if (this._selKeys.has(sig)) this._selKeys.delete(sig);
          else this._selKeys.add(sig);
        } else {
          this._selKeys.clear();
          this._selKeys.add(sig);
        }
        this.selectedId = layer.id;
        this.refreshLayerList();
        this.buildInspector();
        this.drawKeyStrip();
        this.updateStatus(`Keyframe selected (${this._selKeys.size} total) — Del removes, Shift+click to multi-select.`);
        return;
      }
      this.selectedId = layer.id;
      this._selKeys.clear();
      this.refreshLayerList();
      this.buildInspector();
    }
    this.setPlayhead(t);
    const grab = () => {
      const onMove = ev => {
        const r = this.keyCanvas.getBoundingClientRect();
        const ww = this.keyCanvas.clientWidth || 1;
        const tw = Math.max(1, ww - KEYSTRIP_GUTTER);
        this.setPlayhead(clamp(((ev.clientX - r.left - KEYSTRIP_GUTTER) / tw) * this.durationSec, 0, this.durationSec));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    grab();
  }

  setPlayhead(t) {
    this.playhead = clamp(t, 0, this.durationSec);
    this.syncAudioToPlayhead();
    this.drawStage();
    this.drawKeyStrip();
  }

  /* ---------------- mouse recording ---------------- */
  toggleRec() {
    this._recArmed = !this._recArmed;
    this._recCapturing = false;
    this.recBtn.classList.toggle("active", this._recArmed);
    this.recBtn.textContent = this._recArmed ? "■ STOP REC" : "● REC";
    this.updateStatus(this._recArmed
      ? "REC armed — select a layer, set the playhead to the take start, then drag on the stage. Recording only the enabled channels."
      : "Recording off.");
  }

  toggleRecChannel(ch) {
    this._recChannels[ch] = !this._recChannels[ch];
    this.recChanBtns[ch].classList.toggle("active", this._recChannels[ch]);
    const on = Object.keys(this._recChannels).filter(k => this._recChannels[k]);
    this.updateStatus(`Recording channels: ${on.length ? on.join(", ") : "none — enable Pos/Size/Rot"}.`);
  }

  recordedProps(layer, px, py) {
    /* Map the pointer to recorded values: position follows the cursor, scale
       grows as you drag up, rotation follows the pointer's ANGLE AROUND the
       layer's center (a delta from where the drag started) — so the layer
       never flicks or spins wildly as the cursor crosses the center. */
    const [W, H] = this.stageSize();
    const base = propsAt(layer, this._recStartPlayhead) || layer;
    const nx = clamp(px / W, 0, 1);
    const ny = clamp(py / H, 0, 1);
    const scale = clamp(this._recBaseScale * (1 + (this._recStartY - py) / H), 0.02, 8);
    const [cx0, cy0] = this._recBaseCenter || [base.x * W, base.y * H];
    const a0 = Math.atan2(this._recStartY - cy0, this._recStartX - cx0);
    const a1 = Math.atan2(py - cy0, px - cx0);
    const rotation = base.rotation + (a1 - a0) * 180 / Math.PI;
    return { x: nx, y: ny, scale, rotation };
  }

  /* ---------------- keyframes ---------------- */
  keyAtPlayhead(layer) {
    if (!layer) return null;
    /* keys are authored in layer-local time; the playhead is project time */
    const lt = this.playhead * (layer.speed || 1);
    return (layer.keys || []).find(k => Math.abs(k.t - lt) < 0.02) || null;
  }

  ensureKeyAtPlayhead(layer) {
    if (!layer) return null;
    if (!layer.keys) layer.keys = [];
    const existing = this.keyAtPlayhead(layer);
    if (existing) return existing;
    const cur = propsAt(layer, this.playhead) || { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation, opacity: layer.opacity };
    const key = { t: Math.round(this.playhead * (layer.speed || 1) * 1000) / 1000, ease: "linear", x: cur.x, y: cur.y, scale: cur.scale, rotation: cur.rotation, opacity: cur.opacity };
    layer.keys.push(key);
    layer.keys.sort((a, b) => a.t - b.t);
    return key;
  }

  addKeyAtPlayhead() {
    const layer = this.selectedId ? this.layerById(this.selectedId) : null;
    if (!layer) {
      this.updateStatus("Select a layer first, then press Key.");
      return;
    }
    const key = this.ensureKeyAtPlayhead(layer);
    this.updateStatus(`Key added at ${fmtTimestamp(this.playhead)} for "${layer.name || layer.type}".`);
    this.commitChanges();
    this.buildInspector();
  }

  delKeyAtPlayhead() {
    const layer = this.selectedId ? this.layerById(this.selectedId) : null;
    if (!layer) return;
    const key = this.keyAtPlayhead(layer);
    if (!key) {
      this.updateStatus("No keyframe at the playhead for the selected layer.");
      return;
    }
    layer.keys = layer.keys.filter(k => k !== key);
    this.updateStatus("Key removed.");
    this.commitChanges();
    this.buildInspector();
  }

  setProp(layer, prop, value) {
    const key = this.ensureKeyAtPlayhead(layer);
    key[prop] = value;
    layer[prop] = value;
    this.commitChanges();
  }

  /* ---------------- stage interactions ---------------- */
  hitLayerAt(px, py) {
    const [W, H] = this.stageSize();
    for (const layer of this.state.layers) { // top first
      const props = propsAt(layer, this.playhead);
      if (!props) continue;
      const g = this.gizmoRects(layer, props, W, H);
      const left = g.cx + (0.5 - g.px) * g.tw - g.px * g.tw;
      const top = g.cy + (0.5 - g.py) * g.th - g.py * g.th;
      if (px >= left - 4 && px <= left + g.tw + 4 && py >= top - 4 && py <= top + g.th + 4) return layer;
    }
    return null;
  }

  canvasEventPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.clientWidth / Math.max(1, rect.width);
    const scaleY = this.canvas.clientHeight / Math.max(1, rect.height);
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  snapVal(v, step) {
    return this.snapOn ? Math.round(v / step) * step : v;
  }

  onStageDown(e) {
    const { x: px, y: py } = this.canvasEventPos(e);
    const [W, H] = this.stageSize();
    /* gizmo handles first — they act on the SELECTED layer even under others */
    const selLayer = this.selectedId ? this.layerById(this.selectedId) : null;
    if (selLayer) {
      const props = propsAt(selLayer, this.playhead);
      if (props) {
        let handle = this.gizmoHandleAt(selLayer, props, W, H, px, py);
        if (handle === "rotate") {
          const g = this.gizmoRects(selLayer, props, W, H);
          const pvx = g.cx + (0.5 - g.px) * g.tw, pvy = g.cy + (0.5 - g.py) * g.th;
          this._drag = { layerId: selLayer.id, mode: "rotate", startX: px, startY: py, baseRot: props.rotation, startAng: Math.atan2(py - pvy, px - pvx) };
          this.canvas.style.cursor = "crosshair";
          return;
        }
        if (handle === "pivot") {
          if (!e.altKey) {
            /* the pivot dot needs Alt to grab — plain clicks on the layer body move it */
            handle = null;
          } else {
            this._drag = { layerId: selLayer.id, mode: "pivot", startX: px, startY: py };
            this.updateStatus("Dragging the pin point (Alt) — everything rotates/scales around this spot.");
            return;
          }
        }
        if (handle && handle.startsWith("scale:")) {
          this._drag = { layerId: selLayer.id, mode: "scale", handle: handle.split(":")[1], startX: px, startY: py };
          return;
        }
      }
    }
    const layer = this.hitLayerAt(px, py);
    if (layer) {
      this.selectedId = layer.id;
      this.buildInspector();
      this.refreshLayerList();
      this.drawStage();
      /* anchor to the layer's DRAWN position (interpolated), not the static default */
      const props = propsAt(layer, this.playhead) || { x: layer.x, y: layer.y };
      /* nx/ny seed the move-dedup guard with the DRAWN position so the first
         real move is processed (the old `_drag.nx || nx` fallback swallowed it) */
      this._drag = { layerId: layer.id, startX: px, startY: py, dx: props.x - px / W, dy: props.y - py / H, nx: this.snapVal(props.x, 0.01), ny: this.snapVal(props.y, 0.01) };
      if (this._recArmed) {
        this._recCapturing = true;
        this._recStart = performance.now();
        this._recStartPlayhead = this.playhead;
        this._recLastSample = 0;
        this._recStartY = py;
        this._recStartX = px;
        this._recBaseScale = props.scale;
        this._recBaseCenter = [props.x * W, props.y * H];
        this.updateStatus("Recording… drag to perform the motion (the playhead advances). Release to finish the take.");
      }
    } else {
      this.selectedId = null;
      this.buildInspector();
      this.refreshLayerList();
      this.drawStage();
    }
  }

  onStageMove(e) {
    if (!this._drag) return;
    const { x: px, y: py } = this.canvasEventPos(e);
    const layer = this.layerById(this._drag.layerId);
    if (!layer) return;
    const [W, H] = this.stageSize();
    const mode = this._drag.mode || "move";
    if (mode === "rotate") {
      const props = propsAt(layer, this.playhead) || layer;
      const g = this.gizmoRects(layer, props, W, H);
      const pvx = g.cx + (0.5 - g.px) * g.tw, pvy = g.cy + (0.5 - g.py) * g.th;
      const ang = Math.atan2(py - pvy, px - pvx) * 180 / Math.PI;
      let rot = this._drag.baseRot + (ang - this._drag.startAng);
      rot = ((rot % 360) + 360) % 360;
      if (this.snapOn) rot = Math.round(rot / 5) * 5;
      const key = this.ensureKeyAtPlayhead(layer);
      key.rotation = rot;
      layer.rotation = rot;
      this.commitChanges();
      return;
    }
    if (mode === "pivot") {
      const props = propsAt(layer, this.playhead) || layer;
      const g = this.gizmoRects(layer, props, W, H);
      const lp = this.pointerLocal(layer, props, W, H, px, py);
      layer.pivot = {
        x: clamp((lp.x + g.px * g.tw) / g.tw, 0, 1),
        y: clamp((lp.y + g.py * g.th) / g.th, 0, 1),
      };
      this.commitChanges();
      this.drawStage();
      return;
    }
    if (mode === "scale") {
      const props = propsAt(layer, this.playhead) || layer;
      const g = this.gizmoRects(layer, props, W, H);
      const lp = this.pointerLocal(layer, props, W, H, px, py);
      const slp = this.pointerLocal(layer, props, W, H, this._drag.startX, this._drag.startY);
      const dir = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] }[this._drag.handle] || [1, 1];
      let kx = 1, ky = 1;
      if (dir[0] !== 0) kx = slp.x !== 0 ? lp.x / slp.x : 1;
      if (dir[1] !== 0) ky = slp.y !== 0 ? lp.y / slp.y : 1;
      if (dir[0] !== 0 && dir[1] !== 0) {
        const k = Math.max(Math.abs(kx), Math.abs(ky));
        kx = ky = (Math.sign(kx) || 1) * k;
      }
      const k = Math.max(Math.abs(kx), Math.abs(ky), 0.001);
      const newScale = clamp(props.scale * k, 0.02, 12);
      const key = this.ensureKeyAtPlayhead(layer);
      key.scale = newScale;
      layer.scale = newScale;
      /* keep the pivot pixel fixed while the box grows/shrinks */
      const newTw = g.tw * k, newTh = g.th * k;
      key.x = layer.x = clamp((g.cx + (0.5 - g.px) * g.tw - (0.5 - g.px) * newTw) / W, 0, 1);
      key.y = layer.y = clamp((g.cy + (0.5 - g.py) * g.th - (0.5 - g.py) * newTh) / H, 0, 1);
      this.commitChanges();
      return;
    }
    const nx = this.snapVal(clamp((px / W) + this._drag.dx, 0, 1), 0.01);
    const ny = this.snapVal(clamp((py / H) + this._drag.dy, 0, 1), 0.01);
    if (Math.abs(nx - (this._drag.nx != null ? this._drag.nx : nx)) < 1e-9 && Math.abs(ny - (this._drag.ny != null ? this._drag.ny : ny)) < 1e-9) return;
    this._drag.nx = nx;
    this._drag.ny = ny;
    if (this._recCapturing) {
      /* record a take: the playhead advances in real time, keys are written at
         30 Hz with only the enabled channels taken from the pointer */
      const now = performance.now();
      const t = this._recStartPlayhead + (now - this._recStart) / 1000;
      if (t - this._recLastSample >= 1 / 30) {
        this._recLastSample = t;
        this.setPlayhead(Math.min(t, this.durationSec));
        const key = this.ensureKeyAtPlayhead(layer);
        key.ease = "linear";
        const rec = this.recordedProps(layer, px, py);
        if (this._recChannels.pos) { key.x = rec.x; key.y = rec.y; }
        if (this._recChannels.size) key.scale = rec.scale;
        if (this._recChannels.rot) key.rotation = rec.rotation;
        this.commitChanges();
      }
      return;
    }
    const key = this.ensureKeyAtPlayhead(layer);  // auto-key only once a drag actually moves
    key.x = nx;
    key.y = ny;
    layer.x = nx;
    layer.y = ny;
    this.commitChanges();
  }

  onStageUp() {
    if (this._recCapturing) {
      this._recCapturing = false;
      this.updateStatus("Take recorded — REC is still armed: scrub back, pose, and record again, or press ■ STOP. Record Size/Rot separately for fast edits.");
    }
    this._drag = null;
    if (this.canvas) this.canvas.style.cursor = "crosshair";
  }

  onKeyDown(e) {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t.isContentEditable))) return;
    /* never hijack browser/OS chords (Ctrl+R reload, Ctrl+S, Ctrl/Alt+arrows) */
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const mult = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      /* nudge selected keyframes (time or position) — or the layer, 1 px */
      e.preventDefault();
      this.nudgeSelection(e.key, mult);
    } else if (e.key === "s" || e.key === "S") {
      /* split/cut at the playhead = keyframe the selected layer there */
      e.preventDefault();
      this.addKeyAtPlayhead();
    } else if (e.key === "r" || e.key === "R") {
      /* render window: R sets IN, R again sets OUT, R again clears */
      e.preventDefault();
      const at = Math.round(this.playhead * 1000) / 1000;
      if (this.renderIn == null) {
        this.renderIn = at;
        this.renderOut = null;
        this.updateStatus("Render IN set at " + fmtTimestamp(at) + " — move the playhead to the OUT point and press R (R before the IN point clears).");
      } else if (this.renderOut == null || this.renderOut <= this.renderIn) {
        if (at <= this.renderIn) {
          this.renderIn = null;
          this.renderOut = null;
          this.updateStatus("Render range cleared.");
        } else {
          this.renderOut = at;
          this.updateStatus("Render range " + fmtTimestamp(this.renderIn) + " → " + fmtTimestamp(this.renderOut) + " — only that window renders.");
        }
      } else {
        this.renderIn = null;
        this.renderOut = null;
        this.updateStatus("Render range cleared.");
      }
      this.commitChanges();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (this._selKeys && this._selKeys.size) {
        e.preventDefault();
        this._selKeys.forEach(k => {
          const [lid, t0] = String(k).split("@");
          const layer = this.layerById(lid);
          if (layer) layer.keys = (layer.keys || []).filter(kk => Math.abs(kk.t - Number(t0)) > 1e-6);
        });
        this._selKeys.clear();
        this.commitChanges();
        this.buildInspector();
        this.updateStatus(this._selKeys.size + " selected keyframe(s) deleted.");
      } else if (this.selectedId) {
        e.preventDefault();
        this.state.layers = this.state.layers.filter(l => l.id !== this.selectedId);
        this.selectedId = null;
        this.commitChanges();
        this.buildInspector();
        this.refreshLayerList();
        this.updateStatus("Layer deleted.");
      }
    } else if (e.key === "?") {
      /* shortcuts overlay (Shift+/ on US layouts) */
      e.preventDefault();
      this.toggleShortcuts();
    } else if (e.key === "Escape") {
      if (this.helpOverlay && this.helpOverlay.classList.contains("open")) {
        this.closeShortcuts();
        return;   /* Esc while help is open only dismisses help */
      }
      if (this._selKeys) this._selKeys.clear();
      this.selectedId = null;
      this.buildInspector();
      this.refreshLayerList();
      this.drawKeyStrip();
      this.drawStage();
    }
  }

  /* nudge selected keyframes (time with ← →, position with ↑ ↓) or the layer
     (1 px on the stage; Shift = 10x; key times land on the frame grid) */
  nudgeSelection(dir, mult) {
    const unit = 1 / (this.fps || 24);
    const [W, H] = this.stageSize();
    const pxX = 1 / Math.max(1, W);
    const pxY = 1 / Math.max(1, H);
    const horiz = dir === "ArrowLeft" || dir === "ArrowRight";
    const sign = (dir === "ArrowRight" || dir === "ArrowDown") ? 1 : -1;
    if (this._selKeys && this._selKeys.size) {
      const next = new Set();
      this._selKeys.forEach(sig => {
        const [lid, t0] = String(sig).split("@");
        const layer = this.layerById(lid);
        if (!layer) return;
        const key = (layer.keys || []).find(kk => Math.abs(kk.t - Number(t0)) < 1e-6);
        if (!key) return;
        if (horiz) {
          key.t = Math.round(clamp(key.t + sign * unit * mult, 0, this.durationSec) * 1000) / 1000;
        } else {
          key.y = this.snapVal(clamp((key.y != null ? key.y : 0.5) + sign * pxY * mult, 0, 1), 0.01);
        }
        next.add(layer.id + "@" + key.t);
      });
      this._selKeys = next;
      this.commitChanges();
      this.buildInspector();
      this.updateStatus(this._selKeys.size + " keyframe(s) nudged — Del removes, Shift+click to multi-select.");
      return;
    }
    const layer = this.selectedId ? this.layerById(this.selectedId) : null;
    if (!layer) {
      this.updateStatus("Select a layer or keyframe first, then use the arrow keys.");
      return;
    }
    if (horiz) layer.x = this.snapVal(clamp(layer.x + sign * pxX * mult, 0, 1), 0.01);
    else layer.y = this.snapVal(clamp(layer.y + sign * pxY * mult, 0, 1), 0.01);
    this.commitChanges();
    this.buildInspector();
    this.updateStatus("Layer moved — arrows nudge 1 px (Shift = 10 px).");
  }

  /* ---------------- playback ---------------- */
  togglePlay() {
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? "⏸" : "▶";
    this.playBtn.classList.toggle("active", this.playing);
    if (this.playing) {
      if (this.playhead >= this.durationSec - 0.02) this.setPlayhead(0);
      this._lastTick = performance.now();
      const tick = now => {
        if (!this.playing) return;
        const dt = (now - this._lastTick) / 1000;
        this._lastTick = now;
        this.setPlayhead(this.playhead + dt);
        if (this.playhead >= this.durationSec - 1e-4) {
          this.togglePlay();
          return;
        }
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    } else {
      if (this.audioEl && !this.audioEl.paused) this.audioEl.pause();
    }
  }

  /* ---------------- audio ---------------- */
  pickAudio() {
    this.fileInput.accept = "audio/*";
    this.fileInput.onchange = () => {
      const f = this.fileInput.files && this.fileInput.files[0];
      if (f) this.importAudio(f);
      this.fileInput.value = "";
    };
    this.fileInput.click();
  }

  async importAudio(file) {
    try {
      const body = new FormData();
      body.append("image", file);
      const resp = await api.fetchApi("/upload/image", { method: "POST", body });
      if (resp.status !== 200) return;
      const data = await resp.json();
      const sub = data.subfolder || "";
      const path = sub ? sub + "/" + data.name : data.name;
      this.state.audio.file = path;
      this.state.audio.trim_start = 0;
      this.state.audio.trim_end = null;
      this.commitChanges();
      this.loadAudioPeaks(path);
      this.buildAudioPanel();
      this.audioFileLabel.textContent = file.name;
      this.audioFileLabel.title = path;
      this.updateStatus("Audio loaded — scrub with the playhead or the seek bar.");
    } catch (err) {
      console.error("[ChaoticPuppet] audio import failed", err);
    }
  }

  async loadAudioPeaks(path) {
    this._peaks = null;
    this._audioReady = false;
    try {
      const resp = await api.fetchApi(this.viewUrl(path).replace(/^https?:\/\/[^/]+/, ""));
      if (!resp.ok) throw new Error("bad status");
      const buf = await resp.arrayBuffer();
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await actx.decodeAudioData(buf);
      this._audioBuf = decoded;
      const data = decoded.getChannelData(0);
      const peaks = [];
      const n = 200;
      const step = Math.max(1, Math.floor(data.length / n));
      for (let i = 0; i < n; i++) {
        let max = 0;
        for (let j = 0; j < step; j++) {
          const idx = Math.min(data.length - 1, i * step + j);
          max = Math.max(max, Math.abs(data[idx]));
        }
        peaks.push(max);
      }
      this._peaks = peaks;
      this._audioReady = true;
      this.drawAudioWave();
    } catch (err) {
      console.error("[ChaoticPuppet] audio decode failed", err);
      this.updateStatus("Audio decode failed — check the browser console.");
    }
  }

  drawAudioWave() {
    if (!this.audioWave || !this.audioCtx) return;
    const ctx = this.audioCtx;
    const w = this.audioWave.clientWidth || 800;
    const h = 40;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#101214";
    ctx.fillRect(0, 0, w, h);
    const peaks = this._peaks || [];
    ctx.fillStyle = "#2f7a50";
    if (peaks.length) {
      peaks.forEach((p, i) => {
        const x = (i / peaks.length) * w;
        const ph = Math.max(1, p * (h - 6));
        ctx.fillRect(x, h / 2 - ph / 2, Math.max(1, w / peaks.length - 1), ph);
      });
    } else {
      ctx.fillStyle = "#2a2a2a";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.state.audio.file ? "decoding…" : "no audio — pick one to scrub", w / 2, h / 2);
    }
    /* playhead */
    const x = (this.playhead / this.durationSec) * w;
    ctx.strokeStyle = "#ff5a5a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  audioMediaStart() { return Number(this.state.audio.trim_start) || 0; }
  audioMediaEnd() {
    const d = this._audioBuf ? this._audioBuf.duration : 0;
    if (this.state.audio.trim_end != null) return Number(this.state.audio.trim_end);
    return d || 9999;
  }

  syncAudioToPlayhead() {
    if (!this.state.audio.file || !this.audioEl || !this._audioReady) return;
    if (this.audioEl.paused) {
      const t = clamp(this.audioMediaStart() + this.playhead, this.audioMediaStart(), this.audioMediaEnd());
      if (this.audioEl.readyState >= 1 && Math.abs(this.audioEl.currentTime - t) > 0.06) this.audioEl.currentTime = t;
    }
    this.audioSeek.value = String(Math.max(0, this.playhead));
    this.audioSeek.max = String(this.durationSec);
    this.audioTime.textContent = fmtTimestamp(this.playhead) + " / " + fmtTimestamp(this.durationSec);
  }

  toggleAudioPlay() {
    if (!this.state.audio.file) return;
    if (!this.audioEl.src) this.audioEl.src = this.viewUrl(this.state.audio.file);
    if (this.audioEl.paused) {
      this.audioEl.currentTime = clamp(this.audioMediaStart() + this.playhead, this.audioMediaStart(), this.audioMediaEnd());
      this.audioEl.play().catch(() => {});
    } else {
      this.audioEl.pause();
    }
  }

  onAudioTime() {
    const t = this.audioEl.currentTime;
    const end = this.audioMediaEnd();
    if (t >= end - 0.04) {
      this.audioEl.pause();
      this.audioEl.currentTime = this.audioMediaStart();
      this.setPlayhead(0);
      return;
    }
    if (this.playing) return; // manual playhead advance owns the clock
    this.setPlayhead(Math.max(0, t - this.audioMediaStart()));
  }

  onAudioSeek() {
    const t = Number(this.audioSeek.value) || 0;
    this.setPlayhead(clamp(t, 0, this.durationSec));
  }

  buildAudioPanel() {
    this.audioFileLabel.textContent = this.state.audio.file ? this.state.audio.file.split("/").pop() : "no audio";
    this.audioFileLabel.title = this.state.audio.file;
    this.drawAudioWave();
  }

  /* ---------------- layers list + inspector ---------------- */
  refreshLayerList() {
    if (!this.layersList) return;
    this.layersList.innerHTML = "";
    if (this.state.layers.length === 0) {
      const hint = document.createElement("div");
      hint.className = "pup-keystrip-hint";
      hint.textContent = "No layers — import an image/video or add text. Layer order = front-to-back (top row draws on top).";
      this.layersList.appendChild(hint);
      return;
    }
    this.state.layers.forEach(layer => {
      const row = document.createElement("div");
      row.className = "pup-layer-row" + (this.selectedId === layer.id ? " sel" : "");
      row.draggable = true;
      row.addEventListener("dragstart", ev => {
        this._dragLayerId = layer.id;
        if (ev.dataTransfer) ev.dataTransfer.setData("text/pup-layer", layer.id);
      });
      row.addEventListener("dragover", ev => { ev.preventDefault(); row.classList.add("dragover"); });
      row.addEventListener("dragleave", () => row.classList.remove("dragover"));
      row.addEventListener("drop", ev => {
        ev.preventDefault();
        row.classList.remove("dragover");
        const id = (ev.dataTransfer && ev.dataTransfer.getData("text/pup-layer")) || this._dragLayerId;
        if (id && id !== layer.id) this.reorderLayer(id, this.state.layers.indexOf(layer));
        this.clearDragOver();
      });
      row.addEventListener("dragend", () => this.clearDragOver());
      const handle = document.createElement("span");
      handle.className = "pup-drag-handle";
      handle.textContent = "⋮⋮";
      handle.title = "drag to reorder (top = front)";
      const thumb = document.createElement("img");
      thumb.className = "pup-layer-thumb";
      thumb.alt = "";
      if (layer.type === "text") {
        thumb.style.display = "flex";
        thumb.style.alignItems = "center";
        thumb.style.justifyContent = "center";
        thumb.style.fontSize = "12px";
        thumb.style.color = layer.color;
        thumb.style.background = "#111";
        thumb.src = "";
        thumb.textContent = "T";
      } else if (layer.file) {
        thumb.src = layer.type === "image" && this._imgCache[layer.id]
          ? this._imgCache[layer.id].src
          : this.viewUrl(layer.file);
      }
      const name = document.createElement("span");
      name.className = "pup-layer-name";
      name.textContent = layer.name || (layer.type === "text" ? (layer.text || "Text").slice(0, 24) : (layer.file || "").split("/").pop());
      name.title = layer.file || "";
      const type = document.createElement("span");
      type.className = "pup-layer-type";
      const speedBadge = layer.speed && layer.speed !== 1 ? ` · ×${layer.speed}` : "";
      type.textContent = layer.type + (layer.keys && layer.keys.length ? ` · ${layer.keys.length}k` : "") + speedBadge;
      const opacity = document.createElement("input");
      opacity.className = "pup-input";
      opacity.type = "range";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = "0.05";
      opacity.value = layer.opacity;
      opacity.style.width = "56px";
      opacity.style.accentColor = "#4aa47f";
      opacity.addEventListener("input", () => {
        this.setProp(layer, "opacity", Number(opacity.value));
        opacity.title = "Opacity: " + opacity.value;
      });
      const front = document.createElement("button");
      front.className = "pup-btn";
      front.textContent = "⤒";
      front.title = "Bring to front (draws on top of everything)";
      front.addEventListener("click", ev => { ev.stopPropagation(); this.reorderLayer(layer.id, 0); });
      const up = document.createElement("button");
      up.className = "pup-btn";
      up.textContent = "▲";
      up.title = "Move layer toward the top (draws in front)";
      up.addEventListener("click", ev => {
        ev.stopPropagation();
        const i = this.state.layers.indexOf(layer);
        if (i > 0) this.reorderLayer(layer.id, i - 1);
      });
      const down = document.createElement("button");
      down.className = "pup-btn";
      down.textContent = "▼";
      down.title = "Move layer toward the back";
      down.addEventListener("click", ev => {
        ev.stopPropagation();
        const i = this.state.layers.indexOf(layer);
        if (i < this.state.layers.length - 1) this.reorderLayer(layer.id, i + 1);
      });
      const back = document.createElement("button");
      back.className = "pup-btn";
      back.textContent = "⤓";
      back.title = "Send to back (draws behind everything)";
      back.addEventListener("click", ev => { ev.stopPropagation(); this.reorderLayer(layer.id, this.state.layers.length - 1); });
      const del = document.createElement("button");
      del.className = "pup-btn danger";
      del.textContent = "✕";
      del.addEventListener("click", ev => {
        ev.stopPropagation();
        this.state.layers = this.state.layers.filter(l => l.id !== layer.id);
        if (this.selectedId === layer.id) { this.selectedId = null; }
        this.commitChanges();
        this.buildInspector();
      });
      row.appendChild(handle);
      row.appendChild(thumb);
      row.appendChild(name);
      row.appendChild(type);
      row.appendChild(opacity);
      row.appendChild(front);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(back);
      row.appendChild(del);
      row.addEventListener("click", () => {
        this.selectedId = layer.id;
        this.refreshLayerList();
        this.buildInspector();
        this.drawStage();
      });
      this.layersList.appendChild(row);
    });
  }

  buildInspector() {
    const ins = this.inspector;
    ins.innerHTML = "";
    ins.style.display = "none";
    const layer = this.selectedId ? this.layerById(this.selectedId) : null;
    if (!layer) return;
    ins.style.display = "flex";

    const head = document.createElement("div");
    head.className = "pup-panel-title";
    const keyHere = this.keyAtPlayhead(layer);
    const keyInfo = keyHere ? "key @ playhead" : "no key @ playhead";
    head.innerHTML = `<span>${escapeHtml(layer.type)} — ${keyInfo}</span>`;
    ins.appendChild(head);

    if (keyHere) {
      const easeRow = document.createElement("div");
      easeRow.className = "pup-row";
      const easeLab = document.createElement("span");
      easeLab.className = "pup-label";
      easeLab.style.width = "56px";
      easeLab.textContent = "Ease";
      const easeSel = document.createElement("select");
      easeSel.className = "pup-input";
      EASE_MODES.forEach(m => {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        easeSel.appendChild(o);
      });
      easeSel.value = normalizeEase(keyHere.ease);
      easeSel.style.color = EASE_COLORS[normalizeEase(keyHere.ease)] || "#e8e8e8";
      easeSel.addEventListener("change", () => {
        keyHere.ease = normalizeEase(easeSel.value);
        this.commitChanges();  // commitChanges re-draws the strip
        this.buildInspector();
      });
      const easeHint = document.createElement("span");
      easeHint.className = "pup-label";
      easeHint.style.color = "#666";
      easeHint.textContent = "outgoing motion toward the next key";
      easeRow.appendChild(easeLab);
      easeRow.appendChild(easeSel);
      easeRow.appendChild(easeHint);
      ins.appendChild(easeRow);
    }

    if (layer.type === "text") {
      const textRow = document.createElement("div");
      textRow.className = "pup-row";
      textRow.innerHTML = '<span class="pup-label">Text</span>';
      const textIn = document.createElement("input");
      textIn.className = "pup-input";
      textIn.type = "text";
      textIn.value = layer.text;
      textIn.placeholder = "Title text…";
      textIn.addEventListener("input", () => { layer.text = textIn.value; this.commitChanges(); });
      textRow.appendChild(textIn);
      ins.appendChild(textRow);

      const styleRow = document.createElement("div");
      styleRow.className = "pup-row";
      const colorIn = document.createElement("input");
      colorIn.type = "color";
      colorIn.value = /^#[0-9a-fA-F]{6}$/.test(layer.color) ? layer.color : "#ffffff";
      colorIn.addEventListener("input", () => { layer.color = colorIn.value; this.commitChanges(); });
      const sizeLab = document.createElement("span");
      sizeLab.className = "pup-label";
      sizeLab.textContent = "Size";
      const sizeIn = document.createElement("input");
      sizeIn.className = "pup-input";
      sizeIn.type = "number";
      sizeIn.step = "0.01";
      sizeIn.value = layer.font_size;
      sizeIn.addEventListener("change", () => { layer.font_size = Math.max(0.01, Number(sizeIn.value) || 0.06); this.commitChanges(); });
      styleRow.appendChild(colorIn);
      styleRow.appendChild(sizeLab);
      styleRow.appendChild(sizeIn);
      ins.appendChild(styleRow);
    } else {
      const fileRow = document.createElement("div");
      fileRow.className = "pup-row";
      fileRow.innerHTML = `<span class="pup-label" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(layer.file)}">${escapeHtml(layer.file || "no file")}</span>`;
      ins.appendChild(fileRow);
    }
    if (layer.type === "video") {
      const trimRow = document.createElement("div");
      trimRow.className = "pup-row";
      trimRow.innerHTML = '<span class="pup-label">Trim in</span>';
      const tin = document.createElement("input");
      tin.className = "pup-input";
      tin.type = "number";
      tin.step = "0.1";
      tin.value = layer.trim_start;
      tin.addEventListener("change", () => { layer.trim_start = Math.max(0, Number(tin.value) || 0); this.commitChanges(); });
      trimRow.appendChild(tin);
      ins.appendChild(trimRow);
    }

    /* per-layer speed — a multi-track time-warp, not keyframed */
    const speedRow = document.createElement("div");
    speedRow.className = "pup-row";
    const speedLab = document.createElement("span");
    speedLab.className = "pup-label";
    speedLab.style.width = "56px";
    speedLab.textContent = "Speed ×";
    const spIn = document.createElement("input");
    spIn.className = "pup-input";
    spIn.type = "number";
    spIn.step = "0.05";
    spIn.min = "0.05";
    spIn.max = "4";
    spIn.value = layer.speed || 1;
    spIn.addEventListener("change", () => {
      const v = Number(spIn.value);
      layer.speed = isFinite(v) ? clamp(v, 0.05, 4) : 1;
      this.commitChanges();
      this.buildInspector();
    });
    const spHint = document.createElement("span");
    spHint.className = "pup-label";
    spHint.style.color = "#666";
    spHint.textContent = "layer time-warp — 2× finishes the animation in half the project time";
    speedRow.appendChild(speedLab);
    speedRow.appendChild(spIn);
    speedRow.appendChild(spHint);
    ins.appendChild(speedRow);

    /* transform props — auto-keyed */
    const rows = [
      ["X", "x", v => clamp(Number(v), 0, 1), v => v.toFixed(3)],
      ["Y", "y", v => clamp(Number(v), 0, 1), v => v.toFixed(3)],
      ["Scale", "scale", v => Math.max(0.01, Number(v)), v => v.toFixed(2)],
      ["Rotation", "rotation", v => Number(v), v => v.toFixed(1)],
      ["Opacity", "opacity", v => clamp(Number(v), 0, 1), v => v.toFixed(2)],
    ];
    rows.forEach(([label, prop, parse, fmt]) => {
      const row = document.createElement("div");
      row.className = "pup-row";
      const lab = document.createElement("span");
      lab.className = "pup-label";
      lab.style.width = "56px";
      lab.textContent = label;
      const input = document.createElement("input");
      input.className = "pup-input";
      input.type = "number";
      input.step = prop === "scale" ? "0.05" : prop === "rotation" ? "5" : "0.01";
      const current = propsAt(layer, this.playhead) || layer;
      input.value = fmt(current[prop]);
      input.addEventListener("change", () => { this.setProp(layer, prop, parse(input.value)); this.buildInspector(); });
      input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); });
      row.appendChild(lab);
      row.appendChild(input);
      const atKey = document.createElement("span");
      atKey.className = "pup-label";
      atKey.style.color = "#666";
      atKey.textContent = this.keyAtPlayhead(layer) ? "edits key @ playhead" : "creates key @ playhead";
      row.appendChild(atKey);
      ins.appendChild(row);
    });

    const hint = document.createElement("div");
    hint.className = "pup-hint";
    hint.textContent = "Set the playhead where you want a pose, press Key (or just edit/drag — it auto-keys), move the playhead, pose again. Between keys, motion is interpolated. The layer is visible only between its first and last keyframe.";
    ins.appendChild(hint);
  }

  /* ---------------- file import ---------------- */
  pickFiles(kind) {
    this.fileInput.accept = kind === "image" ? "image/*" : "video/*";
    this.fileInput.onchange = () => {
      const files = Array.from(this.fileInput.files || []);
      files.forEach(f => this.importSprite(f, kind));
      this.fileInput.value = "";
    };
    this.fileInput.click();
  }

  pickBackground() {
    this.fileInput.accept = "image/*";
    this.fileInput.onchange = () => {
      const f = this.fileInput.files && this.fileInput.files[0];
      if (f) this.importBackground(f);
      this.fileInput.value = "";
    };
    this.fileInput.click();
  }

  async importBackground(file) {
    try {
      const path = await this.upload(file);
      if (!path) return;
      this.state.bg = { type: "image", file: path };
      const img = new Image();
      img.onload = () => { this._imgCache["bg:" + path] = img; this.commitChanges(); };
      img.src = this.viewUrl(path);
      this.commitChanges();
      this.updateStatus("Background set — press ● Key BG at playhead to make it change over time.");
    } catch (err) {
      console.error("[ChaoticPuppet] bg import failed", err);
    }
  }

  async importSprite(file, kind) {
    try {
      const path = await this.upload(file);
      if (!path) return;
      this.addToLib(path, file.name, kind);
      this.addSpriteLayer(path, file.name, kind, 0.5, 0.5);
      this.refreshLibPanel();
      this.updateStatus(`Added ${kind} layer (also saved to the sprite library). Pose it, press Key, move the playhead, pose again.`);
    } catch (err) {
      console.error("[ChaoticPuppet] import failed", err);
      this.updateStatus("Import failed: " + (err && err.message ? err.message : err));
    }
  }

  async importCrops() {
    try {
      const resp = await api.fetchApi("/chaotic_h3/crops");
      if (resp.status !== 200) {
        this.updateStatus("Could not load exported crops (" + resp.status + ").");
        return;
      }
      const data = await resp.json();
      const crops = (data && data.crops) || [];
      if (!crops.length) {
        this.updateStatus("No exported crops found — copy crops in Chaotic H3 Video Edit, then press ⤴ Export crops there.");
        return;
      }
      let added = 0;
      let skipped = 0;
      for (const c of crops) {
        if (!c || !c.file) continue;
        if (this.state.layers.some(l => l.file === c.file)) {
          skipped++; // already on the stage — never duplicate a layer
          continue;
        }
        this.addToLib(c.file, c.note ? c.note : "crop @" + (c.at != null ? c.at : 0) + "s", "image");
        this.addSpriteLayer(c.file, c.note ? c.note : "crop @" + (c.at != null ? c.at : 0) + "s", "image", 0.5, 0.5);
        added++;
      }
      if (added) {
        this.commitChanges();
        this.refreshLayerList();
        this.buildInspector();
      }
      const msg = skipped > 0
        ? "Imported " + added + " crop(s) — " + skipped + " already on the stage, skipped."
        : "Imported " + added + " crop(s) as image layers — pose them on the stage (opacity = reference strength).";
      this.updateStatus(msg);
    } catch (err) {
      this.updateStatus("Import crops failed: " + (err && err.message ? err.message : err));
    }
  }

  addTextLayer() {
    const layer = this.normalizeLayer({
      id: uid("layer"),
      type: "text",
      name: "Text",
      text: "TITLE",
      color: "#ffffff",
      font_size: 0.06,
      x: 0.5,
      y: 0.5,
      scale: 1,
      rotation: 0,
      opacity: 1,
      keys: [],
    }, this.state.layers.length);
    this.state.layers.unshift(layer);
    this.selectedId = layer.id;
    this.commitChanges();
    this.refreshLayerList();
    this.buildInspector();
    this.updateStatus("Text layer added — type in the inspector.");
  }

  async upload(file) {
    const body = new FormData();
    body.append("image", file);
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (resp.status !== 200) return "";
    const data = await resp.json();
    const sub = data.subfolder || "";
    return sub ? sub + "/" + data.name : data.name;
  }

  onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const dt = e.dataTransfer;
    const libFile = dt ? dt.getData("text/pup-lib") : "";
    if (libFile) {
      const entry = this.state.lib.find(x => x.file === libFile);
      if (entry) {
        let x = 0.5, y = 0.5;
        if (this.canvas) {
          const rect = this.canvas.getBoundingClientRect();
          if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
            x = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
            y = clamp((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
          }
        }
        this.addSpriteLayer(entry.file, entry.name || "sprite", entry.kind || "image", x, y);
        this.updateStatus("Library sprite added as a layer — drag it to pose.");
        return;
      }
    }
    const files = Array.from((dt && dt.files) || []);
    files.forEach(f => {
      const kind = f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "image";
      if (kind === "audio") this.importAudio(f);
      else this.importSprite(f, kind);
    });
  }

  /* ---------------- project save / load ---------------- */
  async saveProject() {
    const payload = JSON.stringify({
      version: 1,
      fps: this.fps,
      duration_sec: this.durationSec,
      ...JSON.parse(this.serialize()),
    }, null, 2);
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: "chaotic_h3_mockup.json",
          types: [{ description: "Chaotic H3 Mockup", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(payload);
        await writable.close();
        this.updateStatus("Mockup project saved.");
      } else {
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "chaotic_h3_mockup.json";
        a.click();
        URL.revokeObjectURL(url);
        this.updateStatus("Mockup project downloaded.");
      }
    } catch (err) {
      if (err.name !== "AbortError") console.error("[ChaoticPuppet] save failed", err);
    }
  }

  async loadProject() {
    const apply = text => {
      try {
        const data = JSON.parse(text);
        let raw = data;
        if (data && typeof data === "object" && data.scene && typeof data.scene === "object") raw = data.scene;
        if (typeof raw !== "object" || raw === null || !Array.isArray(raw.layers)) {
          this.updateStatus("Load failed: not a Chaotic H3 Mockup file.");
          return;
        }
        if (raw.fps && this.fpsWidget) this.fpsWidget.value = parseInt(raw.fps, 10) || 24;
        if (raw.duration_sec) this.durationSec = parseFloat(raw.duration_sec) || 6;
        this.selectedId = null;
        this._applyState(raw, { applySize: true });
        this.refreshLayerList();
        this.buildInspector();
        this.buildAudioPanel();
        this.commitChanges();
        this.refreshAspectButtons();
        this._lastWidth = 0;
        this.checkResize();
        this.recomputeSize();
        this.updateStatus("Mockup project loaded.");
      } catch (err) {
        this.updateStatus("Load failed: " + (err && err.message ? err.message : err));
      }
    };
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "Chaotic H3 Mockup", accept: { "application/json": [".json"] } }],
          multiple: false,
        });
        const file = await handle.getFile();
        apply(await file.text());
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = ev => apply(ev.target.result);
          reader.readAsText(file);
        };
        input.click();
      }
    } catch (err) {
      if (err.name !== "AbortError") console.error("[ChaoticPuppet] load failed", err);
    }
  }

  recomputeSize() {
    if (this.domWidget && this.domWidget.computeSize) this.domWidget.computeSize();
    if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
  }
}

/* ------------------------------------------------------------------ */
/* Extension registration                                             */
/* ------------------------------------------------------------------ */
app.registerExtension({
  name: "Chaotic.MinimaxH3MockupEditor",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "ChaoticH3MockupEditor") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      const container = document.createElement("div");
      container.style.width = "100%";
      container.style.height = "100%";

      const widget = this.addDOMWidget("chaotic_mockup", "chaotic_mockup", container, {
        getValue: () => "",
        setValue: () => {},
      });

      const self = this;
      widget.computeSize = function () {
        const width = Math.max(700, (self.size && self.size[0]) || 1100);
        const inspectorH = self._puppetEditor && self._puppetEditor.inspector.style.display !== "none" ? 330 : 0;
        const aspect = (self._puppetEditor && typeof self._puppetEditor.stageAspect === "function")
          ? self._puppetEditor.stageAspect()
          : STAGE_ASPECT;
        return [Math.max(10, width - 24), Math.round(width / aspect) + 220 + inspectorH];
      };

      setTimeout(() => {
        try {
          self._puppetEditor = new ChaoticPuppetEditor(self, container, widget);
          if (self.size && self.size[0] < 700) self.size = [1100, 760];
          container.style.height = "100%";
          widget.computeSize();
          self.setDirtyCanvas(true, true);
        } catch (err) {
          console.error("[ChaoticPuppet] init failed", err);
        }
      }, 0);

      return r;
    };
  },
});
