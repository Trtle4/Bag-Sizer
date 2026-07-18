/**
 * Canvas 2D renderer for the live fill view.
 *
 * Reads all geometry from the physics state (wall/floor node polylines, product
 * bodies, measurements) and draws the concept's front view: forming tube,
 * open-top deformable bag, product, bottom seal, seal-jaw plane, fill line,
 * centreline and dimension callouts (headspace in accent teal).
 */

import type { FillSim } from "../physics/world.js";
import { fmt1 } from "../geometry/index.js";
import { C, MONO } from "./tokens.js";

export interface SimView {
  bagW: number;
  bagL: number;
  endSeal: number;
  dropH: number;
  showDims: boolean;
}

export class SimRenderer {
  private ctx: CanvasRenderingContext2D;
  private sc = 1;
  private ox = 0;
  private oy = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
  }

  private X(x: number): number {
    return this.ox + x * this.sc;
  }
  private Y(y: number): number {
    return this.oy - y * this.sc;
  }

  private layout(v: SimView, innerLen: number): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const worldH = v.endSeal + innerLen + v.endSeal + Math.max(0, v.dropH) + 60;
    const worldW = v.bagW + 30;
    this.sc = Math.max(0.15, Math.min((w - 210) / worldW, (h - 100) / worldH));
    this.ox = w / 2 - 20;
    this.oy = h - 58;
  }

  private mono(px: number): void {
    this.ctx.font = `500 ${px}px ${MONO}`;
  }

  draw(sim: FillSim, v: SimView): void {
    const env = sim.envelope;
    this.layout(v, env.innerLen);
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const IL = env.innerLen;
    const UH = env.usableHalfW;
    const ES = v.endSeal;
    const topY = IL + ES; // open top film edge during fill
    const outletY = IL + ES + Math.max(0, v.dropH);
    const tubeHW = env.tubeHalfW;

    const left = sim.wallPolyline("left");
    const right = sim.wallPolyline("right");
    const floor = sim.floorPolyline();
    const m = sim.measurements();

    this.drawTube(tubeHW, outletY);
    this.drawBagFill(left, right, floor, topY, UH);
    this.drawParticles(sim);
    this.drawFilmWalls(left, right, floor, topY, UH);
    this.drawBottomSeal(floor, UH, ES);
    this.drawJawPlane(UH, IL);
    this.drawFillLine(m.fillLine, UH, IL);
    this.drawCentreline(topY, ES);
    if (v.showDims) this.drawDims(v, m.fillLine, IL, UH, tubeHW, outletY, topY);
  }

  private drawTube(tubeHW: number, outletY: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = C.tube;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(this.X(-tubeHW), 8);
    ctx.lineTo(this.X(-tubeHW), this.Y(outletY));
    ctx.moveTo(this.X(tubeHW), 8);
    ctx.lineTo(this.X(tubeHW), this.Y(outletY));
    ctx.stroke();
    // outlet flare
    ctx.beginPath();
    ctx.moveTo(this.X(-tubeHW), this.Y(outletY));
    ctx.lineTo(this.X(-tubeHW - 6), this.Y(outletY) + 7);
    ctx.moveTo(this.X(tubeHW), this.Y(outletY));
    ctx.lineTo(this.X(tubeHW + 6), this.Y(outletY) + 7);
    ctx.stroke();
    this.mono(10);
    ctx.fillStyle = C.ink3;
    ctx.textAlign = "center";
    ctx.fillText("FORMING TUBE", this.X(0), Math.max(16, this.Y(outletY) - 10));
  }

  private wallPath(pts: { x: number; y: number }[], topFlare: number, topY: number): void {
    const ctx = this.ctx;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const m = i === 0 ? "moveTo" : "lineTo";
      ctx[m](this.X(p.x), this.Y(p.y));
    }
    ctx.lineTo(this.X(topFlare), this.Y(topY)); // open flare at top
  }

  private drawBagFill(
    left: { x: number; y: number }[],
    right: { x: number; y: number }[],
    floor: { x: number; y: number }[],
    topY: number,
    UH: number,
  ): void {
    const ctx = this.ctx;
    ctx.beginPath();
    // up the left wall
    for (let i = 0; i < left.length; i++) {
      const p = left[i];
      const m = i === 0 ? "moveTo" : "lineTo";
      ctx[m](this.X(p.x), this.Y(p.y));
    }
    ctx.lineTo(this.X(-UH - 7), this.Y(topY));
    ctx.lineTo(this.X(UH + 7), this.Y(topY));
    // down the right wall
    for (let i = right.length - 1; i >= 0; i--) {
      ctx.lineTo(this.X(right[i].x), this.Y(right[i].y));
    }
    // across the floor (right → left)
    for (let i = floor.length - 1; i >= 0; i--) {
      ctx.lineTo(this.X(floor[i].x), this.Y(floor[i].y));
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.fill();
  }

  private drawParticles(sim: FillSim): void {
    const ctx = this.ctx;
    const sc = this.sc;
    for (const p of sim.particles()) {
      ctx.save();
      ctx.translate(this.X(p.x), this.Y(p.y));
      ctx.rotate(-p.angle);
      const grd = ctx.createLinearGradient(0, -p.h * sc, 0, p.h * sc);
      grd.addColorStop(0, C.productLight);
      grd.addColorStop(1, C.productDark);
      ctx.fillStyle = grd;
      ctx.strokeStyle = C.productEdge;
      ctx.lineWidth = 1;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, (p.w / 2) * sc, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (p.hull && p.hull.length >= 3) {
        // STEP silhouette polygon (centred, mm), drawn to scale.
        ctx.beginPath();
        p.hull.forEach((v, i) => {
          const m = i === 0 ? "moveTo" : "lineTo";
          ctx[m](v.x * sc, v.y * sc);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        const hw = (p.w / 2) * sc;
        const hh = (p.h / 2) * sc;
        const r = Math.min(hw, hh) * 0.35;
        ctx.beginPath();
        ctx.roundRect(-hw, -hh, hw * 2, hh * 2, r);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawFilmWalls(
    left: { x: number; y: number }[],
    right: { x: number; y: number }[],
    floor: { x: number; y: number }[],
    topY: number,
    UH: number,
  ): void {
    const ctx = this.ctx;
    ctx.strokeStyle = C.film;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.setLineDash([]);
    ctx.beginPath();
    this.wallPath(left, -(UH + 7), topY);
    ctx.stroke();
    ctx.beginPath();
    this.wallPath(right, UH + 7, topY);
    ctx.stroke();
    // floor
    ctx.beginPath();
    for (let i = 0; i < floor.length; i++) {
      const p = floor[i];
      const m = i === 0 ? "moveTo" : "lineTo";
      ctx[m](this.X(p.x), this.Y(p.y));
    }
    ctx.stroke();
  }

  private drawBottomSeal(floor: { x: number; y: number }[], UH: number, ES: number): void {
    const ctx = this.ctx;
    const sc = this.sc;
    // Seal band sits just below the floor's lowest point.
    const floorMinY = Math.min(...floor.map((p) => p.y), 0);
    const bsTop = this.Y(floorMinY);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.X(-UH) - 4, bsTop, UH * 2 * sc + 8, ES * sc);
    ctx.clip();
    ctx.strokeStyle = C.sealHatch;
    ctx.lineWidth = 1;
    for (let x = this.X(-UH) - 20; x < this.X(UH) + 20; x += 7) {
      ctx.beginPath();
      ctx.moveTo(x, bsTop + ES * sc);
      ctx.lineTo(x + ES * sc, bsTop);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = C.film;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.X(-UH), bsTop, UH * 2 * sc, ES * sc);
  }

  private drawJawPlane(UH: number, IL: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = C.ink3;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(this.X(-UH - 16), this.Y(IL));
    ctx.lineTo(this.X(UH + 16), this.Y(IL));
    ctx.stroke();
    ctx.setLineDash([]);
    this.mono(10);
    ctx.fillStyle = C.ink3;
    ctx.textAlign = "left";
    ctx.fillText("SEAL JAW", this.X(UH) + 20, this.Y(IL) + 3);
  }

  private drawFillLine(fillLine: number, UH: number, _IL: number): void {
    if (fillLine <= 1) return;
    const ctx = this.ctx;
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([7, 3, 2, 3]);
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(this.X(-UH - 16), this.Y(fillLine));
    ctx.lineTo(this.X(UH + 16), this.Y(fillLine));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawCentreline(topY: number, ES: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = C.accent;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 4, 2, 4]);
    ctx.beginPath();
    ctx.moveTo(this.X(0), this.Y(-ES) - 6);
    ctx.lineTo(this.X(0), this.Y(topY));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // ---- dimension helpers ----
  private arrow(x1: number, y1: number, x2: number, y2: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const a = Math.atan2(y2 - y1, x2 - x1);
    const L = 6;
    for (const s of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - L * Math.cos(a - 0.4 * s), y2 - L * Math.sin(a - 0.4 * s));
      ctx.stroke();
    }
  }
  private dimV(x: number, yTop: number, yBot: number, label: string, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    const mid = (yTop + yBot) / 2;
    this.arrow(x, mid - 9, x, yTop);
    this.arrow(x, mid + 9, x, yBot);
    this.mono(11.5);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.translate(x, mid);
    ctx.rotate(-Math.PI / 2);
    const tw = ctx.measureText(label).width;
    ctx.clearRect(-tw / 2 - 4, -8, tw + 8, 16);
    ctx.fillText(label, 0, 0);
    ctx.restore();
    ctx.textBaseline = "alphabetic";
  }
  private dimH(y: number, xL: number, xR: number, label: string, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    const mid = (xL + xR) / 2;
    this.arrow(mid - 9, y, xL, y);
    this.arrow(mid + 9, y, xR, y);
    this.mono(11.5);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(label).width;
    ctx.clearRect(mid - tw / 2 - 4, y - 8, tw + 8, 16);
    ctx.fillText(label, mid, y);
    ctx.textBaseline = "alphabetic";
  }
  private ext(x1: number, y1: number, x2: number, y2: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = C.ink3;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  private drawDims(
    v: SimView,
    fillLine: number,
    IL: number,
    UH: number,
    tubeHW: number,
    outletY: number,
    topY: number,
  ): void {
    const ES = v.endSeal;
    const hs = Math.max(0, IL - fillLine);
    // bag width (below)
    this.ext(this.X(-v.bagW / 2), this.Y(-ES) + 10, this.X(-v.bagW / 2), this.Y(-ES) + 34);
    this.ext(this.X(v.bagW / 2), this.Y(-ES) + 10, this.X(v.bagW / 2), this.Y(-ES) + 34);
    this.dimH(this.Y(-ES) + 28, this.X(-v.bagW / 2), this.X(v.bagW / 2), fmt1(v.bagW), C.ink2);
    // bag length (right)
    this.ext(this.X(UH) + 6, this.Y(-ES), this.X(v.bagW / 2) + 58, this.Y(-ES));
    this.ext(this.X(UH) + 6, this.Y(topY), this.X(v.bagW / 2) + 58, this.Y(topY));
    this.dimV(this.X(v.bagW / 2) + 52, this.Y(topY), this.Y(-ES), fmt1(v.bagL), C.ink2);
    // fill height + headspace (left)
    if (fillLine > 1) {
      this.dimV(this.X(-v.bagW / 2) - 40, this.Y(fillLine), this.Y(0), "FILL " + fmt1(fillLine), C.ink2);
      this.dimV(this.X(-v.bagW / 2) - 40, this.Y(IL), this.Y(fillLine), "HS " + fmt1(hs), C.accent);
    }
    // drop height
    if (v.dropH > 4) {
      this.dimV(this.X(-tubeHW) - 26, this.Y(outletY), this.Y(topY), "DROP " + fmt1(v.dropH), C.ink3);
    }
  }
}
