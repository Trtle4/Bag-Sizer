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
  /**
   * Gusset depth (mm) — the formed front-to-back depth the gusset opens to.
   * Side gusset (gusseted) or bottom gusset (SUP). Ignored by the pillow style.
   * Optional so pillow-only callers (and the test fixtures) need not set it.
   */
  gusset?: number;
}

export interface SimProfileOpts {
  /** Normalised film stiffness in [0, 1]. */
  stiffNorm: number;
}

/**
 * How the filled cross-section forms — the physics builds one elliptical wall
 * cage (halfW × halfD) for every style; only the way that ellipse is sized
 * differs, so containment is identical across styles.
 *
 * - `pillow`: a flat film of fixed circumference `4·flatHalfW` redistributes
 *   from flat toward round as product fills (perimeter conservation). Depth is
 *   emergent and bounded.
 * - `boxed`: a gusset defines the depth directly. The ellipse opens toward
 *   `halfW × halfD` as it fills; `openFloor` is its minimum openness when nearly
 *   empty (a side gusset opens readily; a stand-up base needs some product).
 */
export type SectionModel =
  | { kind: "pillow"; flatHalfW: number }
  | { kind: "boxed"; halfW: number; halfD: number; openFloor: number };

/**
 * 3-D bag shell rest geometry (mm) for the Rapier fill sim.
 *
 * Axes: x = width (±, across the bag face), y = up (0 = inner floor → innerLen =
 * jaw plane), z = depth (±, the pillow's thickness). The shell is quasi-static:
 * the physics builds primitive kinematic wall/floor colliders from these
 * parameters and drives their billow/sag from the resting load — it does not
 * simulate cloth. (See docs/ADR-001-physics.md.)
 */
export interface SimProfile {
  /** Open fill zone height, floor → jaw plane. */
  innerLen: number;
  /** Rest half-width in x, after edge tuck. */
  usableHalfW: number;
  /** Rest half-depth in z (half the formed pillow thickness). */
  usableHalfD: number;
  /** Load → floor-sag gain (limp sags more). */
  floorSagGain: number;
  /** Load → outward wall-billow gain (limp bows out more). */
  billowGain: number;
  /** How the filled cross-section forms (drives the collision ellipse + readout). */
  section: SectionModel;
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
