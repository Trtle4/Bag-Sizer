/**
 * Application entry — wires the DOM controls to the store, the physics sim and
 * the renderers, and runs the fixed-timestep main loop.
 */

import "./styles.css";
import {
  Store,
  prodDims,
  fillCount,
  fillWeight,
  filmLabel,
  type AppState,
} from "./state.js";
import { FillSim, type FillParams, type Measurements } from "./physics/world.js";
import { SimRenderer } from "./render/sim.js";
import { renderDieline } from "./render/dieline.js";
import { getBagStyle, type BagParams } from "./bagstyles/index.js";
import { parseStepBBox } from "./geometry/step.js";
import { webWidth, innerLength, headspace as headspaceOf, fmt1, MAX_PIECES } from "./geometry/index.js";
import {
  exportDielineSvg,
  exportDielinePng,
  exportSpecSheet,
} from "./export/index.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const store = new Store();
const sim = new FillSim();
const renderer = new SimRenderer($<HTMLCanvasElement>("sim"));

let dirty = true; // physics envelope needs a rebuild
let lastMeasure: Measurements = {
  fillLine: 0,
  headspace: 0,
  status: "ready",
  restingCount: 0,
  fillVolume: 0,
  bulkDensity: 0,
  pctUsable: 0,
};

// ---------- param mapping ----------
function bagParams(s: AppState): BagParams {
  return { bagW: s.bagW, bagL: s.bagL, endSeal: s.endSeal, finSeal: s.finSeal };
}

function fillParams(s: AppState, seed: number): FillParams {
  const pd = prodDims(s);
  return {
    style: getBagStyle(s.style),
    bag: bagParams(s),
    product: { w: pd.w, h: pd.h, round: pd.round },
    unitWeight: s.pWt,
    count: fillCount(s),
    dropH: s.dropH,
    stiff: s.stiff,
    seed,
  };
}

function rebuild(): void {
  const s = store.get();
  sim.build(fillParams(s, s.seed));
  dirty = false;
}

/** Rebuild immediately when idle so the empty bag reflects edits live. */
function markDirty(): void {
  dirty = true;
  if (!sim.isActive) rebuild();
}

function nextSeed(s: AppState): number {
  if (s.deterministic) return s.seed;
  // Vary per drop when determinism is off.
  return (s.seed * 1103515245 + 12345 + Math.floor(performance.now())) >>> 0;
}

// ---------- segmented controls ----------
function bindSeg(id: string, key: keyof AppState, after?: () => void): void {
  const root = $(id);
  root.querySelectorAll<HTMLButtonElement>("button[data-v]").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.disabled) return;
      root.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      store.set({ [key]: b.dataset.v } as unknown as Partial<AppState>);
      after?.();
      onChange();
    });
  });
}

bindSeg("segShape", "shape", () => {
  const s = store.get();
  $("shapeRound").style.display = s.shape === "round" ? "" : "none";
  $("shapeSquare").style.display = s.shape === "square" ? "" : "none";
  $("shapeStep").style.display = s.shape === "step" ? "" : "none";
});
bindSeg("segMode", "mode", () => {
  const s = store.get();
  $("fCount").style.display = s.mode === "count" ? "" : "none";
  $("fWeight").style.display = s.mode === "weight" ? "" : "none";
});
bindSeg("segStyle", "style");

// ---------- numeric inputs ----------
const numFields: [string, keyof AppState][] = [
  ["pDia", "pDia"],
  ["pThk", "pThk"],
  ["pL", "pL"],
  ["pW", "pW"],
  ["pH", "pH"],
  ["pWt", "pWt"],
  ["nCount", "nCount"],
  ["nWt", "nWt"],
  ["dropH", "dropH"],
  ["bagW", "bagW"],
  ["bagL", "bagL"],
  ["endSeal", "endSeal"],
  ["finSeal", "finSeal"],
];
// Fields that must be strictly positive (a zero/blank is a blocker).
const positiveOnly = new Set(["pDia", "pThk", "pL", "pW", "pH", "pWt", "bagW", "bagL"]);

for (const [id, key] of numFields) {
  const input = $<HTMLInputElement>(id);
  const wrap = input.closest(".in");
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    const valid = Number.isFinite(v) && v >= 0 && !(positiveOnly.has(id) && v <= 0);
    wrap?.classList.toggle("invalid", !valid);
    if (valid) {
      store.set({ [key]: v } as unknown as Partial<AppState>);
      onChange();
    }
  });
}

// ---------- stiffness slider ----------
const stiff = $<HTMLInputElement>("stiff");
stiff.addEventListener("input", () => {
  store.set({ stiff: +stiff.value });
  stiff.style.setProperty("--pct", stiff.value + "%");
  onChange();
});
stiff.style.setProperty("--pct", store.get().stiff + "%");

// ---------- toolbar ----------
$("btnDrop").addEventListener("click", () => {
  const s = store.get();
  sim.build(fillParams(s, nextSeed(s)));
  dirty = false;
  sim.start();
  setStatusChip();
});
$("btnReset").addEventListener("click", () => {
  rebuild();
  sim.reset();
  setStatusChip();
});
const btnDims = $("btnDims");
btnDims.addEventListener("click", () => {
  const showDims = !store.get().showDims;
  store.set({ showDims });
  btnDims.classList.toggle("on", showDims);
});
$("vwFill").addEventListener("click", () => setView("fill"));
$("vwDieline").addEventListener("click", () => setView("dieline"));

function setView(view: "fill" | "dieline"): void {
  store.set({ view });
  $("vwFill").classList.toggle("on", view === "fill");
  $("vwDieline").classList.toggle("on", view === "dieline");
  $("dielineWrap").classList.toggle("show", view === "dieline");
  $("sim").style.display = view === "fill" ? "block" : "none";
  $("scalechip").textContent =
    view === "fill" ? "Front view · live sim · mm" : "Pillow dieline · fin seal · flat · mm";
  if (view === "dieline") drawDieline();
}

// ---------- dieline ----------
function drawDieline(): void {
  const s = store.get();
  const model = getBagStyle(s.style).dieline(bagParams(s));
  const { inner, viewBox } = renderDieline(model);
  const svg = $("dielineSvg");
  svg.setAttribute("viewBox", viewBox);
  svg.innerHTML = inner;
}

// ---------- STEP upload ----------
$("btnUpload").addEventListener("click", () => $<HTMLInputElement>("fileStep").click());
$<HTMLInputElement>("fileStep").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const hint = $("stepHint");
  const rd = new FileReader();
  rd.onload = () => {
    const res = parseStepBBox(String(rd.result));
    if (!res.ok) {
      hint.textContent = res.error ?? "Could not read STEP file.";
      hint.style.color = "var(--danger)";
      return;
    }
    store.set({ stepDims: res.dims, stepName: f.name });
    $("upName").textContent = f.name;
    hint.style.color = "";
    hint.textContent = `BBOX ${fmt1(res.dims.l)} × ${fmt1(res.dims.w)} × ${fmt1(
      res.dims.h,
    )} mm · ${res.pointCount.toLocaleString()} pts`;
    onChange();
  };
  rd.onerror = () => {
    hint.textContent = "Could not read the file.";
    hint.style.color = "var(--danger)";
  };
  rd.readAsText(f);
});

// ---------- exports ----------
$("btnExportDL").addEventListener("click", () => {
  const s = store.get();
  exportDielineSvg(getBagStyle(s.style).dieline(bagParams(s)), s.bagW, s.bagL);
});
$("btnExportPNG").addEventListener("click", () => {
  const s = store.get();
  exportDielinePng(getBagStyle(s.style).dieline(bagParams(s)), s.bagW, s.bagL);
});
$("btnExportSpec").addEventListener("click", () => {
  exportSpecSheet(store.get(), lastMeasure);
});

// ---------- readouts ----------
function onChange(): void {
  markDirty();
  updateReadouts();
  advisories();
  if (store.get().view === "dieline") drawDieline();
}

function updateReadouts(): void {
  const s = store.get();
  const pd = prodDims(s);
  const n = fillCount(s);
  const wt = fillWeight(s);
  const web = webWidth(s.bagW, s.finSeal);
  $("tbBag").innerHTML = `<b>${fmt1(s.bagW)} × ${fmt1(s.bagL)}</b> mm`;
  $("tbWeb").textContent = `${fmt1(web)} × ${fmt1(s.bagL)} mm`;
  $("tbProd").textContent = pd.label + (s.shape === "step" && s.stepName ? " · stp" : "");
  $("tbFill").textContent = `${n} pcs · ${fmt1(wt)} g`;
  $("tbFilm").textContent = `Stiffness ${filmLabel(s)}`;
  $("stiffVal").textContent = filmLabel(s);
  $("fillHint").textContent =
    s.mode === "weight"
      ? `${n} pcs at ${fmt1(s.pWt)} g each → ${fmt1(n * s.pWt)} g dropped`
      : `${fmt1(wt)} g total at ${fmt1(s.pWt)} g each`;
  $("msBag").textContent = `${fmt1(s.bagW)} × ${fmt1(s.bagL)} mm`;
  $("msFill").textContent = `${n} pcs · ${fmt1(wt)} g`;
}

function setStatusChip(): void {
  const chip = $("statusChip");
  const tx = $("statusTxt");
  const st = lastMeasure.status;
  chip.classList.remove("filling", "blocked");
  if (st === "overfull") {
    chip.classList.add("blocked");
    tx.textContent = "Overfull";
  } else if (st === "filling") {
    chip.classList.add("filling");
    tx.textContent = "Filling…";
  } else if (st === "settled") {
    tx.textContent = "Settled";
  } else {
    tx.textContent = "Ready";
  }
  $("msStatus").textContent = "● " + tx.textContent;
  advisories();
}

function advisories(): void {
  const s = store.get();
  const el = $("advisories");
  const innerLen = innerLength(s.bagL, s.endSeal);
  const hs = headspaceOf(innerLen, lastMeasure.fillLine);
  let out = "";
  if (lastMeasure.status === "overfull") {
    out += `<div class="advisory danger"><span class="ic">✕</span><span>Fill exceeds the seal jaw plane — lengthen the bag, widen it, or reduce the fill.</span></div>`;
  } else if (lastMeasure.status === "settled" && hs < 30) {
    out += `<div class="advisory"><span class="ic">!</span><span>Headspace ${fmt1(
      hs,
    )} mm after settling — under 30 mm risks product in the seal jaws.</span></div>`;
  }
  if (fillCount(s) >= MAX_PIECES) {
    out += `<div class="advisory"><span class="ic">!</span><span>Count capped at ${MAX_PIECES} pieces for the live simulation.</span></div>`;
  }
  el.innerHTML = out;
}

function liveReadouts(m: Measurements): void {
  const s = store.get();
  const innerLen = innerLength(s.bagL, s.endSeal);
  const hs = headspaceOf(innerLen, m.fillLine);
  const has = sim.particleCount > 0 && m.fillLine > 1;
  $("tbFH").textContent = has ? fmt1(m.fillLine) + " mm" : "—";
  const hsEl = $("tbHS");
  if (!has) {
    hsEl.textContent = "—";
  } else if (hs < 0) {
    hsEl.innerHTML = `<span class="dv">${fmt1(hs)} mm</span>`;
  } else if (m.status === "settled" && hs < 30) {
    hsEl.innerHTML = `<span class="wv">${fmt1(hs)} mm</span>`;
  } else {
    hsEl.innerHTML = `<b>${fmt1(hs)} mm</b>`;
  }
  $("msFH").textContent = has ? fmt1(m.fillLine) + " mm" : "—";
  $("msHS").textContent = has ? fmt1(hs) + " mm" : "—";
}

// ---------- main loop ----------
let last = performance.now();
let acc = 0;
let prevStatus = "ready";
function frame(now: number): void {
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);
  acc += dt;
  const h = 1 / 240;
  let guard = 0;
  while (acc > h && guard < 40) {
    sim.fixedStep(h);
    acc -= h;
    guard++;
  }
  lastMeasure = sim.measurements();
  // Apply a deferred envelope rebuild once the current fill has come to rest.
  if (dirty && !sim.isActive) rebuild();
  if (store.get().view === "fill") {
    renderer.draw(sim, {
      bagW: store.get().bagW,
      bagL: store.get().bagL,
      endSeal: store.get().endSeal,
      dropH: store.get().dropH,
      showDims: store.get().showDims,
    });
  }
  liveReadouts(lastMeasure);
  if (lastMeasure.status !== prevStatus) {
    prevStatus = lastMeasure.status;
    setStatusChip();
  }
  requestAnimationFrame(frame);
}

new ResizeObserver(() => {
  if (store.get().view === "fill") {
    renderer.draw(sim, {
      bagW: store.get().bagW,
      bagL: store.get().bagL,
      endSeal: store.get().endSeal,
      dropH: store.get().dropH,
      showDims: store.get().showDims,
    });
  }
}).observe($("sim"));

// ---------- boot ----------
rebuild();
updateReadouts();
advisories();
requestAnimationFrame(frame);
