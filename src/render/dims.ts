/**
 * Live dimension-callout overlay — an SVG layer over the 3-D canvas that projects
 * world points through the active camera and draws technical dimension lines.
 * Shown in the orthographic front/side presets, where the projection is linear
 * and the callouts read like an engineering drawing (headspace in accent teal).
 */

import * as THREE from "three";
import { fmt1 } from "../geometry/index.js";
import type { CameraMode } from "./scene.js";

const INK2 = "#59656C";
const INK3 = "#8A959B";
const ACCENT = "#0F6E77";

export interface DimState {
  mode: CameraMode;
  bagW: number;
  bagL: number;
  bagD: number; // 2 × usableHalfD
  endSeal: number;
  dropH: number;
  innerLen: number;
  fillLine: number;
  headspace: number;
  tubeLen: number;
  hasFill: boolean;
}

export class DimOverlay {
  constructor(private svg: SVGSVGElement) {}

  clear(): void {
    this.svg.innerHTML = "";
  }

  draw(s: DimState, camera: THREE.Camera, w: number, h: number): void {
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    if (s.mode === "iso") {
      this.clear();
      return;
    }
    const across = s.mode === "front" ? s.bagW : s.bagD; // width or depth
    const acrossLabel = s.mode === "front" ? s.bagW : s.bagD;
    // In front view the across-axis is x; in side view it is z.
    const P = (across0: number, y: number): THREE.Vector3 =>
      s.mode === "front"
        ? new THREE.Vector3(across0, y, 0)
        : new THREE.Vector3(0, y, across0);
    const topFilm = s.innerLen + s.endSeal;
    const tubeTop = s.innerLen + s.tubeLen;

    const parts: string[] = [];
    const proj = (v: THREE.Vector3) => {
      const p = v.clone().project(camera);
      return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
    };

    // Across dimension (bag width / depth) below the bag.
    parts.push(
      this.dim(
        proj(P(-across / 2, -s.endSeal)),
        proj(P(across / 2, -s.endSeal)),
        { x: 0, y: 34 },
        fmt1(acrossLabel),
        INK2,
      ),
    );
    // Bag length on the right.
    parts.push(
      this.dim(proj(P(across / 2, -s.endSeal)), proj(P(across / 2, topFilm)), { x: 46, y: 0 }, fmt1(s.bagL), INK2),
    );
    // Fill height + headspace on the left.
    if (s.hasFill) {
      parts.push(
        this.dim(proj(P(-across / 2, 0)), proj(P(-across / 2, s.fillLine)), { x: -40, y: 0 }, "FILL " + fmt1(s.fillLine), INK2),
      );
      parts.push(
        this.dim(
          proj(P(-across / 2, s.fillLine)),
          proj(P(-across / 2, s.innerLen)),
          { x: -40, y: 0 },
          "HS " + fmt1(s.headspace),
          ACCENT,
        ),
      );
    }
    // Drop height labels the former tube (spawn launches at the outlet velocity).
    if (s.dropH > 4) {
      parts.push(this.dim(proj(P(0, s.innerLen)), proj(P(0, tubeTop)), { x: -70, y: 0 }, "DROP " + fmt1(s.dropH), INK3));
    }
    this.svg.innerHTML = parts.join("");
  }

  /** A dimension between two screen points, offset perpendicular, with arrows + label. */
  private dim(
    a: { x: number; y: number },
    b: { x: number; y: number },
    off: { x: number; y: number },
    label: string,
    color: string,
  ): string {
    const a2 = { x: a.x + off.x, y: a.y + off.y };
    const b2 = { x: b.x + off.x, y: b.y + off.y };
    const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
    const ext = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
      `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${INK3}" stroke-width="1"/>`;
    const line = `<line x1="${a2.x.toFixed(1)}" y1="${a2.y.toFixed(1)}" x2="${b2.x.toFixed(1)}" y2="${b2.y.toFixed(1)}" stroke="${color}" stroke-width="1"/>`;
    const vertical = Math.abs(b2.y - a2.y) > Math.abs(b2.x - a2.x);
    // Text box (opaque) so the line doesn't run through the number.
    const tw = label.length * 6.5 + 8;
    const rot = vertical ? ` transform="rotate(-90 ${mid.x} ${mid.y})"` : "";
    const text =
      `<g${rot}><rect x="${(mid.x - tw / 2).toFixed(1)}" y="${(mid.y - 8).toFixed(1)}" width="${tw.toFixed(1)}" height="16" fill="#E9EDF0" opacity="0.9"/>` +
      `<text x="${mid.x.toFixed(1)}" y="${(mid.y + 3.5).toFixed(1)}" text-anchor="middle" font-family="'DM Mono',ui-monospace,monospace" font-size="11" font-weight="500" fill="${color}">${label}</text></g>`;
    return ext(a, a2) + ext(b, b2) + line + this.arrow(a2, b2, color) + this.arrow(b2, a2, color) + text;
  }

  private arrow(tip: { x: number; y: number }, from: { x: number; y: number }, color: string): string {
    const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
    const L = 6;
    const p1 = { x: tip.x - L * Math.cos(ang - 0.4), y: tip.y - L * Math.sin(ang - 0.4) };
    const p2 = { x: tip.x - L * Math.cos(ang + 0.4), y: tip.y - L * Math.sin(ang + 0.4) };
    return `<path d="M${tip.x.toFixed(1)},${tip.y.toFixed(1)} L${p1.x.toFixed(1)},${p1.y.toFixed(1)} M${tip.x.toFixed(1)},${tip.y.toFixed(1)} L${p2.x.toFixed(1)},${p2.y.toFixed(1)}" stroke="${color}" stroke-width="1" fill="none"/>`;
  }
}
