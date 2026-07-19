/**
 * Gusseted bag (side gussets, fin seal).
 *
 * Sim cross-section: a side gusset gives the formed bag a *defined* front-to-back
 * depth (the gusset depth) rather than the pillow's emergent belly — so the
 * filled section is a boxed ellipse, full bag width × gusset depth. The physics
 * builds the same elliptical wall cage from it, so containment is identical to
 * the pillow (verified: nothing escapes).
 *
 * Dieline: fin | gusset½ | FRONT | gusset | BACK | gusset½ | fin, with the two
 * half-gussets meeting at the fin seal, gusset centre-folds, end-seal bands and
 * full dimensioning — mirroring the pillow's fidelity.
 */

import { innerLength, cutoffLength, fmt1 } from "../geometry/index.js";
import type {
  BagParams,
  BagStyle,
  DielineEntity,
  DielineModel,
  SimProfile,
  SimProfileOpts,
} from "./types.js";

/** Gusset depth (mm), defaulted from the width when the caller leaves it unset. */
function gussetDepth(p: BagParams): number {
  return Math.max(4, p.gusset ?? Math.round(p.bagW * 0.4));
}

function simProfile(p: BagParams, opts: SimProfileOpts): SimProfile {
  const st = opts.stiffNorm;
  const g = gussetDepth(p);
  // Front/back panels stay ~full width (the sides are the gussets, not tucked
  // free edges), so only a small fixed margin comes off the half-width.
  const halfW = Math.max(8, p.bagW / 2 - 3);
  const halfD = Math.max(2, g / 2);
  return {
    innerLen: innerLength(p.bagL, p.endSeal),
    usableHalfW: halfW,
    usableHalfD: halfD,
    floorSagGain: 1.8 - 1.4 * st,
    billowGain: 0.4 - 0.3 * st,
    // A side gusset opens readily, so the depth is present from light fill.
    section: { kind: "boxed", halfW, halfD, openFloor: 0.55 },
  };
}

function dieline(p: BagParams): DielineModel {
  const W = p.bagW;
  const G = gussetDepth(p);
  const L = cutoffLength(p.bagL);
  const F = p.finSeal;
  const E = p.endSeal;

  // fin | gusset½ | FRONT | gusset | BACK | gusset½ | fin
  const b = [0, F, F + G / 2, F + G / 2 + W, F + (3 * G) / 2 + W, F + (3 * G) / 2 + 2 * W, F + 2 * G + 2 * W, 2 * F + 2 * G + 2 * W];
  const web = b[7];

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
  entities.push({ kind: "sealZone", layer: "ANNO", x: b[6], y: 0, w: F, h: L });

  // Panel-boundary folds (b[1]..b[6]).
  for (const i of [1, 2, 3, 4, 5, 6]) {
    entities.push({ kind: "fold", layer: "CREASE", a: { x: b[i], y: 0 }, b: { x: b[i], y: L } });
  }
  // Gusset centre-folds (each gusset panel folds in half).
  for (const [lo, hi] of [[b[1], b[2]], [b[3], b[4]], [b[5], b[6]]]) {
    const cx = (lo + hi) / 2;
    entities.push({ kind: "fold", layer: "CREASE", a: { x: cx, y: 0 }, b: { x: cx, y: L } });
  }

  // Eye mark inside the bottom seal band.
  const emW = Math.min(15, F + 5);
  entities.push({ kind: "mark", layer: "ANNO", x: web - emW - 2, y: L - E - 12, w: emW, h: 8, label: "EYE MARK" });

  // Panel labels (horizontal).
  const midY = L / 2;
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
  entities.push(panel(mid(b[1], b[2]), "GUSSET", "panel"));
  entities.push(panel(mid(b[2], b[3]), "FRONT PANEL", "panelBig"));
  entities.push(panel(mid(b[3], b[4]), "GUSSET", "panel"));
  entities.push(panel(mid(b[4], b[5]), "BACK PANEL", "panelBig"));
  entities.push(panel(mid(b[5], b[6]), "GUSSET", "panel"));
  entities.push(panel(mid(b[6], b[7]), "FIN", "panel"));
  entities.push({ kind: "label", layer: "ANNO", at: { x: web / 2, y: E / 2 }, text: "TOP SEAL", anchor: "middle", role: "seal" });
  entities.push({ kind: "label", layer: "ANNO", at: { x: web / 2, y: L - E / 2 }, text: "BOTTOM SEAL", anchor: "middle", role: "seal" });

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
  entities.push({ kind: "dimension", layer: "ANNO", axis: "h", a: { x: b[1], y: 0 }, b: { x: b[2], y: 0 }, text: "G " + fmt1(G / 2) });
  entities.push({ kind: "dimension", layer: "ANNO", axis: "v", a: { x: web, y: 0 }, b: { x: web, y: L }, text: "CUT " + fmt1(L) });
  entities.push({ kind: "dimension", layer: "ANNO", axis: "v", a: { x: 0, y: 0 }, b: { x: 0, y: E }, text: fmt1(E) });

  return { units: "mm", style: "gusseted", web, cut: L, bounds: { w: web, h: L }, entities };
}

export const gusseted: BagStyle = {
  id: "gusseted",
  label: "Gusseted",
  enabled: true,
  simProfile,
  dieline,
};
