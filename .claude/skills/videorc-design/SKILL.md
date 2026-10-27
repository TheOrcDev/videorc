---
name: videorc-design
description: Videorc's UI design language — a desktop app on its own opaque Liquid Chrome ground, built exclusively from shadcn/ui components and Videorc's shared primitives: flush panes, toolbars, grouped lists, glass chips, polished chrome controls, and a Raycast-style ⌘K palette. Use whenever building, styling, reviewing, or planning ANY Videorc UI (new components, screens, dialogs, lists, toolbars, badges, confirmations, empty or locked states), when the user mentions "our design", "the design skill", "glass", "chrome", "Liquid Chrome", "native look", or asks how something should look.
---

# Videorc Design Language (v2: the window family)

The single source of truth for how Videorc looks and feels. Every UI task
follows this skill. Videorc is a desktop app, not a web page: every window
sits on Videorc's own Liquid Chrome ground, panes are flush and split by
hairlines, controls are desktop-sized, and colour is information. The
reference is the Welcome screen's Liquid Chrome and the Videorc logo: black
metal with soft silver streaks, polished chrome on the controls you touch,
and one LED-red accent. Light mode is the same chrome turned the other way
around: porcelain with graphite streaks and black-chrome controls.

The words on these surfaces are not in this file. How to write them is
[`docs/ui-copy.md`](../../../docs/ui-copy.md) (voice, casing, ellipsis,
toasts, errors, disabled and locked copy), and the one name for each thing is
the glossary in [`CONTEXT.md`](../../../CONTEXT.md).

**Status: shipped in plan 050 (2026-09-23); Liquid Chrome since plan 208
(2026-10-27).** `styles.css` implements the tokens below.
`src/main/window-glass.ts` gives every window (main, Stream Manager,
Captions, Notes, Preview) its material and title bar, and
`components/chrome-ground.tsx` paints the ground under it. The Preview
frame's data-URL document and every window's opaque base mirror the solids
through `src/main/window-palette.ts`, and a parity test fails when they
drift. Fix tokens and primitives, never restyle a screen ad hoc. Plan 174
(the UI/UX pass, 2026-10) gave every job one shared primitive
([Primitives](#primitives)) and added the guards that hold them.

## Hard rules

1. **shadcn/ui only.** Every element is a shadcn/ui component or a composition
   of them, installed and customized per the `shadcn` skill. No other
   component libraries and no hand-rolled widgets when a primitive exists.
   audiocn (the owner's shadcn audio registry, `@audiocn`) counts as shadcn:
   its meters draw audio, fed by Videorc adapters, never by its
   Web Audio hooks or blocks. Base UI enters only inside its files
   (`docs/audiocn.md`).
2. **Videorc's own ground, never the desktop and never fake blur.** Every
   window is opaque and sits on the chrome ground, and the only image under
   the UI is `ChromeGround`'s (a guard fails if anything else imports its
   stills). The frost is baked into that still, so there is no CSS
   `backdrop-filter` / `backdrop-blur` anywhere in the renderer: it wedged
   the compositor in June, and on a vibrancy window it never reaches the
   screen (Chromium's own capture shows the blur, the display does not; plan
   072). A guard test fails on it. No wallpaper underlays, no desktop showing
   through, no inline `color-scheme` on the root.
3. **Dark first, light supported.** Dark is the reference. Light is the same
   structure with the light token column, never a separately designed theme:
   its chrome is the dark chrome inverted.
4. **Colour is information.** Chrome is monochrome. Saturated colour appears
   only in source/platform icons, status dots, emphasis chips and the Record
   LED: red for record, live, and destructive; green for healthy; amber for
   attention.
   Never tint panels, rows, or text decoratively, and never colour a status
   word: the tone rides on an icon, a dot, a chip or an Alert.
5. **Keyboard-first, quietly.** Primary actions show their shortcut as a key
   chip. Global hints live in the status bar, not on every surface.
6. **One primitive per job.** Confirmations, locks, disabled reasons,
   shortcuts, device pickers, status words, numbers and times each have one
   shared primitive or helper ([Primitives](#primitives)). Use it. If it
   lacks something, extend it minimally; never hand-roll a competing one.

## Owner calls

Binding. Follow them as written; a change that would undo one is a question
for the owner, not a design choice.

- **Videorc is Liquid Chrome** (2026-10-27, plan 208). The owner asked for
  the Welcome screen's colours everywhere: metallic black with its shine,
  and the other way around in light mode.
  - **An opaque chrome ground behind every window** (D1): a frosted still of
    Liquid Chrome under the coats, the same on macOS, Windows and Linux. The
    desktop never shows through: asked whether it should stay a little
    transparent, the owner chose solid.
  - **Shine on the controls and edges only** (D2): primary buttons, switch
    and slider beads, selected plates, chips and keys. Panels, menus,
    dialogs, toasts and text stay flat. No gradient text, no sheen on the
    toolbar or the panes.
  - **Light is the crisp invert** (D3): the dark chrome's pixels turned
    around, white liquid with black reflections and black-chrome controls.
    No separate light look.
  - **Nothing moves outside the Welcome screen** (D5): the ground is a
    still, so it costs nothing while you record or stream.
  - **Record and Stop are a red LED** (D8): the `record` Button, unlit at
    idle and lit while a recording or livestream runs. Go Live… is the
    chrome primary. Delete, Remove and every other destructive action keep
    the quiet `destructive` tint, so a lit LED only ever means record or
    live.
- **First-run setup paints Liquid Chrome** (2026-10-27, plans 203 and 208).
  The Welcome screen is the only place outside a scene where a live
  background runs, and the only place the chrome moves: Liquid Chrome,
  Polished, Normal motion, edge to edge. Under dark the shader dims it.
  Under light it is inverted (white liquid, black reflections) with no dim,
  and a CSS brightness of 0.85 after the invert only under Increase
  Contrast. Setup sits in one centred card on the dialog tier. The backdrop
  is opaque and covers the chrome ground, which is not drawn while setup is
  open; it is decoration and never carries text. Every other window rule
  stands.
- **The toolbar holds only the page title** (2026-09-23). Record and Go
  Live… sit at the top of the Studio inspector, and a page's own actions sit
  in its body.
- **Buddy stays second in the sidebar, directly under Studio, on ⌘9**
  (2026-10-10, plan 174 D6 and D8). It keeps Clean cut and every other
  feature, because the page sells Premium. Never move it or a feature out of
  it.
- **A click on a live chat row puts the message on stream**, and a click on
  the live row takes it off (2026-10-10, D10; plans 055 and 151). There is no
  select-first step and no separate Show button.
- **Chat stays on the newest message** (2026-10-21). Newest at the bottom,
  and the list follows it. Only the streamer's own scroll up (wheel, touch,
  keys, the scrollbar) stops it; nothing the app does moves it: Buddy's
  "Talking about this" marks a row and never scrolls to it, and rows that
  grow, highlights and removals keep it on the newest message
  (`hooks/use-chat-follow.ts`). While it is stopped, one chip ("12 new", or
  "Latest") goes back.
- **Toasts are never tinted** (2026-09-29). A toast's type colours its icon
  only, never the panel, its rim or its text.
- **No success toast for a scene, layout or source change** (2026-07-16):
  the stage is the confirmation.
- **The platform mark closes a chat or Activity row on the far right**, at
  20 px, with YouTube's official icon (plan 165).
- **The Stream Manager's live chip reads ON AIR** (2026-09-24), the
  broadcast convention. Everywhere else the state is "On air".
- **On macOS the brand lives in About and the Dock**, never in the sidebar
  (2026-09-23).
- **The Buddy mark is the real artwork**, never a redrawn glyph (2026-10-04;
  see [Icons](#icons)).
- **The Studio has one Audio section** (2026-10-26, plan 201 D1).
  Microphone and System audio share one audiocn Mixer scale, each with its
  level and Gain. The System audio switch lives here; the Sources mirror
  keeps Screen and Camera. This replaces the 2026-10-02 call, "Studio keeps
  the Microphone section, no mixer" (plans 092 and 093).
- **Retro LCD is an option, off by default** (2026-10-25, plan 197). Settings
  → General → Appearance → Retro LCD draws the Studio inspector on audiocn
  LCD screens (`components/lcd-panel.tsx`, `studio/retro-lcd-studio.tsx`)
  and every level meter as the LCD meter. Off, the Studio and its meters are
  this skill's rows, buttons and the segmented bar. A Studio change lands in
  both looks; neither replaces the other.

## The window family

Every window uses one material and one title-bar recipe (`window-glass.ts`):

- **Material: the chrome ground** (plan 208, D1). Every window is opaque on
  every platform: no vibrancy, no Mica, and a `backgroundColor` of the
  theme's solid base, so the first paint is already the theme's tone.
  - Main hands each window its ground on its argv
    (`shared/window-ground.ts`), and the theme bootstrap writes
    `data-ground="chrome|glass|solid"` on the root before the first paint.
  - `ChromeGround` (mounted once per window by `WindowProviders`;
    `aria-hidden`, no pointer events, `position: fixed`, the lowest layer)
    paints the theme's still: Liquid Chrome Polished at 1280 × 720 under a
    σ 24 blur, black with silver streaks in dark and its invert in light
    (`assets/backgrounds/chrome-ground-{dark,light}.webp`, imported with
    `?no-inline`). Nothing else draws it.
  - It is sized to the display and centred on it (D11): a resize shows more
    or less chrome and never rescales it.
  - Both stills stay mounted and the `.dark` class picks one, so a theme
    toggle never shows a frame of the other theme's ground.
  - No CSS filter, transition or animation on it, and it is not drawn while
    first-run setup is open.
  - `VIDEORC_GLASS=0` paints the plain solid palette with no ground.
    `VIDEORC_GLASS=clear` brings back plan 091's clear glass (macOS
    vibrancy stripped by the native addon) and Windows Mica, without the
    ground, as the A/B control and escape hatch for one release (D9). A
    follow-up deletes it.
- **Title bar.** `titleBarStyle: 'hiddenInset'`. Traffic lights are centred
  in the header row, which is 40 px (28 px for Preview). A header row shares
  its line with the lights: on macOS it pads `pl-[88px]`
  (`TRAFFIC_LIGHT_GUTTER_CLASS`, through `useTrafficLightGutter()` in
  `components/window-frame.tsx`), **in native fullscreen too**. macOS draws
  the lights over the header when the title bar reveals on hover, and a
  window filling the screen keeps them showing; dropping the gutter there put
  the lights on the Stream Manager title (2026-09-25). Off macOS the native
  frame owns the title bar and the row pads `pl-3`. Header rows are drag
  regions, and their controls opt out with `[-webkit-app-region:no-drag]`.
- **Single-pane windows** (Stream Manager, Notes, the Captions reader) wrap
  their body in `WindowFrame` and lead with one `WindowHeader`: the title as
  the window's `h1` (14 px / 600), an optional quiet `meta` fact after it,
  and the window's few controls trailing. Stream Manager keeps its row to the
  title.
- **One dark-always window.** The Preview frames video, and a pattern
  around a picture competes with it, so it takes no ground: it paints the
  solid dark base whatever the app theme (D7), and a light main window never
  lightens it. Under the clear glass, main pins its NSWindow appearance to
  `darkAqua` through the native addon and falls back to solid dark without
  the pin. Stream Manager, Captions and Notes get the ground and follow the
  app theme like main (#412). The docked preview's slot keeps its solid
  `--video-ground`.
- **Covers.** One cover per region (plan 208, D10; the derivation is plan
  091's): how much of the solid tone a region paints over the ground. The
  sidebar covers 88% (dark) · 92% (light), the work area 82% · 86%, the
  same on every platform: the sidebar is the heavier, more covered region,
  and the work area shows more chrome.
  - The coats are derived from the covers (D4), never set by hand: `body`
    paints the lighter cover (`--glass-window`, and `ChromeGround` repeats
    it over the still), the sidebar `<aside>` adds its delta
    (`bg-glass-sidebar`), content panes add theirs (`bg-glass-content`, 0),
    so each region composites to exactly its cover.
  - Single-pane windows wrap their body in `WindowFrame`.
  - Never stack a third coat.
  - Contrast is a test, not a by-eye call: `chrome-ground-contrast.test.ts`
    composites each coat over the ground's extreme pixels
    (`chrome-ground.stats.json`) the way Chromium blends, and fails if
    `--foreground` drops under 7:1, `--muted-foreground` under 4.5:1 or
    `--subtle` under 3:1. The floors it derives are about 0.78 (dark) and
    0.83 (light). The owner's by-eye may lower a cover toward its floor to
    show more chrome, never past it; past that, the lever is the still's
    tone.
- **Providers.** Each window is its own React root and wraps its tree in
  `<WindowProviders window="main|stream-manager|captions|notes">`: the
  `ChromeGround` under everything, one TooltipProvider (600 ms, the desktop
  delay) and one Toaster, inset above that window's status bar.
- **Accessibility** (D12). `prefers-reduced-transparency` hides the ground,
  swaps the window coat for `--glass-solid` and drops the region coats; a
  media query, so a runtime change applies at once. `prefers-contrast: more`
  puts both covers at 95% and strengthens hairlines, chip rims, the chrome
  controls' edge, and the secondary and tertiary text tiers. Under both, the
  chrome controls keep their gradients: they are opaque.
- **Proof.** `pnpm probe:ui-glass --gate --surfaces` (in
  `smoke:local-gates`) checks every window in both themes over stand-in
  desktops (plan 208 S3):
  - the window is opaque: no vibrancy effect view, and changing the desktop
    behind it changes no pixel of its text-free samples;
  - `ChromeGround` is mounted and showing the theme's still;
  - the captured text tiers meet the contrast test's ratios over the
    worst ground pixel;
  - the Preview stays solid dark;
  - each float tier reads its own token;
  - under `VIDEORC_GLASS=clear` only, plan 091's checks instead:
    transmission, sharpness, neutrality, `nativeClear` and `ghostexParity`.

## Tokens

Implemented as shadcn CSS variables in
`apps/desktop/src/renderer/src/styles.css` (oklch; that file is the live
source). Values below are dark · light.

Coats and surfaces

- Every neutral is chroma 0 (plan 208): the old faint blue cast (hue 286)
  is gone from the solids, text, hairlines, floats and `--video-ground`.
- Base `--glass-base`: black `0.13 0 0` (`#070707`, the chrome's own black)
  · porcelain `0.985 0 0` (`#FAFAFA`), the OKLCH components every coat is
  cut from. Solid `--glass-solid` is that base, opaque.
- Covers `--glass-cover-sidebar` / `--glass-cover-work`: 0.88 / 0.82 ·
  0.92 / 0.86, the same on every platform (0.95 / 0.95 under Increase
  Contrast). The coats `--glass-window`, `--glass-sidebar` and
  `--glass-content` are derived from them in `styles.css`.
- The ground is `ChromeGround`'s still, never a token and never used
  anywhere else ([The window family](#the-window-family)).
- Floating glass, three flat opaque tiers of the solid (plan 091, D6,
  Ghostex's web-modal recipe; kept flat by plan 208, D2), each a 1 px rim
  (white 10% · black 10%) and a drop shadow, no sheen and no highlight:
  - popup `--glass-float` (menus, selects, popovers, hover cards, chart
    tooltips, toasts): black about `#1D1D1D` (the solid plus 6% then 3%
    white, `color-mix` in sRGB) · porcelain `oklch(0.99 0 0)`;
  - dialog `--glass-float-dialog` (dialogs, the palette, the error panel):
    black about `#161616` · porcelain;
  - tooltip `--glass-float-tooltip`: the black solid · porcelain;
  - drops: `--glass-float-drop` (popups and tooltips) is `0 14px 44px` black
    50% and `0 1px 3px` black 30% · `0 12px 36px` black 14% and `0 1px 3px`
    black 8%. `--glass-float-dialog-drop` is the same in dark and deeper in
    light, `0 16px 48px` black 20% and `0 1px 10px` black 14%, so a
    porcelain dialog separates from white chrome (the Welcome card sits on
    the backdrop with no overlay);
  - opaque: without a frost, even 3% translucency lets white text under a
    menu read through. Each is a fixed tone whatever is behind it:
    `probe:ui-glass --surfaces` checks each tier reads its own token.
- Inset `bg-inset`: foreground 3%, for a well inside a section (a preview
  frame, a code line). Never a card.

Text (three tiers, nothing else)

- Primary `text-foreground`: titles and labels, weight 500–600. 0.97
  (`#F5F5F5`) · 0.17 (`#0F0F0F`).
- Secondary `text-muted-foreground`: inline context, metadata, placeholders,
  descriptions, and every fact the streamer needs. 0.71 (`#A1A1A1`) · 0.47
  (`#5B5B5B`); 0.8 · 0.38 under Increase Contrast.
- Tertiary `text-subtle`: section labels, quiet hints, disabled.
  **Essential information never uses `text-subtle`** (plan 174 D12): a
  reason, a limit, a status, a value or a rule a streamer needs is secondary
  or primary. `--subtle` passes AA on the solid (0.62 `#868686` dark · 0.54
  `#6F6F6F` light) and rises under `prefers-contrast: more` (0.68 · 0.45).
  Over the ground's worst pixel it holds only 3:1 (the contrast test): it is
  still the faintest tier.
- Sizes are tokens: `text-label` 11 px / 600 (section labels,
  `SectionLabel`), `text-section` 13 px / 600 (section headers), `text-meta`
  12 px (descriptions and metadata). **No text below 11 px** (a guard fails
  on `text-[9px]` and `text-[10px]`).

Hairlines and selection

- Hairlines `border-border`: white 10% · black 12%, always 1 px.
- Hover/selected row `bg-accent`: white 8% · black 6%, a full-row block with
  no outline. Pressed `bg-accent-pressed`: 12% · 10%. The page you're on in
  the sidebar, an active segment, tab or toggle, and a selected `MediaCard`
  wear the chrome plate instead ([Chrome materials](#chrome-materials));
  hover stays the flat block, so rows highlight instantly.
- Focus-visible: a 2–3 px ring, keyboard only. It composes with the chrome
  materials' light and shade.

Colour

- `--live` / `--destructive`: the logo's LED red. Record (the LED), on air,
  failed, destructive. Never decoration.
- `--success`: healthy or connected. `--warning`: needs attention.
  `--info`: rare.
- `--member`: a muted violet for paid membership (YouTube member, Twitch,
  Kick or X subscriber). It paints only the member row tint in chat
  (plan 154); never a chip tone, never text.
- `--reward`: a muted teal for Twitch channel point rewards. It paints only
  the reward row tint in Activity (`bg-reward/8`, plan 177); never a chip
  tone, never text.
- Use them through the tone utilities (`tone-success`, `tone-warning`,
  `tone-destructive`, `tone-live`, `tone-neutral`) and the chip utilities.
  Never as text colour on status copy: the status colour guard fails on a
  coloured status word.

## Desktop scale

Everything except ⌘K uses the desktop scale.

- **Layout.** There is no page column: content fills its pane edge to edge
  with a 16 px gutter. Panes are flush and split by 1 px hairlines. Inside a
  window there are no floating panels, no shadows (beyond a chrome
  control's own light and shade), and no big cards.
- **Toolbar** (`Toolbar`, 40 px): the page title (14 px / 600, the window's
  `h1`) on the window's drag band, and nothing else (owner call,
  2026-09-23). Actions live with the content they act on. The Studio's
  Record, Go Live… and the stop button ("Stop recording", or "End
  livestream" while on air) and its clock sit at the top of the inspector,
  right above Session; a page's own actions sit in its body (a filter bar, a
  section header, or the PageHeader row). The toolbar never scrolls; only
  `PaneBody` does.
- **Sidebar** (plan 174 D8).
  - The top row holds the traffic lights and the ⌘K button.
  - Studio leads, with a live dot and the clock while a recording or
    livestream runs. Buddy sits directly under it on ⌘9 (owner call).
  - "Setup" labels the pages you configure between sessions: Sources ⌘2,
    Scene ⌘3, Assets ⌘4, Livestream ⌘5, Captions ⌘6, Output ⌘7. Library ⌘8
    follows under no label: a group of one row carries none.
  - Settings (⌘,) sits in a bottom block above the account row. Health has
    no row: the status bar's state is its door (D9).
  - Section labels are `SectionLabel` (11 px / 600, tertiary). Rows are
    28 px, with 14 px text and 16 px icons.
  - On Windows the native title bar carries the app's name, so the sidebar
    shows no mark (D18).
- **Status bar** (`StatusBar`, 26 px in the main window): the session state
  on the left, as a button that opens Health ("● On air 12:04",
  `StatusBarSessionState`). On the right, quiet 11 px shortcut hints
  (`StatusBarHint`), each still clickable and pressed while its window is
  open: ⌘K Search, ⌘P Preview, ⇧⌘N Notes, ⇧⌘J Stream Manager. Every
  clickable thing in a status bar is a `StatusBarHint` or a
  `StatusBarAction` (20 px, 11 px tertiary text that brightens on hover).
- **Sections** (`PanelSection`): flush. A 13 px / 600 header (an `h2`; a
  nested section passes `headingLevel={3}`), a 12 px secondary description,
  a hairline between sections, and 16 px padding. No border, background,
  radius, or shadow.
- **Pages with tabs** (Settings, plan 064; Buddy, plan 150; Livestream,
  plan 174): `PageTabs`, one segmented `TabsList` in a `PaneStrip` pinned
  under the toolbar (`border-b px-gutter py-2`). Only the region under it
  scrolls: the page spreads `PANE_OWNS_SCROLL`, so `PaneBody` stops
  scrolling for it. The last tab used is remembered on this device, deep
  links open a named tab (`openWorkspaceTab(tab, subTab?)`), and ⌘K lists
  every tab. A filter bar pinned under the toolbar is a `PaneStrip` too.
  - Each tab answers one question.
  - A tab body is a `ConfigGrid` of two sections with `CONFIG_GRID_PAIR`,
    or a `PageStack` for one.
  - Settings rows are `SettingsRow` (`label`, `description`, `error`, the
    control as its child) in a `FieldGroup variant="grouped"`: label and
    12 px description on the left, the control on the right.
  - **Locked means disabled, with one reason.** One `LockAlert` (or
    `SessionLockAlert` while recording or live, `OfflineAlert` while
    Videorc reconnects) with its one action leads the tab, and every control
    under it is disabled. Never put an enabled-looking switch or button
    beside "isn't available". A Premium feature stays on screen behind its
    lock, never hidden: the locked page is what sells it.
  - Rules a streamer needs (limits, Premium versus free) go in the section's
    description, never in `text-subtle` footnotes.
- **Lists, not card stacks.** Sets of like things (destinations, sources,
  devices, settings) are one `GroupedList` of `ListRow`s: 32 px rows (28 px
  compact) with hairline separators. A row is a fact unless it says
  otherwise: `interactive` adds the hover, `as="button"` makes the whole row
  one button, and a row that holds its own controls stretches a
  `ListRowButton` over itself. A fact row that jumps to the page owning its
  value is a `NavigableRow` (icon, label, value, chevron).
  Cards remain only for objects with a picture (scene thumbnails, takeovers,
  Buddies, library items): `MediaCard`, 8 px radius, white 4% fill, a 1 px
  hairline, no shadow; `selected` is a brighter rim on the chrome plate,
  never a colour.
  Sources (plan 173) is the reference for rows that carry controls: one
  `SourceItem` per source (`components/sources/source-item.tsx`), a header
  row (icon, title, one status chip, one quick control, More), a body
  indented to the title, and the rare settings folded into More.
- **Overflow menus.** Low-frequency per-item actions go in one `KebabMenu`
  (⋯): items grouped with a hairline between groups, destructive items last,
  each item's keys right-aligned, a spinner while an item's work runs.
  `reveal="hover"` hides the trigger until its row (`group/kebab-host`) is
  hovered or focused.
- **Radii.** Tiers only, never ad-hoc radius values per screen:
  - `rounded-panel`: 12 px. Containers and dialogs.
  - `rounded-row`: 8 px. Rows and cards.
  - `rounded-chip`: 6 px. Controls and key chips.
  - `rounded-tag`: 7 px. Tags. Status chips are round.
  - Floating surfaces add the popup tier (`rounded-lg`, 10 px; see
    Floating surfaces). Nothing else: no `rounded-sm`/`md`/`xl` or
    `rounded-[Npx]` in chrome (a guard checks).
  - Window corners belong to the OS.
- **Controls.** The default height is 28 px for Button, Toggle, Select
  trigger, and Input. Retune it once in `components/ui`, never per screen: no
  `h-*` or `size-*` on a control at its call site (a guard checks).
  - **One compact size** (plan 174 S4.1, J1-11): `xs`, 24 px. Button `xs`
    and `icon-xs`, Toggle and ToggleGroup `xs`, SelectTrigger `xs`
    (SegmentedControl `sm` is the same 24 px). Use it only where the control
    sits inside something denser than a page: an Alert's action; a row's
    trailing or hover actions (`ListRow`, `SourceItem`, chat, activity,
    transcript and marker rows); a card's actions (`MediaCard`, the Buddy and
    Stream Manager cards); the Stream Manager's panes and status bar; a
    small inline action under a field (Reset, Calibrate).
  - A page's or a dialog's own actions stay 28 px, and so does a control
    beside a 28 px control in the same row.
  - There is no `sm` or `icon-sm`: both were 28 px under another name.
    Badge has one size (20 px). Switch's `sm` is a 16 px track, not a
    control height.
- **One control per kind of choice** (plan 174 S1.7, D13). Each wears one
  look:
  - Choosing one of 2–4 exclusive values: `SegmentedControl`
    (`ui/segmented-control.tsx`), the glass Tabs track with no Radix, a
    radio group with arrow keys. Its Field label names it; disabled, it says
    why (`disabledReason`).
  - Switching a view (a page or a pane): `Tabs`.
  - Filter chips (several on at once, or a filter row): `ToggleGroup`, only
    for multi-select filters.
  - A boolean: `Switch`, never an On/Off or Yes/No pair.
  - A one-shot action: `Button`, never a toggle that stays pressed.
  - A screen, camera or microphone: `DevicePicker`, the one device picker
    (plan 174 S1.9). The camera's and microphone's empty choice is "Off".
- **Type.** The system stack (SF Pro). Body 14 px, metadata 12 px, section
  labels 11 px. Density comes from structure, not from smaller text.

## Where things live

One home per control (`docs/ux-ia-refactor-plan.md`). Anywhere else a
control appears, it is a mirror that edits the same state or a summary that
links home.

- **Devices**: Sources is the home of every screen, window, camera,
  microphone and system audio source, with its gain and level. The Studio
  inspector mirrors the few needed mid-session: the Sources section (Screen,
  Camera, with Open Sources) and the Audio section: Microphone (picker,
  level, Gain, mute and its hotkey) and System audio (switch, level, Gain),
  on one audiocn Mixer scale (plan 201 D1).
- **Takeovers**: Assets → Takeovers manages them (import, rename, reorder,
  delete). Studio's Takeover section puts one on stream and takes it off.
- **Scenes**: the Scene page edits a scene; Studio's Scenes gallery switches
  between them.
- **The local file**: Output ("Where recordings go", quality). Recordings
  themselves live in Library.
- **Buddy**: the Buddy page (Profile, Chat, Voice, Reports, Clean cut)
  creates and sets Buddy up; the Stream Manager's Buddy pane operates it
  live.
- **Chat**: the Stream Manager is the full chat (filters, search, the
  composer, ⋯ actions, removals, Buddy). With Chat in Studio on (Settings →
  General → Chat, off by default; ⌘K mirrors it), the Studio inspector
  shows a Chat section under Session while on air (plan 204): a small
  avatar, the name, the words and the platform mark per row, a click that
  shows the message on stream through the same highlight, and nothing
  else. It keeps its default look under Retro LCD for now.
- **Health**: no sidebar row. The status bar state, "Open Health" on a
  degraded alert or an error toast, Settings → About and ⌘K open it. The
  support bundle's one home is Health (`SupportBundleButton`).

## Going live and stopping

One verb pair on every surface (plan 174 D3; the table in
`docs/ui-copy.md`, strings in `lib/go-live-copy.ts`):

- The Studio buttons read "Record" and **"Go Live…"** (it opens a dialog).
- The Go Live dialog's title and primary button read **"Go live"** ("Go
  live on 3 destinations" when it starts more than one).
- Stopping a livestream is **"End livestream"**, with the line "Your
  recording stops too." when it records (D19). Stopping a recording is "Stop
  recording".
- The state is **"On air"**, only while a livestream runs (the Stream
  Manager chip reads ON AIR).
- ⌘K: "Start recording", "Go live…"; while running "Stop recording" or "End
  livestream".

Ending a livestream takes intent (D1, D2; `lib/session-stop.ts`):

- Space works only on the Studio page: Record when idle, Stop recording
  while recording, and the "End livestream?" confirmation while live, with
  "Keep streaming" focused. It never starts Go Live, and it yields to any
  focused control, open dialog or menu.
- Every in-app stop while live (the button, Space, ⌘K, the failure banner,
  quitting) asks first with that one `AlertDialog`.
- A global hotkey arms on the first press ("Press again to end the
  livestream") and stops on a second press within 2 s.
- A Stream Deck intent and the phone's hold-to-stop are deliberate device
  actions: they stop at once. A recording that is not live stops at once
  from everywhere.

## Confirm and undo

Every destructive action either asks first or can be undone (plan 174
S0.3).

- **Confirm** with `ConfirmDialog`, the one recipe over `AlertDialog`:
  - the title is "Verb object?": "Delete saved scene?";
  - one sentence names exactly what is lost: "Only the saved snapshot is
    deleted. Your current scene and recording continue.";
  - the safe answer ("Cancel", or "Keep …") is a ghost button with focus on
    open, and Escape is the same answer;
  - the destructive button reads verb + object: "Delete scene". A
    consequential step that destroys nothing (a replace) passes
    `confirmVariant="default"`;
  - no close button: the two answers are the only way out. The owner closes
    it by dropping `open`, so an async action keeps the sheet up with
    "Deleting…".
- **Undo** a frequent, cheap-to-restore action instead of asking: it runs
  after a short window (3 s for a chat removal) unless undone
  (`scheduleUndoableAction`), or when its Undo toast closes
  (`holdUndoableAction`), both in `lib/undoable-action.ts`.

## Stream Manager

The live dashboard window (plan 055; code name `comments`, the old Chat
window). It follows the window family and adds its own layout rules. Plan 057
made it chat first: one thin stats bar and fewer words.

- **Tiers by container query.** The body is `@container/stream-manager`,
  never JS resize state (`lib/stream-manager-layout.ts`):
  - Wide (1,040 px and up): the stats bar, then Chat beside a right pane
    with Activity and Buddy tabs.
  - Medium (640 to 1,039 px): the stats bar, then one pane behind
    Chat / Activity / Buddy tabs.
  - Narrow (under 640 px, 320 minimum): the same, with the stats bar down to
    its main slots.
  - Every pane renders once; only its placement changes.
- **The title row carries the title only** (`WindowHeader`), with no mode
  badge: the stats bar says ON AIR, and History has its own bar.
- **The status bar is 32 px**, not the shared 26: its platform icons are
  20 px (YouTube's minimum, plan 165) and need room inside the border.
  - Left: each platform's chat state, its icon and a status dot, and a word
    only when something needs the streamer ("read-only", "reconnect to
    send"). The details open on hover and on focus.
  - Right, every action labelled: the window's hints ⌘F Search, ⌘L Write and
    ⌘J Buddy (clickable; below 800 px the key alone, the word kept for
    screen readers), then Keep on top (`PinWindowButton`), Highlight
    position (a menu), Mark clip (its icon and the words "Mark clip"),
    Clear (the word; it asks first, because it cannot be undone) and Open
    Preview (an icon).
  - Below 640 px all of them fold into one ⋯ menu, "More Stream Manager
    actions", with the stats bar's show, hide and reset choices.
- **One thin stats bar** (32 px, `components/stream-manager/stats-bar.tsx`),
  never tiles or cards:
  - The three main slots lead it: by default the ON AIR clock, viewers and
    stream health. They are never clipped at any width.
  - The rest follow after a hairline as a number and a short unit
    ("89,860 followers +83 · 8 subs · $20 · 22 msg/min"). They sit in a
    clipped, wrapping row, so a stat that does not fit drops off the end
    whole.
  - Numbers are monochrome and tabular. Tone lives in the chip and the dots,
    and the ON AIR chip is the only emphasis. Mini sparklines (the shadcn
    `chart`) appear at Wide only.
  - Details are one hover away (`HoverCard`): the per-platform split, peak,
    fps, drops, each destination's state.
  - Drag a stat to move it; right-click the bar to show or hide stats, move
    one, or reset (`lib/stream-manager-stats-layout.ts`, kept in
    `localStorage`). The clock and the viewer count cannot be hidden or leave
    the main slots.
- **Quiet when fine, specific when not.** Mid-stream there is no time to
  read. A healthy state is a dot or a number; words appear only when
  something needs the streamer:
  - health shows "X failed" or "12 dropped/min" instead of the bitrate;
  - a provider shows "read-only" or "reconnect to send";
  - the composer names only what a send skips, and a finished send says
    nothing;
  - every removed caption survives in a hover card or a tooltip.
- **Never an unmeasured zero.** A stat exists only when its source does, and
  an unreadable number shows "–" with the reason on hover. The viewer count
  is never hidden while live.
- **Chat keeps the big-text rows** (plan 055, decision 5), virtualized with
  `@tanstack/react-virtual`. While live, a row's time appears on hover.
  Filters are inline chips from 640 px and one Filters menu below it.
  - A click on a row puts the message on stream, and a click on the live
    row takes it off (owner call, D10). Enter and Space do the same, and the
    row's accessible name carries the message. The ⋯ menu holds the rest.
  - A row paints at most one background, lowest to highest: a member's own
    message `bg-member/8` (plan 154), Buddy's "Talking about this"
    `bg-accent`, a paid message `bg-warning/10` with its ring; an on-stream
    row keeps its button fill. The Member chip stays on every tinted row and
    text stays monochrome.
  - "Remove from chat" (⋯ or ⇧⌫) waits 3 s behind a "Removing {name}'s
    message" toast with Undo (D20) before it runs.
- **Activity rows** lead with who: a row about one named person (a follow,
  sub, gift, tip or raid) shows their avatar circle, with initials until it
  loads (plan 071). Counts the platform never named, announcements and
  destinations keep the event glyph tile (the window-scoped registry
  `components/stream-manager/activity-icons.tsx`). Then comes the name and a
  short fact on one line ("Resub · 14 months"), the time, and the 20 px
  platform mark closing that line on the far right (owner call, plan 165).
  The viewer's words follow, and a ⋯ menu reveals on hover. Filter chips
  carry their counts. One tint per row, like chat (plan 177): a channel point
  reward paints `bg-reward/8`, a tip (bits, Power-ups, KICKs, Super Chats
  and Stickers) chat's paid fill `bg-warning/10` without its ring (the rows
  are flush, split by hairlines); on stream, `bg-accent` wins, and hover
  paints over either. A long fact truncates and every ⋯ stays in the pane.
- **ScrollArea content is a block** (plan 177): `ui/scroll-area.tsx`
  overrides Radix's `display: table` wrapper, which let one long unbreakable
  row widen every row past the pane. Never reintroduce it per call site.
- **The Buddy pane** has one header: Buddy's identity (the living preview at
  32 px, the name, the bubble while one is up), the Alpha tag, listening,
  the status and the **Buddy Live** switch. Under it, "Chat posting" is a
  `SegmentedControl` (Off · Suggest · Auto) with the chosen mode's meaning
  as a line; it never turns Buddy on. Greetings, Answers and Banter are
  read-only summary chips that link to their one home, Buddy → Chat. The
  footer holds the Say box, the reaction chips and the "{name} on stream"
  switch. Every card that waits on the streamer is a `BuddyCard`.
- **Proof.** `pnpm probe:comments-window` sweeps 320/480/640/800/1040/1280.
  It fails on any overflow, a stats bar taller than one row, main stats
  apart or clipped, a stat cut at the bar's edge, a hidden viewer count, a
  button in the title row, or an unreachable control.

## ⌘K palette scale

The command palette alone keeps the Raycast scale:

- `rounded-panel` float glass (the Dialog's `glass-float-dialog`; `Command`
  itself paints nothing).
- An 18–20 px borderless search input with a leading 24 px icon.
- 40 px rows: icon, title, secondary context, an optional alias key chip,
  then right-aligned metadata.
- A footer with the primary action and its key chip.

Nothing else in the app uses this scale.

## Glass chips

Every badge, status pill, tag, and key chip is glass (`ui/badge.tsx`,
`status-badge.tsx`, `ui/kbd.tsx`, `status-dot.tsx`), and so is a `Button`
`secondary`. The chip utilities (`glass-chip`, `glass-chip-tinted`,
`glass-dot`, `glass-keycap`) are defined once in `styles.css`. Plan 208 S4
gave them the crisper highlight that matches the chrome controls.

| Part          | Dark                                    | Light                                   |
| ------------- | --------------------------------------- | --------------------------------------- |
| Fill          | vertical gradient white 13% → 3%        | white 95% → 55%                         |
| Rim           | 1 px white 9% (30% with more contrast)  | 1 px black 9% (24% with more contrast)  |
| Top highlight | `inset 0 1px 0` white 18%               | white                                   |
| Drop          | `0 1px 2px` black 30%                   | black 5%                                |
| Keycap fill   | white 15% → 4%                          | white → white 72%                       |
| Keycap edges  | top white 22%, bottom black 35%         | top white, bottom black 14%             |
| Keycap rim    | 1 px white 10% (30% with more contrast) | 1 px black 11% (28% with more contrast) |

- **Neutral** (`Badge` default/secondary): primary text.
- **Tag** (`Badge` outline): 20 px, `rounded-tag` (7 px), 11 px, secondary
  text. For `9:16`, counts, `Idle`, `beta`.
- **Status** (`Badge` success/warning/neutral, `StatusBadge`,
  `StatusDot`):
  - Monochrome text. A 6 px dot in the tone colour carries the status, with
    a 2 px halo and a soft glow. Tones: `good`, `warn`, `error`, `live`,
    `neutral`.
  - A leading icon replaces the dot and takes the tone.
  - `StatusBadge` is 22 px and fully round.
  - The label is a human, sentence-case word from `lib/state-labels.ts`
    ("Reconnecting", "On air"), never a raw value: a raw `/^[a-z-]+$/`
    value throws under test (`lib/status-word.ts`).
- **Emphasis** (`Badge` destructive/live, an error `StatusBadge`): tinted
  glass, a tone gradient with a tone rim and tone-mixed text. Only for
  failed, on air, and destructive.
- **Key chip** (`Kbd`): a glass keycap with a brighter top edge and a dark
  bottom edge. Print a shortcut only through `ShortcutKeys`, which draws the
  chip (or the status bar's plain text) the way the platform's menus do:
  ⇧⌘J on macOS, Ctrl+Shift+J on Windows and Linux. A guard fails on a
  hand-typed ⌘, ⇧ or ↵, or "Cmd+", in renderer TSX.
- No `backdrop-filter`, no motion, no ad-hoc pills. A rounded, bordered
  `text-[10–12px]` span is a bug: use `Badge`.

## Chrome materials

The Welcome screen's Liquid Chrome in the hand (owner call, plan 208 D2):
the controls you touch shine, and nothing else does. Four utilities are
defined once in `styles.css`, each with a dark and a light token column.
Light is the crisp invert: black chrome on porcelain. Each writes its light
and shade into Tailwind's shadow stack, so focus and hover rings still draw.
No transition on the material, no motion, no `backdrop-filter`.

| Utility           | For                        | Dark                                   | Light                                      |
| ----------------- | -------------------------- | -------------------------------------- | ------------------------------------------ |
| `chrome-fill`     | Primary fills              | Silver over a 0.75 waist, ink 0.13     | Graphite over a 0.13 waist, ink 0.985      |
| `chrome-plate`    | Selected and active        | White 14% → 4% under a white 16% line  | Black 9% → 3% under a white 90% line       |
| `chrome-bead`     | Knobs and thumbs           | A silver bead, black 70% drop          | A pearl bead, black 35% drop, 20% hairline |
| `chrome-bead-ink` | A knob on a chrome track   | A black bead                           | A pearl bead                               |
| `chrome-led`      | Record and its stop button | Red 0.70 → 0.50 (hue 27), lit glow 40% | Red 0.64 → 0.46, lit glow 30%              |

A fill and the LED carry a top line, a bottom line and a small drop, and
`data-lit` adds a 12 px `--live` glow to the LED. The exact stops are the
`--chrome-*` tokens in `styles.css`.

- **States.** A fill or LED lifts a little on hover and turns concave when
  pressed (the gradient flips and the drop goes). Disabled is the flat
  colour at the Button's 50%, so a disabled Go Live… is a flat chrome slab.
  Hover on a plated row or segment stays the flat `bg-accent`: the plate
  means selected.
- **Who wears what.** Only the primitives:
  - `chrome-fill`: `Button` `default` (the chrome primary: Go Live…,
    Continue, Save), a checked `Checkbox`, the `Switch` track when on,
    `Progress`, and the range of `Slider`, `ParameterSlider` and `Fader`;
  - `chrome-bead`: the `Switch` knob when off and every slider and fader
    thumb; `chrome-bead-ink`: the `Switch` knob on its chrome track;
  - `chrome-plate`: the active `SegmentedControl` segment, `Tabs` trigger,
    pressed `Toggle` and `ToggleGroup` item, the sidebar's current page
    row and `MediaCard` `selected`;
  - `chrome-led`: `Button` `record` only, which the Studio's Record (unlit)
    and stop button (`data-lit`) use (D8).
- **Buttons.** `secondary` is the chip recipe; `outline`, `ghost`, `link`
  and `destructive` stay flat. Delete keeps `destructive`, never `record`.
- **Everything else stays flat.** Panels, sections, rows, menus, dialogs,
  toasts and text never take a material or a gradient. The guards hold it:
  a hand-rolled gradient (`bg-linear-*`, `bg-radial-*`, a
  `linear-gradient(`) outside `components/ui/` and `styles.css` fails
  unless its file is on the named list of pictures and stream content, and a
  chrome material outside `components/ui/`, `sidebar.tsx` and
  `media-card.tsx` fails. A screen gets the shine through a primitive's
  variant, never a class.
- **Increase Contrast** gives a fill and the LED a 1 px edge (white 55% ·
  black 60%) and the plate a stronger rim (30% · 28%).

## Floating surfaces

Dialogs, popovers, hover cards, menus, selects, tooltips, toasts, and the
palette are flat, opaque tiers of the window's solid tone (plan 072 made
them opaque, plan 091 D6 made them flat, and plan 208 D2 keeps them flat
over the chrome): `border glass-float` for the popup tier,
`border glass-float-dialog` for dialogs and the palette,
`border glass-float-tooltip` for tooltips. One surface per float: a
`Command` inside a Dialog or Popover stays transparent. Every toast is the
same neutral popup glass: a type (success, warning, error, info) colours its
16 px icon only, never the panel or its rim, and the text stays monochrome.
Never `bg-popover`: a guard test fails on it, so a fresh shadcn add must be
moved onto the utility.

- **Dialogs**: 12 px radius, `p-5`, the dialog tier with its own drop
  (deeper in light). `DialogContent` and `AlertDialogContent` take
  `size`: `sm` 384 px (a rename, one question),
  `md` 448 px (the default: confirmations, short forms), `lg` 576 px
  (forms, pickers, setup), `xl` 768 px (review and media: Go Live, markers,
  galleries). A dialog is never taller than the window less 16 px a side;
  a `DialogBody` between header and footer takes what is left and scrolls.
  A guard rejects a hand-set width or height on a dialog.
- **Menus, selects, and popovers**: 10 px radius, the popup tier. Menu items
  are 28 px with a 6 px radius, concentric inside the 4 px inset. Hover
  inside a float stays `bg-accent` (white 8%).
- **Tooltips**: the tooltip tier (8 px radius, 12 px text), never an
  inverted pill. They open after 600 ms. A tooltip is never the only place
  a fact lives, and `title=` is not an information channel: use `Tooltip`,
  `ShortcutTooltip` or `DisabledReason`.
- **`Alert`**: a flush inline status row (a faint tone tint, the icon in the
  tone, monochrome text), never a card. `variant` is the tone and brings its
  own icon: `default`, `quiet` (a neutral note in secondary text), `locked`
  (via `LockAlert`), `warning`, `success`, `destructive`. Never put an icon
  child inside it; `icon` swaps in a subject's own mark, `icon={null}` drops
  it. Only `destructive` is `role="alert"`; the rest are `status`. A title
  alone reads in regular weight; a title over an `AlertDescription` is a
  heading.
- **`Empty`** (plan 174 D11): short muted text (`text-muted-foreground`),
  centred, with an optional 14 px / 500 `EmptyTitle` above it and an action
  in `EmptyContent`. No media tile, no illustration, no dashed box.
- **Loading**: `Spinner` (`role="status"` with a label, or silent with
  `aria-hidden` beside words that already say it) and `Progress`
  (`value max? aria-label`). A pending label ends in "…".
- **A field's own error**: `FieldError` under the field, monochrome text with
  the destructive icon.

## Native feel

- `html` sets `user-select: none`, `cursor: default`, and
  `overscroll-behavior: none`. Content opts back in with `select-text`:
  chat messages, notes, transcripts, logs, and inputs. Images are not
  draggable.
- Editable fields get the native context menu (Cut, Copy, Paste, Select All,
  spelling), which main builds on `context-menu` (`main/context-menu.ts`).
  Notes has none: a popup menu is not capture-protected.
- macOS overlay scrollbars: no custom scrollbar recipe. Radix `ScrollArea`
  uses `type="scroll"`.
- Rows highlight instantly. No `cursor-pointer`: desktop controls use the
  arrow.
- Copying: `copyText(text, failure?)` or `useCopyText() → { copied, copy }`.
  A copy is quiet on success ("Copied" on the control) and loud on failure.
- The guards (`renderer-style-guards.test.ts`) fail on: any CSS backdrop
  blur or filter, a second import of the chrome ground's stills, a
  hand-rolled gradient on a screen, a chrome material outside the
  primitives, `bg-popover`, a tinted toast, `cursor-pointer`, a colour
  literal outside its short content allowlist, a coloured status word, text
  below 11 px, a hand-sized dialog, an unnamed `SelectTrigger`, `Slider` or
  `SegmentedControl`, a Field control its `FieldLabel` doesn't name, and a
  `Switch` inside a button or a `role="button"` row.
  `renderer-shortcut-guard.test.ts` holds the shortcut rule,
  `renderer-copy-guards.test.ts` and `renderer-toast-guards.test.ts` the
  copy and toast rules of `docs/ui-copy.md`.

## Windows

- Windows gets the chrome ground like macOS and Linux (plan 208): an opaque
  main window, Stream Manager, Captions and Notes on the solid base, with
  `ChromeGround` under the same coats and covers. Every build looks the
  same, and nothing depends on the wallpaper, Mica or the compositor.
- `VIDEORC_GLASS=clear` brings back plan 050's Mica for one release (D9):
  Windows 11 22H2+ (build ≥ 22621) only, with its paint check
  (`micaFoundBlank`, plan 082); older builds and software rendering stay
  solid under it.
- The Preview stays solid dark: it takes no ground, and Windows has no
  per-window appearance pin.
- The D3D11 preview window and the proof surface stay opaque.
- Windows-only chrome uses the `win32:` variant (`hidden win32:flex`). It
  keys on the `data-platform` attribute that `theme-bootstrap.js` sets before
  the first paint, so it never waits for runtime info and never pops in.

## Icons

- The app icon (`assets/videorc-logo.png`) carries its own rounded tile and
  transparent margin: no mask, no shadow. It appears in Settings → About
  (64 px, beside the name, version, and release-track tag) and in first-run
  onboarding. Nowhere else.
- App/source icons: 24 px rounded-square (radius about 6), vivid, full
  colour. They are the only large colour on screen.
- Inline and status icons: 16 px, secondary gray unless conveying status.
- **Import every icon from `@/components/icons`, never from an icon
  package.** The registry names icons by meaning (`SourcesIcon`,
  `AlertIcon`, `RecordIcon`), and `no-restricted-imports` enforces it.
  Before adding a slot, check whether one already means the same thing: the
  set is licence-counted (100 glyphs). `docs/icon-set.md` holds the licence
  terms, the build pipeline (`pnpm icons:build`), and the semantic audit.
  Copy never names an icon by its component name ("Trash", not
  `DeleteIcon`); the copy guard fails on it.
- **The Buddy mark** (plan 164) is the owner's stone golem, always the
  real artwork, never a redrawn glyph (the plan 149 owner call, 2026-10-04).
  The masters and their export commands live in `assets/brand/buddy/`.
  - `BuddyIcon` is the emblem at icon size: an `<svg>` wrapping the image,
    so `svg`-based slot styles size it like its neighbours. It is the one
    full-colour icon in the registry. `weight` and `currentColor` never
    change it, so a selected row keeps the same image.
  - `BuddyEmblem` is the emblem larger, at 32 px (`md`) or 56 px (`lg`)
    tall: the Buddy page's intro line and the Buddy Live consent dialog.
  - It is never tinted or filtered, and one file serves both themes. Its
    colours are the art, not a status.
  - The Videorc app icon stays the orc-head orb. The Buddy is not the app's
    logo.

## Motion

Fast and subtle: 100–150 ms ease-out. Floating surfaces fade and scale from
0.98. Rows highlight instantly. Nothing bounces, and chips never move. The
chrome ground is a still: only the Welcome screen's backdrop moves (owner
call). `prefers-reduced-motion` collapses motion.

## Toast discipline

Toasts are for news the interface does not already show, never for
confirming a routine interaction the user just watched succeed. The copy
(title, description, action, error shape) is `docs/ui-copy.md` → Toasts.

- **Never toast success for scene, layout, or source changes.** The
  stage/preview is the confirmation (owner call, 2026-07-16: "no green
  popups on every small thing"). This includes live layout applies, preset
  clicks, and source device switches.
- **Type by meaning**, and the type colours the icon only (owner call):
  - error: it failed and needs you;
  - warning: it can't happen now, or it is degraded. A refusal ("Renaming takeovers
    is locked while you're recording or live") is a warning, never an
    error;
  - info: neutral news, or a step to take in the browser;
  - success: async work that finishes out of view (recording saved, import
    complete), a destructive confirmation (deleted), an account-level side
    effect (connected, authorized).
- **Durations** (`defaultToastDuration` in `lib/toast.ts`; an explicit
  duration wins):
  - a one-line toast keeps sonner's 4 s;
  - a toast with a description stays at least 8 s
    (`TOAST_WITH_DESCRIPTION_MS`);
  - a toast with an action stays until it is acted on or closed, and so
    does one that mirrors a state still true ("Streaming to X stopped"
    until "X is back" replaces it).
- One id per kind of toast, so a newer one replaces the older and the same
  news never stacks. Each window shows at most three, each dismissible,
  above its status bar.
- Import `toast` from `lib/toast.ts`, never sonner: it withholds raw error
  text. A caught error goes through
  `toastUserError(error, { action, object })`, which shows "Couldn't
  {action} {object}" with the known cause or the generic next step, and
  logs the raw text.
- Warnings and errors always surface. Silence is only for the expected
  outcome.
- When in doubt, don't toast. A user mid-flow reads every popup as an
  interruption.

## Primitives

Plan 174 gave each job one primitive. Read the source before using one;
these are the props that matter. Paths are under
`apps/desktop/src/renderer/src/`.

Asking, locking and explaining

- `AlertDialog` (`ui/alert-dialog.tsx`): shadcn's, on the dialog tier with no
  close button; Radix focuses Cancel and Escape closes. Use it through
  `ConfirmDialog` unless the question is not a delete (End livestream has
  its own, `components/end-livestream-dialog.tsx`).
- `ConfirmDialog` (`components/confirm-dialog.tsx`), the recipe in
  [Confirm and undo](#confirm-and-undo):
  `open title description confirmLabel cancelLabel? confirmVariant? confirmDisabled? children? testId? onCancel onConfirm`.
  Its test ids are `{testId}-dialog`, `-cancel` and `-confirm`.
- `DisabledReason` (`ui/disabled-reason.tsx`):
  `<DisabledReason reason id? label? focusable? tabIndex?>{control}</DisabledReason>`.
  A focusable wrapper with a Tooltip and `aria-describedby`, because a
  disabled control takes no hover. Pass `reason` only while the control is
  disabled; `focusable={false}` only for Radix select or menu items.
- `LockAlert` (`components/lock-alert.tsx`): `reason action?`, where
  `action` is `{ kind: 'sign-in' }` or `{ kind: 'view-premium', url }`
  (`unlockActionForGate`, `unlockActionForReason` in `lib/lock-view.ts`).
  `SessionLockAlert locks?` says "Locked while you're recording or live.
  Changes apply the next time you record or go live."; `OfflineAlert` says
  Videorc is reconnecting.

Rows, forms and choices

- `SettingsRow` (`ui/field.tsx`): `label description? error?`, with the
  control as its child: a horizontal `Field` with an automatic
  `aria-describedby`. A `Field`'s `FieldLabel` names its control on its
  own (`ui/field-context.ts`).
- `SegmentedControl` (`ui/segmented-control.tsx`):
  `options={[{ value, label, disabled?, 'aria-label'?, onClick? }]} value onValueChange disabled? disabledReason? activationMode? size?`.
  Roving focus, one tab stop; `activationMode="manual"` for a heavy change
  (a live scene switch).
- `DevicePicker` (`components/device-picker.tsx`):
  `kind label devices value onChange noneLabel? discoveryPending? searchable? groupByKind? trigger? description? statusInTrigger? disabled? labelHidden?`.
  `trigger="field"` is a labelled form control, `"inline"` a row's
  right-aligned value.
- `ListRow`, `GroupedList` and `ListRowButton` (`components/list-row.tsx`),
  `NavigableRow` (`components/navigable-row.tsx`), `SectionLabel`
  (`components/section-label.tsx`) and `PanelSection`
  (`components/panel-section.tsx`, `title description? action? headingLevel?`).
- `MediaCard` (`components/media-card.tsx`): `selected? interactive? asChild?`
  on a div, for an object with a picture.
- `KebabMenu` (`components/kebab-menu.tsx`): `items label? busy? disabled? reveal? tabIndex?`,
  each item `id label icon? destructive? disabled? disabledReason? group? shortcut? onSelect`.
- `BroadcastInfoFields` (`components/streaming/broadcast-info-fields.tsx`):
  stream details one way everywhere (the Go Live dialog, Livestream →
  Setup, the Schedule dialog), with one title rule, Privacy as a
  `SegmentedControl` and one Made for kids switch:
  `idPrefix value onChange disabled? titleRequired? privacyNote? madeForKidsNote? thumbnail? titleRef?`.

Windows, bars and pages

- `WindowHeader` (`components/window-frame.tsx`): `title meta? className?`,
  with the window's controls as children.
- `PageTabs` (`components/page-tabs.tsx`):
  `tabs value onValueChange label triggerAttribute? testId?`, with the
  `TabsContent` panels as children. `PaneStrip` (`components/pane.tsx`) is
  the strip on its own; `PANE_OWNS_SCROLL` goes on a page that owns its
  scroll.
- `StatusBarAction` (`components/status-bar.tsx`):
  `icon? label text? hint? accelerator? pressed?`, plus button props, so it
  can be a menu trigger. `label` is the name a screen reader says; `text`
  the visible word when there is room. `StatusBarHint`
  (`accelerator label pressed? onClick`) is a clickable shortcut hint.
- `PinWindowButton` (`components/pin-window-button.tsx`):
  `pinned onPinnedChange variant="header|status-bar"`, labelled "Keep on
  top" in every window.
- `SupportBundleButton` (`components/support-bundle-button.tsx`): "Export
  support bundle", its one home Health.

Shortcuts

- `ShortcutKeys` (`ui/shortcut-keys.tsx`): `accelerator platform? variant="chip|text"`,
  with an Electron accelerator (`CmdOrCtrl+Shift+J`). The only way to print
  a shortcut. Accelerators come from `shortcutAccelerator(id)` in
  `lib/shortcuts.ts`.
- `ShortcutTooltip` (`ui/shortcut-tooltip.tsx`): `label accelerator? platform?`
  around a control: its tooltip with the bound shortcut.

Buddy

- `BuddyCard` (`components/stream-manager/buddy-card.tsx`): the one card
  that waits on the streamer in the Buddy pane (a removal, a voice command's
  chooser or confirm, a proposed post):
  `label title testId icon? timer? busy? keys? primary? decline? onPrimary? onDecline?`.
  Primary first, then the decline; ↵ is the primary, and Esc, ⌫ or Delete
  decline.

Words, numbers and navigation

- Status words: `lib/state-labels.ts` (`sessionStatusLabel`,
  `sessionStatusTone`, `previewStateLabel` and the other state machines).
- Formatters: `formatVideoQuality`, `formatResolution`, `formatFrameRate`,
  `formatBitrate` (`lib/format-video.ts`); `formatTimecode`,
  `formatRelativeTime` (`lib/format-time.ts`); `NO_VALUE` ("–"),
  `missingValue(reason)`, `plural` (`lib/format.ts`); `platformLabel`,
  `platformCopy` (`lib/platform-copy.ts`); `layoutPresetLabel`
  (`lib/layout-labels.ts`); `WINDOW_NAMES` for window names.
- Errors: `userErrorMessage` and `toastUserError` (`lib/user-error.ts`).
- Navigation: `openWorkspaceTab(tab, subTab?)`
  (`lib/workspace-navigation.ts`) for every "open page" action; `openHealth`
  (`lib/health-door.ts`) for the Health door.

## shadcn component mapping

| Need                         | Use                                                                         |
| ---------------------------- | --------------------------------------------------------------------------- |
| A window's ground            | `ChromeGround`, mounted by `WindowProviders`; nothing else                  |
| Page chrome                  | `Pane` + `Toolbar` (title only) + `PaneBody`                                |
| Page tabs or a pinned filter | `PageTabs` / `PaneStrip`                                                    |
| Single-pane window header    | `WindowHeader` in a `WindowFrame`                                           |
| Page sections                | `PanelSection` (flush)                                                      |
| Sets of like things          | `GroupedList` + `ListRow`                                                   |
| A settings row               | `SettingsRow` in `FieldGroup variant="grouped"`                             |
| Objects with a picture       | `MediaCard` (8 px, hairline, no shadow)                                     |
| Per-item actions             | `KebabMenu`                                                                 |
| Global state and hints       | `StatusBar` + `StatusBarHint` / `StatusBarAction`                           |
| Palette / searchable list    | `Command` (+ `CommandDialog`), palette scale                                |
| First-run setup              | The Liquid Chrome backdrop and one card on the dialog tier                  |
| Modals                       | `Dialog` with `size`, `DialogBody` for the scroll                           |
| Destructive confirmations    | `ConfirmDialog` (on `AlertDialog`)                                          |
| Segmented choice (2–4)       | `SegmentedControl` (the glass Tabs track)                                   |
| Views and page tabs          | `Tabs`                                                                      |
| Filter chips (multi-select)  | `ToggleGroup`                                                               |
| A boolean                    | `Switch`                                                                    |
| A screen, camera, microphone | `DevicePicker` (`trigger="lcd"` on a Retro LCD screen)                      |
| Buttons                      | `Button` ghost/outline/secondary; `default` chrome primary; 28 px default   |
| Record and its stop button   | `Button` `variant="record"`, `data-lit` while running (never Delete)        |
| Why a control is disabled    | `DisabledReason`, or `SegmentedControl`'s `disabledReason`                  |
| Locked controls              | `LockAlert` / `SessionLockAlert` / `OfflineAlert`                           |
| Inline status                | `Alert` (variant brings the icon)                                           |
| Nothing to show              | `Empty`                                                                     |
| Status, tags, counts         | `Badge`, `StatusBadge`, `StatusDot`                                         |
| Shortcut hints               | `ShortcutKeys` (draws `Kbd`), `ShortcutTooltip`                             |
| Keep a window on top         | `PinWindowButton`                                                           |
| Dividers                     | `Separator` or a `border-border` hairline                                   |
| Scroll regions               | `PaneBody` or `ScrollArea type="scroll"`                                    |
| Menus / popovers             | `DropdownMenu` / `Popover` on `glass-float`                                 |
| Toasts                       | `toast` from `lib/toast.ts`; type colours the icon                          |
| Audio levels                 | `MicLevelMeter`: segmented bar; LCD meter with Retro LCD                    |
| Audio controls               | audiocn `fader` in Sources rows (`SourceItem`) and the Studio Audio section |

The Microphone and System audio Gain faders have one definition for both
pages, `components/audio/gain-faders.tsx`. Retro LCD skins them from outside
with `LCD_FADER` in `components/lcd-panel.tsx`, inside the Audio screen
(plan 201 D5).

Missing a primitive? Install it through the shadcn CLI (see the shadcn skill);
do not hand-roll it.

## Do / Don't

- DO keep chrome monochrome. Let source icons, status dots, and preview
  content provide the colour.
- DO build screens from panes, toolbars, sections, and grouped lists.
- DO use one shared row component for every icon + title + meta list.
- DO write every word per `docs/ui-copy.md` and the glossary in
  `CONTEXT.md`, and grep the tests and `scripts/` smokes for a string
  before changing it.
- DON'T put cards on cards, shadows inside a window, or `rounded-panel`
  boxes around page content.
- DON'T put an image, a wallpaper or the desktop under the UI: the ground
  is `ChromeGround`'s alone.
- DON'T put shine on a screen: no hand-rolled gradient and no chrome
  material outside the primitives, and no sheen on panes, menus, dialogs,
  toasts or text.
- DON'T use `backdrop-filter`, `bg-popover`, `cursor-pointer`, raw colour
  literals, or ad-hoc radii and pills.
- DON'T put essential information in `text-subtle`, colour a status word,
  or set text below 11 px.
- DON'T type a shortcut by hand (⌘, ⇧, ↵, "Cmd+"): `ShortcutKeys`.
- DON'T leave a disabled control without its reason, or hide a Premium
  feature instead of locking it.
- DON'T add a font, a component library, or a direct icon-package import.
- DON'T ship an audio control with nothing behind it: no pan, solo, monitor
  or player volume until the backend can do it (plan 093).
- DO call the companion **Buddy** in all copy (or the name the streamer gave
  it), and **Buddies** for more than one (plan 171). Code and wire names stay
  `cohost`; saved values keep `orcle` (plan 170 D22), like the moderation
  source `orcle-voice`. "golem" names only the stone golem creature (plan 171
  D4): its slug `golem`, its kind "Golem", its art masters and golem example
  text; its name is Buddy. Guard tests fail on "Orcle" and on "Golem"
  anywhere else in the renderer's sources and the docs.
