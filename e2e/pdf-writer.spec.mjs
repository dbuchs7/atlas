// e2e for the dependency-free PDF writer behind the process documentation export
// (api/web/pdf.js, ADR-0138).
//
// A PDF is only a valid PDF if its cross-reference table points at the exact byte
// offset of every object. That is not something a unit test over strings can
// establish — it needs real bytes, produced by the real string encoding and the
// real canvas JPEG encoder. So these tests build documents in the browser and
// then parse the resulting file back, the way a reader would.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/pdf-writer-harness.html");
  await page.waitForFunction(() => window.__ready === true);
  page._errors = errors;
});

test.afterEach(async ({ page }) => {
  expect(page._errors, "no uncaught page errors").toEqual([]);
});

// parseXref pulls the cross-reference table out of a rendered file and returns
// the byte offset each object claims to be at.
function parseXref(raw) {
  const startxref = raw.lastIndexOf("startxref");
  expect(startxref, "the file has a startxref").toBeGreaterThan(-1);
  const xrefOffset = Number(raw.slice(startxref + 9).trim().split(/\s/)[0]);
  const table = raw.slice(xrefOffset);
  expect(table.startsWith("xref"), "startxref points at the xref table").toBe(true);
  const rows = table.split("\n").slice(2); // "xref", "0 N"
  const offsets = [];
  for (const row of rows) {
    const m = /^(\d{10}) (\d{5}) ([nf])/.exec(row);
    if (!m) break;
    if (m[3] === "n") offsets.push(Number(m[1]));
  }
  return offsets;
}

test("a document is a structurally valid PDF whose xref points at every object", async ({ page }) => {
  const raw = await page.evaluate(() => window.__asLatin1(window.__simpleDoc()));

  expect(raw.startsWith("%PDF-1.4"), "opens with the PDF header").toBe(true);
  expect(raw.trimEnd().endsWith("%%EOF"), "closes with %%EOF").toBe(true);

  // The heart of it: every offset in the table must land exactly on that
  // object's header. An off-by-one here produces a file readers reject.
  const offsets = parseXref(raw);
  expect(offsets.length, "the table lists objects").toBeGreaterThan(4);
  offsets.forEach((offset, i) => {
    const header = `${i + 1} 0 obj`;
    expect(raw.slice(offset, offset + header.length), `object ${i + 1} is at its declared offset`).toBe(header);
  });

  // The trailer's /Size must count the objects, plus the free entry at 0.
  const size = Number(/\/Size (\d+)/.exec(raw)[1]);
  expect(size).toBe(offsets.length + 1);

  // The catalog, page tree, both fonts, and the title are all present.
  expect(raw).toContain("/Type /Catalog");
  expect(raw).toContain("/BaseFont /Helvetica");
  expect(raw).toContain("/BaseFont /Helvetica-Bold");
  expect(raw).toContain("/WinAnsiEncoding");
});

test("German text is encoded so it renders, not as mojibake", async ({ page }) => {
  const raw = await page.evaluate(() => window.__asLatin1(window.__simpleDoc()));

  // "Übersicht" must appear with Ü as the single WinAnsi byte 0xDC, not as the
  // two UTF-8 bytes a naive encoder would emit.
  expect(raw).toContain("Übersicht");
  expect(raw).toContain("Größere Änderungen");

  // The mapping itself: a character WinAnsi cannot express degrades to '?'
  // rather than corrupting the file.
  const codes = await page.evaluate(() => window.__pdf.toWinAnsi("aä€中"));
  expect(codes).toEqual([0x61, 0xe4, 0x80, 0x3f]);
});

test("parentheses and backslashes in content are escaped", async ({ page }) => {
  // An unescaped ')' would terminate the string early and corrupt the page.
  const raw = await page.evaluate(() => {
    const doc = new window.__pdf.PdfDocument({ title: "x" });
    doc.paragraph("Zahlung (brutto) \\ netto");
    return window.__asLatin1(doc.bytes());
  });
  expect(raw).toContain("Zahlung \\(brutto\\) \\\\ netto");

  // And the file is still structurally intact with the escapes in place.
  const offsets = parseXref(raw);
  offsets.forEach((offset, i) => {
    expect(raw.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
  });
});

test("content longer than a page flows onto further pages", async ({ page }) => {
  const raw = await page.evaluate(() => window.__asLatin1(window.__longDoc()));

  const count = Number(/\/Count (\d+)/.exec(raw)[1]);
  expect(count, "200 paragraphs need several pages").toBeGreaterThan(3);

  // /Count must agree with the number of page objects and the /Kids list.
  const pageObjects = (raw.match(/\/Type \/Page[^s]/g) || []).length;
  expect(pageObjects).toBe(count);
  const kids = /\/Kids \[([^\]]*)\]/.exec(raw)[1].trim().split(/\s+0 R\s*/).filter(Boolean);
  expect(kids.length).toBe(count);

  // Every page carries its footer with its own number.
  expect(raw).toContain("1 / " + count);
  expect(raw).toContain(count + " / " + count);
});

test("a heading is not stranded at the foot of a page from what it introduces", async ({ page }) => {
  // Fill a page to within one line of the bottom, then start a section. The
  // heading must move to the next page with its body rather than sitting alone.
  const pages = await page.evaluate(() => {
    const doc = new window.__pdf.PdfDocument({ title: "t", footer: "f" });
    while (doc.y < doc.bottom - 70) doc.paragraph("filler");
    const before = doc.pages.length;
    doc.heading("Flug buchen", 3, { keep: 58 });
    const headingPage = doc.pages.length;
    doc.paragraph("Service task · id: Task_buchen");
    doc.paragraph("Ruft das Buchungssystem der Airline auf.");
    return { before, headingPage, after: doc.pages.length };
  });

  expect(pages.headingPage, "the heading broke to a new page").toBe(pages.before + 1);
  expect(pages.after, "and its body followed it there").toBe(pages.headingPage);
});

test("a diagram raster is embedded untranscoded and declared on its page", async ({ page }) => {
  const { raw, jpegHead, jpegLength } = await page.evaluate(async () => {
    const { bytes, jpeg } = await window.__docWithImage();
    return {
      raw: window.__asLatin1(bytes),
      jpegHead: Array.from(jpeg.slice(0, 4)),
      jpegLength: jpeg.length,
    };
  });

  // The image object declares the canvas dimensions and the DCTDecode filter,
  // which is what "embedded untranscoded" means: the JPEG bytes go in as-is.
  expect(raw).toContain("/Subtype /Image");
  expect(raw).toContain("/Width 400");
  expect(raw).toContain("/Height 300");
  expect(raw).toContain("/Filter /DCTDecode");
  expect(raw).toContain(`/Length ${jpegLength}`);

  // The declared length must match the bytes actually written, or every reader
  // desynchronizes at this object.
  const streamStart = raw.indexOf("stream\n", raw.indexOf("/DCTDecode")) + "stream\n".length;
  const embedded = raw.slice(streamStart, streamStart + 4).split("").map((c) => c.charCodeAt(0));
  expect(embedded, "the stream begins with the JPEG's own bytes").toEqual(jpegHead);
  expect(jpegHead.slice(0, 2), "and those bytes are a JPEG SOI marker").toEqual([0xff, 0xd8]);

  // The page must name the XObject it draws, or the image never appears.
  expect(raw).toMatch(/\/XObject << \/Im1 \d+ 0 R >>/);
  expect(raw).toContain("/Im1 Do");

  const offsets = parseXref(raw);
  offsets.forEach((offset, i) => {
    expect(raw.slice(offset, offset + `${i + 1} 0 obj`.length), `object ${i + 1} after a binary stream`).toBe(`${i + 1} 0 obj`);
  });
});

test("text wrapping fits the measured width and breaks unbreakable words", async ({ page }) => {
  const { lines, widths, longWord } = await page.evaluate(() => {
    const { wrapText, widthOf } = window.__pdf;
    const text = "Der Prozess beschreibt die Buchung einer Reise und die anschliessende Abrechnung.";
    const lines = wrapText(text, 10, 200, false);
    return {
      lines,
      widths: lines.map((l) => widthOf(l, 10, false)),
      longWord: wrapText("A".repeat(200), 10, 100, false),
    };
  });

  expect(lines.length).toBeGreaterThan(1);
  for (const w of widths) expect(w).toBeLessThanOrEqual(200);
  // Nothing is lost in the wrap.
  expect(lines.join(" ")).toContain("anschliessende Abrechnung.");
  // A word wider than the line is split rather than allowed to run off the page,
  // and the split loses no characters.
  expect(longWord.length).toBeGreaterThan(1);
  expect(longWord.join("")).toBe("A".repeat(200));
});

test("the finished document survives base64 encoding for upload", async ({ page }) => {
  const { b64, length } = await page.evaluate(() => {
    const bytes = window.__longDoc();
    return { b64: window.__pdf.bytesToBase64(bytes), length: bytes.length };
  });

  // Decoding it back must reproduce the file byte for byte — the server refuses
  // anything that does not open with the PDF header.
  const decoded = Buffer.from(b64, "base64");
  expect(decoded.length).toBe(length);
  expect(decoded.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(decoded.subarray(-6).toString("latin1").trim()).toBe("%%EOF");
});
