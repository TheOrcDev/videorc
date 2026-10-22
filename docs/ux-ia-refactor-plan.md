# UX / IA Refactor Plan

Owner ask (2026-06-13): rethink every page, where it lives, and how users
reach it; decide what lives in the sidebar; reorganize the Studio accordions;
cap the sources diagnostics height. Design language: `.claude/skills/
videorc-design` (Raycast-style glass, keyboard-first, monochrome chrome).

Inventory baseline: 9 full pages + Screens bolted under Layouts, 6 accordions
on Studio, 5 controls duplicated across 2+ surfaces, Diagnostics reachable
only via ⌘K, sources diagnostics list unbounded
(`sources-tab.tsx:449-467`).

> **Where things stand (plan 174, 2026-10).** This is the 2026-06 plan. The
> app has moved on, and this note wins where the two differ. The design
> skill's "Where things live" (`.claude/skills/videorc-design/SKILL.md`)
> keeps the current map.
>
> - **Sidebar**: Studio ⌘1, then Buddy ⌘9 directly under it (owner call
>   2026-10-10: the page sells Premium and keeps Clean cut, so it never
>   moves), then Setup (Sources ⌘2, Scene ⌘3, Assets ⌘4, Livestream ⌘5,
>   Captions ⌘6, Output ⌘7), Library ⌘8, and Settings ⌘, in a bottom block.
>   Health has no row: the status bar's state opens it.
> - **Devices**: Sources is the home of every screen, window, camera,
>   microphone and system audio source. Studio mirrors the few needed
>   mid-session, editing the same state: its Sources section (Screen,
>   Camera, System audio, with Open Sources) and its Microphone section
>   (picker, level, mute).
> - **Takeovers** (the "Screens" below) live on the Assets page, Assets →
>   Takeovers, which manages them; Studio's Takeover section puts one on stream.
>   They never moved to the Scene page.
> - **Space** works only on the Studio page: Record when idle, Stop recording
>   while recording, and the End livestream confirmation while live, with
>   "Keep streaming" focused. It never starts Go Live (plan 174 D1).
> - **Names**: Destinations became Livestream, Recording became Output, AI
>   became Buddy, and the live chat rail became the Stream Manager window
>   (⇧⌘J).

## The organizing idea

**Studio is a stage, not a settings hub.** Everything in the app falls into
one of four zones, and the sidebar mirrors them exactly:

1. **Stage** — the live surface. Preview, transport, on-air state, and the
   few controls you genuinely need _mid-session_ without leaving the stage.
2. **Setup** — pages you configure between sessions. Each owns its domain
   exclusively.
3. **After** — everything post-session: files, repair, AI.
4. **System** — app config and health.

Two laws make the UX coherent everywhere:

- **One home per control.** Every setting has exactly one owning page.
  Anywhere else it appears as a _summary chip_ that shows state and
  deep-links to the home. This dissolves all five duplications (layout
  presets ×2, audio mixer ×2, preview ×2, screens ×3, presets-as-defaults).
- **Bounded panels.** Any list that can grow (devices, logs, artifacts,
  metrics) lives in a `ScrollArea` with a max height and a count in its
  header. Pages never scroll because a diagnostic list pushed them down.

## Sidebar (the answer to "what lives there")

_Historical: the shipped sidebar is in "Where things stand" above._

Sectioned list per the design language (tertiary-gray labels, 8px-radius
rows, kbd chips right-aligned). The "Studio is a page AND a group" confusion
dies: Studio is one row; SETUP is its own labeled group.

```
[Brand header]
Search                              ⌘K

Studio                              ⌘1     ← the stage; no children

SETUP
Sources                             ⌘2
Scene                               ⌘3     (was "Layouts"; absorbs Screens)
Destinations                        ⌘4     (was "Live")
Output                              ⌘5     (was "Recording"; loses artifacts)

LIBRARY
Library                             ⌘6
AI                                  ⌘7

SYSTEM
Settings                            ⌘8 (also ⌘,)
Health                              ⌘9     (was "Diagnostics"; NEW in sidebar)

[footer: status dot → clicks through to Health · refresh · theme]
```

Renames are label-level only — internal ids (`live`, `recording`,
`diagnostics`) and `data-videorc-tab-trigger` legacy ids stay, so smokes and
deep links keep working. Rationale: "Live" named a config page after a
session state; "Recording" collided with the act and the artifacts;
"Diagnostics" hid an actionable page behind jargon. (Naming is taste —
flagged as an approval point at the end.)

Keyboard map (app-shell global): `⌘1–⌘9` pages as above, `⌘P` preview
window (exists), `⌘K` palette (exists), `D` theme (exists), `Esc` dismiss.
The palette mirrors every sidebar entry plus actions; nothing is
palette-only anymore. `Space` is not app-wide any more (plan 174 D1): it
works only on the Studio page, where it records when idle, stops a
recording, and while live opens the End livestream confirmation. It never
starts Go Live, and it yields to a focused control, an open dialog or menu.

## Page-by-page

### 1. Studio — the stage (biggest change)

Delete all six accordions. The page becomes three fixed bands:

1. **Preview** — dominant, top. The only preview users _watch_ (Scene owns
   the preview users _edit_).
2. **Transport bar** — status dot + elapsed, Record (Space), Go Live, Stop,
   output target line, preview-health badge. Kept from today's action bar,
   minus the embedded layout-preset grid.
3. **Session strip** — ONE row of compact stateful chips replacing every
   accordion. Chip anatomy = design-language row in miniature: 16px icon,
   primary label, secondary state text, optional status dot. Click = jump to
   the owning page. At most one _inline_ affordance per chip — only for
   things needed mid-session:

   | Chip         | Shows                                         | Inline affordance                     | Click target       |
   | ------------ | --------------------------------------------- | ------------------------------------- | ------------------ |
   | Source       | screen · camera · mic names                   | —                                     | Sources            |
   | Mic          | mic name + mute state                         | mute toggle                           | Sources            |
   | Layout       | active preset name                            | popover: 4 presets (live-safe switch) | Scene              |
   | Takeover     | active Screen or "—" (hidden if none exist)   | popover: pick/clear Screen            | Assets → Takeovers |
   | Destinations | per-target chips (exist today)                | —                                     | Destinations       |
   | Output       | "MP4 · 1440p30 · ~/Movies/…" or "stream-only" | —                                     | Output             |

4. **Live chat** — not an accordion: a collapsible right rail that exists
   ONLY while a session with chat-capable destinations is live (`⌘J`
   toggles). Off-air, Studio has no chat surface at all.

What leaves Studio entirely: the audio mixer accordion (Sources owns gain/
sync/meter; the chip keeps mute + level), the screens accordion (chip
popover), the output-status accordion (the six summary rows move to Health;
the chip keeps the one-line answer), the scene accordion (chip).

The Go Live dialog is unchanged — it is already the right pattern
(pre-flight + metadata at the moment of commitment).

### 2. Sources — unchanged scope, bounded diagnostics

Keeps its 2026-06-10 charter: the home for screen/window, camera,
microphone, and the full mixer (gain, sync offset, meter, check-mic). It is
the home, not the only place: Studio's Sources and Microphone sections
mirror the devices needed mid-session and edit the same state.

The owner's explicit fix — the device diagnostics block:

- Becomes a `Collapsible`, **default closed**, header
  `Device diagnostics · 12` with a problem-count badge when any device is
  in a permission/error state.
- Content wraps in `ScrollArea` with `max-h-72` (≈6 rows visible), so even
  expanded it can never push the page down arbitrarily.
- Nothing critical hides: permission problems already surface in the
  warnings `Alert` at the top of the page; the collapsed list is forensics,
  not status.

### 3. Scene (was Layouts) — absorbs Screens, owns composition

- Canonical home of: layout presets, scene source list + transforms +
  nudge controls, camera framing (corner/size/shape/fit/mirror/margin/zoom/
  pan), and the **editing preview** (drag transforms — functional, not
  duplicative; Studio watches, Scene edits).
- **Screens become a section of this page** ("Screens" header + the
  existing tile grid), ending the stacked double-page render in
  `app-shell.tsx:135-140` and the third copy inside Studio. Takeover images
  replace the screen source — they are scene content; this is their home.
  _Not built this way: takeovers live on the Assets page (Assets →
  Takeovers), and Studio's Takeover section puts them on stream._
- Camera framing controls regroup into two labeled clusters ("Placement":
  corner/size/shape/margin · "Lens": fit/mirror/zoom/pan) so related
  ToggleGroups stop reading as a scattered pile.

### 4. Destinations (was Live) — rows, and the three jobs separated

Today one 1,438-line page renders mega-cards doing auth + credentials +
metadata each. Restructure into the design language's master pattern:

- **Destination list** — one row per target (24px platform tile, label,
  account in secondary gray, status badge, enable `Switch`). Rows follow
  the shared row component; the colored platform tiles are the page's only
  saturated color, per the language.
- **Row detail** — expanding a row reveals ONLY auth + credentials (OAuth
  connect/disconnect, manual key entry, key-save dialog). One job.
- **Broadcast info** — its own titled section (global title/description/
  privacy + per-platform overrides), no longer interleaved with credential
  cards. Also still editable in the Go Live dialog.
- **Readiness** — stays as the right-column checklist; it earns its place.

### 5. Output (was Recording) — settings only

- Keeps: record-to-file toggle, preset selector, resolution quick presets,
  width/height/fps/bitrate.
- **Loses the artifacts list** — sessions/files have exactly one home:
  Library. The Export-MP4 action already exists on Library rows; the
  duplicate grid here goes away.

### 6. Library — the single home of sessions

- Absorbs artifact/export duty exclusively (from Output).
- Repair stops being a buried two-step: each row shows its known repair
  state proactively; "Check quality / Repair / Restore" collapse into one
  right-aligned actions `DropdownMenu` per row, leaving rows single-line
  per the row pattern.

### 7. AI — unchanged

Already coherent (session picker → artifacts). Reached from sidebar ⌘7 and
per-session from Library. _Now the Buddy page, second in the sidebar on ⌘9;
Clean cut is its last tab._ The consent panel stays — it is a real decision,
not noise.

### 8. Health (was Diagnostics) — into the sidebar, grouped

- Joins SYSTEM in the sidebar (⌘9); the footer status dot deep-links here.
  _Superseded: Health left the sidebar (plan 174 D9). The status bar's
  state is its door, with "Open Health" on degraded alerts and error
  toasts, and Settings → About._
  An actionable page (permission warnings live here) must not be
  palette-only.
- The 50+ flat metrics regroup into collapsible sections with the summary
  badges pinned on top: **Verdicts** (bottleneck, health badges) ·
  **Pipeline** · **Preview** · **Sources** · **Encoder** · **System**.
  Sections default closed except Verdicts and whatever is currently
  unhealthy. Logs keep their existing bounded ScrollAreas.

### 9. Settings — unchanged scope

Paths, ffmpeg, defaults, theme, permissions shortcuts, onboarding replay.
Gains `⌘,` (macOS convention) alongside ⌘8.

### Secondary surfaces

- **Detached preview window (⌘P)** — unchanged; it is the multi-monitor
  answer and the footer already advertises it.
- **Onboarding** — unchanged flow; its "recommended tab" targets update to
  the new names.
- **Footer action bar** — keeps Search ⌘K + Preview ⌘P; the left slot shows
  the current page name as today (context actions per page can come later —
  out of scope here).

## Route map (every way to reach every page)

_Historical: the shortcuts and names below are the 2026-06 plan. See "Where
things stand" at the top._

| Page         | Sidebar | Kbd   | Palette | In-app paths                                              |
| ------------ | ------- | ----- | ------- | --------------------------------------------------------- |
| Studio       | ✓       | ⌘1    | ✓       | everywhere "back to stage"                                |
| Sources      | ✓       | ⌘2    | ✓       | Studio Source/Mic chips · device toasts                   |
| Scene        | ✓       | ⌘3    | ✓       | Studio Layout/Takeover chips                              |
| Destinations | ✓       | ⌘4    | ✓       | Studio destination chips · Go Live dialog resolve buttons |
| Output       | ✓       | ⌘5    | ✓       | Studio Output chip                                        |
| Library      | ✓       | ⌘6    | ✓       | post-session toast ("Recording saved → Library")          |
| AI           | ✓       | ⌘7    | ✓       | Library row "Open in AI"                                  |
| Settings     | ✓       | ⌘8 ⌘, | ✓       | Health permission warnings → Permissions                  |
| Health       | ✓       | ⌘9    | ✓       | footer status dot · preview-health badge on transport     |

## Migration slices (sized for /cut-it)

Dependency-ordered; each leaves the app working and is verified by the
existing gates (typecheck, lint, vitest, `smoke:dev`, `smoke:start-labels`,
`smoke:screens`, palette smoke) plus a `ui-theme-screens.mjs` sweep judged
by eye (per memory: smoothness/visuals are perceptual).

1. **S1 — Sidebar + shortcuts.** New groups/labels/order, Health into
   SYSTEM, ⌘1–⌘9 + ⌘, in app-shell, palette mirrors labels, footer status
   dot → Health. Ids and `data-videorc-tab-trigger` untouched.
2. **S2 — Bound the sources diagnostics.** Collapsible + ScrollArea
   max-h-72 + count/problem badges. (The owner's explicit itch — ships
   first-day.)
3. **S3 — Output sheds artifacts.** MOVE the Export-MP4 action into the
   Library row actions first (verified absent there today — Library rows
   only have Open-in-AI + repair), then delete the artifacts grid; rename
   copy.
4. **S4 — Scene absorbs Screens.** Un-stack the double render in
   app-shell; Screens become a section; framing controls regroup into
   Placement/Lens clusters.
5. **S5 — Studio de-accordion.** Session strip chips + transport cleanup +
   live-only chat rail (⌘J). Largest slice; lands after S2–S4 so every
   chip has a real home to link to.
6. **S6 — Destinations restructure.** Row list + detail expansion +
   separated Broadcast info section.
7. **S7 — Health regroup.** Sidebar entry exists since S1; this slice does
   the metric sections + verdict pinning.

## Approval points — RESOLVED (auto-grill, 2026-06-13)

Owner delegated these to best judgment consistent with the design language;
all four recommendations adopted:

1. Labels: **Scene**, **Destinations**, **Output**, **Health** — adopted,
   label-only (ids and `data-videorc-tab-trigger` stay).
2. Live chat: **live-only right rail**, ⌘J toggle, auto-opens on go-live
   when a chat-capable destination is enabled. `LiveChatPanel` is already a
   self-contained component (snapshot + onClearLocal props) — rehosting is
   presentation-only.
3. ⌘1–⌘9 ordering as specified (Studio first, system last).
4. Layout chip quick-switch popover — adopted as the one deliberate
   exception to "one home per control".

## Grill resolutions (auto-grill, 2026-06-13)

Questions stress-tested against the code; corrections applied above:

- **Mic chip cannot show a live level** — the meter is on-demand sampling
  (`audio.meter.sample` request via the Check-mic flow, `use-studio.tsx:2757`),
  not a continuous stream. Chip shows name + mute only; the on-demand meter
  stays in Sources. A persistent live meter would need new backend work —
  out of scope, noted as a future option.
- **Library lacks Export-MP4 today** — the action lives only on the Output
  (Recording) artifacts grid. S3 moves it into Library rows before deleting
  the grid (corrected in S3).
- **⌘1–⌘9 / ⌘, are conflict-free** — the app ships Electron's default menu
  (no custom Menu in `main/index.ts`), which binds neither; the app-shell
  already owns a renderer keydown handler (⌘K/⌘P pattern at
  `app-shell.tsx:75-88`) that the new bindings extend.
- **`smoke:screens` drives the backend protocol, not the UI** — moving the
  Screens grid into the Scene page does not touch it; `smoke:start-labels`
  asserts Start-button text, untouched by the renames.
- **Sidebar flattening is presentation-only** — `STUDIO_PANELS`,
  `legacyTabId` data attributes, and the workspace-nav context survive
  unchanged, so existing smokes and deep links keep working (the
  "panels are full pages" decision of 2026-06-09 is preserved).
- **Takeover popover replicates an existing live-safe action** — the Studio
  screens accordion already switches takeovers mid-session; management
  (upload/rename/delete) stays session-locked on the Scene page exactly as
  the Screens tab behaves today. _Now on the Assets page (Assets →
  Takeovers)._
