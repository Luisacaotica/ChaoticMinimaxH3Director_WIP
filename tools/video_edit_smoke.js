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

  /* reframe preserve brush (painting must work in reframe mode) */
  ed.playhead = 0.5;
  ed.onCanvasDown({ clientX: 120, clientY: 80 });
  ed.onCanvasMove({ clientX: 130, clientY: 90 });
  ed.onCanvasMove({ clientX: 150, clientY: 100 });
  ed.onCanvasUp();
  const rfPainted = Array.from(ed._workMask || []).filter(v => v === 255).length;
  check("reframe brush paints preserve strokes", rfPainted > 0, "painted=" + rfPainted);

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
  ed.setRfTool("brush");
  check("back to brush tool", ed._rfTool === "brush" && ed.canvas.style.cursor === "crosshair");

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
  check("refs row renders a thumb", ed.refsRow.style.display === "flex" && ed.refsRow.children.length === 1);
  ed.removeRef(0);
  check("removeRef clears the strip", ed.state.refs.length === 0 && ed.refsRow.style.display === "none");

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
