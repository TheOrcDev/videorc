# spike-linux-preview (plan 260 S0.3)

**Question:** can Videorc's Linux preview, the backend's CPU frames in the
shared-memory ring, show inside a GPUI window *below* GPUI's own drawing
(editor handles, labels, popups), at the camera's rate, within S0.1's CPU
lines, under Wayland and under X11?

**Answer on ogre (Hyprland 0.56.2), 2026-11-23:**

- **Wayland: yes.** A `wl_subsurface` placed *below* GPUI's `wl_surface`,
  fed by `wl_shm` buffers over the ring, shows through a transparent hole
  in GPUI's surface. GPUI's translucent box, handles, pill and popup blend
  over the video. 30.0 and 59.97 frames a second reach the screen
  (`wp_presentation`), interval p95 16.9 ms at 60 fps. The app uses 1.3 to
  3.8 % of one core live and 0.06 % still, **at 800 MHz**. GPUI draws
  nothing per video frame.
- **X11: yes, with a second window.** A child window always stacks over
  its parent's own drawing, so the X11 child (MIT-SHM over the ring)
  covers whatever GPUI draws in the slot
  ([shot](#screenshots)). Drawing GPUI's overlay in a second,
  override-redirect, transparent GPUI window over the slot (the
  `--overlay-window` mode) puts GPUI back on top of the video, translucency
  included: 30.0 and 60.0 frames a second, 1.8 to 2.5 % live and 0.9 to
  1.0 % still. No GPUI patch.
- **Route (d), frames as a GPUI image:** works on both and needs no
  window-system code, but redraws the window per frame: 25 to 69 % of one
  core at 800 MHz. It misses the 10 % live line; it is the fallback, not
  the route.

No GPUI patch was needed for any route (D1's patch count stays at zero
for Linux).

## What it does

- A 1650 × 1000 window: a 240 px sidebar, a toolbar, and the preview slot
  (inset 16 px, contain-fit 16:9). GPUI paints the pane around the slot and
  leaves the slot itself transparent (`WindowBackgroundAppearance::Transparent`;
  GPUI's wgpu surface is premultiplied-alpha and sets no opaque region).
- Over the slot GPUI draws an editor selection (a translucent box with
  four handles), a label pill, and a popup panel that crosses the slot's
  right edge.
- The frames come from a writer process (the same binary, `--writer`)
  that writes a moving 1920 × 1080 BGRA pattern (a drifting hue, a white
  bar moving 8 px a frame, the frame number in binary blocks) into a
  `videorc-preview-ring` (copied in `ring/` from `videorc-rust` at
  `2c96c499`, plan 220 S4.1d) at `--fps`. It stands in for the backend's
  CPU preview, which writes the same ring.
- `src/presenter.rs` is plan 220's Linux presenter (`videorc-rust`
  `crates/videorc-preview/src/linux.rs`, S4.2c) with two options added:
  `below` (`wl_subsurface.place_below(parent)`) and `presentation`
  (`wp_presentation` feedback per commit). The reader thread leases the
  latest frame, hands the slot to the presenter, and keeps the lease until
  the server gives the buffer back.
- Phases: warm-up 3 s, **live** (`--seconds`, frames flowing), **still**
  (`--still`, the writer pauses, the last frame stays), **resize**
  (`--resize`, the window stepped between 1650 × 1000 and 1280 × 800 every
  100 ms).

## Run it

```sh
cd spikes/gpui
cargo build --release -p spike-linux-preview
# Wayland (the subsurface below GPUI)
cargo run --release -p spike-linux-preview -- --fps 60 --seconds 60 --still 20 --resize 5 --presentation
# X11 (or XWayland: unset WAYLAND_DISPLAY), with GPUI's overlay window
WAYLAND_DISPLAY= cargo run --release -p spike-linux-preview -- --fps 30 --seconds 60 --overlay-window
# Route (d)
cargo run --release -p spike-linux-preview -- --route image --fps 30 --seconds 60
```

Flags: `--fps`, `--resolution WxH`, `--seconds` (live), `--still`,
`--resize`, `--presentation`, `--above` (the subsurface over GPUI, as the
Slint spike had it), `--no-overlay`, `--overlay-window` (X11),
`--route native|image`, `--compositor-pid PID` (repeatable: their CPU per
phase), `--out`. The summary (`summary.json`) uses SUMMARY.md's names; the
spike's full per-phase report is under `linux`.

`ogre/` holds the scripts that produced the numbers: `nested-hyprland.lua`
(a nested Hyprland with its own Xwayland), `run.sh` (one run, two
screenshots with `grim`, the busiest core's clock every 2 s) and
`matrix.sh`.

## How it was measured, and what that means

- **The owner's session was locked** (the lab output's screenshot shows
  "Enter Password"), so the spike ran inside a **nested Hyprland 0.56.2**
  (same build as the session), sized 1920 × 1080 at 60 Hz on a temporary
  headless output of the owner's Hyprland (`s03-test`, removed after the
  runs; the lab output and the laptop panel were not used). The nested
  compositor composites, presents (`wp_presentation` timestamps are its
  own output's) and runs its own Xwayland, so the screenshots are real
  compositions, but no physical display was involved.
- **X11 is XWayland** (Omarchy ships no X11 session), as in plan 220
  S4.2b. A real X server needs a compositing manager for the overlay
  window's translucency; without one an ARGB override-redirect window
  shows black where it is transparent.
- **Clocks: 800 MHz on every core** for the whole matrix (ogre's T2
  firmware PROCHOT after the GPUI compile; `run.sh` logged the busiest
  core every 2 s). CPU percentages are of one core at a fifth of the box's
  normal clock: read them as an upper bound.
- **Frames are synthetic** (the writer, 4.6 % of a core at 30 fps and
  9.5 % at 60 fps at 800 MHz). The backend's own cost of composing them on
  the CPU (plan 220 S4.2b: 190 to 230 % of a core at 4 GHz) is unchanged
  by the UI framework and is not part of this question.

## The numbers

1920 × 1080 frames; 60 s live, 20 s still, 5 s resize; 800 MHz. "On
screen" is the nested compositor's `wp_presentation` (`--presentation`
runs); otherwise the presenter's commit or the server's `ShmCompletion`.

| Run | Frames shown /s | Interval p95 (ms) | Age at present p50 / p95 (ms) | UI live, % of one core | UI still | GPUI redraws /s live | Compositor live |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wayland, subsurface below, 30 fps | 30.0 (on screen) | 33.7 | 7.1 / 7.4 | 1.30 (1.98 with feedback) | 0.06 | 0 | Hyprland 9.8 % |
| Wayland, subsurface below, 60 fps | 60.0 (on screen 59.97) | 16.9 | 21.6 / 29.9 | 2.44 (3.67 with feedback) | 0.06 | 0 | Hyprland 18.2 % |
| Wayland, 30 fps, no overlay | 30.0 | 33.5 | — | 1.29 | 0.06 | 0 | Hyprland 9.6 % |
| X11 child window, 30 fps | 30.0 | 33.5 | — | 1.42 | 0.57 | 0 | Xwayland 7.8 %, Hyprland 4.2 % |
| X11 child window, 60 fps | 60.0 | 16.8 | — | 2.27 | 0.57 | 0 | Xwayland 16.0 %, Hyprland 7.7 % |
| X11 child + overlay window, 30 fps | 30.0 | 33.5 | — | 1.80 | 0.90 | 0 | Xwayland 7.8 %, Hyprland 4.3 % |
| X11 child + overlay window, 60 fps | 60.0 | 16.8 | — | 2.48 | 0.99 | 0 | Xwayland 16.2 %, Hyprland 7.2 % |
| Route (d), Wayland, 30 fps | 30.0 | 33.6 | — | 34.4 | 0.04 | 30 | Hyprland 4.4 % |
| Route (d), Wayland, 60 fps | 59.8 | 17.1 | — | 68.8 | 0.04 | 58 | Hyprland 8.2 % |
| Route (d), X11, 30 fps | 30.0 | 33.6 | — | 25.0 | 0.52 | 30 | Xwayland 1.5 %, Hyprland 4.3 % |
| Route (d), X11, 60 fps | 60.0 | 17.0 | — | 51.0 | 0.52 | 60 | Xwayland 2.9 %, Hyprland 7.5 % |

- **Resize** (50 steps in 5 s): the native routes keep the frame rate
  (29.9 and 59.8 on screen) while GPUI redraws once per step; the app
  reads 9.5 to 11.6 % on Wayland and 7 to 21 % on X11 with the overlay
  window (two windows re-laid out per step). Route (d) reads 38 to 74 %.
- **Memory:** 84 MB RSS on the native routes, 147 MB on route (d).
- **Copies:** the app copies no pixels on the native routes; the
  compositor uploads each `wl_shm` / MIT-SHM frame (one copy, outside the
  app). Route (d) copies the frame out of the ring and GPUI uploads it to
  its atlas (two). A zero-copy route needs the backend to export dma-bufs,
  which the Linux backend (a CPU compositor) does not.
- Leases were held 2.6 to 2.8 ms p95 on the native routes; no frame was
  skipped or dropped by the ring in any run.

Against S0.1's lines (on the native routes): present p95 ≤ 20 ms passes at
60 fps (16.8 to 16.9; at 30 fps the interval is the source's 33.3 ms
period); still ≤ 3 % passes (0.06 Wayland, 0.57 to 0.99 X11); live ≤ 10 %
passes with room even at 800 MHz (1.3 to 3.8 %); the overlay's idle cost
≤ 1 % passes (0.00 on Wayland, +0.3 to 0.4 points on X11 for the second
window); zero CPU copies holds in the app but not in the compositor (see
Copies); ≤ 2 ms GPU per frame was not measured (the compositor's GPU time
is not visible to the app).

## Screenshots

Taken with `grim` on the nested compositor's output (1920 × 1080), 8 s
into the live phase. Not committed (raw evidence stays out of the repo):
`~/linux-beta/plan260-s0-3/shots/` on ogre.

- `final-wl-native-30-live-a.png`: Wayland, the subsurface below GPUI;
  GPUI's selection, handles, pill and popup over the video.
- `x11-native-30-live-a.png`: X11, the child window covers GPUI's overlay.
- `x11-native-30-overlaywin-live-a.png`: X11 with the overlay window: GPUI
  over the video again.
- `wl-image-30-live-a.png`: route (d).

## What it does not prove

- A physical screen, tearing by eye, a drag of the window by hand (the
  session was locked; the nested compositor's presentation is real but
  its output is headless).
- A real X server and a non-compositing X session; GNOME and KDE (plan
  260: a Phase 4 gate on the second Tier 1 box).
- The backend's own frames (the writer stands in), and 4K.
- The overlay window's input: the spike gives it an empty input shape, so
  clicks reach the main window; the product would set the shape to the
  overlay's hit regions. It follows the main window's ConfigureNotify (the
  resize phase exercised it; a drag was not tested).
- GPU time per frame.

## Notes for the GPUI app (S2.3c)

- `gpui-pre-platform` needs its `wayland` and `x11` features on Linux;
  without them GPUI falls back to its headless platform silently (no
  window handle, no window). The workspace turns them on.
- GPUI exposes the raw handles (`HasWindowHandle` / `HasDisplayHandle` on
  `Window`); call them as trait methods, since `Window::window_handle()`
  is also an inherent method returning GPUI's own handle.
- The presenter joins GPUI's `wl_display` from its own thread
  (`Backend::from_foreign_display`, its own event queue), as it joined
  winit's under Slint.
- GPUI has no API to move a window, and ignores a size set from outside:
  the X11 overlay window is sized with `Window::resize` and moved by the
  spike's own X connection.
- A cold release build of GPUI on ogre (`-j3`) took about 20 minutes
  and the target 5 GB.
