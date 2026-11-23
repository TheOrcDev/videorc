# Linux preview transport spike (plan 257 S3), 2026-11-22/23

Scope: step 1 of slice S3 of `plans/257-linux-beta.md`. Measure today's Linux
Preview transport (BMP over HTTP, polled into an `<img>`) against (a) a
latest-frame transport into a canvas, (b) a WebCodecs H.264 preview leg and
(c) the composed program frame, then build the winner. Evidence (logs, every
run's `result.json`, the harness) is in `~/linux-beta/s3/` on ogre.

**Verdict: (a), without shared memory.** The winner is a latest-frame
request that **waits for the next frame** (`waitMs`), carries **I420** (BT.709
video range, 1.5 bytes a pixel) shrunk on the backend only by **whole box
factors**, runs as a **two-stage pipeline** per layer (one request waiting,
one frame decoding), and is drawn with **WebGL** (three planes, a BT.709
shader) into a canvas in the proof surface. Built as S3's product path and
measured on the production renderer: the real camera shows **30.0 of 30 fps**
(min 29.87 over 60 s) at **29 ms p50 / 37 ms p95** capture-to-page latency,
against **8.5 fps and 104 / 128 ms** for today's transport in the same build;
a moving 1080p card shows **30.0 of 30 fps** (min 29.86) at 8 / 27 ms. App
CPU with the camera on is **183 %**, against 204 % for today's transport at
S3's 30 fps surface rate and about 250-270 % on main (60 fps surface).

(b) is real but deferred (its encode is cheap, but it needs an encoder per
layer); (c) does not exist on Linux at idle. Details below.

## Host and method

| Item     | Value                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine  | ogre: i7-8750H (6c/12t), 15 GB, Arch/Omarchy Hyprland, lid closed                                                                                                                                                                                                                                                                                                                                        |
| Base     | `origin/main` `cf237fbe0` (S1 #1659 and S2 #1650 merged)                                                                                                                                                                                                                                                                                                                                                 |
| Backend  | `cargo build --release` (shipping profile)                                                                                                                                                                                                                                                                                                                                                               |
| Renderer | production bundle (`pnpm --filter @videorc/desktop build`, `electron-vite preview`) for the CPU numbers; the dev server for the variant sweeps (its React dev mode adds ~10 points)                                                                                                                                                                                                                      |
| Output   | the `videorc-lab` headless output, 1920x1080@30. The lid is closed, so eDP-1 is DPMS off and sends no frame callbacks: the harness moves the app's windows to the lab output's workspace, or the proof page gets no `requestAnimationFrame` at all                                                                                                                                                       |
| Preview  | floating window, 346 x 418 pt at scale 2, so the page asks for frames 942 px wide                                                                                                                                                                                                                                                                                                                        |
| Sources  | the FaceTime HD camera (1280x720 NV12 at 30 fps; the lid is closed, so the picture is dark but the frame rate is the camera's), and the dev fixture camera (`VIDEORC_FIXTURE_CAMERA`: a figure that moves every frame, drawn at 1920x1080 by the backend at 30 fps) as the moving card. The session was locked all night, so a screen capture would only have shown the lock screen                      |
| Load     | every run waited for load1 < 2 and no other Electron app before it started; the app under test then adds its own load. Other sessions built on ogre in between, which is why runs were gated                                                                                                                                                                                                             |
| Measures | **fps shown**: frames the proof page decoded and presented per second (difference of its counters over 10 s windows, 60 s per run). **Latency**: the frame's age when the backend sent it (`x-videorc-frame-age-ms`, from the capture store's `captured_at`) plus the time from response to present. **CPU**: `/proc` ticks over the 60 s of every process under the app (dev tooling excluded), by role |

The harness (`~/linux-beta/s3/spike.mjs`) launches the dev app with an
isolated profile, seeds a camera-only 1920x1080@30 scene, opens the Preview,
and reads `measure-native-preview-surface` and `/proc`.

## Results

### The built path, production renderer (the S3 evidence)

| Source                             | Transport                                          | fps shown (min over 10 s windows) | Latency p50 / p95 | App CPU   | Proof page | Main | Backend               | Camera FFmpeg | Chromium GPU, network, app page |
| ---------------------------------- | -------------------------------------------------- | --------------------------------- | ----------------- | --------- | ---------- | ---- | --------------------- | ------------- | ------------------------------- |
| Real camera, 720p30                | **S3 default (`wait-i420`, WebGL)**                | **29.98 (29.87)**                 | **29 / 37 ms**    | **183 %** | 59 %       | 21 % | 50 %                  | 28 %          | 26 %                            |
| Moving 1080p card (fixture camera) | **S3 default**                                     | **29.99 (29.86)**                 | **8 / 27 ms**     | **132 %** | 42 %       | 19 % | 49 % (draws the card) | –             | 22 %                            |
| Real camera, 720p30                | today's (`VIDEORC_PROOF_FRAME_TRANSPORT=interval`) | 8.54 (7.28)                       | 104 / 128 ms      | 204 %     | 96 %       | 34 % | 27 %                  | 29 %          | 19 %                            |

`~/linux-beta/s3/spike-f1-*.log`. Each run waited for load1 < 2 before it
started.

### Real camera (720p30), production renderer, last spike round

| Transport                                          | fps shown | Latency p50 / p95 | App CPU | Proof page | Main | Backend | Camera FFmpeg |
| -------------------------------------------------- | --------- | ----------------- | ------- | ---------- | ---- | ------- | ------------- |
| Today: BMP polled every 40 ms into an `<img>`      | 7.9       | 102 / 131 ms      | 210 %   | 100 %      | 35 % | 28 %    | 30 %          |
| I420, waits, two-stage, `createImageBitmap` canvas | 30.0      | 26 / 35 ms        | 209 %   | 77 %       | 24 % | 45 %    | 32 %          |
| I420, waits, two-stage, WebGL canvas               | 30.0      | 25 / 29 ms        | 194 %   | 70 %       | 23 % | 42 %    | 30 %          |

Today's row already has the S3 surface rate (30 fps, below). The same
transport at today's 60 fps surface cost 272 % on the dev renderer (238 % at
30), so today's shipping cost is about 250-270 %.

### Every variant (dev renderer)

| Variant                                                    | Source        | fps shown                | Latency p50 | App CPU |
| ---------------------------------------------------------- | ------------- | ------------------------ | ----------- | ------- |
| BMP, 40 ms interval, `<img>` (today)                       | 720p          | 7.2                      | 110 ms      | 272 %   |
| BMP, waits (long-poll), `<img>`                            | 1080p fixture | 8.8                      | 117 ms      | 267 %   |
| BMP, waits, `createImageBitmap`, pipelined without a bound | 1080p fixture | 22.0                     | 125 ms      | 398 %   |
| BGRA in a `VideoFrame`, waits, pipelined                   | 1080p fixture | 24.1                     | 71 ms       | 282 %   |
| BGRA `VideoFrame`, full size (no backend resize)           | 720p          | 26.9                     | 88 ms       | 280 %   |
| BGRA `VideoFrame`, full size                               | 1080p fixture | 17.4                     | 193 ms      | 238 %   |
| BMP bitmap, full size, unbounded pipeline                  | 1080p fixture | collapsed: 2.5 s backlog | –           | 679 %   |
| I420, waits, two-stage, bitmap canvas                      | 720p          | 30.0                     | 25 ms       | 223 %   |
| Preview closed, camera on                                  | 720p          | –                        | –           | 44 %    |
| Preview open, no frame requests                            | –             | –                        | –           | 93 %    |

### What each finding means

1. **The 40 ms timer was never the limit; the page was.** Waiting for the
   next frame instead of polling every 40 ms took the `<img>` path from 7.4 to
   8.8 fps only: decoding a 2 MB BMP into an `<img>` (and sampling it back for
   the blank check) held the proof page at one core.
2. **The backend's resize was the next limit.** With the request already
   waiting, frames left the backend 32 ms old: the plan 191 triangle resize
   costs 28 ms for a 720p frame on ogre (its 5 ms figure was another machine).
   Asked for the source's own width, the same frame left 4 ms old. The winner
   only box-averages whole factors, and only while the frame is wider than
   1.5x what the page shows (1280 stays 1280 for a 942-wide Preview; 1920
   halves to 960; a 2880 screen thirds to 960); the GPU scales the rest.
3. **Bytes through Chromium are the cost that stays.** A BGRA frame crosses
   the network service, the page and the GPU process: about 1.4 % of a core
   per MB/s across them (Chromium's GPU and network processes are zygote
   children on Linux, so the census counts them with the renderers). Full-size
   1080p BGRA (250 MB/s) fell to 17 fps. I420 cuts the bytes by 2.7x.
4. **A pipeline needs a bound.** Requesting the next frame before the current
   one is decoded doubled the rate, but without a bound a slow decode built a
   2.5 s backlog at 679 % CPU. Two stages (one waiting, one decoding) keep both
   the rate and the latency.
5. **WebGL beats `createImageBitmap` for I420**: the colour conversion moves to
   the GPU (15 points less CPU, p95 29 against 35 ms).
6. **The idle compositor ran at 60 Hz for nothing.** On Linux it composes no
   preview pixels (plan 0014), so its ticks are status only, and each one
   crossed main and the proof page: the Preview open with no frames cost 93 %
   against 44 % closed. Creating the surface at 30 fps on Linux saved 34 points
   on its own.
7. **The backend's conversion has to be written for the baseline CPU.** The
   first I420 converter (per-pixel calls with clamps, then a separate box
   pass dividing by a runtime value) held a 1080p source to 22-25 fps. Rewritten
   as row loops the compiler vectorises (the BT.709 video-range formulas need
   no clamp for 8-bit input), a fused 2x box for the common case, it costs 1.7
   ms a 720p frame and 1.6 ms a 1080p frame halved, cache-cold, on ogre's
   baseline x86-64 build (`~/linux-beta/s3/bench/`), byte-identical to
   `color.rs` (unit-tested).
8. **Building the metrics cost a tenth of a core.** Main asks the page for its
   metrics with every compositor tick; each answer sorted every latency
   sample. The Linux transport reuses one snapshot for 200 ms.

### (b) WebCodecs H.264 preview leg

Measured as components, realtime-paced for 20 s, on noisy content
(`testsrc2` + temporal noise), net of the source's own cost:

| Step                                                                                  | 720p30 | 1080p30 |
| ------------------------------------------------------------------------------------- | ------ | ------- |
| OpenH264 encode (ogre's encoder; VAAPI is pinned off and the AMD node quarantined)    | +11 %  | +22 %   |
| Intel VAAPI encode (the lab's safe node)                                              | ~0 %   | +12 %   |
| FFmpeg software H.264 decode, one thread (Chromium's decoder without hardware decode) | 5 %    | 7 %     |

The leg would cut the bytes through Chromium from 41 MB/s (I420 720p30) to
about 0.5 MB/s, so it could take another ~40 points off the proof page. It
was not built in S3. It needs an encoder per preview layer (camera and screen
each), keyframe and restart handling, an FFmpeg child lifecycle per layer,
and a WebCodecs decoder in the page, and it adds an encoder's frame of
latency. It is the follow-up if the Beta needs the Preview cheaper than the
winner (see "CPU budget").

### (c) The composed program frame

There is none on Linux at idle: the compositor composes CPU pixels only for
an encoder, because composing for the Preview cost about 7 of 12 logical CPUs
on an idle Linux Studio (plan 0014, `compositor.rs` `composes_cpu_pixels`).
The one program-shaped Preview that exists is the legacy FFmpeg MJPEG
fallback (`VIDEORC_NATIVE_PREVIEW_SURFACE=0`): 124 % app CPU, but at its own
size and rate, not the compositor's program, and Health already names it a
fallback. Ruled out.

## The watchdog (step 3), measured

With the camera live, this run's own backend was frozen (SIGSTOP) for 12 s
and then resumed (`~/linux-beta/s3/spike-stall-backend.log`):

| t after the freeze | Contract | What happened                                                                                                 |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| 1.7 s              | healing  | "Linux preview source frames have not advanced for 1653ms; … Restarting the frame requests (attempt 1 of 2)." |
| 4.6 s              | healing  | attempt 2 of 2                                                                                                |
| 7.6 s              | fallback | the last good frame stays; Health says "Stalled"                                                              |
| resume + 1 s       | met      | "Linux preview pixels are live.", 30 fps                                                                      |

A frozen camera FFmpeg child was caught within 2.2 s the same way; the
backend's own capture recovery replaced the child and the Preview came back.

## CPU budget

S3's "done when" asks idle app CPU with the camera on to drop by at least
half from "today's ~3 cores", so to about 150 %. The built path measures
**183 %** on the production renderer (camera FFmpeg 28 %, backend 50 %, main
21 %, proof page 59 %, Chromium GPU, network and the app's page 26 %): 39 %
under the plan's ~3 cores (measured before S2's camera fix), and 9 % under
today's transport in the same build, which shows a quarter of the frames. The
camera's FFmpeg child (28 %) and the closed-Preview floor (44 % with the
camera on) are not the Preview's to cut. What is left is mostly bytes: 41 MB/s
of I420 through Chromium's network service, the page and the GPU process.
The H.264 leg (b) is the measured way to take most of that out (an encode of
11 % at 720p against roughly 40 points of transport); it is not in S3.
