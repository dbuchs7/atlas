// Process documentation export (ADR-0138): turn the diagram the Modeler is
// holding into a structured PDF — the graphic, then every element with the prose
// written about it.
//
// This module is deliberately split from the editor. Collecting the prose and
// laying out the document are pure functions over a model, so they can be driven
// and asserted in a browser test without mounting the whole editor; the editor
// only wires a button to them.

import { PdfDocument, bytesToBase64 } from "./pdf.js";

// A readable label for each BPMN type. The raw `bpmn:ExclusiveGateway` is
// meaningless to the audience this document is written for.
const TYPE_LABELS = {
  "bpmn:StartEvent": "Start event",
  "bpmn:EndEvent": "End event",
  "bpmn:IntermediateCatchEvent": "Intermediate catch event",
  "bpmn:IntermediateThrowEvent": "Intermediate throw event",
  "bpmn:BoundaryEvent": "Boundary event",
  "bpmn:Task": "Task",
  "bpmn:UserTask": "User task",
  "bpmn:ServiceTask": "Service task",
  "bpmn:ScriptTask": "Script task",
  "bpmn:BusinessRuleTask": "Business rule task",
  "bpmn:SendTask": "Send task",
  "bpmn:ReceiveTask": "Receive task",
  "bpmn:ManualTask": "Manual task",
  "bpmn:CallActivity": "Call activity",
  "bpmn:SubProcess": "Subprocess",
  "bpmn:Transaction": "Transaction",
  "bpmn:ExclusiveGateway": "Exclusive gateway (XOR)",
  "bpmn:ParallelGateway": "Parallel gateway (AND)",
  "bpmn:InclusiveGateway": "Inclusive gateway (OR)",
  "bpmn:EventBasedGateway": "Event-based gateway",
  "bpmn:SequenceFlow": "Sequence flow",
  "bpmn:Participant": "Pool",
  "bpmn:Lane": "Lane",
};

// The order elements are documented in: the reader follows the process, so the
// entry points come first and the ends last, with the work in between. Named
// sequence flows close the list — a flow is a transition between the steps
// above, so it reads as a footnote to them rather than as a step of its own.
const TYPE_ORDER = [
  "bpmn:StartEvent", "bpmn:UserTask", "bpmn:ServiceTask", "bpmn:ScriptTask",
  "bpmn:BusinessRuleTask", "bpmn:SendTask", "bpmn:ReceiveTask", "bpmn:ManualTask",
  "bpmn:Task", "bpmn:CallActivity", "bpmn:SubProcess", "bpmn:Transaction",
  "bpmn:ExclusiveGateway", "bpmn:InclusiveGateway", "bpmn:ParallelGateway",
  "bpmn:EventBasedGateway", "bpmn:IntermediateCatchEvent",
  "bpmn:IntermediateThrowEvent", "bpmn:BoundaryEvent", "bpmn:EndEvent",
  "bpmn:SequenceFlow",
];

export function typeLabel(type) {
  return TYPE_LABELS[type] || String(type || "").replace(/^bpmn:/, "");
}

// documentationOf reads an element's <bpmn:documentation>. BPMN allows several
// entries; they are joined into one block of prose.
export function documentationOf(bo) {
  const docs = (bo && bo.documentation) || [];
  return docs.map((d) => (d && d.text ? String(d.text) : "")).filter(Boolean).join("\n\n").trim();
}

// Containers and decorations, which never earn a section of their own. Pools and
// lanes are structure rather than steps, and each element already reports the
// lane it sits in; annotations are the *source* of prose, not subjects of it.
const NOT_DOCUMENTABLE = /^bpmn:(Process|Collaboration|Definitions|Participant|Lane|LaneSet|TextAnnotation|Association|MessageFlow|DataObject|DataObjectReference|DataStoreReference|Group)$/;

// isDocumentable decides what earns a section. Every flow node does. A sequence
// flow only does when it carries a name, a condition, or its own prose — an
// unnamed flow says nothing a reader could not see in the picture, and listing
// all of them would bury the elements that matter.
function isDocumentable(bo) {
  const type = bo && bo.$type;
  if (!type || !type.startsWith("bpmn:")) return false;
  if (type === "bpmn:SequenceFlow") {
    return !!(bo.name || bo.conditionExpression || documentationOf(bo));
  }
  return !NOT_DOCUMENTABLE.test(type);
}

// collectDocumentation reads everything the document needs out of a live bpmn-js
// modeler: the process identity, its own prose, and one entry per element with
// the documentation and text annotations attached to it.
//
// Annotations are matched through <bpmn:association>, which is how BPMN attaches
// a note to an element. An annotation associated with nothing still appears — as
// a general note on the process — because a modeller who wrote it meant it to be
// read.
export function collectDocumentation(modeler) {
  let registry;
  try { registry = modeler.get("elementRegistry"); } catch { return emptyCollection(); }

  const businessObjects = [];
  registry.forEach((el) => {
    if (el.labelTarget) return; // a label shares its target's businessObject
    if (el.businessObject) businessObjects.push(el.businessObject);
  });

  // Annotations by the id of the element they are associated with.
  const annotationsFor = new Map();
  const generalNotes = [];
  const annotationById = new Map();
  for (const bo of businessObjects) {
    if (bo.$type === "bpmn:TextAnnotation") annotationById.set(bo.id, (bo.text || "").trim());
  }
  const attached = new Set();
  for (const bo of businessObjects) {
    if (bo.$type !== "bpmn:Association") continue;
    const src = bo.sourceRef && bo.sourceRef.id;
    const tgt = bo.targetRef && bo.targetRef.id;
    // An association may point either way; the annotation is whichever end is one.
    const [noteId, elementId] = annotationById.has(tgt) ? [tgt, src] : [src, tgt];
    const text = annotationById.get(noteId);
    if (!text || !elementId) continue;
    attached.add(noteId);
    if (!annotationsFor.has(elementId)) annotationsFor.set(elementId, []);
    annotationsFor.get(elementId).push(text);
  }
  for (const [id, text] of annotationById) {
    if (!attached.has(id) && text) generalNotes.push(text);
  }

  // Lane membership, so a documented element says who owns it (ADR-0121).
  const laneOf = new Map();
  for (const bo of businessObjects) {
    if (bo.$type !== "bpmn:Lane") continue;
    for (const node of bo.flowNodeRef || []) {
      if (node && node.id) laneOf.set(node.id, bo.name || bo.id);
    }
  }

  const elements = [];
  for (const bo of businessObjects) {
    if (!isDocumentable(bo)) continue;
    elements.push({
      id: bo.id,
      type: bo.$type,
      name: (bo.name || "").trim(),
      documentation: documentationOf(bo),
      annotations: annotationsFor.get(bo.id) || [],
      lane: laneOf.get(bo.id) || "",
    });
  }

  // Documented elements sort by the reader's path through the process, then by
  // name so the order is stable between exports of an unchanged model.
  elements.sort((a, b) => {
    const ra = TYPE_ORDER.indexOf(a.type);
    const rb = TYPE_ORDER.indexOf(b.type);
    if (ra !== rb) return (ra < 0 ? TYPE_ORDER.length : ra) - (rb < 0 ? TYPE_ORDER.length : rb);
    return (a.name || a.id).localeCompare(b.name || b.id);
  });

  const root = rootBusinessObject(modeler);
  const process = processBusinessObject(modeler, businessObjects);
  return {
    processId: (process && process.id) || (root && root.id) || "",
    processName: (process && process.name) || (root && root.name) || "",
    processDocumentation: documentationOf(process),
    generalNotes,
    elements,
  };
}

function emptyCollection() {
  return { processId: "", processName: "", processDocumentation: "", generalNotes: [], elements: [] };
}

function rootBusinessObject(modeler) {
  try { return modeler.get("canvas").getRootElement().businessObject || null; } catch { return null; }
}

// processBusinessObject finds the process the document is about. In a plain
// diagram that is the root; in a collaboration the root is the collaboration, so
// the first participant's process stands in.
function processBusinessObject(modeler, businessObjects) {
  const root = rootBusinessObject(modeler);
  if (root && /:Process$/.test(root.$type || "")) return root;
  for (const bo of businessObjects) {
    if (bo.$type === "bpmn:Participant" && bo.processRef) return bo.processRef;
  }
  return root;
}

// svgToJpeg rasterizes the diagram bpmn-js drew. The SVG is drawn onto a canvas
// at a fixed scale and encoded as JPEG, whose bytes the PDF embeds untranscoded.
// A white backdrop is painted first: a BPMN diagram has a transparent background,
// and JPEG has no alpha, so without it the diagram would come out on black.
export async function svgToJpeg(svg, { scale = 2, quality = 0.92, maxPixels = 4000 } = {}) {
  const sized = sizeOfSvg(svg);
  let width = Math.max(1, Math.round(sized.width * scale));
  let height = Math.max(1, Math.round(sized.height * scale));
  const cap = Math.max(width, height);
  if (cap > maxPixels) {
    const shrink = maxPixels / cap;
    width = Math.max(1, Math.round(width * shrink));
    height = Math.max(1, Math.round(height * shrink));
  }

  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const trimmed = trimToContent(canvas);
    const out = await new Promise((resolve) => trimmed.toBlob(resolve, "image/jpeg", quality));
    return { bytes: new Uint8Array(await out.arrayBuffer()), width: trimmed.width, height: trimmed.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// trimToContent crops the blank margin off a rasterized diagram. The SVG bpmn-js
// exports is boxed generously — its viewBox can start well above the topmost
// shape — and a document whose centrepiece floats in a band of white looks like
// a mistake. Returns the original canvas when there is nothing to trim.
export function trimToContent(canvas, { padding = 12 } = {}) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return canvas; // a tainted canvas cannot be read; ship it untrimmed
  }
  let top = height, left = width, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Near-white is background. The tolerance keeps JPEG-ish noise and
      // antialiased edges from counting as content.
      if (pixels[i] > 247 && pixels[i + 1] > 247 && pixels[i + 2] > 247) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (right < 0) return canvas; // nothing but background — leave it alone

  const x0 = Math.max(0, left - padding);
  const y0 = Math.max(0, top - padding);
  const w = Math.min(width, right + padding + 1) - x0;
  const h = Math.min(height, bottom + padding + 1) - y0;
  if (w >= width && h >= height) return canvas;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, w, h);
  octx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  return out;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the diagram image could not be rendered"));
    img.src = url;
  });
}

// sizeOfSvg reads the drawing's dimensions from the SVG bpmn-js produced,
// preferring the viewBox (which is always present and in diagram units) over the
// width/height attributes, which may carry percentages.
export function sizeOfSvg(svg) {
  const viewBox = /viewBox="([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)"/.exec(svg);
  if (viewBox) {
    const w = parseFloat(viewBox[3]);
    const h = parseFloat(viewBox[4]);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  const w = parseFloat((/\swidth="([\d.]+)/.exec(svg) || [])[1]);
  const h = parseFloat((/\sheight="([\d.]+)/.exec(svg) || [])[1]);
  if (w > 0 && h > 0) return { width: w, height: h };
  return { width: 800, height: 600 };
}

const GREY = [0.42, 0.42, 0.42];

// buildDocumentationPdf lays out the document: a cover naming the process and the
// version, the diagram, then one section per element carrying its prose. Returns
// the finished bytes.
export function buildDocumentationPdf(spec) {
  const {
    collection, diagram, title, note, version, createdAt, createdBy, deploymentVersion,
  } = spec;
  const doc = new PdfDocument({
    title: title || collection.processName || collection.processId,
    footer: (title || collection.processId) + (version ? " · v" + version : ""),
  });

  doc.heading(title || collection.processName || collection.processId, 1);
  doc.paragraph("Process documentation", { size: 11, color: GREY, after: 12 });

  doc.keyValue("Process ID", collection.processId || "—");
  if (collection.processName) doc.keyValue("Name", collection.processName);
  if (version) doc.keyValue("Documentation version", "v" + version);
  if (deploymentVersion) doc.keyValue("Deployed version", "v" + deploymentVersion);
  doc.keyValue("Created", createdAt || new Date().toLocaleString());
  if (createdBy) doc.keyValue("Created by", createdBy);
  doc.keyValue("Elements documented", String(collection.elements.length));
  if (note) doc.keyValue("Note", note);
  doc.rule();

  if (collection.processDocumentation) {
    doc.heading("About this process", 2);
    doc.paragraph(collection.processDocumentation, { after: 8 });
  }

  if (diagram && diagram.bytes) {
    doc.heading("Diagram", 2);
    doc.image(diagram.bytes, diagram.width, diagram.height);
  }

  doc.heading("Elements", 2);
  if (collection.elements.length === 0) {
    doc.paragraph("This process has no documentable elements.", { color: GREY });
  }
  for (const el of collection.elements) {
    // An element's section is its title, the type/id line, and at least the
    // first line of what is written about it. Keeping those together is what
    // stops a name stranded at the foot of a page from its own description.
    doc.heading(el.name || el.id, 3, { keep: 58 });
    const meta = [typeLabel(el.type), "id: " + el.id];
    if (el.lane) meta.push("lane: " + el.lane);
    doc.paragraph(meta.join("  ·  "), { size: 8.5, color: GREY, after: 3 });
    if (el.documentation) {
      doc.paragraph(el.documentation, { size: 10, after: el.annotations.length ? 4 : 8 });
    } else if (el.annotations.length === 0) {
      doc.paragraph("No documentation.", { size: 9.5, color: GREY, after: 8 });
    }
    for (const note of el.annotations) {
      doc.paragraph("Note: " + note, { size: 9.5, indent: 12, after: 4 });
    }
    doc.y += 4;
  }

  if (collection.generalNotes.length) {
    doc.heading("Unattached notes", 2);
    doc.paragraph(
      "Annotations in the diagram that are not associated with a particular element.",
      { size: 9.5, color: GREY, after: 6 },
    );
    for (const note of collection.generalNotes) doc.paragraph("• " + note, { indent: 8, after: 4 });
  }

  return doc.bytes();
}

// exportDocumentation is the whole act: read the model, rasterize the diagram,
// build the document, and publish it as the next version of this process. Returns
// the created version as the API rendered it.
export async function exportDocumentation({ modeler, api, title, note, createdBy }) {
  const collection = collectDocumentation(modeler);
  if (!collection.processId) throw new Error("the diagram has no process to document");

  const { svg } = await modeler.saveSVG();
  const diagram = await svgToJpeg(svg);
  const { xml } = await modeler.saveXML({ format: true });

  const bytes = buildDocumentationPdf({
    collection, diagram, title, note, createdBy,
    createdAt: new Date().toLocaleString(),
  });

  return api("POST", `/api/v1/processes/${encodeURIComponent(collection.processId)}/documentation`, {
    title: title || collection.processName || collection.processId,
    note: note || "",
    processName: collection.processName,
    xml,
    elements: collection.elements,
    pdfBase64: bytesToBase64(bytes),
  });
}
