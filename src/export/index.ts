/**
 * Exporters — all driven from the same structured DielineModel / AppState the UI
 * renders. Dieline: SVG, PNG, PDF (1:1 mm), DXF (R12 polylines, CUT/CREASE/ANNO
 * layers). Spec sheet: TXT and CSV.
 */

import type { DielineModel } from "../bagstyles/types.js";
import { renderDieline, dielineName } from "../render/dieline.js";
import { buildDxf } from "./dxf.js";
import { buildPdfBlob } from "./pdf.js";
import {
  webWidth,
  cutoffLength,
  stiffLabel,
  fmt1,
  headspace as headspaceOf,
  innerLength,
} from "../geometry/index.js";
import { fillCount, fillWeight, prodDims, type AppState } from "../state.js";
import type { Measurements } from "../physics/world.js";
import { PART_TAG } from "../constants.js";

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 400);
}

export function exportDielineSvg(model: DielineModel, bagW: number, bagL: number): void {
  const { svg } = renderDieline(model);
  downloadBlob(new Blob([svg], { type: "image/svg+xml" }), dielineName(model, bagW, bagL, "svg"));
}

export function exportDielinePng(
  model: DielineModel,
  bagW: number,
  bagL: number,
  dpi = 300,
): void {
  const { svg, width, height, scale } = renderDieline(model);
  // Raster factor so the artwork rasterizes at the requested print DPI:
  // px per mm = dpi/25.4; SVG units per mm = scale.
  let raster = dpi / 25.4 / scale;
  // Clamp so an extreme DPI on a large bag can't allocate a runaway canvas.
  const MAX_PX = 8000;
  raster = Math.min(raster, MAX_PX / Math.max(width, height));
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = Math.round(width * raster);
    c.height = Math.round(height * raster);
    const g = c.getContext("2d");
    if (g) {
      g.fillStyle = "#FFFFFF";
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
    }
    URL.revokeObjectURL(url);
    c.toBlob((b) => b && downloadBlob(b, dielineName(model, bagW, bagL, "png")), "image/png");
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

export function exportDielineDxf(model: DielineModel, bagW: number, bagL: number): void {
  downloadBlob(
    new Blob([buildDxf(model)], { type: "application/dxf" }),
    dielineName(model, bagW, bagL, "dxf"),
  );
}

export function exportDielinePdf(model: DielineModel, bagW: number, bagL: number): void {
  downloadBlob(buildPdfBlob(model), dielineName(model, bagW, bagL, "pdf"));
}

/** Ordered [label, value, unit] rows shared by the TXT and CSV spec exports. */
function specRows(s: AppState, m: Measurements): [string, string, string][] {
  const pd = prodDims(s);
  const n = fillCount(s);
  const wt = fillWeight(s);
  const innerLen = innerLength(s.bagL, s.endSeal);
  const hs = headspaceOf(innerLen, m.fillLine);
  const has = m.fillLine > 1;
  const settled = m.status === "settled" || m.status === "overfull";
  return [
    ["Part", PART_TAG, ""],
    ["Bag style", "Pillow (fin seal)", ""],
    ["Bag width", fmt1(s.bagW), "mm"],
    ["Bag length", fmt1(s.bagL), "mm"],
    ["Web width", fmt1(webWidth(s.bagW, s.finSeal)), "mm"],
    ["Cutoff length", fmt1(cutoffLength(s.bagL)), "mm"],
    ["End seal", fmt1(s.endSeal), "mm"],
    ["Fin seal", fmt1(s.finSeal), "mm"],
    ["Film stiffness", `${s.stiff} (${stiffLabel(s.stiff)})`, ""],
    ["Min headspace", fmt1(s.minHeadspace), "mm"],
    ["Jaw clearance", fmt1(s.jawClearance), "mm"],
    ["Product geometry", `${s.shape.toUpperCase()} ${pd.label}${s.stepName ? ` (${s.stepName})` : ""}`, ""],
    ["Unit weight", fmt1(s.pWt), "g"],
    ["Fill target", s.mode === "count" ? `${n} pcs` : `${fmt1(s.nWt)} g`, ""],
    ["Dropped", `${n} pcs / ${fmt1(wt)} g`, ""],
    ["Drop height", fmt1(s.dropH), "mm"],
    ["Settled", settled ? "yes" : "no", ""],
    ["Fill height", has ? fmt1(m.fillLine) : "—", has ? "mm" : ""],
    ["Headspace", has ? fmt1(hs) : "—", has ? "mm" : ""],
    ["Fill volume", has ? fmt1(m.fillVolume / 1000) : "—", has ? "cm3" : ""],
    ["Bulk density", has ? fmt1(m.bulkDensity * 1000) : "—", has ? "g/cm3" : ""],
    ["Usable bag volume", has ? fmt1(m.pctUsable) : "—", has ? "%" : ""],
    ["Formed depth", has ? fmt1(m.formedDepth) : "—", has ? "mm" : ""],
    ["Formed roundness", has ? `${Math.round(m.formedRoundness * 100)}` : "—", has ? "%" : ""],
    ["Packing (solid/bag vol)", has ? `${Math.round(m.reconcile * 100)}` : "—", has ? "%" : ""],
  ];
}

export function buildSpecText(s: AppState, m: Measurements): string {
  const pd = prodDims(s);
  const n = fillCount(s);
  const wt = fillWeight(s);
  const web = webWidth(s.bagW, s.finSeal);
  const innerLen = innerLength(s.bagL, s.endSeal);
  const hs = headspaceOf(innerLen, m.fillLine);
  const date = new Date().toISOString().slice(0, 10);
  const settled = m.status === "settled" || m.status === "overfull";
  const lines = [
    "VFFS FILL SIMULATOR — SPEC SHEET",
    `${PART_TAG} · ${date}`,
    "",
    "BAG (PILLOW, FIN SEAL)",
    `  Bag width × length : ${fmt1(s.bagW)} × ${fmt1(s.bagL)} mm`,
    `  Web width          : ${fmt1(web)} mm`,
    `  Cutoff length      : ${fmt1(cutoffLength(s.bagL))} mm`,
    `  End seal / fin seal: ${fmt1(s.endSeal)} / ${fmt1(s.finSeal)} mm`,
    `  Film stiffness     : ${s.stiff} (${stiffLabel(s.stiff)})`,
    "",
    "PRODUCT",
    `  Geometry           : ${s.shape.toUpperCase()} ${pd.label}` + (s.stepName ? ` (${s.stepName})` : ""),
    `  Unit weight        : ${fmt1(s.pWt)} g`,
    "",
    "FILL",
    `  Target             : ${s.mode === "count" ? n + " pcs" : fmt1(s.nWt) + " g"}`,
    `  Dropped            : ${n} pcs · ${fmt1(wt)} g`,
    `  Drop height        : ${fmt1(s.dropH)} mm`,
    "",
    "RESULT" + (settled ? "" : " (not yet settled)"),
    `  Fill height        : ${m.fillLine > 1 ? fmt1(m.fillLine) + " mm" : "—"}`,
    `  Headspace          : ${m.fillLine > 1 ? fmt1(hs) + " mm" : "—"}`,
    `  Fill volume        : ${m.fillLine > 1 ? fmt1(m.fillVolume / 1000) + " cm³" : "—"}`,
    `  Bulk density       : ${m.fillLine > 1 ? fmt1(m.bulkDensity * 1000) + " g/cm³" : "—"}`,
    `  Usable bag volume  : ${m.fillLine > 1 ? fmt1(m.pctUsable) + " %" : "—"}`,
    `  Formed depth       : ${m.fillLine > 1 ? fmt1(m.formedDepth) + " mm (" + Math.round(m.formedRoundness * 100) + "% round)" : "—"}`,
    `  Packing            : ${m.fillLine > 1 ? Math.round(m.reconcile * 100) + " % (product solid ÷ bag internal volume)" : "—"}`,
  ];
  return lines.join("\n");
}

export function buildSpecCsv(s: AppState, m: Measurements): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [["Field", "Value", "Unit"], ...specRows(s, m)];
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

export function exportSpecSheet(s: AppState, m: Measurements): void {
  downloadBlob(new Blob([buildSpecText(s, m)], { type: "text/plain" }), "vffs_spec_sheet.txt");
}

export function exportSpecCsv(s: AppState, m: Measurements): void {
  downloadBlob(new Blob([buildSpecCsv(s, m)], { type: "text/csv" }), "vffs_spec_sheet.csv");
}
