---
name: videorc-design
description: Videorc's UI design language — a native macOS desktop app on real window glass (vibrancy), built exclusively from shadcn/ui components: flush panes, toolbars, grouped lists, glass chips, and a Raycast-style ⌘K palette. Use whenever building, styling, reviewing, or planning ANY Videorc UI (new components, screens, dialogs, lists, toolbars, badges), when the user mentions "our design", "the design skill", "glass", "native look", or asks how something should look.
---

# Videorc Design Language (v2: the window family)

The single source of truth for how Videorc looks and feels. Every UI task
follows this skill. Videorc is a desktop app, not a web page: every window
sits on the real macOS window material, panes are flush and split by
hairlines, controls are desktop-sized, and colour is information. The
reference is the Videorc logo: a glossy black-glass orb with chrome detail and
one LED-red accent. Light mode is the porcelain twin of the same structure.

**Status: shipped in plan 050 (2026-09-23).** `styles.css` implements the
tokens below. `src/main/window-glass.ts` gives every window (main, Stream Manager,
Captions, Notes, Preview) its material and title bar. The Preview frame's
data-URL document mirrors the coats through `src/main/window-palette.ts`, and
a parity test fails when they drift. Fix tokens and primitives, never restyle
a screen ad hoc.

## Hard rules

1. **shadcn/ui only.** Every element is a shadcn/ui component or a composition
   of them, installed and customized per the `shadcn` skill. No other
   component libraries and no hand-rolled widgets when a primitive exists.
2. **Real glass, never fake glass.** The OS draws the blur. No CSS
   `backdrop-filter` / `backdrop-blur` anywhere in the renderer: it wedged the
   compositor in June, and a guard test fails on it. No wallpaper underlays,
   no inline `color-scheme` on the root.
3. **Dark first, light supported.** Dark is the reference. Light is the same
   structure with the light token column, never a separately designed theme.
4. **Colour is information.** Chrome is monochrome. Saturated colour appears
   only in source/platform icons, status dots, and emphasis chips: red for
   record, live, and destructive; green for healthy; amber for attention.
   Never tint panels, rows, or text decoratively.
5. **Keyboard-first, quietly.** Primary actions show their shortcut as a key
   chip. Global hints live in the status bar, not on every surface.

## The window family

Every window uses one material and one title-bar recipe (`window-glass.ts`):

- **Material.** `vibrancy: 'under-window'`, with the effect state pinned
  to `active` so glass stays glass when the window is inactive.
  `VIDEORC_GLASS=0` paints the solid palette instead.
- **Title bar.** `titleBarStyle: 'hiddenInset'`. Traffic lights are centred
  in the header row, which is 40 px (28 px for Preview). A header row shares
  its line with the lights: it pads `pl-[88px]` through
  `useTrafficLightGutter()`, which drops to `pl-3` in native fullscreen.
  Header rows are drag regions, and their controls opt out with
  `[-webkit-app-region:no-drag]`.
- **Dark-always windows.** Stream Manager, Captions, Notes, and Preview frame video or
  sit beside it, so main pins their NSWindow appearance to `darkAqua` through
  the native addon. A light main window never lightens them. If the pin is
  unavailable, they fall back to solid dark.
- **Coats.**
  - `body` paints `--glass-window`, the one window coat.
  - A content pane adds `--glass-content`, so the sidebar reads lighter than
    content.
  - Single-pane windows wrap their body in `WindowFrame`.
  - Never stack a third coat.
- **Accessibility.** `prefers-reduced-transparency` swaps both coats for
  `--glass-solid`. `prefers-contrast: more` thickens the coat and strengthens
  hairlines, chip rims, and the secondary text tier.
- **Proof.** `pnpm probe:ui-glass --gate` measures every window over
  stand-in backdrops: transmission (the glass is real), sharpness (nothing
  behind is legible), contrast, pinned-dark luminance, and the native effect
  view state. It runs in `smoke:local-gates`.

## Tokens

Implemented as shadcn CSS variables in
`apps/desktop/src/renderer/src/styles.css` (oklch; that file is the live
source). Values below are dark · light.

Coats and surfaces

- Window coat `--glass-window`: black `oklch(0.13 0.003 286 / 42%)` ·
  porcelain `oklch(0.985 0.001 286 / 60%)`.
- Content coat `--glass-content`: 34% · 30% of the same base.
- Solid `--glass-solid`: `#0D0D0F` · `#FAFAFB`.
- Floating surfaces (`bg-popover`, `bg-card`): near-opaque, 92%. Only
  dialogs, menus, selects, popovers, tooltips, toasts, and the palette float.

Text (three tiers, nothing else)

- Primary `text-foreground`: titles and labels, weight 500–600.
- Secondary `text-muted-foreground`: inline context, metadata, placeholders.
- Tertiary `text-subtle`: section labels, hints, disabled.

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
- Use them through the tone utilities (`tone-success`, `tone-warning`,
  `tone-destructive`, `tone-live`, `tone-neutral`) and the chip utilities.
  Never as text colour on status copy.

## Desktop scale

Everything except ⌘K uses the desktop scale.

- **Layout.** There is no page column: content fills its pane edge to edge
  with a 16 px gutter. Panes are flush and split by 1 px hairlines. Inside a
  window there are no floating panels, no shadows, and no big cards.
- **Toolbar** (`Toolbar`, 40 px): the page title (14 px / 600) on the
  window's drag band, and nothing else. No buttons in the toolbar's top-right
  corner (owner call, 2026-09-23): actions live with the content they act
  on. The Studio's Record / Stream / Stop and clock sit at the top of its
  inspector, right above Session; a page's own actions sit in its body (a
  filter bar, a section header, or the PageHeader row). The toolbar never
  scrolls; only `PaneBody` does.
- **Sidebar.**
  - The top row holds the traffic lights and the ⌘K button. Windows has no
    traffic lights, so there the row leads with the app icon (16 px) and
    "Videorc" in 12 px regular, the Windows 11 title-bar convention.
  - Section labels are 11 px / 600, tertiary.
  - Rows are 28 px, with 14 px text and 16 px icons.
  - The account row sits at the bottom. On macOS the brand lives in About
    and the Dock, never in the sidebar (owner call, 2026-09-23).
- **Status bar** (`StatusBar`, 26 px): connection and record/live state on
  the left. On the right, quiet 11 px shortcut hints, each still clickable:
  `⌘K Search`, `⌘P Preview`, `⇧⌘N Notes`, `⇧⌘J Stream Manager`.
- **Sections** (`PanelSection`): flush. A 13 px / 600 header, a 12 px
  secondary description, a hairline between sections, and 16 px padding. No
  border, background, radius, or shadow.
- **Lists, not card stacks.** Sets of like things (destinations, sources,
  devices, settings) are one `GroupedList` of `ListRow`s: 32 px rows (28 px
  compact) with hairline separators. Cards remain only for objects with a
  picture (scene thumbnails, library items): 8 px radius, white 4% fill, a
  1 px hairline, no shadow.
- **Radii.** Tiers only, never ad-hoc radius values per screen:
  - `rounded-panel`: 12 px. Containers and dialogs.
  - `rounded-row`: 8 px. Rows and cards.
  - `rounded-chip`: 6 px. Controls and key chips.
  - Tags use 7 px. Status chips are round.
  - Window corners belong to the OS.
- **Controls.** The default height is 28 px for Button, Select trigger, and
  Input. Retune it once in `components/ui`, never per screen. Segmented
  choices use `Tabs`, a glass segmented control.
- **Type.** The system stack (SF Pro). Body 14 px, metadata 12 px, section
  labels 11 px. Density comes from structure, not from smaller text.

## Stream Manager

The live dashboard window (plan 053; code name `comments`, the old Chat
window). It follows the window family and adds its own layout rules.

- **Tiers by container query.** The body is `@container/stream-manager`,
  never JS resize state (`lib/stream-manager-layout.ts`):
  - Wide (1,040 px and up): the stats strip, then Chat beside a right pane
    with an Activity / Orcle segmented control.
  - Medium (640 to 1,039 px): a compact strip (Session, Viewers, Followers,
    Health), then one pane behind Chat / Activity / Orcle.
  - Narrow (under 640 px, 320 minimum): a one-line summary above the same
    segments.
  - Every pane renders once; only its placement changes.
- **The title row carries the title only.** Controls live in the status bar:
  each provider's chat state on the left; Keep on top, Highlight, Clear view
  and Open Preview on the right. They drop to icons under 800 px and fold
  into ⋯ under 640 px.
- **Stats are flush cells split by hairlines,** never cards. Numbers are
  monochrome and tabular. Tone lives in dots and chips, and the ON AIR chip
  is the only emphasis.
  - Sparklines use the shadcn `chart`, neutral unless the tile warns.
  - Per-platform splits open in a `HoverCard`.
- **Never an unmeasured zero.** A tile exists only when its source does, and
  an unreadable number shows "–" with the reason ("Reconnect X to show
  followers."). The viewer count is never hidden while live.
- **Chat keeps the big-text rows** (decision 5), virtualized with
  `@tanstack/react-virtual`. Filters are inline chips from 640 px and one
  Filters menu below it.
- **Activity rows** use the platform tile with the event glyph (the
  window-scoped registry `components/stream-manager/activity-icons.tsx`), a
  one-line fact, the viewer's words, and a ⋯ menu.
- **Proof.** `pnpm probe:comments-window` sweeps 320/480/640/800/1040/1280
  and fails on any overflow, a hidden viewer count, a button in the title
  row, or an unreachable control.

## ⌘K palette scale

The command palette alone keeps the Raycast scale:

- `rounded-panel` glass on `bg-popover`.
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
- **Tag** (`Badge` outline): 20 px, 7 px radius, 11 px, secondary text. For
  `9:16`, counts, `Idle`, `beta`.
- **Status** (`Badge` success/warning/neutral, `StatusBadge`,
  `StatusDot`):
  - Monochrome text. A 6 px dot in the tone colour carries the status, with
    a 2 px halo and a soft glow.
  - A leading icon replaces the dot and takes the tone.
  - `StatusBadge` is 22 px and fully round.
- **Emphasis** (`Badge` destructive/live, an error `StatusBadge`): tinted
  glass, a tone gradient with a tone rim and tone-mixed text. Only for
  failed, on air, and destructive.
- **Key chip** (`Kbd`): a glass keycap with a brighter top edge and a dark
  bottom edge.
- No `backdrop-filter`, no motion, no ad-hoc pills. A rounded, bordered
  `text-[10–12px]` span is a bug: use `Badge`.

## Floating surfaces

Dialogs, popovers, menus, selects, tooltips, toasts, and the palette are
near-opaque `bg-popover` surfaces with one soft shadow and a hairline ring.

- Dialogs: 12 px radius, `p-5`.
- Menus, selects, and popovers: 10 px radius. Menu items are 28 px with a
  6 px radius, concentric inside the 4 px inset.
- Tooltips: a small glass popover (8 px radius, 12 px text), never an
  inverted pill. They open after about 600 ms.
- `Alert`: a flush inline status row (a faint tone tint, the icon in the
  tone, monochrome text), never a card.
- `Empty`: short tertiary text, centred, no dashed box and no illustration.

## Native feel

- `html` sets `user-select: none`, `cursor: default`, and
  `overscroll-behavior: none`. Content opts back in with `select-text`:
  chat messages, notes, transcripts, logs, and inputs. Images are not
  draggable.
- Editable fields get the native context menu (Cut, Copy, Paste, Select All,
  spelling), which main builds on `context-menu` (`main/context-menu.ts`).
  Notes has none: a popup menu is not capture-protected.
- `renderer-style-guards.test.ts` fails on backdrop blur, `cursor-pointer`,
  or a colour literal outside its short content allowlist.
- macOS overlay scrollbars: no custom scrollbar recipe. Radix `ScrollArea`
  uses `type="scroll"`.
- Rows highlight instantly. No `cursor-pointer`: desktop controls use the
  arrow.

## Windows

- Windows 11 22H2+ (build ≥ 22621): `backgroundMaterial: 'mica'` on the
  main window, with its own coats (`[data-platform='win32']` in styles.css).
  Mica tints from the wallpaper without a live blur, so it stays cheap on
  low-end iGPUs. Stream Manager, Captions, Notes, and Preview stay solid dark: Windows
  has no per-window appearance pin.
- Windows 10 and older builds use the solid palette.
- The D3D11 preview window and the proof surface stay opaque.
- Windows-only chrome uses the `win32:` variant (`hidden win32:flex`). It
  keys on the `data-platform` attribute that `theme-bootstrap.js` sets before
  the first paint, so it never waits for runtime info and never pops in.

## Icons

- The app icon (`assets/videorc-logo.png`) carries its own rounded tile and
  transparent margin: no mask, no shadow. It appears in Settings → About
  (64 px, beside the name, version, and release-track tag), in the Windows
  sidebar top row (16 px), and in first-run onboarding. Nowhere else.
- App/source icons: 24 px rounded-square (radius about 6), vivid, full
  colour. They are the only large colour on screen.
- Inline and status icons: 16 px, secondary gray unless conveying status.
- **Import every icon from `@/components/icons`, never from an icon
  package.** The registry names icons by meaning (`SourcesIcon`,
  `AlertIcon`, `RecordIcon`), and `no-restricted-imports` enforces it.
  Before adding a slot, check whether one already means the same thing: the
  set is licence-counted (100 glyphs). `docs/icon-set.md` holds the licence
  terms, the build pipeline (`pnpm icons:build`), and the semantic audit.

## Motion

Fast and subtle: 100–150 ms ease-out. Floating surfaces fade and scale from
0.98. Rows highlight instantly. Nothing bounces, and chips never move.
`prefers-reduced-motion` collapses motion.

## Toast discipline

Toasts are for news the interface does not already show, never for
confirming a routine interaction the user just watched succeed.

- **Never toast success for scene, layout, or source changes.** The
  stage/preview is the confirmation (owner call, 2026-07-16: "no green
  popups on every small thing"). This includes live layout applies, preset
  clicks, and source device switches.
- Success toasts are reserved for:
  - async work that finishes out of view (recording saved, import complete,
    publish pack generated)
  - destructive confirmations (deleted)
  - account-level side effects (connected, authorized)
- Warnings and errors always surface. Silence is only for the expected
  outcome.
- When in doubt, don't toast. A user mid-flow reads every popup as an
  interruption.

## shadcn component mapping

| Need                      | Use                                             |
| ------------------------- | ----------------------------------------------- |
| Page chrome               | `Pane` + `Toolbar` (title only) + `PaneBody`    |
| Page sections             | `PanelSection` (flush)                          |
| Sets of like things       | `GroupedList` + `ListRow`                       |
| Objects with a picture    | Cards (8 px, hairline, no shadow)               |
| Global state and hints    | `StatusBar`                                     |
| Palette / searchable list | `Command` (+ `CommandDialog`), palette scale    |
| Modals and confirmations  | `Dialog`                                        |
| Segmented choice          | `Tabs` (glass segmented control)                |
| Buttons                   | `Button` ghost/outline/secondary; 28 px default |
| Status, tags, counts      | `Badge`, `StatusBadge`, `StatusDot`             |
| Shortcut hints            | `Kbd`                                           |
| Dividers                  | `Separator` or a `border-border` hairline       |
| Scroll regions            | `PaneBody` or `ScrollArea type="scroll"`        |
| Menus / popovers          | `DropdownMenu` / `Popover` on `bg-popover`      |
| Toasts                    | sonner on the same popover tokens               |

Missing a primitive? Install it through the shadcn CLI (see the shadcn skill);
do not hand-roll it.

## Do / Don't

- DO keep chrome monochrome. Let source icons, status dots, and preview
  content provide the colour.
- DO build screens from panes, toolbars, sections, and grouped lists.
- DO use one shared row component for every icon + title + meta list.
- DON'T put cards on cards, shadows inside a window, or `rounded-panel`
  boxes around page content.
- DON'T use `backdrop-filter`, `cursor-pointer`, raw colour literals, or
  ad-hoc radii and pills.
- DON'T add a font, a component library, or a direct icon-package import.
