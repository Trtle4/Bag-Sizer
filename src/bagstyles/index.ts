import type { BagStyle } from "./types.js";
import { pillow } from "./pillow.js";
import { gusseted } from "./gusseted.js";
import { sup } from "./sup.js";

export * from "./types.js";
export { pillow, gusseted, sup };

export type BagStyleId = "pillow" | "gusseted" | "sup";

/** All styles in UI order. Disabled ones render but can't be selected. */
export const BAG_STYLES: BagStyle[] = [pillow, gusseted, sup];

export function getBagStyle(id: BagStyleId): BagStyle {
  const s = BAG_STYLES.find((b) => b.id === id);
  if (!s) throw new Error(`unknown bag style: ${id}`);
  return s;
}
