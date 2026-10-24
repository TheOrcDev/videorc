---
name: videorc-design
description: Videorc's UI design language — a native macOS desktop app on real window glass (vibrancy), built exclusively from shadcn/ui components and Videorc's shared primitives: flush panes, toolbars, grouped lists, glass chips, and a Raycast-style ⌘K palette. Use whenever building, styling, reviewing, or planning ANY Videorc UI (new components, screens, dialogs, lists, toolbars, badges, confirmations, empty or locked states), when the user mentions "our design", "the design skill", "glass", "native look", or asks how something should look.
---

# Videorc Design Language (v2: the window family)

The single source of truth for how Videorc looks and feels. Every UI task
follows this skill. Videorc is a desktop app, not a web page: every window
sits on the real macOS window material, panes are flush and split by
hairlines, controls are desktop-sized, and colour is information. The
reference is the Videorc logo: a glossy black-glass orb with chrome detail and
one LED-red accent. Light mode is the porcelain twin of the same structure.

The words on these surfaces are not in this file. How to write them is
[`docs/ui-copy.md`](../../../docs/ui-copy.md) (voice, casing, ellipsis,
toasts, errors, disabled and locked copy), and the one name for each thing is
the glossary in [`CONTEXT.md`](../../../CONTEXT.md).

**Status: shipped in plan 050 (2026-09-23).** `styles.css` implements the
tokens below. `src/main/window-glass.ts` gives every window (main, Stream Manager,
Captions, Notes, Preview) its material and title bar. The Preview frame's
data-URL document mirrors the coats through `src/main/window-palette.ts`, and
a parity test fails when they drift. Fix tokens and primitives, never restyle
a screen ad hoc. Plan 174 (the UI/UX pass, 2026-10) gave every job one shared
primitive ([Primitives](#primitives)) and added the guards that hold them.

## Hard rules

1. **shadcn/ui only.** Every element is a shadcn/ui component or a composition
   of them, installed and customized per the `shadcn` skill. No other
   component libraries and no hand-rolled widgets when a primitive exists.
   audiocn (the owner's shadcn audio registry, `@audiocn`) counts as shadcn:
   its meters draw audio, fed by Videorc adapters, never by its
   Web Audio hooks or blocks. Base UI enters only inside its files
   (`docs/audiocn.md`).
2. **Real glass, never fake glass.** The OS draws the blur. No CSS
   `backdrop-filter` / `backdrop-blur` anywhere in the renderer: it wedged the
   compositor in June, and on the vibrancy windows it never reaches the screen
   (Chromium's own capture shows the blur, the display does not; plan 072). A
   guard test fails on it. No wallpaper underlays, no inline `color-scheme`
   on the root.
3. **Dark first, light supported.** Dark is the reference. Light is the same
   structure with the light token column, never a separately designed theme.
4. **Colour is information.** Chrome is monochrome. Saturated colour appears
   only in source/platform icons, status dots, and emphasis chips: red for
   record, live, and destructive; green for healthy; amber for attention.
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

## The window family

Every window uses one material and one title-bar recipe (`window-glass.ts`):

- **Material.** `vibrancy: 'under-window'`, with the effect state pinned
  to `active` so glass stays glass when the window is inactive, stripped to
  **clear glass** by the native addon (plan 091): Ghostex's strip on
  Electron's own vibrancy view, no tint, no wallpaper tinting, no saturation
  boost, a 60 pt blur. What shows through is the desktop as soft colour, and
  the coats decide the whole tone. `VIDEORC_GLASS_STYLE=material` keeps
  AppKit's own grey material as the A/B control for one release;
  `VIDEORC_GLASS=0` paints the solid palette instead.
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
- **One dark-always window.** The Preview frames video, so main pins its
  NSWindow appearance to `darkAqua` through the native addon, and a light
  main window never lightens it. If the pin is unavailable, it falls back to
  solid dark. Stream Manager, Captions and Notes follow the app theme like
  main (#412).
- **Covers.** One cover per region, Ghostex's numbers (plan 091, D3): how
  much of the solid tone a region paints over the clear blur. The sidebar
  covers 88% (dark) · 93% (light), the work area 83% · 86%: the sidebar is
  the heavier, more covered region, the work area shows more desktop.
  - The coats are derived from the covers (D4), never set by hand: `body`
    paints the lighter cover (`--glass-window`), the sidebar `<aside>` adds
    its delta (`bg-glass-sidebar`), content panes add theirs
    (`bg-glass-content`, 0 on macOS), so each region composites to exactly
    its cover.
  - Single-pane windows wrap their body in `WindowFrame`.
  - Never stack a third coat.
  - Windows keeps plan 050's Mica composite through its own covers.
- **Providers.** Each window is its own React root and wraps its tree in
  `<WindowProviders window="main|stream-manager|captions|notes">`: one
  TooltipProvider (600 ms, the desktop delay) and one Toaster, inset above
  that window's status bar.
- **Accessibility.** `prefers-reduced-transparency` swaps the window coat
  for `--glass-solid` and drops the region coats (the addon leaves AppKit's
  solid material whole). `prefers-contrast: more` puts both covers at 95%
  and strengthens hairlines, chip rims, and the secondary and tertiary text
  tiers.
- **Proof.** `pnpm probe:ui-glass --gate` measures every window over
  stand-in backdrops: transmission (the glass is real), sharpness (nothing
  behind is legible), contrast, pinned-dark luminance, the native effect
  view state, and since plan 091 neutrality (the stripped material passes
  the backdrop colour through), `nativeClear` (the strip holds) and
  `ghostexParity` (each region composites to its cover). It runs in
  `smoke:local-gates`.

## Tokens

Implemented as shadcn CSS variables in
`apps/desktop/src/renderer/src/styles.css` (oklch; that file is the live
source). Values below are dark · light.

Coats and surfaces

- Base `--glass-base`: black `0.16 0.004 286` (`#0D0D0F`) · porcelain
  `0.985 0.001 286` (`#FAFAFB`), the OKLCH components every coat is cut
  from. Solid `--glass-solid` is that base, opaque.
- Covers `--glass-cover-sidebar` / `--glass-cover-work`: 0.88 / 0.83 ·
  0.93 / 0.86 (Windows 0.34 / 0.5116 · 0.5 / 0.62). The coats
  `--glass-window`, `--glass-sidebar` and `--glass-content` are derived
  from them in `styles.css`.
- Floating glass, three flat opaque tiers of the solid (plan 091, D6,
  Ghostex's web-modal recipe), each a 1 px rim (white 10% · black 10%) and
  a drop shadow, no sheen and no highlight:
  - popup `--glass-float` (menus, selects, popovers, hover cards, chart
    tooltips, toasts): black `#222224` (the solid plus 6% then 3% white,
    `color-mix` in sRGB) · porcelain `oklch(0.99 0 0)`;
  - dialog `--glass-float-dialog` (dialogs, the palette, the error panel):
    black `#1C1C1D` · porcelain;
  - tooltip `--glass-float-tooltip`: the black solid · porcelain.
    Opaque: without a frost, even 3% translucency lets white text under a
    menu read through. Deliberately darker than the glass over a bright
    desktop: `probe:ui-glass --surfaces` checks each tier reads its own token
    whatever is behind it.
- Inset `bg-inset`: foreground 3%, for a well inside a section (a preview
  frame, a code line). Never a card.

Text (three tiers, nothing else)

- Primary `text-foreground`: titles and labels, weight 500–600.
- Secondary `text-muted-foreground`: inline context, metadata, placeholders,
  descriptions, and every fact the streamer needs.
- Tertiary `text-subtle`: section labels, quiet hints, disabled.
  **Essential information never uses `text-subtle`** (plan 174 D12): a
  reason, a limit, a status, a value or a rule a streamer needs is secondary
  or primary. `--subtle` passes AA on the solid (0.62 dark · 0.54 light) and
  rises under `prefers-contrast: more`, but over a bright desktop it is
  still the faintest tier.
- Sizes are tokens: `text-label` 11 px / 600 (section labels,
  `SectionLabel`), `text-section` 13 px / 600 (section headers), `text-meta`
  12 px (descriptions and metadata). **No text below 11 px** (a guard fails
  on `text-[9px]` and `text-[10px]`).

Hairlines and selection

- Hairlines `border-border`: white 10% · black 12%, always 1 px.
- Hover/selected row `bg-accent`: white 8% · black 6%, a full-row block with
  no outline. Pressed `bg-accent-pressed`: 12% · 10%.
- Focus-visible: a 2–3 px ring, keyboard only.

Colour

- `--live` / `--destructive`: the logo's LED red. Record, on air, failed,
  destructive. Never chrome.
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
  window there are no floating panels, no shadows, and no big cards.
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
  hairline, no shadow; `selected` is a brighter rim, never a colour.
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
  Camera, System audio, with Open Sources) and the Microphone section
  (picker, level, mute and its hotkey).
- **Takeovers**: Assets → Takeovers manages them (import, rename, reorder,
  delete). Studio's Takeover section puts one on stream and takes it off.
- **Scenes**: the Scene page edits a scene; Studio's Scenes gallery switches
  between them.
- **The local file**: Output ("Where recordings go", quality). Recordings
  themselves live in Library.
- **Buddy**: the Buddy page (Profile, Chat, Voice, Reports, Clean cut)
  creates and sets Buddy up; the Stream Manager's Buddy pane operates it
  live.
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
`status-badge.tsx`, `ui/kbd.tsx`, `status-dot.tsx`). The chip utilities
(`glass-chip`, `glass-chip-tinted`, `glass-dot`, `glass-keycap`) are defined
once in `styles.css`.

| Part          | Dark                               | Light           |
| ------------- | ---------------------------------- | --------------- |
| Fill          | vertical gradient white 10% → 3.5% | white 70% → 45% |
| Rim           | 1 px white 13%                     | 1 px black 8%   |
| Top highlight | `inset 0 1px 0` white 12%          | white 90%       |
| Drop          | `0 1px 2px` black 30%              | black 6%        |

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

## Floating surfaces

Dialogs, popovers, hover cards, menus, selects, tooltips, toasts, and the
palette are flat, opaque tiers of the window's solid tone (plan 072 made
them opaque, plan 091 D6 made them flat): `border glass-float` for the popup
tier, `border glass-float-dialog` for dialogs and the palette,
`border glass-float-tooltip` for tooltips. One surface per float: a
`Command` inside a Dialog or Popover stays transparent. Every toast is the
same neutral popup glass: a type (success, warning, error, info) colours its
16 px icon only, never the panel or its rim, and the text stays monochrome.
Never `bg-popover`: a guard test fails on it, so a fresh shadcn add must be
moved onto the utility.

- **Dialogs**: 12 px radius, `p-5`, the dialog tier. `DialogContent` and
  `AlertDialogContent` take `size`: `sm` 384 px (a rename, one question),
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
- The guards (`renderer-style-guards.test.ts`) fail on: backdrop blur
  outside `glass-float`, `bg-popover`, a tinted toast, `cursor-pointer`, a
  colour literal outside its short content allowlist, a coloured status
  word, text below 11 px, a hand-sized dialog, an unnamed `SelectTrigger`,
  `Slider` or `SegmentedControl`, a Field control its `FieldLabel` doesn't
  name, and a `Switch` inside a button or a `role="button"` row.
  `renderer-shortcut-guard.test.ts` holds the shortcut rule,
  `renderer-copy-guards.test.ts` and `renderer-toast-guards.test.ts` the
  copy and toast rules of `docs/ui-copy.md`.

## Windows

- Windows 11 22H2+ (build ≥ 22621): `backgroundMaterial: 'mica'` on the
  main window, Stream Manager, Captions and Notes, with their own coats
  (`[data-platform='win32']` in styles.css). Mica tints from the wallpaper
  without a live blur, so it stays cheap on low-end iGPUs. The Preview stays
  solid dark: Windows has no per-window appearance pin.
- Windows 10 and older builds use the solid palette.
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
0.98. Rows highlight instantly. Nothing bounces, and chips never move.
`prefers-reduced-motion` collapses motion.

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

| Need                         | Use                                                        |
| ---------------------------- | ---------------------------------------------------------- |
| Page chrome                  | `Pane` + `Toolbar` (title only) + `PaneBody`               |
| Page tabs or a pinned filter | `PageTabs` / `PaneStrip`                                   |
| Single-pane window header    | `WindowHeader` in a `WindowFrame`                          |
| Page sections                | `PanelSection` (flush)                                     |
| Sets of like things          | `GroupedList` + `ListRow`                                  |
| A settings row               | `SettingsRow` in `FieldGroup variant="grouped"`            |
| Objects with a picture       | `MediaCard` (8 px, hairline, no shadow)                    |
| Per-item actions             | `KebabMenu`                                                |
| Global state and hints       | `StatusBar` + `StatusBarHint` / `StatusBarAction`          |
| Palette / searchable list    | `Command` (+ `CommandDialog`), palette scale               |
| Modals                       | `Dialog` with `size`, `DialogBody` for the scroll          |
| Destructive confirmations    | `ConfirmDialog` (on `AlertDialog`)                         |
| Segmented choice (2–4)       | `SegmentedControl` (the glass Tabs track)                  |
| Views and page tabs          | `Tabs`                                                     |
| Filter chips (multi-select)  | `ToggleGroup`                                              |
| A boolean                    | `Switch`                                                   |
| A screen, camera, microphone | `DevicePicker`                                             |
| Buttons                      | `Button` ghost/outline/secondary; 28 px default            |
| Why a control is disabled    | `DisabledReason`, or `SegmentedControl`'s `disabledReason` |
| Locked controls              | `LockAlert` / `SessionLockAlert` / `OfflineAlert`          |
| Inline status                | `Alert` (variant brings the icon)                          |
| Nothing to show              | `Empty`                                                    |
| Status, tags, counts         | `Badge`, `StatusBadge`, `StatusDot`                        |
| Shortcut hints               | `ShortcutKeys` (draws `Kbd`), `ShortcutTooltip`            |
| Keep a window on top         | `PinWindowButton`                                          |
| Dividers                     | `Separator` or a `border-border` hairline                  |
| Scroll regions               | `PaneBody` or `ScrollArea type="scroll"`                   |
| Menus / popovers             | `DropdownMenu` / `Popover` on `glass-float`                |
| Toasts                       | `toast` from `lib/toast.ts`; type colours the icon         |
| Audio levels                 | audiocn LCD meter in `--primary` ink (`MicLevelMeter`)     |
| Audio controls               | audiocn controls in Sources rows (`SourceItem`)            |

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
- DON'T use `backdrop-filter` outside `glass-float`, `bg-popover`,
  `cursor-pointer`, raw colour literals, or ad-hoc radii and pills.
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
