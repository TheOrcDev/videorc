# spike-a11y (plan 260 S0.6, WC-0.8)

**Question:** can a screen reader (VoiceOver, Narrator, Orca) read a GPUI
list and dialog through AccessKit; can a headless test click Record; and
can a UI driver find a control by role and name through the same tree?

**Answer on macOS: yes for the tree, the driver and the headless test; the
spoken VoiceOver pass is still owed** (verdicts below). Two gaps for the
kit: a modal dialog doesn't hide what is behind it from the tree, and
focus isn't restored when a dialog closes.

## What it does

A 900 × 640 window, every control with a role and a name, built with
GPUI's own accessibility API (`.role()`, `.aria_label()`,
`.aria_selected()`, `.aria_position_in_set()`…, as in GPUI's
`examples/a11y.rs`):

- A toolbar "Studio": the heading, a status ("Ready" / "Recording") and a
  **Record** button that becomes "Stop recording".
- A list "Scenes" of six items (position, set size, selected).
- "Delete scene…" opens a modal `AlertDialog` "Delete <scene>?" with a
  description and Cancel and Delete. Escape cancels; Tab moves between the
  eight tab stops.
- `--dump-tree <path>` writes GPUI's own view of the tree
  (`Window::debug_a11y_tree_json`) after every frame. It is empty until an
  assistive technology (VoiceOver, or any accessibility client) asks:
  AccessKit activates lazily.
- The test at the bottom of [`src/main.rs`](src/main.rs) clicks Record
  headlessly with `TestAppContext` (no window server).

## Run it

```sh
cd spikes/gpui
cargo build --release -p spike-a11y
cargo run --release -p spike-a11y -- --seconds 120 --dump-tree tree.json
```

Then read it with the platform's screen reader: **VoiceOver** (⌘F5) on
macOS, **Narrator** (Ctrl+Win+Enter) on Windows, **Orca** on Linux. Expected:
the list is announced as "Scenes, list, 6 items", each item with its name
and position, Record as a button, and the dialog (after "Delete scene…")
with its title, its description and both buttons.

The headless test needs GPUI's `debug_selector`, which only records in a
debug build. In the spikes' release target, turn on debug assertions for
the two GPUI crates alone instead of building everything in debug:

```sh
cargo test --release -p spike-a11y \
  --config 'profile.release.package."gpui-pre".debug-assertions=true' \
  --config 'profile.release.package."gpui-pre".strip=false' \
  --config 'profile.release.package."gpui-pre-macros".debug-assertions=true' \
  --config 'profile.release.package."gpui-pre-macros".strip=false' \
  --config 'profile.release.build-override.strip=false'
```

(A plain `cargo test -p spike-a11y`, in debug, needs none of this.)

## Verdicts on macOS (2026-11-23)

Driven through the macOS accessibility API with cua-driver, the same API
VoiceOver reads; GPUI 0.3.14, macOS 26, the owner's M4 MacBook Pro.
[`ax-tree.example.md`](ax-tree.example.md) is what the API returned with
the dialog open.

| Check | Verdict | Evidence |
| --- | --- | --- |
| The tree reaches the platform | **PASS** | `AXToolbar "Studio"`, `Heading`, `AXButton "Record"`, `AXList "Scenes"` with six items, `AXButton "Delete scene…"`: 25 AccessKit nodes |
| A UI driver finds a control by role and name | **PASS** | `AXButton` named "Record" found and pressed (`AXPress`): `record started`, the button became "Stop recording" and the status "Recording" |
| The list | **PASS** | Six `AXGroup` items in an `AXList`, each named, pressable (one pressed: "Interview" selected); GPUI's tree carries `position_in_set`, `size_of_set` and `selected` |
| The dialog | **PASS** | An `AXWindow` "Delete Interview?" with the description as its help, a heading, the text, and `AXButton` Cancel and Delete; Cancel pressed through the API closed it |
| A headless test clicks Record | **PASS** | `clicking_record_starts_and_stops`: `TestAppContext`, `simulate_click` on the button's bounds, on and off (34 s build on the warm target, 0.00 s run) |
| VoiceOver speaks it | **OWED** | Not run: turning VoiceOver on speaks aloud and takes over the owner's Mac. Needs the owner (two minutes) or a quiet machine |
| Tab order | **NOT RUN** | GPUI reports 8 tab stops; the driver could not keep the window key on this shared screen (each foreground action hands focus back) |

## Found

- **AccessKit activates lazily.** The first accessibility query after the
  window opens sees only the frame (traffic lights); the full tree follows
  a frame later. A UI driver should query once and wait for the tree.
- **GPUI's test platform has no accessibility tree** (its `a11y_init` does
  nothing), so a headless test can't find controls by role and name;
  `debug_selector` plus `simulate_click` works, in debug builds. Finding by
  role and name has to run against a real window (the UI driver, S2.5).
- **A modal dialog doesn't hide the controls behind it** from the tree:
  "Delete scene…" stays reachable while the dialog is open. GPUI has no
  `aria_modal`; the kit's dialog should leave the background out of the
  tree (or mark it hidden) while open.
- **Focus isn't restored when a dialog closes**: GPUI's focus was `None`
  after Cancel, so Tab did nothing until something was clicked. The kit's
  dialog must return focus to the control that opened it.
- **GPUI doesn't draw a covered window**, so neither its pixels nor its
  accessibility tree update until it is uncovered. On a shared screen a
  driver must keep its window visible.

## Verdicts on Linux (ogre, 2026-11-24, lane L5)

ogre: Omarchy, Hyprland 0.56.2, release build, clocks pinned at 800 MHz.
The owner's session was locked, so the spike ran in a **nested Hyprland**
on the lab output, on Wayland and on its Xwayland. Accessibility was
turned on only on a **private session bus** with its own AT-SPI bus
(`at-spi-bus-launcher` and `at-spi2-registryd` started by hand on it; the
owner's AT-SPI bus and its `IsEnabled = false` were not touched). The
driver, [`linux/atspi-driver.py`](linux/atspi-driver.py) (AT-SPI through
`gi`'s `Atspi`, already on ogre), finds controls by role and name and
presses them with their `click` action; it is the Linux form of the UI
driver's query.

| Check | Verdict | Evidence |
| --- | --- | --- |
| The tree reaches AT-SPI | **PASS** (Wayland and X11) | The application `spike-a11y` on the bus, 26 nodes: `frame`, `tool bar "Studio"`, `heading`, `status bar "Ready"`, `button "Record"`, `list "Scenes"` with six `list item`s, `button "Delete scene…"` |
| A UI driver finds a control by role and name | **PASS** | `button` named "Record" found and its `click` action run: `record started`; it came back as `button "Stop recording"` |
| The list | **PASS, one gap** | Six `list item`s, each named, `selectable`, the selected one `selected`; pressing the second selected it. **`posinset` reads 2 to 7, not 1 to 6, and `setsize` is missing** (below) |
| The dialog | **PASS** | An `alert` "Delete Screen and camera?" with the description as its description, a heading, the text, and `button`s Cancel and Delete; Cancel pressed through AT-SPI closed it and it left the tree |
| A headless test clicks Record | **PASS** | `clicking_record_starts_and_stops` on ogre with the release-plus-debug-assertions command above (1,053 s build from a warm release target at 800 MHz, 0.01 s run) |
| Orca speaks it | **OWED** | **Orca screen-reader pass owed: needs Orca installed on an unlocked session.** Orca is not installed on ogre and the session is locked |
| Modal dialog hides the background | **FAIL** (as on macOS) | "Delete scene…" stays reachable while the dialog is open; the alert has no `modal` state |
| Focus returns after the dialog | **FAIL** (as on macOS) | After Cancel only the `frame` is focused |

Found on Linux:

- **`aria_position_in_set` is 0-based in AccessKit**, and GPUI's own
  `examples/a11y.rs` (and this spike) pass `i + 1`. GPUI's tree shows
  `position_in_set: 1` for the first item; `accesskit_atspi_common` adds
  one (`node.rs`, `position_in_set`), so AT-SPI reads `posinset 2`, and
  Orca would say "2 of 6". The kit's list should pass the 0-based index.
- **`setsize` is missing**: AccessKit's AT-SPI adapter reads the set size
  from the container (`size_of_set_from_container`), and the spike sets it
  on each item. The kit sets it on the list.
- **Accessibility is off until a client asks**, as on macOS: with the
  session's `org.a11y.Status.IsEnabled` false (the owner's), AccessKit
  exposes nothing; a UI driver on Linux sets it on its own bus.
- **ogre's AT-SPI bus is a `dbus-broker` that activates through systemd**;
  on a private bus the registry must be started by hand
  (`/usr/lib/at-spi2-registryd`), or `Atspi.get_desktop` fails with
  "Could not activate remote peer".

## Windows and Linux

The spike is all GPUI code. Windows (WC-0.8): `gpui-pre-windows` depends
on `accesskit_windows`, and Zed's Narrator issue
([#41138](https://github.com/zed-industries/zed/issues/41138)) is still
open, so the Narrator pass is the open question. Linux (L5): the tree
through AT-SPI passes (above); the Orca pass is owed.

## Summary fields

The common fields, plus `renders`, `startup_to_first_paint_ms`, and this
spike's own (in [SUMMARY.md](../SUMMARY.md)): `a11y_tree_available`,
`a11y_nodes`, `recording_at_end`, `deleted_scenes`, `events`.
