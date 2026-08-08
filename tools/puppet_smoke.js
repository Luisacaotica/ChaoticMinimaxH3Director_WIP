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
  check("built stage canvas + ctx", !!ed.ctx);
  check("built key strip + layers panel + audio panel", !!(ed.keyCtx && ed.layersList && ed.audioWave));

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

  /* fresh node path */
  (async () => {
    const NodeType2 = function () {
      this.size = [1100, 760];
      this.widgets = [
        { name: "scene_data", value: "" },
        { name: "fps", value: 24 },
        { name: "duration_sec", value: 6 },
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

    console.log(failures === 0 ? "\nPUPPET SMOKE: ALL PASS" : "\nPUPPET SMOKE: " + failures + " FAILURE(S)");
    process.exit(failures === 0 ? 0 : 1);
  })();
})();
