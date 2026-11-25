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
it covers, as a mouse would.

## Gaps in gpui-pre 0.3.14

Each gap is answered by name in the driver and listed here until it closes.

1. **No bounds in the tree dump.** GPUI sets each node's rect
   (`accesskit::Node::set_bounds`, `element.rs`), but `debug.rs`'s
   `node_to_json` does not print it. Without it, `ui-click`, `ui-scroll` at an
   element, and focusing a field by click have no target. The driver already
   reads a node's `bounds` as AccessKit's `{x0, y0, x1, y1}` in physical pixels
   (`gpui_tree.rs`).
   **Fix:** a few lines in `node_to_json`
   (`if let Some(rect) = node.bounds() { map.insert("bounds", …) }`), upstream
   in Zed, then the next weekly snapshot bump.
2. **No public way to send an AccessKit action.** `Window::handle_a11y_action`
   is `pub(crate)`. So `ui-click {via: "action"}` and a true set-value action
   wait for it. `ui-set-value` types the value instead.
   **Fix:** make it public, or add `Window::perform_a11y_action(ActionRequest)`,
   upstream.
3. **No window capture outside tests.** `Window::render_to_image` is
   `test-support` only, so `capture-page` refuses by name.
   **Fix:** the feature in smoke builds only, or an OS capture of the window
   (macOS `CGWindowListCreateImage` needs Screen Recording). This is a
   decision for S2.5's follow-up.
4. **No disabled flag or clipping in the dump.** Every node reads as enabled
   and visible. The driver honours `disabled: true` should it appear.
5. **No author ids in the dump.** `accessibility_id` is not printed. A
   selector's `id` matches the element id that created the node, which debug
   builds print, qualified by its view (`StudioPage::record`).

Gaps 1 and 2 are the ones the smokes need first. Until 1 closes, the driver
can read a window (`ui-tree`, `ui-find`) and press keys into whatever has the
focus (`ui-key`), but it cannot click.

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

Wait for a GPUI product path or new commands first:

| Smoke                                                                                                                                            | Missing on GPUI                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke:captions-live`                                                                                                                            | the renderer's caption frame submissions (live PNG and cue frames)                                                                                              |
| `smoke:preview-overlay-presentation`                                                                                                             | `native-preview-surface-status`, `preview-surface-sample`                                                                                                       |
| `smoke:banners`, `smoke:html-overlay`                                                                                                            | `import-takeover-image` (the Images takeover import), `html-overlay-stats` (an HTML overlay host)                                                               |
| `smoke:screens`                                                                                                                                  | `import-takeover-image`, `main-window-id`, `capture-page` (gap 3)                                                                                               |
| `smoke:preview-pump-diagnostics`, `smoke:preview-click-focus`                                                                                    | Electron's present-pump and click-focus probes                                                                                                                  |
| `smoke:preview-scene-commit`, `smoke:freeform-editor`                                                                                            | `select-camera-shape`; the editor needs clicks (gap 1)                                                                                                          |
| `smoke:preview-check-invisible`                                                                                                                  | `preview-surface-sample`, the Check computer command                                                                                                            |
| `smoke:recording-native-preview`, `smoke:preview-surface`, `probe:preview-lifecycle`, `probe:preview-window`, `smoke:preview-interaction-stress` | Electron's native-surface and window commands; they need GPUI-specific probes, not a port                                                                       |
| `probe:comments-window`                                                                                                                          | the chat fixtures (`comments-window-push-*`, `-seed-*`), `capture-page` (gap 3), the person card and layout metrics; it needs a GPUI-specific probe, not a port |

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

### Sources, layouts and saved scenes

`StudioSmoke` also runs:

- `select-screen-device {sourceId?, timeoutMs?, settleMs?}`: the first available ScreenCaptureKit screen or window (any
  screen off macOS), or `sourceId`; it turns the test pattern off first, as Electron's hook does. Answers `{id, kind}`.
- `select-camera-device {cameraId?, off?, timeoutMs?, settleMs?}`: the first available camera, `cameraId`, or Camera
  off. Answers `{cameraId}`.
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
- Reorder: `studio-scene-move` instead of a row's Alt+ArrowUp (no clicks or row focus yet, driver gap 1); position keys
  come from `studio-scenes-state`'s `keys`.
- Rapid keys: the trace is polled from `studio-scenes-state`; the renderer-only diagnostics (layout intent, queued key,
  resolve generation) are `null`. The gate reads only the frames and the final state.
- A refused scene apply reads as `false` (the command's error); refusal reasons come from `studio-state`.
- Add app… for the password-manager list goes through `studio-privacy-add-app` (no picker yet).
- Follow's "Videorc in front" row is Electron's and is left out on GPUI.
