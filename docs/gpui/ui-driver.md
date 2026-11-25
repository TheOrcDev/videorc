# The UI driver on GPUI (plan 260 S2.5)

The smokes drive the GPUI app the way they drive Electron: `VIDEORC_APP=gpui`
(`scripts/lib/app-launcher.mjs`), the loopback smoke command server, and the
one JS driver (`scripts/lib/ui-driver.mjs`). Their `ui-*` commands work on
each window's AccessKit tree, which is what VoiceOver, Narrator and Orca read.

| Part | Where | Owner |
| --- | --- | --- |
| Server, policy, the core's commands (`app-quit`, `backend-debug-rpc`, `authorize-smoke-resource`, `inspect-backend-state-isolation`, the quit guard) | `crates/videorc-app-core/src/smoke/` | L6 |
| The tree as data, selectors (`ui_tree`, `gpui_tree`) | `crates/videorc-app-core/src/smoke/` | L6 |
| The driver on live windows, the foreground hop, turning accessibility on | `apps/videorc/src/smoke/` | L6 |
| Starting the server, which window is which, the forced look, a toast | `smoke::start` in `main.rs`, `ShellSmoke` in `apps/videorc/src/smoke/shell.rs` | L6 (Phase 3) |
| `studio-*` and the other Studio commands (`STUDIO_COMMANDS`) | a `SmokeCommandHandler` on S1.6a's Studio | L7 |
| `open-tab`, `main-window-*`, the preview's and each window's commands | `SmokeCommandHandler`s from the slices that own them | their lanes |

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
