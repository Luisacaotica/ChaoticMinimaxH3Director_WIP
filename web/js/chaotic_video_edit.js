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
.ve-refs{display:flex;gap:4px;flex-wrap:wrap;align-items:center;padding:2px 0}
.ve-refcell{position:relative;flex:none}
.ve-refcell img{width:64px;height:36px;object-fit:cover;border-radius:3px;background:#000;border:1px solid #2e2e2e}
.ve-refdel{position:absolute;top:-6px;right:-6px;padding:0 4px;font-size:9px;min-width:16px}
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

function veDiffMask(grayA, grayB, w, h, thr) {
  /* Per-pixel |A-B| > thr -> 1. Returns Uint8Array (0/1). */
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (Math.abs(grayA[i] - grayB[i]) > thr) out[i] = 1;
  }
  return out;
}

function veEdgeBlobs(diff, w, h, edge, marginFrac, minArea) {
  /* Connected components of `diff` pixels that TOUCH the edge band.
     edge: "x" -> left/right columns, "y" -> top/bottom rows (the reframe
     letterbox axis where the void meets the source).
     Returns [{ x0, y0, x1, y1 }] bounding boxes, area >= minArea. */
  const mw = Math.max(1, Math.round(w * marginFrac));
  const mh = Math.max(1, Math.round(h * marginFrac));
  const inBand = (x, y) => (edge === "x" ? x < mw || x >= w - mw : y < mh || y >= h - mh);
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!diff[i] || seen[i] || !inBand(x, y)) continue;
      let x0 = x, x1 = x, y0 = y, y1 = y, count = 0;
      stack.length = 0;
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop();
        const cy = (j / w) | 0, cx = j - cy * w;
        count++;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        const nb = [j - w, j + w, j - 1, j + 1];
        for (const ni of nb) {
          if (ni < 0 || ni >= w * h) continue;
          if (diff[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
        }
      }
      if (count >= minArea) out.push({ x0, y0, x1, y1 });
    }
  }
  return out;
}

function veBlobOverlap(a, b) {
  /* Intersection / min-area overlap ratio in [0, 1]. */
  const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / Math.min((a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1), (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
}

function veClusterCandidates(samples, maxObjects) {
  /* Chain edge-crossing samples into objects (consecutive blobs that overlap),
     return the strongest occurrence of each, biggest-first, capped.
     samples: [{ t, blob }] sorted by t. */
  const objs = [];
  let cur = null;
  for (const s of samples) {
    const b = s.blob;
    const area = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
    if (cur && s.t - cur.lastT <= 1.0 && veBlobOverlap(cur.lastBlob, b) > 0.1) {
      cur.samples.push(s);
      cur.lastT = s.t;
      cur.lastBlob = b;
      if (area > cur.best.area) cur.best = { t: s.t, blob: b, area };
    } else {
      cur = { samples: [s], lastT: s.t, lastBlob: b, best: { t: s.t, blob: b, area } };
      objs.push(cur);
    }
  }
  objs.sort((a, b) => b.best.area - a.best.area);
  return objs.slice(0, Math.max(1, maxObjects)).map(o => o.best);
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

function veDetectKeyColor(imageData, margin, bins) {
  /* Dominant backing color of a frame's border ring (the screen fills the
     edges in a chroma setup) -> { color: [r,g,b] 0..1, frac }. Mirrors
     video_edit.py detect_key_color exactly: same ring, same quantization,
     same first-max tie-break — green, blue, magenta, any flat backdrop. */
  margin = margin || 0.12;
  bins = bins || 6;
  const w = imageData.width, h = imageData.height;
  const d = imageData.data;
  const mh = Math.max(1, Math.round(h * margin));
  const mw = Math.max(1, Math.round(w * margin));
  const nBins = bins * bins * bins;
  const counts = new Uint32Array(nBins);
  const sumR = new Float64Array(nBins), sumG = new Float64Array(nBins), sumB = new Float64Array(nBins);
  const add = (x, y) => {
    const i = (y * w + x) * 4;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const q = Math.min(bins - 1, Math.floor(r * bins)) * bins * bins
      + Math.min(bins - 1, Math.floor(g * bins)) * bins
      + Math.min(bins - 1, Math.floor(b * bins));
    counts[q]++; sumR[q] += r; sumG[q] += g; sumB[q] += b;
  };
  for (let y = 0; y < mh; y++) for (let x = 0; x < w; x++) add(x, y);      // top ring
  for (let y = h - mh; y < h; y++) for (let x = 0; x < w; x++) add(x, y);   // bottom ring
  for (let x = 0; x < mw; x++) for (let y = 0; y < h; y++) add(x, y);       // left ring
  for (let x = w - mw; x < w; x++) for (let y = 0; y < h; y++) add(x, y);   // right ring
  let best = 0, bestN = counts[0];
  for (let q = 1; q < nBins; q++) {
    if (counts[q] > bestN) { bestN = counts[q]; best = q; }
  }
  if (bestN === 0) return { color: [0, 0, 0], frac: 0 };
  let total = 0;
  for (let q = 0; q < nBins; q++) total += counts[q];
  return {
    color: [sumR[best] / bestN, sumG[best] / bestN, sumB[best] / bestN],
    frac: bestN / Math.max(1, total),
  };
}

class ChaoticVideoEdit {
  constructor(node, container, domWidget) {
    this.node = node;
    this.container = container;
    this.domWidget = domWidget;

    this.state = {
      version: 1, mode: "inpaint", edit: "inside", plate_color: "black",
      output: "full", crop_scale: 1.0, outpaint: false, prompt: "", video_file: "",
      render_in: null, render_out: null,
      mask: { type: "rect", keys: [] },
      chroma: { color: [0, 1, 0], similarity: 0.35, smooth: 0.12, spill: 0.15, auto: false },
      reframe: { target_w: 1280, target_h: 720, feather: 8, align_x: 0.5, align_y: 0.5, scale: 1, rotation: 0, fit: "contain", track: [] },
      refs: [],
      video_fps: null,
    };
    this.playhead = 0;
    this.playing = false;
    this._tool = "brush";
    this._drawing = false;
    this._rectAnchor = null;
    this._rfTool = "brush";   // reframe tool: brush (preserve) | move (window)
    this._dragWin = null;     // active window drag state
    this._autoPreserving = false;
    this._autoOpts = { stride: 0.5, margin: 0.15, minArea: 12, maxObjects: 3, floor: 0.55 };
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
      render_in: null, render_out: null,
      mask: { type: "rect", keys: [] },
      chroma: { color: [0, 1, 0], similarity: 0.35, smooth: 0.12, spill: 0.15, auto: false },
      reframe: { target_w: 1280, target_h: 720, feather: 8, align_x: 0.5, align_y: 0.5, scale: 1, rotation: 0, fit: "contain", track: [] },
      refs: [],
      video_fps: null }));
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
      mode: raw.mode === "chroma" || raw.mode === "reframe" ? raw.mode : "inpaint",
      edit: raw.edit === "outside" ? "outside" : "inside",
      plate_color: raw.plate_color === "green" ? "green" : "black",
      output: raw.output === "crop" ? "crop" : "full",
      crop_scale: veClamp(Number(raw.crop_scale) || 1, 0.1, 4),
      outpaint: !!raw.outpaint,
      prompt: typeof raw.prompt === "string" ? raw.prompt : "",
      video_file: typeof raw.video_file === "string" ? raw.video_file : "",
      render_in: raw.render_in == null ? null : veClamp(Number(raw.render_in) || 0, 0, 86400),
      render_out: raw.render_out == null ? null : veClamp(Number(raw.render_out) || 0, 0, 86400),
      mask: { type: raw.mask && raw.mask.type === "brush" ? "brush" : "rect", keys: [] },
      chroma: {
        color: Array.isArray(raw.chroma && raw.chroma.color) && raw.chroma.color.length >= 3
          ? raw.chroma.color.slice(0, 3).map(v => veClamp(Number(v) || 0, 0, 1))
          : [0, 1, 0],
        similarity: veClamp(Number(raw.chroma && raw.chroma.similarity) || 0.35, 0, 0.95),
        smooth: veClamp(Number(raw.chroma && raw.chroma.smooth) || 0.12, 0, 0.5),
        spill: veClamp(Number(raw.chroma && raw.chroma.spill) || 0.15, 0, 0.9),
        auto: !!(raw.chroma && raw.chroma.auto),
      },
    };
    if (this.state.render_in != null && this.state.render_out != null && this.state.render_out <= this.state.render_in) {
      this.state.render_in = null;
      this.state.render_out = null;
    }
    const rawRf = raw.reframe || {};
    this.state.reframe = {
      target_w: Math.max(16, Math.min(4096, parseInt(rawRf.target_w, 10) || 1280)),
      target_h: Math.max(16, Math.min(4096, parseInt(rawRf.target_h, 10) || 720)),
      feather: Math.max(0, Math.min(64, parseInt(rawRf.feather, 10) || 8)),
      /* NB: `Number(x) || 0.5` would map a saved 0 (flush left/top) to 0.5
         (falsy) — use explicit null checks so flush placements survive reload */
      align_x: rawRf.align_x == null ? 0.5 : veClamp(Number(rawRf.align_x) || 0, 0, 1),
      align_y: rawRf.align_y == null ? 0.5 : veClamp(Number(rawRf.align_y) || 0, 0, 1),
      scale: veClamp(Number(rawRf.scale) || 1, 0.1, 4),
      rotation: veClamp(Number(rawRf.rotation) || 0, -180, 180),
      fit: rawRf.fit === "smaller" ? "smaller" : "contain",
      track: Array.isArray(rawRf.track)
        ? rawRf.track
            .filter(k => k && typeof k.t !== "boolean" && isFinite(Number(k.t)) && Number(k.t) >= 0)
            .map(k => ({
              t: Math.round(Number(k.t) * 1000) / 1000,
              ax: k.ax == null ? 0.5 : veClamp(Number(k.ax) || 0, 0, 1),
              ay: k.ay == null ? 0.5 : veClamp(Number(k.ay) || 0, 0, 1),
            }))
            .sort((a, b) => a.t - b.t)
        : [],
    };
    this.state.refs = Array.isArray(raw.refs)
      ? raw.refs.filter(r => r && typeof r.src === "string" && r.src)
        .map(r => ({ src: r.src, at: Number(r.at) || 0, note: typeof r.note === "string" ? r.note : "" }))
      : [];
    const vfps = Number(raw.video_fps);
    this.state.video_fps = isFinite(vfps) && vfps >= 1 && vfps <= 240 ? vfps : null;
    if (this.refsRow) this.renderRefsRow();
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
    btnPlay.title = "play/pause the preview (with audio)";
    const btnMute = this.btn("🔊", () => this.toggleMute());
    btnMute.title = "mute / unmute the preview audio";
    this.muteBtn = btnMute;
    const btnRef = this.btn("⧉ Copy to ref", () => this.copyToReference());
    btnRef.title = "copy the rectangle selection as a reference image (ref_images output)";
    this.refBtn = btnRef;
    toolbar.append(btnLoad, btnMode, btnPlay, btnMute, btnSave, btnLoadP, btnRef);
    this.wrapper.appendChild(toolbar);

    /* framerate row: the node's fps widget is the fixed latent rate — keep it
       in sync with the source file so mask key times line up */
    const fpsRow = document.createElement("div");
    fpsRow.className = "ve-row";
    this.fpsInfo = document.createElement("span");
    this.fpsInfo.className = "ve-label";
    this.fpsInfo.textContent = "fps: node " + this.fpsWidgetValue();
    const useFps = this.btn("Use file fps", () => this.useFileFps());
    useFps.title = "set the node's fps widget to the source file's real framerate";
    fpsRow.appendChild(this.fpsInfo);
    fpsRow.appendChild(useFps);
    this.wrapper.appendChild(fpsRow);

    /* copy-to-reference strip */
    this.refsRow = document.createElement("div");
    this.refsRow.className = "ve-refs";
    this.refsRow.style.display = "none";
    this.wrapper.appendChild(this.refsRow);

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
    colorIn.addEventListener("input", () => {
      this.state.chroma.color = this.hexToRgb(colorIn.value);
      this.state.chroma.auto = false;
      this.refreshChromaUI();
      this.commitChanges();
    });
    const sampleBtn = this.btn("Sample", () => this.sampleColor());
    colorRow.appendChild(colorIn);
    colorRow.appendChild(sampleBtn);
    this.chromaPanel.appendChild(colorRow);

    /* screen presets (green / blue / magenta) + auto-detect */
    const presetRow = document.createElement("div");
    presetRow.className = "ve-row";
    presetRow.appendChild(this.btnL("Screen"));
    [["Green", [0, 1, 0]], ["Blue", [0, 0, 1]], ["Magenta", [1, 0, 1]]].forEach(([label, rgb]) => {
      const b = this.btn(label, () => this.setChromaPreset(rgb));
      b.title = "key color " + label + " screen";
      presetRow.appendChild(b);
    });
    const autoBtn = this.btn("Auto", () => this.toggleChromaAuto());
    autoBtn.title = "detect the dominant backing color from the video at render time";
    this.autoBtn = autoBtn;
    const detectBtn = this.btn("Detect", () => this.detectChromaColor(false));
    detectBtn.title = "grab the most prominent border color from the current frame";
    presetRow.appendChild(autoBtn);
    presetRow.appendChild(detectBtn);
    this.chromaPanel.appendChild(presetRow);

    const simRow = document.createElement("div");
    simRow.className = "ve-row";
    simRow.appendChild(this.btnL("Similarity"));
    simRow.appendChild(this.slider("similarity", 0, 0.95, 0.01));
    simRow.appendChild(this.btnL("Smooth"));
    simRow.appendChild(this.slider("smooth", 0, 0.5, 0.01));
    simRow.appendChild(this.btnL("Spill"));
    simRow.appendChild(this.slider("spill", 0, 0.9, 0.01));
    this.chromaPanel.appendChild(simRow);
    const chromaHint = document.createElement("div");
    chromaHint.className = "ve-hint";
    chromaHint.innerHTML = "How to use: <b>①</b> press <b>Sample</b> (or click the preview / <b>Detect</b> for auto) to pick the backing color — green, blue or any screen · <b>②</b> drag <b>Similarity + Smooth</b> until the subject looks clean on the checkerboard · <b>③</b> the <b>checkerboard = transparency</b>: the keyed foreground plate composites over any background (place it in the Director / Mockup). <b>Spill</b> removes color bleed. The plate output is the cut-out ready to composite — no inpainting needed here.";
    this.chromaPanel.appendChild(chromaHint);
    this.wrapper.appendChild(this.chromaPanel);

    /* reframe panel */
    this.reframePanel = document.createElement("div");
    this.reframePanel.className = "ve-panel";
    this.reframePanel.style.display = "none";
    const rfTitle = document.createElement("div");
    rfTitle.className = "ve-panel-title";
    rfTitle.innerHTML = "<span>Reframe (outpaint outside)</span>";
    this.reframePanel.appendChild(rfTitle);

    /* tools: brush strokes preserve; move drags the source window anywhere */
    const rfToolRow = document.createElement("div");
    rfToolRow.className = "ve-row";
    rfToolRow.appendChild(this.btnL("Tool"));
    const brushBtn = this.btn("Brush (preserve)", () => this.setRfTool("brush"));
    brushBtn.title = "paint strokes = preserve regions (people/objects crossing the edge)";
    const moveBtn = this.btn("✥ Move window", () => this.setRfTool("move"));
    moveBtn.title = "drag the source window anywhere inside the target";
    brushBtn.className = "ve-btn active";
    this.rfToolBtns = { brush: brushBtn, move: moveBtn };
    rfToolRow.appendChild(brushBtn);
    rfToolRow.appendChild(moveBtn);
    this.reframePanel.appendChild(rfToolRow);

    const aspectRow = document.createElement("div");
    aspectRow.className = "ve-row";
    aspectRow.appendChild(this.btnL("Aspect"));
    [["9:16", 720, 1280], ["16:9", 1280, 720], ["4:3", 1024, 768], ["1:1", 1024, 1024], ["21:9", 1344, 576]].forEach(([label, w, h]) => {
      const b = this.btn(label, () => this.setReframeTarget(w, h));
      b.title = "target " + w + "×" + h;
      aspectRow.appendChild(b);
    });
    this.reframePanel.appendChild(aspectRow);

    /* fit mode: contain fills the tight axis at 100% (max resolution); smaller
       shrinks the base fit so the window has room on both axes and the move
       tool can drag it to any position (free 2D placement) */
    const fitRow = document.createElement("div");
    fitRow.className = "ve-row";
    fitRow.appendChild(this.btnL("Fit"));
    const fitContain = this.btn("Contain", () => this.setRfFit("contain"));
    fitContain.title = "fill the tight axis at 100% size (max resolution, window pinned to an edge at scale 1)";
    const fitSmaller = this.btn("Smaller", () => this.setRfFit("smaller"));
    fitSmaller.title = "fit at 80% so the window keeps margin on both axes — drag it anywhere (free 2D placement)";
    fitContain.className = "ve-btn active";
    this.rfFitBtns = { contain: fitContain, smaller: fitSmaller };
    fitRow.appendChild(fitContain);
    fitRow.appendChild(fitSmaller);
    this.reframePanel.appendChild(fitRow);

    const sizeRow = document.createElement("div");
    sizeRow.className = "ve-row";
    sizeRow.appendChild(this.btnL("Custom W"));
    const wIn = document.createElement("input");
    wIn.className = "ve-input"; wIn.type = "number"; wIn.min = "16"; wIn.max = "4096";
    wIn.value = String(this.state.reframe.target_w);
    wIn.addEventListener("change", () => this.setReframeTarget(Math.max(16, Math.min(4096, parseInt(wIn.value, 10) || 1280)), this.state.reframe.target_h));
    const hIn = document.createElement("input");
    hIn.className = "ve-input"; hIn.type = "number"; hIn.min = "16"; hIn.max = "4096";
    hIn.value = String(this.state.reframe.target_h);
    hIn.addEventListener("change", () => this.setReframeTarget(this.state.reframe.target_w, Math.max(16, Math.min(4096, parseInt(hIn.value, 10) || 720))));
    this._rfWIn = wIn;
    this._rfHIn = hIn;
    sizeRow.appendChild(wIn);
    sizeRow.appendChild(this.btnL("H"));
    sizeRow.appendChild(hIn);
    sizeRow.appendChild(this.btnL("Feather"));
    const feather = document.createElement("input");
    feather.className = "ve-range"; feather.type = "range"; feather.min = "0"; feather.max = "32"; feather.step = "1";
    feather.value = String(this.state.reframe.feather);
    feather.style.flex = "0 0 70px";
    feather.addEventListener("input", () => { this.state.reframe.feather = Number(feather.value); feather.title = "feather: " + feather.value; this.commitChanges(); });
    sizeRow.appendChild(feather);
    this.reframePanel.appendChild(sizeRow);

    const alignRow = document.createElement("div");
    alignRow.className = "ve-row";
    alignRow.appendChild(this.btnL("Align H"));
    this.alignBtns = { align_x: {}, align_y: {} };
    [["L", 0], ["C", 0.5], ["R", 1]].forEach(([label, v]) => {
      const b = this.btn(label, () => this.setReframeAlign("align_x", v));
      b.title = "horizontal placement " + (v === 0 ? "left" : v === 1 ? "right" : "center");
      this.alignBtns.align_x[v] = b;
      alignRow.appendChild(b);
    });
    alignRow.appendChild(this.btnL("V"));
    [["T", 0], ["M", 0.5], ["B", 1]].forEach(([label, v]) => {
      const b = this.btn(label, () => this.setReframeAlign("align_y", v));
      b.title = "vertical placement " + (v === 0 ? "top" : v === 1 ? "bottom" : "middle");
      this.alignBtns.align_y[v] = b;
      alignRow.appendChild(b);
    });
    this.reframePanel.appendChild(alignRow);

    /* window transform: size + rotation (the move tool's ✥ handles drag these) */
    const xformRow = document.createElement("div");
    xformRow.className = "ve-row";
    xformRow.appendChild(this.btnL("Size"));
    const rfScaleIn = document.createElement("input");
    rfScaleIn.className = "ve-range"; rfScaleIn.type = "range"; rfScaleIn.min = "0.1"; rfScaleIn.max = "4"; rfScaleIn.step = "0.01";
    rfScaleIn.value = String(this.state.reframe.scale);
    rfScaleIn.style.flex = "0 0 64px";
    rfScaleIn.addEventListener("input", () => { this.state.reframe.scale = veClamp(Number(rfScaleIn.value), 0.1, 4); this.refreshReframeUI(); this.drawPreview(); this.commitChanges(); });
    const rfScaleLbl = document.createElement("span");
    rfScaleLbl.style.font = "10px ui-monospace, monospace";
    rfScaleLbl.style.color = "#9fb6c9";
    rfScaleLbl.style.minWidth = "44px";
    rfScaleLbl.style.textAlign = "right";
    xformRow.appendChild(rfScaleIn);
    xformRow.appendChild(rfScaleLbl);
    const scaleReset = this.btn("1×", () => { this.state.reframe.scale = 1; this.refreshReframeUI(); this.drawPreview(); this.commitChanges(); });
    scaleReset.title = "reset size to 100%";
    xformRow.appendChild(scaleReset);
    this._rfScaleIn = rfScaleIn;
    this._rfScaleLbl = rfScaleLbl;
    this.reframePanel.appendChild(xformRow);

    const rotRow = document.createElement("div");
    rotRow.className = "ve-row";
    rotRow.appendChild(this.btnL("Rotate"));
    const rfRotIn = document.createElement("input");
    rfRotIn.className = "ve-range"; rfRotIn.type = "range"; rfRotIn.min = "-180"; rfRotIn.max = "180"; rfRotIn.step = "1";
    rfRotIn.value = String(this.state.reframe.rotation);
    rfRotIn.style.flex = "0 0 64px";
    rfRotIn.addEventListener("input", () => { this.state.reframe.rotation = veClamp(Number(rfRotIn.value), -180, 180); this.refreshReframeUI(); this.drawPreview(); this.commitChanges(); });
    const rfRotLbl = document.createElement("span");
    rfRotLbl.style.font = "10px ui-monospace, monospace";
    rfRotLbl.style.color = "#9fb6c9";
    rfRotLbl.style.minWidth = "44px";
    rfRotLbl.style.textAlign = "right";
    rotRow.appendChild(rfRotIn);
    rotRow.appendChild(rfRotLbl);
    const rotReset = this.btn("0°", () => { this.state.reframe.rotation = 0; this.refreshReframeUI(); this.drawPreview(); this.commitChanges(); });
    rotReset.title = "reset rotation to 0°";
    rotRow.appendChild(rotReset);
    this._rfRotIn = rfRotIn;
    this._rfRotLbl = rfRotLbl;
    this.reframePanel.appendChild(rotRow);

    /* subject tracking: NCC-track the painted subject, keyframe the window */
    const subjRow = document.createElement("div");
    subjRow.className = "ve-row";
    const btnTrackSubj = this.btn("🎯 Track subject", () => this.trackReframeSubject());
    btnTrackSubj.title = "paint the subject with the Brush (preserve) tool, then track it across the clip — the window follows, keeping them framed (writes position keyframes; drag the window to add/override a key at the playhead)";
    const btnClearTrk = this.btn("✕ Clear track", () => this.clearTrack());
    btnClearTrk.title = "remove all track keyframes and snap the window back to static alignment";
    subjRow.appendChild(btnTrackSubj);
    subjRow.appendChild(btnClearTrk);
    const rfTrackLbl = document.createElement("span");
    rfTrackLbl.style.font = "10px ui-monospace, monospace";
    rfTrackLbl.style.color = "#9fb6c9";
    rfTrackLbl.style.marginLeft = "auto";
    rfTrackLbl.textContent = "static";
    subjRow.appendChild(rfTrackLbl);
    this.trackSubjectBtn = btnTrackSubj;
    this.clearTrackBtn = btnClear;
    this._rfTrackLbl = rfTrackLbl;
    this.reframePanel.appendChild(subjRow);

    /* auto-preserve: detect edge-crossing objects, write preserve strokes */
    const autoRow = document.createElement("div");
    autoRow.className = "ve-row";
    const btnAuto = this.btn("🛡 Auto preserve", () => this.autoPreserve());
    btnAuto.title = "detect objects crossing the reframe edge and write preserve strokes that follow them (NCC tracker)";
    this.autoBtn = btnAuto;
    autoRow.appendChild(btnAuto);
    autoRow.appendChild(this.btnL("Every"));
    const strideSel = document.createElement("select");
    strideSel.className = "ve-input";
    [[0.25, "0.25s"], [0.5, "0.5s"], [1, "1s"], [2, "2s"]].forEach(([v, l]) => {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = l;
      strideSel.appendChild(o);
    });
    strideSel.value = String(this._autoOpts.stride);
    strideSel.addEventListener("change", () => { this._autoOpts.stride = Number(strideSel.value); });
    autoRow.appendChild(strideSel);
    autoRow.appendChild(this.btnL("Max"));
    const maxSel = document.createElement("select");
    maxSel.className = "ve-input";
    [1, 2, 3, 4, 5, 6].forEach(v => {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = String(v);
      maxSel.appendChild(o);
    });
    maxSel.value = String(this._autoOpts.maxObjects);
    maxSel.addEventListener("change", () => { this._autoOpts.maxObjects = Number(maxSel.value); });
    autoRow.appendChild(maxSel);
    this.reframePanel.appendChild(autoRow);

    const rfHint = document.createElement("div");
    rfHint.className = "ve-hint";
    rfHint.style.position = "static";
    rfHint.textContent = "the source fits inside the target window; the dimmed outside is the outpaint region. ✥ Move window: drag to place, the ⬤ knob rotates (Shift = 15°), the ◼ knob scales (0.1×–4×). Brush strokes = preserve (people/objects crossing the edge stay intact).";
    this.reframePanel.appendChild(rfHint);
    this.wrapper.appendChild(this.reframePanel);
    this.refreshReframeUI();

    /* status */
    this.statusLine = document.createElement("div");
    this.statusLine.className = "ve-statusline";
    this.wrapper.appendChild(this.statusLine);

    this.container.appendChild(this.wrapper);

    /* interactions */
    this.canvas.addEventListener("mousedown", e => this.onCanvasDown(e));
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener("keydown", e => this.onKeyDown(e));
    if (typeof document.addEventListener === "function") {
      /* only act when THIS editor is focused — keeps per-node keydown from
         firing while another Chaotic node (or a ComfyUI widget) has focus */
      document.addEventListener("keydown", e => {
        if (this.wrapper && this.wrapper.contains(e.target)) this.onKeyDown(e);
      });
    }
    this.canvas.addEventListener("mousemove", e => this.onCanvasMove(e));
    this.canvas.addEventListener("dblclick", e => this.onCanvasDbl(e));
    this.canvas.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!this.videoEl || !this.videoEl.src) this.pickVideo();
      else this.updateStatus("Right-click: video loaded. Double-click the canvas to play/pause. Draw with Brush/Rect → Set Mask Key.");
    });
    document.addEventListener("mouseup", () => this.onCanvasUp());
    this.keyCanvas.addEventListener("mousedown", e => this.onKeyStripDown(e));
    this.wrapper.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
    this.wrapper.addEventListener("drop", e => this.onDrop(e));
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.style.display = "none";
    this.wrapper.appendChild(this.fileInput);

    this.videoEl = document.createElement("video");
    this.videoEl.muted = false;   /* audible scrub + playback */
    this.videoEl.playsInline = true;
    this.videoEl.preload = "auto";
    this.videoEl.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;pointer-events:none;";
    if (this.previewBox) this.previewBox.appendChild(this.videoEl);
    this.videoEl.addEventListener("loadedmetadata", () => this.onVideoMeta());
    this.videoEl.addEventListener("timeupdate", () => { if (!this.playing) this.setPlayhead(this.videoEl.currentTime); });

    this.refreshModePanels();
    this.refreshToggleStates();
    this.refreshChromaUI();
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
    /* keep the preview in sync with the node's runtime auto-detect (frame 0) */
    if (this.state.chroma.auto) this.detectChromaColor(true);
    this.measureFps();
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

  toggleMute() {
    this.videoEl.muted = !this.videoEl.muted;
    this.muteBtn.textContent = this.videoEl.muted ? "🔇" : "🔊";
    this.muteBtn.title = this.videoEl.muted ? "preview audio muted" : "mute / unmute the preview audio";
    this.updateStatus(this.videoEl.muted ? "Preview audio muted." : "Preview audio on — scrub and press ▶ to hear the clip.");
  }

  onCanvasDbl(e) {
    /* double-click inserts a video; with one loaded it plays/pauses */
    if (!this.videoEl || !this.videoEl.src) {
      this.pickVideo();
      return;
    }
    this.togglePlay();
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
    const pct = Math.round(veClamp(frac, 0, 1) * 100);
    const ctl = this._trackUI;
    if (ctl) {
      if (ctl.btn) { ctl.btn.disabled = !!active; ctl.btn.textContent = active ? ctl.label + "… " + pct + "%" : ctl.label; }
      if (ctl.prog) ctl.prog.style.width = pct + "%";
      return;
    }
    if (this.trackBtn) {
      this.trackBtn.disabled = !!active;
      this.trackBtn.textContent = active ? "Tracking… " + pct + "%" : "Track Mask";
    }
    if (this.trackProg) this.trackProg.style.width = pct + "%";
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
    if (this.state.mode === "reframe" && this._rfTool === "move") {
      this.startWindowDrag(e);
      return;
    }
    if (this.state.mode === "chroma") return;
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
    if (this._dragWin) { this.moveWindowDrag(e); return; }
    if (!this._drawing) {
      /* hover feedback for the move tool's rotate/scale handles */
      if (this.state.mode === "reframe" && this._rfTool === "move" && this.canvas) {
        const [W, H] = this.canvasSize();
        const rect = this.canvas.getBoundingClientRect();
        const h = this.reframeHandleAt(e.clientX - rect.left, e.clientY - rect.top, W, H);
        this.canvas.style.cursor = h === "rotate" ? "grab" : h === "scale" ? "nwse-resize" : "move";
      }
      return;
    }
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
    if (this._dragWin) { this._dragWin = null; this.endWindowDrag(); return; }
    if (!this._drawing) return;
    if (this._tool === "rect" && this._rectAnchor && this._lastNorm) {
      this.fillRectFromAnchor();
      /* keep the selection for copy-to-reference */
      const a = this._rectAnchor, p = this._lastNorm;
      this._selRect = {
        x0: Math.min(a.x, p.x), y0: Math.min(a.y, p.y),
        x1: Math.max(a.x, p.x), y1: Math.max(a.y, p.y),
      };
      this.drawPreview();
    }
    this._drawing = false;
    this._rectAnchor = null;
  }

  paintBrush(p) {
    if (this.state.mode === "reframe") {
      const s = this.reframeCanvasToSource(p.x, p.y);
      if (!s) return;   // strokes in the void (outside the source) are ignored
      p = s;
    }
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
    let a = this._rectAnchor, b = p;
    if (this.state.mode === "reframe") {
      a = this.reframeCanvasToSource(a.x, a.y);
      b = this.reframeCanvasToSource(b.x, b.y);
      if (!a || !b) return;   // a selection in the void selects nothing
    }
    const ax = Math.round(Math.min(a.x, b.x) * (this._gridW - 1));
    const bx = Math.round(Math.max(a.x, b.x) * (this._gridW - 1));
    const ay = Math.round(Math.min(a.y, b.y) * (this._gridH - 1));
    const by = Math.round(Math.max(a.y, b.y) * (this._gridH - 1));
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
    this.drawStagePattern(ctx, W, H);   /* checkerboard stage — no dead black bars */
    const hasVideo = this.videoEl && this.videoEl.src && this.videoEl.readyState >= 1;
    if (hasVideo) {
      const vw = this.videoEl.videoWidth || W, vh = this.videoEl.videoHeight || H;
      const s = Math.min(W / vw, H / vh);
      const dw = vw * s, dh = vh * s;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      ctx.drawImage(this.videoEl, dx, dy, dw, dh);
      if (this.state.mode !== "reframe") this.drawSelectionOverlay(W, H);
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
    if (this.state.mode === "reframe") {
      this.drawReframeFraming(W, H);
      this.drawSelectionOverlay(W, H);  // after the window repaint so it stays visible
    }
    /* mask overlay (red) from the interpolated grid — mapped through the same
       placement the render uses (the reframe window, or the canvas-centered
       contain-fit otherwise) so strokes sit on the video */
    const interp = this.interpolatedMaskGrid(this.playhead);
    if (!interp && !this._workMask) return;
    const overlay = new Uint8ClampedArray(W * H);
    const gw = this._gridW, gh = this._gridH;
    const vw = this.videoEl.videoWidth || W, vh = this.videoEl.videoHeight || H;
    let ox, oy, pxPerGridX, pxPerGridY, affine = null;
    if (this.state.mode === "reframe") {
      const w = this.reframeWindow(W, H);
      if (Math.abs(w.rot) > 1e-4 || Math.abs(w.scale - 1) > 1e-4) {
        affine = true;   // rotated/scaled: per-pixel inverse mapping below
      } else {
        ox = w.sx; oy = w.sy;
        pxPerGridX = w.sw / gw; pxPerGridY = w.sh / gh;
      }
    } else {
      const s = Math.min(W / vw, H / vh);
      ox = (W - vw * s) / 2; oy = (H - vh * s) / 2;
      pxPerGridX = (vw * s) / gw; pxPerGridY = (vh * s) / gh;
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let gx, gy;
        if (affine) {
          const s = this.reframeCanvasToSource(x / W, y / H);
          if (!s) continue;
          gx = Math.floor(s.x * (gw - 1));
          gy = Math.floor(s.y * (gh - 1));
        } else {
          gx = Math.floor((x - ox) / pxPerGridX);
          gy = Math.floor((y - oy) / pxPerGridY);
        }
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

  drawStagePattern(ctx, W, H) {
    /* subtle checkerboard so letterbox areas read as "empty stage", not a bar */
    ctx.fillStyle = "#16181b";
    ctx.fillRect(0, 0, W, H);
    const cell = 14;
    ctx.fillStyle = "#1c1f23";
    for (let y = 0; y < H; y += cell) {
      for (let x = (Math.floor(y / cell) % 2) * cell; x < W; x += cell * 2) {
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }

  drawChromaPreview(W, H) {
    try {
      const img = this.ctx.getImageData(0, 0, W, H);
      const d = img.data;
      const [r, g, b] = this.state.chroma.color;
      const sim = this.state.chroma.similarity, sm = this.state.chroma.smooth;
      const spill = this.state.chroma.spill;
      const low = Math.max(1e-6, sim - sm), high = sim + sm;
      const cell = 8;
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
      this.state.chroma.auto = false;
      this.refreshChromaUI();
      this.updateStatus("Key color sampled from the frame center — click again elsewhere if needed.");
      this.commitChanges();
    } catch (e) {
      this.updateStatus("Sampling failed — ensure the video is loaded.");
    }
  }

  setChromaPreset(rgb) {
    this.state.chroma.color = rgb.slice();
    this.state.chroma.auto = false;
    this.refreshChromaUI();
    this.updateStatus("Key color: " + this.colorToHex(rgb) + " screen (auto off).");
    this.commitChanges();
  }

  toggleChromaAuto() {
    this.state.chroma.auto = !this.state.chroma.auto;
    this.refreshChromaUI();
    if (this.state.chroma.auto) {
      this.updateStatus("Auto key color on — the node detects the dominant backing color at render time.");
      this.detectChromaColor(true);
    } else {
      this.updateStatus("Auto key color off — using the picked color.");
      this.commitChanges();
    }
  }

  refreshChromaUI() {
    if (this.autoBtn) this.autoBtn.classList.toggle("active", !!this.state.chroma.auto);
    if (this.chromaPanel) {
      const picker = this.chromaPanel.querySelector('input[type="color"]');
      if (picker) picker.value = this.colorToHex(this.state.chroma.color);
    }
  }

  async detectChromaColor(atZero) {
    if (!this.videoEl || !this.videoEl.src || this.videoEl.readyState < 1) {
      this.updateStatus("Load a video first, then Detect.");
      return;
    }
    try {
      const vw = this.videoEl.videoWidth || 1280, vh = this.videoEl.videoHeight || 720;
      const dw = 320, dh = Math.max(8, Math.round(dw * vh / vw));
      const off = document.createElement("canvas");
      off.width = dw; off.height = dh;
      const octx = off.getContext("2d", { willReadFrequently: true });
      if (atZero && this.playhead > 0) await this.seekVideo(0);
      octx.drawImage(this.videoEl, 0, 0, dw, dh);
      const res = veDetectKeyColor(octx.getImageData(0, 0, dw, dh));
      this.state.chroma.color = res.color;
      this.refreshChromaUI();
      const pct = Math.round(res.frac * 100);
      this.updateStatus(
        "Key color auto-detected: " + this.colorToHex(res.color) + " (" + pct + "% of the frame border)" +
        (pct < 20 ? " — low coverage, is the backdrop flat?" : ".") +
        (atZero ? " [frame 0]" : "")
      );
      this.commitChanges();
      if (atZero && this.playhead > 0) this.setPlayhead(this.playhead);
    } catch (e) {
      this.updateStatus("Detection failed — " + (e && e.message ? e.message : e));
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
  /* timeline keyboard shortcuts: ← → nudge the playhead by 1 frame (Shift = 10),
     S sets a mask key at the playhead (the cut), R toggles the render window,
     Del removes the mask key at the playhead, Esc clears the painted mask */
  onKeyDown(e) {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t.isContentEditable))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const mult = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const unit = 1 / (this.fpsWidgetValue() || 24);
      this.setPlayhead(this.playhead + (e.key === "ArrowRight" ? 1 : -1) * unit * mult);
      this.updateStatus("Playhead at " + veFmt(this.playhead) + " — arrows nudge 1 frame (Shift = 10).");
    } else if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      if (this._workMask) {
        this.setMaskKey();
        this.updateStatus("Mask key set at " + veFmt(this.playhead) + " — S cuts at the playhead (masks cross-fade).");
      } else {
        this.updateStatus("Paint a mask first (Brush/Rect), then press S to set the key at the playhead.");
      }
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      const at = Math.round(this.playhead * 1000) / 1000;
      if (this.state.render_in == null) {
        this.state.render_in = at;
        this.state.render_out = null;
        this.updateStatus("Render IN set at " + veFmt(at) + " — move the playhead to the OUT point and press R (R before the IN point clears).");
      } else if (this.state.render_out == null || this.state.render_out <= this.state.render_in) {
        if (at <= this.state.render_in) {
          this.state.render_in = null;
          this.state.render_out = null;
          this.updateStatus("Render range cleared.");
        } else {
          this.state.render_out = at;
          this.updateStatus("Render range " + veFmt(this.state.render_in) + " → " + veFmt(this.state.render_out) + " — only that window is rendered.");
        }
      } else {
        this.state.render_in = null;
        this.state.render_out = null;
        this.updateStatus("Render range cleared.");
      }
      this.commitChanges();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.delMaskKey();
    } else if (e.key === "Escape") {
      if (this._workMask) {
        this._workMask = null;
        this.drawPreview();
        this.updateStatus("Painted mask cleared.");
      }
    }
  }

  drawKeyStrip() {
    if (!this.keyCanvas || !this.keyCtx) return;
    const ctx = this.keyCtx;
    const w = this.keyCanvas.clientWidth || 800;
    const h = 26;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, w, h);
    const dur = Math.max(0.1, this.durationSec);
    /* render window (R key): shade everything outside [render_in, render_out) */
    if (this.state.render_in != null || this.state.render_out != null) {
      const xIn = this.state.render_in != null ? (this.state.render_in / dur) * w : 0;
      const xOut = this.state.render_out != null ? (this.state.render_out / dur) * w : w;
      ctx.fillStyle = "rgba(0,0,0,.45)";
      if (xIn > 0) ctx.fillRect(0, 0, xIn, h);
      if (xOut < w) ctx.fillRect(xOut, 0, w - xOut, h);
    }
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
    const order = ["inpaint", "chroma", "reframe"];
    const i = order.indexOf(this.state.mode);
    this.state.mode = order[(i + 1) % order.length];
    this.refreshModePanels();
    this.refreshToggleStates();
    this.drawPreview();
    this.commitChanges();
  }

  refreshModePanels() {
    if (!this.inpaintPanel || !this.chromaPanel || !this.reframePanel) return;
    this.inpaintPanel.style.display = this.state.mode === "inpaint" ? "flex" : "none";
    this.chromaPanel.style.display = this.state.mode === "chroma" ? "flex" : "none";
    this.reframePanel.style.display = this.state.mode === "reframe" ? "flex" : "none";
    const labels = { inpaint: "Inpaint", chroma: "Chroma", reframe: "Reframe" };
    this.modeBtn.textContent = "Mode: " + (labels[this.state.mode] || "Inpaint");
    this.previewHint.textContent = this.state.mode === "inpaint"
      ? "draw the region — red = edited area"
      : this.state.mode === "chroma"
        ? "green screen — transparent shows the checkerboard"
        : "reframe — dimmed outside the target window gets outpainted";
    if (this.canvas) {
      this.canvas.style.cursor = this.state.mode === "reframe" && this._rfTool === "move" ? "move" : "crosshair";
    }
  }

  setTool(t) { this._tool = t; this.refreshToggleStates(); }
  setEdit(e) { this.state.edit = e; this.refreshToggleStates(); this.commitChanges(); }

  setReframeTarget(w, h) {
    this.state.reframe.target_w = Math.max(16, Math.min(4096, parseInt(w, 10) || 1280));
    this.state.reframe.target_h = Math.max(16, Math.min(4096, parseInt(h, 10) || 720));
    this.refreshReframeUI();
    this.drawPreview();
    this.commitChanges();
  }

  setRfFit(mode) {
    this.state.reframe.fit = (mode === "smaller") ? "smaller" : "contain";
    this.refreshReframeUI();
    this.drawPreview();
    this.commitChanges();
  }

  /* --- subject tracking: keyframed window position (reframe.track) --- */

  alignAt(t) {
    /* effective align at time `t`: interpolated from the track keyframes, or
       the static align when there is no track */
    const rf = this.state.reframe;
    const tr = rf.track || [];
    if (!tr.length) return { ax: rf.align_x, ay: rf.align_y };
    if (t <= tr[0].t) return { ax: tr[0].ax, ay: tr[0].ay };
    const last = tr[tr.length - 1];
    if (t >= last.t) return { ax: last.ax, ay: last.ay };
    for (let i = 0; i < tr.length - 1; i++) {
      const a = tr[i], b = tr[i + 1];
      if (t >= a.t && t <= b.t) {
        if (b.t - a.t < 1e-9) return { ax: a.ax, ay: a.ay };
        const u = (t - a.t) / (b.t - a.t);
        return { ax: a.ax + (b.ax - a.ax) * u, ay: a.ay + (b.ay - a.ay) * u };
      }
    }
    return { ax: last.ax, ay: last.ay };
  }

  alignForSubject(scx, scy) {
    /* (ax, ay) that centers the window on the subject at source-normalized
       (scx, scy) — inverts the window transform (scale + rotation around the
       window center, screen space, matching drawReframeFraming) */
    const rf = this.state.reframe;
    const tw = Math.max(1, rf.target_w), th = Math.max(1, rf.target_h);
    const vw = (this.videoEl && this.videoEl.videoWidth) || tw;
    const vh = (this.videoEl && this.videoEl.videoHeight) || th;
    const scale = veClamp(Number(rf.scale) || 1, 0.1, 4);
    const rot = veClamp(Number(rf.rotation) || 0, -180, 180) * Math.PI / 180;
    const fitF = (rf.fit === "smaller") ? 0.8 : 1;
    const k = Math.min(tw / vw, th / vh) * fitF * scale;
    const sw = vw * k, sh = vh * k;
    const dx = (veClamp(Number(scx), 0, 1) - 0.5) * sw;
    const dy = (veClamp(Number(scy), 0, 1) - 0.5) * sh;
    const ox = dx * Math.cos(rot) - dy * Math.sin(rot);
    const oy = dx * Math.sin(rot) + dy * Math.cos(rot);
    const cx = tw / 2 - ox, cy = th / 2 - oy;
    const ax = sw <= tw ? veClamp((cx - sw / 2) / Math.max(1e-9, tw - sw), 0, 1) : 0.5;
    const ay = sh <= th ? veClamp((cy - sh / 2) / Math.max(1e-9, th - sh), 0, 1) : 0.5;
    return { ax, ay };
  }

  setAlignKey(t, ax, ay) {
    /* upsert a track keyframe at time `t` (seconds), keeping the list sorted */
    const rf = this.state.reframe;
    if (!Array.isArray(rf.track)) rf.track = [];
    const key = { t: Math.round(Number(t) * 1000) / 1000, ax: veClamp(Number(ax), 0, 1), ay: veClamp(Number(ay), 0, 1) };
    const idx = rf.track.findIndex(k => Math.abs(k.t - key.t) < 1e-6);
    if (idx >= 0) rf.track[idx] = key; else rf.track.push(key);
    rf.track.sort((a, b) => a.t - b.t);
  }

  clearTrack() {
    this.state.reframe.track = [];
    this.refreshReframeUI();
    this.drawPreview();
    this.commitChanges();
    this.updateStatus("Track cleared — the window uses static alignment again.");
  }

  async trackReframeSubject() {
    if (this._tracking) return;
    if (this.state.mode !== "reframe") {
      this.updateStatus("Switch to Reframe mode first, then press Track subject.");
      return;
    }
    if (!this.videoEl || !this.videoEl.src || !isFinite(this.videoEl.duration) || this.videoEl.duration <= 0) {
      this.updateStatus("Load a video first, then press Track subject.");
      return;
    }
    this.ensureGrid();
    const gw = this._gridW, gh = this._gridH;
    const start = this.playhead;
    /* seed = the painted preserve region at the playhead (source coords) */
    const base = new Uint8ClampedArray(gw * gh);
    const existing = this.keyAt(start);
    if (existing) {
      this.decodeMaskInto(base, existing.png, existing.grid_w, existing.grid_h);
    } else {
      let has = false;
      for (let i = 0; i < base.length; i++) if (this._workMask[i]) { has = true; break; }
      if (!has) {
        this.updateStatus("Paint the subject with the Brush (preserve) tool at the playhead frame, then press Track subject — the window will follow it.");
        return;
      }
      base.set(this._workMask);
    }
    const bbox = veMaskBBox(base, gw, gh);
    if (!bbox) {
      this.updateStatus("Paint the subject first (Brush preserve tool), then press Track subject.");
      return;
    }
    const opts = {
      every: Math.max(1, Math.round(this._trackOpts.every)),
      search: veClamp(Number(this._trackOpts.search), 3, 40),
      floor: veClamp(Number(this._trackOpts.floor), 0.3, 0.95),
      refresh: Math.max(2, Math.round(this._trackOpts.refresh)),
    };
    const step = opts.every / this.fps;
    this._tracking = true;
    this._trackUI = { btn: this.trackSubjectBtn, prog: null, label: "Tracking" };
    let fwd = [], bwd = [], trackErr = null;
    try {
      fwd = await this.trackDirection(base, start, step, opts, 1);
      bwd = await this.trackDirection(base, start, -step, opts, -1);
    } catch (err) {
      trackErr = err;
    } finally {
      this._tracking = false;
      this._trackUI = null;
    }
    if (trackErr) {
      this.setPlayhead(start);
      this.updateStatus("Tracking failed — " + (trackErr && trackErr.message ? trackErr.message : trackErr));
      return;
    }
    if (!fwd.length && !bwd.length) {
      this.setPlayhead(start);
      this.updateStatus("Tracking lost immediately (score below the floor) — lower the Score threshold or increase Search, then try again.");
      return;
    }
    const bcx = (bbox.x + bbox.w / 2) / gw, bcy = (bbox.y + bbox.h / 2) / gh;
    const keys = [{ t: Math.round(start * 1000) / 1000, ...this.alignForSubject(bcx, bcy) }];
    const addPath = (path) => {
      for (const e of path) {
        const scx = veClamp(bcx + e.dx / gw, 0, 1);
        const scy = veClamp(bcy + e.dy / gh, 0, 1);
        keys.push({ t: Math.round(e.t * 1000) / 1000, ...this.alignForSubject(scx, scy) });
      }
    };
    addPath(fwd);
    addPath(bwd);
    const byT = new Map();
    for (const kk of keys) byT.set(kk.t, kk);
    this.state.reframe.track = Array.from(byT.values()).sort((a, b) => a.t - b.t);
    this.commitChanges();
    this.drawPreview();
    const fwdT = fwd.length ? fwd[fwd.length - 1].t : start;
    const bwdT = bwd.length ? bwd[bwd.length - 1].t : start;
    this.setPlayhead(start);
    this.updateStatus(
      `Subject tracked → ${veFmt(fwdT)} and ← ${veFmt(bwdT)} — ${this.state.reframe.track.length} position keyframe(s). ` +
      "Scrub to review; drag the window to add/override a key at the playhead."
    );
  }

  setReframeAlign(axis, v) {
    this.state.reframe[axis] = veClamp(Number(v), 0, 1);
    /* with a track active, an align edit is a keyframe at the playhead */
    if (this.state.reframe.track && this.state.reframe.track.length) {
      this.setAlignKey(this.playhead, this.state.reframe.align_x, this.state.reframe.align_y);
    }
    this.refreshReframeUI();
    this.drawPreview();
    this.commitChanges();
  }

  refreshReframeUI() {
    const rf = this.state.reframe;
    if (this._rfWIn) this._rfWIn.value = String(rf.target_w);
    if (this._rfHIn) this._rfHIn.value = String(rf.target_h);
    if (this.alignBtns) {
      Object.keys(this.alignBtns.align_x).forEach(k => this.alignBtns.align_x[k].classList.toggle("active", Number(k) === rf.align_x));
      Object.keys(this.alignBtns.align_y).forEach(k => this.alignBtns.align_y[k].classList.toggle("active", Number(k) === rf.align_y));
    }
    if (this.rfFitBtns) {
      const fit = rf.fit === "smaller" ? "smaller" : "contain";
      this.rfFitBtns.contain.classList.toggle("active", fit === "contain");
      this.rfFitBtns.smaller.classList.toggle("active", fit === "smaller");
    }
    if (this._rfTrackLbl) {
      const n = (rf.track || []).length;
      this._rfTrackLbl.textContent = n ? n + " keyframe" + (n === 1 ? "" : "s") : "static";
    }
    const scale = veClamp(Number(rf.scale) || 1, 0.1, 4);
    const rotation = veClamp(Number(rf.rotation) || 0, -180, 180);
    if (this._rfScaleIn) this._rfScaleIn.value = String(scale);
    if (this._rfScaleLbl) this._rfScaleLbl.textContent = "×" + scale.toFixed(2);
    if (this._rfRotIn) this._rfRotIn.value = String(rotation);
    if (this._rfRotLbl) this._rfRotLbl.textContent = rotation + "°";
  }

  setRfTool(t) {
    this._rfTool = t;
    if (this.rfToolBtns) {
      Object.keys(this.rfToolBtns).forEach(k => this.rfToolBtns[k].classList.toggle("active", k === t));
    }
    if (this.canvas) this.canvas.style.cursor = t === "move" ? "move" : "crosshair";
  }

  startWindowDrag(e) {
    const [W, H] = this.canvasSize();
    /* anchor at the DISPLAYED window (interpolated track position when a track
       is active) — flipping the drag flag first would snap the grab to the
       static align and make the window jump on mouse-down */
    const w = this.reframeWindow(W, H);
    this._rfDragActive = true;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const handle = this.reframeHandleAt(mx, my, W, H);
    if (handle === "rotate") {
      const ang = Math.atan2(my - w.cy, mx - w.cx) * 180 / Math.PI;
      this._dragWin = { mode: "rotate", cx: w.cx, cy: w.cy, ang0: ang, rot0: veClamp(Number(this.state.reframe.rotation) || 0, -180, 180) };
    } else if (handle === "scale") {
      const d0 = Math.max(1, Math.hypot(mx - w.cx, my - w.cy));
      this._dragWin = { mode: "scale", cx: w.cx, cy: w.cy, d0, scale0: veClamp(Number(this.state.reframe.scale) || 1, 0.1, 4) };
    } else {
      this._dragWin = { mode: "move", grabDX: mx - w.sx, grabDY: my - w.sy, wx: w.wx, wy: w.wy, ww: w.ww, wh: w.wh, sw: w.sw, sh: w.sh };
    }
    if (this.canvas) this.canvas.style.cursor = handle === "rotate" ? "grab" : handle === "scale" ? "nwse-resize" : "move";
  }

  moveWindowDrag(e) {
    if (!this._dragWin) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const d = this._dragWin;
    const rf = this.state.reframe;
    if (d.mode === "rotate") {
      const ang = Math.atan2(my - d.cy, mx - d.cx) * 180 / Math.PI;
      let r = d.rot0 + (ang - d.ang0);
      if (e.shiftKey) r = Math.round(r / 15) * 15;  // shift snaps to 15°
      rf.rotation = veClamp(r, -180, 180);
    } else if (d.mode === "scale") {
      const dist = Math.hypot(mx - d.cx, my - d.cy);
      rf.scale = veClamp(d.scale0 * (dist / d.d0), 0.1, 4);
    } else {
      /* only write an axis that actually has travel — a contain-fit source fills
         one axis, and writing there would scribble meaningless fractions */
      const availW = d.ww - d.sw;
      const availH = d.wh - d.sh;
      if (availW > 1) rf.align_x = veClamp((mx - d.grabDX - d.wx) / availW, 0, 1);
      if (availH > 1) rf.align_y = veClamp((my - d.grabDY - d.wy) / availH, 0, 1);
    }
    this.drawPreview();
  }

  endWindowDrag() {
    this._rfDragActive = false;
    /* with a track active, the drag result becomes a key at the playhead */
    const rf = this.state.reframe;
    if (rf.track && rf.track.length) this.setAlignKey(this.playhead, rf.align_x, rf.align_y);
    this.refreshReframeUI();
    this.commitChanges();
  }

  /* reframe target window in preview coords (mirrors reframe_plate: contain
     + align + scale; rotation rotates the source around its center) */
  reframeWindow(W, H) {
    const rf = this.state.reframe;
    const tw = Math.max(1, rf.target_w), th = Math.max(1, rf.target_h);
    const s = Math.min(W / tw, H / th);
    const ww = tw * s, wh = th * s;
    const wx = (W - ww) / 2, wy = (H - wh) / 2;
    const vw = (this.videoEl && this.videoEl.videoWidth) || W;
    const vh = (this.videoEl && this.videoEl.videoHeight) || H;
    const scale = veClamp(Number(rf.scale) || 1, 0.1, 4);
    const rot = veClamp(Number(rf.rotation) || 0, -180, 180) * Math.PI / 180;
    /* fit smaller (base x 0.8) keeps margin on both axes at scale 1 so the
       move tool can place the window anywhere in 2D; must match Python's
       SMALLER_FACTOR exactly for the WYSIWYG cross-check */
    const fitF = (rf.fit === "smaller") ? 0.8 : 1;
    const k = Math.min(ww / vw, wh / vh) * fitF * scale;
    const sw = vw * k, sh = vh * k;
    /* NB: never use `|| 0.5` here — align 0 (flush left/top) is falsy and
       would silently re-center, diverging from the Python plate geometry.
       With track keyframes the window follows the interpolated align unless
       the user is mid-drag (then the live align wins and is committed as a
       key on release). */
    const tr = rf.track || [];
    const al = (tr.length && !this._rfDragActive)
      ? this.alignAt(this.playhead)
      : { ax: rf.align_x == null ? 0.5 : rf.align_x, ay: rf.align_y == null ? 0.5 : rf.align_y };
    let sx = wx + (ww - sw) * al.ax;
    let sy = wy + (wh - sh) * al.ay;
    /* fitting window keeps its fully-inside clamp; an oversized one pins its
       center inside the target so the view stays anchored while it overflows */
    if (sw <= ww) sx = veClamp(sx, wx, wx + ww - sw);
    else { const cxx = veClamp(sx + sw / 2, wx, wx + ww); sx = cxx - sw / 2; }
    if (sh <= wh) sy = veClamp(sy, wy, wy + wh - sh);
    else { const cyy = veClamp(sy + sh / 2, wy, wy + wh); sy = cyy - sh / 2; }
    return { wx, wy, ww, wh, sx, sy, sw, sh, cx: sx + sw / 2, cy: sy + sh / 2, k, rot, scale };
  }

  /* canvas-normalized point -> source-normalized point through the (scaled +
     rotated) window transform; null when the point is outside the source */
  reframeCanvasToSource(nx, ny) {
    const [W, H] = this.canvasSize();
    const w = this.reframeWindow(W, H);
    const vw = (this.videoEl && this.videoEl.videoWidth) || W;
    const vh = (this.videoEl && this.videoEl.videoHeight) || H;
    const x = nx * W - w.cx, y = ny * H - w.cy;
    const cos = Math.cos(w.rot), sin = Math.sin(w.rot);
    const rx = (x * cos + y * sin) / w.k;   // inverse rotate + unscale
    const ry = (-x * sin + y * cos) / w.k;
    const sx = rx + vw / 2, sy = ry + vh / 2;
    if (sx < 0 || sy < 0 || sx > vw || sy > vh) return null;
    return { x: veClamp(sx / vw, 0, 1), y: veClamp(sy / vh, 0, 1) };
  }

  /* like reframeCanvasToSource but clamps into [0,1] instead of returning null
     — for copy-to-reference, where a selection straddling the window edge
     should snap to the source bounds rather than abort */
  reframeCanvasToSourceClamped(nx, ny) {
    const [W, H] = this.canvasSize();
    const w = this.reframeWindow(W, H);
    const vw = (this.videoEl && this.videoEl.videoWidth) || W;
    const vh = (this.videoEl && this.videoEl.videoHeight) || H;
    const x = nx * W - w.cx, y = ny * H - w.cy;
    const cos = Math.cos(w.rot), sin = Math.sin(w.rot);
    const rx = (x * cos + y * sin) / w.k;
    const ry = (-x * sin + y * cos) / w.k;
    return { x: veClamp((rx + vw / 2) / vw, 0, 1), y: veClamp((ry + vh / 2) / vh, 0, 1) };
  }

  /* move-tool handle positions: the rotate knob floats 16px above the window's
     top edge (rotated with it), the scale knob sits on the bottom-right corner */
  reframeHandles(W, H) {
    const w = this.reframeWindow(W, H);
    const cos = Math.cos(w.rot), sin = Math.sin(w.rot);
    const rx = w.sw / 2, ry = w.sh / 2;
    /* top-center of the rotated window extended outward by the knob radius */
    const rotX = w.cx + (ry + 14) * sin;
    const rotY = w.cy - (ry + 14) * cos;
    /* bottom-right corner of the rotated window */
    const sclX = w.cx + rx * cos - ry * sin;
    const sclY = w.cy + rx * sin + ry * cos;
    return { rot: { x: rotX, y: rotY }, scale: { x: sclX, y: sclY } };
  }

  /* hit-test the move-tool handles */
  reframeHandleAt(mx, my, W, H) {
    const w = this.reframeWindow(W, H);
    const h = this.reframeHandles(W, H);
    if (Math.hypot(mx - h.rot.x, my - h.rot.y) <= 12) return "rotate";
    if (Math.hypot(mx - h.scale.x, my - h.scale.y) <= 12) return "scale";
    if (mx >= w.sx - 4 && mx <= w.sx + w.sw + 4 && my >= w.sy - 4 && my <= w.sy + w.sh + 4) return "move";
    return null;
  }

  drawReframeFraming(W, H) {
    const w = this.reframeWindow(W, H);
    const ctx = this.ctx;
    ctx.save();
    /* dim the outpaint region (outside the target window) — light, hatched,
       so the video stays visible and it reads as "to be generated" */
    ctx.fillStyle = "rgba(8,10,12,0.42)";
    ctx.fillRect(0, 0, W, w.wy);
    ctx.fillRect(0, w.wy + w.wh, W, H - w.wy - w.wh);
    ctx.fillRect(0, w.wy, w.wx, w.wh);
    ctx.fillRect(w.wx + w.ww, w.wy, W - w.wx - w.ww, w.wh);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    const hatch = (hx0, hy0, hw, hh) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(hx0, hy0, hw, hh);
      ctx.clip();
      for (let hx = -hh; hx < hw + hh; hx += 12) {
        ctx.beginPath();
        ctx.moveTo(hx0 + hx, hy0);
        ctx.lineTo(hx0 + hx + hh, hy0 + hh);
        ctx.stroke();
      }
      ctx.restore();
    };
    hatch(0, 0, W, w.wy);
    hatch(0, w.wy + w.wh, W, H - w.wy - w.wh);
    hatch(0, w.wy, w.wx, w.wh);
    hatch(w.wx + w.ww, w.wy, W - w.wx - w.ww, w.wh);
    /* source video placed inside the window, rotated around its center */
    if (this.videoEl && this.videoEl.src && this.videoEl.readyState >= 1) {
      ctx.save();
      ctx.translate(w.cx, w.cy);
      ctx.rotate(w.rot);
      ctx.drawImage(this.videoEl, -w.sw / 2, -w.sh / 2, w.sw, w.sh);
      ctx.restore();
    }
    /* source window border (solid, rotated with the video) */
    ctx.save();
    ctx.translate(w.cx, w.cy);
    ctx.rotate(w.rot);
    ctx.strokeStyle = "#7ee2a8";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-w.sw / 2, -w.sh / 2, w.sw, w.sh);
    ctx.restore();
    /* target window border (dashed) */
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#9fb6c9";
    ctx.lineWidth = 1.25;
    ctx.strokeRect(w.wx, w.wy, w.ww, w.wh);
    ctx.setLineDash([]);
    /* move tool: rotate + scale handles on the source window */
    if (this._rfTool === "move") {
      const h = this.reframeHandles(W, H);
      /* rotate knob: line up the window's top edge + circle */
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(w.cx + w.sh / 2 * Math.sin(w.rot), w.cy - w.sh / 2 * Math.cos(w.rot));
      ctx.lineTo(h.rot.x, h.rot.y);
      ctx.stroke();
      ctx.fillStyle = "#ffb454";
      ctx.beginPath();
      ctx.arc(h.rot.x, h.rot.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#14171a";
      ctx.lineWidth = 1;
      ctx.stroke();
      /* scale knob: square on the bottom-right corner */
      ctx.fillStyle = "#59c2ff";
      ctx.fillRect(h.scale.x - 5, h.scale.y - 5, 10, 10);
      ctx.strokeStyle = "#14171a";
      ctx.strokeRect(h.scale.x - 5, h.scale.y - 5, 10, 10);
    }
    /* label */
    ctx.fillStyle = "#7ee2a8";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(
      "reframe " + this.state.reframe.target_w + "×" + this.state.reframe.target_h +
      " · ×" + w.scale.toFixed(2) + " · " + Math.round(veClamp(Number(this.state.reframe.rotation) || 0, -180, 180)) + "° — outside = outpaint",
      w.wx + 4, w.wy + 4);
    ctx.restore();
  }

  drawSelectionOverlay(W, H) {
    if (!this._selRect) return;
    let ox, oy, pw, ph;
    if (this.state.mode === "reframe") {
      const w = this.reframeWindow(W, H);
      ox = w.sx; oy = w.sy; pw = w.sw; ph = w.sh;
    } else {
      const vw = (this.videoEl && this.videoEl.videoWidth) || W;
      const vh = (this.videoEl && this.videoEl.videoHeight) || H;
      const s = Math.min(W / vw, H / vh);
      ox = (W - vw * s) / 2; oy = (H - vh * s) / 2;
      pw = vw * s; ph = vh * s;
    }
    const x0 = ox + this._selRect.x0 * pw;
    const y0 = oy + this._selRect.y0 * ph;
    const w = (this._selRect.x1 - this._selRect.x0) * pw;
    const h = (this._selRect.y1 - this._selRect.y0) * ph;
    if (w < 1 || h < 1) return;
    this.ctx.save();
    this.ctx.setLineDash([4, 3]);
    this.ctx.strokeStyle = "#ffd479";
    this.ctx.lineWidth = 1.2;
    this.ctx.strokeRect(x0, y0, w, h);
    this.ctx.setLineDash([]);
    this.ctx.fillStyle = "rgba(255,212,121,0.9)";
    this.ctx.font = "9px ui-monospace, monospace";
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "top";
    this.ctx.fillText("ref region", x0 + 3, y0 + 3);
    this.ctx.restore();
  }

  fpsWidgetValue() {
    try {
      const w = this.node && this.node.widgets && this.node.widgets.find(x => x.name === "fps");
      return w ? Number(w.value) || 24 : 24;
    } catch (e) { return 24; }
  }

  measureFps() {
    const v = this.videoEl;
    if (!v || typeof v.requestVideoFrameCallback !== "function") return;
    const times = [];
    const collect = (now, meta) => {
      times.push(meta.mediaTime);
      if (times.length >= 12) {
        const span = times[11] - times[0];
        const fps = span > 0.02 ? 11 / span : null;
        if (fps && fps > 0.5 && fps < 240) this.setVideoFps(Math.round(fps * 100) / 100);
        return;
      }
      v.requestVideoFrameCallback(collect);
    };
    v.requestVideoFrameCallback(collect);
    if (v.paused) { try { v.play().then(() => v.pause()).catch(() => {}); } catch (e) {} }
  }

  setVideoFps(fps) {
    this.state.video_fps = fps;
    this.checkFpsConsistency();
    this.commitChanges();
  }

  checkFpsConsistency() {
    const nodeFps = this.fpsWidgetValue();
    const fileFps = this.state.video_fps;
    if (this.fpsInfo) {
      this.fpsInfo.textContent = fileFps
        ? "fps: node " + nodeFps + " | file ~" + fileFps + (Math.abs(nodeFps - fileFps) > 0.5 ? " ⚠ mismatch" : "")
        : "fps: node " + nodeFps;
    }
    if (fileFps && Math.abs(nodeFps - fileFps) > 0.5) {
      const cur = this.statusLine ? this.statusLine.textContent : "";
      const msg = "⚠ framerate mismatch: file ~" + fileFps + " fps vs node " + nodeFps + " fps — press “Use file fps”.";
      this.updateStatus(cur.indexOf("framerate mismatch") !== -1 ? cur : (cur ? cur + "  " : "") + msg);
    }
  }

  useFileFps() {
    const fps = this.state.video_fps;
    if (!fps) { this.updateStatus("No file framerate measured yet."); return; }
    try {
      const w = this.node && this.node.widgets && this.node.widgets.find(x => x.name === "fps");
      if (w) {
        w.value = Math.round(fps);
        if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
      }
    } catch (e) {}
    this.checkFpsConsistency();
    this.updateStatus("fps widget set to " + Math.round(fps) + " to match the file.");
  }

  async copyToReference() {
    if (!this._selRect) {
      this.updateStatus("Draw a rectangle first (Rect tool), then Copy to ref.");
      return;
    }
    if (!this.videoEl || !this.videoEl.src || this.videoEl.readyState < 1) {
      this.updateStatus("Load a video first.");
      return;
    }
    try {
      const vw = this.videoEl.videoWidth, vh = this.videoEl.videoHeight;
      let rx0 = this._selRect.x0, ry0 = this._selRect.y0, rx1 = this._selRect.x1, ry1 = this._selRect.y1;
      if (this.state.mode === "reframe") {
        /* the selection is drawn in canvas space — map it back to source
           space through the (scaled + rotated) window so the crop is exact;
           corners outside the window snap to the source bounds */
        const a = this.reframeCanvasToSourceClamped(rx0, ry0);
        const b = this.reframeCanvasToSourceClamped(rx1, ry1);
        rx0 = Math.min(a.x, b.x); ry0 = Math.min(a.y, b.y);
        rx1 = Math.max(a.x, b.x); ry1 = Math.max(a.y, b.y);
      }
      const x0 = Math.max(0, Math.round(rx0 * vw));
      const y0 = Math.max(0, Math.round(ry0 * vh));
      const x1 = Math.min(vw, Math.round(rx1 * vw));
      const y1 = Math.min(vh, Math.round(ry1 * vh));
      if (x1 - x0 < 4 || y1 - y0 < 4) {
        this.updateStatus("Selection too small for a reference.");
        return;
      }
      const needSeek = Math.abs(this.videoEl.currentTime - this.playhead) > 0.05;
      if (needSeek) this.videoEl.currentTime = this.playhead;
      await new Promise(res => {
        const v = this.videoEl;
        if (!v || !needSeek) { res(); return; }  // frame already at the playhead
        v.addEventListener("seeked", res, { once: true });
        setTimeout(res, 500);
      });
      const c = document.createElement("canvas");
      c.width = x1 - x0; c.height = y1 - y0;
      const ctx = c.getContext("2d");
      ctx.drawImage(this.videoEl, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
      const b64 = c.toDataURL("image/png").split(",")[1] || "";
      if (!b64) { this.updateStatus("Could not capture the frame (canvas tainted?)."); return; }
      /* persist the crop as a real file in ComfyUI's input folder so the other
         editors can import it (Director library card / Mockup layer) via the
         crops bundle — non-fatal, the b64 still feeds `ref_images`. */
      let file = "", thumb = "";
      try {
        if (typeof fetch === "function") {
          const blob = await (await fetch("data:image/png;base64," + b64)).blob();
          const body = new FormData();
          body.append("image", blob, "ve_crop_" + Date.now() + ".png");
          const up = await api.fetchApi("/upload/image", { method: "POST", body });
          if (up.status === 200) {
            const data = await up.json();
            const sub = data.subfolder || "";
            file = sub ? sub + "/" + data.name : data.name;
            thumb = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=input&subfolder=${encodeURIComponent(sub)}`);
          }
        }
      } catch (err) { /* non-fatal: the crop still works for ref_images */ }
      this.state.refs.push({ src: b64, file, thumb, at: Math.round(this.playhead * 100) / 100, note: "" });
      this.renderRefsRow();
      this.commitChanges();
      this.updateStatus("Reference crop added (" + c.width + "×" + c.height + " @ " + this.playhead.toFixed(2) + "s) — wire `ref_images` into your H3 reference input, or ⤴ Export crops to send it to the Director library / Mockup stage.");
    } catch (e) {
      this.updateStatus("Copy to ref failed — " + (e && e.message ? e.message : e));
    }
  }

  removeRef(i) {
    this.state.refs.splice(i, 1);
    this.renderRefsRow();
    this.commitChanges();
  }

  renderRefsRow() {
    if (!this.refsRow) return;
    this.refsRow.innerHTML = "";
    if (!this.state.refs.length) { this.refsRow.style.display = "none"; return; }
    this.refsRow.style.display = "flex";
    this.state.refs.forEach((r, i) => {
      const cell = document.createElement("div");
      cell.className = "ve-refcell";
      const img = document.createElement("img");
      img.src = "data:image/png;base64," + r.src;
      img.title = "reference @ " + r.at + "s";
      const del = this.btn("✕", () => this.removeRef(i));
      del.className = "ve-btn ve-refdel";
      del.title = "remove reference";
      cell.appendChild(img);
      cell.appendChild(del);
      this.refsRow.appendChild(cell);
    });
    const exp = this.btn("⤴ Export crops", () => this.exportCrops());
    exp.className = "ve-btn";
    exp.title = "Export these crops to input/chaotic_h3_crops.json so Chaotic H3 Director (Library → 📥 Crops) and the Mockup Editor (📥 Crops) can import them.";
    this.refsRow.appendChild(exp);
  }

  async exportCrops() {
    const withFiles = this.state.refs.filter(r => r && r.file);
    if (!withFiles.length) {
      this.updateStatus("Nothing to export — crops copied before the upload change have no file; re-copy a crop now so it can be shared.");
      return;
    }
    const skipped = this.state.refs.length - withFiles.length;
    try {
      const resp = await api.fetchApi("/chaotic_h3/crops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crops: withFiles.map(r => ({ file: r.file, at: r.at, note: r.note || "" })),
        }),
      });
      if (resp.status === 200) {
        const msg = skipped > 0
          ? "Exported " + withFiles.length + " of " + this.state.refs.length + " crop(s) — " + skipped + " have no uploaded file; re-copy them so they can be shared."
          : "Exported " + withFiles.length + " crop(s) to input/chaotic_h3_crops.json — import them in the Director (Library → 📥 Crops) or the Mockup Editor (📥 Crops).";
        this.updateStatus(msg);
      } else {
        this.updateStatus("Export failed (" + resp.status + ").");
      }
    } catch (e) {
      this.updateStatus("Export failed — " + (e && e.message ? e.message : e));
    }
  }

  /* Auto-preserve: detect objects crossing the reframe edge (motion in the
     letterbox band) and write preserve strokes that follow them via the same
     NCC tracker the mask tracking uses. */
  async autoPreserve() {
    if (this._autoPreserving) return;
    if (this.state.mode !== "reframe") {
      this.updateStatus("Switch to Reframe mode first, then press Auto preserve.");
      return;
    }
    if (!this.videoEl || !this.videoEl.src || !isFinite(this.videoEl.duration) || this.videoEl.duration <= 0) {
      this.updateStatus("Load a video first, then press Auto preserve.");
      return;
    }
    const rf = this.state.reframe;
    const vw = this.videoEl.videoWidth || 1280, vh = this.videoEl.videoHeight || 720;
    const s = Math.min(rf.target_w / vw, rf.target_h / vh);
    const spareX = rf.target_w - vw * s, spareY = rf.target_h - vh * s;
    if (spareX < 1 && spareY < 1) {
      this.updateStatus("Target aspect matches the source — there is no outside to outpaint.");
      return;
    }
    this.ensureGrid();
    const opts = {
      stride: Math.max(0.2, Number(this._autoOpts.stride) || 0.5),
      margin: veClamp(Number(this._autoOpts.margin) || 0.15, 0.05, 0.4),
      minArea: Math.max(4, Math.round(Number(this._autoOpts.minArea) || 12)),
      maxObjects: Math.max(1, Math.min(6, Math.round(Number(this._autoOpts.maxObjects) || 3))),
      floor: veClamp(Number(this._autoOpts.floor) || 0.55, 0.3, 0.9),
      diffThr: 0.08,
    };
    const edge = spareX >= spareY ? "x" : "y";
    const dur = this.durationSec;
    const trackW = 160, trackH = Math.max(8, Math.round(trackW * vh / vw));
    const off = document.createElement("canvas");
    off.width = trackW; off.height = trackH;
    const octx = off.getContext("2d", { willReadFrequently: true });
    const frameGray = () => {
      octx.drawImage(this.videoEl, 0, 0, trackW, trackH);
      try {
        return veGray(octx.getImageData(0, 0, trackW, trackH));
      } catch (e) {
        throw new Error("cannot read video pixels (canvas tainted?) — " + (e && e.message ? e.message : e));
      }
    };
    this._autoPreserving = true;
    try {
      const times = [];
      for (let t = 0; t <= dur - 1e-6; t += opts.stride) times.push(t);
      if (times.length < 2) {
        this.updateStatus("Clip too short for Auto preserve.");
        return;
      }
      /* pass 1: motion scan -> edge-crossing candidates */
      const samples = [];
      let prev = null;
      for (let i = 0; i < times.length; i++) {
        this.updateStatus("Auto preserve: scanning " + Math.round((i / times.length) * 100) + "%");
        await this.seekVideo(times[i]);
        const g = frameGray();
        if (prev) {
          const diff = veDiffMask(prev, g, trackW, trackH, opts.diffThr);
          for (const blob of veEdgeBlobs(diff, trackW, trackH, edge, opts.margin, opts.minArea)) {
            samples.push({ t: times[i], blob });
          }
        }
        prev = g;
      }
      if (!samples.length) {
        this.updateStatus("Auto preserve: no objects crossing the edge found (try a larger Margin or smaller Min area).");
        return;
      }
      /* pass 2: lock a template onto each object and NCC-track it both ways */
      const objects = veClusterCandidates(samples, opts.maxObjects);
      const tracked = [];
      for (let k = 0; k < objects.length; k++) {
        const obj = objects[k];
        const cx = (obj.blob.x0 + obj.blob.x1) / 2;
        const cy = (obj.blob.y0 + obj.blob.y1) / 2;
        const bw = Math.max(6, obj.blob.x1 - obj.blob.x0 + 1);
        const bh = Math.max(6, obj.blob.y1 - obj.blob.y0 + 1);
        const pw = veClamp(Math.round(bw * 1.4), 8, 48);
        const ph = veClamp(Math.round(bh * 1.4), 8, 48);
        await this.seekVideo(obj.t);
        const tpl = vePatch(frameGray(), trackW, trackH, cx, cy, pw, ph);
        const radius = Math.max(6, Math.round(0.25 * trackW));
        const pts = [{ t: obj.t, cx, cy, score: 1 }];
        for (const dir of [1, -1]) {
          let px = cx, py = cy, sinceRefresh = 0;
          for (let t = obj.t + dir * opts.stride; dir > 0 ? t <= dur + 1e-6 : t >= -1e-6; t += dir * opts.stride) {
            const tt = veClamp(t, 0, dur);
            this.updateStatus("Auto preserve: tracking object " + (k + 1) + "/" + objects.length);
            await this.seekVideo(tt);
            const g = frameGray();
            const hit = veSearch(g, trackW, trackH, tpl, px, py, radius, 2);
            if (hit.score < opts.floor) break;
            px += hit.dx;
            py += hit.dy;
            /* periodic template refresh fights drift (mirrors Track Mask) */
            sinceRefresh++;
            if (sinceRefresh >= 8) {
              tpl = vePatch(g, trackW, trackH, px, py, tpl.w, tpl.h);
              sinceRefresh = 0;
            }
            pts.push({ t: tt, cx: px, cy: py, score: hit.score });
          }
        }
        tracked.push({ pts, rw: bw, rh: bh });
      }
      const added = this.writeAutoPreserveKeys(tracked, trackW, trackH);
      if (added === 0) {
        this.updateStatus("Auto preserve: nothing tracked well enough to write (raise/lower the score floor?).");
        return;
      }
      this.updateStatus("Auto preserve: " + added + " preserve keyframe(s) added for " + tracked.length + " edge-crossing object(s) — refine with the brush if needed.");
      this.setPlayhead(this.playhead);
    } finally {
      this._autoPreserving = false;
    }
  }

  writeAutoPreserveKeys(tracked, trackW, trackH) {
    const gw = this._gridW, gh = this._gridH;
    if (!gw || !gh || !tracked.length) return 0;
    const byTime = new Map();
    for (const obj of tracked) {
      for (const p of obj.pts) {
        const t = Math.round(p.t * 100) / 100;
        if (!byTime.has(t)) byTime.set(t, new Uint8ClampedArray(gw * gh));
        const grid = byTime.get(t);
        const cx = p.cx * (gw / trackW), cy = p.cy * (gh / trackH);
        const rw = Math.max(2, Math.round(obj.rw * 0.6 * (gw / trackW)));
        const rh = Math.max(2, Math.round(obj.rh * 0.6 * (gh / trackH)));
        const cxi = Math.round(cx), cyi = Math.round(cy);
        for (let y = Math.max(0, cyi - rh); y <= Math.min(gh - 1, cyi + rh); y++) {
          for (let x = Math.max(0, cxi - rw); x <= Math.min(gw - 1, cxi + rw); x++) {
            const d = Math.hypot((x - cx) / rw, (y - cy) / rh);
            if (d <= 1) {
              const v = Math.round(255 * (1 - Math.max(0, d - 0.7) / 0.3));
              grid[y * gw + x] = Math.max(grid[y * gw + x], v);
            }
          }
        }
      }
    }
    let ts = Array.from(byTime.keys()).sort((a, b) => a - b);
    /* decimate so dense tracks don't bloat the workflow JSON, but always keep
       the last sample so the stroke reaches the exact crossing moment */
    const maxKeys = 24;
    const step = Math.max(1, Math.ceil(ts.length / maxKeys));
    ts = ts.filter((_, i) => i % step === 0);
    const realLast = Array.from(byTime.keys()).reduce((m, t) => Math.max(m, t), -1);
    if (ts.length && Math.abs(ts[ts.length - 1] - realLast) > 1e-6) ts.push(realLast);
    if (!ts.length) return 0;
    /* union with existing keys at colliding times — auto strokes ADD to the
       user's brush work instead of replacing it */
    const collision = new Set();
    const keys = [];
    for (const k of this.state.mask.keys) {
      const hit = ts.find(t => Math.abs(t - k.t) < 1e-6);
      if (hit == null) {
        keys.push(k);
      } else {
        collision.add(hit);
        const grid = new Uint8ClampedArray(gw * gh);
        this.decodeMaskInto(grid, k.png, gw, gh);
        const autoGrid = byTime.get(hit);
        for (let i = 0; i < grid.length; i++) grid[i] = Math.max(grid[i], autoGrid[i]);
        keys.push({ t: hit, grid_w: gw, grid_h: gh, png: this.maskToPng(grid, gw, gh) });
      }
    }
    for (const t of ts) {
      if (collision.has(t)) continue;
      keys.push({ t, grid_w: gw, grid_h: gh, png: this.maskToPng(byTime.get(t), gw, gh) });
    }
    keys.sort((a, b) => a.t - b.t);
    this.state.mask.keys = keys;
    this.state.mask.type = "brush";
    this.commitChanges();
    return ts.length;
  }
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
