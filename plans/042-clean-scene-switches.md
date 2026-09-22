# Plan 042: Clean scene switches and black unavailable-source output

Status: IMPLEMENTED — merge readiness blocked by broader verification failures.
Priority: P1. Planned 2026-09-22 against `15206746`.

Implementation rebased on current main `ddcdab71` to include the layout editor
and vertical simulcast changes. The original worktree's unrelated work is intact.

## Implementation and verification

- CPU and Metal now compose opaque black for unavailable sources and missing
  takeover images. Empty production scenes stay black. Explicit TestPattern
  sources still animate. Metal clears RGB to zero (which converts to Y=16),
  matching CPU video-range black.
- Scene revision adoption refreshes capture bindings immediately with try-locks.
  A contended new binding retries next frame. Per-output source identity checks
  prevent a previous device from supplying the newly selected source; existing
  generation invalidation and recovery acknowledgements remain active.
- The opt-in 320 ms animation and saved preferences are unchanged.
- Added deterministic composition/adoption regressions plus
  `pnpm smoke:scene-switch-pixels`, now included in the recording-studio gate.
  The fixture exercises four camera-only / missing-screen / ready-screen /
  screen-only cycles, alternating capture identities, animated geometry, and
  simultaneous landscape recording and portrait stream stores on CPU and Metal.
  Its stream uses an explicitly ready loopback TCP receiver, not a public
  broadcast. Production RTMP/session behavior remains covered by app smokes.
- All 480 decoded frames matched their compositor references. Maximum per-frame
  mean sample error was 0.07/255; recording A/V duration skew was 0 ms and received
  stream skew was 21 ms. The received MPEG-TS is remuxed without transcoding to
  index exact AAC sample durations before A/V analysis; original TS is retained.
- Passed: complete Rust package tests (2,254 passed, 9 ignored across targets),
  Clippy with warnings denied, Rust format, 1,410 Node tests, desktop tests
  (1,792 passed, 1 skipped), typecheck, lint, format check, desktop build.
- Recording-studio passed the new pixel gate, caption transport and record/stream
  artifacts, noise cleanup, all-layout artifacts, blocked-finalization app quit,
  and enforced record latency. Warm recording start p50/p95: 60/80 ms;
  stop-to-idle p50/p95: 83/100 ms. Live layout recording/streaming, imported images,
  real native launch, scene commits, pump diagnostics, focus/click continuity,
  comment overlays, placement/docking, reattachment, real ScreenCaptureKit
  recording, and Notes invisibility also passed.
- The full recording-studio command is **not green**: continuous-resize stress
  reported one presenter IOSurface import failure. An unchanged focused retry
  passed. Running the subsequent stages individually exposed a lifecycle probe
  failure at reopen cycle 52 (`frame polling did not resume`). These are recorded
  as unresolved validation findings, not assumed to be pre-existing failures.
  A second lifecycle attempt failed after more than 70 cycles with `Main window
is not ready for preview motion smoke` (last generation 74).
- Device extension invoked with `VIDEORC_RECORDING_STUDIO_SKIP_APP_SMOKE=1`
  to avoid repeating the standard app stages above: real camera/screen preview
  interaction and its 59.8-second recording passed; real ScreenCaptureKit layout
  changes during recording and simultaneous recording/streaming passed. The
  source-complete native layout-stress gate failed with 11 CPU-fallback frames
  (its final MP4 nevertheless passed quality analysis). This is not a complete
  green device gate. An unchanged focused retry failed with 2 CPU-fallback frames.
  These runs used the dev app; packaged real-camera validation remains outstanding.
- Recording matrix: all 11 standard profiles and 4K30 hard-content passed.
  1080p60 hard-content failed at 53.83 observed fps (324 versus about 361 expected
  frames) and a 2.62-second keyframe interval. 4K30 transient FIFO pressure and
  1080p30 shared recording/stream FIFO pressure passed. Overall: 14/15 cases passed.
- Shadscan baseline/floor: 41 using `pnpm dlx @shadscan/cli@next --json` from
  `apps/desktop`. Commit requires a fresh score of at least 41; the final score
  is recorded with the PR handoff.

Generated media and local diagnostic logs remain outside the committed tree.

## Requested behavior

Switching scenes must never put diagnostic colors into preview, recordings, or
streams. If screen/window capture cannot supply a usable frame, its destination
region must be opaque black. Healthy camera and overlay layers continue rendering.
An unavailable full-screen source produces black across its content region.

The user explicitly confirmed: keep the existing scene animation and remove only
the yellow flash. Preserve the animation setting, saved preference, duration,
easing, and camera motion. Removing animation is outside this fix's scope.

## Evidence

The supplied local MP4 is 1920x1080, 30 fps, H.264, BT.709/video range, with 208
decoded frames. Frame-by-frame inspection finds the orange border and moving
diagonal at zero-based frames 33, 34, and 170: 1.100, 1.133, and 5.667 seconds.
The first flash lasts two frames (about 67 ms); the second lasts one (about 33 ms).
Both occur when returning from camera-only to screen plus camera.

Two independent decoding passes returned the same affected frames. The replay
check decoded to 320x180 RGB and counted pixels with R > 220, 115 < G < 190,
B < 40; these frames each contained over 11,000 matching pixels, with a 2,000
pixel threshold. This is a detector for this supplied clip, not a general rule
that orange user content is invalid. Do not commit this private recording or
extracted images as fixtures.

Confirmed cause of the colored pixels:

- `compositor.rs::missing_source_placeholder_bgra` builds a 16x9 animated
  diagnostic image with an orange border/diagonal for Screen and Window sources
  (BGRA `[0, 160, 255, 255]`, RGB `#ffa000`) and a dark interior. Its appearance
  matches the recording exactly.
- The GPU screen/window branch calls that helper whenever `inputs.screen_frame`
  is absent. There is no recording/stream exclusion. Missing cameras use magenta;
  missing imported screen images also use the orange helper.
- The CPU renderer has a separate problem: no scene/snapshot, or zero rendered
  sources without a background, can invoke `render_synthetic_yuv420p_frame`.
  Fixing only the GPU orange color would leave another production test pattern.
- Existing missing-source Metal tests assert transport/size, not black pixels.

Capture lifecycle evidence from this session's local backend log:

- At 09:35:50.633 UTC the previous window capture generation 11 was stopped.
- At 09:35:51.018 generation 12 started; at 09:35:51.264 it was reused.
- The same stop/start cycle continues through generations 13, 14, 15, and 16.
- The session uses the VideoToolbox encoder consumer. The compositor's output is
  upstream of encoding, so a recording-only export correction is insufficient.

Strongly supported explanation for the short missing-frame window:

1. `live_layout.rs::retire_unused_sources_after_commit` stops screen capture
   immediately after committing a scene that does not need it.
2. Switching back starts capture and `wait_for_sources_ready` waits for backend
   source readiness before committing the new scene.
3. The compositor refreshes its scene snapshot every render tick in
   `publish_compositor_frame`, but refreshes its source handles only every 250 ms
   in `run_synthetic_compositor_loop`.
4. Consequently, a new ready scene can be rendered with an old/absent source
   handle until the next source refresh. Identity/generation changes also clear
   the cached screen frame, correctly preventing cross-source reuse.

The logs do not record per-frame adoption versus scene revision. The added
deterministic regression reproduces the readiness/adoption gap and passes after
the fix; the exact scheduling of the three original frames is not reconstructible
from those logs. The orange-placeholder cause itself is confirmed.

The camera resizing seen in the clip is separate, intentional scene motion:
`use-studio.tsx` requests a 320 ms transition when `animateSceneChanges` is true.
The default setting is already false. `next_scene_transition(None, ...)` can
preserve an active transition; `Some(0)` explicitly cancels it.

## Implementation order

### 1. Enforce black missing-source pixels

First add pixel-level regressions at the real CPU/GPU composition seams, then
replace production diagnostic placeholders with opaque black. Preserve layer
ordering, camera masks, source transforms, captions, and highlight overlays.
Use consistent black in both GPU and CPU output (video-range YUV black is
Y=16, U=128, V=128). A black source must cover its destination; merely skipping
the layer can reveal a background or another source underneath it.

Cover missing screen/window, missing/stale camera, missing imported screen
image, and entirely unavailable production scenes. Retain deliberately selected
TestPattern scenes and explicit synthetic diagnostic runs; distinguish those
from a production scene with no usable source rather than relying on emptiness.
Keep missing-source state visible in diagnostics, never burned into program
pixels. Black output must not count as live source evidence or satisfy startup
readiness. Preserve valid static screen frames regardless of their age.

Acceptance: real source pixels or opaque black, never automatic orange, magenta,
or synthetic motion. GPU and CPU paths agree, including when a custom scene
background is selected.

### 2. Align scene adoption with source adoption

Add a deterministic regression that creates the actual scheduling window:
the compositor has adopted camera-only/no screen; a new screen generation has
its first frame; a scene commit arrives before the 250 ms refresh deadline.
Drive the production publish/adoption seam and inspect its resulting pixels.
Also cover lock contention, different source identity, rapid A→B→A selection,
and a superseded late source start. Use controlled events/clock boundaries,
not timing sleeps as the proof.

Make scene/source changes explicitly invalidate source bindings before the first
render of the new revision. Bind the selected identity and generation to the
rendered scene; ideally hand the compositor a consistent ready snapshot/lease.
At minimum, refresh and validate required bindings at scene adoption rather than
waiting for the periodic maintenance refresh. If the selected binding is not
available, render black for that source until it is. Never render the previously
selected window in the newly selected window's slot.

Keep the render thread bounded: do not wait for native capture startup or add
unbounded blocking locks. Preserve capture recovery adoption acknowledgements,
generation ownership, health epochs, startup barriers, and latest-intent rules.
Exercise primary, stream auxiliary, and simulcast snapshots where applicable.
Do not globally shorten the poll timer as the sole fix.

Acceptance: when a target frame is already ready, the first rendered target
scene uses it; genuinely missing capture uses black. Existing failed-selection
and warm-up timeout behavior remains explicit, with no accidental false success.

Keeping unused screen capture warm may reduce restart latency, but is optional
follow-up work with resource/privacy implications. It is not necessary to remove
these flashes and must not substitute for correct handoff and fallback behavior.

### 3. Preserve animated scene behavior

Keep the existing 320 ms opt-in transition and its mid-transition re-anchoring.
Do not force `transitionMs: 0`, migrate user preferences, or remove the Animate
scene changes setting. Apply the black-output and source-adoption guarantees
while the screen and camera transforms are moving, including rapid selections
that supersede an unfinished transition. Also cover animation disabled so the
same missing-source behavior holds for existing cut-mode users.

Regression: supplying a delayed screen frame changes only its pixels from black
to captured content; it neither restarts the transition nor jumps camera geometry.

### 4. Verify encoded artifacts and the live output path

Extend the maintained all-layout/scene-commit smoke coverage with rapid
camera-only ↔ screen+camera ↔ screen-only changes. Include a controlled delayed
first frame, a unavailable-source interval, a static screen, and a different
window selection. Use known fixture colors/markers and assert frame content and
source identity, not just successful RPCs, file size, or absence of crashes.

Inspect every frame around switches in the finished recording and in a locally
captured stream output. Include simultaneous recording/streaming and a stream
leg with a distinct canvas if available. No public broadcast is required.
Verify frame cadence and final-artifact A/V sync remain healthy. Exercise
normal Metal output and the CPU fallback separately; do not report a skipped
Metal test as passing visual evidence.

Required implementation gates:

- Focused compositor/live-layout/preview-screen tests, then
  `cargo test -p videorc-backend`, `cargo fmt --check --all`, and
  `cargo clippy -p videorc-backend -- -D warnings`.
- `pnpm test:scripts`; desktop unit tests, typecheck, lint, and format checks
  when changing renderer transition requests or shared contracts.
- `pnpm smoke:recording-studio` and `pnpm smoke:recording-studio:devices` on a
  permissioned macOS host. Include real ScreenCaptureKit window/display capture
  and a packaged real-camera run matching the user's scene sequence.
- Add `pnpm probe:preview-lifecycle` if presenter/window lifecycle changes;
  `pnpm smoke:record-latency` if startup/finalization/barriers change; and
  `pnpm smoke:recording-matrix` if encoding/color/fps handling changes.

## Original investigation boundary

This pass decoded the supplied artifact, inspected local session logs, and traced
current source. It did not alter application code, change user settings, start
capture, or broadcast. Source regression tests and device smokes belong to the
implementation above and have not been run as evidence of a fix.
