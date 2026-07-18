/**
 * PDF exporter — vector dieline at true 1:1 mm print scale.
 *
 * Hand-rolled minimal PDF 1.4: one page, one uncompressed content stream, the
 * standard Courier font (monospace, always available — no embedding, pure
 * ASCII). The geometry is the point of this export, drawn at exact millimetre
 * scale so a print measures 1:1. Text is set in Courier as a monospace stand-in
 * for DM Mono; swap to an embedded font later if exact type is required.
 *
 * Consumes the shared DielineModel. Model space is y-down/top-left; PDF is
 * y-up/bottom-left, so y is flipped here.
 */

import type { DielineModel, DielineEntity, Pt } from "../bagstyles/types.js";

const MM_TO_PT = 72 / 25.4;
const MARGIN_MM = 12;
const COURIER_W = 0.6; // Courier advance width per em

type RGB = [number, number, number];
const INK: RGB = [0.098, 0.133, 0.153];
const INK2: RGB = [0.349, 0.396, 0.424];
const INK3: RGB = [0.541, 0.584, 0.608];
const ACCENT: RGB = [0.059, 0.431, 0.467];
const SEAL: RGB = [0.86, 0.878, 0.886];

interface Ctx {
  ops: string[];
  S: number; // mm → pt
  cut: number;
}

export function buildPdfString(model: DielineModel): string {
  const S = MM_TO_PT;
  const pageW = (model.web + 2 * MARGIN_MM) * S;
  const pageH = (model.cut + 2 * MARGIN_MM) * S;

  const ctx: Ctx = { ops: [], S, cut: model.cut };
  const order: DielineEntity["kind"][] = [
    "sealZone",
    "perimeter",
    "fold",
    "mark",
    "label",
    "dimension",
  ];
  for (const kind of order) {
    for (const e of model.entities) if (e.kind === kind) drawEntity(ctx, e, model);
  }
  const content = ctx.ops.join("\n");

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageW)} ${num(pageH)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`,
  ];

  let pdf = `%PDF-1.4\n`;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += `0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}

export function buildPdfBlob(model: DielineModel): Blob {
  return new Blob([buildPdfString(model)], { type: "application/pdf" });
}

// ---- drawing ----

function pt(ctx: Ctx, p: Pt): [number, number] {
  return [(MARGIN_MM + p.x) * ctx.S, (MARGIN_MM + (ctx.cut - p.y)) * ctx.S];
}
function num(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}
function stroke(c: RGB): string {
  return `${num(c[0])} ${num(c[1])} ${num(c[2])} RG`;
}
function fill(c: RGB): string {
  return `${num(c[0])} ${num(c[1])} ${num(c[2])} rg`;
}

function rectPath(ctx: Ctx, x: number, y: number, w: number, h: number): string {
  const [x0, y0] = pt(ctx, { x, y });
  const [x1, y1] = pt(ctx, { x: x + w, y: y + h });
  const X = Math.min(x0, x1);
  const Y = Math.min(y0, y1);
  return `${num(X)} ${num(Y)} ${num(Math.abs(x1 - x0))} ${num(Math.abs(y1 - y0))} re`;
}

function drawEntity(ctx: Ctx, e: DielineEntity, model: DielineModel): void {
  const o = ctx.ops;
  switch (e.kind) {
    case "sealZone":
      o.push("q", fill(SEAL), rectPath(ctx, e.x, e.y, e.w, e.h), "f", "Q");
      return;
    case "perimeter": {
      o.push("q", stroke(INK), "0.6 w");
      e.pts.forEach((p, i) => {
        const [x, y] = pt(ctx, p);
        o.push(`${num(x)} ${num(y)} ${i === 0 ? "m" : "l"}`);
      });
      o.push("h", "S", "Q");
      return;
    }
    case "fold": {
      const [x1, y1] = pt(ctx, e.a);
      const [x2, y2] = pt(ctx, e.b);
      o.push("q", stroke(ACCENT), "0.5 w", "[4 2 1 2] 0 d");
      o.push(`${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
      o.push("Q");
      return;
    }
    case "mark":
      o.push("q", fill(INK), rectPath(ctx, e.x, e.y, e.w, e.h), "f", "Q");
      if (e.label) textAt(ctx, { x: e.x - 2, y: e.y + e.h + 1 }, e.label, 2.4, INK3, "end");
      return;
    case "label": {
      const size = e.role === "panelBig" ? 3.2 : e.role === "seal" ? 2.6 : 3.0;
      const col = e.role === "panelBig" ? INK2 : INK3;
      textAt(ctx, e.at, e.text, size, col, e.anchor);
      return;
    }
    case "dimension":
      drawDimension(ctx, e, model);
      return;
  }
}

/** Draw text with Courier metrics. `at` is the model-space anchor; anchor sets horizontal alignment. */
function textAt(
  ctx: Ctx,
  at: Pt,
  text: string,
  sizeMm: number,
  col: RGB,
  anchor: "start" | "middle" | "end",
  rotate = 0,
): void {
  const s = sanitize(text);
  const size = sizeMm * ctx.S;
  const [x, y] = pt(ctx, at);
  const w = s.length * COURIER_W * size;
  const dx = anchor === "middle" ? -w / 2 : anchor === "end" ? -w : 0;
  // Vertical-centre the baseline against the anchor point.
  const dy = -size * 0.35;
  ctx.ops.push("BT", `/F1 ${num(size)} Tf`, fill(col));
  if (rotate === 90) {
    // rotate about (x,y): text runs upward; offset along its own axis by dx/dy
    ctx.ops.push(`0 1 -1 0 ${num(x - dy)} ${num(y + dx)} Tm`);
  } else {
    ctx.ops.push(`1 0 0 1 ${num(x + dx)} ${num(y + dy)} Tm`);
  }
  ctx.ops.push(`(${esc(s)}) Tj`, "ET");
}

function drawDimension(
  ctx: Ctx,
  e: Extract<DielineEntity, { kind: "dimension" }>,
  model: DielineModel,
): void {
  const OFF = 8; // mm offset of the dim line off the blank
  const EXT = 2; // mm extension-line gap
  const o = ctx.ops;
  const dimLine = (a: Pt, b: Pt) => {
    const [x1, y1] = pt(ctx, a);
    const [x2, y2] = pt(ctx, b);
    o.push("q", stroke(INK2), "0.4 w", `${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
    arrow(ctx, a, b);
    arrow(ctx, b, a);
    o.push("Q");
  };
  const extLine = (a: Pt, b: Pt) => {
    const [x1, y1] = pt(ctx, a);
    const [x2, y2] = pt(ctx, b);
    o.push("q", stroke(INK3), "0.3 w", `${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`, "Q");
  };

  if (e.axis === "h") {
    const top = e.a.y < model.cut / 2;
    const yLine = top ? e.a.y - OFF : e.a.y + OFF;
    const a = { x: e.a.x, y: yLine };
    const b = { x: e.b.x, y: yLine };
    extLine({ x: e.a.x, y: e.a.y + (top ? -EXT : EXT) }, a);
    extLine({ x: e.b.x, y: e.b.y + (top ? -EXT : EXT) }, b);
    dimLine(a, b);
    textAt(ctx, { x: (a.x + b.x) / 2, y: yLine - 1.5 }, e.text, 3.0, INK2, "middle");
  } else {
    const right = e.a.x > model.web / 2;
    const xLine = right ? e.a.x + OFF : e.a.x - OFF;
    const a = { x: xLine, y: e.a.y };
    const b = { x: xLine, y: e.b.y };
    extLine({ x: e.a.x + (right ? EXT : -EXT), y: e.a.y }, a);
    extLine({ x: e.b.x + (right ? EXT : -EXT), y: e.b.y }, b);
    dimLine(a, b);
    textAt(ctx, { x: xLine, y: (a.y + b.y) / 2 }, e.text, 3.0, INK2, "middle", 90);
  }
}

/** Small filled arrowhead at `tip`, pointing from `from` → `tip`. */
function arrow(ctx: Ctx, tip: Pt, from: Pt): void {
  const [tx, ty] = pt(ctx, tip);
  const [fx, fy] = pt(ctx, from);
  const ang = Math.atan2(ty - fy, tx - fx);
  const L = 5;
  const wsp = 0.35;
  const p1x = tx - L * Math.cos(ang - wsp);
  const p1y = ty - L * Math.sin(ang - wsp);
  const p2x = tx - L * Math.cos(ang + wsp);
  const p2y = ty - L * Math.sin(ang + wsp);
  ctx.ops.push(
    fill(INK2),
    `${num(tx)} ${num(ty)} m ${num(p1x)} ${num(p1y)} l ${num(p2x)} ${num(p2y)} l h f`,
  );
}

function sanitize(s: string): string {
  return s.replace(/½/g, "1/2").replace(/⌀/g, "DIA").replace(/×/g, "x");
}
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
