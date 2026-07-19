/**
 * Stand-up pouch (SUP) — bottom gusset, fin-sealed sides.
 *
 * Sim cross-section: a bottom (doyen) gusset lets the base spread into a stable
 * oval footprint, so the fill zone forms a boxed ellipse — bag width × the base
 * spread (from the gusset depth). Like the gusseted style the physics builds the
 * same elliptical wall cage, so containment is identical to the pillow; the base
 * needs a little product before it opens out, hence a lower `openFloor`.
 *
 * Dieline: a fin-sealed front/back web (fin | back½ | FRONT | back½ | fin) plus a
 * hatched BOTTOM GUSSET band above the base seal with its centre fold and a
 * D-seal register mark — a scoping layout at the pillow's fidelity.
 */

import { innerLength, cutoffLength, webWidth, panelBoundaries, fmt1 } from "../geometry/index.js";
import type {
  BagParams,
  BagStyle,
  DielineEntity,
  DielineModel,
  SimProfile,
  SimProfileOpts,
} from "./types.js";

/** Bottom-gusset depth (mm), defaulted from the width when the caller leaves it unset. */
function gussetDepth(p: BagParams): number {
  return Math.max(4, p.gusset ?? Math.round(p.bagW * 0.45));
}

function simProfile(p: BagParams, opts: SimProfileOpts): SimProfile {
  const st = opts.stiffNorm;
  const g = gussetDepth(p);
  const halfW = Math.max(8, p.bagW / 2 - 5);
  // The base opens to roughly the gusset depth across; a stiffer film stands the
  // base out a touch fuller.
  const halfD = Math.max(2, (g / 2) * (0.85 + 0.15 * st));
  return {
    innerLen: innerLength(p.bagL, p.endSeal),
    usableHalfW: halfW,
    usableHalfD: halfD,
    floorSagGain: 1.5 - 1.1 * st,
    billowGain: 0.5 - 0.35 * st,
    // The base needs some product to spread open before it stands out fully.
    section: { kind: "boxed", halfW, halfD, openFloor: 0.4 },
  };
}

function dieline(p: BagParams): DielineModel {
  const W = p.bagW;
  const G = gussetDepth(p);
  const L = cutoffLength(p.bagL);
  const F = p.finSeal;
  const E = p.endSeal;
  const web = webWidth(W, F);
  const b = panelBoundaries(W, F); // [0, F, F+W/2, F+3W/2, F+2W, web]

  const entities: DielineEntity[] = [];

  entities.push({
    kind: "perimeter",
    layer: "CUT",
    pts: [
      { x: 0, y: 0 },
      { x: web, y: 0 },
      { x: web, y: L },
      { x: 0, y: L },
    ],
  });

  // Seal zones: top & bottom end seals, two fin strips.
  entities.push({ kind: "sealZone", layer: "ANNO", x: 0, y: 0, w: web, h: E });
  entities.push({ kind: "sealZone", layer: "ANNO", x: 0, y: L - E, w: web, h: E });
  entities.push({ kind: "sealZone", layer: "ANNO", x: 0, y: 0, w: F, h: L });
  entities.push({ kind: "sealZone", layer: "ANNO", x: b[4], y: 0, w: F, h: L });

  // Bottom gusset band above the base seal (hatched), with its centre fold.
  const gH = Math.min(G, Math.max(6, (L - 2 * E) * 0.35));
  const gY = L - E - gH;
  entities.push({ kind: "sealZone", layer: "ANNO", x: F, y: gY, w: web - 2 * F, h: gH });
  entities.push({ kind: "fold", layer: "CREASE", a: { x: F, y: gY + gH / 2 }, b: { x: web - F, y: gY + gH / 2 } });

  // Interior panel folds (b[1]..b[4]).
  for (const i of [1, 2, 3, 4]) {
    entities.push({ kind: "fold", layer: "CREASE", a: { x: b[i], y: 0 }, b: { x: b[i], y: L } });
  }

  // D-seal register mark at the base gusset corner.
  entities.push({ kind: "mark", layer: "ANNO", x: web - Math.min(15, F + 5) - 2, y: gY + 4, w: Math.min(15, F + 5), h: 8, label: "D-SEAL" });

  // Panel labels (horizontal); keep them above the gusset band.
  const midY = Math.max(E + 10, gY / 2);
  const mid = (lo: number, hi: number) => (lo + hi) / 2;
  const panel = (cx: number, text: string, role: "panel" | "panelBig"): DielineEntity => ({
    kind: "label",
    layer: "ANNO",
    at: { x: cx, y: midY },
    text,
    anchor: "middle",
    role,
  });
  entities.push(panel(mid(b[0], b[1]), "FIN", "panel"));
  entities.push(panel(mid(b[1], b[2]), "BACK ½", "panel"));
  entities.push(panel(mid(b[2], b[3]), "FRONT PANEL", "panelBig"));
  entities.push(panel(mid(b[3], b[4]), "BACK ½", "panel"));
  entities.push(panel(mid(b[4], b[5]), "FIN", "panel"));
  entities.push({ kind: "label", layer: "ANNO", at: { x: web / 2, y: E / 2 }, text: "TOP SEAL", anchor: "middle", role: "seal" });
  entities.push({ kind: "label", layer: "ANNO", at: { x: web / 2, y: gY + gH / 2 }, text: "BOTTOM GUSSET", anchor: "middle", role: "seal" });

  // Dimensions: web, front-panel width, gusset depth, cutoff, end seal.
  entities.push({
    kind: "dimension",
    layer: "ANNO",
    axis: "h",
    a: { x: 0, y: L },
    b: { x: web, y: L },
    text: "WEB " + fmt1(web),
    ext: [
      { a: { x: 0, y: L }, b: { x: 0, y: L } },
      { a: { x: web, y: L }, b: { x: web, y: L } },
    ],
  });
  entities.push({ kind: "dimension", layer: "ANNO", axis: "h", a: { x: b[2], y: 0 }, b: { x: b[3], y: 0 }, text: fmt1(W) });
  entities.push({ kind: "dimension", layer: "ANNO", axis: "v", a: { x: web, y: gY }, b: { x: web, y: L - E }, text: "GUSSET " + fmt1(G) });
  entities.push({ kind: "dimension", layer: "ANNO", axis: "v", a: { x: 0, y: 0 }, b: { x: 0, y: E }, text: fmt1(E) });

  return { units: "mm", style: "sup", web, cut: L, bounds: { w: web, h: L }, entities };
}

export const sup: BagStyle = {
  id: "sup",
  label: "SUP",
  enabled: true,
  simProfile,
  dieline,
};
