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
