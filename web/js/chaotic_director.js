/* Chaotic MinimaxH3 Director — timeline editor widget.
 *
 * Mirrors the Python data contract in timeline.py exactly:
 *   - global tags: pictures+subjects share the image sequence (<Picture N>),
 *     videos get <Video N>, audios get <Audio N>, ordered by (start, index)
 *   - subjects carry a persistent shorthand S1..SK
 *   - the widget serializes into the hidden `timeline_data` STRING widget
 */
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */
const RULER_H = 22;
const TRACK_H = 50;
const PICTURE_TRACK_Y = RULER_H;
const VIDEO_TRACK_Y = PICTURE_TRACK_Y + TRACK_H;
const AUDIO_TRACK_Y = VIDEO_TRACK_Y + TRACK_H;
const SHOT_TRACK_Y = AUDIO_TRACK_Y + TRACK_H;
const TIMELINE_H = SHOT_TRACK_Y + TRACK_H;
const PREVIEW_H = 190;
const HANDLE_PX = 10;
const HANDLE_HIT = 7;
const MIN_DURATION = 0.5;
const MAX_REF_IMAGES = 9;

const VISUAL_MARKERS = ["fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"];
const AUDIO_MARKERS = ["fully_copy", "partially_copy", "reference", "weak_reference"];

const HIDDEN = ["timeline_data"];

const CSS = `
.chaotic-wrap{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:row;gap:0;width:100%;box-sizing:border-box;color:#dcdcdc;font-size:11px;min-height:400px}
.chaotic-left{display:flex;flex-direction:column;gap:6px;width:300px;min-width:260px;max-width:360px;flex-shrink:0;overflow-y:auto;overflow-x:hidden;padding-right:8px;border-right:1px solid #2a2a2a;scrollbar-width:thin;scrollbar-color:#3c3c3c transparent}
.chaotic-left::-webkit-scrollbar{width:5px}
.chaotic-left::-webkit-scrollbar-thumb{background:#3c3c3c;border-radius:3px}
.chaotic-right{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0;overflow:hidden}
.chaotic-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:2px 0}
.chaotic-btn{background:#232323;color:#ddd;border:1px solid #2e2e2e;border-radius:4px;padding:5px 9px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:5px;transition:background .15s,border-color .15s;font-family:inherit}
.chaotic-btn:hover{background:#333;border-color:#555}
.chaotic-btn.danger:hover{background:#4a1515;border-color:#cc4444;color:#ffb0b0}
.chaotic-btn.active{background:#1c2b22;border-color:#2f7a50;color:#7ee2a8}
.chaotic-canvas{border-radius:6px;border:1px solid #1c1c1c;background:#202020;width:100%;display:block;cursor:default;outline:none}
.chaotic-viewport{overflow-x:auto;overflow-y:hidden;border-radius:6px}
.chaotic-viewport::-webkit-scrollbar{height:9px}
.chaotic-viewport::-webkit-scrollbar-thumb{background:#3c3c3c;border-radius:5px}
.chaotic-panel{background:#1b1b1b;border:1px solid #2a2a2a;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px}
.chaotic-panel-title{font-size:10px;font-weight:700;color:#8a8a8a;text-transform:uppercase;letter-spacing:.07em;display:flex;justify-content:space-between;align-items:center}
.chaotic-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.chaotic-label{font-size:10px;color:#9a9a9a;white-space:nowrap}
.chaotic-input{background:#141414;color:#e8e8e8;border:1px solid #333;border-radius:4px;padding:3px 6px;font-size:11px;font-family:inherit}
.chaotic-input[type=number]{width:64px}
.chaotic-input[type=text]{flex:1;min-width:80px}
.chaotic-input:focus{outline:none;border-color:#5a8f7a}
.chaotic-textarea{width:100%;height:110px;background:#141414;color:#e8e8e8;border:1px solid #333;border-radius:4px;padding:6px;font-size:11.5px;line-height:1.45;box-sizing:border-box;resize:vertical;outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.chaotic-textarea:focus{border-color:#5a8f7a}
.chaotic-range{width:110px;accent-color:#4aa47f}
.chaotic-slider-val{color:#fff;font-weight:600;min-width:34px;text-align:center}
.chaotic-band{font-size:10px;color:#7ee2a8;font-family:ui-monospace,Menlo,monospace}
.chaotic-chips{display:flex;flex-wrap:wrap;gap:4px}
.chaotic-chip{padding:2px 7px;border-radius:10px;font-size:10px;cursor:pointer;border:1px solid #2e2e2e;font-family:ui-monospace,Menlo,monospace}
.chaotic-chip.ok{background:#14301f;color:#7ee2a8;border-color:#2f7a50}
.chaotic-chip.warn{background:#332a12;color:#ffd479;border-color:#7a642f}
.chaotic-chip.bad{background:#3a1515;color:#ff8f8f;border-color:#a03030}
.chaotic-hint{font-size:10px;color:#8a8a8a;line-height:1.5}
.chaotic-collapse{background:#1e1e1e;border:1px solid #2a2a2a;border-radius:6px;padding:6px 8px}
.chaotic-collapse-head{display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-size:11px;font-weight:600;color:#c8c8c8}
.chaotic-collapse-body{display:none;flex-direction:column;gap:6px;padding-top:8px}
.chaotic-collapse.open .chaotic-collapse-body{display:flex}
.chaotic-seg{display:flex;border:1px solid #333;border-radius:5px;overflow:hidden}
.chaotic-seg div{padding:4px 8px;cursor:pointer;font-size:10.5px;color:#9a9a9a}
.chaotic-seg div.on{background:#1f3a2c;color:#e8e8e8}
.chaotic-seg div:not(.on):hover{background:#2a2a2a}
.chaotic-tip{position:fixed;z-index:99999;background:#111;border:1px solid #3a3a3a;border-radius:6px;padding:4px;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.6);display:none}
.chaotic-tip img,.chaotic-tip canvas{display:block;max-width:180px;max-height:120px;border-radius:4px}
.chaotic-ghost{position:absolute;pointer-events:none;border:1px dashed #7aa}
/* highlight overlay for tag validation */
.chaotic-txtwrap{position:relative}
.chaotic-txtback{position:absolute;inset:0;overflow:hidden;white-space:pre-wrap;word-wrap:break-word;color:transparent;pointer-events:none;padding:6px;font-size:11.5px;line-height:1.45;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid transparent;box-sizing:border-box}
.chaotic-txtback mark{color:transparent;border-radius:3px;padding:0 1px}
.chaotic-txtback mark.tok-ok{background:rgba(74,164,127,.45)}
.chaotic-txtback mark.tok-warn{background:rgba(210,160,60,.45)}
.chaotic-txtback mark.tok-bad{background:rgba(220,70,70,.5)}
.chaotic-txtarea{position:relative;background:transparent;color:#e8e8e8}
.chaotic-statusline{font-size:10px;color:#9a9a9a;min-height:14px}
.chaotic-overlay{position:absolute;top:8px;right:8px;bottom:8px;left:8px;z-index:60;background:rgba(14,16,20,.97);border:1px solid #383838;border-radius:8px;padding:14px 16px;overflow:auto;display:none;box-shadow:0 6px 24px rgba(0,0,0,.5)}
.chaotic-overlay.open{display:block}
.chaotic-overlay h3{margin:0 0 10px;font-size:12px;letter-spacing:.4px;color:#ffcf5a;font-weight:600}
.chaotic-overlay .row{display:flex;justify-content:space-between;gap:18px;padding:3px 0;border-bottom:1px solid #222;font-size:11px;line-height:1.5}
.chaotic-overlay .row kbd{background:#262626;border:1px solid #3d3d3d;border-bottom-width:2px;border-radius:4px;padding:0 6px;font:11px ui-monospace,Menlo,monospace;color:#ffd97a;white-space:nowrap}
.chaotic-overlay .row .d{color:#9a9a9a;text-align:right}
.chaotic-overlay .x{position:absolute;top:8px;right:10px;cursor:pointer;color:#888;font-size:14px;line-height:1;padding:2px}
.chaotic-overlay .x:hover{color:#fff}
/* scrub preview strip */
.chaotic-preview-stage{position:relative;background:#000;border:1px solid #1c1c1c;border-radius:5px;height:180px;overflow:hidden;display:flex;align-items:center;justify-content:center;flex:none}
.chaotic-preview-stage video{max-width:100%;max-height:100%;display:none;background:#000}
.chaotic-preview-stage img{max-width:100%;max-height:100%;display:none;object-fit:contain;background:#000}
.chaotic-preview-stage canvas.chaotic-preview-wave{width:100%;height:118px;display:none;background:#000;border-radius:4px}
.chaotic-preview-hint{color:#666;font-size:10px;text-align:center;padding:8px;line-height:1.5}
.chaotic-preview-controls{display:flex;gap:6px;align-items:center;flex:none}
.chaotic-preview-seek{flex:1;accent-color:#ff5a5a;height:4px}
.chaotic-preview-time{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#c8c8c8;min-width:150px;white-space:nowrap}
.chaotic-play-btn{background:#2a2a2a;border:1px solid #444;color:#eee;border-radius:4px;width:24px;height:22px;cursor:pointer;font-size:10px;display:flex;align-items:center;justify-content:center;flex:none}
.chaotic-play-btn:hover{background:#3a3a3a;border-color:#666}
.chaotic-play-btn.playing{color:#4fff8f;border-color:#4fff8f}
/* reference library */
.chaotic-lib-drop{border:1.5px dashed #444;border-radius:6px;padding:9px;text-align:center;color:#777;font-size:10px;cursor:pointer;transition:all .15s;flex:none}
.chaotic-lib-drop:hover{border-color:#666;color:#aaa}
.chaotic-lib-drop.drag-over{border-color:#4aa47f;background:rgba(74,164,127,.08);color:#7ee2a8}
.chaotic-lib-grid{display:flex;flex-direction:column;gap:5px}
.chaotic-lib-card{display:grid;grid-template-columns:52px minmax(0,1fr) 52px auto auto auto;gap:6px;align-items:center;background:#141414;border:1px solid #2a2a2a;border-radius:6px;padding:5px 7px}
.chaotic-lib-thumb{width:52px;height:34px;object-fit:cover;border-radius:3px;background:#000;flex:none}
.chaotic-lib-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.chaotic-lib-name{font-size:10.5px;color:#e8e8e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chaotic-lib-tag{font-size:9.5px;color:#7ee2a8;font-family:ui-monospace,Menlo,monospace}
.chaotic-lib-strength{width:52px;accent-color:#4aa47f;height:4px;justify-self:end}
.chaotic-lib-empty{font-size:10px;color:#666;padding:4px 2px}
.chaotic-lib-hint{font-size:10px;color:#8a8a8a;line-height:1.5;padding:2px 0}
.chaotic-range-flag{position:absolute;top:0;font-size:8px;font-weight:700;font-family:ui-monospace,Menlo,monospace;padding:0 2px;pointer-events:none}
/* inspector grid: pack the small rows two-up so the panel stays short */
.chaotic-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;align-items:center}
.chaotic-grid .chaotic-row{flex-wrap:nowrap}
.chaotic-grid .chaotic-row .chaotic-input[type=number]{width:54px}
.chaotic-grid-full{grid-column:1/-1}
.chaotic-minirow{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
/* timeline settings toolbar (snap / unit / overlap-lock) */
.chaotic-ttoolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:3px 0;border-top:1px solid #242424;border-bottom:1px solid #242424;margin-top:2px}
.chaotic-ttoolbar .chaotic-seg div{padding:3px 8px;font-size:10px}
.chaotic-ttoolbar .chaotic-btn{padding:3px 8px;font-size:10px}
.chaotic-ttoolbar .chaotic-btn.active{background:#1c2b22;border-color:#2f7a50;color:#7ee2a8}
.chaotic-ttoolbar .chaotic-btn.warn-active{background:#3a2f12;border-color:#7a642f;color:#ffd479}
.chaotic-tlabel{font-size:9.5px;color:#8a8a8a;white-space:nowrap}
/* right-click context menu */
.chaotic-ctx{position:fixed;z-index:99998;background:#1b1b1b;border:1px solid #3a3a3a;border-radius:6px;padding:4px;min-width:168px;box-shadow:0 8px 24px rgba(0,0,0,.7);display:none}
.chaotic-ctx-item{display:flex;align-items:center;gap:6px;padding:5px 9px;font-size:10.5px;color:#ddd;cursor:pointer;border-radius:4px;white-space:nowrap}
.chaotic-ctx-item:hover{background:#2a2a2a;color:#fff}
.chaotic-ctx-item.danger{color:#ff9d9d}
.chaotic-ctx-item.danger:hover{background:#3a1515;color:#ffb0b0}
.chaotic-ctx-sep{height:1px;background:#2c2c2c;margin:3px 4px}
.chaotic-ctx-sub{color:#8a8a8a;font-size:9.5px;padding:4px 9px 2px;letter-spacing:.05em}
/* inline tag autosuggest menu (typing < in a shot prompt) */
.chaotic-tagmenu{position:fixed;z-index:99997;background:#161616;border:1px solid #3a3a3a;border-radius:6px;padding:3px;min-width:150px;box-shadow:0 8px 24px rgba(0,0,0,.7);display:none;max-height:180px;overflow:auto}
.chaotic-tagmenu div{padding:4px 9px;font-size:10.5px;color:#cdeadd;cursor:pointer;border-radius:4px;font-family:ui-monospace,Menlo,monospace}
.chaotic-tagmenu div:hover{background:#24443a;color:#7ee2a8}
.chaotic-tagmenu .chaotic-tagmenu-hint{color:#666;font-size:9px;font-family:inherit;cursor:default}
.chaotic-tagmenu .chaotic-tagmenu-hint:hover{background:none;color:#666}
.chaotic-edit-badge{display:inline-block;background:#7a3a1a;color:#ffb454;font-size:8px;font-weight:700;padding:0 3px;border-radius:3px;margin-left:4px;vertical-align:middle}
`;

if (!document.getElementById("chaotic-director-styles")) {
  const el = document.createElement("style");
  el.id = "chaotic-director-styles";
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ------------------------------------------------------------------ */
/* Pure helpers (mirror timeline.py)                                  */
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
function fmtSec(sec) { return sec.toFixed(2); }

function orderedByStart(refs) {
  return refs.slice().sort((a, b) => (a.start - b.start) || (a._index - b._index));
}
function assignGlobalTags(refs) {
  const tags = {};
  const imgs = orderedByStart(refs.filter(r => r.kind === "picture" || r.kind === "subject"));
  const vids = orderedByStart(refs.filter(r => r.kind === "video"));
  const auds = orderedByStart(refs.filter(r => r.kind === "audio"));
  imgs.forEach((r, i) => { tags[r.id] = `<Picture ${i + 1}>`; });
  vids.forEach((r, i) => { tags[r.id] = `<Video ${i + 1}>`; });
  auds.forEach((r, i) => { tags[r.id] = `<Audio ${i + 1}>`; });
  return tags;
}
function subjectShorthands(refs) {
  const subs = orderedByStart(refs.filter(r => r.kind === "subject"));
  const map = {};
  subs.forEach((r, i) => { map[r.id] = `S${i + 1}`; });
  return map;
}
function strengthToMarker(kind, strength) {
  if (kind === "audio") {
    if (strength >= 0.85) return "fully_copy";
    if (strength >= 0.6) return "partially_copy";
    if (strength >= 0.35) return "reference";
    return "weak_reference";
  }
  if (strength >= 0.85) return "fully_preserved";
  if (strength >= 0.6) return "partially_preserved";
  if (strength >= 0.35) return "attribute_transfer";
  return "weak_reference";
}
function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ------------------------------------------------------------------ */
/* Editor                                                             */
/* ------------------------------------------------------------------ */
class ChaoticDirectorEditor {
  constructor(node, container, domWidget) {
    this.node = node;
    this.container = container;
    this.domWidget = domWidget;

    this.state = { project: this.defaultProject(), shots: [], refs: [], boundaries: [], snap: { on: false, unit: "frame" }, overlap_lock: false };
    this.fps = 24;
    this.zoom = 1;
    this.selectedType = null;   // "shot" | "ref"
    this.selectedId = null;
    this._drag = null;
    this._ghost = null;
    this._hoverChip = null;
    this._lastWidth = 0;
    this._lastScale = 0;
    this.playhead = null;      // seconds; null = no scrub playhead
    this.renderIn = null;      // render window IN (seconds), null = start
    this.renderOut = null;     // render window OUT (seconds), null = end
    this._previewRefId = null; // ref currently loaded into the preview video
    this._librarySig = null;   // cache key for the library grid
    this._lastClient = null;   // last pointer position in client coords (drag-to-library)
    this._ctxMenu = null;      // open right-click menu
    this._ctxClose = null;

    this.timelineDataWidget = node.widgets.find(w => w.name === "timeline_data");
    this.chunkModeWidget = node.widgets.find(w => w.name === "chunk_mode");
    this.chunkSecondsWidget = node.widgets.find(w => w.name === "chunk_seconds");
    this.continuityWidget = node.widgets.find(w => w.name === "continuity");
    this.videoContextWidget = node.widgets.find(w => w.name === "video_context");
    this.renderInWidget = node.widgets.find(w => w.name === "render_in");
    this.renderOutWidget = node.widgets.find(w => w.name === "render_out");
    this.wireRenderWidgets();

    this.loadState();
    this.buildDOM();
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }

  defaultProject() {
    return {
      format: "official",
      lora_trigger: "",
      style_clarification: "",
      official: {
        subject_definitions: "", summary: "", retention_analysis: "",
        style_line: "", overall_soundscape: "", non_diegetic_music: "N/A",
      },
      narrative: { scene: "", subjects: "", lighting: "", music: "N/A" },
    };
  }

  loadState() {
    let raw = this.timelineDataWidget ? this.timelineDataWidget.value : "";
    let data = {};
    try { if (raw) data = JSON.parse(raw); } catch (e) { /* keep defaults */ }
    this._applyState(data);
    this.syncRenderWidgets();
  }

  _applyState(raw) {
    this.fps = parseInt((raw.fps || this.fpsWidgetValue() || 24), 10) || 24;
    this.state = {
      project: Object.assign(this.defaultProject(), raw.project || {}),
      shots: Array.isArray(raw.shots) ? raw.shots.map((s, i) => this.normalizeShot(s, i)) : [],
      refs: Array.isArray(raw.refs) ? raw.refs.map((r, i) => this.normalizeRef(r, i)) : [],
      boundaries: Array.isArray(raw.boundaries) ? raw.boundaries.map(Number).filter(b => b > 0) : [],
      snap: raw.snap && typeof raw.snap === "object"
        ? { on: !!raw.snap.on, unit: raw.snap.unit === "second" ? "second" : "frame" }
        : { on: false, unit: "frame" },
      overlap_lock: raw.overlap_lock === true,
    };
    this.renderIn = raw.render_in == null ? null : Number(raw.render_in);
    this.renderOut = raw.render_out == null ? null : Number(raw.render_out);
    if (this.renderIn != null && this.renderOut != null && this.renderOut <= this.renderIn) {
      this.renderIn = null;
      this.renderOut = null;
    }
    if (this.state.shots.length === 0) {
      this.state.shots = [this.normalizeShot({ id: uid("shot"), start: 0, duration: 5, text: "[Shot 1] Live-action, cinematic. The camera slowly pushes in." }, 0)];
    }
    this.state.shots.forEach(s => this.loadShotThumbs(s));
    this.state.refs.forEach(r => this.loadRefThumb(r));
  }

  /* the node's render_in / render_out inputs ARE the render window: the R key
     writes into them, and typing in them moves the timeline window. */
  wireRenderWidgets() {
    const renderWidgetCb = which => v => {
      const num = Number.isFinite(Number(v)) ? Number(v) : -1;
      if (which === "in") this.renderIn = num >= 0 ? num : null;
      else this.renderOut = num >= 0 ? num : null;
      /* same rule as the R key: an inverted pair is cleared, not kept */
      if (this.renderIn != null && this.renderOut != null && this.renderOut <= this.renderIn) {
        this.renderIn = null;
        this.renderOut = null;
      }
      this.commitChanges();
    };
    if (this.renderInWidget) this.renderInWidget.callback = renderWidgetCb("in");
    if (this.renderOutWidget) this.renderOutWidget.callback = renderWidgetCb("out");
  }

  syncRenderWidgets() {
    if (this.renderInWidget && this.renderInWidget.value !== (this.renderIn == null ? -1 : this.renderIn)) {
      this.renderInWidget.value = this.renderIn == null ? -1 : this.renderIn;
    }
    if (this.renderOutWidget && this.renderOutWidget.value !== (this.renderOut == null ? -1 : this.renderOut)) {
      this.renderOutWidget.value = this.renderOut == null ? -1 : this.renderOut;
    }
  }

  fpsWidgetValue() {
    const w = this.node.widgets.find(x => x.name === "fps");
    return w ? w.value : 24;
  }

  normalizeShot(s, i) {
    return {
      id: s.id || uid("shot"),
      start: Number(s.start) || 0,
      duration: Math.max(MIN_DURATION, Number(s.duration) || 1),
      text: typeof s.text === "string" ? s.text : "",
      format: ["auto", "official", "narrative"].includes(s.format) ? s.format : "auto",
      _index: i,
      thumb: s.thumb || null,
    };
  }

  normalizeRef(r, i) {
    return {
      id: r.id || uid("ref"),
      kind: ["video", "audio", "picture", "subject"].includes(r.kind) ? r.kind : "picture",
      file: r.file || "",
      name: r.name || "",
      start: Number(r.start) || 0,
      duration: Math.max(MIN_DURATION, Number(r.duration) || 1),
      trim_start: Number(r.trim_start) || 0,
      trim_end: r.trim_end == null ? null : Number(r.trim_end),
      strength: (() => { const s = Number(r.strength); return clamp(Number.isFinite(s) ? s : 1, 0, 1); })(),
      role: r.role === "source" ? "source" : "reference",
      annotation: r.annotation || "",
      tag_type: r.tag_type === "subject" ? "subject" : "picture",
      use_soundtrack: !!r.use_soundtrack,
      timed: r.timed !== false,
      _index: i,
      thumb: r.thumb || null,
      peaks: r.peaks || null,
    };
  }

  get duration() {
    let end = 0;
    this.state.shots.forEach(s => { end = Math.max(end, s.start + s.duration); });
    this.state.refs.forEach(r => { if (r.timed) end = Math.max(end, r.start + r.duration); });
    return Math.max(5, Math.ceil(end));
  }

  loadShotThumbs(shot) {
    /* Shots are text blocks — no thumbnail to reload. */
  }

  loadRefThumb(ref) {
    /* Rebuild a thumbnail for a saved picture/subject ref from its input path. */
    if (!ref || !ref.file || ref.kind === "audio" || ref.kind === "video") return;
    try {
      const url = this.viewUrl(ref.file);
      const img = new Image();
      img.onload = () => { ref.thumb = url; this.renderTimeline(); };
      img.src = url;
    } catch (e) { /* keep null thumb */ }
  }

  /* ---------------- serialization ---------------- */
  serialize() {
    return JSON.stringify({
      version: 1,
      fps: this.fps,
      project: this.state.project,
      shots: this.state.shots.map(s => ({
        id: s.id, start: s.start, duration: s.duration, text: s.text, format: s.format,
      })),
      refs: this.state.refs.map(r => ({
        id: r.id, kind: r.kind, file: r.file, name: r.name, start: r.start,
        duration: r.duration, trim_start: r.trim_start, trim_end: r.trim_end,
        strength: r.strength, role: r.role, annotation: r.annotation,
        tag_type: r.tag_type, use_soundtrack: r.use_soundtrack, timed: r.timed,
      })),
      boundaries: this.state.boundaries,
      snap: this.state.snap,
      overlap_lock: this.state.overlap_lock,
      render_in: this.renderIn,
      render_out: this.renderOut,
    }, null, 1);
  }

  commitChanges() {
    if (this.timelineDataWidget) {
      this.timelineDataWidget.value = this.serialize();
    }
    if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    this.renderTimeline();
    this.maybeRefreshLibrary();
  }

  /* ---------------- helpers ---------------- */
  globalTags() { return assignGlobalTags(this.state.refs); }
  shorthands() { return subjectShorthands(this.state.refs); }

  refById(id) { return this.state.refs.find(r => r.id === id); }
  shotById(id) { return this.state.shots.find(s => s.id === id); }

  predictedBoundaries() {
    /* Approximate where the Python chunk planner will cut: pack shots into
       chunk budgets of chunk_seconds (fixed mode only). */
    const mode = this.chunkModeWidget ? this.chunkModeWidget.value : "fixed";
    if (mode !== "fixed") return [];
    const budget = Math.max(0.5, Number(this.chunkSecondsWidget ? this.chunkSecondsWidget.value : 5));
    const cuts = [];
    const shots = this.state.shots.slice().sort((a, b) => a.start - b.start);
    let acc = 0;
    for (const s of shots) {
      const nxt = acc + s.duration;
      if (acc > 0 && nxt > budget + 1e-6) {
        cuts.push(s.start);
        acc = 0;
      }
      acc += s.duration;
    }
    return cuts;
  }

  trackForY(y) {
    if (y >= PICTURE_TRACK_Y && y < VIDEO_TRACK_Y) return "picture";
    if (y >= VIDEO_TRACK_Y && y < AUDIO_TRACK_Y) return "video";
    if (y >= AUDIO_TRACK_Y && y < SHOT_TRACK_Y) return "audio";
    if (y >= SHOT_TRACK_Y) return "shot";
    return null;
  }

  secondsAt(x) {
    const w = this.canvas ? Math.max(1, this.canvas.clientWidth) : 1;
    return (x / w) * this.duration * this.zoom;
  }
  xAt(sec) {
    const w = this.canvas ? Math.max(1, this.canvas.clientWidth) : 1;
    return (sec / (this.duration * this.zoom)) * w;
  }

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
    const vw = this.viewport ? this.viewport.clientWidth : 0;
    const scale = this.getRenderScale();
    if (vw > 0 && (vw !== this._lastWidth || scale !== this._lastScale)) {
      this._lastWidth = vw;
      this._lastScale = scale;
      const w = Math.round(vw * scale);
      const h = Math.round(TIMELINE_H * scale);
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
      this.renderTimeline();
    }
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }

  /* ---------------- DOM ---------------- */
  buildDOM() {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "chaotic-wrap";

    /* left sidebar — controls, project, library, inspector */
    const leftPanel = document.createElement("div");
    leftPanel.className = "chaotic-left";

    /* right main area — preview + timeline */
    const rightPanel = document.createElement("div");
    rightPanel.className = "chaotic-right";

    /* toolbar */
    const toolbar = document.createElement("div");
    toolbar.className = "chaotic-toolbar";

    const btnAddShot = this.btn("+ Shot", () => this.addShot());
    const btnImportImg = this.btn("⬆ Picture", () => this.pickFiles("picture"));
    const btnImportVid = this.btn("⬆ Video", () => this.pickFiles("video"));
    const btnImportAud = this.btn("⬆ Audio", () => this.pickFiles("audio"));
    const btnImportCrops = this.btn("📥 Crops", () => this.importCrops());
    btnImportCrops.title = "import the crops exported from Chaotic H3 Video Edit (⤴ Export crops) — each becomes a <Picture N> library card you can drag into any prompt or onto the timeline.";
    const btnProject = this.btn("Project", () => this.toggleProjectPanel());
    const btnLibrary = this.btn("Library", () => this.toggleLibraryPanel());
    const btnIn = this.btn("⏮ IN", () => this.setRenderIn());
    const btnOut = this.btn("OUT ⏭", () => this.setRenderOut());
    const btnClearRange = this.btn("✕ Range", () => this.clearRenderRange());
    const btnSave = this.btn("Save", () => this.saveProject());
    const btnLoad = this.btn("Load", () => this.loadProject());
    const btnCopy = this.btn("Copy JSON", () => this.copyJSON());
    const btnChunks = this.btn("Auto-chunk?", () => this.toggleChunkHint());
    toolbar.append(btnAddShot, btnImportImg, btnImportVid, btnImportAud, btnProject, btnLibrary,
                   btnIn, btnOut, btnClearRange, btnSave, btnLoad, btnCopy, btnChunks);
    leftPanel.appendChild(toolbar);

    /* project panel */
    this.projectPanel = document.createElement("div");
    this.projectPanel.className = "chaotic-collapse";
    this.projectPanel.innerHTML = `
      <div class="chaotic-collapse-head"><span>Project prompt scaffolding</span><span style="color:#666">▾</span></div>
      <div class="chaotic-collapse-body"></div>`;
    this.projectPanel.querySelector(".chaotic-collapse-head").addEventListener("click", () => {
      this.projectPanel.classList.toggle("open");
    });
    this.buildProjectPanel();
    this.wrapper.appendChild(this.projectPanel);

    /* reference library (untimed refs — never part of the timeline) */
    this.libraryPanel = document.createElement("div");
    this.libraryPanel.className = "chaotic-collapse";
    this.libraryPanel.innerHTML = `
      <div class="chaotic-collapse-head"><span>Reference library</span><span style="color:#666">▾</span></div>
      <div class="chaotic-collapse-body"></div>`;
    this.libraryPanel.querySelector(".chaotic-collapse-head").addEventListener("click", () => {
      this.libraryPanel.classList.toggle("open");
      this.recomputeSize();
    });
    this.buildLibraryPanel();
    leftPanel.appendChild(this.libraryPanel);

    /* scrub preview strip */
    this.buildPreviewStrip();
    rightPanel.appendChild(this.previewPanel);

    /* timeline settings toolbar (snap / frame-second / overlap lock) */
    this.ttoolbar = document.createElement("div");
    this.ttoolbar.className = "chaotic-ttoolbar";
    const tSnap = document.createElement("button");
    tSnap.className = "chaotic-btn";
    tSnap.textContent = "🧲 Snap";
    tSnap.title = "snap shot/ref moves and trims to whole frames or whole seconds";
    tSnap.addEventListener("click", () => {
      this.state.snap.on = !this.state.snap.on;
      tSnap.classList.toggle("warn-active", this.state.snap.on);
      this.commitChanges();
      this.updateStatus(this.state.snap.on ? `Snap ON — ${this.state.snap.unit === "frame" ? "frames" : "seconds"} (${this.state.snap.unit === "frame" ? "1/" + (this.fps || 24) + "s" : "1s"} grid).` : "Snap off — free placement.");
    });
    const tUnit = document.createElement("div");
    tUnit.className = "chaotic-seg";
    tUnit.title = "snap grid unit";
    ["frame", "second"].forEach(u => {
      const d = document.createElement("div");
      d.textContent = u === "frame" ? "Frame" : "Sec";
      d.className = this.state.snap.unit === u ? "on" : "";
      d.addEventListener("click", () => {
        this.state.snap.unit = u;
        this.ttoolbar.querySelectorAll(".chaotic-seg div").forEach(x => x.classList.remove("on"));
        d.classList.add("on");
        this.commitChanges();
        this.updateStatus(`Snap unit: ${u === "frame" ? "1 frame @ " + (this.fps || 24) + "fps" : "1 second"}.`);
      });
      tUnit.appendChild(d);
    });
    const tOverlap = document.createElement("button");
    tOverlap.className = "chaotic-btn";
    tOverlap.textContent = "⛔ Overlap";
    tOverlap.title = "lock overlap — shots cannot slide over each other on the prompt track";
    tOverlap.addEventListener("click", () => {
      this.state.overlap_lock = !this.state.overlap_lock;
      tOverlap.classList.toggle("warn-active", this.state.overlap_lock);
      this.commitChanges();
      this.updateStatus(this.state.overlap_lock ? "Overlap lock ON — shots are blocked from overlapping each other." : "Overlap lock off — shots may overlap freely.");
    });
    this.snapBtn = tSnap;
    this.overlapBtn = tOverlap;
    this.ttoolbar.appendChild(tSnap);
    this.ttoolbar.appendChild(tUnit);
    this.ttoolbar.appendChild(tOverlap);
    const tZoom = document.createElement("span");
    tZoom.className = "chaotic-tlabel";
    tZoom.textContent = "Ctrl+wheel or +/- to zoom · ? = shortcuts";
    this.zoomLabel = tZoom;
    this.ttoolbar.appendChild(tZoom);
    const tHelp = document.createElement("button");
    tHelp.className = "chaotic-btn";
    tHelp.textContent = "? Help";
    tHelp.title = "show the timeline keyboard shortcuts (? toggles)";
    tHelp.addEventListener("click", () => this.toggleShortcuts());
    this.ttoolbar.appendChild(tHelp);
    rightPanel.appendChild(this.ttoolbar);

    /* timeline viewport — fill remaining height */
    this.viewport = document.createElement("div");
    this.viewport.className = "chaotic-viewport";
    this.viewport.style.flex = "1";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "chaotic-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.canvas.style.height = TIMELINE_H + "px";
    this.viewport.appendChild(this.canvas);
    rightPanel.appendChild(this.viewport);

    /* inspector (collapsible, in the left sidebar) */
    this.inspector = document.createElement("div");
    this.inspector.className = "chaotic-collapse";
    this.inspector.innerHTML = `
      <div class="chaotic-collapse-head"><span>Inspector / parameters</span><span style="color:#666">▾</span></div>
      <div class="chaotic-collapse-body"></div>`;
    this.inspector.querySelector(".chaotic-collapse-head").addEventListener("click", () => {
      this.inspector.classList.toggle("open");
      this.recomputeSize();
    });
    this.inspBody = this.inspector.querySelector(".chaotic-collapse-body");
    leftPanel.appendChild(this.inspector);

    /* status line */
    this.statusLine = document.createElement("div");
    this.statusLine.className = "chaotic-statusline";
    leftPanel.appendChild(this.statusLine);
    this.wrapper.style.position = "relative";
    this.helpOverlay = this.buildShortcutsOverlay();
    this.wrapper.appendChild(this.helpOverlay);

    this.wrapper.appendChild(leftPanel);
    this.wrapper.appendChild(rightPanel);
    this.container.appendChild(this.wrapper);

    /* tooltip */
    this.tip = document.createElement("div");
    this.tip.className = "chaotic-tip";
    document.body.appendChild(this.tip);

    /* interactions */
    this.canvas.addEventListener("mousedown", e => this.onMouseDown(e));
    this.canvas.addEventListener("mousemove", e => this.onMouseMove(e));
    this.canvas.addEventListener("mouseup", e => this.onMouseUp(e));
    this.canvas.addEventListener("dblclick", e => this.onDblClick(e));
    this.canvas.addEventListener("contextmenu", e => this.onContextMenu(e));
    this.canvas.addEventListener("keydown", e => this.onKeyDown(e));
    this.canvas.tabIndex = 0;
    if (typeof document.addEventListener === "function") {
      /* only act when THIS editor is focused — keeps per-node keydown from
         firing while another Chaotic node (or a ComfyUI widget) has focus */
      document.addEventListener("keydown", e => {
        if (this.wrapper && this.wrapper.contains(e.target)) this.onKeyDown(e);
      });
      /* the canvas can't see a mouseup released over the library panel —
         listen at document level for the drag-to-library check */
      document.addEventListener("mouseup", e => this.onMouseUp(e));
    }
    this.canvas.addEventListener("wheel", e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoom = clamp(this.zoom + (e.deltaY > 0 ? -0.2 : 0.2), 1, 6);
        this.renderTimeline();
      }
    }, { passive: false });

    this.wrapper.addEventListener("dragover", e => this.onDragOver(e));
    this.wrapper.addEventListener("dragleave", () => { this._ghost = null; this.renderTimeline(); });
    this.wrapper.addEventListener("drop", e => this.onDrop(e));

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.multiple = true;
    this.fileInput.style.display = "none";
    this.wrapper.appendChild(this.fileInput);

    this.updateStatus("Ready. Add shots to the prompt track, drop references on their tracks, then run.");
    this.renderTimeline();
  }

  btn(label, fn) {
    const b = document.createElement("button");
    b.className = "chaotic-btn";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  buildProjectPanel() {
    const body = this.projectPanel.querySelector(".chaotic-collapse-body");
    body.innerHTML = "";
    const p = this.state.project;

    const fmtRow = document.createElement("div");
    fmtRow.className = "chaotic-row";
    fmtRow.innerHTML = '<span class="chaotic-label">Format</span>';
    const seg = document.createElement("div");
    seg.className = "chaotic-seg";
    ["official", "narrative"].forEach(f => {
      const d = document.createElement("div");
      d.textContent = f;
      d.className = p.format === f ? "on" : "";
      d.addEventListener("click", () => { p.format = f; this.commitChanges(); this.buildProjectPanel(); });
      seg.appendChild(d);
    });
    fmtRow.appendChild(seg);
    body.appendChild(fmtRow);

    const triggerRow = document.createElement("div");
    triggerRow.className = "chaotic-row";
    triggerRow.innerHTML = '<span class="chaotic-label">LoRA trigger</span>';
    const trigger = document.createElement("input");
    trigger.className = "chaotic-input";
    trigger.type = "text";
    trigger.value = p.lora_trigger;
    trigger.placeholder = "e.g. GalaxyAce style";
    trigger.addEventListener("input", () => { p.lora_trigger = trigger.value; this.commitChanges(); });
    triggerRow.appendChild(trigger);
    body.appendChild(triggerRow);

    const clarifyRow = document.createElement("div");
    clarifyRow.className = "chaotic-row";
    clarifyRow.innerHTML = '<span class="chaotic-label">Style note</span>';
    const clarify = document.createElement("input");
    clarify.className = "chaotic-input";
    clarify.type = "text";
    clarify.value = p.style_clarification;
    clarify.placeholder = "e.g. The LoRA only affects style, not wardrobe/setting.";
    clarify.addEventListener("input", () => { p.style_clarification = clarify.value; this.commitChanges(); });
    clarifyRow.appendChild(clarify);
    body.appendChild(clarifyRow);

    const fields = p.format === "official"
      ? [
          ["subject_definitions", "subject_definitions", 5],
          ["summary", "summary (e.g. [reference generation] ...)", 3],
          ["retention_analysis", "retention_analysis (optional — auto-generated from ref strengths)", 4],
          ["style_line", "style line (first line of detailed_description)", 2],
          ["overall_soundscape", "overall_soundscape", 3],
          ["non_diegetic_music", "non_diegetic_music", 2],
        ]
      : [
          ["scene", "Scene", 2],
          ["subjects", "Subjects", 2],
          ["lighting", "Lighting", 2],
          ["music", "Music", 1],
        ];
    fields.forEach(([key, label, rows]) => {
      const row = document.createElement("div");
      row.className = "chaotic-row";
      row.style.alignItems = "stretch";
      const lab = document.createElement("span");
      lab.className = "chaotic-label";
      lab.style.width = "150px";
      lab.textContent = label;
      const ta = document.createElement("textarea");
      ta.className = "chaotic-input";
      ta.style.flex = "1";
      ta.rows = rows;
      ta.style.resize = "vertical";
      const src = p.format === "official" ? p.official : p.narrative;
      ta.value = src[key] || "";
      ta.addEventListener("input", () => { src[key] = ta.value; this.commitChanges(); });
      row.appendChild(lab);
      row.appendChild(ta);
      body.appendChild(row);
    });
  }

  buildInspector() {
    const ins = this.inspBody;
    ins.innerHTML = "";
    this.inspector.classList.remove("open");
    if (!this.selectedType || !this.selectedId) {
      this.recomputeSize();
      return;
    }
    if (this.selectedType === "shot") this.buildShotInspector(ins);
    else this.buildRefInspector(ins);
    this.inspector.classList.add("open");
    this.recomputeSize();
  }

  buildShotInspector(ins) {
    const shot = this.shotById(this.selectedId);
    if (!shot) return;
    const tags = this.globalTags();
    const shorthands = this.shorthands();

    const head = document.createElement("div");
    head.className = "chaotic-panel-title";
    head.innerHTML = `<span>Prompt block — ${fmtSec(shot.start)}s → ${fmtSec(shot.start + shot.duration)}s</span>`;
    const del = document.createElement("button");
    del.className = "chaotic-btn danger";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      this.state.shots = this.state.shots.filter(s => s.id !== shot.id);
      this.selectedId = null;
      this.selectedType = null;
      this.commitChanges();
      this.buildInspector();
    });
    head.appendChild(del);
    ins.appendChild(head);

    const range = document.createElement("div");
    range.className = "chaotic-row";
    range.innerHTML = '<span class="chaotic-label">Start (s)</span>';
    const startIn = document.createElement("input");
    startIn.className = "chaotic-input";
    startIn.type = "number";
    startIn.step = "0.1";
    startIn.value = shot.start;
    startIn.addEventListener("change", () => { shot.start = Math.max(0, Number(startIn.value) || 0); this.commitChanges(); this.buildInspector(); });
    const durIn = document.createElement("input");
    durIn.className = "chaotic-input";
    durIn.type = "number";
    durIn.step = "0.1";
    durIn.value = shot.duration;
    durIn.addEventListener("change", () => { shot.duration = Math.max(MIN_DURATION, Number(durIn.value) || 1); this.commitChanges(); this.buildInspector(); });
    range.appendChild(startIn);
    range.appendChild(document.createTextNode(""));
    const durLabel = document.createElement("span");
    durLabel.className = "chaotic-label";
    durLabel.textContent = "Dur (s)";
    range.appendChild(durLabel);
    range.appendChild(durIn);
    ins.appendChild(range);

    const fmtRow = document.createElement("div");
    fmtRow.className = "chaotic-row";
    fmtRow.innerHTML = '<span class="chaotic-label">Format</span>';
    const seg = document.createElement("div");
    seg.className = "chaotic-seg";
    ["auto", "official", "narrative"].forEach(f => {
      const d = document.createElement("div");
      d.textContent = f;
      d.className = shot.format === f ? "on" : "";
      d.addEventListener("click", () => { shot.format = f; this.commitChanges(); this.buildInspector(); });
      seg.appendChild(d);
    });
    fmtRow.appendChild(seg);
    ins.appendChild(fmtRow);

    const wrap = document.createElement("div");
    wrap.className = "chaotic-txtwrap";
    const back = document.createElement("div");
    back.className = "chaotic-txtback";
    const ta = document.createElement("textarea");
    ta.className = "chaotic-input chaotic-textarea chaotic-txtarea";
    ta.rows = 6;
    ta.value = shot.text;
    ta.placeholder = "[Shot 1] Describe the shot... Use <Picture 1>, <Video 1>, <Audio 1>, or S1 tags.";
    const syncBack = () => { back.scrollTop = ta.scrollTop; back.scrollLeft = ta.scrollLeft; };
    const updateHighlight = () => {
      back.innerHTML = this.highlighted(ta.value, shot, tags, shorthands);
      syncBack();
    };
    ta.addEventListener("input", () => { shot.text = ta.value; updateHighlight(); this.commitChanges(); this.maybeTagSuggest(ta); });
    ta.addEventListener("keyup", e => { if (e.key === "Escape") this.closeTagMenu(); this.maybeTagSuggest(ta); });
    ta.addEventListener("blur", () => setTimeout(() => this.closeTagMenu(), 150));
    ta.addEventListener("scroll", syncBack);
    wrap.appendChild(back);
    wrap.appendChild(ta);
    ins.appendChild(wrap);

    /* one-click tag chips — every available tag, insert at the caret */
    const avail = this.state.refs.map(r => ({ token: tags[r.id] || (r.kind === "subject" ? (shorthands[r.id] || "") : ""), ref: r })).filter(x => x.token);
    if (avail.length) {
      const chips = document.createElement("div");
      chips.className = "chaotic-chips";
      const chipLab = document.createElement("span");
      chipLab.className = "chaotic-tlabel";
      chipLab.textContent = "Insert:";
      chips.appendChild(chipLab);
      avail.forEach(({ token, ref }) => {
        const chip = document.createElement("div");
        chip.className = "chaotic-chip ok";
        chip.textContent = token;
        chip.title = "click to insert at the cursor — " + (ref.name || ref.file || ref.kind);
        chip.addEventListener("click", () => this.insertTagAtCaret(ta, token));
        chip.addEventListener("mouseenter", ev => this.showThumb(ev, ref.id, ref));
        chip.addEventListener("mouseleave", () => this.hideThumb());
        chips.appendChild(chip);
      });
      ins.appendChild(chips);
    }

    const chips = document.createElement("div");
    chips.className = "chaotic-chips";
    const status = document.createElement("div");
    status.className = "chaotic-statusline";
    const found = this.validateTags(ta.value, shot, tags, shorthands);
    if (found.length === 0) {
      status.textContent = avail.length
        ? "No tags typed yet — the block is not linked to any reference. Click a chip above (or type < for autosuggest) to bind one."
        : "No reference tags in this block — add refs to the timeline or library first.";
    }
    found.forEach(item => {
      const chip = document.createElement("div");
      chip.className = "chaotic-chip " + item.status;
      chip.textContent = `${item.token} · ${item.label}`;
      chip.title = item.status === "ok" ? "active during this shot" : item.status === "warn" ? "this ref is not active during this shot's window" : "unknown tag";
      chip.addEventListener("mouseenter", ev => this.showThumb(ev, item.refId, item.ref));
      chip.addEventListener("mouseleave", () => this.hideThumb());
      chips.appendChild(chip);
    });
    ins.appendChild(chips);
    ins.appendChild(status);
    this.updateStatus(found.length ? "Tags validated against the timeline." : "");
  }

  /* ---------------- inline tag autosuggest (type < or <P …) ---------------- */
  insertTagAtCaret(ta, token) {
    const pos = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    ta.value = ta.value.slice(0, pos) + token + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = pos + token.length;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  }

  maybeTagSuggest(ta) {
    const before = ta.value.slice(0, ta.selectionStart != null ? ta.selectionStart : ta.value.length);
    const m = before.match(/<([A-Za-z]*)$/);
    if (!m) { this.closeTagMenu(); return; }
    const prefix = m[1].toLowerCase();
    const tags = this.globalTags();
    const shorthands = this.shorthands();
    const seen = new Set();
    const cands = [];
    this.state.refs.forEach(r => {
      const t = tags[r.id] || (r.kind === "subject" ? (shorthands[r.id] || "") : "");
      if (t && !seen.has(t)) { seen.add(t); cands.push(t); }
    });
    const filtered = prefix ? cands.filter(t => t.toLowerCase().startsWith("<" + prefix)) : cands;
    if (!filtered.length) { this.closeTagMenu(); return; }
    const rect = ta.getBoundingClientRect();
    const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 16;
    const x = rect.left + 8;
    const y = rect.top + 26;
    const menu = document.createElement("div");
    menu.className = "chaotic-tagmenu";
    filtered.slice(0, 12).forEach(tok => {
      const d = document.createElement("div");
      d.textContent = tok;
      d.addEventListener("mousedown", ev => { ev.preventDefault(); this.insertTagAtCaret(ta, tok); this.closeTagMenu(); });
      menu.appendChild(d);
    });
    const hint = document.createElement("div");
    hint.className = "chaotic-tagmenu-hint";
    hint.textContent = "← click to insert";
    menu.appendChild(hint);
    document.body.appendChild(menu);
    menu.style.display = "block";
    menu.style.left = Math.min(x, window.innerWidth - 170) + "px";
    menu.style.top = y + "px";
    if (this._tagMenu) this._tagMenu.remove();
    this._tagMenu = menu;
  }

  closeTagMenu() {
    if (this._tagMenu) { this._tagMenu.remove(); this._tagMenu = null; }
  }

  highlighted(text, shot, tags, shorthands) {
    const found = this.validateTags(text, shot, tags, shorthands);
    let html = "";
    let last = 0;
    for (const item of found) {
      html += escapeHtml(text.slice(last, item.start));
      html += `<mark class="tok-${item.status}">${escapeHtml(item.token)}</mark>`;
      last = item.end;
    }
    html += escapeHtml(text.slice(last));
    return html;
  }

  validateTags(text, shot, tags, shorthands) {
    /* Returns [{start, end, token, status, label, refId, ref}] */
    const out = [];
    const re = /<([A-Za-z]+)\s+(\d+)>|\bS(\d+)\b/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const token = m[0];
      const start = m.index;
      const end = start + token.length;
      let ref = null;
      let label = "";
      if (m[3] !== undefined) {
        const id = Object.keys(shorthands).find(k => shorthands[k] === token);
        ref = id ? this.refById(id) : null;
        label = ref ? `${ref.name || ref.file} (subject)` : "no subject";
      } else {
        const globalTag = `<${m[1]} ${m[2]}>`;
        const id = Object.keys(tags).find(k => tags[k] === globalTag);
        ref = id ? this.refById(id) : null;
        label = ref ? (ref.name || ref.file) : "unknown tag";
      }
      let status;
      if (!ref) status = "bad";
      else if (this.activeAt(ref, shot)) status = "ok";
      else status = "warn";
      out.push({ start, end, token, status, label, refId: ref ? ref.id : null, ref });
    }
    return out;
  }

  activeAt(ref, shot) {
    return ref.start < shot.start + shot.duration - 1e-6 && ref.start + ref.duration > shot.start + 1e-6;
  }

  showThumb(ev, refId, ref) {
    if (!ref) return;
    this.tip.innerHTML = "";
    if (ref.thumb && ref.kind !== "audio") {
      const img = new Image();
      img.onload = () => { this.tip.appendChild(img); this.positionTip(ev); this.tip.style.display = "block"; };
      img.src = ref.thumb;
    } else if (ref.kind === "audio") {
      const c = document.createElement("canvas");
      c.width = 180; c.height = 40;
      this.drawWaveform(c, ref.peaks || this.fakePeaks());
      this.tip.appendChild(c);
      this.positionTip(ev);
      this.tip.style.display = "block";
    } else if (ref.file) {
      const div = document.createElement("div");
      div.textContent = ref.file;
      div.style.color = "#aaa";
      div.style.padding = "4px";
      this.tip.appendChild(div);
      this.positionTip(ev);
      this.tip.style.display = "block";
    }
  }
  positionTip(ev) {
    this.tip.style.left = Math.min(window.innerWidth - 200, ev.clientX + 12) + "px";
    this.tip.style.top = Math.min(window.innerHeight - 160, ev.clientY + 12) + "px";
  }
  hideThumb() { this.tip.style.display = "none"; this.tip.innerHTML = ""; }

  fakePeaks() {
    const peaks = [];
    for (let i = 0; i < 200; i++) peaks.push(0.15 + Math.random() * 0.7);
    return peaks;
  }

  drawWaveform(canvas, peaks) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#2f7a50";
    const mid = canvas.height / 2;
    peaks.forEach((p, i) => {
      const x = (i / peaks.length) * canvas.width;
      const h = Math.max(1, p * (canvas.height - 4));
      ctx.fillRect(x, mid - h / 2, Math.max(1, canvas.width / peaks.length - 1), h);
    });
  }

  buildRefInspector(ins) {
    const ref = this.refById(this.selectedId);
    if (!ref) return;
    const tags = this.globalTags();
    const tag = tags[ref.id] || (ref.kind === "subject" ? (this.shorthands()[ref.id] || "") : "");
    const sh = this.shorthands()[ref.id];

    const head = document.createElement("div");
    head.className = "chaotic-panel-title";
    const tagLabel = ref.kind === "subject" ? `${tag} / ${sh}` : tag;
    head.innerHTML = `<span>${ref.kind} reference — ${tagLabel} @ ${fmtSec(ref.start)}s</span>`;
    const del = document.createElement("button");
    del.className = "chaotic-btn danger";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      this.state.refs = this.state.refs.filter(r => r.id !== ref.id);
      this.selectedId = null;
      this.selectedType = null;
      this.commitChanges();
      this.buildInspector();
    });
    head.appendChild(del);
    ins.appendChild(head);

    const nameRow = document.createElement("div");
    nameRow.className = "chaotic-row";
    nameRow.innerHTML = '<span class="chaotic-label">Name</span>';
    const nameIn = document.createElement("input");
    nameIn.className = "chaotic-input";
    nameIn.type = "text";
    nameIn.value = ref.name;
    nameIn.placeholder = "e.g. Luisa reference sheet";
    nameIn.addEventListener("input", () => { ref.name = nameIn.value; this.commitChanges(); this.renderTimeline(); });
    nameRow.appendChild(nameIn);
    ins.appendChild(nameRow);

    const fileRow = document.createElement("div");
    fileRow.className = "chaotic-row";
    fileRow.innerHTML = `<span class="chaotic-label" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(ref.file)}">${escapeHtml(ref.file || "no file")}</span>`;
    ins.appendChild(fileRow);

    /* two-column grid for the compact rows (keeps the panel short) */
    const grid = document.createElement("div");
    grid.className = "chaotic-grid";

    /* preview + placement */
    const prevRow = document.createElement("div");
    prevRow.className = "chaotic-row";
    const prevBtn = this.btn("▶ Preview", () => this.previewRef(ref.id));
    prevBtn.title = "play this reference in the preview strip (or jump the playhead to it)";
    prevRow.appendChild(prevBtn);
    const placeSeg = document.createElement("div");
    placeSeg.className = "chaotic-seg";
    placeSeg.title = "timeline = part of the video edit; library = reference only, never on the timeline";
    [["timeline", "Timeline"], ["library", "Library"]].forEach(([v, l]) => {
      const d = document.createElement("div");
      d.textContent = l;
      d.className = (ref.timed && v === "timeline") || (!ref.timed && v === "library") ? "on" : "";
      d.addEventListener("click", () => {
        if (v === "timeline") {
          if (!ref.timed) this.placeRefOnTimeline(ref.id);
        } else {
          this.moveRefToLibrary(ref.id);
        }
      });
      placeSeg.appendChild(d);
    });
    prevRow.appendChild(placeSeg);
    grid.appendChild(prevRow);

    const kindRow = document.createElement("div");
    kindRow.className = "chaotic-row";
    kindRow.innerHTML = '<span class="chaotic-label">Tag type</span>';
    if (ref.kind === "picture" || ref.kind === "subject") {
      const seg = document.createElement("div");
      seg.className = "chaotic-seg";
      ["picture", "subject"].forEach(k => {
        const d = document.createElement("div");
        d.textContent = k === "picture" ? "<Picture N>" : "<Subject N> / S#";
        d.className = ref.tag_type === k ? "on" : "";
        d.addEventListener("click", () => { ref.kind = k; ref.tag_type = k; this.commitChanges(); this.buildInspector(); });
        seg.appendChild(d);
      });
      kindRow.appendChild(seg);
    } else {
      const lab = document.createElement("span");
      lab.className = "chaotic-label";
      lab.textContent = ref.kind === "video" ? "<Video N>" : "<Audio N>";
      kindRow.appendChild(lab);
    }
    grid.appendChild(kindRow);

    if (ref.kind === "video") {
      const snd = document.createElement("div");
      snd.className = "chaotic-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = ref.use_soundtrack;
      box.title = "use this video's audio track as an <Audio N> reference for the soundtrack";
      box.addEventListener("change", () => { ref.use_soundtrack = box.checked; this.commitChanges(); this.buildInspector(); });
      const lab = document.createElement("span");
      lab.className = "chaotic-label";
      lab.title = "use this video's audio track as an <Audio N> reference for the soundtrack";
      lab.textContent = "Soundtrack as <Audio N>";
      snd.appendChild(box);
      snd.appendChild(lab);
      grid.appendChild(snd);
    }

    if (ref.kind === "video" || ref.kind === "audio") {
      const trim = document.createElement("div");
      trim.className = "chaotic-row";
      trim.innerHTML = '<span class="chaotic-label">Trim in</span>';
      const tin = document.createElement("input");
      tin.className = "chaotic-input";
      tin.type = "number";
      tin.step = "0.1";
      tin.value = ref.trim_start;
      tin.addEventListener("change", () => { ref.trim_start = Math.max(0, Number(tin.value) || 0); this.commitChanges(); });
      const tout = document.createElement("input");
      tout.className = "chaotic-input";
      tout.type = "number";
      tout.step = "0.1";
      tout.value = ref.trim_end == null ? "" : ref.trim_end;
      tout.placeholder = "end";
      tout.addEventListener("change", () => {
        ref.trim_end = tout.value === "" ? null : Math.max(ref.trim_start + MIN_DURATION, Number(tout.value) || 0);
        this.commitChanges();
      });
      trim.appendChild(tin);
      trim.appendChild(document.createTextNode(""));
      const endLab = document.createElement("span");
      endLab.className = "chaotic-label";
      endLab.textContent = "out";
      trim.appendChild(endLab);
      trim.appendChild(tout);
      grid.appendChild(trim);
    }

    /* strength slider with retention band */
    const strRow = document.createElement("div");
    strRow.className = "chaotic-row";
    strRow.innerHTML = '<span class="chaotic-label">Strength</span>';
    const slider = document.createElement("input");
    slider.className = "chaotic-range";
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.05";
    slider.value = ref.strength;
    const val = document.createElement("span");
    val.className = "chaotic-slider-val";
    const band = document.createElement("span");
    band.className = "chaotic-band";
    const updateBand = () => {
      const marker = strengthToMarker(ref.kind === "audio" ? "audio" : "visual", ref.strength);
      band.textContent = marker;
      band.style.color = ref.strength >= 0.85 ? "#7ee2a8" : ref.strength >= 0.6 ? "#9fd6ff" : ref.strength >= 0.35 ? "#ffd479" : "#ff8f8f";
    };
    slider.addEventListener("input", () => {
      ref.strength = Number(slider.value);
      val.textContent = ref.strength.toFixed(2);
      updateBand();
      this.commitChanges();
    });
    val.textContent = ref.strength.toFixed(2);
    updateBand();
    strRow.appendChild(slider);
    strRow.appendChild(val);
    strRow.appendChild(band);
    grid.appendChild(strRow);
    grid.appendChild(this.hint(`Strength maps onto H3 retention_analysis: the label shown is what the Director will emit for this reference.`));

    if (ref.kind === "video") {
      const roleRow = document.createElement("div");
      roleRow.className = "chaotic-row";
      roleRow.innerHTML = '<span class="chaotic-label">Role</span>';
      const seg = document.createElement("div");
      seg.className = "chaotic-seg";
      [["reference", "Mood donor"], ["source", "Clip being edited"]].forEach(([v, l]) => {
        const d = document.createElement("div");
        d.textContent = l;
        d.title = v === "source"
          ? "this video IS the clip being edited — the edit target fed to the Video Edit node; shown with an EDIT badge"
          : "reference only — used for mood/visual style, never treated as the edit target";
        d.className = ref.role === v ? "on" : "";
        d.addEventListener("click", () => {
          ref.role = v;
          this.commitChanges();
          this.buildInspector();
          this.updateStatus(v === "source"
            ? "Role: Clip being edited — this video is the edit target (EDIT badge on the timeline); its soundtrack can be carried as <Audio N>."
            : "Role: Mood donor — this video is reference-only; not treated as the edit target.");
        });
        seg.appendChild(d);
      });
      roleRow.appendChild(seg);
      grid.appendChild(roleRow);
    }

    ins.appendChild(grid);

    const annRow = document.createElement("div");
    annRow.className = "chaotic-row";
    annRow.style.alignItems = "stretch";
    const annLab = document.createElement("span");
    annLab.className = "chaotic-label";
    annLab.style.width = "150px";
    annLab.textContent = "Annotation";
    const ann = document.createElement("textarea");
    ann.className = "chaotic-input";
    ann.rows = 2;
    ann.style.flex = "1";
    ann.value = ref.annotation;
    ann.placeholder = "Optional descriptive detail (feeds subject_definitions / retention notes).";
    ann.addEventListener("input", () => { ref.annotation = ann.value; this.commitChanges(); });
    annRow.appendChild(annLab);
    annRow.appendChild(ann);
    ins.appendChild(annRow);
  }

  hint(text) {
    const d = document.createElement("div");
    d.className = "chaotic-hint";
    d.textContent = text;
    return d;
  }

  updateStatus(text) {
    this.statusLine.textContent = text;
  }

  /* ---------------- shortcuts overlay (? key / ? Help button) ---------------- */
  buildShortcutsOverlay() {
    const ov = document.createElement("div");
    ov.className = "chaotic-overlay";
    const title = document.createElement("h3");
    title.textContent = "⌨️ Timeline shortcuts";
    ov.appendChild(title);
    const close = document.createElement("span");
    close.className = "x";
    close.textContent = "✕";
    close.title = "close (Esc or ?)";
    close.addEventListener("click", () => this.closeShortcuts());
    ov.appendChild(close);
    [
      ["← →", "nudge the selected shot/ref by 1 snap unit (Shift = 10×)"],
      ["S", "split at the playhead (selected shot, or the one under it)"],
      ["R", "render window — set IN, set OUT, press again to clear"],
      ["+ / −", "zoom the timeline (or Ctrl+wheel)"],
      ["Del", "delete the selected shot / reference"],
      ["Esc", "clear selection, close menus / this overlay"],
      ["Right-click", "context menu — split, duplicate, delete, import, grab from library"],
      ["Double-click", "open an existing shot instead of stacking a new one"],
      ["Drag", "move a block · grab an edge to trim · drop a timed ref on the library to untime it"],
    ].forEach(([k, d]) => {
      const row = document.createElement("div");
      row.className = "row";
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      const desc = document.createElement("span");
      desc.className = "d";
      desc.textContent = d;
      row.appendChild(kbd);
      row.appendChild(desc);
      ov.appendChild(row);
    });
    return ov;   /* hidden by the base CSS rule; the .open class shows it */
  }

  toggleShortcuts() {
    if (!this.helpOverlay) return;
    const open = this.helpOverlay.classList.toggle("open");
    if (open) this.updateStatus("Shortcuts — press ? or Esc to close.");
  }

  closeShortcuts() {
    if (this.helpOverlay) this.helpOverlay.classList.remove("open");
  }

  /* ---------------- timeline drawing ---------------- */
  renderTimeline() {
    if (!this.canvas || !this.ctx) return;
    const ctx = this.ctx;
    const total = this.duration * this.zoom;
    const w = this.canvas.clientWidth || 800;
    const h = TIMELINE_H;
    ctx.clearRect(0, 0, w, h);

    /* background */
    ctx.fillStyle = "#202020";
    ctx.fillRect(0, 0, w, h);

    /* ruler */
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = "#3a3a3a";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H);
    ctx.lineTo(w, RULER_H);
    ctx.stroke();
    const step = this.rulerStep(total);
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "9px ui-monospace, Menlo, monospace";
    for (let t = 0; t <= total + 1e-6; t += step) {
      const x = (t / total) * w;
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillText(t.toFixed(1) + "s", x + 3, RULER_H - 8);
    }

    /* chunk boundary markers */
    const cuts = this.predictedBoundaries();
    const pinned = this.state.boundaries;
    ctx.lineWidth = 1;
    cuts.forEach(t => {
      const x = (t / total) * w;
      ctx.strokeStyle = "rgba(120,190,255,.5)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
    });
    pinned.forEach(t => {
      const x = (t / total) * w;
      ctx.strokeStyle = "#ffd479";
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = "#ffd479";
      ctx.fillRect(x - 3, RULER_H - 2, 6, 6);
    });
    ctx.setLineDash([]);

    /* track labels + lanes */
    const lanes = [
      [PICTURE_TRACK_Y, "PICTURES / SUBJECTS", "#2b3e36"],
      [VIDEO_TRACK_Y, "VIDEOS", "#2b2f3e"],
      [AUDIO_TRACK_Y, "AUDIO", "#3e332b"],
      [SHOT_TRACK_Y, "PROMPT (shots)", "#3e2b33"],
    ];
    lanes.forEach(([y, label, color]) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, y, w, TRACK_H);
      ctx.fillStyle = "rgba(255,255,255,.25)";
      ctx.font = "8px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(label, 4, y + 10);
      ctx.strokeStyle = "#2c2c2c";
      ctx.beginPath();
      ctx.moveTo(0, y + TRACK_H - 1);
      ctx.lineTo(w, y + TRACK_H - 1);
      ctx.stroke();
    });

    /* render window: shade everything outside [renderIn, renderOut) */
    if (this.renderIn != null || this.renderOut != null) {
      const xIn = this.renderIn != null ? (this.renderIn / total) * w : 0;
      const xOut = this.renderOut != null ? (this.renderOut / total) * w : w;
      ctx.fillStyle = "rgba(0,0,0,.42)";
      if (xIn > 0) ctx.fillRect(0, RULER_H, xIn, h - RULER_H);
      if (xOut < w) ctx.fillRect(xOut, RULER_H, w - xOut, h - RULER_H);
    }

    /* refs */
    this.state.refs.forEach(ref => {
      if (!ref.timed) return;
      const y = this.refTrackY(ref);
      this.drawRefBlock(ctx, ref, y, total, w);
    });

    /* shots */
    this.state.shots.forEach(shot => {
      this.drawShotBlock(ctx, shot, SHOT_TRACK_Y, total, w);
    });

    /* ghost */
    if (this._ghost) {
      ctx.strokeStyle = "#7aa";
      ctx.setLineDash([4, 4]);
      const y = this.trackYForKind(this._ghost.kind);
      ctx.strokeRect(this._ghost.x0, y + 4, this._ghost.x1 - this._ghost.x0, TRACK_H - 8);
      ctx.setLineDash([]);
    }

    /* render window IN / OUT markers */
    if (this.renderIn != null) {
      const x = (this.renderIn / total) * w;
      ctx.strokeStyle = "#4aa47f";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = "#1f3a2c";
      ctx.fillRect(x - 14, RULER_H, 28, 12);
      ctx.fillStyle = "#7ee2a8";
      ctx.font = "bold 8px ui-monospace, Menlo, monospace";
      ctx.fillText("IN", x - 6, RULER_H + 9);
    }
    if (this.renderOut != null) {
      const x = (this.renderOut / total) * w;
      ctx.strokeStyle = "#e0665f";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = "#3a1f1f";
      ctx.fillRect(x - 16, RULER_H, 30, 12);
      ctx.fillStyle = "#ff8f8f";
      ctx.font = "bold 8px ui-monospace, Menlo, monospace";
      ctx.fillText("OUT", x - 8, RULER_H + 9);
    }

    /* playhead */
    if (this.playhead != null) {
      const x = (this.playhead / total) * w;
      ctx.strokeStyle = "#ff5a5a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 4);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = "#ff5a5a";
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 7);
      ctx.lineTo(x - 4, RULER_H - 1);
      ctx.lineTo(x + 4, RULER_H - 1);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1;
    }

    /* render window label (ruler, right side) */
    const rangeLabel = this.renderRangeLabel();
    if (rangeLabel) {
      ctx.fillStyle = "#ffd479";
      ctx.font = "bold 9px ui-monospace, Menlo, monospace";
      let labelW = 96;
      try { const m = ctx.measureText(rangeLabel); if (m && m.width) labelW = m.width; } catch (e) { /* keep fallback */ }
      ctx.fillText(rangeLabel, w - labelW - 6, RULER_H - 8);
    }
  }

  rulerStep(total) {
    const target = 80;
    const raw = total / target;
    const steps = [0.5, 1, 2, 5, 10, 20, 30, 60];
    for (const s of steps) if (raw <= s) return s;
    return 120;
  }

  refTrackY(ref) {
    if (ref.kind === "video") return VIDEO_TRACK_Y;
    if (ref.kind === "audio") return AUDIO_TRACK_Y;
    return PICTURE_TRACK_Y;
  }
  trackYForKind(kind) {
    if (kind === "video") return VIDEO_TRACK_Y;
    if (kind === "audio") return AUDIO_TRACK_Y;
    return PICTURE_TRACK_Y;
  }

  drawRefBlock(ctx, ref, y, total, w) {
    const tags = this.globalTags();
    const x0 = (ref.start / total) * w;
    const x1 = ((ref.start + ref.duration) / total) * w;
    const isSel = this.selectedType === "ref" && this.selectedId === ref.id;
    const h = TRACK_H - 10;

    ctx.fillStyle = isSel ? "#2e4a3c" : "#242424";
    ctx.strokeStyle = isSel ? "#4aa47f" : "#3a3a3a";
    ctx.lineWidth = isSel ? 1.5 : 1;
    ctx.beginPath();
    if (ref.kind === "video") this.roundRect(ctx, x0 + 2, y + 5, Math.max(6, x1 - x0 - 4), h, 4);
    else ctx.rect(x0 + 2, y + 5, Math.max(6, x1 - x0 - 4), h);
    ctx.fill();
    ctx.stroke();

    /* thumbnail strip */
    if (x1 - x0 > 26) {
      const tw = Math.min(34, Math.max(8, (x1 - x0) * 0.5));
      if (ref.thumb && ref.kind !== "audio") {
        try {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = tw; c.height = h - 4;
            const cc = c.getContext("2d");
            const r = Math.max(tw / img.width, (h - 4) / img.height);
            cc.drawImage(img, 0, 0, img.width * r, img.height * r);
            ctx.drawImage(c, x0 + 4, y + 7);
          };
          img.src = ref.thumb;
        } catch (e) {}
      } else if (ref.kind === "audio") {
        const c = document.createElement("canvas");
        c.width = tw; c.height = h - 8;
        this.drawWaveform(c, ref.peaks || this.fakePeaks());
        ctx.drawImage(c, x0 + 4, y + 8);
      }
    }

    /* label */
    ctx.fillStyle = "#e8e8e8";
    ctx.font = "9px ui-monospace, Menlo, monospace";
    const tag = tags[ref.id] || (ref.kind === "subject" ? this.shorthands()[ref.id] : "");
    const label = `${tag}${ref.name ? " · " + ref.name : ""}`;
    ctx.fillText(label.slice(0, 40), x0 + (x1 - x0 > 26 ? 40 : 4), y + 17);
    /* visible EDIT badge so changing the role gives immediate feedback */
    if (ref.role === "source") {
      const bx = x0 + (x1 - x0 > 26 ? 40 : 4) + Math.min(ctx.measureText(label).width, 150) + 5;
      ctx.fillStyle = "#7a3a1a";
      ctx.fillRect(bx, y + 9, 25, 11);
      ctx.fillStyle = "#ffb454";
      ctx.font = "bold 7px ui-monospace, Menlo, monospace";
      ctx.fillText("EDIT", bx + 2, y + 18);
    }

    /* trim handles */
    if (x1 - x0 > 30) {
      ctx.fillStyle = "#c8c8c8";
      ctx.fillRect(x0 + 1, y + 5, 5, h);
      ctx.fillRect(x1 - 6, y + 5, 5, h);
    }
  }

  drawShotBlock(ctx, shot, y, total, w) {
    const x0 = (shot.start / total) * w;
    const x1 = ((shot.start + shot.duration) / total) * w;
    const isSel = this.selectedType === "shot" && this.selectedId === shot.id;
    const h = TRACK_H - 10;

    ctx.fillStyle = isSel ? "#3c2e3a" : "#2a2228";
    ctx.strokeStyle = isSel ? "#d47aa0" : "#4a3a44";
    ctx.lineWidth = isSel ? 1.5 : 1;
    ctx.beginPath();
    this.roundRect(ctx, x0 + 2, y + 5, Math.max(6, x1 - x0 - 4), h, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#e8dce2";
    ctx.font = "9px ui-monospace, Menlo, monospace";
    const idx = this.state.shots.filter(s => s.start < shot.start || (s.start === shot.start && s._index < shot._index)).length + 1;
    const snippet = shot.text.replace(/[\n\r]+/g, " ").slice(0, 60);
    const fmtBadge = shot.format && shot.format !== "auto" ? ` · ${shot.format}` : "";
    ctx.fillText(`[Shot ${idx}] ${snippet}`, x0 + 5, y + 20);
    if (fmtBadge) {
      ctx.fillStyle = shot.format === "narrative" ? "#ffd479" : "#9fd6ff";
      ctx.font = "8px ui-monospace, Menlo, monospace";
      const btx = x0 + 5 + ctx.measureText(`[Shot ${idx}] ${snippet}`).width + 4;
      ctx.fillText(fmtBadge.trim(), btx, y + 19);
    }
    ctx.fillStyle = "#8a7a82";
    ctx.fillText(`${fmtSec(shot.duration)}s`, x1 - 34, y + 20);

    /* duration handles */
    ctx.fillStyle = "#c8c8c8";
    ctx.fillRect(x0 + 1, y + 5, 5, h);
    ctx.fillRect(x1 - 6, y + 5, 5, h);
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- interactions ---------------- */
  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.clientWidth / Math.max(1, rect.width);
    const scaleY = this.canvas.clientHeight / Math.max(1, rect.height);
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  hitTest(x, y) {
    const total = this.duration * this.zoom;
    const w = this.canvas.clientWidth || 1;
    /* ruler: render window handles, then scrub playhead */
    if (y < RULER_H) {
      if (this.renderIn != null && Math.abs(x - (this.renderIn / total) * w) < 9) return { type: "render-in" };
      if (this.renderOut != null && Math.abs(x - (this.renderOut / total) * w) < 9) return { type: "render-out" };
      return { type: "playhead" };
    }
    /* chunk boundary handles */
    for (const b of this.state.boundaries) {
      const bx = (b / total) * w;
      if (Math.abs(x - bx) < 6 && y > RULER_H) return { type: "boundary", value: b };
    }
    /* refs */
    for (let i = this.state.refs.length - 1; i >= 0; i--) {
      const ref = this.state.refs[i];
      if (!ref.timed) continue;
      const ry = this.refTrackY(ref);
      if (y < ry || y > ry + TRACK_H) continue;
      const x0 = (ref.start / total) * w;
      const x1 = ((ref.start + ref.duration) / total) * w;
      if (x >= x0 - HANDLE_HIT && x <= x0 + HANDLE_HIT) return { type: "ref-left", id: ref.id };
      if (x >= x1 - HANDLE_HIT && x <= x1 + HANDLE_HIT) return { type: "ref-right", id: ref.id };
      if (x >= x0 && x <= x1) return { type: "ref", id: ref.id };
    }
    /* shots */
    for (let i = this.state.shots.length - 1; i >= 0; i--) {
      const shot = this.state.shots[i];
      if (y < SHOT_TRACK_Y || y > SHOT_TRACK_Y + TRACK_H) continue;
      const x0 = (shot.start / total) * w;
      const x1 = ((shot.start + shot.duration) / total) * w;
      if (x >= x0 - HANDLE_HIT && x <= x0 + HANDLE_HIT) return { type: "shot-left", id: shot.id };
      if (x >= x1 - HANDLE_HIT && x <= x1 + HANDLE_HIT) return { type: "shot-right", id: shot.id };
      if (x >= x0 && x <= x1) return { type: "shot", id: shot.id };
    }
    return null;
  }

  onMouseDown(e) {
    const { x, y } = this.getMousePos(e);
    const hit = this.hitTest(x, y);
    this._drag = null;
    if (!hit) {
      this.selectedType = null;
      this.selectedId = null;
      this.buildInspector();
      this.renderTimeline();
      return;
    }
    if (hit.type === "playhead") {
      const sec = clamp(this.secondsAt(x), 0, this.duration);
      this._drag = { mode: "playhead" };
      this.setPlayhead(sec);
      return;
    }
    if (hit.type === "render-in") {
      this._drag = { mode: "render-in" };
      return;
    }
    if (hit.type === "render-out") {
      this._drag = { mode: "render-out" };
      return;
    }
    if (hit.type === "boundary") {
      this._drag = { mode: "boundary", startX: e.clientX, orig: hit.value };
      return;
    }
    if (hit.type === "ref" || hit.type === "ref-left" || hit.type === "ref-right") {
      this.selectedType = "ref";
      this.selectedId = hit.id;
      const ref = this.refById(hit.id);
      this._drag = { mode: hit.type === "ref" ? "ref-move" : hit.type, id: hit.id, origStart: ref.start, origDur: ref.duration, origTrimStart: ref.trim_start };
      this.buildInspector();
      this.renderTimeline();
      return;
    }
    if (hit.type === "shot" || hit.type === "shot-left" || hit.type === "shot-right") {
      this.selectedType = "shot";
      this.selectedId = hit.id;
      const shot = this.shotById(hit.id);
      this._drag = { mode: hit.type === "shot" ? "shot-move" : hit.type, id: hit.id, origStart: shot.start, origDur: shot.duration };
      this.buildInspector();
      this.renderTimeline();
    }
  }

  onMouseMove(e) {
    this._lastClient = { x: e.clientX, y: e.clientY };
    if (!this._drag) return;
    const { x, y } = this.getMousePos(e);
    const total = this.duration * this.zoom;
    const w = this.canvas.clientWidth || 1;
    const sec = clamp((x / w) * total, 0, total);

    if (this._drag.mode === "playhead") {
      this.setPlayhead(clamp(sec, 0, this.duration));
      return;
    }
    if (this._drag.mode === "render-in") {
      const max = this.renderOut != null ? this.renderOut : this.duration;
      this.renderIn = Math.max(0, Math.min(clamp(sec, 0, this.duration), max));
      this.commitChanges();
      return;
    }
    if (this._drag.mode === "render-out") {
      const min = this.renderIn != null ? this.renderIn : 0;
      this.renderOut = Math.min(this.duration, Math.max(clamp(sec, 0, this.duration), min));
      this.commitChanges();
      return;
    }
    if (this._drag.mode === "boundary") {
      const snapped = this.snapToBoundary(sec);
      this._drag.orig = snapped;
      this.state.boundaries = this.state.boundaries.filter(b => Math.abs(b - snapped) > 0.01);
      this.state.boundaries.push(snapped);
      this.state.boundaries.sort((a, b) => a - b);
      this.commitChanges();
      return;
    }
    if (this._drag.mode.startsWith("ref")) {
      const ref = this.refById(this._drag.id);
      if (!ref) return;
      if (this._drag.mode === "ref-move") {
        ref.start = this.snapTime(clamp(sec - ref.duration / 2, 0, total - ref.duration));
      } else if (this._drag.mode === "ref-left") {
        const newStart = this.snapTime(clamp(sec, 0, ref.start + ref.duration - MIN_DURATION));
        ref.trim_start = Math.max(0, ref.trim_start + (newStart - ref.start));
        ref.duration = ref.duration - (newStart - ref.start);
        ref.start = newStart;
      } else if (this._drag.mode === "ref-right") {
        const newEnd = this.snapTime(clamp(sec, ref.start + MIN_DURATION, total));
        ref.duration = newEnd - ref.start;
      }
      this.commitChanges();
      return;
    }
    if (this._drag.mode.startsWith("shot")) {
      const shot = this.shotById(this._drag.id);
      if (!shot) return;
      if (this._drag.mode === "shot-move") {
        let ns = this.snapTime(clamp(sec - shot.duration / 2, 0, total - shot.duration));
        if (this.state.overlap_lock) ns = this.avoidShotOverlap(shot, ns);
        shot.start = ns;
      } else if (this._drag.mode === "shot-left") {
        let newStart = this.snapTime(clamp(sec, 0, shot.start + shot.duration - MIN_DURATION));
        if (this.state.overlap_lock) newStart = this.avoidShotOverlap(shot, newStart);
        shot.duration = shot.duration - (newStart - shot.start);
        shot.start = newStart;
      } else if (this._drag.mode === "shot-right") {
        const newEnd = this.snapTime(clamp(sec, shot.start + MIN_DURATION, total));
        if (this.state.overlap_lock) {
          /* don't let the right edge push into the next shot */
          const nxt = this.state.shots
            .filter(s => s.id !== shot.id && s.start >= shot.start - 1e-6)
            .sort((a, b) => a.start - b.start)[0];
          const maxEnd = nxt ? Math.max(shot.start + MIN_DURATION, nxt.start) : total;
          shot.duration = clamp(newEnd, MIN_DURATION, maxEnd) - shot.start;
        } else {
          shot.duration = clamp(newEnd, MIN_DURATION, total) - shot.start;
        }
      }
      this.commitChanges();
    }
  }

  snapTime(sec) {
    if (!this.state.snap || !this.state.snap.on) return sec;
    const unit = this.state.snap.unit === "second" ? 1 : (1 / (this.fps || 24));
    return Math.round(sec / unit) * unit;
  }

  avoidShotOverlap(shot, targetStart) {
    /* with overlap-lock on, slide the target to the nearest free gap */
    const dur = shot.duration;
    const others = this.state.shots.filter(s => s.id !== shot.id).sort((a, b) => a.start - b.start);
    const totalEnd = this.duration;
    const maxStart = Math.max(0, totalEnd - dur);
    let target = clamp(targetStart, 0, maxStart);
    for (let guard = 0; guard < 24; guard++) {
      let bad = null;
      for (const o of others) {
        if (target < o.start + o.duration - 1e-6 && target + dur > o.start + 1e-6) { bad = o; break; }
      }
      if (!bad) break;
      const before = bad.start - dur;
      const after = bad.start + bad.duration;
      if (target + dur / 2 <= bad.start + bad.duration / 2) target = Math.max(0, before);
      else target = Math.min(maxStart, after);
    }
    /* final pass: if a tight layout still overlaps, settle on the nearest free edge */
    for (const o of others) {
      if (target < o.start + o.duration - 1e-6 && target + dur > o.start + 1e-6) {
        const before = Math.max(0, o.start - dur);
        const after = Math.min(maxStart, o.start + o.duration);
        target = (Math.abs(target - before) <= Math.abs(target - after)) ? before : after;
      }
    }
    return clamp(target, 0, maxStart);
  }

  snapToBoundary(sec) {
    /* snap to the nearest shot edge for clean chunk cuts */
    let best = sec;
    let bestD = Infinity;
    this.state.shots.forEach(s => {
      [s.start, s.start + s.duration].forEach(edge => {
        const d = Math.abs(edge - sec);
        if (d < bestD && d < 0.6) { bestD = d; best = edge; }
      });
    });
    return clamp(Math.round(best * 20) / 20, 0.05, this.duration - 0.05);
  }

  onMouseUp(e) {
    const drag = this._drag;
    this._drag = null;
    if (!drag) return;
    /* drag a timeline ref onto the open library panel → move it to the library */
    if (drag.mode === "ref-move" && this.libraryPanel && this.libraryPanel.classList.contains("open")) {
      const pt = this._lastClient || { x: e.clientX, y: e.clientY };
      const el = document.elementFromPoint(pt.x, pt.y);
      if (el && this.libraryPanel.contains(el)) {
        const ref = this.refById(drag.id);
        if (ref) {
          ref.timed = false;
          this.commitChanges();
          this.buildInspector();
          this.updateStatus("Reference moved to the library — it no longer appears on the timeline.");
        }
        return;
      }
    }
  }

  onDblClick(e) {
    const { x, y } = this.getMousePos(e);
    const hit = this.hitTest(x, y);
    /* double-clicking an existing shot/ref opens it instead of overlapping it */
    if (hit && (hit.type === "shot" || hit.type === "ref" || hit.type.startsWith("shot") || hit.type.startsWith("ref"))) {
      this.selectedType = hit.type.startsWith("shot") ? "shot" : "ref";
      this.selectedId = hit.id;
      this.buildInspector();
      this.renderTimeline();
      return;
    }
    const track = this.trackForY(y);
    if (track === "shot") {
      const sec = this.snapTime(this.secondsAt(x));
      const dur = this.snapTime(2);
      const shot = this.normalizeShot({ id: uid("shot"), start: Math.max(0, sec - dur / 2), duration: dur, text: "[Shot N] New shot." }, this.state.shots.length);
      if (this.state.overlap_lock) {
        shot.start = this.avoidShotOverlap(shot, shot.start);
      }
      this.state.shots.push(shot);
      this.selectedType = "shot";
      this.selectedId = shot.id;
      this.commitChanges();
      this.buildInspector();
    }
  }

  /* ---------------- keyboard ---------------- */
  onKeyDown(e) {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t.isContentEditable))) return;
    /* never hijack browser/OS chords (Ctrl+R reload, Ctrl+S, Ctrl/Alt+arrows, Ctrl+/-) —
       Shift is fine (shift+= is "+" and Shift+arrows are the 10x nudge) */
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selectedType === "shot" && this.selectedId) {
        e.preventDefault();
        this.deleteShot(this.selectedId);
      } else if (this.selectedType === "ref" && this.selectedId) {
        e.preventDefault();
        this.deleteRef(this.selectedId);
      }
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      /* nudge the selected shot/ref by one snap unit (Shift = 10x) */
      e.preventDefault();
      this.nudgeSelected(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey ? 10 : 1);
    } else if (e.key === "s" || e.key === "S") {
      /* split the selected shot — or the shot under the playhead */
      e.preventDefault();
      let id = null;
      if (this.selectedType === "shot" && this.selectedId) id = this.selectedId;
      else if (this.playhead != null) {
        const at = this.playhead;
        const shot = this.state.shots.find(s => at > s.start + MIN_DURATION && at < s.start + s.duration - MIN_DURATION);
        if (shot) id = shot.id;
      }
      if (id) {
        this.splitShot(id);
        this.selectedType = "shot";
        this.selectedId = id;
        this.buildInspector();
      } else {
        this.updateStatus("Select a shot or place the playhead inside one, then press S to split.");
      }
    } else if (e.key === "r" || e.key === "R") {
      /* render window: R sets IN, R again sets OUT, R again clears */
      e.preventDefault();
      const at = this.playhead != null ? this.snapTime(this.playhead) : null;
      if (this.renderIn == null) {
        this.renderIn = at != null ? at : 0;
        this.renderOut = null;
        this.updateStatus("Render IN set at " + fmtSec(this.renderIn) + "s — move the playhead to the OUT point and press R (R before the IN point clears).");
      } else if (this.renderOut == null || this.renderOut <= this.renderIn) {
        if (at == null || at <= this.renderIn) {
          this.renderIn = null;
          this.renderOut = null;
          this.updateStatus("Render range cleared.");
        } else {
          this.renderOut = at;
          this.updateStatus("Render range set: " + fmtSec(this.renderIn) + "s → " + fmtSec(this.renderOut) + "s (" + this.renderRangeLabel() + ").");
        }
      } else {
        this.renderIn = null;
        this.renderOut = null;
        this.updateStatus("Render range cleared.");
      }
      this.syncRenderWidgets();
      this.commitChanges();
      this.buildInspector();
    } else if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") {
      /* zoom the timeline (same step as Ctrl+wheel) */
      e.preventDefault();
      const dir = (e.key === "-" || e.key === "_") ? -1 : 1;
      this.zoom = clamp(this.zoom + dir * 0.2, 1, 6);
      this.renderTimeline();
    } else if (e.key === "?") {
      /* shortcuts overlay (Shift+/ on US layouts) */
      e.preventDefault();
      this.toggleShortcuts();
    } else if (e.key === "Escape") {
      if (this.helpOverlay && this.helpOverlay.classList.contains("open")) {
        this.closeShortcuts();
        return;   /* Esc while help is open only dismisses help */
      }
      this.closeContextMenu();
      this.closeTagMenu();
      if (this.selectedId) {
        this.selectedId = null;
        this.selectedType = null;
        this.buildInspector();
        this.renderTimeline();
      }
    }
  }

  nudgeSelected(dir, mult) {
    const unit = this.state.snap && this.state.snap.on
      ? (this.state.snap.unit === "second" ? 1 : (1 / (this.fps || 24)))
      : (1 / (this.fps || 24));
    const step = dir * unit * (mult || 1);
    if (this.selectedType === "shot" && this.selectedId) {
      const shot = this.shotById(this.selectedId);
      if (!shot) return;
      let ns = this.snapTime(clamp(shot.start + step, 0, Math.max(0, this.duration - shot.duration)));
      if (this.state.overlap_lock) ns = this.avoidShotOverlap(shot, ns);
      shot.start = ns;
      this.commitChanges();
      this.updateStatus("Shot nudged to " + fmtSec(shot.start) + "s.");
    } else if (this.selectedType === "ref" && this.selectedId) {
      const ref = this.refById(this.selectedId);
      if (!ref || !ref.timed) { this.updateStatus("Only timed refs can be nudged — untime this ref first."); return; }
      ref.start = this.snapTime(clamp(ref.start + step, 0, Math.max(0, this.duration - ref.duration)));
      this.commitChanges();
      this.updateStatus("Ref nudged to " + fmtSec(ref.start) + "s.");
    } else {
      this.updateStatus("Select a shot or timed ref first, then use ← → to nudge.");
    }
  }

  /* ---------------- right-click context menu ---------------- */
  onContextMenu(e) {
    e.preventDefault();
    const { x, y } = this.getMousePos(e);
    const hit = this.hitTest(x, y);
    const items = [];
    if (hit && hit.type.startsWith("shot")) {
      const shot = this.shotById(hit.id);
      if (shot) {
        this.selectedType = "shot";
        this.selectedId = shot.id;
        this.renderTimeline();
        this.buildInspector();
        items.push({ label: "✂ Split at playhead", fn: () => this.splitShot(shot.id) });
        items.push({ label: "⧉ Duplicate", fn: () => this.duplicateShot(shot.id) });
        items.push({ sep: true });
        items.push({ label: "🗑 Delete shot", danger: true, fn: () => this.deleteShot(shot.id) });
      }
    } else if (hit && hit.type.startsWith("ref")) {
      const ref = this.refById(hit.id);
      if (ref) {
        this.selectedType = "ref";
        this.selectedId = ref.id;
        this.renderTimeline();
        this.buildInspector();
        items.push({ label: "▶ Preview", fn: () => this.previewRef(ref.id) });
        items.push({ label: ref.timed ? "📥 Move to library" : "📌 Place on timeline", fn: () => ref.timed ? this.moveRefToLibrary(ref.id) : this.placeRefOnTimeline(ref.id) });
        items.push({ label: ref.role === "source" ? "🎭 Role: Mood donor" : "🎬 Role: Clip being edited", fn: () => { ref.role = ref.role === "source" ? "reference" : "source"; this.commitChanges(); this.buildInspector(); } });
        items.push({ sep: true });
        items.push({ label: "🗑 Delete reference", danger: true, fn: () => this.deleteRef(ref.id) });
      }
    } else {
      /* empty space: import + grab from library */
      const track = this.trackForY(y);
      items.push({ sub: "Import → " + (track ? track.toUpperCase() : "TIMELINE") });
      [["picture", "Picture"], ["video", "Video"], ["audio", "Audio"]].forEach(([k, l]) => {
        items.push({ label: "⬆ " + l + "…", fn: () => this.pickFiles(k) });
      });
      const lib = this.state.refs.filter(r => !r.timed);
      if (lib.length) {
        items.push({ sep: true });
        items.push({ sub: "Grab from library (at this time)" });
        lib.forEach(r => {
          const tag = this.globalTags()[r.id] || (r.name || r.file || r.kind);
          items.push({
            label: "🧷 " + tag,
            fn: () => { const sec = Math.max(0, this.secondsAt(x)); this.placeRefOnTimeline(r.id, sec); },
          });
        });
      }
      const shotsAt = this.state.shots.filter(s => y >= SHOT_TRACK_Y && y <= SHOT_TRACK_Y + TRACK_H);
      if (shotsAt.length) {
        items.push({ sep: true });
        items.push({ label: "✂ Split nearest shot here", fn: () => {
          const sec = this.snapTime(this.secondsAt(x));
          const near = this.state.shots
            .map(s => ({ s, d: Math.min(Math.abs(sec - s.start), Math.abs(sec - (s.start + s.duration))) }))
            .sort((a, b) => a.d - b.d)[0];
          if (near && near.s) { this.playhead = sec; this.splitShot(near.s.id); }
        } });
      }
    }
    this.openContextMenu(items, e.clientX, e.clientY);
  }

  openContextMenu(items, x, y) {
    this.closeContextMenu();
    const m = document.createElement("div");
    m.className = "chaotic-ctx";
    items.forEach(it => {
      if (it.sep) {
        const s = document.createElement("div");
        s.className = "chaotic-ctx-sep";
        m.appendChild(s);
        return;
      }
      if (it.sub) {
        const s = document.createElement("div");
        s.className = "chaotic-ctx-sub";
        s.textContent = it.sub;
        m.appendChild(s);
        return;
      }
      const d = document.createElement("div");
      d.className = "chaotic-ctx-item" + (it.danger ? " danger" : "");
      d.textContent = it.label;
      d.addEventListener("click", () => { this.closeContextMenu(); it.fn(); });
      m.appendChild(d);
    });
    document.body.appendChild(m);
    m.style.display = "block";
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + "px";
    this._ctxMenu = m;
    setTimeout(() => {
      this._ctxClose = ev => { if (this._ctxMenu && !this._ctxMenu.contains(ev.target)) this.closeContextMenu(); };
      document.addEventListener("mousedown", this._ctxClose);
    }, 0);
  }

  closeContextMenu() {
    if (this._ctxMenu) { this._ctxMenu.remove(); this._ctxMenu = null; }
    if (this._ctxClose) { document.removeEventListener("mousedown", this._ctxClose); this._ctxClose = null; }
  }

  deleteShot(id) {
    this.state.shots = this.state.shots.filter(s => s.id !== id);
    if (this.selectedId === id) { this.selectedId = null; this.selectedType = null; }
    this.commitChanges();
    this.buildInspector();
  }

  deleteRef(id) {
    this.state.refs = this.state.refs.filter(r => r.id !== id);
    if (this.selectedId === id) { this.selectedId = null; this.selectedType = null; }
    this.commitChanges();
    this.buildInspector();
  }

  splitShot(id) {
    const shot = this.shotById(id);
    if (!shot) return;
    const at = this.snapTime(this.playhead != null ? this.playhead : shot.start);
    if (at <= shot.start + MIN_DURATION || at >= shot.start + shot.duration - MIN_DURATION) {
      this.updateStatus("Move the playhead inside the shot first, then split.");
      return;
    }
    const b = this.normalizeShot({ id: uid("shot"), start: at, duration: shot.start + shot.duration - at, text: shot.text, format: shot.format }, this.state.shots.length);
    shot.duration = at - shot.start;
    this.state.shots.push(b);
    this.commitChanges();
    this.renderTimeline();
    this.updateStatus("Shot split at " + at.toFixed(2) + "s — both halves keep the same prompt.");
  }

  duplicateShot(id) {
    const shot = this.shotById(id);
    if (!shot) return;
    let start = shot.start + shot.duration;
    if (this.state.overlap_lock) start = this.avoidShotOverlap({ id: uid("shot"), duration: shot.duration }, start);
    const copy = this.normalizeShot({ id: uid("shot"), start, duration: shot.duration, text: shot.text, format: shot.format }, this.state.shots.length);
    this.state.shots.push(copy);
    this.selectedType = "shot";
    this.selectedId = copy.id;
    this.commitChanges();
    this.buildInspector();
    this.updateStatus("Shot duplicated.");
  }

  /* ---------------- file import ---------------- */
  pickFiles(kind) {
    this.fileInput.accept = kind === "picture" ? "image/*" : kind === "audio" ? "audio/*" : "video/*";
    this.fileInput.onchange = () => {
      const files = Array.from(this.fileInput.files || []);
      files.forEach(f => this.importFile(f, kind, null));
      this.fileInput.value = "";
    };
    this.fileInput.click();
  }

  onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    const dt = e.dataTransfer;
    if (!dt) return;
    const hasFiles = dt.types.includes("Files");
    const hasLib = dt.types.includes("text/chaotic-lib");
    if (!hasFiles && !hasLib) return;
    if (e.target && this.libraryPanel && this.libraryPanel.contains(e.target)) return;
    const rect = this.wrapper.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const kind = this.trackForY(y) === "audio" ? "audio" : this.trackForY(y) === "video" ? "video" : "picture";
    if (!hasFiles) return;  // library cards drop without a ghost preview
    if (!this._ghost || this._ghost.kind !== kind) {
      this._ghost = { kind, x0: 0, x1: 1 };
    }
    const { x } = this.getMousePos(e);
    const w = this.canvas.clientWidth || 1;
    const sec = this.secondsAt(x);
    this._ghost.x0 = this.xAt(Math.max(0, sec - 1));
    this._ghost.x1 = this.xAt(Math.max(0, sec - 1) + 2);
    this.renderTimeline();
  }

  onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const dt = e.dataTransfer;
    const libId = dt ? dt.getData("text/chaotic-lib") : "";
    if (libId) {
      if (e.target && this.libraryPanel && this.libraryPanel.contains(e.target)) {
        this._ghost = null;
        return;
      }
      const { x } = this.getMousePos(e);
      const sec = Math.max(0, this.secondsAt(x));
      this._ghost = null;
      this.placeRefOnTimeline(libId, sec);
      this.updateStatus(`Library reference placed on the timeline at ${sec.toFixed(2)}s — drag its trim handles or the whole block to fine-tune.`);
      return;
    }
    const files = Array.from((dt && dt.files) || []);
    if (e.target && this.libraryPanel && this.libraryPanel.contains(e.target)) {
      /* dropped onto the reference library → untimed ref */
      this._ghost = null;
      files.forEach(f => this.importFile(f, this.kindOfFile(f), null, true));
      return;
    }
    const rect = this.wrapper.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const kind = this.trackForY(y) === "audio" ? "audio" : this.trackForY(y) === "video" ? "video" : "picture";
    this._ghost = null;
    const { x } = this.getMousePos(e);
    const start = Math.max(0, this.secondsAt(x));
    files.forEach(f => this.importFile(f, kind, start));
  }

  async importFile(file, kind, start, asLibrary) {
    try {
      const body = new FormData();
      body.append("image", file);
      const resp = await api.fetchApi("/upload/image", { method: "POST", body });
      if (resp.status !== 200) return;
      const data = await resp.json();
      const sub = data.subfolder || "";
      const path = sub ? sub + "/" + data.name : data.name;
      const url = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=input&subfolder=${encodeURIComponent(sub)}`);

      const ref = this.normalizeRef({
        id: uid("ref"),
        kind,
        file: path,
        name: file.name,
        start: asLibrary ? 0 : (start != null ? start : this.duration),
        duration: 3,
        tag_type: kind === "picture" ? "picture" : kind === "subject" ? "subject" : undefined,
        role: "reference",
        timed: !asLibrary,
      }, this.state.refs.length);

      if (kind === "picture" || kind === "subject") {
        ref.duration = 3;
        ref.thumb = url;
        this.state.refs.push(ref);
        this.commitChanges();
      } else if (kind === "video") {
        await this.probeVideo(file, ref, url);
        this.state.refs.push(ref);
        this.commitChanges();
      } else if (kind === "audio") {
        await this.probeAudio(file, ref);
        this.state.refs.push(ref);
        this.commitChanges();
      }
      if (asLibrary) {
        this.updateStatus("Added to reference library.");
        return;
      }
      this.selectedType = "ref";
      this.selectedId = ref.id;
      this.buildInspector();
    } catch (err) {
      console.error("[ChaoticDirector] import failed", err);
      this.updateStatus("Import failed: " + (err && err.message ? err.message : err));
    }
  }

  probeVideo(file, ref, url) {
    return new Promise(resolve => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      v.onloadedmetadata = () => {
        ref.duration = Math.max(MIN_DURATION, v.duration || 3);
        v.currentTime = Math.min(0.1, (v.duration || 0) * 0.02);
        v.onseeked = () => {
          const c = document.createElement("canvas");
          c.width = 120; c.height = 68;
          try {
            c.getContext("2d").drawImage(v, 0, 0, 120, 68);
            ref.thumb = c.toDataURL("image/jpeg", 0.7);
          } catch (e) { ref.thumb = url; }
          resolve();
        };
        v.ontimeupdate = () => {};
      };
      v.onerror = () => { ref.duration = 3; resolve(); };
      v.src = url;
    });
  }

  probeAudio(file, ref) {
    return new Promise(resolve => {
      file.arrayBuffer().then(buf => {
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        actx.decodeAudioData(buf, buffer => {
          ref.duration = Math.max(MIN_DURATION, buffer.duration || 1);
          const data = buffer.getChannelData(0);
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
          ref.peaks = peaks;
          resolve();
        }, () => resolve());
      }, () => resolve());
    });
  }

  /* ---------------- actions ---------------- */
  addShot() {
    let start = 0;
    this.state.shots.forEach(s => { start = Math.max(start, s.start + s.duration); });
    start = this.snapTime(start);
    const shot = this.normalizeShot({ id: uid("shot"), start, duration: this.snapTime(3), text: "[Shot N] Describe the shot...", format: "auto" }, this.state.shots.length);
    this.state.shots.push(shot);
    this.selectedType = "shot";
    this.selectedId = shot.id;
    this.commitChanges();
    this.buildInspector();
  }

  toggleProjectPanel() {
    this.projectPanel.classList.toggle("open");
    if (this.projectPanel.classList.contains("open")) this.buildProjectPanel();
    this.recomputeSize();
  }

  toggleChunkHint() {
    this.updateStatus(this.chunkModeWidget && this.chunkModeWidget.value === "auto"
      ? "Auto chunk size: learned from VRAM probes + previous successful runs this session."
      : "Dashed lines = predicted chunk cuts (from chunk_seconds). Drag a dashed line or a shot edge to pin an exact cut (solid gold).");
  }

  copyJSON() {
    const text = this.serialize();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => this.updateStatus("Timeline JSON copied to clipboard."));
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      this.updateStatus("Timeline JSON copied to clipboard.");
    }
  }

  /* ---------------- reference library ---------------- */
  toggleLibraryPanel() {
    this.libraryPanel.classList.toggle("open");
    if (this.libraryPanel.classList.contains("open")) {
      this.buildLibraryPanel();
      this.refreshLibraryGrid();
    }
    this.recomputeSize();
  }

  buildLibraryPanel() {
    const body = this.libraryPanel.querySelector(".chaotic-collapse-body");
    body.innerHTML = "";
    const drop = document.createElement("div");
    drop.className = "chaotic-lib-drop";
    drop.textContent = "Drop images / videos / audio here — they become library references, never part of the timeline.";
    drop.addEventListener("click", () => this.pickAnyFiles());
    drop.addEventListener("dragover", e => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.add("drag-over");
      this._ghost = null;
      this.renderTimeline();
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop.addEventListener("drop", e => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove("drag-over");
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      files.forEach(f => this.importFile(f, this.kindOfFile(f), null, true));
    });
    body.appendChild(drop);
    const hint = document.createElement("div");
    hint.className = "chaotic-lib-hint";
    hint.textContent = "Library refs are always available to every shot as <Picture N>/<Video N>/<Audio N> — use them to keep look-and-feel consistent without cluttering the timeline.";
    body.appendChild(hint);
    this.libraryGrid = document.createElement("div");
    this.libraryGrid.className = "chaotic-lib-grid";
    body.appendChild(this.libraryGrid);
    this._librarySig = null;
    this.refreshLibraryGrid();
  }

  kindOfFile(file) {
    if (!file || !file.type) return "picture";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    return "picture";
  }

  pickAnyFiles() {
    this.fileInput.accept = "image/*,video/*,audio/*";
    this.fileInput.onchange = () => {
      const files = Array.from(this.fileInput.files || []);
      files.forEach(f => this.importFile(f, this.kindOfFile(f), null, true));
      this.fileInput.value = "";
    };
    this.fileInput.click();
  }

  refreshLibraryGrid() {
    if (!this.libraryGrid) return;
    const untimed = this.state.refs.filter(r => !r.timed);
    const sig = untimed.map(r => r.id).join(",");
    if (sig === this._librarySig) return;
    this._librarySig = sig;
    this.libraryGrid.innerHTML = "";
    if (untimed.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chaotic-lib-empty";
      empty.textContent = "No library references yet.";
      this.libraryGrid.appendChild(empty);
      return;
    }
    const tags = this.globalTags();
    untimed.forEach(ref => {
      const card = document.createElement("div");
      card.className = "chaotic-lib-card";
      card.draggable = true;
      card.title = "Drag onto the timeline to place it, or use Place ▸";
      card.addEventListener("dragstart", e => {
        if (e.target && e.target.classList && (e.target.classList.contains("chaotic-lib-strength") || e.target.classList.contains("chaotic-btn"))) {
          e.preventDefault();   /* dragging the slider/buttons must not drag the card */
          return;
        }
        e.dataTransfer.setData("text/chaotic-lib", ref.id);
        e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("mousedown", e => {
        if (e.target && e.target.classList && e.target.classList.contains("chaotic-lib-strength")) e.stopPropagation();
      });
      let thumb;
      if (ref.kind === "audio") {
        thumb = document.createElement("canvas");
        thumb.className = "chaotic-lib-thumb";
        thumb.width = 52;
        thumb.height = 34;
        this.drawWaveform(thumb, ref.peaks || this.fakePeaks());
      } else {
        thumb = document.createElement("img");
        thumb.className = "chaotic-lib-thumb";
        thumb.alt = "";
        if (ref.thumb) thumb.src = ref.thumb;
        else if (ref.file) thumb.src = this.viewUrl(ref.file);
      }
      const meta = document.createElement("div");
      meta.className = "chaotic-lib-meta";
      const name = document.createElement("div");
      name.className = "chaotic-lib-name";
      name.textContent = (ref.name || ref.file || ref.kind) + (ref.kind === "video" && ref.role === "source" ? " · [edit]" : "");
      name.title = ref.file || ref.name || "";
      const tag = document.createElement("div");
      tag.className = "chaotic-lib-tag";
      const gtag = tags[ref.id] || (ref.kind === "subject" ? (this.shorthands()[ref.id] || "") : "");
      tag.textContent = gtag + (ref.kind === "subject" && this.shorthands()[ref.id] ? " / " + this.shorthands()[ref.id] : "");
      meta.appendChild(name);
      meta.appendChild(tag);
      const strength = document.createElement("input");
      strength.className = "chaotic-lib-strength";
      strength.type = "range";
      strength.min = "0";
      strength.max = "1";
      strength.step = "0.05";
      strength.value = ref.strength;
      strength.title = "Strength: " + ref.strength.toFixed(2);
      strength.addEventListener("input", () => {
        ref.strength = Number(strength.value);
        strength.title = "Strength: " + ref.strength.toFixed(2);
        this.commitChanges();
      });
      const placeBtn = document.createElement("button");
      placeBtn.className = "chaotic-btn";
      placeBtn.textContent = "Place ▸";
      placeBtn.title = "Place on the timeline at the playhead (or drag the card onto the timeline)";
      placeBtn.addEventListener("click", () => this.placeRefOnTimeline(ref.id));
      const suggestBtn = document.createElement("button");
      suggestBtn.className = "chaotic-btn";
      suggestBtn.textContent = "→ prompt";
      suggestBtn.title = "Insert this reference's tag into the selected shot's prompt text";
      suggestBtn.addEventListener("click", () => this.suggestToPrompt(ref.id));
      const del = document.createElement("button");
      del.className = "chaotic-btn danger";
      del.textContent = "✕";
      del.addEventListener("click", () => {
        this.state.refs = this.state.refs.filter(r => r.id !== ref.id);
        if (this.selectedId === ref.id) { this.selectedId = null; this.selectedType = null; }
        this.commitChanges();
        this.buildInspector();
      });
      card.appendChild(thumb);
      card.appendChild(meta);
      card.appendChild(strength);
      card.appendChild(placeBtn);
      card.appendChild(suggestBtn);
      card.appendChild(del);
      this.libraryGrid.appendChild(card);
    });
  }

  maybeRefreshLibrary() {
    const untimed = this.state.refs.filter(r => !r.timed);
    const sig = untimed.map(r => r.id).join(",");
    if (sig !== this._librarySig) this.refreshLibraryGrid();
  }

  moveRefToLibrary(id) {
    const ref = this.refById(id);
    if (!ref) return;
    ref.timed = false;
    this.commitChanges();
    this.buildInspector();
  }

  placeRefOnTimeline(id, start) {
    const ref = this.refById(id);
    if (!ref) return;
    const s = this.snapTime(start != null ? Math.max(0, start) : (this.playhead != null ? Math.max(0, this.playhead) : 0));
    ref.timed = true;
    ref.start = Math.max(0, Math.min(s, Math.max(0, this.duration - 0.5)));
    ref.duration = Math.max(ref.duration, 3);
    this.selectedType = "ref";
    this.selectedId = ref.id;
    this.commitChanges();
    this.buildInspector();
  }

  suggestToPrompt(refId) {
    const ref = this.refById(refId);
    if (!ref) return;
    const tag = this.globalTags()[refId];
    if (!tag) { this.updateStatus("This reference has no tag yet."); return; }
    const shot = this.selectedType === "shot"
      ? (this.state.shots || []).find(s => s.id === this.selectedId)
      : null;
    if (!shot) {
      this.updateStatus(`Select a shot on the prompt track, then click → prompt again to insert ${tag}.`);
      return;
    }
    shot.text = ((shot.text || "").replace(/\s+$/, "")) + " " + tag;
    this.commitChanges();
    this.buildInspector();
    this.updateStatus(`Added ${tag} to the selected shot's prompt — the library ref now feeds that shot.`);
  }

  /* ---------------- scrub preview ---------------- */
  buildPreviewStrip() {
    this.previewPanel = document.createElement("div");
    this.previewPanel.className = "chaotic-panel";
    const title = document.createElement("div");
    title.className = "chaotic-panel-title";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = "Preview / Scrub";
    this.previewLabel = document.createElement("span");
    this.previewLabel.style.color = "#9fd6ff";
    this.previewLabel.textContent = "";
    title.appendChild(titleSpan);
    title.appendChild(this.previewLabel);
    this.previewPanel.appendChild(title);

    this.previewStage = document.createElement("div");
    this.previewStage.className = "chaotic-preview-stage";
    this.previewVideo = document.createElement("video");
    this.previewVideo.muted = false;   /* preview should play audio — toggle available via 🔊 */
    this.previewVideo.playsInline = true;
    this.previewVideo.preload = "auto";
    this.previewVideo.style.display = "none";
    this.previewImg = document.createElement("img");
    this.previewImg.alt = "";
    this.previewImg.style.display = "none";
    this.previewHint = document.createElement("div");
    this.previewHint.className = "chaotic-preview-hint";
    this.previewHint.textContent = "Drag on the ruler to scrub — the video / picture / audio under the playhead appears here. Select a ref and press Preview to jump.";
    this.previewWave = document.createElement("canvas");
    this.previewWave.className = "chaotic-preview-wave";
    this.previewAudio = document.createElement("audio");
    this.previewAudio.preload = "auto";
    this.previewAudio.addEventListener("timeupdate", () => this.onPreviewAudioTime());
    this.previewAudio.addEventListener("play", () => this.previewPlayBtn.classList.add("playing"));
    this.previewAudio.addEventListener("pause", () => this.previewPlayBtn.classList.remove("playing"));
    this.previewAudio.addEventListener("loadedmetadata", () => this.onPreviewAudioMetadata());
    this.previewStage.appendChild(this.previewVideo);
    this.previewStage.appendChild(this.previewImg);
    this.previewStage.appendChild(this.previewWave);
    this.previewStage.appendChild(this.previewAudio);
    this.previewStage.appendChild(this.previewHint);
    this.previewPanel.appendChild(this.previewStage);

    const controls = document.createElement("div");
    controls.className = "chaotic-preview-controls";
    this.previewPlayBtn = document.createElement("button");
    this.previewPlayBtn.className = "chaotic-play-btn";
    this.previewPlayBtn.textContent = "▶";
    this.previewPlayBtn.addEventListener("click", () => this.togglePreviewPlay());
    this.previewSeek = document.createElement("input");
    this.previewSeek.className = "chaotic-preview-seek";
    this.previewSeek.type = "range";
    this.previewSeek.min = "0";
    this.previewSeek.max = "100";
    this.previewSeek.value = "0";
    this.previewSeek.addEventListener("input", () => this.onPreviewSeek());
    this.previewTime = document.createElement("span");
    this.previewTime.className = "chaotic-preview-time";
    this.previewTime.textContent = "--:--.--- / --:--.---";
    const copyRefBtn = this.btn("⧉ Copy to ref", () => this.copyPreviewToReference());
    copyRefBtn.title = "copy the preview frame at the playhead into the reference library";
    this.previewMuteBtn = this.btn("🔊", () => this.togglePreviewMute());
    this.previewMuteBtn.title = "mute / unmute the preview audio";
    controls.appendChild(this.previewPlayBtn);
    controls.appendChild(this.previewSeek);
    controls.appendChild(this.previewTime);
    controls.appendChild(this.previewMuteBtn);
    controls.appendChild(copyRefBtn);
    this.previewPanel.appendChild(controls);

    this.previewVideo.addEventListener("timeupdate", () => this.onPreviewTime());
    this.previewVideo.addEventListener("loadedmetadata", () => this.onPreviewMetadata());
    this.previewVideo.addEventListener("play", () => this.previewPlayBtn.classList.add("playing"));
    this.previewVideo.addEventListener("pause", () => this.previewPlayBtn.classList.remove("playing"));
  }

  copyPreviewToReference() {
    const src = this.previewVideo && this.previewVideo.src && this.previewVideo.readyState >= 1
      ? this.previewVideo
      : (this.previewImg && this.previewImg.src && this.previewImg.naturalWidth > 0 ? this.previewImg : null);
    if (!src) {
      this.updateStatus("Scrub to a video or picture in the Preview first, then Copy to ref.");
      return;
    }
    const at = Math.round(this.playhead * 100) / 100;
    (async () => {
      try {
        const c = document.createElement("canvas");
        const w = src.videoWidth || src.naturalWidth || 640;
        const h = src.videoHeight || src.naturalHeight || 360;
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(src, 0, 0, w, h);
        const dataUrl = c.toDataURL("image/png");
        /* persist it like any imported picture: upload to ComfyUI, store the path */
        let file = "";
        let url = null;
        if (typeof fetch === "function") {
          const blob = await (await fetch(dataUrl)).blob();
          const body = new FormData();
          body.append("image", blob, "director_frame.png");
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status === 200) {
            const data = await resp.json();
            const sub = data.subfolder || "";
            file = sub ? sub + "/" + data.name : data.name;
            url = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=input&subfolder=${encodeURIComponent(sub)}`);
          }
        }
        const ref = this.normalizeRef({
          id: uid("ref"),
          kind: "picture",
          file,
          name: "frame @" + at + "s",
          start: 0,
          duration: 3,
          tag_type: "picture",
          role: "reference",
          strength: 0.9,
          timed: false,
          thumb: url || dataUrl,
        }, this.state.refs.length);
        this.state.refs.push(ref);
        this.commitChanges();
        this.updateStatus("Preview frame copied to the reference library — its <Picture N> tag is auto-assigned and can be dragged into any prompt.");
      } catch (err) {
        console.error("[ChaoticDirector] copy to ref failed", err);
        this.updateStatus("Copy to ref failed: " + (err && err.message ? err.message : err));
      }
    })();
  }

  async importCrops() {
    try {
      const resp = await api.fetchApi("/chaotic_h3/crops");
      if (resp.status !== 200) {
        this.updateStatus("Could not load exported crops (" + resp.status + ").");
        return;
      }
      const data = await resp.json();
      const crops = (data && data.crops) || [];
      if (!crops.length) {
        this.updateStatus("No exported crops found — copy crops in Chaotic H3 Video Edit, then press ⤴ Export crops there.");
        return;
      }
      let added = 0;
      let skipped = 0;
      for (const c of crops) {
        if (!c || !c.file) continue;
        if (this.state.refs.some(r => r.kind === "picture" && r.file === c.file)) {
          skipped++; // already in the library — never duplicate a card
          continue;
        }
        const seg = String(c.file).split("/");
        const name = seg.pop();
        const sub = seg.join("/");
        const url = api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(sub)}`);
        const at = c.at != null ? c.at : 0;
        const ref = this.normalizeRef({
          id: uid("ref"),
          kind: "picture",
          file: c.file,
          name: c.note ? c.note : "crop @" + at + "s",
          start: 0,
          duration: 3,
          tag_type: "picture",
          role: "reference",
          strength: 0.9,
          timed: false,
          thumb: url,
        }, this.state.refs.length);
        this.state.refs.push(ref);
        added++;
      }
      if (added) {
        this.commitChanges();
        this.renderTimeline();
      }
      const msg = skipped > 0
        ? "Imported " + added + " crop(s) — " + skipped + " already in the library, skipped."
        : "Imported " + added + " crop(s) into the reference library — each <Picture N> card can be dragged into any prompt or onto the timeline.";
      this.updateStatus(msg);
    } catch (e) {
      this.updateStatus("Import crops failed: " + (e && e.message ? e.message : e));
    }
  }

  previewRefForPlayhead(sec) {
    if (sec == null) return null;
    for (let i = this.state.refs.length - 1; i >= 0; i--) {
      const ref = this.state.refs[i];
      if (!ref.timed) continue;
      if (ref.kind !== "video" && ref.kind !== "picture" && ref.kind !== "subject" && ref.kind !== "audio") continue;
      if (sec >= ref.start - 1e-6 && sec < ref.start + ref.duration + 1e-6) return ref;
    }
    return null;
  }

  updatePreview() {
    const sec = this.playhead;
    const ref = this.previewRefForPlayhead(sec);
    if (!ref) {
      this._previewRefId = null;
      if (this.previewVideo.src) this.previewVideo.pause();
      if (this.previewAudio.src) this.previewAudio.pause();
      this.previewVideo.style.display = "none";
      this.previewImg.style.display = "none";
      this.previewWave.style.display = "none";
      this.previewHint.style.display = "block";
      this.previewLabel.textContent = "";
      this.previewTime.textContent = "--:--.--- / --:--.---";
      this.previewSeek.value = "0";
      this.previewPlayBtn.classList.remove("playing");
      return;
    }
    const tags = this.globalTags();
    this.previewLabel.textContent = (tags[ref.id] || "") + " · " + (ref.name || ref.file || "");
    this.previewHint.style.display = "none";

    if (ref.kind === "video") {
      this.previewImg.style.display = "none";
      this.previewVideo.style.display = "block";
      if (this._previewRefId !== ref.id) {
        this._previewRefId = ref.id;
        const url = this.viewUrl(ref.file);
        if (url) {
          this.previewVideo.src = url;
          this.previewVideo.load();
        }
      }
      const trimStart = Number(ref.trim_start) || 0;
      const mediaEnd = ref.trim_end != null ? Number(ref.trim_end) : trimStart + ref.duration;
      const target = trimStart + (sec - ref.start);
      if (this.previewVideo.duration && !Number.isNaN(this.previewVideo.duration)) {
        const clamped = clamp(target, trimStart, mediaEnd);
        if (Math.abs(this.previewVideo.currentTime - clamped) > 0.05) {
          this.previewVideo.currentTime = clamped;
        }
        this.previewSeek.max = Math.max(0, mediaEnd - trimStart);
        this.previewSeek.value = String(clamp(clamped - trimStart, 0, mediaEnd - trimStart));
        this.updatePreviewTime(clamped, mediaEnd);
      }
    } else if (ref.kind === "picture" || ref.kind === "subject") {
      this._previewRefId = null; // stills have no video timeline — don't leave a stale play target
      this.previewVideo.pause();
      this.previewVideo.style.display = "none";
      this.previewWave.style.display = "none";
      this.previewImg.style.display = "block";
      const src = ref.thumb || this.viewUrl(ref.file);
      if (this.previewImg.src !== src) this.previewImg.src = src;
      this.previewSeek.max = "0";
      this.previewSeek.value = "0";
      this.previewTime.textContent = "still frame";
    } else if (ref.kind === "audio") {
      this.previewVideo.pause();
      this.previewVideo.style.display = "none";
      this.previewImg.style.display = "none";
      this.previewWave.style.display = "block";
      this.previewWave.width = 360;
      this.previewWave.height = 80;
      this.drawWaveform(this.previewWave, ref.peaks || this.fakePeaks());
      if (this._previewRefId !== ref.id) {
        this._previewRefId = ref.id;
        this.previewAudio.src = this.viewUrl(ref.file);
        this.previewAudio.load();
      }
      const trimStart = Number(ref.trim_start) || 0;
      const mediaEnd = ref.trim_end != null ? Number(ref.trim_end) : trimStart + ref.duration;
      const target = trimStart + (sec - ref.start);
      if (this.previewAudio.readyState >= 1) {
        const clamped = clamp(target, trimStart, mediaEnd);
        if (Math.abs(this.previewAudio.currentTime - clamped) > 0.05) this.previewAudio.currentTime = clamped;
        this.previewSeek.max = Math.max(0, mediaEnd - trimStart);
        this.previewSeek.value = String(clamp(clamped - trimStart, 0, mediaEnd - trimStart));
        this.updatePreviewTime(clamped, mediaEnd);
      }
    }
  }

  updatePreviewTime(mediaSec, mediaEnd) {
    this.previewTime.textContent = fmtTimestamp(mediaSec) + " / " + fmtTimestamp(mediaEnd);
  }

  onPreviewMetadata() {
    const ref = this._previewRefId ? this.refById(this._previewRefId) : null;
    if (!ref || !this.previewVideo.duration) return;
    const trimStart = Number(ref.trim_start) || 0;
    const mediaEnd = ref.trim_end != null ? Number(ref.trim_end) : Math.min(trimStart + ref.duration, this.previewVideo.duration);
    this.previewSeek.max = Math.max(0, mediaEnd - trimStart);
    if (this.playhead != null && ref.timed) {
      const target = clamp(trimStart + (this.playhead - ref.start), trimStart, mediaEnd);
      this.previewVideo.currentTime = target;
      this.updatePreviewTime(target, mediaEnd);
      this.previewSeek.value = String(Math.max(0, target - trimStart));
    }
  }

  onPreviewTime() {
    const ref = this._previewRefId ? this.refById(this._previewRefId) : null;
    if (!ref || ref.kind !== "video") return;
    const trimStart = Number(ref.trim_start) || 0;
    const mediaEnd = ref.trim_end != null ? Number(ref.trim_end) : trimStart + ref.duration;
    if (this.previewVideo.currentTime >= mediaEnd - 0.03) {
      this.previewVideo.pause();
      this.previewVideo.currentTime = trimStart;
      this.previewSeek.value = "0";
      return;
    }
    if (this.previewVideo.paused) {
      /* paused: scrub already set currentTime — keep display in sync */
      this.previewSeek.value = String(Math.max(0, this.previewVideo.currentTime - trimStart));
      this.updatePreviewTime(this.previewVideo.currentTime, mediaEnd);
      return;
    }
    /* playing: follow the frame onto the timeline playhead */
    if (ref.timed && (!this._drag || this._drag.mode !== "playhead")) {
      this.playhead = ref.start + (this.previewVideo.currentTime - trimStart);
      this.renderTimeline();
    }
    this.previewSeek.value = String(Math.max(0, this.previewVideo.currentTime - trimStart));
    this.updatePreviewTime(this.previewVideo.currentTime, mediaEnd);
  }

  onPreviewSeek() {
    const ref = this._previewRefId ? this.refById(this._previewRefId) : null;
    if (!ref) return;
    const trimStart = Number(ref.trim_start) || 0;
    const mediaEnd = ref.trim_end != null ? Number(ref.trim_end) : trimStart + ref.duration;
    const t = clamp(trimStart + Number(this.previewSeek.value || 0), trimStart, mediaEnd);
    if (ref.kind === "video") this.previewVideo.currentTime = t;
    else if (ref.kind === "audio") this.previewAudio.currentTime = t;
    if (ref.timed) {
      this.playhead = ref.start + (t - trimStart);
      this.renderTimeline();
    }
    this.updatePreviewTime(t, mediaEnd);
  }

  onPreviewAudioTime() {
    const ref = this._previewRefId ? this.refById(this._previewRefId) : null;
    if (!ref || ref.kind !== "audio") return;
    const trimStart = Number(ref.trim_start) || 0;
    const mediaEnd = ref.trim_end != null ? Number(ref.trim_end) : trimStart + ref.duration;
    if (this.previewAudio.currentTime >= mediaEnd - 0.04) {
      this.previewAudio.pause();
      this.previewAudio.currentTime = trimStart;
      this.previewSeek.value = "0";
      return;
    }
    if (ref.timed && !this.previewAudio.paused && (!this._drag || this._drag.mode !== "playhead")) {
      this.playhead = ref.start + (this.previewAudio.currentTime - trimStart);
      this.renderTimeline();
    }
    this.previewSeek.value = String(Math.max(0, this.previewAudio.currentTime - trimStart));
    this.updatePreviewTime(this.previewAudio.currentTime, mediaEnd);
  }

  onPreviewAudioMetadata() {
    const ref = this._previewRefId ? this.refById(this._previewRefId) : null;
    if (!ref || ref.kind !== "audio") return;
    const trimStart = Number(ref.trim_start) || 0;
    const mediaEnd = ref.trim_end != null ? Number(ref.trim_end) : Math.min(trimStart + ref.duration, this.previewAudio.duration);
    this.previewSeek.max = Math.max(0, mediaEnd - trimStart);
    if (this.playhead != null && ref.timed) {
      const target = clamp(trimStart + (this.playhead - ref.start), trimStart, mediaEnd);
      this.previewAudio.currentTime = target;
      this.previewSeek.value = String(Math.max(0, target - trimStart));
      this.updatePreviewTime(target, mediaEnd);
    }
  }

  togglePreviewPlay() {
    if (!this._previewRefId) return;
    const ref = this.refById(this._previewRefId);
    if (!ref) return;
    if (ref.kind === "video") {
      if (this.previewVideo.paused) {
        this.previewVideo.play().catch(() => {});
      } else {
        this.previewVideo.pause();
      }
    } else if (ref.kind === "audio") {
      if (this.previewAudio.paused) {
        this.previewAudio.play().catch(() => {});
      } else {
        this.previewAudio.pause();
      }
    } else {
      this.updateStatus("Stills have no audio — scrub to a video or audio ref to play.");
    }
  }

  togglePreviewMute() {
    const m = this.previewVideo.muted;
    this.previewVideo.muted = !m;
    this.previewAudio.muted = !m;
    this.previewMuteBtn.textContent = m ? "🔊" : "🔇";
    this.previewMuteBtn.title = m ? "mute / unmute the preview audio" : "preview audio muted";
  }

  previewRef(id) {
    const ref = this.refById(id);
    if (!ref) return;
    this.previewHint.style.display = "none";
    const label = (this.globalTags()[ref.id] || "") + " · " + (ref.name || ref.file || "");
    if (ref.kind === "picture" || ref.kind === "subject") {
      /* still: show it, no play */
      this._previewRefId = ref.id;
      this.previewVideo.pause();
      this.previewAudio.pause();
      this.previewVideo.style.display = "none";
      this.previewWave.style.display = "none";
      this.previewImg.style.display = "block";
      this.previewImg.src = ref.thumb || this.viewUrl(ref.file);
      this.previewLabel.textContent = label;
      this.previewTime.textContent = "still frame";
      this.previewSeek.max = "0";
      this.previewSeek.value = "0";
      this.updateStatus("Picture preview — scrub to a video/audio ref to hear sound.");
      return;
    }
    if (ref.timed) {
      /* jump the playhead to the ref and start playing */
      this.setPlayhead(ref.start + 0.05);
      this.togglePreviewPlay();
      return;
    }
    /* library video / audio: load it standalone and PLAY */
    this._previewRefId = ref.id;
    this.previewImg.style.display = "none";
    this.previewLabel.textContent = label;
    const url = this.viewUrl(ref.file);
    if (ref.kind === "audio") {
      this.previewVideo.pause();
      this.previewVideo.style.display = "none";
      this.previewWave.style.display = "block";
      this.previewWave.width = 360;
      this.previewWave.height = 100;
      this.drawWaveform(this.previewWave, ref.peaks || this.fakePeaks());
      if (url) { this.previewAudio.src = url; this.previewAudio.load(); }
      const play = () => this.previewAudio.play().catch(() => {});
      if (this.previewAudio.readyState >= 1) play();
      else this.previewAudio.addEventListener("loadeddata", play, { once: true });
    } else {
      this.previewWave.style.display = "none";
      this.previewVideo.style.display = "block";
      if (url) {
        this.previewVideo.src = url;
        this.previewVideo.load();
      }
      const play = () => this.previewVideo.play().catch(() => {});
      if (this.previewVideo.readyState >= 1) play();
      else this.previewVideo.addEventListener("loadeddata", play, { once: true });
    }
    this.updateStatus("Previewing the library reference — press ▶ to replay.");
  }

  /* ---------------- playhead + render window ---------------- */
  setPlayhead(sec) {
    this.playhead = clamp(sec, 0, this.duration);
    this.updatePreview();
    this.renderTimeline();
  }

  setRenderIn() {
    if (this.playhead == null) {
      this.updateStatus("Drag on the ruler to set the playhead, then press IN.");
      return;
    }
    this.renderIn = clamp(this.playhead, 0, this.renderOut != null ? this.renderOut : this.duration);
    if (this.renderOut != null && this.renderIn >= this.renderOut) this.renderIn = Math.max(0, this.renderOut - 0.05);
    this.commitChanges();
  }

  setRenderOut() {
    if (this.playhead == null) {
      this.updateStatus("Drag on the ruler to set the playhead, then press OUT.");
      return;
    }
    this.renderOut = clamp(this.playhead, this.renderIn != null ? this.renderIn : 0, this.duration);
    if (this.renderIn != null && this.renderOut <= this.renderIn) this.renderOut = Math.min(this.duration, this.renderIn + 0.05);
    this.commitChanges();
  }

  clearRenderRange() {
    this.renderIn = null;
    this.renderOut = null;
    this.syncRenderWidgets();
    this.commitChanges();
    this.updateStatus("Render window cleared — full timeline will render.");
  }

  renderRangeLabel() {
    if (this.renderIn == null && this.renderOut == null) return "";
    const from = this.renderIn != null ? fmtSec(this.renderIn) + "s" : "0s";
    const to = this.renderOut != null ? fmtSec(this.renderOut) + "s" : "end";
    return `RENDER ${from} → ${to}`;
  }

  /* ---------------- project save / load ---------------- */
  viewUrl(file) {
    if (!file) return "";
    const parts = file.split("/");
    const filename = parts[parts.length - 1];
    const subfolder = parts.slice(0, -1).join("/");
    return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
  }

  async saveProject() {
    const payload = this.serialize();
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: "chaotic_h3_project.json",
          types: [{ description: "Chaotic H3 Director project", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(payload);
        await writable.close();
        this.updateStatus("Project saved.");
      } else {
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "chaotic_h3_project.json";
        a.click();
        URL.revokeObjectURL(url);
        this.updateStatus("Project downloaded.");
      }
    } catch (e) {
      if (e.name !== "AbortError") console.error("[ChaoticDirector] save failed", e);
    }
  }

  async loadProject() {
    const apply = text => {
      try {
        const data = JSON.parse(text);
        let raw = data;
        if (data && typeof data === "object" && data.timeline && typeof data.timeline === "object") raw = data.timeline;
        if (typeof raw !== "object" || raw === null || !Array.isArray(raw.shots)) {
          this.updateStatus("Load failed: not a Chaotic H3 project file.");
          return;
        }
        this.applyLoaded(raw);
      } catch (e) {
        this.updateStatus("Load failed: " + (e && e.message ? e.message : e));
      }
    };
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "Chaotic H3 Director project", accept: { "application/json": [".json"] } }],
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
    } catch (e) {
      if (e.name !== "AbortError") console.error("[ChaoticDirector] load failed", e);
    }
  }

  applyLoaded(raw) {
    this.selectedId = null;
    this.selectedType = null;
    this._applyState(raw);
    this._librarySig = null;
    this._previewRefId = null;
    this.refreshLibraryGrid();
    this.buildProjectPanel();
    this.commitChanges();
    this.updateStatus("Project loaded.");
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
  name: "Chaotic.MinimaxH3Director",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "ChaoticH3Director") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      const container = document.createElement("div");
      container.style.width = "100%";
      container.style.height = "100%";

      const widget = this.addDOMWidget("chaotic_timeline", "chaotic_timeline", container, {
        getValue: () => "",
        setValue: () => {},
      });

      const self = this;
      widget.computeSize = function () {
        const width = Math.max(700, (self.size && self.size[0]) || 1100);
        const inspectorH = self._chaoticEditor && self._chaoticEditor.inspector.classList.contains("open") ? 330 : 0;
        const projectH = self._chaoticEditor && self._chaoticEditor.projectPanel.classList.contains("open") ? 560 : 36;
        const libraryH = self._chaoticEditor && self._chaoticEditor.libraryPanel && self._chaoticEditor.libraryPanel.classList.contains("open")
          ? 180 : 40;
        return [Math.max(10, width - 24), TIMELINE_H + 120 + PREVIEW_H + inspectorH + projectH + libraryH];
      };

      /* init editor after widgets are finalized */
      setTimeout(() => {
        try {
          self._chaoticEditor = new ChaoticDirectorEditor(self, container, widget);
          if (self.size && self.size[0] < 700) self.size = [1100, 720];
          container.style.height = "100%";
          widget.computeSize();
          self.setDirtyCanvas(true, true);
        } catch (err) {
          console.error("[ChaoticDirector] init failed", err);
        }
      }, 0);

      return r;
    };
  },
});
