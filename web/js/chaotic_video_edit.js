/* Chaotic H3 Video Edit — mask/plate/keying widget.
 *
 * Author a keyframed mask over a video (brush or rectangle), choose how the
 * plate is built (black/green void, full-frame or selection-crop, inside vs
 * outside), or switch to green-screen chroma keying.  The state serializes
 * into the hidden `edit_data` STRING widget and renders server-side via
 * video_edit.py — the node never runs a diffusion model itself; feed the
 * plates into an H3 graph and composite the patch back with the
 * ChaoticH3CompositePatch node.
 *
 * Mask contract (mirrors video_edit.py):
 *   mask.keys  [{t, grid_w, grid_h, png}] — low-res bitmap per keyframe,
 *              cross-faded between keys.  png is base64 of a grayscale PNG.
 */
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const VE_GRID_DIV = 4;

const VE_CSS = `
.ve-wrap{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;color:#dcdcdc;font-size:11px}
.ve-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:2px 0}
.ve-btn{background:#232323;color:#ddd;border:1px solid #2e2e2e;border-radius:4px;padding:5px 9px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:5px;transition:background .15s,border-color .15s;font-family:inherit}
.ve-btn:hover{background:#333;border-color:#555}
.ve-btn.danger:hover{background:#4a1515;border-color:#cc4444;color:#ffb0b0}
.ve-btn.active{background:#1c2b22;border-color:#2f7a50;color:#7ee2a8}
.ve-preview-box{position:relative;background:#000;border:1px solid #1c1c1c;border-radius:6px;overflow:hidden;flex:none}
.ve-canvas{display:block;width:100%;cursor:crosshair;outline:none;background:#101214}
.ve-time{position:absolute;top:4px;right:6px;font-size:10px;color:#ffd479;font-family:ui-monospace,Menlo,monospace;pointer-events:none;text-shadow:0 1px 2px #000}
.ve-hint{position:absolute;top:4px;left:6px;font-size:9px;color:#888;font-family:ui-monospace,Menlo,monospace;pointer-events:none;text-shadow:0 1px 2px #000}
.ve-strip{background:#181818;border:1px solid #1c1c1c;border-radius:6px;display:block;width:100%;cursor:pointer;flex:none}
.ve-panel{background:#1b1b1b;border:1px solid #2a2a2a;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px}
.ve-panel-title{font-size:10px;font-weight:700;color:#8a8a8a;text-transform:uppercase;letter-spacing:.07em;display:flex;justify-content:space-between;align-items:center}
.ve-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ve-label{font-size:10px;color:#9a9a9a;white-space:nowrap}
.ve-input{background:#141414;color:#e8e8e8;border:1px solid #333;border-radius:4px;padding:3px 6px;font-size:11px;font-family:inherit}
.ve-input[type=number]{width:58px}
.ve-input[type=text]{flex:1;min-width:60px}
.ve-input[type=color]{width:34px;height:22px;padding:0;border:1px solid #333;background:#141414}
.ve-input:focus{outline:none;border-color:#5a8f7a}
.ve-textarea{width:100%;height:52px;background:#141414;color:#e8e8e8;border:1px solid #333;border-radius:4px;padding:5px 6px;font-size:11px;line-height:1.4;box-sizing:border-box;resize:vertical;outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ve-range{flex:1;accent-color:#4aa47f;height:4px;min-width:70px}
.ve-legend{font-size:9px;color:#777;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:2px 2px}
.ve-statusline{font-size:10px;color:#9a9a9a;min-height:14px}
.ve-track-prog-wrap{flex:1;height:6px;background:#101214;border:1px solid #262626;border-radius:3px;overflow:hidden;min-width:60px}
.ve-track-prog{height:100%;width:0;background:#4aa47f;transition:width .1s}
`;

if (!document.getElementById("chaotic-ve-styles")) {
  const el = document.createElement("style");
  el.id = "chaotic-ve-styles";
  el.textContent = VE_CSS;
  document.head.appendChild(el);
}

function veClamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function veFmt(sec) {
  sec = Math.max(0, sec);
  const mm = Math.floor(sec / 60), rest = sec - mm * 60;
  const ss = Math.floor(rest), mmm = Math.round((rest - ss) * 1000);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(mmm).padStart(3, "0")}`;
}
function veUid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ------------------------------------------------------------------ */
/* Mask tracking — pure, DOM-free helpers (unit-testable)             */
/* ------------------------------------------------------------------ */
function veGray(imageData) {
  /* RGBA ImageData -> grayscale Float32Array at the same size (0..1). */
  const d = imageData.data;
  const n = imageData.width * imageData.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  }
  return out;
}

function vePatch(gray, w, h, cx, cy, pw, ph) {
  /* Extract a (pw x ph) grayscale patch centered at (cx, cy), clamped to the
     frame (out-of-range cells read 0). Returns { data, w, h, ox, oy }. */
  const data = new Float32Array(pw * ph);
  const x0 = Math.round(cx - pw / 2), y0 = Math.round(cy - ph / 2);
  for (let y = 0; y < ph; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < pw; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= w) continue;
      data[y * pw + x] = gray[sy * w + sx];
    }
  }
  return { data, w: pw, h: ph, ox: x0, oy: y0 };
}

function veNcc(a, b) {
  /* Normalized cross-correlation of two equal-length Float32Arrays.
     Mean-subtracted, unit-normalized: 1 = identical, 0 = uncorrelated. */
  const n = a.length;
  if (n === 0) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-9 ? 0 : num / den;
}

function veSearch(frame, fw, fh, tpl, cx, cy, radius, step) {
  /* Two-stage NCC search around (cx, cy): coarse at `step`, then a 3x3 fine
     pass. Returns { dx, dy, score } where dx/dy are offsets from (cx, cy). */
  const tw = tpl.w, th = tpl.h;
  const r = Math.max(1, Math.round(radius));
  const s = Math.max(1, Math.round(step || 2));
  let best = { dx: 0, dy: 0, score: -2 };
  for (let dy = -r; dy <= r; dy += s) {
    for (let dx = -r; dx <= r; dx += s) {
      const sc = veNcc(vePatch(frame, fw, fh, cx + dx, cy + dy, tw, th).data, tpl.data);
      if (sc > best.score) best = { dx, dy, score: sc };
    }
  }
  for (let dy = best.dy - 1; dy <= best.dy + 1; dy++) {
    for (let dx = best.dx - 1; dx <= best.dx + 1; dx++) {
      const sc = veNcc(vePatch(frame, fw, fh, cx + dx, cy + dy, tw, th).data, tpl.data);
      if (sc > best.score) best = { dx, dy, score: sc };
    }
  }
  return best;
}

function veMaskBBox(mask, gw, gh) {
  /* Union bounding box of painted (non-zero) mask cells -> {x, y, w, h} or null. */
  let x0 = gw, y0 = gh, x1 = -1, y1 = -1;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (mask[y * gw + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function veTranslateMask(mask, gw, gh, gdx, gdy) {
  /* Shift the painted mask by (gdx, gdy) grid cells; out-of-frame -> 0. */
  const out = new Uint8ClampedArray(gw * gh);
  for (let y = 0; y < gh; y++) {
    const sy = y - gdy;
    if (sy < 0 || sy >= gh) continue;
    for (let x = 0; x < gw; x++) {
      const sx = x - gdx;
      if (sx < 0 || sx >= gw) continue;
      out[y * gw + x] = mask[sy * gw + sx];
    }
  }
  return out;
}

class ChaoticVideoEdit {
  constructor(node, container, domWidget) {
    this.node = node;
    this.container = container;
    this.domWidget = domWidget;

    this.state = {
      version: 1, mode: "inpaint", edit: "inside", plate_color: "black",
      output: "full", crop_scale: 1.0, outpaint: false, prompt: "", video_file: "",
      mask: { type: "rect", keys: [] },
      chroma: { color: [0, 1, 0], similarity: 0.35, smooth: 0.12, spill: 0.15 },
    };
    this.playhead = 0;
    this.playing = false;
    this._tool = "brush";
    this._drawing = false;
    this._rectAnchor = null;
    this._workMask = null;        // Uint8ClampedArray grid, 255 = masked
    this._gridW = 0; this._gridH = 0;
    this._lastWidth = 0; this._lastScale = 0;
    this._raf = null;
    /* mask tracking options (transient UI prefs, not serialized) */
    this._trackOpts = { every: 2, search: 15, floor: 0.6, refresh: 12 };
    this._tracking = false;

    this.editDataWidget = node.widgets.find(w => w.name === "edit_data");
    this.fpsWidget = node.widgets.find(w => w.name === "fps");

    this.loadState();
    this.buildDOM();
    this._raf = requestAnimationFrame(() => this.checkResize());
  }

  get fps() { return parseInt((this.fpsWidget && this.fpsWidget.value) || 24, 10) || 24; }
  get durationSec() {
    if (this.videoEl && this.videoEl.duration && isFinite(this.videoEl.duration)) return this.videoEl.duration;
    return 6;
  }

  viewUrl(file) {
    if (!file) return "";
    const parts = file.split("/");
    const filename = parts[parts.length - 1];
    const subfolder = parts.slice(0, -1).join("/");
    return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
  }

  defaultEdit() {
    return JSON.parse(JSON.stringify({ version: 1, mode: "inpaint", edit: "inside", plate_color: "black",
      output: "full", crop_scale: 1.0, outpaint: false, prompt: "", video_file: "",
      mask: { type: "rect", keys: [] },
      chroma: { color: [0, 1, 0], similarity: 0.35, smooth: 0.12, spill: 0.15 } }));
  }

  loadState() {
    let raw = this.editDataWidget ? this.editDataWidget.value : "";
    let data = {};
    try { if (raw) data = JSON.parse(raw); } catch (e) { /* defaults */ }
    this._applyState(data);
  }

  _applyState(raw) {
    const d = this.defaultEdit();
    this.state = {
      version: 1,
      mode: raw.mode === "chroma" ? "chroma" : "inpaint",
      edit: raw.edit === "outside" ? "outside" : "inside",
      plate_color: raw.plate_color === "green" ? "green" : "black",
      output: raw.output === "crop" ? "crop" : "full",
      crop_scale: veClamp(Number(raw.crop_scale) || 1, 0.1, 4),
      outpaint: !!raw.outpaint,
      prompt: typeof raw.prompt === "string" ? raw.prompt : "",
      video_file: typeof raw.video_file === "string" ? raw.video_file : "",
      mask: { type: raw.mask && raw.mask.type === "brush" ? "brush" : "rect", keys: [] },
      chroma: {
        color: Array.isArray(raw.chroma && raw.chroma.color) && raw.chroma.color.length >= 3
          ? raw.chroma.color.slice(0, 3).map(v => veClamp(Number(v) || 0, 0, 1))
          : [0, 1, 0],
        similarity: veClamp(Number(raw.chroma && raw.chroma.similarity) || 0.35, 0, 0.95),
        smooth: veClamp(Number(raw.chroma && raw.chroma.smooth) || 0.12, 0, 0.5),
        spill: veClamp(Number(raw.chroma && raw.chroma.spill) || 0.15, 0, 0.9),
      },
    };
    if (raw.mask && Array.isArray(raw.mask.keys)) {
      raw.mask.keys.forEach(k => {
        if (!k || typeof k !== "object") return;
        this.state.mask.keys.push({
          t: Math.max(0, Number(k.t) || 0),
          grid_w: Math.max(8, parseInt(k.grid_w, 10) || 64),
          grid_h: Math.max(8, parseInt(k.grid_h, 10) || 64),
          png: typeof k.png === "string" ? k.png : "",
        });
      });
      this.state.mask.keys.sort((a, b) => a.t - b.t);
    }
    if (this.state.video_file) this.loadVideoEl(this.state.video_file);
    this.drawPreview();
    this.drawKeyStrip();
  }

  serialize() {
    return JSON.stringify(this.state, null, 1);
  }

  commitChanges() {
    if (this.editDataWidget) this.editDataWidget.value = this.serialize();
    if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    this.drawPreview();
    this.drawKeyStrip();
  }

  /* ---------------- DOM ---------------- */
  buildDOM() {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "ve-wrap";

    const toolbar = document.createElement("div");
    toolbar.className = "ve-toolbar";
    const btnLoad = this.btn("⬆ Video", () => this.pickVideo());
    const btnMode = this.btn("Mode: Inpaint", () => this.toggleMode());
    this.modeBtn = btnMode;
    const btnSave = this.btn("Save", () => this.saveProject());
    const btnLoadP = this.btn("Load", () => this.loadProject());
    const btnPlay = this.btn("▶", () => this.togglePlay());
    this.playBtn = btnPlay;
    toolbar.append(btnLoad, btnMode, btnPlay, btnSave, btnLoadP);
    this.wrapper.appendChild(toolbar);

    /* preview */
    this.previewBox = document.createElement("div");
    this.previewBox.className = "ve-preview-box";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "ve-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.previewHint = document.createElement("div");
    this.previewHint.className = "ve-hint";
    this.previewHint.textContent = "no video loaded";
    this.previewTime = document.createElement("div");
    this.previewTime.className = "ve-time";
    this.previewBox.appendChild(this.canvas);
    this.previewBox.appendChild(this.previewHint);
    this.previewBox.appendChild(this.previewTime);
    this.wrapper.appendChild(this.previewBox);

    /* scrub + key strip */
    const scrubRow = document.createElement("div");
    scrubRow.className = "ve-row";
    this.seek = document.createElement("input");
    this.seek.className = "ve-range";
    this.seek.type = "range";
    this.seek.min = "0"; this.seek.max = "100"; this.seek.value = "0";
    this.seek.addEventListener("input", () => this.setPlayhead((Number(this.seek.value) / 100) * this.durationSec));
    const timeLab = document.createElement("span");
    timeLab.className = "ve-label";
    timeLab.style.fontFamily = "monospace";
    this.timeLabel = timeLab;
    scrubRow.appendChild(this.seek);
    scrubRow.appendChild(timeLab);
    this.wrapper.appendChild(scrubRow);

    this.keyCanvas = document.createElement("canvas");
    this.keyCanvas.className = "ve-strip";
    this.keyCtx = this.keyCanvas.getContext("2d");
    this.wrapper.appendChild(this.keyCanvas);
    const legend = document.createElement("div");
    legend.className = "ve-legend";
    legend.textContent = "mask keys (cross-faded) — set the playhead, draw, press Set Mask Key";
    this.wrapper.appendChild(legend);

    /* inpaint panel */
    this.inpaintPanel = document.createElement("div");
    this.inpaintPanel.className = "ve-panel";
    const iTitle = document.createElement("div");
    iTitle.className = "ve-panel-title";
    iTitle.innerHTML = "<span>Inpaint plate</span>";
    this.inpaintPanel.appendChild(iTitle);

    const toolRow = document.createElement("div");
    toolRow.className = "ve-row";
    const btnBrush = this.btn("Brush", () => this.setTool("brush"));
    const btnRect = this.btn("Rect", () => this.setTool("rect"));
    btnBrush.className = "ve-btn active"; btnRect.className = "ve-btn";
    this.toolBtns = { brush: btnBrush, rect: btnRect };
    toolRow.appendChild(this.btnL("Tool"));
    toolRow.appendChild(btnBrush);
    toolRow.appendChild(btnRect);
    this.inpaintPanel.appendChild(toolRow);

    const editRow = document.createElement("div");
    editRow.className = "ve-row";
    const btnIn = this.btn("Edit inside", () => this.setEdit("inside"));
    const btnOut = this.btn("Edit outside", () => this.setEdit("outside"));
    btnIn.className = "ve-btn active"; btnOut.className = "ve-btn";
    this.editBtns = { inside: btnIn, outside: btnOut };
    editRow.appendChild(this.btnL("Edit"));
    editRow.appendChild(btnIn);
    editRow.appendChild(btnOut);
    this.inpaintPanel.appendChild(editRow);

    const plateRow = document.createElement("div");
    plateRow.className = "ve-row";
    const btnBlack = this.btn("Black void", () => this.setPlate("black"));
    const btnGreen = this.btn("Green void", () => this.setPlate("green"));
    btnBlack.className = "ve-btn active"; btnGreen.className = "ve-btn";
    this.plateBtns = { black: btnBlack, green: btnGreen };
    plateRow.appendChild(this.btnL("Plate"));
    plateRow.appendChild(btnBlack);
    plateRow.appendChild(btnGreen);
    this.inpaintPanel.appendChild(plateRow);

    const outRow = document.createElement("div");
    outRow.className = "ve-row";
    const btnFull = this.btn("Full frame", () => this.setOutput("full"));
    const btnCrop = this.btn("Selection crop", () => this.setOutput("crop"));
    btnFull.className = "ve-btn active"; btnCrop.className = "ve-btn";
    this.outputBtns = { full: btnFull, crop: btnCrop };
    outRow.appendChild(this.btnL("Output"));
    outRow.appendChild(btnFull);
    outRow.appendChild(btnCrop);
    this.inpaintPanel.appendChild(outRow);

    const scaleRow = document.createElement("div");
    scaleRow.className = "ve-row";
    scaleRow.appendChild(this.btnL("Crop scale"));
    const scaleIn = document.createElement("input");
    scaleIn.className = "ve-input";
    scaleIn.type = "number";
    scaleIn.step = "0.1";
    scaleIn.min = "0.1";
    scaleIn.max = "4";
    scaleIn.value = this.state.crop_scale;
    scaleIn.addEventListener("change", () => { this.state.crop_scale = veClamp(Number(scaleIn.value) || 1, 0.1, 4); this.commitChanges(); });
    const outPaint = document.createElement("input");
    outPaint.type = "checkbox";
    outPaint.checked = this.state.outpaint;
    outPaint.addEventListener("change", () => { this.state.outpaint = outPaint.checked; this.commitChanges(); });
    scaleRow.appendChild(scaleIn);
    scaleRow.appendChild(this.btnL("outpaint"));
    scaleRow.appendChild(outPaint);
    this.inpaintPanel.appendChild(scaleRow);

    const keyRow = document.createElement("div");
    keyRow.className = "ve-row";
    const btnSetKey = this.btn("Set Mask Key", () => this.setMaskKey());
    const btnDelKey = this.btn("Del Mask Key", () => this.delMaskKey());
    const btnClear = this.btn("Clear Mask Keys", () => this.clearMaskKeys());
    btnClear.className = "ve-btn danger";
    keyRow.appendChild(btnSetKey);
    keyRow.appendChild(btnDelKey);
    keyRow.appendChild(btnClear);
    this.inpaintPanel.appendChild(keyRow);

    /* auto-track a painted region (template matching, forward + backward) */
    const trackRow = document.createElement("div");
    trackRow.className = "ve-row";
    const btnTrack = this.btn("Track Mask", () => this.trackMask());
    btnTrack.className = "ve-btn";
    this.trackBtn = btnTrack;
    const progWrap = document.createElement("div");
    progWrap.className = "ve-track-prog-wrap";
    const progBar = document.createElement("div");
    progBar.className = "ve-track-prog";
    this.trackProg = progBar;
    progWrap.appendChild(progBar);
    trackRow.appendChild(btnTrack);
    trackRow.appendChild(progWrap);
    this.inpaintPanel.appendChild(trackRow);

    const trackOptRow = document.createElement("div");
    trackOptRow.className = "ve-row";
    const mkNum = (prop, min, max, step, label) => {
      trackOptRow.appendChild(this.btnL(label));
      const inp = document.createElement("input");
      inp.className = "ve-input";
      inp.type = "number";
      inp.step = step;
      inp.min = String(min);
      inp.max = String(max);
      inp.value = this._trackOpts[prop];
      inp.addEventListener("change", () => {
        this._trackOpts[prop] = veClamp(Number(inp.value) || min, min, max);
      });
      trackOptRow.appendChild(inp);
    };
    const mkRange = (prop, min, max, step, label) => {
      trackOptRow.appendChild(this.btnL(label));
      const inp = document.createElement("input");
      inp.className = "ve-range";
      inp.type = "range";
      inp.min = String(min);
      inp.max = String(max);
      inp.step = String(step);
      inp.value = String(this._trackOpts[prop]);
      inp.style.flex = "0 0 70px";
      inp.addEventListener("input", () => {
        this._trackOpts[prop] = Number(inp.value);
        inp.title = label + ": " + inp.value;
      });
      trackOptRow.appendChild(inp);
    };
    mkNum("every", 1, 30, "1", "Every");
    mkRange("search", 3, 40, 1, "Search %");
    mkRange("floor", 0.3, 0.95, 0.01, "Score ≥");
    mkNum("refresh", 2, 60, "1", "Refresh");
    this.inpaintPanel.appendChild(trackOptRow);
    const trackHint = document.createElement("div");
    trackHint.className = "ve-hint";
    trackHint.style.position = "static";
    trackHint.textContent = "paint a region, press Track Mask — the mask follows the subject forward and backward (template matching).";
    this.inpaintPanel.appendChild(trackHint);

    const promptRow = document.createElement("div");
    promptRow.className = "ve-row";
    promptRow.appendChild(this.btnL("Edit prompt"));
    const promptIn = document.createElement("textarea");
    promptIn.className = "ve-textarea";
    promptIn.value = this.state.prompt;
    promptIn.placeholder = "what should H3 do in this region? e.g. 'fix the hand, five fingers'";
    promptIn.addEventListener("input", () => { this.state.prompt = promptIn.value; this.commitChanges(); });
    promptRow.appendChild(promptIn);
    this.inpaintPanel.appendChild(promptRow);
    this.wrapper.appendChild(this.inpaintPanel);

    /* chroma panel */
    this.chromaPanel = document.createElement("div");
    this.chromaPanel.className = "ve-panel";
    const cTitle = document.createElement("div");
    cTitle.className = "ve-panel-title";
    cTitle.innerHTML = "<span>Green screen</span><span style='color:#666'>click the preview to sample the key color</span>";
    this.chromaPanel.appendChild(cTitle);

    const colorRow = document.createElement("div");
    colorRow.className = "ve-row";
    colorRow.appendChild(this.btnL("Key color"));
    const colorIn = document.createElement("input");
    colorIn.type = "color";
    colorIn.className = "ve-input";
    const hex = this.colorToHex(this.state.chroma.color);
    colorIn.value = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#00ff00";
    colorIn.addEventListener("input", () => { this.state.chroma.color = this.hexToRgb(colorIn.value); this.commitChanges(); });
    const sampleBtn = this.btn("Sample from frame", () => this.sampleColor());
    colorRow.appendChild(colorIn);
    colorRow.appendChild(sampleBtn);
    this.chromaPanel.appendChild(colorRow);

    const simRow = document.createElement("div");
    simRow.className = "ve-row";
    simRow.appendChild(this.btnL("Similarity"));
    simRow.appendChild(this.slider("similarity", 0, 0.95, 0.01));
    simRow.appendChild(this.btnL("Smooth"));
    simRow.appendChild(this.slider("smooth", 0, 0.5, 0.01));
    simRow.appendChild(this.btnL("Spill"));
    simRow.appendChild(this.slider("spill", 0, 0.9, 0.01));
    this.chromaPanel.appendChild(simRow);
    this.wrapper.appendChild(this.chromaPanel);

    /* status */
    this.statusLine = document.createElement("div");
    this.statusLine.className = "ve-statusline";
    this.wrapper.appendChild(this.statusLine);

    this.container.appendChild(this.wrapper);

    /* interactions */
    this.canvas.addEventListener("mousedown", e => this.onCanvasDown(e));
    this.canvas.addEventListener("mousemove", e => this.onCanvasMove(e));
    document.addEventListener("mouseup", () => this.onCanvasUp());
    this.keyCanvas.addEventListener("mousedown", e => this.onKeyStripDown(e));
    this.wrapper.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
    this.wrapper.addEventListener("drop", e => this.onDrop(e));
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.style.display = "none";
    this.wrapper.appendChild(this.fileInput);

    this.videoEl = document.createElement("video");
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;
    this.videoEl.preload = "auto";
    this.videoEl.addEventListener("loadedmetadata", () => this.onVideoMeta());
    this.videoEl.addEventListener("timeupdate", () => { if (!this.playing) this.setPlayhead(this.videoEl.currentTime); });

    this.refreshModePanels();
    this.refreshToggleStates();
    this.drawPreview();
    this.drawKeyStrip();
    this.updateStatus("Load a video, scrub to a moment, draw the region, press Set Mask Key. Wire the plates into your H3 graph and composite the patch back.");
  }

  btn(label, fn) {
    const b = document.createElement("button");
    b.className = "ve-btn";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  btnL(text) {
    const s = document.createElement("span");
    s.className = "ve-label";
    s.textContent = text;
    return s;
  }

  slider(prop, min, max, step) {
    const s = document.createElement("input");
    s.className = "ve-range";
    s.type = "range";
    s.min = String(min); s.max = String(max); s.step = String(step);
    s.value = String(this.state.chroma[prop]);
    s.style.flex = "0 0 70px";
    s.addEventListener("input", () => {
      this.state.chroma[prop] = Number(s.value);
      s.title = prop + ": " + s.value;
      this.commitChanges();
    });
    return s;
  }

  updateStatus(text) { this.statusLine.textContent = text; }

  getRenderScale() {
    let gs = 1;
    try {
      if (window.app && window.app.canvas && window.app.canvas.ds && window.app.canvas.ds.scale) gs = window.app.canvas.ds.scale;
    } catch (e) {}
    return (window.devicePixelRatio || 1) * Math.max(1, gs);
  }

  checkResize() {
    const w = this.canvas ? this.canvas.clientWidth : 0;
    const scale = this.getRenderScale();
    if (w > 0 && (w !== this._lastWidth || scale !== this._lastScale)) {
      this._lastWidth = w;
      this._lastScale = scale;
      const h = Math.max(80, Math.round((w * scale) * 9 / 16));
      this.canvas.width = Math.round(w * scale);
      this.canvas.height = h;
      this.canvas.style.height = (w * 9 / 16) + "px";
      this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const kw = this.keyCanvas.clientWidth || w;
      this.keyCanvas.width = Math.round(kw * scale);
      this.keyCanvas.height = Math.round(26 * scale);
      this.keyCtx.setTransform(scale, 0, 0, scale, 0, 0);
      this.drawPreview();
      this.drawKeyStrip();
    }
    this._raf = requestAnimationFrame(() => this.checkResize());
  }

  /* ---------------- video ---------------- */
  pickVideo() {
    this.fileInput.accept = "video/*";
    this.fileInput.onchange = () => {
      const f = this.fileInput.files && this.fileInput.files[0];
      if (f) this.importVideo(f);
      this.fileInput.value = "";
    };
    this.fileInput.click();
  }

  async importVideo(file) {
    try {
      const path = await this.upload(file);
      if (!path) return;
      this.state.video_file = path;
      this.loadVideoEl(path);
      this.commitChanges();
      this.updateStatus("Video loaded — scrub, draw the region, press Set Mask Key.");
    } catch (err) {
      console.error("[ChaoticVideoEdit] import failed", err);
      this.updateStatus("Import failed: " + (err && err.message ? err.message : err));
    }
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

  loadVideoEl(path) {
    if (!this.videoEl) return;
    this.videoEl.src = this.viewUrl(path);
    this.previewHint.textContent = path.split("/").pop();
  }

  onVideoMeta() {
    const vw = this.videoEl.videoWidth || 1280;
    const vh = this.videoEl.videoHeight || 720;
    this._gridW = Math.max(8, Math.round(vw / VE_GRID_DIV));
    this._gridH = Math.max(8, Math.round(vh / VE_GRID_DIV));
    this.updateStatus(`Video ${vw}×${vh} — mask grid ${this._gridW}×${this._gridH} (video/${VE_GRID_DIV}).`);
    this.drawPreview();
  }

  onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    files.forEach(f => {
      if (f.type.startsWith("video/")) this.importVideo(f);
    });
  }

  togglePlay() {
    if (!this.videoEl || !this.videoEl.src) return;
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? "⏸" : "▶";
    if (this.playing) {
      this.videoEl.currentTime = this.playhead;
      this.videoEl.play().catch(() => {});
      const tick = () => {
        if (!this.playing) return;
        this.setPlayhead(this.videoEl.currentTime);
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    } else {
      this.videoEl.pause();
    }
  }

  setPlayhead(t) {
    this.playhead = veClamp(t, 0, this.durationSec);
    if (this.videoEl && this.videoEl.src && Math.abs(this.videoEl.currentTime - this.playhead) > 0.08) {
      try { this.videoEl.currentTime = this.playhead; } catch (e) {}
    }
    this.seek.value = String((this.playhead / Math.max(0.1, this.durationSec)) * 100);
    this.timeLabel.textContent = veFmt(this.playhead) + " / " + veFmt(this.durationSec);
    this.drawPreview();
    this.drawKeyStrip();
  }

  onKeyStripDown(e) {
    const rect = this.keyCanvas.getBoundingClientRect();
    const w = this.keyCanvas.clientWidth || 1;
    const t = veClamp(((e.clientX - rect.left) / w) * this.durationSec, 0, this.durationSec);
    this.setPlayhead(t);
    const onMove = ev => {
      const r = this.keyCanvas.getBoundingClientRect();
      const ww = this.keyCanvas.clientWidth || 1;
      this.setPlayhead(veClamp(((ev.clientX - r.left) / ww) * this.durationSec, 0, this.durationSec));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /* ---------------- masks ---------------- */
  ensureGrid() {
    if (!this._gridW || !this._gridH) {
      this._gridW = Math.max(8, Math.round((this.videoEl.videoWidth || 1280) / VE_GRID_DIV));
      this._gridH = Math.max(8, Math.round((this.videoEl.videoHeight || 720) / VE_GRID_DIV));
    }
    if (!this._workMask || this._workMask.length !== this._gridW * this._gridH) {
      this._workMask = new Uint8ClampedArray(this._gridW * this._gridH);
    }
  }

  interpolatedMaskGrid(t) {
    const keys = this.state.mask.keys.slice().sort((a, b) => a.t - b.t);
    if (!keys.length) return null;
    const gw = keys[0].grid_w, gh = keys[0].grid_h;
    const decoded = keys.map(k => this.decodeMaskPng(k.png, k.grid_w, k.grid_h, gw, gh));
    let A = null, B = null, f = 0;
    if (t <= keys[0].t + 1e-6) { A = decoded[0]; }
    else if (t >= keys[keys.length - 1].t - 1e-6) { A = decoded[decoded.length - 1]; }
    else {
      let bi = 0;
      for (let i = 0; i < keys.length; i++) if (keys[i].t <= t) bi = i;
      A = decoded[bi];
      if (bi + 1 < keys.length) { B = decoded[bi + 1]; f = (t - keys[bi].t) / Math.max(1e-6, keys[bi + 1].t - keys[bi].t); }
    }
    const out = new Float32Array(gw * gh);
    for (let i = 0; i < out.length; i++) {
      /* decoded masks are already normalized 0..1 (decodeMaskPng divides by 255) */
      out[i] = A[i];
      if (B) out[i] = out[i] * (1 - f) + B[i] * f;
    }
    return { data: out, gw, gh };
  }

  decodeMaskPng(b64, gw, gh, outW, outH) {
    const out = new Float32Array(outW * outH);
    try {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      const c = document.createElement("canvas");
      c.width = gw; c.height = gh;
      const cc = c.getContext("2d");
      cc.drawImage(img, 0, 0);
      const d = cc.getImageData(0, 0, gw, gh).data;
      for (let y = 0; y < gh; y++) {
        const sy = Math.min(gh - 1, y);
        const dy = Math.min(outH - 1, y);
        for (let x = 0; x < gw; x++) {
          out[dy * outW + Math.min(outW - 1, x)] = d[(sy * gw + x) * 4] / 255;
        }
      }
    } catch (e) { /* corrupt key -> empty */ }
    return out;
  }

  keyAt(t) {
    return this.state.mask.keys.find(k => Math.abs(k.t - t) < 0.02) || null;
  }

  setMaskKey() {
    this.ensureGrid();
    const png = this.maskToPng(this._workMask, this._gridW, this._gridH);
    const existing = this.keyAt(this.playhead);
    if (existing) {
      existing.png = png;
      existing.grid_w = this._gridW;
      existing.grid_h = this._gridH;
      this.updateStatus("Mask key updated at " + veFmt(this.playhead) + ".");
    } else {
      this.state.mask.keys.push({ t: Math.round(this.playhead * 1000) / 1000, grid_w: this._gridW, grid_h: this._gridH, png });
      this.state.mask.keys.sort((a, b) => a.t - b.t);
      this.updateStatus("Mask key set at " + veFmt(this.playhead) + " — masks cross-fade between keys.");
    }
    this.commitChanges();
  }

  delMaskKey() {
    const k = this.keyAt(this.playhead);
    if (!k) { this.updateStatus("No mask key at the playhead."); return; }
    this.state.mask.keys = this.state.mask.keys.filter(x => x !== k);
    this.updateStatus("Mask key removed.");
    this.commitChanges();
  }

  clearMaskKeys() {
    this.state.mask.keys = [];
    if (this._workMask) this._workMask.fill(0);   // null until the first paint
    this.commitChanges();
    this.updateStatus("All mask keys cleared.");
  }

  /* ---------------- mask tracking ---------------- */
  async trackMask() {
    if (this._tracking) return;
    if (!this.videoEl || !this.videoEl.src || !isFinite(this.videoEl.duration) || this.videoEl.duration <= 0) {
      this.updateStatus("Load a video first, then paint a region and press Track Mask.");
      return;
    }
    this.ensureGrid();
    const gw = this._gridW, gh = this._gridH;
    const start = this.playhead;
    /* base mask = the key at the playhead, else the painted work mask */
    const base = new Uint8ClampedArray(gw * gh);
    const existing = this.keyAt(start);
    if (existing) {
      this.decodeMaskInto(base, existing.png, existing.grid_w, existing.grid_h);
    } else {
      let has = false;
      for (let i = 0; i < base.length; i++) if (this._workMask[i]) { has = true; break; }
      if (!has) { this.updateStatus("Paint a region first (or set a mask key), then press Track Mask."); return; }
      base.set(this._workMask);
    }
    const opts = {
      every: Math.max(1, Math.round(this._trackOpts.every)),
      search: veClamp(Number(this._trackOpts.search), 3, 40),
      floor: veClamp(Number(this._trackOpts.floor), 0.3, 0.95),
      refresh: Math.max(2, Math.round(this._trackOpts.refresh)),
    };
    const step = opts.every / this.fps;
    this._tracking = true;
    this.updateTrackUI(true, 0);
    let fwd = [], bwd = [], trackErr = null;
    try {
      fwd = await this.trackDirection(base, start, step, opts, 1);
      bwd = await this.trackDirection(base, start, -step, opts, -1);
    } catch (err) {
      trackErr = err;
    } finally {
      this._tracking = false;
      this.updateTrackUI(false, 0);
    }
    if (trackErr) {
      this.setPlayhead(start);
      this.updateStatus("Tracking failed — " + (trackErr && trackErr.message ? trackErr.message : trackErr));
      return;
    }
    const added = this.applyTrackKeys(base, fwd.concat(bwd), gw, gh);
    const fwdT = fwd.length ? fwd[fwd.length - 1].t : start;
    const bwdT = bwd.length ? bwd[bwd.length - 1].t : start;
    this.setPlayhead(start);
    if (!added) {
      this.updateStatus("Tracking lost immediately (score below the floor) — lower \u201cScore \u2265\u201d or increase \u201cSearch\u201d.");
      return;
    }
    this.updateStatus(
      `Tracked \u2192 ${veFmt(fwdT)} and \u2190 ${veFmt(bwdT)} — ${added} mask key(s) added. ` +
      "Scrub to review; fix any frame manually and re-track."
    );
  }

  async trackDirection(base, start, step, opts, dir) {
    const vw = this.videoEl.videoWidth || 1280, vh = this.videoEl.videoHeight || 720;
    const dur = this.durationSec;
    const gw = this._gridW, gh = this._gridH;
    const trackW = 160, trackH = Math.max(8, Math.round(trackW * vh / vw));
    const off = document.createElement("canvas");
    off.width = trackW; off.height = trackH;
    const octx = off.getContext("2d", { willReadFrequently: true });
    /* seed the template from the frame at `start`, at the mask bbox center */      await this.seekVideo(start);
    octx.drawImage(this.videoEl, 0, 0, trackW, trackH);
    let frameGray;
    try {
      frameGray = veGray(octx.getImageData(0, 0, trackW, trackH));
    } catch (e) {
      throw new Error("cannot read video pixels (canvas tainted?) — " + (e && e.message ? e.message : e));
    }
    const bbox = veMaskBBox(base, gw, gh);
    if (!bbox) return [];
    const cx = (bbox.x + bbox.w / 2) * (trackW / gw);
    const cy = (bbox.y + bbox.h / 2) * (trackH / gh);
    const pw = veClamp(Math.round(bbox.w * (trackW / gw)), 8, 48);
    const ph = veClamp(Math.round(bbox.h * (trackH / gh)), 8, 48);
    let tpl = vePatch(frameGray, trackW, trackH, cx, cy, pw, ph);
    const radius = Math.max(6, Math.round((opts.search / 100) * trackW));
    const out = [];
    let px = cx, py = cy, sinceRefresh = 0;
    const times = [];
    for (let t = start + step; dir > 0 ? t <= dur + 1e-6 : t >= -1e-6; t += step) {
      times.push(veClamp(t, 0, dur));
    }
    for (const t of times) {
      const frac = dir > 0
        ? (t - start) / Math.max(0.001, dur - start)
        : (start - t) / Math.max(0.001, start);
      this.updateTrackUI(true, frac);
      await this.seekVideo(t);
      octx.drawImage(this.videoEl, 0, 0, trackW, trackH);
      try {
        frameGray = veGray(octx.getImageData(0, 0, trackW, trackH));
      } catch (e) {
        throw new Error("cannot read video pixels (canvas tainted?) — " + (e && e.message ? e.message : e));
      }
      const hit = veSearch(frameGray, trackW, trackH, tpl, px, py, radius, 2);
      if (hit.score < opts.floor) break;
      px += hit.dx;
      py += hit.dy;
      out.push({
        t,
        dx: Math.round((px - cx) * gw / trackW),
        dy: Math.round((py - cy) * gh / trackH),
        score: hit.score,
      });
      if (++sinceRefresh >= opts.refresh) {
        sinceRefresh = 0;
        tpl = vePatch(frameGray, trackW, trackH, px, py, pw, ph);
      }
    }
    return out;
  }

  applyTrackKeys(base, path, gw, gh) {
    if (!path.length) return 0;
    let added = 0;
    path.forEach(entry => {
      const translated = veTranslateMask(base, gw, gh, entry.dx, entry.dy);
      const png = this.maskToPng(translated, gw, gh);
      const t = Math.round(entry.t * 1000) / 1000;
      const existing = this.keyAt(t);
      if (existing) {
        existing.png = png;
        existing.grid_w = gw;
        existing.grid_h = gh;
      } else {
        this.state.mask.keys.push({ t, grid_w: gw, grid_h: gh, png });
        added++;
      }
    });
    this.state.mask.keys.sort((a, b) => a.t - b.t);
    this.commitChanges();
    return added;
  }

  updateTrackUI(active, frac) {
    if (this.trackBtn) {
      this.trackBtn.disabled = !!active;
      this.trackBtn.textContent = active ? "Tracking… " + Math.round(veClamp(frac, 0, 1) * 100) + "%" : "Track Mask";
    }
    if (this.trackProg) this.trackProg.style.width = Math.round(veClamp(frac, 0, 1) * 100) + "%";
  }

  decodeMaskInto(target, b64, gw, gh) {
    target.fill(0);
    if (!b64) return;
    try {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      const c = document.createElement("canvas");
      c.width = gw; c.height = gh;
      const cc = c.getContext("2d");
      cc.drawImage(img, 0, 0);
      const d = cc.getImageData(0, 0, gw, gh).data;
      for (let i = 0; i < Math.min(target.length, gw * gh); i++) target[i] = d[i * 4];
    } catch (e) { /* corrupt key -> empty */ }
  }

  seekVideo(t) {
    return new Promise(resolve => {
      const v = this.videoEl;
      if (!v) { resolve(); return; }
      if (v.readyState >= 1 && Math.abs(v.currentTime - t) < 0.02) { resolve(); return; }
      let timer = null;
      const done = () => {
        if (v) v.removeEventListener("seeked", done);
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(done, 2000);
      v.addEventListener("seeked", done);
      try { v.currentTime = t; } catch (e) { done(); }
    });
  }

  maskToPng(data, gw, gh) {
    try {
      const c = document.createElement("canvas");
      c.width = gw; c.height = gh;
      const cc = c.getContext("2d");
      const img = cc.createImageData(gw, gh);
      for (let i = 0; i < data.length; i++) {
        img.data[i * 4] = data[i];
        img.data[i * 4 + 1] = data[i];
        img.data[i * 4 + 2] = data[i];
        img.data[i * 4 + 3] = 255;
      }
      cc.putImageData(img, 0, 0);
      return c.toDataURL("image/png").split(",")[1] || "";
    } catch (e) {
      return "";
    }
  }

  /* ---------------- canvas drawing ---------------- */
  canvasSize() {
    const w = this.canvas ? this.canvas.clientWidth : 800;
    return [Math.max(160, w), Math.max(90, w * 9 / 16)];
  }

  mouseToNorm(e) {
    const rect = this.canvas.getBoundingClientRect();
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    return {
      x: veClamp((e.clientX - rect.left) / cw, 0, 1),
      y: veClamp((e.clientY - rect.top) / ch, 0, 1),
    };
  }

  onCanvasDown(e) {
    if (this.state.mode !== "inpaint") return;
    const p = this.mouseToNorm(e);
    this.ensureGrid();
    /* seed the work mask from the interpolated mask so drawing refines it */
    const interp = this.interpolatedMaskGrid(this.playhead);
    if (interp) {
      for (let i = 0; i < this._gridW * this._gridH; i++) {
        this._workMask[i] = Math.round(interp.data[i] * 255);
      }
    } else {
      this._workMask.fill(0);
    }
    this._drawing = true;
    if (this._tool === "rect") this._rectAnchor = p;
    else this.paintBrush(p);
  }

  onCanvasMove(e) {
    if (!this._drawing) return;
    const p = this.mouseToNorm(e);
    this._lastNorm = p;
    if (this._tool === "rect") {
      this.drawPreview();
      const [W, H] = this.canvasSize();
      const ctx = this.ctx;
      ctx.strokeStyle = "#ff5a5a";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(this._rectAnchor.x * W, this._rectAnchor.y * H, (p.x - this._rectAnchor.x) * W, (p.y - this._rectAnchor.y) * H);
      ctx.setLineDash([]);
    } else {
      this.paintBrush(p);
    }
  }

  onCanvasUp() {
    if (!this._drawing) return;
    if (this._tool === "rect" && this._rectAnchor && this._lastNorm) {
      this.fillRectFromAnchor();
    }
    this._drawing = false;
    this._rectAnchor = null;
  }

  paintBrush(p) {
    const radius = Math.max(1, Math.round(0.03 * this._gridW));
    const cx = Math.round(p.x * (this._gridW - 1));
    const cy = Math.round(p.y * (this._gridH - 1));
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= this._gridW || y >= this._gridH) continue;
        this._workMask[y * this._gridW + x] = 255;
      }
    }
    this.drawPreview();
  }

  fillRectFromAnchor() {
    /* rect is filled on mouseup using the last known cursor position */
    const p = this._lastNorm;
    if (!p || !this._rectAnchor) return;
    const ax = Math.round(Math.min(this._rectAnchor.x, p.x) * (this._gridW - 1));
    const bx = Math.round(Math.max(this._rectAnchor.x, p.x) * (this._gridW - 1));
    const ay = Math.round(Math.min(this._rectAnchor.y, p.y) * (this._gridH - 1));
    const by = Math.round(Math.max(this._rectAnchor.y, p.y) * (this._gridH - 1));
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        this._workMask[y * this._gridW + x] = 255;
      }
    }
    this.drawPreview();
  }

  /* ---------------- preview rendering ---------------- */
  drawPreview() {
    if (!this.canvas || !this.ctx) return;
    const [W, H] = this.canvasSize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#101214";
    ctx.fillRect(0, 0, W, H);
    const hasVideo = this.videoEl && this.videoEl.src && this.videoEl.readyState >= 1;
    if (hasVideo) {
      const vw = this.videoEl.videoWidth || W, vh = this.videoEl.videoHeight || H;
      const s = Math.min(W / vw, H / vh);
      const dw = vw * s, dh = vh * s;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      ctx.drawImage(this.videoEl, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = "#333";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("load a video to start editing", W / 2, H / 2);
      return;
    }
    if (this.state.mode === "chroma") {
      this.drawChromaPreview(W, H);
      return;
    }
    /* mask overlay (red) from the interpolated grid */
    const interp = this.interpolatedMaskGrid(this.playhead);
    if (!interp && !this._workMask) return;
    const overlay = new Uint8ClampedArray(W * H);
    const gw = this._gridW, gh = this._gridH;
    const vw = this.videoEl.videoWidth || W, vh = this.videoEl.videoHeight || H;
    const s = Math.min(W / vw, H / vh);
    const ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const gx = Math.floor((x - ox) / s / (vw / gw));
        const gy = Math.floor((y - oy) / s / (vh / gh));
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
        let v = 0;
        if (interp) v = interp.data[gy * gw + gx];
        else if (this._workMask) v = this._workMask[gy * gw + gx] / 255;
        if (v > 0.05) {
          const px = x * 4;
          const a = veClamp(v, 0, 1);
          overlay[px] = Math.round(overlay[px] * (1 - a) + 255 * a);
          overlay[px + 1] = Math.round(overlay[px + 1] * (1 - a) + 70 * a);
          overlay[px + 2] = Math.round(overlay[px + 2] * (1 - a) + 70 * a);
        }
      }
    }
    const img = this.ctx.createImageData(W, H);
    const base = this.ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < W * H; i++) {
      img.data[i * 4] = Math.round(base.data[i * 4] * (1 - overlay[i * 4] / 255) + overlay[i * 4]);
      img.data[i * 4 + 1] = Math.round(base.data[i * 4 + 1] * (1 - overlay[i * 4 + 1] / 255) + overlay[i * 4 + 1]);
      img.data[i * 4 + 2] = Math.round(base.data[i * 4 + 2] * (1 - overlay[i * 4 + 2] / 255) + overlay[i * 4 + 2]);
      img.data[i * 4 + 3] = 255;
    }
    try { this.ctx.putImageData(img, 0, 0); } catch (e) {}
  }

  drawChromaPreview(W, H) {
    try {
      const img = this.ctx.getImageData(0, 0, W, H);
      const d = img.data;
      const [r, g, b] = this.state.chroma.color;
      const sim = this.state.chroma.similarity, sm = this.state.chroma.smooth;
      const spill = this.state.chroma.spill;
      const low = Math.max(1e-6, sim - sm), high = sim + sm;
      const cell = 16;
      for (let i = 0; i < W * H; i++) {
        const pr = d[i * 4] / 255, pg = d[i * 4 + 1] / 255, pb = d[i * 4 + 2] / 255;
        const dist = Math.sqrt((pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2);
        let a = veClamp((dist - low) / Math.max(1e-6, high - low), 0, 1);
        let nr = pr, ng = pg, nb = pb;
        if (spill > 0 && a > 0) {
          const f = veClamp(pg - Math.max(pr, pb), 0, 1) * spill * a;
          nr = veClamp(pr + f, 0, 1);
          nb = veClamp(pb + f, 0, 1);
          ng = veClamp(pg * (1 - f * 0.8), 0, 1);
        }
        const x = i % W, y = Math.floor(i / W);
        const sq = (((x / cell) | 0) + ((y / cell) | 0)) % 2 === 0;
        const br = sq ? 0.85 : 0.15;
        d[i * 4] = Math.round((nr * a + br * (1 - a)) * 255);
        d[i * 4 + 1] = Math.round((ng * a + br * (1 - a)) * 255);
        d[i * 4 + 2] = Math.round((nb * a + br * (1 - a)) * 255);
        d[i * 4 + 3] = 255;
      }
      this.ctx.putImageData(img, 0, 0);
    } catch (e) { /* preview fallback: plain frame already drawn */ }
  }

  sampleColor() {
    try {
      const [W, H] = this.canvasSize();
      const img = this.ctx.getImageData(Math.round(W / 2), Math.round(H / 2), 1, 1);
      const d = img.data;
      this.state.chroma.color = [d[0] / 255, d[1] / 255, d[2] / 255];
      const hex = this.colorToHex(this.state.chroma.color);
      const picker = this.chromaPanel.querySelector('input[type="color"]');
      if (picker) picker.value = hex;
      this.updateStatus("Key color sampled from the frame center — click again elsewhere if needed.");
      this.commitChanges();
    } catch (e) {
      this.updateStatus("Sampling failed — ensure the video is loaded.");
    }
  }

  colorToHex(color) {
    return "#" + color.map(v => Math.round(veClamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("");
  }

  hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /* ---------------- key strip ---------------- */
  drawKeyStrip() {
    if (!this.keyCanvas || !this.keyCtx) return;
    const ctx = this.keyCtx;
    const w = this.keyCanvas.clientWidth || 800;
    const h = 26;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, w, h);
    const dur = Math.max(0.1, this.durationSec);
    this.state.mask.keys.forEach(k => {
      const x = (k.t / dur) * w;
      ctx.fillStyle = "#ff5a5a";
      ctx.beginPath();
      ctx.arc(x, h / 2, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    const x = (this.playhead / dur) * w;
    ctx.strokeStyle = "#4aa47f";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  /* ---------------- mode / option toggles ---------------- */
  toggleMode() {
    this.state.mode = this.state.mode === "inpaint" ? "chroma" : "inpaint";
    this.refreshModePanels();
    this.refreshToggleStates();
    this.commitChanges();
  }

  refreshModePanels() {
    if (!this.inpaintPanel || !this.chromaPanel) return;
    this.inpaintPanel.style.display = this.state.mode === "inpaint" ? "flex" : "none";
    this.chromaPanel.style.display = this.state.mode === "chroma" ? "flex" : "none";
    this.modeBtn.textContent = "Mode: " + (this.state.mode === "inpaint" ? "Inpaint" : "Chroma");
    this.previewHint.textContent = this.state.mode === "inpaint"
      ? "draw the region — red = edited area"
      : "green screen — transparent shows the checkerboard";
  }

  setTool(t) { this._tool = t; this.refreshToggleStates(); }
  setEdit(e) { this.state.edit = e; this.refreshToggleStates(); this.commitChanges(); }
  setPlate(c) { this.state.plate_color = c; this.refreshToggleStates(); this.commitChanges(); }
  setOutput(o) { this.state.output = o; this.refreshToggleStates(); this.commitChanges(); }

  refreshToggleStates() {
    const on = (map, key) => {
      Object.keys(map).forEach(k => map[k].classList.toggle("active", k === key));
    };
    on(this.toolBtns, this._tool);
    on(this.editBtns, this.state.edit);
    on(this.plateBtns, this.state.plate_color);
    on(this.outputBtns, this.state.output);
  }

  /* ---------------- project save / load ---------------- */
  async saveProject() {
    const payload = JSON.stringify({
      version: 1,
      fps: this.fps,
      ...JSON.parse(this.serialize()),
    }, null, 2);
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: "chaotic_h3_video_edit.json",
          types: [{ description: "Chaotic H3 Video Edit", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(payload);
        await writable.close();
        this.updateStatus("Video edit project saved.");
      } else {
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "chaotic_h3_video_edit.json";
        a.click();
        URL.revokeObjectURL(url);
        this.updateStatus("Video edit project downloaded.");
      }
    } catch (err) {
      if (err.name !== "AbortError") console.error("[ChaoticVideoEdit] save failed", err);
    }
  }

  async loadProject() {
    const apply = text => {
      try {
        const data = JSON.parse(text);
        let raw = data;
        if (data && typeof data === "object" && data.edit && typeof data.edit === "object") raw = data;
        if (typeof raw !== "object" || raw === null) {
          this.updateStatus("Load failed: not a Chaotic H3 Video Edit file.");
          return;
        }
        this._applyState(raw);
        this.refreshModePanels();
        this.refreshToggleStates();
        this.commitChanges();
        this.updateStatus("Video edit project loaded.");
      } catch (err) {
        this.updateStatus("Load failed: " + (err && err.message ? err.message : err));
      }
    };
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "Chaotic H3 Video Edit", accept: { "application/json": [".json"] } }],
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
      if (err.name !== "AbortError") console.error("[ChaoticVideoEdit] load failed", err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Extension registration                                             */
/* ------------------------------------------------------------------ */
app.registerExtension({
  name: "Chaotic.MinimaxH3VideoEdit",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "ChaoticH3VideoEdit") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      const container = document.createElement("div");
      container.style.width = "100%";
      container.style.height = "100%";

      const widget = this.addDOMWidget("chaotic_video_edit", "chaotic_video_edit", container, {
        getValue: () => "",
        setValue: () => {},
      });

      const self = this;
      widget.computeSize = function () {
        const width = Math.max(700, (self.size && self.size[0]) || 1100);
        return [Math.max(10, width - 24), Math.round(width * 9 / 16) + 240];
      };

      setTimeout(() => {
        try {
          self._videoEditEditor = new ChaoticVideoEdit(self, container, widget);
          if (self.size && self.size[0] < 700) self.size = [1100, 760];
          container.style.height = "100%";
          widget.computeSize();
          self.setDirtyCanvas(true, true);
        } catch (err) {
          console.error("[ChaoticVideoEdit] init failed", err);
        }
      }, 0);

      return r;
    };
  },
});
