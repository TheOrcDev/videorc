# Plan 231: every scene shows its own screen

## Status

- **Status:** PLANNED 2026-11-12. The owner answered Q1 to Q6 in a grilling
  session, then said "continue all questions recommended and make plan":
  D7 to D20 below are the recommended answers, taken as decided. Two of
  them bend earlier owner calls and are marked **Owner check**.
- **Priority:** P1. It is the second time the same streamer has asked for
  this (plan 210 was the first), and the Scenes section is the first thing
  a coding or design streamer touches.
- **Effort:** XL, in four phases (A, B and D in one PR; C separate).
- **Risk:** MEDIUM-HIGH. It migrates every user's scenes (renderer
  localStorage), changes what the Screen pickers do, and touches the scene
  switch, the vertical stream and every remote that names a layout.
- **Planned against:** `origin/main` `bf6e9077` (release 0.23.0), re-checked
  on `8d8149d17` before the plan was committed: #1312 (issue #1275) changed
  how a slow switch looks (item 11 below). Work in a fresh worktree from
  `origin/main`, never in the shared checkout.
- **Owner route:** Orchestrator planned it (fit 10). Each slice names its
  route, fit and model lane from `CLAUDE.md`.

## The ask

A streamer, relayed by the owner on 2026-11-12:

> for my case, as i explain before, I have one Monitor. i want scene one for
> figma, one t3code and other for browser. and keep switching btw them with
> hotkeys. also still hard for to understand the relation between screen (in
> source tab) and scene.

The owner: "We want to create really good UX behind this in our scenes
section inside of Studio." Asked about platform: "We just want much better
UX inside of our Studio, all those things, but it needs to be better UX."

## What's there today (verified on `bf6e9077`)

Renderer paths are under `apps/desktop/src/renderer/src/`, shared types under
`apps/desktop/src/shared/`, backend paths under `crates/videorc-backend/src/`.

Plan 210 (#935, 2026-10-29) built the machinery this user needs on macOS:
New scene… makes one scene per app ("Figma · front window"), the window
swaps in place in about 100 to 150 ms, a saved scene can have a global key,
Follow the app in front is on by default, and Hide screen is on ⌃⌥H. What
is still hard is the model and the way in.

1. **Two things decide what's on stream.** Studio's Scenes section
   (`components/studio/scenes-gallery.tsx`) shows "Saved scenes"
   (`components/scene-presets.tsx`) above "Layouts" (four built-ins in 16:9,
   six in 9:16). A saved scene carries its own screen, window or app
   (`lib/scene-presets.ts:25-70`); a layout card carries none and uses
   whatever the Screen picker holds (`scenes-gallery.tsx:97-107`).
2. **The Screen picker quietly drops your scene.** With a saved scene on,
   choosing another screen or window in Sources or in Studio's Screen row
   (`components/studio/quick-settings.tsx`) leaves the scene
   (`hooks/use-studio.tsx:11358-11372`, plan 210 D3). Then:
   - Studio checks a built-in layout card such as "Screen + camera"
     (`galleryPresetIsActive`, `lib/scene-presets.ts:553-561`);
   - the Scene page says "Unsaved scene" (`components/scene/scene-list.tsx:214-227`).
     The two surfaces disagree about what's on stream.
3. **Different words for one thing.** The picker lists windows ("Figma –
   Untitled"); a scene lists apps ("Figma · front window",
   `lib/scene-list.ts:73`).
4. **Keys are buried.** `GlobalShortcutsConfig.scenes` is empty until the
   streamer finds ⋯ → Set key… (`components/scene/scene-dialogs.tsx:158-163`)
   or Settings → Shortcuts. Plan 210 D7 chose no default keys. Next and
   Previous scene have none either (`shared/global-shortcuts.ts`).
5. **Cards look the same.** Every card draws the layout diagram
   (`LayoutThumb`); "Figma", "T3 Code" and "Chrome" differ only by a 16 px
   icon and the name (`scene-presets.tsx:132-137`).
6. **The camera follows the scene too.** A saved scene stores `cameraId`
   (`VisualSources`), and D3's autosave writes a camera change into the scene
   on stream, so switching scenes can switch the camera back.
7. **Vertical is a second vocabulary.** The gallery is mode-scoped
   (`scenes-gallery.tsx:32-36`): 16:9 and 9:16 scenes are disjoint, and a
   saved scene is one or the other. The Vertical stream panel
   (`components/studio/vertical-leg-monitor.tsx`) picks one of six vertical
   layouts and, with `simulcastFollowsProgram` on (the default), mirrors
   only Camera only and Screen only; everything else streams
   `lastVerticalPreset` (default `vertical-camera-top`,
   `lib/capture.ts:455-475,1463-1466`).
8. **Where the pieces live.**
   - The scene library is renderer localStorage, `videorc.scene-presets.v1`
     (`lib/scene-presets.ts:23,69`; `hooks/use-scene-presets.ts:39-46`); a
     version it doesn't know turns it read-only ("Update Videorc to change
     your scenes").
   - Main registers global keys and sends `global-shortcuts:triggered` to the
     renderer (`main/index.ts:835-836`), which applies `scene:<id>` and the
     layout actions (`lib/global-shortcuts.ts:54`). Next and Previous walk
     saved scenes then layouts (`lib/scene-shortcut-walk.ts`).
   - Remotes: `sceneApply` takes `sceneId`, `screenId` or `layoutPreset`
     (`remote_control.rs:82-84,229-242`); the Stream Deck's Scene action
     reads `savedScenes` (`apps/streamdeck-plugin/src/plugin.ts:246-259`);
     MCP `list_scenes` returns saved scenes and built-in layouts
     (`protocol-fixtures/agent-tools.json:235`).
   - Pictures: `sources.app_previews` returns a JPEG of each app's front
     window on macOS 14 and up, and only the New scene picker asks for it
     (`shared/backend-rpc-contract.ts:5417`; `hooks/use-app-choices.ts`).
     Nothing pictures a display.
   - Capture exclusion for Videorc's own floating windows exists: the
     Stream Manager's Hide from stream uses Videorc's ScreenCaptureKit filter
     on macOS and `WDA_EXCLUDEFROMCAPTURE` on Windows
     (`main/window-capture-protection.ts:46-60`).
9. **Platforms.** Windows captures displays only (`CreateForMonitor`);
   Linux has one portal slot and can't change the screen mid-session
   (plan 210 §24-25).
10. **IA rule today:** the Scene page is the home of scenes and Studio's
    gallery mirrors it (design skill, "Where things live"); Sources is the
    home of every screen and window.
11. **A slow switch keeps the clicked name** (#1312, issue #1275, landed
    after `bf6e9077`). The card or row keeps its name with a pending mark
    (`SceneSwitchPending`). One line under the list says what the switch
    waits for (`SceneSwitchStatus`, `components/scene/scene-switch-status.tsx`).
    A newer click takes a pending switch over, and the switch it replaced
    is not a failure (`result.superseded`, `scene-dialogs.tsx`).

## Decisions

### Answered by the owner

- **D1. Scope.** Better UX in Studio's Scenes section on every platform,
  built around this user's day: several apps on one monitor, switched by
  key. Window capture on Windows is its own backend plan.
- **D2. Every scene owns its screen.** A scene is _what it shows_ (an app's
  front window, a fixed window, a display, or nothing) plus _how it's
  arranged_ (its layouts, the camera's spot and shape, its background).
  - The built-in layouts stop being things you switch to. They become the
    **Layout** choice inside a scene.
  - Studio's gallery shows only scenes.
  - Every Screen picker (Studio, Sources, the phone's display list) changes
    **the screen of the scene on stream**. There is no "Unsaved scene" and no
    silent leaving.
- **D3. Four default scenes.** Today's four 16:9 layouts become scenes:
  **Screen + camera**, **Screen only**, **Camera only** and **Side by side**.
  - New user: the three screen scenes show the main display; Camera only
    shows no screen.
  - On update: they show whatever screen the user has now, so nothing on
    stream changes. Migration details are D15.
- **D4. One scene works in both orientations.** A scene stores what it shows
  once, plus a **16:9 layout** and a **9:16 layout**.
  - The 9:16 layouts (Camera top, Camera bottom, Split, Screen + camera,
    Screen only, Camera only) are layout choices inside a scene.
  - A scene's key works in a 16:9 studio, a 9:16 studio and on both legs of
    a dual stream at once, each leg in its own layout.
  - The Vertical stream panel shrinks to the scene on stream's 9:16 layout
    and Fill or Fit. "Follow the horizontal program" goes away: every scene
    now has its own 9:16 layout.
- **D5. Keys by position.** The first nine scenes answer to **⌃⌥1 to ⌃⌥9**
  on macOS and **Ctrl+Alt+Shift+1 to 9** on Windows and Linux, from any app,
  idle or live.
  - Not Ctrl+Alt on Windows: Ctrl+Alt is AltGr there, and AltGr plus a digit
    types `{ [ ] }` `² ³` on German, Polish, Nordic and other layouts.
  - Each card shows its key chip. Reordering moves keys with positions.
  - Set key… stays for a custom key that sticks to its scene.
  - Next scene and Previous scene walk the same order (no default keys).
  - A new scene goes **at the end**, so making one never moves a key in use.
- **D6. One Add scene… picker.**
  - Groups: **Apps** (macOS: icon, front-window picture, "Chrome · 3
    windows"), **Displays** (with a picture on macOS), **Camera only**.
    Several can be chosen: "Add 3 scenes".
  - Each new scene is named after what it shows, takes the look of the
    scene on stream (16:9 and 9:16 layouts, camera spot, background), lands
    at the end with its key, and never changes what's on stream.
  - **Save scene… goes away.** ⋯ → Duplicate makes "another one like this".
  - A **fixed window** moves to a scene's ⋯ → Change screen… as "A specific
    window".
  - Windows and Linux show Displays and Camera only.

### Recommended, taken on the owner's "continue all recommended"

- **D7. Cards show what the scene shows.** A card draws its layout with the
  screen area filled by a still picture of the scene's screen (the app's
  front window, the fixed window, or the display), the camera area as a
  neutral plate, then the app icon, the name and the key chip.
  - Pictures come from one new RPC, `sources.scene_pictures` (D17), on
    macOS. Windows and Linux keep the glyph inside the layout.
  - A picture is never the live program and never claims to be: it's a
    still, refreshed when the Studio or Scene page shows, when a scene is
    added or its screen changes, and at most every 30 s while the window is
    visible. Never while the window is hidden, and never while Hide screen
    holds (the cards keep their last pictures).
- **D8. Studio's Scenes section becomes the home of scenes.**
  - Header: the 16:9 / 9:16 toggle (locked while recording or live, as
    today), "Follow the app in front" (macOS, moved from the Scene page),
    Edit scene, Add scene….
  - The cards, draggable to reorder (with ⌥← ⌥→ on a focused card for the
    keyboard), each with its ⋯ menu.
  - Under the cards, the scene on stream's own fields: **Screen** ("Figma ·
    front window", Change…, Hide screen), **Layout** (16:9 or 9:16 by the
    studio's mode) and Fill / Fit. With a vertical stream armed, a second
    row, **Vertical stream layout**, sets the scene's 9:16 layout.
  - Studio's **Sources** section loses its Screen row (the screen now lives
    with the scene) and keeps Camera. Hide screen's button and the "Screen
    hidden" chip move to the scene's Screen row.
  - The Scene page keeps the canvas editor (placement, camera look,
    background, banners) and the Hide screen settings, and mirrors the same
    scene list (rows, drag, ⋯). It loses the Layouts group and the Unsaved
    row.
  - The design skill's "Where things live" and `docs/ui-copy.md` change to
    match (S8).
- **D9. The camera device is one, for every scene.** Sources (and Studio's
  Camera row) choose the camera for all scenes. A scene decides whether the
  camera shows, where and in what shape, never which device. Migration drops
  each scene's `cameraId`; the camera in use at update stays the camera.
  A different camera per scene is out of scope.
- **D10. Audio stays as it is.** Scenes keep no audio unless ⋯ → Save audio
  to scene pins it (owner call #876; plan 210 D4). Microphone and System
  audio changes never rewrite a scene.
- **D11. Edits save into the scene on stream** (plan 210 D3 kept): layout,
  camera spot and shape, background, framing, and now its screen. Undo
  (`stage-undo-control`) covers mistakes. A scene that isn't on stream
  changes only through its ⋯ (Rename…, Change screen…, Set key…, Follow,
  Save audio to scene, Duplicate, Delete).
- **D12. Follow the app in front stays on by default** (plan 210 D10). A
  key, a card click or a remote counts as a hand pick and holds until the
  next app change, as today.
- **D13. Keys in Settings → Shortcuts.**
  - A "Scenes" group lists **Scene 1 to Scene 9** with the scene each holds
    now ("Scene 1 · Figma") and its key, each changeable or clearable like
    every key there, then each scene's custom key.
  - The per-layout keys and their group go away (D15 migrates them).
  - A key another app holds says so on its row and on the card's chip
    ("Another app uses ⌃⌥3"), through `lib/global-shortcut-owner.ts`.
  - Scenes after the ninth have no position key; Set key… gives them one.
- **D14. Remotes and agents switch scenes, never layouts.**
  - The Stream Deck's Scene action and the phone list every scene (all are
    named scenes now).
  - `sceneApply` keeps `sceneId`. A legacy `layoutPreset` goes to the first
    scene whose layout in the current orientation is that layout, else it
    is refused with "No scene uses {Layout}". A `screenId` changes the
    screen of the scene on stream, like every Screen picker (D2).
  - MCP `list_scenes` returns scenes only; `switch_scene` accepts a legacy
    layout id with the same rule. ⌘K reads "Switch to {name}" for every
    scene and gains "Add scene…". Buddy's planner reads `list_scenes`.
- **D15. Migration: nothing on stream changes on update.** Writes a new key,
  `videorc.scenes.v2`, and leaves `videorc.scene-presets.v1` untouched, so a
  downgrade still finds its scenes. Order after migration:
  1. the user's saved scenes, in their order, so a streamer who made
     "Figma" and "T3 Code" with plan 210 gets ⌃⌥1 and ⌃⌥2 at once;
  2. the four default scenes with today's screen, skipping one that equals
     a saved scene (same screen, same 16:9 layout);
  3. the working setup, if it matches none of them (a freeform arrangement,
     or a saved scene left by a Screen pick), named after what it shows
     ("Display 1", "Figma").
  - The scene on stream after update is the one matching what was on:
    the saved scene, the default with its layout, or the scene from step 3.
  - A scene's 9:16 layout is what the vertical stream shows for it today:
    with Follow on, Camera only → Camera only and Screen only → Screen only;
    everything else, and Follow off, `lastVerticalPreset`. A v1 scene saved
    in 9:16 keeps its layout as its 9:16 one and takes its 16:9 twin
    (Camera only, Screen only, else Screen + camera).
  - Keys: each scene's custom key stays. A 16:9 layout key becomes the
    custom key of the default scene with that layout. A 9:16 layout key
    becomes the custom key of the first scene whose 9:16 layout matches;
    if none, a scene is added for that layout (named after it, today's
    screen) so the key keeps working.
  - `Follows` on a scene for an app stays.
  - Tested on fixtures (S1), never by hand alone.
- **D16. Deleting.** The last scene can't be deleted ("Keep at least one
  scene."). Off air, deleting the scene on stream first switches to the
  scene before it. While recording or live, Delete on the scene on stream
  is disabled: "Switch to another scene first."
- **D17. Pictures RPC.** `sources.scene_pictures({ targets, maxWidth })`
  takes the scenes' targets (app bundle ids, window ids, display ids) and
  returns a small JPEG per target, through `SCScreenshotManager` like
  `sources.app_previews`, off the capture path. Budget: ten pictures at
  240 px in under 150 ms of backend time; never while Hide screen holds.
  Windows and Linux return `unsupported` and the cards keep their glyphs.
- **D18. A scene that shows no screen leaves the screen capture running.**
  Camera only (and any scene whose layout shows no screen) composites no
  screen but doesn't stop the capture, so going back to Figma is a swap in
  place, not a cold start. S0 measures today's behaviour first. As today
  with the built-in Camera only, the Screen file keeps the screen.
- **D19. A layout that needs a screen on a scene that shows none** opens
  Change screen… first; cancelling keeps the old layout.
- **D20. The key HUD (Owner check).** When a key, the Stream Deck or the
  phone switches the scene while no Videorc window is in front, a small
  chip shows the scene's icon, name and key for 900 ms at the top centre of
  the display under the pointer, then fades (100 to 150 ms, still under
  reduced motion).
  - It is left out of every capture: Videorc's ScreenCaptureKit filter on
    macOS and `WDA_EXCLUDEFROMCAPTURE` on Windows, the Stream Manager's
    route. If the exclusion can't be confirmed, it doesn't show. Not on
    Linux.
  - A refusal shows too ("Figma isn't open").
  - Settings → Shortcuts → "Show the scene's name when a key switches it",
    on by default.
  - **Owner check:** this bends "No success toast for a scene, layout or
    source change" (2026-07-16). That call's reason is that the stage
    confirms the change, but with one monitor and Figma in front no stage
    is visible. It ships as its own phase and PR, so it can be dropped
    without touching the rest.

The other **Owner check** is D8: it moves the home of scenes from the Scene
page (plan 210) to Studio, as the owner's ask reads ("our scenes section
inside of Studio"), and changes plan 210 D2 (new scenes first) to D5 (new
scenes last).

## The model

```ts
// lib/scenes.ts (new); replaces SavedScene for everything but migration.
type SceneShows =
  | { kind: 'app'; bundleId: string; name: string; follows: boolean }
  | { kind: 'window'; windowId: string; windowName?: string }
  | { kind: 'display'; screenId: string; screenName?: string; screenUuid?: string }
  | { kind: 'none' } // shows no screen (Camera only); D18
  | { kind: 'test-pattern' } // development builds

type Scene = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  shows: SceneShows
  layouts: { horizontal: LayoutSettings; vertical: LayoutSettings }
  background: SavedSceneBackground | null
  audio?: SceneAudio // only when pinned (D10)
}

type SceneLibrary = { version: 2; scenes: Scene[]; onStreamId: string }
// The custom keys stay in GlobalShortcutsConfig.scenes[id]; the position keys
// are `scene-slot-1` … `scene-slot-9` with platform defaults (D5, D13).
```

The camera device lives in `captureConfig.sources` only (D9).
`lastVerticalPreset`, `lastHorizontalPreset` and `simulcastFollowsProgram`
become migration inputs, then stop steering anything.

## What the user will see

Their day, on macOS, after this plan:

1. **Setup, once.** Studio → Scenes → Add scene…. Apps shows Figma, T3 Code
   and Chrome ("3 windows"), each with a picture. They choose all three and
   press "Add 3 scenes". Three cards appear after the four defaults, each
   showing its app, with ⌃⌥5, ⌃⌥6 and ⌃⌥7. They drag them to the front:
   now ⌃⌥1, ⌃⌥2 and ⌃⌥3. Nothing on stream changed.
2. **The relation is on screen.** Under the cards: "On stream: Figma",
   Screen "Figma · front window" with Change…, Layout "Screen + camera".
   Sources → Screen says the same thing and changes the same scene: "Shown
   by Figma, the scene on stream. Each scene keeps its own screen."
3. **Streaming.** In Figma, ⌃⌥2: the stream cuts to T3 Code within D5's
   budget, and the HUD says "T3 Code ⌃⌥2" for a moment, off stream. ⌘-Tab to
   Chrome: Follow cuts to Chrome. ⌃⌥4 (Camera only) for a break, ⌃⌥1 back to
   Figma: a swap in place, no cold start.
4. **Vertical.** With a vertical stream on, every key cuts both legs, each
   in its own layout. Vertical stream layout under the cards sets this
   scene's 9:16 layout.
5. **Tomorrow.** Figma relaunched overnight; the card still shows Figma.

On Windows today: the same cards, keys (Ctrl+Alt+Shift+1–9), defaults and
model, with Displays and Camera only in Add scene…; scenes differ by display
and layout until window capture lands.

## Phases and slices

Each slice leaves the branch building and its unit tests green. Write and
commit every slice of a phase, then run the phase's gates once at the end
(owner rule). Every UI slice reads the whole design skill and
`docs/ui-copy.md` first and hands back light and dark screenshots (owner
rule: both themes).

One branch, `plan-231-scenes-own-their-screen`. Phases A, B and D go in one
PR (the old gallery can't ship with the new model). Phase C is its own PR.

### Phase A: the model (all platforms)

#### S0. Measure today (Diagnose, fit 9, `gpt-6.1-sol`)

- Record, on this Mac with `smoke:smart-scenes`'s fixture apps:
  - Camera only → an app scene: does the screen capture stop on Camera
    only (cold start back) or keep running? Click to new picture, p50 and
    p95 over 10 round trips.
  - App scene ↔ app scene through the `scene:<id>` shortcut path (the smoke
    command server; the T3 terminal can't post HID), to compare with S11.
  - `sources.app_previews` time for every app at 240 px.
- Screenshots of Studio's Scenes and Sources sections and the Scene page,
  light and dark, for the before/after.
- **Done when** the numbers and screenshots are in this plan's Execution
  notes, with the host load for each run.

#### S1. Scene library v2 and its migration (Implementation, fit 9, `fable-5.1`)

- New `lib/scenes.ts`: the types above, `hydrateScenes`, `normalizeScene`,
  `defaultScenes(mainDisplay)`, and `migrateToScenes(v1Library, workingScene,
captureConfig, globalShortcuts)` implementing D3, D4, D9 and D15.
- `hooks/use-scenes.ts` reads `videorc.scenes.v2`, migrates from v1 once,
  writes v2 in one `setItem`, and never writes v1. Read-only on an unknown
  version, as today.
- Not wired to the Studio yet.
- **Tests** (fixtures under `lib/__fixtures__/scenes/`): new user; plan 210
  user (Figma and T3 Code, working on Figma, follows on); built-in user
  with layout keys; vertical user with follow on, and with follow off; a
  saved vertical scene; working freeform; a saved scene left by a Screen
  pick; unknown version; a default equal to a saved scene (skipped); a 9:16
  layout key with no matching scene (adds one). Each asserts the order, the
  scene on stream, every scene's 16:9 and 9:16 layout, and the keys.
- **Done when** the tests pass and the plan 210 fixture puts Figma first,
  on stream, with ⌃⌥1.

#### S2. The Studio runs on scenes (Implementation, fit 9, `fable-5.1`)

- `use-studio.tsx` holds `onStreamId` and applies scenes through the
  existing saved-scene path (`applySavedScene`, `scene-apply-preflight.ts`,
  the D5 swap in place, `heldAppWindow`), with the layout for the studio's
  orientation.
- Every Screen pick changes the scene on stream's `shows` (D2, D11);
  `capturePickLeavesScene` and the "Unsaved scene" state go away.
- The camera device comes from `captureConfig.sources` only (D9).
- A scene that shows no screen keeps the running capture (D18), per S0's
  finding.
- Layout edits, canvas edits and framing save into the scene on stream.
- The old layout apply (`applyCameraPreset({ layoutPreset })`) becomes "set
  the scene on stream's layout" for the canvas and smokes, and "switch to
  the first scene with this layout" for keys and remotes (D14).
- Minimal UI so the branch runs: the gallery lists scenes with today's
  cards, the Layouts group is gone. S6 replaces it.
- **Done when** the desktop tests pass, `smoke:smart-scenes`,
  `smoke:scene-presets` (updated for v2), `smoke:scene-switch-pixels` and
  `smoke:live-layout-switch-recording` pass, and no surface says "Unsaved
  scene".

#### S3. One scene, both orientations (Implementation, fit 9, `fable-5.1`)

- The 9:16 studio applies each scene's `layouts.vertical`; the gallery is
  the same list in both modes.
- The vertical leg streams the scene on stream's `layouts.vertical` with
  its framing: `simulcastLegLayout` takes the scene, not
  `lastVerticalPreset`. A scene switch commits both legs (plan 210's "each
  leg cuts on its own scene" stays).
- The Vertical stream panel edits the scene on stream's 9:16 layout and
  Fill / Fit, and loses its six-card gallery and the follow switch.
- `ORIENTATION_SWITCH_LOCK_REASON` stops applying to scenes (every scene
  has both layouts); the canvas orientation itself stays locked while live.
- **Done when** `smoke:multistream:vertical` and
  `smoke:multistream:vertical-fill` pass, and a test shows one key cutting
  both legs to the same scene in their own layouts.

#### S4. Keys by position (Implementation, fit 8, `gpt-6.1-sol`)

- `shared/global-shortcuts.ts`: actions `scene-slot-1` … `scene-slot-9`,
  defaults `Control+Alt+<n>` on darwin and `Control+Alt+Shift+<n>` on win32
  and linux; the layout actions go (migrated in S1).
- The renderer resolves a slot to the scene at that position when pressed.
- Next and Previous walk scenes only (`scene-shortcut-walk.ts`).
- Settings → Shortcuts: the Scenes group of D13, with conflicts through
  `global-shortcut-owner.ts`.
- **Done when** unit tests cover defaults per platform, slot resolution
  after a reorder, a custom key beside a slot key, a conflict, and the
  walk; and Settings → Shortcuts shows "Scene 1 · Figma ⌃⌥1" in light and
  dark.

### Phase B: the Studio UX

#### S5. Scene pictures (Implementation, fit 8, `gpt-6.1-sol`)

- Backend `sources.scene_pictures` (D17) with its contract entry in
  `shared/backend-rpc-contract.ts` (strict contract: new fields must be
  there) and a protocol fixture.
- `hooks/use-scene-pictures.ts`: D7's refresh rules, nothing while hidden
  or while Hide screen holds.
- **Done when** a Rust test covers the target kinds and the Hide screen
  refusal, a renderer test covers the refresh rules, and ten pictures come
  back in under 150 ms of backend time on this Mac (logged).

#### S6. Studio's Scenes section (UI/Product Design, fit 9, `opus-5.5`)

- The section of D8: header, picture cards (D7) with key chips and ⋯, drag
  and keyboard reorder, the "On stream" fields (Screen with Change… and
  Hide screen, Layout, Fill / Fit, Vertical stream layout).
- Studio's Sources section drops the Screen row; the stand-in and switch
  status lines move with it.
- #1312 stays as it is: the pending mark on the card that's switching, the
  status line under the cards, and a newer click or key taking the switch
  over.
- `SceneCard` and `LayoutThumb` grow the picture; no new primitive where
  one exists (`MediaCard`, `KebabMenu`, `ShortcutKeys`, `DisabledReason`,
  `SegmentedControl`, `DevicePicker`).
- Retro LCD Studio gets the same section in its look
  (`studio/retro-lcd-studio.tsx`, owner call 2026-10-25).
- **Done when** the user's day steps 1 to 3 work by hand, light and dark
  screenshots are in the PR, the renderer guards pass, and
  `smoke:scene-item-drag` and `smoke:freeform-editor` pass (their
  pre-existing reds from 11-03 named, not chased).

#### S7. Add scene… and Change screen… (UI/Product Design, fit 9, `opus-5.5`)

- `new-scene-dialog.tsx` becomes Add scene…: Apps, Displays, Camera only,
  multi-choice, "Add 3 scenes" (D6). Change screen… is the same picker for
  one scene, with "A specific window" under Apps.
- Save scene… goes away from Studio, the Scene page and ⌘K.
- **Done when** making the three app scenes and changing one to a fixed
  window work by hand, tests cover naming ("Figma 2"), the end-of-list
  placement and "never touches the stream", with screenshots in both
  themes.

#### S8. Sources, the Scene page and the words (UI/Product Design, fit 9, `opus-5.5`)

- Sources → Screen: "Shown by {Scene}, the scene on stream. Each scene keeps
  its own screen." Its picker changes that scene (D2). Permission alerts
  stay.
- The Scene page list mirrors Studio's (D8).
- `CONTEXT.md`: Scene, Layout, Default scene, Scene key; retire "Saved
  scene" in copy and "Unsaved scene".
- `docs/ui-copy.md`: "Add scene…", "Change screen…", "Scene 1 · Figma",
  "Shown by…".
- The design skill: "Where things live" (Scenes, Devices, Hide screen).
- **Done when** the copy and style guards pass and both themes are
  screenshotted.

#### S9. Remotes and agents (Implementation, fit 8, `gpt-6.1-sol`)

- `remote_control.rs` and the renderer's remote surface apply D14; the
  phone (`crates/videorc-backend/remote_web/app.js`) lists scenes; the Stream Deck plugin's Scene
  action reads the list and drops the layout-only path; MCP
  `list_scenes` and `switch_scene` with updated `agent-tools.json`; ⌘K;
  Buddy's planner.
- **Done when** `smoke:remote-control` passes, plugin and fixture tests
  cover the legacy `layoutPreset` mapping and its refusal, and ⌘K lists
  every scene.

### Phase C: the key HUD (macOS, Windows; Owner check)

#### S10. The HUD (UI/Product Design, fit 8, `opus-5.5`)

- A main-process, non-focusable, click-through window per D20, protected
  through `window-capture-protection.ts` (a new role, `scene-hud`, with its
  smoke marker colour), fail closed.
- The switch in Settings → Shortcuts.
- **Done when** a Display scene recording through a switch shows no HUD
  pixels (the protection harness's marker check), the HUD shows only while
  another app is in front, and both themes are screenshotted.

### Phase D: proof and docs

#### S11. The smoke and acceptance (Implementation, fit 7, `gpt-6.1-sol`)

- Extend `smoke:smart-scenes` (or add `smoke:scene-keys` under
  `smoke:recording-studio`): migrate a plan 210 v1 fixture library, add
  three app scenes, reorder, switch by `scene-slot-*` through the smoke
  command server, assert the program, zero black and zero wrong-layout
  frames, both legs on a vertical stream, Camera only → app as a swap in
  place, and two position keys inside one switch ending on the second
  scene.
- `docs/` acceptance note with S0's before and the after numbers.
- **Done when** the smoke passes twice on this Mac on a host under load
  10, and `pnpm smoke:recording-studio` passes once on the branch.

## Verification summary

- Every slice: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`.
- S5: `cargo fmt --check --all`, `cargo test -p videorc-backend` (targeted,
  one build at a time), `cargo clippy -p videorc-backend -- -D warnings`.
- Phase A end: `smoke:smart-scenes`, `smoke:scene-presets`,
  `smoke:scene-switch-pixels`, `smoke:live-layout-switch-recording`,
  `smoke:multistream:vertical`, `smoke:multistream:vertical-fill`,
  `smoke:preview-scene-commit`, `probe:scene-window-switch`.
- Phase B end: `smoke:remote-control`, `smoke:scene-item-drag`,
  `pnpm build`.
- Phase D: the new smoke, then `pnpm smoke:recording-studio` once.
- Windows: `smoke:hide-screen:windows` on the Windows box (Hide screen moved
  rows), and the Windows CI gates.

## Edge cases

- **The app isn't open.** The card says "Figma isn't open"; its key does
  nothing on stream, Next and Previous skip it, the HUD says so.
- **A fixed window closed.** The card says it, with ⋯ → Change screen….
- **A display unplugged.** "Display 2 isn't connected" on its card.
- **Camera off in Sources.** Scenes that need the camera (Camera only, Side
  by side, the banded 9:16 layouts) say so once under the cards, with Open
  Sources.
- **Reorder while live.** Keys move at once; the chips show it.
- **Two keys in quick succession.** ⌃⌥2 then ⌃⌥3 before the first switch
  lands: the second takes the switch over (#1312), the card shows the
  pending mark, and the HUD names only the last scene.
- **Hide screen holds.** A switch keeps the screen hidden (plan 210); card
  pictures freeze.
- **Linux mid-session.** A scene showing a different screen is refused with
  the existing reason; same-screen scenes switch.
- **More than nine scenes.** The tenth on has no position key.
- **Two of the same app.** "Figma 2"; both show Figma's front window.
- **A downgrade.** The older app reads v1 and its scenes as they were; the
  v2 scenes made since are not there.

## STOP conditions

Stop and ask the owner when:

- The migration would change what's on stream, or what the vertical stream
  shows, at the first launch after update, on any fixture.
- Switching regresses: `smoke:smart-scenes` p95 over 150 ms on a host under
  load 10, or any black or wrong-layout frame.
- A default position key can't be registered on a clean macOS or Windows
  install.
- The HUD's capture exclusion can't be proven on a Display scene (ship
  without Phase C).
- Card pictures cost more than D17's budget or can reach a capture while
  Hide screen holds.

## Out of scope

- Window capture on Windows (`CreateForWindow`): its own plan, next.
- Whole-app capture with menus and popups; two screens in one scene.
- A different camera per scene.
- Keeping every scene's window capturing at once (OBS), unless D5's budget
  is missed.
- Crossfades and transitions.
- The Rust app (`videorc-rust`): it takes this model when its scenes land.
- Spotting sign-in pages (plan 210 D13).

## Risks

- **User data.** The library is per profile in localStorage. v1 is never
  written, v2 is written in one call, and every migration rule has a
  fixture.
- **Smokes that apply layouts.** 84 scripts mention `layoutPreset`. S2 keeps
  the layout apply working for them (fresh profiles get the four defaults),
  and the Phase A gates prove it.
- **Old Stream Deck plugins and phones** that send `layoutPreset` still work
  through D14's mapping, or get a named refusal.
- **Ctrl+Alt+H** (Hide screen) shares the AltGr risk on a few layouts:
  noted for a follow-up, not changed here.
- **Load-dependent timing** (plan 210's notes): read every budget on a host
  under load 10.

## Execution order

S0 → S1 → S2 → S3 → S4 (Phase A gates) → S5 → S6 → S7 → S8 → S9 (Phase B
gates) → S11 → PR for A, B and D. S10 after, as its own PR, once the owner
confirms D20. At most three Rust builds at once, one backend test or clippy
build at a time (the 11-02 kernel panic).

## Execution notes

(Empty until S0.)

### S1. Scene library v2 and its migration (2026-11-15)

Done. Nothing is wired to the Studio and nothing user-visible changed.

**Files**

- `lib/scenes.ts`: the model, the tolerant reads, the defaults, the
  migration and the pure helpers.
- `hooks/use-scenes.ts`: the library hook.
- `lib/scenes.test.ts` (47 tests), `hooks/use-scenes.test.ts` (8 tests),
  and 11 fixtures in `lib/__fixtures__/scenes/`. Each fixture is one
  profile's localStorage, parsed, by key.
- Two small edits to shared code: `sceneNameError` and `movedScenes` take
  any list of `{ id, name }` / `{ id }`, so v2 scenes reuse them.

**Numbers:** typecheck, lint and Prettier green; the full desktop unit run
is 701 files, 8130 passed, 1 skipped, no flake seen.

**The API S2 uses**

From `lib/scenes.ts`:

- `SCENES_KEY`, types `SceneShows`, `Scene`, `SceneLibrary`, `MainDisplay`,
  `ShowsSources`, `SceneMigrationConfig`.
- `hydrateScenes(raw)` → `{ library | null, readOnly, error }`;
  `normalizeScene(raw)` (throws on a broken scene).
- `defaultScenes(mainDisplay, now?)`;
  `migrateToScenes(v1Library, workingScene, captureConfig, globalShortcuts, now?)`
  → `{ library, globalShortcuts }`.
- `sceneOnStream(library)`, `sceneAtPosition(scenes, position)` (1-based),
  `scenePosition(scenes, id)`, `sceneLayout(scene, orientation)`,
  `sceneShowsWords(scene, orientation)`,
  `firstSceneWithLayout(scenes, orientation, preset)` (D14),
  `canDeleteScene({ scenes, id, onStreamId, sessionActive })` →
  `{ allowed: true, switchToId } | { allowed: false, reason }` (D16), with
  `KEEP_ONE_SCENE_REASON` and `DELETE_ON_STREAM_REASON`.
- `showsFromSources(sources)` and `showsSources(shows)`: between a scene's
  `shows` and the capture part of a source selection. `showsSources` writes
  every capture key, so a spread clears the previous screen.
- `sameShows(a, b)`, `withMainDisplay(library, display)`,
  `horizontalTwin(preset)`, `defaultSceneId(preset)`, `WORKING_SCENE_ID`.

From `hooks/use-scenes.ts`: `useScenes()` returns `scenes`, `onStreamId`,
`readOnly`, `error`, `migratedShortcuts`, and `insert(scenes, afterId?)`
(at the end by default, D5), `replace(scene)`, `rename(id, name)`,
`move(id, toIndex)`, `setOnStream(id)`, `remove(id, { sessionActive })`.
`loadScenes()` is the read without React.

**What S2 must know**

- **Save the migrated keys.** `migratedShortcuts` is non-null only on the
  launch that migrated. S2 must write it into `settings.globalShortcuts` on
  that launch: it has the layout keys as scene keys and no `layouts`. The
  hook writes one key, `videorc.scenes.v2`, and never the settings. The ids
  migration makes are stable (`default-screen-camera`,
  `layout-vertical-camera-bottom`, `migrated-working`), so a migration that
  runs twice gives the same keys.
- **The write is an effect.** The hook migrates in its state initializer
  (reads only) and stores v2 after the first render, once, also under
  StrictMode. If that write fails the scenes stay in memory and the next
  change writes them.
- **A new user's display is not known at launch.** Their three screen
  scenes show `{ kind: 'display', screenId: '' }`, v1's "nothing chosen
  yet". Call `withMainDisplay` and `replace` once the device list has the
  display. An updating user with no screen chosen gets the same.
- **`showsSources({ kind: 'none' })` says `captureOff: true`.** D18 keeps
  the capture running under a scene that shows no screen, so S2 must not
  stop the capture from that flag.
- **Unknown version:** the hook is read-only, never writes, and holds the
  four defaults on today's setup in memory, so the Studio still has a scene
  on stream.
- **A v2 library with no usable scene** is treated as missing: the hook
  migrates from v1 again and writes over it.
- `normalizeScene` reuses v1's layout check, which keeps only the keys of
  the default layout. `cameraLook` and `cameraChromaKeyEdges` are dropped
  from a stored scene, as v1 scenes and the working scene drop them today.
  If S2 wants a scene to keep the key's hide edges, that check needs them.
- `scenes.ts` does not import `scene-list.ts`, which stays with the lazy
  scene UI. Keep it that way when `use-studio.tsx` imports `scenes.ts`: the
  eager bundle has a few hundred bytes left.

**Choices the plan left open** (none changes a decision)

- **Defaults take today's look.** The built-in layouts share one look
  today, so each default is the working layout with its preset, the
  remembered framing for that layout, and the working background.
- **The scene on stream keeps the working look exactly.** Its layout in the
  studio's orientation and its background are the working ones. A saved
  scene whose working look drifted from it takes the working look.
- **A working look that is exactly a default goes on that default,** also
  after a Screen pick left a saved scene. Only a look no scene has (a
  dragged camera, Freeform) becomes the extra scene of D15 step 3. The
  fixture for "left by a Screen pick" has a dragged camera, so it adds
  "Display 2".
- **Plan 210 fixture:** the defaults show today's screen, which is Figma.
  The default Screen + camera would equal the saved Figma scene, so it is
  left out: Figma, T3 Code, Screen only, Camera only, Side by side. The
  defaults do not follow the app (`follows: false`), so only the saved
  scenes answer "Follow the app in front".
- **A default is left out only when that is safe:** same screen, same 16:9
  and 9:16 layout, not Freeform; never when it is on stream with another
  look, and never when its layout key could not move to the saved scene
  (that scene already has another key).
- **A 9:16 layout key** goes to the first scene with that 9:16 layout that
  has no key yet, because a scene has one custom key. With none free, a
  scene is added: "Camera bottom", or "Vertical screen only" for a twin
  name.
- **Camera only shows no screen only for a new user** (D3). On update it
  shows today's screen like the others, which also keeps the vertical
  stream right when Follow is off and its 9:16 layout has a screen.
- **Fill or Fit in 9:16.** A scene has one 9:16 layout for the 9:16 studio
  and the vertical stream. From a 16:9 studio it takes the vertical
  stream's framing (`simulcastScreenFraming`, Fit by default), so the
  vertical stream doesn't change. From a 9:16 studio it keeps the layout's
  own (`verticalScreenFraming`, Fill by default). A new user's scenes get
  Fit, where a 9:16 studio starts on Fill today (owner call O1,
  2026-09-21). S3 owns that default.
- **Background with no working scene:** a profile with no
  `videorc.working-scene.v1` gets scenes with no background. S2 can give
  them the library's applied background if that case matters.

### S2. The Studio runs on scenes (2026-11-15)

Done, with one thing owed to the owner: the renderer's eager bundle is over
its cap (see **Bundle**). No backend change, no contract change.

**How it is built**

- The Studio's apply, preflight, swap in place, Follow and list code read a
  scene as plan 210's snapshot (`SavedScene`: id, name, `visual`, `audio`).
  S2 keeps that shape as a **view** of the stored scene, so those paths did
  not change:
  - `lib/scene-studio.ts`: `savedSceneView(scene, orientation, camera)` and
    `sceneFromSaved(saved, template)` go between the two shapes;
    `sceneEditAutosave` is D11; `sceneKeepsCapture` is D18;
    `sceneOnStreamAtLaunch` picks the scene on stream at launch.
  - `hooks/use-scene-library.ts`: `useSceneLibrary(orientation, camera)`
    wraps `useScenes()` and gives `use-studio.tsx` the API the v1 hook had
    (`scenes`, `save`, `insert`, `replace`, `rename`, `move`, `remove`,
    `autosave`, `refreshDisplay`) plus `stored(id)`, `storedScenes()`,
    `setShows`, `setOnStream`, `editAll`, `nameMainDisplay`,
    `migratedShortcuts`.
  - `hooks/use-scene-presets.ts` and `lib/scene-autosave.ts` are deleted.
- `core.savedScenes` and `core.activeSavedSceneId` keep their names and
  shape, so the remotes, the Stream Deck plugin, ⌘K, the agent surface and
  the phone get the v2 scenes with no change (brief item 10).
  `activeSavedSceneId` is never null now. S6 to S9 can rename them.
- The view is in the **studio's orientation** (`sceneLayout(scene,
orientation)`), and its camera is `captureConfig.sources` (D9).
- `videorc.working-scene.v1` is still written on every commit, as before: it
  is the launch checkpoint (exact sources, the resolved window), and a
  downgrade reads it.

**What changed in behaviour**

- **A scene is always on stream.** `activeSavedSceneId` starts from the
  library's `onStreamId`, moves when a switch commits, and is written back.
  At launch, a look whose layout is not the named scene's (a seeded capture
  config, a downgrade and back) is on the first scene with that layout.
- **A Screen pick edits the scene on stream (D2).** Idle, the pick writes the
  scene's `shows` at once. While recording or live, the session's
  confirmation commits it and the autosave writes it. The autosave also
  writes `shows` whenever the capture changed while the same scene stayed on
  (a smoke's `configure({ sources })`, an agent). An app's front window
  changing is not a pick. `capturePickLeavesScene`, `sceneListActive`,
  `galleryPresetIsActive`, `orientationSwitchPreset`, the Unsaved row and
  both Layouts groups are gone.
- **One camera (D9).** A scene going on stream never carries camera keys.
  Only "Resolve scene sources" (the `repaired` argument) carries a camera,
  and it then becomes every scene's camera. Camera Off is the same: it is
  Sources' state, and a scene no longer turns the camera off or on.
- **D18.** A scene whose `shows` is `none` and whose layout draws no screen
  goes on stream with the capture sources, and the working app, left as they
  are. It is the request the built-in Camera only sent before S2 (same
  sources, a Camera only layout), so it matches today's behaviour by
  construction; S0's numbers were not available. A `none` scene whose layout
  draws a screen is refused as before ("No screen is chosen"), and once such
  a layout is committed on it, the scene takes the screen on stream (S7's
  D19 replaces this).
- **Edits save into the scene on stream (D11),** into the layout of the
  committed orientation; the other orientation's layout and the audio stay.
- **`applyCameraPreset({ layoutPreset })` sets the layout of the scene on
  stream.** `keepScene` is gone (it is the only behaviour).
  `applyCameraPreset(patch, { toOrientation: true })` is the 16:9 / 9:16
  toggle: the scene goes on in its own layout for that orientation. A preset
  of the other orientation without that option starts from the scene's own
  layout there and replaces only the preset, so smokes that call
  `layout({ layoutPreset: 'vertical-…' })` still land on that preset.
- **Keys and remotes (D14):** `switchToSceneWithLayout(preset)` switches to
  `firstSceneWithLayout` in the studio's orientation, or returns
  `No scene uses {Layout}`. The layout shortcut actions and the remote's
  `sceneApply` `layoutPreset` use it (`context.applyLayoutPreset` now
  returns `boolean | { ok, message }`). Next and Previous walk scenes only.
- **Delete (D16):** `deleteSavedScene` is async. Off air it switches to the
  scene before first and deletes only when that switch landed. The ⋯ item
  is disabled with its reason, and the confirm says which scene goes on.
- **Undo** of a commit that put another scene on stream switches back to
  that scene through the scene path, so its screen comes back too.
- **Layout framing memory** (camera zoom and offset per layout) is recalled
  on every layout change and remembered by every commit that is not a scene
  switch. Before, a saved scene's edits never reached it.
- **First-run setup's look** goes on the first scene with its layout, and
  every `default-*` scene takes its camera shape and background
  (`scenesWithFirstRunLook`, in the lazy `first-run-look.ts`).
- **Migration is a chunk of its own.** `lib/scenes-migration.ts` has
  `migrateToScenes`, `defaultScenes`, `horizontalTwin`, the ids and
  `migrateStoredScenes`. `StudioProvider` is now a small gate: it renders at
  once when v2 is stored, and otherwise awaits `prepareScenes()` (which
  loads the chunk) and then renders. Import those names from
  `@/lib/scenes-migration`, not `@/lib/scenes`.
- The migrated keys are saved once (`migratedShortcuts` →
  `settings.globalShortcuts`), and `nameMainDisplay` names the main display
  for the scenes that wait for it.

**Numbers:** `pnpm typecheck`, `pnpm lint` and Prettier green. Full desktop
unit run: 701 files, 8149 passed, 1 skipped, no flake seen.
`studio-provider.integration.test.ts`: 215 passed (14 scene tests rewritten
for scenes, 2 added: D18, and the migrated keys saved once).

**Bundle (owed: the owner's call).** `pnpm check:renderer-assets` fails.

|                                         |       raw |    gzip |
| --------------------------------------- | --------: | ------: |
| Before S2 (`ed6c50c03`)                 | 2,361,337 | 485,281 |
| S2, first build                         | 2,389,323 | 491,303 |
| S2, migration and first-run helper lazy | 2,381,700 | 489,705 |
| Cap                                     | 2,365,000 | 487,000 |

It is 16,700 raw and 2,705 gzip over. None of it is UI: the gallery and the
scene list are lazy and lost code. It is the scene model the provider needs
before first paint (the stored-scene check, the view, D11's autosave, the
library's edits), on top of plan 210's snapshot code that the view keeps
alive. The renderer is not minified, so raw moves by whole source bytes.
What I tried: the migration, its v1 reader and the first-run look helper
are lazy (7,623 raw, 1,598 gzip back). What is left to move is about 6 KB
raw (the autosave, delete and layout-key helpers behind the scene-apply
chunk), which makes every edit's save wait on a chunk and still leaves it
over. Later slices delete eager v1 code (S3: `lastVerticalPreset`,
`simulcastFollowsProgram`, `studioModeTogglePreset`; S4: the layout
shortcut actions; S7: Save scene…), so measure again at the Phase A gate
before asking for a raise. The cap is untouched.

**Deviations**

- The orientation toggle no longer falls back to a layout the current
  sources can show (retest 150's `orientationSwitchPreset`). A scene has one
  9:16 layout (D4); when the sources can't show it, the toggle is refused
  with the existing reason.
- "Save scene…" still pins the current audio into the scene it makes, as it
  did (its dialog says so). D10's "no audio unless pinned" holds for New
  scene… and for every edit. S7 removes Save scene….
- A remote `sceneApply` `screenId` is not read by the renderer today (the
  executor takes `sceneId` or `layoutPreset`), so there was nothing to
  change. The phone's display list and the agents' `set_sources` go through
  `switchSourceDeviceLive`, which now edits the scene. S9 owns `screenId`.
- No screenshots: S2 adds no UI, it removes two groups and a row. S6 and S8
  own the look.

**What S3 must know**

- The 9:16 studio already applies each scene's `layouts.vertical`, and the
  toggle already keeps the scene (`toOrientation`). What is left of S3's
  first bullet is the gallery's wording and `ORIENTATION_SWITCH_LOCK_REASON`
  (it can no longer trigger: a view's layout is always in the studio's
  orientation).
- The vertical leg still streams `simulcastLegLayout(lastVerticalPreset, …)`
  from `sendSimulcastLeg`. Read the scene there with
  `storedScene(activeSavedSceneIdRef.current)` and
  `sceneLayout(scene, 'vertical')`.
- The autosave writes only the committed orientation's layout. A vertical
  leg edit made from a 16:9 studio (the Vertical stream panel) is not a
  layout commit, so S3 must write `layouts.vertical` itself: use
  `sceneLibrary.replace` with a snapshot in the vertical layout, or add a
  setter beside `setShows`.
- `captureConfig.lastHorizontalPreset` and `lastVerticalPreset` are still
  written by every commit (`layoutPresetMemoryPatch`) and still read by
  `studioModeTogglePreset`, which now only names the orientation.
- A new user's 9:16 Fill or Fit default is still S1's (Fit); S3 owns it.

**What S4 must know:** the layout shortcut actions still exist and map to
scenes (D14). Deleting them removes `switchLayout`'s `direct` branch and
the `layout:` tokens in `handleGlobalShortcut`; `nextEligibleScene` is
already called with `layouts: []`.

**Smokes S11 must update** (none run in S2; nothing here was a one-line fix)

- `smoke:scene-presets` (`smoke-scene-presets-app.mjs`): expects
  `activeId === null` after `layout({ layoutPreset })` (lines 199 and 474;
  the scene now stays on and takes the layout), and its "saved Off after On"
  steps expect a scene to bring Camera Off or On back (D9: it never does).
  A fresh profile also starts with four scenes, so count from a baseline.
- `smoke:smart-scenes`: its delete step waits for `activeId === null`
  (line 851; D16 puts the scene before it on stream), `remove()` now returns
  a promise, its `keepScene` step (line 310) is the same edit as any layout
  set, and New scene… adds at the end, not the top.
- `smoke:remote-control`: waits for `activeSavedSceneId === null` after a
  layout (line 536). A remote `layoutPreset` now switches to the first
  scene with that layout, and is refused when a `layout()` call before it
  left no scene with it.
- `smoke:agent-mcp`: `switch_scene { sceneId: 'screen-only' }` now puts the
  Screen only scene on stream (the result still says `kind: 'layout'` until
  S9).
- `scripts/lib/renderer-profile-seed.mjs` (every seeded smoke): a seed that
  forgets the working scene keeps `videorc.scenes.v2`. The launch rule above
  puts the seeded layout on the first scene with it, and the seeded sources
  become that scene's screen on the next commit. A seed that needs a clean
  library must also remove `videorc.scenes.v2`.
- `probe:scene-window-switch`, `smoke:hide-screen:windows`,
  `smoke:record-latency`: `configure({ sources })` now also changes the
  screen of the scene on stream. They should pass as they are.
- The scripts that click `[data-videorc-layout-preset]` (freeform editor,
  preview interaction stress, the preview window probe) set the layout of
  the scene on stream, and should pass as they are. No script used
  `[data-scene-preset]`, which is gone from Studio and the Scene page.
- The Stream Deck plugin and the phone list `savedScenes` and light a
  layout key only when `activeSavedSceneId` is null, which never happens
  now (S9).

### S3. One scene, both orientations (2026-11-15)

Done. Renderer only: no backend, contract or smoke script change. Taken over
from a rate-limited first run: its split of `simulcastLegVideo` out of the leg
builder, the leg built from a scene, and the migration's inlined copy of the
old leg rule (same output) are kept; the rest was finished or redone.

**What the vertical stream shows now (D4)**

- The scene on stream's 9:16 layout: `simulcastLegLayout(scene, program)`
  in `lib/capture.ts`, the one builder for session start
  (`buildStartSessionParams({ sceneOnStream })`) and live sends. The scene
  gives the layout, Fill or Fit, the camera's spot, shape, size and zoom, a
  camera drag and a Freeform arrangement made in a 9:16 studio. The program
  gives what the sources look like, as before plan 231: the camera's look,
  mirror and green-screen key (with its Hide edges), and `sourceVisibility`,
  so one camera reads the same on both legs and a source hidden on stream is
  hidden on both.
- A scene switch (click, key, remote, Follow, undo) commits the program, then
  sends the leg for the scene that commit puts on stream
  (`committedSnapshot.savedSceneId`), at the same point the leg was re-derived
  before: plan 210's "each leg cuts on its own scene" is unchanged, with no
  new window of the old scene on one leg. The re-derive after the commit's
  proof now skips only a leg equal to the last one sent (a ref), not the one
  sent at commit, so a Vertical stream edit made during the wait can't leave
  the leg on the scene before.
- The Vertical stream panel edits the scene on stream's 9:16 layout and Fill
  or Fit. It lost its six cards and "Follow horizontal scene". The control is
  `VerticalStreamLayoutControl` (`components/studio/vertical-stream-layout-control.tsx`,
  in the lazy bottom-row chunk): "Layout", a `Select` of the six 9:16 layouts
  with their `LayoutThumb` (six choices are past `SegmentedControl`'s 2 to 4),
  then the existing Fill / Fit `ScreenFramingControl`. A layout the sources
  can't show is disabled, with the gallery's one reason line under it (a
  scene that shows no screen can't take a screen layout here); a read-only
  library disables both with "Update Videorc to change your scenes."
- The edit (`editVerticalStreamLayout(core, patch)`) saves through
  `sceneLibraryActions.replace` with the scene's view carrying the 9:16
  layout (the ⋯-edit path; `sceneFromSaved` saves a layout of the other
  orientation as that layout). The provider sends the leg from an effect on
  `core.sceneOnStream`, deduped against the last leg sent, so the edit goes
  live on the vertical leg only and any other write of the scene sends
  nothing new. A layout change is a layout pick (its remembered framing,
  preset arrangement, no drag); Fill or Fit keeps the arrangement.
- `lastVerticalPreset`, `lastHorizontalPreset`, `simulcastScreenFraming` and
  `simulcastFollowsProgram` steer nothing. `simulcastLegPreset`,
  `studioModeTogglePreset` and `SimulcastLegPatch` are deleted. The 16:9 / 9:16
  toggles (Studio, Scene page) name the orientation with
  `ORIENTATION_DEFAULT_PRESET`; first-run setup's toggle lands on the scene on
  stream's layout there. The fields stay stored and loaded for the migration
  and a downgrade; the commit point still writes the two layouts, and the
  panel still writes `lastVerticalPreset` and `simulcastScreenFraming`.
- `ORIENTATION_SWITCH_LOCK_REASON` is gone, with `savedSceneBlockedReason`'s
  `sessionActive` and `orientation` inputs. The canvas stays locked while
  recording or live (`requestLayoutTransaction`'s refusal and the disabled
  toggle).
- The gallery is the same list in both modes (verified, and now tested). Its
  line reads "Click a scene to put it on stream. Each scene keeps its own 9:16
  layout." in 9:16, and "Click a scene to put it on both streams, the vertical
  one in its 9:16 layout." in 16:9 with a vertical stream armed.

**O1, owed by S1 (my call):** O1 (2026-09-21) gave the vertical stream Fit (a
live program's screen is the content) and a 9:16 studio Fill (short-form).
With one 9:16 layout per scene, a new scene follows O1 by where it is made: in
a 16:9 studio, where its 9:16 layout is first the vertical stream's, Fit; in a
9:16 studio, the studio's own Fill. Every new user starts in 16:9, so their
four scenes are Fit (S1's behaviour, now asserted in `scenes.test.ts`); Add
scene… copies the scene on stream (D6). The Fill or Fit control is on the
panel and on the 9:16 gallery.

**API changes:** core `applySimulcastLeg` is gone; core `sceneOnStream`
(the stored scene on stream, both layouts) is new; `useSceneLibrary` returns
`storedList` (the stored scenes, reactive). `buildSimulcastParams`,
`simulcastLegLiveRequest` take the scene; `simulcastLegVideo(config)` is the
leg's canvas for overlays, captions, banners and the cloud test.
`SceneCard` lost `pressed` (only the follow case used it).

**Tests:** `capture-simulcast-leg.test.ts` rewritten for scenes (the leg
follows the scene, never the program's layout or the old settings; what comes
from the program). `scenes.test.ts` checks on every fixture that the migrated
scene on stream streams exactly what the leg showed before plan 231 (the old
builder frozen in the test), and O1 for a new user. Two integration tests:
one switch by click and one by key, each cutting the program then the leg to
the target scene's own 9:16 layout, a panel edit landing in `layouts.vertical`
and on the leg only, and a fast double switch ending on the right leg; and a
9:16 studio listing the same scenes in their 9:16 layouts and applying one on
a switch. `vertical-stream-layout-control.test.ts` covers the edit's layout.
First-run, scene-list, scene-card and capture tests updated.

**Numbers:** `pnpm typecheck`, `pnpm lint`, Prettier on the 27 touched files
green. Full desktop unit run: 702 files, 8151 passed, 1 skipped, no flake
seen.

|                         |       raw |    gzip |
| ----------------------- | --------: | ------: |
| Before S3 (`e0fdfc93b`) | 2,381,700 | 489,705 |
| After S3                | 2,381,469 | 489,675 |
| Cap                     | 2,365,000 | 487,000 |

S3 takes 231 raw and 30 gzip bytes off; the budget is still over by S2's
amount (the owner's call). A first version with the edit in the provider was
480 gzip up; the lazy control and the effect took it back. The lazy
bottom-row chunk grew from 12.75 to 15.46 kB (the control and its `Select`).

**Screenshots** (light and dark, a vertical stream armed through the dev
smoke API, an isolated profile):
`/Users/orcdev/projects/plan-231-run/S3/shots/videorc-ui-vertical-stream-{light,dark}.png`
(the panel) and `…-vertical-stream-layouts-{light,dark}.png` (the layout list
open). The first shots drew each list item's diagram 14 px wide, unreadable;
it is 22 px wide now. The list scrolls because the panel is at the page's
foot. Capture script: `S3/scratch/capture-vertical-stream.mjs` (not
committed); the backend was built once in this worktree for it (9 min 24 s).

**Deviations**

- The leg takes `sourceVisibility` from the program, beside the camera's
  look, mirror and key, as before plan 231; the brief named the layout and
  Fill or Fit only. Everything else is the scene's 9:16 layout.
- The edit is written by the lazy control through `sceneLibraryActions` and
  sent by a provider effect, not a provider setter (eager bytes).

**What S4 must know:** nothing in the keys changed. A 9:16 layout key in a
16:9 studio still goes through `switchToSceneWithLayout`, which looks in the
studio's orientation only.

**What S6 must know:** mount `<VerticalStreamLayoutControl />` as the
"Vertical stream layout" row. It reads the core itself, renders nothing beside
a 9:16 studio or without a scene on stream, and its "Layout" row and Fill or
Fit are the two controls D8 names. In a 9:16 studio the 9:16 layout is the
studio's own Layout (`applyCameraPreset`).

**Smokes S11 must run** (none run in S3; the Rust backend was built once in
this worktree for the screenshots)

- `smoke:multistream:vertical` and `smoke:multistream:vertical-fill` drive the
  backend directly with their own `simulcast` params
  (`VIDEORC_SMOKE_VERTICAL_LEG=fit|fill`, `vertical-camera-bottom`), so this
  renderer change doesn't reach them: they should pass as they are.
- The new scene smoke's "both legs on a vertical stream": the defaults already
  differ (Screen + camera streams Camera top, Camera only streams Camera only
  in 9:16); the stored 9:16 layouts are in `videorc.scenes.v2`. No script in
  `scripts/` sets `lastVerticalPreset`, `simulcastScreenFraming` or
  `simulcastFollowsProgram`.

### S4: keys by position (2026-11-15)

- Added `scene-slot-1` to `scene-slot-9`, with `Control+Alt+N` defaults on
  macOS and `Control+Alt+Shift+N` on Windows/Linux. Main registers them through
  the existing owner lifecycle. `globalShortcuts.sceneSlots` holds overrides;
  a missing entry uses the platform default and `''` releases the key. IPC
  validates positions 1 to 9. Duplicate checks include the platform defaults.
- A key resolves the current library position through `sceneAtPosition`, then
  uses the same `scene:<id>` apply path as a custom key: Follow's hand pick,
  refusal reasons, and superseding an in-flight switch. Empty positions do
  nothing. Next/Previous walk scenes only, in library order, wrapping and
  skipping unavailable sources/apps. Their existing `layout-next` /
  `layout-previous` action IDs and `layoutNext` / `layoutPrevious` config names
  stay so saved bindings survive. Their dispatch stays synchronous so a canvas
  edit in the same turn cancels the pending walk.
- Per-layout actions, groups, `globalShortcutLayout` and `nextEligibleLayout`
  are deleted. `layouts` stays typed and accepted by IPC only for S1's migration
  and downgrade compatibility; none of its keys register. The remote action
  surface still needs `switchToSceneWithLayout`, so that helper remains for
  legacy remote requests (D14), with no global-key caller.
- Settings lists all nine positions with the scene name or `no scene`, then
  scenes with assigned custom keys. Existing recorder rows still
  change/clear them. Studio cards and Scene page rows show position and custom
  keys together, including the words `Another app uses <key>` when registration
  fails. The shared words come from `global-shortcut-owner.ts`; the new
  `SceneShortcutKeys` and `scene-shortcuts.ts` live in the existing lazy UI
  paths. Set key… remains how to create a scene's custom binding.

**Verification:** `pnpm typecheck`, `pnpm lint`, Prettier on the touched files,
and `git diff --check` pass. The focused Vitest run passed 10 files / 143 tests;
the standalone `studio-provider.integration.test.ts` run passed all 216 tests.
The first typecheck found one old per-layout assertion in the shared accelerator
test; it now checks position/custom ownership and platform defaults instead.
The first full desktop run failed: an unchanged `unavailable display` provider
test hit its 5-second timeout, leaving overlapping React `act()` calls and 124
subsequent failures. No known cloud-resume or quota-toast flake was identified in
that run. The full rerun, `pnpm --filter @videorc/desktop test --maxWorkers=2
--minWorkers=1`, passed all 704 files: 8,163 tests passed, 1 skipped, in 371.53 s,
with no overlapping `act()` warnings. No source changes were needed for this
timeout cascade. Logs: `desktop-full.log` and `desktop-full-final.log` in S4.

`pnpm build` passed both before and after. `pnpm check:renderer-assets` failed
both times on the inherited S2 cap overage; the cap is unchanged.

|                         |       raw |    gzip |
| ----------------------- | --------: | ------: |
| Before S4 (`960029316`) | 2,381,469 | 489,675 |
| After S4                | 2,380,657 | 489,492 |
| Cap                     | 2,365,000 | 487,000 |

S4 removes 812 raw / 183 gzip bytes. The remaining overage is 15,657 raw /
2,492 gzip bytes, still the owner's budget call. Shadscan baseline and floor
are 27; the audit command is `pnpm dlx @shadscan/cli@next --json` from
`apps/desktop`, with the pre-commit result in `S4/shadscan-pre-commit.json`.
The first attempt from the monorepo root reported an unsupported project;
running from the desktop package establishes the applicable score.

**macOS and screenshots:** all nine default position keys registered in the
real Electron app using an isolated profile (`S4/mac-registration.json`), so
the default-key STOP condition did not occur. The screenshot profile seeds
`Figma` first, with custom key F13. Both standard capture runs and the focused
Scenes-group captures passed, and these four PNGs were opened and inspected:

- `/Users/orcdev/projects/plan-231-run/S4/shots/videorc-ui-settings-shortcuts-light.png`
- `/Users/orcdev/projects/plan-231-run/S4/shots/videorc-ui-settings-shortcuts-dark.png`
- `/Users/orcdev/projects/plan-231-run/S4/shots/videorc-ui-settings-scenes-light.png`
- `/Users/orcdev/projects/plan-231-run/S4/shots/videorc-ui-settings-scenes-dark.png`

The standard captures used `VIDEORC_SMOKE_SKIP_PREBUILD=1 node
scripts/capture-ui-pages.mjs --theme=light|dark
--out=/Users/orcdev/projects/plan-231-run/S4/shots`; the focused launcher scrolled
the Scenes fieldset into view and captured each theme (`capture-scenes.log`).

Evidence/logs are under `/Users/orcdev/projects/plan-231-run/S4/`. The screenshot
apps were stopped and their owned children reaped. The shared checkout's status
matches the status saved before S4; no work was done there.

**Deviations and owed work:** retained the Next/Previous IDs/config names and
the legacy remote helper as described above. Windows/Linux defaults and main
registration have unit coverage; real Windows OS registration is owed to the
Windows box. S11 owns the heavy recording/remote/preview smokes; none ran in S4.
Global-key smoke intents must use `scene-slot-*` or `scene:<id>`; retired
`layout:<preset>` global actions are intentionally rejected.

**What S6 must know:** reuse `SceneShortcutKeys` with the scene ID, its library
index + 1, `settings.globalShortcuts`, and the platform. It handles both keys,
cleared positions, scenes after the ninth, and reactive registration conflicts.
Reordering changes the position key immediately; a custom key stays with the
scene ID. Settings custom-key rows list assigned keys only. S10 should retain
the `sceneSlots` storage/registration path when wiring the key HUD.
