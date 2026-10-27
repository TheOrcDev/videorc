# Plan 207: first-run setup, steps 2 to 5

**Status:** BUILT IN PR (unmerged), 2026-10-27. S1 to S7 are committed;
S8 extends the smoke and records acceptance. Owner checks and the final
orchestrator smoke bundle remain owed. See
[acceptance](../docs/acceptance/2026-10-27-first-run-steps.md).
**Priority:** P1. Every new user meets these steps right after permissions.
**Owner request:** after plan 203's permissions step, add the next setup
steps: "What are you making?", "Your look", "Sound check" and "Where you
stream" ("let's do 1, 2, 3, 4. plan it out"). The ideas the owner picked:

1. **What are you making?** Record, stream or both. One click that shapes
   the rest: someone who only records never sees the streaming step.
2. **Your look.** A layout, the camera shape and a live background, seen
   on a picture of the scene.
3. **Sound check.** Choose the microphone, speak, set the level, turn
   System audio on or off.
4. **Where you stream.** Connect YouTube, Twitch, Kick or X, or go set up a
   stream key. Only for people who stream.

**Size:** L. Two logic slices (S1 record and steps, S4 the look's apply
path), one diagnose slice (S2 Clips without a screen), four UI slices (S3
frame and goal, S5 look, S6 sound, S7 destinations) and one acceptance slice
(S8). **Planned against:** `origin/main` `dc1309cb`, which contains plan 203
(`11e1ab9a`, unreleased). Work in a fresh worktree from `origin/main`,
never the shared checkout. **Owner route:** Orchestrator planned it (fit
10). Lanes per slice below, from `CLAUDE.md`.

## Goal

A new user leaves setup with a Studio that is already theirs: the layout
they picked, their camera in the shape they picked, the background they
picked, a microphone at a sensible level, and, if they stream, their
accounts signed in and turned on, so the first Record or Go Live works.

Every step keeps plan 203's frame: the Liquid Chrome backdrop, one centred
card, every word inside the card. Every step saves a real setting or shapes
the steps after it, every step can be left in one click, and nothing in
setup opens a capture device in the backend or raises an OS prompt.

## What's there today (verified on `dc1309cb`)

Renderer paths are under `apps/desktop/src/renderer/src/`; backend paths
under `crates/videorc-backend/src/`.

### The setup frame (plan 203)

1. **One step, hard-coded.** `FIRST_RUN_STEPS = ['permissions']`
   (`lib/first-run.ts:7`). The record (`videorc.firstRun`,
   `{ version: 1, status, step, updatedAt }`, `:9-14`) only parses with
   `step: 'permissions'` (`:31-39`), and `writeFirstRunRecord` writes that
   step (`:94`). `FirstRunSetup` always renders `PermissionsStep`
   (`components/first-run/first-run-setup.tsx:76`). Nothing advances a step.
2. **The one primary ends setup.** `firstRunPrimary(rows)`
   (`lib/system-access-view.ts:70-79`) returns Continue (`done`) or Skip for
   now (`skipped`), and either leaves setup
   (`components/app-shell.tsx:366-378`).
3. **What setup holds back** (`hooks/use-studio.tsx`): the native preview
   camera and screen (`:10405-10411`, `:10488-10494`), the Preview window
   (`:11049-11065`, restored on `app:workspace-shown`), auto-preview
   (`:13193`), Clips (`replayGrantWait`, `:15814`) and global shortcuts
   (`:16984-16986`). The shell's chords and ⌘K are off
   (`app-shell.tsx:390`, `:430`). **Not held:** the scene reload
   (`scene.load_from_capture_config`, `:9112-9150`), which commits a scene
   and starts nothing, and layout transactions.
4. **Providers.** Setup renders inside `StudioProvider`,
   `BackgroundAssetsProvider` and `WorkspaceNavContext` (`App.tsx:38-42`,
   `app-shell.tsx:491-509`), so every `useStudio*` hook and the background
   registry are reachable. `StudioMicVisualProvider` wraps the step
   (`first-run-setup.tsx:72-77`).
5. **A finished setup never reopens.** Any record that isn't `in-progress`
   reads as finished (`first-run.ts:61`). Plan 203 is unreleased, so no
   real user holds a record yet.
6. **Linux** never shows setup on a first launch (`first-run.ts:74`); "Run
   setup again…" shows the card with "Nothing to grant here".
7. **The smoke** (`scripts/smoke-first-run-app.mjs`, gate
   `scripts/lib/first-run-smoke-gate.mjs`) assumes one step and that one
   primary click leaves setup (`:350-351`, `:369-370`, `:382-384`).

### What a "Record, stream or both" choice can touch

8. **No goal setting exists** anywhere. `SessionStartIntent` is per start
   and never writes `recordEnabled` or `streamEnabled`
   (`lib/session-start-intent.ts:1-25`). Owner call: nothing goes beside
   Record and Go Live…, so the choice changes the steps, not the Studio.

### The look

9. **Fresh-profile scene.** `defaultCaptureConfig` (`lib/capture.ts:1399-1458`):
   `layoutPreset 'screen-camera'`, `cameraCorner 'bottom-right'`,
   `cameraSize 'medium'`, `cameraShape 'rectangle'`,
   `cameraCornerRadiusPct 12`, no background (`lib/background-assets.ts:160-176`).
   Sources are filled by `reconcileSourceSelection` (`capture.ts:2779`): the
   first available display, `cameras[0]`, `microphones[0]`.
10. **Layouts.** Horizontal: Screen + camera, Screen only, Camera only, Side
    by side. Vertical: Camera top, Camera bottom, Split, Screen + camera,
    Screen only, Camera only (`lib/layout-labels.ts:10-21`). The vertical
    Studio is the 9:16 canvas (`'vertical-1080x1920'`, `capture.ts:546-570`),
    switched by the gallery's "Studio orientation" control
    (`components/studio/scenes-gallery.tsx:55-68`).
11. **Camera shape.** Rectangle, Rounded or Circle (`CameraShape`,
    `shared/backend.ts:566`; the Scene page's "Shape",
    `components/tabs/layout-tab.tsx:180-184`). Picking Rounded also sets
    `cameraAspect: 'square'` (`:1211-1220`). **The shape only draws on
    Screen + camera, vertical Screen + camera and Freeform**
    (`scene_geometry.rs:248-267`); Camera only and Side by side stay
    rectangular.
12. **Backgrounds.** None, ten bundled pictures, imports, and ten live
    backgrounds with three looks each. No Premium gate on any of them. A
    live background at its default Visibility 20 draws the stage at 80 %
    (`scene_geometry.rs:79-85`). Thumbnails (384 × 216) live in
    `LIVE_BACKGROUND_THUMBNAILS` (`lib/live-backgrounds.ts:58`, lazy).
13. **Every existing apply path for a layout or background opens devices.**
    `applyCameraPreset`, `applyLayoutPatch`, `applyLiveBackground` and the
    library sync effect all go through `requestLayoutTransaction`
    (`use-studio.tsx:9665`) → `scene.layout.apply_preview` →
    `apply_scene_transaction` (`live_layout.rs:957`), which starts missing
    camera and screen sources in the backend (`live_scene.rs:1039-1052`). In
    setup that goes around plan 203's holds, and a never-asked camera would
    raise the OS prompt. **The path that opens nothing** is a `captureConfig`
    change: the scene reload sends `scene.load_from_capture_config`, an idle
    commit (`main.rs:10809-10820`). It skips the transaction's bookkeeping:
    undo, saved-scene origin, framing memory and the orientation and canvas
    coupling.
14. **No live picture of the scene fits in the card today.**
    - The macOS preview is a separate window. It docks over a DOM slot only
      in docked mode (`main/preview-dock.ts`, slots `'studio'` and `'scene'`,
      `shared/backend.ts:4257`), and a fresh profile is floating
      (`main/index.ts:2644`).
    - The main window may only open **audio** in the renderer
      (`main/web-contents-security.ts:58`), so a renderer camera stream is a
      security change.
    - The backend's `/preview/camera/latest.bmp` serves full-size stills,
      and only while the preview camera runs, which setup holds.
    - **What fits** is `SceneStage` (`components/scene/scene-stage.tsx`). It
      is the Scene page's own schematic: exact boxes, the camera mask and the
      background poster (`:903-1010`), drawn from props. The Scene page
      itself shows that schematic on a fresh (floating) profile.
    - The setup's WebGL player draws all ten live backgrounds
      (`shared/live-background-webgl.js`, `lib/live-background-player.ts`).

### Sound

15. **Microphone.** `DevicePicker kind="microphone"`, choice in
    `captureConfig.sources.microphoneId` (`lib/capture.ts:636`). On a fresh
    Mac the OS default input is listed first (`audio.rs:1790-1829`).
    Switching while idle only writes `captureConfig`
    (`components/studio/audio-section.tsx:122-126`).
16. **The level works in setup.** The warm microphone sends standby
    `audio.levels` every 50 ms on macOS (`warm_microphone.rs:376-405`). On
    other platforms the renderer analyser runs (`lib/mic-stream.ts`, audio
    only). The level is dBFS, −60 to 0 on the meter, **after Gain** on every
    path (`warm_microphone.rs:394-405`, `lib/mic-frame-sources.ts:69-83`).
    Zones: ok below −20, warn from −20, clip from −9 (`lib/audio/zones.ts:4-8`,
    "the thresholds streamers know").
17. **Gain.** `MicrophoneGainFader` (`components/audio/gain-faders.tsx:42-76`):
    −24 to +24 dB, whole dB, reset at 0, stored as
    `captureConfig.audio.microphoneGainDb`. While idle the warm microphone
    takes the new gain without reopening (`warm_microphone.rs:222-236`).
18. **Nothing processes the microphone automatically**
    (`sources-audio-mixer.tsx:201`), there is no monitor and no test
    recording, and the design skill forbids an audio control with nothing
    behind it. "Calibrate" is A/V sync, dev builds only.
19. **System audio is Off by default** (`capture.ts:1442`). macOS needs the
    Screen Recording grant (`devices.rs:416-426`). Windows needs build 20348
    or later (`devices.rs:406-414`). **Its level only reads while a session
    bus runs** (plan 201 D3), so it never reads in setup.

### Destinations

20. **Eight built-in destinations, all off, all set to a stream key**
    (`STREAM_TARGET_DEFS`, `capture.ts:695-728`; `makeStreamTarget`
    `:748-767`). They are YouTube, Twitch, Kick, X, YouTube Vertical, TikTok,
    Instagram and Custom RTMP.
    - **Connecting an account turns nothing on.** The user still has to pick
      "Connect with: Sign in" and flip Enable (`destination-card.tsx:98-101`,
      `:358-363`).
21. **Connect flows.**
    - YouTube: a consent dialog ("Connect YouTube to Videorc", a checkbox,
      "Continue to Google"; `destination-card.tsx:1007-1058`), then OAuth
      with a loopback callback.
    - Twitch: a device code.
    - Kick: OAuth with a localhost callback.
    - X: OAuth, plus a second "Authorize X Live" step for native broadcasts
      (`:1222-1280`).
    - The renderer API is `connectPlatformAccount` (`use-studio.tsx:12754-12812`).
    - None needs a videorc.com account or Premium. Multistreaming is free, up
      to 5 at once (`lib/entitlements.ts:9-13`).
    - A build without the OAuth client ids says "Signing in to {Platform}
      isn't available in this build. Use a stream key."
      (`destination-card.tsx:231-234`). Local dev builds are such a build;
      the release workflows bake the ids in.
22. **Reusable pieces.** `DestinationCard` takes props only, but brings the
    Enable switch, quality, URL modes and key fields, too much for setup.
    `OAuthAccountPanel` and `SignInPending` ("Waiting for your browser…",
    "Copy link", "Cancel", `:791-832`) are not exported.
    `PlatformGlyph` and `destination-readiness.ts` are reusable.
23. **Go Live… with nothing on** is disabled: "Turn on a destination in
    Livestream before you go live." (`lib/start-blocked-copy.ts:28`).

### A bug the onboarding run showed

24. **A fresh install that skips Screen Recording gets "Clips couldn't
    start".** Seen on 2026-10-27 in the dev app: after Skip for now, the
    backend refused three Clips starts with "the screen preview source(s)
    produced no frames" (`recording.rs:16468`). Then the renderer gave up
    with the toast "Clips couldn't start" (`use-studio.tsx:15858-15867`).
    - The default layout is Screen + camera, and with no screen granted no
      screen is chosen.
    - The backend still adds a visible Screen source with no device
      (`scene.rs:255-273`).
    - `replayStartWaitsForGrant` (`lib/replay-buffer-grants.ts:14-52`) only
      counts a _chosen_ screen, and `recordBlockedReason` only an explicit
      Screen Off (`lib/scene-presets.ts:322-333`). So nothing waits.

## Owner decisions

- **D1. Who sees the new steps.** **Recommended:** fresh installs, and any
  setup still in progress, see every step. A finished setup (`done`,
  `skipped`, `existing-install`) never reopens on its own; "Run setup again…"
  walks every step. Plan 203 is unreleased, so nobody real holds a finished
  record that would miss them. Linux keeps no automatic setup (nothing to
  grant, never tested there); its replay walks the new steps after "Nothing
  to grant here".
- **D2. Order.** **Recommended:** Permissions → What are you making? →
  Your look → Sound check → Where you stream. The streaming step appears only
  for Livestreams or Both. The header counts the steps that apply: "Step 3
  of 5", or "of 4" for Recordings.
- **D3. Moving through setup.** **Recommended:**
  - Every step has ONE primary at the footer's right: "Continue", and on the
    last step "Open Studio" ("Done" when replaying).
  - From step 2, "Back" (ghost) sits at the footer's left.
  - "Skip setup" (ghost) is on every step, and goes straight to the Studio
    with the record `skipped`. What was already chosen stays.
  - The permissions step's "Skip for now" now moves on to step 2. It no
    longer ends setup; "Skip setup" does that.
  - Escape still does nothing, and Enter presses the primary. Between steps
    the card's content cross-fades in 150 ms, and the backdrop never
    restarts.
- **D4. What are you making?** **Recommended:** three choice rows, nothing
  preselected on a first run. Clicking a row picks it and moves on, one
  click. In replay the saved choice is marked.
  - The rows are "Recordings", "Livestreams" and "Both".
  - The choice is saved in the first-run record (`goal`). It decides
    whether "Where you stream" appears, and nothing else: no Studio switch,
    no reordered buttons (owner call).
  - The footer has Back and Skip setup, and no primary (the rows are the
    action).
- **D5. The picture in Your look.** **Recommended: the scene's own picture,
  live where it's cheap.**
  - `SceneStage`'s exact boxes and the camera's shape, as the Scene page
    draws them.
  - The chosen live background moving behind them, drawn by the setup's
    player, which already runs all ten.
  - The camera and screen boxes show their device's name, not a picture.
  - The real preview opens with the Studio right after setup.
  - **Alternative:** dock the real Preview into the card, with exact pixels
    and the user's face. That needs a third dock slot and a temporary docked
    mode on a profile that is floating by default. It is native preview
    lifecycle work on macOS first, with Windows unknown, and would need its
    own plan. A renderer camera stream is not offered: the main window may
    only open audio, a security rule.
- **D6. Card width.** **Recommended:** Your look uses the `xl` dialog width
  (768 px, the skill's "review and media" size): the picture on the left,
  the choices on the right. Every other step keeps `lg` (576 px). The width
  change animates with the cross-fade.
- **D7. Layouts and shape.** **Recommended:**
  - **Orientation:** a `SegmentedControl` with "Horizontal 16:9" and
    "Vertical 9:16", and the line "Vertical is for Shorts, Reels and
    TikTok."
  - **Layouts:** the gallery's layout cards (`SceneCard` + `LayoutThumb`)
    for the chosen orientation.
  - **Shape:** Rectangle, Rounded or Circle, shown only on the layouts that
    draw it (point 11).
  - A layout whose source is missing is disabled through `DisabledReason`:
    "Allow Screen Recording first." or "No camera found." The preselected
    layout is one that works: on a fresh install without a screen, Camera
    only; without a camera, Screen only.
  - Corner, size and margin stay on the Scene page.
- **D8. Backgrounds.** **Recommended:** "None" and the ten live backgrounds,
  each in its first look, as thumbnail tiles. None stays the default.
  Pictures, imports and other looks stay in Assets. A background shrinks the
  stage to 80 %, and the picture shows that.
- **D9. Sound check.** **Recommended:**
  - The microphone picker (`DevicePicker`, "Off" included) and its level bar
    with Gain.
  - A verdict line after three seconds of speech: "Sounds good.", "A bit
    quiet. Raise Gain or move closer." or "Too loud. Lower Gain."
  - A "Set level for me" button that sets Gain so speech peaks land near
    −12 dBFS, the middle of the meter's speech zone (−20 to −9).
  - The System audio switch, Off by default, with a line saying its level
    shows once you record or go live.
  - No monitor and no test recording (design rule; out of scope).
- **D10. Where you stream.** **Recommended:**
  - One row each for YouTube, Twitch, Kick and X, with "Sign in…".
  - Connecting **also switches that destination to Sign in and turns it
    on**. That's four at most, inside the cap of 5.
  - YouTube keeps its consent dialog first (Google's requirement).
  - X signs in here. If X Live still needs authorizing, the row's one
    button becomes "Authorize X Live…".
  - Stream-key services (TikTok, Instagram, YouTube Vertical, Custom RTMP)
    get one line, "Using a stream key, TikTok or Instagram? Set it up in
    Livestream.", and an "Open Livestream" button. It finishes setup
    (`done`) and opens Livestream → Setup.
  - A build without sign-in says so on the row, and has no button.
- **D11. Clips without a screen.** **Recommended:** fix it in this plan (S2).
  When the scene needs a screen that isn't chosen, Clips waits quietly, the
  same as for a missing grant: no refused starts and no "Clips couldn't
  start". It starts once the layout or the screen changes. Setup's look step
  also preselects a layout that works (D7).
- **D12. Names.** **Recommended:** the step titles are the four the owner
  chose: "What are you making?", "Your look", "Sound check" and "Where you
  stream". The permissions card keeps "Welcome to Videorc". In code the
  steps are `permissions`, `goal`, `look`, `sound` and `destinations`.

## What the user will see

The frame stays plan 203's: the Liquid Chrome backdrop moving edge to edge,
the title band with the traffic lights, and one card on the dialog tier.

Step 2 (lg):

```
┌─────────────────────────────────────────────────────┐
│ Step 2 of 5                              Skip setup │
│ What are you making?                                │
│ Pick what you'll do most. You can always do both.   │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ [Record]  Recordings                          > │ │
│ │           Tutorials, demos and videos, saved on │ │
│ │           this Mac.                             │ │
│ │ [Live]    Livestreams                         > │ │
│ │           Go live on YouTube, Twitch, Kick or X.│ │
│ │ [Both]    Both                                > │ │
│ │           Record and go live.                   │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ [Back]                                              │
└─────────────────────────────────────────────────────┘
```

Step 3 (xl):

```
┌──────────────────────────────────────────────────────────────────────┐
│ Step 3 of 5                                               Skip setup │
│ Your look                                                            │
│ How you'll look in recordings and livestreams. Change it any time    │
│ on the Scene page.                                                   │
│                                                                      │
│ ┌──────────────────────────────┐  Orientation [Horizontal 16:9|9:16] │
│ │ ~~~ live background ~~~~~~~~ │  Layout                             │
│ │  ┌────────────────────┐      │  [▣ Screen + camera] [▢ Camera only] │
│ │  │ Built-in Retina    │      │  [▭ Screen only]    [◫ Side by side] │
│ │  │ Display            │ (◯)  │  Shape  [Rectangle|Rounded|Circle]  │
│ │  └────────────────────┘ FaceTime HD                                │
│ │ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~ │  Background                          │
│ └──────────────────────────────┘  [None][Silk][Side Rays][Plasma …]  │
│                                   [Liquid Chrome][Line Waves] …      │
│                                                                      │
│ [Back]                                                    [Continue] │
└──────────────────────────────────────────────────────────────────────┘
```

Step 4 (lg):

```
┌─────────────────────────────────────────────────────┐
│ Step 4 of 5                              Skip setup │
│ Sound check                                         │
│ Pick your microphone and talk the way you will when │
│ you record.                                         │
│                                                     │
│ Microphone                [MacBook Pro Microphone ▾]│
│ ▮▮▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯                            │
│ Gain  ──────────●──────── +4 dB   [Set level for me]│
│ Sounds good.                                        │
│ ─────────────────────────────────────────────────── │
│ System audio                                  [  ○] │
│ The sound your Mac plays: games, music and calls.   │
│ Its level shows once you record or go live.         │
│                                                     │
│ [Back]                                   [Continue] │
└─────────────────────────────────────────────────────┘
```

Step 5 (lg, Livestreams or Both only):

```
┌─────────────────────────────────────────────────────┐
│ Step 5 of 5                              Skip setup │
│ Where you stream                                    │
│ Sign in, and Videorc sets your title and gets the   │
│ stream key for you. Each one you connect is turned  │
│ on for Go Live.                                     │
│                                                     │
│ [YT] YouTube    Connected · OrcDev                  │
│ [TW] Twitch     Not connected             Sign in…  │
│ [KI] Kick       Not connected             Sign in…  │
│ [X]  X          Not connected             Sign in…  │
│                                                     │
│ Using a stream key, TikTok or Instagram? Set it up  │
│ in Livestream.                     [Open Livestream]│
│                                                     │
│ [Back]                                [Open Studio] │
└─────────────────────────────────────────────────────┘
```

- **Copy** above is a draft. Every word goes through `docs/ui-copy.md` and
  its guards, and `{deviceNoun}` replaces "Mac" on Windows. The owner
  changes copy at the by-eye.
- **Light and dark** both (owner rule). The card follows the theme over the
  same backdrop.
- **The live background in the picture** follows the backdrop's rules: 30
  fps cap, the poster when still (reduced motion, software GPU, lost
  context), released when the step closes. While Your look shows, the
  window runs two players (the backdrop and the picture). S5 measures that.
- **Waiting on a browser** (step 5): the row shows "Waiting for your
  browser…" with "Copy link" and "Cancel", as the Livestream page does.
- **Leaving:** "Open Studio" or "Skip setup" fades the card and backdrop
  (150 ms) to the Studio, now showing the chosen look. Replay returns to the
  page it came from.

## Slices

Each slice leaves `main` shippable. Write and commit every slice first, then
run the e2e smokes and the bundle once at the end (owner rule). Unit tests
run with their slice.

### Slice S1: the record and the step list (renderer logic)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:** `lib/first-run.ts` and its test; `components/app-shell.tsx`
(resume at the saved step); `lib/system-access-view.ts` (`firstRunPrimary`
no longer completes setup).

**Changes:**

1. Record version 2:
   `{ version: 2, status, step: FirstRunStep, goal: FirstRunGoal | null, updatedAt }`.
   - `FIRST_RUN_STEPS = ['permissions', 'goal', 'look', 'sound', 'destinations'] as const`.
   - `FirstRunGoal = 'record' | 'stream' | 'both'`.
   - A version 1 record parses: `in-progress` resumes at `permissions`, and
     the finished statuses stay finished. An unknown step resumes at
     `permissions`. It never becomes "fresh": a damaged record must not
     re-greet an existing user.
2. Pure step logic:
   - `firstRunStepsFor({ goal, platform })` drops `destinations` unless the
     goal is `stream` or `both`, and drops `permissions` on Linux replay.
   - `nextFirstRunStep` and `previousFirstRunStep`.
   - `firstRunStepPosition` returns `{ index, count }` for "Step 3 of 5".
     Before a goal is picked, the count assumes the streaming step; it
     settles once the goal is known.
3. Writes:
   - Entering a step writes `in-progress` with that step, so a quit or a
     relaunch resumes there.
   - "Open Studio" writes `done`, and "Skip setup" writes `skipped`.
   - The goal is written when it is picked.
   - Replay never writes the record (plan 203). It keeps the goal it
     picked in memory for the destinations step only.
4. `firstRunPrimary` keeps choosing the permissions step's label (Continue
   or Skip for now), but neither completes setup any more: both advance
   (D3).

**Verification:** desktop unit tests: the v1 to v2 matrix, the step lists
per goal and platform, positions, resume at each step, replay writing
nothing; `pnpm typecheck && pnpm lint`.

**Done when:** the matrix is green, and a profile stopped at any step
resumes at that step.

### Slice S2: Clips waits when the scene has no screen (diagnose)

**Route / lane:** Diagnose, fit 9, `fable-5.1`. Recording behavior, and
independent of every other slice: it can run first.

**Files:** `lib/replay-buffer-grants.ts` and its test, or the
`recordBlockedReason` path (`lib/scene-presets.ts`); `hooks/use-studio.tsx`
(`replayGrantWait`). The backend only if the diagnosis shows the renderer
can't know it.

**Changes:**

1. Reproduce first. Use a fresh profile in the dev app with the screen
   unavailable: Screen Recording refused, or a smoke seam that lists no
   available display. Record the three refused starts and the toast.
2. When the scene's layout needs a screen and none is chosen, Clips waits
   the way it waits for a grant. It makes no start attempt, so there is no
   refused start, no retry and no toast. It starts within the normal
   reconcile delay once a screen is chosen or the layout no longer needs
   one.
3. Clips' existing status line names the wait: it says why it isn't
   running, in the same words Sources already uses for a missing screen. It
   is never an error toast.
4. Coordinate with plan 205 (`~/projects/videorc-wt-205`, preview source of
   truth, not merged). If it lands first, apply this rule on top of its
   Clips model; don't fork it.

**Verification:** unit tests for the wait (screen needed and not chosen,
camera-only layouts unaffected, a chosen screen without frames still
reported as today); `pnpm smoke:replay-buffer` at the end;
`smoke:scene-presets` if the blocked-reason path changed.

**Done when:** the fresh-profile repro shows no refused start and no toast,
and Clips starts on its own after switching to Camera only.

**STOP** if the only fix is in the backend's frame check
(`recording.rs:16446-16452`). Report the evidence: that check guards
recordings that don't match the preview, and it needs its own decision.

### Slice S3: the step frame and "What are you making?" (UI)

**Route / lane:** UI/Product Design, fit 8, `opus-5.5`. Read the whole
`.claude/skills/videorc-design/SKILL.md` and `docs/ui-copy.md` first.

**Files:** `components/first-run/first-run-setup.tsx`; a new
`components/first-run/setup-step-frame.tsx` (the shared header and footer);
`components/first-run/permissions-step.tsx`; a new
`components/first-run/goal-step.tsx`; `components/app-shell.tsx`.

**Changes:**

1. `FirstRunSetup` renders the current step from S1's list, inside one
   card.
   - The shared frame: the step count (`text-meta`, secondary), "Skip
     setup" (ghost) at the header's right, the title as the window's `h1`,
     the description, the body (`DialogBody`, scrolls), and the footer
     (Back at the left, the one primary at the right).
   - The permissions step keeps its icon, title and privacy line.
2. Between steps the content cross-fades in 150 ms, and the card's width
   animates to the step's size (D6). With `prefers-reduced-motion`, the
   content swaps with no animation.
   - Focus goes to the new step's first control, or its primary.
   - The `h1` changes, and a polite live region announces "Step 3 of 5,
     Your look".
3. The goal step (D4): one `GroupedList` of three `ListRow as="button"`
   rows, each an icon from the registry, a title and a line. Arrow keys move
   between rows, and Enter or a click picks a row and advances.
4. The DOM contract for the smoke:
   - `data-first-run-step` on the card, kept, now with the step id.
   - `data-first-run-step-position="3/5"`.
   - `data-first-run-back` and `data-first-run-skip`.
   - `data-first-run-goal` on each goal row.

**Verification:** desktop unit tests (renders the saved step; Back, Skip
setup and the primary per step; the goal advances and sets the step count);
`renderer-style-guards`, `renderer-copy-guards`, `renderer-shortcut-guard`;
`pnpm typecheck && pnpm lint && pnpm format:check`;
`pnpm check:renderer-assets` (new code stays in the setup chunk).

**Done when:** setup walks Permissions → goal and back in both themes, Skip
setup leaves from either, and a relaunch resumes at the goal step.

### Slice S4: applying the look without opening a device (logic)

**Route / lane:** Implementation, fit 9, `fable-5.1`. It touches the scene
and layout paths, which every recording uses.

**Files:** a new `lib/first-run-look.ts` and its test;
`hooks/use-studio.tsx` (the background library sync while setup is open);
read only: `lib/capture.ts` (orientation and canvas coupling),
`lib/scene-presets.ts` (`sceneSourceGaps`), `lib/background-assets.ts`.

**Changes:**

1. Pure helpers that turn a look choice into the same `captureConfig` and
   background-registry state the Studio's own controls produce:
   - `firstRunLookPatch(config, { orientation, layoutPreset, cameraShape })`
     follows the existing coupling: the vertical canvas with vertical
     presets, and Rounded and Circle set the square aspect.
   - `firstRunBackgroundChoice(registry, liveId | null)`.
   - A test pins each result against what `requestCameraPresetTransaction`
     and the Scene page would have written.
2. `firstRunLayoutOptions({ orientation, sources, mediaAccess, devices })`
   lists each layout as available or disabled with its reason, plus the
   preselected layout (D7).
3. **Nothing opens a device while setup is open.** The look step writes
   state only. The scene reload commits it idle
   (`scene.load_from_capture_config`, which starts nothing). The background
   library sync, which today runs a layout transaction, is held while setup
   is open and runs once when the workspace shows, the same way Clips and
   auto-preview are held.
   - Decide, and record in the execution notes, whether that first
     transaction after setup is needed at all, or whether the reload already
     carries the background.
4. Undo, saved-scene origin and framing memory: setup's changes start the
   Studio with no undo history. Note it in the execution notes; it is not a
   regression.

**Verification:** unit tests (patches per orientation and layout, shape
coupling, options per grant and device set, the held background sync);
`pnpm typecheck && pnpm lint`; at the end `pnpm probe:preview-lifecycle` and
`pnpm smoke:scene-presets`.

**Done when:** choosing a look in setup changes the committed scene with no
camera or screen opened (the backend log shows no source start until the
workspace shows), and the Studio's first frame after setup is that look.

**STOP** if the Studio can't reach the chosen look without the transaction
starting sources while setup is still open. Report the path; don't loosen
plan 203's holds.

### Slice S5: Your look (UI)

**Route / lane:** UI/Product Design, fit 9, `fable-5.1`. It's the most
visual step, and it has a second WebGL player. The owner's by-eye polish
after it runs on `opus-5.5`. Read the design skill and
`docs/live-backgrounds.md` first.

**Files:** a new `components/first-run/look-step.tsx`; a new
`components/first-run/look-picture.tsx`; `lib/live-background-player.ts`
(only if a look other than Liquid Chrome needs a typed entry); read only:
`components/scene/scene-stage.tsx`, `components/studio/scene-card.tsx`,
`components/studio/scenes-gallery.tsx` (`LayoutThumb`),
`lib/live-backgrounds.ts`.

**Changes:**

1. The picture (D5):
   - `SceneStage` draws the committed scene's boxes, mask and labels, with
     the device names in the boxes.
   - Behind it, a canvas plays the chosen live background through the
     setup's player, with the same 30 fps cap, still rules, poster first and
     release on close as the backdrop. With None, the stage shows the
     canvas tone.
   - Its aspect follows the orientation (16:9 or 9:16). On a short window
     the picture shrinks before the choices scroll.
2. The choices (D7, D8):
   - Orientation is a `SegmentedControl`.
   - Layouts are `SceneCard` + `LayoutThumb` cards, disabled with
     `DisabledReason`.
   - Shape is a `SegmentedControl`, shown only for the layouts that draw
     it.
   - Backgrounds are thumbnail tiles (`MediaCard`, `selected` rim), "None"
     first. Thumbnails load lazily from `LIVE_BACKGROUND_THUMBNAILS`.
   - Every control writes through S4's helpers at once, so the picture is
     the confirmation (no toast, owner call).
3. Cost: the backdrop and the picture together. Measure frames per second
   and the GPU process's CPU over 30 s with the step open, on the owner's
   Mac and a Windows CI or tester run. If the pair goes past the backdrop
   guard's budget, the backdrop drops to its still poster while Your look
   shows; the picture keeps moving, because it's the content.
4. The DOM contract:
   - `data-first-run-look-layout`, `-shape`, `-orientation` and
     `-background` hold the current values.
   - `data-first-run-look-picture="moving|still"` holds the picture's
     state.

**Verification:** unit tests (options render from S4, disabled reasons,
shape shown per layout); the style, copy and shortcut guards;
`pnpm check:renderer-assets`; `pnpm build`; screenshots of the step in both
themes, horizontal and vertical, with None and two live backgrounds; the
cost numbers for the acceptance doc.

**Done when:** each choice changes the picture at once, the Studio opens on
the same look, and the step reads right in both themes at the `xl` width
and in a small window.

### Slice S6: Sound check (UI and pure logic)

**Route / lane:** UI/Product Design, fit 8, `opus-5.5`.

**Files:** a new `components/first-run/sound-step.tsx`; a new
`lib/first-run-sound.ts` and its test (the verdict and the level helper);
read only: `components/studio/audio-section.tsx`,
`components/audio/gain-faders.tsx`, `components/device-picker.tsx`,
`lib/mic-meter-input.ts`, `lib/system-audio.ts`.

**Changes:**

1. Microphone: `DevicePicker kind="microphone"` (`trigger="field"`, "Off"
   included), writing through the same `buildMicrophoneSources` path as the
   Studio. Then `MicLevelMeter`, and `MicrophoneGainFader` with its reset.
   - With the microphone not granted, the row says so and offers "Back to
     permissions" (the permissions step, not System Settings).
2. The verdict (`lib/first-run-sound.ts`, pure, on the meter's post-gain
   peaks):
   - Speech is a peak above −45 dBFS. The verdict needs 3 s of speech
     within the last 8 s.
   - The 90th-percentile peak, below −24: "A bit quiet. Raise Gain or move
     closer." From −24 to −8: "Sounds good." Above −8, or any reading at
     the clip light (−1): "Too loud. Lower Gain."
   - Before speech: "Say something. The bar moves when Videorc hears you."
   - The line is polite live text, never a toast.
3. "Set level for me":
   - It is enabled once there is a verdict. Before that, `DisabledReason`
     says "Talk for a few seconds first."
   - It sets Gain to `currentGain + (−12 − p90Peak)`, rounded to whole dB
     and clamped to −24 to +24, then clears the window so the verdict
     re-measures.
   - It acts at once, so it has no ellipsis.
4. System audio:
   - The `Switch` (Off by default) with the line "The sound your
     {deviceNoun} plays: games, music and calls. Its level shows once you
     record or go live."
   - macOS without the Screen Recording grant: disabled, with
     `DisabledReason` "Comes with Screen Recording. Go back to permissions
     to allow it."
   - Windows without loopback: the backend's reason. Linux: hidden.
   - Writes the same `systemAudioEnabled` the Studio's switch writes.
5. The DOM contract: `data-first-run-sound-verdict="none|quiet|good|loud"`,
   and `data-first-run-sound-gain`.

**Verification:** unit tests for the verdict and the level helper (quiet,
good, loud, clipping, too little speech, the clamp at both ends); a
component test that the picker, fader and switch write the Studio's own
fields; the guards; `pnpm typecheck && pnpm lint`.

**Done when:** on the owner's Mac, speaking moves the bar, the verdict
changes with Gain, "Set level for me" lands a normal voice on "Sounds good."
in one press, and the Studio's Audio section shows the same microphone, Gain
and System audio after setup.

### Slice S7: Where you stream (UI)

**Route / lane:** UI/Product Design, fit 8, `opus-5.5`. OAuth itself is not
changed.

**Files:** a new `components/first-run/destinations-step.tsx`;
`components/streaming/destination-card.tsx` (export `SignInPending` and the
YouTube consent dialog, no behavior change); `hooks/use-studio.tsx` only if
a "connect and turn on" helper belongs there; `components/app-shell.tsx`
(leaving setup to Livestream).

**Changes:**

1. Four rows in a `GroupedList`: `PlatformGlyph`, the name, a status chip
   ("Not connected", or "Connected" with the account or channel name), and
   one button.
   - The button is "Sign in…". After an X sign-in that still needs X Live,
     it is "Authorize X Live…", with the same handlers the Livestream page
     uses.
   - YouTube opens its consent dialog first.
   - While waiting, the row shows `SignInPending`.
   - A build without sign-in shows the card's existing line and no button.
   - Offline shows `OfflineAlert`, with the buttons disabled.
2. A finished connect switches that destination to Sign in and turns it on
   (D10), through `patchStreamingTarget`. It shows the same "Connected
   {Platform}" toast as today.
   - A YouTube account with several channels uses its first channel. The
     row names it, and Livestream changes it.
3. The stream-key line and its "Open Livestream" button finish setup
   (`done`) and open Livestream → Setup.
4. A replay shows the current accounts. It turns nothing off, and an
   already-connected row has no button.
5. The DOM contract: `data-first-run-destination="youtube|twitch|kick|x"`,
   with `data-state`.

**Verification:** unit tests with a mocked `connectPlatformAccount`
(waiting, success turns the destination on, failure leaves it off,
unavailable build, offline); the guards; `pnpm typecheck && pnpm lint`. A
real sign-in to one platform on a release-like build is in the owner
checklist (dev builds lack the client ids).

**Done when:** a connected platform shows Connected in the step, is on in
Livestream → Setup, and Go Live… is enabled in the Studio after setup.

### Slice S8: smoke, docs and acceptance

**Route / lane:** Implementation, fit 7, `gpt-6.1-sol`.

**Files:** `scripts/smoke-first-run-app.mjs`,
`scripts/lib/first-run-smoke-gate.mjs` and its test; `CONTEXT.md` (the
"First-run setup" entry lists the steps); `docs/ui-copy.md` (new strings
that set a rule); the design skill (the owner call widens to the picture's
live background, below); `docs/live-backgrounds.md` (the look step as a
fifth place the player runs); a dated acceptance doc; `plans/README.md`.

**The owner call, rewritten in the design skill:** "**First-run setup
paints Liquid Chrome** (2026-10-27, plans 203 and 207). The Welcome screen
is the only place outside a scene where a live background runs: Liquid
Chrome, Polished, Normal motion, edge to edge, dimmed under dark. Setup
sits in one centred card on the dialog tier, and Your look's scene picture
plays the chosen live background inside the card. The backdrop is opaque
and makes no glass claim; it is decoration and never carries text. Every
other window rule stands."

**The smoke (dev app, macOS, a fresh isolated profile):**

1. Setup opens at Permissions as today (plan 203's checks stay).
2. The primary advances to the goal step. The record says `in-progress` at
   `goal`, and the position reads 2/5.
3. Picking Recordings makes the count 4 and goes to Your look.
4. Your look: Camera only (or Screen only, whichever the host allows) and
   one live background. Check that `captureConfig` and the registry hold
   the choices and the picture reads moving. **Check that the backend
   started no camera or screen while setup was open** (the backend log or
   a status probe).
5. Sound check: the meter element is present, and moving Gain by a key
   press changes `microphoneGainDb`.
6. Relaunch on the same profile: setup resumes at Sound check.
7. Open Studio: the record says `done`, the workspace shows, and the
   committed scene has the chosen layout and background. No "Clips couldn't
   start" toast within 10 s.
8. A second fresh profile picks Livestreams: the destinations step shows
   four rows (unavailable in a dev build without client ids, or Sign in…
   with them). "Open Livestream" lands on Livestream → Setup with `done`.
9. Skip setup from Your look on a third profile: `skipped`, the choices made
   so far kept.
10. Replay from Settings walks every step without touching anything. The
    record and `captureConfig` are byte-identical before and after, and
    "Done" returns to Settings.

**Owner checklist (by-eye and real accounts):**

- [ ] Both themes, every step; the step-to-step motion; Your look at `xl`.
- [ ] The picture with three live backgrounds, horizontal and vertical.
- [ ] Sound check with your own voice: the verdict and "Set level for me".
- [ ] A real sign-in to YouTube (consent dialog) and one of Twitch or Kick
      on a release-like build. Then Go Live… is enabled.
- [ ] Skip Screen Recording on a clean account: Your look preselects Camera
      only, and no Clips toast appears.
- [ ] Windows tester: every step, the cost numbers, and Sound check through
      the analyser.

**Verification:** `pnpm test:scripts`, `pnpm smoke:first-run`,
`pnpm smoke:replay-buffer`, `pnpm smoke:scene-presets`,
`pnpm probe:preview-lifecycle`, then the bundle once:
`pnpm smoke:local-gates`.

**Done when:** the smoke passes, the docs are updated, and the acceptance
doc lists every gate, the S5 cost numbers and the owner checklist with what
is owed.

## Verification summary

| Slice | Gates                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------- |
| S1    | desktop unit tests (record and step matrix), typecheck, lint                                       |
| S2    | unit tests; at the end `smoke:replay-buffer` (+ `smoke:scene-presets` if the blocked path changed) |
| S3    | unit tests, style/copy/shortcut guards, renderer asset budget, typecheck, lint, format             |
| S4    | unit tests; at the end `probe:preview-lifecycle`, `smoke:scene-presets`                            |
| S5    | unit tests, guards, asset budget, build, screenshots both themes, cost numbers                     |
| S6    | unit tests (verdict, level helper, fields), guards, typecheck, lint                                |
| S7    | unit tests with a mocked connect, guards, typecheck, lint                                          |
| S8    | `smoke:first-run`, `test:scripts`, the smokes above, `smoke:local-gates`                           |

## Edge cases

- **Quit or relaunch on any step.** Setup resumes at that step with the
  choices already applied. Permissions' Reopen still resumes at Permissions.
- **No camera, or the camera not granted.** Camera layouts are disabled
  with their reason, and Screen only is preselected. With no screen and no
  camera, Your look shows the layouts all disabled and Continue still works.
- **No microphone, or it isn't granted.** Sound check shows the reason and
  "Back to permissions"; Continue still works.
- **Vertical chosen, then Livestreams.** Go Live with a vertical Studio
  streams the 9:16 canvas. S7 checks what Go Live does with a vertical
  Studio and a horizontal destination. If it refuses or letterboxes, the
  step's description says so; this plan doesn't change it.
- **A sign-in that never comes back.** The row stays waiting, "Cancel"
  clears it, and Open Studio is never blocked by it. The backend's
  10-minute expiry still applies.
- **Port 17995 busy.** Today that's a log line only, and X then fails. The
  row shows the existing failure toast's words; fixing the port fallback is
  out of scope.
- **A user who goes Back from Sound check to Your look.** The choices stay,
  and nothing reapplies or restarts.
- **Replay while Clips runs.** Replay is allowed (Clips doesn't lock it).
  Look changes then hit a running Clips ring the way a Studio change would.
  Check this in S4: if a Clips re-arm opens a device during replay, hold the
  look's writes until setup closes in replay mode too.
- **Reduced motion.** Steps swap with no animation, and the backdrop and
  the picture show their posters.
- **A tiny window.** The card keeps 16 px a side. At `xl` the picture
  stacks above the choices below 800 px of window width.
- **Two players on a weak GPU** (S5.3): the backdrop yields first.

## STOP conditions

- S2: the fix needs the backend's frame check changed.
- S4: the chosen look can't reach the Studio without a transaction opening
  devices while setup is open.
- S5: the second player makes the backdrop guard drop both to stills on the
  owner's Mac. Report the numbers; the fallback is the poster in the
  picture, an owner call.
- S7: reusing the YouTube consent dialog outside the Livestream page would
  change what Google reviewed (the wording, or the checkbox). Keep it
  byte-identical, or stop.
- Any slice: an existing install would see setup after updating, or setup
  opens a capture device in the backend.

## Out of scope

- A live camera picture in setup (D5's alternative; its own plan).
- A microphone monitor, a test recording or tone, and any automatic
  processing (noise suppression, compressor). The design rule stands.
- A System audio level in setup (plan 201 D3: no capture outside a
  session).
- Stream-key entry inside setup, the vertical destinations and Custom RTMP
  (they open Livestream). Facebook (plan 206).
- The "Meet Buddy" and "Test take" ideas, and Clips as a tip: later plans.
- Corner, size, margin, pictures and imported backgrounds (Scene page and
  Assets).
- Offering the new steps to people who finished an older setup (D1).
- Linux automatic setup (D1).

## Risks

- **First launch stays the riskiest launch.** Four more steps mean four
  more chances to trap someone. Skip setup is on every step, every primary
  is enabled, and the step logic is pure and tested.
- **The look writes the same state the Studio writes.** A helper that
  drifts from the Studio's coupling (orientation and canvas, shape and
  aspect) would ship a scene the Studio can't reproduce. S4's tests pin
  each helper against the Studio's own result.
- **The held background sync.** It runs once when the workspace shows, so
  the Studio's first seconds do one transaction more than today. S4 decides
  whether it's needed, and the preview lifecycle probe covers it.
- **Two WebGL players** on the first launch's busiest minute (S5.3).
- **Auto-enabling destinations** changes Go Live's default for those
  accounts. It's what a user who signs in during setup expects, and the
  step's description says it.
- **OAuth on dev builds.** The smoke can't sign in, so the real connect is
  owner-checked on a release-like build.

## Execution order

1. `git fetch origin && git worktree add -b plan-207-first-run-steps-exec ~/projects/videorc-wt-207-exec origin/main`
   (never the shared checkout).
2. Read `AGENTS.md` and this plan. For S3, S5, S6 and S7, also read the
   whole design skill and `docs/ui-copy.md`.
3. S1 and S2 first, in parallel: neither depends on the other.
4. S3 after S1. S4 after S1. S5 after S3 and S4. S6 and S7 after S3, and
   both can run beside S5.
5. S8 last: the smokes, the bundle and the acceptance doc, once.

## Execution notes

S1 to S7, in `git log --oneline dc1309cb..HEAD` order at S8 handoff:

```text
9a13f3de fix(first-run): Your look fits the window, says why a layout is off, and labels its boxes (plan 207 S5)
dfbe8acc feat(first-run): Your look, the scene picture with its live background moving (plan 207 S5)
be51b97f feat(first-run): apply the look as state, never opening a device during setup (plan 207 S4)
18aa265c fix(clips): wait quietly while the scene shows a screen nobody has chosen (plan 207 S2)
256030a2 feat(first-run): Where you stream, signing in turns the destination on (plan 207 S7)
1e55bd1e feat(first-run): Sound check, with a level verdict and Set level for me (plan 207 S6)
236d69cb feat(first-run): the step frame and "What are you making?" (plan 207 S3)
818b1e54 feat(first-run): record v2 with the step and goal, and the step list (plan 207 S1)
feadeb2f docs(plans): plan 207, first-run setup steps 2 to 5
```

- S2, S4 and S5 were finished by the orchestrator (Opus 5.5) after Fable
  5.1 hit the API rate limit on three accounts; the owner chose that.
- S1 left `firstRunPrimary` alone; S3 made both permission labels advance.
  Linux drops the permissions step entirely, so its replay starts at
  "What are you making?" (D1 said after "Nothing to grant here").
- S5 draws a read-only scene picture
  (`components/first-run/look-picture.tsx`: the committed scene's boxes
  and camera mask, device names as Badge chips, "No screen"/"No camera" in
  empty boxes) instead of `SceneStage`, which is an editor with a toolbar
  and footer. The picture follows the committed scene, so it lags a choice
  by the idle scene reload (about 0.3 s).
- Your look: picture + orientation beside camera shape + background tiles
  (thumbnails, names as button names and tooltips, the chosen name in a
  line under them); layouts in a full-width row with the gallery's reason
  line and "Back to permissions".
- `lib/live-background-player.ts` gained an optional `background` (id,
  motion); the welcome backdrop is unchanged.
- The frame gained `goTo` and `leaveTo`; `FirstRunLeave` lives in
  `lib/first-run.ts`.
- `YouTubeConsentDialog` was extracted from the destination card with its
  words byte-identical, and `SignInPending` exported; setup's sign-in turns
  its destination on through `setupDestinationsToTurnOn`.
- S4's idle scene reload already carries the chosen background and updates
  the applied fingerprint. The library sync stays held while setup is
  open; on workspace entry it applies only an outstanding change. The
  normal setup path needs no redundant layout transaction. Setup starts
  the Studio without undo history; the state-only apply path intentionally
  does not create transaction undo entries or saved-scene origin changes.
- This host has no camera/mic/screen grants for dev Electron and no OAuth
  client ids. Granted paths (a moving camera box, a real sign-in, the
  verdict with a real voice) are owner-owed. The picture names devices;
  live camera capture inside setup remains out of scope.
- S8 keeps plan 203's smoke checks and adds three actual isolated profiles,
  saved-step reload, every-step replay, light/dark screenshots, the
  open-to-close source-start log scan and 30 s two-player cost sample.
  Reload normalizes absent source-off flags to false; resume checks the
  chosen layout, audio and background, while replay still requires raw
  record and captureConfig byte identity.
- S8 makes no app-source changes, adds no DOM attributes and leaves its
  changes uncommitted for orchestrator review. The orchestrator owns the
  broader recording/preview gates and runs `smoke:local-gates` once at the
  end; S8's exact results and owner checklist are in the acceptance doc.
