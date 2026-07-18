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
import { FillSim, initPhysics, FIXED_DT, type FillParams, type Measurements } from "./physics/world.js";
import { SceneRenderer, type CameraMode } from "./render/scene.js";
import { DimOverlay } from "./render/dims.js";
import { renderDieline } from "./render/dieline.js";
import { getBagStyle, type BagParams } from "./bagstyles/index.js";
import { parseStepBBox } from "./geometry/step.js";
import { webWidth, innerLength, headspace as headspaceOf, fmt1, MAX_PIECES } from "./geometry/index.js";
import {
  exportDielineSvg,
  exportDielinePng,
  exportDielineDxf,
  exportDielinePdf,
  exportSpecSheet,
  exportSpecCsv,
} from "./export/index.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const store = new Store();
const sim = new FillSim();
let renderer: SceneRenderer;
let dims: DimOverlay;

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
    product: { w: pd.w, h: pd.h, depth: pd.depth, round: pd.round, hull: pd.hull },
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
  renderer?.setProduct(prodDims(s));
  renderer?.frame(sim.envelope);
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
  ["minHeadspace", "minHeadspace"],
  ["jawClearance", "jawClearance"],
];
// Fields that must be strictly positive (a zero/blank is a blocker).
const positiveOnly = new Set(["pDia", "pThk", "pL", "pW", "pH", "pWt", "bagW", "bagL"]);
// Advisory-only fields — changing them must not rebuild/reset the physics.
const advisoryOnly = new Set(["minHeadspace", "jawClearance"]);

for (const [id, key] of numFields) {
  const input = $<HTMLInputElement>(id);
  const wrap = input.closest(".in");
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    const valid = Number.isFinite(v) && v >= 0 && !(positiveOnly.has(id) && v <= 0);
    wrap?.classList.toggle("invalid", !valid);
    if (valid) {
      store.set({ [key]: v } as unknown as Partial<AppState>);
      onChange(!advisoryOnly.has(id));
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
const btnSeed = $("btnSeed");
btnSeed.addEventListener("click", () => {
  const deterministic = !store.get().deterministic;
  store.set({ deterministic });
  btnSeed.classList.toggle("on", deterministic);
  btnSeed.title = deterministic ? "Deterministic replay (same seed)" : "New seed each drop";
});
$("vwFill").addEventListener("click", () => setView("fill"));
$("vwDieline").addEventListener("click", () => setView("dieline"));

// Camera presets (Fill view).
const camModes: Record<string, CameraMode> = { camIso: "iso", camFront: "front", camSide: "side" };
for (const [id, mode] of Object.entries(camModes)) {
  $(id).addEventListener("click", () => setCamera(mode));
}
function setCamera(mode: CameraMode): void {
  store.set({ camera: mode });
  for (const id of Object.keys(camModes)) $(id).classList.toggle("on", camModes[id] === mode);
  renderer?.setCamera(mode, sim.envelope);
  $("scalechip").textContent =
    mode === "iso" ? "¾ view · live 3-D sim · mm" : `${mode === "front" ? "Front" : "Side"} ortho · mm`;
}

function setView(view: "fill" | "dieline"): void {
  store.set({ view });
  $("vwFill").classList.toggle("on", view === "fill");
  $("vwDieline").classList.toggle("on", view === "dieline");
  $("dielineWrap").classList.toggle("show", view === "dieline");
  $("sim3d").style.display = view === "fill" ? "block" : "none";
  $("dimsOverlay").style.display = view === "fill" ? "block" : "none";
  $("camSeg").style.display = view === "fill" ? "flex" : "none";
  if (view === "fill") {
    $("scalechip").textContent =
      store.get().camera === "iso" ? "¾ view · live 3-D sim · mm" : `${store.get().camera} ortho · mm`;
    renderer?.resize();
  } else {
    $("scalechip").textContent = "Pillow dieline · fin seal · flat · mm";
    dims?.clear();
    drawDieline();
  }
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
    store.set({ stepDims: res.dims, stepName: f.name, stepHull: res.silhouette });
    $("upName").textContent = f.name;
    hint.style.color = "";
    hint.textContent = `BBOX ${fmt1(res.dims.l)} × ${fmt1(res.dims.w)} × ${fmt1(
      res.dims.h,
    )} mm · ${res.silhouette.length}-pt silhouette · ${res.pointCount.toLocaleString()} pts`;
    onChange();
  };
  rd.onerror = () => {
    hint.textContent = "Could not read the file.";
    hint.style.color = "var(--danger)";
  };
  rd.readAsText(f);
});

// ---------- exports (dropdown menus) ----------
function runDielineExport(fmt: string): void {
  const s = store.get();
  const model = getBagStyle(s.style).dieline(bagParams(s));
  switch (fmt) {
    case "svg": exportDielineSvg(model, s.bagW, s.bagL); break;
    case "pdf": exportDielinePdf(model, s.bagW, s.bagL); break;
    case "dxf": exportDielineDxf(model, s.bagW, s.bagL); break;
    case "png150": exportDielinePng(model, s.bagW, s.bagL, 150); break;
    case "png300": exportDielinePng(model, s.bagW, s.bagL, 300); break;
    case "png600": exportDielinePng(model, s.bagW, s.bagL, 600); break;
  }
}
function runSpecExport(fmt: string): void {
  if (fmt === "txt") exportSpecSheet(store.get(), lastMeasure);
  else if (fmt === "csv") exportSpecCsv(store.get(), lastMeasure);
}

function wireMenu(menuId: string, btnId: string, run: (fmt: string) => void): void {
  const menu = $(menuId);
  const btn = $(btnId);
  const close = () => {
    menu.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !menu.classList.contains("open");
    // Close any other open menu first.
    document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
    menu.classList.toggle("open", willOpen);
    btn.setAttribute("aria-expanded", String(willOpen));
  });
  menu.querySelectorAll<HTMLButtonElement>(".menu-list button[data-fmt]").forEach((item) => {
    item.addEventListener("click", () => {
      run(item.dataset.fmt!);
      close();
    });
  });
}
wireMenu("menuDieline", "btnExportDL", runDielineExport);
wireMenu("menuSpec", "btnExportSpec", runSpecExport);
// Dismiss menus on outside click / Escape.
document.addEventListener("click", () =>
  document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")),
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
});

// ---------- readouts ----------
function onChange(affectsPhysics = true): void {
  if (affectsPhysics) markDirty();
  updateReadouts();
  advisories();
  setStatusChip();
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

/** True when the fill has come within the user's jaw-clearance of the seal plane. */
function jawViolation(s: AppState): boolean {
  const innerLen = innerLength(s.bagL, s.endSeal);
  return sim.particleCount > 0 && lastMeasure.fillLine > innerLen - s.jawClearance;
}

function setStatusChip(): void {
  const s = store.get();
  const chip = $("statusChip");
  const tx = $("statusTxt");
  const st = lastMeasure.status;
  chip.classList.remove("filling", "blocked");
  if (st === "overfull" || jawViolation(s)) {
    chip.classList.add("blocked");
    tx.textContent = st === "overfull" ? "Overfull" : "Jaw risk";
  } else if (st === "filling") {
    chip.classList.add("filling");
    tx.textContent = "Filling…";
  } else if (st === "settled") {
    tx.textContent = "Settled";
  } else {
    tx.textContent = "Ready";
  }
  $("msStatus").textContent = "● " + tx.textContent;
}

function advisories(): void {
  const s = store.get();
  const el = $("advisories");
  const innerLen = innerLength(s.bagL, s.endSeal);
  const hs = headspaceOf(innerLen, lastMeasure.fillLine);
  let out = "";
  if (lastMeasure.status === "overfull") {
    out += `<div class="advisory danger"><span class="ic">✕</span><span>Fill exceeds the seal jaw plane — lengthen the bag, widen it, or reduce the fill.</span></div>`;
  } else if (jawViolation(s)) {
    out += `<div class="advisory danger"><span class="ic">✕</span><span>Fill is within the ${fmt1(
      s.jawClearance,
    )} mm jaw clearance — risks product in the seal jaws.</span></div>`;
  } else if (lastMeasure.status === "settled" && hs < s.minHeadspace) {
    out += `<div class="advisory"><span class="ic">!</span><span>Headspace ${fmt1(
      hs,
    )} mm after settling — under the ${fmt1(s.minHeadspace)} mm minimum.</span></div>`;
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
  } else if (m.status === "settled" && hs < s.minHeadspace) {
    hsEl.innerHTML = `<span class="wv">${fmt1(hs)} mm</span>`;
  } else {
    hsEl.innerHTML = `<b>${fmt1(hs)} mm</b>`;
  }
  $("msFH").textContent = has ? fmt1(m.fillLine) + " mm" : "—";
  $("msHS").textContent = has ? fmt1(hs) + " mm" : "—";

  const vol = has ? `${fmt1(m.fillVolume / 1000)} cm³ · ${fmt1(m.pctUsable)}%` : "—";
  $("tbVol").textContent = vol;
  $("msVol").textContent = has ? `${fmt1(m.fillVolume / 1000)} cm³` : "—";
  $("msPct").textContent = has ? `${fmt1(m.pctUsable)} %` : "—";
}

function drawDims(s: AppState): void {
  if (!dims || !renderer) return;
  if (!s.showDims) {
    dims.clear();
    return;
  }
  const container = $("sim3d");
  const env = sim.envelope;
  dims.draw(
    {
      mode: s.camera,
      bagW: s.bagW,
      bagL: s.bagL,
      bagD: 2 * env.usableHalfD,
      endSeal: s.endSeal,
      dropH: s.dropH,
      innerLen: env.innerLen,
      fillLine: lastMeasure.fillLine,
      headspace: lastMeasure.headspace,
      spawnY: env.spawnY,
      hasFill: sim.particleCount > 0 && lastMeasure.fillLine > 1,
    },
    renderer.camera,
    container.clientWidth,
    container.clientHeight,
  );
}

// ---------- main loop ----------
let last = performance.now();
let acc = 0;
let prevStatus = "ready";
function frame(now: number): void {
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.1);
  acc += dt;
  // Fixed timestep with substep clamping: a heavy frame degrades smoothly
  // (drops backlog) rather than spiralling. Determinism is per-substep.
  let guard = 0;
  while (acc > FIXED_DT && guard < 6) {
    sim.fixedStep();
    acc -= FIXED_DT;
    guard++;
  }
  if (guard >= 6) acc = 0;

  lastMeasure = sim.measurements();
  if (dirty && !sim.isActive) rebuild();
  const s = store.get();
  if (s.view === "fill") {
    renderer.draw(sim);
    drawDims(s);
  }
  liveReadouts(lastMeasure);
  const statusKey = `${lastMeasure.status}|${jawViolation(s)}`;
  if (statusKey !== prevStatus) {
    prevStatus = statusKey;
    setStatusChip();
    advisories();
  }
  requestAnimationFrame(frame);
}

// ---------- boot ----------
(async () => {
  await initPhysics();
  renderer = new SceneRenderer($("sim3d"));
  dims = new DimOverlay($("dimsOverlay") as unknown as SVGSVGElement);
  new ResizeObserver(() => {
    renderer.resize();
    if (store.get().camera !== "iso") renderer.setCamera(store.get().camera, sim.envelope);
  }).observe($("sim3d"));
  rebuild();
  setCamera(store.get().camera);
  updateReadouts();
  advisories();
  requestAnimationFrame(frame);
})();
