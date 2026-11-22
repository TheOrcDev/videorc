# Plan 258 S0: person segmentation spike (2026-11-22)

Plan 258 (background effects without a green screen), slice S0: measure Apple
Vision person segmentation and the MediaPipe selfie model on real hardware
before anything is built. These numbers set the budgets for S3 (macOS stage)
and S8/S9 (browser processor for rooms and guests).

- **Hardware:** the owner's MacBook Pro, Apple M4 (10 cores, 32 GB), macOS
  26.5.1, built-in camera (720p and 1080p at 30 fps). No Intel Mac was
  available.
- **Browsers:** Chrome 157.0.8103.80 and the repo's Electron 39.8.10
  (Chromium 142), `@mediapipe/tasks-vision` 1.2.0, ANGLE Metal on both.
- **Evidence (outside the repo, owner footage):**
  `~/cloud-test/reports/2026-11-22-plan-258/S0/` (`README.md` there has the
  method, every table and the edge sheets).
- **Harness:** `pnpm probe:person-segmentation live|clip --out-dir DIR`
  (Swift probe `scripts/person-segmentation/seg-probe.swift`), and in
  `scripts/person-segmentation/`: `bench-run.mjs` + `bench.html` (MediaPipe in
  Chrome or Electron), `analyze-mattes.mjs` (scores against a ground truth
  matte), `edge-sheet.mjs` (by-eye crops).

## Method in one paragraph

Vision timing came from the live camera: one stateful request on its own
queue, pipelined as plan 258 D2 draws it (20 s per run). The camera showed an
empty room (00:40), so quality used 60 s of the owner's own 1080p Camera ISO
file from 2026-11-11: hands at the face and waving, a black T-shirt, a mic on
an arm, in front of a green screen. It ran three ways: as recorded, keyed
over the bundled dark `podcast.webp` studio (a black shirt in a dark,
textured room: the hard case), and that composite darkened with sensor noise
(low light). The green-screen key is the ground truth. Every engine was
scored for IoU, edge error, flicker and **background leak**: the share of the
real background that the matte keeps as "person", which the effect would then
show sharp. Timing runs used a load gate (1-minute load ≤ 10) because other
sessions were compiling; each run records its load.

## Answers to S0's "done when"

1. **macOS quality level: `.balanced`**, on the Neural Engine (what `auto`
   picks), one stateful request per camera, every frame at 30 fps and every
   other frame at 60 fps, with the EMA S3 plans. `.fast` is not safe to ship.
   In low light it showed more than 5 % of the room sharp in 118 of 1800
   frames (worst 12 %) and blurred away the lower face. `.balanced` never
   passed 2.5 % in any frame of any clip.
2. **Matte input: the full camera buffer, no downscale stage.** A 512 px
   VideoToolbox copy first saved nothing (21.0 vs 21.3 ms at 1080p), and 4K
   input costs 1.6 ms more than 1080p. The matte comes back 512x384 (always
   4:3, stretched over the frame) and `OneComponent16Half` costs the same as
   8-bit, so S3 can keep the plan's 16-bit half matte and drop the "≈512 px
   IOSurface" step from the architecture.
3. **4K holds for segmentation:** `.balanced` 21.8 ms p50 / 26.5 ms p95 at 4K
   input, against 20.2 / 22.6 at 1080p. The 4K composite is S3's to measure.
4. **Intel: not measured** (no Intel Mac here). Recommendation: don't fall
   back to `.fast`, because it is the level that leaks in low light. Offer
   the effect on Intel only after S3 measures `.balanced` on one, with at
   least 15 mattes a second. Otherwise show it as unavailable on that Mac.

## Vision numbers (built-in camera, quiet)

| Level       | Matte     | 1080p p50 / p95 | 720p / 4K p95 (clip, paced) | Matte Hz at 30 fps | Probe CPU (1 core) |
| ----------- | --------- | --------------- | --------------------------- | ------------------ | ------------------ |
| `.fast`     | 256x192   | 6.6 / 8.0 ms    | 7.6 / 10.0 ms               | 29.9               | 19 %               |
| `.balanced` | 512x384   | 21.3 / 25.1 ms  | 22.9 / 26.5 ms              | 29.9               | 50 %               |
| `.accurate` | 2016x1512 | 59.1 / 68.8 ms  | not run                     | 14.2               | 38 %               |

- Neural Engine vs others (forced): `.balanced` ANE 21.4 ms, GPU 44.8 ms,
  CPU 67.8 ms; `.fast` 6.6 / 17.0 / 20.3 ms. The ANE path held its time with
  the Mac at 100 % CPU (load 44–60): `.fast` 6.1 / 7.8 ms, `.balanced`
  21.9 / 23.9 ms.
- Latency: the camera itself delivers frames 46–50 ms after their timestamp.
  The matte adds its `perform` time (no queueing): timestamp → matte p95 is
  56 ms with `.fast` and 73 ms with `.balanced`. The newest matte is at most
  19 ms old (p95) when a `.balanced` frame arrives.
- The first request after a level hasn't run for a while takes 0.7–1.4 s
  (model load); warm, it takes 34–58 ms. D6's startup cover must cover that
  first second.
- "Probe CPU" is the whole probe process including capture. `.balanced` costs
  about 30 % of a core more than `.fast` on the CPU side even though
  inference is on the ANE.

## MediaPipe numbers (room clip at 1x, quiet)

Both browsers kept 30.0 Hz with no missed frames, at 720p and 1080p, on GPU
and on CPU.

| Path                                | Chrome p50 / p95 | Electron p50 / p95 |
| ----------------------------------- | ---------------- | ------------------ |
| GPU delegate, mask read back, 720p  | 9.6 / 13.9 ms    | 8.2 / 11.9 ms      |
| GPU delegate, mask read back, 1080p | 10.4 / 13.7 ms   | 8.0 / 11.4 ms      |
| CPU (WASM), 1080p                   | 10.0 / 14.6 ms   | 9.5 / 11.2 ms      |

- GPU with `gl.finish()` and no readback measures 1.5 ms, but that is not the
  GPU cost: `finish()` does not wait for MediaPipe's work in Chrome's GPU
  process (the same run with a 147 KB readback costs 8–10 ms). S8's in-pass
  composite will land between the two.
- First GPU call 150–190 ms (shader compile), init 100–150 ms. During the
  night's busiest hour (load ~50) the first call took 4.8 s, and the browser
  presented only 21–23 frames a second.
- **WebGPU was not measured:** tasks-vision 1.2.0 has only CPU and GPU
  (WebGL2) delegates.

## Quality (IoU, flicker, background leak: mean / p99 frame / worst frame)

| Clip         | Vision `.fast`                   | Vision `.balanced`               | MediaPipe selfie landscape       |
| ------------ | -------------------------------- | -------------------------------- | -------------------------------- |
| Green screen | 0.974, 1.04, 0.00 / 0.00 / 0.6 % | 0.982, 1.34, 0.01 / 0.02 / 6.8 % | 0.985, 0.79, 0.00 / 0.01 / 0.2 % |
| Dark room    | 0.974, 1.76, 0.07 / 1.3 / 4.4 %  | 0.990, 0.90, 0.01 / 0.05 / 2.0 % | 0.902, 4.11, 2.6 / 13.2 / 16.3 % |
| Low light    | 0.947, 3.12, 1.3 / 11.2 / 12.1 % | 0.983, 3.71, 0.02 / 0.38 / 2.5 % | 0.887, 11.5, 1.9 / 7.9 / 11.9 %  |

- `.accurate` matched `.balanced` (room IoU 0.990, slightly tighter edges) at
  3x the cost: not worth it.
- An EMA of 0.5 cut flicker 2.5–4x for every engine (`.balanced` room 0.90 →
  0.33, MediaPipe 4.11 → 1.13) for about +0.01 edge error. It does not cure a
  leak.
- MediaPipe's square model leaks more (dark room p99 14.8 %). The 16 MB
  multiclass model does better (IoU 0.954, leak p99 4.5 %) but is still well
  short of Vision.
- The green-screen worst frames for `.balanced` (6.8 %, 5.0 %) are
  motion-blurred fingers whose gaps stay "person" for a frame or two.
- **The mic.** Vision treats a desk mic in front of the chest (and its arm) as
  background, while MediaPipe keeps it. With Vision a streamer's mic will be
  blurred in Blur and disappear in Cut out. The scores above leave the mic area
  out.

## What misses the plan, and what that means

- **"≤ 6 ms p95 per matte" (macOS, Apple silicon) is missed:** `.balanced` is
  22.6–26.5 ms p95, and even `.fast` is 7.7–10.0 ms. Suggested budget:
  `.balanced` ≤ 28 ms p95 on the Neural Engine, on its own queue, which still
  gives a fresh matte for every frame at 30 fps and every other frame at
  60 fps. Under the ≤ 1 frame latency budget at 30 fps, S3 can hold each frame
  for its own matte (about 25 ms) rather than drawing with the previous one.
  A previous-frame matte trails a moving hand, which shows the room.
- **"≤ 10 ms tasks-vision GPU at 720p" (browser):** p50 met (8.2–9.6 ms), p95
  missed (11.9–13.9 ms) counting the readback. Timing is fine for 30 Hz.
- **Browser quality is the real gap.** The selfie model shows sharp patches of
  a dark room in over 5 % of the background in 211 of 1800 frames. As it
  stands, S8/S9 can't honestly say "your real background never leaves your
  computer". S8 should use this harness's leak metric as a gate (dark-room
  and low-light leak p99 ≤ 1 %) and try the multiclass model, a matte biased
  toward background, a joint-bilateral refine and the EMA before it ships.
- **Not covered:** Intel, WebGPU, a browser on the real camera (Electron's dev
  binary has no camera grant; a Chrome camera prompt at night was avoided),
  a real 4K camera (4K input was the decoder-scaled clip), and the plan's
  owner-recorded clip with a mug, standing up and real low light. The
  composite's cost is S3's.

## Re-running

```sh
pnpm probe:person-segmentation live --out-dir ~/cloud-test/reports/<date>/seg --quiet-load 10
pnpm probe:person-segmentation clip --out-dir … --in clip.mp4 --sizes 1280x720,1920x1080,3840x2160 --pace realtime
node scripts/person-segmentation/bench-run.mjs --browser chrome --out-dir … --tv-dir <tasks-vision>/package \
  --models-dir … --clips-dir … --runs "name:clip.mp4:selfie_segmenter_landscape:GPU:realtime:readback:small"
node scripts/person-segmentation/analyze-mattes.mjs --gt gt-480.gray --ignore "…" name=mattes.gray:WxH
```

The terminal needs the Camera permission for `live`. Keep evidence out of
`/tmp` (the runner refuses it).
