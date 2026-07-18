import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildPdfString } from "../src/export/pdf.js";
import { pillow } from "../src/bagstyles/index.js";
import type { BagParams } from "../src/bagstyles/types.js";

const P: BagParams = { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10 };
const MM_TO_PT = 72 / 25.4;
const MARGIN = 12;

describe("PDF export", () => {
  const pdf = buildPdfString(pillow.dieline(P));

  it("is a well-formed PDF 1.4 document", () => {
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/Type /Catalog");
    expect(pdf).toContain("stream");
    expect(pdf).toContain("endstream");
    expect(pdf).toContain("trailer");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("has a MediaBox at true 1:1 mm scale", () => {
    const m = pdf.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    expect(m).toBeTruthy();
    const w = parseFloat(m![1]);
    const h = parseFloat(m![2]);
    expect(w).toBeCloseTo((300 + 2 * MARGIN) * MM_TO_PT, 1); // web + margins
    expect(h).toBeCloseTo((230 + 2 * MARGIN) * MM_TO_PT, 1); // cut + margins
  });

  it("declares Courier and embeds no font program (standard 14)", () => {
    expect(pdf).toContain("/BaseFont /Courier");
    expect(pdf).not.toContain("/FontFile");
  });

  it("has a valid xref table whose offsets point at object headers", () => {
    const startxref = pdf.match(/startxref\n(\d+)/);
    expect(startxref).toBeTruthy();
    const xrefPos = parseInt(startxref![1], 10);
    expect(pdf.slice(xrefPos, xrefPos + 4)).toBe("xref");

    // Parse the xref entries and confirm each in-use offset lands on "N 0 obj".
    const xrefBlock = pdf.slice(xrefPos);
    const entries = [...xrefBlock.matchAll(/^(\d{10}) (\d{5}) n $/gm)];
    expect(entries.length).toBeGreaterThanOrEqual(5);
    entries.forEach((e, i) => {
      const off = parseInt(e[1], 10);
      expect(pdf.slice(off).startsWith(`${i + 1} 0 obj`)).toBe(true);
    });
  });

  it("draws content (paths + text operators present)", () => {
    expect(pdf).toMatch(/ re\b/); // rectangles (seal zones)
    expect(pdf).toMatch(/ m\n?/); // moveto
    expect(pdf).toContain("Tj"); // text
    expect(pdf).toContain("WEB 300.0");
  });

  it("emits ASCII-only bytes", () => {
    // eslint-disable-next-line no-control-regex
    expect(pdf).toMatch(/^[\x00-\x7F]*$/);
  });

  it("is accepted by an independent PDF parser (pdf-lib)", async () => {
    const bytes = new Uint8Array([...pdf].map((c) => c.charCodeAt(0)));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeCloseTo((300 + 2 * MARGIN) * MM_TO_PT, 1);
    expect(page.getHeight()).toBeCloseTo((230 + 2 * MARGIN) * MM_TO_PT, 1);
  });
});
