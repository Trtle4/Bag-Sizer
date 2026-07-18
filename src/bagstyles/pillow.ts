/**
 * Pillow bag (fin seal) — the first fully implemented BagStyle.
 *
 * Sim cross-section: vertical film walls at ±usableHalfW, flat floor at y = 0,
 * both anchored at the bottom seal and at the jaw plane.
 *
 * Dieline: fin | back ½ | FRONT | back ½ | fin, with hatched end-seal bands and
 * fin strips, dash-dot fold lines, an eye mark, and full dimensioning. Panel
 * labels run horizontal (parallel to the top seal), per the approved revision.
 */

import {
  innerLength,
  usableHalfWidth,
  webWidth,
  cutoffLength,
  panelBoundaries,
  fmt1,
} from "../geometry/index.js";
import type {
  BagParams,
  BagStyle,
  DielineEntity,
  DielineModel,
  SimProfile,
  SimProfileOpts,
} from "./types.js";

function simProfile(p: BagParams, opts: SimProfileOpts): SimProfile {
  const st = opts.stiffNorm;
  const uhw = usableHalfWidth(p.bagW, st);
  // Formed pillow depth is the dimension stiffness governs most: a limp film
  // rounds out into a deep belly (more volume → product settles low); a stiff
  // film stays flat/planar (shallow → product stacks tall). This wide swing is
  // what makes the stiffness slider visibly move fill height and headspace.
  const usableHalfD = uhw * (1.0 - 0.7 * st);
  return {
    innerLen: innerLength(p.bagL, p.endSeal),
    usableHalfW: uhw,
    usableHalfD,
    floorSagGain: 2.6 - 2.2 * st,
    billowGain: 0.6 - 0.45 * st,
  };
}

function dieline(p: BagParams): DielineModel {
  const W = p.bagW;
  const L = cutoffLength(p.bagL);
  const F = p.finSeal;
  const E = p.endSeal;
  const web = webWidth(W, F);
  const b = panelBoundaries(W, F); // [0, F, F+W/2, F+3W/2, F+2W, web]

  const entities: DielineEntity[] = [];

  // --- CUT: perimeter ---
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

  // --- ANNO: seal zones (hatched) — top & bottom end seals, two fin strips ---
  entities.push({ kind: "sealZone", layer: "ANNO", x: 0, y: 0, w: web, h: E });
  entities.push({ kind: "sealZone", layer: "ANNO", x: 0, y: L - E, w: web, h: E });
  entities.push({ kind: "sealZone", layer: "ANNO", x: 0, y: 0, w: F, h: L });
  entities.push({ kind: "sealZone", layer: "ANNO", x: b[4], y: 0, w: F, h: L });

  // --- CREASE: fold lines at the four interior panel boundaries ---
  for (const i of [1, 2, 3, 4]) {
    entities.push({ kind: "fold", layer: "CREASE", a: { x: b[i], y: 0 }, b: { x: b[i], y: L } });
  }

  // --- ANNO: eye mark near bottom-right, inside the bottom seal band ---
  const emW = Math.min(15, F + 5);
  const emH = 8;
  entities.push({
    kind: "mark",
    layer: "ANNO",
    x: web - emW - 2,
    y: L - E - 12,
    w: emW,
    h: emH,
    label: "EYE MARK",
  });

  // --- ANNO: panel labels (horizontal, parallel to the top seal) ---
  const midY = L / 2;
  const mid = (lo: number, hi: number) => (lo + hi) / 2;
  const panel = (
    cx: number,
    text: string,
    role: "panel" | "panelBig",
  ): DielineEntity => ({
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
  entities.push({
    kind: "label",
    layer: "ANNO",
    at: { x: web / 2, y: E / 2 },
    text: "TOP SEAL",
    anchor: "middle",
    role: "seal",
  });
  entities.push({
    kind: "label",
    layer: "ANNO",
    at: { x: web / 2, y: L - E / 2 },
    text: "BOTTOM SEAL",
    anchor: "middle",
    role: "seal",
  });

  // --- ANNO: dimensions ---
  // Web width (below the blank).
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
  // Front panel width (above).
  entities.push({
    kind: "dimension",
    layer: "ANNO",
    axis: "h",
    a: { x: b[2], y: 0 },
    b: { x: b[3], y: 0 },
    text: fmt1(W),
  });
  // Fin width (above, top-left).
  entities.push({
    kind: "dimension",
    layer: "ANNO",
    axis: "h",
    a: { x: b[0], y: 0 },
    b: { x: b[1], y: 0 },
    text: fmt1(F),
  });
  // Cutoff length (right, vertical).
  entities.push({
    kind: "dimension",
    layer: "ANNO",
    axis: "v",
    a: { x: web, y: 0 },
    b: { x: web, y: L },
    text: "CUT " + fmt1(L),
  });
  // End seal band (left, vertical).
  entities.push({
    kind: "dimension",
    layer: "ANNO",
    axis: "v",
    a: { x: 0, y: 0 },
    b: { x: 0, y: E },
    text: fmt1(E),
  });

  return {
    units: "mm",
    style: "pillow",
    web,
    cut: L,
    bounds: { w: web, h: L },
    entities,
  };
}

export const pillow: BagStyle = {
  id: "pillow",
  label: "Pillow",
  enabled: true,
  simProfile,
  dieline,
};
