# Plan 210: scenes for your apps, and Hide screen

**Status:** EXECUTING, 2026-10-28. The owner took every recommended answer
(D1 to D13) and asked for the whole plan in one PR.
**Priority:** P1. This is the most common way a coding or design streamer
uses scenes, and today it takes about nine clicks, breaks when an app
relaunches, and has no way to hide a sign-in.
**Owner request:** "Our whole Scene tab needs to be much smarter than it is
right now." The owner was quoting a Videorc user:

> For example, I like to switch between T3 Code and Figma while streaming.
> With OBS I put each app in its own scene and keep switching between them,
> and I can hide them with a blurry image while doing something like auth.
> With Videorc this is still hard.

The plan turns this into three things the streamer can do:

1. **A scene for each app, made in one go.** Choose T3 Code and Figma once.
   Each becomes a scene named after the app, in your current look, and keeps
   working after the app restarts.
2. **Switching that feels instant**, from a click, a key, a Stream Deck key,
   the phone, or by bringing the app to the front ("Follow the app in
   front").
3. **Hide screen.** One key turns the screen into a frosted, unreadable
   picture on every output while the camera and microphone stay on. A
   password manager coming to the front does it on its own.

**Size:** XL, in four phases that ship as separate PRs:

| Phase | What ships                                                     | Platforms             |
| ----- | -------------------------------------------------------------- | --------------------- |
| A     | Scenes for apps, instant switching, scene keys and remotes     | macOS                 |
| B     | Hide screen                                                    | macOS, Windows, Linux |
| C     | Follow the app in front, and Hide screen for password managers | macOS                 |
| D     | The smoke, docs and acceptance                                 | all                   |

Phases A and B are independent and can run side by side. C needs A and B.
**Planned against:** `origin/main` `25aefcf2`. Work in a fresh worktree from
`origin/main`, never in the shared checkout.
**Owner route:** Orchestrator planned it (fit 10). Each slice names its own
route and lane from `CLAUDE.md`.

## Goal

A streamer who works across a few apps sets up their scenes once and then
forgets about them:

- They choose their apps, and each one becomes a scene.
- Bringing an app to the front puts it on stream, or one key does.
- The cut is clean: no frozen picture, no black frame, and never a frame of
  one scene drawn in the other scene's layout.
- When they sign in to something, one key (or the password manager itself)
  hides the screen on the recording, every stream, Clips and the Screen
  file, while viewers still see and hear them.
- Nothing breaks when an app quits and comes back.

## What's there today (verified on `25aefcf2`)

Renderer paths are under `apps/desktop/src/renderer/src/`, backend paths
under `crates/videorc-backend/src/`, shared types under `apps/desktop/src/shared/`.

### What a scene is

1. **Built-in scenes are layouts, not stored objects.** There are ten ids:
   four horizontal and six vertical (`shared/backend.ts:571-608`, names in
   `lib/layout-labels.ts:10-21`). Clicking one changes only the layout of the
   working setup, keeps the current sources, and clears the saved-scene
   identity (`hooks/use-studio.tsx:10194-10278`).
2. **A saved scene is a renderer snapshot** in localStorage
   (`videorc.scene-presets.v1`, `lib/scene-presets.ts:20-70`;
   `hooks/use-scene-presets.ts:16,23`). Neither the backend nor main holds
   one. It stores:
   - `visual`: the whole `LayoutSettings`, **one** screen _or_ window
     (`windowId` wins, `scene-presets.ts:392`), the camera, and the
     background;
   - `audio` (optional): the microphone and System audio on or off, since
     #876 on 2026-10-27 (`scene-presets.ts:40-50`). A scene without `audio`
     leaves audio as it is when applied.

   It does **not** store banners (one global set, plan 186 D3), the
   takeover, crop, output or destinations.

3. **The backend holds one live scene,** `scene:default`, with one base
   source and one camera (`scene.rs:17-37`; `state.rs:1018`). The OBS import
   says so in its own words: "Videorc scenes hold one screen"
   (`lib/obs-import-map.ts:308-310`).

### Making "T3 Code" and "Figma" today

4. **About nine clicks plus two typed names.** A saved scene is a snapshot
   of global state, so the steps are: choose the T3 Code window in Studio's
   Screen picker, then Save scene…, type "T3 Code", choose the Figma window,
   then Save scene…, type "Figma".
   - There is no "new scene for this window" (`components/scene-presets.tsx:48-98`).
   - The name field starts empty, and the Studio picker can't be searched
     (`components/studio/quick-settings.tsx:56-85`).
5. **The Modified trap.** Choosing Figma's window marks the "T3 Code" scene
   **Modified**, and the Scene page puts "Update “T3 Code”…" first
   (`scene-presets.tsx:85-94`). One wrong click overwrites the first scene.
6. **Two Screen-only scenes look identical.** The cards draw the schematic
   `LayoutThumb`, never the app (`scene-presets.tsx:184-189`).
7. **The Scene page never lists saved scenes.** Only the Studio gallery
   does, under the built-ins (`scene-presets.tsx:107`;
   `components/studio/scenes-gallery.tsx:211-213`). Saved scenes keep their
   creation order with no reorder (`use-scene-presets.ts:59-63`).
8. **"Save scene…" can be disabled without saying why**
   (`scene-presets.tsx:95,102`), which breaks `docs/ui-copy.md:162-165`.

### Window identity

9. **macOS window ids die with the window.** A window is
   `window:screencapturekit:<CGWindowID>` (`screen_capture.rs:6,604`), and
   the device record carries only id, name, kind, status, detail and size
   (`protocol.rs:225-236`): no bundle id, no pid.
10. **A saved scene matches the exact id only.** After T3 Code relaunches,
    the scene refuses to apply and says "Resolve sources"
    (`scene-presets.ts:371-399`; `use-studio.tsx:9844-9862`). That covers
    ⌘K, agents and Buddy too. The working scene rebinds by exact
    "App - Title" name, but only while idle and never to a different window
    (`lib/capture.ts:2564-2582,2867-2905`).
11. **Whole-application capture and region capture don't exist.**
    `DeviceKind` is Screen, Window, Camera, Microphone or SystemAudio
    (`protocol.rs:240-246`). Window capture uses
    `initWithDesktopIndependentWindow` (`preview_screen.rs:5794-5799`), so
    an app's menus, popovers and dropdowns are separate windows and don't
    show.

### Switching

12. **There is one screen capture slot.** `AppState.preview_screen` is a
    single `PreviewScreenSlot` (`state.rs:1003`), and the compositor holds
    one `screen` (`compositor.rs:1221-1234`).
    - Switching to another window **stops the old SCStream before starting
      the new one** (`preview_screen.rs:1367-1368,1455-1459`).
    - Each switch fetches fresh shareable content first: a 12 s timeout, two
      attempts (`preview_screen.rs:5820-5854`).
    - `updateContentFilter` and `updateConfiguration` appear nowhere.
13. **What viewers likely see (never measured).** The live switch keeps the
    old layout until the new source has frames (`live_layout.rs:9-14`). But
    by then the old capture is already stopped, so:
    - its last frame sits frozen on air;
    - at the commit the compositor drops the cached screen frame
      (`compositor.rs:1440-1443`), and an unavailable source draws black
      (plan 042);
    - the one log in plan 042 shows about 385 ms between the old capture
      stopping and the new one starting (`plans/042-clean-scene-switches.md:108-110`).

    No smoke switches one window to another
    (`smoke:live-layout-switch-recording` holds one source fixed).

14. **The transition is a 320 ms geometry glide, off by default**
    (`lib/capture.ts:682`; `compositor.rs:1852-1988`). There is no
    crossfade.
15. **Keeping the next window warm was a follow-up that was never built**
    (`plans/042-clean-scene-switches.md:188-190`).

### Where a scene can be switched from

16. **Saved scenes can be switched from:**
    - Studio cards;
    - ⌘K ("Switch to {name}", `components/command-palette.tsx:401-423`);
    - MCP `switch_scene` and `list_scenes` (`protocol-fixtures/agent-tools.json:234-283`);
    - Buddy's planner.
17. **Not from:**
    - a global key: shortcuts exist for the ten built-ins and for Next and
      Previous, which cycle built-ins only (`shared/global-shortcuts.ts:3-55`);
    - the Stream Deck or the phone: `sceneApply` takes `screenId` or
      `layoutPreset` (`remote_control.rs:71-78,194-203`), and the phone lists
      built-ins (`remote_web/app.js:557-566`).

    Plan 044 kept saved scenes off the remotes on purpose, because they carry
    a name the streamer typed (`docs/remote-control.md:305-316`). But the
    phone already receives takeover names, which are typed too
    (`lib/remote-surface.ts:39`).

18. **No global shortcut has a default key.** Every field in
    `GlobalShortcutsConfig` is optional (`shared/backend.ts:4887-4903`).

### Hiding the screen

19. **Nothing on any compositor path blurs or pixelates the screen.** None
    of these is a usable blur:
    - The background "Blur" slider is stored but never rendered
      (`protocol.rs:667`).
    - The D3D11 shader has a 9-tap per-layer blur that every producer sets
      to 0 (`windows_d3d11_shaders.hlsl:95-119`).
    - The CPU path point-samples on purpose: a full-frame bilinear pass cost
      about 2 cores at 1080p30 (`compositor.rs:10832-10837,11012-11017`).
20. **The only lever is a takeover:** a full-frame imported image.
    - It covers **the camera too** and **mutes the microphone**
      (`hooks/use-studio.tsx:4185-4214`).
    - It reaches the recording, the aux and vertical legs, the preview, Clips
      and the Screen file. The Camera file is not covered
      (`compositor.rs:9545-9550`).
    - It has no hotkey and no ⌘K command. The Stream Deck's one key is
      "BRB" (`apps/streamdeck-plugin/src/plugin.ts:196-217`).
21. **Exclusion.** Videorc deliberately captures itself (OBS parity,
    `preview_screen.rs:1069-1076`). Only the Notes window is excluded
    (`preview_screen.rs:3548-3557`). No user-chosen app is ever excluded.
22. **"Visible in scene" is locked while recording or live**
    (`lib/scene-edits.ts:9`). Switching to Camera only does hide the screen
    mid-session, but it stops screen capture, so switching back is a cold
    start.

### Focus

23. **No code observes the frontmost app or window on any platform.**
    `NSWorkspace` is used only for the reduce-transparency setting
    (`crates/videorc-native-preview-addon/src/lib.rs:643`).

### Platforms

24. **Windows captures displays only.** Windows Graphics Capture uses
    `CreateForMonitor` (`windows_graphics_capture.rs:163-201`), and window
    sources are refused (`preview_screen.rs:3631-3635`;
    `live_layout.rs:588-598`).
25. **Linux has one portal "window" slot** (`linux_portal_capture.rs:26-27`)
    and can't change the screen mid-session (`recording.rs:6737-6748`).

## What OBS does, and where Videorc can do better

In OBS, each app gets its own scene with a window or application capture,
and every source stays running, so a switch is instant. Hiding means a third
scene with a blurred image, or a blur filter from a plugin. Two things OBS
can't do without a plugin (Advanced Scene Switcher) are following the app in
front and hiding when a password manager opens. They are what make this
"smarter", not just "OBS parity".

## Owner decisions

- **D1. What a scene made for an app shows.**
  - **Recommended: the app's front window, whichever that is.** The scene
    stores the app (bundle id and name), not a window number. When it goes
    on stream, it shows that app's frontmost normal window, ignoring
    palettes and popups under 400 × 300. If the app's front window changes
    while the scene is on, the stream follows it.
  - Quitting and relaunching the app never breaks the scene: it waits for
    the app's next window.
  - **Alternative:** a fixed window, which is today's behaviour. It stays
    available through "Save scene…".
  - **Later:** the whole app with its menus and popups (an SCK
    application-filtered display capture cropped to the app's windows); see
    Out of scope.
- **D2. Making scenes.**
  - **Recommended:** "New scene…" opens a picker of open apps, each with a
    picture of its front window and its icon. Choose one or several, then
    "Add 2 scenes". Each new scene:
    - is named after its app ("Figma"; "Figma 2" if taken);
    - uses your current look (layout, camera, shape, background);
    - never touches the scene on stream.
  - "Save scene…" stays for "this exact picture".
  - On Windows and Linux, the picker offers what Sources offers today:
    displays, or the portal (D12).
- **D3. Editing a saved scene.**
  - **Recommended:** while a saved scene is on, layout, placement, camera
    and background edits save into it as you make them. Undo
    (`stage-undo-control`) covers mistakes. "Modified" and "Update…" go
    away; "Save as new scene…" stays.
  - Choosing a different screen or window in a Screen picker **leaves** the
    saved scene instead of rewriting it. The list then shows "Unsaved
    scene" with "Save scene…". A scene for an app changes its app from its
    ⋯ menu ("Change app…").
  - Microphone and System audio changes never rewrite a scene: a scene's
    audio changes only from its ⋯ menu.
  - **Alternative:** keep today's explicit Update…, with its trap (§5).
- **D4. Scenes for apps and audio.**
  - **Recommended:** a scene made with New scene… keeps no audio. The
    existing "no `audio` field" path (`scene-presets.ts:61-62`) leaves
    whatever microphone and System audio are on, so switching between apps,
    by hand or by following, never changes your microphone.
  - "Save scene…" keeps pinning audio, the owner's 2026-10-27 call (#876).
  - **Alternative:** every scene pins audio, which means following an app
    can switch the microphone mid-sentence.
- **D5. How fast a switch is, and how.**
  - **Recommended: swap in place, with the last frame held.** The running
    SCStream changes its target with `updateContentFilter` and
    `updateConfiguration` instead of stop-then-start. The program keeps the
    outgoing scene's last frame until the incoming window's first frame,
    then cuts.
  - Every frame carries its capture generation, so no frame is drawn under
    the wrong scene's layout. No black, ever.
  - **Budget,** measured by S0 and gated by S11 on the owner's Mac: click
    to new picture at most 150 ms p95 for a running app, a 1080p30 canvas
    and a window scene.
  - **Alternative:** keep every scene's window capturing at once (OBS). It
    costs memory and GPU per window, and it breaks the single-slot model
    the whole backend assumes. It is a follow-up only if D5's budget is
    missed.
- **D6. Where scenes live.**
  - **Recommended:** the Scene page leads with a scene list: your saved
    scenes, then "Layouts" (the built-ins for the current orientation).
    - Each row shows the app icon or a layout glyph, the name, what it shows
      ("Figma · front window"), its key chip, and "Follows" when it does.
    - "New scene…" sits in the list header, and you drag rows to reorder.
    - Clicking a row puts that scene on stream, as in Studio; the canvas
      edits the scene on stream.
  - The Studio gallery shows saved scenes first, in the same order, once
    you have one. Cards for scenes made for an app show the app's icon.
- **D7. Keys and remotes for saved scenes.**
  - **Recommended: keys.**
    - Each saved scene can have a global key, set from its ⋯ menu ("Set
      key…") or in Settings → Shortcuts. There are no default keys: ⌃1 to
      ⌃9 are macOS's own Desktop keys, and a global key takes the chord
      from every app.
    - Next scene and Previous scene walk the whole list (saved, then
      layouts) in its order, instead of the built-ins only. That also fixes
      their label drift.
  - **Recommended: remotes.**
    - `sceneApply` gains `sceneId`. The Stream Deck gets a Scene action
      that lists saved scenes by name.
    - The phone shows saved scenes above the layouts. The leak argument
      matches takeovers, whose typed names the phone already receives.
- **D8. What Hide screen shows.**
  - **Recommended: a frosted still of the screen as it was when you
    pressed it.** It is scaled down to at most 48 px tall, blurred and
    scaled back up, so no text survives and colours and shapes do.
  - The camera, the microphone, banners, captions and Buddy stay. It is not
    a takeover.
  - It is done at the source: while hidden, every screen and window
    capture's live frames are dropped before they reach the frame store,
    and the still is published in their place. So the recording, every
    stream leg, Clips, the Screen file and the Preview all get the still,
    and no path can leak a live frame.
  - **Alternatives:**
    - a live blur, which leaks movement, costs every frame on every leg,
      and has no blur on CPU or Metal to start from;
    - an image you choose, like a takeover inside the screen's box (later).
- **D9. How Hide screen is reached.**
  - **Recommended: everywhere a streamer already is.**
    - A global key with a default, ⌃⌥H (Ctrl+Alt+H on Windows and Linux).
      It would be the first default global key, because the moment you need
      it you are inside another app. Settings → Shortcuts changes or clears
      it.
    - A "Hide screen" button on Studio's Screen row in Sources. It is not
      in the transport area (owner rule, 2026-10-12).
    - The Stream Manager status bar.
    - ⌘K.
    - `/hide` and `/show` in the chat composer.
    - A Stream Deck key and a phone key.
    - MCP `hide_screen`, marked `buddy: true` so "Buddy, hide my screen"
      works.
  - **Agents and Buddy can hide but never show.** Only the streamer's own
    key, button, Deck or phone shows the screen again.
  - While hidden:
    - Studio's Screen row and the Stream Manager stats bar show a "Screen
      hidden" chip.
    - The Preview shows the still.
    - There is no toast.
  - Hide screen is cleared at launch, like takeovers.
- **D10. Follow the app in front.**
  - **Recommended:** a "Follow the app in front" switch in the Scene list
    header, on by default. Each scene made for an app follows, and its ⋯
    menu can stop it. Older saved scenes never follow until you turn it on
    for them, so nobody's stream starts switching after an update.
  - Rules:
    - It switches once the app has stayed in front for 400 ms, so ⌘-Tab
      passing through apps doesn't flicker.
    - Videorc itself, and any app without a scene, keep the current scene.
    - A scene you choose by hand stays until the next app change.
    - It never crosses orientation mid-session, and it never shows a
      hidden screen.
  - macOS only (D12).
- **D11. Hide screen for password managers.**
  - **Recommended: on, with a built-in list.** The list is 1Password,
    Bitwarden, Dashlane, Keeper, LastPass, Passwords, Keychain Access,
    Proton Pass, KeePassXC and Enpass. You can add apps and switch off a
    default; an empty list means the defaults (owner rule, 2026-10-24).
  - It acts only while a whole screen is on stream. A window or app scene
    never shows another app, so it doesn't need hiding.
  - It shows the screen again when the app leaves the front, unless you
    hid it yourself.
  - The list lives on the Scene page, under Hide screen. macOS only, since
    it rides D10's observer.
- **D12. Platforms.**
  - **Recommended:**
    - Hide screen ships on macOS, Windows and Linux (Metal, D3D11 and CPU).
    - Scenes for apps, swap in place, Follow and the password-manager hide
      are macOS only in this plan.
    - Window capture on Windows (`CreateForWindow`) gets its own plan.
    - On Windows and Linux, the macOS-only controls are absent, not
      disabled.
- **D13. Spotting sign-in pages by window title** ("Sign in", "Log in",
  "Verification code").
  - **Recommended: not in this plan.** A detector the streamer trusts and
    that misses once leaks a password on a live stream. The manual key and
    the password-manager list are honest about what they cover. It is
    listed for later.

## What the user will see

Using the user's own day, with the recommended answers:

1. **Setup, once.** Scene page (⌘3) → "New scene…". The picker shows T3
   Code, Figma, Chrome ("3 windows") and so on, each with a picture and its
   icon. They choose T3 Code and Figma and press "Add 2 scenes". Two rows
   appear at the top of the list, "T3 Code" and "Figma", each in their
   current look. Nothing on stream changed.
2. **Streaming.** They go live on "T3 Code". ⌘-Tab to Figma: within half a
   second the stream cuts cleanly to Figma. ⌘-Tab back: T3 Code. A glance
   at Slack, which has no scene, changes nothing. They can also click the
   Studio card, press the scene's key, or tap the Stream Deck.
3. **Signing in.** T3 Code's browser opens a GitHub sign-in. They press
   ⌃⌥H. On stream, the screen becomes a frosted blur of T3 Code. Their face
   and voice continue, and the chip says "Screen hidden". They type the
   code and press ⌃⌥H again, and the screen is back. The recording, the
   vertical stream, Clips and the Screen file all show the blur for those
   seconds.
4. **A password manager.** On a "Display 1" scene they open 1Password.
   Screen hidden. They close it, and the screen is back.
5. **Tomorrow.** Figma updated overnight and relaunched. The "Figma" scene
   still works.

## Phases and slices

Each slice leaves `main` shippable. Write and commit every slice in a phase
first, then run the phase's e2e smokes and the bundle once at the end of
that phase (owner rule). Unit tests run with their slice. Every UI slice
reads the whole design skill and `docs/ui-copy.md` first and hands back
light and dark screenshots.

### Phase A: scenes for your apps (macOS)

#### Slice S0: measure today's window switch (diagnose)

**Route / lane:** Diagnose, fit 9, `fable-5.1`.

**Files:**

- `crates/videorc-backend/examples/fixture-window.rs`: a tiny AppKit window
  drawing a solid colour, a frame counter and a big marker glyph;
- `scripts/fixtures/build-fixture-apps.mjs`: wraps it into two `.app`
  bundles with their own bundle ids, `com.videorc.fixture.alpha` and
  `.beta`, under the run's temp dir;
- `scripts/probe-scene-window-switch.mjs` with `pnpm probe:scene-window-switch`.

**Changes:**

1. The probe launches both fixture apps and starts the dev app on an
   isolated profile. It saves two scenes, one per fixture window, through
   the renderer's own path, then switches A→B→A 20 times, idle and while
   recording.
2. It reads the program, either the recording analysed per frame or
   `compositor.status` frame evidence, and reports for each switch:
   - click → first frame of the new window;
   - frozen frames;
   - black frames;
   - frames of the new window under the old layout.

   It splits the time into renderer preflight (`devices.list`, gaps,
   background check), backend stop, shareable-content fetch, start and
   first frame.

3. The numbers go into the plan's execution notes. They set the S3 target
   and the S11 gate.

**Done when:** the probe runs twice on the owner's Mac with stable numbers,
and the report names the largest share of the gap. If this host has no
Screen Recording grant for the dev app, the probe SKIPs loudly and the run
is owner-owed.

#### Slice S1: windows know their app (backend)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:** `screen_capture.rs`, `protocol.rs`, `shared/backend.ts`,
`backend-rpc-contract.ts` (strict contract: new fields go here or main
retires its pump), protocol fixtures.

**Changes:**

1. The window `Device` gains optional `app: { bundleId, name, pid }` from
   `SCWindow.owningApplication`, and `windowTitle`, which is today folded
   into the name. They are serialized with `skip_serializing_if` so that a
   `null` never reaches the contract.
2. A new RPC, `sources.resolve_app_window { bundleId, preferWindowId?, minSize? }`,
   returns the app's frontmost normal on-screen window (layer 0, at least
   400 × 300, in on-screen z-order) as `{ windowId, title, size }`. If
   there is none it returns a reason: `not-running`, `no-window` or
   `minimized`.
3. Shareable content is cached for 1 s and dropped on any SCK error, so
   resolving and listing don't fetch twice per switch.

**Verification:** Rust unit tests for the selection rule (z-order, size
floor, Notes and loginwindow excluded) with a fake window list; contract
round-trip tests; `cargo clippy -p videorc-backend -- -D warnings`.

**Done when:** `devices.list` carries the app of each window, and the
resolver picks the right window for each fixture case.

#### Slice S2: a saved scene can show an app (renderer logic)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:** `lib/scene-presets.ts` and its tests, `hooks/use-scene-presets.ts`,
the apply path in `hooks/use-studio.tsx` (`applySavedScene`,
`requestLayoutTransaction` preflight), `lib/capture.ts` reconciliation.

**Changes:**

1. `VisualSources` gains
   `app?: { bundleId: string; name: string; follows: boolean }`. A scene
   with `app` resolves its window through S1 just before the strict
   preflight, and the strict check then runs on the resolved window.
2. The library stays `version: 1`. An unknown field is already ignored by
   older builds' per-entry parsing; S2 proves that with a fixture written
   by a scene with `app`. If it isn't ignored, bump to 2 with a v1 reader
   and stop for review (STOP).
3. Old window scenes keep their exact `windowId`. When one fails on id, it
   tries the same bundle id, using S1's `app`, which the scene starts
   recording on its next successful apply. Only then does it offer
   "Resolve sources". The fix is never written into the snapshot without a
   save (D3 rules).
4. Refusals say what is wrong in words: "Figma isn't open", "Figma has no
   window open", "Figma's window is minimized". They are typed reasons,
   not a generic "Couldn't switch".
5. Pure helpers:
   - `scenesForApps(apps, currentLook)` builds the D2 scenes (names,
     dedupe "Figma 2", no `audio` per D4);
   - `sceneForFrontApp(scenes, front, lastUsed)` picks the scene for an app
     (most recently used of several).

**Verification:** unit tests for parse and round trip, old builds ignoring
`app`, resolve and refusal reasons, naming, and D4's audio absence;
`pnpm typecheck && pnpm lint`.

**Done when:** a scene with `app` survives the fixture app relaunching (a
unit test with a mocked resolver).

#### Slice S3: swap in place, last frame held (backend)

**Route / lane:** Diagnose / Implementation, fit 9, `fable-5.1`. This is the
riskiest slice: the capture slot and the compositor's screen handle.

**Files:** `preview_screen.rs`, `live_layout.rs`, `compositor.rs` (screen
handle and `last_screen_frame`), `compositor_scene_switch_tests.rs`, and
the Metal and CPU screen paths.

**Changes:**

1. When the slot is running an SCStream and the next source is another
   window or display on macOS, the slot calls `updateContentFilter`, then
   `updateConfiguration` with the new size (`preview_screen.rs:3425-3444`
   rules), instead of stop-then-start. The slot's source id changes, but
   its frame store does not.
2. Every published frame carries the slot's **capture generation**, and a
   swap bumps it. A scene commit names the generation it expects, and the
   compositor:
   - keeps drawing the previous generation's last frame until a frame of
     the expected generation arrives, then cuts;
   - never draws a new-generation frame under the old revision;
   - never clears to black on a source change when a held frame exists.
     This replaces the reset at `compositor.rs:1440-1443`.
3. If the in-place update fails or times out (250 ms), it falls back to
   today's stop-then-start, still under the held frame, with a diagnostic
   reason in `compositor.status`.
4. Window swaps on a window that the app's front-window change moved (D1)
   use the same path.
5. Idle, preview, record and stream all use it. Windows D3D11 and Linux
   keep their paths: they have no window swap to make.

**Verification:** Rust tests for generation gating (no wrong-layout frame,
no black with a held frame, fallback reason);
`compositor_scene_switch_tests`; `pnpm probe:scene-window-switch` against
S0's numbers; at the phase end, `pnpm smoke:recording-studio` and
`pnpm probe:preview-lifecycle`.

**Done when:** the probe shows zero black and zero wrong-layout frames
over 40 switches, and meets D5's budget, or the STOP below fires with
numbers.

#### Slice S4: window pictures for the picker (backend)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:** `screen_capture.rs` (or a new `window_previews.rs`),
`protocol.rs`, `shared/backend.ts`, the contract, `main/index.ts` (app
icons).

**Changes:**

1. A new RPC, `sources.app_previews { maxWidth: 320 }`, returns, for each
   running app with a normal window, its front window's picture as a small
   JPEG from `SCScreenshotManager` (macOS 14 and up), plus its window
   count. Below macOS 14, `picture` is absent and the picker shows the icon
   only.
2. App icons come from main (`app.getFileIcon` on the app's bundle path, or
   `NSWorkspace iconForFile` through the addon), cached per bundle id.
3. The RPC runs only while the picker is open: no polling, nothing at idle.

**Verification:** Rust tests with a fake source list; a timing log on the
owner's Mac (target under 400 ms for 12 apps).

**Done when:** the fixture apps come back with pictures and icons.

#### Slice S5: New scene… and the scene list (UI)

**Route / lane:** UI/Product Design, fit 9, `opus-5.5`.

**Files:**

- `components/tabs/layout-tab.tsx` (the Scene page);
- new `components/scene/scene-list.tsx` and
  `components/scene/new-scene-dialog.tsx`;
- `components/scene-presets.tsx`;
- `components/studio/scenes-gallery.tsx` and `scene-card.tsx`;
- the D3 save path in `hooks/use-studio.tsx` and `use-scene-presets.ts`
  (reorder, auto-save).

**Changes:**

1. **New scene…** is a `Dialog` `lg` with a searchable grid of
   `MediaCard`s (picture, app icon, name, "3 windows"). Several can be
   chosen, and the primary reads "Add scene" or "Add 2 scenes". It creates
   through S2's `scenesForApps`. The orientation follows the Studio's.
2. **The scene list** (D6) leads the Scene page: a `GroupedList` with saved
   scenes, then "Layouts".
   - Rows: icon, name, what it shows, a key chip, and "Follows" (Phase C
     fills it in).
   - Drag to reorder.
   - The ⋯ menu holds: Rename…, Set key…, Change app…, Duplicate, Save
     audio to scene, Stop following (Phase C), and Delete. Delete asks
     first.
3. **D3 auto-save:** a confirmed commit while a saved scene is on writes
   its `visual`, apart from sources, into the library. A source change
   leaves the scene. "Modified" and "Update…" are gone, and undo stays.
   "Save scene…" says why when it is disabled (`DisabledReason`).
4. **Studio gallery:** saved scenes first in list order, app icons on the
   cards of scenes made for an app, and layouts after.
5. Copy follows `docs/ui-copy.md`: "Choose", "New scene…", no success
   toast, and refusals in S2's words.

**Verification:** component tests; the style, copy and shortcut guards; the
renderer asset budget; screenshots in both themes; `pnpm build`.

**Done when:** the nine-click flow is New scene… → choose two → Add, and no
saved scene can be overwritten by choosing another window.

#### Slice S6: keys and remotes for saved scenes (wiring)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:**

- `shared/global-shortcuts.ts`, `renderer/lib/global-shortcuts.ts`,
  `components/settings/shortcuts-settings.tsx`;
- `remote_control.rs`, `lib/studio-actions/remote.ts` and `scene.ts`,
  `lib/remote-surface.ts`;
- `remote_web/app.js`;
- `apps/streamdeck-plugin/` (manifest, plugin);
- `docs/remote-control.md`.

**Changes:**

1. Global shortcut actions `scene:<savedSceneId>`, stored in a new
   `GlobalShortcutsConfig.scenes` map. A deleted scene drops its key.
2. `layout-next` and `layout-previous` walk the D6 list order, shown as
   "Next scene" and "Previous scene".
3. `sceneApply { sceneId }` is validated (non-empty, at most 128 chars), and
   the executor runs the same `applySavedScene`. `remote.state` gains
   `savedScenes: { id, name }[]` and `activeSavedSceneId`.
4. The Stream Deck gets a Scene action with a saved-scene picker in its
   property inspector, and the phone gets saved-scene keys above the
   layouts. The doc gains a leak-argument section, with takeover names as
   the precedent.

**Verification:** `cargo test` filters for remote intents;
`pnpm smoke:remote-control`; `pnpm smoke:remote-lan`; Deck plugin tests;
unit tests for the key map.

**Done when:** a Deck key and a phone key switch to "Figma" against
confirmed state in the smokes.

### Phase B: Hide screen (macOS, Windows, Linux)

#### Slice S7: the screen hold at the source (backend)

**Route / lane:** Implementation, fit 9, `fable-5.1`. This touches every
capture path, and a silent miss leaks a password.

**Files:**

- `preview_screen.rs` (publish point);
- the Windows WGC, DXGI and D3D11 capture publish points;
- `linux_pipewire_stream.rs`;
- a new `screen_privacy.rs` (state, frost);
- `protocol.rs`, `main.rs` (RPCs on the LiveControl lane);
- `recording.rs` (the legacy refusal);
- the contract.

**Changes:**

1. Add state `ScreenPrivacy { hidden: bool, since, reason: 'you' | 'password-manager' }`,
   the RPCs `screen.hide` and `screen.show`, and an event
   `screen.privacy.changed`. Agents' `show` is refused (D9).
2. **The frost** is a pure function. It takes the last published frame,
   scales it to at most 48 px tall with an area average, applies a
   Gaussian blur at σ 2 px at that size, and scales it back up bilinearly
   to the frame's size, once. It never runs per frame.
3. **At the source:** while hidden, each capture path's publish point:
   - drops live frames;
   - publishes the frosted still once, in its own frame format (an
     IOSurface on macOS, a D3D11 texture on Windows, a CPU buffer on the
     CPU path and Linux);
   - makes a new source after a swap (S3) start frosted from its first
     frame.

   With no frame yet, it publishes a neutral grey still.

4. Showing again publishes the next live frame. Nothing is restarted
   either way.
5. **The legacy FFmpeg recording path** reads the display directly, so
   there `screen.hide` is refused with a reason ("Hide screen isn't
   available on this recording. Stop and record again.") and the UI shows
   it. It is never silently uncovered.
6. The Windows direct-D3D11 record-only path and Linux get the same
   publish-point hold, each with a test.

**Verification:**

- Rust tests: the frost is unreadable (a 72 px text fixture's
  high-frequency energy under a threshold, with no glyph edges past the
  blur), no live frame published while hidden, the swap starts frosted,
  and show resumes;
- a fixture render through CPU and Metal (and D3D11 on Windows CI) proving
  that the program, the aux leg, the vertical leg, the Screen file leg and
  Clips get the still;
- `cargo clippy -p videorc-backend -- -D warnings`.

**Done when:** no output path can carry a live screen frame while hidden,
by test, on each platform's path.

#### Slice S8a: Hide screen wiring (logic)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:**

- `shared/global-shortcuts.ts` (`screen-hide-toggle` with D9's default);
- `hooks/use-studio.tsx` (state from the event);
- `components/command-palette.tsx`;
- `components/stream-manager/chat-pane.tsx` (`/hide`, `/show`);
- `remote_control.rs` (`screenHide`, `screenShow`, `screenHideToggle`, in
  a "privacy" debounce bucket);
- `remote_web/app.js`, the Stream Deck plugin;
- `protocol-fixtures/agent-tools.json`, `lib/studio-actions/tools.ts`,
  `agent_tools.rs` (`hide_screen`, `buddy: true`, `onAir: true`; no show
  tool);
- `docs/remote-control.md`, `docs/agents-mcp.md`.

**Changes:** each trigger calls one studio action, which calls the RPC. The
privacy debounce runs on its own lane so it never queues behind a scene
switch (`lib/remote-intent-queue.ts`). The default key registers on first
launch after the update only if nothing else holds it; Settings shows it.

**Verification:** unit tests per trigger; `pnpm smoke:remote-control`,
`pnpm smoke:remote-lan`, `pnpm smoke:agent-mcp` (a new step: hide refused
for show, the tool listed), `pnpm smoke:buddy-act` unchanged.

**Done when:** every D9 surface hides through the one action in its smoke.

#### Slice S8b: Hide screen in the UI

**Route / lane:** UI/Product Design, fit 9, `opus-5.5`.

**Files:**

- Studio's Sources section, Screen row (`components/studio/quick-settings.tsx`);
- the Retro LCD twin (`studio/retro-lcd-studio.tsx`);
- the Stream Manager status bar and stats bar;
- the Scene page's Hide screen section (key, D11 list placeholder for
  Phase C);
- CONTEXT.md glossary.

**Changes:**

1. "Hide screen" is a 24 px row button with a `ShortcutTooltip`. While
   hidden it reads "Show screen" and the row carries a "Screen hidden"
   `StatusBadge`.
2. The Stream Manager gets a status-bar action and a stats chip.
3. Glossary:
   - **Hide screen:** cover the screen on every output with a frosted
     still of it while the camera and microphone stay on. "Show screen"
     brings it back. _Avoid_: blur (it isn't live), privacy mode, BRB (a
     takeover), censor.
   - **Follow the app in front** (Phase C).

**Verification:** component tests, the guards, screenshots in both themes
and under Retro LCD.

**Done when:** the owner can hide and show from Studio and the Stream
Manager and always sees the state.

### Phase C: follow the app in front (macOS)

#### Slice S9: the front-app observer (native)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:** `crates/videorc-native-preview-addon/src/lib.rs` (or the
addon that owns NSWorkspace), `main/index.ts`, the preload, and
`shared/ipc` types.

**Changes:**

1. Main observes `NSWorkspaceDidActivateApplicationNotification` through
   the addon. Main has a run loop; the backend doesn't.
2. It sends `app:front-changed { bundleId, name, pid, frontWindowId? }` to
   the main window's renderer. The front window comes from
   `CGWindowListCopyWindowInfo` (on-screen, layer 0, that pid, top-most).
   While a scene for an app is on, it is also polled at 2 Hz so a window
   change inside the app is seen.
3. It needs no Accessibility permission and raises no new prompt (STOP if
   it would).
4. App names never leave the machine and are not logged by name. The
   support bundle gets counts only.

**Verification:** addon unit tests where possible; a probe that activates
the two fixture apps and checks the events in order within 100 ms.

**Done when:** activating fixture A, then B, then Videorc gives three
events.

#### Slice S10: following and the password-manager hide (logic and UI)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol` for the logic;
UI/Product Design, `opus-5.5`, for the Scene list header switch, the ⋯
"Stop following" and the D11 list editor.

**Files:** new `lib/follow-front-app.ts` and its tests, `hooks/use-studio.tsx`,
the scene list, and the Scene page's Hide screen section.

**Changes:**

1. A pure state machine: `(front, scenes, settings, session, now) → action`
   with D10's rules. The actions are switch to a scene, swap the window
   (D1), hide, show, or nothing. It runs through `applySavedScene`, so it
   uses the same latest-intent path.
2. D11:
   - the built-in bundle ids;
   - user additions through "Add app…" (the running apps, or choosing an
     `.app`);
   - acts only while the program's screen source is a display;
   - auto-show only for a `password-manager` hide.
3. Settings are saved per device (renderer storage, like the scene
   library).

**Verification:** a state-machine test matrix covering settle time,
⌘-Tab passes, Videorc in front, no-scene apps, a manual pick, orientation,
hidden, D11 display versus window, and a manual hide never auto-shown.
Plus component tests, the guards and screenshots.

**Done when:** the matrix is green and the probe in S11 follows the
fixtures.

### Phase D: proof and docs

#### Slice S11: the smoke, docs and acceptance

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`. The orchestrator
runs the bundle.

**Files:** `scripts/smoke-smart-scenes-app.mjs` and its gate in
`scripts/lib/`, `package.json` (`smoke:smart-scenes`, added to
`smoke:recording-studio` and `smoke:local-gates`), AGENTS.md (one rule
line), CONTEXT.md, `docs/ui-copy.md` if new phrases, the design skill's
"Where things live", `docs/remote-control.md`, `docs/agents-mcp.md`, plans
README, and an acceptance doc.

**The smoke** (dev app, isolated profile, the fixture apps):

1. New scene… for both fixture apps through the renderer; two scenes with
   `app`, no `audio`.
2. 20 switches while recording, gated on D5's budget, zero black and zero
   wrong-layout frames, measured from the ffprobed recording.
3. Quit and relaunch fixture B; "beta" still switches.
4. Follow: activate A, then B, then Videorc; the program follows within the
   settle time plus the budget.
5. Hide: the hide key while recording and streaming to a local RTMP sink.
   The recording, the stream sink, the Screen file and a Clips save each
   show the still (a frame-energy check) for the hidden span and live
   frames after.
6. D11: a stand-in bundle id on the list, on a display scene, hides and
   shows.

It never goes live on a real channel.

**Done when:** the smoke and `pnpm smoke:local-gates` are green on the
owner's Mac, or each SKIP names its missing grant. The acceptance doc lists
the owner's by-eye checks:

- T3 Code and Figma for real, in both themes;
- a real sign-in with Hide screen;
- 1Password;
- a Stream Deck key.

## Verification summary

| Slice | Gates                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------- |
| S0    | `probe:scene-window-switch` (twice), numbers in the notes                                               |
| S1    | Rust unit tests, contract tests, clippy                                                                 |
| S2    | desktop unit tests, typecheck, lint                                                                     |
| S3    | Rust tests, `probe:scene-window-switch`; phase end: `smoke:recording-studio`, `probe:preview-lifecycle` |
| S4    | Rust tests, timing log                                                                                  |
| S5    | component tests, guards, asset budget, `build`, screenshots in both themes                              |
| S6    | `smoke:remote-control`, `smoke:remote-lan`, Deck tests                                                  |
| S7    | Rust tests per platform path, fixture renders (CPU, Metal; D3D11 in Windows CI), clippy                 |
| S8a   | `smoke:remote-control`, `smoke:remote-lan`, `smoke:agent-mcp`, `smoke:buddy-act`                        |
| S8b   | component tests, guards, screenshots in both themes and Retro LCD                                       |
| S9    | the activation probe                                                                                    |
| S10   | the state-machine matrix, component tests, guards                                                       |
| S11   | `smoke:smart-scenes`, `test:scripts`, `smoke:local-gates`                                               |

## Edge cases

- **The app has no window, is minimized or is on another Space.** A manual
  switch is refused with S2's reason, and its card is disabled with that
  reason. Follow does nothing until a window shows.
- **The app's front window becomes a small palette or a dialog.** The
  400 × 300 floor ignores it. A sheet attached to a window is a separate
  window in SCK and doesn't show (known limit; see Out of scope).
- **Two scenes for the same app.** Follow picks the one used most
  recently, and a manual pick sets it.
- **Several Chrome windows.** The scene shows Chrome's front window.
  Someone who wants one window keeps using "Save scene…" (D1's
  alternative).
- **A full-screen app.** It is a window on its own Space. SCK captures it
  while it's on screen, and `onScreenWindowsOnly` lists it then. S0 checks
  it with a fixture.
- **Switching while hidden.** It stays hidden, and the new window starts
  frosted from its first frame (S7.3).
- **Hide with no screen in the scene.** It is allowed, the chip shows, and
  nothing visible changes until a screen comes on.
- **Hide while a takeover is up.** The takeover still covers. Hide applies
  under it and remains after the takeover is turned off.
- **A crash or quit while hidden.** Hide is cleared at launch (D9). The
  next session starts visible, and the streamer sees it in the Preview
  before Record or Go Live.
- **The default key is taken by another app.** Registration fails, Settings
  says so, and every other surface still works.
- **An agent tries `show`.** It is refused, with an answer that says only
  the streamer can show the screen.
- **A vertical Studio.** Scenes made for apps follow the Studio's
  orientation. Follow never crosses orientation mid-session.
- **Clips only (no take).** Clips record the program, so they get the
  still.
- **A legacy FFmpeg session.** Hide is refused with its reason (S7.5).
- **macOS 13.** No window pictures in the picker (icons only). The rest
  works.
- **Videorc's own windows.** Follow ignores Videorc. A display scene still
  captures Videorc (OBS parity, unchanged).

## STOP conditions

- **S0:** the dev app can't get a Screen Recording grant on this host. Ask
  the owner for a run; don't build S3 blind.
- **S2:** an older build would drop or mangle a scene with `app` (step 2).
- **S3:**
  - `updateContentFilter` doesn't deliver the new window within 250 ms
    p95, or SkyLight crashes, on macOS 14, 15 or 26. Report the numbers;
    the fallback (stop-then-start under the held frame) still ships, and
    the owner decides on warm captures.
  - The generation gate needs changes in the aux or vertical leg's commit
    path beyond the screen handle. Report before widening.
- **S7:** any capture path can't hold at the publish point and would need a
  compositor-side cover instead. Stop and report: a cover that a leg can
  miss is the failure this plan exists to prevent.
- **S9:** the observer needs Accessibility or raises a new OS prompt.
- **Any slice:** a saved scene is lost or rewritten without the streamer's
  action, or an existing user's stream starts switching on its own after
  updating.

## Out of scope

- **Window capture on Windows** (`CreateForWindow`) and Linux window
  scenes: their own plan (D12).
- **Keeping several windows capturing at once** (D5's alternative).
- **A crossfade between scenes.** The held frame makes one possible later.
- **Whole-app capture with menus and popups,** and region capture.
- **"Never show these apps"**: excluding chosen apps from display capture
  with `SCContentFilter(display:including:exceptingWindows:)`. It needs the
  filter rebuilt on each app launch, which S3's in-place update would make
  possible.
- **Spotting sign-in pages by title** (D13).
- **Hide screen with a chosen image** (D8's second alternative).
- **Per-scene banners** (plan 186 D3 stands).
- **Saved scenes in the backend** instead of renderer storage.

## Risks

- **S3 sits at the centre of the capture path.** The single-slot
  assumption runs through the slot, the compositor and the live-layout
  generation checks. The fallback keeps today's behaviour, and S0's probe
  plus `smoke:recording-studio` guard it.
- **Hide screen is a promise.** A path that misses it leaks a password on a
  live stream. That's why it works at the source, why the legacy path
  refuses loudly, and why S11 checks each output's pixels.
- **Auto-save changes what a saved scene means.** It is undoable, a source
  change leaves the scene instead of rewriting it, and audio is never
  auto-saved. Even so, an existing user's habit of "try something, then
  don't press Update" now saves. The owner should check this by eye
  (D3).
- **Follow surprising someone.** It is on only for scenes made for an app,
  it never switches Videorc's own focus, and Videorc and apps without a
  scene do nothing.
- **A default global key** is a first for Videorc. ⌃⌥H may clash with a
  user's tool; registration failure is visible.
- **Fixture apps in CI.** The smoke is macOS-local like the other device
  smokes; CI covers the unit and Rust tests only.

## Execution order

1. `git fetch origin && git worktree add -b plan-210-exec ~/projects/videorc-wt-210-exec origin/main`
   (never the shared checkout).
2. Read `AGENTS.md` and this plan. UI slices (S5, S8b, S10's UI) also read
   the whole design skill and `docs/ui-copy.md`.
3. Phase A and Phase B run side by side:
   - A: S0 → S1 → S2 and S3 (parallel, both after S1) → S4 → S5 → S6.
   - B: S7 → S8a → S8b.
4. Phase C after A and B: S9 → S10.
5. Phase D last: S11, the bundle and the acceptance doc, once.
6. Ship as one PR per phase (A, B, C+D), in the order they're ready. Hide
   screen alone is worth releasing first.

## Execution notes

(Empty until execution starts. S0's numbers go here first.)
