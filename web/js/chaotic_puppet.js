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
 *   - keys       [{t, x, y, scale, rotation, opacity}] — layer is visible only
 *                inside [first.t, last.t] and interpolates linearly; a layer
 *                without keys is static and always visible
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
const KEYSTRIP_H = 26;
const AUDIO_H = 84;

const CSS = `
.pup-wrap{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;color:#dcdcdc;font-size:11px}
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
.pup-keystrip-hint{font-size:10px;color:#666;padding:2px 2px}
.pup-hint{font-size:10px;color:#8a8a8a;line-height:1.5}
.pup-drop{border:1.5px dashed #444;border-radius:6px;padding:8px;text-align:center;color:#777;font-size:10px;cursor:pointer;transition:all .15s}
.pup-drop.drag-over{border-color:#4aa47f;background:rgba(74,164,127,.08);color:#7ee2a8}
.pup-audio{display:flex;flex-direction:column;gap:5px}
.pup-wave{background:#101214;border:1px solid #1c1c1c;border-radius:5px;display:block;width:100%;cursor:pointer;flex:none}
.pup-statusline{font-size:10px;color:#9a9a9a;min-height:14px}
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

function propsAt(layer, t) {
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
  return {
    x: lerp(before.x, after.x, f),
    y: lerp(before.y, after.y, f),
    scale: lerp(before.scale, after.scale, f),
    rotation: lerp(before.rotation, after.rotation, f),
    opacity: lerp(before.opacity, after.opacity, f),
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

    this.state = { bg: { type: "color", color: [16, 18, 22] }, layers: [], audio: { file: "", trim_start: 0, trim_end: null } };
    this.playhead = 0;
    this.playing = false;
    this.selectedId = null;
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
    };
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
      keys: Array.isArray(l.keys)
        ? l.keys.map(k => ({
            t: Math.max(0, Number(k.t) || 0),
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
      aspect: this.stateAspectLabel(),
      bg: this.state.bg,
      layers: this.state.layers.map(l => ({
        id: l.id, type: l.type, name: l.name, file: l.file, fit: l.fit,
        x: l.x, y: l.y, scale: l.scale, rotation: l.rotation, opacity: l.opacity,
        text: l.text, color: l.color, font_size: l.font_size, trim_start: l.trim_start,
        keys: l.keys.map(k => ({ t: k.t, x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity })),
      })),
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
    const btnText = this.btn("T Text", () => this.addTextLayer());
    const btnSave = this.btn("Save", () => this.saveProject());
    const btnLoad = this.btn("Load", () => this.loadProject());
    const btnPlay = this.btn("▶", () => this.togglePlay());
    btnPlay.className = "pup-btn";
    this.playBtn = btnPlay;
    const btnKey = this.btn("Key", () => this.addKeyAtPlayhead());
    const btnDelKey = this.btn("Del Key", () => this.delKeyAtPlayhead());
    const btnBg = this.btn("Bg", () => this.pickBackground());
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
    toolbar.append(btnImg, btnVid, btnText, btnBg, aspectLab, ...aspectBtns, aspectDims, btnKey, btnDelKey, btnPlay, btnSave, btnLoad, btnClear);
    this.wrapper.appendChild(toolbar);

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
    this.wrapper.appendChild(this.stageBox);

    /* keyframe strip */
    this.keyCanvas = document.createElement("canvas");
    this.keyCanvas.className = "pup-keystrip";
    this.keyCtx = this.keyCanvas.getContext("2d");
    this.wrapper.appendChild(this.keyCanvas);

    /* layers panel */
    this.layersPanel = document.createElement("div");
    this.layersPanel.className = "pup-panel";
    const layersTitle = document.createElement("div");
    layersTitle.className = "pup-panel-title";
    layersTitle.innerHTML = "<span>Layers (top first)</span><span style='color:#666'>drag the stage to move the selected layer</span>";
    this.layersList = document.createElement("div");
    this.layersList.className = "pup-row";
    this.layersList.style.flexDirection = "column";
    this.layersList.style.alignItems = "stretch";
    this.layersPanel.appendChild(layersTitle);
    this.layersPanel.appendChild(this.layersList);
    this.wrapper.appendChild(this.layersPanel);

    /* inspector */
    this.inspector = document.createElement("div");
    this.inspector.className = "pup-panel";
    this.inspector.style.display = "none";
    this.wrapper.appendChild(this.inspector);

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
    this.wrapper.appendChild(this.audioPanel);

    /* status */
    this.statusLine = document.createElement("div");
    this.statusLine.className = "pup-statusline";
    this.wrapper.appendChild(this.statusLine);

    this.container.appendChild(this.wrapper);

    /* interactions */
    this.canvas.addEventListener("mousedown", e => this.onStageDown(e));
    this.canvas.addEventListener("mousemove", e => this.onStageMove(e));
    this.canvas.addEventListener("mouseup", e => this.onStageUp(e));
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
      this.keyCanvas.height = Math.round(KEYSTRIP_H * scale);
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
    const bg = this.state.bg || {};
    if (bg.type === "image" && bg.file) {
      const img = this._imgCache["__bg__"];
      if (img) {
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

  drawLayer(ctx, layer, W, H) {
    const props = propsAt(layer, this.playhead);
    if (!props || props.opacity <= 0.001) return;
    const [sw, sh] = this.spriteSize(layer);
    const s = Math.min(W / Math.max(1, sw), H / Math.max(1, sh)) * props.scale;
    const tw = sw * s, th = sh * s;
    const cx = props.x * W, cy = props.y * H;
    const isSel = this.selectedId === layer.id;
    ctx.save();
    ctx.translate(cx, cy);
    if (Math.abs(props.rotation) > 0.1) ctx.rotate(-props.rotation * Math.PI / 180);
    ctx.globalAlpha = props.opacity;

    if (layer.type === "image") {
      const img = this._imgCache[layer.id];
      if (img) ctx.drawImage(img, -tw / 2, -th / 2, tw, th);
    } else if (layer.type === "video") {
      const v = this._videoEls[layer.id];
      if (v) {
        const keys = layer.keys;
        const t0 = keys.length ? keys[0].t : 0;
        const mediaT = layer.trim_start + (this.playhead - t0);
        if (v.readyState >= 1 && Math.abs(v.currentTime - mediaT) > 0.08) v.currentTime = mediaT;
        ctx.drawImage(v, -tw / 2, -th / 2, tw, th);
      } else {
        this.drawPlaceholder(ctx, tw, th, layer);
      }
    } else if (layer.type === "text") {
      const px = Math.max(8, layer.font_size * W);
      ctx.font = `600 ${px}px ui-sans-serif, system-ui, sans-serif`;
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
      ctx.strokeStyle = "rgba(74,164,127,.9)";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(cx - tw / 2 - 2, cy - th / 2 - 2, tw + 4, th + 4);
      ctx.setLineDash([]);
    }
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

  /* ---------------- keyframe strip ---------------- */
  drawKeyStrip() {
    if (!this.keyCanvas || !this.keyCtx) return;
    const ctx = this.keyCtx;
    const w = this.keyCanvas.clientWidth || 800;
    const h = KEYSTRIP_H;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, w, h);
    const dur = this.durationSec;
    /* ruler ticks */
    ctx.fillStyle = "#555";
    const step = dur <= 10 ? 1 : dur <= 30 ? 5 : 10;
    for (let t = 0; t <= dur + 1e-6; t += step) {
      const x = (t / dur) * w;
      ctx.fillRect(x, h - 6, 1, 6);
      ctx.fillStyle = "#9a9a9a";
      ctx.font = "8px ui-monospace, monospace";
      ctx.fillText(t.toFixed(0) + "s", x + 2, h - 8);
      ctx.fillStyle = "#555";
    }
    /* key markers (selected layer prominent) */
    const sel = this.selectedId ? this.layerById(this.selectedId) : null;
    this.state.layers.forEach(layer => {
      const isSel = sel && sel.id === layer.id;
      (layer.keys || []).forEach(k => {
        const x = (k.t / dur) * w;
        ctx.fillStyle = isSel ? "#4aa47f" : "#3a3a3a";
        ctx.beginPath();
        ctx.arc(x, h / 2, isSel ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
      });
    });
    if (sel && sel.keys && sel.keys.length) {
      const atPlayhead = sel.keys.some(k => Math.abs(k.t - this.playhead) < 0.02);
      if (atPlayhead) {
        const x = (this.playhead / dur) * w;
        ctx.fillStyle = "#ffd479";
        ctx.beginPath();
        ctx.arc(x, h / 2, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    /* playhead */
    const x = (this.playhead / dur) * w;
    ctx.strokeStyle = "#ff5a5a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  onKeyStripDown(e) {
    const rect = this.keyCanvas.getBoundingClientRect();
    const w = this.keyCanvas.clientWidth || 1;
    const t = clamp(((e.clientX - rect.left) / w) * this.durationSec, 0, this.durationSec);
    this.setPlayhead(t);
    const grab = () => {
      const onMove = ev => {
        const r = this.keyCanvas.getBoundingClientRect();
        const ww = this.keyCanvas.clientWidth || 1;
        this.setPlayhead(clamp(((ev.clientX - r.left) / ww) * this.durationSec, 0, this.durationSec));
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

  /* ---------------- keyframes ---------------- */
  keyAtPlayhead(layer) {
    if (!layer) return null;
    return (layer.keys || []).find(k => Math.abs(k.t - this.playhead) < 0.02) || null;
  }

  ensureKeyAtPlayhead(layer) {
    if (!layer) return null;
    if (!layer.keys) layer.keys = [];
    const existing = this.keyAtPlayhead(layer);
    if (existing) return existing;
    const cur = propsAt(layer, this.playhead) || { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation, opacity: layer.opacity };
    const key = { t: Math.round(this.playhead * 1000) / 1000, x: cur.x, y: cur.y, scale: cur.scale, rotation: cur.rotation, opacity: cur.opacity };
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
      const [tw, th] = this.fittedSize(layer, props, W, H);
      const cx = props.x * W, cy = props.y * H;
      if (Math.abs(px - cx) <= tw / 2 + 4 && Math.abs(py - cy) <= th / 2 + 4) return layer;
    }
    return null;
  }

  onStageDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.clientWidth / Math.max(1, rect.width);
    const scaleY = this.canvas.clientHeight / Math.max(1, rect.height);
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const layer = this.hitLayerAt(px, py);
    if (layer) {
      this.selectedId = layer.id;
      this.buildInspector();
      this.refreshLayerList();
      this.drawStage();
      /* anchor to the layer's DRAWN position (interpolated), not the static default */
      const props = propsAt(layer, this.playhead) || { x: layer.x, y: layer.y };
      const [W, H] = this.stageSize();
      this._drag = { layerId: layer.id, startX: px, startY: py, dx: props.x - px / W, dy: props.y - py / H };
    } else {
      this.selectedId = null;
      this.buildInspector();
      this.refreshLayerList();
      this.drawStage();
    }
  }

  onStageMove(e) {
    if (!this._drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.clientWidth / Math.max(1, rect.width);
    const scaleY = this.canvas.clientHeight / Math.max(1, rect.height);
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const layer = this.layerById(this._drag.layerId);
    if (!layer) return;
    const [W, H] = this.stageSize();
    const nx = clamp((px / W) + this._drag.dx, 0, 1);
    const ny = clamp((py / H) + this._drag.dy, 0, 1);
    if (Math.abs(nx - (this._drag.nx || nx)) < 1e-9 && Math.abs(ny - (this._drag.ny || ny)) < 1e-9) return;
    this._drag.nx = nx;
    this._drag.ny = ny;
    const key = this.ensureKeyAtPlayhead(layer);  // auto-key only once a drag actually moves
    key.x = nx;
    key.y = ny;
    layer.x = nx;
    layer.y = ny;
    this.commitChanges();
  }

  onStageUp() { this._drag = null; }

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
      type.textContent = layer.type + (layer.keys && layer.keys.length ? ` · ${layer.keys.length}k` : "");
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
      const up = document.createElement("button");
      up.className = "pup-btn";
      up.textContent = "▲";
      up.title = "Move layer toward the top (draws in front)";
      up.addEventListener("click", ev => {
        ev.stopPropagation();
        const i = this.state.layers.indexOf(layer);
        if (i > 0) {
          this.state.layers.splice(i, 1);
          this.state.layers.splice(i - 1, 0, layer);
          this.commitChanges();
        }
      });
      const down = document.createElement("button");
      down.className = "pup-btn";
      down.textContent = "▼";
      down.title = "Move layer toward the back";
      down.addEventListener("click", ev => {
        ev.stopPropagation();
        const i = this.state.layers.indexOf(layer);
        if (i < this.state.layers.length - 1) {
          this.state.layers.splice(i, 1);
          this.state.layers.splice(i + 1, 0, layer);
          this.commitChanges();
        }
      });
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
      row.appendChild(thumb);
      row.appendChild(name);
      row.appendChild(type);
      row.appendChild(opacity);
      row.appendChild(up);
      row.appendChild(down);
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
    const keyInfo = this.keyAtPlayhead(layer) ? "key @ playhead" : "no key @ playhead";
    head.innerHTML = `<span>${escapeHtml(layer.type)} — ${keyInfo}</span>`;
    ins.appendChild(head);

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
      img.onload = () => { this._imgCache["__bg__"] = img; this.commitChanges(); };
      img.src = this.viewUrl(path);
      this.commitChanges();
      this.updateStatus("Background set.");
    } catch (err) {
      console.error("[ChaoticPuppet] bg import failed", err);
    }
  }

  async importSprite(file, kind) {
    try {
      const path = await this.upload(file);
      if (!path) return;
      const layer = this.normalizeLayer({
        id: uid("layer"),
        type: kind,
        name: file.name,
        file: path,
        x: 0.5,
        y: 0.5,
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
      this.updateStatus(`Added ${kind} layer. Pose it, press Key, move the playhead, pose again.`);
    } catch (err) {
      console.error("[ChaoticPuppet] import failed", err);
      this.updateStatus("Import failed: " + (err && err.message ? err.message : err));
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
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
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
