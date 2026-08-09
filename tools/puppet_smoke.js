#!/usr/bin/env node
/* puppet_smoke.js — regression harness for the ChaoticH3MockupEditor widget.
 *
 * Loads web/js/chaotic_puppet.js under a mocked ComfyUI frontend and drives the
 * real registration path (registerExtension -> beforeRegisterNodeDef ->
 * onNodeCreated -> new ChaoticPuppetEditor) against a saved 2-layer scene with
 * keyframes, then exercises keyframe editing and serialization round-trips.
 *
 * Run: node tools/puppet_smoke.js   (plain node, no deps)
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
                  contains(c) { return this._s.has(c); }, toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } },
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
    duration: 0,
    videoWidth: 0,
    videoHeight: 0,
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
  fetchApi: async () => ({ status: 200, json: async () => ({ name: "x.png", subfolder: "" }) }),
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
  AudioContext: class { decodeAudioData() { return Promise.resolve({ duration: 10, getChannelData: () => new Float32Array(1000) }); } },
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
const jsPath = path.join(__dirname, "..", "web", "js", "chaotic_puppet.js");
const src = fs.readFileSync(jsPath, "utf-8");
vm.runInContext(src, sandbox, { filename: "chaotic_puppet.js" });

if (!capturedExtension) {
  console.error("FAIL: extension was never registered (top-level threw?)");
  process.exit(1);
}

const savedScene = {
  version: 1,
  aspect: "16:9",
  bg: { type: "color", color: [16, 18, 22] },
  layers: [
    { id: "layer_hero", type: "image", name: "Hero", file: "input/hero.png",
      fit: "contain", x: 0.3, y: 0.6, scale: 0.8, rotation: 0, opacity: 1.0,
      text: "", color: "#ffffff", font_size: 0.06, trim_start: 0,
      keys: [
        { t: 0, x: 0.3, y: 0.6, scale: 0.8, rotation: 0, opacity: 1 },
        { t: 2, x: 0.7, y: 0.4, scale: 1.2, rotation: 10, opacity: 0.6 },
      ] },
    { id: "layer_title", type: "text", name: "Title", file: "",
      fit: "contain", x: 0.5, y: 0.15, scale: 1, rotation: 0, opacity: 1.0,
      text: "EPISODE 1", color: "#ffffff", font_size: 0.08, trim_start: 0, keys: [] },
  ],
  audio: { file: "", trim_start: 0, trim_end: null },
};

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : "  FAIL ") + name + (extra ? "  (" + extra + ")" : ""));
  if (!cond) failures++;
}

(async () => {
  const nodeData = { name: "ChaoticH3MockupEditor" };
  function NodeType() {
    this.size = [1100, 760];
    this.widgets = [
      { name: "scene_data", value: JSON.stringify(savedScene) },
      { name: "fps", value: 24 },
      { name: "duration_sec", value: 6 },
      { name: "width", value: 1280 },
      { name: "height", value: 720 },
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

  const ed = node._puppetEditor;
  check("editor was constructed", !!ed);
  if (!ed) { console.error("FAIL: mockup editor missing. " + (threw ? threw.stack : "")); process.exit(1); }
  check("loaded 2 saved layers", ed.state.layers.length === 2, "layers=" + ed.state.layers.length);
  check("keyframes sorted by time", ed.state.layers[0].keys[0].t === 0 && ed.state.layers[0].keys[1].t === 2);
  check("text layer kept content", ed.state.layers[1].type === "text" && ed.state.layers[1].text === "EPISODE 1");
  check("loaded keys default to linear ease", ed.state.layers[0].keys.every(k => k.ease === "linear"));
  check("built stage canvas + ctx", !!ed.ctx);
  check("built key strip + layers panel + audio panel", !!(ed.keyCtx && ed.layersList && ed.audioWave));
  check("default stage aspect is 16:9", Math.abs(ed.stageAspect() - 16 / 9) < 1e-6, "aspect=" + ed.stageAspect());

  /* aspect-ratio presets */
  let presetThrew = null;
  try {
    ed.applyAspectPreset("9:16");
  } catch (e) { presetThrew = e; }
  check("applyAspectPreset(9:16) does not throw", presetThrew === null, presetThrew ? presetThrew.message : "");
  check("9:16 preset updates the render-size widgets", ed.widthWidget && ed.widthWidget.value === 720 && ed.heightWidget && ed.heightWidget.value === 1280,
    "w=" + (ed.widthWidget && ed.widthWidget.value) + " h=" + (ed.heightWidget && ed.heightWidget.value));
  check("stage aspect follows the 9:16 size", Math.abs(ed.stageAspect() - 720 / 1280) < 1e-6, "aspect=" + ed.stageAspect());
  check("aspect serializes into the scene", JSON.parse(ed.serialize()).aspect === "9:16");
  ed.applyAspectPreset("1:1");
  check("1:1 preset sets square render size", ed.widthWidget.value === 1024 && ed.heightWidget.value === 1024);
  check("square stage aspect", Math.abs(ed.stageAspect() - 1) < 1e-6, "aspect=" + ed.stageAspect());
  /* custom size via the widget-edit callback path (what a user typing
     width/height triggers in ComfyUI) */
  let cbThrew = null;
  try {
    ed.widthWidget.value = 800;
    ed.heightWidget.value = 1280;
    ed.widthWidget.callback();
  } catch (e) { cbThrew = e; }
  check("widget callback path does not throw", cbThrew === null, cbThrew ? cbThrew.message : "");
  check("manual width edit marks aspect custom", ed.stateAspectLabel() === "custom", "aspect=" + ed.stateAspectLabel());
  check("custom stage aspect follows 800x1280", Math.abs(ed.stageAspect() - 800 / 1280) < 1e-6, "aspect=" + ed.stageAspect());
  check("custom aspect serializes", JSON.parse(ed.serialize()).aspect === "custom");
  ed.widthWidget.value = 720;
  ed.heightWidget.value = 1280;
  ed.widthWidget.callback();
  check("typing exact preset dims re-labels 9:16", ed.stateAspectLabel() === "9:16", "aspect=" + ed.stateAspectLabel());
  /* restore landscape for the rest of the harness */
  ed.applyAspectPreset("16:9");
  check("16:9 preset restores 1280x720", ed.widthWidget.value === 1280 && ed.heightWidget.value === 720);

  let stageThrew = null;
  try { ed.drawStage(); ed.drawKeyStrip(); ed.drawAudioWave(); } catch (e) { stageThrew = e; }
  check("drawStage/drawKeyStrip/drawAudioWave do not throw", stageThrew === null, stageThrew ? stageThrew.message : "");

  /* keyframe editing */
  ed.selectedId = "layer_hero";
  ed.playhead = 1.0;
  let keyAdded = null;
  try { ed.addKeyAtPlayhead(); keyAdded = ed.layerById("layer_hero").keys.some(k => Math.abs(k.t - 1.0) < 0.02); } catch (e) { keyAdded = "THREW: " + e.message; }
  check("addKeyAtPlayhead inserted a key", keyAdded === true, "keyAdded=" + keyAdded);

  let edited = null;
  try { ed.setProp(ed.layerById("layer_hero"), "scale", 0.5); edited = ed.layerById("layer_hero").keys.find(k => Math.abs(k.t - 1.0) < 0.02).scale; } catch (e) { edited = "THREW: " + e.message; }
  check("setProp updates the key at the playhead", edited === 0.5, "scale=" + edited);

  let removed = null;
  try { ed.delKeyAtPlayhead(); removed = !ed.layerById("layer_hero").keys.some(k => Math.abs(k.t - 1.0) < 0.02); } catch (e) { removed = "THREW: " + e.message; }
  check("delKeyAtPlayhead removed the key", removed === true, "removed=" + removed);

  /* serialization round trip */
  const serialized = JSON.parse(ed.serialize());
  check("serialize round-trips layers", serialized.layers.length === 2);
  check("serialize round-trips keys", serialized.layers[0].keys.length === 2);
  check("serialize keeps bg + audio", serialized.bg.type === "color" && serialized.audio.file === "");

  /* keyboard shortcuts: arrows nudge, S keys at playhead, R render window */
  const keyEv = (key, shift) => ({ key, shiftKey: !!shift, target: {}, preventDefault() {} });
  const hero0 = ed.layerById("layer_hero");
  const hx0 = hero0.x != null ? hero0.x : 0.5;
  const hy0 = hero0.y != null ? hero0.y : 0.5;
  ed.selectedId = "layer_hero";
  try { ed.onKeyDown(keyEv("ArrowRight")); } catch (e) { check("ArrowRight did not throw", false, e.message); }
  check("ArrowRight nudges the layer 1 px on stage", hero0.x > hx0, "dx=" + (hero0.x - hx0).toFixed(5));
  try { ed.onKeyDown(keyEv("ArrowUp", true)); } catch (e) { check("Shift+ArrowUp did not throw", false, e.message); }
  check("Shift+ArrowUp nudges the layer 10 px up", hero0.y < hy0, "dy=" + (hero0.y - hy0).toFixed(5));
  const kBefore = hero0.keys.length;
  try { ed.setPlayhead(1.5); ed.onKeyDown(keyEv("s")); } catch (e) { check("S did not throw", false, e.message); }
  check("S keys the selected layer at the playhead", hero0.keys.length === kBefore + 1 && hero0.keys.some(k => Math.abs(k.t - 1.5) < 0.02), "keys=" + hero0.keys.length);
  /* keyframe position nudge: up/down moves y, never x */
  const keyA = hero0.keys.find(k => Math.abs(k.t) < 0.02);
  const kx0 = keyA.x, ky0 = keyA.y;
  ed._selKeys.add("layer_hero@" + keyA.t);
  try { ed.onKeyDown(keyEv("ArrowDown")); } catch (e) { check("keyframe ArrowDown did not throw", false, e.message); }
  check("keyframe ArrowDown nudges y (not x)", keyA.y > ky0 && Math.abs(keyA.x - kx0) < 1e-9, "dy=" + (keyA.y - ky0).toFixed(5));
  try { ed.onKeyDown(keyEv("ArrowUp", true)); } catch (e) { check("Shift+ArrowUp keyframe did not throw", false, e.message); }
  check("Shift+ArrowUp keyframe nudges 10 px up", keyA.y < ky0, "dy=" + (keyA.y - ky0).toFixed(5));
  ed._selKeys.clear();
  /* cleanup: drop the key S added so later interpolation tests are untouched */
  hero0.keys = hero0.keys.filter(k => Math.abs(k.t - 1.5) > 0.02);
  ed.renderIn = null; ed.renderOut = null;
  try { ed.setPlayhead(2); ed.onKeyDown(keyEv("r")); } catch (e) { check("R IN did not throw", false, e.message); }
  check("R sets the render IN at the playhead", ed.renderIn === 2, "in=" + ed.renderIn);
  try { ed.setPlayhead(4); ed.onKeyDown(keyEv("R")); } catch (e) { check("R OUT did not throw", false, e.message); }
  check("second R sets the render OUT", ed.renderOut === 4, "out=" + ed.renderOut);
  try { ed.onKeyDown(keyEv("r")); } catch (e) { check("third R did not throw", false, e.message); }
  check("third R clears the render window", ed.renderIn === null && ed.renderOut === null, "in=" + ed.renderIn + " out=" + ed.renderOut);
  ed.renderIn = 2; ed.renderOut = 4;
  const winJson = JSON.parse(ed.serialize());
  check("render window serializes", winJson.render_in === 2 && winJson.render_out === 4, "in=" + winJson.render_in + " out=" + winJson.render_out);
  ed.renderIn = null; ed.renderOut = null;
  try { ed.onKeyDown(Object.assign(keyEv("r"), { ctrlKey: true })); } catch (e) { check("ctrl+R ignored", false, e.message); }
  check("ctrl+R is ignored (no hijack)", ed.renderIn === null && ed.renderOut === null);

  /* easing modes (module helpers + key strip + inspector dropdown) */
  const hero = ed.layerById("layer_hero");
  const p0 = hero.keys.find(k => Math.abs(k.t) < 0.02);
  const pAt = sandbox.propsAt;
  p0.ease = "out";
  check("serialize carries ease", JSON.parse(ed.serialize()).layers[0].keys[0].ease === "out");
  check("ease-out midpoint > linear (fast start)", pAt(hero, 1.0).x > 0.5, "x=" + pAt(hero, 1.0).x.toFixed(3));
  p0.ease = "hold";
  check("hold stays at key A mid-segment", Math.abs(pAt(hero, 1.0).x - 0.3) < 1e-6, "x=" + pAt(hero, 1.0).x);
  check("hold jumps to key B at its time", Math.abs(pAt(hero, 2.0).x - 0.7) < 1e-6, "x=" + pAt(hero, 2.0).x);
  p0.ease = "in";
  check("ease-in midpoint < linear", pAt(hero, 1.0).x < 0.5, "x=" + pAt(hero, 1.0).x.toFixed(3));
  p0.ease = "linear";
  check("key strip redraw with eased keys does not throw", (() => { ed.drawKeyStrip(); return true; })());
  ed.selectedId = "layer_hero";
  ed.playhead = 0.0;
  let inspThrew = null;
  try { ed.buildInspector(); } catch (e) { inspThrew = e; }
  check("inspector builds with the ease dropdown", inspThrew === null, inspThrew ? inspThrew.message : "");
  ed.selectedId = null;

  /* mouse recording (Cappuccino-style) */
  ed.selectedId = "layer_hero";
  ed.playhead = 0.0;
  ed.toggleRec();
  check("REC arms", ed._recArmed === true);
  ed.toggleRecChannel("size");
  check("size channel toggled", ed._recChannels.size === true);
  /* a recorded take: down on the layer (center at key0), drag, release */
  const heroKeysBefore = ed.layerById("layer_hero").keys.length;
  ed._recStartPlayhead = 0.0;
  ed.onStageDown({ clientX: 240, clientY: 270 });
  ed._recStart = Date.now() - 100;  // sandbox performance.now() is Date.now(); simulate a take 100 ms in
  ed.onStageMove({ clientX: 300, clientY: 280 });
  ed.onStageMove({ clientX: 340, clientY: 300 });
  ed.onStageUp();
  const heroKeys = ed.layerById("layer_hero").keys;
  const recKey = heroKeys.find(k => k.t >= 0.05 && k.t < 1);
  check("recording wrote a key during the take", !!recKey && heroKeys.length > heroKeysBefore,
    "keys=" + heroKeys.length + " t=" + heroKeys.map(k => k.t.toFixed(2)).join(","));
  check("recorded take wrote the enabled channels", recKey && Math.abs(recKey.x - 0.375) < 0.001 && Math.abs(recKey.scale - 0.8) > 0.001,
    "x=" + (recKey && recKey.x.toFixed(3)) + " scale=" + (recKey && recKey.scale.toFixed(3)));
  check("recorded keys are linear ease", heroKeys.every(k => (k.ease || "linear") === "linear"));
  check("REC still armed after the take", ed._recArmed === true && ed._recCapturing === false);
  ed.toggleRec();
  check("REC disarms", ed._recArmed === false);
  ed.selectedId = null;

  /* ---- multi-track: per-layer speed + z-order reordering ---- */
  const spLayer = {
    type: "image", name: "sp", file: "", fit: "contain",
    x: 0.3, y: 0.6, scale: 1, rotation: 0, opacity: 1,
    speed: 2,
    keys: [
      { t: 0, ease: "linear", x: 0.3, y: 0.6, scale: 1, rotation: 0, opacity: 1 },
      { t: 2, ease: "linear", x: 0.7, y: 0.4, scale: 1, rotation: 0, opacity: 1 },
    ],
  };
  check("propsAt warps by layer speed (t=0.5 -> local 1 = midpoint)",
    Math.abs(sandbox.propsAt(spLayer, 0.5).x - 0.5) < 1e-6, "x=" + sandbox.propsAt(spLayer, 0.5).x.toFixed(3));
  check("propsAt hides a layer outside its speed window (t=1.5 -> local 3)", sandbox.propsAt(spLayer, 1.5) === null);
  const spSlow = Object.assign({}, spLayer, { speed: 0.5 });
  check("propsAt slow speed: midpoint at project t=2 (local 1)",
    Math.abs(sandbox.propsAt(spSlow, 2.0).x - 0.5) < 1e-6, "x=" + sandbox.propsAt(spSlow, 2.0).x.toFixed(3));

  const heroL = ed.layerById("layer_hero");
  check("layers default to speed 1", heroL.speed === 1, "speed=" + heroL.speed);
  heroL.speed = 2.5;
  ed.commitChanges();
  check("serialize carries layer speed", JSON.parse(ed.serialize()).layers[0].speed === 2.5);
  /* the DOM mock's innerHTML= clearing doesn't drop children, so reset the
     list container before reading the freshest rows */
  ed.layersList.children.length = 0;
  ed.refreshLayerList();
  const row0 = ed.layersList.children[0];
  const rowTexts = row0 ? (row0.children || []).map(c => c.textContent || "").join("|") : "";
  check("layer list row shows a speed badge", rowTexts.indexOf("×2.5") >= 0, rowTexts);
  check("layer row has drag handle + z-order buttons",
    rowTexts.indexOf("⋮⋮") >= 0 && rowTexts.indexOf("⤒") >= 0 && rowTexts.indexOf("⤓") >= 0, rowTexts);
  heroL.speed = 1;

  const orderBefore = ed.state.layers.map(l => l.id);
  ed.reorderLayer("layer_title", 0);
  const orderAfter = ed.state.layers.map(l => l.id);
  check("reorderLayer brings a layer to the front",
    orderAfter[0] === "layer_title" && orderBefore[0] === "layer_hero", "order=" + orderAfter.join(","));
  ed.reorderLayer("layer_title", 1);
  check("reorderLayer moves it back down", ed.state.layers[1].id === "layer_title");
  check("lane strip height scales with layer count", ed.keyStripHeight() === 16 + 2 * 16, "h=" + ed.keyStripHeight());
  let stripThrew = null;
  try { ed.drawKeyStrip(); } catch (e) { stripThrew = e; }
  check("multi-track lane strip draws without throwing", stripThrew === null, stripThrew ? stripThrew.message : "");
  /* the mock's requestAnimationFrame never fires, so exercise the resize
     path (key-strip height, DPR transforms) explicitly */
  let crThrew = null;
  try { ed.checkResize(); } catch (e) { crThrew = e; }
  check("checkResize (lane strip height path) does not throw", crThrew === null, crThrew ? crThrew.message : "");
  check("lane strip height after resize follows layer count", ed.keyStripHeight() === 16 + 2 * 16, "h=" + ed.keyStripHeight());
  const laneClick = { clientX: 100, clientY: 40, preventDefault() {} };
  let ksdThrew = null;
  try { ed.onKeyStripDown(laneClick); } catch (e) { ksdThrew = e; }
  check("clicking a lane selects that layer", ksdThrew === null && ed.selectedId === "layer_title",
    ksdThrew ? ksdThrew.message : "sel=" + ed.selectedId);
  ed.selectedId = null;

  /* cross-node crops import (Video Edit ⤴ Export crops -> stage layers) */
  const cropsBefore = ed.state.layers.length;
  const pupOrigFetch = apiMock.fetchApi;
  apiMock.fetchApi = async (path) => {
    if (path === "/chaotic_h3/crops") {
      return { status: 200, json: async () => ({ crops: [
        { file: "ve_crop_1.png", at: 1.5, note: "face" },
        { file: "ve_crop_2.png", at: 3.2, note: "" },
      ] }) };
    }
    return pupOrigFetch(path);
  };
  await ed.importCrops();
  check("importCrops adds image layers", ed.state.layers.length === cropsBefore + 2, "layers=" + ed.state.layers.length);
  const cropLayer = ed.state.layers[0]; // unshifted -> crops on top
  check("imported crop layer is an image with file + note name", !!cropLayer && cropLayer.type === "image" && cropLayer.file === "ve_crop_2.png" && cropLayer.name === "crop @3.2s", JSON.stringify(cropLayer));
  check("import selects the newest crop layer", ed.selectedId === cropLayer.id);
  await ed.importCrops(); // same bundle again -> dedupe, no new layers
  check("importCrops dedupes already-imported crops", ed.state.layers.length === cropsBefore + 2, "layers=" + ed.state.layers.length);
  apiMock.fetchApi = pupOrigFetch;
  await ed.importCrops(); // dumb mock has no crops -> graceful
  check("importCrops without a bundle warns gracefully", (ed.statusLine.textContent || "").indexOf("No exported crops") !== -1, ed.statusLine.textContent);

  /* fresh node path */
  (async () => {
    const NodeType2 = function () {
      this.size = [1100, 760];
      this.widgets = [
        { name: "scene_data", value: "" },
        { name: "fps", value: 24 },
        { name: "duration_sec", value: 6 },
        { name: "width", value: 1280 },
        { name: "height", value: 720 },
      ];
      this.addDOMWidget = (name, type, container, opts) => ({ name, computeSize: null, getValue: opts.getValue, setValue: opts.setValue });
      this.setDirtyCanvas = () => {};
      this.computeSize = () => [1100, 600];
    };
    await capturedExtension.beforeRegisterNodeDef(NodeType2, { name: "ChaoticH3MockupEditor" }, appMock);
    const fresh = new NodeType2();
    let t2 = null;
    try { fresh.onNodeCreated(); } catch (e) { t2 = e; }
    check("fresh node constructs with empty scene", !!fresh._puppetEditor && t2 === null, t2 ? t2.message : "");
    check("fresh node has zero layers", fresh._puppetEditor.state.layers.length === 0);
    check("fresh node defaults to 16:9 aspect", fresh._puppetEditor.stateAspectLabel() === "16:9");
    check("fresh node stage aspect from widgets", Math.abs(fresh._puppetEditor.stageAspect() - 16 / 9) < 1e-6);

    console.log(failures === 0 ? "\nPUPPET SMOKE: ALL PASS" : "\nPUPPET SMOKE: " + failures + " FAILURE(S)");
    process.exit(failures === 0 ? 0 : 1);
  })();
})();
