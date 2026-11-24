# spike-hello (plan 260 WC-0.1, checked by S0.2a)

**Question:** does GPUI build and run on a Windows PC, and what does an
idle GPUI window cost there?

**Answer on one Windows PC (an Intel UHD 620 laptop): yes.** A clean
release build takes about 5½ minutes, and the window paints its first
frame about 260 ms after the process starts. The full numbers are under
"Reference result".

This is the frame the later Windows spikes (WC-0.2 to WC-0.5) start from.
It has nothing platform-specific, so it also builds and runs on macOS and
Linux.

## What it does

- Opens an 1100 × 640 window titled `spike-hello`: a 280 px sidebar and a
  content pane. That size fits a 1920 × 1080 display at 150 %.
- GPUI paints the pane a new colour once a second. That timer is the only
  thing that asks for a new frame, so `renders` is about one a second.
- Over the pane GPUI draws a translucent bordered box (an editor handle)
  and a translucent pill with text.
- The sidebar shows the render count, the seconds the window has been open,
  and the window's logical size and scale.
- Closes itself after `--seconds` and writes the summary.

## Run it

PowerShell, from a clone on the `spikes/gpui` branch (the Windows testing
plan's [one-time setup](../../../plans/260-gpui-rewrite-windows-testing.md#one-time-setup)
first):

```powershell
cd spikes\gpui
Measure-Command { cargo build --release -p spike-hello } | Select-Object TotalMinutes
cargo run --release -p spike-hello -- --seconds 20
```

Start it from the folder you want `summary.json` in. With `--out` the path
you give is printed in the summary's `args`, so don't pass one that
contains your user name in a summary you will post.

**Expected:**

- The pane changes colour once a second, and the box and pill stay drawn
  over it.
- The window resizes smoothly when you drag its edge, and the sidebar's
  size line follows.
- Text is sharp at 100 % and at your highest scale.
- The summary has `renders` above 0 and `"errors": 0`.

## Summary fields

These are added to the common fields in [SUMMARY.md](../SUMMARY.md):

- `renders` and `ui_redraws_per_second_idle`: about 1 a second, from the
  pane's timer, plus one render for each resize.
- `startup_to_first_paint_ms`: process start to the first frame (S0.9).
- `window_open_to_first_paint_ms`: `open_window` to the first frame.
- `scale_factor` and `scale_factors_seen`: two values in
  `scale_factors_seen` mean the window moved to a display with another
  scale.
- `viewport_px` and `viewport_device_px`: the content size at the end of
  the run, in logical and in device pixels.
- `viewport_changes`: resizes, maximises and moves between scales.

The spike reports an error if GPUI never renders or never paints.

## Reference result

A Windows 11 Pro 26H2 (build 26300) laptop: Intel Core i5-8365U (8
logical CPUs), Intel UHD 620 (driver 31.0.101.2135), 16 GB. Its display is
1920 × 1080 at 150 % and 60 Hz, and it was on AC power. Release build,
2026-11-23. The run file is [summary.example.json](summary.example.json).

| Number | Value |
| --- | --- |
| Clean release build | 5.4 min, crate downloads included; 0 warnings |
| `target` folder after it | 1.09 GB; `spike-hello.exe` 10 MB |
| GPUI renders | 22 in 20.2 s (1.09 a second) |
| Start to first frame | 395 ms on the first start; 258 to 265 ms on four warm starts (S0.9) |
| `open_window` to first frame | 263 ms on the first start; 119 to 127 ms warm |
| Process CPU, whole run | 1.1 % of one core |
| Peak memory | 58 MB |
| Content | 1100 × 640 logical, 1650 × 960 device px at 1.5 |

The window was resized five times through `SetWindowPos`, then maximised
and restored, in a 15 s run. The result was `viewport_changes` 7, no
errors, and the layout followed each size. A script can't judge whether a
drag by hand is smooth; that is the testing plan's check by eye.

## What it does not prove

It has no native view, no video, no backend, no shared texture and no
second display. It was not tested on a discrete GPU or at 100 % scale on
this PC. Those are WC-0.2 to WC-0.5 and the second contributor's PC.
