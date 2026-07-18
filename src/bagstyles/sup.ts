/**
 * Stand-up pouch (SUP) — roadmap stub.
 *
 * Typed placeholder. To enable: simProfile() returns a doyen/oval bottom floor
 * profile and outward-bowing walls; dieline() emits the bottom gusset panel and
 * its D-shaped seals. Not wired into the sim.
 */

import type { BagParams, BagStyle, DielineModel, SimProfile, SimProfileOpts } from "./types.js";

function notImplemented(what: string): never {
  throw new Error(`sup bag style: ${what} not implemented yet`);
}

function simProfile(_p: BagParams, _opts: SimProfileOpts): SimProfile {
  return notImplemented("simProfile");
}

function dieline(_p: BagParams): DielineModel {
  return notImplemented("dieline");
}

export const sup: BagStyle = {
  id: "sup",
  label: "SUP",
  enabled: false,
  simProfile,
  dieline,
};
