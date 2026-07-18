/**
 * Exporters. Phase 1 ships SVG, PNG and a plain-text spec sheet — all from the
 * same structured dieline model / state the UI renders. Phase 2 adds PDF (1:1
 * mm), DXF (R12 polylines, CUT/CREASE/ANNO layers) and CSV.
 */

import type { DielineModel } from "../bagstyles/types.js";
import { renderDieline, dielineName } from "../render/dieline.js";
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
  scale = 3,
): void {
  const { svg, width, height } = renderDieline(model);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = Math.round(width * scale);
    c.height = Math.round(height * scale);
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
  ];
  return lines.join("\n");
}

export function exportSpecSheet(s: AppState, m: Measurements): void {
  downloadBlob(new Blob([buildSpecText(s, m)], { type: "text/plain" }), "vffs_spec_sheet.txt");
}
