# Plan 212: the Preview never shows test noise

> **Executor instructions**: Follow this plan slice by slice, in order. Run
> every "Done when" check before moving on. If anything in "STOP
> conditions" happens, stop and report; do not improvise. When a phase is
> done, update this plan's row in `plans/README.md` and fill in "As built".
> Gates run once at the end of each phase (owner rule): write and commit
> the phase's slices first, then run its gate slice. S1 is the exception:
> its smoke must be seen red on the base before S2 starts.
>
> **Drift check (run first)**:
> `git diff --stat b465b071..origin/main -- crates/videorc-backend/src/performance_check.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/compositor_preview_frame_lease.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/scene.rs crates/videorc-backend/src/synthetic_diagnostic.rs crates/videorc-backend/src/preview_surface.rs apps/desktop/src/main/native-preview-first-frame.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx apps/desktop/src/renderer/src/lib/performance-check.ts apps/desktop/src/renderer/src/components/first-run apps/desktop/src/shared/backend-rpc-contract.ts scripts/smoke-performance-check.mjs`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Status:** PLANNED 2026-10-31. Nothing built. Owner decisions D1 to D3
  are open; the slices below follow the recommendations.
- **Priority:** P0 for Phase 1. Every packaged user sees about 18 seconds
  of coloured noise in the Preview on the first launch after each update.
  On this Mac that happened three times in 21 hours.
- **Owner report, 2026-10-31:** "preview was giving me this, we shouldn't
  have this ever ... this was the first thing and it was there for too
  long 15+ seconds before I got my camera. so whenever we turn on preview
  we should never see this, and also not in transition."
- **Size:** M for Phase 1 (S1 to S6). Phase 2 (S7 to S9) is optional and
  only built if the owner picks it in D2.
- **Risk:** MEDIUM in Phase 1. It changes what the Preview presents, but
  only while a performance check runs, plus a backstop that refuses a
  test-pattern frame in packaged builds. A real recording, stream or
  Clips ring is unchanged. HIGH in Phase 2, which keeps the Preview live
  during a check by composing twice.
- **Planned against:** `origin/main` `b465b071` (0.17.2), in
  `~/projects/videorc-wt-preview-noise` (branch
  `plan-212-preview-never-shows-test-noise`). The shared checkout is on a
  stale branch (`feat/windows-owner-waiver`), so work in a fresh worktree
  from `origin/main`.
- **Owner route:** Orchestrator, fit 10. The fix spans the renderer's
  check trigger, the backend compositor and lease, main's first-frame
  watchdog and the Preview's words. Lanes per slice below, from
  `CLAUDE.md`.

## Goal

The Preview shows what goes out, and nothing else, from the first frame,
through every hand-over, every time. A performance check never draws in
it, never changes the scene, and no longer runs on every update.

## What happened on 2026-10-31 (owner's Mac, 0.17.2)

Read from `~/Library/Application Support/Videorc/logs/backend.log` and the
`performance_check_result` row in `videorc.sqlite3` (read only). Times are
UTC; the owner's clock is UTC+1.

| Time                     | What happened                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10:40:15                 | The app launches; main connects to the backend at 10:40:16.                                                                                                                          |
| 10:40:17.5               | The Clips ring tries to start and is refused at 10:40:18.3: "the camera preview source(s) produced no frames". The camera starts at 10:40:18.3.                                      |
| 10:40:19.5               | Clips starts on a fresh compositor run. The camera is live.                                                                                                                          |
| 10:40:24.9               | The renderer stops Clips for the performance check: the auto-run fires 8 s after launch (`PERFORMANCE_CHECK_AUTO_RUN_DELAY_MS`).                                                     |
| 10:40:25.1               | Rung 1 (3840x2160@30) arms the Preview's compositor in place and commits its own scene: one full-frame "Test pattern" source, drawn as noise. **The Preview shows noise from here.** |
| 10:40:25.7 to 10:40:30.2 | Main's first-frame watchdog takes the check for a broken Preview: two present-kicks, a resync-scene, then a reset-native-path (a new presenter).                                     |
| 10:40:31.3               | Rung 1 ends. The run is "released to preview" with the test-pattern scene still in it and the noise still on. 70 ms later rung 2 (2560x1440@30) takes it again.                      |
| 10:40:37.2               | Rung 2 ends; rung 3 (1920x1080@30) starts.                                                                                                                                           |
| 10:40:43.0               | The ladder ends after 18.1 s.                                                                                                                                                        |
| 10:40:43.3               | Clips arms again and commits the user's scene. **The camera is back.**                                                                                                               |
| 10:40:51                 | Backend: "This computer is overloaded: a load of 27 on 10 cores and 17.0 GB of swap in use."                                                                                         |

The same ladder ran on 10-30 at 14:03 and 15:10. Each run was the first
launch after an update.

The stored verdict from 10:40 is also wrong. It failed 4K30 at 14.5 fps
and 1440p30 at 22.6 fps on an overloaded host, and now recommends 1080p30
on a Mac that records 4K30 every day. Because the owner chose 4K30, the
check most likely also raised the toast "4K · 30 fps is too heavy for this
computer" (`performanceCheckTooHeavyToast`, `performance-check.ts:163`).

## Why (verified at `b465b071`)

Backend paths are under `crates/videorc-backend/src/`. Renderer paths are
under `apps/desktop/src/renderer/src/`.

1. **Every update re-runs the check, 8 s after launch.**
   - `capability_key()` (`performance_check.rs:478`) hashes the desktop
     app version (`desktop_app_version()`), so every release makes the
     stored verdict stale.
   - The renderer runs a stale check 8 s after launch, in packaged builds
     only (`use-studio.tsx:17076-17086`, `performanceCheckMayAutoRun` in
     `lib/performance-check.ts:145`). It stops Clips first
     (`requestPerformanceCheck`, `use-studio.tsx:16969`).
2. **A rung is a real capture session, and it takes the Preview's
   compositor.**
   - There is one compositor slot (`state.compositor`).
     `start_synthetic_compositor_with_lifecycle` (`compositor.rs:3436`)
     stops the current run before it starts another, so a session either
     borrows the Preview's run or replaces it.
   - `benchmark_session_params` (`performance_check.rs:803`) asks for
     `test_pattern: true`, no camera, no screen and no scene.
   - The session arms the Preview's run in place (`recording.rs:5367`,
     `arm_compositor_for_capture`, `compositor.rs:3842`). Nothing in that
     path looks at `SessionPurpose::PerformanceCheck`.
   - It then commits its own scene over the user's
     (`recording.rs:5494-5541`, `commit_recording_startup_scene_at_time`,
     `recording.rs:3678`). With `test_pattern` set, `base_source`
     (`scene.rs:474`) makes that scene one full-frame "Test pattern"
     source.
   - The Preview presents `presented_frame_store`
     (`compositor_preview_frame_lease.rs:14`), which is that run's
     primary. So the Preview shows the benchmark.
3. **The noise is a process-wide switch.**
   - `run_ladder` engages `SyntheticHardContentGuard`
     (`performance_check.rs:630`) for the whole ladder.
   - That guard sets a global `AtomicBool` (`compositor.rs:8777-8793`).
     `synthetic_test_pattern_bgra` (`compositor.rs:8836`) reads it at
     draw time, for any test-pattern source in any scene.
   - It draws per-frame random RGB at a quarter of the canvas
     (`synthetic_hard_content_bgra`, `compositor.rs:8805`), plus the
     frame-number strip and timecode (`synthetic_diagnostic.rs:84`).
     In the owner's screenshot, those are the white bars along the top
     and "08 08 18 03" in the corner.
4. **Nothing gives the user's scene back.**
   - Releasing the lease (`compositor.rs:3960-4040`) restores the loop
     config and the overlays, but not the scene.
     `reconcile_preview_after_capture_release` does not touch it either.
   - So between rungs, the Preview keeps the benchmark scene, with the
     noise still on.
   - After the ladder, only a Clips re-arm puts the user's scene back
     (`releasePerformanceCheckHold` → `scheduleReplayReconcile`).
   - With Clips off, or refused on a software encoder, the Preview
     probably keeps the plain test pattern (moving bars and a yellow
     square) until something commits a scene. **Suspected; S1 proves or
     clears it.**
5. **The renderer can adopt the benchmark scene.**
   - `readLayoutTransactionBackendTruth` (`use-studio.tsx:9800-9850`)
     turns a backend `test-pattern` source into `sources.testPattern =
true` and drops the screen, then persists the working visual.
   - A layout transaction during a check could therefore carry the test
     pattern into the user's look for the rest of the session.
     `capture.ts:1578` strips `testPattern` on the next load, so it does
     not survive a relaunch. **Suspected; S1 checks.**
6. **Main's watchdog fights the check.** The first-frame ladder
   (`native-preview-first-frame.ts`, wired in `main/index.ts:1797-1890`)
   treats the benchmark as a broken Preview. Its `resync-scene` asks the
   renderer to commit its scene into the benchmark's session, and its
   `reset-native-path` throws away a working presenter.
7. **The gate never looked at the picture.**
   - `SUPPRESSED_EVENTS` (`performance_check.rs:408`) hides the
     benchmark's events from the client.
   - `smoke:performance-check` is backend-only. It proves "no events, no
     Library row, no media", but "invisible" never included the Preview.
     That is how this shipped.
8. **The verdict came from a busy Mac.** Nothing in `measure_rung`
   reads host load. On the owner's Mac the encoder bridge logged
   "overloaded" eight seconds after the ladder ended. Clips was also off
   for those 18 s.

**Ruled out:**

- A cold source draws black (`missing_source_black_bgra`,
  `compositor.rs:8477`), not noise.
- In a packaged build, nothing but the check makes a test-pattern scene.
  `storage.rs:1819` and `support_bundle.rs:744` are test fixtures, and
  `smokePreviewCompositorCaptureConfig` (`capture.ts:1623`) is smoke-only.

**Windows and Linux:** the backend path is the same (one slot, the same
scene commit), and the proof surface draws the compositor's frames. Not
verified on either platform.

## The rule

The Preview shows the program, and nothing else.

- It never shows the test pattern, benchmark noise, or any frame composed
  for a performance check.
- At every hand-over it shows the last program frame or the next one,
  never anything else. That covers launch, Record and Stop, Go Live and
  End, Clips on and off, a check's rung change, and a scene switch.
- A check never changes the user's scene, look or saved scenes.
- Backstop: a packaged build never presents a frame composed from a
  scene with a test-pattern source. Dev builds and smokes keep it,
  because they rely on it.

## What the user will see

- **Launch after an update:** the camera appears in the usual start time.
  No check runs and no noise appears.
- **First launch on a new Mac (D1):** the check runs during first-run
  setup, behind the setup card. The Studio's Preview never shows it.
- **"Check this computer" in Recording → Output (D2):** the Preview keeps
  its last picture under a small "Checking this computer · 2 of 3"
  label, then goes live again. Clips pauses for the check, and the button
  says so.
- **A busy Mac (D3):** "Your Mac was busy, so the check stopped. Try
  again when it's quieter." The old verdict stays.

## Owner decisions (open)

- **D1. When the check runs on its own.**
  - **Recommended:** once per Mac. Never at launch, and never after an
    update.
    - First-run setup starts it. Setup shows no Preview and records
      nothing.
    - Otherwise it runs only from Recording → Output. That panel
      suggests a check when this Mac has no verdict yet, or when the Mac
      changed since the last one (graphics or OS).
    - An update never re-measures. A pipeline-version constant does, and
      it is bumped only when an encode change alters what a rung
      measures.
  - B: keep an automatic run, but at a quiet moment: at least 2 minutes
    after launch, nothing recording, and no input for 30 s. The Preview
    holds under the label (D2).
  - C: as today (8 s after launch, whenever the verdict is stale), with
    the Preview held under the label.
- **D2. What the Preview shows while a check runs.**
  - **Recommended:** Phase 1 only. The last program frame, with "Checking
    this computer · 2 of 3". If no frame was ever presented, the existing
    starting placeholder with the same words.
  - Alternative: also build Phase 2, where the Preview stays live during
    the check and the camera keeps moving. It needs a spike first,
    touches what the native preview presents, and adds a second compose
    during the measurement.
- **D3. A check on a busy Mac.**
  - **Recommended:** record no verdict, using the encoder bridge's
    existing overload signal (load and swap). The old verdict stays, and
    Output says why.
  - Alternative: record it anyway (today's behaviour).

## Slices

### Phase 1: the check never touches the Preview, and stops running on every update

#### Slice S1: a gate that reads the Preview (red first)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`. It is clear test
work, and S2's owner reviews it.

**Files:**

- New `scripts/smoke-preview-check-invisible-app.mjs`, with
  `smoke:preview-check-invisible` in `package.json`.
- New `scripts/lib/synthetic-frame-strip.mjs` and its test. It decodes
  the strip that `synthetic_diagnostic.rs` draws.
- Reuse the pixel oracle in `scripts/lib/preview-interaction-stress.mjs`.
  Do not add a second Preview lease holder.

**Steps:**

1. Launch the dev app with an isolated profile (`scripts/lib/smoke-env.mjs`).
   Use a program that is not synthetic and needs no grant, such as a
   background-image scene. With the Screen Recording grant, also run a
   screen scene. Without it, SKIP that pass and name the missing grant.
2. Run three passes: Clips on, Clips off, and Clips on with Record
   pressed during rung 2.
3. Start the check the way the app does (`requestPerformanceCheck`,
   through a remote-control or test intent), not with the raw RPC. That
   puts the Clips stop and restart and the renderer's scene reads in
   play. Set `VIDEORC_PERFORMANCE_CHECK_FORCE_FAIL_ABOVE_HEIGHT` so at
   least two rungs run and there is a rung hand-over.
4. Sample what main presents on every tick, from 2 s before the check
   until 3 s after `performance.check.completed`.

**Hard-fails:**

- Any presented frame with a decodable synthetic strip.
- Any `compositor.status.sceneSources` entry of kind `test-pattern`.
- `scene.get` content differs before and after the check. The revision
  may advance.
- The renderer's working visual or saved scenes changed, including a
  `testPattern` the user never chose.
- The Preview is not back on the program within 1 s after completion, in
  any pass.
- Any `[first-frame]` or `[preview-watch]` healing line while the check
  runs.
- In the Record pass: the recording's first frame decodes as synthetic,
  or the recording is missing.

**Done when:**

- The smoke runs red on `b465b071`, and the PR names each failure. That
  run is the evidence for "Why" items 2 to 6.
- The strip decoder's unit tests pass in `pnpm test:scripts`.
- The smoke is listed in `smoke:recording-studio`'s preview reliability
  set. Update `AGENTS.md` to match.

#### Slice S2: the benchmark draws only into its encoder, and the Preview holds the program

**Route / lane:** Diagnose → Implementation, fit 9, `fable-5.1`. It
touches the compositor lease and what the native preview presents, which
is release-critical.

**Files:** `compositor.rs`, `compositor_preview_frame_lease.rs`,
`recording.rs`, `performance_check.rs`, `protocol.rs`,
`apps/desktop/src/shared/backend-rpc-contract.ts` and the shared TS
status type, `apps/desktop/src/main/native-preview-first-frame.ts`, and
their tests.

**Changes:**

1. **The lease knows it is a benchmark.**
   - Carry `SessionPurpose::PerformanceCheck` into `CompositorArmParams`
     and `CompositorCaptureLease`.
   - Carry it into the fresh-run path as well, used when the in-place arm
     is refused (`recording.rs:5466`). The rule must hold on both paths.
2. **The user's scene stays.**
   - A benchmark session's startup scene goes into a lease-scoped
     `benchmark_scene` that only the primary leg draws.
   - `compositor.scene`, `status.scene_*`, `scene.get` and the scene
     revisions keep the user's scene.
   - The startup barrier and the frame-scene-revision checks read the
     benchmark scene's revision for that session.
   - A scene edit during the check goes into the user's scene and shows
     when the hold ends.
3. **The noise belongs to the benchmark.**
   - Replace `SYNTHETIC_HARD_CONTENT_OVERRIDE` with a flag on the
     benchmark scene, and pass it to `synthetic_test_pattern_bgra`.
   - Keep `VIDEORC_SYNTHETIC_HARD_CONTENT` for the smokes.
   - Delete `SyntheticHardContentGuard`, and update the test at
     `compositor.rs:14384` and its "process-wide" comment.
4. **The Preview holds across the whole ladder.**
   - `run_ladder` takes a `PreviewHoldGuard`. It holds from before rung 1
     until after the last release and the first program frame composed
     after it, so the Preview never flashes between rungs.
   - While held, `presented_frame_store` keeps returning the frame it
     returned when the hold began. Keep a retained `FrameHandle`, so the
     arm's resize cannot recycle that IOSurface.
   - No `preview.frameReady` is sent for benchmark ticks
     (`compositor.rs:6491`), and `acquire_preview_frame` refuses them.
5. **A hold is not a broken Preview.**
   - Add `compositor.status.previewHold: "performance-check"`, left off
     the wire when there is no hold.
   - Add it to `backend-rpc-contract.ts` in the same commit. A status
     field missing from the strict contract retires main's present pump.
   - `assessFirstFrame` and `assessPresenting` treat a hold as pending or
     observing with the reason "Checking this computer", and never heal.
     Add unit tests for both.
6. **The backstop.**
   - In packaged builds, `presented_frame_store` and the lease never
     hand main a frame composed from a scene with a test-pattern source.
     They keep the last program frame, log once per run, and count
     `framePipeline.previewSyntheticRefused`.
   - Use whatever packaged signal the backend already has. If there is
     none, main passes one.
   - Dev builds and smokes behave as today.
7. **The proof surface.** Find where the Windows and Linux proof surface
   reads compositor frames. If it does not go through
   `presented_frame_store`, apply the same hold and backstop there.
8. **The renderer never adopts a test pattern.** In packaged builds,
   `readLayoutTransactionBackendTruth` ignores a `test-pattern` source.
   This backs up change 2.

**Tests:** one Rust or TS unit test per change.

- A benchmark arm leaves `scene.get` unchanged.
- The hold returns the frame from before the hold across a release and a
  re-arm.
- A user's test-pattern scene stays the plain pattern while a benchmark
  runs.
- The backstop refuses in packaged mode only.
- The contract test includes `previewHold`.
- Main's assessors treat a hold as not broken.

**Done when:** the targeted `cargo test -p videorc-backend` filters pass,
`cargo clippy -p videorc-backend -- -D warnings` is clean, and the
desktop tests for the touched files pass. Smokes run in S6.

#### Slice S3: the check stops running on every update and at launch (D1)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:** `performance_check.rs`, `lib/performance-check.ts`,
`hooks/use-studio.tsx` (the auto-run effect), and
`components/first-run/first-run-setup.tsx`.

**Changes:**

1. **The key.**
   - Drop `desktop_app_version()` and the crate version from
     `capability_key_from`.
   - Add `PERFORMANCE_CHECK_PIPELINE_VERSION: u32`, with a doc rule: bump
     it only when an encode change alters what a rung measures.
   - Bump `CAPABILITY_KEY_VERSION` to v3.
   - Keep the Linux v1 poison rule (`linux_did_not_start_below_floor`).
2. **No forced re-check on upgrade.**
   - A stored v2 row is not stale when re-hashing it with its own
     `appVersion` and today's os, arch and graphics identity reproduces
     its key. In other words, the same machine.
   - Upgrades then keep their verdict, and a new GPU or OS still
     re-measures.
3. **No launch auto-run.** Remove the effect at
   `use-studio.tsx:17076-17086` and `PERFORMANCE_CHECK_AUTO_RUN_DELAY_MS`.
4. **First-run setup starts it.**
   - Start the check when setup opens, so it is done before setup ends.
   - If the user leaves setup first, the check finishes under the held
     Preview with the label.
   - Confirm that no setup step shows the native Preview. `look-step`
     draws its own SVG picture (`look-picture.tsx`).

**Tests:**

- A v2 row from the same machine is not stale.
- A graphics-identity change is stale, and so is a pipeline-version
  bump.
- A Linux v1 poison row is still stale.
- The renderer never starts a check on launch.
- Setup starts one when no verdict exists.

**Done when:** those tests pass.

#### Slice S4: no verdict from a busy Mac (D3)

**Route / lane:** Implementation, fit 7, `gpt-6.1-sol`.

**Files:** `performance_check.rs` (`measure_rung`, `run_ladder`), and the
encoder bridge's overload probe (the code that logs "This computer is
overloaded").

**Changes:**

- Read the same load and swap signal at the start and end of each rung.
- An overloaded rung bails like `studio_busy`, with "the computer was
  busy; no verdict recorded". The previous verdict stays.
- `performance.check.completed` carries the reason, so Output can say
  it (S5).

**Done when:** unit tests show that an overloaded measurement saves
nothing and that a quiet one is unchanged.

**Owner's stored verdict:** the 1080p30 row from 10:40 stays until it is
re-run. After this ships, run "Check this computer" once on a quiet Mac.

#### Slice S5: the words

**Route / lane:** UI/Product Design, fit 8, `opus-5.5`. Read
`.claude/skills/videorc-design/SKILL.md` first. shadcn only.

**Files:** the Preview's status overlay (where
`updatePreviewWindowWaitDetail` and the docked Preview's waiting state
render), and the Recording → Output panel's check row.

**Words (the owner may edit them):**

- Preview while held: "Checking this computer · 2 of 3", from
  `performanceCheckProgress`. It disappears when the hold ends.
- Output with no verdict: "Not checked on this Mac yet", and the button
  "Check this computer". The button's hint: "Takes about 20 seconds.
  Clips pauses while it runs."
- Output after the Mac changed: "Your Mac changed since the last check".
- Output after a busy run: "Your Mac was busy, so the check stopped. Try
  again when it's quieter."

**Done when:** the desktop unit tests pass. A by-eye pass in both themes
is owed to the owner (owner rule: check light and dark). Say so in the
PR.

#### Slice S6: Phase 1 gates and acceptance

Run these once, after S1 to S5 are committed:

- `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D
warnings`, and the targeted Rust test filters. Run the full Rust suite
  only if CI cannot (owner directive).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm
test:scripts`, `pnpm --filter @videorc/desktop test`.
- `pnpm smoke:preview-check-invisible`: all three passes green.
- `pnpm smoke:performance-check`: green, with verdicts unchanged on a
  quiet host against an APFS-cloned `b465b071` base
  (`videorc-smoke-ab-base-worktree`).
- `pnpm smoke:preview-overlay-presentation` and `pnpm
probe:preview-lifecycle`.
- `pnpm smoke:recording-studio` (AGENTS.md rule for preview changes).
- **Owner acceptance (packaged, macOS):**
  - Install over the previous version and launch. No check runs, and the
    camera appears in the usual time.
  - Recording → Output → "Check this computer": the Preview holds under
    the label, shows no noise, and goes live again. Clips resumes.
  - Check both themes.
- **Windows tester pass:** the same two checks on the proof surface.

### Phase 2 (only if D2 picks it): the Preview stays live during a check

#### Slice S7: spike, measure two shapes (no product change)

**Route / lane:** Diagnose, fit 9, `fable-5.1`.

Measure two shapes:

- **A, a benchmark leg.** The primary stays the idle Preview at the
  Preview's size. The benchmark composes on its own leg at the rung's
  size, on a lazily built `GpuCompositor` and ring (the pattern of plan
  205's twin), and feeds the encoder.
- **B, the program leg with its own scene.** The primary composes the
  benchmark, and plan 205's twin composes the user's scene at the
  Preview's size.

**The bar:**

- Rung verdicts on a quiet host match Phase 1's in 3 runs per rung.
- The Preview's present rate stays within 10% of idle.
- No benchmark frame is ever presented.

**Done when:** the numbers are written into "As built" and one shape is
picked, or neither is.

#### Slice S8: build the winner

**Route / lane:** Implementation, fit 9, `fable-5.1`.

- The hold from S2 becomes the fallback, used only when the leg cannot
  start.
- S1's smoke gains a check that the Preview keeps advancing during the
  check.

#### Slice S9: Phase 2 gates

Run S6's list again, plus an A/B of `smoke:performance-check` verdicts
against Phase 1.

## Edge cases

- **Record during a check.** `yield_to_capture` cancels the check. The
  hold ends and the recording starts from the user's scene, which was
  never replaced. S1's third pass covers it.
- **A scene edit during a check** lands in the user's scene and shows
  when the hold ends.
- **The floating Preview window is open.** It follows the same hold,
  because it reads the same lease.
- **The Preview closes during a check.** There is nothing to hold.
  Reopening it during the check shows the label.
- **Quit during a check.** `discard_benchmark_sessions` already cleans
  up. Under D1, the next launch does not re-run it.
- **The backend crashes during a check.** The hold lives in the backend,
  so a new backend starts without one.
- **Clips is refused on a software encoder.** After the check the
  Preview is the user's scene, because it was never replaced. S1's
  Clips-off pass covers it.

## STOP conditions

- S1: the oracle cannot read the presented frame without taking the
  Preview lease from main. Report it; do not add a second lease holder.
- S1: the smoke is green on `b465b071`. The repro is wrong; find out why
  before you build anything.
- S2: the startup barrier cannot pass without committing the benchmark
  scene into the user's scene.
- S2: anything a real recording, stream or Clips ring carries changes in
  `smoke:recording-studio` or the artifact analyzers.
- S2: `smoke:performance-check` verdicts change on a quiet host against
  the base.
- S2: the hold drops or blanks a presented frame in
  `probe:preview-lifecycle`.
- S2: a new status field cannot go into `backend-rpc-contract.ts`.
- S3: some first-run setup step shows the live native Preview. Then D1
  needs another moment; ask the owner.
- S7: neither shape meets the bar. Report the numbers and stop Phase 2;
  Phase 1 stands on its own.

## Out of scope

- The Clips refusal at launch (10:40:17.5, "camera preview source(s)
  produced no frames"). It costs about 1.4 s of Clips at launch and is
  cold-launch work. An active `fix/preview-buddy-cold-launch` worktree
  exists; check it before touching that.
- Measuring the Mac from the Clips ring's real encode instead of a
  ladder. Worth its own plan.
- What a cold source draws (black, unchanged).
- Rewriting stored verdicts, apart from S3's same-machine rule.

## Risks

- **The most load-bearing path.** S2 changes what the Preview presents.
  It is gated on the benchmark lease, plus a backstop that only refuses
  test-pattern frames in packaged builds, so the common sessions never
  take the new path.
- **A pinned frame.** The hold keeps one Preview-size IOSurface alive for
  up to the check's 45 s budget (`TOTAL_BUDGET`). That memory is small,
  but it must outlive the arm's resize of the ring.
- **The strict-contract trap.** `previewHold` must reach
  `backend-rpc-contract.ts` in the same commit.
- **Weak PCs without a verdict.** With no launch auto-run, a weak PC
  that never ran setup and has no verdict is never measured
  automatically. That is rare: until now every post-update launch
  measured it, so such machines already have a verdict.
- **Host load.** Host GPU load is uncontrolled, so any verdict A/B needs
  a quiet host.

## Verification summary

| Slice | Proof                                                              |
| ----- | ------------------------------------------------------------------ |
| S1    | Red on `b465b071` with named failures; decoder unit tests          |
| S2    | Rust and TS unit tests; S6 smokes                                  |
| S3    | Key and auto-run unit tests                                        |
| S4    | Busy-host unit tests                                               |
| S5    | Desktop tests; owner by-eye in both themes                         |
| S6    | Full Phase 1 list above; packaged owner acceptance; Windows tester |

## As built

(empty)
