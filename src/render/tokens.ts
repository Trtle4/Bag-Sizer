/**
 * Design-system colour tokens, mirrored from the shared CSS `:root` so the
 * canvas (which can't read CSS custom properties) draws in the same palette.
 * Keep in sync with styles.css — these are the "keep identical" tokens.
 */
export const C = {
  paper: "#E9EDF0",
  panel: "#FFFFFF",
  ink: "#192227",
  ink2: "#59656C",
  ink3: "#8A959B",
  line: "#D2D9DE",
  line2: "#E3E8EB",
  accent: "#0F6E77",
  accent2: "#0B565D",
  valid: "#2F7D5B",
  warn: "#B0740F",
  danger: "#B23A2E",
  product: "#C89468",
  productEdge: "#A9754C",
  productLight: "#D6A87D",
  productDark: "#BC8759",
  film: "#59656C",
  filmLight: "#8FA0A8",
  tube: "#B7C1C7",
  sealHatch: "#C4CCD1",
} as const;

export const MONO = '"DM Mono", ui-monospace, monospace';
