#!/usr/bin/env node
/* widget_smoke.js — regression harness for the ChaoticH3Director timeline widget.
 *
 * Loads web/js/chaotic_director.js under a mocked ComfyUI frontend (window.comfyAPI,
 * document, canvas 2d context, requestAnimationFrame) and drives the real
 * registration path:
 *   app.registerExtension → beforeRegisterNodeDef → node.onNodeCreated →
 *   new ChaoticDirectorEditor(...)
 * against a SAVED timeline (3 shots, 1 picture ref) — the exact scenario that
 * crashed with "TypeError: this.loadShotThumbs is not a function".
 *
 * Run: node tools/widget_smoke.js   (plain node, no deps)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* ------------------------- minimal DOM mocks ------------------------- */
function makeCtx2d() {
  const noop = () => {};
  const target = {
    canvas: null,
    setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop,
    moveTo: noop, lineTo: noop, stroke: noop, fill: noop, fillText: noop,
    arcTo: noop, closePath: noop, strokeRect: noop, drawImage: noop,
    setLineDash: noop, roundRect: noop,
  };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      return noop; // any other ctx method (fillStyle etc. are setters via `set`)
    },
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
    clientWidth: 0,
    clientHeight: 0,
    width: 0,
    height: 0,
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
    replaceWith() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 300 }; },
  };
  return el;
}

const documentMock = {
  createElement: (tag) => makeElement(tag),
  getElementById: () => null,
  head: { appendChild() {} },
  body: { appendChild() {} },
};

/* ------------------------- api / app mocks ------------------------- */
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

/* ------------------------- sandbox ------------------------- */
const sandbox = {
  window: {
    /* real frontend exposes window.comfyAPI.app.app and window.comfyAPI.api.api
       (namespace objects wrapping the app/api instances) */
    comfyAPI: { app: { app: appMock }, api: { api: apiMock } },
    app: appMock,
    devicePixelRatio: 1,
  },
  document: documentMock,
  api: apiMock,
  app: appMock,
  Image: FakeImage,
  FormData: class { append() {} },
  AudioContext: class { decodeAudioData() {} },
  navigator: {},
  requestAnimationFrame() { return 0; }, // never fire → no rAF loop
  setTimeout(fn) { fn(); return 0; },   // fire immediately → editor built synchronously
  console,
};
sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
sandbox.window.setTimeout = sandbox.setTimeout;
sandbox.window.navigator = sandbox.navigator;

vm.createContext(sandbox);
const jsPath = path.join(__dirname, "..", "web", "js", "chaotic_director.js");
const src = fs.readFileSync(jsPath, "utf-8");
vm.runInContext(src, sandbox, { filename: "chaotic_director.js" });

if (!capturedExtension) {
  console.error("FAIL: extension was never registered (top-level threw?)");
  process.exit(1);
}

/* ------------------------- drive registration ------------------------- */
const savedTimeline = {
  version: 1,
  fps: 24,
  project: { format: "official", lora_trigger: "", style_clarification: "",
             official: { subject_definitions: "", summary: "", retention_analysis: "",
                         style_line: "", overall_soundscape: "", non_diegetic_music: "N/A" },
             narrative: { scene: "", subjects: "", lighting: "", music: "N/A" } },
  shots: [
    { id: "shot_a", start: 0.0, duration: 3.5, text: "[Shot 1] A tight two-shot frames S1 and S2 nose-to-nose.", format: "auto" },
    { id: "shot_b", start: 3.5, duration: 3.5, text: "[Shot 2] Wide static angle as S1 lunges.", format: "auto" },
    { id: "shot_c", start: 7.0, duration: 3.5, text: "[Shot 3] S2 falls to the ground.", format: "auto" },
  ],
  refs: [
    { id: "ref_pic", kind: "picture", file: "input/luisa_sheet.png", name: "Luisa sheet",
      start: 0, duration: 3, trim_start: 0, trim_end: null, strength: 0.9, role: "reference",
      annotation: "", tag_type: "picture", use_soundtrack: false, timed: true },
    { id: "ref_lib", kind: "picture", file: "input/mood.png", name: "Mood board",
      start: 0, duration: 3, trim_start: 0, trim_end: null, strength: 0.7, role: "reference",
      annotation: "", tag_type: "picture", use_soundtrack: false, timed: false },
  ],
  boundaries: [7.0],
  render_in: 2.0,
  render_out: 9.0,
};

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : "  FAIL ") + name + (extra ? "  (" + extra + ")" : ""));
  if (!cond) failures++;
}

(async () => {
  const nodeData = { name: "ChaoticH3Director" };
  function NodeType() {
    this.size = [1100, 720];
    this.widgets = [
      { name: "timeline_data", value: JSON.stringify(savedTimeline) },
      { name: "fps", value: 24 },
      { name: "chunk_mode", value: "fixed" },
      { name: "chunk_seconds", value: 5 },
      { name: "continuity", value: true },
      { name: "video_context", value: true },
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
  NodeType.prototype.onNodeCreated = function () {
    /* original (stub) onNodeCreated — real node has none defined */
    return undefined;
  };

  await capturedExtension.beforeRegisterNodeDef(NodeType, nodeData, appMock);

  const node = new NodeType();
  let threw = null;
  try {
    node.onNodeCreated();
  } catch (e) {
    threw = e;
  }
  check("onNodeCreated did not throw", threw === null, threw ? threw.message : "");

  const ed = node._chaoticEditor;
  check("editor was constructed", !!ed);
  if (!ed) { console.error("FAIL: widget editor missing — widget is blank. " + (threw ? threw.stack : "")); process.exit(1); }
  check("editor loaded 3 saved shots", ed.state.shots.length === 3, "shots=" + ed.state.shots.length);
  check("editor loaded 2 saved refs", ed.state.refs.length === 2, "refs=" + ed.state.refs.length);
  check("editor kept pinned boundary 7.0", ed.state.boundaries.length === 1 && Math.abs(ed.state.boundaries[0] - 7.0) < 1e-6);
  check("editor loaded render window 2.0 -> 9.0", ed.renderIn === 2.0 && ed.renderOut === 9.0,
        "in=" + ed.renderIn + " out=" + ed.renderOut);
  check("library ref parsed as untimed", ed.state.refs.some(r => r.id === "ref_lib" && r.timed === false));
  check("loadShotThumbs is a function", typeof ed.loadShotThumbs === "function");
  check("loadRefThumb is a function", typeof ed.loadRefThumb === "function");
  check("editor built the wrapper DOM", !!(ed.wrapper && ed.wrapper.children.length > 0));
  check("editor built preview strip", !!(ed.previewPanel && ed.previewVideo));
  check("editor built library panel", !!(ed.libraryPanel && ed.libraryGrid));
  check("canvas exists with 2d ctx", !!ed.ctx);
  const serialized = JSON.parse(ed.serialize());
  check("reserialize round-trips shots", serialized.shots.length === 3);
  check("reserialize round-trips refs", serialized.refs.length === 2);
  check("reserialize keeps boundary", serialized.boundaries.length === 1);
  check("reserialize keeps render window", serialized.render_in === 2.0 && serialized.render_out === 9.0);
  check("reserialize keeps timed flags", serialized.refs.find(r => r.id === "ref_lib").timed === false);

  /* new interactions: playhead scrub + library placement toggle */
  let scrubbed = null;
  try { ed.setPlayhead(3.5); scrubbed = ed.playhead; } catch (e) { scrubbed = "THREW: " + e.message; }
  check("setPlayhead works", scrubbed === 3.5, "playhead=" + scrubbed);
  let moved = null;
  try { ed.moveRefToLibrary("ref_pic"); moved = ed.refById("ref_pic").timed; } catch (e) { moved = "THREW: " + e.message; }
  check("moveRefToLibrary flips timed", moved === false, "timed=" + moved);
  let placed = null;
  try { ed.placeRefOnTimeline("ref_pic"); placed = ed.refById("ref_pic").timed; } catch (e) { placed = "THREW: " + e.message; }
  check("placeRefOnTimeline flips timed", placed === true, "timed=" + placed);
  try { ed.clearRenderRange(); } catch (e) { check("clearRenderRange did not throw", false, e.message); }
  check("clearRenderRange clears window", ed.renderIn === null && ed.renderOut === null);
  ed.renderIn = 2.0; ed.renderOut = 9.0; // restore for later round-trip checks

  /* fresh-node path (empty timeline_data) must also construct */
  (async () => {
    const NodeType2 = function () {
      this.size = [1100, 720];
      this.widgets = [
        { name: "timeline_data", value: "" },
        { name: "fps", value: 24 },
        { name: "chunk_mode", value: "fixed" },
        { name: "chunk_seconds", value: 5 },
        { name: "continuity", value: true },
        { name: "video_context", value: true },
      ];
      this.addDOMWidget = (name, type, container, opts) => ({ name, computeSize: null, getValue: opts.getValue, setValue: opts.setValue });
      this.setDirtyCanvas = () => {};
      this.computeSize = () => [1100, 600];
    };
    await capturedExtension.beforeRegisterNodeDef(NodeType2, { name: "ChaoticH3Director" }, appMock);
    const fresh = new NodeType2();
    let t2 = null;
    try { fresh.onNodeCreated(); } catch (e) { t2 = e; }
    check("fresh node (empty timeline) constructs", !!fresh._chaoticEditor && t2 === null, t2 ? t2.message : "");
    check("fresh node seeds a default shot", fresh._chaoticEditor && fresh._chaoticEditor.state.shots.length === 1);
    console.log(failures === 0 ? "\nWIDGET SMOKE: ALL PASS" : "\nWIDGET SMOKE: " + failures + " FAILURE(S)");
    process.exit(failures === 0 ? 0 : 1);
  })();
})();
