# Plan 072: Floating surfaces wear the window glass

Status: planned 2026-09-28 against `origin/main` `4d36bd76` (0.9.120);
**IMPLEMENTED 2026-09-28** on `plan/072-glass-floating-surfaces` (S0 to S5, see
[Implementation record](#implementation-record-2026-09-28)). S0 chose **Path
B**, and the coat went fully opaque. Owner by-eye acceptance on the packaged
app and a Windows look are owed. Priority P1, effort M, 6 slices.

## Problem

The owner shared a Stream Manager stat hover card (`msg/min` → "Chat ·
Messages in the last minute · Chatters"). It reads as a flat black slab on top
of the grey window glass. Every other floating surface in the app has the same
defect, because they all paint one token:

```
--popover (dark): oklch(0.16 0.004 286 / 92%)   ≈ #141417, near-opaque
--glass-window (dark): oklch(0.13 0.003 286 / 42%) over real macOS vibrancy
```

Plan 050 moved every _window_ onto real vibrancy with a thin coat, so the
window now reads as a mid-grey frost. It left floating surfaces on the old
near-opaque token (`styles.css` token contract: "bg-popover / bg-card
(near-opaque floating surfaces only)"). The window got lighter and the
floating surfaces did not. That is why popovers now read as black holes, not
glass. Light mode has the same gap, but it is less visible (a 92% white slab
on porcelain).

## Inventory: every floating surface

All of them come from shadcn primitives in
`apps/desktop/src/renderer/src/components/ui/`, so the fix is a token and
primitive change, not 30 screen edits.

| Surface                     | File:line                                     | Current paint                                          | Consumers (non-test files)                   |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| Hover card (the screenshot) | `ui/hover-card.tsx:28`                        | `bg-popover shadow-soft ring-1 ring-border`            | 1 (`stream-manager/stats-bar.tsx:104`)       |
| Popover                     | `ui/popover.tsx:27`                           | same                                                   | 5                                            |
| Tooltip                     | `ui/tooltip.tsx:42`                           | same                                                   | 1                                            |
| Dropdown menu + sub-menu    | `ui/dropdown-menu.tsx:40`, `:229`             | same                                                   | 5                                            |
| Context menu + sub-menu     | `ui/context-menu.tsx:58`, `:122`              | same                                                   | 1                                            |
| Select content              | `ui/select.tsx:70`                            | same                                                   | 10                                           |
| Select scroll buttons       | `ui/select.tsx:153`, `:171`                   | `bg-popover` (a second coat inside the first)          | via Select                                   |
| Dialog panel                | `ui/dialog.tsx:59`                            | `bg-popover shadow-glass`                              | 11                                           |
| Command                     | `ui/command.tsx:18`                           | `bg-popover`, ALWAYS nested in a Dialog or Popover     | `CommandDialog` + `source-select-searchable` |
| Chart tooltip               | `ui/chart.tsx:168`                            | `bg-popover shadow-lg ring-1`                          | 0 today (Bklit/charts)                       |
| Toasts (sonner)             | `ui/sonner.tsx` `--normal-bg: var(--popover)` | popover token; `richColors` tints success/error        | `App.tsx:43`                                 |
| Error boundary panel        | `components/error-boundary.tsx:28`            | `bg-popover shadow-glass`                              | app-wide                                     |
| On-thumbnail buttons        | `tabs/assets-tab.tsx:402`, `:490`             | `bg-popover` as a button backing (misuse of the token) | Assets tab                                   |

Two existing bugs make it darker still:

- **Double coats.** `Command` paints `bg-popover` inside a `DialogContent` or
  `PopoverContent` that already paints it. Two 92% coats stack to about 99%,
  the blackest surface in the app (palette, searchable source picker). The same
  goes for the Select scroll buttons inside Select content.
- **Two different rims.** The menus use `ring-1 ring-border dark:ring-foreground/10`.
  Dialogs use `shadow-glass`. Neither has the glass-chip top highlight that
  plan 050 gave every chip and keycap, so floating panels are the only glass
  pieces with no specular edge.

Out of scope: native `title=` tooltips (the OS draws them), Electron native
menus, the video-framing `bg-video-ground` / caption plates (content, not
chrome), and the main-process data-URL Preview window.

## Design decision

A floating surface is a **raised piece of the same glass**. One
`@utility glass-float` (styles.css), and one token family per theme column:

- `--glass-float`: the coat. Raised glass reads one step LIGHTER than the window
  in dark mode (like macOS menus over a dark window) and one step whiter in light.
- `--glass-float-sheen`: a top-to-bottom white gradient (the chip sweep, scaled
  to panel size), dark `oklch(1 0 0 / 6%) → transparent`.
- Rim `--chip-rim` (1 px), top highlight `inset 0 1px 0 var(--chip-highlight)`,
  and the drop from `--shadow-glass-panel`. These reuse the plan 050 chip
  language, so a menu and a badge share one edge.
- `prefers-reduced-transparency`: coat goes `--glass-solid`, and the sheen and blur go away.
  `prefers-contrast: more`: the rim takes the stronger `--chip-rim`.

Which coat depends on one open technical fact: **can CSS `backdrop-filter`
run again?** It was banned after the June 2026 compositor wedge (blank app
until restart). That bisect ran on the old fake-frost setup. Its sibling claim
("NSVisualEffectView paints opaque") turned out false on Electron 39.8.10 /
macOS 26.5.1 (see `docs/acceptance/2026-09-23-real-glass-calibration.md`).
S0 settles it:

- **Path A: real frost** (S0 passes). `--glass-float` is dark
  `oklch(0.2 0.004 286 / 60%)` plus `backdrop-filter: blur(24px) saturate(1.5)`,
  on floating surfaces ONLY. The guard test allows the one utility and still
  bans backdrop-filter everywhere else. This is the owner's ask exactly: the
  hover card becomes see-through frosted glass like the window.
- **Path B: tone-matched glass** (S0 fails). No blur, so the coat must stay
  near-opaque, or the rows underneath show through sharp (the July text leak).
  `--glass-float` becomes a solid colour calibrated to what the window glass
  _looks like_ as measured (probe sample of the Stream Manager / main window over
  the smoke backdrops, lifted by one step). The sheen, rim and highlight do the
  "glass" work. Starting value dark `oklch(0.27 0.004 286 / 97%)`, light
  `oklch(0.995 0 0 / 96%)`; S2 calibrates it.

Either way `--popover` / `--card` get retuned to the float base colour, so any
straggler that still says `bg-popover` lands on-tone rather than black.

Radii stay as they are (menus/popovers `rounded-lg`, dialogs `rounded-panel`,
tooltips `rounded-md`). Normalising them is a separate call.

## Route

Owner route **UI/Product Design** (fit 9). S0 is a compositor-risk probe
(`fable-5`); S1–S5 are scoped cosmetic work (`opus-4.8`). Load
`.claude/skills/videorc-design/SKILL.md` before any slice.

## Slices

### S0: backdrop-filter wedge probe (decides Path A or B)

In a scratch branch (never committed), add `backdrop-filter: blur(24px)
saturate(1.5)` to `DialogContent`, `PopoverContent`, `HoverCardContent`,
`DropdownMenuContent` and `TooltipContent` in a dev build. Then:

1. Run `pnpm probe:ui-glass --themes=dark,light` and confirm the windows still
   measure as real glass.
2. Script 200 open/close cycles of each surface over Studio with the native
   preview running (smoke command or CDP), in both the main and Stream Manager
   windows. After every 20 cycles, compare a CDP `Page.captureScreenshot` with a
   `screencapture -R` region capture. A blank or frozen region means a wedge.
3. Repeat step 2 while `pnpm smoke:recording-studio` records. Watch the renderer
   GPU process CPU and the preview cadence (`probe:preview-lifecycle` numbers
   must not regress).

Done when a note in `docs/acceptance/2026-09-xx-floating-glass.md` records
pass/fail with the evidence, and names Path A or B. Any wedge, any preview
cadence regression, or GPU CPU above +5 pp at idle means Path B.

### S1: `glass-float` utility and tokens

- `styles.css`: add the `--glass-float*` tokens to both columns, the Win32 Mica
  overrides (Mica shows no desktop, so Win32 takes Path B values even if macOS
  takes A), increase-contrast and reduced-transparency. Add
  `@utility glass-float` (coat, sheen as `background-image`, rim as `border`
  colour, highlight + drop as `box-shadow`, and blur on Path A). Update the
  token-contract comment: "Coats: … · glass-float (floating surfaces)".
- Retune `--popover` / `--card` to the float base.
- Path A only: relax `renderer-style-guards.test.ts` so that `backdrop-filter`
  is allowed in `styles.css` inside `@utility glass-float` and nowhere else.
  Keep the allowlist path check `sep`-normalised (the Windows CI trap).

Done when `pnpm typecheck && pnpm lint && pnpm --filter @videorc/desktop test`
pass and no component has changed yet.

### S2: move every primitive onto `glass-float`

- Swap `bg-popover shadow-soft ring-1 ring-border dark:ring-foreground/10` (and
  the `shadow-glass`/`shadow-lg` variants) for `border glass-float` in:
  hover-card, popover, tooltip, dropdown-menu ×2, context-menu ×2, select,
  dialog, chart tooltip, error-boundary.
- `command.tsx`: drop `bg-popover`, use `bg-transparent`, and let the host
  surface paint.
- `select.tsx:153/171`: scroll buttons go `bg-transparent`. On Path A, make sure
  their sticky position still hides rows scrolling beneath (the host blur is
  enough). Otherwise use a fade mask.
- `sonner.tsx`: `--normal-bg` goes to `var(--glass-float)` and the toast class
  gets `glass-float`. Check that `richColors` success/error toasts still read as
  tinted glass (they should become `glass-chip-tinted`-style tones, not flat
  green/red slabs). If `richColors` fights the utility, drop it and tint by
  `tone-*`.
- Re-grep for multi-line consumer overrides that repaint the surface
  (`className=` on any `*Content` carrying `bg-`, `ring-`, `shadow-`) and
  remove them.

Done when `rg "bg-popover" apps/desktop/src/renderer/src` returns only the
token definition, and the app typechecks, lints and passes unit tests.

### S3: stragglers and the regression guard

- `assets-tab.tsx:402/490`: the on-thumbnail kebab and style buttons use
  `glass-chip` (a control over an image), not the popover token.
- Add a guard to `renderer-style-guards.test.ts`. Every file under
  `components/ui/` that renders a Radix `*Content` / sonner toast must contain
  `glass-float`, and `bg-popover` / `bg-card` may not appear outside
  `styles.css`. That stops the next shadcn `add` from bringing back a black
  surface.
- Update `.claude/skills/videorc-design/SKILL.md`: the Tokens and shadcn-mapping
  rows for Menus/popovers/Dialogs/Toasts now say `glass-float`. Remove "solid-
  fallback surface".

Done when the guard fails on a deliberately reverted primitive (check it
locally, then restore).

### S4: measure it (probe) and calibrate Path B

Extend `scripts/ui-glass-probe.mjs` with `--surfaces`. Open the Stream Manager
stat hover card, a dropdown, a Select, a dialog and a toast through the smoke
command client (never by activating the app). Region-capture each one and
report for each surface:

- `lift`: the surface interior's OKLCH L minus the window glass beside it.
  Dark must be `0.03 ≤ lift ≤ 0.12` (a raised step, never a black hole). Light
  must be `-0.02 ≤ lift ≤ 0.04`.
- `contrast`: `--popover-foreground` / `--muted-foreground` against the sampled
  surface over white and black backdrops. Primary ≥ 7, secondary ≥ 4.5 (the
  plan 050 thresholds).
- Path A only: `sharpness` of the backdrop text seen through the surface must
  stay ≤ the window's `maxSharpness` (6). No legible bleed.

On Path B, tune `--glass-float` until `lift` passes on both themes. Add
`--surfaces` to the `--gate` run used by `smoke:local-gates`.

Done when `pnpm probe:ui-glass --gate --surfaces` passes on dark and light, and
the calibration numbers are recorded in the S0 acceptance note.

### S5: by-eye pass and PR

- Screenshots (dark + light) of every surface in the inventory, taken in the
  main window and the Stream Manager window, including the exact `msg/min`
  hover from the owner's report, stored in the acceptance note.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`, `pnpm build`,
  `pnpm check:renderer-assets` (eager budget: the utility is CSS, so the budget
  should hold; CI Linux gzip is the gate, see the renderer-budget drift note),
  `pnpm probe:ui-glass --gate --surfaces`, and on Path A
  `pnpm probe:preview-lifecycle` on an idle machine.
- One PR, `feat/072-glass-floating-surfaces`. Owner by-eye acceptance is owed
  before release. Windows (Mica, Path B values) needs an on-box look.

## Risks

- **Path A compositor wedge** returning under load that S0 did not cover. The
  mitigation is one utility, so rolling back to Path B is a token edit.
  `VIDEORC_GLASS=0` already forces the solid palette, and glass-float must
  honour it (the solid coat).
- **Blur cost over a live preview.** Surfaces open over Studio mid-stream. S0
  step 3 is the gate, and short-lived surfaces (tooltips, hover cards) matter
  most because they open often.
- **Text leak on Path B** if someone lowers the alpha later. The S4 probe gate
  catches it.
- **Toast `richColors`** may override the background. It is handled in S2.

## Implementation record (2026-09-28)

Evidence: [docs/acceptance/2026-09-28-glass-floating-surfaces.md](../docs/acceptance/2026-09-28-glass-floating-surfaces.md).

- **S0 → Path B.** There was no compositor wedge: 200 cycles per window plus
  79 under encoder load, the preview held 59 fps, and the GPU cost was
  +0.2 pp. But `backdrop-filter` never reaches the screen on the vibrancy
  windows. Chromium's own capture shows the blur; the display shows a tint
  over sharp text. The guard against backdrop filters stays as plan 050 left
  it.
- **Deviation: the coat is opaque, not 97%.** A 97% coat let the white
  Stream Manager filter labels read through the hover card (bleed 2.07,
  against 0 when opaque). Without a frost, translucency buys nothing. Dark is
  `oklch(0.275 0.004 286)`, light `oklch(0.99 0 0)`, plus the chip rim, top
  highlight and sheen.
- **Deviation: `--card` is untouched.** It paints in-window cards
  (`PanelSection`, the co-host nudge), not floating surfaces. Only `--popover`
  follows `--glass-float`.
- **Deviation: the Assets on-thumbnail buttons use `glass-float`, not
  `glass-chip`.** A chip's 10%→3.5% white is nearly transparent over a photo,
  and the old backing was opaque.
- **Deviation: no Win32 override.** With no blur anywhere, Windows takes the
  same opaque coat, so there is nothing platform-specific left to tune except
  the tone, on the box.
- **Toasts:** sonner injects unlayered CSS, so the toast glass lives in an
  unlayered `styles.css` block that outranks sonner by specificity:
  `@apply glass-float`, plus `tone-*` per type, which colours the icon only.
  The `richColors` slab colours are pointed at the glass and the text stays
  monochrome. (A tinted rim and sheen per type shipped in #488. The owner
  rejected the amber-washed warning toast on 2026-09-29, and the follow-up
  removed it.) Keeping it in CSS
  kept the renderer eager JS under its 2,000,000-byte raw budget. Main sits
  at 2,000,010; this branch builds 1,999,654.
- **S4:** `probe:ui-glass --surfaces` gates lift, contrast and bleed (below the
  sheen), with the old coat and a 97% coat as ungated controls.
  `smoke:local-gates` runs it. A full five-window gate passed.
- `.agents/skills/videorc-design/SKILL.md` is a stale pre-050 copy. Only its
  floating-surface lines were corrected; the `.claude` skill is current.
