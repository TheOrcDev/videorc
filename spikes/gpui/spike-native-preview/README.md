# spike-native-preview (plan 260 S0.0, the model spike)

**Question:** can a GPUI window host Videorc's preview as a native video
layer that presents on its own thread, so GPUI does not redraw per video
frame, with GPUI's UI drawn over the video?

**Answer on macOS: yes** (plan 260, "Spike S0.0"). Read this spike as the
model for the others: one folder, one question, the shared arguments and
`summary.json` from [`spike-summary`](../spike-summary/), a README with
the exact commands and a reference result.

## What it does

- Opens a 1650 × 962 window (smaller screens clamp it) titled
  `spike-native-preview`: a 280 px sidebar and a content pane.
- **macOS:** the pane is an `NSView` hosting a `CAMetalLayer`, placed in
  GPUI's layout with `gpui::NativeView`. A plain thread (`presenter`)
  waits for each drawable, clears it to a colour that cycles over time and
  presents it, as `videorc-preview`'s presenter thread does. It keeps the
  drawable at the pane's pixel size.
- **Windows and Linux:** GPUI has no native view there yet (WC-0.2 adds
  one on Windows; S0.3 is Linux), so GPUI itself paints the pane a new
  colour once a second. Same window, overlays, arguments and summary: this
  build is where WC-0.1's `spike-hello` starts.
- Over the video GPUI draws a translucent bordered box (an editor handle)
  and a translucent pill with text. The sidebar counts GPUI's renders.
- Closes itself after `--seconds` and writes the summary.

## Run it

```sh
cd spikes/gpui
cargo build --release -p spike-native-preview
cargo run --release -p spike-native-preview -- --seconds 40
```

Don't cover or move the window during a timed run.

**Expected on macOS:** the colour under the box and pill keeps changing
smoothly; the sidebar's "GPUI renders so far" stays at a small number
(about 3) for the whole run; the summary has `"native_view": true`,
`presents_per_second` near the display's refresh rate, and `"errors": 0`.

**Expected on Windows and Linux:** the pane changes colour once a second,
the box and pill draw over it, the window resizes smoothly when you drag
its edge; the summary has `"native_view": false`, `renders` about one per
second, and `"errors": 0`.

## Summary fields

The common fields ([SUMMARY.md](../SUMMARY.md)), plus `renders`,
`ui_redraws_per_second_idle`, `startup_to_first_paint_ms`, `native_view`,
and on macOS `presents`, `presents_per_second`, `present_interval_p95_ms`,
`drawable_px` and `cpu_copies_per_frame` (0: the presenter clears GPU
textures; nothing is copied through the CPU).

## Reference result

The owner's M4 MacBook Pro (10 logical CPUs, 120 Hz built-in display),
2026-11-23, release build, window unoccluded, other agents building:
[summary.example.json](summary.example.json).

| Number | Value |
| --- | --- |
| Video presents | 4,781 in 40.4 s (118.5 a second) |
| Present interval p95 | 8.62 ms |
| GPUI renders | 3 in the whole run (0.07 a second) |
| Start to first frame | 156 ms |
| Process CPU, whole run | 8.3 % of one core |
| Peak memory | 75 MB |
| Drawable | 2368 × 1600 px |

Plan 260's first run (S0.0, the same code before it moved here) gave
4,678 presents in 40.3 s and 2 renders. The CPU figure is for clear-only
frames and is not comparable to S0.1's lines; S0.1 measures the real
presenter with the backend's frames.

## What it does not prove

No IOSurface import, no backend, no 4K source, no resize or drag test, no
floating window. Those are S0.1 (macOS) and WC-0.2 to WC-0.5 (Windows).
