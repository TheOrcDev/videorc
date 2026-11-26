# spike-native-view-windows (plan 260 WC-0.2, checked by S0.2a)

**Question:** can a GPUI window on Windows show video as a native view,
a DirectComposition visual beneath GPUI's own, that a GPUI element lays
out, that presents on its own thread, with GPUI drawing over it and not
redrawing per video frame? This is route (a) in one process.

**Answer on one Windows PC (a GTX 1650 SUPER desktop): yes,** with a
GPUI patch of +637 −5 lines (below). The video presents at the display's
rate (59 a second at 60 Hz, p95 17.0 ms between presents) while GPUI
renders twice in 40 s. The full numbers are under "Reference result".

## What it does

- spike-hello's window (1100 × 640, a 280 px sidebar and a content pane),
  with the pane's colour replaced by a `gpui::NativeView`.
- The view's content is a swap chain from
  `IDXGIFactory2::CreateSwapChainForComposition` on the spike's own D3D11
  device. A plain thread (`presenter`) waits on the swap chain's
  frame-latency object (maximum latency 1), keeps the buffers at the size
  GPUI laid the view out at, clears them to a colour that changes over
  time (the macOS spike's palette) and presents with vsync.
- Over the video GPUI draws a translucent bordered box (an editor handle),
  an opaque red square and a translucent pill with text. The video has
  10 px rounded corners.
- A magenta box is painted **before** the view, under it. Seeing magenta
  means the renderer did not erase what was drawn before the view.
- GPUI has no timer: it renders at startup and when the layout changes.
  `--layout-test` switches the sidebar between 280 and 400 px and the
  padding between 24 and 64 px every two seconds, so the view moves and
  resizes without anyone touching the window.
- Closes itself after `--seconds` and writes the summary. It builds on
  macOS and Linux but reports an error there: the native view is Windows
  only (macOS has `spike-native-preview`).

## The GPUI patch

[`../patches/gpui-pre-windows/`](../patches/gpui-pre-windows/) is
`gpui-pre-windows` 0.3.14 with native views, wired through
`[patch.crates-io]` in the workspace `Cargo.toml` (plan 260 D1). The diff
against the published crate is
[`../patches/gpui-pre-windows.patch`](../patches/gpui-pre-windows.patch):
**+637 −5**, of which `src/native_view.rs` (new) is 446 lines with its
docs and three unit tests, and the edits to `directx_renderer.rs` (+147
−4), `window.rs` (+41 −1) and `gpui_windows.rs` (+3) are 191.

It fills in `PlatformWindow::attach_native_view`, which `gpui-pre`
already calls from `NativeView::new` on every platform. Nothing in
`gpui-pre` itself changes.

- **The composition tree.** GPUI's swap chain visual moves under a new
  root visual. Each native view is a small stack of visuals inserted
  beneath GPUI's: one clipped to the element's content mask, one at the
  element's bounds with a rounded clip, a background, and the caller's
  content, unscaled.
- **Erasing.** `PaintNativeView` erases what was painted before it. The
  renderer draws an eraser per view with the quad shaders, at the batch's
  depth, and a blend state that keeps `dst × (1 − src alpha)`. Opaque
  quads painted after the view are drawn first (GPUI's opaque pass) at a
  greater depth, so the eraser leaves them alone; translucent elements
  painted after it blend over the transparent hole as usual.
- **Placing.** After each present, the renderer moves each painted view's
  visuals to the element's bounds and content mask, hides views the scene
  no longer paints, and commits only on a change. It publishes the
  laid-out size in device pixels through `NativeVisualSize`, which the
  presenter follows.
- **Background.** `NativeView::set_background` is a one-pixel composition
  surface stretched behind the content, so a frame where the content has
  not caught up with a resize shows that colour, not the window behind.
- **Lifetime.** Dropping the `NativeView` removes its visuals. After a
  lost device the visuals are rebuilt on the new composition device.
- **The Windows API.** `NativeView::new`'s `view` points to a
  `gpui_windows::NativeVisual`: the content (an `IUnknown` that
  `IDCompositionVisual::SetContent` takes), the corner radius in logical
  pixels, and the shared `NativeVisualSize`.

Not in the patch: mouse and keyboard input to the view (the view is
video; GPUI keeps all input, and the focus hooks stay the trait's
defaults), and content from another process. WC-0.5's route (a) shows the
backend's composition surface, which needs the surface handle opened on
GPUI's composition device; that is a small addition to `NativeVisual`
there.

## Run it

PowerShell, from a clone on this branch (the Windows testing plan's
[one-time setup](../../../plans/260-gpui-rewrite-windows-testing.md#one-time-setup)
first):

```powershell
cd spikes\gpui
cargo build --release -p spike-native-view-windows
cargo run --release -p spike-native-view-windows -- --seconds 40
cargo run --release -p spike-native-view-windows -- --seconds 20 --layout-test
```

Don't cover or move the window during the timed run.

**Expected:**

- The video's colour changes smoothly, while the sidebar's "GPUI renders
  so far" stays at about 2 for the whole run.
- The box and pill blend over the video, the red square is solid, the
  corners are rounded, and there is no magenta.
- Dragging the window's edge resizes the video with the pane, with no
  magenta, black or garbage at its edges.
- With `--layout-test`, the video moves and resizes every two seconds.
- The summary has `"native_view": true`, `presents_per_second` near the
  display's rate, `ui_redraws_per_second_idle` at most 2 and
  `"errors": 0`.

## Summary fields

These are added to the common fields in [SUMMARY.md](../SUMMARY.md):

- `renders`, `ui_redraws_per_second_idle`, `startup_to_first_paint_ms`,
  `window_open_to_first_paint_ms`, `scale_factor`, `viewport_px`,
  `viewport_changes`: as in spike-hello.
- `native_view`: true once the presenter has presented a frame.
- `presents`, `presents_per_second`, `present_interval_p95_ms`,
  `drawable_px`, `cpu_copies_per_frame` (0: the presenter clears GPU
  buffers): as in spike-native-preview.
- `display_hz`: the refresh rate the desktop compositor reports, to
  compare `presents_per_second` with.
- `drawable_resizes`: times the presenter resized its buffers to follow
  the layout.
- `present_waits_timed_out`: waits for a free buffer that took over a
  second, as when the window is minimised.
- `layout_test`: whether `--layout-test` ran; `ui_redraws_per_second_idle`
  is only an idle figure without it.

## Reference result

A Windows 11 Home 26H2 (build 26300) desktop: Intel Core i5-8400 (6
logical CPUs), NVIDIA GeForce GTX 1650 SUPER (driver 32.0.16.1742), 24 GB.
Its display is 1920 × 1080 at 120 % and 60 Hz. Release build, 2026-11-25.
The 40 s run's file is [summary.example.json](summary.example.json).

| Number | Value |
| --- | --- |
| Build of the patch and the spike | 3.3 min on a warm `target`; 0 warnings; clippy clean with `-D warnings` |
| Video presents | 2,396 in 40.6 s (59.0 a second; the display is 60 Hz) |
| Present interval p95 | 17.02 ms |
| GPUI renders | 2 in the whole run (0.05 a second) |
| Start to first frame | 505 ms; `open_window` to first frame 83 ms |
| Process CPU, whole run | 7.2 % of one core (presenter and GPUI together) |
| Peak memory | 64 MB |
| Drawable | 925 × 709 px, the pane at scale 1.198 |
| CPU copies per frame | 0 |

| Check | Verdict | Note |
| --- | --- | --- |
| The visual sits under GPUI content | PASS | Window captures: the box, square and pill draw over the video |
| Translucent GPUI elements blend over it | PASS | The box and pill tint the video; the colour behind them changes with it |
| What was painted before the view is erased | PASS | No magenta in any capture, at rest or mid-resize |
| Opaque elements painted after the view stay | PASS | The red square is solid |
| Rounded corners | PASS | 10 px, clipped by the visual |
| It moves and resizes with layout | PASS | `--layout-test`, 20 s: 10 layout steps, 10 buffer resizes, 0 errors, presents 57.3 a second, p95 17.07 ms |
| The present thread runs at the display's rate | PASS | 59.0 a second at 60 Hz, p95 17.02 ms (S0.1's line: ≤ 20) |
| GPUI redraws at most twice a second when idle | PASS | 0.05 a second |
| A drag by hand, judged by eye | Owed | A 30 s screen recording by the contributor |

A scripted resize also ran: `SetWindowPos` about every 16 ms for about
14 s (338 renders, 336 size changes, 330 buffer resizes). No capture
showed magenta, and the only black pixels were from the taskbar and an
NVIDIA overlay notice where the window grew past the screen. While the
window resized nonstop, presents fell to 52.5 a second with a p95 of
34.8 ms: each `ResizeBuffers` costs a frame. At rest they are back at the
display's rate.

## What it does not prove

One process, synthetic frames, one GPU: no backend, no composition surface
from another process, no 4K source, no floating window, no GPU time per
frame. Those are WC-0.5. It was run on one PC at one scale; the second
contributor's PC and the drag recording are still owed.
