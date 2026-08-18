// BPMN editor view. Embeds the vendored bpmn-js modeler (ADR-0013): the canvas,
// palette, and context pad come from bpmn-js; the Details panel and Deploy
// wiring are ours. Assets load lazily so non-editor pages stay light.

import { attachFeelEditor } from "./feel.js";
import { attachCodeEditor } from "./code-editor.js";
import { moduleFor } from "./powershell.js";
import { attachJSONEditor } from "./json-editor.js";
import { openDmnEditor } from "./dmn-editor.js";
import { tokenSimulationModule } from "./token-simulation.js";
import { attachCollab } from "./collab.js";
import { collectDocumentation, exportDocumentation } from "./process-doc.js";

// JOB_LANGS are the general-purpose script languages a script task can use besides
// inline FEEL (ADR-0047). Each runs on a job worker off the engine's hot path; the
// key is the language stored in <atlas:jobScript language="...">. `short` labels
// the script field, `placeholder` seeds an empty editor, and `hint` documents that
// language's input/result contract (PowerShell uses its output stream; Python and
// JavaScript assign to a variable named `result`). `icon` is a self-contained SVG
// glyph shown on the task shape in the Implement view so the executable language is
// legible at a glance — a plain bpmn:ScriptTask looks identical whatever language
// it runs (see makeImplementBadges).
const JOB_LANGS = {
  powershell: {
    label: "PowerShell (job worker)", short: "PowerShell",
    placeholder: 'Write-Output "Hallo $Vorname"',
    hint: `Runs on a PowerShell job worker, off the engine's hot path. The instance's variables are available as <code>$name</code>; the script's <b>output</b> is written back into the result variable.`,
    icon: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="0.5" y="0.5" width="15" height="15" rx="3" fill="#2c6db5"/><path d="M4 4.3 8 8 4 11.7" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11.5h3.4" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  },
  python: {
    label: "Python (job worker)", short: "Python",
    placeholder: 'result = f"Hallo {Vorname}"',
    hint: `Runs on a Python job worker, off the engine's hot path. The instance's variables are available as <code>name</code>; assign your output to a variable named <code>result</code>.`,
    icon: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M7.7 1.4c-2 0-3.4.4-3.4 1.9v1.6h3.5v.4H3.2C1.7 5.3 1 6.3 1 8.3s.7 3 2.2 3h1.1V9.4c0-1.5 1.2-2.7 2.7-2.7h3c1.2 0 2-.9 2-2.1V3.3C13.9 2 13 1.4 7.7 1.4zM5.9 2.5c.4 0 .7.3.7.7s-.3.7-.7.7-.7-.3-.7-.7.3-.7.7-.7z" fill="#3c78aa"/><path d="M8.3 14.6c2 0 3.4-.4 3.4-1.9v-1.6H8.2v-.4h4.6c1.5 0 2.2-1 2.2-3s-.7-3-2.2-3h-1.1v1.9c0 1.5-1.2 2.7-2.7 2.7h-3c-1.2 0-2 .9-2 2.1v2.2C2.1 14 3 14.6 8.3 14.6zm1.8-1.1c-.4 0-.7-.3-.7-.7s.3-.7.7-.7.7.3.7.7-.3.7-.7.7z" fill="#f6c945"/></svg>`,
  },
  javascript: {
    label: "JavaScript (job worker)", short: "JavaScript",
    placeholder: 'const result = "Hallo " + Vorname',
    hint: `Runs on a Node.js job worker, off the engine's hot path. The instance's variables are available as <code>name</code>; assign your output to a variable named <code>result</code>.`,
    icon: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#f0db4f"/><text x="8.5" y="12" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="8" font-weight="700" fill="#323330">JS</text></svg>`,
  },
};

const BPMN_CSS = [
  "vendor/bpmn/assets/diagram-js.css",
  "vendor/bpmn/assets/bpmn-js.css",
  "vendor/bpmn/assets/bpmn-font/css/bpmn-embedded.css",
];

let bpmnReady; // memoized loader promise → { BpmnJS, moddle: { zeebe, atlas } }
function loadBpmn() {
  if (bpmnReady) return bpmnReady;
  bpmnReady = new Promise((resolve, reject) => {
    for (const href of BPMN_CSS) {
      if (document.querySelector(`link[href="${href}"]`)) continue;
      const l = document.createElement("link");
      l.rel = "stylesheet"; l.href = href;
      document.head.appendChild(l);
    }
    const s = document.createElement("script");
    s.src = "vendor/bpmn/bpmn-modeler.js";
    s.onload = async () => {
      try {
        // The zeebe moddle lets bpmn-js read/write the zeebe extension elements
        // Atlas executes (zeebe:script, zeebe:taskDefinition). See ADR-0013. The
        // atlas moddle adds our own start-variable declaration (atlas:startForm),
        // which is editor metadata the engine ignores (the compiler skips unknown
        // extension elements) — it drives the typed Deploy & run form.
        const [zeebe, atlas] = await Promise.all([
          fetch("vendor/bpmn/zeebe.json").then((r) => r.json()),
          fetch("atlas-moddle.json").then((r) => r.json()),
        ]);
        resolve({ BpmnJS: window.BpmnJS, moddle: { zeebe: patchZeebeModdle(zeebe), atlas } });
      } catch (e) {
        reject(new Error("failed to load the moddle extensions: " + e.message));
      }
    };
    s.onerror = () => reject(new Error("failed to load the BPMN modeler assets"));
    document.head.appendChild(s);
  });
  return bpmnReady;
}

// patchZeebeModdle declares the handful of attributes Atlas reads from a zeebe
// extension element that the upstream descriptor does not know (ADR-0135): a
// business rule task's <zeebe:calledDecision retries="…">, the retry budget the
// compiler has always parsed there. The vendored zeebe.json stays a pristine copy of
// zeebe-bpmn-moddle (see vendor/bpmn/README.md), so the difference lives here, in
// code, where it is visible — rather than as an invisible edit to a vendored file.
// Declaring it as a plain attribute (not an atlas:-prefixed one) is what keeps the
// round-trip honest: a hand-authored retries="5" is read back into the panel.
function patchZeebeModdle(zeebe) {
  const cd = (zeebe.types || []).find((t) => t.name === "CalledDecision");
  if (cd && !(cd.properties || []).some((p) => p.name === "retries")) {
    cd.properties.push({ name: "retries", type: "String", isAttr: true });
  }
  return zeebe;
}

// newModeler/newViewer construct a bpmn-js instance with the moddle extensions
// (zeebe + atlas) wired.
function newModeler(BpmnJS, moddle, container, extraModules) {
  const opts = { container, moddleExtensions: moddle };
  if (extraModules && extraModules.length) opts.additionalModules = extraModules;
  return new BpmnJS(opts);
}

// blankXML builds an empty diagram with a UNIQUE process id. The process id is
// the identity deployments and instances are grouped by (see the Details panel),
// so a fixed "Process_new" would make every new diagram a silent new *version* of
// the same process — the previous diagram would appear lost. A per-diagram id
// keeps distinct diagrams distinct; re-opening a deployment and redeploying still
// reuses its id, which is the intended way to cut a new version.
function blankXML() {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pid = `Process_${suffix}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  id="Definitions_${suffix}" targetNamespace="http://atlas/bpmn">
  <bpmn:process id="${pid}" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="Start"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${pid}">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="180" y="160" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
}

// calleeXML builds a starter diagram for a *called* process a call activity refers
// to (ADR-0076): a single start event, keyed by the caller-chosen process id (the
// deploy/route identity), so the "＋ create new" affordance in the call-activity
// panel scaffolds the callee the caller already points at. Whitespace in the id is
// collapsed to underscores so it stays a valid BPMN id; an empty id falls back to a
// unique one, like blankXML.
function calleeXML(pid, name) {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const id = (pid || "").trim().replace(/\s+/g, "_") || `Process_${suffix}`;
  const nm = (name || id).trim();
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  id="Definitions_${suffix}" targetNamespace="http://atlas/bpmn">
  <bpmn:process id="${esc(id)}" name="${esc(nm)}" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="Start"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${esc(id)}">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="180" y="160" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
}

let current; // active modeler/viewer, destroyed on remount
let onLayoutKey; // document-level F8 handler for auto-layout, removed on remount
let liveTimer; // active live-overlay poll, cleared on remount/leave
let collab; // active live collaboration session (ADR-0103), closed on remount
// generation is bumped by cleanup() on every navigation/remount. A mount captures
// it right after its own cleanup() and re-checks it after each await, so a slow
// mount that a newer navigation has superseded bails out *before* it builds a
// second viewer or writes into the live view's DOM. Without this, the router's
// re-entrancy (hashchange fires route() again while a mount is still awaiting
// bpmn assets or the timeline) let a stale mount create a second bpmn-js canvas
// inside the current mount's #canvas and render another instance's data over it —
// two overlaid diagrams, mismatched instance keys, a leaked poll timer.
let generation = 0;

// docTitle refines the browser tab title with a loaded subject (a diagram or
// process name), matching app.js's "<subject> · Atlas" scheme so open tabs are
// distinguishable. The router sets a route-based title first; this sharpens it.
function docTitle(label) { document.title = label ? `${label} · Atlas` : "Atlas"; }

// cleanup tears down the current modeler and any live poll. app.js calls it (via
// window.__atlasCleanup) when navigating away so nothing keeps running.
export function cleanup() {
  generation++; // supersede any in-flight mount (see `generation` above)
  if (onLayoutKey) { document.removeEventListener("keydown", onLayoutKey, true); onLayoutKey = null; }
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (collab) { try { collab.close(); } catch { /* ignore */ } collab = null; }
  if (current) { try { current.destroy(); } catch { /* ignore */ } current = null; }
}
window.__atlasCleanup = cleanup;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const shortType = (t) => (t || "").replace(/^bpmn:/, "");

// isValidTtl mirrors the engine's instance-TTL parser (ADR-0085, compiler/duration.go):
// the day-and-time subset of ISO-8601 durations (P[nD]T[nH][nM][nS]), and it must be
// positive — the empty duration "P"/"PT" and an all-zero "PT0S" are rejected. Used only
// to warn while authoring; the deploy is the authority that rejects a bad value.
const isValidTtl = (s) => {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s).trim());
  if (!m) return false;
  const parts = [m[1], m[2], m[3], m[4]];
  if (parts.every((p) => p === undefined)) return false; // no components → empty duration
  return parts.some((p) => p !== undefined && Number(p) > 0); // must be strictly positive
};

// --- Variable presentation (shared by the live and replay views) ---
//
// Operators inspect an instance's variables, which can be whole JSON structures.
// These render them clearly: scalars as labeled, type-colored fields; JSON values
// as collapsible, syntax-highlighted, pretty-printed cards.

// highlightJSON pretty-prints a canonical JSON string and wraps its tokens in
// colored spans (keys, strings, numbers, booleans, null) — a tiny, dependency-
// free syntax highlighter (ADR-0012 buildless UI). It escapes first, then spans.
function highlightJSON(text) {
  let out;
  try { out = JSON.stringify(JSON.parse(text), null, 2); }
  catch { return esc(text); } // not valid JSON after all — show it verbatim
  out = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return out.replace(
    /("(?:\\.|[^"\\])*"\s*:?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
    (m) => {
      let cls = "j-num";
      if (m[0] === '"') cls = /:\s*$/.test(m) ? "j-key" : "j-str";
      else if (m === "true" || m === "false") cls = "j-bool";
      else if (m === "null") cls = "j-null";
      return `<span class="${cls}">${m}</span>`;
    });
}

// jsonSummary is the compact one-liner shown on a collapsed JSON card.
function jsonSummary(text) {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
    if (v && typeof v === "object") {
      const n = Object.keys(v).length;
      return `${n} field${n === 1 ? "" : "s"}`;
    }
    return String(v);
  } catch { return ""; }
}

// decVal reads a decision evaluation's inputs/outputs/trace. The API returns these
// as raw JSON values (json.RawMessage) — i.e. already-parsed objects/arrays — so
// they must NOT be JSON.parse'd again (parsing an object stringifies it to
// "[object Object]" and throws, which silently emptied the panel to "none"). It
// still accepts a JSON string for robustness (older payloads, tests), and falls
// back when a string can't be parsed.
function decVal(x, fallback) {
  if (x === null || x === undefined) return fallback;
  if (typeof x === "string") { try { return JSON.parse(x); } catch { return fallback; } }
  return x;
}

// Decision-trace presentation, shared with the Operations decision-detail page
// (temis Operate style): values compact, and a decision table rendered as a matrix
// with the matched rule highlighted and each cell tinted by whether its condition
// held. decTablesOf/decMatchedNums read an evaluation's (already-parsed) trace.
const decFmtVal = (v) => (v === null || v === undefined ? "null" : typeof v === "string" ? v : JSON.stringify(v));
const decCellText = (t) => { const s = (t ?? "").trim(); return s === "" || s === "-" ? "–" : s; };
const decTablesOf = (d) => { const t = decVal(d.trace, null); return (t && Array.isArray(t.tables)) ? t.tables : []; };
const decMatchedNums = (d) => {
  const nums = [];
  for (const t of decTablesOf(d)) for (const r of (t.rules || [])) if (r.matched) nums.push(r.index + 1);
  return [...new Set(nums)];
};
function decMiniTable(tt, n) {
  const matched = (tt.rules || []).filter((r) => r.matched).map((r) => r.index + 1);
  const policy = (tt.hitPolicy || "U") + (tt.aggregation ? " " + tt.aggregation : "");
  const head = matched.length ? `Rule ${matched.join(", ")} fired` : "no rule fired";
  const ins = tt.inputs || [];
  const hr = `<tr><th class="mcol-idx">#</th>${ins.map((i) =>
    `<th>${esc(i.expression)} <code>= ${esc(decFmtVal(i.value))}</code></th>`).join("")}<th>&rarr;</th></tr>`;
  const body = (tt.rules || []).map((r) => {
    const cells = ins.map((_, k) => {
      const c = r.conditions && r.conditions[k];
      const cls = c ? (c.matched ? "mcell is-ok" : "mcell is-no") : "mcell is-skip";
      return `<td class="${cls}">${c ? esc(decCellText(c.entry)) : ""}</td>`;
    }).join("");
    const out = r.matched && r.outputs ? esc(r.outputs.map(decFmtVal).join(", ")) : "";
    return `<tr class="mrule${r.matched ? " is-hit" : ""}"><td class="mcol-idx">${r.index + 1}</td>${cells}<td class="mout">${out}</td></tr>`;
  }).join("");
  return `<div class="mtable"><div class="mtable-head">${n ? `Table ${n} · ` : ""}${esc(head)}<span class="mtable-policy">${esc(policy)}</span></div>` +
    `<table class="mgrid">${hr}${body}</table></div>`;
}

// decCard renders one decision evaluation: a header, its input pills, and its result
// rows. Each result carries a "Rule N" badge; a row backed by a decision table is
// hoverable — data-dec indexes the caller's evaluation list so a shared popover can
// look the trace back up. Shared by the replay Decisions tab and the live view.
function decCard(d, i) {
  const when = d.at ? new Date(d.at / 1e6).toLocaleString() : "";
  const inEntries = Object.entries(decVal(d.inputs, {}) || {});
  const outEntries = Object.entries(decVal(d.outputs, {}) || {});
  const pills = inEntries.length
    ? `<div class="in-pills">${inEntries.map(([k, v]) => `<span class="pill-kv"><b>${esc(k)}</b> = ${esc(decFmtVal(v))}</span>`).join("")}</div>`
    : '<span class="muted">none</span>';
  const nums = decMatchedNums(d);
  const badge = nums.length ? `<span class="res-rule">Rule ${nums.join(", ")}</span>` : "";
  const hoverable = decTablesOf(d).length ? " hoverable" : "";
  const result = outEntries.length
    ? `<div class="res">${outEntries.map(([k, v], oi) =>
        `<div class="res-row${hoverable}" data-dec="${i}"${hoverable ? ' tabindex="0"' : ""}>
          <span class="res-key">${esc(k)}</span>
          <span class="res-val">${esc(decFmtVal(v))}</span>
          ${oi === 0 ? badge : ""}
        </div>`).join("")}</div>`
    : '<span class="muted">none</span>';
  return `<div class="dec-card2">
    <div class="dec-card2-h"><b>${esc(d.decisionId)}</b>${when ? ` <span class="muted">${esc(when)}</span>` : ""}</div>
    <div class="dec-sect2"><span class="dec-sect2-l">Inputs</span>${pills}</div>
    <div class="dec-sect2"><span class="dec-sect2-l">Result</span>${result}</div>
  </div>`;
}

// renderVarsBody lays out a variable list: scalars as a labeled field grid, JSON
// values as collapsible, syntax-highlighted cards. collapsed is a Set of the JSON
// variable names the operator has collapsed (persists across re-renders); the
// caller wires a delegated click on `.vj-head` to toggle it and re-render.
function renderVarsBody(list, collapsed) {
  if (!list || !list.length) return '<span class="muted">No variables yet.</span>';
  const scalars = list.filter((v) => v.kind !== "json");
  const jsons = list.filter((v) => v.kind === "json");
  let html = "";
  if (scalars.length) {
    html += `<div class="vgrid">${scalars.map((v) => {
      const cls = v.kind === "boolean" ? "bool" : v.kind === "number" ? "num" : v.kind === "null" ? "null" : "str";
      // The name gets its own full-width line (long identifiers like
      // "textfield_nachnamestring" must not wrap mid-word against the type badge);
      // the badge rides the value row, and the copy button floats in the corner so
      // it never steals width from the name.
      return `<div class="vfield"><div class="vf-head"><span class="vk" title="${esc(v.name)}">${esc(v.name)}</span></div>
        <div class="vf-val"><span class="vv ${cls}">${esc(v.value)}</span><span class="vtag">${esc(v.kind)}</span></div>
        ${copyBtn(v.value, "Copy value")}</div>`;
    }).join("")}</div>`;
  }
  html += jsons.map((v) => {
    const isCollapsed = collapsed.has(v.name);
    return `<div class="vjson${isCollapsed ? " collapsed" : ""}">
      <div class="vj-head">
        <button class="vj-toggle" data-name="${esc(v.name)}" aria-expanded="${isCollapsed ? "false" : "true"}">
          <span class="chev">&#9662;</span><span class="vk">${esc(v.name)}</span>
          <span class="vtag">json</span><span class="vj-sum">${esc(jsonSummary(v.value))}</span>
        </button>
        ${copyBtn(prettyJSON(v.value), "Copy JSON")}
      </div>
      <pre class="vj-body">${highlightJSON(v.value)}</pre>
    </div>`;
  }).join("");
  return html;
}

// copyBtn renders a small clipboard button carrying the raw text to copy in a data
// attribute; a delegated handler (bindVarCopy) does the actual write. Operators
// live in these values, so every scalar, every JSON blob and the whole set are
// one click from the clipboard.
function copyBtn(text, title) {
  return `<button class="vcopy" type="button" title="${esc(title)}" aria-label="${esc(title)}" data-copy="${esc(text)}">
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5.5 1.5h6a1 1 0 0 1 1 1v8" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="3.5" y="4.5" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
  </button>`;
}

// copyAllBtn renders a "Copy all" button that carries every variable of a set as
// one JSON object ({name: value}, JSON-typed values parsed back to structures) —
// the whole payload in one click, the shape an operator pastes into a ticket or a
// re-run. Module-level so both the Live side panel and the replay inspector share it.
function copyAllBtn(list) {
  if (!list || !list.length) return "";
  const obj = {};
  for (const v of list) {
    if (v.kind === "json") { try { obj[v.name] = JSON.parse(v.value); continue; } catch { /* keep raw */ } }
    if (v.kind === "number") { const n = Number(v.value); obj[v.name] = Number.isNaN(n) ? v.value : n; }
    else if (v.kind === "boolean") obj[v.name] = v.value === "true";
    else if (v.kind === "null") obj[v.name] = null;
    else obj[v.name] = v.value;
  }
  return `<button class="btn ghost small vcopy-all vcopy" type="button" title="Copy all variables as JSON" data-copy="${esc(JSON.stringify(obj, null, 2))}">Copy all</button>`;
}

// prettyJSON canonicalizes a JSON variable's stored string to pretty-printed form
// for copying (falling back to the raw text if it isn't valid JSON), so what lands
// on the clipboard matches what the operator sees in the card.
function prettyJSON(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return String(text); }
}

// copyText writes text to the clipboard, falling back to a hidden textarea +
// execCommand where the async Clipboard API isn't available (older browsers, or
// insecure origins). Returns a promise that resolves once the copy is attempted.
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// bindVarCopy wires the delegated click on `.vcopy` buttons inside panel: it copies
// the button's data-copy payload and flashes a brief "Copied" state on the button.
// Attach once per view; survives the panel's inner re-renders.
function bindVarCopy(panel, toast) {
  panel.addEventListener("click", async (e) => {
    const btn = e.target.closest(".vcopy");
    if (!btn || !panel.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(btn.dataset.copy || "");
    if (ok) {
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 900);
    } else if (toast) {
      toast("Copy failed", "err");
    }
  });
}

// bindJsonCards wires the delegated expand/collapse click for JSON cards inside
// panel, toggling names in collapsed and calling rerender. Attach once per view.
function bindJsonCards(panel, collapsed, rerender) {
  panel.addEventListener("click", (e) => {
    const head = e.target.closest(".vj-toggle");
    if (!head || !panel.contains(head)) return;
    const name = head.dataset.name;
    if (collapsed.has(name)) collapsed.delete(name);
    else collapsed.add(name);
    rerender();
  });
}

// editorCrumbs renders the editor's breadcrumb trail. It always offers a way
// back to the Modeler home, and — when the artifact belongs to a project — a
// link straight back to that project's workspace, so authoring an artifact
// isn't a one-way trip into the canvas (ADR-0034). `project` is {id, name} or
// null/undefined (a new/ungrouped diagram or a deployment, which has no
// project scope). The current segment is filled in with the diagram name once
// the model loads; see #crumb-current.
function editorCrumbs(project, current) {
  const sep = `<span class="crumb-sep" aria-hidden="true">›</span>`;
  const proj = project
    ? `${sep}<a href="#/modeler/p/${encodeURIComponent(project.id)}">${esc(project.name)}</a>`
    : "";
  return `<nav class="crumbs" aria-label="Breadcrumb">` +
    `<a href="#/modeler">Home</a>${proj}${sep}` +
    `<span class="crumb-current">${esc(current)}</span></nav>`;
}

export async function mountEditor(root, { api, toast, key, draftId, projectId, project }) {
  cleanup();
  const gen = generation; // this mount's token; bail if a newer navigation supersedes it

  const crumb = draftId != null ? "Draft" : key == null ? "New diagram" : "Deployment " + key;
  root.innerHTML = `
    <div class="editor">
      <div class="editor-bar">
        ${editorCrumbs(project, crumb)}
        <div class="etabs">
          <button data-tab="design" class="active">Design</button>
          <button data-tab="implement">Implement</button>
        </div>
        <div style="flex:1"></div>
        <button class="btn neutral sim-toggle" id="sim-toggle" title="Play tokens through the diagram to see how the control flow moves — no deploy, just a walkthrough" aria-pressed="false">&#9654; Token simulation</button>
        <button class="btn neutral" id="vars-toggle" title="Show the variables this diagram writes">Variables</button>
        <button class="btn neutral" id="autolayout" title="Re-flow the diagram into a clean left-to-right layout (F8)">Auto-layout</button>
        <button class="btn neutral" id="save">Save</button>
        <button class="btn neutral" id="export">Export XML</button>
        <button class="btn neutral" id="docexport" title="Publish this process as a structured PDF — the diagram plus every element's documentation and notes — as a numbered version you can share (ADR-0138)">Documentation</button>
        <button class="btn neutral" id="deploy" title="Deploy this single diagram. To ship a whole process application, use Publish on the application (ADR-0128).">Deploy</button>
      </div>
      <div class="sim-bar" id="sim-bar" hidden>
        <button class="btn play" id="sim-play">&#9654; Play</button>
        <button class="btn neutral" id="sim-step" title="Advance one token by a single step">Step</button>
        <button class="btn neutral" id="sim-reset" title="Clear all tokens">Reset</button>
        <label class="sim-speed">Speed
          <select class="speed" id="sim-speed" aria-label="Simulation speed">
            <option value="0.25">0.25&times;</option>
            <option value="0.5">0.5&times;</option>
            <option value="1" selected>1&times;</option>
            <option value="2">2&times;</option>
            <option value="4">4&times;</option>
          </select>
        </label>
        <label class="sim-auto" title="Let Play run end-to-end: gateways take their default (or every branch), and message/timer/signal events fire on their own — no clicking required.">
          <input type="checkbox" id="sim-auto"/> Auto-decide
        </label>
        <label class="sim-mi" title="How many instances a multi-instance activity runs in the simulation. A modelled fixed loop cardinality overrides this.">Instances
          <input type="number" id="sim-mi" min="1" max="20" step="1" value="3"/>
        </label>
        <span class="sim-hint" id="sim-hint"></span>
        <span style="flex:1"></span>
        <span class="sim-stats" id="sim-stats"></span>
      </div>
      <div class="start-panel" id="doc-panel" hidden>
        <label class="field"><span>Title</span>
          <input id="doc-title" placeholder="Leave empty to use the process name"/></label>
        <label class="field"><span>Note for this version</span>
          <input id="doc-note" placeholder="What changed, or what this version was signed off for"/></label>
        <div class="row">
          <button class="btn" id="doc-publish">Publish version</button>
          <button class="btn neutral" id="doc-cancel">Close</button>
          <span class="err" id="doc-err"></span>
        </div>
        <div class="doc-history" id="doc-history"></div>
      </div>
      <div class="start-panel" id="deploy-panel" hidden>
        <div id="deploy-body"></div>
        <div class="row" id="deploy-actions">
          <button class="btn" id="deploy-run">Deploy &amp; run</button>
          <button class="btn neutral" id="deploy-only">Deploy only</button>
          <button class="btn neutral" id="deploy-cancel">Cancel</button>
          <span class="err" id="deploy-err"></span>
        </div>
      </div>
      <div class="editor-body">
        <div id="canvas"></div>
        <aside class="vars-panel" id="vars-panel" hidden>
          <div class="vars-head"><b>Variables</b>
            <button class="icon-btn" id="vars-close" title="Close" aria-label="Close">✕</button></div>
          <input class="vars-filter" id="vars-filter" placeholder="Filter by name or origin…"/>
          <div class="vars-list" id="vars-list"></div>
        </aside>
        <div class="props-resizer" id="props-resizer" title="Drag to resize the properties panel"></div>
        <aside class="props" id="props">
          <div class="phead"><span class="ptype" id="p-icon">–</span>
            <div><div class="kv" id="p-typename">No selection</div><b id="p-name">—</b></div></div>
          <div class="psec" id="p-body">
            <p class="muted">Select an element to see its properties.</p>
          </div>
        </aside>
      </div>
      <div class="prob-list" id="prob-list" hidden></div>
      <div class="problems" id="problems-bar" role="button" tabindex="0"
           aria-expanded="false" aria-controls="prob-list"
           title="Show validation problems">
        <span class="badge" id="prob-count">0</span> Problems
        <span class="prob-summary" id="prob-summary"></span>
        <span style="flex:1"></span>
        <span class="prob-filters" id="prob-filters" hidden>
          <button type="button" data-sev="all" class="active">All</button>
          <button type="button" data-sev="error">Errors</button>
          <button type="button" data-sev="warning">Warnings</button>
        </span>
        <span class="muted" id="prob-version">Checked against the Atlas compiler</span>
        <span class="prob-caret" id="prob-caret" aria-hidden="true">▾</span>
      </div>
    </div>`;

  let lib;
  try {
    lib = await loadBpmn();
  } catch (e) {
    document.getElementById("canvas").innerHTML =
      `<div class="coming"><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (gen !== generation) return; // a newer navigation took over while assets loaded

  const modeler = newModeler(lib.BpmnJS, lib.moddle, root.querySelector("#canvas"), [
    tokenSimulationModule(),
  ]);
  current = modeler;
  window.__atlasModeler = modeler; // exposed for scripted/end-to-end testing

  // Load content: a saved draft, a deployed definition, or a fresh blank diagram.
  try {
    if (draftId != null) {
      const xml = await api("GET", `/api/v1/drafts/${encodeURIComponent(draftId)}/xml`);
      await modeler.importXML(typeof xml === "string" ? xml : String(xml));
    } else if (key == null) {
      await modeler.importXML(blankXML());
    } else {
      const xml = await api("GET", `/api/v1/processes/${key}/xml`);
      await modeler.importXML(typeof xml === "string" ? xml : String(xml));
    }
    modeler.get("canvas").zoom("fit-viewport");
    const pbo = rootProcess(modeler);
    if (pbo) {
      const nm = pbo.name || pbo.id || "Diagram";
      root.querySelector(".crumb-current").textContent = nm;
      docTitle(`${nm} · Modeler`);
    }
  } catch (e) {
    toast("could not open diagram: " + e.message, "err");
  }

  const rerender = wireProperties(root, modeler, api, projectId, toast);
  const refreshBadges = makeImplementBadges(root, modeler);
  refreshBadges(); // reflect the initial tab for the diagram just imported
  const refreshPoolCaptions = makePoolProcessCaptions(modeler);
  refreshPoolCaptions(); // name the process each pool runs, on the diagram just imported
  wireTabs(root, () => { rerender(); refreshBadges(); });
  wireActions(root, modeler, api, toast, projectId);
  wireEditorVars(root, modeler, api);
  wireProblems(root, modeler, api);
  wireResizer(root, modeler);
  wireTokenSim(root, modeler);

  // Only a saved draft has a stable id to key a live session on; a fresh unsaved
  // diagram or a read-only deployment does not co-edit (ADR-0103).
  if (draftId != null) collab = attachCollab(modeler, api, draftId, toast);
}

// The BPMN elements the stock bpmn-js palette can draw but the Atlas engine can't run
// yet, mapped to a plain-language reason. The Modeler uses these to flag such elements
// at author time — a canvas badge and a Problems-bar warning — so the author isn't
// surprised at Deploy/Validate. Keep in sync with the compiler's rejections and unrun
// elements (compiler/scope_compile.go, compiler/parse.go).
const UNSUPPORTED_TYPES = {
  "bpmn:ComplexGateway": "Complex gateways aren't supported yet",
  "bpmn:AdHocSubProcess": "Ad-hoc subprocesses aren't supported yet",
  "bpmn:DataStoreReference": "Data stores aren't supported yet",
};
const UNSUPPORTED_EVENT_DEFS = {};

// unsupportedReason returns why a drawn element can't run on the Atlas engine yet, or
// null if it can. It keys off the element type and any event definitions it carries.
function unsupportedReason(bo) {
  if (!bo || !bo.$type) return null;
  if (UNSUPPORTED_TYPES[bo.$type]) return UNSUPPORTED_TYPES[bo.$type];
  for (const d of (bo.eventDefinitions || [])) {
    if (UNSUPPORTED_EVENT_DEFS[d.$type]) return UNSUPPORTED_EVENT_DEFS[d.$type];
  }
  return null;
}

// wireProblems drives the Problems panel (ADR-0026): the bottom bar becomes a
// toggle that opens a filterable, element-linked list of the compiler's findings.
// Validation is the real compiler run behind POST /api/v1/validate — never a
// JS reimplementation of the rules (that is the interpret-don't-compile failure
// mode the ADR rejects) — so the panel always tells the same truth as a deploy,
// warnings included. It re-validates (debounced) as the diagram is edited, on
// import, and on demand, so a modeling smell like a disconnected end event is
// explained continuously rather than only at deploy time.
function wireProblems(root, modeler, api) {
  const bar = root.querySelector("#problems-bar");
  const listEl = root.querySelector("#prob-list");
  const countEl = root.querySelector("#prob-count");
  const summaryEl = root.querySelector("#prob-summary");
  const filtersEl = root.querySelector("#prob-filters");
  const versionEl = root.querySelector("#prob-version");
  const caretEl = root.querySelector("#prob-caret");
  if (!bar || !listEl) return;

  let problems = [];
  let filter = "all"; // all | error | warning
  let expanded = false;
  let marked = null; // element id currently highlighted on the canvas
  let seq = 0; // guards against a stale validate response overwriting a newer one
  let unsupIds = []; // overlay ids for the "can't run yet" badges we drew

  // findUnsupported walks the live model for elements the engine can't run yet (see
  // unsupportedReason) and returns them as Problems-bar warnings — author-time feedback
  // that doesn't depend on a server round-trip and catches every offender at once (the
  // compiler stops at its first rejection).
  const findUnsupported = () => {
    const out = [];
    let registry;
    try { registry = modeler.get("elementRegistry"); } catch { return out; }
    registry.forEach((el) => {
      if (el.labelTarget) return; // a label shares its target's businessObject — don't double-count
      const why = unsupportedReason(el.businessObject);
      if (why) out.push({ severity: "warning", message: why, element: el.id, rule: "unsupported-element" });
    });
    return out;
  };
  // redrawUnsupported puts a ⚠ badge on each unrunnable element (top-right, clear of the
  // Implement type badge at top-left) and reaps the previous set first.
  const redrawUnsupported = (findings) => {
    let overlays;
    try { overlays = modeler.get("overlays"); } catch { return; }
    for (const id of unsupIds) { try { overlays.remove(id); } catch { /* gone */ } }
    unsupIds = [];
    for (const f of findings) {
      try {
        unsupIds.push(overlays.add(f.element, "atlas-unsupported", {
          position: { top: -8, right: -8 },
          html: `<span class="unsup-badge" title="${esc(f.message)} — remove it or the diagram won't run">⚠</span>`,
        }));
      } catch { /* shape without graphics (mid-import) — skip */ }
    }
  };

  const SEV_LABEL = { error: "Error", warning: "Warning" };
  const sevIcon = (s) => (s === "error" ? "✕" : s === "warning" ? "!" : "•");

  const clearMark = () => {
    if (marked == null) return;
    try { modeler.get("canvas").removeMarker(marked, "atlas-problem"); } catch { /* gone */ }
    marked = null;
  };

  // Jump to and highlight a problem's element — the same select + scroll pattern
  // the variables panel uses, plus a persistent marker so the offending element
  // stays visible after the click.
  const focusElement = (id) => {
    if (!id) return;
    const el = modeler.get("elementRegistry").get(id);
    if (!el) return;
    clearMark();
    try { modeler.get("selection").select(el); } catch { /* stale */ }
    try { modeler.get("canvas").scrollToElement(el); } catch { /* older bpmn-js */ }
    try { modeler.get("canvas").addMarker(id, "atlas-problem"); marked = id; } catch { /* no marker */ }
  };

  const render = () => {
    const errors = problems.filter((p) => p.severity === "error").length;
    const warnings = problems.filter((p) => p.severity === "warning").length;
    const total = problems.length;

    countEl.textContent = String(total);
    bar.classList.toggle("has-errors", errors > 0);
    bar.classList.toggle("has-warnings", errors === 0 && warnings > 0);
    filtersEl.hidden = total === 0;
    caretEl.style.visibility = total === 0 ? "hidden" : "";

    if (total === 0) {
      summaryEl.textContent = "No problems";
    } else {
      const parts = [];
      if (errors) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
      if (warnings) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
      summaryEl.textContent = parts.join(", ");
    }

    // A collapsed panel with nothing to show stays closed; nothing to list.
    if (total === 0) { expand(false); }

    const shown = problems.filter((p) => filter === "all" || p.severity === filter);
    listEl.innerHTML = shown.length === 0
      ? `<p class="prob-empty muted">No ${filter === "all" ? "" : filter + " "}problems.</p>`
      : shown.map((p) => `<div class="prob-row prob-${esc(p.severity)}"${p.element ? ` data-el="${esc(p.element)}"` : ""}>
          <span class="prob-sev" title="${esc(SEV_LABEL[p.severity] || p.severity)}">${sevIcon(p.severity)}</span>
          <span class="prob-msg">${esc(p.message)}</span>
          ${p.element ? `<span class="prob-el" title="Element id">${esc(p.element)}</span>` : ""}
          <span class="prob-rule" title="Rule">${esc(p.rule)}</span>
        </div>`).join("");
  };

  const expand = (open) => {
    expanded = open && problems.length > 0;
    listEl.hidden = !expanded;
    bar.setAttribute("aria-expanded", String(expanded));
    bar.classList.toggle("open", expanded);
  };

  // A full compile is cheap but not free; debounce so a burst of edits triggers
  // one validate, not one per keystroke-equivalent modeling event (ADR-0026).
  let timer = null;
  const validate = async () => {
    // Client-side "can't run yet" findings first: instant canvas badges, and a fallback
    // list if the server validate can't run (not imported / offline).
    const unsupported = findUnsupported();
    redrawUnsupported(unsupported);
    let xml;
    try { ({ xml } = await modeler.saveXML({ format: true })); } catch { problems = unsupported; render(); return; }
    const mine = ++seq;
    let res;
    try { res = await api("POST", "/api/v1/validate", xml, true); } catch { problems = unsupported; render(); return; }
    if (mine !== seq) return; // a newer validate has superseded this one
    const server = Array.isArray(res.problems) ? res.problems : [];
    // Keep the compiler's authoritative findings and add a per-element warning for each
    // unrunnable element the server didn't already flag — so a hard compile error on one
    // element isn't doubled by a client warning, but the offenders the compiler never
    // reached (it stops at the first) are still surfaced.
    const flagged = new Set(server.map((p) => p.element).filter(Boolean));
    // The compiler's hard rejections (send/receive/terminate) name the element in the
    // message text rather than tagging it, so also drop a client warning when a server
    // finding quotes that id — avoiding a doubled row for the same element.
    problems = [...server, ...unsupported.filter((u) =>
      !flagged.has(u.element) && !server.some((p) => (p.message || "").includes(`"${u.element}"`)))];
    if (res.version) versionEl.textContent = `Checked against Atlas ${res.version}`;
    render();
  };
  const scheduleValidate = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(validate, 500);
  };

  bar.addEventListener("click", (e) => {
    if (e.target.closest("#prob-filters")) return; // a filter click is not a toggle
    expand(!expanded);
  });
  bar.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); expand(!expanded); }
  });
  filtersEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sev]");
    if (!b) return;
    filter = b.dataset.sev;
    for (const btn of filtersEl.querySelectorAll("button")) {
      btn.classList.toggle("active", btn === b);
    }
    if (!expanded) expand(true);
    render();
  });
  listEl.addEventListener("click", (e) => {
    const row = e.target.closest(".prob-row");
    if (row && row.dataset.el) focusElement(row.dataset.el);
  });

  modeler.on("element.changed", scheduleValidate);
  modeler.on("elements.changed", scheduleValidate);
  modeler.on("import.done", scheduleValidate);
  validate(); // check the diagram just imported
}

// wireTokenSim drives the Design view's token simulation (ADR-0078): a toolbar toggle
// enters a read-only "play" mode where tokens walk the diagram, and a control bar below
// the toolbar plays/steps/resets the run. The simulation itself lives in the bpmn-js
// `atlasTokenSimulation` module; this only translates button clicks into service calls
// and reflects the service's `atlasSim.changed` events back into the controls.
function wireTokenSim(root, modeler) {
  let sim;
  try { sim = modeler.get("atlasTokenSimulation"); } catch { return; } // module absent
  const editor = root.querySelector(".editor");
  const toggle = root.querySelector("#sim-toggle");
  const bar = root.querySelector("#sim-bar");
  const playBtn = root.querySelector("#sim-play");
  const stepBtn = root.querySelector("#sim-step");
  const resetBtn = root.querySelector("#sim-reset");
  const speedSel = root.querySelector("#sim-speed");
  const autoBox = root.querySelector("#sim-auto");
  const miInput = root.querySelector("#sim-mi");
  const hintEl = root.querySelector("#sim-hint");
  const statsEl = root.querySelector("#sim-stats");
  if (!toggle || !bar) return;

  const setActive = (on) => {
    sim.setActive(on);
    toggle.classList.toggle("active", on);
    toggle.setAttribute("aria-pressed", on ? "true" : "false");
    editor.classList.toggle("sim-active", on);
    bar.hidden = !on;
  };

  toggle.addEventListener("click", () => setActive(!sim.isActive()));
  playBtn.addEventListener("click", () => (sim.stats().playing ? sim.pause() : sim.play()));
  stepBtn.addEventListener("click", () => sim.step());
  resetBtn.addEventListener("click", () => sim.reset());
  speedSel.addEventListener("change", () => sim.setSpeed(Number(speedSel.value)));
  if (autoBox) autoBox.addEventListener("change", () => sim.setAuto(autoBox.checked));
  if (miInput) miInput.addEventListener("change", () => sim.setMiCount(Number(miInput.value)));

  // Reflect the simulation's state in the controls whenever it changes. `deciding` means a
  // gateway is waiting for a path to be picked; `waiting` means a message/timer/signal
  // event is parked, ready to be fired.
  modeler.get("eventBus").on("atlasSim.changed", (s) => {
    playBtn.innerHTML = s.playing ? "&#9208; Pause" : "&#9654; Play";
    statsEl.textContent = `${s.live} live · ${s.completed} completed`;
    hintEl.textContent = s.deciding
      ? "Pick a path: click a glowing flow (an inclusive gateway takes several — click the gateway to confirm)."
      : s.waiting
        ? "An event is waiting: click its ⚡ to fire it, or turn on Auto-decide."
        : s.live === 0
          ? "Click a start event ▶ to drop a token, then Play."
          : "";
  });
  // Seed the initial control state (counts at zero, opening hint).
  sim.setSpeed(Number(speedSel.value));
  if (miInput) sim.setMiCount(Number(miInput.value));
}

// wireResizer makes the properties panel width draggable, so authoring long FEEL
// expressions and scripts has room. The chosen width is remembered across mounts
// (localStorage), and the bpmn-js canvas is nudged to re-fit after a drag.
function wireResizer(root, modeler) {
  const resizer = root.querySelector("#props-resizer");
  const props = root.querySelector("#props");
  if (!resizer || !props) return;
  const KEY = "atlas.propsWidth";
  const clamp = (w) => Math.max(240, Math.min(900, w));

  const saved = parseInt(localStorage.getItem(KEY) || "", 10);
  if (saved) props.style.width = clamp(saved) + "px";

  let startX = 0, startW = 0;
  const onMove = (e) => {
    // The panel is on the right, so dragging the divider left widens it.
    props.style.width = clamp(startW - (e.clientX - startX)) + "px";
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    resizer.classList.remove("dragging");
    document.body.style.userSelect = "";
    localStorage.setItem(KEY, String(parseInt(props.style.width, 10) || 300));
    // Let bpmn-js recompute its viewport for the canvas's new width.
    try { modeler && modeler.get("canvas").resized(); } catch { /* ignore */ }
    window.dispatchEvent(new Event("resize"));
  };
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = props.getBoundingClientRect().width;
    resizer.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
  // Double-click the divider to reset to the default width.
  resizer.addEventListener("dblclick", () => {
    props.style.width = "300px";
    localStorage.setItem(KEY, "300");
    try { modeler && modeler.get("canvas").resized(); } catch { /* ignore */ }
    window.dispatchEvent(new Event("resize"));
  });
}

// wireVarsPanel makes the Live view's variables panel a first-class side panel like
// the Modeler's properties: a toolbar toggle collapses it out of the way (operators
// who want the diagram full-width), and a draggable divider widens it for reading
// long JSON. Both choices persist across mounts (localStorage), and the bpmn-js
// canvas is nudged to re-fit whenever the panel's footprint changes.
function wireVarsPanel(root, viewer) {
  const editor = root.querySelector(".editor.live");
  const panel = root.querySelector("#var-panel");
  const resizer = root.querySelector("#var-resizer");
  const toggle = root.querySelector("#vars-toggle");
  if (!editor || !panel) return;
  const WKEY = "atlas.varsWidth";
  const CKEY = "atlas.varsCollapsed";
  const clamp = (w) => Math.max(240, Math.min(900, w));

  const savedW = parseInt(localStorage.getItem(WKEY) || "", 10);
  if (savedW) panel.style.width = clamp(savedW) + "px";

  // Let bpmn-js recompute its viewport for the canvas's new width.
  const nudge = () => {
    try { viewer && viewer.get("canvas").resized(); } catch { /* ignore */ }
    window.dispatchEvent(new Event("resize"));
  };

  const applyCollapsed = (collapsed) => {
    editor.classList.toggle("vars-collapsed", collapsed);
    if (toggle) toggle.setAttribute("aria-pressed", collapsed ? "false" : "true");
    nudge();
  };
  applyCollapsed(localStorage.getItem(CKEY) === "1");

  if (toggle) {
    toggle.addEventListener("click", () => {
      const collapsed = !editor.classList.contains("vars-collapsed");
      localStorage.setItem(CKEY, collapsed ? "1" : "0");
      applyCollapsed(collapsed);
    });
  }

  if (resizer) {
    let startX = 0, startW = 0;
    const onMove = (e) => {
      // The panel is on the right, so dragging the divider left widens it.
      panel.style.width = clamp(startW - (e.clientX - startX)) + "px";
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      resizer.classList.remove("dragging");
      document.body.style.userSelect = "";
      localStorage.setItem(WKEY, String(parseInt(panel.style.width, 10) || 320));
      nudge();
    };
    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      resizer.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
    // Double-click the divider to reset to the default width.
    resizer.addEventListener("dblclick", () => {
      panel.style.width = "320px";
      localStorage.setItem(WKEY, "320");
      nudge();
    });
  }
}

// wireTabs toggles the Design/Implement tabs. Design is the descriptive view
// (eCH-0158 level: names/labels and control flow only); Implement surfaces the
// executable detail (FEEL conditions, script expressions, job types). Switching
// tabs re-renders the properties panel for the current selection via onChange.
function wireTabs(root, onChange) {
  root.querySelectorAll(".etabs button").forEach((b) => {
    b.addEventListener("click", () => {
      root.querySelectorAll(".etabs button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      if (onChange) onChange();
    });
  });
}

// activeTab reads which properties view is selected, defaulting to design.
function activeTab(root) {
  const b = root.querySelector(".etabs button.active");
  return (b && b.dataset.tab) || "design";
}

// implMarker resolves an element's *implementation type* to the icon shown in the
// Implement / runtime views, or null when the element carries no such type (so the
// generic BPMN marker shows instead). Two task families have one: a job-script task
// resolves to its language (a FEEL script task runs in the engine — none); a service
// task to its connector kind (the plain job worker has none — the gear bpmn-js draws
// IS the service-task symbol). `label` is the tooltip; `icon` is a self-contained SVG.
function implMarker(bo) {
  if (!bo) return null;
  if (bo.$type === "bpmn:ScriptTask") {
    const js = findExt(bo, "atlas:JobScript");
    if (!js) return null; // FEEL script task — runs in the engine, no worker language
    const meta = JOB_LANGS[js.language] || JOB_LANGS.powershell;
    return { label: meta.label, icon: meta.icon };
  }
  if (bo.$type === "bpmn:ServiceTask") {
    const kind = serviceTaskKind(bo);
    if (!kind.glyph) return null; // plain job worker — the default gear is its symbol
    return { label: kind.name, icon: kind.glyph };
  }
  if (bo.$type === "bpmn:SendTask") {
    // The send task's kind badge (ADR-0112): a message throw, a connector, or (plain job
    // worker) nothing — the filled send-task arrow bpmn-js draws is that kind's own symbol.
    if (bo.messageRef) return { label: SEND_MESSAGE_KIND.name, icon: SEND_MESSAGE_KIND.glyph };
    const kind = serviceTaskKind(bo);
    if (!kind.glyph) return null;
    return { label: kind.name, icon: kind.glyph };
  }
  return null;
}

// drawImplBadges marks every element that has an implementation type (see implMarker)
// with that type's icon, so a task's *executable* nature — PowerShell vs Python, a
// REST connector vs a plain job worker — reads at a glance. A plain bpmn:ScriptTask or
// bpmn:ServiceTask looks identical whatever it runs; this restores the distinction.
// Each badge is a bpmn-js overlay (like Operate's execution-count badges), so it tracks
// the shape through pan/zoom and is torn down with the modeler. Returns the overlay ids
// it added, for callers that reap their own badges (the Modeler removes them on tab
// switch; the live views let overlays.clear() reap them). Shared by the Modeler's
// Implement view and the read-only runtime views (live/collaboration/replay), where the
// type a token is running through is just as relevant as at authoring time.
function drawImplBadges(modeler) {
  const ids = [];
  let overlays, registry;
  try { overlays = modeler.get("overlays"); registry = modeler.get("elementRegistry"); }
  catch { return ids; } // modeler torn down mid-flight
  registry.forEach((el) => {
    const m = implMarker(el.businessObject);
    if (!m) return;
    try {
      // Sit the badge over the shape's own top-left type marker (the generic script
      // scroll or service-task gear bpmn-js draws), so the type icon reads as *the*
      // element marker rather than a floating label. The opaque disc covers the marker
      // beneath it; in the Design view (no badge) that generic marker shows through,
      // which is the intended level-of-detail split.
      ids.push(overlays.add(el.id, "impl-badge", {
        position: { top: 2, left: 2 },
        html: `<span class="impl-badge" title="${esc(m.label)}">${m.icon}</span>`,
      }));
    } catch { /* shape without graphics (e.g. mid-import) — skip */ }
  });
  return ids;
}

// makeImplementBadges gates drawImplBadges on the Modeler's Implement tab: the Design
// view is deliberately descriptive (control flow and BPMN symbols only), but on the
// Implement tab the difference between a PowerShell and a Python task, or a REST
// connector and a plain worker, is exactly what the author is working with. Returns a
// refresh function the tab toggle and diagram-change events call; it is a no-op off the
// Implement tab, where it clears any badges the author left behind.
function makeImplementBadges(root, modeler) {
  let ids = []; // overlay ids currently on the canvas, so we can remove ours only

  const clear = () => {
    let overlays;
    try { overlays = modeler.get("overlays"); } catch { ids = []; return; }
    for (const id of ids) { try { overlays.remove(id); } catch { /* gone */ } }
    ids = [];
  };

  const refresh = () => {
    clear();
    if (activeTab(root) !== "implement") return;
    ids = drawImplBadges(modeler);
  };

  // Keep badges in step with edits (language switched, task added/removed) while the
  // Implement tab is showing; refresh() short-circuits when another tab is active.
  modeler.on("element.changed", refresh);
  modeler.on("elements.changed", refresh);
  modeler.on("import.done", refresh);
  return refresh;
}

// drawPoolProcessCaptions writes, on each collaboration pool, a label naming the process
// that pool executes. A pool is a *participant*: the canvas draws its name (e.g. "Teilnehmer
// 1") as a vertical label in the left band, but not the process it runs — so which process a
// pool deploys as (its name, the deploy identity instances group by) is invisible on the
// diagram and only readable by selecting the pool. This surfaces it the same way the
// participant is drawn: a vertical, bottom-to-top label just inside the pool body beside the
// name band, centered on the pool's height, so it reads as the participant's counterpart.
// The Process ID rides along in the hover title. Only pools that carry a process (a
// processRef) get a label; a black-box pool has none to name.
function drawPoolProcessCaptions(modeler) {
  const ids = [];
  let overlays, registry;
  try { overlays = modeler.get("overlays"); registry = modeler.get("elementRegistry"); }
  catch { return ids; } // modeler torn down mid-flight
  registry.forEach((el) => {
    const bo = el.businessObject;
    if (!bo || !/:Participant$/.test(bo.$type || "")) return;
    const proc = bo.processRef;
    if (!proc) return; // black-box pool — no process to name
    const name = (proc.name || "").trim();
    const pid = (proc.id || "").trim();
    const main = name || pid; // name leads; a nameless process shows its id
    if (!main) return;
    const title = name ? `Process: ${name}${pid ? ` (${pid})` : ""}` : `Process: ${pid}`;
    try {
      ids.push(overlays.add(el.id, "atlas-pool-process", {
        // Centered ~46px from the pool's left edge so the label's near edge clears the ~30px
        // participant band divider by the same ~8px the participant name sits from the outer
        // frame — matching whitespace on both. (Measured against the participant label; the
        // offset accounts for this label rendering a touch thicker than the participant's.)
        // The offset scales with zoom like any overlay; the label is rotated in CSS.
        position: { top: (el.height || 0) / 2, left: 46 },
        html: `<div class="pool-process-vlabel"><span class="ppv-text" title="${esc(title)}">${esc(main)}</span></div>`,
      }));
    } catch { /* shape without graphics (e.g. mid-import) — skip */ }
  });
  return ids;
}

// makePoolProcessCaptions keeps the pool→process captions in step with edits (process
// renamed, a process added to a black-box pool, a pool deleted). Unlike the implementation
// badges these are not tab-gated: which process a pool runs is structural — relevant when
// reading the diagram at any level of detail — not an implementation nicety. Returns a
// refresh function; the initial call reflects the just-imported diagram.
function makePoolProcessCaptions(modeler) {
  let ids = []; // overlay ids currently on the canvas, so we remove only ours
  const clear = () => {
    let overlays;
    try { overlays = modeler.get("overlays"); } catch { ids = []; return; }
    for (const id of ids) { try { overlays.remove(id); } catch { /* gone */ } }
    ids = [];
  };
  const refresh = () => { clear(); ids = drawPoolProcessCaptions(modeler); };
  modeler.on("element.changed", refresh);
  modeler.on("elements.changed", refresh);
  modeler.on("import.done", refresh);
  return refresh;
}

// variablesForCompletion returns the variables to offer in an element's expression
// and script fields, each tagged with where it comes from so the completion popup
// can show its origin. Process-scope variables (start variables, script/decision
// results, and output mappings) come from collectDiagramVariables — the same static
// analysis behind the Variables panel, so completion and that panel stay in step.
// The selected element's own input-mapping targets are then added as activity-local
// "task" variables (ADR-0068); a local shadows a like-named process variable.
// Best-effort: a failure just yields fewer hints.
function variablesForCompletion(modeler, element) {
  const byName = new Map();
  try {
    for (const v of collectDiagramVariables(modeler)) {
      if (v.name && !byName.has(v.name)) byName.set(v.name, { name: v.name, detail: v.source || "variable" });
    }
  } catch { /* best-effort */ }
  try {
    const io = element && findExt(element.businessObject, "zeebe:IoMapping");
    for (const p of (io && io.inputParameters) || []) {
      const name = (p.target || "").trim();
      if (name) byName.set(name, { name, detail: "task variable · local" });
    }
  } catch { /* best-effort */ }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// formFieldCache maps a linked form's id to its input-field keys once fetched:
// null marks a fetch in flight (so each form is requested once), otherwise
// { name, fields } — the form's display name and its variable-bearing field keys.
// collectDiagramVariables reads it synchronously; ensureFormFields fills it.
const formFieldCache = new Map();

// formFieldKeys extracts the variable-bearing field keys from a form-js schema.
// Every form-js input component carries a `key` — the variable it reads and writes;
// layout-only components (text, image, spacer, separator, …) have none. A repeating
// container (dynamic list / group with a `path`) binds an array under that path, so
// surface the path rather than descending into its per-row template. A plain group
// is layout only, so recurse — its fields live in the enclosing scope. Each key
// appears once, in document order.
function formFieldKeys(schema) {
  const keys = [];
  const seen = new Set();
  const add = (k) => {
    k = (k || "").trim();
    if (k && !seen.has(k)) { seen.add(k); keys.push(k); }
  };
  const walk = (comps) => {
    for (const c of comps || []) {
      if (!c || typeof c !== "object") continue;
      if (c.path) { add(c.path); continue; } // repeatable scope: its path is the variable
      if (typeof c.key === "string") add(c.key);
      if (Array.isArray(c.components)) walk(c.components); // layout group: keys are in-scope
    }
  };
  if (schema && Array.isArray(schema.components)) walk(schema.components);
  return keys;
}

// linkedFormIds returns the form ids referenced by any element's zeebe:FormDefinition
// (start forms and user-task forms). Best-effort — a registry hiccup yields none.
function linkedFormIds(modeler) {
  const ids = [];
  try {
    modeler.get("elementRegistry").forEach((el) => {
      const fd = findExt(el.businessObject, "zeebe:FormDefinition");
      if (fd && fd.formId) ids.push(fd.formId);
    });
  } catch { /* best-effort */ }
  return ids;
}

// ensureFormFields fetches the schema of each not-yet-cached form id, records its
// field keys, then calls onLoaded so the caller can re-render with the new
// variables. Each form is requested once (its cache slot is reserved as null while
// in flight); a missing or failed load caches as no fields so it isn't retried in a
// loop. No-op without an `api`.
function ensureFormFields(api, ids, onLoaded) {
  if (!api) return;
  for (const id of new Set(ids)) {
    if (!id || formFieldCache.has(id)) continue;
    formFieldCache.set(id, null); // reserve: in flight, don't refetch
    api("GET", "/api/v1/forms/" + encodeURIComponent(id))
      .then((def) => {
        formFieldCache.set(id, { name: (def && def.name) || id, fields: formFieldKeys(def && def.schema) });
      })
      .catch(() => { formFieldCache.set(id, { name: id, fields: [] }); })
      .then(() => { try { if (onLoaded) onLoaded(); } catch { /* best-effort */ } });
  }
}

// collectDiagramVariables statically analyses the diagram for the variables it
// writes and where — the data behind the Variables panel (like Camunda's). Each
// entry is { name, origin, originId, source, category }: the variable name, the
// element that writes it (name/id and the id to select it), how (start variable,
// linked-form field, script result, decision result, output mapping), and which
// panel section it groups under. De-duplicated by name, sorted.
function collectDiagramVariables(modeler) {
  const out = [];
  const seen = new Set();
  const push = (name, origin, originId, source, category = "Process") => {
    name = (name || "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, origin, originId, source, category });
  };
  try {
    const rootBo = rootProcess(modeler);
    if (rootBo) {
      for (const v of readStartVariables(rootBo)) {
        push(v.name, "Start", "", "start variable" + (v.type ? " · " + v.type : ""));
      }
    }
  } catch { /* best-effort */ }
  try {
    modeler.get("elementRegistry").forEach((el) => {
      const bo = el.businessObject;
      if (!bo) return;
      const label = bo.name || bo.id;
      const s = findExt(bo, "zeebe:Script");
      if (s && s.resultVariable) push(s.resultVariable, label, bo.id, "FEEL script");
      const js = findExt(bo, "atlas:JobScript");
      if (js && js.resultVariable) push(js.resultVariable, label, bo.id, (js.language || "job") + " script");
      const cd = findExt(bo, "zeebe:CalledDecision");
      if (cd && cd.resultVariable) push(cd.resultVariable, label, bo.id, "decision result");
      const io = findExt(bo, "zeebe:IoMapping");
      for (const p of (io && io.outputParameters) || []) push(p.target, label, bo.id, "output mapping");
      // A data object is first-class per-instance state (ADR-0053): its name is the
      // engine's variable-like identity, so surface it here too. The name lives on the
      // underlying <dataObject>; the reference's shape id drives click-to-select.
      if (bo.$type === "bpmn:DataObjectReference") {
        const obj = bo.dataObjectRef;
        const st = (bo.dataState && bo.dataState.name) || "";
        push((obj && obj.name) || bo.name, "Data object", bo.id, st ? "data object · [" + st + "]" : "data object");
      }
      // A linked form (start form or user-task form, ADR-0028) contributes each of
      // its input fields as a variable: a start form's fields become the instance's
      // start variables, a task form's become variables when the task completes. The
      // schema is fetched lazily (ensureFormFields); until it lands the form adds
      // nothing here. Grouped under "Form" so it reads as its own panel section.
      const fd = findExt(bo, "zeebe:FormDefinition");
      if (fd && fd.formId) {
        const cached = formFieldCache.get(fd.formId);
        if (cached && cached.fields) {
          for (const key of cached.fields) push(key, cached.name || fd.formId, bo.id, "form field", "Form");
        }
      }
    });
  } catch { /* best-effort */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// wireEditorVars drives the design-time Variables panel: a toolbar toggle opens it,
// it lists the diagram's variables (origin is click-to-select), a filter narrows
// the list, and it refreshes as the diagram changes while open — a modeling aid
// that answers "what variables exist here and who writes them" without running
// anything. (The live view has its own runtime-variables panel, wireVarsPanel.)
function wireEditorVars(root, modeler, api) {
  const panel = root.querySelector("#vars-panel");
  const toggle = root.querySelector("#vars-toggle");
  const closeBtn = root.querySelector("#vars-close");
  const filter = root.querySelector("#vars-filter");
  const list = root.querySelector("#vars-list");
  if (!panel || !toggle || !list) return;

  // Which variable groups (Form / Process) the author collapsed — persisted so the
  // choice sticks across edits and reopening. Groups are collapsible only when there
  // is more than one (a linked form splits Form from Process), so a header doubles as
  // its toggle.
  const GKEY = "atlas.vars.collapsedGroups";
  let collapsedCats;
  try { collapsedCats = new Set(JSON.parse(localStorage.getItem(GKEY) || "[]")); } catch { collapsedCats = new Set(); }
  const saveCats = () => { try { localStorage.setItem(GKEY, JSON.stringify([...collapsedCats])); } catch { /* ignore */ } };

  // One variable row. Draggable so its name can be dropped into any text field to
  // insert it (a FEEL expression, a mapping source, …) — a plain-text payload, so
  // the browser's native drop-to-insert does the work with no per-field wiring.
  const rowHTML = (v) => {
    // A data object isn't "written by" an element — it *is* the element, so its
    // source label itself is the click-to-select target. A form field names its form
    // (also click-to-select). Other sources name the writing element.
    let meta;
    if (v.source === "form field") {
      meta = `form field · <span class="var-origin" data-el="${esc(v.originId)}">${esc(v.origin)}</span>`;
    } else if (v.origin === "Data object") {
      meta = `<span class="var-origin" data-el="${esc(v.originId)}">${esc(v.source)}</span>`;
    } else {
      meta = `${esc(v.source)}${v.originId
        ? ` · written by <span class="var-origin" data-el="${esc(v.originId)}">${esc(v.origin)}</span>`
        : ` · ${esc(v.origin)}`}`;
    }
    return `<div class="var-row" draggable="true" data-var="${esc(v.name)}" title="Drag into a field to insert">
      <div class="var-name">${esc(v.name)}</div>
      <div class="var-meta">${meta}</div></div>`;
  };

  const render = () => {
    // Warming the form-schema cache here (fired on every diagram change) also feeds
    // the completion/picker lists, which read the same collectDiagramVariables.
    ensureFormFields(api, linkedFormIds(modeler), render);
    if (panel.hidden) return;
    const q = (filter.value || "").trim().toLowerCase();
    const vars = collectDiagramVariables(modeler).filter((v) =>
      !q || v.name.toLowerCase().includes(q) || (v.origin || "").toLowerCase().includes(q) ||
      (v.source || "").toLowerCase().includes(q));
    if (!vars.length) {
      list.innerHTML = `<p class="vars-empty">${q ? "No matching variables." :
        "No variables yet. They appear as you add start variables, a linked form's fields, script or decision result variables, output mappings, and data objects."}</p>`;
      return;
    }
    // Group by category so a linked form's fields read as their own section
    // ("Form"), the process's own variables under "Process". With only one group
    // (the common no-form case) keep the familiar flat list — no lone header.
    const groups = new Map();
    for (const v of vars) {
      const g = v.category || "Process";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(v);
    }
    const order = ["Form", "Process"];
    const rank = (c) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
    const cats = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    list.innerHTML = cats.length === 1
      ? groups.get(cats[0]).map(rowHTML).join("")
      : cats.map((cat) => {
          const col = collapsedCats.has(cat);
          return `<div class="vars-group${col ? " collapsed" : ""}" data-cat="${esc(cat)}">
            <button type="button" class="vars-group-head" aria-expanded="${col ? "false" : "true"}">
              <span class="vg-chevron" aria-hidden="true">▸</span>
              <span class="vg-title">${esc(cat)}</span>
              <span class="vg-count">${groups.get(cat).length}</span>
            </button>
            <div class="vars-group-body">${groups.get(cat).map(rowHTML).join("")}</div>
          </div>`;
        }).join("");
  };

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.classList.toggle("active", !panel.hidden);
    render();
  });
  if (closeBtn) closeBtn.addEventListener("click", () => {
    panel.hidden = true;
    toggle.classList.remove("active");
  });
  filter.addEventListener("input", render);
  list.addEventListener("click", (e) => {
    const gh = e.target.closest(".vars-group-head");
    if (gh) {
      const grp = gh.closest(".vars-group");
      const cat = grp && grp.dataset.cat;
      if (cat) {
        const col = grp.classList.toggle("collapsed");
        gh.setAttribute("aria-expanded", col ? "false" : "true");
        if (col) collapsedCats.add(cat); else collapsedCats.delete(cat);
        saveCats();
      }
      return;
    }
    const o = e.target.closest(".var-origin");
    if (!o) return;
    const el = modeler.get("elementRegistry").get(o.dataset.el);
    if (el) {
      try { modeler.get("selection").select(el); } catch { /* stale */ }
      try { modeler.get("canvas").scrollToElement(el); } catch { /* older bpmn-js */ }
    }
  });
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".var-row");
    if (!row || !e.dataTransfer) return;
    // Plain-text payload: dropping onto a text input/textarea natively inserts the
    // variable name at the drop point — no drop handler needed on each field.
    e.dataTransfer.setData("text/plain", row.dataset.var || "");
    e.dataTransfer.effectAllowed = "copy";
  });
  // Keep the open panel current as the diagram is edited; warm the cache once now
  // (import.done has already fired by the time this wires up) so completion sees a
  // linked form's fields even before the panel is first opened.
  render();
  modeler.on("element.changed", render);
  modeler.on("elements.changed", render);
  modeler.on("import.done", render);
}

// enhanceFeel turns the FEEL <textarea> matched by `sel` into a syntax-highlighted
// editor with completions, live validation, a hint line, and a "Test" panel that
// evaluates the expression against sample variables. No-op if the field isn't
// present for the current selection. `validate` and `evaluate` are async server
// calls (the FEEL compiler / evaluator) or null.
function enhanceFeel(body, sel, vars, validate, evaluate) {
  const ta = body.querySelector(sel);
  if (!ta) return;
  attachFeelEditor(ta, { variables: vars, validate });
  const wrap = ta.closest(".code-editor");
  if (!wrap) return;

  const hint = document.createElement("p");
  hint.className = "feel-hint";
  hint.innerHTML = "FEEL — <kbd>Ctrl</kbd>+<kbd>Space</kbd> for completions";
  if (evaluate) hint.innerHTML += ' &middot; <button type="button" class="linklike" data-feel-test>Test</button>';
  wrap.after(hint);
  if (!evaluate) return;

  // The Test panel: sample variables (JSON) + Run, evaluating the current
  // expression server-side and showing the typed result inline.
  const panel = document.createElement("div");
  panel.className = "feel-test";
  panel.hidden = true;
  panel.innerHTML = `
    <textarea class="feel-test-vars" rows="2" spellcheck="false" placeholder='sample variables, e.g. { "amount": 100 }'></textarea>
    <div class="feel-test-row">
      <button type="button" class="btn neutral feel-test-run">Run</button>
      <span class="feel-test-out" aria-live="polite"></span>
    </div>`;
  hint.after(panel);
  const varsEl = panel.querySelector(".feel-test-vars");
  const outEl = panel.querySelector(".feel-test-out");
  const setOut = (cls, text) => { outEl.className = "feel-test-out" + (cls ? " " + cls : ""); outEl.textContent = text; };

  hint.querySelector("[data-feel-test]").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) varsEl.focus();
  });
  panel.querySelector(".feel-test-run").addEventListener("click", async () => {
    let variables;
    try { variables = parseStartVariables(varsEl.value).variables || {}; }
    catch (e) { setOut("err", e.message); return; }
    setOut("", "…");
    try {
      const res = await evaluate(ta.value, variables);
      if (res && res.ok) setOut("ok", `= ${res.result} (${res.kind})`);
      else setOut("err", (res && res.error) || "could not evaluate");
    } catch (e) {
      setOut("err", e.message);
    }
  });
}

// prettyResult renders a script's decoded result for the Run panel; undefined (an
// omitted/null result) shows as null.
function prettyResult(v) {
  if (v === undefined) return "null";
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// cleanScriptError strips the Go handler's "script: run <lang>: exit status N:"
// wrapper so the panel shows the interpreter's own error, not our plumbing.
function cleanScriptError(s) {
  return String(s || "").replace(/^script: run \w+: (?:exit status \d+: )?/, "").trim();
}

// firstLine is the first non-blank line of a message, capped — used as an error
// marker's hover text.
function firstLine(s) {
  return (String(s).split("\n").find((l) => l.trim()) || "error").trim().slice(0, 140);
}

// scriptErrorLine best-effort parses the 1-based source line an interpreter error
// points at, so the editor can mark it. PowerShell emits either the concise
// "Line |\n  N |" view or the classic "At line:N"; Python a "line N" traceback; a
// JS error a "<anonymous>:N:col". Line numbers are relative to the author's source
// because each bootstrap runs it as a fresh block (see script/exec.go). Returns 0
// when no line can be found.
function scriptErrorLine(language, msg) {
  if (language === "powershell") {
    let m = /At line:(\d+)/.exec(msg);
    if (m) return Number(m[1]);
    m = /\bLine \|\s*[\r\n]+\s*(\d+)\s*\|/.exec(msg);
    if (m) return Number(m[1]);
  }
  if (language === "javascript") {
    const m = /:(\d+)(?::\d+)?\b/.exec(msg);
    if (m) return Number(m[1]);
  }
  const g = /\bline (\d+)/i.exec(msg);
  return g ? Number(g[1]) : 0;
}

// enhanceScript upgrades the polyglot script field (#f-psbody — PowerShell, Python
// or JavaScript, ADR-0047) into the shared code editor: syntax highlighting,
// completion over the in-scope process variables ($name) and the $env: keys the
// script references, a line-number gutter, and a Run panel that executes the script
// through the real interpreter (POST /scripts/run), shows its result/error stream
// and runtime, and maps a runtime error back to a marker on the offending line.
// No-op if the field isn't present for the current selection.
function enhanceScript(body, modeler, api, variables) {
  const ta = body.querySelector("#f-psbody");
  if (!ta) return;
  const flang = body.querySelector("#f-scriptlang");
  const language = (flang && flang.value) || "powershell";
  const editor = attachCodeEditor(ta, { lang: moduleFor(language), variables: variables || [], gutter: true, wrap: false });

  const shortcut = language === "powershell"
    ? "<code>$name</code> / <code>$env:</code> &middot; <kbd>Ctrl</kbd>+<kbd>Space</kbd> for completions, <kbd>Tab</kbd> to indent"
    : "instance variables by name &middot; <kbd>Ctrl</kbd>+<kbd>Space</kbd> for completions, <kbd>Tab</kbd> to indent";
  const hint = document.createElement("p");
  hint.className = "feel-hint";
  hint.innerHTML = shortcut;
  if (editor && editor.el) editor.el.after(hint);

  const runBtn = body.querySelector(".ps-run");
  if (!runBtn || !api) return;
  const runVars = body.querySelector(".ps-run-vars");
  const runOut = body.querySelector(".ps-run-out");
  const detail = body.querySelector(".ps-run-detail");
  const setOut = (cls, text) => { runOut.className = "feel-test-out ps-run-out" + (cls ? " " + cls : ""); runOut.textContent = text; };
  const setDetail = (cls, text) => {
    if (!detail) return;
    detail.hidden = !text;
    detail.className = "ps-run-detail" + (cls ? " " + cls : "");
    detail.textContent = text || "";
  };

  runBtn.addEventListener("click", async () => {
    if (editor) editor.setMarkers([]);
    let variables = {};
    const raw = (runVars.value || "").trim();
    if (raw) {
      try { variables = JSON.parse(raw); }
      catch { setOut("err", "Sample variables must be valid JSON."); setDetail("", ""); return; }
    }
    setOut("", "Running…"); setDetail("", "");
    const t0 = performance.now();
    try {
      const r = await api("POST", "/api/v1/scripts/run", { language, source: ta.value || "", variables });
      const ms = Math.round(performance.now() - t0);
      if (r && r.ok) {
        setOut("ok", `✓ ${ms} ms`);
        setDetail("ok", "→ " + prettyResult(r.result));
      } else {
        setOut("err", `✗ ${ms} ms`);
        const msg = cleanScriptError((r && r.error) || "run failed");
        setDetail("err", msg);
        const line = scriptErrorLine(language, msg);
        if (line && editor) { editor.setMarkers([{ line, message: firstLine(msg) }]); editor.focusLine(line); }
      }
    } catch (e) {
      setOut("err", "✗");
      setDetail("err", (e && e.message) || String(e));
    }
  });
}

// attachExpressionToggle adds a Camunda-style fx switch to a value field that may
// hold either a literal string or a FEEL expression. Zeebe stores an expression
// with a leading '=' (that's exactly what the compiler keys on), so the field
// element stays the single value holder the save wiring already reads — toggling
// only changes the editing surface and whether the value carries the '=' prefix.
// In expression mode the field becomes a FEEL code editor with the '=' shown as a
// dimmed, read-only prefix (deleting it is the fx button's job, not a keystroke); the
// mode is inferred from the current value on load. No-op if the field isn't present.
// Exported so it can be reused by any value-or-expression field (and driven by a UI
// smoke test).
export function attachExpressionToggle(el, opts = {}) {
  if (!el || el.dataset.fxOn === "1") return;
  el.dataset.fxOn = "1";
  const field = el.closest(".field");
  const span = field && field.querySelector("span");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fx-toggle";
  btn.textContent = "fx";
  btn.title = "Toggle between a literal value and a FEEL expression (=)";
  // Prefer the field label (a labelled row); fall back to sitting inline before the
  // input for fields without a .field/span wrapper (e.g. a map value cell).
  if (span) span.appendChild(btn);
  else el.insertAdjacentElement("beforebegin", btn);

  let feelHandle = null;
  const isExpr = () => el.value.trimStart().startsWith("=");

  function render() {
    const expr = isExpr();
    btn.classList.toggle("active", expr);
    btn.setAttribute("aria-pressed", expr ? "true" : "false");
    if (expr && !feelHandle) {
      // The leading '=' stays in the field value (the save wiring and compiler key on
      // it), but is shown as a dimmed, read-only prefix — it can't be typed away, and
      // the FEEL validator sees the bare expression, not "=expr" (which it rejects as
      // an unexpected '='). Switching back to a literal is the fx button's job.
      feelHandle = attachFeelEditor(el, {
        variables: opts.variables,
        validate: opts.validate,
        lockPrefix: (v) => (/^\s*=\s*/.exec(v) || [""])[0].length,
      });
    } else if (!expr && feelHandle) {
      feelHandle.destroy();
      feelHandle = null;
    } else if (expr && feelHandle) {
      feelHandle.setVariables(opts.variables || []);
    }
  }

  btn.addEventListener("click", () => {
    // Flip the value between its literal and '=' expression forms; the FEEL editor
    // attaches/detaches in render(), and the change event lets the save wiring
    // persist the new value verbatim.
    el.value = isExpr() ? el.value.replace(/^\s*=\s*/, "") : "=" + (el.value ? " " + el.value : "");
    render();
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (feelHandle) el.focus();
  });

  render();
}

// findExt returns a business object's extension element of the given moddle type.
function findExt(bo, type) {
  const ext = bo && bo.extensionElements;
  if (!ext || !ext.values) return null;
  return ext.values.find((v) => v.$type === type) || null;
}

// upsertExt ensures element has an extension element of `type` and applies props,
// through the modeling API so it participates in undo/redo.
function upsertExt(modeler, element, type, props) {
  const moddle = modeler.get("moddle");
  const modeling = modeler.get("modeling");
  const bo = element.businessObject;
  let ext = bo.extensionElements;
  if (!ext) {
    ext = moddle.create("bpmn:ExtensionElements", { values: [] });
    ext.$parent = bo;
  }
  let node = (ext.values || []).find((v) => v.$type === type);
  if (!node) {
    node = moddle.create(type);
    node.$parent = ext;
    ext.values = [...(ext.values || []), node];
  }
  Object.assign(node, props);
  modeling.updateProperties(element, { extensionElements: ext });
}

// removeExt drops an element's extension element of `type`, if present, through
// the modeling API (undo/redo aware). Used to unlink a form (drop the whole
// zeebe:FormDefinition rather than leave an empty formId behind).
function removeExt(modeler, element, type) {
  const modeling = modeler.get("modeling");
  const ext = element.businessObject.extensionElements;
  if (!ext || !ext.values) return;
  const next = ext.values.filter((v) => v.$type !== type);
  if (next.length === ext.values.length) return;
  ext.values = next;
  modeling.updateProperties(element, { extensionElements: ext });
}

// RETRIES_FIELD is the retry budget every job-backed task carries (ADR-0135): how
// many attempts the engine grants the job before a failure parks the token behind an
// incident (ADR-0061). It is one field description appended to every catalog kind,
// so the property reads, saves and validates identically whichever implementation a
// task has — the plain job worker stores it on <zeebe:taskDefinition retries>, a
// connector on its own extension's retries attribute, and the compiler reads both.
const RETRIES_FIELD = {
  key: "retries", label: "Retries", type: "number", min: 1, placeholder: "3",
  hint: "How often the engine hands this task's job to a worker before giving up — the first attempt plus one per remaining count. When they are used up the failure raises an incident that parks the token until an operator resolves it. Leave empty for the default (3); 1 means a single attempt with no retry.",
};

// withRetries appends the retry-budget section to a catalog kind's fields. Every
// kind that runs as a job takes it; the mockup kind does not (ADR-0120: the engine
// simulates that task itself and creates no job, so there is nothing to hand out
// again — its failure simulation raises the incident directly).
function withRetries(kind) {
  if (kind.id === "mockup") return kind;
  return { ...kind, fields: [...kind.fields, { group: "Failure handling" }, RETRIES_FIELD] };
}

// SERVICE_TASK_KINDS is the catalog of service-task connector kinds the modeler
// can author (ADR-0067). Each entry maps a human-facing kind to the extension
// element the compiler reads and the typed fields that configure it. Adding a
// connector kind is one entry here (plus its moddle type, compiler branch, and
// worker) — the searchable picker and the field form are both rendered
// generically from this data, so no bespoke panel code is needed per kind.
const SERVICE_TASK_KINDS = [
  {
    id: "worker", name: "Job worker", desc: "Handled by an external job worker", icon: "⚙",
    ext: "zeebe:TaskDefinition",
    fields: [{ key: "type", label: "Job type", placeholder: "payment" }],
  },
  {
    id: "rest", name: "REST Outbound Connector", desc: "Invoke a REST API", icon: "R",
    // glyph is the canvas type marker shown in the Implement/runtime views (drawImplBadges),
    // the connector's counterpart to a script task's language icon. The plain job worker
    // has none — the gear bpmn-js already draws IS the service-task symbol. A globe reads
    // "HTTP/web API" at a glance.
    glyph: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#12a594"/><circle cx="8" cy="8" r="4.7" fill="none" stroke="#fff" stroke-width="1.1"/><ellipse cx="8" cy="8" rx="2.3" ry="4.7" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M3.3 8h9.4M8 3.3v9.4" stroke="#fff" stroke-width="1.1"/></svg>`,
    ext: "atlas:RestConnector",
    fields: [
      { group: "HTTP endpoint" },
      { key: "method", label: "Method", type: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
      { key: "url", label: "URL", placeholder: "https://api.example.com/customers", fx: true },
      { key: "headers", label: "Headers", type: "map", childType: "atlas:HttpHeader", fx: true, hint: "Sent with the request. A value may be a FEEL expression (fx)." },
      { key: "queryParameters", label: "Query parameters", type: "map", childType: "atlas:QueryParam", fx: true, hint: "Appended to the request URL. A value may be a FEEL expression (fx)." },
      { group: "Authentication" },
      {
        key: "authType", label: "Type", type: "select", reRender: true,
        options: [{ v: "", l: "None" }, { v: "basic", l: "Basic" }, { v: "bearer", l: "Bearer token" }, { v: "apiKey", l: "API key" }],
      },
      { key: "authUsername", label: "Username", showIf: (v) => v.authType === "basic" },
      { key: "authApiKeyName", label: "API key header name", placeholder: "X-API-Key", showIf: (v) => v.authType === "apiKey" },
      {
        key: "authSecret", label: "Secret reference", placeholder: "MY_TOKEN",
        showIf: (v) => v.authType === "basic" || v.authType === "bearer" || v.authType === "apiKey",
        hint: "The credential lives on the server as ATLAS_CONNECTOR_<REF>_TOKEN; the model stores only this reference, never the secret value.",
      },
      { group: "Output" },
      { key: "resultVariable", label: "Result variable", placeholder: "response", hint: "The JSON response is written into this process variable (leave empty to discard it)." },
    ],
  },
  {
    id: "clio", name: "clio Event Store Connector", desc: "Send, query, or read events on a clio event store", icon: "C",
    // A stacked event-stream mark on a violet tile reads "append-only event log" at a
    // glance — clio's counterpart to REST's globe. Three white rows with a leading
    // dot suggest a growing stream of events; the drawImplBadges/stkind-icon CSS adds
    // the round tile chrome, so the SVG only needs the fill and the white marks.
    glyph: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#7c5cff"/><circle cx="4.1" cy="4.6" r="1.05" fill="#fff"/><rect x="6.4" y="3.85" width="6.2" height="1.5" rx="0.75" fill="#fff"/><circle cx="4.1" cy="8" r="1.05" fill="#fff"/><rect x="6.4" y="7.25" width="6.2" height="1.5" rx="0.75" fill="#fff"/><circle cx="4.1" cy="11.4" r="1.05" fill="#fff"/><rect x="6.4" y="10.65" width="6.2" height="1.5" rx="0.75" fill="#fff"/></svg>`,
    ext: "atlas:ClioConnector",
    fields: [
      { group: "clio connector" },
      { key: "connector", label: "Connector", placeholder: "orders-clio", hint: "Names a server-registered clio connector (its endpoint and token live on the server, never in the model)." },
      {
        key: "operation", label: "Operation", type: "select", reRender: true,
        options: [{ v: "write", l: "Send event (write-events)" }, { v: "query", l: "Query state (get_state / run_query)" }, { v: "read", l: "Read events (read-events)" }],
      },
      { group: "Event", showIf: (v) => !v.operation || v.operation === "write" },
      { key: "subject", label: "Subject", placeholder: "orders/new", showIf: (v) => !v.operation || v.operation === "write" || v.operation === "read", hint: "The clio subject the event lands under (write) or is read from (read/get_state)." },
      { key: "eventType", label: "Event type", placeholder: "OrderPlaced", showIf: (v) => !v.operation || v.operation === "write", hint: "The instance's variables are sent as the event body." },
      { group: "Query", showIf: (v) => v.operation === "query" },
      { key: "query", label: "Query", placeholder: "leave empty for get_state", showIf: (v) => v.operation === "query", hint: "A run_query query string. If empty, get_state is read for the subject above." },
      { key: "reduceSpec", label: "Reduce spec", placeholder: "orderTotals", showIf: (v) => v.operation === "query", hint: "The projection to read for get_state (ignored when a query is set)." },
      { group: "Read", showIf: (v) => v.operation === "read" },
      { key: "limit", label: "Limit", placeholder: "0 = connector default", showIf: (v) => v.operation === "read" },
      { key: "resultVariable", label: "Result variable", placeholder: "result", showIf: (v) => v.operation === "query" || v.operation === "read", hint: "The query result / events are written into this process variable." },
    ],
  },
  {
    id: "mail", name: "E-Mail Outbound Connector", desc: "Send an e-mail via a mail provider", icon: "M",
    // An envelope on a warm amber tile reads "outbound mail" at a glance — the mail
    // connector's counterpart to REST's globe and clio's event stream. The
    // drawImplBadges/stkind-icon CSS adds the round tile chrome; the SVG carries the
    // fill and the white envelope strokes.
    glyph: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#e5484d"/><rect x="3" y="4.6" width="10" height="6.8" rx="1" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M3.4 5.2L8 8.6l4.6-3.4" fill="none" stroke="#fff" stroke-width="1.1"/></svg>`,
    ext: "atlas:MailConnector",
    fields: [
      { group: "Mail provider" },
      { key: "connector", label: "Connector", placeholder: "office365", hint: "Names a server-registered mail provider (its host, credentials, and default sender live on the server, never in the model)." },
      { group: "Message" },
      { key: "to", label: "To", placeholder: "ops@example.com, =customer.email", fx: true, hint: "Comma-separated recipients. A value may be a FEEL expression (fx)." },
      { key: "cc", label: "Cc", placeholder: "team@example.com", fx: true },
      { key: "bcc", label: "Bcc", placeholder: "audit@example.com", fx: true, hint: "Delivered but never shown in the message headers." },
      { key: "from", label: "From", placeholder: "leave empty for the connector's default sender", fx: true },
      { key: "subject", label: "Subject", placeholder: "Order shipped", fx: true },
      { key: "body", label: "Body", placeholder: "Your order is on its way.", fx: true, rows: 8, hint: "Plain-text body, or a FEEL expression (fx) composed from the instance's variables — switch on fx, then press Ctrl+Space for variable completion." },
    ],
  },
  {
    id: "csv", name: "CSV to JSON", desc: "Parse an uploaded CSV into a JSON rows array", icon: "T",
    // A grid/table mark on a teal tile reads "tabular data → rows" at a glance — the
    // CSV connector's counterpart to REST's globe and mail's envelope. The
    // drawImplBadges/stkind-icon CSS adds the round tile chrome; the SVG carries the
    // fill and the white grid strokes.
    glyph: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#3b82f6"/><rect x="3" y="3.6" width="10" height="8.8" rx="1" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M3 6.4h10M3 9.2h10M6.6 3.6v8.8" stroke="#fff" stroke-width="1.1"/></svg>`,
    ext: "atlas:CsvConnector",
    fields: [
      { group: "Source" },
      { key: "source", label: "Source variable", placeholder: "csvText", hint: "Name of the process variable holding the raw CSV text (e.g. from the upload task)." },
      { group: "Layout" },
      { key: "delimiter", label: "Delimiter", type: "select", options: [{ v: ",", l: "Comma ," }, { v: ";", l: "Semicolon ;" }, { v: "\t", l: "Tab" }, { v: "|", l: "Pipe |" }] },
      { key: "hasHeader", label: "Header row", type: "select", options: [{ v: "true", l: "First row is the header" }, { v: "false", l: "No header row" }] },
      { key: "columns", label: "Columns", placeholder: "email, group, license", hint: "Comma-separated field names. Leave empty to derive them from the header row; required when there is no header." },
      { group: "Output" },
      { key: "resultVariable", label: "Result variable", placeholder: "rows", hint: "The parsed JSON array of rows is written into this process variable (rowCount is also set)." },
    ],
  },
  {
    id: "sharepoint", name: "SharePoint Connector", desc: "Create a list item in a SharePoint site", icon: "S",
    // A list/grid mark on a Microsoft-teal tile reads "SharePoint list" at a glance —
    // this connector's counterpart to REST's globe and mail's envelope. The
    // drawImplBadges/stkind-icon CSS adds the round tile chrome; the SVG carries the
    // fill and the white list rows.
    glyph: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#038387"/><rect x="3" y="3.6" width="10" height="8.8" rx="1" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M3.4 6.2h9.2M6 3.9v8.2" stroke="#fff" stroke-width="1.1"/></svg>`,
    ext: "atlas:SharePointConnector",
    fields: [
      { group: "SharePoint provider" },
      { key: "connector", label: "Connector", placeholder: "contoso", hint: "Names a server-registered SharePoint provider (its Graph base and OAuth credential live on the server, never in the model)." },
      { group: "Target" },
      { key: "site", label: "Site", placeholder: "contoso.sharepoint.com,<siteId>,<webId>", fx: true, hint: "The Microsoft Graph site identifier. A value may be a FEEL expression (fx)." },
      { key: "list", label: "List", placeholder: "Incidents", fx: true, hint: "The list name or id the item is created in." },
      { group: "Item" },
      { key: "fields", label: "Item fields", type: "map", childType: "atlas:ItemField", fx: true, hint: "Column values of the created list item. A value may be a FEEL expression (fx) over the instance's variables." },
      { group: "Output" },
      { key: "resultVariable", label: "Result variable", placeholder: "createdItem", hint: "The created item's JSON is written into this process variable (leave empty to discard it)." },
    ],
  },
  {
    id: "remedy", name: "BMC Remedy Connector", desc: "Create an incident/entry in BMC Remedy (Helix ITSM)", icon: "B",
    // A ticket/incident mark on a BMC-orange tile reads "ITSM ticket" at a glance — the
    // Remedy connector's counterpart to REST's globe and mail's envelope. The
    // drawImplBadges/stkind-icon CSS adds the round tile chrome; the SVG carries the
    // fill and the white ticket strokes.
    glyph: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#f76808"/><rect x="3" y="4.4" width="10" height="7.2" rx="1.2" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M5.4 7h5.2M5.4 9h3.2" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/></svg>`,
    ext: "atlas:RemedyConnector",
    fields: [
      { group: "Remedy instance" },
      { key: "connector", label: "Connector", placeholder: "helix-itsm", hint: "Names a server-registered Remedy instance (its base URL and credentials live on the server, never in the model)." },
      { group: "Entry" },
      { key: "form", label: "Form", placeholder: "HPD:IncidentInterface_Create", fx: true, hint: "The Remedy form the entry is created in. May be a FEEL expression (fx)." },
      { key: "fields", label: "Fields", type: "map", childType: "atlas:RemedyField", fx: true, hint: "The entry's field values, keyed by Remedy field name. A value may be a FEEL expression (fx)." },
      { group: "Output" },
      { key: "resultVariable", label: "Result variable", placeholder: "incidentNumber", hint: "The created entry's id is written into this process variable (leave empty to discard it)." },
    ],
  },
  {
    id: "webscrape", name: "Web Scraping Connector", desc: "Fetch a web page and extract elements by CSS selector", icon: "W",
    // A spider-web mark on an indigo tile reads "web scraping" at a glance — this
    // connector's counterpart to REST's globe and mail's envelope. The
    // drawImplBadges/stkind-icon CSS adds the round tile chrome; the SVG carries the
    // fill and the white web strokes.
    glyph: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#5b5bd6"/><g fill="none" stroke="#fff" stroke-width="1.1"><path d="M8 2.4v11.2M2.4 8h11.2M4 4l8 8M12 4l-8 8"/><circle cx="8" cy="8" r="2.6"/><circle cx="8" cy="8" r="5"/></g></svg>`,
    ext: "atlas:WebscrapeConnector",
    fields: [
      { group: "Page" },
      { key: "url", label: "URL", placeholder: "https://example.com/news", fx: true, hint: "The page to fetch. A value may be a FEEL expression (fx) over the instance's variables." },
      { group: "Extraction" },
      { key: "selector", label: "CSS selector", placeholder: ".headline a", fx: true, hint: "The CSS selector whose matching elements are extracted. May be a FEEL expression (fx)." },
      { key: "attribute", label: "Attribute", placeholder: "leave empty for the element's text", hint: "The HTML attribute read from each match (e.g. href). Leave empty to extract each match's text content." },
      { group: "Output" },
      { key: "resultVariable", label: "Result variable", placeholder: "matches", hint: "The extracted values are written into this process variable as a JSON array." },
    ],
  },
  {
    id: "mockup", name: "Mockup (Simulation)", desc: "Let the engine simulate this task — random duration, scripted output, optional failures", icon: "K",
    // A beaker on a slate tile reads "simulation / lab" at a glance — the mockup
    // task's counterpart to REST's globe and mail's envelope. The
    // drawImplBadges/stkind-icon CSS adds the round tile chrome; the SVG carries the
    // fill and the white beaker strokes.
    glyph: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#647488"/><path d="M6.3 3.2v3.4L3.9 11a1 1 0 0 0 .9 1.5h6.4a1 1 0 0 0 .9-1.5L9.7 6.6V3.2" fill="none" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/><path d="M5.6 3.2h4.8M5.4 8.4h5.2" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/></svg>`,
    ext: "atlas:MockupConnector",
    fields: [
      { group: "Duration" },
      { key: "minDuration", label: "Min duration", placeholder: "PT1S", hint: "ISO-8601 duration (e.g. PT1S, PT5M). The engine waits a random time in [min, max] before completing. For a fixed time, set only this." },
      { key: "maxDuration", label: "Max duration", placeholder: "leave empty for a fixed duration", hint: "ISO-8601 duration. Omit to make the duration exactly the minimum." },
      { group: "Result (input → output)" },
      { key: "resultExpression", label: "Result expression", placeholder: `={ status: "ok", id: orderId }`, fx: true, rows: 4, hint: "A FEEL expression evaluated over the instance's variables and written to the result variable — the input→output script, e.g. a simulated REST/Umsystem response. Press Ctrl+Space for variable completion." },
      { key: "resultVariable", label: "Result variable", placeholder: "response", hint: "The process variable the result expression is written into. Required when a result expression is set." },
      { group: "Failure simulation" },
      { key: "failRate", label: "Failure rate", placeholder: "0 = never, 1 = always", hint: "Probability in [0,1] that an attempt fails instead of completing — for exercising error/retry paths." },
      { key: "errorCode", label: "BPMN error code", placeholder: "leave empty to raise an incident", hint: "When set, a failure throws a BPMN error with this code — caught by a matching error boundary event or error event subprocess. Leave empty to raise a technical incident (resolvable, retries with a fresh draw) instead." },
      { key: "failMessage", label: "Incident message", placeholder: "umsystem unavailable", hint: "The incident message when a failure raises an incident (i.e. when no error code is set)." },
    ],
  },
].map(withRetries);

// serviceTaskKind returns the catalog entry a service task currently represents,
// detected by which connector extension it carries; the plain job worker is the
// default when no connector extension is present.
function serviceTaskKind(bo) {
  for (const k of SERVICE_TASK_KINDS) {
    if (k.id !== "worker" && findExt(bo, k.ext)) return k;
  }
  return SERVICE_TASK_KINDS[0];
}

// selectOption normalizes a select option to {v,l} (a bare string is both value and
// label).
function selectOption(o) {
  return typeof o === "string" ? { v: o, l: o } : o;
}

// stMapRowHTML renders one key/value row of a map field (a header or query param).
// The value is a 1-row textarea so the fx toggle can upgrade it to a FEEL editor in
// place (a plain input can't host the code editor).
function stMapRowHTML(fieldKey, name, value) {
  return `<div class="st-map-row" data-field="${esc(fieldKey)}" style="display:flex;gap:6px;margin-bottom:6px;align-items:start">
    <input type="text" class="st-map-name" value="${esc(name || "")}" placeholder="name" style="flex:0 0 40%"/>
    <textarea class="st-map-value" rows="1" spellcheck="false" placeholder="value" style="flex:1;resize:none">${esc(value || "")}</textarea>
    <button type="button" class="st-map-del" title="Remove" style="flex:0 0 auto">✕</button>
  </div>`;
}

// serviceTaskKindHTML renders the searchable kind picker plus the current kind's
// fields, both from SERVICE_TASK_KINDS. The picker approximates the reference
// tooling's template chooser within the buildless panel (ADR-0067/0012); the field
// form is generic over text/select/map fields, section groups, and showIf
// visibility so a new connector kind needs no bespoke panel code.
// stKindRowsHTML renders the searchable kind-picker rows for a list of kinds, highlighting
// curId. Shared by the service task (SERVICE_TASK_KINDS) and the send task, which prepends a
// Message kind (ADR-0112); the click/filter handlers key off the .stkind-row markup.
function stKindRowsHTML(kinds, curId) {
  return kinds.map((k) => `
    <div class="stkind-row" data-kind="${k.id}" data-match="${esc((k.name + " " + k.desc).toLowerCase())}"
         style="display:flex;gap:8px;align-items:center;padding:8px;border:1px solid #d7d7d7;border-radius:6px;margin-bottom:6px;cursor:pointer;${k.id === curId ? "background:#eef2ff;border-color:#9aa8ff" : ""}">
      <span class="stkind-icon">${k.glyph || esc(k.icon)}</span>
      <span style="line-height:1.25"><b>${esc(k.name)}</b><br><span class="muted" style="font-size:12px">${esc(k.desc)}</span></span>
    </div>`).join("");
}

// stKindFieldsHTML renders the typed field form for one catalog kind over its stored
// extension, generic over text/select/map fields, section groups, and showIf visibility.
function stKindFieldsHTML(cur, ext) {
  let fields = "";
  for (const f of cur.fields) {
    if (f.group) {
      if (f.showIf && !f.showIf(ext)) continue;
      fields += `<h3>${esc(f.group)}</h3>`;
      continue;
    }
    if (f.showIf && !f.showIf(ext)) continue;
    if (f.type === "map") {
      const list = Array.isArray(ext[f.key]) ? ext[f.key] : [];
      const rowsHTML = list.map((kv) => stMapRowHTML(f.key, kv.name, kv.value)).join("");
      fields += `<div class="field"><span>${esc(f.label)}</span>
        <div class="st-map" data-field="${esc(f.key)}" data-childtype="${esc(f.childType)}">
          <div class="st-map-rows">${rowsHTML}</div>
          <button type="button" class="st-map-add" style="margin-top:2px">+ Add</button>
        </div></div>`;
    } else if (f.type === "number") {
      // A count, not free text (the retry budget): a spinner with the engine's own
      // lower bound, so the field cannot express a value the compiler refuses.
      fields += `<label class="field"><span>${esc(f.label)}</span>
        <input type="number" id="f-st-${f.key}" ${f.min === undefined ? "" : `min="${esc(String(f.min))}"`} step="1"
               value="${esc(ext[f.key] || "")}" placeholder="${esc(f.placeholder || "")}"/></label>`;
    } else if (f.type === "select") {
      const chosen = ext[f.key] || "";
      const opts = f.options.map((o) => {
        const { v, l } = selectOption(o);
        return `<option value="${esc(v)}" ${v === chosen ? "selected" : ""}>${esc(l)}</option>`;
      }).join("");
      fields += `<label class="field"><span>${esc(f.label)}</span><select id="f-st-${f.key}">${opts}</select></label>`;
    } else if (f.fx) {
      // A textarea — 1 row by default, taller for prose like an e-mail body — so the
      // fx toggle can host the FEEL editor in place at that size.
      fields += `<label class="field"><span>${esc(f.label)}</span>
        <textarea id="f-st-${f.key}" rows="${f.rows || 1}" spellcheck="false" placeholder="${esc(f.placeholder || "")}">${esc(ext[f.key] || "")}</textarea></label>`;
    } else {
      fields += `<label class="field"><span>${esc(f.label)}</span>
        <input type="text" id="f-st-${f.key}" value="${esc(ext[f.key] || "")}" placeholder="${esc(f.placeholder || "")}"/></label>`;
    }
    if (f.hint) fields += `<p class="muted" style="font-size:12px">${esc(f.hint)}</p>`;
  }
  return fields;
}

// serviceTaskKindHTML renders the searchable kind picker plus the current kind's fields,
// both from SERVICE_TASK_KINDS (ADR-0067). A new connector kind needs no bespoke panel code.
function serviceTaskKindHTML(bo) {
  const cur = serviceTaskKind(bo);
  const ext = findExt(bo, cur.ext) || {};
  return `<h3>Type</h3>
    <input type="text" id="f-stkind-filter" placeholder="Search type… (e.g. rest)" style="width:100%;box-sizing:border-box;margin-bottom:8px"/>
    <div id="f-stkind-list">${stKindRowsHTML(SERVICE_TASK_KINDS, cur.id)}</div>
    <h3>${esc(cur.name)}</h3>${stKindFieldsHTML(cur, ext)}`;
}

// SEND_MESSAGE_KIND is the send task's Message kind (ADR-0112): a correlating throw in task
// form. It is not a connector (no ext / fields form) — it is configured by the shared message
// picker and detected by a messageRef — so it lives outside SERVICE_TASK_KINDS and is prepended
// to the send task's picker.
const SEND_MESSAGE_KIND = {
  id: "message", name: "Message", icon: "✉",
  desc: "Publish a BPMN message; a waiting receive task or message catch with a matching key continues",
  glyph: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#4666ff"/><rect x="3" y="4.6" width="10" height="6.8" rx="1" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M3.4 5.2L8 8.6l4.6-3.4" fill="none" stroke="#fff" stroke-width="1.1"/></svg>`,
};

// sendTaskKind returns the kind a send task currently represents (ADR-0112). It is detected by
// what the task carries: a messageRef → Message; a connector extension → that connector; a
// taskDefinition → Job worker. With none of those, the send task is the Message kind by default —
// so selecting Message (which clears the other kinds' extensions) keeps the message picker visible
// until a message is chosen, and a fresh send task starts as a plain message send. Without this
// default, the Message kind would be undetectable while messageRef is still empty.
function sendTaskKind(bo) {
  if (bo && bo.messageRef) return SEND_MESSAGE_KIND;
  for (const k of SERVICE_TASK_KINDS) {
    if (k.id !== "worker" && findExt(bo, k.ext)) return k;
  }
  if (findExt(bo, "zeebe:TaskDefinition")) return SERVICE_TASK_KINDS[0]; // Job worker
  return SEND_MESSAGE_KIND;
}

// sendTaskKindHTML renders the send task's kind picker: the Message kind plus the service
// task's connector/job-worker catalog, then either the shared message picker (Message kind)
// or the chosen connector's field form (ADR-0112). The picker reuses the .stkind-row markup,
// so the existing filter/click wiring drives it.
function sendTaskKindHTML(modeler, bo) {
  const cur = sendTaskKind(bo);
  const picker = `<h3>Type</h3>
    <input type="text" id="f-stkind-filter" placeholder="Search type… (e.g. message, mail)" style="width:100%;box-sizing:border-box;margin-bottom:8px"/>
    <div id="f-stkind-list">${stKindRowsHTML([SEND_MESSAGE_KIND, ...SERVICE_TASK_KINDS], cur.id)}</div>`;
  if (cur.id === "message") {
    return picker + messageFieldsHTML(modeler, bo,
      "On reaching this send task the message is published; any instance waiting on it (a receive task or message catch) with a matching correlation key continues. The token then flows straight on.");
  }
  const ext = findExt(bo, cur.ext) || {};
  return picker + `<h3>${esc(cur.name)}</h3>${stKindFieldsHTML(cur, ext)}`;
}

// applyServiceTaskKind switches a service task to a catalog kind by writing that
// kind's extension (seeding select defaults) and removing every other kind's
// extension, so the compiler sees exactly one connector kind (ADR-0067).
function applyServiceTaskKind(modeler, element, kindId) {
  const kind = SERVICE_TASK_KINDS.find((k) => k.id === kindId) || SERVICE_TASK_KINDS[0];
  // The retry budget is a property of the task, not of the implementation it happens
  // to have (ADR-0135), so it survives a switch of kind even though each kind stores
  // it on its own extension — swapping a job worker for a REST connector must not
  // silently reset the task to the default three attempts.
  const prev = findExt(element.businessObject, serviceTaskKind(element.businessObject).ext) || {};
  for (const other of SERVICE_TASK_KINDS) {
    if (other.id !== kind.id) removeExt(modeler, element, other.ext);
  }
  const defaults = {};
  if (prev.retries && kind.fields.some((f) => f.key === "retries")) defaults.retries = prev.retries;
  for (const f of kind.fields) {
    if (f.type === "select" && f.options && f.options.length) {
      const v = selectOption(f.options[0]).v;
      if (v) defaults[f.key] = v;
    }
  }
  upsertExt(modeler, element, kind.ext, defaults);
}

// applySendTaskKind switches a send task between its Message kind and the connector/job-worker
// kinds (ADR-0112). The three kinds are mutually exclusive at compile time, so switching to
// Message drops every connector/taskDefinition extension (the message picker then sets the
// messageRef), and switching to a connector/worker clears any messageRef first.
function applySendTaskKind(modeler, element, kindId) {
  if (kindId === "message") {
    for (const k of SERVICE_TASK_KINDS) removeExt(modeler, element, k.ext);
    return;
  }
  const bo = element.businessObject;
  if (bo && bo.messageRef) linkMessage(modeler, element, bo, null);
  applyServiceTaskKind(modeler, element, kindId);
}

// decisionInputRowHTML renders one editable business-rule-task input mapping: a
// decision input name (target) fed by a FEEL source over the instance's variables.
// The stored source is '=' prefixed (Zeebe convention); it is shown stripped.
// Both fields are comboboxes (native datalist, ADR-0012 buildless): the name offers
// the decision's declared inputs (#dmn-inputs-dl), the source offers the diagram's
// known variables (#dmn-vars-dl) — so an author picks from a list instead of
// hand-typing, while any FEEL expression stays typable for composite sources.
function decisionInputRowHTML(i, source, target) {
  const src = (source || "").replace(/^=\s*/, "");
  return `<div class="dmn-input-row" data-i="${i}" style="display:flex;gap:6px;margin-bottom:6px">
    <input type="text" class="dmn-in-target" list="dmn-inputs-dl" value="${esc(target || "")}" placeholder="Season" style="flex:0 0 34%" title="Decision input name (from the decision)"/>
    <input type="text" class="dmn-in-source" list="dmn-vars-dl" value="${esc(src)}" placeholder="order.season" style="flex:1" title="A known variable, or any FEEL expression over the instance's variables"/>
  </div>`;
}

// saveDecisionInputs rebuilds a business rule task's zeebe:ioMapping input list
// from the panel rows. A row with no target is dropped (an incomplete row); each
// kept source is stored as a '=' prefixed FEEL expression. An empty list removes
// the ioMapping element entirely so the model stays clean.
function saveDecisionInputs(modeler, element, rows) {
  const moddle = modeler.get("moddle");
  const modeling = modeler.get("modeling");
  const bo = element.businessObject;
  let ext = bo.extensionElements;
  if (!ext) {
    ext = moddle.create("bpmn:ExtensionElements", { values: [] });
    ext.$parent = bo;
  }
  let io = (ext.values || []).find((v) => v.$type === "zeebe:IoMapping");
  const params = rows
    .filter((r) => r.target !== "")
    .map((r) => moddle.create("zeebe:Input", {
      source: r.source === "" ? "" : (r.source.startsWith("=") ? r.source : "= " + r.source),
      target: r.target,
    }));
  if (params.length === 0) {
    if (io) ext.values = (ext.values || []).filter((v) => v !== io);
  } else {
    if (!io) {
      io = moddle.create("zeebe:IoMapping");
      io.$parent = ext;
      ext.values = [...(ext.values || []), io];
    }
    params.forEach((p) => (p.$parent = io));
    io.inputParameters = params;
  }
  modeling.updateProperties(element, { extensionElements: ext });
}

// ioMapDefaultName mints an auto-generated variable name for a freshly added
// mapping, matching the modeler convention (InputVariable_xxxxxxx /
// OutputVariable_xxxxxxx) so an added mapping is complete — and thus saved — before
// the author has typed anything, exactly like Camunda's panel.
function ioMapDefaultName(kind) {
  const stem = kind === "in" ? "InputVariable_" : "OutputVariable_";
  return stem + Math.random().toString(36).slice(2, 9);
}

// ioMapTitle is the collapsed-card label for a mapping: its target variable name,
// or a placeholder while the name is still blank.
function ioMapTitle(kind, target) {
  const t = (target || "").trim();
  return t || (kind === "in" ? "Input mapping" : "Output mapping");
}

// ioTrashIcon is the small trash glyph used to delete a mapping card (styled red by
// .io-map-del). currentColor lets the CSS own the colour.
const ioTrashIcon = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 2.2h4M2.6 4.2h10.8M4.4 4.2l.5 8.4a1 1 0 0 0 1 .95h4.2a1 1 0 0 0 1-.95l.5-8.4M6.6 6.8v4.4M9.4 6.8v4.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ioMapCardHTML renders one mapping as a collapsible card (ADR-0068, Camunda-style):
// a header showing the target variable name (with a delete button), and a body with
// the target-name field and the FEEL "assignment value". kind is "in" (source over
// the enclosing scope → a local variable) or "out" (source over the local scope → a
// variable promoted to the parent). The stored source is '=' prefixed (Zeebe
// convention); it is shown stripped and re-prefixed on save.
function ioMapCardHTML(kind, i, source, target) {
  const src = (source || "").replace(/^=\s*/, "");
  const nameLabel = kind === "in" ? "Local variable name" : "Process variable name";
  const cfg = kind === "in"
    ? { np: "amount", sp: "order.total", nt: "Local variable the activity sees", st: "FEEL over the enclosing scope" }
    : { np: "orderStatus", sp: "result.status", nt: "Variable promoted to the process scope", st: "FEEL over the activity's local scope" };
  return `<div class="io-map" data-kind="${kind}" data-i="${i}">
    <div class="io-map-head">
      <span class="io-map-chevron" aria-hidden="true">▾</span>
      <span class="io-map-title">${esc(ioMapTitle(kind, target))}</span>
      <button type="button" class="io-map-del" title="Delete mapping" aria-label="Delete mapping">${ioTrashIcon}</button>
    </div>
    <div class="io-map-body">
      <label class="field"><span>${nameLabel}</span>
        <input type="text" class="io-target" value="${esc(target || "")}" placeholder="${cfg.np}" title="${cfg.nt}"/></label>
      <label class="field"><span>Variable assignment value <i class="io-fx" title="This value is a FEEL expression">fx</i></span>
        <div class="io-assign">
          <span class="io-eq" aria-hidden="true">=</span>
          <input type="text" class="io-source" value="${esc(src)}" placeholder="${cfg.sp}" spellcheck="false" title="${cfg.st}"/>
        </div></label>
    </div>
  </div>`;
}

// mappingGroupHTML renders one direction's mapping list as a collapsible group with
// an add button, a count badge, and a collapse chevron (Camunda-style). The group is
// flagged data-standalone-group so groupifyPanel leaves it intact rather than folding
// it into the preceding <h3> section. kind is "in" or "out".
function mappingGroupHTML(kind, params) {
  const meta = kind === "in"
    ? { title: "Input mapping", wrap: "io-inputs",
        hint: "Each mapping computes a variable the activity sees (its <b>local scope</b>) from a FEEL expression over the enclosing variables. Locals shadow inherited values and are dropped when the activity completes." }
    : { title: "Output mapping", wrap: "io-outputs",
        hint: "Each mapping promotes a value to the <b>process scope</b> from a FEEL expression over the activity's local scope (e.g. its result). With no output mapping the task's result merges into the process scope as-is." };
  const cards = params.map((p, i) => ioMapCardHTML(kind, i, p.source, p.target)).join("");
  return `<div class="io-group" data-kind="${kind}" data-group="${meta.title}" data-standalone-group="1">
    <div class="io-group-head">
      <span class="io-group-title">${meta.title}</span>
      <button type="button" class="io-group-add" title="Add mapping" aria-label="Add mapping">＋</button>
      <span class="io-group-count" title="Mappings">${params.length}</span>
      <span class="io-group-chevron" aria-hidden="true">▾</span>
    </div>
    <div class="io-group-body">
      <div class="io-map-list" id="${meta.wrap}">${cards}</div>
      <p class="muted io-group-hint">${meta.hint}</p>
    </div>
  </div>`;
}

// ioMappingsHTML renders the generic zeebe:ioMapping editor — an input and an output
// mapping group — for a job-backed activity (service, script, user task; ADR-0068).
// Each group adds mappings via its add button and grows/shrinks in place. It is
// distinct from a business rule task's ioMapping inputs (decision inputs), which
// have their own editor.
function ioMappingsHTML(bo) {
  const io = findExt(bo, "zeebe:IoMapping");
  const ins = (io && io.inputParameters) || [];
  const outs = (io && io.outputParameters) || [];
  return mappingGroupHTML("in", ins) + mappingGroupHTML("out", outs);
}

// saveIOMappings rebuilds a task's generic zeebe:ioMapping from the panel rows: the
// input rows become inputParameters, the output rows outputParameters. A row with no
// target is dropped; each kept source is stored '=' prefixed. When both lists are
// empty the ioMapping element is removed so the model stays clean (ADR-0068).
function saveIOMappings(modeler, element, inRows, outRows) {
  const moddle = modeler.get("moddle");
  const modeling = modeler.get("modeling");
  const bo = element.businessObject;
  let ext = bo.extensionElements;
  if (!ext) {
    ext = moddle.create("bpmn:ExtensionElements", { values: [] });
    ext.$parent = bo;
  }
  let io = (ext.values || []).find((v) => v.$type === "zeebe:IoMapping");
  const mk = (type, rows) => rows
    .filter((r) => r.target !== "")
    .map((r) => moddle.create(type, {
      source: r.source === "" ? "" : (r.source.startsWith("=") ? r.source : "= " + r.source),
      target: r.target,
    }));
  const ins = mk("zeebe:Input", inRows);
  const outs = mk("zeebe:Output", outRows);
  if (ins.length === 0 && outs.length === 0) {
    if (io) ext.values = (ext.values || []).filter((v) => v !== io);
  } else {
    if (!io) {
      io = moddle.create("zeebe:IoMapping");
      io.$parent = ext;
      ext.values = [...(ext.values || []), io];
    }
    [...ins, ...outs].forEach((p) => (p.$parent = io));
    io.inputParameters = ins;
    io.outputParameters = outs;
  }
  modeling.updateProperties(element, { extensionElements: ext });
}

// loopMode reports which loop marker an activity carries — the value of the Mode
// select and, one to one, the marker bpmn-js draws on the shape: "none" (no marker),
// "loop" (bpmn:StandardLoopCharacteristics, the ↻ icon, ADR-0133), or "parallel" /
// "sequential" (bpmn:MultiInstanceLoopCharacteristics, the ∥ / ≡ icons, ADR-0077).
// Every reader of the loop section goes through this, so the panel can never disagree
// with the icon: whatever set the characteristics — this panel, the context pad's
// marker toggle, or an imported file — reads back as the mode that drew it.
function loopMode(bo) {
  const lc = bo.loopCharacteristics;
  if (!lc) return "none";
  if (lc.$type === "bpmn:StandardLoopCharacteristics") return "loop";
  if (lc.$type === "bpmn:MultiInstanceLoopCharacteristics") return lc.isSequential ? "sequential" : "parallel";
  return "none";
}

// multiInstanceHTML renders the Loop section for an activity: the mode — a BPMN
// standard loop (ADR-0133) or a parallel/sequential multi-instance (ADR-0077) — and
// the fields that mode needs. For a multi-instance: whether it runs over a collection
// or a fixed count, the per-iteration input element, an optional output
// collection/element, and an optional completion condition, read from the activity's
// bpmn:MultiInstanceLoopCharacteristics (bo.loopCharacteristics) and its nested
// <zeebe:loopCharacteristics> plus <loopCardinality>/<completionCondition>. For a
// standard loop: the repeat-while condition, when it is checked, and the iteration
// cap, read from bpmn:StandardLoopCharacteristics. Changing the mode or the
// collection/count choice re-renders the panel so the right fields show; FEEL values
// are stored '=' prefixed (stripped for display), matching the io-mapping editor. The
// whole block only shows for the activity types the compiler supports (service/script/
// user tasks, call activities, subprocesses).
function multiInstanceHTML(bo) {
  const mi = bo.loopCharacteristics;
  const mode = loopMode(bo);
  const on = mode === "parallel" || mode === "sequential";
  const loop = on && mi.extensionElements
    ? (mi.extensionElements.values || []).find((v) => v.$type === "zeebe:LoopCharacteristics")
    : null;
  const cardBody = on && mi.loopCardinality ? (mi.loopCardinality.body || "") : "";
  const compBody = on && mi.completionCondition ? (mi.completionCondition.body || "") : "";
  const ic = (loop && loop.inputCollection) || "";
  const ie = (loop && loop.inputElement) || "";
  const oc = (loop && loop.outputCollection) || "";
  const oe = (loop && loop.outputElement) || "";
  // A loop with a cardinality and no input collection is the "fixed count" variant.
  const src = cardBody && !ic ? "cardinality" : "collection";
  const strip = (s) => (s || "").replace(/^=\s*/, "");

  let html = `<h3>Loop</h3>
    <label class="field"><span>Mode</span>
      <select id="f-mi-mode">
        <option value="none" ${mode === "none" ? "selected" : ""}>None — runs once</option>
        <option value="loop" ${mode === "loop" ? "selected" : ""}>Loop — repeat while a condition holds</option>
        <option value="parallel" ${mode === "parallel" ? "selected" : ""}>Multi-instance parallel — all iterations at once</option>
        <option value="sequential" ${mode === "sequential" ? "selected" : ""}>Multi-instance sequential — one after another</option>
      </select></label>`;
  if (mode === "none") return html;
  if (mode === "loop") return html + standardLoopHTML(mi, strip);

  html += `<label class="field"><span>Iterate over</span>
      <select id="f-mi-src">
        <option value="collection" ${src === "collection" ? "selected" : ""}>A collection</option>
        <option value="cardinality" ${src === "cardinality" ? "selected" : ""}>A fixed count</option>
      </select></label>`;
  if (src === "collection") {
    html += `<label class="field"><span>Input collection (FEEL)</span>
        <input type="text" id="f-mi-inputCollection" value="${esc(strip(ic))}" placeholder="orderLines"/></label>
      <label class="field"><span>Input element</span>
        <input type="text" id="f-mi-inputElement" value="${esc(ie)}" placeholder="line"/></label>`;
  } else {
    html += `<label class="field"><span>Loop cardinality (FEEL or a number)</span>
        <input type="text" id="f-mi-cardinality" value="${esc(strip(cardBody))}" placeholder="3"/></label>`;
  }
  html += `<label class="field"><span>Output collection <span class="muted">(optional)</span></span>
      <input type="text" id="f-mi-outputCollection" value="${esc(oc)}" placeholder="totals"/></label>
    <label class="field"><span>Output element (FEEL) <span class="muted">(optional)</span></span>
      <input type="text" id="f-mi-outputElement" value="${esc(strip(oe))}" placeholder="line.qty * line.price"/></label>
    <label class="field"><span>Completion condition (FEEL) <span class="muted">(optional)</span></span>
      <input type="text" id="f-mi-completion" value="${esc(strip(compBody))}" placeholder="count(totals) > 2"/></label>
    <p class="muted" style="font-size:12px">${mode === "sequential"
      ? "Runs one iteration at a time — the next starts only when the previous finishes."
      : "Starts every iteration at once and waits until all finish."} ${src === "collection"
      ? "One iteration per element of the <b>input collection</b>; the <b>input element</b> is the variable each iteration binds its item to (plus the built-in <code>loopCounter</code>)."
      : "Runs <b>loop cardinality</b> times, each with a <code>loopCounter</code>."} An <b>output collection</b> gathers each iteration's <b>output element</b> into a list in order; a <b>completion condition</b> ends the loop early.</p>`;
  return html;
}

// standardLoopHTML renders the fields of a BPMN standard loop — the ↻ marker
// (ADR-0133): the FEEL condition the loop repeats while, when that condition is
// checked (testBefore: before the first run makes it a while loop that may skip the
// activity entirely; after each run is BPMN's default repeat-until, which always runs
// once), and an optional iteration cap. sl is the bpmn:StandardLoopCharacteristics.
function standardLoopHTML(sl, strip) {
  const cond = sl && sl.loopCondition ? (sl.loopCondition.body || "") : "";
  const max = sl && sl.loopMaximum != null ? String(sl.loopMaximum) : "";
  const before = !!(sl && sl.testBefore);
  return `<label class="field"><span>Repeat while (FEEL)</span>
      <input type="text" id="f-mi-loopcond" value="${esc(strip(cond))}" placeholder="not(approved)"/></label>
    <label class="field"><span>Check the condition</span>
      <select id="f-mi-testbefore">
        <option value="after" ${before ? "" : "selected"}>After each run — the activity always runs at least once</option>
        <option value="before" ${before ? "selected" : ""}>Before each run — the activity may be skipped entirely</option>
      </select></label>
    <label class="field"><span>Max iterations <span class="muted">(optional)</span></span>
      <input type="number" min="1" id="f-mi-loopmax" value="${esc(max)}" placeholder="no limit"/></label>
    <p class="muted" style="font-size:12px">Runs the activity again and again while <b>repeat while</b> holds — one run at a time, each with a 1-based <code>loopCounter</code> the condition can read. What a run writes stays visible to the next run and to the rest of the process, so the loop can work towards its own exit. <b>Max iterations</b> is a hard stop; give a condition, a cap, or both. Without a cap the engine stops a loop after <b>1000</b> runs with an incident you can resolve to grant 1000 more — a backstop for a condition that never turns false, not a limit on a cap you set yourself.</p>`;
}

// saveMultiInstance writes (or clears) an activity's bpmn:MultiInstanceLoopCharacteristics
// from the panel fields (ADR-0077). Mode "none" drops it entirely; otherwise it
// rebuilds the whole element — the isSequential flag, a nested <zeebe:loopCharacteristics>
// (only the non-empty of inputCollection/inputElement or outputCollection/outputElement),
// a <loopCardinality> for the fixed-count variant, and a <completionCondition> — so
// editing one field never leaves a stale sibling. FEEL values are stored '=' prefixed.
function saveMultiInstance(modeler, element, vals) {
  const moddle = modeler.get("moddle");
  const modeling = modeler.get("modeling");
  const bo = element.businessObject;
  if (vals.mode === "none") {
    modeling.updateProperties(element, { loopCharacteristics: undefined });
    return;
  }
  const feel = (v) => { v = (v || "").trim(); return v === "" ? "" : (v.startsWith("=") ? v : "= " + v); };
  // A standard loop is the other BPMN marker (ADR-0133) — its own element, with the
  // condition, the testBefore flag, and the cap. Written whole like the multi-instance
  // one, so switching modes or clearing a field never leaves a stale sibling behind.
  if (vals.mode === "loop") {
    const props = {};
    if (vals.testBefore) props.testBefore = true;
    const max = parseInt(vals.loopMaximum, 10);
    if (max > 0) props.loopMaximum = max;
    const sl = moddle.create("bpmn:StandardLoopCharacteristics", props);
    sl.$parent = bo;
    if (vals.loopCondition) {
      const cond = moddle.create("bpmn:FormalExpression", { body: feel(vals.loopCondition) });
      cond.$parent = sl;
      sl.loopCondition = cond;
    }
    modeling.updateProperties(element, { loopCharacteristics: sl });
    return;
  }
  const mi = moddle.create("bpmn:MultiInstanceLoopCharacteristics", { isSequential: vals.mode === "sequential" });
  mi.$parent = bo;

  const loopProps = {};
  if (vals.src === "collection") {
    if (vals.inputCollection) loopProps.inputCollection = feel(vals.inputCollection);
    if (vals.inputElement) loopProps.inputElement = vals.inputElement;
  }
  if (vals.outputCollection) loopProps.outputCollection = vals.outputCollection;
  if (vals.outputElement) loopProps.outputElement = feel(vals.outputElement);
  if (Object.keys(loopProps).length) {
    const loop = moddle.create("zeebe:LoopCharacteristics", loopProps);
    const ext = moddle.create("bpmn:ExtensionElements", { values: [loop] });
    ext.$parent = mi;
    loop.$parent = ext;
    mi.extensionElements = ext;
  }
  if (vals.src === "cardinality" && vals.cardinality) {
    const card = moddle.create("bpmn:FormalExpression", { body: feel(vals.cardinality) });
    card.$parent = mi;
    mi.loopCardinality = card;
  }
  if (vals.completion) {
    const cc = moddle.create("bpmn:FormalExpression", { body: feel(vals.completion) });
    cc.$parent = mi;
    mi.completionCondition = cc;
  }
  modeling.updateProperties(element, { loopCharacteristics: mi });
}

// messageFieldsHTML renders the message picker for a catch or throw event: a
// dropdown of the model's shared messages (plus "new"), and — once one is chosen —
// its name and correlation key, which are shared so every event using the message
// stays in sync (that's what lets a throw and a catch correlate). med is the
// bpmn:MessageEventDefinition.
function messageFieldsHTML(modeler, med, hint) {
  const current = med.messageRef;
  const options = listMessages(modeler).map((m) =>
    `<option value="${esc(m.id)}"${current && current.id === m.id ? " selected" : ""}>${esc(m.name || m.id)}</option>`
  ).join("");
  const fields = current ? `
    <label class="field"><span>Message name</span>
      <input type="text" id="f-msgname" value="${esc(current.name || "")}" placeholder="payment-received"/></label>
    <label class="field"><span>Correlation key (FEEL)</span>
      <textarea id="f-corrkey" rows="1" placeholder="orderId">${esc(messageCorrelationKey(current))}</textarea></label>
    <p class="muted" style="font-size:12px">Shared with every event that uses this message — a throw and a catch correlate when they use the same message and their keys evaluate equal.</p>` : "";
  return `<h3>Message</h3>
    <label class="field"><span>Message</span>
      <select id="f-msgref">
        <option value="">— none —</option>
        ${options}
        <option value="__new__">＋ New message…</option>
      </select></label>
    ${fields}
    <p class="muted" style="font-size:12px">${hint}</p>`;
}

// messagesManagerHTML lists the model's messages for central management (add,
// rename, set correlation key, delete). Shown on the diagram/collaboration root.
function messagesManagerHTML(modeler) {
  const msgs = listMessages(modeler);
  const rows = msgs.length
    ? msgs.map((m) => `
        <div class="msg-row" data-id="${esc(m.id)}">
          <input class="msg-name" value="${esc(m.name || "")}" placeholder="message name"/>
          <input class="msg-key" value="${esc(messageCorrelationKey(m))}" placeholder="correlationKey (FEEL)"/>
          <button type="button" class="btn ghost danger msg-del" title="Delete message">✕</button>
        </div>`).join("")
    : `<p class="muted" style="font-size:12px;margin:0 0 8px">No messages yet — add one, then reference it from a message throw/catch event.</p>`;
  return `<h3>Messages</h3>
    <div class="msg-list">${rows}</div>
    <button type="button" class="btn neutral" id="msg-add" style="margin-top:8px">＋ Add message</button>
    <p class="muted" style="font-size:12px">A message links a <b>throw</b> event to the <b>catch</b> events waiting for it. They correlate when they share a message and their correlation keys evaluate equal.</p>`;
}

// wireMessagesManager binds the Messages management section's inputs and buttons.
// rerenderRoot re-renders the root panel after add/delete so the list updates.
function wireMessagesManager(body, modeler, rerenderRoot) {
  const add = body.querySelector("#msg-add");
  if (add) add.addEventListener("click", () => { createMessage(modeler, "message"); rerenderRoot(); });
  body.querySelectorAll(".msg-row").forEach((row) => {
    const id = row.dataset.id;
    const msg = () => listMessages(modeler).find((m) => m.id === id);
    const nameIn = row.querySelector(".msg-name");
    const keyIn = row.querySelector(".msg-key");
    if (nameIn) nameIn.addEventListener("change", () => { const m = msg(); if (m) m.name = nameIn.value.trim(); });
    if (keyIn) keyIn.addEventListener("change", () => { const m = msg(); if (m) setMessageCorrelationKey(modeler, m, keyIn.value.trim()); });
    const del = row.querySelector(".msg-del");
    if (del) del.addEventListener("click", () => { deleteMessage(modeler, id); rerenderRoot(); });
  });
}

const isActivity = (bo) => /Task$/.test((bo && bo.$type) || "");

// timerDefOf returns an event's bpmn:TimerEventDefinition, or null.
function timerDefOf(bo) {
  return (bo && bo.eventDefinitions || []).find((d) => d.$type === "bpmn:TimerEventDefinition") || null;
}

// The three schedule kinds a TimerEventDefinition can carry, mapped to the
// bpmn element each writes and how the panel labels it. A start event accepts
// all three; a catch or interrupting boundary fires once, so they omit the
// recurring cycle (ADR-0051/0054). Iteration order (duration, date, cycle) is
// the detection precedence in timerScheduleOf.
const TIMER_KINDS = {
  duration: { prop: "timeDuration", label: "Duration", placeholder: "PT30M" },
  date: { prop: "timeDate", label: "Date & time", placeholder: "2026-08-01T09:00:00Z" },
  cycle: { prop: "timeCycle", label: "Cycle", placeholder: "R/PT1H  ·  0 * * * *" },
};

// timerScheduleOf reports which kind a timer currently holds and its expression
// text. It keys off which sub-element exists (not its body), so a just-switched,
// still-empty kind survives a re-render. Defaults to duration for a bare timer.
function timerScheduleOf(timer) {
  for (const [kind, meta] of Object.entries(TIMER_KINDS)) {
    if (timer && timer[meta.prop]) return { kind, body: timer[meta.prop].body || "" };
  }
  return { kind: "duration", body: "" };
}

// timerFieldsHTML renders the Type picker (restricted to the kinds valid in this
// context) and the schedule-expression input, followed by a context note.
function timerFieldsHTML(timer, kinds, note) {
  const detected = timerScheduleOf(timer);
  const kind = kinds.includes(detected.kind) ? detected.kind : kinds[0];
  const meta = TIMER_KINDS[kind];
  const body = (timer && timer[meta.prop] && timer[meta.prop].body) || "";
  const opts = kinds
    .map((k) => `<option value="${k}" ${k === kind ? "selected" : ""}>${TIMER_KINDS[k].label}</option>`)
    .join("");
  return `<h3>Timer</h3>
    <label class="field"><span>Type</span>
      <select id="f-timerkind">${opts}</select></label>
    <label class="field"><span>${meta.label}</span>
      <input type="text" id="f-timerval" value="${esc(body)}" placeholder="${esc(meta.placeholder)}"/></label>
    <p class="muted" style="font-size:12px">${note}</p>`;
}

// messageDefOf returns an event's bpmn:MessageEventDefinition, or null.
function messageDefOf(bo) {
  return (bo && bo.eventDefinitions || []).find((d) => d.$type === "bpmn:MessageEventDefinition") || null;
}

// messageRefHolder returns the moddle object that carries an element's messageRef: the
// bpmn:MessageEventDefinition for a message event, or the receive task's own business object
// (a receive task holds messageRef directly, not via an event definition — ADR-0102). It is
// what the message picker reads and its handlers write, so a receive task reuses the same
// picker as a message catch. null when the element references no message.
function messageRefHolder(bo) {
  // A receive task (ADR-0102) and a message-kind send task (ADR-0112) both hold messageRef
  // directly on their own business object, not via an event definition, so the shared
  // message picker reads and writes them the same way it does a message event.
  if (bo && (bo.$type === "bpmn:ReceiveTask" || bo.$type === "bpmn:SendTask")) return bo;
  return messageDefOf(bo);
}

// isEventSubStart reports whether a start event is the trigger of an event subprocess —
// i.e. it sits directly inside a subprocess whose triggeredByEvent is set (ADR-0082). Such
// a start carries a message/timer trigger and an isInterrupting flag, not a process-entry
// form. bpmn-js sets triggeredByEvent (and draws the dashed container) when the user makes
// the subprocess an event subprocess.
function isEventSubStart(element) {
  const p = element && element.parent && element.parent.businessObject;
  return !!(p && p.$type === "bpmn:SubProcess" && p.triggeredByEvent === true);
}

// definitionsOf returns the diagram's <bpmn:definitions> moddle element, where
// top-level <bpmn:message> declarations live.
function definitionsOf(modeler) {
  try { if (typeof modeler.getDefinitions === "function") return modeler.getDefinitions(); } catch { /* older bpmn-js */ }
  try { return modeler.get("canvas").getRootElement().businessObject.$parent; } catch { return null; }
}

// Messages are top-level <bpmn:message> declarations shared by reference: a throw
// event and the catch events waiting for it must point at the SAME message (same
// name and correlation key) to correlate. These helpers let the editor treat
// messages as first-class, reusable definitions rather than per-event text.

// listMessages returns every <bpmn:message> declared on the model's definitions.
function listMessages(modeler) {
  const defs = definitionsOf(modeler);
  const out = [];
  if (defs && defs.rootElements) {
    for (const el of defs.rootElements) {
      if (el.$type === "bpmn:Message") out.push(el);
    }
  }
  return out;
}

// messageCorrelationKey reads a message's zeebe correlation-key expression,
// stripped of the leading '=' the engine tolerates.
function messageCorrelationKey(msg) {
  const vals = msg && msg.extensionElements && msg.extensionElements.values;
  const sub = vals && vals.find((v) => v.$type === "zeebe:Subscription");
  return ((sub && sub.correlationKey) || "").replace(/^=\s*/, "");
}

// createMessage adds a fresh <bpmn:message> to the model and returns it.
function createMessage(modeler, name) {
  const moddle = modeler.get("moddle");
  const msg = moddle.create("bpmn:Message");
  msg.id = "Message_" + Math.random().toString(36).slice(2, 8);
  msg.name = name || "";
  const defs = definitionsOf(modeler);
  if (defs) {
    msg.$parent = defs;
    defs.rootElements = [...(defs.rootElements || []), msg];
  }
  return msg;
}

// setMessageCorrelationKey sets a message's shared zeebe correlation-key
// expression (normalizing the Zeebe '=' prefix); it applies to every event that
// references the message.
function setMessageCorrelationKey(modeler, msg, key) {
  const moddle = modeler.get("moddle");
  let ext = msg.extensionElements;
  if (!ext) { ext = moddle.create("bpmn:ExtensionElements", { values: [] }); ext.$parent = msg; msg.extensionElements = ext; }
  let sub = (ext.values || []).find((v) => v.$type === "zeebe:Subscription");
  if (!sub) { sub = moddle.create("zeebe:Subscription"); sub.$parent = ext; ext.values = [...(ext.values || []), sub]; }
  const k = (key || "").trim();
  sub.correlationKey = k === "" ? "" : (k.startsWith("=") ? k : "= " + k);
}

// linkMessage points a message event definition at a message (undo/redo tracked).
function linkMessage(modeler, element, med, msg) {
  try { modeler.get("modeling").updateModdleProperties(element, med, { messageRef: msg || undefined }); } catch { /* stale */ }
}

// deleteMessage removes a message and clears any event still referencing it, so a
// deleted message never leaves a dangling messageRef (which would fail to compile).
function deleteMessage(modeler, msgId) {
  const defs = definitionsOf(modeler);
  if (defs && defs.rootElements) defs.rootElements = defs.rootElements.filter((e) => e.id !== msgId);
  const modeling = modeler.get("modeling");
  modeler.get("elementRegistry").getAll().forEach((el) => {
    const med = messageDefOf(el.businessObject);
    if (med && med.messageRef && med.messageRef.id === msgId) {
      try { modeling.updateModdleProperties(el, med, { messageRef: undefined }); } catch { /* stale */ }
    }
  });
}

// --- Signals (broadcast events, ADR-0088) ---
//
// A signal is a top-level <bpmn:signal> declaration shared by reference, exactly like a
// message — except a signal has NO correlation key: it is a 1:n broadcast delivered by
// name alone to every waiting catch (an intermediate catch, a signal boundary, a signal
// event subprocess, a signal start). These helpers mirror the message ones, dropping the
// correlation-key concept.

// signalDefOf returns an event's bpmn:SignalEventDefinition, or null.
function signalDefOf(bo) {
  return (bo && bo.eventDefinitions || []).find((d) => d.$type === "bpmn:SignalEventDefinition") || null;
}

// listSignals returns every <bpmn:signal> declared on the model's definitions.
function listSignals(modeler) {
  const defs = definitionsOf(modeler);
  const out = [];
  if (defs && defs.rootElements) {
    for (const el of defs.rootElements) {
      if (el.$type === "bpmn:Signal") out.push(el);
    }
  }
  return out;
}

// createSignal adds a fresh <bpmn:signal> to the model and returns it.
function createSignal(modeler, name) {
  const moddle = modeler.get("moddle");
  const sig = moddle.create("bpmn:Signal");
  sig.id = "Signal_" + Math.random().toString(36).slice(2, 8);
  sig.name = name || "";
  const defs = definitionsOf(modeler);
  if (defs) {
    sig.$parent = defs;
    defs.rootElements = [...(defs.rootElements || []), sig];
  }
  return sig;
}

// linkSignal points a signal event definition at a signal (undo/redo tracked).
function linkSignal(modeler, element, sed, sig) {
  try { modeler.get("modeling").updateModdleProperties(element, sed, { signalRef: sig || undefined }); } catch { /* stale */ }
}

// deleteSignal removes a signal and clears any event still referencing it, so a deleted
// signal never leaves a dangling signalRef (which would fail to compile).
function deleteSignal(modeler, sigId) {
  const defs = definitionsOf(modeler);
  if (defs && defs.rootElements) defs.rootElements = defs.rootElements.filter((e) => e.id !== sigId);
  const modeling = modeler.get("modeling");
  modeler.get("elementRegistry").getAll().forEach((el) => {
    const sed = signalDefOf(el.businessObject);
    if (sed && sed.signalRef && sed.signalRef.id === sigId) {
      try { modeling.updateModdleProperties(el, sed, { signalRef: undefined }); } catch { /* stale */ }
    }
  });
}

// signalFieldsHTML renders the signal picker for a catch/throw/boundary/start/end event:
// a dropdown of the model's shared signals (plus "new") and — once one is chosen — its
// name, shared so every event using the signal stays in sync. Unlike a message there is
// no correlation key: a signal broadcasts by name alone. sed is the
// bpmn:SignalEventDefinition.
function signalFieldsHTML(modeler, sed, hint) {
  const current = sed.signalRef;
  const options = listSignals(modeler).map((s) =>
    `<option value="${esc(s.id)}"${current && current.id === s.id ? " selected" : ""}>${esc(s.name || s.id)}</option>`
  ).join("");
  const fields = current ? `
    <label class="field"><span>Signal name</span>
      <input type="text" id="f-signame" value="${esc(current.name || "")}" placeholder="order-cancelled"/></label>
    <p class="muted" style="font-size:12px">Shared with every event that uses this signal — a broadcast reaches every catch, boundary, event subprocess, and start event of the same name.</p>` : "";
  return `<h3>Signal</h3>
    <label class="field"><span>Signal</span>
      <select id="f-sigref">
        <option value="">— none —</option>
        ${options}
        <option value="__new__">＋ New signal…</option>
      </select></label>
    ${fields}
    <p class="muted" style="font-size:12px">${hint}</p>`;
}

// signalsManagerHTML lists the model's signals for central management (add, rename,
// delete). Shown on the diagram/collaboration root alongside the messages manager.
function signalsManagerHTML(modeler) {
  const sigs = listSignals(modeler);
  const rows = sigs.length
    ? sigs.map((s) => `
        <div class="sig-row" data-id="${esc(s.id)}">
          <input class="sig-name" value="${esc(s.name || "")}" placeholder="signal name"/>
          <button type="button" class="btn ghost danger sig-del" title="Delete signal">✕</button>
        </div>`).join("")
    : `<p class="muted" style="font-size:12px;margin:0 0 8px">No signals yet — add one, then reference it from a signal throw/catch/boundary/start event.</p>`;
  return `<h3>Signals</h3>
    <div class="sig-list">${rows}</div>
    <button type="button" class="btn neutral" id="sig-add" style="margin-top:8px">＋ Add signal</button>
    <p class="muted" style="font-size:12px">A signal is a broadcast by name: a <b>throw</b> reaches every <b>catch</b>, boundary, event subprocess, and start event using the same signal — with no correlation key.</p>`;
}

// wireSignalsManager binds the Signals management section's inputs and buttons.
// rerenderRoot re-renders the root panel after add/delete so the list updates.
function wireSignalsManager(body, modeler, rerenderRoot) {
  const add = body.querySelector("#sig-add");
  if (add) add.addEventListener("click", () => { createSignal(modeler, "signal"); rerenderRoot(); });
  body.querySelectorAll(".sig-row").forEach((row) => {
    const id = row.dataset.id;
    const sig = () => listSignals(modeler).find((s) => s.id === id);
    const nameIn = row.querySelector(".sig-name");
    if (nameIn) nameIn.addEventListener("change", () => { const s = sig(); if (s) s.name = nameIn.value.trim(); });
    const del = row.querySelector(".sig-del");
    if (del) del.addEventListener("click", () => { deleteSignal(modeler, id); rerenderRoot(); });
  });
}

// --- Errors (scoped failures, ADR-0089) ---
//
// An error is a top-level <bpmn:error> declaration shared by reference, like a message or
// signal — but matched by its errorCode (not a name or correlation key) and delivered to the
// NEAREST enclosing handler (an error boundary or error event subprocess), not broadcast. An
// error is thrown by an error end event (or a worker failing a job to a code); an error catch
// is always interrupting. These helpers mirror the signal ones, authoring the error code — a
// code-less error is a catch-all when caught, an uncoded throw when thrown.

// errorDefOf returns an event's bpmn:ErrorEventDefinition, or null.
function errorDefOf(bo) {
  return (bo && bo.eventDefinitions || []).find((d) => d.$type === "bpmn:ErrorEventDefinition") || null;
}

// cancelDefOf returns the <cancelEventDefinition> of an element, or null. On a boundary event
// it makes a cancel boundary (a transaction's cancellation catch); on an end event a cancel
// end event (ADR-0108).
function cancelDefOf(bo) {
  return (bo && bo.eventDefinitions || []).find((d) => d.$type === "bpmn:CancelEventDefinition") || null;
}

// listErrors returns every <bpmn:error> declared on the model's definitions.
function listErrors(modeler) {
  const defs = definitionsOf(modeler);
  const out = [];
  if (defs && defs.rootElements) {
    for (const el of defs.rootElements) {
      if (el.$type === "bpmn:Error") out.push(el);
    }
  }
  return out;
}

// createError adds a fresh <bpmn:error> with the given code to the model and returns it.
function createError(modeler, code) {
  const moddle = modeler.get("moddle");
  const err = moddle.create("bpmn:Error");
  err.id = "Error_" + Math.random().toString(36).slice(2, 8);
  err.errorCode = code || "";
  const defs = definitionsOf(modeler);
  if (defs) {
    err.$parent = defs;
    defs.rootElements = [...(defs.rootElements || []), err];
  }
  return err;
}

// linkError points an error event definition at an error (undo/redo tracked).
function linkError(modeler, element, eed, err) {
  try { modeler.get("modeling").updateModdleProperties(element, eed, { errorRef: err || undefined }); } catch { /* stale */ }
}

// deleteError removes an error and clears any event still referencing it, so a deleted error
// never leaves a dangling errorRef (which would fail to compile).
function deleteError(modeler, errId) {
  const defs = definitionsOf(modeler);
  if (defs && defs.rootElements) defs.rootElements = defs.rootElements.filter((e) => e.id !== errId);
  const modeling = modeler.get("modeling");
  modeler.get("elementRegistry").getAll().forEach((el) => {
    const eed = errorDefOf(el.businessObject);
    if (eed && eed.errorRef && eed.errorRef.id === errId) {
      try { modeling.updateModdleProperties(el, eed, { errorRef: undefined }); } catch { /* stale */ }
    }
  });
}

// errorFieldsHTML renders the error picker for an error end event or an error boundary /
// event subprocess: a dropdown of the model's shared errors (plus "new") and — once one is
// chosen — its code, shared so a thrower and its catchers stay in sync. Matching is by code;
// a code-less error is a catch-all. eed is the bpmn:ErrorEventDefinition.
function errorFieldsHTML(modeler, eed, hint) {
  const current = eed.errorRef;
  const options = listErrors(modeler).map((e) =>
    `<option value="${esc(e.id)}"${current && current.id === e.id ? " selected" : ""}>${esc(e.errorCode || e.id)}</option>`
  ).join("");
  const fields = current ? `
    <label class="field"><span>Error code</span>
      <input type="text" id="f-errcode" value="${esc(current.errorCode || "")}" placeholder="PAYMENT_FAILED"/></label>
    <p class="muted" style="font-size:12px">Shared with every event that uses this error — a thrown code is caught by the nearest enclosing error boundary or error event subprocess with the same code (an empty code is a catch-all).</p>` : "";
  return `<h3>Error</h3>
    <label class="field"><span>Error</span>
      <select id="f-errref">
        <option value="">— none —</option>
        ${options}
        <option value="__new__">＋ New error…</option>
      </select></label>
    ${fields}
    <p class="muted" style="font-size:12px">${hint}</p>`;
}

// errorsManagerHTML lists the model's errors for central management (add, edit code, delete).
function errorsManagerHTML(modeler) {
  const errs = listErrors(modeler);
  const rows = errs.length
    ? errs.map((e) => `
        <div class="err-row" data-id="${esc(e.id)}">
          <input class="err-code" value="${esc(e.errorCode || "")}" placeholder="error code"/>
          <button type="button" class="btn ghost danger err-del" title="Delete error">✕</button>
        </div>`).join("")
    : `<p class="muted" style="font-size:12px;margin:0 0 8px">No errors yet — add one, then reference it from an error end event or error boundary.</p>`;
  return `<h3>Errors</h3>
    <div class="err-list">${rows}</div>
    <button type="button" class="btn neutral" id="err-add" style="margin-top:8px">＋ Add error</button>
    <p class="muted" style="font-size:12px">An error is a scoped failure caught by code: an <b>error end event</b> (or a worker) throws it, and the nearest enclosing <b>error boundary</b> or <b>error event subprocess</b> with the same code catches it — always interrupting.</p>`;
}

// wireErrorsManager binds the Errors management section's inputs and buttons.
// rerenderRoot re-renders the root panel after add/delete so the list updates.
function wireErrorsManager(body, modeler, rerenderRoot) {
  const add = body.querySelector("#err-add");
  if (add) add.addEventListener("click", () => { createError(modeler, "ERROR_CODE"); rerenderRoot(); });
  body.querySelectorAll(".err-row").forEach((row) => {
    const id = row.dataset.id;
    const err = () => listErrors(modeler).find((e) => e.id === id);
    const codeIn = row.querySelector(".err-code");
    if (codeIn) codeIn.addEventListener("change", () => { const e = err(); if (e) e.errorCode = codeIn.value.trim(); });
    const del = row.querySelector(".err-del");
    if (del) del.addEventListener("click", () => { deleteError(modeler, id); rerenderRoot(); });
  });
}

// --- Escalation authoring (ADR-0125) ---
// An escalation is raised by an escalation throw or end event and caught by the nearest
// enclosing escalation boundary or event subprocess with a matching code. Unlike an error, an
// escalation catch may be non-interrupting (the handler runs alongside the still-running
// activity) and an uncaught escalation is benign. These helpers mirror the error ones, keyed on
// the escalation code — a code-less escalation is a catch-all when caught, an uncoded raise when
// thrown.

// escalationDefOf returns an event's bpmn:EscalationEventDefinition, or null.
function escalationDefOf(bo) {
  return (bo && bo.eventDefinitions || []).find((d) => d.$type === "bpmn:EscalationEventDefinition") || null;
}

// linkDefOf returns an event's bpmn:LinkEventDefinition, or null. A link intermediate throw
// jumps to the link intermediate catch of the same name in the same scope — an off-page
// connector / goto (ADR-0133).
function linkDefOf(bo) {
  return (bo && bo.eventDefinitions || []).find((d) => d.$type === "bpmn:LinkEventDefinition") || null;
}

// linkFieldsHTML renders the link-name field for a link throw or catch. A throw jumps to the
// catch of the same name in the same scope; the name is the whole configuration (ADR-0133).
function linkFieldsHTML(led, hint) {
  return `<h3>Link</h3>
    <label class="field"><span>Link name</span>
      <input type="text" id="f-linkname" value="${esc(led.name || "")}" placeholder="ProceedHere"/></label>
    <p class="muted" style="font-size:12px">${hint}</p>`;
}

// conditionalDefOf returns an event's bpmn:ConditionalEventDefinition, or null. A conditional
// event fires when its boolean FEEL condition over the process's variables becomes true —
// re-evaluated on every variable change (ADR-0137).
function conditionalDefOf(bo) {
  return (bo && bo.eventDefinitions || []).find((d) => d.$type === "bpmn:ConditionalEventDefinition") || null;
}

// conditionalFieldsHTML renders the FEEL condition field for a conditional catch, boundary, or
// event-subprocess start. The condition is a boolean FEEL expression over the scope's variables;
// the event fires when it becomes true (ADR-0137). ced is the bpmn:ConditionalEventDefinition.
function conditionalFieldsHTML(ced, hint) {
  const condText = ((ced.condition && ced.condition.body) || "").replace(/^=\s*/, "");
  return `<h3>Condition (FEEL)</h3>
    <label class="field"><span>Expression</span>
      <textarea id="f-condition" rows="2" placeholder="amount > 100">${esc(condText)}</textarea></label>
    <p class="muted" style="font-size:12px">${hint}</p>`;
}

// listEscalations returns every <bpmn:escalation> declared on the model's definitions.
function listEscalations(modeler) {
  const defs = definitionsOf(modeler);
  const out = [];
  if (defs && defs.rootElements) {
    for (const el of defs.rootElements) {
      if (el.$type === "bpmn:Escalation") out.push(el);
    }
  }
  return out;
}

// createEscalation adds a fresh <bpmn:escalation> with the given code and returns it.
function createEscalation(modeler, code) {
  const moddle = modeler.get("moddle");
  const esc_ = moddle.create("bpmn:Escalation");
  esc_.id = "Escalation_" + Math.random().toString(36).slice(2, 8);
  esc_.escalationCode = code || "";
  const defs = definitionsOf(modeler);
  if (defs) {
    esc_.$parent = defs;
    defs.rootElements = [...(defs.rootElements || []), esc_];
  }
  return esc_;
}

// linkEscalation points an escalation event definition at an escalation (undo/redo tracked).
function linkEscalation(modeler, element, eed, esc_) {
  try { modeler.get("modeling").updateModdleProperties(element, eed, { escalationRef: esc_ || undefined }); } catch { /* stale */ }
}

// deleteEscalation removes an escalation and clears any event still referencing it, so a
// deleted escalation never leaves a dangling escalationRef (which would fail to compile).
function deleteEscalation(modeler, escId) {
  const defs = definitionsOf(modeler);
  if (defs && defs.rootElements) defs.rootElements = defs.rootElements.filter((e) => e.id !== escId);
  const modeling = modeler.get("modeling");
  modeler.get("elementRegistry").getAll().forEach((el) => {
    const eed = escalationDefOf(el.businessObject);
    if (eed && eed.escalationRef && eed.escalationRef.id === escId) {
      try { modeling.updateModdleProperties(el, eed, { escalationRef: undefined }); } catch { /* stale */ }
    }
  });
}

// escalationFieldsHTML renders the escalation picker for an escalation throw/end event or an
// escalation boundary / event subprocess: a dropdown of the model's shared escalations (plus
// "new") and — once one is chosen — its code, shared so a raiser and its catchers stay in sync.
// Matching is by code; a code-less escalation is a catch-all. eed is the
// bpmn:EscalationEventDefinition.
function escalationFieldsHTML(modeler, eed, hint) {
  const current = eed.escalationRef;
  const options = listEscalations(modeler).map((e) =>
    `<option value="${esc(e.id)}"${current && current.id === e.id ? " selected" : ""}>${esc(e.escalationCode || e.id)}</option>`
  ).join("");
  const fields = current ? `
    <label class="field"><span>Escalation code</span>
      <input type="text" id="f-esccode" value="${esc(current.escalationCode || "")}" placeholder="ESCALATE_TO_MANAGER"/></label>
    <p class="muted" style="font-size:12px">Shared with every event that uses this escalation — a raised code is caught by the nearest enclosing escalation boundary or escalation event subprocess with the same code (an empty code is a catch-all).</p>` : "";
  return `<h3>Escalation</h3>
    <label class="field"><span>Escalation</span>
      <select id="f-escref">
        <option value="">— none —</option>
        ${options}
        <option value="__new__">＋ New escalation…</option>
      </select></label>
    ${fields}
    <p class="muted" style="font-size:12px">${hint}</p>`;
}

// escalationsManagerHTML lists the model's escalations for central management (add, edit code,
// delete).
function escalationsManagerHTML(modeler) {
  const escs = listEscalations(modeler);
  const rows = escs.length
    ? escs.map((e) => `
        <div class="esc-row" data-id="${esc(e.id)}">
          <input class="esc-code" value="${esc(e.escalationCode || "")}" placeholder="escalation code"/>
          <button type="button" class="btn ghost danger esc-del" title="Delete escalation">✕</button>
        </div>`).join("")
    : `<p class="muted" style="font-size:12px;margin:0 0 8px">No escalations yet — add one, then reference it from an escalation throw/end event or escalation boundary.</p>`;
  return `<h3>Escalations</h3>
    ${rows}
    <button type="button" class="btn ghost" id="esc-add">＋ Add escalation</button>
    <p class="muted" style="font-size:12px">An escalation is a matter raised up the scope chain: an <b>escalation throw</b> or <b>end event</b> raises it, and the nearest enclosing <b>escalation boundary</b> or <b>escalation event subprocess</b> with the same code catches it. Unlike an error, a catch may be <b>non-interrupting</b> (the activity keeps running) and an uncaught escalation is harmless.</p>`;
}

// wireEscalationsManager binds the Escalations management section's inputs and buttons.
// rerenderRoot re-renders the root panel after add/delete so the list updates.
function wireEscalationsManager(body, modeler, rerenderRoot) {
  const add = body.querySelector("#esc-add");
  if (add) add.addEventListener("click", () => { createEscalation(modeler, "ESCALATION_CODE"); rerenderRoot(); });
  body.querySelectorAll(".esc-row").forEach((row) => {
    const id = row.dataset.id;
    const escl = () => listEscalations(modeler).find((e) => e.id === id);
    const codeIn = row.querySelector(".esc-code");
    if (codeIn) codeIn.addEventListener("change", () => { const e = escl(); if (e) e.escalationCode = codeIn.value.trim(); });
    const del = row.querySelector(".esc-del");
    if (del) del.addEventListener("click", () => { deleteEscalation(modeler, id); rerenderRoot(); });
  });
}

// rootProcess returns the diagram's process business object, or null if the root
// isn't a plain process (e.g. a collaboration with pools).
function rootProcess(modeler) {
  try {
    const bo = modeler.get("canvas").getRootElement().businessObject;
    return bo && /:Process$/.test(bo.$type || "") ? bo : null;
  } catch { return null; }
}

// isCollaborationRoot reports whether the diagram root is a collaboration (pools),
// rather than a single process.
function isCollaborationRoot(modeler) {
  try {
    const bo = modeler.get("canvas").getRootElement().businessObject;
    return !!bo && /:Collaboration$/.test(bo.$type || "");
  } catch { return false; }
}

// The scalar types a declared start variable can take, matching what the server
// accepts (parseStartVariables) and what the typed Deploy form coerces to.
const START_VAR_TYPES = ["string", "number", "boolean", "json"];

// readStartVariables returns the start variables a process declares via its
// atlas:StartForm extension element: [{name, type, default, required}]. Empty
// when none are declared.
function readStartVariables(bo) {
  const sf = findExt(bo, "atlas:StartForm");
  return ((sf && sf.variables) || []).map((v) => ({
    name: v.name || "",
    type: START_VAR_TYPES.includes(v.type) ? v.type : "string",
    default: v.default || "",
    required: !!v.required,
  }));
}

// writeStartVariables persists the declared start variables onto the process
// through the modeling API (undo/redo; serializes on deploy). Rows without a
// name are dropped; an empty result removes the atlas:StartForm entirely so a
// cleared declaration leaves no dangling element.
//
// By default it targets the diagram's root process. A collaboration pool has no
// single root process — each pool executes its own — so a pool passes its shape
// (targetEl, the participant) and the process it references (targetBo) to land
// the declaration on that process. Referenced-object updates go through
// updateModdleProperties; the root shape keeps updateProperties (unchanged).
// dataRefName resolves a data association's source/target reference (a data object
// reference, which bpmn-js may hand back as a one-element list) to its display name:
// the reference's name, else the underlying data object's name, else its id.
function dataRefName(ref) {
  const r = Array.isArray(ref) ? ref[0] : ref;
  if (!r) return "?";
  return r.name || (r.dataObjectRef && r.dataObjectRef.name) || r.id || "?";
}

// processOf returns the bpmn:Process business object that contains element — its
// nearest Process ancestor, falling back to the diagram's single root process (for a
// collaboration a data object lives in the pool's process, reached via the parent).
function processOf(modeler, element) {
  let bo = element && element.businessObject;
  while (bo) {
    if (/:Process$/.test(bo.$type || "")) return bo;
    bo = bo.$parent;
  }
  return rootProcess(modeler);
}

// dataObjectNames lists a process's data objects distinct by name (a nameless one
// falls back to its id), each with a representative id to point a reference at. Used
// by the "Points to" selector so several references can share one logical object.
function dataObjectNames(procBo) {
  const out = [];
  if (!procBo) return out;
  for (const o of procBo.flowElements || []) {
    if (o.$type !== "bpmn:DataObject") continue;
    const name = o.name || o.id;
    if (!out.some((e) => e.name === name)) out.push({ name, id: o.id });
  }
  return out;
}

// setAssignment writes a data association's single <assignment> from its two FEEL
// bodies — <from> (the value/transform) and <to> (an output member path or an input
// target variable). Empty bodies clear the assignment, so a stateless association
// carries no dangling element (ADR-0058/0059/0060).
function setAssignment(modeler, element, bo, fromBody, toBody) {
  const modeling = modeler.get("modeling");
  const moddle = modeler.get("moddle");
  try {
    if (!fromBody && !toBody) {
      modeling.updateModdleProperties(element, bo, { assignment: [] });
      return;
    }
    const asg = moddle.create("bpmn:Assignment", {});
    asg.$parent = bo;
    if (fromBody) {
      const f = moddle.create("bpmn:FormalExpression", { body: fromBody });
      f.$parent = asg;
      asg.from = f;
    }
    if (toBody) {
      const t = moddle.create("bpmn:FormalExpression", { body: toBody });
      t.$parent = asg;
      asg.to = t;
    }
    modeling.updateModdleProperties(element, bo, { assignment: [asg] });
  } catch { /* stale */ }
}

function writeStartVariables(modeler, list, targetEl, targetBo) {
  const moddle = modeler.get("moddle");
  const modeling = modeler.get("modeling");
  const onRoot = !targetEl;
  const rootEl = modeler.get("canvas").getRootElement();
  if (onRoot) { targetEl = rootEl; targetBo = rootEl.businessObject; }
  const bo = targetBo;
  let ext = bo.extensionElements;
  if (!ext) { ext = moddle.create("bpmn:ExtensionElements", { values: [] }); ext.$parent = bo; }
  let sf = (ext.values || []).find((v) => v.$type === "atlas:StartForm");
  const clean = list.filter((v) => (v.name || "").trim() !== "");
  if (clean.length === 0) {
    if (sf) ext.values = (ext.values || []).filter((v) => v !== sf);
  } else {
    if (!sf) { sf = moddle.create("atlas:StartForm"); sf.$parent = ext; ext.values = [...(ext.values || []), sf]; }
    sf.variables = clean.map((v) => {
      const sv = moddle.create("atlas:StartVariable", {
        name: v.name.trim(),
        type: START_VAR_TYPES.includes(v.type) ? v.type : "string",
      });
      if ((v.default || "") !== "") sv.default = v.default;
      if (v.required) sv.required = true;
      sv.$parent = sf;
      return sv;
    });
  }
  if (onRoot) modeling.updateProperties(targetEl, { extensionElements: ext });
  else modeling.updateModdleProperties(targetEl, bo, { extensionElements: ext });
}

// startVarRowHTML renders one editable declaration row. Values are escaped for
// the attributes; the type <select> marks the current option. For json-typed
// variables, the default field is a textarea (upgraded to a JSON editor after
// the row is inserted into the DOM by wireStartVars).
function startVarRowHTML(v) {
  const opts = START_VAR_TYPES
    .map((t) => `<option value="${t}"${t === v.type ? " selected" : ""}>${t}</option>`).join("");
  const defaultField = v.type === "json"
    ? `<textarea class="sv-default sv-json-default" rows="2" placeholder='{"key": "value"}' aria-label="Default value (JSON)">${esc(v.default)}</textarea>`
    : `<input type="text" class="sv-default" value="${esc(v.default)}" placeholder="default" aria-label="Default value"/>`;
  return `<div class="sv-row${v.type === "json" ? " sv-row-json" : ""}">
    <input type="text" class="sv-name" value="${esc(v.name)}" placeholder="customer" aria-label="Variable name"/>
    <select class="sv-type" aria-label="Type">${opts}</select>
    ${defaultField}
    <label class="sv-req" title="Required"><input type="checkbox" class="sv-required"${v.required ? " checked" : ""}/> req</label>
    <button type="button" class="sv-del icon-btn" title="Remove" aria-label="Remove variable">✕</button>
  </div>`;
}

// wireStartVars renders and wires the process-level start-variable declaration
// editor into #sv-list. Rows persist on change (blur), not on every keystroke,
// so typing isn't interrupted; adding a row is DOM-only until it gets a name.
// Editing the process root fires element.changed for the root, but with nothing
// selected the panel isn't re-rendered, so in-progress rows survive a save.
//
// targetEl/targetBo are optional: omit them for the diagram's root process, or
// pass a collaboration pool's (participant shape, referenced process) to declare
// the variables on the process that pool executes instead.
//
// wrap optionally runs the persist under a rerender guard. The root editor shows
// with nothing selected, so its self-save re-renders nothing; a pool editor is
// shown for the *selected* participant, so its save would rebuild the panel and
// tear down an in-progress JSON editor — the pool passes savePreservingPanel to
// keep the panel intact, mirroring how FEEL fields self-save.
function wireStartVars(body, modeler, targetEl, targetBo, wrap = (fn) => fn()) {
  const listEl = body.querySelector("#sv-list");
  const addBtn = body.querySelector("#sv-add");
  if (!listEl || !addBtn) return;

  const editors = new Map(); // row DOM node → attachJSONEditor handle

  // attachEditors upgrades any json-typed default textareas to JSON editors.
  const attachEditors = () => {
    for (const row of listEl.querySelectorAll(".sv-row-json")) {
      const ta = row.querySelector(".sv-json-default");
      if (ta && !editors.has(row)) {
        const handle = attachJSONEditor(ta, { compact: true, onChange: persist });
        if (handle) editors.set(row, handle);
      }
    }
  };

  const collect = () => [...listEl.querySelectorAll(".sv-row")].map((row) => ({
    name: row.querySelector(".sv-name").value,
    type: row.querySelector(".sv-type").value,
    default: row.querySelector(".sv-default").value,
    required: row.querySelector(".sv-required").checked,
  }));
  const persist = () => wrap(() => { try { writeStartVariables(modeler, collect(), targetEl, targetBo); } catch { /* stale */ } });

  listEl.addEventListener("change", (e) => {
    // When the type dropdown changes to or from "json", rebuild the row so the
    // default field switches between <input> and the JSON editor.
    const sel = e.target.closest(".sv-type");
    if (sel) {
      const row = sel.closest(".sv-row");
      const data = {
        name: row.querySelector(".sv-name").value,
        type: sel.value,
        default: sel.value === "json" ? "" : row.querySelector(".sv-default").value,
        required: row.querySelector(".sv-required").checked,
      };
      // Destroy any existing JSON editor for this row.
      if (editors.has(row)) { editors.get(row).destroy(); editors.delete(row); }
      row.outerHTML = startVarRowHTML(data);
      attachEditors();
    }
    persist();
  });
  listEl.addEventListener("click", (e) => {
    const del = e.target.closest(".sv-del");
    if (del) {
      const row = del.closest(".sv-row");
      if (editors.has(row)) { editors.get(row).destroy(); editors.delete(row); }
      row.remove();
      persist();
    }
  });
  addBtn.addEventListener("click", () => {
    listEl.insertAdjacentHTML("beforeend", startVarRowHTML({ name: "", type: "string", default: "", required: false }));
    listEl.querySelector(".sv-row:last-child .sv-name").focus();
  });

  // Attach editors for any pre-existing json-typed rows.
  attachEditors();
}

// groupifyPanel turns each <h3> section of the properties panel into a collapsible
// group (Camunda-style): the heading becomes a toggle with a chevron and a filled
// dot when the group has content, and everything up to the next <h3> becomes its
// collapsible body. It works on the already-rendered panel, so every element type's
// markup is grouped by one function instead of each branch knowing about grouping.
// Nodes are moved as whole subtrees, so field listeners and rich editors survive.
function groupifyPanel(body, ctl) {
  const heads = [...body.children].filter((n) => n.tagName === "H3");
  if (!heads.length) return;
  // A section absorbs everything up to the next <h3>, but a standalone group (e.g.
  // the I/O mapping list groups, which render their own header) must stay a
  // top-level sibling rather than being folded into the preceding section's body.
  const isStop = (n) => n.nodeType === 1 && (n.tagName === "H3" || n.dataset.standaloneGroup === "1");
  for (const h3 of heads) {
    const title = h3.textContent.trim();
    const group = document.createElement("div");
    group.className = "pgroup" + (ctl.isCollapsed(title) ? " collapsed" : "");
    group.dataset.group = title;
    const bodyWrap = document.createElement("div");
    bodyWrap.className = "pgroup-body";
    let n = h3.nextSibling;
    while (n && !isStop(n)) {
      const next = n.nextSibling;
      bodyWrap.appendChild(n);
      n = next;
    }
    const fields = [...bodyWrap.querySelectorAll("input, textarea, select")];
    const hasVal = fields.some((el) =>
      el.tagName === "SELECT" ? el.selectedIndex > 0
        : (el.type !== "button" && el.type !== "submit" && (el.value || "").trim() !== ""));
    const hasRows = !!bodyWrap.querySelector(".dmn-input-row, .sv-row, .msg-row, tr, li");
    const head = document.createElement("button");
    head.type = "button";
    head.className = "pgroup-head";
    head.innerHTML = `<span class="pgroup-chevron">▸</span><span class="pgroup-title"></span>`;
    head.querySelector(".pgroup-title").textContent = title;
    if (hasVal || hasRows) {
      const dot = document.createElement("span");
      dot.className = "pgroup-dot";
      dot.title = "has content";
      head.appendChild(dot);
    }
    head.addEventListener("click", () => ctl.onToggle(title, group.classList.toggle("collapsed")));
    body.insertBefore(group, h3);
    group.appendChild(head);
    group.appendChild(bodyWrap);
    body.removeChild(h3);
  }
  // A subtle expand-all / collapse-all control, added once there is more than one
  // collapsible group (the <h3> sections plus any standalone I/O-mapping groups), so
  // the author can open or clear the whole panel in one click.
  const total = body.querySelectorAll(".pgroup, .io-group").length;
  if (total >= 2 && !body.querySelector(".pgroup-tools")) {
    const tools = document.createElement("div");
    tools.className = "pgroup-tools";
    tools.innerHTML = `<button type="button" class="pgroup-all" data-all="expand">Expand all</button>`
      + `<span class="pgroup-all-sep" aria-hidden="true">·</span>`
      + `<button type="button" class="pgroup-all" data-all="collapse">Collapse all</button>`;
    tools.querySelector('[data-all="expand"]').addEventListener("click", () => ctl.setAll(false));
    tools.querySelector('[data-all="collapse"]').addEventListener("click", () => ctl.setAll(true));
    body.insertBefore(tools, body.firstChild);
  }
}

function wireProperties(root, modeler, api, projectId, toast) {
  const icon = root.querySelector("#p-icon");
  const typename = root.querySelector("#p-typename");
  const nameEl = root.querySelector("#p-name");
  const body = root.querySelector("#p-body");
  const modeling = modeler.get("modeling");
  const selection = modeler.get("selection");

  // Tidy the panel Camunda-style: every <h3> section becomes a collapsible group
  // with a chevron and a filled dot when it carries content. groupifyPanel runs
  // after each (re-)render via a MutationObserver, so no per-element branch has to
  // know about grouping; collapse state persists across renders in `collapsed`.
  // Property groups start collapsed on open — all but General — so a freshly selected
  // element shows its identity, not every section at once (the author's request).
  // `choice` remembers explicit toggles for this editing session, shared across element
  // selections; untouched groups fall back to the default. It resets when the editor
  // remounts, so reopening a file collapses the panel again.
  const DEFAULT_OPEN = new Set(["General"]);
  const choice = new Map(); // group title -> true(collapsed)/false(open), only when toggled
  const groupCtl = {
    isCollapsed: (title) => choice.has(title) ? choice.get(title) : !DEFAULT_OPEN.has(title),
    onToggle: (title, col) => choice.set(title, col),
    // Expand/collapse every group now on screen (both <h3> sections and standalone
    // I/O-mapping groups) and record each so re-renders keep the chosen state.
    setAll: (col) => {
      for (const g of body.querySelectorAll(".pgroup, .io-group")) {
        g.classList.toggle("collapsed", col);
        const t = (g.dataset.group || "").trim();
        if (t) choice.set(t, col);
      }
    },
  };
  let groupifying = false;
  const panelObserver = new MutationObserver(() => {
    if (groupifying) return;
    groupifying = true;
    try { groupifyPanel(body, groupCtl); } finally { groupifying = false; }
  });
  panelObserver.observe(body, { childList: true });

  // savePreservingPanel runs a field save whose resulting element.changed should
  // NOT rebuild the whole properties panel. Editing a FEEL field saves on blur;
  // rebuilding then would tear down the FEEL editor (losing caret/scroll) and the
  // Test panel the user just opened — clicking into the sample-variables box would
  // destroy it mid-interaction. Only this save's synchronous change is suppressed;
  // genuinely external changes still refresh the panel.
  let suppressRerender = false;
  const savePreservingPanel = (fn) => {
    suppressRerender = true;
    try { fn(); } finally { suppressRerender = false; }
  };

  // addProcessToPool gives a black-box pool (a Participant with no processRef) the
  // process it needs to hold elements and deploy. Rather than hand-wire the moddle
  // (a processRef is a *reference*, so the process would also have to be added to
  // definitions.rootElements, and the collapsed shape expanded), it delegates to
  // bpmn-js's own expand: replacing the participant with an expanded one runs the
  // factory that creates the process, registers it, and grows the band — the same
  // path the palette uses for a fresh pool. The name is carried across by replace.
  function addProcessToPool(element) {
    try {
      const replaced = modeler.get("bpmnReplace")
        .replaceElement(element, { type: "bpmn:Participant", isExpanded: true });
      selection.select(replaced);
      show(replaced); // now an executable pool: elements can be dropped in
    } catch { toast("could not add a process to this pool", "err"); }
  }

  // showPool renders the Details panel for a collaboration pool (Participant).
  // The pool executes a process; this edits that process (its id — the deploy
  // identity — its name, and its start variables), or offers to create one when
  // the pool is an empty black box that can't yet hold elements.
  function showPool(element, bo) {
    icon.textContent = "PL"; typename.textContent = "Pool";
    nameEl.textContent = bo.name || bo.id || "(pool)";
    const proc = bo.processRef;
    const poolFields = `
      <h3>Pool</h3>
      <label class="field"><span>Name</span><input type="text" id="f-poolname" value="${esc(bo.name || "")}" placeholder="Teilnehmer"/></label>
      <label class="field"><span>Pool ID</span><input type="text" id="f-poolid" value="${esc(bo.id || "")}" spellcheck="false"/></label>`;

    if (!proc) {
      body.innerHTML = `${poolFields}
        <p class="muted" style="font-size:12px">A pool is a <b>participant</b> — it doesn't hold the flow itself, it <i>executes a process</i>. This pool has <b>no process</b>, so it can't contain elements or run.</p>
        <h3>Process</h3>
        <p class="muted" style="font-size:12px">Add the process that sits between the pool and its elements — the participant runs it, and the elements you draw live inside it.</p>
        <button type="button" class="btn" id="f-addproc" style="margin-top:6px">+ Add a process</button>`;
      body.querySelector("#f-poolname").addEventListener("change", (e) => {
        try { modeling.updateProperties(element, { name: e.target.value }); } catch { /* stale */ }
      });
      wirePoolId(body, element);
      body.querySelector("#f-addproc").addEventListener("click", () => addProcessToPool(element));
      return;
    }

    let startVarsHTML = "";
    if (activeTab(root) === "implement") {
      const declared = readStartVariables(proc);
      startVarsHTML = `
        <h3>Start variables</h3>
        <div id="sv-list">${declared.map(startVarRowHTML).join("")}</div>
        <button type="button" class="btn neutral" id="sv-add" style="margin-top:6px">+ Add variable</button>
        <p class="muted" style="font-size:12px">Declared on this pool's process, these render as a typed form on <b>Deploy &amp; run</b> — with defaults and required checks. The engine ignores the declaration; it's authoring metadata.</p>`;
    }
    body.innerHTML = `${poolFields}
      <p class="muted" style="font-size:12px">The pool is a <b>participant</b> that executes the process below. The elements live in that process — the pool only labels who runs it.</p>
      <h3>Process</h3>
      <label class="field"><span>Process name</span><input type="text" id="f-procname" value="${esc(proc.name || "")}" placeholder="Order fulfillment"/></label>
      <label class="field"><span>Process ID</span><input type="text" id="f-procid" value="${esc(proc.id || "")}" placeholder="order-fulfillment"/></label>
      <p class="muted" style="font-size:12px">Each pool deploys as its own process; the <b>Process ID</b> is that deployment's identity — instances group by it, and renaming it deploys a new process rather than a new version.</p>
      ${startVarsHTML}`;
    body.querySelector("#f-poolname").addEventListener("change", (e) => {
      try { modeling.updateProperties(element, { name: e.target.value }); } catch { /* stale */ }
    });
    wirePoolId(body, element);
    body.querySelector("#f-procname").addEventListener("change", (e) => {
      try { modeling.updateModdleProperties(element, proc, { name: e.target.value }); } catch { /* stale */ }
    });
    body.querySelector("#f-procid").addEventListener("change", (e) => {
      const v = (e.target.value || "").trim();
      if (v) { try { modeling.updateModdleProperties(element, proc, { id: v }); } catch { toast("invalid process id", "err"); } }
    });
    if (activeTab(root) === "implement") wireStartVars(body, modeler, element, proc, savePreservingPanel);
  }

  // wirePoolId makes a pool's ID editable, the same way the element ID and Process ID
  // fields are: bpmn-js validates the new id and rewrites references, throwing on an
  // invalid or duplicate id, which we revert with a toast.
  function wirePoolId(body, element) {
    const f = body.querySelector("#f-poolid");
    if (!f) return;
    f.addEventListener("change", (e) => {
      const v = (e.target.value || "").trim();
      if (v === element.businessObject.id) return;
      if (!v) { show(element); return; }
      try { modeling.updateProperties(element, { id: v }); }
      catch { toast("invalid id — must be unique and a valid identifier", "err"); show(element); }
    });
  }

  function show(element) {
    if (!element) {
      // Nothing selected → show the process itself, so its id/name can be edited
      // (this is how you rename a diagram; the id is the deployed process id).
      const rootBo = rootProcess(modeler);
      if (rootBo) {
        icon.textContent = "PR"; typename.textContent = "Process";
        nameEl.textContent = rootBo.name || rootBo.id || "(process)";
        // The declaration editor is executable detail, so it lives on the
        // Implement tab (like a task's script or a branch's condition).
        let startVarsHTML = "";
        if (activeTab(root) === "implement") {
          const declared = readStartVariables(rootBo);
          startVarsHTML = `
            <h3>Start variables</h3>
            <div id="sv-list">${declared.map(startVarRowHTML).join("")}</div>
            <button type="button" class="btn neutral" id="sv-add" style="margin-top:6px">+ Add variable</button>
            <p class="muted" style="font-size:12px">Declared here, these render as a typed form on <b>Deploy &amp; run</b> — with defaults and required checks — instead of raw JSON. The engine ignores the declaration; it's authoring metadata.</p>`;
        }
        body.innerHTML = `
          <h3>Process</h3>
          <label class="field"><span>Name</span><input type="text" id="f-pname" value="${esc(rootBo.name || "")}" placeholder="Order fulfillment"/></label>
          <label class="field"><span>Process ID</span><input type="text" id="f-pid" value="${esc(rootBo.id || "")}" placeholder="order-fulfillment"/></label>
          <p class="muted" style="font-size:12px">The Process ID is the identity deployments and instances are grouped by. Renaming it and deploying creates a new process rather than a new version.</p>
          <label class="field"><span>Version tag</span><input type="text" id="f-pver" value="${esc(rootBo.versionTag || "")}" placeholder="1.0.0"/></label>
          <label class="pcheck"><input type="checkbox" id="f-pexec"${rootBo.isExecutable !== false ? " checked" : ""}/> <span>Executable</span></label>
          <p class="muted" style="font-size:12px">An <b>executable</b> process can be started and offered in the start lists; leave it off for a descriptive-only diagram. <b>Version tag</b> is an optional label for this revision.</p>
          <label class="field"><span>Instance TTL</span><input type="text" id="f-pttl" value="${esc(rootBo.instanceTtl || "")}" placeholder="P7D"/></label>
          <p class="muted" style="font-size:12px">A self-cleaning <b>time-to-live</b> for instances of this process, as an ISO-8601 duration (e.g. <code>P7D</code> = 7 days, <code>PT12H</code> = 12 hours, <code>PT30M</code> = 30 minutes). An instance that outlives its TTL is automatically terminated and moved to history — where it stays queryable and can still be exported. Leave empty for no TTL (instances live until they complete or are cancelled). Set it above the longest run you legitimately expect.</p>
          ${startVarsHTML}
          ${messagesManagerHTML(modeler)}
          ${signalsManagerHTML(modeler)}
          ${errorsManagerHTML(modeler)}
          ${escalationsManagerHTML(modeler)}`;
        const rootEl = modeler.get("canvas").getRootElement();
        body.querySelector("#f-pname").addEventListener("change", (e) => {
          try { modeling.updateProperties(rootEl, { name: e.target.value }); } catch { /* ignore */ }
        });
        body.querySelector("#f-pid").addEventListener("change", (e) => {
          const v = (e.target.value || "").trim();
          if (v) { try { modeling.updateProperties(rootEl, { id: v }); } catch { toast("invalid process id", "err"); } }
        });
        body.querySelector("#f-pver").addEventListener("change", (e) => {
          const v = (e.target.value || "").trim();
          try { modeling.updateProperties(rootEl, { versionTag: v || undefined }); } catch { /* ignore */ }
        });
        body.querySelector("#f-pttl").addEventListener("change", (e) => {
          const v = (e.target.value || "").trim();
          // The engine parses the day/time subset of ISO-8601 and rejects a malformed or
          // non-positive TTL at deploy (ADR-0085). Catch it here so the mistake surfaces
          // while authoring instead of as a failed deploy — but still store what was typed
          // so the field never silently drops the user's value.
          if (v && !isValidTtl(v)) toast("Instance TTL must be a positive ISO-8601 duration, e.g. P7D or PT12H", "err");
          try { modeling.updateProperties(rootEl, { instanceTtl: v || undefined }); } catch { /* ignore */ }
        });
        body.querySelector("#f-pexec").addEventListener("change", (e) => {
          try { modeling.updateProperties(rootEl, { isExecutable: e.target.checked }); } catch { /* ignore */ }
        });
        wireStartVars(body, modeler);
        wireMessagesManager(body, modeler, () => show(null));
        wireSignalsManager(body, modeler, () => show(null));
        wireErrorsManager(body, modeler, () => show(null));
        wireEscalationsManager(body, modeler, () => show(null));
        return;
      }
      // A collaboration root has no single process to rename; each pool
      // (participant) executes its own process, configured by selecting the pool.
      if (isCollaborationRoot(modeler)) {
        icon.textContent = "CO"; typename.textContent = "Collaboration"; nameEl.textContent = "(collaboration)";
        body.innerHTML = `
          <h3>Collaboration</h3>
          <p class="muted" style="font-size:12px">This diagram has several <b>pools</b>. A pool is a <b>participant</b> that <i>executes a process</i> — the process holds the flow, the pool just names who runs it, and each deploys as its own process. Select a pool to name it and configure the process it runs, or an element inside a pool to configure it. Pools talk to each other through <b>message events</b>: a throw event in one pool and a catch event in another that reference the <b>same message</b> below.</p>
          ${messagesManagerHTML(modeler)}
          ${signalsManagerHTML(modeler)}
          ${errorsManagerHTML(modeler)}
          ${escalationsManagerHTML(modeler)}`;
        wireMessagesManager(body, modeler, () => show(null));
        wireSignalsManager(body, modeler, () => show(null));
        wireErrorsManager(body, modeler, () => show(null));
        wireEscalationsManager(body, modeler, () => show(null));
        return;
      }
      icon.textContent = "–"; typename.textContent = "No selection"; nameEl.textContent = "—";
      body.innerHTML = `<p class="muted">Select an element to see its properties.</p>`;
      return;
    }
    const bo = element.businessObject || {};
    const type = shortType(element.type);
    // The generic two-letter badge is the type's first two letters, but every data
    // element starts "Da" (DataObject, DataStore, DataInput/OutputAssociation) and
    // would collide on "DA" — badge them by what they are so they read at a glance:
    // data object → DO, data store → DS, output/input association → OA/IA (ADR-0053).
    const badges = {
      "bpmn:DataObjectReference": "DO",
      "bpmn:DataStoreReference": "DS",
      "bpmn:DataOutputAssociation": "OA",
      "bpmn:DataInputAssociation": "IA",
    };
    icon.textContent = badges[bo.$type] || type.slice(0, 2).toUpperCase();
    typename.textContent = type;
    nameEl.textContent = bo.name || bo.id || "(unnamed)";

    // A pool (Participant) is not itself executable — in BPMN it *executes* a
    // process: participant → processRef → the flow elements. The pool's own name
    // is only the band label; the process it references is the deploy identity
    // and the only thing that can hold elements (a Participant with no processRef
    // is a black box the engine can't run and the canvas can't drop into). So the
    // panel edits the process behind the pool, and offers to create one when the
    // pool has none — the "Prozess dazwischen" that takes the elements.
    if (/:Participant$/.test(bo.$type || "")) {
      showPool(element, bo);
      return;
    }

    const tab = activeTab(root);
    const isSeqFlow = /:SequenceFlow$/.test(bo.$type || "");
    const src = bo.sourceRef;
    // A conditional branch is a flow out of an exclusive/inclusive gateway. Its
    // name is the descriptive label (Design); its conditionExpression is the FEEL
    // guard (Implement). The gateway's default flow carries no condition.
    const isGatewayFlow = isSeqFlow && src && /(Exclusive|Inclusive)Gateway$/.test(src.$type || "");
    const isDefaultFlow = isGatewayFlow && src.default === bo;

    // General: the descriptive view shared by both tabs. For a sequence flow the
    // name IS the diagram label (e.g. the branch outcome "Großauftrag").
    let html = `
      <h3>General</h3>
      <label class="field"><span>${isSeqFlow ? "Label" : "Name"}</span><input type="text" id="f-name" value="${esc(bo.name || "")}"${isSeqFlow ? ' placeholder="Großauftrag"' : ""}/></label>
      <label class="field"><span>ID</span><input type="text" id="f-id" value="${esc(bo.id || "")}" spellcheck="false"/></label>`;

    // A data object is the data a process carries — first-class in Atlas, not just
    // decoration (ADR-0053). Its name is the engine's variable-like identity and its
    // data state is the [received]/[approved] label an activity advances. Shown on
    // both tabs since data is descriptive and executable at once.
    if (bo.$type === "bpmn:DataObjectReference") {
      const stateName = (bo.dataState && bo.dataState.name) || "";
      const collection = !!(bo.dataObjectRef && bo.dataObjectRef.isCollection);
      // The other data objects in this process, so a reference can be pointed at an
      // existing one — showing the same object in several places (one logical object,
      // no long arrows). Distinct by name: duplicates are folded at compile time.
      const names = dataObjectNames(processOf(modeler, element));
      const curName = (bo.dataObjectRef && (bo.dataObjectRef.name || bo.dataObjectRef.id)) || "";
      let pointsTo = "";
      if (names.length > 1) {
        pointsTo = `<label class="field"><span>Points to</span>
          <select id="f-pointsto">${names.map((n) => `<option value="${esc(n.id)}" ${n.name === curName ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select></label>
          <p class="muted" style="font-size:12px">Point this box at an existing data object to show <b>the same object in several places</b> — one logical object, so you can put it next to each activity without long arrows across the diagram.</p>`;
      }
      html += `<h3>Data object</h3>
        <label class="field"><span>Data state</span>
          <input type="text" id="f-datastate" value="${esc(stateName)}" placeholder="received"/></label>
        <label class="field checkbox"><input type="checkbox" id="f-collection" ${collection ? "checked" : ""}/> <span>Collection (a list of items)</span></label>
        ${pointsTo}
        <p class="muted" style="font-size:12px">A data object carries a value <i>and</i> a <b>data state</b> — <code>order [received]</code> → <code>[approved]</code>. The state set here is where the object starts each instance; a <b>data output association</b> (an arrow from an activity to this object) advances it and writes its value, a <b>data input association</b> reads it back, and the full state history is recorded per instance and survives restart. The <b>Name</b> is how the engine identifies it.</p>`;
    }

    // A data association is the arrow between an activity and a data object — it is
    // what makes data flow (ADR-0058/0059/0060). Its <assignment> carries the FEEL:
    // <from> is the value/transform, <to> is an output member path or an input target
    // variable. Shown on both tabs since it is the executable data contract.
    if (bo.$type === "bpmn:DataOutputAssociation" || bo.$type === "bpmn:DataInputAssociation") {
      const asg = (bo.assignment && bo.assignment[0]) || {};
      const fromBody = (asg.from && asg.from.body) || "";
      const toBody = (asg.to && asg.to.body) || "";
      if (bo.$type === "bpmn:DataOutputAssociation") {
        html += `<h3>Writes data object</h3>
          <label class="field"><span>FEEL value</span><input type="text" id="f-assoc-from" value="${esc(fromBody)}" placeholder="=amount * 1.19"/></label>
          <label class="field"><span>Target member <span class="muted">(optional)</span></span><input type="text" id="f-assoc-to" value="${esc(toBody)}" placeholder="name"/></label>
          <p class="muted" style="font-size:12px">When the activity completes it writes <b>${esc(dataRefName(bo.targetRef))}</b>: the <b>FEEL value</b> (over the instance's variables) becomes the object's value, and its data state advances to the one on the target reference. Leave <b>Target member</b> empty to write the whole object; set it (e.g. <code>name</code>) to update just that field of a structured object and keep the rest.</p>`;
      } else {
        html += `<h3>Reads data object</h3>
          <label class="field"><span>Target variable</span><input type="text" id="f-assoc-to" value="${esc(toBody)}" placeholder="order"/></label>
          <label class="field"><span>Transform <span class="muted">(optional)</span></span><input type="text" id="f-assoc-from" value="${esc(fromBody)}" placeholder="=order.amount"/></label>
          <p class="muted" style="font-size:12px">At activation this reads <b>${esc(dataRefName(bo.sourceRef))}</b> into the <b>Target variable</b>, so the activity's FEEL can use it. Leave <b>Transform</b> empty to copy the object's value; set it (the object is available under its name) to compute the value written into the variable.</p>`;
      }
    }

    if (tab === "implement") {
      if (bo.$type === "bpmn:ReceiveTask") {
        // A receive task waits for a correlating message, then continues (ADR-0102). It is
        // an activity, so it takes the shared message picker (the receive task holds its
        // messageRef directly, which messageRefHolder resolves for the field handlers).
        html += messageFieldsHTML(modeler, bo, "The receive task waits until this message is published (or thrown) with a matching correlation key, then continues. Attach a timer boundary event for a wait-or-time-out.");
        html += multiInstanceHTML(bo); // wait for the message once per iteration
      } else if (bo.$type === "bpmn:SendTask") {
        // The single outbound element (ADR-0112): a kind picker chooses what it sends —
        // Message (a correlating throw), or a connector / job worker (a job it waits on).
        html += sendTaskKindHTML(modeler, bo);
        // A message-kind send task is a throw, not an activity the engine can loop
        // (the compiler skips it), so the loop section is offered only for the
        // job-backed kinds — matching what actually runs.
        if (sendTaskKind(bo).id !== "message") html += multiInstanceHTML(bo);
      } else if (isActivity(bo)) {
        const t = bo.$type;
        html += `
          <label class="field"><span>Task type</span>
            <select id="f-tasktype">
              <option value="bpmn:Task" ${t === "bpmn:Task" ? "selected" : ""}>Undefined task</option>
              <option value="bpmn:ScriptTask" ${t === "bpmn:ScriptTask" ? "selected" : ""}>Script task (FEEL)</option>
              <option value="bpmn:ServiceTask" ${t === "bpmn:ServiceTask" ? "selected" : ""}>Service task (job worker)</option>
              <option value="bpmn:BusinessRuleTask" ${t === "bpmn:BusinessRuleTask" ? "selected" : ""}>Business rule task (DMN)</option>
              <option value="bpmn:UserTask" ${t === "bpmn:UserTask" ? "selected" : ""}>User task</option>
            </select></label>`;

        if (t === "bpmn:ScriptTask") {
          // A script task is authored either in FEEL (evaluated inline by the
          // engine, <zeebe:script>) or in a general-purpose language run by a job
          // worker (<atlas:jobScript>, ADR-0047). The language selector switches
          // which the task carries; both are still bpmn:ScriptTask.
          const js = findExt(bo, "atlas:JobScript");
          const lang = js ? (js.language || "powershell") : "feel";
          const opts = [`<option value="feel" ${lang === "feel" ? "selected" : ""}>FEEL (built-in, runs in the engine)</option>`]
            .concat(Object.entries(JOB_LANGS).map(([k, v]) =>
              `<option value="${k}" ${lang === k ? "selected" : ""}>${v.label}</option>`));
          html += `<h3>Script</h3>
            <label class="field"><span>Language</span>
              <select id="f-scriptlang">${opts.join("")}</select></label>`;
          if (lang === "feel") {
            const s = findExt(bo, "zeebe:Script") || {};
            const exprText = (s.expression || "").replace(/^=\s*/, "");
            html += `<label class="field"><span>Expression (FEEL)</span>
                <textarea id="f-expr" rows="3" placeholder="amount * (1 + taxRate)">${esc(exprText)}</textarea></label>
              <label class="field"><span>Result variable</span>
                <input type="text" id="f-result" value="${esc(s.resultVariable || "")}" placeholder="gross"/></label>`;
          } else {
            const meta = JOB_LANGS[lang] || JOB_LANGS.powershell;
            html += `<label class="field"><span>Script (${meta.short})</span>
                <textarea id="f-psbody" rows="6" spellcheck="false" placeholder='${meta.placeholder}'>${esc(js && js.source || "")}</textarea></label>
              <label class="field"><span>Result variable</span>
                <input type="text" id="f-psresult" value="${esc((js && js.resultVariable) || "")}" placeholder="Greeting"/></label>
              <p class="muted" style="font-size:12px">${meta.hint}</p>
              <h3>Failure handling</h3>
              <label class="field"><span>Retries</span>
                <input type="number" id="f-psretries" min="1" step="1" value="${esc((js && js.retries) || "")}" placeholder="3"/></label>
              <p class="muted" style="font-size:12px">${RETRIES_FIELD.hint}</p>
              <div class="feel-test" data-run-lang="${lang}">
                <label class="field"><span>Test — sample variables (JSON)</span>
                  <textarea class="ps-run-vars" rows="2" spellcheck="false" placeholder='{ "Vorname": "Anna" }'></textarea></label>
                <div class="feel-test-row">
                  <button type="button" class="btn neutral ps-run">Run</button>
                  <span class="feel-test-out ps-run-out" aria-live="polite"></span>
                </div>
                <pre class="ps-run-detail" hidden></pre>
                <p class="muted" style="font-size:12px">Runs the script through the real interpreter with these variables — no deploy needed. The language's worker must be enabled on the server.</p>
              </div>`;
          }
        } else if (t === "bpmn:ServiceTask") {
          html += serviceTaskKindHTML(bo);
        } else if (t === "bpmn:BusinessRuleTask") {
          const cd = findExt(bo, "zeebe:CalledDecision") || {};
          const tc = findExt(bo, "atlas:TemisConnector");
          const mode = tc ? "connector" : "local";
          const io = findExt(bo, "zeebe:IoMapping");
          const inputs = (io && io.inputParameters) || [];
          // Combobox option sets: the diagram's known variables for the source
          // column, and the already-declared input names for the name column (the
          // picker enriches the latter with the decision's full input list on load).
          const varOpts = collectDiagramVariables(modeler)
            .map((v) => `<option value="${esc(v.name)}">${esc(v.source || v.origin || "")}</option>`).join("");
          const inNameOpts = [...new Set(inputs.map((p) => (p.target || "").trim()).filter(Boolean))]
            .map((n) => `<option value="${esc(n)}"></option>`).join("");
          html += `<h3>Called decision (DMN)</h3>
            <label class="field"><span>Evaluation</span>
              <select id="f-brt-mode">
                <option value="local" ${mode === "local" ? "selected" : ""}>In-engine (embedded DMN)</option>
                <option value="connector" ${mode === "connector" ? "selected" : ""}>External (temis connector)</option>
              </select></label>`;
          if (mode === "connector") {
            html += `<label class="field"><span>Connector</span>
              <input type="text" id="f-connector" value="${esc((tc && tc.connector) || "")}" placeholder="risk-service"/></label>`;
          }
          const binding = cd.bindingType === "deployment" ? "deployment" : "latest";
          const bindingField = mode === "local" ? `
            <label class="field"><span>Binding</span>
              <select id="f-brt-binding">
                <option value="latest" ${binding === "latest" ? "selected" : ""}>Latest — newest deployed version</option>
                <option value="deployment" ${binding === "deployment" ? "selected" : ""}>Deployment — pinned to this deploy</option>
              </select></label>` : "";
          html += `<label class="field"><span>Decision</span>
              <select id="f-decision-pick"><option value="">${cd.decisionId ? esc(cd.decisionId) + " (current)" : "— choose a decision —"}</option></select></label>
            <div style="display:flex; gap:8px; margin:-4px 0 6px">
              <button type="button" class="btn ghost" id="f-dmn-new">＋ Neue Decision</button>
              <button type="button" class="btn ghost" id="f-dmn-edit"${cd.decisionId ? "" : " disabled"}>Bearbeiten</button>
            </div>
            <label class="field"><span>Decision ID <span class="field-derived">derived</span></span>
              <input type="text" id="f-decisionid" value="${esc(cd.decisionId || "")}" placeholder="pick a decision above" readonly title="Set by the decision picked above — no need to type it"/></label>
            <label class="field"><span>Result variable</span>
              <input type="text" id="f-resultvar" value="${esc(cd.resultVariable || "")}" placeholder="dish"/></label>${bindingField}
            <p class="muted" style="font-size:12px">Pick a decision to auto-fill its id, inputs and result variable. <b>Latest</b> evaluates the newest deployed version; <b>Deployment</b> pins to the version deployed with this process.</p>
            <h3>Failure handling</h3>
            <label class="field"><span>Retries</span>
              <input type="number" id="f-brt-retries" min="1" step="1" value="${esc(cd.retries || "")}" placeholder="3"/></label>
            <p class="muted" style="font-size:12px">${RETRIES_FIELD.hint}</p>
            <h3>Decision inputs</h3>
            <p class="muted" style="font-size:12px">Each row feeds one decision input. Pick a variable from the list or type any FEEL expression over the instance's variables. Leave a row's name blank to drop it.</p>
            <div id="dmn-inputs">${inputs.map((p, i) => decisionInputRowHTML(i, p.source, p.target)).join("")}${decisionInputRowHTML(inputs.length, "", "")}</div>
            <datalist id="dmn-vars-dl">${varOpts}</datalist>
            <datalist id="dmn-inputs-dl">${inNameOpts}</datalist>`;
        } else if (t === "bpmn:UserTask") {
          const a = findExt(bo, "zeebe:AssignmentDefinition") || {};
          const pr = findExt(bo, "zeebe:PriorityDefinition") || {};
          const sch = findExt(bo, "zeebe:TaskSchedule") || {};
          const fd = findExt(bo, "zeebe:FormDefinition") || {};
          const curForm = fd.formId || "";
          html += `<h3>Form</h3>
            <label class="field"><span>Linked form</span>
              <select id="f-form">
                <option value="">— none —</option>
                ${curForm ? `<option value="${esc(curForm)}" selected>${esc(curForm)}</option>` : ""}
              </select></label>
            <p class="muted" style="font-size:12px">The form the Tasks app renders for this task, submitted as its variables.
              <a href="#/modeler/form/new" target="_blank" rel="noopener">Create a new form</a>, then reopen this to link it.</p>
            <h3>Assignment</h3>
            <label class="field"><span>Assignee</span>
              <textarea id="f-assignee" rows="1" spellcheck="false" placeholder="editor">${esc(a.assignee || "")}</textarea></label>
            <label class="field"><span>Candidate groups</span>
              <textarea id="f-groups" rows="1" spellcheck="false" placeholder="reviewers">${esc(a.candidateGroups || "")}</textarea></label>
            <h3>Schedule</h3>
            <label class="field"><span>Priority</span>
              <input type="number" id="f-priority" min="0" max="100" value="${esc(pr.priority || "50")}" placeholder="50"/></label>
            <label class="field"><span>Due in</span>
              <textarea id="f-due" rows="1" spellcheck="false" placeholder="P2D, PT4H, PT30M">${esc(sch.dueDate || "")}</textarea></label>
            <p class="muted" style="font-size:12px">An ISO-8601 duration measured from when the task appears
              (e.g. <b>P2D</b> = 2 days, <b>PT4H</b> = 4 hours). Leave blank for no due date. Priority 0–100; higher sorts first.</p>`;
        }
        // Generic zeebe:ioMapping input/output editor for job-backed activities
        // (ADR-0068). A business rule task's ioMapping inputs are decision inputs
        // with their own editor above, so it is excluded here.
        if (t === "bpmn:ServiceTask" || t === "bpmn:ScriptTask" || t === "bpmn:UserTask") {
          html += ioMappingsHTML(bo);
        }
        // Every task kind can carry a loop marker (ADR-0077 multi-instance, ADR-0133
        // standard loop) — including the ones with no implementation of their own: an
        // undefined or manual task repeats its pass-through, a business rule task
        // re-evaluates its decision. The section is offered wherever the engine honours
        // the marker, so the panel and the icon agree on every activity.
        html += multiInstanceHTML(bo);
      } else if (bo.$type === "bpmn:SubProcess") {
        // An embedded subprocess is a scope, so it takes the same generic
        // zeebe:ioMapping editor as a task (ADR-0074) — but no task-type selector, a
        // subprocess is not a task. Input mappings write a variable into the
        // subprocess scope on entry (its inner elements see it, up the chain); output
        // mappings promote selected values to the enclosing scope on completion.
        html += `<p class="muted" style="font-size:12px">Pass variables in and out of this subprocess. <b>Input mappings</b> create variables its inner elements see (its local scope); <b>output mappings</b> promote selected values back to the enclosing scope when it completes.</p>`;
        html += ioMappingsHTML(bo);
        html += multiInstanceHTML(bo); // ADR-0077: run this subprocess once per collection element
      } else if (bo.$type === "bpmn:CallActivity") {
        // A call activity invokes a *separate* deployed process as a child instance
        // (ADR-0076). It is configured by its <zeebe:calledElement>: which process to
        // call (by its bpmn process id), the version binding, and whether variables
        // propagate wholesale in each direction. With propagation off, only the I/O
        // mappings below cross the boundary — true isolation.
        const ce = findExt(bo, "zeebe:CalledElement") || {};
        const binding = ce.bindingType === "deployment" ? "deployment" : "latest";
        const propParent = ce.propagateAllParentVariables !== false; // default true (Zeebe)
        const propChild = ce.propagateAllChildVariables !== false;   // default true (Zeebe)
        html += `<h3>Called process</h3>
          <label class="field"><span>Process ID</span>
            <input type="text" id="f-call-processid" list="f-call-proc-list" autocomplete="off" value="${esc(ce.processId || "")}" placeholder="pruefe-auftrag"/>
            <datalist id="f-call-proc-list"></datalist></label>
          <div class="field-actions"><button type="button" class="btn ghost small" id="f-call-newproc">&#43; Create new process</button></div>
          <label class="field"><span>Binding</span>
            <select id="f-call-binding">
              <option value="latest" ${binding === "latest" ? "selected" : ""}>Latest — newest deployed version</option>
              <option value="deployment" ${binding === "deployment" ? "selected" : ""}>Deployment — pinned to this deploy</option>
            </select></label>
          <p class="muted" style="font-size:12px">Starts the process with this <b>id</b> as a child instance and waits for it to finish. <b>Latest</b> calls the newest deployed version; <b>Deployment</b> pins to the version deployed alongside this one.</p>
          <h3>Variables</h3>
          <label class="field checkbox"><input type="checkbox" id="f-call-prop-parent" ${propParent ? "checked" : ""}/> <span>Pass all caller variables in</span></label>
          <label class="field checkbox"><input type="checkbox" id="f-call-prop-child" ${propChild ? "checked" : ""}/> <span>Return all child variables out</span></label>
          <p class="muted" style="font-size:12px">With a box <b>unchecked</b>, only the matching mappings below cross that direction — the child sees only what you map in, or the caller gets back only what you map out (isolation).</p>`;
        html += ioMappingsHTML(bo);
        html += multiInstanceHTML(bo); // ADR-0077: call the process once per collection element
      } else if (isDefaultFlow) {
        html += `<h3>Condition (FEEL)</h3>
          <p class="muted" style="font-size:12px">This is the gateway's <b>default flow</b> — taken when no other branch's condition matches, so it carries no condition of its own.</p>`;
      } else if (isGatewayFlow) {
        const condText = ((bo.conditionExpression && bo.conditionExpression.body) || "").replace(/^=\s*/, "");
        html += `<h3>Condition (FEEL)</h3>
          <label class="field"><span>Expression</span>
            <textarea id="f-cond" rows="2" placeholder="amount > 100">${esc(condText)}</textarea></label>
          <p class="muted" style="font-size:12px">Evaluated when the token reaches the gateway; the first branch whose condition holds is taken.</p>`;
      } else if (bo.$type === "bpmn:IntermediateCatchEvent") {
        const timer = timerDefOf(bo);
        const msg = messageDefOf(bo);
        const sig = signalDefOf(bo);
        const link = linkDefOf(bo);
        const cond = conditionalDefOf(bo);
        if (timer) {
          html += timerFieldsHTML(timer, ["duration", "date"], `The event waits, then continues (ADR-0054).
            <b>Duration</b> waits that long (<b>PT30S</b>, <b>PT5M</b>, <b>P1DT2H</b>); <b>Date &amp; time</b> waits until that instant.
            A catch fires once, so it has no cycle. A FEEL expression is allowed in either.`);
        } else if (msg) {
          html += messageFieldsHTML(modeler, msg, "The event waits until this message is published with a matching correlation key.");
        } else if (sig) {
          html += signalFieldsHTML(modeler, sig, "The event waits until a signal with this name is broadcast (by a throw or signal end event, in this or any other instance).");
        } else if (link) {
          html += linkFieldsHTML(link, "This is the landing point of a <b>link throw</b> with the same name in the same scope (an off-page connector). It does not wait — a token arriving via the link flows straight on. Draw it with no incoming sequence flow.");
        } else if (cond) {
          html += conditionalFieldsHTML(cond, "The event waits until this boolean condition over the instance's variables becomes true — re-evaluated on every variable change — then continues. If it already holds when the token arrives, it passes straight through.");
        } else {
          html += `<p class="muted" style="font-size:12px">Use the wrench icon on the element to make this a <b>Timer</b>, <b>Message</b>, <b>Signal</b>, <b>Conditional</b>, or <b>Link</b> intermediate catch event, then configure it here.</p>`;
        }
      } else if (bo.$type === "bpmn:IntermediateThrowEvent") {
        const msg = messageDefOf(bo);
        const sig = signalDefOf(bo);
        const escl = escalationDefOf(bo);
        const link = linkDefOf(bo);
        if (msg) {
          html += messageFieldsHTML(modeler, msg, "On reaching this event the message is published; any instance waiting on it with a matching correlation key continues.");
        } else if (sig) {
          html += signalFieldsHTML(modeler, sig, "On reaching this event the signal is broadcast to every event waiting on that signal name, across all instances. The token then continues.");
        } else if (escl) {
          html += escalationFieldsHTML(modeler, escl, "On reaching this event the escalation is raised, propagating up to the nearest matching escalation boundary or event subprocess, and the token then continues on its outgoing flow (unless an interrupting catch aborts it). Uncaught, it is harmless.");
        } else if (link) {
          html += linkFieldsHTML(link, "On reaching this event the token jumps to the <b>link catch</b> with the same name in the same scope — an off-page connector / goto, in place of a sequence flow. Draw it with no outgoing sequence flow; deploy fails if no matching link catch exists.");
        } else {
          html += `<p class="muted" style="font-size:12px">Use the wrench icon on the element to make this a <b>Message</b>, <b>Signal</b>, <b>Escalation</b>, or <b>Link</b> throw event, then configure it here.</p>`;
        }
      } else if (bo.$type === "bpmn:BoundaryEvent") {
        // A boundary event is attached to an activity and arms while it runs. Its
        // cancelActivity attribute (interrupting by default) and its timer/message
        // trigger are configured here; the trigger's fields reuse the same
        // timer / message wiring as the intermediate catch event.
        const timer = timerDefOf(bo);
        const msg = messageDefOf(bo);
        const sig = signalDefOf(bo);
        const err = errorDefOf(bo);
        const escl = escalationDefOf(bo);
        const cond = conditionalDefOf(bo);
        const cancel = cancelDefOf(bo);
        if (err) {
          // An error boundary is always interrupting — no cancelActivity toggle (ADR-0089).
          html += `<h3>Behaviour</h3>
            <p class="muted" style="font-size:12px">An <b>error boundary</b> is always <b>interrupting</b>: a matching thrown error cancels the attached activity (and its job) and routes the token out this event.</p>`;
          html += errorFieldsHTML(modeler, err, "The event fires when the attached activity throws a matching error — an error end event inside it, a worker failing its job to the code, or an error propagating up from a called process.");
        } else if (cancel) {
          // A cancel boundary may attach only to a transaction and is always interrupting — no
          // cancelActivity toggle and no trigger fields (ADR-0108).
          html += `<h3>Behaviour</h3>
            <p class="muted" style="font-size:12px">A <b>cancel boundary</b> attaches only to a <b>transaction</b> and is always <b>interrupting</b>: when a cancel end event inside the transaction fires, its completed activities are compensated (in reverse order) and the token is then routed out this event. Draw it on a transaction subprocess.</p>`;
        } else {
          const interrupting = bo.cancelActivity !== false;
          html += `<h3>Behaviour</h3>
            <label class="field"><span>On trigger</span>
              <select id="f-cancelactivity">
                <option value="true" ${interrupting ? "selected" : ""}>Interrupting — cancel the activity</option>
                <option value="false" ${interrupting ? "" : "selected"}>Non-interrupting — run alongside</option>
              </select></label>
            <p class="muted" style="font-size:12px">Interrupting cancels the attached activity (and its job) and routes the token out this event; non-interrupting spawns a parallel token and lets the activity continue.</p>`;
          if (timer) {
            const kinds = interrupting ? ["duration", "date"] : ["duration", "date", "cycle"];
            const cycleNote = interrupting
              ? "An interrupting boundary fires once, so it has no cycle."
              : "A non-interrupting boundary may <b>Cycle</b> — an ISO-8601 repeating interval (<b>R/PT1H</b>) or cron (<b>0 * * * *</b>) — firing a fresh token each time.";
            html += timerFieldsHTML(timer, kinds, `The event fires relative to the activity (ADR-0054).
              <b>Duration</b> fires that long after it starts (<b>PT30S</b>, <b>PT5M</b>); <b>Date &amp; time</b> at a fixed instant.
              ${cycleNote} A FEEL expression is allowed in any type.`);
          } else if (msg) {
            html += messageFieldsHTML(modeler, msg, "The event fires when this message is published with a matching correlation key.");
          } else if (sig) {
            html += signalFieldsHTML(modeler, sig, "The event fires when a signal with this name is broadcast (in this or any other instance) while the activity runs.");
          } else if (escl) {
            html += escalationFieldsHTML(modeler, escl, "The event fires when the attached activity raises a matching escalation — an escalation throw/end event inside it, or one propagating up from a called process. Interrupting cancels the activity and routes out this event; non-interrupting runs the handler while the activity keeps going.");
          } else if (cond) {
            html += conditionalFieldsHTML(cond, "The event fires while the activity runs, when this boolean condition over the instance's variables becomes true — re-evaluated on every variable change. Interrupting cancels the activity and routes out this event; non-interrupting runs the handler once while the activity keeps going.");
          } else {
            html += `<p class="muted" style="font-size:12px">Use the wrench icon on the element to make this a <b>Timer</b>, <b>Message</b>, <b>Signal</b>, <b>Error</b>, <b>Escalation</b>, or <b>Conditional</b> boundary event, then configure its trigger here.</p>`;
          }
        }
      } else if (bo.$type === "bpmn:StartEvent" && isEventSubStart(element)) {
        // The start event of an event subprocess: it triggers the handler while the
        // enclosing scope runs, interrupting it or not (ADR-0082). Its message/timer
        // trigger reuses the same editors as a catch/boundary event; the isInterrupting
        // flag is the scope-level analog of a boundary's cancelActivity.
        const timer = timerDefOf(bo);
        const msg = messageDefOf(bo);
        const sig = signalDefOf(bo);
        const err = errorDefOf(bo);
        const escl = escalationDefOf(bo);
        const cond = conditionalDefOf(bo);
        if (err) {
          // An error event subprocess is always interrupting — no toggle (ADR-0089).
          html += `<h3>Event subprocess trigger</h3>
            <p class="muted" style="font-size:12px">An <b>error event subprocess</b> is always <b>interrupting</b>: a matching thrown error terminates the enclosing scope's other work, then runs this handler.</p>`;
          html += errorFieldsHTML(modeler, err, "The event subprocess fires when its enclosing scope throws a matching error, terminating the scope's other work and running this handler.");
        } else {
          const interrupting = bo.isInterrupting !== false;
          html += `<h3>Event subprocess trigger</h3>
            <label class="field"><span>On trigger</span>
              <select id="f-interrupting">
                <option value="true" ${interrupting ? "selected" : ""}>Interrupting — cancel the enclosing scope</option>
                <option value="false" ${interrupting ? "" : "selected"}>Non-interrupting — run alongside</option>
              </select></label>
            <p class="muted" style="font-size:12px">This start event triggers the event subprocess while its enclosing scope (the process or subprocess) runs. <b>Interrupting</b> terminates the scope's other work, then runs this handler; <b>non-interrupting</b> runs it in parallel and can fire again.</p>`;
          if (timer) {
            const kinds = interrupting ? ["duration", "date"] : ["duration", "date", "cycle"];
            const cycleNote = interrupting
              ? "An interrupting timer fires once, so it has no cycle."
              : "A non-interrupting timer may <b>Cycle</b> — an ISO-8601 repeating interval (<b>R3/PT1H</b>) or cron (<b>0 * * * *</b>) — firing the handler each time.";
            html += timerFieldsHTML(timer, kinds, `The event subprocess fires on this schedule while its scope runs (ADR-0082).
              <b>Duration</b> fires that long after the scope is entered; <b>Date &amp; time</b> at a fixed instant.
              ${cycleNote} A FEEL expression is allowed in any type.`);
          } else if (msg) {
            html += messageFieldsHTML(modeler, msg, "The event subprocess fires when this message is published with a matching correlation key, while its scope runs.");
          } else if (sig) {
            html += signalFieldsHTML(modeler, sig, "The event subprocess fires when a signal with this name is broadcast while its scope runs. A non-interrupting trigger re-arms and can fire again.");
          } else if (escl) {
            html += escalationFieldsHTML(modeler, escl, "The event subprocess fires when its enclosing scope raises a matching escalation. Interrupting terminates the scope's other work first; non-interrupting runs this handler alongside the still-running scope.");
          } else if (cond) {
            html += conditionalFieldsHTML(cond, "The event subprocess fires when this boolean condition over the scope's variables becomes true — re-evaluated on every variable change. Interrupting terminates the scope's other work first; non-interrupting runs this handler once alongside the still-running scope.");
          } else {
            html += `<p class="muted" style="font-size:12px">Use the wrench icon on this start event to give it a <b>Timer</b>, <b>Message</b>, <b>Signal</b>, <b>Error</b>, <b>Escalation</b>, or <b>Conditional</b> trigger, then configure it here.</p>`;
          }
        }
      } else if (bo.$type === "bpmn:StartEvent") {
        const timer = timerDefOf(bo);
        const msg = messageDefOf(bo);
        const sig = signalDefOf(bo);
        if (timer) {
          html += timerFieldsHTML(timer, ["duration", "date", "cycle"], `A timer start event fires on this schedule with no incoming token (ADR-0051).
            <b>Duration</b> and <b>Date &amp; time</b> fire once — that long after deploy, or at that instant;
            <b>Cycle</b> recurs, either an ISO-8601 repeating interval (<b>R/PT1H</b>, <b>R3/P1D</b>) or a cron expression (<b>0 * * * *</b>).
            A FEEL expression is allowed in any type.`);
        } else if (msg) {
          html += messageFieldsHTML(modeler, msg, "A message start event: publishing this message starts a new instance of this process, matched by message name (the correlation key is shared with the throwing event but is not yet evaluated for starts).");
        } else if (sig) {
          html += signalFieldsHTML(modeler, sig, "A signal start event: broadcasting this signal starts a new instance of this process, matched by signal name. One broadcast starts every deployed process with a matching signal start.");
        } else {
          const fd = findExt(bo, "zeebe:FormDefinition") || {};
          const curForm = fd.formId || "";
          html += `<h3>Start form</h3>
            <label class="field"><span>Linked form</span>
              <select id="f-form">
                <option value="">— none —</option>
                ${curForm ? `<option value="${esc(curForm)}" selected>${esc(curForm)}</option>` : ""}
              </select></label>
            <p class="muted" style="font-size:12px">Shown before the process starts — from the Tasks app's <b>Start</b> view — its data becomes the instance's start variables.
              <a href="#/modeler/form/new" target="_blank" rel="noopener">Create a new form</a>, then reopen this to link it.</p>
            <p class="muted" style="font-size:12px">A plain start event begins an instance directly. Use the wrench icon on the element to make this a <b>Timer</b>, <b>Message</b>, or <b>Signal</b> start event instead.</p>`;
        }
      } else if (bo.$type === "bpmn:EventBasedGateway") {
        // A deferred choice: no configuration of its own — the branches are the
        // catch events it points at (ADR-0110).
        html += `<p class="muted" style="font-size:12px">An <b>event-based gateway</b> is a <b>deferred choice</b>: reaching it arms every branch's catch event at once (each outgoing flow must lead to a <b>message</b>, <b>timer</b>, or <b>signal</b> intermediate catch event), and the branch whose event fires <b>first</b> is taken — the others are cancelled. The classic use is a request with a timeout (a message catch raced against a timer catch).</p>`;
      } else if (bo.$type === "bpmn:EndEvent") {
        const msg = messageDefOf(bo);
        const sig = signalDefOf(bo);
        const err = errorDefOf(bo);
        const escl = escalationDefOf(bo);
        const cancel = cancelDefOf(bo);
        if (msg) {
          html += messageFieldsHTML(modeler, msg, "On reaching this end event the message is published; any instance waiting on it with a matching correlation key continues. The instance then ends.");
        } else if (sig) {
          html += signalFieldsHTML(modeler, sig, "On reaching this end event the signal is broadcast to every event waiting on that signal name, across all instances. The instance then ends.");
        } else if (err) {
          html += errorFieldsHTML(modeler, err, "On reaching this end event the error is thrown, aborting its scope and propagating up to the nearest matching error boundary or error event subprocess. Uncaught, it raises an incident.");
        } else if (escl) {
          html += escalationFieldsHTML(modeler, escl, "On reaching this end event the escalation is raised, propagating up to the nearest matching escalation boundary or event subprocess, then this path ends. Unlike an error end, a matching catch may be non-interrupting, and an uncaught escalation is harmless (no incident).");
        } else if (cancel) {
          // A cancel end event is only meaningful inside a transaction (ADR-0108).
          html += `<p class="muted" style="font-size:12px">A <b>cancel end event</b> cancels its enclosing <b>transaction</b>: its completed activities are compensated (in reverse order), then the token is routed out the transaction's <b>cancel boundary</b>. Use it only inside a transaction subprocess.</p>`;
        } else {
          html += `<p class="muted" style="font-size:12px">A plain end event ends the instance. Use the wrench icon on the element to make this a <b>Message</b>, <b>Signal</b>, <b>Error</b>, or <b>Escalation</b> end event.</p>`;
        }
      }
    } else if (isGatewayFlow && !isDefaultFlow) {
      // Design tab: point to where the executable rule lives.
      const has = bo.conditionExpression && bo.conditionExpression.body;
      html += `<p class="muted" style="font-size:12px">${has
        ? "A FEEL condition is set on this branch — edit it in the <b>Implement</b> tab."
        : "Set this branch's FEEL condition in the <b>Implement</b> tab."}</p>`;
    }
    // A loop marker on an element that has no Loop section above is one Atlas does not
    // run: the shape would show a ∥/≡/↻ icon the engine ignores. Say so rather than let
    // the diagram claim behavior it doesn't have (ADR-0133).
    if (bo.loopCharacteristics && !html.includes("f-mi-mode")) {
      html += `<h3>Loop</h3>
        <p class="muted" style="font-size:12px">This element carries a <b>loop marker</b> Atlas does not execute here — it will run <b>once</b>, whatever the icon suggests. Loops run on <b>activities</b>: every task kind, call activities and subprocesses (a message-kind send task is a throw, not an activity). Remove the marker (the wrench icon on the shape) or move the work to one of those.</p>`;
    }
    body.innerHTML = html;

    body.querySelector("#f-name").addEventListener("change", (e) => {
      try {
        modeling.updateProperties(element, { name: e.target.value });
        // A data object's engine identity is the underlying <dataObject> name, not
        // the reference's — so setting the reference's name here also names the
        // object it points at, keeping the modeled name and the runtime one in sync
        // (ADR-0053).
        if (bo.$type === "bpmn:DataObjectReference" && bo.dataObjectRef) {
          modeling.updateModdleProperties(element, bo.dataObjectRef, { name: e.target.value });
        }
      } catch { /* stale */ }
    });

    // Element IDs are editable, mirroring the Process ID field. bpmn-js validates the
    // new id (unique, a valid identifier) and rewrites the references that point at this
    // element — they are moddle object references, so links such as a data object's stay
    // intact — throwing on an invalid or duplicate id, which we revert with a toast. This
    // is how a data object's auto-generated id is renamed to something meaningful.
    const fid = body.querySelector("#f-id");
    if (fid) {
      fid.addEventListener("change", (e) => {
        const v = (e.target.value || "").trim();
        if (v === bo.id) return;
        if (!v) { show(element); return; } // empty is not a valid id → revert to the current one
        try { modeling.updateProperties(element, { id: v }); }
        catch { toast("invalid id — must be unique and a valid identifier", "err"); show(element); }
      });
    }

    const fdatastate = body.querySelector("#f-datastate");
    if (fdatastate) {
      fdatastate.addEventListener("change", (e) => {
        const v = (e.target.value || "").trim();
        try {
          let ds;
          if (v) {
            ds = modeler.get("moddle").create("bpmn:DataState", { name: v });
            ds.$parent = bo;
          }
          // Setting dataState to undefined clears the [state] label.
          modeling.updateModdleProperties(element, bo, { dataState: ds || undefined });
        } catch { /* stale */ }
      });
    }
    const fcollection = body.querySelector("#f-collection");
    if (fcollection && bo.dataObjectRef) {
      fcollection.addEventListener("change", (e) => {
        try { modeling.updateModdleProperties(element, bo.dataObjectRef, { isCollection: !!e.target.checked }); } catch { /* stale */ }
      });
    }
    const fpointsto = body.querySelector("#f-pointsto");
    if (fpointsto) {
      fpointsto.addEventListener("change", (e) => {
        try {
          const procBo = processOf(modeler, element);
          const objs = procBo ? (procBo.flowElements || []).filter((x) => x.$type === "bpmn:DataObject") : [];
          const target = objs.find((o) => o.id === e.target.value);
          if (!target) return;
          const old = bo.dataObjectRef;
          // Point this reference at the chosen object, and relabel the box to match so
          // the canvas and the engine identity agree.
          modeling.updateModdleProperties(element, bo, { dataObjectRef: target });
          if (target.name) modeling.updateProperties(element, { name: target.name });
          // Remove the reference's former object if nothing else points at it, so a
          // freshly-dropped duplicate does not linger as a phantom object.
          if (old && old !== target && procBo) {
            const stillUsed = (procBo.flowElements || []).some((x) => x.$type === "bpmn:DataObjectReference" && x.dataObjectRef === old);
            if (!stillUsed) {
              modeling.updateModdleProperties(element, procBo, { flowElements: (procBo.flowElements || []).filter((x) => x !== old) });
            }
          }
          show(element);
        } catch { /* stale */ }
      });
    }
    const assocFrom = body.querySelector("#f-assoc-from");
    const assocTo = body.querySelector("#f-assoc-to");
    if (assocFrom || assocTo) {
      const applyAssoc = () => setAssignment(modeler, element, bo,
        assocFrom ? assocFrom.value.trim() : "",
        assocTo ? assocTo.value.trim() : "");
      if (assocFrom) assocFrom.addEventListener("change", applyAssoc);
      if (assocTo) assocTo.addEventListener("change", applyAssoc);
    }

    const tasktype = body.querySelector("#f-tasktype");
    if (tasktype) {
      tasktype.addEventListener("change", (e) => {
        try {
          const el = modeler.get("bpmnReplace").replaceElement(element, { type: e.target.value });
          selection.select(el);
          show(el);
        } catch (err) { /* stale */ }
      });
    }
    // Script language selector: switch a script task between FEEL (inline) and a
    // job-worker language by swapping which extension it carries, then re-render so
    // the right fields show. Switching to a job language stores it on the
    // <atlas:jobScript>; switching to FEEL drops that extension.
    const flang = body.querySelector("#f-scriptlang");
    if (flang) {
      flang.addEventListener("change", (e) => {
        try {
          if (e.target.value === "feel") {
            removeExt(modeler, element, "atlas:JobScript");
          } else {
            removeExt(modeler, element, "zeebe:Script");
            upsertExt(modeler, element, "atlas:JobScript", { language: e.target.value });
          }
          show(element);
        } catch { /* stale */ }
      });
    }

    const fexpr = body.querySelector("#f-expr");
    const fresult = body.querySelector("#f-result");
    const saveScript = () => savePreservingPanel(() => {
      const raw = (fexpr.value || "").trim();
      upsertExt(modeler, element, "zeebe:Script", {
        expression: raw === "" ? "" : (raw.startsWith("=") ? raw : "= " + raw),
        resultVariable: (fresult.value || "").trim(),
      });
    });
    if (fexpr) fexpr.addEventListener("change", saveScript);
    if (fresult) fresult.addEventListener("change", saveScript);

    const fpsbody = body.querySelector("#f-psbody");
    const fpsresult = body.querySelector("#f-psresult");
    const fpsretries = body.querySelector("#f-psretries");
    const saveJobScript = () => savePreservingPanel(() => {
      // The selected language is the source of truth; keep it on the extension so
      // the compiler maps it to the right worker's job type.
      const language = (flang && flang.value) || (findExt(element.businessObject, "atlas:JobScript") || {}).language || "powershell";
      upsertExt(modeler, element, "atlas:JobScript", {
        language,
        source: fpsbody.value || "",
        resultVariable: (fpsresult.value || "").trim(),
        // A script runs as a job, so it carries the same retry budget as any other
        // job-backed task (ADR-0135); cleared means the engine's default, written as
        // no attribute at all.
        retries: ((fpsretries && fpsretries.value) || "").trim() || undefined,
      });
    });
    if (fpsbody) fpsbody.addEventListener("change", saveJobScript);
    if (fpsresult) fpsresult.addEventListener("change", saveJobScript);
    if (fpsretries) fpsretries.addEventListener("change", saveJobScript);

    // The script field is upgraded to the shared code editor (highlighting,
    // completion, gutter, error markers) and its Run panel wired in the Implement
    // tab's enhancement pass below — see enhanceScript.

    // Service-task connector kind: a searchable picker over SERVICE_TASK_KINDS
    // (ADR-0067). Filtering narrows the list; clicking a row switches the kind
    // (swapping which extension the task carries) and re-renders so that kind's
    // fields show. Field edits upsert the current kind's extension generically.
    const stfilter = body.querySelector("#f-stkind-filter");
    const stlist = body.querySelector("#f-stkind-list");
    if (stfilter && stlist) {
      stfilter.addEventListener("input", () => {
        const q = stfilter.value.trim().toLowerCase();
        stlist.querySelectorAll(".stkind-row").forEach((row) => {
          row.hidden = q !== "" && !row.dataset.match.includes(q);
        });
      });
    }
    if (stlist) {
      stlist.addEventListener("click", (e) => {
        const row = e.target.closest(".stkind-row");
        if (!row) return;
        try {
          // A send task's picker includes the Message kind (ADR-0112); a service task's does not.
          if (bo.$type === "bpmn:SendTask") applySendTaskKind(modeler, element, row.dataset.kind);
          else applyServiceTaskKind(modeler, element, row.dataset.kind);
          show(element);
        } catch { /* stale */ }
      });
    }
    const stKind = serviceTaskKind(bo);
    const stModdle = modeler.get("moddle");
    // readMapField rebuilds a map field's moddle children (headers/query params)
    // from its rows, keeping only rows with a name (an unnamed row is incomplete).
    const readMapField = (f) => {
      const out = [];
      body.querySelectorAll(`.st-map-row[data-field="${f.key}"]`).forEach((r) => {
        const name = (r.querySelector(".st-map-name").value || "").trim();
        if (!name) return;
        out.push(stModdle.create(f.childType, { name, value: r.querySelector(".st-map-value").value || "" }));
      });
      return out;
    };
    const saveKindFields = () => savePreservingPanel(() => {
      const props = {};
      for (const f of stKind.fields) {
        if (f.group) continue;
        if (f.type === "map") { props[f.key] = readMapField(f); continue; }
        // A showIf-hidden field isn't rendered; leave its stored value untouched.
        const el = body.querySelector("#f-st-" + f.key);
        if (!el) continue;
        const v = (el.value || "").trim();
        // A cleared count means "the engine's default" — drop the attribute rather
        // than write an empty one, so the exported XML says what the task means.
        props[f.key] = (f.type === "number" && v === "") ? undefined : v;
      }
      upsertExt(modeler, element, stKind.ext, props);
    });
    for (const f of stKind.fields) {
      if (f.group || f.type === "map") continue;
      const el = body.querySelector("#f-st-" + f.key);
      if (!el) continue;
      el.addEventListener("change", () => {
        saveKindFields();
        if (f.reRender) show(element); // e.g. auth type: reveal the scheme's fields
      });
    }
    // Value-or-expression (fx) support: an fx field can hold a literal or a FEEL
    // expression (stored '=' prefixed, exactly what the compiler keys on). The
    // toggle swaps the editing surface; the value the save wiring reads is the same
    // field element, so no save/load change is needed.
    const stFeelVars = variablesForCompletion(modeler, element);
    const stValidate = api ? (expression) => api("POST", "/api/v1/feel/validate", { expression }) : null;
    const stAttachFx = (el) => { if (el) attachExpressionToggle(el, { variables: stFeelVars, validate: stValidate }); };
    // Every fx-capable text field (REST url, mail recipients/subject/body, the Remedy
    // form, …) gets the value-or-expression toggle; map value cells are handled below.
    for (const f of stKind.fields) {
      if (f.group || f.type === "map" || !f.fx) continue;
      stAttachFx(body.querySelector("#f-st-" + f.key));
    }

    // Map editors: a name/value row list with add/remove. Edits and removals save;
    // adding inserts an empty row (it saves once the author types a name). When the
    // map is fx-capable, each value cell carries the fx toggle.
    for (const f of stKind.fields) {
      if (f.type !== "map") continue;
      const cont = body.querySelector(`.st-map[data-field="${f.key}"]`);
      if (!cont) continue;
      if (f.fx) cont.querySelectorAll(".st-map-value").forEach(stAttachFx);
      cont.addEventListener("change", saveKindFields);
      cont.addEventListener("click", (e) => {
        if (e.target.closest(".st-map-add")) {
          e.preventDefault();
          cont.querySelector(".st-map-rows").insertAdjacentHTML("beforeend", stMapRowHTML(f.key, "", ""));
          if (f.fx) stAttachFx(cont.querySelector(".st-map-row:last-child .st-map-value"));
        } else if (e.target.closest(".st-map-del")) {
          e.preventDefault();
          e.target.closest(".st-map-row").remove();
          saveKindFields();
        }
      });
    }

    const fdecision = body.querySelector("#f-decisionid");
    const fresultvar = body.querySelector("#f-resultvar");
    const fbinding = body.querySelector("#f-brt-binding");
    const fbrtretries = body.querySelector("#f-brt-retries");
    // currentBinding preserves the decision binding (ADR-0063) across every save of
    // the called decision, so editing the id/result variable never drops it.
    const currentBinding = () => (fbinding && fbinding.value === "deployment") ? "deployment" : "latest";
    const calledDecisionProps = () => ({
      decisionId: (fdecision.value || "").trim(),
      resultVariable: (fresultvar.value || "").trim(),
      bindingType: currentBinding(),
      // Evaluating a decision is a job like any other, so the task carries the same
      // retry budget (ADR-0135); cleared means the engine's default, written as no
      // attribute at all.
      retries: ((fbrtretries && fbrtretries.value) || "").trim() || undefined,
    });
    const saveDecision = () => savePreservingPanel(() => {
      upsertExt(modeler, element, "zeebe:CalledDecision", calledDecisionProps());
    });
    if (fdecision) fdecision.addEventListener("change", saveDecision);
    if (fresultvar) fresultvar.addEventListener("change", saveDecision);
    if (fbinding) fbinding.addEventListener("change", saveDecision);
    if (fbrtretries) fbrtretries.addEventListener("change", saveDecision);

    // Evaluation mode: local (embedded DMN) vs a temis connector (central). The
    // choice is the presence of the atlas:temisConnector extension the compiler
    // reads (ADR-0050); flipping it re-renders so the connector field appears.
    const fmode = body.querySelector("#f-brt-mode");
    if (fmode) {
      fmode.addEventListener("change", () => {
        savePreservingPanel(() => {
          if (fmode.value === "connector") {
            const name = (body.querySelector("#f-connector")?.value || "").trim();
            upsertExt(modeler, element, "atlas:TemisConnector", { connector: name });
          } else {
            removeExt(modeler, element, "atlas:TemisConnector");
          }
        });
        show(element);
      });
    }
    const fconnector = body.querySelector("#f-connector");
    if (fconnector) {
      fconnector.addEventListener("change", () => savePreservingPanel(() => {
        upsertExt(modeler, element, "atlas:TemisConnector", { connector: (fconnector.value || "").trim() });
      }));
    }

    // Decision picker: populate from the DMN references' decisions and, on pick,
    // set the decision id + result variable and auto-fill the input mappings from
    // the decision's declared inputs — so an author selects from a list instead of
    // typing ids and parameters by hand (ADR-0050). A previously-set source for a
    // given input target is preserved when re-picking.
    const fpick = body.querySelector("#f-decision-pick");
    if (fpick && api) {
      const decKey = (d) => `${d.modelRef} ${d.id}`;
      // The picker offers every decision the engine can resolve, not just this
      // project's own references: a business rule task routinely calls a decision
      // that lives in another project or is shared engine-wide (ADR-0034 project
      // scoping organizes artifacts, it does not gate reuse). Fetch the project's
      // decisions and the full catalog, list the project's own first (as an
      // optgroup) and every other decision below, so the dropdown is never empty
      // when a usable decision exists — and picking any of them auto-fills its
      // declared inputs. Without a project scope the full catalog is the only list.
      const scope = projectId ? "?projectId=" + encodeURIComponent(projectId) : "";
      const both = projectId
        ? Promise.all([
            api("GET", "/api/v1/decisions" + scope).catch(() => []),
            api("GET", "/api/v1/decisions").catch(() => []),
          ])
        : api("GET", "/api/v1/decisions").then((all) => [[], all || []]).catch(() => [[], []]);
      both.then(([scoped, all]) => {
        if (!document.body.contains(fpick)) return;
        const cur = (fdecision?.value || "").trim();
        const inProject = new Set((scoped || []).map(decKey));
        const seen = new Set();
        const catalog = [];
        const optionFor = (d) => {
          const label = d.model ? `${d.name} · ${d.model}` : d.name;
          return `<option value="${esc(d.id)}" data-key="${esc(decKey(d))}"${d.id === cur ? " selected" : ""}>${esc(label)}</option>`;
        };
        const takeGroup = (list) => {
          const out = [];
          for (const d of list || []) {
            if (seen.has(decKey(d))) continue;
            seen.add(decKey(d));
            catalog.push(d);
            out.push(optionFor(d));
          }
          return out;
        };
        const projectOpts = takeGroup(scoped);
        const otherOpts = takeGroup((all || []).filter((d) => !inProject.has(decKey(d))));
        const parts = [`<option value="">— choose a decision —</option>`];
        if (projectOpts.length) parts.push(`<optgroup label="This project">${projectOpts.join("")}</optgroup>`);
        if (otherOpts.length) parts.push(`<optgroup label="${projectOpts.length ? "Other decisions" : "Available decisions"}">${otherOpts.join("")}</optgroup>`);
        fpick.innerHTML = parts.join("");
        fpick._catalog = catalog;
        // Offer the current decision's full declared inputs in the name combobox,
        // not just the rows already mapped — so adding a row suggests every input.
        const curDec = catalog.find((d) => d.id === cur);
        const dl = body.querySelector("#dmn-inputs-dl");
        if (curDec && dl && Array.isArray(curDec.inputs) && curDec.inputs.length) {
          dl.innerHTML = curDec.inputs.map((inp) => `<option value="${esc(inp.name)}"></option>`).join("");
        }
      }).catch(() => { /* leave the placeholder; manual entry still works */ });

      // applyPick sets the decision id + result variable and auto-fills the input
      // mappings from a catalog decision's declared inputs, preserving any custom
      // source already mapped for a target. Shared by the picker's change handler
      // and by the "author a decision" flow, so a decision created in the embedded
      // editor is adopted exactly as if it had been picked from the list.
      const applyPick = (d) => {
        const io = findExt(element.businessObject, "zeebe:IoMapping");
        const prev = {};
        for (const p of (io && io.inputParameters) || []) {
          if (p.target) prev[p.target] = (p.source || "").replace(/^=\s*/, "");
        }
        savePreservingPanel(() => {
          upsertExt(modeler, element, "zeebe:CalledDecision", {
            // Picking a decision fills in the id and result variable; everything else
            // the task already carries (binding, retry budget) survives the pick.
            ...calledDecisionProps(),
            decisionId: d.id,
            resultVariable: (fresultvar.value || "").trim() || (d.output && d.output.name) || d.id,
          });
          const rows = (d.inputs || []).map((inp) => ({ target: inp.name, source: prev[inp.name] || inp.name }));
          saveDecisionInputs(modeler, element, rows);
        });
        show(element); // reflect the filled id, result variable, and input rows
      };
      fpick.addEventListener("change", () => {
        const k = fpick.selectedOptions[0] && fpick.selectedOptions[0].getAttribute("data-key");
        const d = (fpick._catalog || []).find((x) => decKey(x) === k) ||
          (fpick._catalog || []).find((x) => x.id === fpick.value);
        if (d) applyPick(d);
      });

      // Author-a-decision: the embedded dmn-js editor (ADR-0051). "＋ Neue Decision"
      // creates a model + reference and adopts it; "Bearbeiten" opens the current
      // decision's local model in place. After authoring, the catalog is re-fetched
      // and the authored decision is adopted (id + inputs + result), so inputs and
      // output flow in automatically — no separate upload step.
      const adoptAuthored = async (result) => {
        if (!result) return;
        const scope = projectId ? "?projectId=" + encodeURIComponent(projectId) : "";
        let decisions = [];
        try { decisions = (await api("GET", "/api/v1/decisions" + scope)) || []; } catch { /* keep panel */ }
        const d = decisions.find((x) => x.id === result.name) ||
          decisions.find((x) => x.modelRef === result.modelRef);
        if (d) applyPick(d); else show(element);
      };
      const fnew = body.querySelector("#f-dmn-new");
      if (fnew) {
        fnew.addEventListener("click", async () => {
          adoptAuthored(await openDmnEditor({ api, toast, projectId }));
        });
      }
      const fedit = body.querySelector("#f-dmn-edit");
      if (fedit) {
        fedit.addEventListener("click", async () => {
          const cur = (fpick._catalog || []).find((x) => x.id === (fdecision?.value || "").trim());
          if (!cur || !cur.modelRef) {
            toast && toast("Diese Decision hat kein lokal editierbares Modell.", "err");
            return;
          }
          adoptAuthored(await openDmnEditor({ api, toast, projectId, modelRef: cur.modelRef }));
        });
      }
    }

    const inputsWrap = body.querySelector("#dmn-inputs");
    if (inputsWrap) {
      const collect = () => [...inputsWrap.querySelectorAll(".dmn-input-row")].map((row) => ({
        target: (row.querySelector(".dmn-in-target").value || "").trim(),
        source: (row.querySelector(".dmn-in-source").value || "").trim(),
      }));
      const saveInputs = () => savePreservingPanel(() => saveDecisionInputs(modeler, element, collect()));
      // wireRow saves on blur and grows the list in place — typing into the last
      // row's target appends a fresh empty row without a full re-render, so input
      // focus is never yanked mid-edit.
      const wireRow = (row) => {
        const target = row.querySelector(".dmn-in-target");
        const source = row.querySelector(".dmn-in-source");
        target.addEventListener("change", saveInputs);
        source.addEventListener("change", saveInputs);
        target.addEventListener("input", () => {
          const rows = [...inputsWrap.querySelectorAll(".dmn-input-row")];
          if (row === rows[rows.length - 1] && target.value.trim() !== "") {
            const tmp = document.createElement("div");
            tmp.innerHTML = decisionInputRowHTML(rows.length, "", "");
            const newRow = tmp.firstElementChild;
            inputsWrap.appendChild(newRow);
            wireRow(newRow);
          }
        });
      };
      [...inputsWrap.querySelectorAll(".dmn-input-row")].forEach(wireRow);
    }

    // Generic zeebe:ioMapping input/output editor (ADR-0068), Camunda-style: one
    // collapsible list group per direction, each mapping a collapsible card. Cards
    // save on blur; the add button appends an auto-named card and the trash button
    // removes one. Both groups share one save that re-collects both lists.
    const ioGroups = [...body.querySelectorAll(".io-group")];
    if (ioGroups.length) {
      const ioInWrap = body.querySelector("#io-inputs");
      const ioOutWrap = body.querySelector("#io-outputs");
      const collect = (wrap) => wrap
        ? [...wrap.querySelectorAll(".io-map")].map((card) => ({
            target: (card.querySelector(".io-target").value || "").trim(),
            source: (card.querySelector(".io-source").value || "").trim(),
          }))
        : [];
      const saveIO = () => savePreservingPanel(() => saveIOMappings(modeler, element, collect(ioInWrap), collect(ioOutWrap)));
      // updateCount keeps a group's badge in step with its card total.
      const updateCount = (group) => {
        const badge = group.querySelector(".io-group-count");
        if (badge) badge.textContent = String(group.querySelectorAll(".io-map").length);
      };
      // wireCard binds one mapping card: the header toggles the card open/closed
      // (except the delete button), the name field retitles the card live and saves
      // on blur, the value saves on blur, and delete removes the card and saves.
      const wireCard = (card, group) => {
        const kind = card.dataset.kind;
        const target = card.querySelector(".io-target");
        const source = card.querySelector(".io-source");
        const titleEl = card.querySelector(".io-map-title");
        card.querySelector(".io-map-head").addEventListener("click", (e) => {
          if (e.target.closest(".io-map-del")) return;
          card.classList.toggle("collapsed");
        });
        target.addEventListener("input", () => { titleEl.textContent = ioMapTitle(kind, target.value); });
        target.addEventListener("change", saveIO);
        source.addEventListener("change", saveIO);
        card.querySelector(".io-map-del").addEventListener("click", (e) => {
          e.stopPropagation();
          card.remove();
          updateCount(group);
          saveIO();
        });
      };
      for (const group of ioGroups) {
        const kind = group.dataset.kind;
        const wrap = group.querySelector(".io-map-list");
        [...wrap.querySelectorAll(".io-map")].forEach((card) => wireCard(card, group));
        // Start collapsed on open like the other groups (all but General), and share the
        // panel's collapse memory so a re-render keeps the author's chosen state.
        group.classList.toggle("collapsed", groupCtl.isCollapsed(group.dataset.group || ""));
        // Section collapse: clicking the head toggles it, but not via the add button.
        group.querySelector(".io-group-head").addEventListener("click", (e) => {
          if (e.target.closest(".io-group-add")) return;
          groupCtl.onToggle((group.dataset.group || "").trim(), group.classList.toggle("collapsed"));
        });
        // Add an auto-named, expanded card (Camunda-style) and focus its name so the
        // author can rename it immediately; save so it persists even if left as-is.
        group.querySelector(".io-group-add").addEventListener("click", (e) => {
          e.stopPropagation();
          group.classList.remove("collapsed");
          groupCtl.onToggle((group.dataset.group || "").trim(), false);
          const idx = wrap.querySelectorAll(".io-map").length;
          const tmp = document.createElement("div");
          tmp.innerHTML = ioMapCardHTML(kind, idx, "", ioMapDefaultName(kind));
          const card = tmp.firstElementChild;
          wrap.appendChild(card);
          wireCard(card, group);
          updateCount(group);
          saveIO();
          const name = card.querySelector(".io-target");
          name.focus();
          name.select();
        });
      }
    }

    // Call activity: the whole <zeebe:calledElement> is rewritten on any field
    // change, so editing one field never drops the others (ADR-0076). Propagation
    // flags are written as booleans (moddle omits a value equal to its default);
    // the compiler reads an absent flag as true, matching Zeebe.
    const fcallpid = body.querySelector("#f-call-processid");
    if (fcallpid) {
      const fcallbind = body.querySelector("#f-call-binding");
      const fcallpp = body.querySelector("#f-call-prop-parent");
      const fcallpc = body.querySelector("#f-call-prop-child");
      const saveCall = () => savePreservingPanel(() => {
        upsertExt(modeler, element, "zeebe:CalledElement", {
          processId: (fcallpid.value || "").trim(),
          bindingType: fcallbind.value === "deployment" ? "deployment" : "latest",
          propagateAllParentVariables: fcallpp.checked,
          propagateAllChildVariables: fcallpc.checked,
        });
      });
      fcallpid.addEventListener("change", saveCall);
      fcallbind.addEventListener("change", saveCall);
      fcallpp.addEventListener("change", saveCall);
      fcallpc.addEventListener("change", saveCall);

      // Suggest existing callees — deployed processes and saved drafts — so the
      // Process ID is a pick, not blind typing; free text stays allowed for a callee
      // that doesn't exist yet (ADR-0076). Best-effort: a load failure just leaves an
      // empty suggestion list.
      const proclist = body.querySelector("#f-call-proc-list");
      if (proclist) {
        (async () => {
          try {
            const [procs, drafts] = await Promise.all([
              api("GET", "/api/v1/processes").catch(() => []),
              api("GET", "/api/v1/drafts").catch(() => []),
            ]);
            const seen = new Set();
            const opts = [];
            const add = (id, label) => {
              id = (id || "").trim();
              if (!id || seen.has(id)) return;
              seen.add(id);
              opts.push(`<option value="${esc(id)}">${esc(label)}</option>`);
            };
            (procs || []).forEach((p) => add(p.processId,
              (p.name && p.name !== p.processId ? p.name + " · " : "") + "deployed" + (p.version ? " v" + p.version : "")));
            (drafts || []).forEach((d) => add(d.processId,
              (d.name && d.name !== d.processId ? d.name + " · " : "") + "draft"));
            proclist.innerHTML = opts.join("");
          } catch { /* suggestions are best-effort */ }
        })();
      }

      // "＋ Create new process" scaffolds the called process the caller points at and
      // opens it (ADR-0076): it saves this caller first (drafts persist only on save,
      // so navigating away would otherwise drop its edits), then creates a starter
      // draft keyed by the process id and navigates to it in the modeler.
      const newbtn = body.querySelector("#f-call-newproc");
      if (newbtn) {
        newbtn.addEventListener("click", async () => {
          let pid = (fcallpid.value || "").trim();
          if (!pid) {
            const typed = prompt("Process ID for the new called process:", "");
            if (typed == null) return;
            pid = typed.trim();
            if (!pid) return;
          }
          pid = pid.replace(/\s+/g, "_");
          newbtn.disabled = true;
          try {
            // Point the caller at this child, then persist the caller so its unsaved
            // edits survive the navigation.
            fcallpid.value = pid;
            saveCall();
            const savePath = "/api/v1/drafts" + (projectId ? "?projectId=" + encodeURIComponent(projectId) : "");
            const { xml: callerXml } = await modeler.saveXML({ format: true });
            await api("POST", savePath, callerXml, true);
            if (collab && collab.markSaved) collab.markSaved();
            // Scaffold the child only if no draft already holds that id — never clobber
            // existing work; just open it in that case.
            const existing = await api("GET", "/api/v1/drafts").catch(() => []);
            if ((existing || []).some((d) => (d.processId || "") === pid)) {
              toast(`Opening existing draft “${pid}”`, "ok");
            } else {
              await api("POST", savePath, calleeXML(pid, pid), true);
              toast(`Created called process “${pid}”`, "ok");
            }
            location.hash = `#/modeler/draft/${encodeURIComponent(pid)}`;
          } catch (e) {
            toast("Could not create the process: " + e.message, "err");
            newbtn.disabled = false;
          }
        });
      }
    }

    // Loop (ADR-0077 multi-instance, ADR-0133 standard loop): the whole loop
    // characteristics element is rewritten on any field change so editing one field
    // never leaves a stale sibling. Mode, the collection/count choice, and the
    // condition-check choice re-render the panel (fields appear/vanish); the text
    // fields save on blur. Writing the element is what makes bpmn-js redraw the
    // marker, so the icon follows the Mode select by construction.
    const fmiMode = body.querySelector("#f-mi-mode");
    if (fmiMode) {
      const v = (sel) => { const el = body.querySelector(sel); return el ? (el.value || "").trim() : ""; };
      const saveMI = () => savePreservingPanel(() => saveMultiInstance(modeler, element, {
        mode: fmiMode.value,
        src: v("#f-mi-src") || "collection",
        inputCollection: v("#f-mi-inputCollection"),
        inputElement: v("#f-mi-inputElement"),
        cardinality: v("#f-mi-cardinality"),
        outputCollection: v("#f-mi-outputCollection"),
        outputElement: v("#f-mi-outputElement"),
        completion: v("#f-mi-completion"),
        loopCondition: v("#f-mi-loopcond"),
        loopMaximum: v("#f-mi-loopmax"),
        testBefore: v("#f-mi-testbefore") === "before",
      }));
      fmiMode.addEventListener("change", () => { saveMI(); show(element); });
      const fmiSrc = body.querySelector("#f-mi-src");
      if (fmiSrc) fmiSrc.addEventListener("change", () => { saveMI(); show(element); });
      ["#f-mi-inputCollection", "#f-mi-inputElement", "#f-mi-cardinality",
        "#f-mi-outputCollection", "#f-mi-outputElement", "#f-mi-completion",
        "#f-mi-loopcond", "#f-mi-loopmax", "#f-mi-testbefore"].forEach((sel) => {
        const el = body.querySelector(sel);
        if (el) el.addEventListener("change", saveMI);
      });
    }

    const fassignee = body.querySelector("#f-assignee");
    const fgroups = body.querySelector("#f-groups");
    const saveAssignment = () => {
      upsertExt(modeler, element, "zeebe:AssignmentDefinition", {
        assignee: (fassignee.value || "").trim(),
        candidateGroups: (fgroups.value || "").trim(),
      });
    };
    if (fassignee) fassignee.addEventListener("change", saveAssignment);
    if (fgroups) fgroups.addEventListener("change", saveAssignment);

    // Priority and due date (ADR-0051): zeebe:priorityDefinition is written only
    // when it differs from the default 50; zeebe:taskSchedule is dropped when the
    // due-date field is cleared, keeping the XML free of empty extensions.
    const fpriority = body.querySelector("#f-priority");
    const fdue = body.querySelector("#f-due");
    if (fpriority) {
      fpriority.addEventListener("change", () => {
        const v = (fpriority.value || "").trim();
        if (v === "" || v === "50") removeExt(modeler, element, "zeebe:PriorityDefinition");
        else upsertExt(modeler, element, "zeebe:PriorityDefinition", { priority: v });
      });
    }
    if (fdue) {
      fdue.addEventListener("change", () => {
        const v = (fdue.value || "").trim();
        if (v) upsertExt(modeler, element, "zeebe:TaskSchedule", { dueDate: v });
        else removeExt(modeler, element, "zeebe:TaskSchedule");
      });
    }

    const fform = body.querySelector("#f-form");
    if (fform) {
      // Link/unlink writes (or drops) the zeebe:FormDefinition formId — the same
      // extension the compiler reads to bind a form (ADR-0028).
      fform.addEventListener("change", () => {
        const id = fform.value;
        if (id) upsertExt(modeler, element, "zeebe:FormDefinition", { formId: id });
        else removeExt(modeler, element, "zeebe:FormDefinition");
      });
      // Populate the picker with the project's forms once loaded; keep the
      // currently-linked one selected even if it is no longer in the list.
      api("GET", "/api/v1/forms").then((forms) => {
        if (!document.body.contains(fform)) return; // selection moved on
        const cur = fform.value;
        const opts = [`<option value="">— none —</option>`];
        let sawCur = false;
        for (const f of forms || []) {
          const sel = f.id === cur ? " selected" : "";
          if (f.id === cur) sawCur = true;
          opts.push(`<option value="${esc(f.id)}"${sel}>${esc(f.name || f.id)}</option>`);
        }
        if (cur && !sawCur) opts.push(`<option value="${esc(cur)}" selected>${esc(cur)} (missing)</option>`);
        fform.innerHTML = opts.join("");
      }).catch(() => { /* leave the current single-option select as-is */ });
    }

    const fcancel = body.querySelector("#f-cancelactivity");
    if (fcancel) {
      fcancel.addEventListener("change", () => {
        // Flipping cancelActivity also flips bpmn-js's solid/dashed boundary marker.
        try { modeling.updateProperties(element, { cancelActivity: fcancel.value === "true" }); } catch { /* stale */ }
      });
    }

    const finterrupting = body.querySelector("#f-interrupting");
    if (finterrupting) {
      finterrupting.addEventListener("change", () => {
        // isInterrupting flips bpmn-js's solid/dashed event-subprocess start marker, and
        // re-renders so the timer editor can offer (or drop) the Cycle kind (ADR-0082).
        try { modeling.updateProperties(element, { isInterrupting: finterrupting.value === "true" }); } catch { /* stale */ }
        show(element);
      });
    }

    const ftimerkind = body.querySelector("#f-timerkind");
    const ftimerval = body.querySelector("#f-timerval");
    if (ftimerkind || ftimerval) {
      const moddle = modeler.get("moddle");
      // ensureExpr returns the FormalExpression sub-element for a kind, creating
      // an empty one parented to the timer when it does not yet exist.
      const ensureExpr = (timer, prop) => {
        let e = timer[prop];
        if (!e) { e = moddle.create("bpmn:FormalExpression"); e.$parent = timer; }
        return e;
      };
      if (ftimerkind) {
        // Switching type moves the schedule to a different sub-element: the chosen
        // kind's element is (re)created and the other two are dropped, so exactly
        // one of timeDuration/timeDate/timeCycle is ever set (the compiler rejects
        // more than one). Re-render so the value field's label and placeholder match.
        ftimerkind.addEventListener("change", () => {
          const timer = timerDefOf(element.businessObject);
          if (!timer) return;
          const props = {};
          for (const [k, meta] of Object.entries(TIMER_KINDS)) {
            props[meta.prop] = k === ftimerkind.value ? ensureExpr(timer, meta.prop) : undefined;
          }
          modeling.updateModdleProperties(element, timer, props);
          show(element);
        });
      }
      if (ftimerval) {
        ftimerval.addEventListener("change", () => {
          const timer = timerDefOf(element.businessObject);
          if (!timer) return;
          const kind = (ftimerkind && ftimerkind.value) || timerScheduleOf(timer).kind;
          const prop = TIMER_KINDS[kind].prop;
          const e = ensureExpr(timer, prop);
          e.body = (ftimerval.value || "").trim();
          modeling.updateModdleProperties(element, timer, { [prop]: e });
        });
      }
    }

    const fmsgref = body.querySelector("#f-msgref");
    if (fmsgref) {
      fmsgref.addEventListener("change", () => {
        const med = messageRefHolder(element.businessObject);
        if (!med) return;
        const v = fmsgref.value;
        savePreservingPanel(() => {
          if (v === "__new__") {
            linkMessage(modeler, element, med, createMessage(modeler, ""));
          } else if (v === "") {
            linkMessage(modeler, element, med, null);
          } else {
            linkMessage(modeler, element, med, listMessages(modeler).find((m) => m.id === v));
          }
        });
        show(element); // re-render so the name/key fields match the chosen message
      });
    }
    const fmsgname = body.querySelector("#f-msgname");
    if (fmsgname) {
      fmsgname.addEventListener("change", () => {
        const med = messageRefHolder(element.businessObject);
        if (med && med.messageRef) med.messageRef.name = (fmsgname.value || "").trim();
      });
    }
    const fcorrkey = body.querySelector("#f-corrkey");
    if (fcorrkey) {
      fcorrkey.addEventListener("change", () => {
        const med = messageRefHolder(element.businessObject);
        if (med && med.messageRef) setMessageCorrelationKey(modeler, med.messageRef, (fcorrkey.value || "").trim());
      });
    }
    const fsigref = body.querySelector("#f-sigref");
    if (fsigref) {
      fsigref.addEventListener("change", () => {
        const sed = signalDefOf(element.businessObject);
        if (!sed) return;
        const v = fsigref.value;
        savePreservingPanel(() => {
          if (v === "__new__") {
            linkSignal(modeler, element, sed, createSignal(modeler, ""));
          } else if (v === "") {
            linkSignal(modeler, element, sed, null);
          } else {
            linkSignal(modeler, element, sed, listSignals(modeler).find((s) => s.id === v));
          }
        });
        show(element); // re-render so the name field matches the chosen signal
      });
    }
    const fsigname = body.querySelector("#f-signame");
    if (fsigname) {
      fsigname.addEventListener("change", () => {
        const sed = signalDefOf(element.businessObject);
        if (sed && sed.signalRef) sed.signalRef.name = (fsigname.value || "").trim();
      });
    }
    const ferrref = body.querySelector("#f-errref");
    if (ferrref) {
      ferrref.addEventListener("change", () => {
        const eed = errorDefOf(element.businessObject);
        if (!eed) return;
        const v = ferrref.value;
        savePreservingPanel(() => {
          if (v === "__new__") {
            linkError(modeler, element, eed, createError(modeler, ""));
          } else if (v === "") {
            linkError(modeler, element, eed, null);
          } else {
            linkError(modeler, element, eed, listErrors(modeler).find((e) => e.id === v));
          }
        });
        show(element); // re-render so the code field matches the chosen error
      });
    }
    const ferrcode = body.querySelector("#f-errcode");
    if (ferrcode) {
      ferrcode.addEventListener("change", () => {
        const eed = errorDefOf(element.businessObject);
        if (eed && eed.errorRef) eed.errorRef.errorCode = (ferrcode.value || "").trim();
      });
    }
    const fescref = body.querySelector("#f-escref");
    if (fescref) {
      fescref.addEventListener("change", () => {
        const eed = escalationDefOf(element.businessObject);
        if (!eed) return;
        const v = fescref.value;
        savePreservingPanel(() => {
          if (v === "__new__") {
            linkEscalation(modeler, element, eed, createEscalation(modeler, ""));
          } else if (v === "") {
            linkEscalation(modeler, element, eed, null);
          } else {
            linkEscalation(modeler, element, eed, listEscalations(modeler).find((e) => e.id === v));
          }
        });
        show(element); // re-render so the code field matches the chosen escalation
      });
    }
    const fesccode = body.querySelector("#f-esccode");
    if (fesccode) {
      fesccode.addEventListener("change", () => {
        const eed = escalationDefOf(element.businessObject);
        if (eed && eed.escalationRef) eed.escalationRef.escalationCode = (fesccode.value || "").trim();
      });
    }
    const flinkname = body.querySelector("#f-linkname");
    if (flinkname) {
      flinkname.addEventListener("change", () => {
        const led = linkDefOf(element.businessObject);
        if (led) {
          try { modeling.updateModdleProperties(element, led, { name: (flinkname.value || "").trim() }); } catch { /* stale */ }
        }
      });
    }

    const fcond = body.querySelector("#f-cond");
    if (fcond) {
      fcond.addEventListener("change", () => savePreservingPanel(() => {
        const raw = (fcond.value || "").trim();
        const beo = element.businessObject;
        const prevCond = ((beo.conditionExpression && beo.conditionExpression.body) || "").replace(/^=\s*/, "").trim();
        const curName = (beo.name || "").trim();
        // The flow's diagram label mirrors its condition — so a conditional branch
        // shows its guard on the canvas — unless the modeler gave it a distinct
        // descriptive label (then that label is left alone).
        const mirrors = curName === "" || curName === prevCond;
        const props = {};
        if (raw === "") {
          // Clearing the field removes the guard, turning the branch unconditional;
          // an auto-derived label goes with it.
          props.conditionExpression = undefined;
          if (mirrors && curName !== "") props.name = "";
        } else {
          // Store as a FEEL expression, '=' prefixed per Zeebe (Atlas strips it).
          const moddle = modeler.get("moddle");
          const expr = moddle.create("bpmn:FormalExpression", {
            body: raw.startsWith("=") ? raw : "= " + raw,
          });
          expr.$parent = beo;
          props.conditionExpression = expr;
          const plain = raw.replace(/^=\s*/, "");
          if (mirrors && curName !== plain) props.name = plain;
        }
        try { modeling.updateProperties(element, props); } catch { /* stale */ }
      }));
    }

    // A conditional event's FEEL predicate lives on its bpmn:ConditionalEventDefinition as a
    // <condition> FormalExpression body (ADR-0137). Clearing it removes the condition (the
    // compiler then rejects the empty predicate at deploy, surfaced in the Problems panel).
    const fcondition = body.querySelector("#f-condition");
    if (fcondition) {
      fcondition.addEventListener("change", () => savePreservingPanel(() => {
        const ced = conditionalDefOf(element.businessObject);
        if (!ced) return;
        const raw = (fcondition.value || "").trim();
        if (raw === "") {
          try { modeling.updateModdleProperties(element, ced, { condition: undefined }); } catch { /* stale */ }
          return;
        }
        const moddle = modeler.get("moddle");
        const cexpr = moddle.create("bpmn:FormalExpression", { body: raw.startsWith("=") ? raw : "= " + raw });
        cexpr.$parent = ced;
        try { modeling.updateModdleProperties(element, ced, { condition: cexpr }); } catch { /* stale */ }
      }));
    }

    // Upgrade every FEEL field in this panel into a code editor (highlighting +
    // completion + live validation + a Test panel). The textareas keep their
    // identity, so the change-to-save handlers wired above are untouched.
    // Validation compiles the expression against the same engine deploy uses
    // (POST /feel/validate); Test evaluates it (POST /feel/evaluate).
    if (tab === "implement") {
      const feelVars = variablesForCompletion(modeler, element);
      const validate = api ? (expression) => api("POST", "/api/v1/feel/validate", { expression }) : null;
      const evaluate = api ? (expression, variables) => api("POST", "/api/v1/feel/evaluate", { expression, variables }) : null;
      enhanceFeel(body, "#f-expr", feelVars, validate, evaluate);
      enhanceFeel(body, "#f-cond", feelVars, validate, evaluate);
      enhanceFeel(body, "#f-condition", feelVars, validate, evaluate);
      enhanceFeel(body, "#f-corrkey", feelVars, validate, evaluate);
      enhanceScript(body, modeler, api, feelVars);
      // Value-or-expression fields carry a Camunda-style fx toggle: switch them to
      // a FEEL editor and the value is stored '=' prefixed (Zeebe's expression form).
      for (const sel of ["#f-assignee", "#f-groups", "#f-due"]) {
        attachExpressionToggle(body.querySelector(sel), { variables: feelVars, validate });
      }
    }
  }

  modeler.on("selection.changed", (e) => show((e.newSelection || [])[0]));

  // When an input association is freshly drawn (data object → activity), default its
  // target variable to the source object's name, so it compiles and reads the object
  // into a like-named variable without hand-editing (ADR-0059). Deferred so the
  // create command settles first. Output associations need no default: a bare one is
  // a valid state-only transition.
  modeler.on("commandStack.connection.create.postExecuted", (e) => {
    const conn = e.context && e.context.connection;
    const bo = conn && conn.businessObject;
    if (!bo || bo.$type !== "bpmn:DataInputAssociation") return;
    if (bo.assignment && bo.assignment.length) return; // already configured
    const objName = dataRefName(bo.sourceRef);
    if (objName && objName !== "?") setTimeout(() => setAssignment(modeler, conn, bo, "", objName), 0);
  });
  modeler.on("element.changed", (e) => {
    if (suppressRerender) return; // a FEEL-field self-save; keep the panel intact
    const sel = selection.get();
    if (sel[0] && e.element && sel[0].id === e.element.id) show(sel[0]);
  });
  show(null);

  // Returned so a Design/Implement tab switch re-renders the current selection.
  return () => show(selection.get()[0]);
}

// parseStartVariables turns a start-variables textarea value into an instance
// request body, validating client-side so an obvious typo fails before a
// round-trip. Empty input means no variables. Values can be scalars (number,
// string, boolean, null) or structured (objects, arrays) — the server stores
// objects/arrays as canonical JSON under VarJSON (ADR-0037). Throws
// Error(message) on invalid input. Shared by the Modeler's Deploy & run and the
// Live view's Start instance.
export function parseStartVariables(raw) {
  const s = (raw || "").trim();
  if (!s) return {};
  let obj;
  try { obj = JSON.parse(s); }
  catch (e) { throw new Error("not valid JSON: " + e.message); }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error('expected a JSON object, e.g. { "amount": 100, "customer": { "name": "acme" } }');
  }
  return { variables: obj };
}

// typedDeployFieldHTML renders one typed input for a declared start variable,
// prefilled with its default. A boolean is a true/false/— select; a number an
// input[type=number]; a string a text input; a json a textarea upgraded to a
// JSON editor after insertion. Required fields carry data-required so
// readTypedDeployBody can enforce them.
function typedDeployFieldHTML(v) {
  const req = v.required ? ' <span class="req-star" title="required">*</span>' : "";
  const dr = v.required ? ' data-required="1"' : "";
  const cap = `<span>${esc(v.name)} <span class="muted">(${v.type})</span>${req}</span>`;
  let input;
  if (v.type === "boolean") {
    const d = v.default;
    input = `<select class="dv-field" data-name="${esc(v.name)}" data-type="boolean"${dr}>
      <option value=""${d === "" ? " selected" : ""}>—</option>
      <option value="true"${d === "true" ? " selected" : ""}>true</option>
      <option value="false"${d === "false" ? " selected" : ""}>false</option>
    </select>`;
  } else if (v.type === "number") {
    input = `<input type="number" step="any" class="dv-field" data-name="${esc(v.name)}" data-type="number"${dr} value="${esc(v.default)}" placeholder="0"/>`;
  } else if (v.type === "json") {
    // A textarea, upgraded to a JSON editor by wireDeployJSONEditors() after
    // the panel is inserted into the DOM.
    input = `<textarea class="dv-field dv-json" data-name="${esc(v.name)}" data-type="json"${dr} rows="3" spellcheck="false" placeholder='{ "key": "value" }'>${esc(v.default)}</textarea>`;
  } else {
    input = `<input type="text" class="dv-field" data-name="${esc(v.name)}" data-type="string"${dr} value="${esc(v.default)}"/>`;
  }
  return `<label class="field">${cap}${input}</label>`;
}

// startVarsFormHTML is the body of a start-variables panel — the editor's
// Deploy & run and the Live view's Start instance both use it: a typed form when
// the process declares start variables, otherwise a free-form JSON textarea.
// readStartFormBody reads back whichever was rendered.
function startVarsFormHTML(declared) {
  if (!declared.length) {
    return `<label class="field">
      <span>Start variables — optional. A JSON object the instance starts with. Scalar and structured values (objects, arrays) are supported. Leave empty to start with none.</span>
      <textarea class="sv-json" rows="3" spellcheck="false" placeholder='{ "amount": 100, "customer": { "name": "acme", "tags": ["a", "b"] } }'></textarea>
    </label>`;
  }
  return `<p class="muted" style="font-size:12px;margin:0 0 8px">Start variables for this run — declared on the process. Required are marked <span class="req-star">*</span>; leave an optional one blank to omit it.</p>`
    + declared.map(typedDeployFieldHTML).join("");
}

// readStartFormBody turns a rendered start-variables panel into an instance
// request body — parsing the JSON textarea, or coercing the typed fields when a
// declaration produced them. Throws Error(message) on invalid input.
function readStartFormBody(bodyEl) {
  const json = bodyEl.querySelector(".sv-json");
  return json ? parseStartVariables(json.value) : readTypedDeployBody(bodyEl);
}

// readTypedDeployBody turns the typed Deploy form into an instance request body,
// coercing each field to its declared type and enforcing required fields. Empty
// optional fields are omitted. Throws Error(message) on a bad number, invalid
// JSON, or a missing required value.
function readTypedDeployBody(bodyEl) {
  const vars = {};
  const missing = [];
  bodyEl.querySelectorAll(".dv-field").forEach((el) => {
    const { name, type } = el.dataset;
    const raw = el.value.trim();
    if (raw === "") { if (el.dataset.required === "1") missing.push(name); return; }
    if (type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number`);
      vars[name] = n;
    } else if (type === "boolean") {
      vars[name] = raw === "true";
    } else if (type === "json") {
      try {
        vars[name] = JSON.parse(raw);
      } catch (e) {
        throw new Error(`"${name}": invalid JSON — ${e.message}`);
      }
    } else {
      vars[name] = raw;
    }
  });
  if (missing.length) throw new Error(`required: ${missing.join(", ")}`);
  return Object.keys(vars).length ? { variables: vars } : {};
}

// wireDeployJSONEditors upgrades every json-typed textarea (.dv-json) and the
// free-form start-variables textarea (.sv-json) in the given container to a
// professional JSON editor. Called after startVarsFormHTML inserts the panel
// HTML, so the DOM elements exist.
function wireDeployJSONEditors(container) {
  for (const ta of container.querySelectorAll(".dv-json, .sv-json")) {
    attachJSONEditor(ta, { rows: 3 });
  }
}

function wireActions(root, modeler, api, toast, projectId) {
  // Save persists the diagram as a draft (raw XML, no compile), keyed by process
  // id, so incomplete work survives and can be reopened from the Modeler home. A
  // projectId (set when the editor was opened from a project's "Create new") files
  // the draft into that project (ADR-0034).
  const saveBtn = root.querySelector("#save");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const { xml } = await modeler.saveXML({ format: true });
      const path = "/api/v1/drafts" + (projectId ? "?projectId=" + encodeURIComponent(projectId) : "");
      const d = await api("POST", path, xml, true);
      root.querySelector(".crumb-current").textContent = d.name || d.processId || "Draft";
      docTitle(`${d.name || d.processId || "Draft"} · Modeler`);
      toast(`Saved draft “${d.name || d.processId}”`, "ok");
      // Draft is now persisted: clear the collab unsaved-work guard so a co-editor's
      // deferred change (held back to protect these edits) can sync in (ADR-0103).
      if (collab && collab.markSaved) collab.markSaved();
    } catch (e) {
      toast("save failed: " + e.message, "err");
    } finally {
      saveBtn.disabled = false;
    }
  });

  // Auto-layout re-flows the diagram: the current model is sent to the server,
  // which discards its diagram interchange and regenerates a clean left-to-right
  // layout (the same generator that lays out a layout-less deployed model), then
  // the reflowed model is re-imported. Purely a rendering convenience — it moves
  // shapes and edges, never touching the semantic model — so a tangle of a
  // hand-drawn diagram can be straightened out in one click.
  const layoutBtn = root.querySelector("#autolayout");
  layoutBtn.addEventListener("click", async () => {
    layoutBtn.disabled = true;
    try {
      const { xml } = await modeler.saveXML({ format: true });
      const relaid = await api("POST", "/api/v1/layout", xml, true);
      await modeler.importXML(typeof relaid === "string" ? relaid : String(relaid));
      modeler.get("canvas").zoom("fit-viewport");
      toast("Diagram auto-laid out", "ok");
    } catch (e) {
      toast("auto-layout failed: " + e.message, "err");
    } finally {
      layoutBtn.disabled = false;
    }
  });

  // F8 triggers the same auto-layout (the shortcut is otherwise unbound). Captured
  // at the document so it works wherever focus sits in the editor; cleanup() removes
  // it on navigation away. Ignored while a layout is already running or when the
  // user is typing in a field, so it never eats an F8 meant for something else.
  onLayoutKey = (e) => {
    if (e.key !== "F8" || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = document.activeElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    e.preventDefault();
    if (!layoutBtn.disabled) layoutBtn.click();
  };
  document.addEventListener("keydown", onLayoutKey, true);

  root.querySelector("#export").addEventListener("click", async () => {
    try {
      const { xml } = await modeler.saveXML({ format: true });
      const blob = new Blob([xml], { type: "application/xml" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "diagram.bpmn";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast("export failed: " + e.message, "err"); }
  });

  // Documentation (ADR-0138): publish the process as a structured PDF — the
  // diagram plus every element's prose — as an immutable numbered version, and
  // manage the revocable public link that puts a version in front of readers who
  // have no Atlas account. The document is produced here in the browser, where
  // the authoritative picture already lives; the panel is the whole surface.
  const docBtn = root.querySelector("#docexport");
  const docPanel = root.querySelector("#doc-panel");
  const docErr = root.querySelector("#doc-err");
  const docHistory = root.querySelector("#doc-history");
  const docPublish = root.querySelector("#doc-publish");
  const closeDoc = () => { docPanel.hidden = true; docErr.textContent = ""; };

  // renderDocHistory draws one process's published versions, newest first, each
  // with its download and its sharing state. Sharing is per version, so every
  // row carries its own control.
  const renderDocHistory = (versions) => {
    if (!versions.length) {
      docHistory.innerHTML = `<p class="muted doc-empty">No version published yet.</p>`;
      return;
    }
    docHistory.innerHTML = versions.map((v) => {
      const when = v.createdAt ? new Date(v.createdAt * 1000).toLocaleString() : "";
      const by = v.createdBy ? " · " + esc(v.createdBy) : "";
      const note = v.note ? `<div class="doc-note">${esc(v.note)}</div>` : "";
      const share = v.shareUrl
        ? `<a class="doc-link" href="${esc(v.shareUrl)}" target="_blank" rel="noopener">Public link</a>
           <button class="btn neutral small" data-unshare="${esc(v.id)}">Revoke</button>`
        : `<button class="btn neutral small" data-share="${esc(v.id)}">Share…</button>`;
      return `<div class="doc-version">
        <div class="doc-version-head">
          <b>v${v.version}</b>
          <span class="muted">${esc(when)}${by} · ${v.elementCount} elements</span>
        </div>
        ${note}
        <div class="row">
          <a class="doc-link" href="${esc(v.pdfUrl)}" target="_blank" rel="noopener">Open PDF</a>
          ${share}
        </div>
      </div>`;
    }).join("");
  };

  // loadDocHistory reads the history for whatever process the diagram currently
  // declares. A diagram that has never been documented simply has none.
  const loadDocHistory = async () => {
    const collection = collectDocumentation(modeler);
    if (!collection.processId) { docHistory.innerHTML = ""; return; }
    try {
      const versions = await api("GET", `/api/v1/processes/${encodeURIComponent(collection.processId)}/documentation`);
      renderDocHistory(versions || []);
    } catch (e) {
      docHistory.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  };

  const openDoc = async () => {
    docPanel.hidden = false;
    docErr.textContent = "";
    const bo = rootProcess(modeler);
    const titleField = root.querySelector("#doc-title");
    if (!titleField.value) titleField.value = (bo && bo.name) || "";
    docHistory.innerHTML = `<p class="muted doc-empty">Loading…</p>`;
    await loadDocHistory();
  };

  docBtn.addEventListener("click", () => { docPanel.hidden ? openDoc() : closeDoc(); });
  root.querySelector("#doc-cancel").addEventListener("click", closeDoc);

  docPublish.addEventListener("click", async () => {
    docPublish.disabled = true;
    docErr.textContent = "";
    try {
      await exportDocumentation({
        modeler, api,
        title: root.querySelector("#doc-title").value.trim(),
        note: root.querySelector("#doc-note").value.trim(),
      });
      root.querySelector("#doc-note").value = "";
      toast("Documentation version published", "ok");
      await loadDocHistory();
    } catch (e) {
      docErr.textContent = e.message;
    } finally {
      docPublish.disabled = false;
    }
  });

  // Sharing and revoking are delegated: the history is re-rendered on every
  // change, so binding per row would leak listeners.
  docHistory.addEventListener("click", async (e) => {
    const shareId = e.target.getAttribute && e.target.getAttribute("data-share");
    const unshareId = e.target.getAttribute && e.target.getAttribute("data-unshare");
    if (!shareId && !unshareId) return;
    e.target.disabled = true;
    try {
      if (shareId) await api("POST", `/api/v1/documentation/${encodeURIComponent(shareId)}/share`);
      else await api("DELETE", `/api/v1/documentation/${encodeURIComponent(unshareId)}/share`);
      await loadDocHistory();
    } catch (err) {
      docErr.textContent = err.message;
      e.target.disabled = false;
    }
  });

  // Deploy opens a panel that offers two actions: "Deploy only" makes the model
  // runnable without touching the runtime, and "Deploy & run" additionally starts
  // an instance seeded with the entered start variables — the editor's equivalent
  // of the Live view's Start instance. A developer iterating on a model shouldn't
  // be forced to spin up an instance every time they deploy, so the two are split.
  // When the process declares start variables (Process panel → Start variables)
  // the panel shows a typed form built from that declaration; otherwise a
  // free-form JSON textarea. Start variables only apply to "Deploy & run".
  const deployBtn = root.querySelector("#deploy");
  const dpanel = root.querySelector("#deploy-panel");
  const dbody = root.querySelector("#deploy-body");
  const dactions = root.querySelector("#deploy-actions");
  const drun = root.querySelector("#deploy-run");
  const donly = root.querySelector("#deploy-only");
  const derr = root.querySelector("#deploy-err");
  const closeDeploy = () => { dpanel.hidden = true; derr.textContent = ""; };

  // Read the declaration fresh each open — it can change while the editor is up.
  // Reopening after a success also restores the form and its Deploy buttons (the
  // success view replaces them with a link back to Operations).
  const openDeploy = () => {
    const bo = rootProcess(modeler);
    dbody.innerHTML = startVarsFormHTML(bo ? readStartVariables(bo) : []);
    wireDeployJSONEditors(dbody);
    dactions.hidden = false;
    dpanel.hidden = false;
    derr.textContent = "";
    const first = dbody.querySelector(".sv-json, .dv-field");
    if (first) first.focus();
  };

  deployBtn.addEventListener("click", () => { dpanel.hidden ? openDeploy() : closeDeploy(); });
  root.querySelector("#deploy-cancel").addEventListener("click", closeDeploy);

  // resolveInstanceLink returns the Operations deep-link for the instance a
  // Deploy & run just started. A freshly deployed version has exactly one
  // instance, found by its definition key; that key completes the roundtrip so the
  // link lands directly on it. If it can't be resolved (a transient list failure),
  // fall back to the process-level Operations view.
  const resolveInstanceLink = async (defKey) => {
    try {
      const list = await api("GET", "/api/v1/instances");
      const mine = list.filter((r) => r.processDefKey === defKey);
      if (mine.length) {
        const inst = mine.reduce((a, b) => (b.key > a.key ? b : a));
        return `#/operations/p/${defKey}/i/${inst.key}`;
      }
    } catch { /* fall back to the process-level view */ }
    return `#/operations/p/${defKey}`;
  };

  // showDeploySuccess replaces the panel form with a confirmation that carries a
  // link into Operations — the deploy→run→observe roundtrip. `href` targets the
  // started instance (Deploy & run) or the process (Deploy only / collaboration).
  const showDeploySuccess = (message, href) => {
    dactions.hidden = true;
    derr.textContent = "";
    dbody.innerHTML = `<div class="deploy-success">
      <p class="deploy-success-msg">✓ ${esc(message)}</p>
      <div class="row">
        <a class="btn" href="${href}">Open in Operations →</a>
        <button type="button" class="btn neutral" id="deploy-done">Close</button>
      </div>
    </div>`;
    const done = dbody.querySelector("#deploy-done");
    if (done) done.addEventListener("click", closeDeploy);
  };

  // run === true also starts an instance; run === false deploys only. The start
  // form is read (and validated) only when running, so an unrelated JSON typo
  // never blocks a plain deploy.
  const doDeploy = async (run) => {
    let body = {};
    if (run) {
      try {
        body = readStartFormBody(dbody);
      } catch (e) { derr.textContent = e.message; return; }
    }
    drun.disabled = true;
    donly.disabled = true;
    derr.textContent = "";
    try {
      const { xml } = await modeler.saveXML({ format: true });
      // Carry the editor's project so the deployment files under the same folder as
      // its draft on the Modeler home (ADR-0034); omitted when editing outside a
      // project, which deploys to Ungrouped.
      const depPath = "/api/v1/deployments" + (projectId ? "?projectId=" + encodeURIComponent(projectId) : "");
      const dep = await api("POST", depPath, xml, true);
      const all = dep.deployments || [{ key: dep.key, processId: dep.processId, version: dep.version }];
      if (all.length > 1) {
        // A collaboration deploys one definition per pool; which pool to start is
        // ambiguous, so just report what was deployed (start pools from Operations).
        // Start variables don't apply here — there's no single instance to seed.
        const msg = `Deployed ${all.length} pools: ${all.map((d) => d.processId).join(", ")}`;
        toast(msg, "ok");
        showDeploySuccess(msg, "#/operations");
      } else if (run) {
        await api("POST", `/api/v1/processes/${dep.key}/instances`, body);
        const n = body.variables ? Object.keys(body.variables).length : 0;
        const msg = `Deployed ${dep.processId} v${dep.version} and started an instance${n ? ` with ${n} variable${n === 1 ? "" : "s"}` : ""}`;
        toast(msg, "ok");
        showDeploySuccess(msg, await resolveInstanceLink(dep.key));
      } else {
        const msg = `Deployed ${dep.processId} v${dep.version}`;
        toast(msg, "ok");
        showDeploySuccess(msg, `#/operations/p/${dep.key}`);
      }
    } catch (e) {
      // The Atlas compiler rejects elements it can't execute yet — surface that
      // inline in the panel so the entered variables aren't lost.
      derr.textContent = e.message;
    } finally {
      drun.disabled = false;
      donly.disabled = false;
    }
  };

  drun.addEventListener("click", () => doDeploy(true));
  donly.addEventListener("click", () => doDeploy(false));
}

// mountLive renders a deployed process read-only and overlays runtime state,
// polling for updates: elements holding a token right now are green, elements a
// token has only passed through are gray (the history heatmap), each badged with
// its count. This is the differentiator a standalone modeler can't offer — the
// diagram shows where the engine's tokens are now and the distribution of where
// they have flowed, so a finished process still tells its story.
//
// The view is organized around one process: a version picker swaps which deployed
// definition is shown, and an instance picker either aggregates every instance's
// tokens on the diagram or isolates a single one. The selected instance's
// variables are listed below the diagram.
export async function mountLive(root, { api, toast, key, instance }) {
  cleanup();
  const gen = generation; // this mount's token; bail if a newer navigation supersedes it

  // Resolve the process this definition version belongs to, and all its versions,
  // so the version picker can offer them. One /processes call feeds both.
  let procName = `definition ${key}`;
  let versions = []; // [{key, version, name}], newest first
  try {
    const procs = await api("GET", "/api/v1/processes");
    const here = procs.find((x) => x.key === key);
    if (here) {
      procName = here.name || here.processId;
      docTitle(`${procName} · Operations`);
      versions = procs
        .filter((x) => x.processId === here.processId)
        .sort((a, b) => b.version - a.version);
    }
  } catch { /* header/version picker are best-effort */ }
  if (gen !== generation) return; // superseded before we wrote this view's shell

  const versionOptions = versions.length
    ? versions.map((v) =>
        `<option value="${v.key}"${v.key === key ? " selected" : ""}>v${v.version}</option>`).join("")
    : `<option value="${key}" selected>current</option>`;

  root.innerHTML = `
    <div class="editor live">
      <div class="editor-bar">
        <a class="btn neutral" href="#/operations">&larr; Instances</a>
        <span class="crumbs" style="margin-left:8px">Live &middot; <b>${esc(procName)}</b></span>
        <label class="bar-select"><span>Version</span>
          <select id="version-sel">${versionOptions}</select></label>
        <label class="bar-select"><span>Instance</span>
          <select id="instance-sel"><option value="all">All instances</option></select></label>
        <div style="flex:1"></div>
        <a class="btn neutral" id="edit-modeler" href="#/modeler/d/${key}" title="Open this definition in the Modeler">✎ Edit in Modeler</a>
        <button class="btn" id="start">Start instance</button>
        <button class="btn ghost danger" id="cancel-inst" hidden>Cancel instance</button>
        <a class="btn" id="replay-inst" hidden title="Replay this instance step by step">&#9654; Replay</a>
        <a class="btn" id="collab-link" hidden>⇄ Collaboration replay</a>
        <button class="btn neutral" id="refresh">Refresh</button>
        <button class="btn neutral" id="vars-toggle" aria-pressed="true" title="Show or hide the variables panel">Variables</button>
        <span class="pill ok" style="margin-left:8px"><span class="dot"></span><b id="inst-count">0</b>&nbsp;running</span>
        <span class="pill" style="margin-left:8px"><b id="token-count">0</b>&nbsp;tokens total</span>
      </div>
      <div class="start-panel" id="start-panel" hidden>
        <div id="start-body"></div>
        <div class="row">
          <button class="btn" id="start-go">Start instance</button>
          <button class="btn neutral" id="start-cancel">Cancel</button>
          <span class="err" id="start-err"></span>
        </div>
      </div>
      <div class="editor-body">
        <div id="canvas"></div>
        <div class="props-resizer" id="var-resizer" title="Drag to resize the variables panel"></div>
        <aside class="var-panel side" id="var-panel"></aside>
      </div>
      <div class="problems">
        <span class="legend-swatch live"></span> live token
        <span class="legend-swatch history" style="margin-left:12px"></span> passed through
        <span class="badge" style="margin-left:12px">N</span> token count
        <span style="flex:1"></span>
        <span class="muted">Polling every 1.5s</span>
      </div>
    </div>`;

  // Switching version loads a different deployed definition, so re-route to its
  // live view (a full remount — the diagram itself changes).
  root.querySelector("#version-sel").addEventListener("change", (e) => {
    const next = Number(e.target.value);
    if (next && next !== key) location.hash = `#/operations/p/${next}`;
  });

  let lib;
  try {
    lib = await loadBpmn();
  } catch (e) {
    root.querySelector("#canvas").innerHTML = `<div class="coming"><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (gen !== generation) return; // a newer navigation took over while assets loaded

  const viewer = newModeler(lib.BpmnJS, lib.moddle, root.querySelector("#canvas"));
  current = viewer;

  try {
    const xml = await api("GET", `/api/v1/processes/${key}/xml`);
    await viewer.importXML(typeof xml === "string" ? xml : String(xml));
    viewer.get("canvas").zoom("fit-viewport");
    // A pool of a collaboration can jump to the replay view, which shows every
    // pool at once and plays the messages that crossed between them (ADR-0038).
    if (isCollaborationRoot(viewer)) {
      const cl = root.querySelector("#collab-link");
      cl.href = `#/operations/c/${key}`;
      cl.hidden = false;
    }
  } catch (e) {
    root.querySelector("#canvas").innerHTML =
      `<div class="coming"><p>Could not render this model.</p>
       <p class="muted">${esc(e.message)}</p></div>`;
    return;
  }

  const canvas = viewer.get("canvas");
  const overlays = viewer.get("overlays");
  const registry = viewer.get("elementRegistry");
  drawImplBadges(viewer); // show type icons at once, before the first poll lands
  const countEl = root.querySelector("#inst-count");
  const tokenEl = root.querySelector("#token-count");
  const instSel = root.querySelector("#instance-sel");
  const varPanel = root.querySelector("#var-panel");
  let marked = [];
  const jsonCollapsed = new Set(); // JSON variable names collapsed by the operator
  let varsHTML = "";               // last rendered variables markup, to skip no-op rebuilds
  let decisions = [];              // the selected instance's DMN decision evaluations (ADR-0066)
  let curDecs = [];                // the evaluations the decision panel is showing (backs the hover popover)
  let focusEl = null;              // a business rule task the operator is inspecting, or null
  // "all" or an instance key (as a string). A deep-linked instance (Deploy & run's
  // roundtrip link, or a shared URL) preselects that one; refreshInstances falls
  // back to "all" if it no longer exists.
  let selected = instance != null ? String(instance) : "all";
  let instances = [];       // this version's instances, cached for the picker/variables
  let instSig = "";         // signature of the picker's current option set
  let liveTasks = [];       // open user-task jobs for this version, refreshed each poll
  let runningCount = 0;     // active instances of this version (from runtime), may exceed the listed page
  // Bulk-terminate selection over the "All instances" list. selectMode shows a
  // checkbox on each active card; picked holds the ticked instance keys. Above
  // TERMINATE_TYPE_THRESHOLD the confirm modal makes the operator type the count, so a
  // large irreversible terminate can't be a single mis-click.
  let selectMode = false;
  let scopeAllActive = false; // "All active" chose the whole version (filter mode), not a hand-picked set
  const picked = new Set();
  const TERMINATE_TYPE_THRESHOLD = 50;

  // refreshInstances pulls this version's instances and, only when the set of
  // instances (or their state) actually changed, rebuilds the picker — so the
  // operator's current selection isn't reset on every poll. Newest activity first.
  // Scope the fetch to this definition with ?process=: the list endpoint caps
  // active and finished instances independently per call, so a global fetch can
  // truncate this version's lone running instance out of the active page during a
  // flood (its finished instances survive in the separate finished cap), leaving
  // the picker showing only completed ones. Filtering server-side keeps the cap
  // per-definition, so a running instance is never dropped.
  async function refreshInstances() {
    let all;
    try { all = await api("GET", "/api/v1/instances?process=" + encodeURIComponent(key)); }
    catch { return; } // transient; the picker just keeps its current options
    instances = all
      .filter((r) => r.processDefKey === key)
      .sort((a, b) => (a.state === b.state ? b.key - a.key : a.state === "active" ? -1 : 1));
    const sig = instances.map((r) => `${r.key}:${r.state}`).join(",");
    if (sig === instSig) return;
    instSig = sig;
    // Drop a selection that no longer exists (e.g. its definition was deleted).
    if (selected !== "all" && !instances.some((r) => String(r.key) === selected)) selected = "all";
    instSel.innerHTML =
      `<option value="all"${selected === "all" ? " selected" : ""}>All instances (${instances.length})</option>` +
      instances.map((r) =>
        `<option value="${r.key}"${String(r.key) === selected ? " selected" : ""}>${r.key} · ${esc(r.state)}</option>`
      ).join("");
  }

  // JSON variable values are shown with a collapsible preview (first 60 chars)
  // instead of blowing out the chip; hover to see the full value.
  const varChips = (list) => !list || !list.length
    ? '<span class="muted">No variables.</span>'
    : list.map((v) => {
        if (v.kind === "json") {
          const preview = v.value.length > 60 ? v.value.slice(0, 57) + "..." : v.value;
          return `<span class="chip" title="${esc(v.value)}">${esc(v.name)}=<code>${esc(preview)}</code></span>`;
        }
        return `<span class="chip">${esc(v.name)}=${esc(v.value)}</span>`;
      }).join(" ");
  // completedAt is unix nanoseconds; Date wants milliseconds.
  const fmtNano = (ns) => ns ? new Date(ns / 1e6).toLocaleString() : "";

  // fmtDuration renders a nanosecond span as a short human duration (the age of
  // a running instance, or how long a finished one took).
  const fmtDuration = (ns) => {
    if (!ns || ns < 0) return "";
    const ms = ns / 1e6;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
    const d = Math.floor(h / 24), rh = h % 24;
    return rh ? `${d}d ${rh}h` : `${d}d`;
  };

  // instanceMeta renders the operator facts the Operations overview shows beside
  // an instance's variables: when it started, how long it ran (or — for a live
  // one — has been running, filled in by updateElapsed), and the message
  // correlation key it began with. Shared by the single-instance detail and the
  // all-instances overview so both surface the same facts.
  const metaItem = (label, value, title) =>
    `<span class="vp-meta-item" title="${esc(title)}"><span class="vp-meta-k">${esc(label)}</span> ${value}</span>`;
  const instanceMeta = (inst) => {
    const bits = [];
    if (inst.createdAt) {
      bits.push(metaItem("started", esc(fmtNano(inst.createdAt)), "When this instance started"));
      if (inst.completedAt) {
        bits.push(metaItem("took", esc(fmtDuration(inst.completedAt - inst.createdAt)), "How long this instance ran"));
      } else if (inst.state === "active") {
        // The live elapsed is filled by updateElapsed rather than baked into the
        // markup, so a ticking value never forces a panel rebuild (which would
        // reset an expanded JSON card's scroll).
        bits.push(metaItem("running for", `<span class="vp-elapsed" data-created="${inst.createdAt}"></span>`, "How long this instance has been running"));
      }
    }
    if (inst.correlationKey) {
      bits.push(metaItem("correlationKey", `<code>${esc(inst.correlationKey)}</code>`, "The message correlation key this instance started with"));
    }
    return bits.length ? `<div class="vp-meta">${bits.join("")}</div>` : "";
  };

  // updateElapsed fills every live "running for" span from the current clock,
  // outside the varsHTML diff so a ticking duration never forces a rebuild.
  function updateElapsed() {
    const now = Date.now() * 1e6;
    varPanel.querySelectorAll(".vp-elapsed[data-created]").forEach((el) => {
      const created = Number(el.getAttribute("data-created"));
      el.textContent = created ? fmtDuration(now - created) : "";
    });
  }

  // tasksFor returns the open user-task jobs waiting in the given instance, newest
  // first — the "jump to the form" targets for a running instance.
  const tasksFor = (instanceKey) =>
    liveTasks.filter((t) => String(t.processInstanceKey) === String(instanceKey))
      .sort((a, b) => b.key - a.key);

  // renderTaskLinks lists a running instance's active user tasks as one-click links
  // into the Tasks app, landing straight on the task's form (ADR-0028) — so an
  // operator goes from "the token is on this user task" to "work it" without
  // hunting through the inbox.
  function renderTaskLinks(list) {
    if (!list || !list.length) return "";
    return `<div class="vp-tasks">
      <div class="vp-tasks-head">Waiting on ${list.length === 1 ? "a user task" : list.length + " user tasks"}</div>
      ${list.map((t) => `
        <a class="task-link" href="#/tasks/t/${t.key}" title="Open this task's form in the Tasks app">
          <span class="task-link-ic" aria-hidden="true">&#128203;</span>
          <span class="task-link-name">${esc(t.name || t.elementId || ("Task " + t.key))}</span>
          ${t.formId ? '<span class="task-link-tag">form</span>' : ""}
          <span class="task-link-go">Open &#8599;</span>
        </a>`).join("")}
    </div>`;
  }

  // isBusinessRuleTask reports whether a diagram element is a DMN business rule
  // task — the only element for which a decision can be inspected.
  const isBusinessRuleTask = (elementId) => {
    const el = registry.get(elementId);
    return !!(el && el.businessObject && el.businessObject.$type === "bpmn:BusinessRuleTask");
  };

  // decisionLabel names a business rule task for the panel header: its diagram
  // label if it has one, else its id.
  const decisionLabel = (elementId) => {
    const el = registry.get(elementId);
    const bo = el && el.businessObject;
    return (bo && (bo.name || bo.id)) || elementId;
  };

  // renderDecisionDetail is the inspection panel for a clicked business rule task:
  // every evaluation the selected instance made at that task, newest last, rendered
  // in the temis style (input pills, a Rule N badge, and the matched-rule table on
  // hover) — the same surface as the Operations decision views. curDecs backs the
  // hover popover; decisions are per-instance history, so it needs one instance.
  function renderDecisionDetail(elementId) {
    const head = `<div class="vp-head">
      <span class="vp-title">Decision · ${esc(decisionLabel(elementId))}</span>
      <span class="vp-actions"><button class="btn ghost small dec-back" type="button" title="Back to variables">&larr; Variables</button></span>
    </div>`;
    if (selected === "all") {
      curDecs = [];
      return head + `<p class="muted" style="margin:0">Select a single instance (top-left) to see how its decision was made.</p>`;
    }
    const matches = decisions.filter((d) => d.elementId === elementId);
    curDecs = matches;
    if (!matches.length) {
      return head + `<p class="muted" style="margin:0">This instance has not evaluated this decision yet. Its inputs, outputs, and the rules that fired will appear here once a token reaches the task.</p>`;
    }
    return head + matches.map((d, i) => decCard(d, i)).join("");
  }

  // renderVariables shows the selected instance's variables with the shared
  // polished renderer (scalars as fields, JSON as collapsible highlighted cards),
  // or — for "All instances" — a compact per-instance overview table. When the
  // operator is inspecting a business rule task, it shows that decision's evaluation
  // instead (ADR-0066). It rebuilds only when the markup actually changes, so a 1.5s
  // poll never resets an expanded JSON card's scroll or the operator's collapse
  // choices.
  function renderVariables() {
    if (focusEl && isBusinessRuleTask(focusEl)) {
      const decHTML = renderDecisionDetail(focusEl);
      if (decHTML === varsHTML) return;
      varsHTML = decHTML;
      varPanel.innerHTML = decHTML;
      return;
    }
    let html;
    if (selected === "all") {
      // Prune ticks for instances that have since left the active set (finished or
      // gone), so the "Terminate N" count and the request never carry stale keys.
      const activeKeys = new Set(instances.filter((r) => r.state === "active").map((r) => r.key));
      for (const k of [...picked]) if (!activeKeys.has(k)) picked.delete(k);
      const activeInsts = instances.filter((r) => r.state === "active");
      // "Select all active" targets every running instance of this version — including
      // any beyond the listed page — so it uses the runtime count when it is larger.
      const allActive = Math.max(runningCount, activeInsts.length);
      const head = !activeInsts.length
        ? `<div class="vp-head"><span class="vp-title">Variables · all instances (${instances.length})</span></div>`
        : `<div class="vp-head">
            <span class="vp-title">Variables · all instances (${instances.length})</span>
            <span class="vp-actions">${selectMode
              ? (() => {
                  const n = scopeAllActive ? allActive : picked.size;
                  return `<button class="btn danger sm" data-term-go ${n ? "" : "disabled"} title="Terminate the selected instances">Terminate${n ? ` ${n}` : ""}</button>
                 <button class="btn neutral sm${scopeAllActive ? " on" : ""}" data-term-all title="Select every running instance of this version">All active (${allActive})</button>
                 <button class="btn neutral sm" data-term-off>Done</button>`;
                })()
              : `<button class="btn neutral sm" data-term-on title="Select running instances to terminate in bulk">&#9745; Select</button>`}
            </span>
          </div>`;
      html = !instances.length
        ? `<div class="vp-head"><span class="vp-title">Variables</span></div>
          <p class="muted" style="margin:0">No instances yet — start one to see its variables here.</p>`
        : `${head}
        <div class="vp-insts${selectMode ? " picking" : ""}">${instances.map((r) => {
          const ts = tasksFor(r.key);
          const active = r.state === "active";
          const on = scopeAllActive ? active : picked.has(r.key);
          return `<div class="vp-inst${selectMode && on ? " picked" : ""}">
            <div class="vp-inst-head">
              ${selectMode && active
                ? `<label class="vp-pick" title="Select for termination"><input type="checkbox" data-pick="${r.key}"${on ? " checked" : ""}/></label>`
                : ""}
              <b title="Select this instance">${r.key}</b>
              ${active
                ? '<span class="pill ok"><span class="dot"></span>active</span>'
                : `<span class="pill">${esc(r.state)}</span>`}
              <span class="vp-inst-actions">${ts.length
                ? `<a class="task-link inline" href="#/tasks/t/${ts[0].key}" title="Open the waiting task's form">&#128203; Task&#8599;</a>`
                : ""}<a class="replay-link" href="#/operations/i/${r.key}" title="Replay this instance step by step">&#9654; Replay</a></span>
            </div>
            ${instanceMeta(r)}
            <div class="vp-inst-vars">${varChips(r.variables)}</div>
          </div>`;
        }).join("")}</div>`;
    } else {
      const inst = instances.find((r) => String(r.key) === selected);
      if (!inst) {
        html = `<div class="vp-head"><span class="vp-title">Variables</span></div>
          <p class="muted" style="margin:0">Instance no longer available.</p>`;
      } else {
        const when = inst.state === "active" ? "" : fmtNano(inst.completedAt);
        html = `<div class="vp-head">
            <span class="vp-title">Variables · instance ${inst.key}
              ${inst.state === "active"
                ? '<span class="pill ok"><span class="dot"></span>active</span>'
                : `<span class="pill">${esc(inst.state)}</span>${when ? ` <span class="muted">${esc(when)}</span>` : ""}`}</span>
            <span class="vp-actions">${copyAllBtn(inst.variables)}<a class="replay-link" href="#/operations/i/${inst.key}" title="Replay this instance step by step">&#9654; Replay</a></span>
          </div>
          ${instanceMeta(inst)}
          ${renderTaskLinks(tasksFor(inst.key))}
          <div class="vars">${renderVarsBody(inst.variables, jsonCollapsed)}</div>`;
      }
    }
    if (html === varsHTML) { updateElapsed(); return; } // unchanged — keep DOM, just tick the age
    varsHTML = html;
    varPanel.innerHTML = html;
    updateElapsed();
  }

  async function poll() {
    await refreshInstances();
    await refreshTasks();
    await refreshDecisions();
    updateCancelBtn();
    const q = selected === "all" ? "" : `?instance=${encodeURIComponent(selected)}`;
    let rt;
    try { rt = await api("GET", `/api/v1/processes/${key}/runtime${q}`); }
    catch (e) { return; } // transient; try again next tick
    if (current !== viewer) return; // navigated away mid-flight
    overlays.clear();
    drawImplBadges(viewer); // type icons are static; overlays.clear() reaped them
    for (const [id, marker] of marked) canvas.removeMarker(id, marker);
    marked = [];
    // The tasks in scope: a single instance's own, or (for "All instances") every
    // waiting task of this version. Grouped by element so a user-task element in
    // the diagram can be linked straight to its form.
    const scopeTasks = selected === "all"
      ? liveTasks.slice()
      : tasksFor(selected);
    const tasksByElement = new Map();
    for (const t of scopeTasks) {
      if (!t.elementId) continue;
      const arr = tasksByElement.get(t.elementId) || [];
      arr.push(t);
      tasksByElement.set(t.elementId, arr);
    }
    // The business rule tasks the selected instance has already decided — each gets
    // a clickable badge that opens its decision inspection (ADR-0066).
    const decidedEls = new Set(decisions.map((d) => d.elementId));
    // Each element is drawn in one of two states: green if it holds a live token
    // right now, gray if tokens have only passed through it (history). Together
    // they show the flow distribution even once every instance has finished — a
    // gray trail with green where tokens are still alive.
    for (const e of rt.elements) {
      if (!registry.get(e.elementId)) continue;
      const live = e.tokens > 0;
      if (!live && !(e.visits > 0)) continue;
      const marker = live ? "atlas-active" : "atlas-visited";
      canvas.addMarker(e.elementId, marker);
      marked.push([e.elementId, marker]);
      // Two badges per element: how many tokens have already passed through
      // (gray) and how many are live here right now (green). A visit is recorded
      // on activation, so e.visits already counts the live tokens — the number
      // that has moved on is the difference. Gray sits left, green right, reading
      // past → present. Each badge is drawn only when non-zero, so a purely
      // historical element keeps a single gray badge and a just-entered one a
      // single green badge (no "0", never a doubled count).
      const passed = Math.max(0, e.visits - e.tokens);
      const grayBadge = passed > 0
        ? `<div class="token-badge history" title="${passed} token(s) passed through">${passed}</div>`
        : "";
      const greenBadge = e.tokens > 0
        ? `<div class="token-badge" title="${e.tokens} live token(s)">${e.tokens}</div>`
        : "";
      overlays.add(e.elementId, "tokens", {
        position: { bottom: 4, right: 4 },
        html: `<div class="token-badges">${grayBadge}${greenBadge}</div>`,
      });
      // A user-task element with a waiting job gets a clickable "Open" badge that
      // jumps to its form. One waiting task → straight to it; several (only under
      // "All instances") → the inbox, where the operator picks.
      const ets = tasksByElement.get(e.elementId);
      if (ets && ets.length) {
        const href = ets.length === 1 ? `#/tasks/t/${ets[0].key}` : "#/tasks";
        const label = ets.length === 1 ? "Open task" : `${ets.length} tasks`;
        overlays.add(e.elementId, "open-task", {
          position: { top: 4, right: 4 },
          html: `<a class="task-open" href="${href}" title="Open the waiting user task's form">&#128203; ${label}</a>`,
        });
      }
      // A decided business rule task offers a decision-inspection badge.
      if (decidedEls.has(e.elementId)) {
        overlays.add(e.elementId, "decision", {
          position: { top: 4, left: 4 },
          html: `<button class="decision-badge${focusEl === e.elementId ? " on" : ""}" data-el="${esc(e.elementId)}" title="Inspect this decision — inputs, outputs, and how it was decided">&#9878; decision</button>`,
        });
      }
    }
    countEl.textContent = rt.instances;
    tokenEl.textContent = rt.tokens;
    runningCount = rt.instances || 0;
    renderVariables();
  }

  // refreshTasks pulls the open user-task jobs and keeps those for this deployed
  // version. Best-effort: a transient failure leaves the previous set so the links
  // and diagram badges don't flicker.
  async function refreshTasks() {
    let all;
    try { all = await api("GET", "/api/v1/tasks"); }
    catch { return; }
    liveTasks = all.filter((t) => t.processDefKey === key);
  }

  // refreshDecisions pulls the selected instance's DMN decision evaluations so the
  // diagram can badge decided business rule tasks and the inspection panel can show
  // how each decision was made (ADR-0066). Only a single selected instance has a
  // decision history to fetch; "All instances" clears it. Best-effort, like the
  // other polled reads.
  async function refreshDecisions() {
    if (selected === "all") { decisions = []; return; }
    try { decisions = await api("GET", `/api/v1/instances/${selected}/decisions`); }
    catch { /* transient; keep the previous set */ }
  }

  // The Cancel button targets the selected instance; it is shown only when a
  // single, still-active instance is selected (there is nothing to cancel for
  // "All instances" or an already-finished one).
  const cancelBtn = root.querySelector("#cancel-inst");
  const replayBtn = root.querySelector("#replay-inst");
  function updateCancelBtn() {
    const inst = instances.find((r) => String(r.key) === selected);
    cancelBtn.hidden = !(inst && inst.state === "active");
    // Replay is offered for any single selected instance (active or finished): its
    // step timeline drives a play/step/scrub walk through the diagram (ADR-0046).
    if (inst) {
      replayBtn.href = `#/operations/i/${inst.key}`;
      replayBtn.hidden = false;
    } else {
      replayBtn.hidden = true;
    }
  }

  // Selecting an instance isolates it on the diagram; re-poll right away so the
  // overlay and variables switch without waiting for the next tick.
  instSel.addEventListener("change", () => { selected = instSel.value; updateCancelBtn(); poll(); });

  cancelBtn.addEventListener("click", async () => {
    if (selected === "all") return;
    if (!window.confirm(`Cancel (terminate) instance ${selected}? Its token is discarded and it moves to the finished list as "terminated".`)) return;
    cancelBtn.disabled = true;
    try {
      await api("DELETE", `/api/v1/instances/${selected}`);
      toast(`Instance ${selected} terminated`, "ok");
      await refreshInstances();
      await poll();
      updateCancelBtn();
    } catch (e) {
      toast("cancel failed: " + e.message, "err");
    } finally {
      cancelBtn.disabled = false;
    }
  });

  // --- Bulk terminate over the "All instances" list ---
  // Ticking, "All active", and the mode toggles all funnel through one delegated
  // listener on the panel, since its innerHTML is rebuilt every poll.
  varPanel.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-pick]");
    if (!cb) return;
    const k = Number(cb.dataset.pick);
    // A manual tick means the operator is hand-picking, so drop the whole-version
    // scope and fall back to the explicit set (seeding it from what was shown ticked).
    if (scopeAllActive) {
      scopeAllActive = false;
      for (const r of instances) if (r.state === "active") picked.add(r.key);
    }
    if (cb.checked) picked.add(k); else picked.delete(k);
    renderVariables();
  });
  varPanel.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-term-on]")) { selectMode = true; renderVariables(); return; }
    if (t.closest("[data-term-off]")) { selectMode = false; scopeAllActive = false; picked.clear(); renderVariables(); return; }
    if (t.closest("[data-term-all]")) {
      // Toggle whole-version scope; ticks are implied by scopeAllActive, so clear the
      // explicit set to avoid a stale count when it is turned off again.
      scopeAllActive = !scopeAllActive;
      picked.clear();
      renderVariables();
      return;
    }
    if (t.closest("[data-term-go]")) { await runTerminate(); return; }
  });

  // runTerminate confirms, then terminates either the whole version (filter mode,
  // drained in batches while the server reports remaining) or the hand-picked set,
  // and refreshes the view.
  async function runTerminate() {
    const activeInsts = instances.filter((r) => r.state === "active");
    const allActive = Math.max(runningCount, activeInsts.length);
    const count = scopeAllActive ? allActive : picked.size;
    if (!count) return;
    const scopeAll = scopeAllActive;
    if (!(await confirmTerminate(count, scopeAll))) return;
    const btn = varPanel.querySelector("[data-term-go]");
    if (btn) btn.disabled = true;
    try {
      let terminated = 0;
      if (scopeAll) {
        // Drain the whole version in bounded batches (server caps per call).
        for (let guard = 0; guard < 1000; guard++) {
          const res = await api("POST", "/api/v1/instances/terminate", { processDefKey: key });
          terminated += res.terminated || 0;
          if (!res.remaining) break;
        }
      } else {
        const res = await api("POST", "/api/v1/instances/terminate", { keys: [...picked] });
        terminated = res.terminated || 0;
      }
      toast(`Terminated ${terminated} instance${terminated === 1 ? "" : "s"}`, "ok");
      selectMode = false; scopeAllActive = false; picked.clear();
      await refreshInstances();
      await poll();
    } catch (err) {
      toast("terminate failed: " + err.message, "err");
    } finally {
      const b = varPanel.querySelector("[data-term-go]");
      if (b) b.disabled = false;
    }
  }

  // confirmTerminate shows a modal that scales its friction to the blast radius: a
  // plain confirm for a small set, and — above TERMINATE_TYPE_THRESHOLD — a type-the-
  // count gate so a large irreversible terminate can't be a single click. Resolves
  // true only when the operator confirms (and, when gated, typed the exact count).
  function confirmTerminate(count, scopeAll) {
    return new Promise((resolve) => {
      const gated = count > TERMINATE_TYPE_THRESHOLD;
      const ov = document.createElement("div");
      ov.className = "modal-ov";
      const scopeText = scopeAll
        ? `every running instance of this version`
        : `${count} selected instance${count === 1 ? "" : "s"}`;
      ov.innerHTML = `
        <div class="modal confirm-modal" role="dialog" aria-modal="true" aria-label="Confirm termination">
          <div class="modal-head"><h2>Terminate ${count} instance${count === 1 ? "" : "s"}?</h2></div>
          <div class="modal-body">
            <p class="muted" style="margin:0 0 10px">This discards each token and moves ${scopeText} to the finished list as <b>terminated</b>. This can't be undone.</p>
            ${gated ? `<label class="field"><span>Type <b>${count}</b> to confirm</span>
              <input id="term-confirm-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="${count}"/></label>` : ""}
          </div>
          <div class="modal-foot">
            <button class="btn neutral" data-term-cancel>Cancel</button>
            <button class="btn danger" data-term-confirm ${gated ? "disabled" : ""}>Terminate ${count}</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const input = ov.querySelector("#term-confirm-input");
      const confirmBtn = ov.querySelector("[data-term-confirm]");
      const close = (ok) => { ov.remove(); document.removeEventListener("keydown", onKey); resolve(ok); };
      const onKey = (e) => { if (e.key === "Escape") close(false); };
      document.addEventListener("keydown", onKey);
      if (input) {
        input.addEventListener("input", () => { confirmBtn.disabled = input.value.trim() !== String(count); });
        input.focus();
      } else {
        confirmBtn.focus();
      }
      ov.querySelector("[data-term-cancel]").addEventListener("click", () => close(false));
      confirmBtn.addEventListener("click", () => { if (!confirmBtn.disabled) close(true); });
      ov.addEventListener("click", (e) => { if (e.target === ov) close(false); });
    });
  }

  root.querySelector("#refresh").addEventListener("click", poll);
  bindJsonCards(varPanel, jsonCollapsed, renderVariables);
  bindVarCopy(varPanel, toast);
  wireVarsPanel(root, viewer);

  // Decision panel: hovering (or focusing) a result row backed by a decision table
  // reveals that table, matched rule highlighted, in a shared viewport popover — the
  // same interaction as the Operations decision views. The popover lives outside the
  // var panel (which re-renders on poll), so it survives; the delegated listeners are
  // attached once and survive the panel's inner rebuilds.
  const decPop = document.createElement("div");
  decPop.className = "dec-pop";
  decPop.hidden = true;
  root.appendChild(decPop);
  const showDecPop = (row) => {
    const d = curDecs[Number(row.dataset.dec)];
    const tables = d ? decTablesOf(d) : [];
    if (!tables.length) return;
    decPop.innerHTML = `<div class="pop-title">${esc(d.decisionId)}</div>` +
      tables.map((tt, i) => decMiniTable(tt, tables.length > 1 ? i + 1 : 0)).join("");
    decPop.hidden = false;
    const box = row.getBoundingClientRect();
    const top = box.top - decPop.offsetHeight - 10;
    decPop.style.left = Math.max(8, Math.min(box.left, window.innerWidth - decPop.offsetWidth - 8)) + "px";
    decPop.style.top = (top < 8 ? box.bottom + 10 : top) + "px";
  };
  const hideDecPop = () => { decPop.hidden = true; };
  varPanel.addEventListener("pointerover", (e) => {
    const row = e.target.closest(".res-row.hoverable");
    if (row && varPanel.contains(row)) showDecPop(row);
  });
  varPanel.addEventListener("pointerout", (e) => {
    const row = e.target.closest(".res-row.hoverable");
    if (row && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".res-row.hoverable") === row)) hideDecPop();
  });
  varPanel.addEventListener("focusin", (e) => { const row = e.target.closest(".res-row.hoverable"); if (row) showDecPop(row); });
  varPanel.addEventListener("focusout", hideDecPop);

  // Inspecting a decision (ADR-0066): clicking a business rule task on the diagram
  // opens how its decision was made in the side panel (toggle off by clicking it
  // again); clicking any other element leaves the inspection. The ⚖ badge on a
  // decided task is the discoverable affordance for the same thing.
  viewer.on("element.click", ({ element }) => {
    if (element && element.businessObject && element.businessObject.$type === "bpmn:BusinessRuleTask") {
      focusEl = focusEl === element.id ? null : element.id;
      renderVariables();
      poll();
    } else if (focusEl) {
      focusEl = null;
      renderVariables();
    }
  });
  // The ⚖ badge (a diagram overlay) and the panel's "← Variables" button are HTML,
  // so they're wired by delegation on the view root.
  root.addEventListener("click", (ev) => {
    const badge = ev.target.closest(".decision-badge");
    if (badge) {
      ev.preventDefault();
      focusEl = badge.dataset.el;
      renderVariables();
      poll();
      return;
    }
    if (ev.target.closest(".dec-back")) {
      focusEl = null;
      renderVariables();
    }
  });

  // Start a fresh instance of this already-deployed definition. The demo and the
  // Modeler's "Deploy & run" both couple starting to a deployment; this is the
  // path for a model that's already live — start it again straight from its view,
  // optionally seeded with start variables entered in the panel below the toolbar.
  const startBtn = root.querySelector("#start");
  const panel = root.querySelector("#start-panel");
  const startBody = root.querySelector("#start-body");
  const goBtn = root.querySelector("#start-go");
  const errEl = root.querySelector("#start-err");
  const closePanel = () => { panel.hidden = true; errEl.textContent = ""; };

  // When the deployed model declares start variables (atlas:startForm), show the
  // same typed form the Modeler's Deploy & run uses; otherwise a JSON textarea.
  // The declaration is read from the rendered definition, fresh each open.
  const openPanel = () => {
    const bo = rootProcess(viewer);
    startBody.innerHTML = startVarsFormHTML(bo ? readStartVariables(bo) : []);
    wireDeployJSONEditors(startBody);
    panel.hidden = false;
    errEl.textContent = "";
    const first = startBody.querySelector(".sv-json, .dv-field");
    if (first) first.focus();
  };

  startBtn.addEventListener("click", () => { panel.hidden ? openPanel() : closePanel(); });
  root.querySelector("#start-cancel").addEventListener("click", closePanel);

  goBtn.addEventListener("click", async () => {
    let body;
    try { body = readStartFormBody(startBody); }
    catch (e) { errEl.textContent = e.message; return; }
    goBtn.disabled = true;
    try {
      await api("POST", `/api/v1/processes/${key}/instances`, body);
      const n = body.variables ? Object.keys(body.variables).length : 0;
      toast(n ? `Started a new instance with ${n} variable${n === 1 ? "" : "s"}` : "Started a new instance", "ok");
      closePanel();
      await poll();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      goBtn.disabled = false;
    }
  });

  await poll();
  liveTimer = setInterval(poll, 1500);
}

// sleep resolves after ms milliseconds (the pause between replayed messages).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// runDotAnimation moves an envelope dot along a message-flow edge's waypoints over
// dur ms, in a dedicated SVG layer above the diagram (diagram coordinates, so it
// tracks pan/zoom). cancelled() lets the caller abort mid-flight (navigation or a
// superseding animation). Resolves when the dot reaches the target or is cancelled.
function runDotAnimation(layer, waypoints, dur, cancelled) {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  const halo = document.createElementNS(NS, "circle");
  halo.setAttribute("r", "11"); halo.setAttribute("class", "atlas-msg-halo");
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("r", "6"); dot.setAttribute("class", "atlas-msg-dot");
  g.appendChild(halo); g.appendChild(dot);
  layer.appendChild(g);

  const segs = [];
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len });
    total += len;
  }
  return new Promise((resolve) => {
    let start = null;
    function frame(ts) {
      if (start == null) start = ts;
      const t = total ? Math.min(1, (ts - start) / dur) : 1;
      let d = t * total, x = waypoints[0].x, y = waypoints[0].y;
      for (const s of segs) {
        if (d <= s.len || s === segs[segs.length - 1]) {
          const k = s.len ? Math.min(1, d / s.len) : 1;
          x = s.a.x + (s.b.x - s.a.x) * k;
          y = s.a.y + (s.b.y - s.a.y) * k;
          break;
        }
        d -= s.len;
      }
      g.setAttribute("transform", `translate(${x} ${y})`);
      if (t < 1 && !cancelled()) {
        requestAnimationFrame(frame);
      } else {
        g.remove();
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

// mountCollaboration renders a whole collaboration read-only and replays the
// messages that flowed between its pools (ADR-0038). The shared diagram shows
// every pool at once; a merged token overlay (green live, gray visited) is polled
// like the single-process live view, and a transport bar plays the message-flow
// timeline — each delivery animates an envelope dot along its message-flow edge in
// the order it actually happened, so a finished collaboration replays its exchange.
export async function mountCollaboration(root, { api, toast, key }) {
  cleanup();
  const gen = generation; // this mount's token; bail if a newer navigation supersedes it

  root.innerHTML = `
    <div class="editor live">
      <div class="editor-bar">
        <a class="btn neutral" href="#/operations">&larr; Instances</a>
        <span class="crumbs" style="margin-left:8px">Replay &middot; <b id="collab-title">Collaboration</b></span>
        <div style="flex:1"></div>
        <button class="btn neutral" id="refresh">Refresh</button>
        <span class="pill ok" style="margin-left:8px"><span class="dot"></span><b id="inst-count">0</b>&nbsp;running</span>
        <span class="pill" style="margin-left:8px"><b id="flow-count">0</b>&nbsp;messages</span>
      </div>
      <div class="replay-bar">
        <button class="btn play" id="play">&#9654; Play</button>
        <button class="btn neutral" id="step-back" title="Previous message">&#9198;</button>
        <button class="btn neutral" id="step-fwd" title="Next message">&#9197;</button>
        <input type="range" id="scrub" min="0" max="0" value="0" step="1" aria-label="Message timeline"/>
        <label class="bar-select"><span>Speed</span>
          <select id="speed" class="speed">
            <option value="1">1&times;</option>
            <option value="2">2&times;</option>
            <option value="0.5">0.5&times;</option>
          </select></label>
        <span class="clock" id="clock">no messages yet</span>
      </div>
      <div class="editor-body"><div id="canvas"></div></div>
      <div class="flow-log" id="flow-log"></div>
      <div class="problems">
        <span class="legend-swatch live"></span> live token
        <span class="legend-swatch history" style="margin-left:12px"></span> passed through
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--accent);margin:0 4px 0 12px;vertical-align:middle"></span> message flow
        <span style="flex:1"></span>
        <span class="muted">Live tokens poll every 1.5s</span>
      </div>
    </div>`;

  let lib;
  try {
    lib = await loadBpmn();
  } catch (e) {
    root.querySelector("#canvas").innerHTML = `<div class="coming"><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (gen !== generation) return; // a newer navigation took over while assets loaded

  const viewer = newModeler(lib.BpmnJS, lib.moddle, root.querySelector("#canvas"));
  current = viewer;

  try {
    const xml = await api("GET", `/api/v1/processes/${key}/xml`);
    await viewer.importXML(typeof xml === "string" ? xml : String(xml));
    viewer.get("canvas").zoom("fit-viewport");
  } catch (e) {
    root.querySelector("#canvas").innerHTML =
      `<div class="coming"><p>Could not render this collaboration.</p>
       <p class="muted">${esc(e.message)}</p></div>`;
    return;
  }

  const canvas = viewer.get("canvas");
  const registry = viewer.get("elementRegistry");
  drawImplBadges(viewer); // static type icons; this view never clears overlays
  const layer = canvas.getLayer("atlas-replay", 900); // message dots ride above the diagram
  const titleEl = root.querySelector("#collab-title");
  const instEl = root.querySelector("#inst-count");
  const flowCountEl = root.querySelector("#flow-count");
  const clockEl = root.querySelector("#clock");
  const scrub = root.querySelector("#scrub");
  const playBtn = root.querySelector("#play");
  const logEl = root.querySelector("#flow-log");
  const speedSel = root.querySelector("#speed");

  let flows = [];    // message-flow timeline, oldest first
  let marked = [];   // token markers to clear on the next poll
  let playing = false;
  let playhead = 0;  // number of messages delivered so far (0..flows.length)
  let animToken = 0; // bumped to supersede an in-flight animation

  const speed = () => Number(speedSel.value) || 1;
  const fmtClock = (ns) => (ns ? new Date(ns / 1e6).toLocaleTimeString() : "");

  function receiverLabel(f) {
    const el = registry.get(f.receiverElementId);
    const bo = el && el.businessObject;
    return (bo && (bo.name || bo.id)) || f.receiverElementId || "?";
  }

  function updateClock() {
    if (!flows.length) { clockEl.textContent = "no messages yet"; return; }
    const shown = Math.min(playhead, flows.length);
    clockEl.textContent = `${shown} / ${flows.length}${shown ? ` · ${fmtClock(flows[shown - 1].at)}` : ""}`;
  }

  function highlightCurrent() {
    logEl.querySelectorAll("tr[data-i]").forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.classList.toggle("done", i < playhead);
      tr.classList.toggle("pending", i >= playhead);
      tr.classList.toggle("cur", i === playhead - 1);
    });
    const cur = logEl.querySelector("tr.cur");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function setPlayhead(n) {
    playhead = Math.max(0, Math.min(flows.length, n));
    scrub.value = String(playhead);
    updateClock();
    highlightCurrent();
  }

  function renderLog() {
    if (!flows.length) {
      logEl.innerHTML = `<div class="fl-head">Messages</div>
        <div class="empty">No messages have flowed between the pools yet. Start an instance from a
        pool's live view, then come back to replay the exchange.</div>`;
      return;
    }
    const rows = flows.map((f, i) => `
      <tr data-i="${i}">
        <td class="tnum">${fmtClock(f.at)}</td>
        <td><span class="msg-name">${esc(f.messageName)}</span>${f.correlationKey
          ? ` <span class="muted">· ${esc(f.correlationKey)}</span>` : ""}</td>
        <td class="muted"><span class="arrow">&rarr;</span>${esc(receiverLabel(f))}</td>
      </tr>`).join("");
    logEl.innerHTML = `<div class="fl-head">Messages <span class="muted">· ${flows.length}</span></div>
      <table><tbody>${rows}</tbody></table>`;
    logEl.querySelectorAll("tr[data-i]").forEach((tr) => tr.addEventListener("click", () => {
      const i = Number(tr.dataset.i);
      pause();
      setPlayhead(i + 1);
      animateFlow(flows[i]);
    }));
    highlightCurrent();
  }

  // messageFlowTo finds the message-flow connection whose target is the receiving
  // element, so a delivery can be animated along the edge the modeler drew.
  function messageFlowTo(receiverId) {
    let found = null;
    registry.forEach((el) => {
      if (found) return;
      const bo = el.businessObject;
      if (bo && bo.$type === "bpmn:MessageFlow" && bo.targetRef && bo.targetRef.id === receiverId) found = el;
    });
    return found;
  }

  // animateFlow plays one delivery: the receiving element pulses, and if the
  // message-flow edge exists the envelope dot travels along it. Resolves when done.
  function animateFlow(f) {
    if (!f || current !== viewer) return Promise.resolve();
    if (registry.get(f.receiverElementId)) {
      canvas.addMarker(f.receiverElementId, "atlas-flow-hit");
      setTimeout(() => { try { canvas.removeMarker(f.receiverElementId, "atlas-flow-hit"); } catch { /* gone */ } }, 700);
    }
    const conn = messageFlowTo(f.receiverElementId);
    if (!conn || !conn.waypoints || conn.waypoints.length < 2) return Promise.resolve();
    canvas.addMarker(conn.id, "atlas-flow-active");
    const wps = conn.waypoints.map((w) => ({ x: w.x, y: w.y }));
    const token = ++animToken;
    return runDotAnimation(layer, wps, 900 / speed(), () => current !== viewer || token !== animToken)
      .finally(() => { try { canvas.removeMarker(conn.id, "atlas-flow-active"); } catch { /* gone */ } });
  }

  function pause() { playing = false; playBtn.innerHTML = "&#9654; Play"; }

  async function play() {
    if (!flows.length) return;
    if (playhead >= flows.length) setPlayhead(0); // wrap to replay from the start
    playing = true;
    playBtn.innerHTML = "&#9208; Pause";
    while (playing && current === viewer && playhead < flows.length) {
      const f = flows[playhead];
      setPlayhead(playhead + 1);
      await animateFlow(f);
      if (!playing || current !== viewer) break;
      // Pause between messages, scaled to the real gap (clamped) and the speed.
      const gap = playhead < flows.length
        ? Math.min(1200, Math.max(150, (flows[playhead].at - f.at) / 1e6))
        : 0;
      await sleep(gap / speed());
    }
    pause();
  }

  async function poll() {
    let rt;
    try { rt = await api("GET", `/api/v1/collaborations/${key}/runtime`); }
    catch { return; } // transient; try again next tick
    if (current !== viewer) return;
    if (rt.pools && rt.pools.length) {
      titleEl.textContent = rt.pools.map((p) => p.name || p.processId).join(" ⇄ ");
    }
    instEl.textContent = rt.instances;
    // Merged token overlay across all pools: green where a token is now, gray where
    // one has passed through — the same two-state heatmap the live view draws.
    for (const [id, m] of marked) canvas.removeMarker(id, m);
    marked = [];
    for (const e of rt.elements || []) {
      if (!registry.get(e.elementId)) continue;
      const live = e.tokens > 0;
      if (!live && !(e.visits > 0)) continue;
      const marker = live ? "atlas-active" : "atlas-visited";
      canvas.addMarker(e.elementId, marker);
      marked.push([e.elementId, marker]);
    }
    // Rebuild the timeline only when the message set grows, so a poll never
    // disturbs the operator's current scrub position mid-replay.
    const next = rt.messageFlows || [];
    if (next.length !== flows.length) {
      const wasAtEnd = playhead >= flows.length;
      flows = next;
      flowCountEl.textContent = String(flows.length);
      scrub.max = String(flows.length);
      renderLog();
      if (!playing && wasAtEnd) setPlayhead(flows.length); // follow new messages live
      else { scrub.value = String(playhead); updateClock(); highlightCurrent(); }
    }
  }

  playBtn.addEventListener("click", () => { playing ? pause() : play(); });
  root.querySelector("#step-fwd").addEventListener("click", () => {
    pause();
    if (playhead < flows.length) { const f = flows[playhead]; setPlayhead(playhead + 1); animateFlow(f); }
  });
  root.querySelector("#step-back").addEventListener("click", () => { pause(); setPlayhead(playhead - 1); });
  scrub.addEventListener("input", () => { pause(); setPlayhead(Number(scrub.value)); });
  root.querySelector("#refresh").addEventListener("click", poll);

  await poll();
  liveTimer = setInterval(poll, 1500);
}

// mountTaskProcess renders a compact, read-only process view for a single instance,
// meant to sit inside the Tasks detail pane so a task assignee can see, at a glance,
// what has already run and what is still ahead. It overlays the instance's progress
// on the definition diagram: elements walked so far are grayed (atlas-visited), live
// tokens are highlighted (atlas-active / atlas-token-waiting), and the task's own
// element is outlined in blue (atlas-selected) as "you are here". Unlike the full
// Operations replay it is a static snapshot with no transport bar, and — crucially —
// it owns its own viewer and does NOT touch the shared navigation lifecycle
// (cleanup/current/generation), so it can live alongside the Tasks view. Returns a
// handle with destroy(); the caller tears it down when the selection changes.
export async function mountTaskProcess(container, { api, instanceKey, activeElementId }) {
  let viewer = null;
  let destroyed = false;
  const handle = {
    destroy() {
      destroyed = true;
      if (viewer) { try { viewer.destroy(); } catch { /* already gone */ } viewer = null; }
    },
  };
  const fail = (msg) => { if (!destroyed && container) container.innerHTML = `<p class="tp-msg muted">${esc(msg)}</p>`; };

  let lib;
  try { lib = await loadBpmn(); } catch (e) { fail("Could not load the diagram viewer: " + e.message); return handle; }
  if (destroyed) return handle;

  // The timeline resolves the instance's definition (for the diagram) and carries
  // its progress (steps walked + the current token frame).
  let tl;
  try { tl = await api("GET", `/api/v1/instances/${instanceKey}/timeline`); }
  catch (e) { fail("Could not load the process progress: " + e.message); return handle; }
  if (destroyed) return handle;
  if (!tl || !tl.processDefKey) { fail("No process diagram is available for this task."); return handle; }

  container.innerHTML = "";
  viewer = newModeler(lib.BpmnJS, lib.moddle, container);
  try {
    const xml = await api("GET", `/api/v1/processes/${tl.processDefKey}/xml`);
    if (destroyed) return handle;
    await viewer.importXML(typeof xml === "string" ? xml : String(xml));
    viewer.get("canvas").zoom("fit-viewport");
  } catch (e) {
    if (destroyed) return handle;
    fail("Could not render the process diagram: " + e.message);
    return handle;
  }
  if (destroyed) return handle;

  const canvas = viewer.get("canvas");
  const registry = viewer.get("elementRegistry");
  try { drawImplBadges(viewer); } catch { /* best-effort type icons */ }

  const frames = tl.frames || [];
  const steps = tl.steps || [];
  const tokens = frames.length ? (frames[frames.length - 1].tokens || []) : [];
  const liveOn = new Set(tokens.map((t) => t.elementId));
  // Everything walked so far, grayed — except where a token lives now (that must
  // read as active, not history) and the task's own element (shown as "you are here").
  for (const s of steps) {
    if (!s.elementId || liveOn.has(s.elementId) || s.elementId === activeElementId) continue;
    if (registry.get(s.elementId)) canvas.addMarker(s.elementId, "atlas-visited");
  }
  // Live tokens on other branches, highlighted green (or orange while waiting at a join).
  for (const token of tokens) {
    if (token.elementId === activeElementId || !registry.get(token.elementId)) continue;
    canvas.addMarker(token.elementId, token.state === "waiting" ? "atlas-token-waiting" : "atlas-active");
  }
  // The task's own element: "you are here".
  if (activeElementId && registry.get(activeElementId)) canvas.addMarker(activeElementId, "atlas-selected");
  return handle;
}

// mountInstanceReplay renders one process instance read-only and replays it step
// by step (ADR-0046), in a Camunda-Operate-style layout: a metadata header, the
// definition diagram with per-element execution-count badges and a play/step/scrub
// transport that walks the tokens through the elements in activation order, an
// instance-history tree, and a tabbed inspector (Details / Variables) for the
// element the operator selects. Selecting an element in the diagram or the history
// cross-highlights both and shows that element instance's facts and the variables
// as they stood when it activated. The timeline is polled so a still-running
// instance keeps gaining steps live.
export async function mountInstanceReplay(root, { api, toast, key }) {
  cleanup();
  const gen = generation; // this mount's token; bail if a newer navigation supersedes it

  root.innerHTML = `
    <div class="editor live ops-replay">
      <div class="ops-meta">
        <span class="ops-title"><span class="ops-status" id="rp-status">&#9679;</span> <b id="rp-title">Instance ${esc(String(key))}</b></span>
        <div class="ops-fields">
          <div><label>Process Instance Key</label><span id="m-key" class="mono">${esc(String(key))}</span></div>
          <div><label>Version</label><span id="m-version">&mdash;</span></div>
          <div id="m-vtag-wrap" hidden><label>Version tag</label><span id="m-vtag" class="ver-tag"></span></div>
          <div><label>Start Date</label><span id="m-start">&mdash;</span></div>
          <div><label>End Date</label><span id="m-end">&mdash;</span></div>
          <div><label>State</label><span class="pill" id="rp-state">&mdash;</span></div>
        </div>
        <div style="flex:1"></div>
        <a class="btn neutral" id="rp-live" title="Open this instance's live view">Live view</a>
        <a class="btn neutral" id="rp-instances" href="#/operations" title="Back to this process's instances">&larr; Instances</a>
      </div>
      <div class="replay-bar">
        <button class="btn play" id="play">&#9654; Play</button>
        <button class="btn neutral" id="step-back" title="Previous step">&#9198;</button>
        <button class="btn neutral" id="step-fwd" title="Next step">&#9197;</button>
        <input type="range" id="scrub" min="0" max="0" value="0" step="1" aria-label="Replay frames"/>
        <label class="bar-select"><span>Speed</span>
          <select id="speed" class="speed">
            <option value="1">1&times;</option>
            <option value="2">2&times;</option>
            <option value="0.5">0.5&times;</option>
          </select></label>
        <span class="clock" id="clock">no steps yet</span>
      </div>
      <div class="editor-body"><div id="canvas"></div></div>
      <div class="token-legend" id="token-legend" aria-label="Active replay tokens"></div>
      <div class="ops-resizer" id="ops-resizer" title="Drag to resize · double-click to reset" role="separator" aria-orientation="horizontal" tabindex="0"></div>
      <div class="ops-split" id="ops-split">
        <div class="ops-history" id="rp-history">
          <div class="ops-panel-head">Instance History
            <label class="ops-toggle"><input type="checkbox" id="tg-end"> End date</label>
          </div>
          <div class="ops-history-list" id="history-list"></div>
        </div>
        <div class="ops-detail">
          <div class="ops-tabs" id="rp-tabs">
            <button data-tab="details" class="active">Details</button>
            <button data-tab="variables">Variables</button>
            <button data-tab="decisions">Decisions</button>
          </div>
          <div class="ops-tab-body" id="tab-details"></div>
          <div class="ops-tab-body" id="tab-variables" hidden></div>
          <div class="ops-tab-body" id="tab-decisions" hidden></div>
        </div>
      </div>
      <div class="var-modal-ov" id="var-modal-ov" hidden>
        <div class="var-modal" role="dialog" aria-modal="true" aria-labelledby="var-modal-title">
          <div class="var-modal-head">
            <span class="var-modal-title mono" id="var-modal-title"></span>
            <span class="vtag obj" id="var-modal-tag"></span>
            <span style="flex:1"></span>
            <button class="btn ghost small vcopy vcopy-all" id="var-modal-copy" type="button" data-copy="">Copy JSON</button>
            <button class="icon-btn" id="var-modal-x" type="button" title="Close" aria-label="Close">✕</button>
          </div>
          <div class="var-modal-body"><pre class="vj-body" id="var-modal-body"></pre></div>
        </div>
      </div>
      <div class="dec-pop" id="dec-pop" hidden></div>
    </div>`;

  let lib;
  try {
    lib = await loadBpmn();
  } catch (e) {
    root.querySelector("#canvas").innerHTML = `<div class="coming"><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (gen !== generation) return; // a newer navigation took over while assets loaded

  // The timeline resolves the instance's definition, which the diagram renders.
  let tl;
  try {
    tl = await api("GET", `/api/v1/instances/${key}/timeline`);
  } catch (e) {
    root.querySelector("#canvas").innerHTML =
      `<div class="coming"><p>Could not load this instance's replay.</p>
       <p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  // Superseded while the timeline was in flight — do NOT build a viewer or touch
  // the DOM, which now belongs to the newer mount.
  if (gen !== generation) return;
  root.querySelector("#rp-live").href = `#/operations/p/${tl.processDefKey}/i/${key}`;
  // Return to this process's instance view — the Live view the replay was opened from —
  // rather than all the way to the top-level Instances list (still one click away in the
  // nav bar). Deep-linking straight to a replay lands there too, on the instance's process.
  root.querySelector("#rp-instances").href = `#/operations/p/${tl.processDefKey}`;

  const viewer = newModeler(lib.BpmnJS, lib.moddle, root.querySelector("#canvas"));
  current = viewer;

  try {
    const xml = await api("GET", `/api/v1/processes/${tl.processDefKey}/xml`);
    await viewer.importXML(typeof xml === "string" ? xml : String(xml));
    viewer.get("canvas").zoom("fit-viewport");
  } catch (e) {
    // A newer navigation destroyed this viewer mid-import; the error is expected
    // and the #canvas now belongs to that mount, so leave it untouched.
    if (gen !== generation) return;
    root.querySelector("#canvas").innerHTML =
      `<div class="coming"><p>Could not render this instance's diagram.</p>
       <p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  if (gen !== generation) return; // superseded while the diagram imported

  const canvas = viewer.get("canvas");
  const registry = viewer.get("elementRegistry");
  const overlays = viewer.get("overlays");
  drawImplBadges(viewer); // static type icons; only the count badges are re-drawn
  const eventBus = viewer.get("eventBus");
  const layer = canvas.getLayer("atlas-replay", 900); // moving token dot rides above the diagram
  const dotLayer = canvas.getLayer("atlas-tokens", 899); // static per-frame token dots
  const titleEl = root.querySelector("#rp-title");
  const statusEl = root.querySelector("#rp-status");
  const stateEl = root.querySelector("#rp-state");
  const clockEl = root.querySelector("#clock");
  const scrub = root.querySelector("#scrub");
  const playBtn = root.querySelector("#play");
  const historyEl = root.querySelector("#history-list");
  const detailEl = root.querySelector("#tab-details");
  const varsEl = root.querySelector("#tab-variables");
  const decEl = root.querySelector("#tab-decisions");
  const decPop = root.querySelector("#dec-pop");
  const speedSel = root.querySelector("#speed");

  let steps = [];    // element-activation audit timeline, oldest first
  let frames = [];   // complete logical token states, oldest first
  let marked = [];   // element markers to clear on the next render
  let badges = [];   // overlay ids for the execution-count badges
  let visits = {};   // elementId → cumulative execution count (the badge number)
  let selEik = 0;    // selected element-instance key (0 = none / process root)
  let selElId = "";  // selected diagram element id (may cover several instances)
  let activeTab = "details";
  let showEnd = false; // history shows end date instead of start date
  let playing = false;
  let playhead = 0;  // number of frames walked so far (0..frames.length)
  let animToken = 0; // bumped to supersede an in-flight animation
  let decisions = [];    // this instance's DMN decision evaluations (ADR-0066)
  let curDecs = [];      // the evaluations the Decisions tab is currently showing (backs the hover popover)
  let varFilter = "";    // Variables-tab name filter (persists across scrubs)
  let curVarList = [];   // the variable set the Variables tab is currently showing
  let varsBuilt = false; // the Variables tab's stable shell (toolbar + table) is mounted

  const speed = () => Number(speedSel.value) || 1;
  const tokenColors = ["#0072b2", "#d55e00", "#009e73", "#cc79a7", "#e69f00", "#56b4e9"];
  const tokenColor = (id) => tokenColors[Number(BigInt(String(id || 0)) % BigInt(tokenColors.length))];
  const fmtClock = (ns) => (ns ? new Date(ns / 1e6).toLocaleTimeString() : "");
  const fmtDateTime = (ns) => {
    if (!ns) return "—";
    const d = new Date(ns / 1e6);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  function stepLabel(s) {
    const el = registry.get(s.elementId);
    const bo = el && el.businessObject;
    return (bo && (bo.name || bo.id)) || s.elementId || "?";
  }
  // A short human label for a compiled node type ("bpmn:ServiceTask" → "Service task").
  function typeLabel(t) {
    const bare = String(t || "").replace(/^bpmn:/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
    return bare ? bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase() : "";
  }

  // drawBadges overlays each executed element with its cumulative execution count
  // (ADR-0022 visit history), like Operate's numbered badges. Data comes from the
  // per-instance runtime endpoint; a still-running instance's counts grow on poll.
  function drawBadges() {
    for (const id of badges) { try { overlays.remove(id); } catch { /* gone */ } }
    badges = [];
    for (const [elId, count] of Object.entries(visits)) {
      if (!count || !registry.get(elId)) continue;
      try {
        badges.push(overlays.add(elId, { position: { top: -12, right: 12 }, html: `<span class="ops-badge">${count}</span>` }));
      } catch { /* element not in this diagram */ }
    }
  }

  async function loadBadges() {
    let rt;
    try { rt = await api("GET", `/api/v1/processes/${tl.processDefKey}/runtime?instance=${key}`); }
    catch { return; }
    if (current !== viewer) return;
    const next = {};
    for (const e of rt.elements || []) if (e.visits > 0) next[e.elementId] = e.visits;
    visits = next;
    drawBadges();
  }

  // stepsForElement returns every recorded activation of one diagram element, in
  // order (a looped or multi-instance element appears more than once).
  const stepsForElement = (elId) => steps.filter((s) => s.elementId === elId);
  const stepByEik = (eik) => steps.find((s) => s.elementInstanceKey === eik) || null;

  // drawCallActivityLinks puts a transparent, clickable hotspot directly over each
  // call activity's "+" marker (bpmn-js draws it at the shape's bottom centre) whose
  // child instance is known, so a single click on the marker itself jumps into the
  // child's replay (same window) — no extra badge, the marker is the target. It
  // complements the Details panel's link and is rebuilt whenever the step set grows.
  // One hotspot per element (the first child); a multi-instance call activity's
  // per-iteration children are reachable by selecting each iteration in the history.
  const caLinkIds = [];
  function drawCallActivityLinks() {
    for (const id of caLinkIds.splice(0)) { try { overlays.remove(id); } catch { /* gone */ } }
    const seen = new Set();
    for (const s of steps) {
      if (!s.childInstanceKey || seen.has(s.elementId)) continue;
      seen.add(s.elementId);
      const el = registry.get(s.elementId);
      if (!el) continue; // element not on this diagram
      // Centre a small hotspot (sized in CSS) horizontally on the bottom marker.
      const left = Math.max(0, Math.round((el.width || 100) / 2) - 11);
      caLinkIds.push(overlays.add(s.elementId, "atlas-callchild", {
        position: { bottom: 1, left },
        html: `<a class="ca-child-hotspot" href="#/operations/i/${s.childInstanceKey}" title="Open the called process's instance replay" aria-label="Open the called process"></a>`,
      }));
    }
  }

  // renderDetail fills the Details tab for the selected element instance (or the
  // process instance when nothing is selected), mirroring Operate's element panel.
  function renderDetail() {
    if (!selEik) {
      detailEl.innerHTML = `<dl class="ops-props">
        <dt>Process</dt><dd>${esc(titleEl.textContent)}</dd>
        <dt>Instance Key</dt><dd class="mono">${esc(String(key))}</dd>
        <dt>State</dt><dd>${esc(stateEl.textContent)}</dd>
        <dt>Elements executed</dt><dd>${steps.length}</dd>
        <dt class="hint" colspan>Select an element in the diagram or the history to inspect it.</dt>
      </dl>`;
      return;
    }
    const s = stepByEik(selEik);
    if (!s) { detailEl.innerHTML = `<p class="ops-empty">No details for this element.</p>`; return; }
    const rel = s.relation ? `<dt>Concurrency</dt><dd>${s.relation === "fork" ? "Parallel branch (fork)" : "Join arrival"}</dd>` : "";
    const from = s.sourceElementId ? `<dt>Entered from</dt><dd>${esc(stepLabel({ elementId: s.sourceElementId }))}</dd>` : "";
    // A call activity links to the child instance it started (ADR-0076), so an
    // operator drills from caller to child in one click, same window.
    const child = s.childInstanceKey
      ? `<dt>Called process</dt><dd><a class="ca-child-link" href="#/operations/i/${s.childInstanceKey}" title="Open the called process's instance replay">&#8627; Instance ${esc(String(s.childInstanceKey))}</a></dd>`
      : "";
    detailEl.innerHTML = `<dl class="ops-props">
      <dt>Element</dt><dd>${esc(stepLabel(s))}</dd>
      <dt>Type</dt><dd>${esc(typeLabel(s.type))}</dd>
      <dt>Element ID</dt><dd class="mono">${esc(s.elementId)}</dd>
      <dt>Element Instance Key</dt><dd class="mono">${esc(String(s.elementInstanceKey || "—"))}</dd>
      <dt>Token</dt><dd class="mono">${s.tokenId ? esc(String(s.tokenId)) : "—"}</dd>
      <dt>Start Date</dt><dd>${esc(fmtDateTime(s.at))}</dd>
      <dt>End Date</dt><dd>${s.endAt ? esc(fmtDateTime(s.endAt)) : '<span class="ops-live">active</span>'}</dd>
      ${from}${rel}${child}
    </dl>`;
  }

  // A JSON variable's stored value is a JSON string; these read its shape without
  // throwing. isComplexVar tells the structures (objects/arrays, shown behind a
  // modal) from the scalars shown inline in the table.
  const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  const isComplexVar = (v) => {
    if (v.kind !== "json") return false;
    const parsed = parseJson(v.value);
    return parsed !== null && typeof parsed === "object";
  };
  const jsonTypeLabel = (text) => (Array.isArray(parseJson(text)) ? "array" : "object");
  // A one-line preview of a structure for the table cell, truncated so a big object
  // never blows out the row — the full value is one click away in the modal.
  const jsonPeek = (text) => {
    const s = (() => { try { return JSON.stringify(JSON.parse(text)); } catch { return String(text); } })();
    return s.length > 40 ? s.slice(0, 39) + "…" : s;
  };

  // varRow renders one variable as a table row: name, value, type, and a copy
  // action. Scalars show inline and type-colored; objects and arrays show a compact
  // summary + preview behind a "···" button that opens the value in a modal — the
  // table stays scannable no matter how deep a structure is (operator's request).
  function varRow(v) {
    const complex = isComplexVar(v);
    let valCell;
    if (complex) {
      valCell = `<button class="v-open" type="button" data-name="${esc(v.name)}" data-json="${esc(v.value)}" data-type="${esc(jsonTypeLabel(v.value))}" title="Open ${esc(v.name)}">
          <span class="more" aria-hidden="true">···</span>
          <span class="v-sum">${esc(jsonSummary(v.value))}</span>
          <span class="peek">${esc(jsonPeek(v.value))}</span></button>`;
    } else {
      const cls = v.kind === "boolean" ? "bool" : v.kind === "number" ? "num" : v.kind === "null" ? "null" : "str";
      valCell = `<span class="c-val ${cls}">${esc(v.value)}</span>`;
    }
    const typeBadge = complex
      ? `<span class="vtag obj">${esc(jsonTypeLabel(v.value))}</span>`
      : `<span class="vtag">${esc(v.kind)}</span>`;
    const copyData = complex ? prettyJSON(v.value) : v.value;
    // A subprocess-local variable (an input mapping) carries the id of the
    // subprocess it lives in; label it so it reads apart from a process variable
    // (ADR-0074). A process-scope variable has no scope and no chip.
    const scopeChip = v.scope
      ? ` <span class="c-scope" title="Local to subprocess ${esc(v.scope)}">${esc(v.scope)}</span>`
      : "";
    return `<tr>
      <td class="c-name" title="${esc(v.name)}${v.scope ? " — local to subprocess " + esc(v.scope) : ""}">${esc(v.name)}${scopeChip}</td>
      <td class="c-valcell">${valCell}</td>
      <td class="c-type">${typeBadge}</td>
      <td class="c-act">${copyBtn(copyData, complex ? "Copy JSON" : "Copy value")}</td>
    </tr>`;
  }

  // renderVarRows fills the table body from the current variable set, honoring the
  // name filter. Split out from renderVars so typing in the filter (or scrubbing a
  // frame) only rewrites the rows — the toolbar and its focused filter input survive.
  function renderVarRows() {
    const body = varsEl.querySelector("#v-rows");
    if (!body) return;
    const f = varFilter.trim().toLowerCase();
    const shown = f ? curVarList.filter((v) => v.name.toLowerCase().includes(f)) : curVarList;
    varsEl.querySelector("#v-count").textContent = `${shown.length} variable${shown.length === 1 ? "" : "s"}`;
    body.innerHTML = shown.length
      ? shown.map(varRow).join("")
      : `<tr><td colspan="4" class="v-none">${f ? `No variables match “${esc(varFilter)}”.` : "The element has no variables."}</td></tr>`;
  }

  // buildVarsShell mounts the Variables tab's stable frame once: a toolbar (scope,
  // count, filter, copy-all) over a scrollable table. renderVars then only refreshes
  // the parts that change, so a 1.5s poll never steals the filter's focus.
  function buildVarsShell() {
    varsEl.innerHTML = `
      <div class="vp-head v-toolbar">
        <span class="vp-title" id="v-scope">Variables</span>
        <span class="vp-count" id="v-count">0 variables</span>
        <span class="v-filter">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3"/></svg>
          <input id="v-filter" type="text" placeholder="Filter…" aria-label="Filter variables by name"/>
        </span>
        <span class="vp-actions" id="v-copyall"></span>
      </div>
      <div class="v-scroll">
        <table class="vt">
          <thead><tr><th>Name</th><th>Value</th><th>Type</th><th class="c-act" aria-label="Actions"></th></tr></thead>
          <tbody id="v-rows"></tbody>
        </table>
      </div>`;
    const filterEl = varsEl.querySelector("#v-filter");
    filterEl.value = varFilter;
    filterEl.addEventListener("input", () => { varFilter = filterEl.value; renderVarRows(); });
    varsBuilt = true;
  }

  // renderVars fills the Variables tab. With an element selected it shows the
  // variables as they stood when that element activated (the per-step snapshot,
  // ADR-0048 — the closest analogue to Operate's element-scoped variables);
  // otherwise it shows the variables as of the current replay frame.
  function renderVars() {
    if (!varsBuilt) buildVarsShell();
    let src, scope;
    if (selEik) {
      const s = stepByEik(selEik);
      src = s ? s.variables : [];
      scope = s ? `As of <b>${esc(stepLabel(s))}</b> activation` : "Variables";
    } else {
      const pos = playhead > 0 && playhead <= frames.length ? frames[playhead - 1].position : 0;
      const cur = [...steps].reverse().find((s) => s.position <= pos) || null;
      src = cur ? cur.variables : [];
      scope = cur ? `As of step ${playhead} · <b>${esc(stepLabel(cur))}</b>` : "Variables";
    }
    curVarList = src || [];
    varsEl.querySelector("#v-scope").innerHTML = scope;
    varsEl.querySelector("#v-copyall").innerHTML = copyAllBtn(curVarList);
    renderVarRows();
  }

  // openVarModal shows an object/array variable's full value as pretty-printed,
  // syntax-highlighted JSON — the deep-inspect surface the table's "···" opens.
  const modalOv = root.querySelector("#var-modal-ov");
  function openVarModal(name, jsonText, typeLabel) {
    root.querySelector("#var-modal-title").textContent = name;
    root.querySelector("#var-modal-tag").textContent = typeLabel || "json";
    root.querySelector("#var-modal-body").innerHTML = highlightJSON(jsonText);
    root.querySelector("#var-modal-copy").dataset.copy = prettyJSON(jsonText);
    modalOv.hidden = false;
    root.querySelector("#var-modal-x").focus(); // so Escape closes and focus is trapped in the dialog
  }
  const closeVarModal = () => { modalOv.hidden = true; };

  // --- Decisions tab: the DMN evaluations this instance made (ADR-0066) ---
  // Rendered like the Operations decision-detail page (temis Operate style): inputs
  // as typed pills, each result tagged with the rule that fired, and the matched-rule
  // table revealed on hover. Scoped to the selected business rule task when one is
  // picked, the same as the Variables tab.
  const decLabel = (elId) => {
    const el = registry.get(elId);
    const bo = el && el.businessObject;
    return (bo && (bo.name || bo.id)) || elId;
  };
  // renderDecisions lists the instance's evaluations grouped by the task that made
  // them. If a business-rule task is selected it narrows to that task's decisions —
  // the same scoping the Variables tab uses. curDecs backs the hover popover.
  function renderDecisions() {
    if (!decisions.length) {
      decEl.innerHTML = `<p class="ops-empty">This instance made no decisions. A business rule task's inputs, outputs, and the rules that fired appear here once it runs.</p>`;
      curDecs = [];
      return;
    }
    const sel = selEik ? stepByEik(selEik) : null;
    const focusEl = sel && (registry.get(sel.elementId) || {}).businessObject
      && (registry.get(sel.elementId).businessObject.$type === "bpmn:BusinessRuleTask") ? sel.elementId : "";
    const list = focusEl ? decisions.filter((d) => d.elementId === focusEl) : decisions;
    const scope = focusEl ? `Decisions · <b>${esc(decLabel(focusEl))}</b>` : "Decisions";
    curDecs = list;
    if (!list.length) {
      decEl.innerHTML = `<div class="vp-head"><span class="vp-title">${scope}</span></div>
        <p class="ops-empty">This task has not evaluated a decision at this point.</p>`;
      return;
    }
    const groups = {};
    list.forEach((d, i) => { (groups[d.elementId] = groups[d.elementId] || []).push(i); });
    const body = Object.entries(groups).map(([elId, idxs]) =>
      `<div class="dec-group">${focusEl ? "" : `<div class="dec-group-h">${esc(decLabel(elId))}</div>`}` +
      idxs.map((i) => decCard(list[i], i)).join("") + "</div>").join("");
    decEl.innerHTML = `<div class="vp-head">
        <span class="vp-title">${scope}</span>
        <span class="vp-count">${list.length} evaluation${list.length === 1 ? "" : "s"}</span>
      </div>${body}`;
  }

  function renderInspector() { renderDetail(); renderVars(); renderDecisions(); }

  function updateClock() {
    if (!frames.length) { clockEl.textContent = "no frames yet"; return; }
    const shown = Math.min(playhead, frames.length);
    clockEl.textContent = `${shown} / ${frames.length}${shown ? ` · ${fmtClock(frames[shown - 1].at)}` : ""}`;
  }

  // renderOverlay paints the current frame: every element a live token sits on is
  // highlighted (green, or orange while waiting at a join) and carries a colored
  // token dot; elements only walked earlier are grayed. An element that holds a
  // token now must NOT also be grayed — the two markers have equal CSS weight, so
  // whichever is defined last would win and hide the live token. So the visited
  // pass skips any element in the current token set, and the token dots make even
  // two concurrent branches unmistakable.
  function renderOverlay() {
    for (const [id, m] of marked) { try { canvas.removeMarker(id, m); } catch { /* gone */ } }
    marked = [];
    while (dotLayer.firstChild) dotLayer.removeChild(dotLayer.firstChild);
    const frame = playhead ? frames[playhead - 1] : null;
    const position = frame ? frame.position : 0;
    const tokens = frame ? frame.tokens : [];
    const liveOn = new Set(tokens.map((t) => t.elementId));
    for (const s of steps.filter((item) => item.position <= position)) {
      if (liveOn.has(s.elementId) || !registry.get(s.elementId)) continue;
      canvas.addMarker(s.elementId, "atlas-visited");
      marked.push([s.elementId, "atlas-visited"]);
    }
    // Count tokens per element so several tokens on one node (both arrivals at a
    // join) fan out instead of stacking into one dot.
    const perEl = {};
    for (const token of tokens) {
      const el = registry.get(token.elementId);
      if (!el) continue;
      const marker = token.state === "waiting" ? "atlas-token-waiting" : "atlas-active";
      canvas.addMarker(token.elementId, marker);
      marked.push([token.elementId, marker]);
      const n = perEl[token.elementId] = (perEl[token.elementId] || 0) + 1;
      drawTokenDot(el, tokenColor(token.tokenId), n - 1);
    }
    const legend = root.querySelector("#token-legend");
    legend.innerHTML = tokens.length ? tokens.map((token) =>
      `<span class="token-chip"><i style="--token-color:${tokenColor(token.tokenId)}">#</i>` +
      `Token ${esc(String(token.tokenId))} — ${esc(stepLabel(token))}${token.state === "waiting" ? " (waiting at join)" : ""}</span>`).join("")
      : `<span class="muted">No active tokens in this frame</span>`;
    applySelection();
  }

  // applySelection re-draws the blue "selected element" outline. renderOverlay
  // clears every marker each frame, so the selection is re-applied here after it.
  function applySelection() {
    if (selElId && registry.get(selElId)) {
      canvas.addMarker(selElId, "atlas-selected");
      marked.push([selElId, "atlas-selected"]);
    }
  }

  // drawTokenDot places a filled token marker at the top-left of an element (index
  // offsets stacked tokens so concurrent ones on the same node stay distinct). The
  // dot lives on the replay layer, so it tracks pan/zoom like the moving dot.
  function drawTokenDot(el, color, index) {
    const NS = "http://www.w3.org/2000/svg";
    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `translate(${el.x + 6 + index * 16} ${el.y + 6})`);
    const halo = document.createElementNS(NS, "circle");
    halo.setAttribute("r", "9"); halo.setAttribute("fill", "#fff"); halo.setAttribute("stroke", color); halo.setAttribute("stroke-width", "2");
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "6"); dot.setAttribute("fill", color);
    g.appendChild(halo); g.appendChild(dot);
    dotLayer.appendChild(g);
  }

  // highlightHistory marks how far the replay has walked (done / current / pending)
  // and which row is the selected element instance, and scrolls the current one in.
  function highlightHistory() {
    historyEl.querySelectorAll(".ops-hrow[data-i]").forEach((row) => {
      const i = Number(row.dataset.i);
      const pos = steps[i] ? steps[i].position : 0;
      row.classList.toggle("done", playhead > 0 && pos <= (frames[playhead - 1] || {}).position);
      row.classList.toggle("cur", playhead > 0 && i === playhead - 1);
      row.classList.toggle("sel", steps[i] && steps[i].elementInstanceKey === selEik && selEik !== 0);
    });
    const cur = historyEl.querySelector(".ops-hrow.cur");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function setPlayhead(n) {
    playhead = Math.max(0, Math.min(frames.length, n));
    scrub.value = String(playhead);
    updateClock();
    renderOverlay();
    highlightHistory();
    if (!selEik) renderVars(); // an unselected inspector tracks the playhead
  }

  // renderHistory draws the instance-history tree: the process root, then every
  // element activation in order with a lifecycle icon and its start (or end) time.
  // A row is clickable to select and scrub to that element instance.
  function renderHistory() {
    if (!steps.length) {
      historyEl.innerHTML = `<p class="ops-empty">No history recorded yet.</p>`;
      return;
    }
    const rows = steps.map((s, i) => {
      const done = s.endAt > 0;
      const icon = done ? "&#10003;" : "&#9679;";
      const when = showEnd ? (s.endAt ? fmtClock(s.endAt) : "—") : fmtClock(s.at);
      return `<div class="ops-hrow" data-i="${i}" data-eik="${s.elementInstanceKey || 0}">
        <span class="ops-hicon ${done ? "done" : "live"}">${icon}</span>
        <span class="ops-hname">${esc(stepLabel(s))}</span>
        <span class="ops-htime">${esc(when)}</span>
      </div>`;
    }).join("");
    historyEl.innerHTML = `<div class="ops-hrow root" data-i="-1" data-eik="0">
        <span class="ops-hicon proc">&#9635;</span>
        <span class="ops-hname"><b>${esc(titleEl.textContent)}</b></span>
        <span class="ops-htime">${showEnd ? "" : fmtClock(steps[0].at)}</span>
      </div>${rows}`;
    historyEl.querySelectorAll(".ops-hrow").forEach((row) => row.addEventListener("click", () => {
      const i = Number(row.dataset.i);
      pause();
      if (i < 0) { selectElement("", 0); return; }
      const s = steps[i];
      selectElement(s.elementId, s.elementInstanceKey || 0);
      const frame = frames.findIndex((f) => f.position >= s.position);
      setPlayhead(frame < 0 ? frames.length : frame + 1);
      animateStep(i);
    }));
    highlightHistory();
  }

  // selectElement cross-highlights the diagram, the history and the inspector for
  // one element instance (or clears the selection when elId is empty).
  function selectElement(elId, eik) {
    selElId = elId;
    // Without a specific instance, default to this element's last activation so the
    // inspector has facts to show (clicking the diagram picks the whole element).
    if (!eik && elId) {
      const list = stepsForElement(elId);
      eik = list.length ? list[list.length - 1].elementInstanceKey : 0;
    }
    selEik = eik;
    renderOverlay();
    highlightHistory();
    renderInspector();
  }

  // sequenceFlowBetween finds the connection the modeler drew from srcId to tgtId,
  // so a step can animate a token dot along the edge the token actually traversed.
  function sequenceFlowBetween(srcId, tgtId) {
    let found = null;
    registry.forEach((el) => {
      if (found) return;
      const bo = el.businessObject;
      if (bo && bo.sourceRef && bo.targetRef && bo.sourceRef.id === srcId && bo.targetRef.id === tgtId
        && el.waypoints && el.waypoints.length >= 2) found = el;
    });
    return found;
  }

  // animateStep plays the walk INTO step i: the entered element pulses, and if a
  // sequence flow joins it to the previous step the token dot travels the edge.
  function animateStep(i) {
    if (i < 0 || i >= steps.length || current !== viewer) return Promise.resolve();
    const s = steps[i];
    if (registry.get(s.elementId)) {
      canvas.addMarker(s.elementId, "atlas-flow-hit");
      setTimeout(() => { try { canvas.removeMarker(s.elementId, "atlas-flow-hit"); } catch { /* gone */ } }, 700);
    }
    // Animate along the edge the token actually traversed: the activation carries
    // the element it came from (its incoming flow's source). Falling back to the
    // previous row would draw a fork branch from its sibling (way1 → way2) instead
    // of from the gateway.
    const from = s.sourceElementId || (i > 0 ? steps[i - 1].elementId : null);
    if (!from) return Promise.resolve(); // the start event has no incoming walk
    const conn = sequenceFlowBetween(from, s.elementId);
    if (!conn) return Promise.resolve(); // a jump with no drawn edge (e.g. across a gateway)
    canvas.addMarker(conn.id, "atlas-flow-active");
    const wps = conn.waypoints.map((w) => ({ x: w.x, y: w.y }));
    const token = ++animToken;
    return runDotAnimation(layer, wps, 700 / speed(), () => current !== viewer || token !== animToken)
      .finally(() => { try { canvas.removeMarker(conn.id, "atlas-flow-active"); } catch { /* gone */ } });
  }

  function pause() { playing = false; playBtn.innerHTML = "&#9654; Play"; }

  async function play() {
    if (!frames.length) return;
    if (playhead >= frames.length) setPlayhead(0); // wrap to replay from the start
    playing = true;
    playBtn.innerHTML = "&#9208; Pause";
    while (playing && current === viewer && playhead < frames.length) {
      const i = playhead;
      setPlayhead(playhead + 1);
      await sleep(120 / speed());
      if (!playing || current !== viewer) break;
      // Pause between steps, scaled to the real gap (clamped) and the speed.
      const gap = playhead < frames.length
        ? Math.min(1200, Math.max(150, (frames[playhead].at - frames[i].at) / 1e6))
        : 0;
      await sleep(gap / speed());
    }
    pause();
  }

  function applyStatePill(state) {
    stateEl.textContent = state || "—";
    stateEl.className = "pill" + (state === "active" ? " ok" : state === "completed" ? "" : state ? " err" : "");
    statusEl.className = "ops-status " + (state === "active" ? "live" : "done");
  }

  // Header name prefers the diagram's process name, falling back to its id.
  function processName() {
    try {
      const bo = canvas.getRootElement().businessObject;
      return (bo && (bo.name || bo.id)) || tl.processId || `instance ${key}`;
    } catch { return tl.processId || `instance ${key}`; }
  }

  function applyMeta(next) {
    titleEl.textContent = processName();
    docTitle(`${processName()} · Instance ${key}`);
    root.querySelector("#m-version").textContent = next.version != null ? "v" + next.version : "—";
    const vtag = next.versionTag || "";
    const vtWrap = root.querySelector("#m-vtag-wrap");
    if (vtWrap) {
      if (vtag) { root.querySelector("#m-vtag").textContent = vtag; vtWrap.hidden = false; }
      else { vtWrap.hidden = true; }
    }
    root.querySelector("#m-start").textContent = steps.length ? fmtDateTime(steps[0].at) : "—";
    const end = next.state !== "active" && steps.length ? Math.max(...steps.map((s) => s.endAt || 0)) : 0;
    root.querySelector("#m-end").textContent = end ? fmtDateTime(end) : "—";
    applyStatePill(next.state);
  }

  async function poll() {
    let next;
    try { next = await api("GET", `/api/v1/instances/${key}/timeline`); }
    catch { return; } // transient; try again next tick
    if (current !== viewer) return;
    // Rebuild only when the step set grows, so a poll never disturbs the operator's
    // current scrub position mid-replay.
    const list = next.steps || [], nextFrames = next.frames || [];
    const grew = list.length !== steps.length || nextFrames.length !== frames.length;
    if (grew) {
      const wasAtEnd = playhead >= frames.length;
      steps = list; frames = nextFrames;
      scrub.max = String(frames.length);
      renderHistory();
      loadBadges();
      drawCallActivityLinks();
      if (!playing && wasAtEnd) setPlayhead(frames.length); // follow new frames live
      else { scrub.value = String(playhead); updateClock(); renderOverlay(); highlightHistory(); }
      renderInspector();
    }
    applyMeta(next);
    await refreshDecisions();
  }

  // refreshDecisions pulls the instance's DMN evaluations and re-renders the tab
  // when they change, so a still-running instance's decisions appear live.
  async function refreshDecisions() {
    let next;
    try { next = await api("GET", `/api/v1/instances/${key}/decisions`); }
    catch { return; } // transient; keep what we have
    if (current !== viewer) return;
    next = next || [];
    if (next.length === decisions.length) return; // nothing new
    decisions = next;
    renderDecisions();
  }

  // Selecting an element in the diagram inspects it, the same as a history click.
  eventBus.on("element.click", (e) => {
    const el = e.element;
    if (!el || el.waypoints || el === canvas.getRootElement()) { selectElement("", 0); return; }
    pause();
    selectElement(el.id, 0);
  });

  root.querySelectorAll("#rp-tabs button").forEach((b) => b.addEventListener("click", () => {
    activeTab = b.dataset.tab;
    root.querySelectorAll("#rp-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    detailEl.hidden = activeTab !== "details";
    varsEl.hidden = activeTab !== "variables";
    decEl.hidden = activeTab !== "decisions";
  }));
  root.querySelector("#tg-end").addEventListener("change", (e) => { showEnd = e.target.checked; renderHistory(); });
  playBtn.addEventListener("click", () => { playing ? pause() : play(); });
  root.querySelector("#step-fwd").addEventListener("click", () => {
    pause();
    if (playhead < frames.length) setPlayhead(playhead + 1);
  });
  root.querySelector("#step-back").addEventListener("click", () => { pause(); setPlayhead(playhead - 1); });
  scrub.addEventListener("input", () => { pause(); setPlayhead(Number(scrub.value)); });
  // A "···" button in the Variables table opens its object/array value in the modal.
  varsEl.addEventListener("click", (e) => {
    const open = e.target.closest(".v-open");
    if (!open || !varsEl.contains(open)) return;
    openVarModal(open.dataset.name, open.dataset.json, open.dataset.type);
  });
  modalOv.addEventListener("click", (e) => { if (e.target === modalOv) closeVarModal(); });
  modalOv.addEventListener("keydown", (e) => { if (e.key === "Escape") closeVarModal(); });
  root.querySelector("#var-modal-x").addEventListener("click", closeVarModal);
  bindVarCopy(varsEl, toast);
  bindVarCopy(modalOv, toast);
  wireOpsResizer(root, viewer);

  // Decisions tab: hovering (or focusing) a result row backed by a decision table
  // reveals that table, matched rule highlighted, in a shared viewport popover.
  const showDecPop = (row) => {
    const d = curDecs[Number(row.dataset.dec)];
    const tables = d ? decTablesOf(d) : [];
    if (!tables.length) return;
    decPop.innerHTML = `<div class="pop-title">${esc(d.decisionId)}</div>` +
      tables.map((tt, i) => decMiniTable(tt, tables.length > 1 ? i + 1 : 0)).join("");
    decPop.hidden = false;
    const box = row.getBoundingClientRect();
    const top = box.top - decPop.offsetHeight - 10;
    decPop.style.left = Math.max(8, Math.min(box.left, window.innerWidth - decPop.offsetWidth - 8)) + "px";
    decPop.style.top = (top < 8 ? box.bottom + 10 : top) + "px";
  };
  const hideDecPop = () => { decPop.hidden = true; };
  decEl.addEventListener("pointerover", (e) => {
    const row = e.target.closest(".res-row.hoverable");
    if (row && decEl.contains(row)) showDecPop(row);
  });
  decEl.addEventListener("pointerout", (e) => {
    const row = e.target.closest(".res-row.hoverable");
    if (row && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".res-row.hoverable") === row)) hideDecPop();
  });
  decEl.addEventListener("focusin", (e) => { const row = e.target.closest(".res-row.hoverable"); if (row) showDecPop(row); });
  decEl.addEventListener("focusout", hideDecPop);

  await poll();
  renderInspector();
  liveTimer = setInterval(poll, 1500);
}

// wireOpsResizer makes the boundary between the diagram and the bottom panel
// (Instance History + inspector) draggable, so an operator can trade diagram room
// for a taller history/variables view — mirroring the Modeler's properties resizer.
// The chosen height persists across mounts (localStorage) and the bpmn-js canvas is
// re-fit whenever the split's footprint settles.
function wireOpsResizer(root, viewer) {
  const resizer = root.querySelector("#ops-resizer");
  const split = root.querySelector("#ops-split");
  if (!resizer || !split) return;
  const KEY = "atlas.opsSplitHeight";
  const clamp = (h) => Math.max(140, Math.min(Math.round(window.innerHeight * 0.75), h));

  const saved = parseInt(localStorage.getItem(KEY) || "", 10);
  if (saved) split.style.height = clamp(saved) + "px";

  // Let bpmn-js recompute its viewport for the diagram's new height.
  const nudge = () => {
    try { viewer && viewer.get("canvas").resized(); } catch { /* ignore */ }
    window.dispatchEvent(new Event("resize"));
  };

  let startY = 0, startH = 0;
  const onMove = (e) => {
    // The split sits below the divider, so dragging up (clientY decreases) grows it.
    split.style.height = clamp(startH - (e.clientY - startY)) + "px";
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    resizer.classList.remove("dragging");
    document.body.style.userSelect = "";
    localStorage.setItem(KEY, String(parseInt(split.style.height, 10) || 280));
    nudge();
  };
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = split.getBoundingClientRect().height;
    resizer.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
  // Double-click the divider to reset to the default height.
  resizer.addEventListener("dblclick", () => {
    split.style.height = "280px";
    localStorage.setItem(KEY, "280");
    nudge();
  });
  // Keyboard: arrow up/down resize in 24px steps (the divider is focusable).
  resizer.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    split.style.height = clamp(split.getBoundingClientRect().height + (e.key === "ArrowUp" ? 24 : -24)) + "px";
    localStorage.setItem(KEY, String(parseInt(split.style.height, 10)));
    nudge();
  });
}
