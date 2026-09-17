# Plan 041: Eliminate macOS 4K screen-and-camera recording source decay

> **Executor instructions**: This is the incident overlay for the August 2026
> macOS recording-lag investigation. Follow the steps in order and execute only
> one behavior-changing candidate at a time. Run every verification command and
> confirm the expected result before moving on. Do not credit a candidate from
> code inspection alone: the terminal acceptance is three real-device clips on
> the owner's normally launched installed app. If a STOP condition occurs, stop
> and report; do not improvise or weaken a threshold.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat 92f91493..HEAD -- \
>   crates/videorc-backend/src/compositor.rs \
>   crates/videorc-backend/src/diagnostics.rs \
>   crates/videorc-backend/src/encoder_bridge.rs \
>   crates/videorc-backend/src/frame_store.rs \
>   crates/videorc-backend/src/metal_compositor.rs \
>   crates/videorc-backend/src/preview_camera.rs \
>   crates/videorc-backend/src/preview_screen.rs \
>   crates/videorc-backend/src/protocol.rs \
>   crates/videorc-backend/src/recording.rs \
>   apps/desktop/src/shared/backend.ts \
>   apps/desktop/src/shared/backend-rpc-contract.ts \
>   apps/desktop/src/shared/backend-rpc-contract.test.ts \
>   scripts/analyze-recording.mjs \
>   scripts/lib/recording-analyzer.mjs \
>   scripts/lib/recording-analyzer.test.mjs \
>   scripts/lib/real-source-evidence-gates.mjs \
>   scripts/lib/real-source-evidence-gates.test.mjs \
>   scripts/smoke-recording-session-decay.mjs \
>   package.json
> ```
>
> If an in-scope file changed, compare the live code with the excerpts below.
> A semantic mismatch is a STOP condition until this plan is rebased.

## Status

- **Status**: BLOCKED (2026-08-25; automated oracle, lifecycle, capture,
  retention, and Metal slices pass, but the permissioned ScreenCaptureKit gate
  repeatedly captured only the animated desktop wallpaper and could not see a
  maintained motion-stimulus window; the required 3+3 owner-device clips remain
  unaccepted under the mandatory STOP rule)
- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none; this plan blocks and partially supersedes Plan 034
- **Category**: bug, perf, tests
- **Planned at**: commit `92f91493`, 2026-08-24

## Why this matters

Long 3840x2160@30 screen-and-camera recordings can become slideshows while
audio, the compositor, and the encoder continue at nominal cadence. A measured
89.5-second failure delivered the camera at 6.5 fps and re-served held camera
frames 2,034 times; another failure let the screen age for 4.1 seconds while
the encoder still accepted 2,635 fresh compositor outputs. The defect damages
the primary recording artifact and the native preview simultaneously, so it is
a release blocker, not a cosmetic preview issue.

This plan separates settled facts from hypotheses, supplies a fail-closed test
oracle, and changes one resource owner at a time. It is deliberately not a
blind revert of recent PRs.

## Incident contract

### Settled facts

- The failure is upstream of the compositor and encoder. Final accounting from
  the installed 0.9.73 build shows capture producers falling to 0.8-12.9 fps
  for screen or about 6.5 fps for camera while the compositor remains near
  30 fps and the encoder reports no material drops.
- The artifact and native preview go stale together. This rules out MP4 export,
  mux timestamps, and preview presentation as the primary owner.
- Short clips can pass; the known collapse window starts around 10-15 seconds.
  Synthetic capture and real-screen-only capture have not reproduced it. The
  shipping shape that does reproduce is real ScreenCaptureKit + real
  AVFoundation camera, normally Cam Link 4K, at a 4K30 output canvas.
- The owner machine now has signed 0.9.74 installed. Its preview/device suite
  reached the real-screen gate, but no terminal >60-second 4K30 clip was
  accepted, so 0.9.74 still lacks the required owner-device validation.
- A wedged Shure/CoreAudio device contaminated one investigation run. Reboot
  and replug before every cold validation batch; do not interpret a run with a
  broken microphone as recording-video evidence.

### Corrected hypothesis ranking

| Candidate                      | What the code proves                                                                                                                                                                                                                       | Incident confidence                                       | Required decision                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Capture-producer starvation    | Per-source accounting directly observes it while compositor/encoder stay healthy.                                                                                                                                                          | HIGH                                                      | Treat as the fault domain.                                                                    |
| 0.9.74 / #279 encoder teardown | 0.9.73 already dropped `retired_active` at the same post-muxer boundary, and its `Drop` already signalled and joined the bridge. 0.9.74 adds bounded detach, counters, and warnings; it does not move the stop edge earlier.               | LOW-MED as root; HIGH as useful containment/observability | Validate unchanged, but do not declare the lifecycle theory proven.                           |
| CVMetal texture-cache pressure | Every real capture source is re-imported every compositor tick, even for held frames; the persistent cache is never flushed. CoreVideo requires periodic cache housekeeping.                                                               | MED as root; HIGH that the defect exists                  | Instrument, correct ownership/flush/reuse, then owner A/B.                                    |
| Full-canvas 4K BGRA camera     | #242 (`b79028be`, shipped in 0.9.65) changed inset screen-camera capture from a 1280x720 floor to the full 3840x2160 canvas. Zero-copy preference chooses BGRA when advertised, about 995 MB/s at 4K30 before the screen source.           | MED as root; HIGH as a stress multiplier                  | Run a bounded 1080p acquisition A/B only if the cache correction does not close the incident. |
| Fallback idle-preview race     | Terminal Idle is published before async fallback-preview restart completes. A new recording can observe no installed child, then the stale restart can install FFmpeg capture afterward. Native CAMetalLayer normally bypasses this route. | LOW-MED and conditional                                   | Cancel by generation; require fallback-path log evidence before attribution.                  |
| #259 startup cadence           | Bounded startup checks finish before the sustained session and leave no worker.                                                                                                                                                            | LOW                                                       | Bisect only after the two resource candidates.                                                |
| #262 shared macOS changes      | macOS changes are counters/accounting; Windows media changes are cfg-gated.                                                                                                                                                                | LOW                                                       | Late controlled A/B only.                                                                     |
| #267                           | Runtime behavior is Windows-only.                                                                                                                                                                                                          | RULED OUT on macOS                                        | Do not bisect it.                                                                             |

## Current state

### 1. 0.9.74 is containment, not a demonstrated root-cause fix

At `crates/videorc-backend/src/recording.rs:2694-2721`, the new writer fence
waits two seconds, warns, and then starts anyway:

```rust
while crate::encoder_bridge::live_synthetic_writers() > 0
    && Instant::now() < fence_deadline
{
    tokio::time::sleep(Duration::from_millis(50)).await;
}
if lingering > 0 {
    // emits encoder-bridge-writer-lingering, then continues
}
```

This check is also late: the recording compositor has already started around
`recording.rs:2385-2423` and FFmpeg has spawned around `:2627-2639`.

At `crates/videorc-backend/src/recording.rs:5459-5498`, 0.9.74 replaces the
old direct drop with a three-second bounded reap and detaches on timeout. Its
parent already had:

```rust
#[cfg(not(target_os = "windows"))]
drop(retired_active);

// caption/export/preview awaits follow
```

The parent `EncoderBridgeRecordingSession::drop` already set `stop=true` and
joined the outer writer. Therefore an observed writer with `stop=false` must be
identified by session and ownership path before teardown is changed again.

Current `stop_and_reap` (`encoder_bridge.rs:738-758`) watches only the outer
thread. The outer thread can in turn spend time in VideoToolbox completion and
a nested FIFO writer; the global live counter (`:1310-1337`) tracks only the
outer writer. Two bridges are reaped sequentially. These limitations make the
new warning valuable evidence, not proof that every encoder resource is gone.

There is also a conditional fallback-preview race in this orchestrator.
`monitor_session` publishes terminal Idle around `recording.rs:6004-6007` and
then awaits `restart_idle_live_preview_if_desired`. That restart performs
several awaits before installing its child around `:4363-4370`, with no final
recording/generation check. A new recording can stop "no child" while restart
is in flight, after which the stale FFmpeg screen/camera preview is installed
concurrently. Production native CAMetalLayer preview normally bypasses this
RPC, so log evidence must show the fallback route before it is blamed.

### 2. The capture workload was inflated in 0.9.65

`crates/videorc-backend/src/preview_camera.rs:1607-1620` currently returns the
full output dimensions for every layout:

```rust
fn camera_capture_target_dimensions(
    _layout: &LayoutSettings,
    video: &VideoSettings,
) -> (u32, u32) {
    (video.width, video.height)
}
```

Those dimensions drive AVFoundation selection at `preview_camera.rs:2412-2435`.
At `:2286-2305`, the output prefers the zero-copy format and sets
`alwaysDiscardsLateVideoFrames(true)`. The zero-copy preference chooses BGRA
when the device advertises it. A 3840x2160 BGRA source is 31.6 MiB per frame,
about 995 MB/s at 30 fps, even though the camera is a small inset.

The `didDrop` delegate at `preview_camera.rs:2170-2183` increments one aggregate
counter and discards the CoreMedia reason. Apple exposes `FrameWasLate`,
`OutOfBuffers`, and `Discontinuity`; those distinguish callback overload from
retained-buffer pressure and device discontinuity.

### 3. The CoreVideo-to-Metal import violates two lifecycle contracts

`crates/videorc-backend/src/metal_compositor.rs:542-547` caches only an
`MTLTexture`. `import_pixel_buffer_texture` at `:1406-1431` creates and retains
a `CVMetalTexture`, obtains its Metal texture, then drops the `CVMetalTexture`
wrapper on return:

```rust
let cv_texture = unsafe { CFRetained::from_raw(NonNull::new(cv_texture)?) };
CVMetalTextureGetTexture(&cv_texture)
```

CoreVideo's API contract says clients must retain the `CVMetalTexture` until
they are done using the image. The current command buffer is not even committed
until `metal_compositor.rs:889`; the wrapper has already gone out of scope.

The persistent `CVMetalTextureCache` is created once at
`metal_compositor.rs:733-755`. It exposes no flush call. The installed binding's
generated CoreVideo documentation says `CVMetalTextureCache::flush` must be
called periodically for internal housekeeping/recycling. The compositor has a
safe bounded point immediately after `waitUntilCompleted()` at `:890`.

Finally, `compositor.rs:3099-3105` and `:3189-3195` give dynamic camera and
screen sources `content_key: None`. `ensure_source_texture` imports before it
checks any reuse key, so a held frame is imported again on every 30 fps
compositor tick. Combined screen+camera therefore creates about 600-900 import
views in the observed 10-15 second failure window; screen-only creates half as
many and synthetic capture creates none.

Authoritative API references:

- [CoreVideo CVMetalTexture cache creation and lifetime](https://developer.apple.com/documentation/corevideo/cvmetaltexturecachecreatetexturefromimage%28_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A%29?changes=_3_2&language=objc)
- [AVFoundation dropped-frame delegate](https://developer.apple.com/documentation/avfoundation/avcapturevideodataoutputsamplebufferdelegate/captureoutput%28_%3Adiddrop%3Afrom%3A%29)
- [Apple TN2445: diagnosing dropped video frames](https://developer.apple.com/library/archive/technotes/tn2445/_index.html)

### 4. Existing diagnostics undercount zero-copy retention

`crates/videorc-backend/src/frame_store.rs:171` lets a `StoredFrame` own a
retained IOSurface and CVPixelBuffer. Any external `FrameHandle` clone keeps
that backing alive. `FrameStore::stats` at `:433` counts only the CPU `Vec` and
spare buffers. A zero-copy 4K frame can therefore retain about 31.6 MiB while
diagnostics report zero source bytes. The existing retention test around
`:539` intentionally keeps external handles while the stats still report one
store-owned buffer; it is the right place to extend coverage.

ScreenCaptureKit has a related visibility gap: `preview_screen.rs:3165-3168`
imports `SCFrameStatus` but `sample_buffer_is_complete` always returns `true`.
Incomplete/idle/blank/suspended statuses are not classified.

### 5. The decay smoke can pass the known failure

`scripts/smoke-recording-session-decay.mjs` defaults to 15-second clips and
1080p. With real sources it demotes artifact motion evidence to warnings. Its
source verdict requires only `held > fresh`; a 60-second run with five seconds
of frozen content still has about 1,650 fresh versus 150 held frames and passes.
Missing freshness fields also skip the verdict. The bridge repeat denominator
uses `encoded + repeated` instead of authoritative bridge input
`fresh + repeated + synthetic`.

The script is defined as `pnpm smoke:session-decay` but is absent from
`smoke:local-gates`. The analyzer computes ordered frame hashes but does not
publish the overall unique-frame ratio, even though the incident's useful
oracle is 277 unique frames out of 1,014 (27.3%).

## Commands you will need

Do not run the full Rust test suite for this incident. The owner's environment
has a known deterministic-test resource problem; use the focused filters below.

| Purpose                   | Command                                                                                                                                        | Expected on success                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Installed version         | `plutil -extract CFBundleShortVersionString raw /Applications/Videorc.app/Contents/Info.plist`                                                 | exactly the candidate version being tested                                         |
| Analyzer tests            | `node --test scripts/lib/recording-analyzer.test.mjs scripts/lib/session-decay-gates.test.mjs scripts/lib/real-source-evidence-gates.test.mjs` | all tests pass                                                                     |
| Analyzer CLI              | `pnpm analyze:recording -- /absolute/path/to/clip.mp4 --fps 30 --expect-audio --min-unique-frame-ratio 0.95`                                   | exit 0 and JSON/Markdown reports written                                           |
| Existing teardown tests   | `cargo test -p videorc-backend stop_and_reap`                                                                                                  | two tests pass                                                                     |
| Lifecycle slice           | `cargo test -p videorc-backend encoder_bridge_lifecycle`                                                                                       | all matching tests pass                                                            |
| Capture diagnostics slice | `cargo test -p videorc-backend capture_drop_reason`                                                                                            | all matching tests pass                                                            |
| Frame retention slice     | `cargo test -p videorc-backend surface_backing_lifecycle`                                                                                      | all matching tests pass                                                            |
| Metal cache slice         | `cargo test -p videorc-backend metal_source_texture_cache`                                                                                     | all matching tests pass on macOS                                                   |
| Camera profile slice      | `cargo test -p videorc-backend camera_capture_target`                                                                                          | all matching tests pass                                                            |
| Rust format               | `cargo fmt --check --all`                                                                                                                      | exit 0                                                                             |
| Rust lint                 | `cargo clippy -p videorc-backend -- -D warnings`                                                                                               | exit 0                                                                             |
| TypeScript                | `pnpm typecheck`                                                                                                                               | exit 0                                                                             |
| Desktop unit tests        | `pnpm --filter @videorc/desktop test`                                                                                                          | all pass                                                                           |
| Node logic tests          | `pnpm test:scripts`                                                                                                                            | all pass                                                                           |
| Synthetic session decay   | `pnpm smoke:session-decay:gate`                                                                                                                | three identical sessions pass; every post-stop live-writer count is zero           |
| Recording studio          | `pnpm smoke:recording-studio`                                                                                                                  | pass                                                                               |
| Preview lifecycle         | `pnpm probe:preview-lifecycle`                                                                                                                 | pass; no stale fallback child survives a generation change                         |
| Hard-content profiles     | `pnpm smoke:recording-matrix`                                                                                                                  | all shipping profiles and hard-content passes succeed                              |
| Permissioned devices      | `pnpm smoke:recording-studio:devices`                                                                                                          | pass on the granted owner Mac, or remain explicitly blocked until owner acceptance |

## Scope

**In scope** (modify only files needed by the active step):

- `crates/videorc-backend/src/encoder_bridge.rs`
- `crates/videorc-backend/src/recording.rs`
- `crates/videorc-backend/src/bin/native_preview_host_helper.rs`
- `crates/videorc-backend/src/capture_interruption.rs`
- `crates/videorc-backend/src/frame_store.rs`
- `crates/videorc-backend/src/preview_camera.rs`
- `crates/videorc-backend/src/preview_screen.rs`
- `crates/videorc-backend/src/compositor.rs`
- `crates/videorc-backend/src/metal_compositor.rs`
- `crates/videorc-backend/src/diagnostics.rs`
- `crates/videorc-backend/src/protocol.rs`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/backend-rpc-contract.test.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/smoke-command-security.ts`
- `apps/desktop/src/main/smoke-command-security.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/studio-provider.integration.test.ts`
- `scripts/analyze-recording.mjs`
- `scripts/lib/recording-analyzer.mjs`
- `scripts/lib/recording-analyzer.test.mjs`
- `scripts/lib/session-decay-gates.mjs` (create)
- `scripts/lib/session-decay-gates.test.mjs` (create)
- `scripts/lib/screen-motion-stimulus.mjs`
- `scripts/lib/screen-motion-stimulus.test.mjs`
- `scripts/lib/real-source-evidence-gates.mjs`
- `scripts/lib/real-source-evidence-gates.test.mjs`
- `scripts/smoke-recording-session-decay.mjs`
- `scripts/real-source-baseline-app.mjs`
- `package.json`
- `docs/acceptance/2026-08-24-macos-recording-source-decay.md` (create)
- `plans/041-eliminate-macos-recording-source-decay.md`
- `plans/034-4k-pipeline-headroom.md`
- `plans/README.md`

**Out of scope**:

- Windows media behavior. Preserve protocol parity, compile parity, and the
  existing Windows shutdown ordering; do not use this incident to redesign it.
- Plan 034's async GPU completion, compositor timer, and 4K encoder-quality
  slices. They can obscure the producer diagnosis and remain blocked until this
  plan closes.
- Audio graph or sync work, except recording the CoreAudio confound in evidence.
- FFmpeg mux/export changes; the measured fault is before those layers.
- Raising ScreenCaptureKit queue depth without evidence. One extra 4K BGRA slot
  costs about 31.6 MiB and can worsen pool pressure.
- Committing recordings, generated reports, support bundles, process samples,
  secrets, or app data.
- `vmmap`, broad process scans, or process cleanup by pattern. Resolve only
  Videorc-owned PIDs from Diagnostics/owned-process records; `sample` is allowed
  for one explicit backend PID during a live failure.

## Git workflow

- Branch: `codex/041-macos-recording-source-decay`
- Make one commit per completed step. Match repository style, for example:
  `test(recording): make session-decay evidence fail closed` and
  `fix(macos): recycle held CVMetal capture textures safely`.
- Never combine the camera-resolution A/B with the texture-cache candidate.
- Do not push or open a PR unless the operator explicitly asks.
- Stage only this plan's files; the worktree may contain owner changes.

## Decision flow

```text
Unmodified 0.9.74, 3 x >60s owner clips
  ├─ all pass, no lifecycle warnings
  │    └─ close user-visible regression only after Steps 1-4 guards land;
  │       do not claim the old teardown story was proven
  └─ any failure
       ├─ previous writer live/detached -> Branch L (complete lifecycle owner)
       ├─ backing/cache growth or out-of-buffers -> Step 4 cache fix
       ├─ camera late / 4K BGRA pressure -> Branch C camera-cap A/B
       ├─ SCK callback/status gap -> Branch S SCK investigation
       └─ none of the above -> Branch B controlled historical A/B
```

## Steps

### Step 0: Establish an untouched 0.9.74 owner baseline

This is an operator/device step. Do it before any new media-path code change.

1. Install the 0.9.74 candidate and verify the bundle version with the command
   above. If it prints 0.9.73, stop; no 0.9.74 conclusion is valid.
2. Reboot the Mac, power-cycle/replug the camera/capture card and Shure device,
   and verify all three sources are live before recording.
3. Launch Videorc normally with Finder or LaunchServices. Do not shell-spawn the
   bundle executable directly; that loses the TCC responsibility needed for
   real camera capture on this machine.
4. In one app/backend generation, record three consecutive 3840x2160@30
   screen+camera clips of 65-75 seconds each. Keep obvious continuous motion on
   the captured screen and in the camera frame. Wait for each finalization to
   finish, but do not quit or restart the app between clips.
5. After each clip, record its absolute path and run the analyzer. Do not edit
   the media. Query both `session_logs` and `health_events` for:
   `recording-frame-accounting`, `encoder-bridge-writer-leaked`, and
   `encoder-bridge-writer-lingering`.

   ```sh
   sqlite3 -readonly -json \
     '/Users/orcdev/Library/Application Support/Videorc/videorc.sqlite3' \
     "SELECT 'session_log' AS source, session_id, code, message, created_at
        FROM session_logs
       WHERE code IN ('recording-frame-accounting',
                      'encoder-bridge-writer-leaked',
                      'encoder-bridge-writer-lingering')
      UNION ALL
      SELECT 'health_event', session_id, code, message, created_at
        FROM health_events
       WHERE code IN ('recording-frame-accounting',
                      'encoder-bridge-writer-leaked',
                      'encoder-bridge-writer-lingering')
      ORDER BY created_at DESC
      LIMIT 40;"
   ```

6. If a clip visibly decays, resolve the explicit Videorc backend PID from the
   app's Diagnostics/owned-process record and take one ten-second `sample` while
   the failure is active. Do not use `pgrep`, `vmmap`, or pattern-based cleanup.

Acceptance for **each** clip:

- duration at least 60 seconds; observed FPS within 5% of 30;
- screen and camera capture/fresh rates at least 28 fps while the motion
  stimulus is active;
- `fresh / (fresh + held) >= 0.90` for both requested sources and maximum served
  age no greater than 200 ms;
- decoded unique-frame ratio at least 0.95 and no corroborated freeze longer
  than 400 ms;
- bridge input coverage at least 95% of expected frames, repeat share no more
  than 5%, and no encoder errors;
- no writer leaked/lingering event, and the next session never overlaps a
  previous writer.

**Decision**:

- Three passes: record the result, then continue through Steps 1-4 because the
  existing oracle and CoreVideo contracts are still defective. Do not execute
  Branch C/B/S.
- Any failure: preserve the reports and sample outside Git, then continue to
  Steps 1-4. If a writer warning occurs, do not start another recording; use
  Branch L after Step 2.

**Verify**: the acceptance document contains one row per clip, the exact
candidate SHA/version, cold-start state, source identities (names only; no
secrets), final accounting, analyzer verdict, lifecycle event verdict, and a
PASS/FAIL. Expected: three rows and no unclassified result.

### Step 1: Make the artifact and freshness oracle fail closed

1. In `recording-analyzer.mjs`, compute:

   ```text
   uniqueFrameCount = count(distinct decoded framemd5 hashes)
   uniqueFrameRatio = uniqueFrameCount / observed frame hashes
   ```

   Add `minUniqueFrameRatio` as an opt-in gate and render both values in JSON and
   Markdown. Add CLI option `--min-unique-frame-ratio`; do not change unrelated
   analyzer defaults.

2. Extract the source/bridge verdict from the monolithic decay smoke into
   `scripts/lib/session-decay-gates.mjs`. It must reject missing, non-finite,
   negative, or under-covered counters rather than skipping them.
3. For every requested real source, require:
   - counter coverage at least 90% of elapsed target ticks;
   - fresh rate at least `targetFps - 2`;
   - freshness ratio at least 0.90;
   - served-age maximum at most 200 ms.
4. Use bridge input `fresh + repeated + synthetic` as the denominator. Require
   at least 95% expected input coverage and no more than 5% repeats/synthetic.
5. Add unit fixtures for:
   - healthy 30 fps / >=90% fresh data;
   - the incident's camera `570 fresh / 2034 held`;
   - the incident's screen `1590 fresh / 1014 held` with a 4097 ms age;
   - a 16 fps source where fresh still exceeds held;
   - one five-second stall in an otherwise healthy 60-second clip;
   - missing counters and zero/short coverage;
   - the 277/1014 unique-frame incident artifact.
6. Make real-device mode default to at least 65 seconds. Keep the required CI
   smoke short and synthetic: add `smoke:session-decay:gate` for three identical
   sessions in one backend generation and include that script in
   `smoke:local-gates`. The synthetic gate proves cross-session lifecycle only;
   its output must explicitly say that it does not prove real-device freshness.
7. Listen for `session.log` and `health.event` on the existing backend WebSocket.
   Treat missing final accounting or any writer leak/lingering event as a hard
   failure. Do not rely solely on a best-effort `diagnostics.stats` snapshot
   taken before stop.

**Verify**:

```sh
node --test scripts/lib/recording-analyzer.test.mjs \
  scripts/lib/session-decay-gates.test.mjs \
  scripts/lib/real-source-evidence-gates.test.mjs
pnpm smoke:session-decay:gate
```

Expected: all fixtures pass their stated verdicts; the gate completes three
sessions and fails if final evidence is missing.

### Step 2: Make writer admission and ownership truthful

This step is containment and attribution. Do not redesign VideoToolbox teardown
without a positive lifecycle finding.

1. Replace `LIVE_SYNTHETIC_WRITERS` with a session-scoped writer registry. Give
   every recording and stream bridge a stable writer ID, session ID, output
   role, and lifecycle transitions:
   `started -> stop-signalled -> outer-exited -> fifo-exited/resource-released`,
   plus `detached` on deadline expiry. Track both outer and nested FIFO writers;
   never report zero while capture-relevant child resources remain live.
2. Emit bounded `encoder-bridge-writer-lifecycle` session-log entries on state
   transitions. Include final live outer/FIFO/resource counts and teardown
   duration in `recording-frame-accounting`. Do not log paths, tokens, or frame
   payloads.
3. Move the previous-writer admission check before recording compositor,
   capture-resource, native-audio, and FFmpeg startup. Wait a bounded grace;
   if any previous-session writer/resource remains, fail the new session start
   with an actionable recovery message. Never warn and continue.
4. Signal all bridges first, then apply one shared absolute teardown deadline;
   do not give two bridges independent sequential deadlines. Return a structured
   report rather than a boolean. Preserve and publish terminal/drain failures
   learned during reaping; current macOS code snapshots them before shutdown.
5. Correct comments that state #279 proved the old writer survived caption/export
   awaits. The historical parent disproves that claim.
6. Give fallback idle-preview starts a generation/cancellation token. Recheck
   both the generation and `state.recording` immediately before child spawn and
   immediately before installation. Stop and reap a child produced by a stale
   request. Preserve the native CAMetalLayer production path.
7. Add deterministic tests for explicit stop, unsolicited muxer exit, two
   bridges, cooperative outer/FIFO exit, detached child, pre-start refusal, and
   terminal failure discovered during final drain. Add the race where a new
   recording begins between fallback-preview snapshot and child installation.

Do **not** call `VTCompressionSessionInvalidate` cross-thread or promise forced
in-process recovery unless authoritative API evidence and a regression test
prove that ownership safe. The safe immediate behavior for an unreaped writer
is to refuse another capture and recover by restarting the owned backend.

**Verify**:

```sh
cargo test -p videorc-backend encoder_bridge_lifecycle
cargo test -p videorc-backend stop_and_reap
cargo fmt --check --all
cargo clippy -p videorc-backend -- -D warnings
pnpm probe:preview-lifecycle
```

Expected: all focused tests pass; a deliberately hung child leaves a nonzero
registry count and makes start admission fail.

### Step 3: Expose capture and surface-pool pressure

1. In the AVFoundation `didDrop` callback, read
   `kCMSampleBufferAttachmentKey_DroppedFrameReason` and count at least:
   `FrameWasLate`, `OutOfBuffers`, `Discontinuity`, and `Unknown`. Keep the
   callback O(1) and allocation-free after initialization.
2. Replace ScreenCaptureKit's always-true `sample_buffer_is_complete` stub with
   attachment parsing. Count every observed `SCFrameStatus`; admit only statuses
   that are valid current image content. Preserve static-screen semantics: a
   complete old frame remains valid when SCK emits no new frame.
3. Add surface-backed frame lifecycle accounting. Assign each published
   `StoredFrame` a monotonic storage identity. Increment live/estimated-byte
   counters when a retained IOSurface/CVPixelBuffer frame is created and
   decrement only when the final `Arc<StoredFrame>` drops, including handles
   outside the store. Report current, peak, and oldest live backing by source.
   Rename or document existing byte counters as CPU-buffer-only.
4. Add final accounting for camera sample-PTS maximum gap, screen callback
   maximum gap, selected camera native/output dimensions and pixel format,
   source drop reasons/statuses, Metal import/reuse/flush/failure counts, and
   surface-backed live/peak counts.
5. Preserve every Rust/TypeScript protocol mirror and contract fixture.

**Verify**:

```sh
cargo test -p videorc-backend capture_drop_reason
cargo test -p videorc-backend surface_backing_lifecycle
pnpm typecheck
pnpm --filter @videorc/desktop test
```

Expected: reason/status decoders classify every fixture; replacing the latest
frame while external handles exist keeps live backing visible, and dropping the
last handle returns counts/bytes to baseline.

### Step 4: Correct CVMetal ownership, housekeeping, and held-frame reuse

This is the first capture-path behavior change. Land it separately from any
camera-resolution policy.

1. Change pixel-buffer import to return an owned wrapper containing both the
   retained `CVMetalTexture` and its retained `MTLTexture`. Store both in
   `CachedSourceTexture`. The `CVMetalTexture` must remain alive through command
   buffer completion; retaining only `MTLTexture` is not the API contract.
2. Use the Step 3 monotonic frame storage identity as the content key for camera
   and screen. Check the cached identity before creating a new CVMetal/IOSurface
   view. A held frame must increment a reuse counter and perform zero imports.
   Never key only on sequence number or a raw pointer; sequences reset and pools
   reuse addresses.
3. Call `CVMetalTextureCache::flush(0)` periodically only after
   `command_buffer.waitUntilCompleted()`, and after an import failure. Define a
   named cadence constant, count imports since flush, and reset the counter on
   flush. Do not flush an in-flight view.
4. Add a macOS characterization test that imports hundreds of distinct
   IOSurface-backed pixel buffers, reuses held identities between fresh frames,
   crosses multiple flush intervals, and proves live backing/cache counters
   return to baseline. Keep it bounded and deterministic; it is not a substitute
   for the real 4K device gate.

**Verify**:

```sh
cargo test -p videorc-backend metal_source_texture_cache
cargo fmt --check --all
cargo clippy -p videorc-backend -- -D warnings
pnpm smoke:recording-matrix
pnpm smoke:recording-studio
```

Expected: tests demonstrate retained wrapper lifetime, zero imports for held
frames, periodic post-completion flushes, and full cleanup; both recording
smokes pass without more repeats or CPU fallback.

### Step 5: Run the real-device acceptance on the cache candidate

Build/install the Step 4 candidate and repeat Step 0 exactly. Do not change
camera acquisition dimensions, queue depth, source device settings, or encoder
profile between baseline and candidate.

Also require:

- held-frame import reuse is nonzero when a source is static/held;
- imports grow only with fresh frame storage identities;
- periodic flush count grows during every >60-second clip;
- live surface-backed frames/estimated bytes remain bounded and return to the
  idle baseline after every finalization;
- no AVFoundation `OutOfBuffers`, unexplained SCK status burst, or previous
  writer resource remains.

**Decision**:

- Three passing clips after a failing untouched 0.9.74 baseline: classify the
  CoreVideo cache/lifetime defect as the confirmed incident fix and skip Branch
  C/B/S.
- Three passing clips when untouched 0.9.74 also passed: keep the change as a
  verified correctness/headroom fix, but record the original root cause as
  unproven. Skip the speculative branches.
- Any failure with clean writer lifecycle: select exactly one branch below from
  the new evidence.

**Verify**: `docs/acceptance/2026-08-24-macos-recording-source-decay.md` contains
a before/after table with three candidate rows and the Step 0 acceptance fields.

### Branch C: A/B a bounded camera acquisition profile

Enter only when Step 5 still fails and camera evidence shows `FrameWasLate`,
`OutOfBuffers`, low delivery at a 4K BGRA selection, or growing shared backing.

1. Add a diagnostic candidate override that caps the camera acquisition target
   at 1920x1080 while keeping the session output at 3840x2160@30. The cap must be
   stable for the entire camera source generation so live layout changes do not
   power-cycle the device.
2. Verify format selection prioritizes target cadence before extra resolution
   and logs the actual native format, pixel format, output size, and selected
   FPS. Do not combine this with native multi-plane YUV import.
3. Use LaunchServices/Finder-compatible candidate launch so the bundle retains
   TCC responsibility. Run one screening clip over 60 seconds. If it fails, stop
   and remove the override. If it passes, run the complete three-clip batch.
4. If the A/B confirms the cap, ship a generation-stable acquisition policy:
   screen+camera generations may use the bounded profile; a camera-only source
   generation may use full canvas. Surface the actual acquisition resolution in
   Diagnostics. Do not silently downscale an already-running camera-only 4K
   generation during a layout switch.
5. Defer native NV12/UYVY Metal sampling to a separate plan unless it is required
   to preserve an explicitly accepted 4K camera-only quality contract.

**Verify**:

```sh
cargo test -p videorc-backend camera_capture_target
pnpm smoke:recording-studio
pnpm smoke:recording-studio:devices
```

Expected: preset changes retain one camera generation, screen+camera acquisition
is bounded, camera-only quality behavior is explicit, and three owner clips meet
Step 0 acceptance.

### Branch L: Complete the actual leaked writer/resource owner

Enter only when Step 2 lifecycle evidence identifies a previous session's live
outer/FIFO/VideoToolbox resource.

1. Correlate the writer ID and session ID with explicit stop/muxer-exit times and
   the one safe process sample. Name the exact stuck operation.
2. Make one shared absolute deadline cover outer writer, nested FIFO writer,
   pending VideoToolbox callbacks/session release, and both recording/stream
   bridges. Signal every owner before waiting on any owner.
3. Preserve final-frame and A/V-tail integrity on the cooperative path. On a
   non-cooperative path, keep admission closed and request an owned backend
   restart; never detach invisibly and start another capture.
4. Refresh terminal/drain errors after teardown before finalization decides the
   recording succeeded.

**Verify**: focused lifecycle tests from Step 2, `pnpm smoke:session-decay:gate`,
`pnpm smoke:recording-studio`, and the full three-clip owner acceptance all pass.

### Branch S: Investigate ScreenCaptureKit only with attributed gaps

Enter only when screen callback gaps/statuses fail while writer, camera, and
surface/cache evidence remain clean.

1. Correlate callback maximum gap with SCK status counts, live backing count,
   and the explicit backend sample.
2. A/B one SCK parameter at a time. Do not raise queue depth first; prove that
   the current depth of three is exhausted and that extra retained memory is
   safe before changing it.
3. Keep screen motion constant and use the same source/display and profile.

**Verify**: one screening clip identifies a material metric change; only then
run the complete three-clip acceptance. No unexplained parameter tuning lands.

### Branch B: Controlled historical A/B after resource candidates are clean

Enter only when Steps 2-5 produce no attribution and Branch C/S is not selected.
Use the hardened oracle and change one commit family at a time:

1. Reproduce #242's pre-full-canvas camera target as the first controlled A/B.
2. If unchanged, A/B #259's startup-cadence behavior.
3. If unchanged, A/B only the non-Windows shared changes from #262.
4. If still unchanged, compare 0.9.63-0.9.67 candidates using the exact same
   long device protocol. Do not include #267; it has no macOS runtime path.

One >60-second screening failure rejects a candidate. A screening pass requires
the complete three-clip batch before attribution. Record candidate SHA and diff
scope in the acceptance document; never batch multiple reverts.

### Step 6: Lock the regression and close the incident

Run after one candidate has passed the terminal owner acceptance.

1. Run all focused unit commands from the active steps, then:

   ```sh
   pnpm test:scripts
   pnpm typecheck
   pnpm --filter @videorc/desktop test
   cargo fmt --check --all
   cargo clippy -p videorc-backend -- -D warnings
   pnpm smoke:session-decay:gate
   pnpm smoke:recording-studio
   pnpm probe:preview-lifecycle
   pnpm smoke:recording-matrix
   pnpm smoke:recording-studio:devices
   ```

2. Do not run `cargo test -p videorc-backend` without a filter and do not run
   `pnpm smoke:local-gates` locally for this incident; both include the forbidden
   full Rust suite. CI/release infrastructure may exercise its normal gates.
3. Complete the acceptance document with exact commands, results, artifact
   report locations (not media), device/TCC blockers, and the selected branch.
4. Update this plan and `plans/README.md` to DONE only when real-device evidence
   passes. A synthetic-only result remains BLOCKED, never DONE.

## Test plan

### New deterministic tests

- `scripts/lib/recording-analyzer.test.mjs`
  - unique ratio for all-unique, repeated-run, and 277/1014 incident hashes;
  - opt-in 0.95 gate pass/fail and missing-video behavior.
- `scripts/lib/session-decay-gates.test.mjs`
  - all seven fixtures listed in Step 1;
  - authoritative bridge denominator;
  - hard failure on missing/stale/under-covered evidence.
- `encoder_bridge.rs` tests
  - session/role identity; all lifecycle transitions; outer and FIFO counts;
  - one absolute two-bridge deadline; start refusal while anything remains;
  - final failure discovered during drain.
- `recording.rs` tests
  - a stale fallback-preview generation can neither spawn nor install a child
    after a new recording begins; any raced child is stopped and reaped.
- `preview_camera.rs` tests
  - all Apple dropped-frame reasons plus unknown;
  - bounded camera profile preserves source-generation/layout invariance.
- `preview_screen.rs` tests
  - complete and non-complete SCK frame statuses; static complete frame remains
    valid without new callbacks.
- `frame_store.rs` tests
  - zero-copy backing remains counted after store replacement while an external
    handle exists; final drop returns live count/estimated bytes to baseline.
- `metal_compositor.rs` tests
  - retained CVMetal wrapper outlives command completion;
  - held storage identity produces reuse, not import;
  - hundreds of distinct buffers cross flush intervals and fully release.
- shared protocol tests
  - one maximal fixture carries every new diagnostics field through Rust/TS
    normalization without `null` serialization regressions.

### Terminal non-automatable test

Three consecutive >60-second 4K30 ScreenCaptureKit + AVFoundation clips in one
normally launched installed-app generation, with continuous visible motion and
the exact Step 0 thresholds. TCC restrictions make this owner/device evidence;
no dev-Electron or synthetic substitute may close the incident.

## Done criteria

All must hold:

- [ ] The untouched 0.9.74 baseline is recorded as three PASS/FAIL rows; the
      installed version was verified before testing.
- [ ] The selected fix candidate passes three consecutive >60-second 4K30 real
      screen+camera clips in one backend generation.
- [ ] Every accepted clip has >=28 fps screen and camera fresh delivery, >=90% source freshness under motion, <=200 ms served age, >=95% decoded
      unique frames, and no >400 ms corroborated freeze.
- [ ] No accepted clip emits writer leaked/lingering; post-stop outer/FIFO/live
      capture-resource counts are zero before another session starts.
- [x] A stale fallback-preview restart cannot install a capture process after a
      newer recording generation begins.
- [x] The decay evaluator fails all incident/missing-evidence fixtures and the
      short synthetic three-session gate is part of release local gates.
- [x] CVMetalTexture ownership follows the CoreVideo contract, held frames are
      not re-imported, and cache flushes occur after completed GPU work.
- [ ] Zero-copy backing diagnostics remain truthful across external handles and
      return to idle baseline after every accepted clip.
- [ ] Focused Rust tests, Node tests, typecheck, desktop tests, Rust fmt/clippy,
      recording studio, recording matrix, and permissioned device gate pass.
- [x] No generated media, app data, process samples, secrets, or support bundles
      are committed.
- [x] `docs/acceptance/2026-08-24-macos-recording-source-decay.md` identifies the
      confirmed branch or explicitly says the original root remains unproven.
- [x] Plan 034 remains blocked until this plan is DONE, then is rebased to remove
      its superseded camera-callback work before any U-slice resumes.
- [x] `plans/README.md` is updated.

## STOP conditions

Stop and report; do not improvise if:

- the installed bundle is not the intended candidate version;
- camera, screen, or microphone permissions/devices are unhealthy after the
  required reboot/replug;
- a previous writer/resource is live at session admission (do not record over it);
- any candidate changes more than one causal variable;
- an in-scope file no longer matches the current-state excerpts;
- a focused test or recording smoke fails twice after one reasonable correction;
- passing requires weakening freshness, uniqueness, freeze, age, or coverage
  thresholds;
- the fix appears to require unproven cross-thread destruction of a
  VideoToolbox session;
- a 1080p camera cap appears to solve the incident but the proposed permanent
  policy silently degrades an existing camera-only 4K contract;
- permissioned real-device acceptance cannot run. Mark the plan BLOCKED with the
  reason; synthetic evidence cannot substitute;
- a change requires touching an out-of-scope media subsystem;
- unrelated owner changes overlap an in-scope file and cannot be preserved.

## Maintenance notes

- `CVMetalTextureCache::flush` is periodic housekeeping, not permission to drop
  an in-flight `CVMetalTexture`. Keep wrapper lifetime and flush cadence as two
  separately tested contracts.
- Static ScreenCaptureKit content legitimately has old timestamps. Freshness is
  a hard gate only with the motion stimulus; production should continue holding
  the last complete screen frame rather than showing a placeholder.
- The synthetic decay gate protects session lifecycle, not real capture pools.
  Keep this distinction in script output and release records.
- If Branch C confirms bandwidth pressure, create a follow-up plan for native
  multi-plane YUV Metal sampling rather than quietly expanding this incident
  patch.
- Reviewers should scrutinize ownership/drop order, global counter reset between
  tests, protocol mirrors, and whether any new diagnostic callback allocates or
  blocks.
