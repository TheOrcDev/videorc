# spike-desktop (plan 260 S0.7, WC-0.9)

**Question:** does GPUI, with a few calls through the window's raw handle,
cover every desktop job Electron's main process does for Videorc today:
menus, the title bar over a custom header, a global shortcut, a deep link on
a cold start, one instance, window order, Hide from stream, the sleep guard,
system notifications and files?

**Answer on macOS: yes, every row** (verdicts below). One GPUI default
needs a line of our own code (the floating panel). Windows (WC-0.9) and
Linux (L5) fill in their halves of [`src/os.rs`](src/os.rs); until then
those calls report a gap instead of faking a pass.

## What it does

One main window (a 40 px custom header with the traffic lights in its
88 px gutter, a column of checks and an event log), plus two small test
windows in a column on the right:

- **Magenta, "Hidden from stream":** `NSWindow.sharingType = .none`, what
  Electron's `setContentProtection(true)` sets. A capture should not show it.
- **Cyan, "Keep on top":** a normal window raised to `NSFloatingWindowLevel`
  through the raw handle (Electron's `setAlwaysOnTop`), so it can be toggled
  at run time as Notes and Preview do. `--gpui-floating` opens it as GPUI's
  `WindowKind::Floating` panel instead (see "Found").

Every check is a button in the window and an item in the menu bar, so a
driver can run it through the accessibility tree:

| Menu | Items |
| --- | --- |
| spike-desktop | About, Services (the system's), Hide (⌘H), Hide Others (⌥⌘H), Show All, Quit (⌘Q) |
| File | Open… (⌘O), Show Sample in Finder, Move Sample to Trash |
| Edit | Undo, Redo, Cut, Copy, Paste, Select All (each with its `OsAction`) |
| Window | Minimize (⌘M), Zoom, Keep on Top ✓, Hide from Stream ✓, Keep Awake ✓, Post Notification, Bring Test Windows to Front |

- **Global shortcut:** Ctrl+Option+Shift+R (Ctrl+Alt+Shift+R) through the
  `global-hotkey` crate; each press prints `[spike] hotkey`.
- **Deep links:** `videorc-spike://…` through `on_open_urls`, registered
  before `run` so a link that starts the app is not lost. A link passed on
  the command line (how Windows and Linux deliver one) counts too.
- **One instance:** the first start owns loopback port 47931; a second start
  sends its arguments there and exits 0, and the first focuses its window.
- **Sleep guard:** `IOPMAssertionCreateWithName(PreventUserIdleDisplaySleep)`,
  released on toggle and on quit.
- **Notifications:** `cx.show_system_notification`.
- **Files:** `prompt_for_paths`, `reveal_path`, the `trash` crate (macOS:
  `NSFileManager`, which needs no Automation consent; the crate's default
  asks Finder through AppleScript), and `on_drop` with `ExternalPaths`. The
  sample file is `$TMPDIR/spike-desktop/sample.txt`, made at start.

## Run it

```sh
cd spikes/gpui
cargo build --release -p spike-desktop
cargo run --release -p spike-desktop -- --seconds 300
```

**macOS:** links and notifications need an app bundle. Make one (its own
scheme and bundle id, never `videorc://`), then start it from a link:

```sh
./spike-desktop/bundle-macos.sh              # prints the .app path
open 'videorc-spike://hello'                 # cold start from a link
# Started by a link, it runs in `/`: the summary goes to
# $TMPDIR/spike-desktop/summary.json, or set SPIKE_OUT / SPIKE_SECONDS
# with `open --env`.
./spike-desktop/bundle-macos.sh --unregister # when done
```

Running `<target>/release/spike-desktop.app/Contents/MacOS/spike-desktop`
directly also counts as bundled (notifications work) and keeps stdout.

| Flag | Meaning |
| --- | --- |
| `--gpui-floating` | Open the cyan window as GPUI's `WindowKind::Floating` (an `NSPanel`), with `hidesOnDeactivate` turned off |
| `--keep-panel-default` | With `--gpui-floating`, leave the panel as GPUI makes it |

## What you should see (each row of the S0.7 table)

| # | Check | Expected |
| --- | --- | --- |
| 1 | Menus | The menu bar shows the four menus above; each item prints `[spike] action <name>` |
| 2 | Title bar | The traffic lights sit centred in the 40 px header (x 14, y 13); dragging the header moves the window; double-clicking it zooms (or minimises, per the system setting) |
| 3 | Global shortcut | With another app in front, Ctrl+Option+Shift+R prints `[spike] hotkey` |
| 4 | Deep link, cold | With the spike closed, `open 'videorc-spike://hello'` starts it; the summary's `open_urls` has the link with `before_main_window: true` |
| 5 | One instance | Starting it again (the binary, or `open -n`) prints `handed over … exiting` there; the first prints the arguments and comes to the front |
| 6 | Keep on top | The cyan window stays above another app's window that is in front and overlaps it |
| 7 | Hide from stream | The magenta window is missing from a screenshot or screen recording; toggling Hide from Stream off makes it appear, on again hides it |
| 8 | Sleep guard | While "Keep awake" is on, `pmset -g assertions` (macOS) lists `spike-desktop is keeping the display awake` under the process |
| 9 | Notification | A notification titled "spike-desktop" (macOS asks for permission the first time; an active Focus mode delivers it silently to Notification Center) |
| 10 | Files | Open… returns the chosen path; Show in Finder selects the sample; Move to Trash removes it; dropping a file on the dashed box prints its path |

## Verdicts on macOS (2026-11-23)

The owner's M4 MacBook Pro, macOS 26, release build, driven through the
accessibility tree and real input (cua-driver), load average about 3.5 to 4
from other agents' builds. Evidence and screenshots are in the plan 260
report folder, outside the repository.

| # | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Menus | **PASS** | The menu bar reads Apple, spike-desktop, File, Edit, Window; the system filled Services; items invoked by accessibility ran (`menu_actions`) |
| 2 | Title bar | **PASS** | Lights centred in the 40 px header; a real drag moved the window from (0, 32) to (110, 139); a double-click zoomed it from 1116 × 880 to 1512 × 885 (`titlebar_double_click`) |
| 3 | Global shortcut | **PASS** | With Finder in front, the shortcut posted through the HID path printed `[spike] hotkey` |
| 4 | Deep link, cold | **PASS** | `open 'videorc-spike://hello?from=cold-start'` started the app; the link arrived 91 ms after start, before the main window |
| 5 | One instance | **PASS** | A direct second start and `open -n` both handed over and exited 0; a warm `open videorc-spike://warm` reached the running app |
| 6 | Keep on top | **PASS** | Finder in front and overlapping: the cyan window stayed above it (317,000 cyan pixels in the capture); window level 3 |
| 7 | Hide from stream | **PASS** | Full-screen captures, magenta pixels: 0 (hidden), 314,253 (toggled off), 0 (on again); a window-only capture of it comes back blank |
| 8 | Sleep guard | **PASS** | `pmset -g assertions` listed the `PreventUserIdleDisplaySleep` assertion; none left after Quit |
| 9 | Notification | **PASS** | The permission prompt appeared; after Allow, `usernoted` delivered it "as banner"; the owner's Focus mode muted the banner and kept it in Notification Center (unified log) |
| 10 | Files | **PASS** | The open panel returned the sample's path; Show in Finder selected it; Move to Trash removed it; dragging it from Finder onto the box printed its path |

Cost over a 337 s driven run: 0.7 % of one core on average, 113.5 MB peak
memory, first frame 163 ms after start, 129 renders (all from input or
events; idle draws nothing).
[summary.example.json](summary.example.json) is that run.

## Found

- **GPUI's `WindowKind::Floating` hides when another app is in front.** It
  is an `NSPanel`, and panels default to `hidesOnDeactivate = YES`; GPUI
  never turns it off. With Finder in front the cyan panel dropped from
  317,479 visible pixels to 95. Setting `hidesOnDeactivate = NO` through
  the raw handle keeps it (317,486). The app should use normal windows and
  raise their level (this spike's default), which also allows toggling
  Keep on top at run time; no GPUI patch is needed.
- **GPUI doesn't draw a window another window covers**, so a menu action
  run while the window is covered shows only once it is uncovered. A first
  reading of this run blamed accessibility menu presses; rerun with the
  window visible, an accessibility press of Window → Keep Awake redrew at
  once. A driver on a shared screen must keep its window visible.
- `screencapture` and a ScreenCaptureKit window capture (cua-driver's)
  both honour `sharingType = .none` on macOS 26. The backend's capture
  filter can also exclude the window ids the spike prints.
- macOS notifications need a bundle: without one GPUI quietly disables
  them (`gpui-pre-macos` `system_notifications.rs`), so `os::can_notify`
  reports it as an error instead.

## Verdicts on Linux (ogre, 2026-11-24, lane L5)

ogre: Omarchy, Hyprland 0.56.2, release build, clocks pinned at 800 MHz.
The owner's session was locked, so the spike ran in a **nested Hyprland**
on the lab output, on Wayland and on its Xwayland, with a **private session
bus** carrying stand-ins for the desktop's services
([`linux/fake-session-services.py`](linux/fake-session-services.py):
`org.freedesktop.Notifications` and `org.freedesktop.ScreenSaver`, each call
logged) and a private `XDG_DATA_HOME`. The checks were pressed through
AT-SPI by role and name ([`linux/press.py`](linux/press.py); the buttons
now carry `Role::Button` and their label), since Linux has no native menu
bar to drive instead. `src/os.rs` now has a Linux half.

| # | Check | Wayland | X11 (Xwayland) | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Menus | `cx.set_menus` stores them (`get_menus`); GPUI draws no menu bar on Linux | Same | **The app draws its menus**, as Zed does and as on Windows |
| 2 | Title bar | Not run: the nested compositor takes no synthetic pointer drags | Same | **NOT RUN** |
| 3 | Global shortcut | `global-hotkey` reports registered but has no Wayland backend | Ctrl+Alt+Shift+R through XTEST: 2 presses, 2 `[spike] hotkey` | **X11 PASS; Wayland gap:** the GlobalShortcuts portal (plan 257) |
| 4 | Deep link, cold | `videorc-spike://hello?from=cold-start` on the command line: arrived 0.6 ms after start, before the main window | Same | **PASS** (the `.desktop` file that makes the scheme start the app was not installed: it writes into the owner's desktop database) |
| 5 | One instance | A second start with `videorc-spike://warm` handed over and exited 0; the first got the link 15 s in | Same code | **PASS** |
| 6 | Keep on top | No protocol: reported as a gap | `_NET_WM_STATE_ABOVE` sent; **Hyprland's Xwayland window manager does not set it** (level stays 0) | **Gap:** Wayland has no window level (a compositor rule or layer-shell); EWMH untested on a real X window manager |
| 7 | Hide from stream | No protocol: reported as a gap | No protocol | **Gap** (plan 257 D8): the backend's capture filter, or a compositor rule such as Hyprland's `no_screen_share` |
| 8 | Sleep guard | `org.freedesktop.ScreenSaver.Inhibit` → cookie 1, `UnInhibit` on toggle off (the stand-in's log) | Same | **PASS** (the call Chromium makes for Electron's `powerSaveBlocker`; hypridle answers it) |
| 9 | Notification | `Notify` arrived: app and summary "spike-desktop", body "Notification 1 from GPUI", a `default` action | Same | **PASS** (through notify-rust on the session bus) |
| 10 | Files | Show in Finder ran `xdg-open` on the folder (Nautilus opened it); Move to Trash put the sample in `/tmp/.Trash-1000` (the freedesktop per-mount trash); Open… needs the FileChooser portal, absent on the private bus; drop not run | Same | **Reveal and Trash PASS; Open… untested here** (needs `xdg-desktop-portal`, which the owner's session has) |

Cost: 2.8 % of one core over a 46 s Wayland run, 89.7 MB peak, first
frame 935 ms (Wayland) and 826 ms (X11) after start at 800 MHz.

Found on Linux:

- `reveal_path` with no FileManager1 on the bus falls back to `xdg-open`
  on the folder, which starts the file manager.
- The freedesktop trash puts a file from `/tmp` in `/tmp/.Trash-1000`,
  not the home Trash; the app's recordings live in the home directory, so
  theirs go to the home Trash.

## Windows and Linux

The window, menus, global shortcut, links on the command line, one
instance, notifications, files and the summary are cross-platform code.
On Windows each `os.rs` call (hide from capture, keep on top, sleep guard)
returns `Err("… not written for <os> yet")` and counts as a `[spike] error`:

- **Windows (WC-0.9):** `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`,
  `HWND_TOPMOST`, `SetThreadExecutionState(ES_DISPLAY_REQUIRED |
  ES_CONTINUOUS)`, the `videorc-spike` scheme under
  `HKCU\Software\Classes`, an AppUserModelID for notifications, and
  Windows' caption buttons in the header (`WindowControlArea::Min`, `Max`,
  `Close`, so snap layouts show on the maximise button).
- **Linux (L5):** written and run (above): the ScreenSaver inhibitor,
  EWMH keep on top on X11, and the gaps that stay: the GlobalShortcuts
  portal on Wayland (`global-hotkey` only covers X11), a `.desktop` file for
  the scheme, and what Hide from stream can be there (plan 257 D8).

Neither target could be checked from this Mac (the Windows build needs
`llvm-rc`, the Linux build the Wayland libraries), so the first build on
each platform is also its compile check.

## Summary fields

The common fields, plus `renders`, `ui_redraws_per_second_idle`,
`startup_to_first_paint_ms`, and this spike's own (all in
[SUMMARY.md](../SUMMARY.md)): `bundle_id`, `hotkey`, `hotkey_presses`,
`menu_actions`, `open_urls`, `single_instance_handoffs`, `hidden_window`,
`on_top_window`, `keep_awake_assertions`, `notifications_posted`,
`notification_responses`, `picked_paths`, `revealed_paths`,
`trashed_paths`, `dropped_paths`, `header_double_clicks`, `header_drags`,
`reopens`.
