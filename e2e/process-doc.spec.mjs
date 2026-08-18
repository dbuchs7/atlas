// e2e for the process documentation collector and layout (api/web/process-doc.js,
// ADR-0138).
//
// The whole point of the feature is that the prose modellers write *into* the
// diagram — per-element <documentation> and the <textAnnotation> notes hanging
// off elements — reaches the reader. That prose lives in the moddle tree bpmn-js
// builds, so these tests run against the real vendored modeler on a real model:
// a stub would only prove the stub.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/process-doc-harness.html");
  await page.waitForFunction(() => window.__ready === true);
  page._errors = errors;
});

test.afterEach(async ({ page }) => {
  expect(page._errors, "no uncaught page errors").toEqual([]);
});

test("the collector reads the process identity and its own documentation", async ({ page }) => {
  const c = await page.evaluate(() => window.__doc.collectDocumentation(window.__modeler));
  expect(c.processId).toBe("reisebuchung");
  expect(c.processName).toBe("Reisebuchung");
  expect(c.processDocumentation).toContain("Bucht eine Reise für einen Kunden");
});

test("every element carries its documentation, annotations, and lane", async ({ page }) => {
  const c = await page.evaluate(() => window.__doc.collectDocumentation(window.__modeler));
  const byId = Object.fromEntries(c.elements.map((e) => [e.id, e]));

  // Per-element prose reaches the document.
  expect(byId.Task_pruefen.documentation).toBe("Die Sachbearbeitung prüft Vollständigkeit und Budget.");
  expect(byId.Task_buchen.documentation).toBe("Ruft das Buchungssystem der Airline auf.");

  // The annotation associated with the booking task is attached to it, and to
  // nothing else — this is the association walk, the heart of the collector.
  expect(byId.Task_buchen.annotations).toEqual(["Benötigt IATA-Zugang"]);
  expect(byId.Task_pruefen.annotations).toEqual([]);

  // Lane membership tells the reader who owns each step.
  expect(byId.Task_pruefen.lane).toBe("Sachbearbeitung");
  expect(byId.Task_buchen.lane).toBe("System");

  // An annotation attached to nothing is still surfaced — the modeller meant it
  // to be read — but as a general note, not against an arbitrary element.
  expect(c.generalNotes).toEqual(["Freigabe durch die Leitung steht aus"]);
});

test("elements are selected and ordered so the document reads like the process", async ({ page }) => {
  const c = await page.evaluate(() => window.__doc.collectDocumentation(window.__modeler));
  const ids = c.elements.map((e) => e.id);

  // The nodes are all there, in path order: start, work, gateway, end.
  expect(ids[0]).toBe("Start_1");
  expect(ids.indexOf("Task_pruefen")).toBeLessThan(ids.indexOf("Gw_1"));
  expect(ids.indexOf("Gw_1")).toBeLessThan(ids.indexOf("End_1"));

  // Named flows out of the gateway earn a section — they carry the branch
  // condition a reader needs. Unnamed ones do not: they would bury the elements
  // that matter behind noise the picture already shows.
  expect(ids).toContain("f2");
  expect(ids).toContain("f3");
  expect(ids).not.toContain("f0");
  expect(ids).not.toContain("f4");

  // A flow is a transition between the steps, so it reads as a footnote after
  // all of them rather than as a step of its own.
  expect(ids.indexOf("End_1")).toBeLessThan(ids.indexOf("f2"));
  expect(ids.at(-1)).toBe("f3"); // "nein" sorts after "ja"

  // Annotations and associations are the source of prose, never sections of
  // their own; lanes are structure, and each element already reports its own.
  expect(ids).not.toContain("note_iata");
  expect(ids).not.toContain("assoc_1");
  expect(ids).not.toContain("lane_sb");
  expect(ids).not.toContain("lane_sys");

  // Ordering is stable: the same model exports the same document twice running.
  const again = await page.evaluate(() => window.__doc.collectDocumentation(window.__modeler).elements.map((e) => e.id));
  expect(again).toEqual(ids);
});

test("the diagram rasterizes to a JPEG with its blank margin trimmed off", async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { svg } = await window.__modeler.saveSVG();
    const size = window.__doc.sizeOfSvg(svg);
    const jpeg = await window.__doc.svgToJpeg(svg, { scale: 2 });
    return { size, width: jpeg.width, height: jpeg.height, head: Array.from(jpeg.bytes.slice(0, 2)), length: jpeg.bytes.length };
  });

  expect(out.head, "a JPEG SOI marker").toEqual([0xff, 0xd8]);
  expect(out.length).toBeGreaterThan(1000);

  // bpmn-js boxes its exported SVG generously — this model's viewBox opens some
  // 80 units above the topmost shape. The raster is cropped to what is actually
  // drawn, so the document's centrepiece does not float in a band of white.
  expect(out.height, "the blank band above the diagram is gone").toBeLessThan(out.size.height * 2 * 0.9);
  // Cropping preserves the drawing: it is still wider than it is tall, as the
  // model is.
  expect(out.width).toBeGreaterThan(out.height);
});

test("trimming leaves an all-background raster alone", async ({ page }) => {
  // A diagram with nothing in it has no content bounds to crop to; returning the
  // canvas untouched is better than returning a zero-sized image.
  const same = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 120, 80);
    const out = window.__doc.trimToContent(canvas);
    return { width: out.width, height: out.height, identical: out === canvas };
  });
  expect(same).toEqual({ width: 120, height: 80, identical: true });
});

test("a very large diagram is capped rather than rasterized without bound", async ({ page }) => {
  const out = await page.evaluate(async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8000 2000" width="8000" height="2000"><rect width="8000" height="2000" fill="#eee"/></svg>';
    return await window.__doc.svgToJpeg(svg, { scale: 2, maxPixels: 4000 }).then((r) => ({ width: r.width, height: r.height }));
  });
  expect(out.width).toBeLessThanOrEqual(4000);
  expect(out.height).toBeLessThanOrEqual(4000);
  expect(out.width / out.height).toBeCloseTo(4, 1);
});

test("the built document contains the diagram and every element's prose", async ({ page }) => {
  const raw = await page.evaluate(async () => {
    const collection = window.__doc.collectDocumentation(window.__modeler);
    const { svg } = await window.__modeler.saveSVG();
    const diagram = await window.__doc.svgToJpeg(svg);
    const bytes = window.__doc.buildDocumentationPdf({
      collection, diagram, title: "Reisebuchung", note: "Freigabe Q3",
      version: 2, createdAt: "18.08.2026", createdBy: "ada", deploymentVersion: 4,
    });
    return window.__asLatin1(bytes);
  });

  expect(raw.startsWith("%PDF-")).toBe(true);
  expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);

  // The cover states what version of what process this is, and who made it —
  // historization is worth nothing if a printed copy cannot identify itself.
  expect(raw).toContain("reisebuchung");
  expect(raw).toContain("v2");
  expect(raw).toContain("ada");
  expect(raw).toContain("Freigabe Q3");

  // The diagram is in there.
  expect(raw).toContain("/Filter /DCTDecode");
  expect(raw).toContain("/Im1 Do");

  // And so is the prose, element by element, with its human-readable type and
  // its annotation.
  expect(raw).toContain("Anfrage pr\xFCfen");
  expect(raw).toContain("Die Sachbearbeitung pr\xFCft Vollst\xE4ndigkeit und Budget.");
  expect(raw).toContain("Service task");
  expect(raw).toContain("Note: Ben\xF6tigt IATA-Zugang");
  expect(raw).toContain("Freigabe durch die Leitung steht aus");

  // An element with nothing written about it says so, rather than appearing to
  // have been overlooked.
  expect(raw).toContain("No documentation.");
});

test("exporting publishes the document, the prose, and the source in one request", async ({ page }) => {
  const call = await page.evaluate(async () => {
    await window.__doc.exportDocumentation({
      modeler: window.__modeler, api: window.__api, title: "Reisebuchung", note: "Freigabe Q3",
    });
    const c = window.__apiCalls.at(-1);
    return {
      method: c.method, path: c.path,
      title: c.body.title, note: c.body.note, processName: c.body.processName,
      elementCount: c.body.elements.length,
      firstAnnotated: c.body.elements.find((e) => e.annotations.length > 0),
      xmlHasAnnotation: c.body.xml.includes("textAnnotation"),
      pdfHead: atob(c.body.pdfBase64).slice(0, 5),
      pdfBytes: atob(c.body.pdfBase64).length,
    };
  });

  expect(call.method).toBe("POST");
  expect(call.path).toBe("/api/v1/processes/reisebuchung/documentation");
  expect(call.title).toBe("Reisebuchung");
  expect(call.note).toBe("Freigabe Q3");
  expect(call.processName).toBe("Reisebuchung");
  expect(call.elementCount).toBeGreaterThan(4);

  // The element prose travels with the document, so the server's record can be
  // read without opening the PDF.
  expect(call.firstAnnotated.annotations).toEqual(["Benötigt IATA-Zugang"]);

  // The BPMN source is snapshotted too, so a reader of the history can recover
  // the exact model a version describes.
  expect(call.xmlHasAnnotation).toBe(true);

  // And the upload really is a PDF — the server refuses anything else.
  expect(call.pdfHead).toBe("%PDF-");
  expect(call.pdfBytes).toBeGreaterThan(5000);
});

test("a diagram with no process is refused rather than published empty", async ({ page }) => {
  const message = await page.evaluate(async () => {
    const fakeModeler = {
      get: () => { throw new Error("no registry"); },
      saveSVG: async () => ({ svg: "" }),
      saveXML: async () => ({ xml: "" }),
    };
    try {
      await window.__doc.exportDocumentation({ modeler: fakeModeler, api: window.__api });
      return "no error";
    } catch (e) { return e.message; }
  });
  expect(message).toContain("no process to document");
});
