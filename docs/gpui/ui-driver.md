# The UI driver on GPUI (plan 260 S2.5)

The smokes drive the GPUI app the way they drive Electron: `VIDEORC_APP=gpui`
(`scripts/lib/app-launcher.mjs`), the loopback smoke command server, and the
one JS driver (`scripts/lib/ui-driver.mjs`). Their `ui-*` commands work on
each window's AccessKit tree, which is what VoiceOver, Narrator and Orca read.

| Part                                                                                                                                                 | Where                                                                          | Owner        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------ |
| Server, policy, the core's commands (`app-quit`, `backend-debug-rpc`, `authorize-smoke-resource`, `inspect-backend-state-isolation`, the quit guard) | `crates/videorc-app-core/src/smoke/`                                           | L6           |
| The tree as data, selectors (`ui_tree`, `gpui_tree`)                                                                                                 | `crates/videorc-app-core/src/smoke/`                                           | L6           |
| The driver on live windows, the foreground hop, turning accessibility on                                                                             | `apps/videorc/src/smoke/`                                                      | L6           |
| Starting the server, which window is which, the forced look, a toast                                                                                 | `smoke::start` in `main.rs`, `ShellSmoke` in `apps/videorc/src/smoke/shell.rs` | L6 (Phase 3) |
| `studio-*` and the other Studio commands (`STUDIO_COMMANDS`)                                                                                         | a `SmokeCommandHandler` on S1.6a's Studio                                      | L7           |
| `open-tab`, `main-window-*`, the preview's and each window's commands                                                                                | `SmokeCommandHandler`s from the slices that own them                           | their lanes  |

A known command that nobody runs yet answers, by name, that it is not
supported. None ever succeeds silently.

## Launching the GPUI app from a smoke

`VIDEORC_APP=gpui` makes the launcher's prebuild build `videorc-app` with the
backend, then run `target/<profile>/Videorc` itself, with the smoke's
isolated profile through `VIDEORC_USER_DATA_DIR`. A smoke run keeps the
Studio from picking devices for it (`withhold_device_defaults`).

## How the driver reads a window

GPUI 0.3.14 builds the AccessKit tree only while the platform's adapter says
assistive technology is there. A smoke runs without a screen reader, so the
driver asks the same first question of its own window, in its own process:

- **macOS:** `accessibilityChildren` on the window's view.
  `accesskit_macos::SubclassingAdapter` answers it and activates GPUI.
- **Windows:** `WM_GETOBJECT` with `UiaRootObjectId` to its own `HWND`.
  `accesskit_windows::Adapter` answers it.
- **Linux:** the adapter follows the AT-SPI bus's screen-reader switch.
  Turning that on is S2.6c's (L5). Until then the driver refuses by name.

No Accessibility grant is involved. From then on GPUI keeps the last frame's
tree, and the driver reads it with `Window::debug_a11y_tree_json`. Pointer
and keys go through `Window::dispatch_event` and `Window::dispatch_keystroke`,
the window's own dispatch, so a dialog's scrim takes a click meant for what
it covers, as a mouse would. `ui-click` / `ui-focus` take a selector by
element id or accessibility name; `ui-click {x,y}` and `ui-drag
{fromX,fromY,toX,toY}` hit absolute window points (the Scene stage paints
sources without a11y nodes); `ui-key` with no selector sends keys to
whatever has the focus.

## Gaps in gpui-pre 0.3.14

Each gap is answered by name in the driver and listed here until it closes.

1. ~~**No bounds in the tree dump.**~~ **Closed** (C5, local `patches/gpui-pre`).
   `node_to_json` now prints AccessKit `{x0, y0, x1, y1}` physical-pixel bounds
   so `ui-click`, `ui-focus`, `ui-scroll` at an element, and focusing a field by
   click have a target. Drop `patches/gpui-pre` when a gpui-pre release prints
   the same lines upstream. The driver reads them in `gpui_tree.rs`.
2. **No public way to send an AccessKit action.** `Window::handle_a11y_action`
   is `pub(crate)`. So `ui-click {via: "action"}` and a true set-value action
   wait for it. `ui-set-value` types the value instead.
   **Fix:** make it public, or add `Window::perform_a11y_action(ActionRequest)`,
   upstream.
3. **No window capture outside tests (closed on macOS by an OS capture).**
   `Window::render_to_image` is `test-support` only, so `capture-page-alpha`
   (a page render's alpha) still refuses by name. `capture-page`,
   `comments-window-capture-page` and `preview-surface-sample`
   (`apps/videorc/src/smoke/capture.rs`, shapes in
   `videorc_app_core::smoke::capture`) capture the composited window with
   `screencapture -x -o -l <windowNumber>`: what is on screen, glass and the
   native preview layer included. It needs Screen Recording for the process
   that runs the app (a terminal's grant carries over). Windows and Linux
   answer by name that they have no capture yet.
4. **No disabled flag or clipping in the dump.** Every node reads as enabled
   and visible. The driver honours `disabled: true` should it appear.
5. **No author ids in the dump.** `accessibility_id` is not printed. A
   selector's `id` matches the element id that created the node, which debug
   builds print, qualified by its view (`StudioPage::record`).

Gap 1 is closed locally (`patches/gpui-pre`). Absolute `ui-click {x,y}` and
`ui-drag {fromX,fromY,toX,toY}` use the same pointer dispatch for painted
stage content that has no accessibility node. Gap 2 (AccessKit actions) is
still open: `ui-click {via: "action"}` waits. Pointer clicks, focus, drag, and
keys go through `Window::dispatch_event` / `dispatch_keystroke` (no OS-level HID).

## What the plan's "done when" still needs

`smoke:record-latency`, `smoke:recording-matrix` and the recording-studio
fixtures send `eval-js` and `enable-synthetic-source` today. With
`VIDEORC_APP=gpui` they need the Studio handler (L7) and their `eval-js`
moved to UI driver or Studio commands. That happens as the screens land.

## The first GPUI smoke: `pnpm smoke:gpui-studio`

`scripts/smoke-gpui-studio.mjs` drives the Studio through the driver only. It checks the isolated profile, the
preview converging (`compositor.status`: the committed scene drawn, frames advancing), the Record button
(`session-record`) in the main window's tree, and a take started and stopped with Space.

A smoke run picks no devices, so the smoke first logs why Record is blocked, then turns the test pattern on with
`enable-synthetic-source` before the take.

## The Studio's smoke commands

`crates/videorc-app-core/src/smoke/studio.rs` (`StudioSmoke`, handed to `smoke::start` as `studio`) runs
`enable-synthetic-source {settleMs?}`, `studio-state`, `studio-record {timeoutMs?}` and `studio-stop {timeoutMs?}` on
the core's Studio. `open-tab {tab}` opens a page in the main window (`ShellCommands`, `PageId::from_tab_param`). The
other `STUDIO_COMMANDS` still answer "not supported" by name.

The preview's commands (`PREVIEW_COMMANDS` in `apps/videorc/src/smoke/mod.rs`): `inspect-native-preview-runtime` and
`preview-window-state` answer where the preview is (`mode`, `phase`, `nativeReady`, `dockedShown`, `canFloat`,
`floatingOpen`, `words`); `preview-window-open`, `-close` and `-toggle` float it in its own window or dock it back
(macOS; elsewhere opening is refused by name). Electron's surface and host commands have no GPUI form.

### `open-tab`'s GPUI extras and the screen gallery

`open-tab` also takes `subTab` (a Settings, Sidekick or Avatar tab id from `nav::sub_tabs`, such as `voice` or
`greetings`) and `dialog` (`go-live`, `palette`, or `first-run` with `step` and `goal`), answered by
`Shell::smoke_open`. A sub-tab on a page without tabs, or an unknown id, is refused by name.

`pnpm gallery:gpui` (`scripts/gpui-gallery.mjs`) uses them to shoot every GPUI screen on main, dark and light, at a
1280x800 window, next to the S0.10 Electron baseline ([baseline.md](baseline.md)). It runs the compile sentinel's
binaries (`~/cloud-test/gpui-builds/latest/`) on a profile seeded like the baseline's, captures the window with
`screencapture -l` (gap 3), and writes a manifest (each shot, its baseline pair, the parity rows it covers) and the
Live pages the owner answers per screen. Rows are ticked only from those answers.

## Recording smokes on the GPUI app

Run with `VIDEORC_APP=gpui`:

- `smoke:record-latency` seeds its video profile with `studio-capture-configure`, arms the clip buffer with
  `studio-replay-buffer {armed, seconds}` (`Studio::set_clips_for_run`), and reads a refused start from
  `studio-state`. Its cycles already press Record and Stop through the remote surface, which the core's Studio serves.
  `--real-screen` stays Electron-only until the GPUI app has `select-screen-device`.
- `smoke:recording-matrix` drives the backend directly (`session.start` with the test pattern) and needs only
  `authorize-smoke-resource`, so it runs unchanged.

### The rest of `smoke:recording-studio` on GPUI (2026-11-25)

Should run with `VIDEORC_APP=gpui` (nothing app-specific beyond supported commands and backend RPC):
`smoke:output-stall`, `smoke:live-layout-switch-recording`, `smoke:app-quit-recording`, `smoke:buddy-pet` (its
bubble case skips on GPUI), `smoke:dev` (its asset background goes through `import-smoke-background`, now in the
core), `smoke:preview-real-launch` (on GPUI the main side of the chain is `inspect-native-preview-runtime`).

`smoke:preview-overlay-presentation` and `smoke:preview-check-invisible` run with `VIDEORC_APP=gpui` on macOS:
`native-preview-surface-status` reads the element's live feed (`presentedFrameId`, transport `native-surface`), and
`preview-surface-sample` captures the window showing the Preview and reads the rects in the canvas the layer contain-fits
(the frame's own size, else the Studio's video). The renderer hooks are the Studio handler's: `studio-capture-configure`,
`studio-replay-buffer`, `studio-scenes-state`, `studio-record` / `studio-stop`, and `studio-performance-check` (Check
this computer as the Output page starts it). The GPUI watchdog's `[preview] healing` / `stalled` lines count as
Electron's `[preview-watch]` ones.

### The GPUI native preview probes (L6, 2026-11-25)

`VIDEORC_APP=gpui pnpm probe:preview-lifecycle` runs `scripts/gpui-preview-lifecycle-probe.mjs` (Electron's
probe hands over; no new package script while the 0.38 guard holds). It drives the paths a person takes and
reads L1's preview through the smoke server: docked and presenting (`presentedFrameId` advances), Retry while
presenting (`retried: true`, `retry preview (n)`, `reset-native-path` on macOS, back at presenting), ⌘P close and
reopen cycles (`VIDEORC_PREVIEW_LIFECYCLE_CYCLES`, 10), the Preview window (macOS: ⌘P, its close button through
`preview-window-os-close`, docking back), and Retry after `preview.surface.destroy`. A forced first-frame fallback
has no switch yet: a named SKIP. `preview-window-os-close` closes the Preview window as its close button does
(`performClose:`, so `on_window_should_close` runs). `VIDEORC_GPUI_APP_BINARY` runs a prebuilt app
(`~/cloud-test/gpui-builds/latest`) instead of building one. Evidence: `gpui-preview-lifecycle.json` in the
output folder.

**Found on the first runs (sentinel build `010616c0d`):** the UI driver's accessibility tree never arrived in a
smoke run (`ui-*` waited 20 s and gave up). The cause: GPUI's window handle names its own `GPUIView`, a subview of the
window's content view, while AccessKit's `SubclassingAdapter::for_window` subclasses the content view, so
`activate.rs` asked a plain view. It now asks the content view (L6). The preview probes press ⌘P as the
`TogglePreview` action (`preview-toggle-open`) either way.

`VIDEORC_APP=gpui pnpm probe:preview-window` runs `scripts/gpui-preview-window-probe.mjs`: the Preview on screen
(`preview-surface-sample`) against the frame the backend presents (`preview.debug.sample`), cell by cell over a 4 × 4
grid (each channel within `VIDEORC_PREVIEW_WINDOW_TOLERANCE`, 48; at least 13 of 16 cells). It checks it docked,
after main-window resizes, in the Preview window (opened, moved and sized off 16:9 with `preview-window-set-bounds`),
after its close button and ⌘P, docked back, and on the Scene page. It needs Screen Recording and the debug backend.

`VIDEORC_APP=gpui pnpm smoke:preview-interaction-stress` runs `scripts/gpui-preview-interaction-stress.mjs`: a
sampler reads `presentedFrameId` and the phase every 100 ms while rapid layout intents (a burst, then
`VIDEORC_PREVIEW_STRESS_SCENE_ROUNDS` rounds of Electron's sequence), a Preview window move/resize storm (then the
alignment read) and a main-window storm (`main-window-set-bounds`, now on GPUI) run with no settle. A phase fails when
the preview stood still longer than `VIDEORC_PREVIEW_STRESS_MAX_STILL_MS` (1000), left presenting, or presented
nothing; a layout the backend refuses without a real device makes the scene phase a named SKIP.

Wait for a GPUI product path or new commands first:

| Smoke                                                                                                                                            | Missing on GPUI                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke:captions-live`                                                                                                                            | the renderer's caption frame submissions (live PNG and cue frames)                                                                                                                                             |
| `smoke:html-overlay`                                                                                                                             | the Chromium page host (`videorc-page-host` / P5-D10); `html-overlay-stats` answers `{ stats: null }` until then (named SKIP on GPUI)                                                                          |
| `smoke:screens` theme screenshots                                                                                                                | the port itself (C1): `capture-page` captures the composited window on macOS now (gap 3)                                                                                                                       |
| `smoke:preview-pump-diagnostics`, `smoke:preview-click-focus`                                                                                    | Electron's present-pump and click-focus probes                                                                                                                                                                 |
| `smoke:recording-native-preview`, `smoke:preview-surface`, `probe:preview-lifecycle`, `probe:preview-window`, `smoke:preview-interaction-stress` | Electron's native-surface and window commands; they need GPUI-specific probes, not a port                                                                                                                      |
| `probe:comments-window`                                                                                                                          | Electron fixtures (`push-*`/`seed-*`/person-card/layout-metrics) stay Electron-only. GPUI path: `comments-window-probe-gpui.mjs` (open/place/raise/hide + `#2142` composited capture on macOS; Win/Linux SKIP) |

### The Notes and Stream Manager windows on GPUI (2026-11-25)

`apps/videorc/src/smoke/windows.rs` runs `notes-window-open`, `-close`, `-state`, `-set-bounds`, `-save-document`,
`comments-window-open`, `-close`, `-toggle`, `-state`, `-set-bounds`, `-set-hidden-from-stream`, `-set-smoke-marker`
and `raise-window` (roles `notes`, `chat`, `main`; levels `floating`, `screen-saver`; never with focus). The answers
keep Electron's shapes (`notesWindowState`, `commentsWindowState`); `visible` is `open`, because GPUI does not say
whether a window is minimized. Bounds are screen points with a top-left origin, as Electron's `setBounds` takes them.

`smoke:screen-recording-real` and `smoke:notes-window-invisible` run with `VIDEORC_APP=gpui` on the no-surface path
(`VIDEORC_BASELINE_NO_PREVIEW_SURFACE` is implied: the GPUI preview has no Electron surface or host-command drain).
`VIDEORC_BASELINE_SYSTEM_AUDIO=1` is still Electron-only.

The chat pane's commands are its own paths: `comments-window-click-message {messageId}` is a row's click (on stream, or
off when it is the one on stream), `comments-window-set-highlight-anchor {anchor}` the status bar's corner pick (it
writes the highlight's rects into the overlay layout, as Electron's `snapHighlightToAnchor` does),
`comments-window-reader-state` the shown rows' words (emotes left out, as Electron's `innerText`) with each row's
`highlightPhases` and `highlightReasons`, and `comments-window-command-trace` the clicks in flight (`pendingCount`).
`smoke:comment-highlight-stream` runs with `VIDEORC_APP=gpui` on its default Stream Manager surface;
`VIDEORC_COMMENT_HIGHLIGHT_SURFACE=studio` is still Electron-only (it reads the renderer through `eval-js`).

### Banners, HTML overlays and Screens on GPUI (2026-11-25)

`videorc_app_core::smoke::commands` runs `import-takeover-image` (the Images takeover import through
`screens.importImage`, answered with Electron's `{ ids, readyIds }` from `screens.list`) and
`html-overlay-stats` (`{ stats: null }` until the page host reports). `apps/videorc/src/smoke` runs
`main-window-id` (OS capture id + top-left bounds). `capture-page` and `comments-window-capture-page`
write a PNG of the composited window on macOS (#2142); Windows and Linux still answer by name that
they have no capture.

`smoke:banners` and `smoke:screens` run with `VIDEORC_APP=gpui`. The banners smoke skips the
`videorc-asset://` renderer fetch (no Chromium scheme; recording samples still prove the draw).
`smoke:html-overlay` is a named SKIP until `videorc-page-host` (P5-D10) paints frames. Screens can
use `capture-page` on macOS for theme screenshots; the renderer mic `eval-js` check stays Electron.

### Sources, layouts and saved scenes

`StudioSmoke` also runs:

- `select-screen-device {sourceId?, timeoutMs?, settleMs?}`: the first available ScreenCaptureKit screen or window (any
  screen off macOS), or `sourceId`; it turns the test pattern off first, as Electron's hook does. Answers `{id, kind}`.
- `select-camera-device {cameraId?, off?, timeoutMs?, settleMs?}`: the first available camera, `cameraId`, or Camera
  off. Answers `{cameraId}`.
- `select-camera-shape {shape, settleMs?}`: `apply_camera_preset` with `camera_shape_patch` (circle / rounded /
  rectangle). Answers `{shape, pressed, editModeActivated, label}`. Shared with `smoke:preview-scene-commit`.
- `select-layout-preset {preset, settleMs?}`: the layout on stream (switching to 9:16 first for a `vertical-` preset),
  answered once the capture config shows it. It moved from the window commands to the Studio's.
- `studio-scenes-state`: the library (`scenes`, `onStreamId`, `pendingSceneId`, `modified`, `readOnly`, `error`) and
  what shows now (`visual`: screen, window, camera, Camera off, test pattern, layout preset).
- `studio-scene-save {name, updateId?}` (the look on stream as a new scene, or over `updateId`, then on stream),
  `studio-scene-apply {id}`, `studio-scene-delete {id}`, `studio-scene-layout {patch}` (`applyCameraPreset`) and
  `studio-scene-background {background}` (a saved background, or `null` for none, as one quiet transaction).

`smoke:record-latency -- --real-screen` uses the pickers on GPUI.

### Ported in the scene batch

- `smoke:layout-source-loop`: watches the Preview window (macOS; elsewhere a named SKIP), opens the Scene page with
  `open-tab`, reads the layout and canvas from `studio-scenes-state`, and checks the preview's scene with
  `preview-surface-scene-state`, which on GPUI answers from the scene the Studio committed. `preview-window-state` also
  answers Electron's `open`, `visible` and the floating window's `contentBounds`.
- `smoke:live-background`: Clips off with `studio-replay-buffer`, the fixture with Camera off, the screen-only layout
  and `studio-scene-save`. The idle compositor reports the live background on every platform: the GPUI preview draws
  the compositor's frames, and `inspect-native-preview-live-background` says so.
- `smoke:system-audio`: the seed and the clips-idle gain through `studio-capture-configure`; the tones come from the
  Node player (`lib/tone-player.mjs`). The `self` case is a named SKIP on GPUI: the app has no monitor-only sound of its
  own to play during a take.

### smart-scenes on GPUI

`smoke:smart-scenes` runs with `VIDEORC_APP=gpui` on the Studio smoke handler (`studio-scenes-state`,
`studio-scene-insert`, `-edit`, `-move`, `-apply`, `-delete`, `-layout`, `studio-shortcut`, `studio-privacy-*`,
`studio-screen-privacy`) and #2056's Follow and password-manager hide. What differs from Electron:

- The plan-210 migration step is a SKIP: it seeds the renderer's v1 settings and reloads; core unit tests cover
  `scenes::migration`.
- New scenes: the GPUI Scene page has no Add scene… dialog yet, so the smoke builds the app scenes (Follow on, the app's
  name, "<name> 2" for a second) and inserts them with `studio-scene-insert`.
- Reorder: `ui-focus` on `scene-row-{id}` then Alt+ArrowUp through `ui-key` (gap 1 closed; rows `track_focus`).
  `studio-scene-move` remains as a direct Studio path. Position keys come from `studio-scenes-state`'s `keys`.
- Rapid keys: the trace is polled from `studio-scenes-state`; the renderer-only diagnostics (layout intent, queued key,
  resolve generation) are `null`. The gate reads only the frames and the final state.
- A refused scene apply reads as `false` (the command's error); refusal reasons come from `studio-state`.
- Add app… for the password-manager list goes through `studio-privacy-add-app` (no picker yet).
- Follow's "Videorc in front" row is Electron's and is left out on GPUI.

### freeform-editor on GPUI

`smoke:freeform-editor` with `VIDEORC_APP=gpui` skips CDP / `__freeformSmoke` and drives the Scene stage through
`ui-click {x,y}` and `ui-drag` (`scripts/lib/freeform-editor-gpui.mjs`). Stage bounds come from `ui-find` on
`scene-stage` (gutter 28 px). The gate is backend-authoritative (scene revision + accepted transform); DOM frame /
pointer-capture evidence stays Electron. `select-camera-shape` covers the mask case shared with preview-scene-commit.
