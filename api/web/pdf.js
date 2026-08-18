// A small, dependency-free PDF writer for the process documentation export
// (ADR-0138).
//
// Atlas does not vendor a general PDF library for this. What a process document
// needs is a narrow slice of PDF — pages, the two standard Helvetica faces,
// wrapped paragraphs, rules, and one embedded raster of the diagram — and the
// vendored bundles in this repository are already megabytes each. A focused
// writer we understand is cheaper to own than a general one we do not.
//
// The diagram is embedded as a JPEG with the DCTDecode filter, so its bytes go
// into the file exactly as the canvas produced them: no decompression, no
// re-encoding, no pixel handling in here at all.

const A4 = { width: 595.28, height: 841.89 };

// Standard-14 Helvetica advance widths for the printable ASCII range, in 1/1000
// em. Anything outside it (accented Latin-1, typographic punctuation) falls back
// to FALLBACK_WIDTH, which is the width of a lowercase letter — close enough for
// line breaking, which is the only thing these numbers are used for.
const FALLBACK_WIDTH = 556;
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// The cp1252 code points that are not Latin-1, keyed by their Unicode value.
// WinAnsiEncoding is Adobe's name for cp1252, so a document written this way
// renders German umlauts, the euro sign, and typographic dashes and quotes
// correctly rather than as mojibake.
const CP1252_EXTRAS = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

// toWinAnsi maps a JS string to the byte codes a WinAnsiEncoding font expects.
// A character the encoding cannot represent becomes '?' rather than a broken
// glyph or a corrupt file.
export function toWinAnsi(text) {
  const out = [];
  for (const ch of String(text ?? "")) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a || cp === 0x0d || cp === 0x09) { out.push(0x20); continue; }
    if (cp >= 0x20 && cp <= 0x7e) { out.push(cp); continue; }
    if (cp >= 0xa0 && cp <= 0xff) { out.push(cp); continue; }
    const mapped = CP1252_EXTRAS.get(cp);
    out.push(mapped === undefined ? 0x3f : mapped);
  }
  return out;
}

// widthOf returns the rendered width of a string at a given size, in points.
export function widthOf(text, size, bold) {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let mille = 0;
  for (const code of toWinAnsi(text)) {
    mille += code >= 32 && code <= 126 ? table[code - 32] : FALLBACK_WIDTH;
  }
  return (mille * size) / 1000;
}

// wrapText breaks a string into lines that fit maxWidth. A single word longer
// than the line (a URL, a long identifier) is split rather than allowed to run
// off the page.
export function wrapText(text, size, maxWidth, bold) {
  const lines = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line ? line + " " + word : word;
      if (widthOf(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
      if (line) { lines.push(line); line = ""; }
      // The word alone may still be too wide; break it at the last character
      // that fits and carry the rest.
      let rest = word;
      while (widthOf(rest, size, bold) > maxWidth) {
        let cut = 1;
        while (cut < rest.length && widthOf(rest.slice(0, cut + 1), size, bold) <= maxWidth) cut++;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) lines.push(line);
  }
  return lines;
}

// escapePdfString escapes the three characters a PDF literal string reserves.
function escapePdfString(codes) {
  let out = "";
  for (const code of codes) {
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += "\\";
    out += String.fromCharCode(code);
  }
  return out;
}

// latin1Bytes encodes a "binary string" — one whose char codes are all bytes —
// into the Uint8Array that goes into the file.
function latin1Bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const num = (n) => (Math.round(n * 100) / 100).toString();

// PdfDocument lays out a document top-down: every call appends below what came
// before, and the page breaks on its own when the content reaches the bottom
// margin. That is the whole model — there is no positioning API, because a
// documentation export never needs one.
export class PdfDocument {
  constructor(opts = {}) {
    this.width = opts.width ?? A4.width;
    this.height = opts.height ?? A4.height;
    this.margin = opts.margin ?? 56;
    this.title = opts.title ?? "";
    this.footer = opts.footer ?? "";
    this.pages = [];
    this.images = [];
    this.y = 0;
    this.newPage();
  }

  get contentWidth() { return this.width - 2 * this.margin; }

  // bottom is the y past which content must break to a new page. Everything that
  // decides about a break reads it, so a widow check and the break it is trying
  // to predict can never disagree.
  get bottom() { return this.height - this.margin - (this.footer ? 18 : 0); }

  newPage() {
    this.current = { ops: [], images: [] };
    this.pages.push(this.current);
    this.y = this.margin;
    return this.current;
  }

  // space reserves vertical room, breaking to a new page when the block would
  // cross the bottom margin.
  space(h) {
    if (this.y + h > this.bottom) this.newPage();
    const top = this.y;
    this.y += h;
    return top;
  }

  // text draws one line at the current cursor. Callers wrap first.
  text(line, { size = 10, bold = false, color = [0, 0, 0], indent = 0 } = {}) {
    const top = this.space(size * 1.35);
    const baseline = this.height - top - size;
    const font = bold ? "/F2" : "/F1";
    const [r, g, b] = color;
    this.current.ops.push(
      `BT ${num(r)} ${num(g)} ${num(b)} rg ${font} ${num(size)} Tf ` +
      `1 0 0 1 ${num(this.margin + indent)} ${num(baseline)} Tm ` +
      `(${escapePdfString(toWinAnsi(line))}) Tj ET`,
    );
  }

  paragraph(text, opts = {}) {
    const size = opts.size ?? 10;
    const indent = opts.indent ?? 0;
    const lines = wrapText(text, size, this.contentWidth - indent, opts.bold ?? false);
    for (const line of lines) this.text(line, { ...opts, size, indent });
    if (opts.after !== 0) this.y += opts.after ?? 4;
  }

  // reserve breaks to a new page unless `points` of vertical space are left. It
  // is how a caller keeps a block together: only the caller knows how much of
  // what follows must stay with what it is about to write.
  reserve(points) {
    if (this.y + points > this.bottom) this.newPage();
  }

  // heading writes a section title. `keep` is the height of the block that must
  // not be orphaned from it — pass what the section actually needs; the default
  // holds the title with two following lines.
  heading(text, level = 1, { keep } = {}) {
    const size = level === 1 ? 18 : level === 2 ? 13 : 11;
    this.y += level === 1 ? 6 : 10;
    this.reserve(keep ?? size * 1.35 + 2 * 13.5);
    this.paragraph(text, { size, bold: true, after: level === 1 ? 8 : 4 });
  }

  rule({ color = [0.85, 0.85, 0.85] } = {}) {
    const top = this.space(8);
    const y = this.height - top - 4;
    const [r, g, b] = color;
    this.current.ops.push(
      `${num(r)} ${num(g)} ${num(b)} RG 0.7 w ` +
      `${num(this.margin)} ${num(y)} m ${num(this.width - this.margin)} ${num(y)} l S`,
    );
  }

  // keyValue renders a label/value row, the shape the metadata block uses.
  keyValue(label, value) {
    const labelWidth = 120;
    const size = 9.5;
    const lines = wrapText(value, size, this.contentWidth - labelWidth, false);
    const top = this.space(Math.max(1, lines.length) * size * 1.35);
    let baseline = this.height - top - size;
    this.current.ops.push(
      `BT 0.4 0.4 0.4 rg /F1 ${num(size)} Tf 1 0 0 1 ${num(this.margin)} ${num(baseline)} Tm ` +
      `(${escapePdfString(toWinAnsi(label))}) Tj ET`,
    );
    for (const line of lines) {
      this.current.ops.push(
        `BT 0 0 0 rg /F1 ${num(size)} Tf 1 0 0 1 ${num(this.margin + labelWidth)} ${num(baseline)} Tm ` +
        `(${escapePdfString(toWinAnsi(line))}) Tj ET`,
      );
      baseline -= size * 1.35;
    }
  }

  // image places a JPEG, scaled to fit the content width and the space left on
  // the page while keeping its aspect ratio. jpeg is a Uint8Array of the encoded
  // bytes; they are embedded untranscoded (DCTDecode).
  image(jpeg, pixelWidth, pixelHeight) {
    const maxWidth = this.contentWidth;
    const maxHeight = this.height - 2 * this.margin;
    const scale = Math.min(maxWidth / pixelWidth, maxHeight / pixelHeight, 1);
    let w = pixelWidth * scale;
    let h = pixelHeight * scale;
    // If it cannot fit in what is left of this page, start a fresh one rather
    // than shrinking the diagram to a stamp.
    if (this.y + h > this.bottom) {
      this.newPage();
      const fit = Math.min(maxWidth / pixelWidth, (this.bottom - this.margin) / pixelHeight, 1);
      w = pixelWidth * fit;
      h = pixelHeight * fit;
    }
    const top = this.space(h);
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, data: jpeg, width: pixelWidth, height: pixelHeight });
    this.current.images.push(name);
    const x = this.margin + (maxWidth - w) / 2;
    const y = this.height - top - h;
    this.current.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /${name} Do Q`);
    this.y += 6;
  }

  pageBreak() { this.newPage(); }

  // stampFooters writes the running footer and page numbers. Called once at
  // build time, when the total page count is finally known.
  stampFooters() {
    if (!this.footer) return;
    const size = 8;
    this.pages.forEach((page, i) => {
      const label = `${this.footer}  ·  ${i + 1} / ${this.pages.length}`;
      const y = this.margin / 2 + 4;
      page.ops.push(
        `BT 0.45 0.45 0.45 rg /F1 ${num(size)} Tf 1 0 0 1 ${num(this.margin)} ${num(y)} Tm ` +
        `(${escapePdfString(toWinAnsi(label))}) Tj ET`,
      );
    });
  }

  // bytes serializes the document. Objects are laid out in a fixed order so the
  // cross-reference table can be built from the running byte offset of each one.
  bytes() {
    this.stampFooters();
    const chunks = [];
    let offset = 0;
    const push = (data) => {
      const bin = typeof data === "string" ? latin1Bytes(data) : data;
      chunks.push(bin);
      offset += bin.length;
    };

    // A binary comment on line 2 marks the file as binary for tools that sniff.
    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    const objects = []; // 1-based; objects[i] = byte offset of object i+1
    const startObject = (n) => { objects[n - 1] = offset; push(`${n} 0 obj\n`); };
    const endObject = () => push("endobj\n");

    const pageCount = this.pages.length;
    const firstPageObj = 6;
    const firstContentObj = firstPageObj + pageCount;
    const firstImageObj = firstContentObj + pageCount;
    const totalObjects = firstImageObj + this.images.length - 1;

    // 1 Catalog
    startObject(1);
    push("<< /Type /Catalog /Pages 2 0 R >>\n");
    endObject();

    // 2 Pages
    const kids = this.pages.map((_, i) => `${firstPageObj + i} 0 R`).join(" ");
    startObject(2);
    push(`<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>\n`);
    endObject();

    // 3, 4 Fonts
    startObject(3);
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n");
    endObject();
    startObject(4);
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\n");
    endObject();

    // 5 Info
    startObject(5);
    push(`<< /Title (${escapePdfString(toWinAnsi(this.title))}) /Producer (Atlas) /Creator (Atlas) >>\n`);
    endObject();

    // Pages, each naming the fonts and only the images it actually draws.
    const imageObjNumber = new Map();
    this.images.forEach((img, i) => imageObjNumber.set(img.name, firstImageObj + i));
    this.pages.forEach((page, i) => {
      const xobjects = page.images.length
        ? ` /XObject << ${page.images.map((n) => `/${n} ${imageObjNumber.get(n)} 0 R`).join(" ")} >>`
        : "";
      startObject(firstPageObj + i);
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects} >> ` +
        `/Contents ${firstContentObj + i} 0 R >>\n`,
      );
      endObject();
    });

    // Content streams.
    this.pages.forEach((page, i) => {
      const body = page.ops.join("\n") + "\n";
      startObject(firstContentObj + i);
      push(`<< /Length ${latin1Bytes(body).length} >>\nstream\n`);
      push(body);
      push("endstream\n");
      endObject();
    });

    // Images, embedded untranscoded.
    this.images.forEach((img, i) => {
      startObject(firstImageObj + i);
      push(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>\n` +
        "stream\n",
      );
      push(img.data);
      push("\nendstream\n");
      endObject();
    });

    // Cross-reference table and trailer.
    const xrefOffset = offset;
    let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= totalObjects; i++) {
      xref += String(objects[i - 1] ?? 0).padStart(10, "0") + " 00000 n \n";
    }
    push(xref);
    push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const out = new Uint8Array(offset);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    return out;
  }
}

// bytesToBase64 encodes the finished document for the JSON upload. It chunks the
// input because String.fromCharCode applied to a whole multi-megabyte document at
// once overflows the call stack.
export function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
