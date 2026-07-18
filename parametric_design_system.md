# Parametric Tools — Shared Design System

Purpose: make a second app visually cohesive with the Cookie Tray Sizer. Apply these
tokens, fonts, and component patterns verbatim. This is presentational only — it does not
dictate app logic, layout content, or geometry. Where an app's needs differ, keep the
tokens and patterns; only the content changes.

The identity is a **precision drafting instrument**: calm, measured, data-forward, a large
canvas/viewport as the hero, and numbers treated as first-class (monospace, aligned, like a
spec sheet). Warm and approachable, not cold or corporate.

Explicitly AVOID the three "AI-default" looks: cream + serif + terracotta (~#D97757);
near-black + acid/neon accent; broadsheet hairline columns. If the result drifts toward any
of these, correct it.

---

## 1. Design tokens (drop into `:root`, use verbatim)

```css
:root{
  /* surfaces — cool paper, not cream */
  --paper:#E9EDF0;   /* app background */
  --panel:#FFFFFF;   /* cards, header, control column */
  --panel-2:#F3F6F8; /* subtle raised/secondary fill */
  --recess:#E7ECEF;  /* segmented-control track, inset wells */

  /* ink */
  --ink:#192227;     /* primary text */
  --ink-2:#59656C;   /* labels, secondary text */
  --ink-3:#8A959B;   /* muted, units, eyebrows, hints */

  /* lines */
  --line:#D2D9DE;    /* hairline borders */
  --line-2:#E3E8EB;  /* lighter internal dividers */
  --grid:#DBE1E6;    /* drafting-grid lines on the canvas */

  /* accent — quiet petrol teal, PRIMARY ACTIONS ONLY */
  --accent:#0F6E77;
  --accent-2:#0B565D;   /* hover/pressed */
  --accent-soft:#E0F0F1;/* tint bg for active toggles / focus ring */

  /* semantic state (use by MEANING, not decoration) */
  --valid:#2F7D5B;      /* valid / ready / exportable */
  --warn:#B0740F;       /* clamped / advisory (non-blocking) */
  --warn-soft:#FBF0D8;
  --danger:#B23A2E;     /* blocked / invalid input */

  /* radii */
  --r:9px; --r-sm:6px;

  /* type */
  --sans:"Hanken Grotesk",system-ui,sans-serif;
  --mono:"DM Mono",ui-monospace,monospace;
}
```

**App-specific accent (optional):** if you want each tool to have a subtle identity while
staying in the family, keep EVERYTHING above and change only `--accent` / `--accent-2` /
`--accent-soft` to a different but equally muted, desaturated hue (e.g. an ink-indigo or a
deep moss). Keep the semantic state colors (`--valid/--warn/--danger`) identical across all
apps — those must mean the same thing everywhere. Default is to share the teal.

**Domain/material color:** the tray app uses `--product:#C89468` for the cookie color in the
viewport. Each app can define its own 1–2 domain colors for whatever it renders; keep them
muted so they don't fight the teal accent.

---

## 2. Fonts

Load once in `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Rules:
- **Hanken Grotesk** for all interface text (labels, buttons, headings, body).
- **DM Mono** for numbers ONLY where alignment/precision matters: input values, derived
  readouts, dimension callouts, the title block, eyebrow labels, unit tags, pill/part tags.
- Turn on tabular figures (`font-variant-numeric: tabular-nums`) for anything that updates
  live, so digits don't jitter as values change.
- Body base: 14px / line-height 1.45, `-webkit-font-smoothing:antialiased`.

Type scale (approx, adjust per app): wordmark 16px/600 tracking -0.01em; section eyebrow
10.5px mono uppercase tracking 0.13em `--ink-3`; field label 12.5px/500 `--ink-2`; input &
data value 13px mono/500 `--ink`; small hint 11px mono `--ink-3`.

---

## 3. Core components (patterns to reuse)

**Header bar** — `--panel` bg, 56px tall, `1px solid var(--line)` bottom border. Left:
wordmark (Hanken 600) + a mono "part/rev"-style pill (`--ink-3`, hairline border, pill
radius). Right: a state chip + primary/secondary action buttons.

**Buttons** — radius `--r-sm`, 8px/15px padding. Default: `--panel` bg, `--line` border,
`--ink` text; hover raises border to `--ink-3`. Primary: `--accent` bg/border, white text;
hover `--accent-2`. Keep exactly one primary action visible at a time.

**Control column** — `--panel` bg, `1px solid var(--line)` divider from the canvas, scrolls
independently. Grouped into numbered sections; each section has a mono eyebrow
(`01 SECTION NAME`, uppercase, tracked, `--ink-3`, with the number in `--accent`) and a
`--line-2` top divider.

**Fields** — label (12.5px/500 `--ink-2`) above an input wrapper: `--panel` bg,
`1px solid var(--line)`, radius `--r-sm`. Value text in DM Mono. Optional unit tag on the
right, `--ink-3`, separated by a `--line-2` divider. Focus: border → `--accent`, plus
`box-shadow:0 0 0 3px var(--accent-soft)`. Use a 2-up grid (`1fr 1fr`, ~11px gap) for
paired short fields.

**Segmented toggle** — `--recess` track, 3px padding; the active segment gets a `--panel`
chip with a soft shadow and `--ink` text; inactive segments `--ink-2`. Use for binary/enum
choices (e.g. mode switches, axis, shape).

**Canvas / viewport (the hero)** — subtle backdrop: a soft radial/vertical gradient from
`--panel-2` to `~#DCE2E7`, plus a faint drafting grid built from two 1px `--grid`
linear-gradients at ~24px, masked to fade at the edges. This is the signature backdrop —
reuse it for whatever each app renders.

**Floating toolbar** — a `--panel` pill (radius 10px, `--line` border, soft shadow) centered
over the top of the canvas, holding view/mode controls. Active control: `--accent-soft` bg,
`--accent-2` text. Min tap target 44px on touch.

**Advisory / warning** — non-blocking notices use `--warn-soft` bg, an amber-tinted border,
and `--warn` text with a mono `!` marker. Reserve `--danger` (red field borders + message)
for genuinely blocking/invalid input. State color must always match meaning.

---

## 4. Two signature elements (adopt if the app suits them)

These are what make the Cookie Tray app feel like a *drafting instrument*. Reuse them where
the app has an equivalent, so the family reads as one.

1. **Engineering title-block** — a bordered box anchored in a canvas corner, styled like the
   title block on a real technical drawing: a dark (`--ink`) header strip with mono uppercase
   labels, then rows of `KEY | value` in DM Mono holding the app's derived/summary readouts.
   On mobile it must NOT float over the canvas — drop it below as a static two-up spec panel.

2. **Live dimension callouts** — key derived measurements drawn over the canvas as technical
   dimension lines (thin `--ink-2` lines, small arrowheads, mono numbers, `--accent`
   dash-dot centerlines where useful), updating as inputs change. Only where an app actually
   has spatial dimensions to annotate.

---

## 5. Motion & quality floor

- Motion restrained: ease view/state transitions, subtle control hovers, fade/slide-in for
  banners and callouts. Nothing bouncy, glowing, or ambient. Respect
  `prefers-reduced-motion`.
- Responsive down to 390px; the control column stacks above the canvas, no horizontal
  overflow, floating overlays relocate below the canvas.
- Visible keyboard focus everywhere; 44px min tap targets on toolbar/touch controls.
- Watch CSS specificity so section/element selectors don't cancel component paddings.

---

## 6. What to keep identical vs. what can vary

**Keep identical across all parametric apps:** the font pairing, the full surface/ink/line
token set, the semantic state colors, the field/button/segmented/advisory patterns, the
canvas backdrop treatment, the header structure, the title-block styling, and the mobile
"overlay drops below the canvas" rule.

**Allowed to vary per app:** the wordmark text and part tag, the `--accent` hue (optional,
kept equally muted), the app's own domain/material render colors, the section names and
field content, and whether the live-dimension-callout signature applies (only if the app has
dimensions to show).
