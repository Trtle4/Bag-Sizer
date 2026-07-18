/**
 * DXF R12 (AC1009) exporter for a cutting table (Kongsberg).
 *
 * Constraints, per the shop requirements:
 *   - Strict R12: POLYLINE/VERTEX/SEQEND (LWPOLYLINE is R13+), LINE, TEXT.
 *   - No splines.
 *   - Millimetres, y-up, bottom-left origin.
 *   - Layer conventions: CUT (perimeter, closed polylines), CREASE (fold lines),
 *     ANNO (dims/labels/seal zones — strippable).
 *
 * Consumes the same structured DielineModel the SVG/PDF renderers use.
 */

import type { DielineModel, DielineEntity, Layer, Pt } from "../bagstyles/types.js";

// AutoCAD Color Index per layer.
const LAYER_COLOR: Record<Layer, number> = { CUT: 7, CREASE: 4, ANNO: 8 };
const TEXT_H = { dim: 3.2, panel: 3.0, seal: 2.6 };

class DxfWriter {
  private out: string[] = [];
  pair(code: number, value: string | number): void {
    this.out.push(String(code));
    this.out.push(typeof value === "number" ? fmtNum(value) : value);
  }
  toString(): string {
    return this.out.join("\r\n") + "\r\n";
  }
}

/** Map model space (y-down, origin top-left) to DXF space (y-up, bottom-left). */
function mapPt(p: Pt, cut: number): [number, number] {
  return [p.x, cut - p.y];
}

export function buildDxf(model: DielineModel): string {
  const w = new DxfWriter();
  const cut = model.cut;

  // ---- HEADER ----
  w.pair(0, "SECTION");
  w.pair(2, "HEADER");
  w.pair(9, "$ACADVER");
  w.pair(1, "AC1009");
  w.pair(9, "$INSUNITS");
  w.pair(70, 4); // millimetres
  w.pair(9, "$EXTMIN");
  w.pair(10, 0);
  w.pair(20, 0);
  w.pair(9, "$EXTMAX");
  w.pair(10, model.web);
  w.pair(20, cut);
  w.pair(0, "ENDSEC");

  // ---- TABLES (layers) ----
  w.pair(0, "SECTION");
  w.pair(2, "TABLES");
  w.pair(0, "TABLE");
  w.pair(2, "LAYER");
  w.pair(70, 3);
  for (const layer of ["CUT", "CREASE", "ANNO"] as Layer[]) {
    w.pair(0, "LAYER");
    w.pair(2, layer);
    w.pair(70, 0);
    w.pair(62, LAYER_COLOR[layer]);
    w.pair(6, "CONTINUOUS");
  }
  w.pair(0, "ENDTAB");
  w.pair(0, "ENDSEC");

  // ---- ENTITIES ----
  w.pair(0, "SECTION");
  w.pair(2, "ENTITIES");
  for (const e of model.entities) writeEntity(w, e, cut);
  w.pair(0, "ENDSEC");

  w.pair(0, "EOF");
  return w.toString();
}

function polyline(w: DxfWriter, layer: Layer, pts: Pt[], closed: boolean, cut: number): void {
  w.pair(0, "POLYLINE");
  w.pair(8, layer);
  w.pair(66, 1); // vertices follow (required in R12)
  w.pair(70, closed ? 1 : 0);
  for (const p of pts) {
    const [x, y] = mapPt(p, cut);
    w.pair(0, "VERTEX");
    w.pair(8, layer);
    w.pair(10, x);
    w.pair(20, y);
  }
  w.pair(0, "SEQEND");
  w.pair(8, layer);
}

function line(w: DxfWriter, layer: Layer, a: Pt, b: Pt, cut: number): void {
  const [x1, y1] = mapPt(a, cut);
  const [x2, y2] = mapPt(b, cut);
  w.pair(0, "LINE");
  w.pair(8, layer);
  w.pair(10, x1);
  w.pair(20, y1);
  w.pair(11, x2);
  w.pair(21, y2);
}

function text(
  w: DxfWriter,
  layer: Layer,
  at: Pt,
  height: number,
  value: string,
  halign: 0 | 1 | 2,
  cut: number,
  rotation = 0,
): void {
  const [x, y] = mapPt(at, cut);
  w.pair(0, "TEXT");
  w.pair(8, layer);
  w.pair(10, x);
  w.pair(20, y);
  w.pair(40, height);
  w.pair(1, sanitizeText(value));
  if (rotation) w.pair(50, rotation);
  if (halign !== 0) {
    w.pair(72, halign);
    w.pair(11, x);
    w.pair(21, y);
  }
}

function writeEntity(w: DxfWriter, e: DielineEntity, cut: number): void {
  switch (e.kind) {
    case "perimeter":
      polyline(w, "CUT", e.pts, true, cut);
      return;
    case "fold":
      line(w, "CREASE", e.a, e.b, cut);
      return;
    case "sealZone":
      polyline(
        w,
        "ANNO",
        [
          { x: e.x, y: e.y },
          { x: e.x + e.w, y: e.y },
          { x: e.x + e.w, y: e.y + e.h },
          { x: e.x, y: e.y + e.h },
        ],
        true,
        cut,
      );
      return;
    case "mark":
      polyline(
        w,
        "ANNO",
        [
          { x: e.x, y: e.y },
          { x: e.x + e.w, y: e.y },
          { x: e.x + e.w, y: e.y + e.h },
          { x: e.x, y: e.y + e.h },
        ],
        true,
        cut,
      );
      if (e.label) text(w, "ANNO", { x: e.x - 2, y: e.y + e.h }, TEXT_H.seal, e.label, 2, cut);
      return;
    case "label": {
      const h = e.role === "panelBig" ? TEXT_H.panel + 0.6 : e.role === "seal" ? TEXT_H.seal : TEXT_H.panel;
      const halign = e.anchor === "middle" ? 1 : e.anchor === "end" ? 2 : 0;
      // DXF TEXT y is the baseline; nudge down so it centres like the SVG.
      text(w, "ANNO", { x: e.at.x, y: e.at.y + h / 2 }, h, e.text, halign, cut);
      return;
    }
    case "dimension": {
      // Dimension line between the two anchor points + the value as centred text.
      line(w, "ANNO", e.a, e.b, cut);
      const mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
      const rot = e.axis === "v" ? 90 : 0;
      text(w, "ANNO", mid, TEXT_H.dim, e.text, 1, cut, rot);
      return;
    }
  }
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "0";
  // 6 dp is ample at mm scale; trim trailing zeros.
  return (Math.round(v * 1e6) / 1e6).toString();
}

/** DXF R12 strings are ASCII; drop non-ASCII (e.g. ½, ⌀) to safe equivalents. */
function sanitizeText(s: string): string {
  return s
    .replace(/½/g, "1/2")
    .replace(/⌀/g, "DIA")
    .replace(/×/g, "x")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7F]/g, "");
}
