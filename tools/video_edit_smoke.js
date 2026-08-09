#!/usr/bin/env node
/* video_edit_smoke.js — regression harness for the ChaoticH3VideoEdit widget.
 *
 * Loads web/js/chaotic_video_edit.js under a mocked ComfyUI frontend and drives
 * the real registration path (registerExtension -> beforeRegisterNodeDef ->
 * onNodeCreated -> new ChaoticVideoEdit), then exercises mode toggles, mask
 * keyframe authoring (brush + rect), serialization round-trips, and chroma
 * settings.
 *
 * Run: node tools/video_edit_smoke.js   (plain node, no deps)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* ------------------------- minimal DOM mocks ------------------------- */
function makeCtx2d() {
  const noop = () => {};
  const target = {
    setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop,
    moveTo: noop, lineTo: noop, stroke: noop, fill: noop, fillText: noop,
    arc: noop, save: noop, restore: noop, translate: noop, rotate: noop,
    drawImage: noop, strokeRect: noop, setLineDash: noop, closePath: noop,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),  // black decode -> drawing tests start from an empty mask
    putImageData: noop,
  };
  return new Proxy(target, {
    get(t, p) { if (p in t) return t[p]; return noop; },
    set(t, p, v) { t[p] = v; return true; },
  });
}

class FakeImage {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this.src = "";
    this.width = 0;
    this.height = 0;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
  }
}

function makeElement(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                  contains(c) { return this._s.has(c); }, toggle(c, force) {
                    if (force === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
                    else { force ? this._s.add(c) : this._s.delete(c); }
                  } },
    dataset: {},
    value: "",
    textContent: "",
    innerHTML: "",
    type: "",
    rows: 0,
    step: "",
    min: "", max: "",
    checked: false,
    accept: "",
    placeholder: "",
    className: "",
    clientWidth: 800,
    clientHeight: 450,
    width: 0,
    height: 0,
    src: "",
    muted: false,
    playsInline: false,
    preload: "",
    currentTime: 0,
    readyState: 0,
    duration: 6,
    videoWidth: 1280,
    videoHeight: 720,
    paused: true,
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    querySelector() { return makeElement("div"); },
    querySelectorAll() { return []; },
    getContext() { return makeCtx2d(); },
    click() {},
    focus() {},
    load() {},
    pause() {},
    play() { return Promise.resolve(); },
    toDataURL() { return "data:image/png;base64,QUJDRA=="; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 450 }; },
  };
  return el;
}

const documentMock = {
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
  head: { appendChild() {} },
  body: { appendChild() {} },
};

let capturedExtension = null;
const apiMock = {
  fetchApi: async () => ({ status: 200, json: async () => ({ name: "clip.mp4", subfolder: "" }) }),
  apiURL: (route) => "http://localhost:8188" + route,
};
const appMock = {
  registerExtension(ext) { capturedExtension = ext; },
  canvas: { ds: { scale: 1 } },
  graph: { setDirtyCanvas() {} },
};

const sandbox = {
  window: {
    comfyAPI: { app: { app: appMock }, api: { api: apiMock } },
    app: appMock,
    devicePixelRatio: 1,
  },
  document: documentMock,
  api: apiMock,
  app: appMock,
  Image: FakeImage,
  FormData: class { append() {} },
  fetch: () => Promise.resolve({ blob: () => Promise.resolve(new Blob(["x"], { type: "image/png" })) }),
  navigator: {},
  performance: { now: () => Date.now() },
  requestAnimationFrame() { return 0; },
  setTimeout(fn) { fn(); return 0; },
  console,
};
sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
sandbox.window.setTimeout = sandbox.setTimeout;
sandbox.window.navigator = sandbox.navigator;
sandbox.window.performance = sandbox.performance;

vm.createContext(sandbox);
const jsPath = path.join(__dirname, "..", "web", "js", "chaotic_video_edit.js");
const src = fs.readFileSync(jsPath, "utf-8");
vm.runInContext(src, sandbox, { filename: "chaotic_video_edit.js" });

if (!capturedExtension) {
  console.error("FAIL: extension was never registered (top-level threw?)");
  process.exit(1);
}

const savedEdit = {
  version: 1,
  mode: "inpaint",
  edit: "inside",
  plate_color: "black",
  output: "crop",
  crop_scale: 1.5,
  outpaint: false,
  prompt: "fix the hand",
  video_file: "input/clip.mp4",
  mask: {
    type: "brush",
    keys: [
      { t: 0.0, grid_w: 320, grid_h: 180, png: "QUJDRA==" },
      { t: 2.0, grid_w: 320, grid_h: 180, png: "QUJDRA==" },
    ],
  },
  chroma: { color: [0, 1, 0], similarity: 0.4, smooth: 0.1, spill: 0.2 },
};

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : "  FAIL ") + name + (extra ? "  (" + extra + ")" : ""));
  if (!cond) failures++;
}

(async () => {
  const nodeData = { name: "ChaoticH3VideoEdit" };
  function NodeType() {
    this.size = [1100, 760];
    this.widgets = [
      { name: "edit_data", value: JSON.stringify(savedEdit) },
      { name: "fps", value: 24 },
    ];
    this.addDOMWidget = (name, type, container, opts) => {
      this._container = container;
      this._domOpts = opts;
      return { name, computeSize: null, getValue: opts.getValue, setValue: opts.setValue };
    };
    this.setDirtyCanvas = () => {};
    this.computeSize = () => [1100, 600];
  }
  const proto = new NodeType();
  NodeType.prototype.onNodeCreated = function () { return undefined; };

  await capturedExtension.beforeRegisterNodeDef(NodeType, nodeData, appMock);

  const node = new NodeType();
  let threw = null;
  try { node.onNodeCreated(); } catch (e) { threw = e; }
  check("onNodeCreated did not throw", threw === null, threw ? threw.message : "");

  const ed = node._videoEditEditor;
  check("editor was constructed", !!ed);
  if (!ed) { console.error("FAIL: video edit editor missing. " + (threw ? threw.stack : "")); process.exit(1); }
  check("loaded saved mode", ed.state.mode === "inpaint");
  check("loaded 2 mask keys sorted", ed.state.mask.keys.length === 2 && ed.state.mask.keys[0].t === 0);
  check("loaded chroma settings", ed.state.chroma.similarity === 0.4 && ed.state.chroma.spill === 0.2);
  check("loaded crop output + scale", ed.state.output === "crop" && ed.state.crop_scale === 1.5);
  check("loaded prompt + video file", ed.state.prompt === "fix the hand" && ed.state.video_file === "input/clip.mp4");
  check("built canvas + key strip + panels", !!(ed.ctx && ed.keyCtx && ed.inpaintPanel && ed.chromaPanel));

  let drawThrew = null;
  try { ed.drawPreview(); ed.drawKeyStrip(); } catch (e) { drawThrew = e; }
  check("drawPreview/drawKeyStrip do not throw", drawThrew === null, drawThrew ? drawThrew.message : "");

  /* mode toggle (inpaint -> chroma -> reframe -> inpaint) */
  ed.toggleMode();
  check("mode toggles to chroma", ed.state.mode === "chroma" && ed.chromaPanel.style.display !== "none");
  ed.toggleMode();
  check("mode toggles to reframe", ed.state.mode === "reframe" && ed.reframePanel.style.display !== "none");
  ed.toggleMode();
  check("mode toggles back to inpaint", ed.state.mode === "inpaint");

  /* option setters */
  ed.setEdit("outside");
  check("edit setter", ed.state.edit === "outside" && ed.editBtns.outside.classList.contains("active"));
  ed.setPlate("green");
  check("plate setter", ed.state.plate_color === "green" && ed.plateBtns.green.classList.contains("active"));
  ed.setOutput("full");
  check("output setter", ed.state.output === "full" && ed.outputBtns.full.classList.contains("active"));
  ed.setTool("rect");
  check("tool setter", ed._tool === "rect" && ed.toolBtns.rect.classList.contains("active"));
  ed.setTool("brush");

  /* brush painting writes the work mask */
  ed.ensureGrid();
  const gw = ed._gridW, gh = ed._gridH;
  check("grid derived from 1280x720 video", gw === 320 && gh === 180, "grid=" + gw + "x" + gh);
  ed.playhead = 0.5;
  ed.onCanvasDown({ clientX: 40, clientY: 30 });
  for (let i = 1; i <= 5; i++) {
    ed.onCanvasMove({ clientX: 40 + i * 30, clientY: 30 + i * 10 });
  }
  ed.onCanvasUp();
  const painted = Array.from(ed._workMask).filter(v => v === 255).length;
  check("brush painted the work mask", painted > 10, "painted=" + painted);

  /* set / update / delete mask key */
  let keySet = null;
  try { ed.setMaskKey(); keySet = ed.keyAt(0.5) && ed.keyAt(0.5).png === "QUJDRA=="; } catch (e) { keySet = "THREW: " + e.message; }
  check("setMaskKey wrote a key with png", keySet === true, "keySet=" + keySet);
  check("key count now 3", ed.state.mask.keys.length === 3);
  ed.playhead = 0.5;
  ed.delMaskKey();
  check("delMaskKey removed the key", ed.state.mask.keys.length === 2);

  /* rect tool fill on mouseup (explicit tool switch, like the UI) */
  ed.setTool("rect");
  ed.onCanvasDown({ clientX: 10, clientY: 10 });
  ed.onCanvasMove({ clientX: 200, clientY: 150 });
  ed.onCanvasUp();
  const rectPainted = Array.from(ed._workMask).filter(v => v === 255).length;
  check("rect drag filled a rectangle", rectPainted > 2000, "filled=" + rectPainted);
  ed.setTool("brush");

  /* interpolation cross-fade with a deterministic decoder (left half masked) */
  const realDecode = ed.decodeMaskPng.bind(ed);
  ed.decodeMaskPng = (b64, gw, gh, outW, outH) => {
    const out = new Float32Array(outW * outH);
    const half = Math.floor(outW / 2);
    for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) out[y * outW + x] = x < half ? 1 : 0;
    return out;
  };
  const mid = ed.interpolatedMaskGrid(1.0);
  check("interpolatedMaskGrid returns data", !!mid && mid.data.length === 320 * 180);
  check("cross-fade keeps left half masked", mid && Math.abs(mid.data[0] - 1) < 1e-6, "v=" + (mid && mid.data[0]));
  check("cross-fade keeps right half empty", mid && Math.abs(mid.data[319] - 0) < 1e-6, "v=" + (mid && mid.data[319]));
  ed.decodeMaskPng = realDecode;

  /* serialize round trip */
  const serialized = JSON.parse(ed.serialize());
  check("serialize keeps mode + edit", serialized.mode === "inpaint" && serialized.edit === "outside");
  check("serialize keeps mask keys", serialized.mask.keys.length === 2);
  check("serialize keeps chroma", serialized.chroma.similarity === 0.4);

  /* sample color guard without video */
  let sampleThrew = null;
  try { ed.sampleColor(); } catch (e) { sampleThrew = e; }
  check("sampleColor does not throw without video", sampleThrew === null, sampleThrew ? sampleThrew.message : "");

  /* ---- mask tracking (pure helpers + widget path) ---- */
  const gray = sandbox.veGray({ width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]) });
  check("veGray luminance", Math.abs(gray[0] - 1) < 1e-6 && Math.abs(gray[1] - 0) < 1e-6);
  const pg = new Float32Array(16);
  pg[5] = 0.5;
  const patch = sandbox.vePatch(pg, 4, 4, 1, 1, 2, 2);
  check("vePatch extracts the centered cells", patch.data[0] === 0 && patch.data[3] === 0.5, "v=" + patch.data[3]);
  const a = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.9]);
  check("veNcc identical ~ 1", Math.abs(sandbox.veNcc(a, a.slice()) - 1) < 1e-9);
  const anti = new Float32Array(Array.from(a, v => 1 - v));
  check("veNcc anticorrelated ~ -1", Math.abs(sandbox.veNcc(a, anti) + 1) < 1e-9);

  const fw = 60, fh = 40;
  function makeFrame(bx, by) {
    const g = new Float32Array(fw * fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) g[y * fw + x] = (x / fw) * 0.2;  // gradient texture
    for (let y = by - 3; y <= by + 3; y++) for (let x = bx - 3; x <= bx + 3; x++) {
      if (x >= 0 && y >= 0 && x < fw && y < fh) g[y * fw + x] = 0.8;
    }
    return g;
  }
  const f0 = makeFrame(15, 12), f1 = makeFrame(30, 20);
  const tpl = sandbox.vePatch(f0, fw, fh, 15, 12, 14, 14);
  const hit = sandbox.veSearch(f1, fw, fh, tpl, 15, 12, 20, 2);
  check("veSearch finds the moved blob", Math.abs(hit.dx - 15) <= 1 && Math.abs(hit.dy - 8) <= 1,
    "dx=" + hit.dx + " dy=" + hit.dy + " score=" + hit.score.toFixed(3));
  check("veSearch reports a high score", hit.score > 0.8, "score=" + hit.score.toFixed(3));
  const flat = new Float32Array(fw * fh);  // zero variance
  const flatHit = sandbox.veSearch(flat, fw, fh, tpl, 15, 12, 20, 2);
  check("veSearch scores flat frames ~0 (below any floor)", flatHit.score < 0.6, "score=" + flatHit.score.toFixed(3));

  const tb = new Uint8ClampedArray(64 * 36);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) tb[y * 64 + x] = 255;
  const bbox = sandbox.veMaskBBox(tb, 64, 36);
  check("veMaskBBox finds the painted rect", bbox && bbox.x === 10 && bbox.y === 10 && bbox.w === 20 && bbox.h === 10,
    JSON.stringify(bbox));
  const tr = sandbox.veTranslateMask(tb, 64, 36, 8, 4);
  check("veTranslateMask shifts the mask", tr[14 * 64 + 18] === 255 && tr[10 * 64 + 10] === 0,
    "v=" + tr[14 * 64 + 18]);

  const keysBefore = ed.state.mask.keys.length;
  ed._gridW = 64; ed._gridH = 36;
  const added = ed.applyTrackKeys(tb, [{ t: 1.0, dx: 8, dy: 4, score: 0.9 }], 64, 36);
  const k1 = ed.keyAt(1.0);
  check("applyTrackKeys writes a tracked key", added === 1 && !!k1 && typeof k1.png === "string" && k1.png.length > 0,
    "added=" + added);
  check("applyTrackKeys sorted the key in", ed.state.mask.keys.length === keysBefore + 1 && k1.grid_w === 64);

  check("track UI built (button + progress + options)", !!ed.trackBtn && !!ed.trackProg
    && ed._trackOpts.every === 2 && ed._trackOpts.floor === 0.6);
  let trackThrew = null;
  try { await ed.trackMask(); } catch (e) { trackThrew = e; }
  check("trackMask on a flat/black preview adds no keys and does not throw",
    trackThrew === null && ed.state.mask.keys.length === keysBefore + 1 && ed._tracking === false,
    trackThrew ? trackThrew.message : "keys=" + ed.state.mask.keys.length);
  let clearThrew = null;
  try {
    ed._workMask = null;              // the state on a fresh node before any paint
    ed.clearMaskKeys();               // must not crash (guard against null)
    ed._workMask = new Uint8ClampedArray(64 * 36);
    ed.clearMaskKeys();
  } catch (e) { clearThrew = e; }
  check("clearMaskKeys survives a null work mask and commits",
    clearThrew === null && ed.state.mask.keys.length === 0, clearThrew ? clearThrew.message : "");

  /* ---- chroma: any screen color + auto-detect ---- */
  function mkFrame(bg, subject) {
    const dd = new Uint8ClampedArray(40 * 30 * 4);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) {
      const i = (y * 40 + x) * 4;
      const c = (x >= 10 && x < 30 && y >= 8 && y < 22) ? subject : bg;
      dd[i] = c[0]; dd[i + 1] = c[1]; dd[i + 2] = c[2]; dd[i + 3] = 255;
    }
    return { width: 40, height: 30, data: dd };
  }
  const blue = sandbox.veDetectKeyColor(mkFrame([20, 20, 235], [200, 40, 40]));
  check("veDetectKeyColor finds a blue backdrop", blue.color[2] > 0.7 && blue.color[0] < 0.25 && blue.frac > 0.5,
    "c=" + blue.color.map(v => v.toFixed(2)).join(",") + " frac=" + blue.frac.toFixed(2));
  const magenta = sandbox.veDetectKeyColor(mkFrame([235, 20, 235], [40, 200, 40]));
  check("veDetectKeyColor finds a magenta backdrop", magenta.color[0] > 0.7 && magenta.color[2] > 0.7 && magenta.color[1] < 0.25,
    "c=" + magenta.color.map(v => v.toFixed(2)).join(","));
  const solid = new Uint8ClampedArray(20 * 20 * 4);
  for (let i = 0; i < 20 * 20 * 4; i += 4) { solid[i] = 0; solid[i + 1] = 255; solid[i + 2] = 0; solid[i + 3] = 255; }
  const green = sandbox.veDetectKeyColor({ width: 20, height: 20, data: solid });
  check("veDetectKeyColor green screen full coverage", green.color[1] > 0.9 && green.frac === 1, "g=" + green.color[1].toFixed(2));

  /* auto-preserve pure helpers */
  const makeGray = (w, h, fill, rect) => {
    const g = new Float32Array(w * h);
    if (fill) g.fill(fill);
    if (rect) for (let y = rect.y0; y <= rect.y1; y++) for (let x = rect.x0; x <= rect.x1; x++) g[y * w + x] = 1;
    return g;
  };
  const ga = makeGray(40, 24, 0.1, { x0: 0, y0: 2, x1: 6, y1: 8 });
  const gb = makeGray(40, 24, 0.1, { x0: 0, y0: 3, x1: 6, y1: 9 });
  const diff = sandbox.veDiffMask(ga, gb, 40, 24, 0.05);
  let diffCount = 0;
  for (let i = 0; i < diff.length; i++) diffCount += diff[i];
  check("veDiffMask flags only moved pixels", diffCount > 0 && diffCount < 40 * 24, "n=" + diffCount);
  const edgeBlobs = sandbox.veEdgeBlobs(diff, 40, 24, "x", 0.1, 4);
  check("veEdgeBlobs finds the edge-touching mover", edgeBlobs.length >= 1 && edgeBlobs[0].x0 === 0, JSON.stringify(edgeBlobs));
  const centerDiff = new Uint8Array(40 * 24);
  for (let y = 10; y <= 15; y++) for (let x = 10; x <= 15; x++) centerDiff[y * 40 + x] = 1;
  check("veEdgeBlobs ignores center motion", sandbox.veEdgeBlobs(centerDiff, 40, 24, "x", 0.1, 4).length === 0);
  const topDiff = new Uint8Array(40 * 24);
  for (let y = 0; y <= 3; y++) for (let x = 10; x <= 14; x++) topDiff[y * 40 + x] = 1;
  check("veEdgeBlobs finds top-edge motion on the y axis", sandbox.veEdgeBlobs(topDiff, 40, 24, "y", 0.1, 4).length >= 1);
  const sideDiff = new Uint8Array(40 * 24);
  for (let y = 5; y <= 10; y++) for (let x = 37; x <= 39; x++) sideDiff[y * 40 + x] = 1;
  check("veEdgeBlobs ignores side motion on the y axis", sandbox.veEdgeBlobs(sideDiff, 40, 24, "y", 0.1, 4).length === 0);
  const clustered = sandbox.veClusterCandidates([
    { t: 0.5, blob: { x0: 0, y0: 0, x1: 5, y1: 5 } },
    { t: 1.0, blob: { x0: 1, y0: 0, x1: 6, y1: 5 } },
    { t: 2.0, blob: { x0: 30, y0: 0, x1: 35, y1: 5 } },
  ], 3);
  check("veClusterCandidates chains + sorts objects", clustered.length === 2 && clustered[0].t === 0.5, JSON.stringify(clustered));
  const capped = sandbox.veClusterCandidates([
    { t: 0.5, blob: { x0: 0, y0: 0, x1: 5, y1: 5 } },
    { t: 1.0, blob: { x0: 1, y0: 0, x1: 6, y1: 5 } },
  ], 1);
  check("veClusterCandidates caps max objects", capped.length === 1, JSON.stringify(capped));

  ed.setChromaPreset([0, 0, 1]);
  check("setChromaPreset sets blue + auto off",
    ed.state.chroma.color[2] > 0.9 && ed.state.chroma.auto === false && ed.autoBtn.classList.contains("active") === false);
  ed.videoEl.readyState = 1;   // the DOM mock never fires loadedmetadata
  ed.videoEl.src = "mock://clip.mp4";   // satisfy the detect guard; ctx mock getImageData returns 1x1 black
  ed.toggleChromaAuto();
  check("toggleChromaAuto turns auto on", ed.state.chroma.auto === true && ed.autoBtn.classList.contains("active"));
  let detThrew = null;
  try { await ed.detectChromaColor(true); } catch (e) { detThrew = e; }
  /* the DOM mock's frames are 1x1 black, so a run detection must overwrite the
     preset blue with [0,0,0] — this proves the widget path really executed */
  check("detectChromaColor ran and wrote the detected color",
    detThrew === null && ed.state.chroma.color[0] === 0 && ed.state.chroma.color[1] === 0 && ed.state.chroma.color[2] === 0,
    detThrew ? detThrew.message : "color=" + ed.state.chroma.color.join(","));
  ed.toggleChromaAuto();
  check("toggleChromaAuto turns auto off", ed.state.chroma.auto === false);
  check("chroma auto serializes", JSON.parse(ed.serialize()).chroma.auto === false);

  /* reframe mode + framerate + copy-to-reference */
  ed.state.mode = "inpaint";
  ed.toggleMode();  // -> chroma
  ed.toggleMode();  // -> reframe
  check("mode cycle reaches reframe", ed.state.mode === "reframe" && ed.modeBtn.textContent === "Mode: Reframe", "mode=" + ed.state.mode);
  check("reframe panel visible", ed.reframePanel.style.display === "flex");
  check("reframe defaults", ed.state.reframe.target_w === 1280 && ed.state.reframe.feather === 8 && ed.state.reframe.align_x === 0.5);
  let rfThrew = null;
  try { ed.setReframeTarget(720, 1280); ed.setReframeAlign("align_x", 0); } catch (e) { rfThrew = e; }
  check("setReframeTarget/Align commit without throwing", rfThrew === null && ed.state.reframe.target_w === 720 && ed.state.reframe.align_x === 0, rfThrew ? rfThrew.message : "");
  check("reframe serializes", JSON.parse(ed.serialize()).reframe.target_w === 720);

  /* reframe preserve brush (painting must work in reframe mode, mapped through
     the window — strokes in the void are ignored) */
  ed.playhead = 0.5;
  ed.onCanvasDown({ clientX: 300, clientY: 200 });
  ed.onCanvasMove({ clientX: 310, clientY: 210 });
  ed.onCanvasMove({ clientX: 330, clientY: 220 });
  ed.onCanvasUp();
  const rfPainted = Array.from(ed._workMask || []).filter(v => v === 255).length;
  check("reframe brush paints preserve strokes inside the window", rfPainted > 0, "painted=" + rfPainted);
  ed._workMask = new Uint8ClampedArray(ed._gridW * ed._gridH);
  ed.onCanvasDown({ clientX: 12, clientY: 12 });
  ed.onCanvasUp();
  const rfVoid = Array.from(ed._workMask || []).filter(v => v === 255).length;
  check("reframe brush ignores strokes in the void", rfVoid === 0, "painted=" + rfVoid);

  /* free-drag the source window (move tool) — target 720x1280, mock video 1280x720
     => vertical letterbox, only align_y has room to travel */
  ed.setRfTool("move");
  check("move tool sets cursor + active state", ed._rfTool === "move" && ed.canvas.style.cursor === "move" && ed.rfToolBtns.move.classList.contains("active"));
  ed.onCanvasDown({ clientX: 400, clientY: 200 });
  ed.onCanvasMove({ clientX: 400, clientY: 300 });
  check("window drag moves the placement", Math.abs(ed.state.reframe.align_y - 0.8251) < 0.02, "ay=" + ed.state.reframe.align_y.toFixed(3));
  ed.onCanvasMove({ clientX: 400, clientY: 600 });
  check("window drag clamps inside the target", ed.state.reframe.align_y === 1, "ay=" + ed.state.reframe.align_y);
  check("flush axis is never scribbled", ed.state.reframe.align_x === 0, "ax=" + ed.state.reframe.align_x);
  ed.onCanvasUp();
  check("window drag commits on release", JSON.parse(ed.serialize()).reframe.align_y === 1);

  /* rotate + scale handles on the move tool (canvas 800x450, target 720x1280,
     source window 253x142 -> reset to centered, handles at (400,140) and
     (527,296)) */
  ed.setRfTool("move");
  ed.state.reframe.align_x = 0.5;
  ed.state.reframe.align_y = 0.5;
  check("rotate handle hit-tests above the window", ed.reframeHandleAt(400, 140, 800, 450) === "rotate", "h=" + ed.reframeHandleAt(400, 140, 800, 450));
  check("scale handle hit-tests on the corner", ed.reframeHandleAt(527, 296, 800, 450) === "scale", "h=" + ed.reframeHandleAt(527, 296, 800, 450));
  check("window body hit-tests as move", ed.reframeHandleAt(450, 220, 800, 450) === "move", "h=" + ed.reframeHandleAt(450, 220, 800, 450));

  ed.state.reframe.scale = 2; ed.state.reframe.rotation = 0;
  const w2 = ed.reframeWindow(800, 450);
  check("scale 2× doubles the source window", Math.abs(w2.sw - 506.25) < 2 && Math.abs(w2.sh - 284.76) < 2, "sw=" + w2.sw.toFixed(1));
  ed.state.reframe.scale = 1; ed.state.reframe.rotation = 45;
  check("rotation lands in the window geometry", Math.abs(ed.reframeWindow(800, 450).rot - Math.PI / 4) < 1e-6);
  ed.state.reframe.rotation = 0;

  const srcMid = ed.reframeCanvasToSource(0.5, 0.5);  // the window center
  check("canvasToSource maps the window center to source center", !!srcMid && Math.abs(srcMid.x - 0.5) < 0.05 && Math.abs(srcMid.y - 0.5) < 0.05, JSON.stringify(srcMid));
  check("canvasToSource returns null in the void", ed.reframeCanvasToSource(0.02, 0.02) === null);

  /* JS window geometry must equal the Python plate box, scaled by the canvas
     display factor (WYSIWYG proof): independent port of reframe_plate's box */
  const TW = 720, TH = 1280, VW = 1280, VH = 720;
  const dispS = Math.min(800 / TW, 450 / TH);
  const pyBox = (scale, ax, ay, fit) => {
    const k = Math.min(TW / VW, TH / VH) * (fit === "smaller" ? 0.8 : 1) * scale;
    const sw = Math.max(1, Math.round(VW * k)), sh = Math.max(1, Math.round(VH * k));
    let sx = Math.round((TW - sw) * ax), sy = Math.round((TH - sh) * ay);
    if (sw <= TW) sx = Math.min(Math.max(0, sx), TW - sw);
    else sx = Math.min(Math.max(0, sx + Math.floor(sw / 2)), TW) - Math.floor(sw / 2);
    if (sh <= TH) sy = Math.min(Math.max(0, sy), TH - sh);
    else sy = Math.min(Math.max(0, sy + Math.floor(sh / 2)), TH) - Math.floor(sh / 2);
    return [sx, sy, sw, sh];
  };
  const matchesPy = (w, p) =>
    Math.abs(w.sx - (w.wx + p[0] * dispS)) < 2 && Math.abs(w.sy - (w.wy + p[1] * dispS)) < 2 &&
    Math.abs(w.sw - p[2] * dispS) < 2 && Math.abs(w.sh - p[3] * dispS) < 2;
  ed.state.reframe.scale = 1; ed.state.reframe.align_x = 0; ed.state.reframe.align_y = 1;
  const wpy1 = ed.reframeWindow(800, 450), ppy1 = pyBox(1, 0, 1);
  check("JS window matches the Python plate box (WYSIWYG, scale 1)", matchesPy(wpy1, ppy1),
    "js=" + wpy1.sw.toFixed(1) + "x" + wpy1.sh.toFixed(1) + " py=" + ppy1[2] + "x" + ppy1[3]);
  ed.state.reframe.scale = 2; ed.state.reframe.align_x = 0.5; ed.state.reframe.align_y = 0.5;
  const wpy2 = ed.reframeWindow(800, 450), ppy2 = pyBox(2, 0.5, 0.5);
  check("JS window matches the Python plate box at scale 2 (oversized centering)", matchesPy(wpy2, ppy2),
    "js=" + wpy2.sw.toFixed(1) + "x" + wpy2.sh.toFixed(1) + " py=" + ppy2[2] + "x" + ppy2[3]);

  /* non-center round-trip: 3/4 of the window maps to 3/4 of the source */
  ed.state.reframe.scale = 1; ed.state.reframe.rotation = 0;
  const wq = ed.reframeWindow(800, 450);
  const qx = (wq.cx + wq.sw * 0.25) / 800, qy = (wq.cy - wq.sh * 0.25) / 450;
  const q = ed.reframeCanvasToSource(qx, qy);
  check("canvasToSource round-trips a non-center point (3/4 of the window)",
    !!q && Math.abs(q.x - 0.75) < 0.03 && Math.abs(q.y - 0.25) < 0.03, JSON.stringify(q));
  ed.state.reframe.align_x = 0.5; ed.state.reframe.align_y = 0.5;

  /* fit smaller: base fit x 0.8 keeps margin on BOTH axes at scale 1, so the
     move tool can place the window anywhere (true 2D free placement) */
  ed.setRfFit("smaller");
  check("Fit toggle writes smaller + serializes", ed.state.reframe.fit === "smaller" &&
    JSON.parse(ed.serialize()).reframe.fit === "smaller" && ed.rfFitBtns.smaller.classList.contains("active"));
  ed.state.reframe.scale = 1; ed.state.reframe.align_x = 0; ed.state.reframe.align_y = 1;
  const wsm = ed.reframeWindow(800, 450), psm = pyBox(1, 0, 1, "smaller");
  check("fit smaller keeps margin on both axes at scale 1",
    wsm.sw < wsm.ww && wsm.sh < wsm.wh, "sw=" + wsm.sw.toFixed(1) + " ww=" + wsm.ww.toFixed(1));
  check("fit smaller window matches the Python plate box (WYSIWYG)", matchesPy(wsm, psm),
    "dx=" + Math.abs(wsm.sx - (wsm.wx + psm[0] * dispS)).toFixed(2) +
    " dy=" + Math.abs(wsm.sy - (wsm.wy + psm[1] * dispS)).toFixed(2) +
    " dw=" + Math.abs(wsm.sw - psm[2] * dispS).toFixed(2) +
    " dh=" + Math.abs(wsm.sh - psm[3] * dispS).toFixed(2));
  ed.setRfTool("move");
  ed.onCanvasDown({ clientX: 500, clientY: 250 });
  ed.onCanvasMove({ clientX: 620, clientY: 250 });
  const travelX = Math.abs(ed.state.reframe.align_x - 0);
  check("fit smaller unlocks horizontal free travel (contain pins flush)", travelX > 0.05,
    "ax=" + ed.state.reframe.align_x.toFixed(2));
  ed.onCanvasUp();
  ed.setRfFit("contain");
  check("Fit toggle round-trips back to contain", ed.state.reframe.fit === "contain" &&
    ed.rfFitBtns.contain.classList.contains("active"));

  /* flush-left placement must survive a save/load round-trip — align 0 is
     falsy, so hydration must not re-center it (WYSIWYG parity with Python),
     and the reframe MODE itself must survive reload too */
  ed.setReframeAlign("align_x", 0);
  ed.editDataWidget.value = ed.serialize();
  ed.loadState();
  check("flush-left placement survives save/load (align 0 not re-centered)",
    ed.state.reframe.align_x === 0, "ax=" + ed.state.reframe.align_x);
  check("reframe mode survives save/load", ed.state.mode === "reframe",
    "mode=" + ed.state.mode);
  ed.state.reframe.scale = 1; ed.state.reframe.rotation = 0;
  ed.state.reframe.align_x = 0.5; ed.state.reframe.align_y = 0.5;

  /* rotate drag: grab the knob and swing it 90° clockwise (ang0 = -90°) */
  ed.onCanvasDown({ clientX: 400, clientY: 140 });
  ed.onCanvasMove({ clientX: 526, clientY: 225 });
  check("rotate drag writes rotation", Math.abs(ed.state.reframe.rotation - 90) < 3, "rot=" + ed.state.reframe.rotation.toFixed(1));
  ed.onCanvasMove({ clientX: 300, clientY: 400 });
  check("rotate drag clamps at ±180", ed.state.reframe.rotation === 180, "rot=" + ed.state.reframe.rotation);
  ed.onCanvasUp();
  check("rotate commits on release", JSON.parse(ed.serialize()).reframe.rotation === 180);
  ed.state.reframe.rotation = 0;

  /* scale drag: pull the corner outward to grow, then clamp at 4× */
  ed.onCanvasDown({ clientX: 527, clientY: 296 });
  ed.onCanvasMove({ clientX: 700, clientY: 420 });
  check("scale drag grows the window", ed.state.reframe.scale > 2 && ed.state.reframe.scale < 2.7, "s=" + ed.state.reframe.scale.toFixed(2));
  ed.onCanvasMove({ clientX: 1200, clientY: 800 });
  check("scale drag clamps at 4×", ed.state.reframe.scale === 4, "s=" + ed.state.reframe.scale);
  ed.onCanvasUp();
  check("scale commits on release", JSON.parse(ed.serialize()).reframe.scale === 4);
  ed.state.reframe.scale = 1;
  ed.setRfTool("brush");
  check("back to brush tool", ed._rfTool === "brush" && ed.canvas.style.cursor === "crosshair");

  /* auto-preserve widget paths (mode is still reframe; mock video frames are black) */
  const autoKeysBefore = ed.state.mask.keys.length;
  let apThrew = null;
  try { await ed.autoPreserve(); } catch (e) { apThrew = e; }
  check("autoPreserve on a black mock adds nothing and does not throw",
    apThrew === null && ed.state.mask.keys.length === autoKeysBefore && (ed.statusLine.textContent || "").indexOf("no objects") !== -1,
    apThrew ? apThrew.message : ed.statusLine.textContent);
  const addedKeys = ed.writeAutoPreserveKeys(
    [{ pts: [{ t: 0.5, cx: 20, cy: 18 }, { t: 1.0, cx: 24, cy: 18 }], rw: 6, rh: 6 }],
    160, 90);
  check("writeAutoPreserveKeys writes sorted brush keys",
    addedKeys === 2 && ed.state.mask.type === "brush" &&
    ed.state.mask.keys.length === autoKeysBefore + 2 &&
    ed.state.mask.keys.every((k, i, a) => i === 0 || a[i - 1].t <= k.t) &&
    ed.state.mask.keys.every(k => (k.png || "").length > 0),
    "added=" + addedKeys + " keys=" + ed.state.mask.keys.length);
  /* union: auto keys must ADD to a manual key at the same time, not replace it */
  ed.state.mask.keys = [{ t: 0.5, grid_w: 320, grid_h: 180, png: "QUJDRA==" }];
  const beforeUnion = ed.state.mask.keys.length;
  const unionAdded = ed.writeAutoPreserveKeys(
    [{ pts: [{ t: 0.5, cx: 20, cy: 18 }], rw: 6, rh: 6 }],
    160, 90);
  check("writeAutoPreserveKeys unions with a manual key at the same time",
    unionAdded === 1 && ed.state.mask.keys.length === beforeUnion && ed.state.mask.keys[0].t === 0.5,
    "added=" + unionAdded + " keys=" + ed.state.mask.keys.length);

  check("fps row shows the node fps", (ed.fpsInfo.textContent || "").indexOf("fps: node 24") === 0, ed.fpsInfo.textContent);
  ed.setVideoFps(29.97);
  check("fps mismatch flagged in the row", (ed.fpsInfo.textContent || "").indexOf("mismatch") !== -1, ed.fpsInfo.textContent);
  ed.state.video_fps = null;
  ed.checkFpsConsistency();
  ed._selRect = null;
  await ed.copyToReference();
  check("copyToReference without a selection just warns", ed.state.refs.length === 0 && (ed.statusLine.textContent || "").indexOf("rectangle") !== -1, ed.statusLine.textContent);
  ed._selRect = { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.5 };
  ed.playhead = 1.25;
  await ed.copyToReference();
  check("copyToReference adds a ref crop", ed.state.refs.length === 1 && ed.state.refs[0].src.length > 0 && ed.state.refs[0].at === 1.25, "refs=" + ed.state.refs.length);
  check("copyToReference uploads the crop for cross-node import", ed.state.refs[0].file === "clip.mp4" && (ed.state.refs[0].thumb || "").indexOf("view?filename=clip.mp4") !== -1, "file=" + ed.state.refs[0].file);
  check("refs row renders a thumb", ed.refsRow.style.display === "flex" && ed.refsRow.children.length === 2);
  let postedCrops = null;
  const veOrigFetch = apiMock.fetchApi;
  apiMock.fetchApi = async (path, opts) => {
    if (path === "/chaotic_h3/crops" && opts && opts.method === "POST") {
      postedCrops = JSON.parse(opts.body || "{}");
      return { status: 200, json: async () => ({ status: "ok" }) };
    }
    return veOrigFetch(path, opts);
  };
  await ed.exportCrops();
  check("exportCrops posts the crops bundle", !!postedCrops && Array.isArray(postedCrops.crops) && postedCrops.crops.length === 1 && postedCrops.crops[0].file === "clip.mp4" && postedCrops.crops[0].at === 1.25, JSON.stringify(postedCrops));
  check("export reports the count", (ed.statusLine.textContent || "").indexOf("Exported 1 crop(s)") !== -1, ed.statusLine.textContent);
  apiMock.fetchApi = veOrigFetch;
  ed.state.refs.push({ src: "AAAA", file: "", at: 2.0, note: "" });
  await ed.exportCrops();
  check("exportCrops reports skipped file-less crops", (ed.statusLine.textContent || "").indexOf("have no uploaded file") !== -1, ed.statusLine.textContent);
  ed.removeRef(1);
  ed.removeRef(0);
  check("removeRef clears the strip", ed.state.refs.length === 0 && ed.refsRow.style.display === "none");
  await ed.exportCrops();
  check("exportCrops without uploadable crops warns", (ed.statusLine.textContent || "").indexOf("Nothing to export") !== -1, ed.statusLine.textContent);

  /* fresh node path */
  (async () => {
    const NodeType2 = function () {
      this.size = [1100, 760];
      this.widgets = [
        { name: "edit_data", value: "" },
        { name: "fps", value: 24 },
      ];
      this.addDOMWidget = (name, type, container, opts) => ({ name, computeSize: null, getValue: opts.getValue, setValue: opts.setValue });
      this.setDirtyCanvas = () => {};
      this.computeSize = () => [1100, 600];
    };
    await capturedExtension.beforeRegisterNodeDef(NodeType2, { name: "ChaoticH3VideoEdit" }, appMock);
    const fresh = new NodeType2();
    let t2 = null;
    try { fresh.onNodeCreated(); } catch (e) { t2 = e; }
    check("fresh node constructs with empty edit", !!fresh._videoEditEditor && t2 === null, t2 ? t2.message : "");
    check("fresh node defaults to inpaint", fresh._videoEditEditor.state.mode === "inpaint");
    check("fresh node has zero mask keys", fresh._videoEditEditor.state.mask.keys.length === 0);

    console.log(failures === 0 ? "\nVIDEO EDIT SMOKE: ALL PASS" : "\nVIDEO EDIT SMOKE: " + failures + " FAILURE(S)");
    process.exit(failures === 0 ? 0 : 1);
  })();
})();
