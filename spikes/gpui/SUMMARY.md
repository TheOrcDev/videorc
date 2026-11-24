# The spike summary format (`summary.json`)

Every plan 260 spike ends its timed run the same way:

1. It prints one line to standard output: `[spike] summary ` followed by the
   JSON on one line.
2. It writes the same JSON, pretty-printed, to `summary.json` in the folder
   it was started from (or to `--out <path>`).
3. It exits `0`, or `1` when it reported any error.

Anything that goes wrong is printed at once as `[spike] error <message>`
and counted in `errors`. A panic is reported the same way. The
[`spike-summary`](spike-summary/src/lib.rs) crate does all of this; a
spike calls `Run::start("<spike-name>")` first, `run.set(...)` for its
numbers, and `run.finish()` at the end. Use it rather than writing the
JSON by hand, so the common fields are the same on every platform.

The Windows contributors attach this file to their evidence comment
([Windows testing plan, "Sending evidence"](../../plans/260-gpui-rewrite-windows-testing.md#sending-evidence)).

## Arguments every spike takes

| Argument | Meaning | Default |
| --- | --- | --- |
| `--seconds <n>` | Length of the timed run; the spike closes itself after it | `30` |
| `--out <path>` | Where `summary.json` is written | `summary.json` in the current folder |

A spike's own flags (`--route a`, `--floating`, `--resolution 4k`…) are
read with `run.args.flag("--floating")` and `run.args.value("--route")`.

## Common fields (every spike, `schema_version` 1)

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | integer | `1`. Bumped only when a common field changes meaning |
| `spike` | string | The spike's package name, for example `spike-hello` |
| `os`, `arch` | string | `macos`, `windows` or `linux`; `aarch64` or `x86_64` |
| `gpui_pre` | string | The pinned GPUI snapshot, `0.3.14` |
| `build` | string | `release` or `debug` (numbers only count from `release`) |
| `args` | string array | The command line after the program name |
| `started_unix_ms` | integer | When the run started |
| `seconds` | integer | `--seconds` as asked |
| `elapsed_s` | number | Wall time from start to the summary |
| `logical_cpus` | integer | Logical processors, so CPU percentages can be read |
| `process_cpu_seconds` | number | User plus system CPU time of the spike's process |
| `process_cpu_percent_avg` | number | `process_cpu_seconds / elapsed_s × 100`: percent of **one** core, averaged over the whole run including start-up (200 means two cores busy) |
| `peak_rss_mb` | number | Peak resident memory (Windows: peak working set) |
| `errors` | integer | How many `[spike] error` lines were printed. `0` to pass |
| `error_messages` | string array | Their text |

## Spike fields

Use these names whenever a spike measures the thing; a spike leaves out
what it does not measure. The pass lines are the Windows testing plan's
([S0.2a](../../plans/260-gpui-rewrite-windows-testing.md#s02a-gpui-builds-and-runs-on-windows),
[S0.2c](../../plans/260-gpui-rewrite-windows-testing.md#s02c-the-windows-preview-routes-measured)),
which are plan 260's S0.1 lines.

| Field | Type | Meaning | Pass line |
| --- | --- | --- | --- |
| `renders` | integer | Times GPUI called the root view's `render` | above 0 |
| `startup_to_first_paint_ms` | number | Process start to the first GPUI frame after the first `render` (`Window::on_next_frame`) | reported (S0.9) |
| `ui_redraws_per_second_idle` | number | `renders / elapsed_s` while nothing in the UI changes | ≤ 2 for routes a, c, d |
| `native_view` | boolean | The video is a native layer under GPUI (not pixels GPUI paints) | — |
| `presents` | integer | Video frames presented by the presenter | — |
| `presents_per_second` | number | `presents / elapsed_s` | at the display or source rate |
| `present_interval_p95_ms` | number | p95 of the time between two presents (nearest rank) | ≤ 20 |
| `drawable_px` | string | Size of the presented surface, `<w>x<h>` | — |
| `cpu_copies_per_frame` | integer | CPU copies of a video frame between producer and screen | 0 for routes a, b, c |
| `ui_cpu_percent_still` | number | App process CPU (% of one core) while the scene does not change | ≤ 3 |
| `ui_cpu_percent_live` | number | App process CPU (% of one core) while the video moves | ≤ 10 |
| `gpu_ms_per_frame_p95` | number | p95 GPU time per presented frame | ≤ 2 |
| `dropped_frames` | integer | Frames the producer made that never reached the screen | reported |
| `route` | string | `a`, `b`, `c` or `d` (S0.2c) | — |
| `resolution`, `fps` | string, integer | The source's size and rate (S0.2c) | — |
| `bundle_id` | string or null | The app bundle's id on macOS (`spike-desktop`, S0.7) | — |
| `hotkey`, `hotkey_presses` | string, integer | The global shortcut and how many presses arrived (S0.7) | ≥ 1 when pressed with another app in front |
| `menu_actions` | string array | Menu items that ran, in order (S0.7) | — |
| `open_urls` | object array | Each link: `url`, `ms_after_start`, `before_main_window` (S0.7) | the cold-start link arrives |
| `single_instance_handoffs` | array of string arrays | The arguments each second start handed over (S0.7) | — |
| `hidden_window`, `on_top_window` | object | The test windows: id, `sharing_none`, `level`, `hides_on_deactivate`, or `gap` (S0.7) | — |
| `keep_awake_assertions`, `notifications_posted` | integer | Sleep-guard assertions taken; notifications posted (S0.7) | — |
| `notification_responses` | object array | Notifications the user clicked: `tag`, `action` (S0.7) | — |
| `picked_paths`, `revealed_paths`, `trashed_paths`, `dropped_paths` | string array | Files through the open dialog, Show in Finder, the Trash, drag and drop (S0.7) | — |
| `header_double_clicks`, `header_drags`, `reopens` | integer | Custom-header double-clicks and drags; Dock reopens (S0.7) | — |
| `window_open_to_first_paint_ms` | number | `open_window` to the first frame (S0.5) | ≤ 100 |
| `chat_rows`, `chat_rows_built`, `chat_data_ms` | integer, integer, number | Chat size, rows the list built during the run, time to make the rows (S0.5) | — |
| `chat_remount_to_frame_ms` | number | Resetting the whole chat to the next frame (S0.5) | — |
| `emotes` | string | `gpui-img` or `timer` (S0.5) | — |
| `scroll` | object | The scroll test: `fps`, `interval_p50_ms`, `interval_p95_ms`, `interval_p99_ms`, `interval_max_ms`, `frames_over_16_7_ms`, `frames_with_window_active`, `rows_built_during` (S0.5) | `fps` ≥ 60, `interval_p95_ms` ≤ 16.7 |
| `idle_with_emotes` | object | Five idle seconds with emotes on screen: `cpu_percent`, `renders_per_second`, `window_active` (S0.5) | — |
| `ime_steps` | object array | Each IME step: `step`, `text`, `marked`, `want_text`, `want_marked`, `ok`; then the candidate rect (S0.5) | every `ok` true |
| `numbers` | object | Digit-run widths with and without `tnum`: `tabular_equal`, `proportional_differs` (S0.5) | `tabular_equal` true |
| `selected_text` | string array | Text selected with the mouse (S0.5) | — |
| `ime_observed` | object array | Every change of the input's committed `text` and composing `marked` text while a real input method typed (`--ime-wait`, Windows and Linux; S0.5) | the composed text commits |
| `a11y_tree_available`, `a11y_nodes` | boolean, integer | Whether GPUI built an accessibility tree (an assistive technology asked for it) and how many nodes it had (S0.6) | true once a screen reader or driver is attached |
| `recording_at_end`, `deleted_scenes`, `events` | boolean, string array, string array | What the controls did, in order (S0.6) | — |
| `backing` | string | The surface that shows the video, in words (S0.3) | — |
| `session` | string | `wayland` or `x11` (S0.3) | — |
| `video_below_gpui` | boolean | GPUI's own drawing shows over the video in the main window (S0.3; X11's child window covers it) | true, or `overlay_window` |
| `overlay_window` | boolean | GPUI's overlay is drawn in a second, override-redirect window over the slot (S0.3, X11) | — |
| `present_interval_source` | string | What `present_interval_p95_ms` timed: `wp_presentation (on screen)`, the commit, `ShmCompletion`, or the image route's notify (S0.3) | — |
| `ui_redraws_per_second_live` | number | GPUI frames a second while the video moves (S0.3) | 0 for the native routes |
| `cpu_copies_per_frame_in_app` | integer | The part of `cpu_copies_per_frame` made in the app's process (S0.3) | 0 for the native routes |
| `linux` | object | spike-linux-preview's full report: per phase (live, still, resize) the app's, writer's and compositor's CPU, GPUI paints, frames, commit and presentation intervals, ages and lease times (S0.3) | — |

A spike that needs a number not in this table adds it with a plain
snake-case name and a unit suffix (`_ms`, `_mb`, `_percent`), and adds a
row here in the same PR.

## Example

From `spike-native-preview` on the owner's M4 MacBook Pro (2026-11-23),
`cargo run --release -p spike-native-preview -- --seconds 40`: see
[spike-native-preview/summary.example.json](spike-native-preview/summary.example.json).
