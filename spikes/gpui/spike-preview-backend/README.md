# spike-preview-backend (plan 260 S0.1, lane L1)

The macOS preview inside GPUI against the **real backend**: plan 220's
`videorc-preview` element (the S0.2h presenter: a `CAMetalLayer` presented on
its own thread from the backend's IOSurface ring, the latest-wins lease loop,
the first-frame and presenting watchdogs) hosted in a GPUI `NativeView`, with
`videorc-backend` from `main` composing the test pattern at a pinned 3840x2160
canvas at 60 fps. GPUI paints the scene editor's chrome over the video (a
selected item with eight handles and its label, a top scrim, a pill). A
floating Preview window takes the layer over (no surface restart) and is kept
out of screen capture (`NSWindowSharingNone`).

macOS only. It is its own Cargo workspace, outside the spikes workspace,
because it needs a `videorc-rust` checkout beside this repository
(`../../../../videorc-rust`, main `1e097e52c`; that repository is private).
S1.7 moves those crates into this repository; the spike then points at them.

## How it hosts the layer

- A layer-hosting `NSView` with a flipped root `CALayer` goes to
  `NativeView::new`; GPUI owns its frame, visibility and stacking.
- `PreviewElement::attach` gets that view's raw handle (not the window's), so
  the element adds its `CAMetalLayer` as a sublayer of it, unchanged.
- After attach the `CAMetalLayer` gets an autoresizing mask (it follows the
  view in the same Core Animation transaction GPUI moves the view in) and the
  slot's corner radius (a native view ignores GPUI clipping).
- A `canvas` painted over the slot calls `PreviewElement::place` with the
  slot's size each layout: drawable size and the surface's bounds record.
- No `cx.notify()` per frame: GPUI drew the window 0 to 69 times in 10 minutes
  of live video (window events only), against 36,000 video frames.

## Run it

```sh
# The backend: main's crate, with debug assertions (plan 212 S6's packaged
# backstop refuses test-pattern frames to the Preview otherwise) and no strip
# (this toolchain has no rust-objcopy). From a target cloned from a release
# build of the same source, only the backend crate recompiles (about 7 min).
CARGO_TARGET_DIR=~/projects/.targets/260-l1 CARGO_BUILD_JOBS=1 \
  node scripts/with-build-slot.mjs cargo build --release -p videorc-backend --bin videorc-backend \
  --config 'profile.release.package.videorc-backend.debug-assertions=true' \
  --config 'profile.release.package.videorc-backend.strip=false'

# The spike (gpui-pre 0.3.14, runtime_shaders: no Metal Toolchain needed).
cd spikes/gpui/spike-preview-backend
CARGO_TARGET_DIR=~/projects/.targets/260-l1 CARGO_BUILD_JOBS=1 cargo build --release

# One measured run: 600 s live with the overlay on, 60 s with it off, the
# A/B (cycles of overlay off/on, back to back), the still frame with the
# overlay off then on, the floating window, then the report.
./run-s0-1.sh <out-dir> --live 600 --live-compare 60 --still 60 --floating 60 [--ab 4]
python3 summarize.py <out-dir>     # summary.json (the spikes' field names) + verdict.md
```

`run-s0-1.sh` takes `~/videorc-app-run.lock`, refuses while
`~/Library/Application Support/Videorc/on-air.json` exists, uses a throwaway
profile, samples `ps` every 2 s for its own two PIDs only, and records the
load before and after. The spike stops the backend by its own PID at the end
(`stray pids []`).

## Result, 2026-11-23 (M4 MacBook Pro, 120 Hz panel, 2x)

Run 1, 23:15 to 23:31 CET, release builds, the window kept above other apps.
**The host was not quiet**: other plan 260 lanes were building and the owner
was using the Mac (load average mean 5.8, p95 8.8, max 11.8 over the run).

| Pass line (plan 260 S0.1) | Measured | Bar | |
| --- | --- | --- | --- |
| 4K60 for 10 min | 36,320 frames in 606.8 s (59.84/s); 1 skipped, 0 dropped, 0 refused | 10 min at 60/s | pass |
| Zero CPU copies | 3 IOSurface imports (one per ring slot), 36,317 cache hits; backend `framePipeline`: `gpuReadbacks 0`, `bgraBytesCopied 0` | 0 | pass |
| Present p95 | commit interval p50 16.72, **p95 18.65**, p99 21.14 ms; display (`presentedTime`) p50 16.67, p95 25.00 ms (the 120 Hz panel's reading on every route, plan 220 S0.2h) | ≤ 20 ms | pass |
| Still frame CPU | **0.011 %** of one core (surface suspended, last frame on the layer) | ≤ 3 % | pass |
| Live CPU | **7.71 %** of one core over 600 s, overlay on (getrusage, whole process); `ps` mean 7.7, p50 7.1, p95 11.3 %; overlay off, the next 60 s: 5.97 % | ≤ 10 % | pass |
| GPU per frame | p50 **0.52**, p95 1.47, p99 3.81 ms (`GPUEndTime - GPUStartTime`) | ≤ 2 ms | pass |
| Floating window out of capture | `sharingType` 0 read back; `screencapture -l <window>` wrote nothing; absent from the full-screen capture; present when shared read-only for one proof shot | out | pass |
| Editor overlay, idle | 0.011 → 0.012 % (**+0.001 points**) | ≤ 1 % | pass |

The overlay's live cost, run 2 (23:43 to 23:56 CET, load 2.6 to 5.4): four
back-to-back pairs of 60 s, overlay off then on, read 5.92/5.82, 6.54/6.79,
6.49/6.48 and 6.36/6.35 % (mean **6.33 % off, 6.36 % on**: +0.03 points).
Run 1's 7.71 % against 5.97 % was the host, not the overlay: GPUI drew the
window 69 times in that phase (window and pointer events while the owner used
the Mac) and `ps` shows one burst to 25 % at t = 308 s.

Also: lease held p50 1.2 ms; frameReady to commit p50 0.4 ms; first frame
0.19 s after process start (backend ready in 0.06 s); UI RSS 76 MB, backend
39 MB and 5.5 % CPU; floating window live 4.88 %, 59.96/s; docked again,
presenting at once.

Found on the way (for S2.3a): after `preview.surface.destroy` and a new
`create` (the smoke harness's suspend), `main`'s backend refuses leases until
a fresh scene commit; the element's watchdog heals it through its
resync-scene step in 4.6 to 5.2 s. The product route never suspends, but
the lease loop should re-commit the scene with the new surface instead of
waiting for the watchdog.
