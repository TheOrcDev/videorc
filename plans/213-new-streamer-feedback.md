# Plan 213: a new streamer's feedback

> **Executor instructions**: This plan is ten workstreams (A to J), one PR
> each. Pick a workstream from "Order of work", follow its slices in order,
> and run every "Done when" check before moving on. If anything in "STOP
> conditions" happens, stop and report; do not improvise. When a workstream
> is done, update this plan's row in `plans/README.md` and fill in its "As
> built" line. Gates run once at the end of each workstream (owner rule):
> write and commit its slices first, then run its gate. A slice marked
> **red first** must be seen failing on the base before the fix starts.
>
> **Drift check (run first)**: `git diff --stat d3bac98c..origin/main --`
> plus the paths listed under your workstream. If an anchor quoted below has
> moved, re-find it by the symbol name. If a _behaviour_ changed (not just a
> line number), that is a STOP condition.

## Status

- **Status:** EXECUTING 2026-11-01. Owner answers, 2026-11-01: "I
  wouldn't change the window size … just go with the recommended … open
  multiple PRs. Execute the entire plan." So D2 is **no change** (the
  main window keeps 1180×780, minimum 960×660, and is not clamped; slice
  C2 is dropped). D1 and D3 to D8 are taken as recommended. C starts
  without the streamer's screenshots. One draft PR per workstream.
- **Source:** feedback from a new live streamer on the macOS build,
  relayed by the owner on 2026-11-01. They use AeroSpace (a tiling window
  manager), an ultrawide monitor shown through a 16:9 virtual display, and
  Continuity Camera.
- **Planned against:** `origin/main` `d3bac98c`, in
  `~/projects/videorc-wt-213` (branch `plan-213-new-streamer-feedback`).
  The shared checkout is on a stale branch (`feat/windows-owner-waiver`),
  so work in a fresh worktree from `origin/main`.
- **Owner route:** Orchestrator, fit 10, for the plan as a whole. Each
  workstream names its own route and model lane from `CLAUDE.md`.
- **How the facts were found:** four read-only investigations of
  `d3bac98c`, then the load-bearing claims re-read by hand. Each fact is
  marked **verified** (read in the code) or **guess** (reasoned, not
  reproduced). Nothing was reproduced on the streamer's Mac. We have no
  support bundle or log from them.

## The feedback (verbatim, lightly trimmed)

1. "frontend breaks in a lot of places, and hitboxes could be a little
   bigger. eg, around the stream selection, if you click near the toggle,
   it doesn't open"
2. "took me a while to find the stream manager. that's on me, but there
   should be a clear indication for chat, similar to captions and
   highlights"
3. "X chats aren't supported yet, i guess they're on the way"
4. "i use AeroSpace, so the preview window glitches and appears in weird
   locations. would be great if the preview wasn't a floating window and
   was part of the app itself, similar to OBS (i know it's already there),
   but the preview still breaks when switching apps. works fine in app."
5. "i also use a virtual display. it took a while and multiple restarts to
   get it working correctly (my monitor is ultrawide so i convert into
   virtual display same as mac screen size 16:9 ratio, for me black bars
   are there on display)"
6. "more freedom with display positioning would be great. i feel that's
   mostly because of my virtual display, which is why everything looked
   smaller on the screen"
7. "continuity cam broke once, i guess videorc hijacked it, that's why"
8. "with camera, little control to add contrast and saturation in
   realtime (feat request)"

## What we found, in one table

| #   | What they hit                          | Cause (short)                                                                                                                                                                                                                      | Workstream | Size |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| 1   | Click near the toggle doesn't open     | The destination row's chevron sits in a layer above the row button and has no handler. The Switch's invisible hit area spills 12 px sideways onto the chevron, so near misses toggle instead of open.                              | A          | S    |
| 1   | "Frontend breaks in a lot of places"   | Not specific yet. Main window minimum 960×660 is never clamped to the screen. Most Setup pages switch layout on the _viewport_ width, not their own. No narrow-width checks exist outside Studio.                                  | C          | M    |
| 2   | Couldn't find chat                     | No Chat or Stream Manager entry in the sidebar or the idle Studio. Only cue: a 20 px status-bar hint. Chat in Studio is off by default (plan 204 D3). "Open Stream Manager when you go live" is off by default.                    | B          | S    |
| 3   | "X chat isn't supported"               | X chat ships, but only for X added with Sign in plus Authorize X Live. With a stream key, the Stream Manager row says "Failed: Manual RTMP has no native X broadcast context…" (jargon).                                           | J          | S    |
| 4   | Preview jumps around under AeroSpace   | The Preview is a second, ordinary window. Floating: AeroSpace tiles it and our aspect-ratio backstop resizes it back on every resize (a fight). Stick to app: still a separate child window that AeroSpace sees and moves.         | D          | L    |
| 5   | Virtual display needed restarts        | Displays are named "Display 1/2/…" and known only by their numeric id. Nothing listens for displays appearing or changing. A missing display silently becomes another one, and that substitute is saved as your choice.            | E, F       | M    |
| 6   | Wants to place the screen more freely  | No crop or zoom for the screen. Landscape is always Fit, never Fill. With a background, the default Visibility 20 puts the screen on an 80% stage, a likely reason things "looked smaller". The control lives on the Assets page.  | G          | M    |
| 7   | Continuity Camera "hijacked"           | The camera is held whenever one is selected (Preview, plus Clips on by default). No disconnect observer: a drop looks like a 6 s stall, then failed restarts, then "restart Videorc". The fallback camera is saved as your choice. | E, H       | M    |
| 8   | Contrast and saturation for the camera | No per-source colour controls exist. The chroma key is the template: a live, camera-only, per-pixel effect.                                                                                                                        | I          | L    |

## Send to the streamer now (the owner relays)

**Workarounds that work on today's build:**

- **Preview and AeroSpace:** use **Stick to app** under the Preview. That
  makes the Preview a child of the main window, not a free window. It
  still breaks when AeroSpace switches workspaces (workstream D fixes
  that). Until then, telling AeroSpace to float Videorc's windows should
  stop the tiling fight. This snippet is **untested**:

  ```toml
  [[on-window-detected]]
  if.app-id = 'dev.theorcdev.videorc'
  run = 'layout floating'
  ```

- **Virtual display:** after the virtual display is on, press **Refresh**
  on the Sources page and pick it again. Displays are listed as "Display
  1", "Display 2", and so on. The size under the picker tells them apart.
- **Screen looks small:** with a background picture on, the screen sits
  on an 80% stage. Set **Assets → background → Visibility** to 0 for a
  full-size screen. **Scene → Make freeform** lets them move and resize
  the screen. An app scene (Scene → New scene…) captures one app's window
  instead of the whole large display.
- **Chat:** ⇧⌘J or Window → Stream Manager. Settings → General → "Open
  Stream Manager when you go live" opens it automatically. Settings →
  General → Chat → "Chat in Studio" shows chat in the Studio while live.
- **X chat:** add X with **Sign in** (not a stream key), then **Authorize
  X Live**. With a stream key, X doesn't share chat with any app.

**Questions back (each one changes the work):**

1. Screenshots of the places where the app "breaks", plus the virtual
   display's resolution and whether HiDPI is on (and which tool: BetterDisplay,
   DeskPad, …). Workstream C starts from these.
2. Preview: did they use Pop out or Stick to app? Does the AeroSpace
   config float or tile Videorc?
3. Continuity Camera: what broke, and where? In Videorc, or in another app
   while Videorc was open? Did the iPhone lock or move? When it came back,
   which camera did Videorc show?
4. X: did they add X with a stream key or with Sign in?
5. A support bundle (Health → Support bundle) and
   `~/Library/Application Support/Videorc/logs/backend.log` from a session
   where it happened. The bundle has no backend log in it today.

## Order of work

| Wave | Workstreams (one PR each)                            | Why this order                                                                                         | Runs in parallel?                                                               |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1    | A hit targets, B chat door, J X words, E keep choice | Small, mostly renderer, low risk. They can ship in the next release.                                   | Yes. A, B and J don't share files. E touches `capture.ts` and `use-studio.tsx`. |
| 2    | D Preview in the main window                         | The biggest break for this streamer, and high risk. It gets its own PR and the full preview probe set. | Yes with wave 1. D touches only preview code.                                   |
| 2    | F displays, H Continuity Camera                      | Both build on E (device watch, keep the choice).                                                       | F and H are separate files, but cap backend builds at two (`pnpm cargo:slot`).  |
| 3    | C pages fit, G screen crop, I camera look            | G and I are features. (Owner: all waves start now.)                                                    | Yes. I is the riskiest, with four render paths that must agree.                 |

`use-studio.tsx` is touched by B, E, H and I. Rebase the later PR rather
than merge in parallel blindly.

## Decisions for the owner

Each has a recommendation. The plan is written to the recommendation.

- **D1. Where chat shows.** _Recommended:_ a **Chat** row in the Studio
  inspector, right under Captions, built like the Captions row: a door, not
  a switch. It reads "Stream Manager · ⇧⌘J" when idle and "{n} new" while
  live, and a click opens the Stream Manager. It is far from Record and Go
  Live, so it keeps the "nothing beside Record/Go Live" rule. _Also
  possible:_ turn "Open Stream Manager when you go live" on for new
  installs, or turn Chat in Studio on by default (that reverses plan 204
  D3).
- **D2. The main window's minimum size.** _Recommended:_ 960×600, and the
  first-open and restored frame are clamped to the display's work area,
  like every other window. Today it is 960×660 and never clamped.
  **Owner answer (2026-11-01): no change.** The window's size, minimum
  and placement stay as they are.
- **D3. Stick to app draws inside the main window (macOS).**
  _Recommended:_ yes. The Metal layer moves from the separate Preview
  window into the main window's view at the slot. That leaves one window,
  as in OBS, and nothing a window manager can move on its own. Pop out
  stays a separate window.
- **D4. New installs start with the Preview stuck to the app.**
  _Recommended:_ yes. Existing installs keep their saved mode. Today every
  install starts floating (`parsePreviewWindowMode`,
  `preview-dock.ts:30`).
- **D5. Screen crop scope.** _Recommended:_ crop the screen by number and
  by ⌥-drag on an edge (OBS's habit), Fill as well as Fit for landscape,
  and a "Screen size" control on the Scene page next to the screen (the
  background's Visibility, shown where people look). Not while recording
  or live (editing is locked then today). The Screen ISO file stays
  uncropped, so it is the raw source for editing.
- **D6. A camera or display that comes back.** _Recommended:_ when
  nothing is recording or live, switch back to it at once. During a
  session, show a toast: "{iPhone} is back · Use it". Never switch
  mid-recording without a click.
- **D7. Camera look.** _Recommended:_ Brightness, Contrast and Saturation,
  neutral by default. One look per camera, applied in every scene; it is
  not part of a scene. It applies to every output, including the Camera
  ISO file, because it stands in for the camera's own settings. White
  balance and LUTs are not in this plan.
- **D8. X chat with a stream key.** _Recommended:_ fix the words and add a
  one-click path to Sign in. Do not build a stream-key lookup: it would
  still need Authorize X Live, which is what Sign in already asks for.

---

## Workstream A: bigger hit targets, and the destination row opens anywhere

**Route:** UI/Product Design, fit 9. **Lane:** `opus-5.5` (scoped UI
polish). Read `.claude/skills/videorc-design/SKILL.md` first.

**Drift paths:** `apps/desktop/src/renderer/src/components/streaming/destination-card.tsx components/list-row.tsx components/ui/switch.tsx components/ui/button.tsx components/sources/source-item.tsx components/status-bar.tsx components/streaming/discord-section.tsx`

**Why (verified):**

- The destination row (Livestream → Destinations) is the "stream
  selection" the streamer means. Its title is a `ListRowButton`, stretched
  over the row with `after:absolute after:inset-0` (`list-row.tsx:187`).
  The trailing controls span is `relative`
  (`destination-card.tsx:398-414`), so it sits above that layer. The
  chevron, the only visible "open" cue, is inside the span and has no
  handler. A click on the chevron does nothing.
- The Switch's hit area spills `after:-inset-x-3 after:-inset-y-2`
  (`ui/switch.tsx:27`). With an 8 px gap, that covers the gap and the
  chevron's left edge, so a near miss toggles the destination.
- A disabled Switch (destination cap reached) still swallows its whole
  area.
- The row's own comment says a click anywhere on the row should open it
  (`destination-card.tsx:374-379`).
- Same family: on `SourceItem` (`sources/source-item.tsx:126-143`) only a
  24 px chevron opens "More". The status-bar hints are 20 px tall
  (`status-bar.tsx:12`). Discord rows put a Switch's spill over 24 px
  icon buttons (`discord-section.tsx:616-640`). There are many `icon-xs`
  (24 px) buttons, for example `studio/studio-chat.tsx:119-131` and
  `stream-manager/chat-pane.tsx:1115`.

**Slices:**

- **A1. The destination row opens anywhere but the switch.** The chevron
  becomes decoration (`pointer-events-none`), so clicks fall through to
  the row button. Only the Switch itself is positioned. Trim the Switch's
  spill on the side that faces the chevron, and widen the gap. A disabled
  Switch lets clicks through to the row, so the row opens and shows why
  it's locked.
  _Done when:_ `destination-card.test.ts` and
  `destination-card-keys.test.ts` pin the new anatomy. By eye, clicking
  the chevron and the gap opens the row, and only the switch toggles.
- **A2. The `ListRowButton` rule, written down and audited.** Its doc says
  trailing decorations are never positioned and only real controls are.
  Fix every caller that breaks that rule.
  _Done when:_ a grep for `ListRowButton` callers shows each one checked
  (list them in the PR).
- **A3. `SourceItem`'s header row opens More.** The whole header is the
  trigger; the chevron stays. This fixes Screen, Camera, Mic and System
  audio at once.
  _Done when:_ `source-item.test.ts` is updated.
- **A4. A minimum hit area of 28×28 px without growing anything you can
  see.** `icon-xs` and `xs` buttons, `Toggle xs`, and the status-bar
  action class get an invisible spill, except where it would overlap a
  neighbour (state each such case in the PR). Discord rows: the Switch
  spill no longer covers the edit and remove buttons.
  _Done when:_ `rows-and-labels.test.ts` and `pane.test.ts` still pass,
  and dense rows look the same in both themes.

**Gate:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm --filter @videorc/desktop test`. By eye in light and dark. The PR
lists every hit area it changed.

---

## Workstream B: chat has a door in the Studio (D1)

**Route:** UI/Product Design, fit 9. **Lane:** `opus-5.5`.

**Drift paths:** `apps/desktop/src/renderer/src/components/studio/quick-settings.tsx components/studio/session-panel.tsx components/app-shell.tsx lib/studio-chat.ts components/command-palette.tsx`

**Why (verified):**

- The sidebar has no Chat or Stream Manager row (`workspace-nav.tsx:56-75`).
- The always-visible entries are the 20 px status-bar hint "⇧⌘J Stream
  Manager" (`app-shell.tsx:666-673`), ⌘K, the Window menu, and a button
  on the Buddy page.
- While live, the Session section has a row that opens the Stream Manager,
  but it is labelled **Buddy** (`session-panel.tsx:584-615`).
- Captions, by contrast, has an always-visible inspector row that opens
  its page (`studio/quick-settings.tsx:135-143`). That row is what the
  streamer means by "similar to captions".
- Chat in Studio is off by default by owner decision (plan 204 D3,
  `lib/studio-chat.ts:10`). This workstream does not change that.

**Slices:**

- **B1. A Chat row under Captions.** A `NavigableRow` with the chat icon,
  label "Chat", and value "Stream Manager · ⇧⌘J" when idle or "{n} new"
  while live (new since the Stream Manager was last focused). A click
  opens the Stream Manager (`openCommentsWindow`). It is a door, never a
  switch.
  _Done when:_ a test pins the row, its two values and its action. By eye
  in both themes, idle and live.
- **B2. The live Session row says what it opens.** Keep Buddy's presence
  dot, but the row's hint and accessible name say it opens the Stream
  Manager, and the copy is checked against B1, so two rows don't compete.
  If B1 makes this row redundant, say so in the PR and leave it.
  _Done when:_ `session-panel` tests are updated.
- **B3 (only if D1 picks it).** "Open Stream Manager when you go live" on
  for new installs.

**Gate:** typecheck, lint, format, desktop tests, `pnpm smoke:studio-chat`
(the inspector changes around it). By eye in both themes.

---

## Workstream C: pages fit a small window and a small display (D2)

**Route:** UI/Product Design, fit 9. **Lane:** `opus-5.5`.

The owner said go without the streamer's screenshots (2026-11-01), so C1
produces the evidence. D2 is no change: never touch the main window's
size, minimum or placement in this workstream.

**Drift paths:** `apps/desktop/src/renderer/src/lib/studio-layout.ts components/tabs/streaming-tab.tsx components/tabs/layout-tab.tsx components/tabs/captions-tab.tsx components/page.tsx components/clean-cut/clean-cut-review.tsx scripts/capture-ui-pages.mjs`

**Why (verified unless marked):**

- The main window opens at 1180×780 with a 960×660 minimum and is never
  clamped to the work area (`main/index.ts:2434-2438`). Other windows are
  clamped.
- **Guess:** a 1280×720-point virtual display has about 650 points of
  work area under the menu bar. The 660 minimum then pushes the status
  bar and the bottom of the inspector off-screen.
- Studio switches layout on its own width (a container query,
  `studio-layout.ts:19-28`). Its comment calls the viewport approach a
  bug.
- Other pages still switch on the viewport's `lg` (1024 px):
  `streaming-tab.tsx:243`, `layout-tab.tsx:584`, `captions-tab.tsx:8`
  (also a 380 px minimum column), `page.tsx:70` (`ConfigGrid`, all of
  Settings) and `clean-cut-review.tsx:714`. With the sidebar, those
  pages get two columns at about 800 px of content.
- Fixed widths inside rows: Discord `w-64` and `w-56`
  (`discord-section.tsx:313`, ~595).
- No narrow-width check exists outside Studio. `capture-ui-pages.mjs`
  captures only at 1280×860.

**Slices:**

- **C1 (red first). A page sweep at three sizes.** Extend
  `scripts/capture-ui-pages.mjs` (with a package script) to capture every
  page at 960×660 (the minimum), 1100×720 and 1280×800, light and dark.
  List what breaks: clipping, overflow, controls off-screen, two columns
  too narrow.
  _Done when:_ the list is in the PR. It is the work list for C3 and C4.
- **C2. Dropped (D2 is no change).**
- **C3. Container queries, not the viewport.** Convert the five pages
  above to the Studio pattern, with a narrow-width test each, like
  `studio-layout.test.ts`.
- **C4. Fix what C1 found.** One commit per page. Never hide a control to
  make it fit.
  _Done when:_ the C1 sweep is clean at all three sizes in both themes.

**Gate:** typecheck, lint, format, desktop tests, the C1 sweep. By eye.

---

## Workstream D: the Preview lives in the main window (macOS) (D3, D4)

**Route:** Diagnose then Implementation, native preview, fit 9. **Lane:**
`fable-5.1` (native addon, main process, renderer slot, and the preview
probes; release-critical).

**Drift paths:** `crates/videorc-native-preview-addon/src/lib.rs apps/desktop/src/main/index.ts apps/desktop/src/main/preview-dock.ts apps/desktop/src/main/native-preview-in-process-driver.ts apps/desktop/src/renderer/src/components/preview-stage.tsx scripts/preview-window-probe.mjs`

**Why (verified unless marked):**

- The default macOS preview draws into a separate **Preview**
  BrowserWindow. The addon adds a `CAMetalLayer` as a sublayer of that
  window's NSView at `zPosition 10_000`, with its origin fixed at 0,0
  (`videorc-native-preview-addon/src/lib.rs:164-196, 238-241`). The
  helper-process window is a diagnostic fallback only
  (`native-preview-host-policy.ts:440-444`).
- The Preview is an ordinary titled window (`index.ts:4737-4757`) and
  starts **floating** (`preview-dock.ts:30`). AeroSpace tiles standard
  windows (**guess** on AeroSpace's side).
- The aspect backstop `conformPreviewWindowToAspect`
  (`index.ts:2811-2832`) runs on every resize and calls `setContentSize`.
  Its own comment says tiling window managers bypass the aspect lock. So
  AeroSpace sets a size, we set it back, and AeroSpace re-tiles: the
  "glitches".
- **Stick to app** is still a second window: a child
  (`applyDockedPreviewChrome`, `index.ts:4919-4932`). AeroSpace still
  sees it.
  - When the main window moves, the in-process driver leaves placement to
    AppKit's parent/child link (`index.ts:2666-2675`).
  - The dock's visibility rules never treat a main window parked
    off-screen as hidden (`preview-dock.ts:129-153`).
  - AeroSpace parks a hidden workspace by moving its windows to a screen
    corner (**guess**). Parent and child can then be moved separately,
    and come back in the wrong place: "breaks when switching apps".
- Nothing reacts to the app losing focus. The only hook re-shows the
  preview on focus (`index.ts:4340`).
- History: the first native plan embedded the layer over the React rect
  (`docs/native-metal-preview-plan.md:374-377`). A separate window won
  while the video came from a helper process, which can't be a subview.
  The in-process layer (2026-07-09) went into the Preview window, and
  embedding it in the main window was never weighed again (no document
  found).
- Overlays: nothing in Electron draws above the surface. Dialogs and
  popovers hide it (`plans/058-live-scene-canvas.md:59-61`). That holds
  for a layer in the main window too, and the existing overlay-open hide
  already covers it.
- Linux already moved its preview into the window because tiling
  compositors re-tile it (`in-window-proof-surface.ts:1-8`).

**Slices:**

- **D1 (red first). Probe cases for a window manager.** Add two cases to
  `scripts/preview-window-probe.mjs`:
  - `wm-displaces-child`: with Stick to app on, move the Preview window on
    its own through the `preview-window-set-bounds` smoke command
    (`index.ts:11786`).
  - `wm-parks-main`: move the main window so almost all of it is past the
    display's bottom-right corner, then bring it back.

  Both assert one thing: the presented surface is inside the main
  window's slot, or not shown. Add `wm-resizes-floating` for floating
  mode: set a non-16:9 size and assert the window keeps it for 2 s.
  _Done when:_ all three are seen red on `d3bac98c`.

- **D2. The addon places the layer.** `update` takes an origin and a
  corner radius. The origin is converted from the slot's top-left frame
  to the host view's coordinates by a pure helper (flipped or not), with
  unit tests. Add `masksToBounds` for the radius. `PreviewSurfaceBounds`
  gains the fields in every mirror (Rust protocol, shared TS, host and
  helper protocol, normalisation and comparison), with the regression
  test `AGENTS.md` requires.
  _Done when:_ `cargo test -p videorc-native-preview-addon` covers the
  geometry, and the mirror test passes.
- **D3. Stick to app attaches to the main window.** On macOS with the
  in-process driver, a stuck Preview attaches to the main window's native
  handle at the slot rectangle, so no Preview window is shown. Main sends
  slot reports straight to the layer, as it already does for the child
  frame (no renderer round trip). Keep the overlay-open and
  scrolled-away hides. Full screen stops hiding the preview, since it is
  in the window now. Pop out recreates the Preview window as today.
  Status keeps the native CAMetalLayer transport and names the host
  (main window or Preview window). Never a silent change.
  _Done when:_ D1's `wm-*` docked cases pass. `probe:preview-lifecycle`
  and `probe:preview-window` pass, including dock, dock-move, dock-storm,
  overlay, scroll and pass-through.
- **D4. A floating Preview stops fighting.** On macOS, where AppKit
  already applies the aspect lock to the user's own drags, an external
  resize no longer calls `setContentSize`. The video is drawn aspect-fit
  inside, with bars. Windows keeps the backstop.
  _Done when:_ `wm-resizes-floating` passes, plus a unit test of the pure
  decision.
- **D5. New installs start stuck (D4).** Only when no `preview-window.json`
  mode is saved.
  _Done when:_ a test covers fresh, saved-floating and saved-docked.
- **D6. Docs.** A short section in the native preview doc: where the
  layer lives in each mode and why. Add the AeroSpace float rule for Pop
  out.

**Gate:** `pnpm probe:preview-lifecycle`, `pnpm probe:preview-window`,
`pnpm smoke:preview-overlay-presentation`, `pnpm smoke:preview-click-focus`
and `pnpm smoke:recording-studio`. Then `cargo test` and `cargo clippy -D
warnings` for the addon. Then by eye on a Mac with AeroSpace (the lab Mac
or a second macOS user, never the owner's daily session unless they say
so): switch workspaces 20 times, ⌘Tab away and back, resize the tile,
and open a dialog over the Preview, in both themes.

---

## Workstream E: a missing screen or camera never rewrites your choice (D6)

**Route:** Implementation, fit 8. **Lane:** `gpt-6.1-sol`. Run it at high
effort: at default effort, that lane returned no changes on 2 of 3
earlier tasks.

**Drift paths:** `apps/desktop/src/renderer/src/lib/capture.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx crates/videorc-backend/src/main.rs (devices.changed) crates/videorc-backend/src/camera_capture.rs crates/videorc-backend/src/screen_capture.rs`

**Why (verified):**

- `reconcileSourceSelection` (`capture.ts:2824`) resolves the saved
  screen and camera by exact id, then exact name, then falls back to the
  first one (`capture.ts:2896-2916`). The result is written back into the
  saved sources, so the substitute becomes your choice.
- A toast appears only during a live session
  (`recordAutomaticSourceFallbacks`, `use-studio.tsx:7050`).
- Nothing tells the renderer when cameras or displays come and go.
  `devices.changed` is sent only when someone asks for the list
  (`main.rs:10459-10476`). The list is re-read at launch, on Refresh,
  when Settings gets focus, and in scene preflight.
- After `failed` or `device-missing`, the camera start key is cleared
  (`use-studio.tsx` near `nativePreviewCameraKeyRef`, ~11122). Every
  device-list change then tries to start the camera again.

**Slices:**

- **E1 (red first). "Wanted" and "using" are two things.** The saved
  `screenId`/`cameraId` (and names) stay the user's pick. A substitute
  is used for this session only and never saved. Only a user's pick is
  saved. Sources and the inspector say so calmly, idle too: "{iPhone}
  isn't connected · using {FaceTime HD Camera}".
  _Done when:_ a unit test is red on base: a fallback rewrites the saved
  camera. It then passes. `capture` tests cover screen, window and camera.
- **E2. The backend says when devices change.** Camera connect and
  disconnect notifications (AVFoundation), and a display reconfiguration
  callback (CoreGraphics), go on the backend's main-thread run loop (the
  one #375 added, `main.rs:398-430`). They push `devices.changed`,
  debounced to 500 ms. Strict contract and serde rules apply to any new
  field.
  _Done when:_ a unit test covers the debounce, and by eye a USB camera
  plugged in after launch appears without Refresh.
- **E3. It comes back (D6).** When the wanted device reappears, switch
  back when idle. During a session, show the toast with "Use it". The
  camera start is retried only when the wanted camera is actually in the
  list (no re-grab loop).
  _Done when:_ tests cover idle and in-session.

**Gate:** typecheck, lint, desktop tests, targeted `cargo test` for the
touched modules, `cargo clippy -p videorc-backend -- -D warnings`,
`pnpm smoke:smart-scenes` (scene source resolution) and
`pnpm smoke:recording-studio` (capture selection).

---

## Workstream F: displays you can tell apart, that survive hot-plug and resolution changes

**Route:** Diagnose, fit 9. **Lane:** `fable-5.1` (ScreenCaptureKit,
CoreGraphics, saved scenes and the renderer). **Depends on E.**

**Drift paths:** `crates/videorc-backend/src/screen_capture.rs crates/videorc-backend/src/preview_screen.rs crates/videorc-backend/src/diagnostics.rs apps/desktop/src/renderer/src/lib/scene-presets.ts apps/desktop/src/renderer/src/lib/source-select-state.ts scripts/live-lab/lib/seed.mjs`

**Why (verified unless marked):**

- A display is known only by its CGDirectDisplayID
  (`screen:screencapturekit:<id>`) and named by position:
  `format!("Display {}", index + 1)` (`screen_capture.rs:1027-1028`). No
  UUID, macOS name, origin, or mirror flag is read.
- Saved scenes match the exact id only (`scene-presets.ts:390-420`). A
  new id after a restart blocks the scene behind "Resolve scene sources".
- **Guess:** virtual display tools can hand out a new id after a restart.
- The capture size is set when a stream starts or switches source
  (`preview_screen.rs:6856-6879, 7170-7187`). Picking the same display
  again reuses the running stream (`preview_screen.rs:5168-5182`). A
  resolution or HiDPI change keeps the old size until you switch away
  and back, or restart. That fits "multiple restarts".
- **Guess:** if they picked the physical ultrawide, which mirrors the
  16:9 virtual display with side bars, the bars are captured too. Then
  the 21:9 picture is fit into 16:9 with more bars, which also explains
  "smaller". Real names (F1) make the right pick obvious.
- The support bundle has ids, "Display N" and sizes, but no names,
  UUIDs, frames, scale, mirroring or backend log (`main.rs:14432`,
  `diagnostics.rs:1731-1745`).
- The live lab matches its BetterDisplay screen by its macOS name
  (`seed.mjs:58-60`), but the backend calls it "Display N".

**Slices:**

- **F1. Real names and a stable identity.** Name each display as macOS
  does (`NSScreen.localizedName`, matched by display id), with its size,
  for example "LG ULTRAWIDE · 3440×1440". Mark mirrored displays. Add the
  display UUID (`CGDisplayCreateUUIDFromDisplayID`) as an optional
  `Device` field; the id format does not change. The saved choice and
  saved scenes resolve by UUID, then id, then name. A UUID match rewrites
  a stale id silently, because it is the same display. Check `seed.mjs`
  against the new names.
  _Done when:_ Rust unit tests cover naming fallbacks, and a renderer test
  covers UUID-first resolution. The strict contract lists the new field.
- **F2. A resolution or scale change is followed.** On the
  reconfiguration callback from E2, if the captured display's pixel size
  changed, recompute the capture size and apply it in place. Use
  `SCStream`'s `updateConfiguration`, or the source-swap path that holds
  the last frame. Never show a black frame. The size under the picker
  updates.
  _Done when:_ a unit test covers the size recompute, and by eye a
  BetterDisplay virtual display changed 1080p → 1440p → HiDPI on
  mid-Preview shows no bars and no restart.
- **F3. The support bundle can diagnose a display setup.** A "Displays"
  section: per display, the UUID, macOS name, frame, pixel size, scale,
  main/mirror flags, and which one is captured with its requested and
  actual size. Add the last 200 capture-related backend log lines,
  filtered to `screen`/`camera` capture targets, never the whole log.
  _Done when:_ a test pins the section, and a leak check shows no window
  titles beyond what the bundle already holds.

**Gate:** targeted `cargo test`, clippy, desktop tests,
`pnpm smoke:smart-scenes`, `pnpm smoke:recording-studio`, and
`pnpm smoke:recording-studio:devices` if this Mac has the grants. By eye
on the lab Mac with BetterDisplay: turn a virtual display on after launch
(it appears without Refresh), change its resolution (no restart), then
relaunch (same display chosen, saved scenes open).

---

## Workstream G: make the screen bigger: crop, Fill, and the size where you look (D5)

**Route:** UI/Product Design, fit 9. **Lane:** `opus-5.5` for the editor.
If G1 finds a render path that ignores crop, that part escalates to
`fable-5.1`.

**Drift paths:** `crates/videorc-backend/src/scene.rs crates/videorc-backend/src/scene_geometry.rs apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx components/scene/ lib/stage-transform.ts`

**Why (verified):**

- `SceneTransform` already has `crop_left/top/right/bottom`, and the
  compositor draws crop for the camera (`compositor.rs:2736`) and in the
  FFmpeg graph (`recording.rs:23255`).
- Freeform saves only x, y, w and h, and the screen always gets zero crop
  (`scene.rs:459-500`). No crop UI exists.
- Landscape screen layouts always Fit; Fill exists only for vertical
  (`layout-tab.tsx:681-685`). The freeform box can't exceed the canvas
  (`stage-transform.ts:296-313`).
- A background's Visibility (default 20) shrinks the screen to an 80%
  stage (`scene_geometry.rs:80-86`). Its slider is on the Assets page
  (`lib/background-library.ts:33`).

**Slices:**

- **G1 (red first if any path fails). The crop draws the same
  everywhere.** One fixture: a screen source with a crop, through CPU,
  Metal, FFmpeg legacy and the aux leg (record + stream on macOS streams
  from a separate leg). Windows D3D11 runs through CI. Compare the
  pixels, the same way the chroma-key parity test does.
  _Done when:_ every path agrees, or the one that doesn't is fixed in its
  own commit.
- **G2. Crop in the Scene editor.** Left, top, right and bottom as % in
  the screen's inspector, beside X/Y/W/H. ⌥-drag on an edge crops instead
  of resizing. Save the crop on freeform scenes. "Reset crop".
  _Done when:_ the scene round-trips crop (Rust and TS tests), and the
  editor's snap and nudge tests still pass.
- **G3. Fill for landscape.** The vertical Fit/Fill control, offered for
  landscape screen layouts too.
- **G4. Screen size on the Scene page.** When a background is on, show
  its Visibility as "Screen size" next to the screen. It is the same
  setting, shown where people look, not a second one.
- **G5.** The Screen ISO file stays uncropped (D5). A test pins that.

**Gate:** typecheck, lint, desktop tests, targeted `cargo test`, clippy,
`pnpm smoke:smart-scenes`, `pnpm smoke:recording-studio`, a record+stream
smoke for the aux leg, and `pnpm smoke:separate-source-fixture` (ISO).
By eye in both themes.

---

## Workstream H: Continuity Camera is never lost or taken

**Route:** Diagnose, fit 9. **Lane:** `fable-5.1` (AVFoundation, capture
recovery, and a physical device). **Depends on E.**

**Drift paths:** `crates/videorc-backend/src/camera_capture.rs crates/videorc-backend/src/preview_camera.rs crates/videorc-backend/src/capture_health.rs crates/videorc-backend/src/capture_recovery.rs apps/desktop/electron-builder.yml`

**Why (verified unless marked):**

- Cameras are found with the deprecated
  `AVCaptureDevice::devicesWithMediaType` (`camera_capture.rs:625`). There
  is no `DiscoverySession` and no Continuity Camera device type.
  Info.plist has only `NSCameraUsageDescription`
  (`electron-builder.yml:121-122`).
- **Guess, check Apple's docs first:** on macOS 14 and later, the
  Continuity Camera device type needs
  `NSCameraUseContinuityCameraDeviceType`.
- The camera is held whenever one is selected and the preset isn't
  screen-only. Hiding the window doesn't release it. Clips is on by
  default and keeps a camera-fed session running.
- A fresh profile picks `cameras[0]`, which may be the iPhone (**guess**:
  it depends on order). Videorc then keeps it open all day.
- A drop has no observer. It shows up as a frame stall: under 1 frame/s
  for three 2 s windows (`capture_health.rs:37-65`). Then up to 2
  restarts (`capture_recovery.rs:67`), then a latched
  "…Check the camera connection, or restart Videorc."
  (`capture_recovery.rs:2346-2352`). Meanwhile the last frame stays up,
  so the camera looks frozen (**guess**).
- After the drop, the fallback camera is saved (fixed in E). The start is
  retried on every device change (fixed in E3).
- The legacy FFmpeg recording path opens the camera a second time with
  `-f avfoundation`, while the preview session stays open. It runs for
  some profiles above 30 fps (`recording.rs:16943-16958, 14238-14260`).
  It maps the device by name to an index from a 30 s cache.

**Slices:**

- **H1. Find Continuity Camera properly.** Use `DiscoverySession` with
  built-in, external and Continuity Camera types (Continuity on macOS 14
  and later), and the Info.plist key if Apple requires it. Rows say
  "iPhone camera". Verify that the iPhone's `uniqueID` stays the same
  across a lock and unlock, and across a reconnect (STOP if not).
  _Done when:_ a unit test covers the device-type mapping, and by eye the
  iPhone is listed with its type.
- **H2. A disconnect is known within a second.** Observe the disconnect
  notification for the running camera. Status becomes "{iPhone}
  disconnected" with the last frame dimmed, never "restart Videorc".
  Recovery doesn't count a disconnect as a failed restart. When the same
  `uniqueID` reconnects (E2), the camera restarts on its own.
  _Done when:_ a unit test covers the disconnect → reconnect status
  machine. By eye: lock the iPhone, see the status within 1 s; unlock,
  and the camera is back within 3 s without a click.
- **H3. A sensible default camera.** For a fresh profile, use
  `systemPreferredCamera` on macOS 14 and later, then the built-in
  camera, then the first one. Never the iPhone just because it's listed
  first.
- **H4. The legacy double open is visible.** When the FFmpeg path opens a
  camera the preview already holds, the session status says so. Resolve
  the index by `uniqueID` from a fresh probe, not a substring of the name.
  If that can't be done safely, note it in the PR and leave the path for
  a later plan.
- **H5. The support bundle shows the camera's story.** Device type and
  transport, wanted vs used camera, and the last 20 connect and
  disconnect events with times.

**Gate:** targeted `cargo test`, clippy, desktop tests,
`pnpm smoke:recording-studio`, and `pnpm smoke:record-latency` if the
camera start path changed. The dev app has no camera grant, so the
physical part runs in the packaged app with a real iPhone:

1. Lock and unlock the phone while idle, while recording and while live
   (local RTMP sink).
2. Relaunch with the phone away, then bring it back.
3. Use FaceTime with the iPhone while Videorc also has it open.

Record what macOS allows in step 3; don't promise more.

---

## Workstream I: camera look: brightness, contrast, saturation (D7)

**Route:** Implementation with UI design, fit 8. **Lane:** `fable-5.1`
for the render paths (four paths must agree on recording output), with
`opus-5.5` as a helper for the sliders.

**Drift paths:** `crates/videorc-backend/src/protocol.rs crates/videorc-backend/src/metal_compositor.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/windows_d3d11_session.rs crates/videorc-backend/src/windows_d3d11_shaders.hlsl crates/videorc-backend/src/bin/native_preview_host_helper.rs apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx`

**Why (verified):**

- `SceneSource` has only transform, visible and locked
  (`protocol.rs:843-855`). Camera controls (shape, mirror, zoom, chroma
  key) live in `LayoutSettings` (`protocol.rs:455-535`).
- No AVCaptureDevice image control is used.
- Windows D3D11 already has per-layer saturation and dim
  (`windows_d3d11_shaders.hlsl:14, 210-212`). The camera layer passes
  defaults (`windows_d3d11_session.rs:3339-3342`).
- The chroma key is the template: a camera-only per-pixel effect, edited
  live through `scene.layout.apply_live`.
  - Metal: `f_main` (`metal_compositor.rs:83-181`).
  - CPU: `blit_rgba_to_yuv420p` (`compositor.rs:12258`); its fast path
    skips per-pixel work.
  - FFmpeg legacy: camera filter graphs in `recording.rs` (~23145-23653).
  - Parity tests: `cpu_and_metal_chroma_keyers_agree…`
    (`compositor.rs:14631`) and
    `ffmpeg_chroma_mapping_keys_the_realistic_palette`
    (`recording.rs:38399`).

**The maths (so every path matches FFmpeg's `eq`):** work on
gamma-encoded RGB, with Y = BT.709 luma. The chroma key decides alpha on
the original pixel; the look is applied after it, so adjusting the look
never moves the key.

- Brightness: `rgb += b`.
- Contrast moves luma only: `rgb += (c − 1)·(Y − 0.5)`.
- Saturation: `rgb = Y + s·(rgb − Y)`.
- Clamp at the end.
- Ranges: b −0.25…0.25, c 0.5…1.5, s 0…2, neutral 0 / 1 / 1. The UI
  shows −100…100.

**Slices:**

- **I1. Where it is stored (D7).** One look per camera, keyed by the
  camera's id and stored with the settings, then injected into the
  layout sent to the backend. The wire field `cameraLook` is optional,
  with `skip_serializing_if` when neutral, so older apps never see a
  `null`. It goes in the strict contract (`backend-rpc-contract.ts`), the
  IPC contract and the high-risk fixture.
  _Done when:_ contract round-trip tests pass in Rust and TS, and an
  older payload without the field still loads.
- **I2 (red first). The parity test.** A fixture frame graded on CPU,
  Metal and FFmpeg `eq` agrees within 2/255 away from clipping. It is red
  until I3.
- **I3. The render paths.**
  - Metal: the shader plus a uniform. The preview helper's `GpuSource`
    must still compile.
  - CPU: skip the fast path when the look isn't neutral.
  - D3D11: wire saturation, add contrast and brightness.
  - FFmpeg: `eq=` in every camera graph, including camera-only,
    side-by-side and vertical bands.
  - The aux leg (record + stream).
  - The Camera ISO file, per D7.
- **I4. The sliders.** Scene page → Camera, beside Chroma key: Brightness,
  Contrast, Saturation and Reset. They apply live while dragging,
  throttled to about 30 Hz, never only on release. Check the existing
  slider path (`use-studio.tsx` ~9017) and fix it if it waits for
  release. Changing the look never restarts the camera.
  _Done when:_ by eye, dragging is smooth in the Preview, and the
  recording matches the Preview.

**Gate:** targeted `cargo test` (compositor, recording, protocol),
clippy, desktop tests, `pnpm smoke:recording-studio`,
`pnpm smoke:separate-source-fixture`, a record+stream smoke, and Windows
CI for D3D11. By eye in both themes.

---

## Workstream J: X chat with a stream key says how to get it (D8)

**Route:** UI/Product Design (copy), fit 8. **Lane:** `opus-5.5`.

**Drift paths:** `crates/videorc-backend/src/main.rs (~3577) crates/videorc-backend/src/preflight.rs (~387) crates/videorc-backend/src/x_chat.rs apps/desktop/src/renderer/src/components/stream-manager apps/desktop/src/renderer/src/components/streaming apps/desktop/src/renderer/src/lib/studio-toasts.ts`

**Why (verified):**

- X chat ships (#360, web #21, both merged 2026-09-19). It reads through
  the web relay (`x_chat.rs:1-19`, `X_NATIVE_COMMENTS_AVAILABLE = true`)
  and can send.
- It needs all of these:
  - an X destination added with Sign in, with a native broadcast;
  - Authorize X Live;
  - a signed-in Videorc account.
- With a stream key, the Stream Manager shows a **Failed** row: "Manual
  RTMP has no native X broadcast context, so X comments are unavailable
  for this destination." (`main.rs:3577`). That reads as "not supported".
- The Go Live check is clearer: "With a stream key, Videorc can't read or
  send X chat. Choose Sign in to use it." (`preflight.rs:387`).

**Slices:**

- **J1. Not a failure.** The Stream Manager's X row for a stream-key
  destination becomes a neutral state: "X chat needs Sign in. Your stream
  key still streams; X shares chat only with apps you sign in to." It
  has a "Use Sign in" button that opens that destination's connection.
- **J2. Say it when adding X.** In the destination setup, Sign in is
  first and says "Chat works". The stream-key option says "No chat".
- **J3.** Toasts and the Go Live check use the same words. Mention
  Authorize X Live only once Sign in is done.

**Gate:** targeted `cargo test` for the changed strings and states,
clippy, desktop tests, and the comments contract tests. By eye in both
themes.

---

## STOP conditions

- **D:** attaching the layer to the main window's view breaks Electron's
  own drawing (web content, vibrancy, the window's corners), or the
  overlay-open hide can't cover a case the child window covered. Stop and
  report with a screenshot. Do not fall back to the helper window.
- **D:** any probe or smoke needs the old "a Preview window always exists"
  assumption in a way that changes what users see.
- **E:** a smoke or saved-scene flow depends on the old "fallback is saved"
  behaviour in a way users rely on.
- **H:** the iPhone's `uniqueID` is not stable across a lock or reconnect.
  Identity then needs a redesign; report what changes.
- **I:** FFmpeg `eq` can't match the GPU maths within tolerance. The
  owner decides whether the legacy path may differ.
- Any new status, event or settings field that isn't in
  `backend-rpc-contract.ts`, or a Rust `Option` without
  `skip_serializing_if`.
- An anchor's behaviour changed since `d3bac98c`.

## Not in this plan

- Editing the scene while recording or live (locked today, a bigger
  question).
- Changing how large a format the camera is opened at (the canvas size).
  The layout-invariant capture depends on it.
- Tiling window managers on Windows (Komorebi, FancyZones). The docked
  child window is the same pattern there; a later plan, if anyone
  reports it.
- X chat for stream-key destinations through a broadcast lookup (D8).
- White balance, temperature, LUTs, filters (D7).
- Desk View camera (plan 024 noted it's missing).
- Turning Chat in Studio on by default (plan 204 D3), unless D1 picks it.

## Owner acceptance

- **A, B, C, J:** by eye in light and dark at 960×600 and at full size.
  The destination row opens from the chevron and the gap. Chat is visible
  in the idle Studio.
- **D:** with AeroSpace on a test Mac: Stick to app shows no second
  window; workspace switches, ⌘Tab, and tile resizes leave the Preview in
  its slot. Pop out floats without fighting.
- **E, F:** a BetterDisplay virtual display turned on after launch,
  resized, and relaunched, with no restarts or re-picks.
- **H:** an iPhone locked and unlocked while idle, recording and live
  comes back without a click, and Videorc never saves the fallback.
- **G, I:** crop, Fill and the camera look match between the Preview and
  the recording.
- **Feedback loop:** send the streamer the build with A, B, J, E and D,
  and ask them to re-test AeroSpace and the virtual display.

## As built

- A: not started.
- B: not started.
- C: not started.
- D: not started.
- E: implemented in three slices (draft PR, plan 213 E). Wanted camera,
  screen and window choices survive substitutes in settings and saved scenes.
  AVFoundation notifications and CoreGraphics reconfiguration feed a 500 ms
  trailing debounce and the existing `devices.changed` DeviceList event. Idle
  discovery restores the choice; active sessions offer "Use it". Camera starts
  wait for discovery and do not repeat a failed start on unrelated changes.
  Physical camera/display reconnect acceptance is still owed.
- F: not started.
- G: not started.
- H: not started.
- I: not started.
- J: not started.
