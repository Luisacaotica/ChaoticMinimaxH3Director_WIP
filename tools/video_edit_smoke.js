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

  /* mode toggle */
  ed.toggleMode();
  check("mode toggles to chroma", ed.state.mode === "chroma" && ed.chromaPanel.style.display !== "none");
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
