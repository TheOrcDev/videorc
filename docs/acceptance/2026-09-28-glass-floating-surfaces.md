# Floating surfaces on the window glass (plan 072)

Date: 2026-09-28 · macOS 26.5.1 (Apple M4, built-in Retina display) · Electron
39.8.10 · dev app from `plan/072-glass-floating-surfaces`, isolated profiles.

The owner reported the Stream Manager `msg/min` hover card as a black slab,
"not our glass design". Every floating surface (hover cards, popovers,
tooltips, dropdown and context menus, selects, dialogs, the ⌘K palette,
toasts) painted `--popover`, a near-opaque `oklch(0.16 0.004 286 / 92%)`. On
the plan 050 window glass that reads about 0.09 OKLCH L darker than the window.

## S0: can a floating surface frost what it floats over?

Plan 050 banned CSS `backdrop-filter` after the June 2026 compositor wedge,
bisected on the old fake-frost setup. S0 re-tested it on the real-vibrancy
windows with a scratch probe (not committed). It forced
`backdrop-filter: blur(24px) saturate(1.5)` onto every Radix `*-content`
surface and onto synthetic tooltip-, menu- and dialog-sized layers, in the
main and Stream Manager pages, with the detached native preview presenting.

**No wedge.** There were 200 open/close cycles per window (synthetic layers
plus the real account-menu, output-select and highlight-position triggers),
and 79 more while the backend encoded a synthetic 1080p30 recording. Across
26 checkpoints the maximum double-rAF was 17.2 ms. Every CDP screenshot
succeeded, and every region capture was painted (Laplacian detail 354–814,
never blank).

| Measure                            | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| Native preview before → after      | 59.36 → 59.26 fps, 0 dropped, p95 20→21 ms |
| Encoder under the cycles           | 1,350 frames written, 0 dropped            |
| GPU-process CPU, idle, no frost    | 0.03%                                      |
| … hover-card-sized frost held open | 0.24%                                      |
| … dialog-sized frost held open     | 0.23%                                      |
| … after the cycles                 | 0.03%                                      |

**But the frost never reaches the screen.** The first `--surfaces` probe run
failed its bleed check (sharpness 45.6 dark / 23.9 light through the surface).
A debug launch compared three surfaces over the sidebar: the utility, an
inline `blur(24px)` with a coat, and a bare `blur(24px)` with no background.
All three have the computed `backdrop-filter` set. Chromium's own
`Page.captureScreenshot` shows the sidebar text blurred. The `screencapture
-R` of the window (what the display shows) shows the text sharp under a dark
tint, even for the bare layer that paints no colour at all. On these vibrancy
windows the filtered pass does not composite to the screen. That settles plan
072 on **Path B** (no blur), and the plan 050 guard against backdrop filters
stays as it was.

## The surface: an opaque raised step of the window glass

`glass-float` (styles.css) is an opaque coat in the window's measured tone,
plus the plan 050 chip edge: a 1 px rim, a top highlight and a sheen fading
down the first third. It is opaque because a 97% coat still leaked. Over a
dark coat, 3% of white text adds visible light, and the Stream Manager filter
labels ("Questions", "Mentions") read through the first opaque-ish hover card.

- Dark `oklch(0.275 0.004 286)`. The dark window glass measures L 0.187–0.261
  at the probe patch over the red, blue, white, black and text backdrops, so
  the surface is a raised step of +0.01 to +0.10.
- Light `oklch(0.99 0 0)`. The light window measures 0.943–0.964.

## S4: `probe:ui-glass --surfaces` (the gate)

`--surfaces` paints the real utility on the main and Stream Manager pages and
scores it with `scripts/lib/float-glass-checks.mjs`:

- **lift**: surface L minus window L at a text-free patch, per backdrop. The
  band is dark [-0.02, 0.12] and light [-0.04, 0.06].
- **contrast**: primary ≥ 7 and secondary ≥ 4.5 against the surface over
  white and black.
- **bleed**: sharpness of app text through the surface ≤ 0.5, below the
  sheen band, whose 8-bit gradient steps read as detail. The text is the
  sidebar rows (main) and the chat filter labels (Stream Manager).

- **opaque**: the surface's lightness spreads ≤ 0.01 across the five
  backdrops (measured 0.000 on every window and theme). This fails closed on a
  capture something else obscured, and on a coat that turns translucent.

Two ungated controls show what the gate catches. The old popover coat is the
lift control; a 97% `glass-float` coat is the bleed control.

| theme | window | lift (min…max) | old coat lift | secondary contrast | bleed through | 97% leak |
| ----- | ------ | -------------- | ------------- | -----------------: | ------------: | -------: |
| dark  | main   | +0.024…+0.097  | −0.092        |               5.59 |          0.00 |     0.66 |
| dark  | Stream | +0.013…+0.086  | −0.092        |               5.80 |          0.00 |     2.07 |
| light | main   | +0.028…+0.049  | +0.024        |               6.61 |          0.00 |     0.80 |
| light | Stream | +0.027…+0.048  | +0.024        |               6.60 |          0.00 |     2.15 |

`smoke:local-gates` runs `probe:ui-glass --gate --surfaces`.

Harness note: one full five-window run captured the Stream Manager's float
and control shots with the photo backdrop stacked over the window. The whole
window, surface included, read washed pale blue (L 0.406 for both the
surface and the old coat). That frame is a stacking glitch, not a surface
result. See the final run below.

## By eye (S5)

Real Radix surfaces were captured over the probe's photo backdrop in both
themes:

- the Stream Manager supporters stat hover card (the same `StatDetails` card
  as the owner's `msg/min`)
- the highlight-position dropdown and the account dropdown
- the output select and the ⌘K palette
- a stack of plain, success and error toasts. These were raised through the
  page's own `sonner` module (Vite serves the pre-bundled dep, so a dynamic
  import reaches the same toaster).

The hover card now reads as a raised grey glass panel above the window, with
a rim and a top highlight, and the filter labels under it no longer show. The
palette is one surface (its `Command` no longer double-coats the dialog).
Typed toasts keep monochrome text, never the old solid green or red slab.
(At merge the tone also tinted the toast's rim and sheen. On 2026-09-29 the
owner rejected that as a yellow panel, so the tone now lives in the icon
only.) The captures stay local
(no media in the tree).

Not captured: the tooltip. Its only consumer is a Library row, which an empty
profile does not have. It uses the same utility, and
`components/ui/desktop-scale.test.ts` pins that.

Owed: the owner's by-eye pass on the packaged app, and a look on the Windows
box (Mica). The coat is opaque there too, so only its tone needs judging.
