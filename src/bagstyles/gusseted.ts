/**
 * Gusseted bag — roadmap stub.
 *
 * Typed placeholder so the UI can list it (disabled) and so enabling it later is
 * additive: fill in simProfile() with the side-gusset wall anchors and a
 * flat/box floor, and dieline() with the gusset panels. Not wired into the sim.
 */

import type { BagParams, BagStyle, DielineModel, SimProfile, SimProfileOpts } from "./types.js";

function notImplemented(what: string): never {
  throw new Error(`gusseted bag style: ${what} not implemented yet`);
}

function simProfile(_p: BagParams, _opts: SimProfileOpts): SimProfile {
  return notImplemented("simProfile");
}

function dieline(_p: BagParams): DielineModel {
  return notImplemented("dieline");
}

export const gusseted: BagStyle = {
  id: "gusseted",
  label: "Gusseted",
  enabled: false,
  simProfile,
  dieline,
};
