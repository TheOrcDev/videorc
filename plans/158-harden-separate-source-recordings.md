# Plan 158: Fix PR 632 separate-source timing, lifecycle and recovery

## Status and execution baseline

- **Status:** IN PROGRESS, 2026-10-07. Owner authorized full execution and pushing the fixes to [PR #632](https://github.com/TheOrcDev/videorc/pull/632).
- **Acceptance limitation:** Three simultaneous 4K30 hardware outputs fail the unchanged artifact gate on this Mac16,1 / M4 host. Sustained independent encoder controls reach about 21 fps per output. Remaining runtime, app/device and Windows stability verification is in progress; this plan is not fully accepted.
- **Priority:** P1 overall; the test handshake and metadata gate are P2.
- **Effort / implementation risk:** L / HIGH. Changes cross capture clocks, native encoder ownership, process teardown and durable recording metadata.
- **Source inspected / planned at:** `b9ee699c82ddc58c4220d5ae32b5a1b8341fa713`, branch `feat/separate-source-recordings`; PR base `cdd2f9421bbd055a36973bcfe222b6c44db87bec`.
- **Shared checkout when written:** `15206746`, on an unrelated branch with owner changes. The source under review is not the source in that checkout.
- **Depends on:** PR 632 / its `plans/157-separate-source-recordings.md`. The local draft named `153-separate-source-recordings.md` was renumbered 157 on the PR; do not confuse it with current main's unrelated Plan 153.
- **Category:** correctness, recovery and regression coverage. No feature expansion or release is included.

Executor: read this whole plan, the PR's Plan 157, AGENTS.md and ADR 0001 before changing code. Implement on an isolated checkout of the PR's current head. Reconcile newer commits with the evidence below; do not overwrite fixes already made. Preserve the owner's shared worktree. Update this plan's slice statuses and the plans index as work is verified. Commits, pushing and publication follow the operator's instructions; this planning request does not publish anything.

First compare the live PR head with the reviewed head:

```sh
gh pr view 632 --json headRefOid,headRefName,state
git diff --stat b9ee699c82ddc58c4220d5ae32b5a1b8341fa713..HEAD -- crates/videorc-backend/src apps/desktop/src scripts package.json
```

Run the diff from the implementation checkout, not the older shared checkout. If findings have been fixed independently, record their replacement tests and skip those edits. Materially changed clock or ownership architecture needs a revised plan before dependent implementation.

## Intended outcome and boundaries

One capture session produces Combined, Screen/system-audio and Camera/microphone files. They share a truthful session timeline, respect configured audio offsets, expose independent failures, and remain discoverable after a crash. Failed startup leaves no unmanaged child processes. A confirmed source removal ends just that source's file with an explicit reason; unaffected recording and streaming outputs continue.

Keep the existing product decisions: opt-in and off by default, Free, Combined retained, recording-profile canvas with fit/contain, windows count as Screen, and ISOs remain local during dual-orientation streaming. Retain MKV capture followed by background MP4 export. Preserve the existing ISO-off behavior and latency budgets.

Out of scope: new platform capture support, dropping Combined, arbitrary ISO track counts, Library grouping redesign/delete-take actions, per-role performance dashboards, entitlement changes, release packaging/publication, and fixing unrelated Windows incident failures. Small status/copy changes needed to identify a failed or intentionally ended role are in scope.

## Findings and source evidence

All references below describe the reviewed commit. Line numbers are navigation aids; verify the named symbols after drift.

| Review ID | Finding / impact                                                          | Evidence                                                                                                                                                                                                                      | Slice |
| --------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| F1 / P1   | Cancellation or late startup failure can abandon muxers and partial files | `recording.rs:5450` commits the ISO guard into `pending_active`, before caption/recording-lock awaits and the later FFmpeg startup-failure return; `source_iso.rs:489` awaits bridge readiness before constructing that guard | S1    |
| F2 / P2   | Scheduling-dependent FIFO test can fail on Windows                        | `source_audio_tap.rs:387` sleeps 50 ms before offering the final supposedly retained chunk                                                                                                                                    | S0    |
| F3 / P1   | ISO video is shifted relative to its audio and Combined                   | `recording.rs:5225` starts ISOs after Combined readiness; `encoder_bridge.rs:3232` initializes each bridge sequence to zero and `:6118` rebases each MPEG-TS stream to its own first frame                                    | S4    |
| F4 / P1   | Negative microphone sync offsets are omitted from ISO muxing              | `source_iso.rs:250` maps tap audio without the residual correction applied to Combined by `ffmpeg_session_params` / `capture_audio_filter`                                                                                    | S5    |
| F5 / P1   | Camera Off / Screen Off can silently produce successful filler            | `compositor.rs:7684` explicitly keeps publishing for an absent role; no matching role-level stop owner                                                                                                                        | S6    |
| F6 / P1   | Crash during recording/Stop leaves ISO files outside Library/recovery     | `source_iso.rs:781` first inserts sibling rows only after muxers finish; `storage.rs::reconcile_orphaned_sessions` operates on existing rows                                                                                  | S3    |
| F7 / P2   | The real-take gate rejects healthy production metadata                    | `separate-source-take-gates.mjs:19` expects Combined `Mix`; `recording.rs::microphone_audio_track` emits `Microphone`; the fixture supplies artificial `Mix` tags                                                             | S7    |
| F8 / P1   | Failed ISO encode can be exported as successful truncated media           | `source_iso.rs:610` discards teardown outcomes, `:629` trusts FFmpeg exit zero, and ISO finalization sets `post_recording_gate: None`                                                                                         | S2    |

Load-bearing excerpts:

```rust
// recording.rs, constructing pending_active before the final commit:
source_iso: source_iso_runtime.map(crate::source_iso::SourceIsoStartGuard::commit),

// source_iso.rs::finish: encoder outcome currently discarded:
let _ = crate::recording::finish_recording_encoder_bridge_teardown(
    state,
    Some(batch),
    "source-iso-recording-process-exit",
)
.await;
// Muxer exit alone decides success:
Ok(Ok(status)) if status.success() => Ok(()),

// source_audio_tap.rs test: elapsed time is treated as readiness:
thread::sleep(Duration::from_millis(50));
tap.offer(&[0.7; 4]);
```

```js
// scripts/lib/separate-source-take-gates.mjs
export const ROLE_AUDIO_TITLES = Object.freeze({
  combined: 'Mix',
  screen: 'System audio',
  camera: 'Microphone'
})
```

Audio timing already splits the requested offsets as follows in `recording.rs::session_audio_sync` / `session_audio_options`:

```text
track_shift = min(microphone_offset, system_offset)
microphone_bus_delay = microphone_offset - track_shift
system_bus_delay = system_offset - track_shift
```

For microphone −120 ms and system 0 ms, taps contain a 0 ms microphone delay and a +120 ms system delay. Both ISO muxers must then apply the same −120 ms residual track shift as Combined. Applying the microphone's full requested offset independently to both roles would also be wrong.

## Relevant code and conventions

Primary backend scope is `crates/videorc-backend/src/`:

- `source_iso.rs`: role planning, muxer args, startup/runtime ownership, finish and finalization registration.
- `recording.rs`: `start_session_with_timeline`, `UncommittedCaptureProcess`, `ActiveRecording`, `monitor_session`, audio offset/filter helpers, finalization jobs and `resume_pending_recording_finalizations`.
- `encoder_bridge.rs`: prepare/readiness, epoch/PTS generation, writer ownership and teardown reports.
- `compositor.rs`, `compositor_scene_switch_tests.rs`: ISO snapshots, publishers and source-frame evidence.
- `metal_compositor.rs`: distinguish target-ring busy from other composition failures without changing the ring cap. `video_toolbox_encoder.rs`: keep bounded callback ownership comments aligned with the configured encoded admission budget and inspect actual native encoder selection/property results for the demonstrated 4K throughput failure.
- `preview_camera.rs`, `preview_screen.rs`: test-only generation-owned source publication; release admission authority before allocating and publishing fixture frames, matching native callback ownership.
- `source_audio_tap.rs`, `session_audio.rs`: bounded audio queues, shared PCM chronology, per-role closure and sync-offset split.
- `fifo.rs`, only as needed for an explicit create-new transport operation:
  ISO startup must refuse an existing endpoint without removing a parked
  Windows named-pipe server. Preserve the legacy recreate behavior of other
  callers and cover both contracts in the existing Windows FIFO tests.
- `storage.rs`, `recording_finalization.rs`, startup recovery in `main.rs`: sibling persistence, bound media identity, export registry, replay and interrupted sessions.
- `live_source_switch.rs`, `live_scene.rs`: existing authoritative source-selection and scene-commit state; use these to distinguish removal from transient preparation.
- `protocol.rs`: only if durable role outcome or Library status needs an additional field. Mirror changes in `apps/desktop/src/shared/backend.ts` and `backend-rpc-contract.ts`, plus contract tests.

Test/script scope: existing ISO/tap/storage/recording tests; `scripts/lib/separate-source-take-gates{,.test}.mjs`, `scripts/smoke-separate-source-{fixture,take}.mjs`, recording-studio and record-latency script/helpers, and their tests. A maintained `scripts/smoke-separate-source-runtime.mjs` and its package entry may be added for the production lifecycle regression. Its invocation below is a planned new command, not an existing script.

Execution scope clarification: add the affected portable ISO/tap filters to the existing 25-pass PowerShell loop in `.github/workflows/release-windows-gates.yml`. That workflow already runs the full Rust suite three times; retaining its failure/zero-test checks supplies the Windows stability evidence through PR CI without introducing a separate verification system.

Frontend scope, only if required for truthful status: Library row/view helpers and their tests. Follow the project's videorc-design and shadcn skills for any UI work. Prefer existing finalization/error fields and role badges over a new status API or control.

Match the established `UncommittedCaptureProcess` ownership pattern: protect resources before fallible awaits and transfer ownership only at a real commit boundary. Match Combined's terminal-failure handling and `persist_finalization_or_recovery` rather than inventing a second recovery engine. Rust owns capture; FFmpeg is downstream (ADR 0001). Do not introduce another capture session or replace native preview transport.

Use owned PIDs only. Never hold the recording/compositor mutex across child waits, bridge joins, or role finalization. New test synchronization uses explicit channels and bounded waits; failed assertions must still terminate/reap owned children. Generated recordings and reports belong in temporary evidence directories, not commits.

## Ordered slices

| Slice | Deliverable                                                     | Depends on | Effort | Status                                                                     |
| ----- | --------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------- |
| S0    | Deterministic tap regression and lifecycle test seams           | —          | S      | Implemented; Windows repetitions pending                                   |
| S1    | Cancellation-safe writer ownership through final commit         | S0         | M      | Implemented; Unix collision regression passed, Windows repetitions pending |
| S2    | Per-role terminal verdicts preserve encoder/audio/muxer failure | S1         | M      | Implemented; full runtime acceptance pending                               |
| S3    | Durable role registration and idempotent crash recovery         | S2         | M      | Implemented; final acceptance pending                                      |
| S4    | Shared production start barrier and timeline                    | S1–S3      | L      | Implemented; full timing matrix pending                                    |
| S5    | Residual audio sync offsets on both ISO muxers                  | S4         | M      | Implemented; full offset matrix pending                                    |
| S6    | Confirmed source removal closes one role explicitly             | S2–S5      | M      | Implemented; full lifecycle matrix pending                                 |
| S7    | Production metadata and real-take gate agree                    | S3, S5, S6 | S      | Implemented; healthy controlled MKV/MP4 verified                           |
| S8    | Production runtime smoke, failure matrix and final acceptance   | S0–S7      | L      | Implemented; final gates in progress                                       |

Execute in this order under one implementation owner because most slices share recording and ISO lifecycle code. Each slice should leave normal ISO-off recording operational. Tests establishing a defect should fail before its fix and pass afterward; do not retain deliberately failing tests between completed slices.

### S0: Replace the timing handshake and prepare bounded test controls

1. Change `dropped_chunks_are_paid_back_as_silence_so_the_timeline_never_shifts` to have the reader read the initial queued byte count, acknowledge it through a channel, then drain the remainder. Offer the `0.7` chunk only after that acknowledgement. Preserve the exact dropped-count, silence-position and final-sample assertions.
2. Bound readiness and joins; arrange cleanup before asserting timeout results so a reader cannot remain blocked after a failure. Do not substitute polling a temporary file or a longer sleep.
3. Establish narrow test seams for later slices: child-spawn acknowledgement, encoder-prepared/readiness gates, injected bridge terminal failure, and finalization pause/restart points. Add each seam with its first exercising regression, using existing test injection patterns; do not add general-purpose production fault APIs.

**Verify:** `cargo test -p videorc-backend source_audio_tap` passes. Windows repetition requirements are listed under final gates and remain mandatory even if macOS passes.

### S1: Own resources before the first child spawn until the final session commit

1. Make the staged ISO owner exist before spawning any muxer. Register each child, bridge, tap, FIFO and session-created partial file immediately. Cancellation during `wait_until_ready` must execute cleanup even when the async function never returns.
2. Retain the guard through caption setup, recording-lock acquisition and the last `ffmpeg_progress.startup_failure()` check. The actual transfer into `state.recording` and installation of its reaper must contain no unprotected await gap. A pending `ActiveRecording` may itself retain an armed guard if that best matches existing construction.
3. Drop must synchronously signal stop/kill and hand bounded reaping to an owned cleanup task. Use `kill_on_drop` as a last-resort child safeguard, not as a substitute for explicit reap and partial-resource cleanup. Handle creation failures before a writer enters the vector too.
4. Abort cleanup may remove only files proven created by that failed startup. Retain collision protection and do not delete any pre-existing sibling path. Successful ownership transfer must disarm abort exactly once.

**Regressions:** cancellation after the first muxer spawn; cancellation awaiting each bridge; failure while starting the second role; failure after guard-to-pending transfer; late Combined failure; cancellation at final lock acquisition; normal successful commit. Assert all recorded PIDs reaped, all started bridges retired, no unexpected FIFOs/owned partials, and a subsequent session can start.

**Verify:** `cargo test -p videorc-backend source_iso` and `cargo test -p videorc-backend recording::tests` pass; new lifecycle tests explicitly cover the cancellation points above.

### S2: Preserve independent role failures through finalization

1. Give each role one cleanup owner and a terminal outcome that retains the stop cause, bridge failure, muxer exit, tap failure and actual media end. A small internal enum/result is enough; a diagnostics dashboard is not required.
2. Observe bridge terminal failure and muxer exit while the session remains live. Close the failed role's remaining producers/readers, emit a role-named health event once and retain partial media. Unaffected roles and streams continue unless an existing session-wide fault requires termination.
3. Reconcile bridge teardown reports with their owning roles rather than discarding them. Exit zero is only one success condition. A muxer that exits before a requested role/session stop cannot become normal completion simply because its input reached EOF.
4. Distinguish queue overflow repaid as timed silence from permanent tap failure or a forced, incomplete drain. The latter must produce a degraded/failed role outcome. Preserve current non-blocking bus behavior.
5. Give each finalized ISO the applicable existing recording quality checks and its own expected duration/fps/audio facts. Use role end time for an intentionally shortened role. Neither idle diagnostics nor muxer exit zero proves a complete take. Keep failed/truncated media recoverable and prevent a generic “all saved” message from overriding its error.

**Regressions:** bridge fails after valid frames while muxer exits zero; muxer exits early with zero/nonzero; audio writer fails after readiness; one role fails while the other and Combined advance; simultaneous Stop/failure; duplicate completion notification. Assert one terminal outcome and one cleanup per role, no successful verdict for unexpected truncation.

**Verify:** `cargo test -p videorc-backend source_iso`, `cargo test -p videorc-backend source_audio_tap` and `cargo test -p videorc-backend recording_finalization` pass. S8 must additionally verify actual partial artifacts through real muxers.

### S3: Persist all take members before recording and recover by stored ownership

1. Within the existing session-start transaction boundary, persist the Combined take identity and two sibling reservations with role, intended path and initial lifecycle status before their processes write media. Reuse the deterministic sibling IDs and existing session schema where sufficient.
2. Replace stop-time inserts with idempotent updates of those rows. Persist role outcome before publishing terminal status. Update intended paths with the existing bound media identity when available; honor file collision and no-overwrite rules.
3. Extend startup reconciliation/resumption to include interrupted ISO rows and existing export recovery records. Distinguish missing/empty media, recoverable MKV, already finalized MP4 and interrupted staging output. Only adopt artifacts through the existing validated ownership/recovery rules; never scan and claim arbitrary files by suffix.
4. Make startup rollback explicit: untouched reservations can be retired according to existing session policy; written artifacts remain visible as failed/recoverable unless the still-uncommitted owner safely removes its own partial files. A failed metadata write must use durable recovery reporting rather than a log-only orphan.
5. Keep export permits and registry entries established before reporting capture idle. Repeated recovery must not create duplicate siblings, double-export a completed MP4 or clear a recorded failure. Library should show real role states using existing fields.

**Regressions:** reopen a database after interruption before spawn, during recording, after role stop, after MKV close, during MP4 export and after MP4 publication but before DB commit. Check one row per role, correct `take_id`, artifact ownership, explicit partial failure and repeatable replay. Include one failed Camera with usable Combined+Screen, missing paths, existing-file collisions and one database-write fault.

**Verify:** `cargo test -p videorc-backend storage::tests`, `cargo test -p videorc-backend recording_finalization`, `cargo test -p videorc-backend resume_pending_recording_finalizations` pass. If DTOs change, run `pnpm typecheck` and shared-contract tests in S7 as well.

### S4: Establish one origin before any output consumes session media

1. Separate resource/encoder preparation from releasing the first session frame. Prepare the required Combined and ISO encoders under S1 ownership, then release them through one coordinator with a shared origin and a retained initial compositor/source snapshot. Wire compatible split/simulcast participants without changing their composition or stream offset policy.
2. Make audio epoch and video timestamps derive from that same origin. Each role must encode content from the correct session time. Do not rebase a later role's first live frame to zero while leaving its audio at the original epoch; do not repair this with a guessed constant delay or by labeling newer content as old content.
3. Account explicitly for the FIFO dependency: muxers open/probe audio before encoded video. “All muxers have consumed video” cannot be a prerequisite to releasing an audio epoch they need to reach that state. Encoder preparation and output-writer readiness must be distinct; allow transport threads to wait independently and bound the whole startup.
4. Preserve discontinuities and duration on overload using existing bridge policy. Transport-specific rebasing must not erase offsets from the shared origin. ISO-off must continue on its existing optimized start path.
5. Add a time-varying source fixture whose visual frame identity and audio impulses share a known capture clock. Hold each participant at a deterministic preparation gate in turn, including a delay longer than the former expected startup skew, then release it. Test both first content and late-session events.
6. Distinguish temporary native target-ring exhaustion from other GPU failures. For a VideoToolbox recording consumer, keep the previous usable native frame during that bounded busy condition and preserve explicit diagnostics; do not replace it with CPU-only fallback or republish stale content as fresh. Keep the ring cap and failure/stall contracts, retain normal behavior for other consumers, and prove resumed composition after target release. The 4K artifact gate must still reject unacceptable held frames.

**Acceptance:** at 30 and 60 fps, decoded event alignment between role files and against expected audio timing differs by no more than one output frame plus 10 ms of bus chunk granularity. This is an explicit new content-alignment criterion, separate from existing container A/V and stop-tail gates. AAC encoder delay must be accounted for from decoded timing, not hidden by relaxing the tolerance. Test an intentionally shifted leg to prove detection.

**Verify:** `cargo test -p videorc-backend source_iso`, `cargo test -p videorc-backend encoder_bridge`, `cargo test -p videorc-backend session_audio::mix_tests`, `pnpm smoke:separate-source-fixture` pass. Production startup proof is required in S8; the old offline fixture alone does not close F3.

### S5: Apply the residual audio shift exactly once

1. Pass the result of the existing `session_audio_sync` split into ISO muxer planning, preferably as a small immutable timing value shared with Combined. Avoid recomputing the split differently per role.
2. Apply the residual track shift to each ISO tap: negative shift trims the relevant leading samples and resets timestamps; positive shift delays with timed silence. Do not reapply microphone gain, mute, echo processing, system gain or the bus's individual source delay.
3. Keep role audio on the shared start/stop timeline when a source is disabled, muted or switched. Silent tracks remain present. Do not apply stream egress advance to these local ISO files.
4. Bound ISO-enabled PCM frames to 480 samples (10 ms at 48 kHz) after
   timing correction and padding. FFmpeg's shortest-input handling can
   discard a whole packet crossing video EOF; its default 4,096-sample
   frames can otherwise lose about 85 ms of the captured tail. Preserve
   AAC stream filters, ISO-off behavior and the narrow timing diagnostics.
   Cover an active-tone Stop and an encoded truncated-audio negative at
   both 30 and 60 fps.
5. For ISO-enabled local VideoToolbox recording bridges, including the
   existing shared record-and-stream fallback, add
   `ceil(fps * negative_residual_ms / 1000)` encoded access units to the
   existing 16-unit admission budget, clamping residual magnitude to the
   supported 1,000 ms limit. Advancing live audio requires future samples;
   FFmpeg consequently consumes video behind capture. Retain that bounded
   encoded lookahead without retaining raw/Metal frames or changing audio
   filters, dedicated-stream policies, ISO-off behavior or no-progress
   deadlines. The shared fallback already uses recording admission and the
   same residual audio shift, so it needs the same bounded allowance. Verify
   admission/failure boundaries at 30/60 fps and decode -1,000 ms local and
   forced-shared-stream production artifacts with timing checks unchanged.
6. Use the existing 4 KiB encoded-video probe budget for an ISO-enabled
   shared recording/streaming input. The 64 KiB shared-stream default can
   postpone startup until Stop for short, low-complexity takes and stall all
   audio taps. Preserve the ISO-off streaming probe contract and verify both
   the three local artifacts and the received stream.

Stop-boundary clarification from implementation review: a negative microphone
offset advances its last available sample before video Stop; the remaining
microphone tail is intentionally silent, since capture must not extend past
the committed source boundary. System audio at offset zero must retain every
pre-Stop sample even when the common negative shift delays those samples
inside the bus. Flush that buffered content without pacing during global
Stop, keep the existing drain deadline, and prevent future source samples
from entering the tail. For early role removal, preserve its own boundary
while other outputs continue. Verify against source-clock expectations as
well as Combined, since comparing two equally truncated files can pass.

**Regressions:** offsets −120, 0 and +120 ms; min/max supported microphone offsets; system on/off, no selected microphone, muted mic, non-default gains, stereo system content and a live toggle. Verify decoded impulse placement against the intended offset for each source and against Combined. Detect both omitted correction and double correction.

**Verify:** `cargo test -p videorc-backend source_iso`, `cargo test -p videorc-backend session_audio::mix_tests`, `pnpm test:scripts` and the S8 runtime artifact scenarios pass. These tests must compare content timing, not just `start_time` or equal file lengths.

### S6: End only the role whose required source is removed

1. Derive removal from authoritative committed source selection / scene state, and terminal capture health through the existing recovery policy. A temporary missing frame, an uncommitted scene change or normal source replacement preparation is not removal.
2. Preserve the intended distinction: hiding a layer in the composed scene may leave its selected source recording in ISO; Camera Off/Screen Off that removes the selected source ends that role. A window remains the Screen role.
3. Send the role owner a stop cause and boundary time, stop further publication/encoding for it, close only its tap, drain and finalize it exactly once, and persist a clear “ended because source was removed” outcome. Do not wait for the global Stop. Combined, the other ISO and streams continue.
4. Re-adding the source does not silently append/restart a new segment in the same file. Keep the ended state visible until the next session. Starting another segment is a separate product feature.
5. Extend take expectations with persisted role start/end/outcome where necessary. Healthy, uninterrupted takes still require all armed roles and bounded duration spread. Intentional early completion is validated against its recorded end; unexplained truncation cannot pass as source removal. Without such explicit expectations, keep the real-take CLI strict.

**Regressions:** remove camera, remove screen/window, remove while Stop is pending, remove during source replacement, source re-added afterward, hidden-but-selected camera, ordinary scene transition and physical capture failure after its existing recovery budget. Verify remaining output frames advance, removed role stops at its boundary, durations reflect actual media, and its explanation survives restart.

**Verify:** `cargo test -p videorc-backend source_iso`, `cargo test -p videorc-backend live_source_switch`, `cargo test -p videorc-backend compositor::scene_switch_tests`, and `node --test scripts/lib/separate-source-take-gates.test.mjs` pass; run the corresponding S8 source-removal artifact scenarios.

### S7: Make production role metadata and acceptance agree

1. When ISO is enabled, stamp Combined's real audio track with both `title=Mix` and `handler_name=Mix` at the output metadata boundary. Keep its internal microphone/mix identity and ISO-off metadata contract unchanged. Cover ordinary, split-output and simulcast muxer argument paths that can carry the Combined file.
2. Retain `System audio` and `Microphone` for the two ISO roles. Verify those values after ordinary MKV-to-MP4 finalization; do not fix the problem by accepting Combined's `Microphone` tag as interchangeable with Camera.
3. Add a real production-argument/remux metadata test. Keep title checks distinct from decoded-source checks: correct labels alone never establish correct routing. Remove the fixture's ability to mask a production metadata discrepancy by supplying its own authoritative expected tags.
4. Ensure the CLI supports S6's explicit interrupted-role expectations without relaxing default healthy-take validation. Preserve cross-platform sibling-path handling and `--` passthrough.

**Verify:** `node --test scripts/lib/separate-source-take-gates.test.mjs`, `cargo test -p videorc-backend source_iso`, and `pnpm --filter @videorc/desktop test -- src/renderer/src/lib/separate-source-recordings.test.ts src/renderer/src/lib/session-params.test.ts src/shared/backend-rpc-contract.test.ts` pass. `pnpm smoke:separate-source-take -- <actual-combined-file>` passes on both production MKV and finalized MP4 siblings; swapped labels and swapped content remain failing cases.

### S8: Close the production lifecycle and device acceptance gaps

1. Keep the existing CPU/Metal pixel and audio-bus fixture as a focused check. Make its source frames vary by tick so a frozen first frame cannot satisfy its assertions. The routing-only audio fixture must coordinate producer delivery and render admission explicitly, under `cfg(test)`, rather than rely on a wall-clock playout margin. Install readiness before render starts; wait without shared locks, bound both waits and producer lookahead, allow packet/chunk overlap, and release on Stop. Retain amplitude, exact summed samples, stereo routing and zero-drop assertions; preserve independent real-time capture tests.
2. Add a maintained no-device runtime smoke, exposed as **new** `pnpm smoke:separate-source-runtime`, that feeds deterministic changing sources and timed audio through the production session orchestration, bridges, muxer args, Stop and finalization. Controlled capture adapters are acceptable; offline encoding of dumped frames cannot replace the production writer path. Wire it into recording-studio gates and test the command wiring.
3. Exercise healthy start/stop, delayed preparation per role, negative/positive sync offsets, startup cancellation, failed bridge with muxer exit zero, source removal and process interruption/restart against a temporary database/output directory. For process interruption, kill only the smoke-owned backend, clean up its known children and check recovered role rows/artifacts. Persist a small JSON manifest of expected role intervals, terminal causes, event times and measured verdicts beside the evidence.
4. Validate 1080p30, 1080p60 and 4K30 runtime takes, plus an ISO-on dual-orientation stream to local test receivers. Analyze each file independently and verify Combined/stream composition remains composed. Keep the full shipping-profile recording-matrix gate unchanged.
5. Extend record-latency coverage with ISO-on startup and Stop using the maintained fixture or a permission-enabled packaged app. Existing budgets remain the decision point: warm start p95 350 ms, cold start 1000 ms, Stop-to-idle p95 300 ms, short-clip background finalization p95 5000 ms. Verify completion of every armed export; the first role finishing is not whole-take finalization. Read current constants before implementation and do not raise them to make a regression pass.
6. Run the aggregate gates below and record build SHA, host, commands, durations, verdicts and evidence locations. Finish with a permission-enabled packaged camera+screen/window+mic+system take, import the files into an editor, and confirm content alignment. Device permission blocks leave device acceptance explicitly open; a green fixture cannot close it.

**Verify:** new `pnpm smoke:separate-source-runtime`, existing `pnpm smoke:separate-source-fixture`, real-take CLI, and all applicable final gates pass. Include at least one deliberate timing shift, premature EOF and swapped-audio negative control; each must exit nonzero for the intended reason.

## Final gates and evidence

Use Node 24.x, the repo-pinned pnpm 11.0.9, Rust stable and the appropriate FFmpeg tools. Install dependencies normally in the isolated implementation worktree (`pnpm install --frozen-lockfile`); symlinking its entire `node_modules` from another checkout fails a deliberate Windows bundled-tool containment test.

| Gate                                                             | Required result                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `cargo fmt --check --all`                                        | Exit 0                                                                                           |
| `cargo clippy -p videorc-backend -- -D warnings`                 | Exit 0; identify any baseline issue separately                                                   |
| `cargo test -p videorc-backend`                                  | Entire suite passes                                                                              |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`               | Exit 0                                                                                           |
| `pnpm --filter @videorc/desktop test`                            | Entire desktop suite passes                                                                      |
| `pnpm test:scripts`                                              | Entire Node suite passes in a correctly installed checkout                                       |
| `pnpm build`                                                     | Desktop build succeeds                                                                           |
| `pnpm smoke:separate-source-fixture`                             | CPU + Metal content/audio/artifact checks pass                                                   |
| New `pnpm smoke:separate-source-runtime`                         | Production timing, cancellation, failure, source removal and recovery scenarios pass             |
| `pnpm smoke:recording-studio`                                    | Full studio aggregate passes                                                                     |
| `pnpm smoke:record-latency` and `pnpm smoke:record-latency:gate` | ISO-off and added ISO-on evidence meet unchanged applicable budgets                              |
| `pnpm smoke:recording-matrix`                                    | Shipping profiles, color/fps/container and hard-content cases pass                               |
| `pnpm probe:preview-lifecycle`                                   | Preview restart/ownership remains healthy after compositor/start changes                         |
| `pnpm smoke:recording-studio:devices`                            | Pass on permission-enabled macOS; otherwise name the blocked cases and retain pending status     |
| `pnpm smoke:separate-source-take -- <combined-file>`             | Actual healthy camera take passes; role-aware shortened takes match explicit expected boundaries |

Run `pnpm probe:preview-window` if placement/move/resize changes become necessary. Run remote-control or remote-LAN smokes if their production surfaces are touched. Normal CI advisory gates remain required; do not waive them through this plan.

On Windows, AGENTS.md requires affected async/process filters at least 25 times and the full Rust suite three times from PowerShell 7. At minimum repeat `source_audio_tap` and the portable lifecycle/recovery tests introduced here; include any additional changed filters. Check `$LASTEXITCODE` after every invocation. macOS repetitions do not substitute. Hardware-specific macOS tests stay properly platform-gated.

Review baseline, not new acceptance evidence:

- 58 focused desktop tests and 22 focused Rust tests passed on the reviewed SHA.
- Existing CPU/Metal source fixture passed, including decoded audio-source checks.
- Node: 1,951/1,952 passed; one dependency-root symlink containment failure in the review worktree. The corresponding check passed in the original checkout.
- [Windows startup incident diagnostics](https://github.com/TheOrcDev/videorc/actions/runs/37589317704/job/112686843425) failed on freezes and A/V tails on the unchanged reviewed PR head. Causality was not established. The separate [Windows source gates](https://github.com/TheOrcDev/videorc/actions/runs/37589317704/job/112686843738) passed on that head. New-head stability evidence is still required; do not silently call the whole CI result green.
- The PR reports dev-camera TCC limitations. Real packaged ISO-on device acceptance and complete production start/failure coverage remain outstanding.

## Done criteria

- [ ] F1–F8 each have a passing regression that would fail the reviewed implementation.
- [ ] Cancellation leaves no unmanaged role child/bridge/FIFO, including before readiness and after construction of pending active state.
- [ ] A bridge failure plus muxer exit zero cannot yield a successful role verdict.
- [ ] All armed roles are durable before capture, visible after interruption, and recovered idempotently without adopting unrelated media.
- [ ] Production-encoded event timing meets the common-origin tolerance at 30/60 fps and respects negative/zero/positive audio offsets exactly once.
- [ ] Confirmed source removal ends only its role, with a persisted cause and truthful duration; ordinary transitions do not end it.
- [ ] Healthy production MKV and MP4 takes pass metadata, routing and artifact gates; negative controls fail.
- [ ] ISO-off defaults, native preview, Combined/stream composition and existing latency budgets pass their regressions.
- [ ] Required Windows 25/3 stability evidence and macOS device evidence are recorded, or acceptance is explicitly left incomplete with the exact blocker.
- [ ] Plan 157's implementation notes and this plan/index accurately describe completed work and remaining acceptance. Review diffs contain only intended scope; generated media, tokens and app databases are not committed.

## Escalation conditions and maintenance

Continue independent slices when a gate is externally blocked; do not reinterpret missing evidence as approval. Report the specific blocker before dependent acceptance. Revise this plan if the live implementation has materially different ownership or clock semantics, if shared startup cannot meet existing latency budgets, or if recovery would require claiming files without validated ownership. Do not work around these by weakening timing gates, inventing success statuses or silently disabling ISO.

## Execution evidence (2026-10-07, in progress)

Implementation checkout: `/tmp/videorc-pr632-review`, branch `codex/pr632-plan158`, based on PR head `b9ee699c82ddc58c4220d5ae32b5a1b8341fa713`. The owner's shared checkout is untouched by source implementation. Dependencies were installed with the frozen lockfile; Node 24 and pnpm 11 are used for verification.

Reviewer-run baseline gates, before the new runtime smoke and script changes:

| Command                               | Observed result                                            | Local evidence                              |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `pnpm typecheck`                      | Passed                                                     | `/tmp/videorc-pr632-typecheck.log`          |
| `pnpm test:scripts`                   | 1,952 passed, none failed                                  | `/tmp/videorc-pr632-scripts.log`            |
| `pnpm --filter @videorc/desktop test` | 311 files; 3,412 passed, one skipped                       | `/tmp/videorc-pr632-desktop-tests.log`      |
| `pnpm build`                          | Passed                                                     | `/tmp/videorc-pr632-build.log`              |
| `pnpm lint`                           | Passed; existing `use-studio.tsx` React dependency warning | `/tmp/videorc-pr632-lint.log`               |
| `pnpm audit:js`                       | Passed; no known vulnerabilities                           | `/tmp/videorc-pr632-audit-js.log`           |
| `pnpm audit:rust`                     | Passed; 365 crate dependencies checked                     | `/tmp/videorc-pr632-audit-rust.log`         |
| Shadscan in `apps/desktop`            | Baseline score 37; commit floor 37                         | `/tmp/videorc-pr632-shadscan-baseline.json` |

These baseline results do not establish runtime timing, recovery, native-device acceptance, or the final changed-script verdict. Their relevant gates must be rerun after implementation. No new source acceptance is marked complete yet.

Interim implementation verification:

- Host: macOS 26.5.1 (25F80), arm64; Rust 1.98.0, Node 24.6.0,
  pnpm 11.0.9, FFmpeg 8.1.1.
- Full Rust suite passed: 80 native-helper tests, 3,170 backend tests and
  one wire integration test; 14 backend tests ignored. Compile took 90
  seconds and backend tests 37.1 seconds
  (`/tmp/videorc-pr632-rust-full.log`). This snapshot predates the latest
  offset-tail/recovery test additions, which need their final rerun.
- Full changed-script suite: 1,961 tests passed in 23.1 seconds
  (`/tmp/videorc-pr632-scripts-final.log`). Subsequent runtime-checker edits
  require another focused run.
- `pnpm format:check` and `cargo fmt --check --all` passed
  (`/tmp/videorc-pr632-format-final.log`, `/tmp/videorc-pr632-rust-fmt.log`).
- Independent decoding of the production runtime's third take confirmed
  MKV and MP4 video-event alignment within 33 ms at 30 fps, and exposed a
  150 ms Camera audio tail loss. After the drain correction, the fourth take
  had matching Combined/Camera decoded pulse edges and last active sample
  at 4.010 seconds in both containers. Evidence is under
  `/tmp/videorc-pr632-runtime-third` and `/tmp/videorc-pr632-runtime-fourth`.
  These narrow zero-offset runs do not establish the full offset matrix.
- The first full runtime attempt stopped at the routing analyzer: FFmpeg's
  equal-power stereo-to-mono downmix increased measured tone amplitude by
  `sqrt(2)`. The checker is being corrected to decode channels explicitly.
  No full-runtime pass is claimed.
- With explicit arithmetic stereo downmix, the zero-offset production
  runner passed both MKV and MP4 artifact verdicts, including decoded
  routing, timing and negative controls
  (`/tmp/videorc-pr632-runtime-quick-corrected.log`). This was a quick run
  against the previous test executable, not full-matrix acceptance.
- Follow-up review identified failed-row publication recovery, terminal
  Stop timing, bounded Windows fixture cleanup, ambiguous periodic timing
  stimuli, and residual-offset stop-tail coverage. These remain under
  implementation and verification; they are not waived by earlier passes.

App gates on the frozen production implementation (test matrix execution
still pending):

| Gate                                                        | Observed result                                                                                                                                                         | Local evidence                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `cargo build -p videorc-backend` with `CARGO_INCREMENTAL=0` | Passed, 93 seconds; subsequent launcher freshness build passed in 89 seconds                                                                                            | `/tmp/videorc-pr632-backend-build.log`         |
| `pnpm build:native-preview-addon`                           | Passed, 3.8 seconds                                                                                                                                                     | `/tmp/videorc-pr632-addon-build.log`           |
| `cargo clippy -p videorc-backend -- -D warnings`            | Passed, 15.5 seconds                                                                                                                                                    | `/tmp/videorc-pr632-clippy.log`                |
| `pnpm probe:preview-lifecycle`                              | Passed all 100 cycles and clean teardown; performance verdict `pass`                                                                                                    | `/tmp/videorc-pr632-preview-lifecycle.log`     |
| `pnpm smoke:record-latency:gate`                            | Passed five renderer-driven ISO-off cycles and artifact analysis. Cold Record 149 ms; warm Record p95 73 ms; warm Stop-to-idle p95 107 ms; warm finalization p95 233 ms | `/tmp/videorc-pr632-record-latency-gate.log`   |
| `pnpm smoke:record-latency`                                 | Passed five additional cycles; budgets also met. Cold Record 168 ms; warm Record p95 76 ms; warm Stop-to-idle p95 116 ms; warm finalization p95 224 ms                  | `/tmp/videorc-pr632-record-latency-report.log` |

All ten renderer latency artifacts passed their recording and startup gates.
These results establish ISO-off behavior; the expanded runtime runner must
still establish ISO-on budgets and completion of every armed export.

The expanded `source_iso` Rust filter subsequently passed 30 tests (one
ignored), including moving CPU/Metal compositor references, injected
post-publication database failure and repeatable identity recovery,
cancelled-start reaping, exact tap cutoffs, and a real-bus negative-offset
Stop drain that preserves buffered system audio while silencing unavailable
future microphone samples (`/tmp/videorc-pr632-source-iso-final.log`). The
latest full Node run passed 1,963 tests in 10 seconds. Late-start health and
immediate Off/Stop ordering checks are the final source refinements being
verified before the full runtime matrix.

The runtime's 72 ms latency cases backdate both controlled producers to
exercise a shared observed publication-to-presentation delay. Native camera
and screen `FrameHandle.captured_at` values currently describe frame-store
publication, not sensor acquisition; native camera sample PTS is diagnostic.
These cases therefore do not prove compensation for independent physical
device latency. Packaged-device and editor acceptance remains necessary.

Further full-matrix attempts identified two checker assumptions: microphone
capture intentionally centers stereo voice, while system audio retains its
channels; and audio coverage must use the committed Stop boundary rather
than the nominal end of a final held CFR video frame. The checker retains
independent routing, video-duration and source-clock sample assertions. A
constructor FIFO-collision regression also protects pre-existing resources
from failed-start cleanup. These refinements require a fresh full run.

Pre-push candidate verification:

- The full Rust suite passed 80 helper, 3,173 backend and one wire test
  (14 ignored), including the real-constructor collision regression. This
  run predates only the final create-new FIFO helper; an exact-source rerun
  is in progress (`/tmp/videorc-pr632-rust-final-full.log`,
  `/tmp/videorc-pr632-rust-prepush.log`).
- Exact-source strict Clippy and Rust formatting passed; Clippy took
  16 seconds (`/tmp/videorc-pr632-clippy-prepush.log`,
  `/tmp/videorc-pr632-fmt-prepush.log`).
- All 1,963 Node tests and the repository format check passed before the
  final boundary-checker refinement. Its final focused suite passed all
  38 tests, including rejecting truncated and silently padded stop tails
  at 30/60 fps (`/tmp/videorc-pr632-scripts-prepush.log`,
  `/tmp/videorc-pr632-format-prepush.log`,
  `/tmp/videorc-pr632-script-gates-prepush.log`).
- The final create-new transport review found no remaining ownership
  defect: it preserves parked Windows pipes under a single reservation
  lock and retains legacy recreation behavior for existing callers.
- The candidate is being pushed to start new-head Windows CI while the
  full runtime, studio/device and recording-profile gates continue.
  Neither those pending gates nor physical device acceptance is claimed
  complete by this push.

Commit `72da8da3` was pushed to PR #632. Its exact-source full Rust rerun
passed 80 helper, 3,173 backend and one wire test (14 ignored); compile took
4m03s and backend execution 37.29 seconds
(`/tmp/videorc-pr632-rust-prepush.log`). Pre-commit Shadscan was 37 against
baseline/floor 37 (`/tmp/videorc-pr632-shadscan-precommit.json`). The full
`pnpm smoke:recording-studio:devices` aggregate is now in progress in
`/tmp/videorc-pr632-studio-devices.log`; JavaScript PR CI has passed.

The aggregate passed all preliminary desktop/script/backend checks (1,964
Node tests), CPU/Metal scene-switch artifacts and the complete separate-source
CPU/Metal fixture. Its runtime passed both containers for normal, no-microphone,
muted, system-off, gain, stereo and silent cases, then stopped at the -120 ms
take: Camera held the same content marker across three frames around 2.7 s,
exceeding the existing frame-alignment allowance. Pulse-edge timing matched
across roles. Evidence is under
`/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-separate-source-runtime-T4RBSQ`.
This is under diagnosis; the remaining runtime and app/device gates have not
passed, and the tolerance has not been relaxed.

The held-frame investigation found test publishers retaining the preview
admission lock while publishing, unlike native callbacks. The corrected
`#[cfg(test)]` helpers retain a generation-owned shared store and release
admission before allocation/publication. Read-only review confirmed that
late callbacks cannot publish into replacement generations. Three maintained
focused -120 ms runs passed all unchanged checks in both containers, without
the repeat warning (`/tmp/videorc-pr632-minus120-corrected{1,2,3}.log`). The
original isolated rerun also passed, so contention is the supported mechanism,
not a deterministic before/after reproduction. The maintained quick mode now
accepts a validated integer offset in -1000..1000 and explicitly labels its
result partial. Full-matrix acceptance still requires the aggregate rerun.

The next aggregate passed frame markers but found Combined PCM ending
73 ms before Stop in a -120 ms take, while both ISOs covered it. The missing
interval was silent in that take. A minimized constant-tone artifact proved
the underlying issue at both 30/60 fps: FFmpeg `-shortest` discards an entire
4,096-sample PCM frame when it crosses video EOF, losing 76 ms of audible
content in the control. Splitting PCM frames into 480 samples after timing
correction and padding retained the complete 1.100-second tone. The fix is
scoped to ISO-enabled PCM outputs; AAC stream filters and ISO-off recording
are unchanged. The runtime now includes this encoded negative/control pair
and an active-tone Stop profile. Production runtime verification of this
refinement is in progress; its frame/time tolerances remain unchanged.

The active-tone and normal-duration -120 ms production takes subsequently
passed both MKV/MP4 checks. Combined retained the active system tone through
3.52 s for a 3.5297 s Stop boundary; the normal take retained PCM through
4.030 s for a 4.0260 s boundary. Terminal Stop-to-idle was 244.4/246.4 ms
(`/tmp/videorc-pr632-pcm-bound-{active-stop,normal-stop}.log`). The minimized
old-packet mux is diagnostic because FFmpeg sometimes retains its crossing
packet. The maintained negative instead deterministically truncates audio
to 1.024 s while preserving 1.100 s of video; it is rejected at both 30/60 fps.
The current full Rust suite passed 80 helper, 3,174 backend and one wire test,
with 14 ignored (`/tmp/videorc-pr632-rust-pcm-final.log`). Full runtime and
app/device acceptance remain pending.

The following aggregate passed the control profiles, -120 ms normal/active
Stop and +120 ms, then failed the -1000 ms limit with missing video frames
in all three roles. Capture producers kept advancing; the native encoder
output queue filled behind slow FFmpeg FIFO writes. Repeated packet-PTS gaps
and up to 772 ms queue age localize the loss downstream of capture. Smaller
shortest buffering and larger input queues did not fix it. A negative input
timestamp probe restored video cadence but failed decoded sample timing and
was rejected. The production correction and unchanged full-matrix gate are
still pending (`/tmp/videorc-pr632-studio-devices-pcm.log`).

CI for `72da8da3` passed macOS Rust, JavaScript, Linux and the Windows
installer. The Windows source stability loop failed on pass 11 in the audio
artifact fixture: Camera measured 440 Hz amplitude 0.4767 against expected
0.5, after exact Combined=sum-of-taps and zero tap-drop checks passed.
Fixture producer scheduling is under diagnosis; Windows 25/3 acceptance is
not complete. The separate Windows incident diagnostic also failed with
stream A/V tails of 114-231 ms and occasional repeated/dropped frames. That
job already failed on reviewed head `b9ee699c`; this records the failure,
not proof of an unchanged cause or a waiver of it. Current logs are
`/tmp/videorc-pr632-windows-{source,incident}-failure.log`.

The bounded encoded lookahead correction passed the maintained -1,000 ms
production take in both MKV and MP4, with unchanged video, decoded pulse,
source-clock envelope and Stop-tail checks. The real FFmpeg binary was used;
none of the rejected argument wrappers entered the tree. Coordinator cold
start was 340.8 ms, Stop-to-idle 224.2 ms and whole-take background
finalization 525.9 ms (`/tmp/videorc-pr632-minus1000-lookahead.log`, evidence
`videorc-separate-source-runtime-2ORlW4`). Strict Clippy and 33 focused Rust
tests passed (one ignored); the complete runtime matrix still needs rerun.

The next full production runtime run passed 28 MKV/MP4 take verdicts,
including both offset limits, controlled 72 ms latency and 1080p60. It then
failed 4K30 after 13 encoded Combined frames: all roles reported no retained
VideoToolbox target. Diagnostics recorded all 15 target-ring slots allocated,
14 peak encoder references and a CPU fallback publication, without encoded
output queue pressure. Code review confirmed that composition failure can
publish CPU-only fallback frames into a VideoToolbox-only path, which rejects
them. Transient target exhaustion is the supported cause; the precise Metal
error was not persisted. Native-target handling and full acceptance remain
open (`/tmp/videorc-pr632-runtime-lookahead-full.log`, evidence
`videorc-separate-source-runtime-OgfZ66`).

The native-target correction now retains the existing frame only for typed
ring-busy results. Held ticks do not advance frame history, scene receipts,
preview progress or published sequence; diagnostics preserve native backing
and output age and do not count an unrendered CPU frame. Releasing targets
allows both primary and auxiliary publication to resume. The routing-only
Windows fixture uses bounded delivery/render coordination armed after the
bus acknowledges its epoch, with original routing/amplitude assertions.
Read-only final review found no remaining defect in these paths. An initial
snapshot passed 35 focused Rust tests (one ignored); exact-source artifact
and full-suite verification is still pending after the final diagnostics
corrections.

Exact-source verification of the native busy/fixture fixes passed 35
focused Rust tests (one ignored), formatting and strict Clippy. The 4K
runtime then exposed a throughput failure instead of `NoTarget`: actual
Combined video ended at 3.133 s (94 frames), ISOs at 3.166 s (95), versus a
4.031 s boundary. Encoder submission averaged about 64 ms and bridge lag
reached 877 ms, with sub-millisecond FIFO writes and no encoded queue
pressure. Stop audio coverage correctly failed. Hardware selection and
native encoder timing are under investigation; this is not evidence that
changing duration tolerances is acceptable. The forced shared-stream
-1,000 ms case also failed: Combined retained 122 frames, but both ISOs
retained 77 with a stalled audio bus and up to 3 s of queued video. Its
muxer/fanout behavior remains under diagnosis. Evidence logs:
`/tmp/videorc-pr632-ring-4k-runtime.log` and
`/tmp/videorc-pr632-shared-minus1000-runtime.log`.

A one-option shared-stream experiment (64 KiB video probe to 4 KiB) passed
all local MKV/MP4 timing/content checks and the received stream, confirming
the probe stall. The scoped production rule and ISO-off regression are
implemented; strict Clippy passed (`/tmp/videorc-pr632-shared-probe4096.log`).
Native 4K diagnostics confirmed three hardware AVE encoders with speed
priority enabled. Both requested frame-delay values (one/two) are rejected
as unsupported; the two configurations failed alike. A subsequent lookahead-property experiment was also unsupported. Native
policy was not changed on the strength of an ignored setting or an
unverified throughput hypothesis.

The longer independent hardware controls confirmed the local throughput
limitation outside Videorc and its target ring. With 360 frames per encoder,
one hardware H.264 4K session reached 62.37 fps; three independent processes
reached 21.18–21.24 fps each. BGRA input converted to NV12 by FFmpeg reached
62.19 fps alone and 21.11–21.17 fps with three sessions. All owned children
exited successfully. The controls required hardware encoding, used 4K30,
8 Mbps, High 5.1, GOP 60, realtime/speed priority, no realtime input throttle
and null output. Evidence is `/tmp/videorc-pr632-vt-throughput/results-360.json`.
Together with native callback/FIFO measurements, this supports a host
throughput limit; it does not establish support on another device.

Unsupported lookahead/frame-delay requests and the low-latency experiment
were rejected. All experimental encoder properties and per-frame diagnostics
were removed. Resolution, fps, codec, target ownership and acceptance
thresholds remain unchanged. The full 4K acceptance gate remains blocked.
An explicit `VIDEORC_SOURCE_ISO_RUNTIME_SKIP_4K=1` diagnostic mode records
omitted coverage, prints PARTIAL and exits 3 even if all remaining cases
pass; the default aggregate still exercises 4K and cannot silently pass.

Final production source passed 36 focused Rust tests (one ignored), strict
Clippy, Rust formatting and runner formatting. The unwrapped real-FFmpeg
Shared -1,000 ms take passed MKV, MP4 and received RTMP content checks with
unchanged frame markers, decoded alignment, routing and audio-tail gates.
Its manifest confirms shared topology; cold start was 349.49 ms and terminal
Stop was 209.90 ms. The diagnostic selection printed PARTIAL PASS, persisted
omitted coverage and returned the required exit 3. Evidence:
`/tmp/videorc-pr632-shared-final-partial.log`, runtime `VCronz`.
The exact-source full Rust suite passed 80 helper, 3,178 backend and one
wire test, with 14 ignored (backend 37.64 s), recorded in
`/tmp/videorc-pr632-rust-followup-final.log`. Remaining runtime/app gates and
new Windows stability CI are pending.

Future writer additions must join the same origin and ownership protocol. Future source switching must preserve the distinction between committed removal and temporary unavailability. Future audio processing must retain the split between bus delays and whole-track correction. Future finalization/recovery changes must preserve per-role outcomes across crashes and retries. A test that only checks filenames, container durations or metadata is insufficient evidence for source routing, lip sync or complete output.
