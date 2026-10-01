# Plan 091: Ghostex glass: a clean blur under one tint per region, dark and light

Status: planned 2026-10-02 against `origin/main` `a8637877` (0.9.126). Not
started. Priority P2 (owner-requested look), effort M, 5 slices (S0 to S4).
Owner route: **UI/Product Design**, fit 9. Model lane: **`fable-5`**. The work
spans the Rust addon, Electron main, renderer tokens and the probe, and the
glass has rested on two wrong premises before: plan 050's "materials paint
opaque" and plan 072's backdrop-filter. S3 and S4 are cosmetic only and may
drop to `opus-4.8`.

## Goal

The owner runs Ghostex (`/Applications/ghostex.app`, the agent-terminal app)
every day and wants Videorc's window glass to look like it, in both themes:
a deep, clean frost where the desktop shows through as soft colour. Today
Videorc's glass reads as a narrow grey milk.

## What Ghostex does (read from its source, not guessed)

Ghostex 10.8.1 (`com.madda.ghostex.host`) is a Rust app on GPUI (Zed's UI
framework; fork `maddada/zed`, branch `ghostex`) with CEF browser panes. It is
open source (MIT). References are pinned to `maddada/Ghostex@dd7d40f7` and
`maddada/zed@b0b0b850`. The installed binary confirms them: it defines a
`BlurredView` class with `ghostexBlurRadius`, `ghostexKeepSaturation` and
`ghostexRegionMask` ivars.

1. **The material is a stripped `NSVisualEffectView`**
   (`crates/gpui_macos/src/window.rs`: `blurred_view_init_with_frame`,
   `blurred_view_update_layer`, `remove_layer_background`).
   - It uses material `UnderWindowBackground`, blending `BehindWindow`, state
     `Active`. **This is the same material Videorc uses today.**
   - On every `updateLayer`, after `super`, it walks the layer tree:
     - It sets `backgroundColor = nil` on every layer, which removes the
       material's grey or white tint.
     - It hides the `CAChameleonLayer`, which removes wallpaper tinting.
     - It removes the `colorSaturate` filter, which removes the saturation
       boost.
     - It sets the gaussian `Blur` filter's `inputRadius` to **60 pt**.
   - What is left is a neutral blur of the desktop and the windows behind.
   - The view's own layer is painted black. Only Mission Control and
     app-switcher snapshots show it, because they drop backdrop layers.
   - It is inserted at the bottom of the content view
     (`addSubview:positioned:NSWindowBelow relativeTo:nil`). That is the same
     slot Electron uses for its vibrancy view.
2. **One tint per region, painted straight over the blur**
   (`apps/desktop/src/app/helpers/window_glass.rs`). The comment there says the
   tint is "applied once instead of stacking into an opaque slab".
   - The window shell is clear.
   - The sidebar paints its colour at **88% dark / 93% light**. The work area
     paints its colour at **81% dark / 86% light**. So the sidebar is the more
     covered one.
   - Nested panes paint nothing. Cards on glass are a 6% (dark) or 4% (light)
     ink wash. Dividers are ink at 8%.
3. **Floats.**
   - Ghostex's native menus are separate windows with their own 20 pt blur
     that keeps saturation. Their fill covers 32% in dark (lifted 8% toward
     white) and 60% in light.
   - Its native dialogs cover 86% in dark and 90% in light.
   - Its **web (React + shadcn) modals**
     (`packages/core-ui/styles/modals-glass.css`) are the case that matches
     Videorc, which is all web.
     - They are **solid and flat**. The owner's words there are "bg shouldn't
       be gradient or fake glass or anything just lighter color".
     - The dialog is the chrome colour plus 6% white (about `#1c1c1c`).
     - Popups add 3%, raised surfaces 6% and hover 8.5%. Hairlines are white at
       10–13%.
     - An earlier 12% lift (about `#2a2a2a`, close to Videorc's float today)
       was rejected as "too light gray".
4. **Policy.**
   - `windowGlass` defaults to **Dark only**: light mode is opaque, "where glass
     has the weakest text contrast".
   - The "Always" setting uses the light numbers above.
   - Reduce Transparency makes the window opaque.
   - **On this Mac, Ghostex runs those defaults.**
     `~/.config/ghostex/native-sidebar-settings.json` has no `windowGlass*`
     keys, so the Ghostex the owner sees in light mode is opaque.

## What Videorc does today (`origin/main` `a8637877`)

- **Material.** `src/main/window-glass.ts` sets `vibrancy: 'under-window'`
  and `visualEffectState: 'active'`.
  - Electron 39.8.10 creates a plain `NSVisualEffectView` for that
    (`shell/browser/native_window_mac.mm`, `SetVibrancy`). It stores it as the
    window's `vibrantView` and hosts it at index 0 under all web content.
  - AppKit draws it untouched: the material tint, wallpaper tinting, the
    saturation boost and the default blur.
  - Over pure white, the dark material alone reads `#4A4B49`
    (`docs/acceptance/2026-09-23-real-glass-calibration.md`).
- **Coats.** `src/renderer/src/styles.css`:
  - `body` paints `--glass-window`, 42% dark and 60% light.
  - `main` (`components/app-shell.tsx:366`) and `WindowFrame`
    (`components/window-frame.tsx:38`) add `--glass-content`, 34% and 30%.
  - The sidebar sits on the window coat alone, so it reads **lighter** than
    the content. That is the opposite of Ghostex.
  - The coats are thin because the material already greys everything.
  - The result: the dark glass measures OKLCH L 0.19–0.26 (about
    `#141414`–`#242424`) over every probe backdrop. That narrow range is the
    "milk".
- **Floats.** `glass-float` (plan 072) is opaque. Dark is `oklch(0.275)`
  (about `#2B2B2E`); light is `oklch(0.99)`. Both add a sheen gradient, a rim
  and a top highlight.
- **Already Ghostex-like, keep.** Inside panes there are no opaque slabs:
  `bg-card` is used in one file, and washes are `bg-muted` / `bg-accent` at
  6–8%.

## The gap

Targets assume the stripped material is neutral and mix in sRGB, as Chromium
and Core Animation composite. Videorc's base colours are `#0D0D0F` (dark) and
`#FAFAFB` (light). The Ghostex column applies Ghostex's covers to those same
bases. Ghostex's own dark workspace colour on this Mac is `#0e0e0e`, within
one step.

| Item                              | Ghostex                                          | Videorc today                            | Videorc after 091                                            |
| --------------------------------- | ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------ |
| Material                          | `under-window`, stripped, blur 60 pt             | `under-window` as AppKit draws it        | `under-window`, stripped, blur 60 pt                         |
| Dark sidebar / work cover         | 88% / 81%                                        | 42% / 62% total, over the grey material  | **88% / 83%** (D3)                                           |
| Light sidebar / work cover        | 93% / 86% ("Always"); opaque by default          | 60% / 72% total, over the white material | **93% / 86%**                                                |
| Dark work, white / black desktop  | `#3B3B3D` / `#0B0B0C`                            | inside L 0.19–0.26 whatever the desktop  | `#363638` (L 0.333) / `#0B0B0C` (L 0.150)                    |
| Dark sidebar, white / black       | `#2A2A2C` / `#0B0B0D`                            | ≈ `#303131` over white                   | `#2A2A2C` (L 0.286) / `#0B0B0D` (L 0.150)                    |
| Light work, black / white desktop | `#D7D7D8` / `#FBFBFC`                            | white material over anything             | `#D7D7D8` (L 0.879) / `#FBFBFC`                              |
| Transmission (probe metric)       | n/a                                              | dark 24–37, light 10–13                  | ≈ dark work 61, sidebar 43; light work 50, sidebar 25        |
| Floats (dark)                     | web: flat `#1c1c1c`, popups +3%; native: frosted | opaque `#2B2B2E` + sheen + top highlight | flat: dialog `#1C1C1D`, popups `#232324`, tooltips `#0D0D0F` |

Transmission rises even though the tints get heavier. The grey material, not
the coat, is what eats the desktop colour today.

## Decisions (auto-grilled)

**D1. Port Ghostex's strip onto Electron's own vibrancy view.**

- Keep `vibrancy: 'under-window'`. The window then keeps its native shadow,
  border highlight and resize edges, and plan 050's options do not change.
- The addon re-classes Electron's `vibrantView` to a `NSVisualEffectView`
  subclass, `VideorcClearGlassView`, using a KVO-style isa swap.
  - The subclass overrides `updateLayer` to run Ghostex's strip.
  - It adds no ivars. The blur radius is a global, and the snapshot base
    comes from the view's `effectiveAppearance`.
- Electron stays the only owner of the view. `setVibrancy(null)` still
  destroys it, and any re-created view is re-classed again.
- Rejected alternatives:
  - **Own view instance.** It needs `transparent: true` and fights Electron's
    `NativeViewHost`. It is fallback B in S0.
  - **`CGSSetWindowBackgroundBlurRadius`.** It needs a transparent window,
    gives no saturation control, and Ghostex's current macOS path does not use
    it. It is fallback C.
  - **`NSGlassEffectView`.** That is Liquid Glass (refraction, edge
    highlights), a different look, and Ghostex does not use it.

**D2. Blur radius 60 pt on every window.** The saturation boost is stripped
everywhere.

**D3. Coverage.**

- Dark: sidebar 88%, work area **83%**. Ghostex's 81% leaves
  `--muted-foreground` at 4.35:1 over a white desktop, below the probe's 4.5
  gate. 83% is the smallest value that passes (4.69:1).
- Light: sidebar 93%, work area 86%. Over a black desktop that gives 5.53:1 and
  4.71:1.
- The sidebar is darker than the work area in dark mode and whiter in light,
  as in Ghostex. This deliberately reverses plan 050's "sidebar reads
  lighter".

**D4. Tokens carry Ghostex's numbers. CSS derives a flash-free stack.**

- Per theme and platform, set `--glass-cover-sidebar` and `--glass-cover-work`.
- `body` paints the lighter cover:
  `--glass-cover-body: min(sidebar, work)`. First paint and any full-window
  state therefore stay tinted.
- The heavier region adds the exact delta `1 - (1 - cover) / (1 - body)`.
  - The sidebar's delta becomes the new `bg-glass-sidebar`.
  - The work area's delta keeps the existing `bg-glass-content` name. `main`
    and `WindowFrame` are unchanged.
- Every region uses one base colour, so each region composites to exactly
  its cover. On macOS the work delta is 0 and the sidebar delta is 29.4%
  (dark) or 50% (light).

**D5. Windows keeps its look.** The win32 covers reproduce today's Mica
composite exactly:

| Theme | Sidebar | Work                  | Result                                          |
| ----- | ------- | --------------------- | ----------------------------------------------- |
| dark  | 0.34    | 0.512 (1 − .66 × .74) | work delta 25.8%, today's `--glass-content` 26% |
| light | 0.50    | 0.62 (1 − .5 × .76)   | work delta 24%, the same as today               |

Windows has no material strip (Mica is untouched).

**D6. Floats follow Ghostex's web-modal recipe: flat and opaque.**

- Dark tones:
  - Dialog and palette surface: base plus 6% white (`#1C1C1D`).
  - Popups (menus, select, popover, hover card, context menu, toasts): plus
    3% on that (`#232324`).
  - Raised: plus 6%. Hover inside floats: plus 8.5%.
  - Rim: white 10%.
  - Tooltips: the dark base (`#0D0D0F`) with the rim. Ghostex darkens its
    dark tooltips.
- Light keeps its tone (`oklch(0.99)`) with a black 10% rim.
- Both themes drop the sheen gradient and the top highlight, and keep the
  drop shadow.
- The floats stay opaque. Plan 072 S0 showed `backdrop-filter` never reaches
  the screen on these windows. S0 re-checks this once and only records the
  result.

**D7. Accessibility.**

- Reduce Transparency: the addon skips the strip, so AppKit draws its solid,
  and the covers go to `--glass-solid`, as today.
- Increase Contrast: both covers go to 0.95.

**D8. Light glass stays on, as the owner asked for both themes.** If the owner
rejects light glass by eye, the fallback is Ghostex's own default (light covers
`1`, which is opaque). That is a two-token change, not a setting.

**D9. Glass chips stay.** Plan 050 D9 (gradient, rim and highlight pills) is
an owner decision. Ghostex's flat cards already match `bg-muted` /
`bg-accent`.

## Slices

Work in a dedicated worktree (`../videorc-wt-091-clear-glass` from
`origin/main`). Commit each slice to `plan/091-clear-glass` and open one PR.

### S0: The clear-glass strip in the addon, behind a flag, with a neutrality proof (`fable-5`)

Files:

- `crates/videorc-native-preview-addon/src/lib.rs` and its `Cargo.toml`
  (objc2 `define_class!`, CALayer filter access).
- `apps/desktop/src/main/window-appearance.ts`.
- `apps/desktop/src/main/window-glass.ts`.
- `apps/desktop/src/main/index.ts`.
- `scripts/ui-glass-probe.mjs`.

Steps:

1. **The subclass.** Register `VideorcClearGlassView : NSVisualEffectView`.
   - `updateLayer` calls `super`, then runs Ghostex's strip
     (`remove_layer_background`): nil each layer's `backgroundColor`, hide
     `CAChameleonLayer`, drop the filter whose description contains
     `Saturat`, and set `inputRadius` on the one containing `Blur`.
   - It then paints the root layer's snapshot base: `#0D0D0F` when its
     `effectiveAppearance` is dark, `#FAFAFB` when light.
   - When `NSWorkspace.accessibilityDisplayShouldReduceTransparency` is on,
     it does nothing.
   - Every step gives up quietly on anything it does not recognise.
2. **The napi function.** Add
   `set_window_glass_style(handle, { blurRadius }) -> { restyled, reason }`.
   It runs on the main thread.
   - It finds the window's behind-window effect views with the same walk as
     `window_effect_views`.
   - It re-classes a view only when `object_getClass(view)` is exactly
     `NSVisualEffectView`. A KVO class or any other subclass reports
     `unsupported-class`.
   - It then calls `setNeedsDisplay(true)`.
3. **Read-back.** `window_effect_views` also reports `clear` and the
   backdrop's blur radius, read back from the layer tree.
4. **Main applies the style.**
   - `VIDEORC_GLASS_STYLE=clear|material` selects it. The default in S0 is
     `material`.
   - `finishGlassWindow` applies it to every `material` window.
   - It is re-applied after the `set-vibrancy` and `revibrancy` smoke levers.
   - A failure logs once and keeps the plan 050 material. It never falls back
     to solid or fake frost.
   - `runtime-info` and `window-glass-state` report the applied style.
5. **Probe.** Add `--style=clear|material` and two metrics.
   - **`neutrality`.** Zero the coats through the probe's existing
     `cdpEvaluate` style injection. The glass sample over white, black, red
     and blue must then sit within RGB distance **≤ 8** of the backdrop.
     Today's material measures about 313 over white.
   - **`nativeClear`.** Every effect view reports `clear` and a radius of 60.
6. **Record a calibration doc.** Write
   `docs/acceptance/2026-10-XX-clear-glass-calibration.md`.
   - The effect view's layer tree (class names and filter descriptions)
     before and after the strip.
   - Neutrality, transmission and sharpness for `material` against `clear`,
     in both themes.
   - A persistence matrix. The strip must still hold after:
     - losing focus;
     - dark → light → dark;
     - resize;
     - fullscreen in and out;
     - minimize and restore;
     - a `set-vibrancy` re-create.
   - WindowServer CPU for `material` against `clear`, measured with `top`
     after a 20 s settle with the preview presenting, in the same session.
   - A by-eye check that the Mission Control snapshot is not see-through.
7. **Backdrop-filter re-check.** Re-run plan 072's backdrop-filter bleed check
   once under `clear` and record the result. If it reaches the screen
   (unexpected), finish S0 and ask the owner whether to open a frosted-menu
   follow-up. S3 stays flat either way.

Done when:

- With `VIDEORC_GLASS_STYLE=clear`, main passes `neutrality` on all four
  backdrops in both themes.
- `nativeClear` holds through the whole persistence matrix.
- The default (`material`) run passes the unchanged
  `pnpm probe:ui-glass --gate`.
- The addon's cargo gates and `pnpm typecheck` are green.

STOP if the strip does not persist, because AppKit rebuilds the layers outside
`updateLayer`. Then try the fallbacks in order:

- **Fallback B.** The addon inserts its own `VideorcClearGlassView` under the
  content, with Electron vibrancy off. Prove the shadow, resize edges and
  traffic lights still work.
- **Fallback C.** `CGSSetWindowBackgroundBlurRadius` on a transparent window.
  Prove the corners and shadow.

If none of them is neutral, stop and report. Never ship a fake frost.

### S1: Ghostex coverage, clear glass on by default (main, Stream Manager, Captions, Notes)

Files:

- `styles.css`: covers, the derived coats, `bg-glass-sidebar` in
  `@theme inline`, the win32, contrast and reduced-transparency blocks, and the
  token-contract comment.
- `components/sidebar.tsx`: the `<aside>` adds `bg-glass-sidebar`.
- `window-glass.ts`: the default style becomes `clear`, and
  `VIDEORC_GLASS_STYLE=material` keeps the plan 050 look for one release of
  A/B.
- `scripts/ui-glass-probe.mjs`: expected values.
- The window-glass and style-guard tests.

Sketch. Values are from D3 and D5; check the derived coats in DevTools.

```css
:root {
  --glass-base: 0.985 0.001 286;
  --glass-cover-sidebar: 0.93;
  --glass-cover-work: 0.86;
}
.dark {
  --glass-base: 0.13 0.003 286;
  --glass-cover-sidebar: 0.88;
  --glass-cover-work: 0.83;
}
:root,
.dark {
  --glass-cover-body: min(var(--glass-cover-sidebar), var(--glass-cover-work));
  --glass-window: oklch(var(--glass-base) / var(--glass-cover-body));
  --glass-sidebar: oklch(
    var(--glass-base) /
      calc(1 - (1 - var(--glass-cover-sidebar)) / max(1 - var(--glass-cover-body), 0.001))
  );
  --glass-content: oklch(
    var(--glass-base) /
      calc(1 - (1 - var(--glass-cover-work)) / max(1 - var(--glass-cover-body), 0.001))
  );
}
```

Done when:

- `pnpm probe:ui-glass --gate --themes=dark,light --roles=main,chat,captions,notes`
  passes the existing gates (transmission ≥ 8, sharpness, primary ≥ 7,
  secondary ≥ 4.5), `neutrality` and `nativeClear`.
- A new `ghostexParity` check passes: each sample over white and black is
  within ±0.02 OKLCH L of the gap table's targets.
- The win32 composite tokens equal today's. A unit test computes them.
- `pnpm --filter @videorc/desktop test` and `pnpm check:renderer-assets` are
  green.

### S2: The Preview frame and the preview gates

Files:

- `src/main/window-palette.ts`: `DARK_GLASS_COATS` is derived from the dark
  covers. The data-URL document paints the body cover and a 0% content coat.
- `window-palette.test.ts`: parity with `styles.css`.
- `index.ts`: the Preview window takes the style; its pin stays dark.

Done when:

- `probe:ui-glass --gate --roles=preview` passes, including the pinned-dark
  luminance check.
- `pnpm probe:preview-lifecycle` and `pnpm probe:preview-window` pass on an
  idle machine.
- `pnpm probe:comments-window` passes.

### S3: Floats, Ghostex's flat lift (`opus-4.8` is fine)

Files:

- `styles.css`: the `glass-float` tokens and utility, a dialog tier and a
  tooltip tier, and the unlayered sonner block.
- `ui/dialog.tsx` and `ui/command.tsx` (the dialog tier), and `ui/tooltip.tsx`.
- `scripts/lib/float-glass-checks.mjs`.
- `renderer-style-guards.test.ts`: the `bg-popover` and backdrop-blur bans
  stay.

Steps:

- Apply D6.
- Replace the float gate's "lift over the window glass" check with a
  fixed-tone check: the float measures its token within ±0.01 L whatever is
  behind it. Ghostex's dark floats are deliberately darker than the glass over
  a bright desktop.

Done when:

- `pnpm probe:ui-glass --gate --surfaces --themes=dark,light` passes: no
  bleed, text ≥ 7 / 4.5, and fixed tone.
- The owner has looked at each of these in both themes:
  - the Go Live dialog;
  - the ⌘K palette;
  - a Select inside a dialog;
  - the Stream Manager hover card;
  - a toast;
  - a tooltip.

### S4: Language, docs, acceptance (`opus-4.8` is fine)

Files:

- `.claude/skills/videorc-design/SKILL.md`: the material is clear glass; the
  coat rule is now "covers per region, sidebar heavier"; the float recipe.
- The `window-glass.ts` header.
- The final calibration doc.
- A row in `plans/README.md`.

Owner by-eye acceptance on the **packaged** app, side by side with Ghostex:

- Over a bright wallpaper, a dark wallpaper, and a colourful wallpaper with a
  white browser window half behind both apps.
- In dark and in light.
- Focused and unfocused.
- In Mission Control.
- With Reduce Transparency on.
- With Increase Contrast on.

Done when the owner signs off, or picks the D8 fallback for light mode.

## Verification

- Addon:
  - `cargo fmt --check --all`
  - `cargo clippy -p videorc-native-preview-addon -- -D warnings`
  - `cargo test -p videorc-native-preview-addon`
  - `pnpm build:native-preview-addon`
  - `pnpm build:native-preview-addon:release`, which catches release-only
    cfg gaps.
- TypeScript: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`, `pnpm build`,
  `pnpm check:renderer-assets`.
- Glass:
  - `pnpm probe:ui-glass --gate --surfaces --themes=dark,light`. Run it once
    with all roles, and once with `--style=material` as the A/B control.
- Windows and preview: `pnpm probe:comments-window`,
  `pnpm probe:preview-lifecycle`, `pnpm probe:preview-window`.
- Packaged: `pnpm smoke:packaged:native-preview`, which proves the addon still
  loads and presents in the signed layout.

## Known blockers and traps

- **Private AppKit internals.** `CAChameleonLayer`, `colorSaturate` and the
  `Blur` filter's `inputRadius` are undocumented.
  - Zed's GPUI and Ghostex ship the same strip. Ghostex runs it on this Mac's
    macOS 26.5.1 today.
  - A macOS update could still rename them. `neutrality` and `nativeClear`
    are the tripwires, and every strip step must fail soft.
- **Never re-class a view whose class is not exactly `NSVisualEffectView`.**
  A KVO class or a future Electron subclass would break.
- **Screen capture.** The probes need Screen Recording permission for
  `screencapture -R`. That already works for agents here, and no probe
  captures the owner's real desktop.
- **`probe:preview-lifecycle` steals focus** about 100 times, so it needs an
  idle machine. Do not run heavy builds during recording smokes.
- **Shared checkout.** Other sessions switch branches in
  `~/projects/videorc`, so stay in the worktree. APFS-clone an idle sibling's
  `target/` (check `ps` first).
- **The renderer eager budget** has little headroom. This plan is CSS only on
  the renderer side, but run `check:renderer-assets`. CI's Linux gzip is the
  gate.

## Out of scope (follow-ups)

- Ghostex's other backdrop sources: Wallpaper, Picture, Live animations and
  your own video.
- Blur and tint sliders, and a Transparency setting (Dark only / Always /
  Never).
- Windows acrylic (Ghostex uses the DWM blur there; Videorc keeps Mica) and
  Linux.
- Frosted menus as separate native windows.
- Hairline weight: Ghostex uses 8%, Videorc 10%/12%.

## References

- Ghostex material:
  https://github.com/maddada/zed/blob/b0b0b8500c62ab19977ef6f422ffe1357efe231d/crates/gpui_macos/src/window.rs
  (`BlurredView`, `remove_layer_background`, `apply_window_backdrop`).
- Ghostex tints and policy:
  https://github.com/maddada/Ghostex/blob/dd7d40f7d9c2fe16660b52cff5d2cf476f57593e/apps/desktop/src/app/helpers/window_glass.rs
- Ghostex web modals:
  https://github.com/maddada/Ghostex/blob/dd7d40f7d9c2fe16660b52cff5d2cf476f57593e/packages/core-ui/styles/modals-glass.css
- Ghostex defaults:
  `/Applications/ghostex.app/Contents/Resources/CLI/skills/ghostex-help/references/settings-catalog.json`
  (`windowGlass*`).
- Electron 39.8.10 vibrancy:
  https://github.com/electron/electron/blob/v39.8.10/shell/browser/native_window_mac.mm
  (`SetVibrancy`).
- Videorc:
  - plan 050 (`plans/050-real-glass-in-every-window.md`);
  - plan 072 (`plans/072-glass-floating-surfaces.md`);
  - `docs/acceptance/2026-09-23-real-glass-calibration.md`.

## Implementation record

Evidence: `docs/acceptance/2026-10-02-clear-glass-calibration.md`.

- **S0 (2026-10-02).** D1 held on the first attempt: Electron's vibrancy view
  takes the `VideorcClearGlassView` class in place, the strip is neutral
  (≤ 1.03 RGB steps from the bare backdrop against 297–349 for AppKit's
  material) and it persists through theme, resize, simple fullscreen,
  minimize/restore and a re-created view. macOS 26.5.1 carries one filter
  the Ghostex comment does not know, `sdrNormalize`; the strip leaves it. No
  fallback (B or C) was needed. Two findings outside the plan: the addon's
  test build had never mounted `frame_store` (the compositor's tests use it),
  and every `*-window-set-bounds` smoke command activated the app through
  `show()`, so `probe:ui-glass` had been taking focus at placement since
  plan 050; the commands now honour `focus: false`.
- **S1 (2026-10-02).** D3's covers held as written: dark 88% / 83%, light
  93% / 86%, no adjustment. The dark token base `oklch(0.13 0.003 286)`
  renders `#070708`, not the `#0D0D0F` this plan's gap table assumed (that
  hex is `window-palette.ts`'s rounding), so the measured dark samples sit
  about 0.02 OKLCH L below the table and contrast lands higher than the
  table's 4.69:1 (secondary 5.05:1 dark work, 4.71:1 light work). The
  derived coats survive Tailwind v4 / lightningcss verbatim and Chromium
  resolves them to the designed alphas (0.83 / 0.294 / 0 dark, 0.86 / 0.5 / 0
  light). D5's dark work cover is 0.5116, not 0.512, so the Windows content
  delta is exactly plan 050's 26%. `ghostexParity` is an RGB-distance gate
  (≤ 4) against a prediction from the computed coats over a bare-backdrop
  reference, with the OKLCH L reported beside it, rather than the ±0.02 L
  check the slice sketched.
- **S2 (2026-10-02).** `DARK_GLASS_COATS` is derived from the dark covers
  (body 83%, content 0%), pinned to `styles.css` by `window-palette.test.ts`.
  The Preview passes the full gate in both themes, the pinned-dark check
  included (white luminance 0.031 with main in light theme), and its strip
  sharpness drops from 4.2 to 0.05 under the 60 pt blur.
  `probe:preview-lifecycle` is the owner's to schedule; `probe:preview-window`
  and `probe:comments-window` were not run because both activate the app
  by design (`main-window-focus` and OS clicks; the Stream Manager's open
  and toggle paths).
