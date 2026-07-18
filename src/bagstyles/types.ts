/**
 * BagStyle — the extension point for the tool's roadmap.
 *
 * A style has exactly two responsibilities:
 *   (a) simProfile(): the sim cross-section rest geometry the physics engine
 *       builds its soft-body walls and floor from.
 *   (b) dieline(): a structured, layer-tagged geometry model that every
 *       exporter (SVG now; DXF / PDF / PNG in phase 2) renders from.
 *
 * `pillow` is fully implemented. `gusseted` and `sup` are typed stubs so that
 * enabling them later is purely additive — no interface churn.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface BagParams {
  /** Finished bag width (mm). */
  bagW: number;
  /** Finished bag length / cutoff (mm). */
  bagL: number;
  /** End seal band height (mm). */
  endSeal: number;
  /** Fin seal strip width (mm). */
  finSeal: number;
}

export interface SimProfileOpts {
  /** Normalised film stiffness in [0, 1]. */
  stiffNorm: number;
  /** Number of nodes per wall chain. */
  wallNodes: number;
  /** Number of nodes across the floor chain. */
  floorNodes: number;
}

/**
 * Cross-section rest geometry, in mm.
 * x = 0 is the centreline (+x right); y = 0 is the inner floor (+y up to jaw).
 */
export interface SimProfile {
  /** Open fill zone height, floor → jaw plane. */
  innerLen: number;
  /** Usable half-width of the fill channel after edge tuck. */
  usableHalfW: number;
  /** Left wall rest nodes, bottom → top (x negative). Length = wallNodes. */
  leftWall: Pt[];
  /** Right wall rest nodes, bottom → top (x positive). Length = wallNodes. */
  rightWall: Pt[];
  /** Floor rest nodes, left → right. Length = floorNodes. */
  floor: Pt[];
  /** Indices within each wall chain that are hard-anchored (never move). */
  anchoredWall: number[];
  /** Indices within the floor chain that are hard-anchored. */
  anchoredFloor: number[];
}

/** Cutting-table layer conventions (also the DXF layer names in phase 2). */
export type Layer = "CUT" | "CREASE" | "ANNO";

export type DielineEntity =
  /** Closed cut perimeter. */
  | { kind: "perimeter"; layer: "CUT"; pts: Pt[] }
  /** A fold / crease line (rendered dash-dot). */
  | { kind: "fold"; layer: "CREASE"; a: Pt; b: Pt }
  /** A hatched seal zone (outline on ANNO; fill is visual only). */
  | { kind: "sealZone"; layer: "ANNO"; x: number; y: number; w: number; h: number }
  /** A solid printed register mark (eye mark). */
  | { kind: "mark"; layer: "ANNO"; x: number; y: number; w: number; h: number; label?: string }
  /** A text label. role tunes emphasis/size. */
  | {
      kind: "label";
      layer: "ANNO";
      at: Pt;
      text: string;
      anchor: "start" | "middle" | "end";
      role: "panel" | "panelBig" | "seal";
    }
  /** A linear dimension with extension lines and a text value. */
  | {
      kind: "dimension";
      layer: "ANNO";
      a: Pt;
      b: Pt;
      text: string;
      /** Orientation of the dimension line. */
      axis: "h" | "v";
      /** Optional extension-line stubs {from, to} pairs. */
      ext?: { a: Pt; b: Pt }[];
    };

/**
 * Structured dieline geometry. All coordinates in mm, origin at the top-left of
 * the flat web, x → right, y → down. The SVG renderer draws this directly; the
 * DXF exporter (phase 2) filters by `layer` and flips Y to the DXF y-up frame.
 */
export interface DielineModel {
  units: "mm";
  style: string;
  /** Flat web width. */
  web: number;
  /** Cutoff length along the web. */
  cut: number;
  /** Overall extent of the geometry (web × cut). */
  bounds: { w: number; h: number };
  entities: DielineEntity[];
}

export interface BagStyle {
  id: "pillow" | "gusseted" | "sup";
  label: string;
  /** false → visible in the UI but disabled ("Coming soon"). */
  enabled: boolean;
  simProfile(p: BagParams, opts: SimProfileOpts): SimProfile;
  dieline(p: BagParams): DielineModel;
}
