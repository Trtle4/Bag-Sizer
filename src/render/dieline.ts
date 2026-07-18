/**
 * SVG renderer for the dieline. Consumes the structured DielineModel produced by
 * a BagStyle and emits SVG — both into a live DOM element and as a standalone
 * string for export. Layer semantics (CUT / CREASE / ANNO) are preserved as SVG
 * group classes so the same model drives the phase-2 DXF/PDF exporters.
 */

import type { DielineModel, DielineEntity, Pt } from "../bagstyles/types.js";
import { fmt1 } from "../geometry/index.js";

const MARGIN = 74;

export interface RenderedDieline {
  /** Full standalone <svg> string (fonts referenced, styles inlined). */
  svg: string;
  /** Inner markup only (no <svg> wrapper). */
  inner: string;
  viewBox: string;
  width: number;
  height: number;
}

const DEFS = `
  <defs>
    <pattern id="dl-hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="7" stroke="#C4CCD1" stroke-width="1.1"/>
    </pattern>
    <marker id="dl-ar" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M1,1 L8,4.5 L1,8" fill="none" stroke="#59656C" stroke-width="1.1"/>
    </marker>
    <marker id="dl-arr" markerWidth="9" markerHeight="9" refX="2" refY="4.5" orient="auto">
      <path d="M8,1 L1,4.5 L8,8" fill="none" stroke="#59656C" stroke-width="1.1"/>
    </marker>
  </defs>`;

const STYLE = `
  <style>
    .dl-dim{font-family:"DM Mono",ui-monospace,monospace;font-size:11px;fill:#59656C;font-weight:500}
    .dl-lab{font-family:"DM Mono",ui-monospace,monospace;font-size:10px;fill:#8A959B;letter-spacing:.12em}
    .dl-lab.b{fill:#59656C}
  </style>`;

export function renderDieline(model: DielineModel): RenderedDieline {
  const sc = Math.min(640 / model.web, 520 / model.cut, 2.2);
  const px = (v: number) => v * sc;
  const P = (p: Pt) => ({ x: MARGIN + p.x * sc, y: MARGIN + p.y * sc });
  const W = px(model.web);
  const H = px(model.cut);
  const vbW = W + MARGIN * 2;
  const vbH = H + MARGIN * 2;
  const viewBox = `0 0 ${vbW} ${vbH}`;

  const parts: string[] = [];
  parts.push(`<rect x="${MARGIN}" y="${MARGIN}" width="${W}" height="${H}" fill="#FBFCFD"/>`);

  // Draw order: seals → perimeter → creases → marks → labels → dims.
  const order: DielineEntity["kind"][] = [
    "sealZone",
    "perimeter",
    "fold",
    "mark",
    "label",
    "dimension",
  ];
  for (const kind of order) {
    for (const e of model.entities) {
      if (e.kind !== kind) continue;
      parts.push(renderEntity(e, model, P, px));
    }
  }

  const inner = DEFS + parts.join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${STYLE}${inner}</svg>`;
  return { svg, inner: STYLE + inner, viewBox, width: vbW, height: vbH };
}

function renderEntity(
  e: DielineEntity,
  model: DielineModel,
  P: (p: Pt) => Pt,
  px: (v: number) => number,
): string {
  switch (e.kind) {
    case "sealZone": {
      const a = P({ x: e.x, y: e.y });
      return `<rect x="${a.x}" y="${a.y}" width="${px(e.w)}" height="${px(e.h)}" fill="url(#dl-hatch)" stroke="#C9D1D6" stroke-width="1"/>`;
    }
    case "perimeter": {
      const d = e.pts.map((p, i) => `${i === 0 ? "M" : "L"}${fmtN(P(p).x)},${fmtN(P(p).y)}`).join(" ") + " Z";
      return `<path class="dl-cut" d="${d}" fill="none" stroke="#192227" stroke-width="1.6"/>`;
    }
    case "fold": {
      const a = P(e.a);
      const b = P(e.b);
      return `<line class="dl-crease" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#0F6E77" stroke-width="1" stroke-dasharray="8 4 2 4" opacity=".65"/>`;
    }
    case "mark": {
      const a = P({ x: e.x, y: e.y });
      const w = px(e.w);
      const hh = px(e.h);
      const label = e.label
        ? `<text class="dl-lab" x="${a.x - 6}" y="${a.y + hh - 2}" text-anchor="end">${e.label}</text>`
        : "";
      return `<rect x="${a.x}" y="${a.y}" width="${w}" height="${hh}" fill="#192227"/>${label}`;
    }
    case "label": {
      const a = P(e.at);
      const cls = e.role === "panelBig" ? "dl-lab b" : "dl-lab";
      return `<text class="${cls}" x="${a.x}" y="${a.y + 3.5}" text-anchor="${e.anchor}">${e.text}</text>`;
    }
    case "dimension":
      return renderDimension(e, model, P);
  }
}

function renderDimension(
  e: Extract<DielineEntity, { kind: "dimension" }>,
  model: DielineModel,
  P: (p: Pt) => Pt,
): string {
  const a = P(e.a);
  const b = P(e.b);
  const chip = (cx: number, cy: number, text: string, rot = 0) => {
    const wChip = Math.max(52, text.length * 7 + 12);
    const g = rot ? ` transform="rotate(${rot} ${cx} ${cy})"` : "";
    return `<g${g}><rect x="${cx - wChip / 2}" y="${cy - 9}" width="${wChip}" height="16" fill="#E9EDF0" opacity=".92"/><text class="dl-dim" x="${cx}" y="${cy + 3.5}" text-anchor="middle">${text}</text></g>`;
  };
  const arrowLine = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#59656C" stroke-width="1" marker-start="url(#dl-arr)" marker-end="url(#dl-ar)"/>`;
  const ext = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#8A959B" stroke-width="1"/>`;

  if (e.axis === "h") {
    const top = e.a.y < model.cut / 2;
    const off = top ? -26 : 32;
    const y = a.y + off;
    const parts = [
      ext(a.x, a.y + (top ? -6 : 6), a.x, y + (top ? 8 : -8)),
      ext(b.x, b.y + (top ? -6 : 6), b.x, y + (top ? 8 : -8)),
      arrowLine(a.x, y, b.x, y),
      chip((a.x + b.x) / 2, y, e.text),
    ];
    return parts.join("");
  }

  // vertical
  const right = e.a.x > model.web / 2;
  const span = Math.abs(b.y - a.y);
  if (!right && span < 30) {
    // Compact left-side label (e.g. end seal band).
    const x = a.x - 24;
    return (
      ext(a.x - 6, a.y, a.x - 30, a.y) +
      ext(b.x - 6, b.y, b.x - 30, b.y) +
      `<line x1="${x}" y1="${a.y}" x2="${x}" y2="${b.y}" stroke="#59656C" stroke-width="1"/>` +
      `<text class="dl-dim" x="${x - 6}" y="${(a.y + b.y) / 2 + 3.5}" text-anchor="end">${e.text}</text>`
    );
  }
  const x = right ? a.x + 34 : a.x - 34;
  const cx = x;
  const cy = (a.y + b.y) / 2;
  return (
    ext(a.x + (right ? 6 : -6), a.y, x + (right ? -8 : 8), a.y) +
    ext(b.x + (right ? 6 : -6), b.y, x + (right ? -8 : 8), b.y) +
    arrowLine(x, a.y, x, b.y) +
    chip(cx, cy, e.text, -90)
  );
}

function fmtN(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "0";
}

/** Convenience filename stem from bag dims. */
export function dielineName(model: DielineModel, bagW: number, bagL: number, ext: string): string {
  return `${model.style}_dieline_${fmt1(bagW)}x${fmt1(bagL)}.${ext}`;
}
