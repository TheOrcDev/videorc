# Plan 235: A tidy Studio

The owner's ask (2026-11-14, with a screenshot of the Studio on 0.25.x):
"We need to make our studio nice and tidy." Nine changes to the main window,
plus one bug in the stage:

1. Remove the Ready badge above Record and Go Live: it takes space and says
   little.
2. "Go Live…" loses its three dots: "Go Live" with its icon.
3. The Studio inspector's section titles go (Session, Audio, Sources): the
   rows already say what they are.
4. "Open Sources" becomes a cog: one small button that opens Sources.
5. Buddy's sidebar row gets a different, quieter icon instead of the
   streamer's own Buddy picture.
6. The Studio row becomes the sidebar's big, shiny button, like Record.
7. Livestream and Buddy move into their own sidebar group, "Livestream".
   The Livestream page needs a better name (owner's idea: "Connections").
8. Page hotkeys run in order down the sidebar, ⌘1, ⌘2, ⌘3 and so on (today:
   Studio ⌘1, then Buddy ⌘9).
9. Assets: a background clicked while the scene is camera-only and the green
   screen is off shows nothing. It should frame the camera, the way it
   frames a shared screen.

## Status and scope

- **Status: EXECUTING 2026-11-14** (owner: "execute the entire plan and
  create a PR for each"). One PR per slice group, each built in its own
  worktree from `origin/main` `2ba6b232d`; this plan lands in the docs PR
  `plans-235-236`.
- **Owner answers (2026-11-14):** D1 a, D2 a, D3 a (with the Chat title
  going too, see D3), D4 a, D5 a, D6 a (Destinations), D8 a, D9 a (both
  canvases), D7 = icon 9, Phosphor `UserSound` ("I love icon 9").
- **Buddy becomes Sidekick in [plan 236](236-buddy-becomes-sidekick.md)**
  (owner, 2026-11-14), because speech to text hears "Buddy" as "body". This
  plan reads the row's label from `BUDDY_TAB_LABEL`, so the rename is one
  constant here. `UserSound` and the `BuddyPageIcon` slot name stay.
- Three PRs, one per slice group:
  - **PR A:** the Studio inspector (asks 1–4). Renderer only, both looks.
  - **PR B:** the sidebar (asks 5–8). Renderer, plus the View menu data that
    main reads.
  - **PR C:** a camera-only scene with a background (ask 9). Backend
    geometry on every render path, plus the shared TS mirrors.
- PR A and PR B can be built in parallel worktrees: they share only
  `retro-lcd-studio.tsx` and `session-panel.tsx`, in different lines.
  PR C does not depend on either.
- **Overlap with plan 231** (draft, PR #1345): its D8 moves the Screen row
  out of Studio's Sources and into the Scenes section. This plan's cog
  (D4 a) sits on the Camera row so that it survives that move. Whichever
  plan lands second rebases on the other. Neither changes the other's
  decision.

## What it looks like after

The sidebar (PR B):

```
 ┌───────────────────────────┐
 │ ■  Studio            ⌘1   │   chrome slab, 40 px (D5)
 └───────────────────────────┘
 SETUP
   Sources               ⌘2
   Scene                 ⌘3
   Assets                ⌘4
   Captions              ⌘5
   Output                ⌘6
 LIVESTREAM
   Destinations          ⌘7    was "Livestream" (D6)
   Buddy                 ⌘8    plain glyph (D7)
 Library                 ⌘9
 …
 Settings                ⌘,
```

The Studio inspector (PR A), top to bottom:

```
 [ ● Record  Space ]  [ ((•)) Go Live ]      no Ready row above (D1, D2)
 ───────────────────────────────────────
  ((•)) Livestream      4 destinations ›     no "Session" title (D3)
  ▢     Output           4K · 30 fps   ›
 ───────────────────────────────────────
  🎙 Microphone            ⇧⌘M   🔈       no "Audio" title
     Shure MV7+                   ⌄
     ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮
     Gain  ─────●─────     0.0 dB
 ───────────────────────────────────────
  🖥 Screen   LG HDR 4K · 3…   ⌄            no "Sources" title
              ⌃⌥H  [Hide screen]
  📷 Camera   ZV-E10M2   ⌄   ⚙              the cog opens Sources (D4)
 ───────────────────────────────────────
  CC Captions                  Off ›
  💬 Chat     Stream Manager ⇧⌘J ›
 ───────────────────────────────────────
  Takeover                         ⚙        keeps its title (D3)
  [Intro] [BRB]
```

## Decisions for the owner

Several of these change earlier owner calls in the design skill. Where they
do, it is said below. The owner made those calls, so the owner can change
them. The skill and `docs/ui-copy.md` are updated in the same PR.

- **D1. Where the session state shows once the Ready badge is gone.**
  The badge (`SessionStatusPill` in the transport's top row, with the clock
  and the "Rec" chip) repeats two things that already show elsewhere: the
  status bar (state, clock and a live region) and the sidebar's Studio row
  (dot and clock while a session runs).
  - **a (recommended):** remove the whole row in every state. The state and
    clock stay in the status bar and the Studio row. While on air, the
    status bar takes the "Rec" fact ("On air · Rec") so it is not lost.
    The "Not ready" case is already covered by the blocked-reason line
    under the buttons.
  - b: remove it only while idle, and keep the state and clock row while a
    session runs.
- **D2. Where "Go Live" drops its three dots.** `docs/ui-copy.md` uses "…"
  to mean "this opens a dialog".
  - **a (recommended):** only the Studio button and its Retro LCD twin
    (`GO_LIVE_LABEL`). ⌘K keeps "Go live…" and Upcoming keeps "Use for Go
    Live…". The ui-copy table names the Studio button as the exception
    (owner, 2026-11-14).
  - b: drop the three dots everywhere "Go Live" appears.
- **D3. Which inspector titles go.**
  - **a (recommended):** Session, Audio and Sources lose their titles,
    because their rows name themselves. Takeover keeps its title, because
    its buttons are only takeover names ("Intro", "BRB") and need it. The
    on-air Chat section keeps its title for now. Each titleless group keeps
    its name for screen readers (`role="group"` and `aria-label` on the
    `GroupedList`). Retro LCD gets the same change: its Session and Audio
    screens drop their headers (owner call: a Studio change lands in both
    looks).
  - b: same as a, but Retro LCD keeps its screen labels as part of its
    hardware look.
  - c: Takeover loses its title too, and gains a leading icon on its line.
  - **Owner (2026-11-14): "leave the takeover title, remove everything
    else."** So this is a, and the on-air Chat section's "Chat" word goes
    too. Its header keeps its Hide button, because the rows are plainly
    chat.
- **D4. Where the cog goes.** It is a 24 px ghost icon button with the
  Settings cog, tooltip and accessible name "Open Sources". With no header,
  the cog needs a row. The Sources page is one grid, so no row-specific
  deep link exists.
  - **a (recommended):** one cog at the right end of the Camera row, the
    group's last row. It is the row with room (the Screen picker already
    truncates), and plan 231 leaves Camera as the only Sources row anyway.
    Takeover's "Open Assets" becomes the same cog, so the inspector has one
    pattern.
  - b: a cog on every device row (Screen, Camera, Microphone), all opening
    Sources. This is symmetric but repeats the same button.
  - c: no visible button. Each device picker's menu ends with "Open
    Sources".
- **D5. The Studio row's look.** Today it is a 28 px row that wears the
  `chrome-plate` when it is the current page.
  - **a (recommended):** a 40 px slab in `chrome-fill`, Go Live's polished
    silver metal (black chrome in light mode), with a 20 px icon. It always
    wears the metal, because it is the way home, and its icon fills while
    it is the current page. While a session runs, it shows the clock with
    the red dot, as today. Red metal stays for Record and live only (owner
    call D8 of plan 208: "lit red only ever means record or live").
  - b: the same slab in Record's red metal (`chrome-led`). This changes the
    D8 owner call, and a red Studio button reads like a second Record
    button.
  - c: only taller, keeping the plate.
- **D6. The Livestream page's new name, under a "Livestream" group.**
  The page holds Setup (destinations and stream details), Upcoming and
  Guests.
  - **a (recommended): Destinations.** It is already the app's word
    (`CONTEXT.md`: "Destination: where a livestream goes"), and the Studio's
    own row says "4 destinations". "Connections" would also describe the
    Phone remote, the Stream Deck, agents and the Videorc account, none of
    which live on this page.
  - b: Connections (the owner's idea).
  - c: Channels. `CONTEXT.md` already uses "Channel" for the platform's own
    channel, so it would mean two things.

  Whichever name wins, ⌘K keeps "livestream", "stream key", "YouTube" and
  similar words as search aliases, so old habits still find the page. The
  page id `live`, `legacyTabId: 'streaming'`, deep links and smoke hooks do
  not change.

- **D7. Buddy's sidebar glyph.** It is a plain monochrome icon like every
  other row (regular weight, filled when it is the current page). It
  replaces `OwnBuddyIcon` in the sidebar and in ⌘K's page list. The real
  Buddy artwork stays on the Buddy page's intro, the consent dialog, the
  Stream Manager's Buddy pane and chat rows. This changes the owner call
  "BuddyIcon is the one full-colour icon" for the sidebar only.
  - Robot was recommended, and the owner turned it down (2026-11-14).
  - **Owner (2026-11-14): 9, `UserSound`**, a co-host that speaks. It was
    picked from twelve Phosphor 2.1.10 glyphs, each shown at sidebar size,
    plain and selected:
    1. StarFour
    2. ChatTeardropDots
    3. Smiley
    4. Ghost
    5. PawPrint
    6. HandWaving
    7. HeadCircuit
    8. MagicWand
    9. UserSound
    10. Alien
    11. Lightbulb
    12. Cube
  - Avoid `Sparkle`: `SparkleIcon` already marks Premium (account menu) and
    Buddy's touches in chat rows.
  - Any pick adds one slot to `icons.tsx` and one glyph to the count in
    `docs/icon-set.md`.
- **D8. Hotkeys in sidebar order.** This is the map above. The changes are
  Captions ⌘6→⌘5, Output ⌘7→⌘6, Livestream/Destinations ⌘5→⌘7, Buddy
  ⌘9→⌘8 and Library ⌘8→⌘9. Five keys move, so the release notes say so.
  The only choice is where Captions sits.
  - **a (recommended):** Captions stays in Setup. The captions are drawn
    into recordings too, not only the livestream.
  - b: Captions moves into the Livestream group (⌘7 Destinations, ⌘8
    Captions, ⌘9 Buddy, ⌘0 not usable), and Library loses its digit.
    Not recommended.
- **D9. The background around a camera-only scene (ask 9).** See the next
  section.
  - **a (recommended):** a camera-only scene with a background, and Key
    out background off, puts the camera on the same stage as a shared
    screen: 80 % by default, moved by the background's Visibility slider,
    full frame at 0. A keyed camera stays full frame over the background
    (the headline green screen case). The same rule applies on the
    vertical canvas.
  - b: horizontal only. Vertical camera-only keeps covering the canvas.

## Ask 9: why a camera-only background shows nothing

Traced on `origin/main` `2ba6b232d`:

- An Assets click (`assets-tab.tsx:264`) sends the background with
  `scene.layout.apply_preview` or `apply_live` (`use-studio.tsx:11298`,
  `:10840`). The backend puts it on the `Scene` (`scene.rs:155`). That part
  works.
- Every path draws the background over the whole canvas, then draws the
  sources. Only screen-like sources are shrunk onto the "stage":
  `scene_source_render_transform` insets a source only when
  `scene_source_uses_background_stage(kind)` is true, which is
  `Screen | Window | TestPattern` only (`scene_geometry.rs:204-231`). The
  margin is `background_stage_margin` = Visibility / 200 (0.10 by default,
  `scene_geometry.rs:179`).
- A camera-only scene places the camera at `full_frame_transform()`
  (`scene.rs:168-188`) and the camera is never staged. So the background is
  drawn and then fully covered. It shows only through keyed pixels, or as
  letterbox bars on Fit.
- No plan decided this. It came with `2532da6dd` ("Fix asset background
  recording stage", 2026-07-01). The Assets copy promises the opposite:
  backgrounds "move behind your screen and camera" (`assets-tab.tsx:216`).

**The fix (D9 a):** one rule decides whether a source sits on the stage, and
every path asks it.

- `scene_source_uses_background_stage` takes the scene's context. It
  returns true for screen-like sources, as today. It also returns true for
  the camera when the scene has no screen-like source (camera-only, both
  canvases) and the camera is not keyed (`camera_chroma_key(layout)` is
  None).
- Call sites:
  - Metal `compositor.rs:9215`
  - CPU `compositor.rs:11895`
  - D3D11 `windows_d3d11_session.rs:3639`
  - FFmpeg legacy `recording.rs:24998`
- TS mirrors:
  - `shared/scene-picture-geometry.ts:69-89`, used by the Scene canvas and
    the scene cards
  - the preview surface's own kind list, `main/index.ts:6141-6152`
- The shared fixture `protocol-fixtures/scene-picture-geometry.json` holds
  the two languages equal. Its line "the camera never sits on the stage
  margin" becomes the new cases.
- This keeps the existing guard that insets only while the background
  actually renders, so a background that fails to load never leaves a
  black ring. Fixing it in `scene.rs`'s placement instead (the smaller
  option) would lose that guard, so this plan does not.
- Out of scope: Freeform scenes (their transforms are the streamer's own),
  and side-by-side, whose camera half still runs to the canvas edge. The
  latter is noted below.

## Slices

### PR A: the Studio inspector (asks 1–4)

Owner route: UI/Product Design (fit 9). Model lane: `opus-5.5` (scoped
cosmetic UI). Read `.claude/skills/videorc-design/SKILL.md` first.

- **A1. The status row goes (D1).**
  - Remove the transport's top row (`session-panel.tsx`, the `status` slot
    and `SessionClock` in `SessionTransport`). Also drop the `status`
    prop's wiring in `studio-tab.tsx` and the Retro LCD's
    `RetroSessionStatus` (per D3).
  - Move the `data-videorc-session-status` hook to the status bar's state
    (`status-bar-session.tsx`). Update its two readers,
    `scripts/smoke-backend-resilience.mjs:143` and
    `scripts/smoke-captions-live-app.mjs:804`.
  - The status bar gains "· Rec" while on air and recording
    (`sessionAlsoRecords`).
  - Done when: no badge in either look, the status bar announces the same
    words, and both smokes still find the hook.
- **A2. "Go Live" (D2).**
  - `GO_LIVE_LABEL` in `lib/go-live-copy.ts` becomes "Go Live".
  - Update the tests that pin "Go Live…" (`session-transport.test.ts`,
    `go-live-copy.test.ts`, `lcd-panel.test.ts`,
    `studio-provider.integration.test.ts`) and
    `scripts/smoke-start-labels.mjs`.
  - Update the ui-copy table, the `CONTEXT.md` Go Live entry and the
    design skill's "Going live and stopping".
  - Done when: the copy guard (`renderer-copy-guards.test.ts`) passes with
    the new exception named.
- **A3. Titleless groups (D3).**
  - Drop `title` from Session (`session-panel.tsx:371`), Audio
    (`audio-section.tsx:244`), Sources (`quick-settings.tsx`) and the on-air
    Chat (`studio-chat.tsx:135`, the header keeps its Hide button and gets
    `aria-label="Chat"` on the section).
  - Each `GroupedList` gets `role="group"` and `aria-label`.
  - The audio `Mixer` gets `aria-label="Audio"`, because its comment says
    the heading named it.
  - Retro LCD: drop the Session and Audio `LcdPanelHeader`s, or keep them
    under D3 b.
  - `PanelSection` is a synced registry file. It is not changed: a
    titleless section already renders no header.
  - Done when: the inspector has no header rows above those three groups,
    and an axe or role check names each group.
- **A4. The cog (D4).**
  - "Open Sources" (`quick-settings.tsx:87`) becomes an icon `Button`
    (`variant="ghost"`, `size="icon-xs"`, 24 px) with `SettingsIcon` and
    `aria-label="Open Sources"`, inside a `Tooltip`, on the Camera row's
    right end. `InspectorRow` gains an optional `trailing` slot.
  - Takeover's "Open Assets" becomes the same cog in its header.
  - Retro LCD's `LcdPanelAction` "Open Sources" becomes the LCD cog.
  - Update the tests that pin the words (`quick-settings.test.ts:96`,
    `retro-lcd-studio.test.ts:290`, `command-palette.test.ts` if it reads
    the button).
  - Done when: one click on the cog opens Sources, and keyboard focus
    reaches it in order.
- **Gates (once, at the end of PR A):**
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
  - `pnpm --filter @videorc/desktop test`
  - `pnpm smoke:start-labels`
  - by eye in the dev app on an isolated profile, in **light and dark**,
    both looks (Retro LCD on and off), idle, recording and on air (a local
    RTMP sink only, never a real channel)

### PR B: the sidebar (asks 5–8)

Owner route: UI/Product Design (fit 9). Model lane: `opus-5.5`.

- **B1. Groups and the new name (D6).**
  - `workspace-nav.tsx`: Buddy leaves the `stage` group. Add a labelled
    `livestream` zone holding `live` (label "Destinations") and `ai`.
    Remove `live` from `STUDIO_PANELS` or give panels a group, whichever
    keeps `isStudioPanel` and `openStudioPanel('live')` working.
  - `sidebar.tsx` renders Setup, then Livestream, then Library.
  - Rename the page everywhere it is named: about 40 files today, found by
    `git grep -n "Open Livestream\|'Livestream'\|Livestream →"`. Examples:
    jump labels, the Stream Manager status bar, the first-run destinations
    step, `watchdog-notify.ts` and the window title.
  - Keep "livestream" where it means the broadcast (glossary). The Studio
    row "Livestream · 4 destinations" keeps its label.
  - Update `CONTEXT.md`: Livestream is the group and the noun, and
    Destinations is the page.
  - Done when: `git grep` finds no copy that names the page "Livestream",
    and every jump lands on the renamed page.
- **B2. Hotkeys in order (D8).**
  - `WORKSPACE_SHORTCUTS` follows the map above.
  - `lib/shortcuts.ts` `nav-*` accelerators and labels.
  - `shared/app-menu-items.ts` `APP_MENU_PAGE_GROUPS` follows the new
    zones, and its comment about Buddy's ⌘9 goes.
  - `sidebarOrderFor` now equals digit order.
  - Update `workspace-nav.test.ts`, `workspace-nav-menu.test.ts`,
    `sidebar.test.ts`, `command-palette.test.ts` (sidebar order) and
    `app-menu.test.ts`.
  - Done when: ⌘1–⌘9 open the rows top to bottom, and the View menu lists
    the same.
- **B3. The Studio slab (D5).**
  - In `sidebar.tsx`, the Studio row renders as its own `StudioNavButton`:
    `chrome-fill`, `h-10`, a 20 px icon, the shortcut chip and the session
    clock in the same places. `sidebar.tsx` is already on the chrome
    guard's allow list (`renderer-style-guards.test.ts`).
  - Check contrast: the label keeps 4.5:1 on the fill in both themes.
  - Done when: it reads as the main button in light and dark, with the
    clock visible while recording.
- **B4. Buddy's glyph (D7).**
  - Add a slot `BuddyPageIcon` (Phosphor `UserSound`) to `icons.tsx`, and
    update `docs/icon-set.md`'s count. The slot is named by its meaning,
    the Buddy page, so a later rename of Buddy keeps the slot.
  - The sidebar and ⌘K's page row use it, and `OwnBuddyIcon` leaves both.
    `OwnBuddyIcon` stays for the places that show the art.
  - Done when: `renderer-buddy-name-guard.test.ts` and the icon count
    tests pass.
- **B5. Owner calls, written down.** In the design skill:
  - "Buddy stays second … on ⌘9" becomes the new group, with Buddy keeping
    every feature (the page still sells Premium).
  - The Icons section's sidebar line changes.
  - The Desktop scale section's sidebar map (`SKILL.md:377-379`) follows
    the new order.
  - The `.agents/skills/videorc-design` copy changes too (it mirrors this
    skill for Codex).
- **Gates (once):** the same TS gates as PR A, plus by eye in both themes
  with ⌘ held (the chips cascade top to bottom).

### PR C: a camera-only scene with a background (ask 9)

Owner route: Implementation, then recording-studio gates (fit 9). Model
lane: `fable-5.1`, because it is recording output on four render paths
plus TS mirrors. Read AGENTS.md "Recording Studio Regression Rules" first.

- **C1. The rule and its fixture.**
  - `scene_geometry.rs`: the stage rule takes the scene context (per the
    fix above).
  - Fixture cases:
    - camera-only plus a background: staged
    - plus Key out background: full frame
    - Visibility 0: full frame
    - vertical camera-only: staged (D9 a)
    - picture-in-picture: the camera unchanged
  - Done when: the Rust and TS fixture tests both pass on the new cases.
- **C2. Every path asks it.**
  - Metal, CPU, D3D11 and the FFmpeg legacy call sites, and the TS mirrors
    in `shared/scene-picture-geometry.ts` and `main/index.ts` (the preview
    surface).
  - Update the tests that pin today's geometry:
    - `scene.rs:1713` `camera_only_scene_is_full_frame_camera` (it stays
      true without a background)
    - `compositor.rs:24132` (it asserts the camera is never inset)
    - `recording.rs:48756`, `:49034`
    - `scene_geometry.rs:1524`
    - `shared/scene-picture-geometry.test.ts:90`
    - `transform-fields-math.test.ts:168`
  - Add a CPU and Metal parity case for the staged camera.
  - Done when: CPU and Metal agree pixel for pixel on the staged camera.
- **C3. What the streamer sees.**
  - The Scene page canvas and the scene cards draw the staged camera
    through the shared geometry.
  - The Assets copy stays: it is now true.
  - Done when: by eye in the dev app, the "Head" scene with a background
    shows the background around the camera in the Preview, the scene card,
    a recording and a local RTMP sink.
- **Gates:**
  - `cargo fmt --check --all`
  - scoped `cargo test -p videorc-backend` filters (scene_geometry, scene,
    compositor background), through `pnpm cargo:slot` in one hold
  - `cargo clippy -p videorc-backend --all-targets -- -D warnings`
  - `pnpm test:scripts`, the desktop tests
  - `pnpm smoke:recording-studio` (required: layout composition and
    recording output)
  - `pnpm smoke:scene-presets`
  - Windows D3D11: the pinned Windows CI test, plus `smoke:recording-studio`
    on a Windows box if one is free. Otherwise the PR says why.

## Also seen, not in this plan

- Side by side with a background: the screen half is staged, but the camera
  half still runs to the canvas edge, so the frame is lopsided. Worth its
  own small plan once D9 lands.
- The Retro LCD's Chat stays on the default look (plan 204). Nothing here
  changes that.

## Handoff

- Goal: the nine asks above, in three PRs, with the owner's D1–D9 answers
  (or the recommended ones on "start").
- State:
  - The plan is in `~/projects/videorc-wt-235` (branch
    `plan-235-tidy-studio`, uncommitted).
  - Facts are from `origin/main` `2ba6b232d`.
- Each PR builds in its own worktree from `origin/main`, never in the
  shared checkout.
- PR A and PR B run in parallel. PR C runs alone in the Rust build slots
  (≤ 1 backend test or clippy build at a time).
- Out of scope: plan 231's Scenes changes, Freeform scenes, side by side
  with a background, and any change to Buddy's features.
