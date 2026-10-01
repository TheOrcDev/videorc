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
