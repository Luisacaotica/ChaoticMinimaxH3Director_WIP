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
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
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

  /* cross-node crops import (Video Edit ⤴ Export crops -> library cards) */
  const cropsBefore = ed.state.refs.length;
  const wsOrigFetch = apiMock.fetchApi;
  apiMock.fetchApi = async (path) => {
    if (path === "/chaotic_h3/crops") {
      return { status: 200, json: async () => ({ crops: [
        { file: "ve_crop_1.png", at: 1.5, note: "face" },
        { file: "sub/ve_crop_2.png", at: 3.2, note: "" },
      ] }) };
    }
    return wsOrigFetch(path);
  };
  await ed.importCrops();
  check("importCrops adds library Picture refs", ed.state.refs.length === cropsBefore + 2, "refs=" + ed.state.refs.length);
  const cropRef = ed.state.refs[cropsBefore];
  check("imported crop is an untimed picture card", !!cropRef && cropRef.kind === "picture" && cropRef.tag_type === "picture" && cropRef.timed === false && cropRef.file === "ve_crop_1.png" && cropRef.name === "face", JSON.stringify(cropRef));
  check("imported crop thumb is subfolder-aware", (ed.state.refs[cropsBefore].thumb || "").indexOf("view?filename=ve_crop_1.png") !== -1 && (ed.state.refs[cropsBefore + 1].thumb || "").indexOf("subfolder=sub") !== -1, ed.state.refs[cropsBefore].thumb);
  await ed.importCrops(); // same bundle again -> dedupe, no new cards
  check("importCrops dedupes already-imported crops", ed.state.refs.length === cropsBefore + 2, "refs=" + ed.state.refs.length);
  apiMock.fetchApi = wsOrigFetch;
  await ed.importCrops(); // dumb mock has no crops -> graceful
  check("importCrops without a bundle warns gracefully", (ed.statusLine.textContent || "").indexOf("No exported crops") !== -1, ed.statusLine.textContent);

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

  /* library drag-to-timeline + tag suggestion */
  let placedAt = null;
  try { ed.placeRefOnTimeline("ref_lib", 2.5); placedAt = ed.refById("ref_lib"); } catch (e) { placedAt = "THREW: " + e.message; }
  check("placeRefOnTimeline places at the drop time", typeof placedAt === "object" && placedAt.timed === true && Math.abs(placedAt.start - 2.5) < 1e-6,
    "start=" + (placedAt && placedAt.start));
  let suggested = null;
  let expectedTag = null;
  try {
    ed.selectedType = "shot";
    ed.selectedId = "shot_a";
    expectedTag = ed.globalTags()["ref_lib"];
    ed.suggestToPrompt("ref_lib");
    suggested = ed.state.shots.find(s => s.id === "shot_a").text;
  } catch (e) { suggested = "THREW: " + e.message; }
  check("suggestToPrompt appends the ref's tag to the shot", typeof suggested === "string" && expectedTag && suggested.includes(expectedTag),
    "tag=" + expectedTag);
  let suggestNoShot = null;
  try {
    ed.selectedType = null;
    ed.selectedId = null;
    ed.suggestToPrompt("ref_lib");
    suggestNoShot = true;
  } catch (e) { suggestNoShot = "THREW: " + e.message; }
  check("suggestToPrompt warns without a selected shot", suggestNoShot === true, "" + suggestNoShot);

  /* timeline keyboard shortcuts: arrows nudge, S splits, R toggles the render window, +/- zooms */
  const keyEv = (key, shift) => ({ key, shiftKey: !!shift, target: {}, preventDefault() {} });
  ed.shotById("shot_a").start = 5; // park it mid-timeline so nudging can't clamp at 0
  const start0 = 5;
  try { ed.selectedType = "shot"; ed.selectedId = "shot_a"; ed.onKeyDown(keyEv("ArrowRight")); } catch (e) { check("ArrowRight nudge did not throw", false, e.message); }
  const start1 = ed.shotById("shot_a").start;
  check("ArrowRight nudges the selected shot by 1 frame", Math.abs((start1 - start0) - 1 / 24) < 1e-9, "delta=" + (start1 - start0));
  try { ed.onKeyDown(keyEv("ArrowLeft", true)); } catch (e) { check("Shift+ArrowLeft did not throw", false, e.message); }
  const start2 = ed.shotById("shot_a").start;
  check("Shift+ArrowLeft nudges back 10 frames", Math.abs((start2 - start1) + 10 / 24) < 1e-9, "delta=" + (start2 - start1));
  const shotsBefore = ed.state.shots.length;
  try { ed.setPlayhead(ed.shotById("shot_a").start + 1); ed.onKeyDown(keyEv("s")); } catch (e) { check("S split did not throw", false, e.message); }
  check("S splits the shot under the playhead", ed.state.shots.length === shotsBefore + 1, "shots=" + ed.state.shots.length);
  ed.clearRenderRange();
  try { ed.setPlayhead(3.5); ed.onKeyDown(keyEv("r")); } catch (e) { check("R IN did not throw", false, e.message); }
  check("R sets the render IN at the playhead", ed.renderIn === 3.5, "in=" + ed.renderIn);
  try { ed.setPlayhead(6); ed.onKeyDown(keyEv("R")); } catch (e) { check("R OUT did not throw", false, e.message); }
  check("second R sets the render OUT", ed.renderOut === 6, "out=" + ed.renderOut);
  try { ed.onKeyDown(keyEv("r")); } catch (e) { check("third R did not throw", false, e.message); }
  check("third R clears the render window", ed.renderIn === null && ed.renderOut === null, "in=" + ed.renderIn + " out=" + ed.renderOut);
  try { ed.onKeyDown(keyEv("r").ctrlKey ? keyEv("r") : Object.assign(keyEv("r"), { ctrlKey: true })); } catch (e) { check("ctrl+R did not throw", false, e.message); }
  check("ctrl+R is ignored (no hijack of browser reload)", ed.renderIn === null && ed.renderOut === null, "in=" + ed.renderIn + " out=" + ed.renderOut);
  const zoom0 = ed.zoom;
  try { ed.onKeyDown(keyEv("+")); } catch (e) { check("+ zoom did not throw", false, e.message); }
  check("+ zooms in by one step", Math.abs(ed.zoom - (zoom0 + 0.2)) < 1e-9, "zoom=" + ed.zoom);
  try { ed.onKeyDown(keyEv("-")); } catch (e) { check("- zoom did not throw", false, e.message); }
  check("- zooms back out", Math.abs(ed.zoom - zoom0) < 1e-9, "zoom=" + ed.zoom);
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
