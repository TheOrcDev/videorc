# Plan 208: Liquid Chrome colours

**Status:** PLANNED 2026-10-27. D1 to D5 are owner decisions (2026-10-27);
D6 to D13 are recommendations the executor uses unless the owner changes
them. **Priority:** P1. Every screen changes. **Owner request:** "let's plan
out complete redesign of our Videorc color. I really love our new
onboarding live background thing that we have. let's put same colors like
that so metallic black with that shine, and similar just other way around
in light mode." **Size:** L: one baseline slice (S0), one asset slice (S1),
one window slice (S2), one probe slice (S3), three UI slices (S4 controls,
S5 Welcome, S6 phone remote and sign-in page) and one docs and acceptance
slice (S7). **Planned against:** Videorc `origin/main` `dc1309cb`. The
shared checkout is weeks behind on `feat/windows-owner-waiver`, so work in a
fresh worktree from `origin/main`. **Owner route:** Orchestrator planned it
(fit 10); the owner chose from a rendered mockup of three directions. Lanes
per slice below, from `CLAUDE.md`.

## Goal

Videorc wears the Welcome screen's material everywhere. In dark mode every
window sits on black Liquid Chrome: a frosted still of the Polished look
under the panes, so the black reads as metal with soft silver streaks, and
the controls you touch are polished chrome. In light mode the same chrome
is turned the other way around: white liquid metal with dark reflections,
and black-chrome controls. Red stays the one brand colour (Record, On air,
destructive), and it becomes a lit LED instead of a flat tint. Nothing moves
except on the Welcome screen, so the new look costs nothing while you
record.

## What's there today (verified on `dc1309cb`)

- **Windows are clear glass (plan 091).** `src/main/window-glass.ts` gives
  every window macOS vibrancy (`under-window`, pinned `active`). The native
  addon (`crates/videorc-native-preview-addon/src/lib.rs`,
  `VideorcClearGlassView`) strips AppKit's tint so only a 60 pt blur of
  the desktop shows through. Windows 11 uses Mica, and Windows 10 and Linux
  paint the solid palette (`GlassMode` `material` / `mica` / `solid`).
  `VIDEORC_GLASS=0` forces solid, and `VIDEORC_GLASS_STYLE=material` is
  AppKit's own look.
- **Coats decide the tone.** `styles.css` cuts every coat from
  `--glass-base` and two covers, which set how much of the base a region
  paints over the blur. Dark is base `0.16 0.004 286` with sidebar 0.88 and
  work 0.83. Light is `0.985 0.001 286` with 0.93 and 0.86. Windows Mica has
  its own covers (`data-platform='win32'`). The body paints
  `--glass-window`, and the sidebar and panes add their deltas.
  `prefers-reduced-transparency` swaps in `--glass-solid`, and
  `prefers-contrast: more` puts both covers at 95%.
- **The palette has a faint blue cast.** Every neutral carries hue 286 at
  chroma 0.001 to 0.004. Liquid Chrome is truly neutral.
- **Main-side mirrors.** `src/main/window-palette.ts`
  (`DARK_WINDOW_PALETTE` `#0D0D0F` and friends, `LIGHT_WINDOW_PALETTE`
  `#FAFAFB`) feeds the Preview frame's data-URL document and the solid
  BrowserWindow bases. `window-palette.test.ts` pins the parity with
  `styles.css`. `index.ts` updates the solid base on theme changes
  (`setBackgroundColor(solidWindowBase(...))`, lines ~1921, ~2004 and ~2222).
- **Controls are flat.** The `Button` default is a flat `bg-primary`
  (near-white in dark, ink in light). The Studio's Record is the
  `destructive` variant (a 10 to 20% red tint with red text), Go Live… is
  `outline`, and the stop button is `destructive`
  (`components/studio/session-panel.tsx`). The Switch, Slider,
  ParameterSlider, Fader, Checkbox, Progress and Avatar use `bg-primary` or
  `--knob` inside `components/ui/` only. Chips and keycaps are already
  gradient glass (`glass-chip`, `glass-keycap` in `styles.css`). Floats
  (menus, dialogs, tooltips, toasts) are flat opaque tiers by design
  (plan 091 D6).
- **The renderer is token-disciplined.** There are no raw palette classes
  (`bg-zinc-*`, `bg-white`, …) outside a handful of overlay and caption
  files that draw stream content. The redesign is tokens plus primitives,
  not a screen-by-screen restyle.
- **The Welcome backdrop** (plan 203 S4,
  `components/first-run/welcome-backdrop.tsx`,
  `lib/live-background-player.ts`) draws Liquid Chrome Polished at Normal
  through the shared WebGL2 player. It puts the poster first, caps at
  30 fps, falls back to a still with a reason, and uses the same look in
  both themes, dimmed 30% under dark. `smoke:first-run` drives it.
- **The Liquid Chrome shader is dark only** (`liquid_chrome.frag`: a black
  studio with white lamps). A light look would need new environment
  lighting in all four renderers plus posters and goldens. Inverting the
  dark look's pixels gives "the other way around" exactly, and it was the
  owner's pick from the mockup.
- **The phone remote** (`crates/videorc-backend/remote_web/app.css`) and
  **the OAuth page** (`crates/videorc-backend/oauth_page/index.html`) carry
  their own copies of the old palette (`#0d0d0f`, `#141417`, …) and follow
  `prefers-color-scheme`.
- **Proof today.** `pnpm probe:ui-glass --gate --surfaces` (in
  `smoke:local-gates`) measures glass transmission, sharpness, contrast,
  neutrality, `nativeClear` and `ghostexParity` over stand-in desktops.
  `scripts/ui-theme-screens.mjs` captures tabs in both themes.
  `renderer-style-guards.test.ts` fails on any CSS backdrop filter.
  `renderer-security-policy.test.ts` keeps the retired wallpaper feed out.
- **The design skill forbids this today.** Hard rule 2 says "Real glass,
  never fake glass … No wallpaper underlays", and the window family is built
  on clear glass. S7 rewrites both as the owner's new call.

## Measured: how much chrome can show under text

A 1280 × 720 Polished poster blurred at σ 24 spans sRGB grey 0.024 to 0.92
(dark). The inverted one spans 0.079 to 0.976 (light, where the blur lifts
the black lines). Chromium blends coats in gamma-encoded sRGB. Keeping
secondary text (`--muted-foreground`) at 4.5:1 over the brightest crest
(dark) or the darkest line (light) needs:

- **Dark:** a work cover ≥ 0.80 (today 0.83). At 0.82 a crest composites to
  about `#303030` on a `#0a0a0a` trough: visible silver streaks.
- **Light:** a work cover ≥ 0.85 (today 0.86). At 0.86 a line composites to
  about `#dadada` on `#fafafa`: visible graphite streaks.

Today's covers already pass, because they were sized for a white (dark) or
black (light) desktop. The difference is that the ground is now ours, so S2
proves contrast with a unit test against the real pixels instead of a probe
over stand-in desktops.

## Owner decisions

- **D1. What's behind the panes. DECIDED (owner, 2026-10-27): Liquid
  Chrome behind the whole app, solid.** Every window (D7 lists them) gets
  an opaque chrome ground: a frosted still of Liquid Chrome under the
  theme's coats. The window is opaque on every platform: no vibrancy, no
  Mica, no desktop showing through. The panes stay translucent over the
  chrome. Asked "is it going to stay a little bit transparent?", the owner
  chose solid chrome over a hint of desktop (2026-10-27).
- **D2. How much shine. DECIDED (owner, 2026-10-27): controls and edges.**
  The changes:
  - Primary buttons are polished chrome.
  - Switch knobs and slider thumbs are chrome beads.
  - Selected rows and active segments get a sheen plate.
  - Chips and keys get a crisper top highlight.
  - Record is a red LED.

  Panels, text, menus, dialogs and toasts stay flat (their plan 091 D6
  recipe, neutralised). There is no gradient text and no sheen on the
  toolbar or panes.
- **D3. Light mode chrome. DECIDED (owner, 2026-10-27): crisp invert.**
  The light ground and the Welcome screen's light backdrop are the Polished
  look with its pixels inverted: white liquid with black reflections, as
  much contrast as dark Polished. No new shader look (D4).
- **D4. Scope. DECIDED (owner, 2026-10-27): the desktop app's windows, plus
  the phone remote and the OAuth page.** The website (`videorcweb`), Stream
  Deck icons and a selectable light Liquid Chrome look in Backgrounds are
  out of scope (see Out of scope).
- **D5. Nothing moves outside the Welcome screen.** Stated to the owner
  before the questions; not objected. The ground is a still image. A moving
  ground would spend GPU on every window while recording or streaming.

Recommendations (used unless the owner changes them):

- **D6. Colour stays information.** Red (`--live`, `--destructive`) is
  still the one brand colour. Green, amber, info, member and reward keep
  their hues, are re-checked on the neutral solids, and change only if a
  check fails. Retro LCD keeps its own screens: its panels are opaque and
  sit on the new ground unchanged.
- **D7. Which windows get the ground.** Main, Stream Manager, Captions and
  Notes get it, following the app theme as today. The Preview window
  stays solid neutral black: it frames video, and a pattern around a
  picture competes with it. The docked preview's slot keeps its solid
  `--video-ground`. The Welcome screen's moving backdrop covers the ground
  while setup is open.
- **D8. Record, Go Live and Stop.**
  - A new `Button` variant, `record`, is a red LED: red glass with a top
    highlight. It's unlit at idle, and its glow comes on while a
    recording or livestream runs.
  - Record uses it. While running, the stop button ("Stop recording" or
    "End livestream") uses it lit.
  - **Go Live… becomes the chrome primary** (`default`), as in the
    approved mockup.
  - Delete, Remove and every other destructive action keep the quiet red
    tint (`destructive`), so a lit LED only ever means record or live.
  - Flag for the owner's by-eye: this makes Go Live… louder than today's
    outline button.
- **D9. The old glass stays reachable for one release.** `VIDEORC_GLASS=clear`
  restores the plan 091 clear glass on macOS (and Mica on Windows), without
  the ground, as the A/B control for the owner's by-eye and an escape
  hatch. `VIDEORC_GLASS=0` stays the plain solid palette (no ground, the
  debug mode). A follow-up removes vibrancy, Mica and the native strip once
  a release has shipped with the ground.
- **D10. Covers.** Start at dark sidebar 0.88 and work 0.82, and light
  sidebar 0.92 and work 0.86, on every platform (the Windows overrides go).
  The floor is what the S2 contrast test computes from the ground's real
  pixels (about 0.80 dark and 0.85 light). The owner's by-eye may lower a
  cover toward the floor to show more chrome, never past it.
- **D11. The ground is sized to the display, not the window.** It covers
  the window's display and is centred on it. Resizing a window shows more
  or less chrome and never rescales it. A window moved to another display
  re-sizes on the next resize event.
- **D12. Accessibility.** `prefers-reduced-transparency` hides the ground
  and paints `--glass-solid` (neutral, as today). `prefers-contrast: more`
  keeps 95% covers and the stronger hairlines and rims. Under both, the
  chrome controls keep their gradients (they're opaque) and gain the
  stronger rim.
- **D13. Phone remote and OAuth page.** The phone remote gets the neutral
  palette, the chrome primary, the LED Record and the ground behind its
  page. The OAuth page ("you can close this tab") gets the neutral palette
  and the chrome primary only: it's a three-second page in someone's
  browser.

## What the user will see

- **Dark.** The window is deep neutral black with soft silver streaks
  under the sidebar and panes, like the Welcome screen seen through smoked
  glass. Primary buttons ("Go Live…", "Continue", "Save") are polished
  silver with dark text. Record is a red LED that lights while you record.
  Switches turn silver when on, with a black bead. Slider thumbs are chrome
  beads. The selected sidebar row is a soft polished plate. Text, menus and
  dialogs look like today, minus the faint blue cast.
- **Light.** The same window turned the other way around. Porcelain white
  with faint graphite streaks under the panes, black-chrome primary
  buttons with white text, black switch tracks with a pearl bead, and the
  same red LED. The Welcome screen is white liquid metal with black
  reflections.
- **Everywhere.** Mac, Windows and Linux look the same: the ground is
  Videorc's own, so it no longer depends on the desktop, Mica or the
  compositor. Your desktop no longer shows through.

## Slices

### Slice S0: before pictures (no product change)

**Route / lane:** Implementation, fit 5, `Composer 2.5`.

**Changes:** none. On `origin/main`, run `node scripts/ui-theme-screens.mjs
studio sources scene assets livestream library settings buddy` (with
`env -u ELECTRON_RUN_AS_NODE`). Capture the Stream Manager, the Captions
reader, Notes and the Welcome screen in both themes. Keep the PNGs out of
the tree. List their paths in
`docs/acceptance/2026-10-27-liquid-chrome-colours.md` (new) under
"Before".

**Done when:** the acceptance doc names a before image for every surface
S7 will compare, in both themes.

### Slice S1: the ground images (assets, no UI change)

**Route / lane:** Implementation, fit 7, `gpt-6.1-sol`. Read
`docs/live-backgrounds.md` first.

**Files:**
- A generator. Extend the poster pipeline
  (`pnpm probe:live-background-cost -- --mode posters`, which uses the
  backend's `image` crate) with a `grounds` mode, or write a sibling script
  that uses it.
- Its outputs `assets/backgrounds/chrome-ground-dark.webp`,
  `chrome-ground-light.webp` and `chrome-ground.stats.json`.
- A test.

**Changes:**

1. Render Liquid Chrome Polished at its poster phase at 1280 × 720 (blurred
   and upscaled by CSS, so it doesn't need to be larger). Apply a Gaussian
   blur, σ 24 to start, and encode WebP at ≤ 40 KB. The light ground is the
   same pixels inverted before the blur.
2. Write `chrome-ground.stats.json`: per asset, the minimum and maximum
   sRGB grey and the mean, plus the generator's version and inputs (look,
   phase, size, σ).
3. A test re-reads both WebPs and fails if the stats file doesn't match
   them, so the contrast test in S2 can never read stale numbers.
4. The generator is rerunnable and never hand-edited. The command goes in
   `docs/live-backgrounds.md`.

**Verification:** the new test, `cargo test -p videorc-backend` scoped to
it (or the script's own test), and `pnpm check:text-files`.

**Done when:** rerunning the generator reproduces both images and the stats
file, and the stats test passes.

### Slice S2: the chrome ground on every window (main and renderer)

**Route / lane:** Implementation, fit 9, `fable-5.1`. Window material on
three platforms, first paint, theme changes and accessibility: multi-system
and release-critical. Read the whole `.claude/skills/videorc-design/SKILL.md`
(the window family), `AGENTS.md` (native preview rules) and
`src/main/window-glass.ts` first.

**Files:** `src/main/window-glass.ts` and its test, `src/main/index.ts`
(window creation and the theme paths that call `solidWindowBase`),
`src/main/window-palette.ts` and its test, `styles.css`, a new
`components/chrome-ground.tsx` and its test, each window root
(`WindowProviders` or the roots it wraps), and `theme-bootstrap.js` if the
ground mode must be known before first paint.

**Changes:**

1. **A `ground` mode.** `resolveGlassMode` returns `{ kind: 'ground' }` by
   default on every platform. `windowGlassOptions` gives it an opaque
   window: no `vibrancy`, no `backgroundMaterial`, and `backgroundColor`
   set to the theme's solid base. The macOS title bar recipe is unchanged.
   `VIDEORC_GLASS=clear` returns today's material or Mica path (D9), and
   `0` stays `solid`. The Preview role stays solid dark (D7). Record the
   applied mode as today (`recordAppliedGlass`) so diagnostics and probes
   can read it.
2. **The renderer knows the mode before first paint.** Main passes it the
   same way the window already learns its role or appearance (check
   `window-appearance.ts` and the preload first; don't add a second
   channel), and the root gets `data-ground="chrome|glass|solid"`.
3. **`ChromeGround`.** One component, mounted once per window root while
   `data-ground="chrome"`, under everything (`aria-hidden`, no pointer
   events, `position: fixed`, the lowest layer):
   - It paints the theme's ground image, imported with `?no-inline` so the
     eager bundle doesn't grow.
   - It's sized to the display and centred (D11).
   - It has no CSS filter, no transition, no animation and no
     `backdrop-filter`.
   - It doesn't render while the Welcome screen is open, or under
     `prefers-reduced-transparency` (a media query, so a runtime change
     applies at once).
   - The body keeps painting `--glass-window`, and the sidebar and panes
     keep their deltas. The coat math is unchanged.
4. **Neutral tokens.** In both columns of `styles.css`, every neutral
   becomes chroma 0 (hue 286 goes). Dark `--glass-base` becomes `0.13 0 0`
   (the chrome's own black), and light becomes `0.985 0 0`. The covers move
   to D10's numbers on every platform, and the `data-platform='win32'`
   cover overrides go. Floats, text tiers, hairlines, scrollbar and
   `--video-ground` are neutralised in the same edit. `window-palette.ts`
   mirrors the new solids, and `--chip-*` and `--keycap-*` are neutralised
   only (S4 retunes them). `--live`, `--destructive` and the status tones
   are untouched (D6).
5. **Contrast is a test, not a probe.** Extend `window-palette.test.ts` (or
   add `chrome-ground-contrast.test.ts`). For each theme and region, it
   composites the coat over the ground's extreme pixel from
   `chrome-ground.stats.json`, the way Chromium does (gamma-encoded sRGB,
   coat over ground). It asserts:
   - `--foreground` at ≥ 7:1;
   - `--muted-foreground` at ≥ 4.5:1;
   - `--subtle` at ≥ 3:1;
   - every cover above the floor it derives.

   A cover or asset change that breaks a ratio fails here.
6. **Guards.**
   - `renderer-style-guards.test.ts` keeps failing on backdrop filters.
   - A new guard fails if anything but `ChromeGround` imports a
     `chrome-ground-*` asset.
   - The wallpaper-feed test stays: the ground is a bundled image, never
     the desktop.

**Verification:**
- `pnpm --filter @videorc/desktop test` (`window-glass`, `window-palette`,
  the contrast test, `chrome-ground`, the style guards).
- `pnpm typecheck && pnpm lint && pnpm format:check`.
- `pnpm build && pnpm check:renderer-assets`: eager gzip unchanged within
  the ground component's few hundred bytes, the images outside it.
- `pnpm probe:preview-lifecycle` and `pnpm probe:preview-window`: window
  creation options changed, and the docked and detached native preview
  must still stack, place and reattach.
- Screenshots in both themes of the main window, Stream Manager, Captions
  and Notes, with and without `VIDEORC_GLASS=clear`.

**Done when:**
- Every D7 window opens straight onto the chrome ground in both themes.
- A theme toggle swaps the ground and the base with no flash of the other
  theme.
- Reduce Transparency paints solid.
- `VIDEORC_GLASS=clear` gives back today's glass.
- The contrast test passes.
- Both preview probes are green.

### Slice S3: the window probe proves the ground

**Route / lane:** Implementation, fit 7, `gpt-6.1-sol`. Read
`scripts/ui-glass-probe.mjs` first.

**Changes:**
1. `probe:ui-glass` learns the ground mode. Under `ground` it asserts
   these things for every D7 window, in both themes:
   - the window is opaque: no vibrancy effect view, and a stand-in desktop
     behind it doesn't change a single captured pixel;
   - `ChromeGround` is mounted with the theme's asset;
   - captured text contrast meets S2's ratios;
   - the Preview window stays solid dark;
   - each `--surfaces` float tier reads its token.
2. Transmission, `nativeClear`, neutrality and `ghostexParity` run only
   under `VIDEORC_GLASS=clear`, as the A/B check.
3. `smoke:local-gates` keeps `pnpm probe:ui-glass --gate --surfaces`
   unchanged, so it now gates the ground.

**Verification:** `pnpm probe:ui-glass --gate --surfaces` green under the
default, and the clear-glass checks green under `VIDEORC_GLASS=clear`.
`pnpm test:scripts` if the probe has script tests.

**Done when:** the probe fails if a window shows the desktop, loses its
ground, or drops below the contrast ratios.

### Slice S4: chrome controls (UI)

**Route / lane:** UI/Product Design, fit 8, `opus-5.5`. Read the whole
`.claude/skills/videorc-design/SKILL.md` and the `shadcn` skill first. Fix
tokens and primitives in `components/ui/` and `styles.css` only. A call site
changes only for D8's Record, Stop and Go Live….

**Changes:**

1. **Four material utilities** in `styles.css`, each with dark and light
   tokens, defined once. Starting values (tune by eye in both themes):
   - `chrome-fill`, polished, for primary fills.
     - Dark: a vertical gradient `oklch(1 0 0)` 0%, `0.93` 40%, `0.75`
       52%, `0.88` 78%, `0.97` 100%, with ink `oklch(0.13 0 0)`, an inset
       `0 1px 0` white top line, an inset `0 -1px 0` black 30% bottom line
       and a `0 1px 3px` black 60% drop.
     - Light: `0.45` 0%, `0.27` 40%, `0.13` 54%, `0.23` 82%, `0.40`
       100%, with ink `oklch(0.985 0 0)`, a white 35% top line and a black
       35% drop.
     - Hover lifts it slightly. Pressed flips the gradient (concave).
       Disabled is flat at 50%.
   - `chrome-plate`, for selected and active.
     - Dark: white 14% to 4% with a white 16% top line and a white 5% rim.
     - Light: black 9% to 3% with a white 90% top line and a black 7% rim.
     - Hover stays the flat `bg-accent`: rows highlight instantly, and the
       plate means selected.
   - `chrome-bead`, for knobs and thumbs.
     - Dark: a radial gradient at 35% 30%, white to `0.85` (55%) to `0.6`,
       with a black 70% drop.
     - Light: white to `0.9` to `0.7`, with a black 35% drop and a black 20%
       hairline.
     - `chrome-bead-ink` is the inverse bead for a knob on a chrome track:
       black in dark, pearl in light.
   - `chrome-led`, for record and live.
     - Dark: `oklch(0.70 0.21 27)` to `0.56 0.23 27` (55%) to `0.50 0.21
       27`, with a white 38% top line and white ink.
     - Light: `0.64 0.22 27` to `0.52 0.24 27` to `0.46 0.22 27`.
     - `data-lit` adds a `0 0 12px` glow of `--live` at 40% (30% in light).
2. **Primitives.**
   - `Button` `default` becomes `chrome-fill`. `secondary` takes the chip
     recipe. `outline`, `ghost`, `link` and `destructive` are unchanged.
     The new `record` variant is `chrome-led`, with `data-lit` when the
     session runs (D8).
   - Checkbox checked and Progress fill: `chrome-fill`.
   - Switch on: a `chrome-fill` track with a `chrome-bead-ink` knob. Off: an
     `bg-input` track with a `chrome-bead` knob.
   - Slider, ParameterSlider and Fader: a `chrome-fill` range with a
     `chrome-bead` thumb. Each `--knob` use becomes the bead.
   - SegmentedControl, Tabs and ToggleGroup active: `chrome-plate`.
   - The sidebar's selected row and `MediaCard` `selected` (a brighter
     chrome rim, never a colour): `chrome-plate`.
   - Chips and keycaps: retune `--chip-*` and `--keycap-*` to the crisper
     highlight. Dark: fill white 13% to 3%, rim 9%, top line 18%. Light:
     white 95% to 55%, rim black 9%, top line white, drop black 5%.
   - The Avatar fallback keeps `bg-primary` if it's text-on-fill. Check by
     eye.
3. **Call sites (D8).** `session-panel.tsx`: Record → `variant="record"`,
   the stop button → `variant="record"` lit, and Go Live… →
   `variant="default"`. The Retro LCD Studio (`retro-lcd-studio.tsx`) keeps
   its own transport. Check it still reads, and change nothing there unless
   it breaks.
4. **Guards.** A style guard fails on hand-rolled gradients
   (`bg-linear-*`, `bg-radial-*`, `linear-gradient(` in TSX) outside
   `components/ui/` and `styles.css`, so the shine can't spread screen by
   screen. Existing exceptions (stream overlays, captions previews) are
   listed by name.

**Verification:**
- `pnpm --filter @videorc/desktop test` (`glass-chips`, the style guards,
  `segmented-control`, `slider`, the session transport tests).
- `pnpm typecheck && pnpm lint && pnpm format:check`.
- `pnpm check:renderer-assets`.
- Both-theme screenshots of the Studio idle, recording and on air, Sources,
  Scene, Settings → General, a ConfirmDialog with Delete, the ⌘K palette
  and the Stream Manager, on the S2 ground.

**Done when:**
- Every primitive above wears its material in both themes.
- Record is unlit at idle and lit while recording, and Delete stays the
  quiet tint.
- No screen outside `components/ui/` gained a gradient.

### Slice S5: the Welcome screen, light turned around (UI)

**Route / lane:** UI/Product Design, fit 8, `opus-5.5`. Read
`components/first-run/welcome-backdrop.tsx`, `lib/live-background-player.ts`
and plan 203 S4 and S5 first. Never edit `shared/live-background-webgl.js`
or the render JSON: they serve the Windows and Linux preview.

**Changes:**

1. **Light is the crisp invert (D3).** Under light, an inner wrapper around
   the poster `<img>` and the canvas host takes `filter: invert(1)`. The
   root's solid stays uninverted. Under dark, nothing changes.
2. **Tone under light.** The shader's Dim darkens before the invert, so
   after it, it would wash the chrome out. Under light the shader's Dim is
   0, and the tone is a CSS `brightness()` after the invert:
   - none by default (the owner's crisp invert);
   - 0.85 under `prefers-contrast: more`, so the porcelain card separates.

   `welcomeBackdropDim` and its test learn the split.
3. **The card on the new tokens.** Its Continue is the chrome primary from
   S4. In light mode, check that the dialog tier's rim and drop separate the
   porcelain card from white chrome. If they don't, strengthen the light
   `--glass-float-drop` once in `styles.css`, for every dialog, not just
   this card.
4. **DOM contract.** Add `data-first-run-backdrop-tone="normal|inverse"` to
   the backdrop root, and have `smoke:first-run` assert it per theme.
5. **Cost.** The invert is a compositor filter on a 30 fps canvas. Record
   the backdrop's frame interval and the GPU process's CPU over 30 s in
   light, against dark, in the acceptance doc. The existing budget guard
   still drops to the poster if it's slow.

**Verification:** `welcome-backdrop` and `live-background-player` tests,
`pnpm typecheck && pnpm lint`, `pnpm smoke:first-run` (both themes), and
screenshots of the Welcome screen moving and still in both themes.

**Done when:** light shows white liquid with black reflections, moving and
as the still, the card reads in both themes, and the smoke asserts the tone.

### Slice S6: the phone remote and the OAuth page (backend-served pages)

**Route / lane:** UI/Product Design, fit 7, `opus-5.5`. Mirror S2's
neutral values and S4's recipes; don't invent new ones.

**Changes:**

1. `remote_web/app.css`. Both `prefers-color-scheme` columns move to the
   neutral palette. Primary buttons get `chrome-fill`'s gradient and Record
   `chrome-led`'s (lit while recording or live, as the page already knows).
   The page body sits on the ground (D13): serve
   `chrome-ground-{dark,light}.webp` the way the backend already serves
   `remote_web/icon.svg`, from the S1 files, never a copy that can drift.
   The manifest's `theme_color` and `background_color` become the new
   solids.
2. `oauth_page/index.html`: the neutral palette and the chrome primary
   only. No ground.
3. A backend test asserts that both pages' palette matches the desktop's
   solids (the same numbers as `window-palette.ts`), so the three copies
   can't drift.

**Verification:** `cargo test -p videorc-backend` scoped to the
remote-web and OAuth-page tests, `cargo clippy -p videorc-backend -- -D
warnings`, `pnpm smoke:remote-control`, `pnpm smoke:oauth`, and phone-size
screenshots of the remote in both schemes.

**Done when:** the phone remote and the OAuth page match the desktop in
both schemes, and the drift test passes.

### Slice S7: docs, acceptance and gates

**Route / lane:** UI/Product Design, fit 8, `opus-5.5` for the skill
rewrite; the orchestrator runs the gates.

**Changes:**

1. `.claude/skills/videorc-design/SKILL.md`.
   - Rewrite the intro, hard rule 2 and "The window family" for the chrome
     ground. Rule 2 becomes: Videorc's own ground, never the desktop and
     never fake blur; no backdrop filter; and the only image under the UI
     is `ChromeGround`.
   - Add an owner call, "Videorc is Liquid Chrome (2026-10-27, plan 208)",
     that states D1 to D3, D5 and D8.
   - Update the token tables (neutral, covers), the glass-chips table and a
     new "Chrome materials" section (the four utilities and where each is
     allowed).
   - Update the Proof paragraph (S3) and the First-run owner call (light is
     inverted).
2. `docs/live-backgrounds.md`: the Welcome screen's light invert and the
   grounds generator. `CONTEXT.md`: add **chrome ground** (the still under
   every window) and **chrome controls** to the glossary.
3. Comments that name clear glass as the current material: `window-glass.ts`,
   `window-palette.ts`, the `styles.css` header and the token contract.
4. The acceptance doc: before and after pairs per surface and theme, the
   S5 cost numbers, the gate results, and what's owner-owed.
5. A `plans/README.md` entry, and the status line here.

**Gates (once, at the end):**
- `pnpm smoke:local-gates` (it includes `probe:ui-glass --gate --surfaces`
  and `probe:comments-window`).
- `pnpm smoke:first-run`.
- `pnpm probe:preview-lifecycle` and `pnpm probe:preview-window`.
- `pnpm smoke:recording-studio`: window creation changed, so make sure
  preview and recording are untouched.
- `cargo fmt --check --all`.
- The Windows CI job.

**Done when:** the skill describes what ships, every gate is green or
waived with its reason, and the acceptance doc lists what the owner still
needs to check by eye.

## Verification summary

| Slice | Proof |
| ----- | ----- |
| S0 | before PNGs listed in the acceptance doc |
| S1 | generator reproduces the assets; stats test |
| S2 | contrast test, window-glass and palette tests, style guards, renderer budget, both preview probes |
| S3 | `probe:ui-glass --gate --surfaces` under ground and clear |
| S4 | primitive tests, gradient guard, both-theme screenshots |
| S5 | backdrop tests, `smoke:first-run` per theme, cost numbers |
| S6 | backend drift test, `smoke:remote-control`, `smoke:oauth` |
| S7 | `smoke:local-gates`, `smoke:recording-studio`, Windows CI |

Owner-owed by eye, in both themes: the ground's strength (D10), the
Go Live… hierarchy (D8), the Record LED lit and unlit, light-mode Welcome
card separation, the phone remote, and one Windows pass on the tester's
machine.

## Edge cases

- **Theme toggle or follow-system change.** Main already resets the solid
  base, and the ground swaps with the class: no frame shows the other
  theme's ground.
- **First paint.** The window's `backgroundColor` is the solid base, so the
  ground decoding a frame later changes the tone by a few percent, never
  from bright. If it reads as a flash, preload the image in the window's
  HTML. Never add a fade.
- **Big and mixed displays.** A 5K display upscales a 1280 × 720 blurred
  image, which is invisible after the blur. A window dragged across
  displays keeps its ground until the next resize event.
- **Fullscreen, Stage Manager, minimise.** The ground is static. Nothing
  runs while the window is hidden.
- **Reduce Transparency at runtime.** The media query hides the ground and
  swaps the coats at once.
- **Hardware acceleration off or a software GPU.** The ground is a plain
  image with no filter, so it draws the same. The Welcome backdrop shows its
  poster (inverted under light) as today.
- **Retro LCD on.** Its LCD panels are opaque. Check that the inspector
  beside the ground still reads.
- **Screen-recording Videorc itself.** The capture shows the chrome,
  never the user's desktop through the window (today's glass could show
  the desktop recursively).
- **The plan 091 "transparent-backed window wedge" research**
  (`heal-main-window` levers in `index.ts`). Opaque windows may make it
  moot. Note it in the acceptance doc if it's seen, and don't remove the
  research code in this plan.
- **Windows 10 and old Windows 11 builds.** Today they're solid. Now they
  get the ground like everyone, and the Mica blank-window check
  (`micaFoundBlank`) only matters under `VIDEORC_GLASS=clear`.

## STOP conditions

- The contrast test can't pass with the chrome visible in light mode (a
  floor above 0.95). Stop, and show the owner screenshots of the crisp
  invert against a lifted-black ground before tuning further.
- Either preview probe goes red after S2's window change. Stop and
  diagnose. Never ship the ground over a broken native preview.
- The eager renderer budget trips. Stop. Don't raise the ceiling without
  the owner.
- The ground visibly flashes or rescales on open or resize and preload
  doesn't fix it. Stop before S4.
- The Welcome light invert costs a measurable frame-interval regression on
  the Windows tester's machine. Keep the poster there and ask.

## Out of scope

- The website (`videorcweb`), Stream Deck icons, and a selectable light
  Liquid Chrome look in Backgrounds for scenes and streams (D4). The light
  look would need new studio lighting in all four renderers, posters and
  goldens: its own plan if wanted.
- Anything in the program output: scenes, banners, captions, chat
  highlights and Buddy on stream.
- A moving ground (D5), a gradient on text, sheen on panes, menus, dialogs
  or toasts (D2), and new brand colours (D6).
- Removing vibrancy, Mica and the native clear-glass strip (D9's
  follow-up).
- Retro LCD's own screens and the audiocn meter tones.
- Release notes and the release itself (the `videorc-release` skill).

## Risks

- **The light ground is subtle by physics.** Grey streaks under grey text
  cap how much chrome shows (about 14% show-through). The Welcome screen
  shows it at full strength, and the panes show it frosted. If the owner
  wants more, the lever is the asset's tone (lift the lines), never a cover
  below the floor.
- **Noise behind dense text.** The blur (σ) is the lever. S1 makes it one
  number and S2's test keeps contrast honest whatever it's set to.
- **Go Live… gets louder** (D8). It's the approved mockup, but it changes
  the Studio's hierarchy. The owner's by-eye decides.
- **GPU memory.** Each ground-bearing window holds one decoded
  1280 × 720 image (about 3.7 MB), so up to four windows hold about 15 MB.
  Acceptable. The Preview window holds none.
- **Windows and Linux were never on the glass path.** The ground is the
  same plain image there, but it's untested on the Windows tester's GPU
  until S7's pass.
- **A one-release A/B doubles the window paths.** D9 keeps the clear-glass
  path alive for one release. The follow-up must actually delete it.
