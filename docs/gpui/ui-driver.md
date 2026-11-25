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

## Recording smokes on the GPUI app

Run with `VIDEORC_APP=gpui`:

- `smoke:record-latency` seeds its video profile with `studio-capture-configure`, arms the clip buffer with
  `studio-replay-buffer {armed, seconds}` (`Studio::set_clips_for_run`), and reads a refused start from
  `studio-state`. Its cycles already press Record and Stop through the remote surface, which the core's Studio serves.
  `--real-screen` stays Electron-only until the GPUI app has `select-screen-device`.
- `smoke:recording-matrix` drives the backend directly (`session.start` with the test pattern) and needs only
  `authorize-smoke-resource`, so it runs unchanged.
