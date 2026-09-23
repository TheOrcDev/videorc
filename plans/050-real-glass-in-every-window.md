# Plan 050: Real glass and a native look in every window

> Executor: implement the ordered slices below in your own worktree of current
> main, never in the shared `~/projects/videorc` checkout. Read AGENTS.md,
> `.claude/skills/videorc-design/SKILL.md`, and this plan's Design section
> first. Every slice ships on its own and leaves main green. Planning
> authorizes no merge or release.

## Status and decisions

- Status: PLANNED 2026-09-23. Priority P1. Effort XL: 6 phases, 22 slices.
  Risk MEDIUM. Every window's chrome and every screen change. The preview,
  recording, and capture-protection paths are touched only at the window level,
  and each touch has a gate.
- Owner, 2026-09-23: "We want to have this real glass look … we need to be
  consistent in every window, comments, chat, etc. Everything needs to look
  good." Also: "We also want all these badges to look glassy and not regular
  like they are right now" (the `● Ready` status pill). The reference is the
  Ghostex screenshot the owner shared: real desktop blur under the whole
  window, flush panes, toolbar rows at the traffic lights, and quiet glass
  chips.
- Planned against `origin/main` `6418c739` (fix(tabs), #392). The
  plan-storage checkout (`feat/windows-owner-waiver`) is behind. Build on main.
  `apps/desktop/src/main/index.ts` has not changed since `14d8ffad`, so its
  line numbers below hold.
- Evidence from the 2026-09-23 investigation (captures in that session's
  scratchpad, not committed; S1 rebuilds the same evidence as a probe):
  1. Real macOS vibrancy blurs through in Electron 39.8.10 on macOS 26.5.1. It
     works in a clean window and in the real Videorc window
     (`VIDEORC_GLASS_VIBRANCY=under-window` with the wallpaper underlay hidden
     through CDP). It was shot with `screencapture -R` over a loud backdrop,
     and works with or without `transparent: true`. The `sidebar` and
     `fullscreen-ui` materials transmit too.
  2. `visualEffectState: 'followWindow'` paints the material flat opaque gray
     when the window is unfocused.
  3. The shipped fake frost (wallpaper underlay at 0.92) still leaks faintly
     readable text from windows behind the app. Real vibrancy blurs the same
     text down to colour.
  4. Over a warm wallpaper, today's window reads flat near-black. Real vibrancy
     with a lighter coat picks up the wallpaper like the reference does.
  5. Electron 39's Chromium 142 parses `prefers-reduced-transparency`,
     `prefers-contrast`, and `prefers-reduced-motion`.
  6. The June premise, "NSVisualEffectView paints fully opaque here" (commit
     `b15750a7`, repeated at `index.ts:1611-1616`, `glass-wallpaper.tsx:9`, and
     SKILL.md:25), does not reproduce on this stack.
  7. Contrast is reachable with real glass. Over pure white, the dark
     `under-window` material measures `#4A4B49` (luminance 0.069).
     Secondary text (`#A1A1AA`) needs a background luminance of 0.040 or less
     for 4.5:1, so a coat of about 30% of `--glass-solid` already reaches it.
     `fullscreen-ui` measures `#787775` (0.185) over white, too light for a
     base material.
- Independent review (2026-09-23, `fable-5`, read-only): its findings are
  folded in below, and "Review amendments" lists each one.
- Owner route: Orchestrator sequences the phases. UI/Product Design (fit 9)
  owns every slice. Model lanes:
  - `fable-5` for phases 1, 2 (except S8), 5, and 6. These cover the native
    window material, per-window appearance, the preview interplay, perf, the
    shell architecture, Windows materials, and acceptance.
  - `opus-4.8` for S8 and phases 3 and 4 (screen conversions and native
    polish).
  - If a slice's captures miss the by-eye bar, escalate without asking.
- Branches: one per phase: `feat/real-glass-p1-material`,
  `feat/real-glass-p2-language`, `feat/real-glass-p3-screens`,
  `feat/real-glass-p4-native-feel`, `feat/real-glass-p5-windows`. A phase may
  split into several PRs. Commits use `feat(glass):` / `feat(ui):`.
- Owner decisions:
  1. (owner, 2026-09-23) Real OS glass replaces the fake wallpaper frost in
     every window. All windows read as one family: the same material, header
     spec, tokens, chips, and controls.
  2. (owner, 2026-09-23) "Everything needs to look good": the website-like
     structure is in scope. The design language moves from command-palette
     scale to desktop scale (Phase 2), and every screen converts (Phase 3).
  3. (owner, 2026-09-23) Badges, status pills, and key chips become glass chips
     (D9).
  4. Defaults the owner can flip before the named slice. Each is one switch in
     `window-glass.ts`:
     - a. Chat, Captions, Notes, and Preview stay dark in both themes. This is
       the existing rule: they are part of the show or they frame video. S3
       pins their appearance per window, so light mode no longer leaks into
       their material.
     - b. Glass stays live when a window is unfocused (`visualEffectState:
'active'`, as today). Native apps go flat when inactive. We don't,
       because Chat and Captions spend most of a stream unfocused.
     - c. No in-app "glass off" toggle. macOS Reduce Transparency is honoured
       (solid palette). The solid path exists, so a toggle stays cheap later.
     - d. Windows gets Mica on Windows 11 in Phase 5. Windows 10 keeps the
       solid palette.
- Coordination: plans 043 (Freeform editor), 044 (saved scenes, partly landed
  as #383), and 046 (live source switching, #389) touch the Studio and Scene
  screens. Phase 1 does not conflict with them. S12 and S14 rebase onto
  whatever of those has landed. If a branch is open on the same files, stop and
  coordinate instead of racing it.

## Review amendments (2026-09-23)

The independent review verified the source inventory. These amendments
change the slices below:

1. **S3, addon loading.** The `.node` loads only inside the preview driver
   (`loadNativePreviewPrimaryDriver`), and the in-process binding validator
   checks its six exports. Add a preview-independent
   `loadWindowAppearanceBinding()` that uses the same module-path resolver,
   and treat the new export as optional.
   - If the pin fails, pinned roles paint `--glass-solid` (no light material
     under a dark window). `window-glass-state` and Health report it.
   - `pnpm build:native-preview-addon` becomes a prerequisite of
     `probe:comments-window`.
2. **S5 and S12, AGENTS.md.** Both touch the preview (S5 rebuilds the window
   that hosts the CAMetalLayer; S12 moves the docked slot). They run
   `pnpm smoke:recording-studio`, or, if the host blocks a device smoke, its
   preview-reliability smokes with the reason recorded. The Verification
   section no longer waives it.
3. **S21, Mica backing.** Mica cannot show through the opaque Windows backing.
   On Windows 11 with Mica, the window gets a transparent `#00000000` backing,
   and `app:set-native-theme` stops repainting an opaque base. `index.ts`
   changes in S21.
4. **S4, Notes smoke marker.** The sandboxed renderer cannot read
   `VIDEORC_NOTES_SMOKE_MARKER`. Main loads `notes.html?smokeMarker=1` instead.
5. **D8, displays.** The probe moves every window onto the primary display
   (where the backdrop is) before capturing.
6. **S1, CDP access.** CDP comes from the existing `VIDEORC_REMOTE_DEBUG_PORT`
   switch, and the underlay is hidden through it in every renderer window.
7. **S1, calibration.** The calibration doc publishes the raw metrics, and each
   gated metric needs at least 2x separation between today's frost and real
   glass.
8. **S3 and S11, fullscreen.** `WindowFrame` listens to a `window:fullscreen`
   event (`enter-full-screen` / `leave-full-screen`) and collapses the
   traffic-light gutter, because native fullscreen hides the lights.
9. **Perf.** The WindowServer sample runs while the preview presents
   (`probe:ui-glass` runs with preview motion). S2 also samples during a
   `smoke:record-latency` run.
10. **Citations.**
    - The Toaster is at `App.tsx:45`.
    - The Windows smokes are `smoke:windows-stream-performance` and
      `smoke:windows-native-screen`.
    - `perf-idle-probe` runs as `pnpm smoke:preview-performance`.
    - `api-policy.ts` glass keys are at 39-41 and 49-51.
11. **S8 order.** S8 runs after S7, since both edit `styles.css`.
12. **S12, docked slot check.** Use `probe:preview-window`'s numeric check:
    docked window bounds equal the slot rect within 1 px.
13. **D6, accessibility.** The opt-in text-selection set names the Chat
    composer, the Notes textarea, every input, textarea and contenteditable,
    chat messages, transcripts, and logs.

## Problem (measured from source, origin/main 6418c739)

### P1. The glass is simulated, and it no longer has to be

- The frost is `GlassWallpaperUnderlay`
  (`renderer/src/components/glass-wallpaper.tsx:18`). It is mounted three times:
  `App.tsx:35`, `comments/main.tsx:309`, and `captions/main.tsx:59`.
  - Main fetches the wallpaper through System Events (`currentWallpaperPath`,
    `index.ts:802`), which is a one-time Automation permission prompt. It also
    re-encodes the image to JPEG (`refreshGlassWallpaper`, `:813`).
  - Main broadcasts per-window geometry on every move or resize
    (`glassGeometry` / `glassWindows` / `queueGlassGeometryBroadcast`,
    `:765-800`; `watchAuxWindowGlass`, `:1666`).
  - The renderer draws the image blurred 70 px at 0.92 / 0.94 opacity
    (`styles.css:208` and the light twin) under a 68% coat.
- Results: flat near-black; an Automation prompt; only the wallpaper and never
  the windows behind; a faint unblurred text leak; renderer GPU spent on a
  full-display blur; IPC on every move.
- Real vibrancy is available and the code already carries the switch
  (`VIDEORC_GLASS_VIBRANCY=<material>`, `index.ts:743-748`, `:1617-1626`). It
  is off by default because of the stale premise.
- Plumbing that exists only for the simulation:
  - IPC: `glass:wallpaper:get` (`index.ts:12873`), and the events
    `glass:wallpaper` and `glass:geometry`.
  - Preload: `getGlassWallpaper` / `onGlassWallpaper` / `onGlassGeometry`
    (`preload/index.ts:181-183`, `api-policy.ts:39-51`).
  - Types: `GlassWallpaperState` (`shared/backend.ts:3462`).
  - Tokens: `--glass-underlay-*`, `--glass-fallback-base`.
  - The `glass-shine` sweep: `App.tsx:38`, `comments/main.tsx:310`,
    `captions/main.tsx:60`, `panel-section.tsx:34`, `studio/session-panel.tsx:31`.

### P2. Five windows, five chrome recipes

| Window   | Document                                                      | Chrome today                                                                            | Header                                                                                                       | Traffic lights | Material      |
| -------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------- | ------------- |
| Main     | renderer `index.html`                                         | `platformWindowChromeOptions()` `index.ts:1588`: transparent + `#00000000`, hiddenInset | fixed 36 px drag strip (`app-shell.tsx:321`), no toolbar                                                     | (14, 13)       | fake underlay |
| Chat     | renderer `comments.html` (hard-codes `class="dark"`)          | `auxWindowChromeOptions()` `:1648`                                                      | 40 px, 88 px gutter (`comments-reader.tsx:328`)                                                              | (14, 13)       | fake underlay |
| Captions | renderer `captions.html` (hard-codes `class="dark"`)          | same                                                                                    | 40 px with `px-3`, so **the "Live captions" label sits under the traffic lights** (`captions-reader.tsx:52`) | (14, 13)       | fake underlay |
| Notes    | data-URL `notesWindowHtml()` `:2240`, ~100-line inline script | solid `DARK_WINDOW_PALETTE.base` `:2516`                                                | 34 px `VIDEORC NOTES` uppercase                                                                              | (14, 11)       | none          |
| Preview  | data-URL `PREVIEW_WINDOW_HTML` `:3678`                        | solid base `:3768`                                                                      | 28 px `VIDEORC PREVIEW` + dot grip                                                                           | (14, 8)        | none          |

- Notes hand-copies the app's scrollbar recipe ("keep the two in step by
  hand"). Both data-URL windows restate `window-palette.ts` colours, and
  nothing checks them against `styles.css`.
- `app:set-native-theme` paints `#F5F5F7` / `#1C1C1F` off macOS
  (`index.ts:12870`). That differs from the `window-palette.ts` solids
  (`#FAFAFB` / `#0D0D0F`) used everywhere else, so a Windows theme toggle
  changes the base colour.
- Preview's 28 px strip is load-bearing. `PREVIEW_WINDOW_BAR_HEIGHT`
  (`index.ts:1932`) drives the aspect lock and the native surface placement
  (`:1953-2010`).
- The macOS preview video is a CAMetalLayer added to the Preview window's own
  view at `zPosition 10000`
  (`crates/videorc-native-preview-addon/src/lib.rs:142-175`). A vibrancy view
  in that window sits below it, so glass cannot cover the video.

### P3. The structure reads as a web page

- The shell is a centered page column, `mx-auto max-w-[1600px] px-10 pt-4 pb-8`
  (`app-shell.tsx:350-354`). Every tab except Library scrolls as one
  document.
- There is no toolbar. The top 36 px is an empty drag strip, and the page
  title lives inside cards.
- `PanelSection` (`panel-section.tsx:34`) is a floating card:
  `glass-shine rounded-panel border bg-card/40 p-5 shadow-soft`. It has 40 call
  sites, with 18 px corners and `text-base` titles.
- Per-tab panel counts: Studio 4–5, Livestream 3 plus N `DestinationCard`s
  (`streaming-tab.tsx:584`) and 11 wells/banners, Settings 11, Health 7,
  Publish 3 plus 8 nested `rounded-panel` boxes.
- The sidebar opens with a logo/beta block (`sidebar.tsx:175-199`) and a
  36 px-row nav.
- The footer is a 44 px shortcut bar (`footer-action-bar.tsx:30`).
- Floating surfaces use off-tier radii: popover `rounded-3xl`, dropdown and
  select `rounded-2xl`, items `rounded-xl`.
- Scrollbars are a custom always-drawn `::-webkit-scrollbar` recipe
  (`styles.css`), not macOS overlay scrollbars. UI text is selectable almost
  everywhere: 19 `select-none` uses and none on the root.
- The skill mandates this scale: rows 44–48 px, 18–20 px search, 16–20 px panel
  radius, floating shadows (SKILL.md:43 and around it). That is correct for ⌘K,
  but wrong for a whole window.

### P4. Chips are flat fills

- `ui/badge.tsx` variants are solid tints: `success: bg-success/20
text-success`, `warning: bg-warning/25`, `destructive: bg-destructive/20`.
  - `default: bg-primary`, a solid white pill, has 18 uses with no variant prop.
  - 70 `<Badge>` uses across 21 files.
- `StatusBadge` (`status-badge.tsx:28`, 20 uses) is `h-6 rounded-chip` with a
  coloured dot, and the text is coloured too.
- `Kbd` (`ui/kbd.tsx:15`, 37 uses) is `bg-foreground/10`.
- Ad-hoc pills exist too: the sidebar `beta` badge (`h-4 text-[10px]`), status
  dots at `captions-reader.tsx:56` and `sidebar.tsx:130`, and more for S8's
  audit.

### P5. What breaks once the material is real

1. **CSS `backdrop-filter` on a vibrancy window wedged the compositor in June.**
   The notes are at `ui/dialog.tsx:54-58` and `ui/sonner.tsx:42-44`. It is
   still used at `sidebar.tsx:174`, `tabs/assets-tab.tsx:405,493`, and
   `captions-reader.tsx:135`.
2. **`nativeTheme` is app-global.** It is set at `index.ts:664` and
   `index.ts:12865-12872`. With real vibrancy, light mode turns the material of
   the dark-always windows light.
3. **Light mode can paint an opaque canvas.** Chromium does this when the
   root carries `color-scheme: light` (bisect cell `light-scheme-inline`).
   `theme-bootstrap.js:12` sets it inline, and next-themes sets it again
   because `enableColorScheme` is not disabled (`App.tsx:26`). Today the
   underlay hides this; real vibrancy would expose it.
4. **Reduce Transparency:** macOS paints the material opaque, and our alpha
   coats then sit on flat gray. Nothing handles it.
5. **Window capture:** a ScreenCaptureKit single-window capture of a
   vibrancy window may show the material without its backdrop (flat or
   transparent). Chat and Captions are part of the show. Display capture is
   unaffected.
6. **Probes tied to the simulation:**
   - `probe:comments-window` asserts the "glass underlay mounted".
   - `probe:preview-lifecycle` sets `VIDEORC_GLASS_WALLPAPER=0`.
   - `ui-glass-wallpaper-probe` only tests the underlay.
   - Every glass probe is report-only and main-window-only, and captures with
     `screencapture -l` or CDP, which cannot see vibrancy.
   - No probe measures WindowServer, and Captions has no macOS probe at all.

## Design

### D1. One window material (macOS)

A new main-process module, `src/main/window-glass.ts`, owns every window's
chrome. `windowGlassOptions(role, platform, env)` returns the BrowserWindow
options for `main | chat | captions | notes | preview`. No window builds its
own `vibrancy`, `backgroundColor`, `titleBarStyle`, or `trafficLightPosition`
any more. `platformWindowChromeOptions()` and `auxWindowChromeOptions()` fold
into it, and a registry answers "what did this window get" for probes and
diagnostics.

- **Material:** `vibrancy: 'under-window'` and `visualEffectState: 'active'` on
  every role. One material everywhere is the consistency rule. The
  sidebar/content difference is a CSS coat (D3), not a second material.
- **Backing:** prefer vibrancy without `transparent: true`. Electron makes the
  web contents transparent by itself when vibrancy is set, and the window keeps
  its native shadow and resize edges. S2 measures both backings against the
  wedge probes, keeps the one that passes, and records why in the module
  comment.
- **Appearance:** the main window follows the theme through
  `nativeTheme.themeSource`, as today. The dark-always roles (Chat, Captions,
  Notes, Preview; decision 4a) get `NSAppearance darkAqua` pinned per window.
  The pin goes through the existing native addon: add
  `setWindowAppearance(handle, 'dark' | 'light' | 'system')` to
  `crates/videorc-native-preview-addon`. The addon already turns an Electron
  window handle into an `NSView` (`native_view_pointer`, `lib.rs:427`). Add the
  `NSAppearance` feature to `objc2-app-kit`. If the addon is unavailable, log
  it and surface it in Health. Never fail silently.
- **Environment switches:**
  - `VIDEORC_GLASS=0` forces the solid palette everywhere (support/debug).
  - `VIDEORC_GLASS=<material>` overrides the material for experiments.
  - `VIDEORC_GLASS_VIBRANCY` and `VIDEORC_GLASS_WALLPAPER` go in S6. Keep
    reading `VIDEORC_GLASS_VIBRANCY=0` as an alias of `VIDEORC_GLASS=0` for one
    release.
- **Future Liquid Glass:** macOS 26's `NSGlassEffectView` is not exposed by
  Electron 39. Keeping the material choice inside this module makes a later
  switch a one-file change.

### D2. One window frame

| Role     | Document                            | Toolbar row                                  | Traffic lights                                         | Body                                                        |
| -------- | ----------------------------------- | -------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| Main     | renderer `index.html`               | 40 px per pane (sidebar pane + content pane) | (14, 13)                                               | sidebar + content, flush, 1 px hairline                     |
| Chat     | renderer `comments.html`            | 40 px (unchanged)                            | (14, 13)                                               | message list + Orcle pane + composer, flush                 |
| Captions | renderer `captions.html`            | 40 px with the 88 px gutter                  | (14, 13)                                               | caption lines on glass                                      |
| Notes    | **renderer `notes.html` (new, S4)** | 40 px (was 34)                               | (14, 13)                                               | textarea on glass + 24 px status line                       |
| Preview  | data-URL (stays)                    | **28 px, unchanged**                         | (14, 7) from the shared formula, verified on a capture | native video; glass only in the strip and the waiting state |

- Traffic-light `y` comes from one formula, `round((header - 14) / 2)`, the
  way `auxWindowChromeOptions` already does it. The gutter is one shared
  constant (88 px).
- Titles are sentence case at 13 px / 600: `Chat`, `Captions`, `Notes`,
  `Preview`. The uppercase tracked labels and the Preview dot grip go.
- Renderer windows mount one shared `WindowFrame`
  (`components/window-frame.tsx`). It sets the frame classes, the
  `data-reduced-transparency` and `data-window-focused` attributes, and the
  toolbar slot with its drag region and gutter. It replaces the hand-repeated
  underlay + `glass-shine` pair in all three roots.
- Preview's data-URL CSS is generated from the shared token module (D3), and a
  parity test pins it.

### D3. Coats and tokens

`styles.css` stays the source of truth. `src/main/window-palette.ts` becomes
`window-tokens.ts`: the solid palette plus the coat values that the Preview
strip and the BrowserWindow fallbacks use. A vitest parity test parses
`styles.css` and fails when the two disagree. Today the file only says "change
them together".

Starting values come from the 2026-09-23 "lighter coat" shot. S2 and S3 tune
them against the probe's contrast and privacy checks, then by eye.

| Token             | Dark start                    | Light start                    | Painted by                                                          |
| ----------------- | ----------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `--glass-window`  | `oklch(0.13 0.003 286 / 42%)` | `oklch(0.985 0.001 286 / 45%)` | `body`: the one window coat                                         |
| `--glass-content` | `oklch(0.13 0.003 286 / 34%)` | `oklch(0.985 0.001 286 / 35%)` | content panes only, so the sidebar reads lighter                    |
| `--glass-solid`   | `#0D0D0F`                     | `#FAFAFB`                      | Reduce Transparency, `VIDEORC_GLASS=0`, and non-macOS until Phase 5 |

- "Exactly one coat per region" stays the rule. Toolbars and status rows sit
  on their pane's coat and are split from it by a hairline.
- `@media (prefers-reduced-transparency: reduce)` swaps every coat for
  `--glass-solid`. `@media (prefers-contrast: more)` lifts hairlines to 20% and
  raises the secondary text tier.
- Delete `--glass-underlay-filter`, `--glass-underlay-opacity`,
  `--glass-fallback-base`, the `.glass-shine` utility, and its tokens.
- The root carries no inline `color-scheme`, which fixes P5.3. Set it on
  `body` instead (`.dark body { color-scheme: dark }` and the light twin), so
  native form controls still theme correctly. S2 proves that light-mode glass
  transmits.

### D4. Desktop structure (design language v2)

Keep the command-palette scale for ⌘K only, and define a desktop scale for
everything else. Starting values follow. S9 writes the final numbers into the
skill, and the owner signs off on captures.

- **Layout:** no page column. Content fills its pane edge to edge with a 16 px
  gutter. Panes are flush and split by 1 px hairlines. Inside a window there
  are no floating panels, no shadows, and no 18 px cards.
- **Toolbar row per pane** (40 px): the page title (14 px / 600). The toolbar
  never scrolls; only the pane body does. Toolbar rows are drag regions.
  - Owner call during execution (2026-09-23): no buttons in the toolbar's
    top-right corner. Page actions stay in the page body, and the Studio
    transport sits at the top of its inspector, above Session.
- **Sidebar:** the top row holds the traffic lights and the ⌘K search button.
  The logo/beta block goes; the brand lives in About and the Dock. Section
  labels are 11 px / 600 tertiary. Rows are 28 px, with 14 px text and 16 px
  icons. The account row stays at the bottom.
- **Status bar** (26 px), replacing the footer shortcut bar:
  - Left: connection and record/live state.
  - Right: 11 px hints (`⌘K Search · ⌘P Preview · ⇧⌘N Notes · ⇧⌘J Chat`),
    each still clickable.
  - This keeps the keyboard-first rule, only quieter.
- **Lists, not card stacks:**
  - Sets of like things (destinations, sources, devices, settings) are one
    grouped list with hairline separators and 32 px rows.
  - Cards remain only for objects with a picture (scene thumbnails, library
    items): 8 px radius, white-4% fill, 1 px hairline, no shadow.
- **Sections:** 13 px / 600 section headers inside panes replace the 16–18 px
  card titles, with 12–16 px vertical rhythm. `PanelSection` becomes this
  flush section, which converts its 40 call sites at once.
- **Radii:** containers 12 px (was 18), rows and cards 8 px (was 10), controls
  and chips 6 px, status chips round. Window corners belong to the OS.
- **Controls:** the default control height is 28 px. Retune it once in
  `components/ui` (Button, Select trigger, Input), never per screen.
- **Type:** keep the system stack and 14 px body, 12 px metadata, 11 px section
  labels. The reference's density comes from structure, not smaller text; its
  body text is 13–15 pt.
- **Colour rules are unchanged:** monochrome chrome, red only for
  record/live/destructive, vivid source icons.

### D5. Floating surfaces

Dialogs, popovers, menus, selects, tooltips, toasts, and the ⌘K palette stay
near-opaque `--popover` surfaces:

- Dialogs 12 px, menus and selects 8 px, menu items 28 px.
- One soft shadow plus a hairline ring.
- Tooltips become small dark-glass popovers instead of the inverted
  `bg-foreground` pill.

No CSS `backdrop-filter` anywhere in the renderer. S20 adds a guard test.

### D6. Native feel

- `html` gets `user-select: none`, `cursor: default`, and `overscroll-behavior:
none`. Content opts back in with `select-text`: chat messages, notes,
  transcripts, logs, and inputs. Add `img { -webkit-user-drag: none }`.
- Editable fields get a native context menu (Cut, Copy, Paste, Select All,
  spelling suggestions) through main's `context-menu` event and `Menu`. No new
  dependency.
- Drop the custom `::-webkit-scrollbar` recipe so macOS overlay scrollbars
  render and honour the system setting. Radix `ScrollArea` switches to
  `type="scroll"`.
- Tooltips open after about 600 ms. Rows highlight instantly. No
  `cursor-pointer`.

### D7. Windows

- Windows 11 22H2 and later (build ≥ 22621): `backgroundMaterial: 'mica'` on
  every role, using the same coats at Windows-tuned alphas. Mica tints from the
  wallpaper and does not live-blur, so it stays cheap on the low-end Intel
  iGPU machines testers use.
- Windows 10 and older builds: the solid palette.
- The D3D11 preview window and the proof surface stay opaque.
- Verify on the physical Windows box.

### D8. Verification harness: `probe:ui-glass`

A new `scripts/ui-glass-probe.mjs` (`pnpm probe:ui-glass`) runs on
`launchDevApp` with isolated user data:

1. **Backdrop.** A stand-in wallpaper sits behind the app, so the user's
   desktop is never captured.
   - Extend `open-backdrop-window` (`index.ts:10764`) with `variant: 'stripes'
| 'red' | 'blue' | 'black' | 'white' | 'text' | 'photo'`. `photo` loads
     `/Library/Desktop Pictures/Mojave Day.jpg` if present and otherwise skips.
   - Add `close-backdrop-window` and `raise-window { role }`. All are dev-only
     and stay out of `PACKAGED_SMOKE_COMMAND_NAMES`.
2. **Capture.** Open every window (main on Studio, Chat, Captions, Notes,
   Preview) through the existing `*-open` and `*-set-bounds` commands.
   REGION-capture each one (`screencapture -x -R`). Window captures and CDP
   cannot show vibrancy.
3. **Assertions,** per window and theme, on a text-free sample rect:
   - **Transmission:** mean colour over the red backdrop differs from the blue
     one by more than a calibrated margin.
   - **Privacy:** over the dense-text backdrop, high-frequency energy
     (Laplacian variance) stays under a calibrated ceiling, so text behind the
     app is not readable. The July leak becomes a test.
   - **Contrast:** measured coat luminance over white and black backdrops keeps
     primary text ≥ 7:1 and secondary ≥ 4.5:1.
   - **Unfocused:** transmission holds while another window has focus.
   - **Pinned appearance:** Chat, Captions, Notes, and Preview stay dark while
     main is light.
4. **Contact sheet.** Write one PNG per run for the owner. It is never
   committed.
5. **WindowServer CPU.** Sample WindowServer's CPU read-only (`ps -Ao
pid,comm,pcpu`, exact name match, never signalled) during a 60 s idle with
   the preview open. Report it next to the app's own processes.

No new npm dependency: decode PNGs with Electron `nativeImage` or `sips` → BMP.
Keep the pixel math in `scripts/lib/image-stats.mjs` with unit tests on
synthetic buffers.

### D9. Glass chips (the owner's badge request)

Every badge, status pill, tag, and key chip becomes glass. The mock
`4-badges-today-vs-glass.png` (2026-09-23 scratchpad) shows today's chips
against the proposal on real vibrancy. Dark values follow; the light twin
mirrors them.

| Part          | Dark                               | Light           |
| ------------- | ---------------------------------- | --------------- |
| Fill          | vertical gradient white 10% → 3.5% | white 70% → 45% |
| Rim           | 1 px white 13%                     | 1 px black 8%   |
| Top highlight | `inset 0 1px 0` white 12%          | white 90%       |
| Drop          | `0 1px 2px` black 30%              | black 6%        |

- **Status chip** (`StatusBadge`, success/warning/neutral): 22 px, fully
  round, 12 px / 500.
  - A 6 px dot in the tone colour carries the status, with a 2 px halo at 22%
    and an 8 px glow at 75%.
  - The text stays monochrome (primary value, secondary label). Colour is
    information, so it lives in the dot.
- **Emphasis chip** (live, destructive, failed): tinted glass. Gradient from
  tone 30% to 12%, rim tone 45%, text is the tone mixed 35% with white.
- **Tag** (`9:16`, `beta`, counts, `Idle`): 20 px, 7 px radius, 11 px,
  secondary text, the same glass.
- **Key chip** (`Kbd`): a glass keycap. Gradient white 12% → 4%, rim 13%, top
  highlight 14%, bottom `inset 0 -1px 0` black 30%.
- No `backdrop-filter` and no motion. Define it once in `ui/badge.tsx`,
  `status-badge.tsx`, `ui/kbd.tsx`, and `status-dot.tsx` using `color-mix(in
oklch, …)` on the existing tone tokens.
- The `default` variant (the solid white pill, 18 uses) maps to the neutral
  glass chip.
- Every ad-hoc pill moves onto `Badge` or `StatusBadge`.

## Slices

### Phase 1: real material in every window, layout unchanged (`fable-5`)

#### S1: `probe:ui-glass`, red first

Files:

- new `scripts/ui-glass-probe.mjs`
- new `scripts/lib/image-stats.mjs` and its `.test.mjs`
- root `package.json`
- `apps/desktop/src/main/index.ts` (smoke commands near `:10764`)
- `apps/desktop/src/main/smoke-command-security.ts`

Steps:

1. Add the backdrop variants and the `close-backdrop-window` and
   `raise-window` commands (D8). The
   `scripts/lib/smoke-command-callers.test.mjs` rule applies: every command a
   script uses must be allowlisted and handled.
2. Build the probe flow, sample rects, metrics, contact sheet, and
   WindowServer sample (D8).
3. Add `--calibrate`, which runs two configurations and prints every metric:
   today's default, and `VIDEORC_GLASS_VIBRANCY=under-window` with the
   underlay hidden through CDP. Set each threshold between the two measured
   populations.
4. Ship in report mode. `--gate` enforces the thresholds; S7 wires `--gate`
   into `smoke:local-gates`.

Done when:

- `pnpm probe:ui-glass` runs end to end on main and writes the contact sheet.
- The calibration numbers and thresholds are recorded in
  `docs/acceptance/<date>-real-glass-calibration.md`.
- On unmodified main, privacy fails for main, Chat, and Captions (the leak),
  and transmission fails for Notes and Preview (opaque). Both pass in the
  calibration vibrancy configuration.
- `pnpm test:scripts` covers `image-stats`.

#### S2: the main window on real vibrancy

Files:

- new `src/main/window-glass.ts` and its test
- `index.ts` (`createWindow` uses the module; delete
  `platformWindowChromeOptions`)
- `App.tsx` (drop the main underlay and shine mounts)
- `styles.css` (coats; body `color-scheme`)
- `theme-bootstrap.js:12` (stop writing inline `color-scheme`)
- `App.tsx:26` (`enableColorScheme={false}`)
- `app-shell.tsx` (the `main` element paints `--glass-content`)
- `sidebar.tsx:174` and `tabs/assets-tab.tsx:405,493` (drop `backdrop-blur`;
  the assets tiles get a solid `bg-popover/90`)

Steps:

1. Build `windowGlassOptions` with unit tests for every role × platform ×
   `VIDEORC_GLASS` value. Only `main` switches in this slice.
2. Compare the backings: A is vibrancy only, B is vibrancy +
   `transparent: true` + `#00000000`. Run each through the following, then keep
   the passing one (prefer A) and record the evidence:
   - `scripts/ui-vibrancy-reload-probe.mjs` (reload wedge)
   - `scripts/ui-palette-wedge-probe.mjs` (⌘K)
   - a dialog-open + toast check (frames keep presenting)
3. Record the perf baseline first: `perf-idle-probe` plus the probe's
   WindowServer sample on clean main. Then run both again on the branch.

Done when:

- `probe:ui-glass --gate` passes for main in dark and light: transmission,
  privacy, and contrast.
- The wedge probes pass.
- `perf-idle-probe` PASS, with presents at baseline and per-process CPU within
  +5 pp. Renderer CPU should drop.
- WindowServer idle CPU is within +3 pp of baseline, with the numbers in the
  PR.
- JS gates pass.
- Owner quick look (optional): the main window over their own wallpaper.

#### S3: Chat and Captions, pinned dark, one `WindowFrame`

Files:

- `window-glass.ts` (roles `chat` and `captions`)
- `index.ts` (`openCommentsWindow` `:3075`, `openCaptionsWindow` `:3292`;
  delete `auxWindowChromeOptions`; stop calling `watchAuxWindowGlass`)
- the addon crate (`set_window_appearance`, `NSAppearance` feature) and its TS
  loader:
  - Main resolves the addon once at startup as the in-process preview driver
    (`index.ts:1005-1015`, `resolveNativePreviewInProcessModule` /
    `loadNativePreviewPrimaryDriver`). Expose the new function from that same
    module.
  - When the driver kind is not `in-process` (helper-process fallback), the pin
    is unavailable. Report that in Health.
- new `components/window-frame.tsx`
- `comments/main.tsx`, `captions/main.tsx`
- `captions-reader.tsx`: fix the missing traffic-light gutter at `:52`, and
  make the glass caption plate at `:135` translucent without `backdrop-blur`
- `scripts/comments-window-probe.mjs`
- a new `window-glass-state { role }` smoke command that reports the applied
  material, backing, appearance, and `visualEffectState` from the registry

Done when:

- `probe:ui-glass --gate` passes for Chat and Captions while main is dark and
  while main is light (they stay dark).
- `probe:comments-window` passes, with the "underlay mounted" check replaced by
  `window-glass-state`. It still checks plan 047's header tiers at 320–900 px.
- `pnpm build:native-preview-addon` passes, and so do `cargo fmt --check --all`
  and `cargo clippy` for the addon crate.
- JS gates pass.

#### S4: Notes becomes a renderer window

Files:

- new `src/renderer/notes.html`, `src/renderer/notes/main.tsx`, and
  `components/notes-window.tsx` with its test
- `electron.vite.config.ts` (input `notes`)
- the renderer CSP policy, the same as `comments.html`
- `index.ts` (`openNotesWindow` `:2484` loads the entry the way Chat does;
  delete `notesWindowHtml` `:2240` and its inline script)

Parity checklist:

- word count
- debounced save, save on blur, flush on close (the
  `requestNotesWindowCloseFlush` handshake)
- font scale S/M/L (18/24/32 px) as a `ToggleGroup`
- keep-on-top pin
- the arrow cursor over the textarea: an I-beam over "empty" space would
  betray the hidden notes to viewers
- capture protection via `applyVideorcWindowCaptureProtection`, unchanged
- the red smoke-marker styling under `VIDEORC_NOTES_SMOKE_MARKER=1`
- dark-always

The preload API is unchanged. The new entry is not in `check:renderer-assets`,
which measures `index.html` eager JS only; note that in the PR.

Done when:

- Notes unit tests pass: render, save, and the flush handshake against a mocked
  preload.
- `pnpm smoke:notes-window-invisible` passes. If the host exposes no
  ScreenCaptureKit source, as in July, say so, run `notes-window-state`
  (expect `protected: true`), and have the owner record 10 s by hand.
- `probe:ui-glass` Notes passes.
- `git grep notesWindowHtml` is empty.

#### S5: the Preview frame on glass

Files:

- `window-glass.ts` (role `preview`, pinned dark)
- `index.ts` (`openPreviewWindow` `:3714`; `PREVIEW_WINDOW_HTML` `:3678` CSS
  generated from `window-tokens.ts`; sentence-case `Preview`; no grip; 28 px
  kept)
- `window-palette.ts` → `window-tokens.ts`, plus the parity test

Done when:

- `pnpm probe:preview-lifecycle`, `pnpm probe:preview-window`, and
  `pnpm smoke:preview-real-launch` pass. Run each on clean main first on the
  same machine: memory notes the lifecycle probe has failed on clean main here
  before, so parity with clean main is the bar.
- `probe:ui-glass` passes for the Preview strip and the waiting state.
- The video region is unchanged. By eye in floating and docked modes: no glass
  at the video edges, and in docked mode the strip is hidden.
- JS gates pass.

#### S6: delete the simulation

Delete:

- `glass-wallpaper.tsx`
- in `index.ts`: `currentWallpaperPath`, `refreshGlassWallpaper`,
  `glassGeometry`, `glassWindows`, `queueGlassGeometryBroadcast`,
  `watchAuxWindowGlass`, the `glass:wallpaper:get` IPC and both events, and the
  two env switches (keep the alias from D1)
- `preload/index.ts:181-183`, `api-policy.ts:39-51`
- `GlassWallpaperState` and its API types
- the underlay tokens and `.glass-shine`, plus its uses in
  `panel-section.tsx:34` and `studio/session-panel.tsx:31`
- `scripts/ui-glass-wallpaper-probe.mjs`
- `ui-glass-bisect-probe`, `ui-vibrancy-matrix`, `ui-vibrancy-frame-matrix`,
  and `ui-vibrancy-proof`, which `probe:ui-glass` supersedes. Keep
  `ui-vibrancy-reload-probe` and the palette wedge probes: they guard the
  wedge.

Update:

- `probe:preview-lifecycle` (drop `VIDEORC_GLASS_WALLPAPER=0`)
- the stale comments at `index.ts:1596-1640`, `:665`, `:752-757`, and
  `shared/backend.ts:3451`
- the SKILL.md Electron note
- a superseded note on `docs/ui-glass-redesign-acceptance.md`

Done when:

- `git grep -n -i "wallpaper\|glass-shine\|underlay" apps/desktop/src` returns
  only intentional hits, listed in the PR.
- No `osascript` / System Events call remains for glass.
- A fresh-profile run shows no Automation prompt (manual).
- `check:renderer-assets` reports the eager-JS delta, which should shrink.
- JS gates pass.

#### S7: reduced transparency, contrast, light theme, captured windows

Files:

- `styles.css` (media queries)
- `window-tokens.ts`
- `index.ts:12870` (off-mac theme colours from `window-tokens.ts`)
- `probe:ui-glass` (`--gate` joins `smoke:local-gates` next to
  `probe:comments-window`)

Steps:

1. Toggle Reduce Transparency and Increase Contrast in System Settings. All
   five windows must turn solid and stay readable. Record it in the acceptance
   doc.
2. Tune the light coats with the probe's contrast check over white and black
   backdrops.
3. Theme round trip (the `D` key): main flips, and the pinned windows stay
   dark.
4. Check fullscreen and minimize/restore visuals.
5. Captured windows: record 10 s with a display source that includes the Chat
   window, and 10 s with the Chat window as a WINDOW source. Inspect the
   artifacts (ffprobe plus a frame grab); the window region must not be
   black or garbage.
   - If the window source fails, implement the mitigation: when a Videorc
     window is the active window-capture source, main switches that window to
     `--glass-solid` for the capture's duration. Main knows the selected
     source's window id.

Done when:

- `probe:ui-glass --gate` passes both themes.
- The manual accessibility notes are recorded.
- The capture artifacts are checked (and the mitigation is tested, if needed).
- `smoke:local-gates` includes the probe.
- **Owner checkpoint 1:** all five windows, both themes, over the owner's own
  wallpaper, including a live session with Chat and Captions on stream.

### Phase 2: glass chips and the desktop language (`fable-5`; S8 `opus-4.8`)

#### S8: glass chips

Files:

- `ui/badge.tsx`, `status-badge.tsx`, `ui/kbd.tsx`, `status-dot.tsx`
- `styles.css` (chip tokens)
- the ad-hoc pills found by the audit: the sidebar `beta` badge (removed in
  S11 anyway), the destination `Idle` / `9:16` chips, the caption status dot,
  and every rounded + bordered `text-[10–12px]` span

Steps:

1. Implement D9 for both themes.
2. Map every variant: `default` → neutral glass, `secondary` → neutral,
   `outline` → tag, `success` / `warning` → status, `destructive` → emphasis.
3. Move the ad-hoc pills onto `Badge` / `StatusBadge`.

Done when:

- `renderToStaticMarkup` tests assert the chip classes per variant and tone,
  and that the text stays monochrome for the status tones.
- Region captures of Studio, Livestream, Health (15 StatusBadges), and the
  Chat header show only glass chips.
- The PR lists the audit.
- JS gates pass.
- Owner quick look against the mock.

#### S9: design language v2, the skill, tokens, and `ui/` defaults

Files:

- `.claude/skills/videorc-design/SKILL.md`: rewrite it around the window
  family, coats, desktop scale, ⌘K-only palette scale, glass chips, lists not
  cards, toolbars, status bar, native feel, and Windows
- `styles.css`: radius tiers 12 / 8 / 6, spacing tokens
- `components/ui`:
  - Button, Select trigger, and Input: 28 px default
  - `tabs`: becomes a glass segmented control and keeps the #392 fix
  - dropdown, select, and popover: 8–10 px radii
  - tooltip: small dark-glass popover
  - dialog: 12 px radius, `p-5`
  - `alert`: flush inline status row
  - `empty`: no dashed box
  - `slider`: token colours instead of `bg-white`

Done when:

- The owner reviews the skill text and a contact sheet of every `ui/`
  primitive in both themes.
- `ui` tests pass.
- `ui-theme-screens` shows no clipping from the size changes.

#### S10: pane primitives

Files:

- `panel-section.tsx`: becomes the flush section. No border, background,
  radius, shadow, or shine; a 13 px / 600 header, a 12 px description, a
  hairline between sections, 16 px padding. This covers 40 call sites.
- `page.tsx`: `PageHeader`, `ConfigGrid`, `Gallery`, and `PageStack` become a
  pane grid with hairline dividers; `Gallery` keeps cards.
- new `components/toolbar.tsx`, `components/pane.tsx` (`Pane` + `PaneBody`
  scroll container), and `components/status-bar.tsx`
- `list-row.tsx`: 32 px default, 28 px compact, and a `GroupedList`
- delete the unused `inspector.tsx`, `section-header.tsx`, and
  `live-chat-panel.tsx` after confirming no test imports them

Done when:

- Primitive tests pass.
- Every tab renders in both themes with no horizontal overflow at 960×660 and
  1440×900 (layout metrics via `eval-js`).
- JS gates pass.

#### S11: the main shell

Files:

- `app-shell.tsx`:
  - delete the 36 px strip and the page column
  - the content pane becomes `Pane` + `Toolbar` + `PaneBody`, with a per-tab
    actions slot through context; Library keeps its own scroll inside
    `PaneBody`
  - the Toaster offset moves above the status bar
- `sidebar.tsx`:
  - a 40 px top row with the 88 px gutter and the ⌘K button
  - delete the brand block and the gradient divider
  - 28 px rows and 11 px labels
  - the update chip becomes a quiet row
- `footer-action-bar.tsx` → `StatusBar`
- `window-glass.ts` (the main traffic lights stay at (14, 13), centred in the
  40 px row)

Done when:

- Every tab renders in the new shell (contact sheet).
- The shortcut tests pass unchanged: ⌘1–9, ⌘K, ⌘P, ⇧⌘N, ⇧⌘J, `D`.
- There are no double scrollbars.
- `perf-idle-probe` shows no change.
- **Owner checkpoint 2a:** the shell.

#### S12: Studio in v2, the flagship

Files:

- `tabs/studio-tab.tsx`
- `studio/*`: `quick-settings.tsx`, `session-panel.tsx`,
  `studio-dashboard-bottom-row.tsx`
- `preview-stage.tsx`:
  - literals at `:209`, `:224`, and `:225` become tokens
  - `rounded-panel` becomes 12 px
  - the dashed "live in its own window" box becomes a quiet empty state

Direction:

- Record, Stream, and the timer sit at the top of the Studio inspector, right
  above Session (owner call, 2026-09-23; the first cut put them in the
  toolbar's top-right corner). Space still records.
- The preview pane leads.
- The inputs (source, mic, layout, output, captions) become a grouped
  inspector.
- Scenes are thumbnail cards.
- The audio mixer is a pane section.
- Rebase on plans 043, 044, and 046 first.

Done when:

- Captures are reviewed in both themes, with the preview floating and docked,
  idle, recording, and live.
- `pnpm smoke:record-latency:gate` passes (Record now lives in a toolbar).
- `probe:preview-window` and `probe:preview-lifecycle` pass: the docked slot
  geometry changes with the layout.
- **Owner checkpoint 2b, "this is the look":** Phase 3 starts only after it.

### Phase 3: every screen and surface (`opus-4.8`)

Each slice meets the same bar:

- captures of the touched screens in both themes (contact sheet in the PR)
- no horizontal overflow at 960×660
- the screen's existing tests
- JS gates
- no new `rounded-panel` or `shadow-*` inside a window

#### S13: Livestream (`streaming-tab.tsx`, 2,193 lines)

- Destinations become one `GroupedList`: platform icon, name, account, switch,
  `9:16` tag, and state chip.
- Setup / Upcoming becomes a segmented control in the toolbar.
- Live output health becomes sections with an inline stat grid (no nested
  cards). The mono values stop wrapping mid-word.
- The warnings become an inline callout row, replacing the large amber card.
- The platform tint literals at `:923-927` become tokens.

#### S14: Sources, Scene, Assets

- Sources: the `ConfigGrid` wells become grouped rows.
- Scene (`layout-tab.tsx`): `SceneStage` `rounded-panel bg-card/40` becomes a
  flush stage pane with the inspector beside it.
- Assets: the `h1` moves into the toolbar; the tiles keep cards.
- Rebase on plans 043 and 044.

#### S15: Output (`recording-tab.tsx`) and the Captions tab

- The caption preview's video-backdrop gradients stay, because they show
  content, but become named constants.
- The `captions-controls` literals at `:135-146` become tokens.

#### S16: Library and Publish (`ai-tab.tsx`)

- Library: the table panel becomes a flush table inside `PaneBody`.
- Publish: the 3 panels and 8 nested boxes become sections and grouped rows,
  with no `calc(100vh-…)` heights.

#### S17: Settings and Health

- Settings: the 11 panels become grouped settings rows, like macOS System
  Settings.
- Health: 7 sections, 15 status chips, and log panes without card chrome.

#### S18: floating surfaces

Every dialog (onboarding/permissions, What's New, Go Live, confirmations), the
⌘K palette (which keeps palette scale), menus, selects, popovers, tooltips,
toasts, empty states, the error boundary, and the `phone-remote-section`
literals.

#### S19: the Chat and Captions window bodies

- Comment rows.
- The Orcle pane: `bg-card/30` becomes flush.
- The composer becomes a 12 px card.
- The `N new` pill becomes a glass chip.
- Caption lines sit on glass.
- The plan 047 container-query tiers stay intact: `probe:comments-window` must
  pass at 320–900 px.

### Phase 4: native feel (`opus-4.8`)

#### S20: interaction details and guards

- Implement D6, and remove the 6 `cursor-pointer` uses.
- Add a guard test (`renderer-style-guards.test.ts`) that scans
  `apps/desktop/src/renderer` and fails on:
  - `backdrop-blur` / `backdrop-filter`
  - `cursor-pointer`
  - colour literals outside a short allowlist: brand/platform tints and
    content previews, named in the test

Done when:

- The guard tests pass.
- The manual native-feel checklist is recorded in the PR: selection, context
  menu, overscroll, scrollbars, tooltips, and image drag in every window.
- JS gates pass.

### Phase 5: Windows (`fable-5`)

#### S21: Mica on Windows 11, solid on Windows 10

Files:

- `window-glass.ts` (Windows branch, gated on build ≥ 22621)
- `styles.css` (a `[data-platform=win32]` coat block)
- `index.ts` (unchanged proof-surface and D3D11 paths)

Verify on the physical Windows 11 box:

- every window in both themes, and readability
- `smoke-windows-stream-performance` on a low-end iGPU machine if available
- preview presenter health unchanged
- `smoke-windows-native-screen-app` passes

Force the fallback with `VIDEORC_GLASS=0` to check the solid path.

Done when:

- Windows acceptance notes with box screenshots are recorded.
- Windows CI is green.
- The AGENTS.md Windows async/process rules are followed if any process code
  moves (none expected).

### Phase 6: acceptance (`fable-5`, Review route)

#### S22: the full matrix

- Run every verification gate below.
- Owner by-eye checklist:
  - every window, in both themes
  - focused and unfocused
  - fullscreen
  - the owner's wallpaper and a bright wallpaper
  - a recording and a live session with Chat and Captions on stream
  - Reduce Transparency and Increase Contrast
- Write `docs/acceptance/<date>-real-glass.md`.
- Add a changelog entry for the next release.
- Final pass on the skill and memory.

## Verification

- Every slice:
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
  - `pnpm --filter @videorc/desktop test` (arm64 node first on PATH)
  - `pnpm build`
  - `pnpm check:renderer-assets`: the eager-JS budget has had almost no
    headroom (about 29 bytes at #389). Report the delta, never raise the budget
    silently; S6 frees room.
- Glass: `pnpm probe:ui-glass` (report mode S1–S6, `--gate` from S7).
- Chat: `pnpm probe:comments-window`. Build the debug backend first (known
  trap).
- Preview (S5, S12): `pnpm probe:preview-lifecycle`, `pnpm probe:preview-window`,
  `pnpm smoke:preview-real-launch`, each compared with clean main on the same
  machine.
- Notes (S4): `pnpm smoke:notes-window-invisible`, or the documented fallback.
- Perf (S2, S3, S6, S11, S22): `perf-idle-probe` plus the WindowServer sample,
  against the recorded baseline.
- Wedge (S2, S18): `ui-vibrancy-reload-probe`, `ui-palette-wedge-probe`,
  dialog/toast open.
- Record path (S12): `pnpm smoke:record-latency:gate`.
- Addon (S3): `pnpm build:native-preview-addon`, `cargo fmt --check --all`, and
  clippy on the addon crate.
- Recording studio (S5, S12): `pnpm smoke:recording-studio`, per AGENTS.md,
  because both touch the preview. If a device smoke is blocked on this host,
  run its preview-reliability smokes and record why. Recording, capture,
  encoding and audio code is otherwise untouched. The S7 capture check is the
  media-facing proof for the glass windows themselves.

## Risks

1. **The June compositor wedge returns.** Mitigation: no `backdrop-filter`
   anywhere (S2 removes it, S20 guards it), the backing choice in S2, and the
   wedge probes. Rollback: `VIDEORC_GLASS=0`, or flip the default in one line.
2. **WindowServer or GPU cost.** It is measured in S2 and on every structural
   slice. Real vibrancy is composited by the OS, and deleting the 70 px
   full-display CSS blur should lower renderer cost.
3. **Window-source capture of a glass window looks flat or black.** S7 checks
   it and adds the per-capture solid mitigation only if needed.
4. **An opaque light canvas.** Fixed in S2 and asserted by the probe.
5. **Preview video layering.** The Metal layer sits at `zPosition 10000` above
   the vibrancy view. S5 runs every preview probe.
6. **Notes invisibility regressions.** The port keeps the same
   `setContentProtection` call; S4 runs the invisibility gate.
7. **In-flight Studio and Scene work** (plans 043, 044, 046). S12 and S14
   rebase or coordinate.
8. **Taste risk.** The owner checkpoints gate the spread (1 after the
   material, 2a after the shell, 2b after Studio), before any screen converts.
9. **Future macOS or Electron changes** to materials are isolated in
   `window-glass.ts`.

## Out of scope

- The Phone remote web UI, the Stream Deck plugin, the website, Linux.
- `NSGlassEffectView` (Liquid Glass) until Electron exposes it.
- A frameless custom Windows title bar (Mica uses the native frame).
- Private window-server APIs, such as `CGSSetWindowBackgroundBlurRadius`: the
  public material works.
- Functional changes to recording, streaming, capture, or audio.
- New fonts, component libraries, or icon packages.
- Copy changes beyond labels that move into toolbars.

## Handoff

- **Goal:** real macOS glass under every Videorc window, one window family,
  glass chips, and a desktop-scale structure on every screen, so the app reads
  as a native Mac app rather than a website.
- **Current state:** nothing is implemented. The evidence and inventory are
  above; the investigation captures are in the 2026-09-23 session scratchpad
  (not committed), and S1 regenerates them.
- **Route / model / fit:** Orchestrator plus UI/Product Design, fit 9.
  `fable-5` for phases 1, 2, 5, and 6; `opus-4.8` for S8 and phases 3–4.
- **Order:**
  - S1 → S2 → S3 → S4 → S5 → S6 → S7 → owner checkpoint 1.
  - S8 may start any time after S3, once chips have real glass under them.
  - S9 → S10 → S11 → checkpoint 2a → S12 → checkpoint 2b.
  - S13–S19 in any order after 2b. S20 after Phase 3. S21 needs the Windows
    box. S22 last.
- **Blockers:**
  - Probes need a logged-in macOS GUI session, and Screen Recording permission
    for the terminal that runs them (for `screencapture -R`).
  - `smoke:notes-window-invisible` needs a ScreenCaptureKit source (blocked
    before on this host).
  - Phase 5 needs the physical Windows 11 box.
  - The Rust addon build needs the pinned toolchain.
