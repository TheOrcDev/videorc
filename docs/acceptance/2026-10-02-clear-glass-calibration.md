# Clear glass: calibration (plan 091, S0)

Date: 2026-10-02 · macOS 26.5.1 (Apple M4, built-in Retina display) · Electron
39.8.10 · dev app from `plan/091-clear-glass`, isolated profiles ·
`probe:ui-glass` (`scripts/ui-glass-probe.mjs`), report mode, main window,
dark and light. Captures stay local (no media in the tree).

S0 asks one question: can Videorc's window material be made neutral, the way
Ghostex's is, on Electron's own vibrancy view, and does it stay that way? The
answer is yes, with the plan's first mechanism (D1), on the first attempt.

## The mechanism (D1: re-class Electron's view in place)

Electron creates a plain `NSVisualEffectView` for `vibrancy: 'under-window'`
and hosts it under the web contents. The native addon
(`crates/videorc-native-preview-addon`) registers
`VideorcClearGlassView : NSVisualEffectView` with no ivars and one override,
`updateLayer`, which calls `super` and then runs Ghostex's strip
(`remove_layer_background` in maddada/zed `crates/gpui_macos/src/window.rs`):

- `backgroundColor = nil` on every layer in the view's tree;
- the `CAChameleonLayer` (wallpaper tinting) hidden;
- the filter whose description contains `Saturat` removed;
- `inputRadius` of the filter whose description contains `Blur` set to 60;
- the view's own layer painted the window's solid base (`#0D0D0F` dark,
  `#FAFAFB` light, from `effectiveAppearance`) as the snapshot base.

`set_window_glass_style(handle, { blurRadius })` swaps the class of every
behind-window effect view whose class is exactly `NSVisualEffectView`
(`object_setClass`, after checking the instance sizes match) and calls
`setNeedsDisplay`. A KVO class or any other subclass is refused as
`unsupported-class`. On this machine Electron's view had no KVO observer, so
the swap applied: `className: VideorcClearGlassView`. The addon runs nothing
when Reduce Transparency is on.

Main applies it from `finishGlassWindow` to every material window when
`VIDEORC_GLASS_STYLE=clear` (S0 default: `material`), and again after
`set-vibrancy`, `revibrancy` and every theme change. A failure logs once and
keeps the plan 050 material. `window-glass-state` reports `applied.style` and
`styleRequested`; `runtime-info.windowGlass` carries `style` and
`styleRequested`.

## The layer tree, before and after

Read back by the addon (`window_effect_views`): class, hidden, background
components, filters.

Before the strip, the material as AppKit draws it (dark main window; light
differs only in the tint values):

```
NSViewBackingLayer bg=none filters=[]
  CALayer bg=none filters=[]
    CABackdropLayer bg=none filters=[sdrNormalize; gaussianBlur inputRadius=30; colorSaturate]
    CALayer bg=(0.157,0.157,0.157,0.800) filters=[]      light: (0.965,0.965,0.965,0.840)
    CALayer bg=(0.140,0.140,0.140,1.000) filters=[]      light: (0.915,0.915,0.915,1.000)
    CAChameleonLayer bg=(0.708,0.443,0.684,0.000) filters=[]
```

After the strip (dark; light paints the root `(0.980,0.980,0.984,1.000)`):

```
NSViewBackingLayer bg=(0.051,0.051,0.059,1.000) filters=[]
  CALayer bg=none filters=[]
    CABackdropLayer bg=none filters=[sdrNormalize; gaussianBlur inputRadius=60]
    CALayer bg=none filters=[]
    CALayer bg=none filters=[]
    CAChameleonLayer hidden bg=none filters=[]
```

Findings:

- macOS 26.5.1's `under-window` backdrop carries one filter beyond Ghostex's
  blur and saturate pair: `sdrNormalize`. The strip leaves it alone (it only
  touches what it recognises), and the result is neutral regardless, so it
  is not a tint.
- The material's grey (dark) or white (light) comes from a tint layer at 80%
  (dark) or 84% (light) alpha plus a second, opaque grey layer. Nil-ing the
  backgrounds removes both.
- AppKit's own blur radius is 30 pt; Ghostex's 60 pt applies through KVC on
  the private `CAFilter`.
- A fresh view created by `setVibrancy` has no layer tree until its first
  display; the re-class still takes, and the strip runs on the first
  `updateLayer`.

## Neutrality

With the renderer's coats zeroed through CDP (`--glass-window`,
`--glass-content`, `--glass-sidebar` set to `transparent !important`), the
RGB distance between the window sample and a patch of the bare backdrop
captured beside the window in the same pass (so the display's colour
pipeline cancels out). Gate: ≤ 8 under `clear`.

| theme | style    |  white |  black |    red |   blue |      max |
| ----- | -------- | -----: | -----: | -----: | -----: | -------: |
| dark  | material | 297.34 |  66.98 | 152.53 | 169.96 |   297.34 |
| dark  | clear    |      0 |      0 |   1.03 |   0.03 | **1.03** |
| light | material |  50.81 | 348.72 | 226.00 | 284.89 |   348.72 |
| light | clear    |      0 |      0 |   1.03 |   0.03 | **1.03** |

The sidebar-foot sample reads the same material as the toolbar sample
(clear: 0 / 0 / 0.43 / 0.23). The stripped material passes the backdrop
colour through unchanged; AppKit's material sits 300 steps away.

## Transmission, sharpness, contrast

The plan 050 probe metrics, with today's coats (dark 42% + 34%, light
60% + 30%) left as they are. Contrast is the worst case over the white and
black backdrops.

| theme | style    | sample          | transmission | sharpness | primary | secondary |
| ----- | -------- | --------------- | -----------: | --------: | ------: | --------: |
| dark  | material | content toolbar |        24.04 |      0.00 |   14.23 |      6.03 |
| dark  | material | sidebar foot    |        36.77 |      0.02 |   11.46 |      4.86 |
| dark  | clear    | content toolbar |       122.72 |      0.08 |    5.26 |      2.23 |
| dark  | clear    | sidebar foot    |       184.80 |      0.33 |    2.68 |      1.14 |
| light | material | content toolbar |         9.90 |      0.00 |   16.09 |      5.73 |
| light | material | sidebar foot    |        13.45 |      0.00 |   15.34 |      5.46 |
| light | clear    | content toolbar |        88.40 |      0.14 |    9.17 |      3.26 |
| light | clear    | sidebar foot    |       127.08 |      0.26 |    6.43 |      2.29 |

- Transmission rises four- to nine-fold: the grey material, not the coat,
  was what ate the desktop colour (the plan's gap table said so; this is the
  measurement).
- Sharpness stays at the blurred-glass floor (≤ 0.33 against the ≥ 11.8 leak
  population), so the 60 pt blur hides what is behind at least as well as
  AppKit's 30 pt.
- Contrast fails under `clear` with today's thin coats, as expected: over a
  white desktop the dark window now reads L 0.31 at the sidebar foot. S1
  carries Ghostex's covers (dark 88% / 83%, light 93% / 86%), which the plan
  computed to pass 4.5:1; until then `clear` stays behind the flag and the
  default `material` run passes the unchanged gate.

## Persistence

`--persistence` re-reads the effect view (class, radius, chameleon,
saturation) after each transition and shoots one red-backdrop neutrality
sample with the coats zeroed. `mainFocused` is `BrowserWindow.isFocused()`,
recorded so a step that activates the app shows itself.

| step                               | class | radius | chameleon | saturate | neutrality (red) | held    |
| ---------------------------------- | ----- | -----: | --------- | -------- | ---------------: | ------- |
| baseline                           | clear |     60 | hidden    | none     |             1.03 | yes     |
| dark → light                       | clear |     60 | hidden    | none     |             1.03 | yes     |
| light → dark                       | clear |     60 | hidden    | none     |             1.03 | yes     |
| resize (−60 × −40)                 | clear |     60 | hidden    | none     |             1.09 | yes     |
| resize back                        | clear |     60 | hidden    | none     |             1.03 | yes     |
| simple fullscreen in               | clear |     60 | hidden    | none     |              n/a | yes     |
| simple fullscreen out              | clear |     60 | hidden    | none     |             1.03 | yes     |
| minimize \*                        | clear |     60 | hidden    | none     |              n/a | yes     |
| restore \*                         | clear |     60 | hidden    | none     |             1.03 | yes     |
| `set-vibrancy` null → under-window | clear |     60 | hidden    | none     |             1.03 | yes     |
| `revibrancy` lever                 | clear |     60 | hidden    | none     |             1.03 | yes     |
| focus loss                         |       |        |           |          |                  | not run |

\* From the first walk, which had activated the app at placement (see the
finding below); the clean walk skips the pair. Every other row is from the
clean walk, with `mainFocused: false` on each.

The strip holds through every transition AppKit rebuilds the material for:
the appearance change rebuilds the tint for the new theme and `updateLayer`
strips it again; the re-created view is re-classed by the `set-vibrancy` and
`revibrancy` paths (`restyle: clear`). No fallback (B or C) was needed.

Not automated, and why:

- **Focus loss.** `visualEffectState: 'active'` pins the material, so a key
  change does not rebuild it. Proving that needs the app to take and give
  back the user's focus; the probe never activates the app, so the step runs
  only with `--allow-focus` and was not run with the owner at the machine.
- **Native fullscreen.** It moves the window to a new Space and switches the
  display to it. The probe uses Electron's simple fullscreen instead: the
  same frame-to-screen and style-mask change without the Space.
- **Minimize and restore.** Measured once (the row above) in a run that had
  already activated the app. `deminiaturize:` activates the app whatever the
  caller asks, so the step is now behind `--allow-focus` as well.
- **Mission Control snapshot.** The addon reads back the root layer's
  background as the painted base (`(0.051,0.051,0.059,1)` dark,
  `(0.980,0.980,0.984,1)` light), which is what a snapshot shows where the
  backdrop is dropped. The by-eye check is the owner's, in S4.

### A finding on the probe itself

Every `*-window-set-bounds` smoke command calls `window.show()`, and
Electron's `Show()` calls `activateIgnoringOtherApps:YES`. The glass probe
has therefore activated the app at placement since plan 050 (`mainFocused:
true` at the first persistence baseline). The placement commands now take
`focus: false` (`showInactive`), the probe passes it, and the clean run
reads `mainFocused: false` throughout.

## WindowServer

Read-only `top`, 12 one-second samples after a 20 s settle with the native
preview presenting, main window only, the same session back to back:

| style    |                  WindowServer CPU |
| -------- | --------------------------------: |
| material |                             47.1% |
| clear    | 46.6% (earlier runs 48.3%, 46.9%) |

The 60 pt blur costs nothing measurable. All figures are far above plan
050's 24.2% from 2026-09-23, which is the session (the owner's apps, Ghostex
among them, were running), not the style.

## Backdrop-filter re-check (plan 072 S0, once more under `clear`)

`--frost-check` paints a bare `backdrop-filter: blur(24px)` layer with no
coat over the sidebar rows (the plan 072 setup) and measures the rows'
sharpness under and through it.

| theme | style    | sharpness under | through | reaches the screen |
| ----- | -------- | --------------: | ------: | ------------------ |
| dark  | material |          561.68 |  161.04 | no                 |
| dark  | clear    |           99.74 |   28.27 | no                 |
| light | material |          945.42 |  129.19 | no                 |
| light | clear    |          745.44 |  102.27 | no                 |

The rows stay sharp through the layer (far above the 0.5 bleed bar a real
blur would reach); the drop is contrast, not blur, and the capture shows the
rows dimmed under a tint with every glyph intact. Plan 072's result stands:
on these vibrancy windows the filtered pass never reaches the screen, with
or without the strip. S3 stays flat.

## Gates

- `cargo fmt --check --all`, `cargo clippy -p videorc-native-preview-addon
-- -D warnings`, `cargo test -p videorc-native-preview-addon` (the test
  build also needed `frame_store` mounted: the compositor's own tests had
  referenced it since 0.9.126 and the addon never built them).
- `pnpm build:native-preview-addon` and `pnpm build:native-preview-addon:release`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`, `pnpm test:scripts`.
- `node scripts/ui-glass-probe.mjs --gate` (default `material`) passes
  unchanged; `--style=clear --themes=dark,light --roles=main --persistence
--frost-check` is the run above.

## S1: Ghostex's covers, clear glass by default

Same day, same machine. `DEFAULT_GLASS_STYLE` is now `clear`;
`VIDEORC_GLASS_STYLE=material` is the A/B control. `styles.css` carries one
base tone per theme (`--glass-base`) and two covers per theme and platform
(`--glass-cover-sidebar`, `--glass-cover-work`, plan 091 D3/D5); the coats are
derived from them (D4): the body paints `min(sidebar, work)`, the sidebar
and the content pane add `1 - (1 - cover) / (1 - body)`. The sidebar
`<aside>` paints `bg-glass-sidebar`; `main` and `WindowFrame` keep
`bg-glass-content`.

### The computed coats, read back from the running app

`getComputedStyle(...).backgroundColor` through CDP, after `pnpm build` and
in the dev app (the probe's `report.coats`). Tailwind v4 / lightningcss emit
the `oklch(var(--glass-base) / calc(...))` expressions verbatim (the only
change is `0.001` to `.001`), and Chromium resolves them to the designed
alphas:

| theme | body                            | aside                              | main / WindowFrame           |
| ----- | ------------------------------- | ---------------------------------- | ---------------------------- |
| dark  | `oklch(0.13 0.003 286 / 0.83)`  | `oklch(0.13 0.003 286 / 0.294118)` | `oklch(0.13 0.003 286 / 0)`  |
| light | `oklch(0.985 0.001 286 / 0.86)` | `oklch(0.985 0.001 286 / 0.5)`     | `oklch(0.985 0.001 286 / 0)` |

So the sidebar composites to 1 − 0.17 × 0.705882 = 0.88 (dark) and
1 − 0.14 × 0.5 = 0.93 (light), the work area to 0.83 and 0.86, exactly the
covers. `window-palette.test.ts` computes the same from the covers it parses
out of `styles.css`, and pins the Windows covers (0.34 / 0.5116 dark,
0.5 / 0.62 light) to plan 050's Mica composite (34% + 26%, 50% + 24%).

### Per role and theme (`--gate --themes=dark,light`, all five roles)

Clear glass with the new covers. Contrast is the worst case over white and
black; `parity` is the worst RGB distance between the capture and the
computed coats composited over the bare-backdrop reference (white and
black); `L` is the OKLCH lightness of the capture over white / black, with
the prediction in brackets.

| theme | window · sample        | cover | transmission | sharpness | primary | secondary | neutrality | parity | L white (pred.) | L black (pred.) |
| ----- | ---------------------- | ----: | -----------: | --------: | ------: | --------: | ---------: | -----: | --------------: | --------------: |
| dark  | main · content toolbar |  0.83 |        53.17 |      0.08 |   11.93 |      5.05 |       1.03 |   0.45 |   0.314 (0.315) |   0.123 (0.122) |
| dark  | main · sidebar foot    |  0.88 |        37.70 |      0.06 |   14.23 |      6.03 |       0.43 |   1.53 |   0.261 (0.264) |   0.123 (0.125) |
| dark  | Stream Manager · list  |  0.83 |        53.18 |      0.92 |   11.92 |      5.05 |       1.50 |   0.41 |   0.314 (0.315) |   0.123 (0.122) |
| dark  | Captions · body        |  0.83 |        53.19 |      0.07 |   11.93 |      5.05 |       0.46 |   0.45 |   0.314 (0.315) |   0.123 (0.122) |
| dark  | Notes · textarea       |  0.83 |        53.20 |      0.02 |   11.93 |      5.05 |       1.27 |   0.45 |   0.314 (0.315) |   0.123 (0.122) |
| light | main · content toolbar |  0.86 |        44.49 |      0.03 |   13.22 |      4.71 |       1.03 |   0.92 |   0.988 (0.987) |   0.879 (0.879) |
| light | main · sidebar foot    |  0.93 |        22.16 |      0.08 |   15.65 |      5.57 |       0.43 |   1.06 |   0.988 (0.986) |   0.934 (0.932) |
| light | Stream Manager · list  |  0.86 |        44.50 |      1.62 |   13.21 |      4.70 |       1.53 |   0.88 |   0.988 (0.987) |   0.879 (0.879) |
| light | Captions · body        |  0.86 |        44.53 |      0.07 |   13.22 |      4.71 |       0.46 |   0.92 |   0.988 (0.987) |   0.879 (0.879) |
| light | Notes · textarea       |  0.86 |        44.52 |      0.01 |   13.22 |      4.71 |       1.27 |   0.92 |   0.988 (0.987) |   0.879 (0.879) |

Every plan 050 gate passes unchanged (transmission ≥ 8, sharpness ≤ 6,
primary ≥ 7, secondary ≥ 4.5), plus `neutrality`, `nativeClear` and
`parity`. **No cover moved**: D3's numbers pass on this panel as written.
The Preview frame fails in this run (primary 5.24, secondary 2.22, and the
pinned-dark luminance in light theme): it still paints the plan 050 coats
over the now-clear material, which is S2's slice.

Against the plan's gap table (which assumed a `#0D0D0F` base):

| region       | backdrop | plan target L | measured L |
| ------------ | -------- | ------------: | ---------: |
| dark work    | white    |         0.333 |      0.314 |
| dark work    | black    |         0.150 |      0.123 |
| dark sidebar | white    |         0.286 |      0.261 |
| dark sidebar | black    |         0.150 |      0.123 |
| light work   | black    |         0.879 |      0.879 |
| light work   | white    |         0.995 |      0.988 |

The dark rows sit about 0.02 L under the table because the token base
`oklch(0.13 0.003 286)` renders `#070708`; the table's `#0D0D0F` is
`window-palette.ts`'s rounding of it (OKLCH L 0.158). The predictions from
the computed coats match the captures to within 0.003 L, so the base, not
the covers, explains the gap. It also explains why contrast lands above the
plan's 4.69:1 at 83%. The light rows match.

### ghostexParity's threshold

The population above is 20 samples, five windows, both themes, two
backdrops each: parity 0.16 to 1.53. The gate is **≤ 4**: 2.6x the worst
sample, and still a tripwire. A cover off by 0.02 moves a dark sample about
5 steps over white; a missing sidebar coat moves it 70; the plan 050 coats
would miss by more than 100. The S0 neutrality gate (≤ 8 against a 1.03
population) was set the same way.

### The A/B control (`--style=material`, main, S1 tokens)

The same covers over AppKit's material, report mode. This is what
`VIDEORC_GLASS_STYLE=material` now shows: the control for one release, not
a look.

| theme | sample          | transmission | secondary | neutrality | parity | L white | L black |
| ----- | --------------- | -----------: | --------: | ---------: | -----: | ------: | ------: |
| dark  | content toolbar |        10.63 |      7.16 |     297.34 |  50.67 |   0.192 |   0.158 |
| dark  | sidebar foot    |         7.81 |      7.39 |     297.34 |  36.17 |   0.173 |   0.149 |
| light | content toolbar |         5.74 |      6.10 |     348.72 |  48.86 |   0.976 |   0.964 |
| light | sidebar foot    |         2.83 |      6.32 |     348.72 |  24.89 |   0.982 |   0.976 |

Ghostex's covers over the grey material leave almost nothing of the desktop
(three of the four samples fall under the plan 050 transmission gate) and
sit 25–51 steps from the coat prediction, because the material tints what
the coats composite over. The covers and the strip go together; neither is
the look on its own. WindowServer: 46.9% for the control against 50.0% for
the clear gate run with all five windows up, the same session.

### Persistence on the S1 tree

`--gate --themes=dark,light --roles=main --persistence` re-walked the S0
matrix on the final S1 tree: baseline, dark → light → dark, resize, simple
fullscreen in and out, the `set-vibrancy` re-create and the `revibrancy`
lever all hold (clear class, radius 60, chameleon hidden, no saturate, red
neutrality 1.03–1.09), with `mainFocused: false` on every row; the focus
cycle and minimize/restore stay behind `--allow-focus`. The run passed the
gate. Eager renderer bytes after the token change: 1,993,889 raw /
385,143 gzip, 152 raw and 68 gzip bytes over the pre-S1 build on this
machine.

## S2: the Preview frame

The Preview frame is a data-URL document that cannot read the stylesheet;
`window-palette.ts` paints its coats. `DARK_GLASS_COATS` is now derived
from the dark covers the same way styles.css derives its own: the body
paints the work cover, `oklch(0.13 0.003 286 / 83%)`, and the content coat
is the work delta, `oklch(0.13 0.003 286 / 0%)`. The frame therefore
composites to exactly what the main window's work area does, and
`window-palette.test.ts` pins both strings to the covers it parses out of
`styles.css`. The window's dark pin (`set_window_appearance`) and the clear
strip (applied after the pin, S0) are unchanged.

`--gate --themes=dark,light`, all five roles, S2 tree: every sample passes,
the Preview included.

| theme | sample          | transmission | sharpness | primary | secondary | white luminance | nativeClear |
| ----- | --------------- | -----------: | --------: | ------: | --------: | --------------: | ----------- |
| dark  | Preview · strip |        53.17 |      0.05 |   11.93 |      5.05 |          0.0308 | yes         |
| light | Preview · strip |        53.17 |      0.05 |   11.93 |      5.05 |          0.0308 | yes         |

The light row is the pinned-dark check: with the main window in light
theme the frame still measures 0.0308 over white (gate ≤ 0.12), the same
as in dark theme, so the dark pin holds under the clear material. Before
S2 (the S1 gate run) the frame failed on the plan 050 coats: primary 5.24,
secondary 2.22, white luminance 0.134. The strip's sharpness also drops
from the 4.1–4.2 the 2026-09-23 calibration recorded at the window edge to
0.05: the 60 pt blur reaches past the 28 pt strip's edge where AppKit's
30 pt did not. The main, Stream Manager, Captions and Notes rows repeat
the S1 table to the hundredth. WindowServer, five windows up: 51.8%.

Not run, and why: `pnpm probe:preview-lifecycle` steals focus about a
hundred times and is the owner's to schedule. `pnpm probe:preview-window`
calls `main-window-focus` and clicks through the OS by design, and
`pnpm probe:comments-window` opens and toggles the Stream Manager through
`openCommentsWindow`, which shows and focuses the window as the product
does (`comments-window-open`, `comments-window-toggle`,
`comments-window-click-message`). Both activate the app, so neither ran
with the owner at the machine. The glass probe's own window-open step
(`comments-window-open`, `captions-window-open`, `notes-window-open`,
`preview-window-open`) goes through the product's open paths, which show
the window and focus an existing one, so a five-role run can activate the
app once at the start (not measured; the walk records `mainFocused` only
in the main-only runs, where it stays false). A `focus: false` variant of
the open commands would close that gap.

## Step A: the dark base is `#0D0D0F`

S1 found the dark token `oklch(0.13 0.003 286)` rendering `#070708` while
everything else intends `#0D0D0F`: the design skill's token table,
`window-palette.ts`'s dark base, the addon's snapshot base and this plan's
gap table (Ghostex's dark workspace is `#0e0e0e`). At 83% the old base
composited to about `#060606` over a black desktop, the pure black the
skill says kills the glass depth. The dark `--glass-base` and
`--glass-solid` are now the exact OKLCH of `#0D0D0F`, `0.16 0.004 286`
(L 0.15999, C 0.00418, h 285.9; the short form rounds back to 13, 13, 15).
No other token moved; `DARK_GLASS_BASE` and the Preview coats follow.

`--gate --themes=dark,light`, all five roles, after the change: every
sample passes, no cover moved.

| theme | window · sample        | cover | transmission | primary | secondary | parity | L white (pred.) |  plan | L black (pred.) |  plan |
| ----- | ---------------------- | ----: | -----------: | ------: | --------: | -----: | --------------: | ----: | --------------: | ----: |
| dark  | main · content toolbar |  0.83 |        54.54 |   11.23 |      4.76 |   1.79 |   0.330 (0.334) | 0.333 |   0.146 (0.149) | 0.150 |
| dark  | main · sidebar foot    |  0.88 |        37.97 |   13.33 |      5.64 |   1.66 |   0.282 (0.286) | 0.286 |   0.151 (0.153) | 0.150 |
| dark  | Stream Manager · list  |  0.83 |        53.65 |   11.23 |      4.76 |   1.75 |   0.330 (0.334) | 0.333 |   0.146 (0.149) | 0.150 |
| dark  | Captions · body        |  0.83 |        54.37 |   11.23 |      4.76 |   1.79 |   0.330 (0.334) | 0.333 |   0.146 (0.149) | 0.150 |
| dark  | Notes · textarea       |  0.83 |        53.83 |   11.23 |      4.76 |   1.79 |   0.330 (0.334) | 0.333 |   0.146 (0.149) | 0.150 |
| dark  | Preview · strip        |  0.83 |        54.04 |   11.23 |      4.76 |    n/a |      lum 0.0358 |       |                 |       |

The dark rows now land on the plan's gap table (within 0.004 L), and
secondary contrast reads 4.76:1 at 83%, the plan's 4.69 plus the panel's
margin: still above 4.5, so D3 stands. Light rows are unchanged. The
parity population grew to 1.79 (the dark coats are now a hair further from
neutral), still under the ≤ 4 gate. WindowServer read 66.5% in this run,
an outlier against the 47–52% of every other run today; nothing in the
tree changed between them but a token, so it is session noise.

## S3: floats, Ghostex's flat lift

The floating surfaces follow Ghostex's web-modal recipe (plan 091 D6): flat,
opaque tiers of the solid, mixed in sRGB with `color-mix`, a 1 px rim and
the drop shadow; the sheen gradient and the top highlight are gone in both
themes. Dark: the dialog tier (`glass-float-dialog`: dialogs, the ⌘K
palette, the error panel) is the solid plus 6% white, the popup tier
(`glass-float`: menus, selects, popovers, hover cards, chart tooltips,
toasts) adds 3% more, the tooltip tier (`glass-float-tooltip`) is the solid
itself; the rim is white 10%. Light keeps `oklch(0.99 0 0)` for every tier
with a black 10% rim. `--popover` still follows `--glass-float`, so a stray
`bg-popover` lands on the popup tier and the guard stays. Toasts keep the
#501 rule: the type colours the icon only.

The float gate (`scripts/lib/float-glass-checks.mjs`, `--surfaces`) drops
plan 072's "lift over the window glass" band: the dark floats are now
deliberately darker than the glass over a bright desktop. In its place a
fixed-tone check: each tier is painted over the probe patch, shot over the
five backdrops, and the capture must sit within **4 RGB steps** of the
colour the page computes for it (`getComputedStyle` through CDP). A neutral
opaque tone reaches the display unchanged, which S1's parity run had
already shown (the sRGB prediction of the neutral coats matched the
captures within 1.5 steps), so the comparison needs no backdrop reference;
the opaque check (spread ≤ 0.01 L across the backdrops) guards the
"whatever is behind" half. Contrast ≥ 7 / 4.5 and the bleed check are
unchanged. The old 92% popover coat rides along as an ungated control.

`--gate --surfaces --themes=dark,light`, all five roles (what
`smoke:local-gates` runs): every window sample and every float sample
passes.

| theme | tier    | computed                                   | tone |     L | primary | secondary | control tone |
| ----- | ------- | ------------------------------------------ | ---: | ----: | ------: | --------: | -----------: |
| dark  | popup   | `color(srgb 0.1347 0.1348 0.1416)` #222224 | 0.52 | 0.253 |   14.58 |      6.17 |         6.42 |
| dark  | dialog  | `color(srgb 0.1080 0.1080 0.1151)` #1C1C1D | 0.74 | 0.227 |   15.63 |      6.62 |              |
| dark  | tooltip | `oklch(0.16 0.004 286)` #0D0D0F            | 0.92 | 0.160 |   17.83 |      7.55 |              |
| light | popup   | `oklch(0.99 0 0)`                          | 0.62 | 0.991 |   18.53 |      6.60 |         4.58 |
| light | dialog  | `oklch(0.99 0 0)`                          | 0.62 | 0.991 |   18.53 |      6.60 |              |
| light | tooltip | `oklch(0.99 0 0)`                          | 0.62 | 0.991 |   18.53 |      6.60 |              |

The main and Stream Manager windows read the same to the hundredth. Tone
population 0.52–0.92 against the ≤ 4 gate (4x margin); the old coat, a
translucent 92%, reads 6.42 dark / 4.58 light and fails it, as it should.
Bleed through the popup tier: 0 in every window and theme (the 97% leak
control 0.71–2.13). Lightningcss keeps the `color-mix` expressions verbatim
(it writes the white as `oklch(100% 0 0)`); Chromium resolves them to
`color(srgb …)`. Eager renderer bytes: 1,993,904 raw / 385,146 gzip.
WindowServer with the five windows up: 50.6%.

### By eye

A scratch script (not committed) drove the dev app through CDP and the
smoke commands, never activating it, over the photo backdrop in both
themes: the ⌘K palette (the dialog tier through `CommandDialog`'s
`DialogContent`), a success and an error toast raised through Vite's own
`sonner` dep, a tooltip on the real `glass-float-tooltip` utility, and the
Stream Manager's "Supporters this stream" hover card. The palette is a flat
`#1C1C1D` panel with its rim and shadow; the toasts are flat popups whose
type colours the icon only; the hover card is the popup tier over glass
that shows the desktop through. Two surfaces could not be opened in the
empty test profile: the Go Live dialog (the Stream button toasts a setup
hint without a destination) and, with it, a Select inside a dialog (the
Schedule dialog's "Schedule on …" buttons need provider capabilities the
profile lacks). The Library tab has no tooltip trigger without an item, so
the tooltip capture is the utility on a synthetic element. The captures stay
local.

## Where it landed (plan 091, end of S4)

The tree as it goes to review, measured by `probe:ui-glass --gate
--surfaces --themes=dark,light` on all five windows:

| what                             | dark                               | light                              |
| -------------------------------- | ---------------------------------- | ---------------------------------- |
| material                         | clear glass, 60 pt, neutral ≤ 1.5  | clear glass, 60 pt, neutral ≤ 1.5  |
| base                             | `#0D0D0F` (`0.16 0.004 286`)       | `#FAFAFB` (`0.985 0.001 286`)      |
| covers sidebar / work            | 0.88 / 0.83                        | 0.93 / 0.86                        |
| work area over white / black, L  | 0.330 / 0.146 (plan 0.333 / 0.150) | 0.988 / 0.879 (plan 0.995 / 0.879) |
| sidebar over white, L            | 0.282 (plan 0.286)                 | 0.988                              |
| secondary contrast, worst        | 4.76 (work)                        | 4.70 (work)                        |
| transmission                     | 38–55                              | 22–45                              |
| ghostexParity, worst             | 1.79                               | 1.06                               |
| floats: popup / dialog / tooltip | `#222224` / `#1C1C1D` / `#0D0D0F`  | `oklch(0.99 0 0)` for all three    |
| float tone, worst                | 0.92                               | 0.62                               |
| float secondary contrast, worst  | 6.17                               | 6.60                               |
| bleed through a float            | 0                                  | 0                                  |
| WindowServer, five windows       | 50–52%                             | (same run)                         |

Owed: the owner's by-eye pass side by side with Ghostex (dark and light;
bright, dark and colourful wallpapers; focused and unfocused; Mission
Control), Reduce Transparency and Increase Contrast with the real system
switches, the three focus-stealing preview and comments probes, a look on
the Windows box (Mica is unchanged by design), the D8 light-mode decision,
and `pnpm smoke:packaged:native-preview` (it opens the preview through the
product path and calls `restore-window` without `focus: false`, so it
activates the app).
