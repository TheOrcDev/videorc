# Plan 158: Fix PR 632 separate-source timing, lifecycle and recovery

## Status and execution baseline

- **Status:** IN PROGRESS, 2026-10-07. Owner authorized full execution and pushing the fixes to [PR #632](https://github.com/TheOrcDev/videorc/pull/632).
- **Acceptance limitation:** Three simultaneous 4K30 hardware outputs fail the unchanged artifact gate on this Mac16,1 / M4 host. Sustained independent encoder controls reach about 21 fps per output. Remaining runtime and app/device verification is in progress; Windows source/audio stability passed on pushed `35b6f71d`. This plan is not fully accepted.
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
| S0    | Deterministic tap regression and lifecycle test seams           | —          | S      | Implemented; Windows 25-pass stability verified on 35b6f71d                |
| S1    | Cancellation-safe writer ownership through final commit         | S0         | M      | Implemented; Unix and Windows ownership regressions verified               |
| S2    | Per-role terminal verdicts preserve encoder/audio/muxer failure | S1         | M      | Implemented; full runtime acceptance pending                               |
| S3    | Durable role registration and idempotent crash recovery         | S2         | M      | Implemented; final acceptance pending                                      |
| S4    | Shared production start barrier and timeline                    | S1–S3      | L      | Implemented; native-latency and coordinated terminal output qualified     |
| S5    | Residual audio sync offsets on both ISO muxers                  | S4         | M      | Implemented; full offset matrix pending                                    |
| S6    | Confirmed source removal closes one role explicitly             | S2–S5      | M      | Implemented; 19 lifecycle cases pass, final rollback regression pending    |
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
6. Bound buffering on ISO-enabled local MKV outputs so an interrupted take
   contains decodable clusters during capture. Declare output packet
   flushing and a 500 ms cluster time limit at each local MKV boundary;
   preserve streaming destinations and ISO-off graphs. A header alone is
   insufficient. Verify real backend interruption and successful manual
   remux of all owned written roles. The crash fixture must establish
   actual decodable media with a bounded readiness check before killing
   its owned processes, rather than assume a fixed sleep proves durability.

**Regressions:** reopen a database after interruption before spawn, during recording, after role stop, after MKV close, during MP4 export and after MP4 publication but before DB commit. Check one row per role, correct `take_id`, artifact ownership, explicit partial failure and repeatable replay. Include one failed Camera with usable Combined+Screen, missing paths, existing-file collisions and one database-write fault.

**Verify:** `cargo test -p videorc-backend storage::tests`, `cargo test -p videorc-backend recording_finalization`, `cargo test -p videorc-backend resume_pending_recording_finalizations` pass. If DTOs change, run `pnpm typecheck` and shared-contract tests in S7 as well.

### S4: Establish one origin before any output consumes session media

1. Separate resource/encoder preparation from releasing the first session frame. Prepare the required Combined and ISO encoders under S1 ownership, then release them through one coordinator with a shared origin and a retained initial compositor/source snapshot. Wire compatible split/simulcast participants without changing their composition or stream offset policy.
2. Make audio epoch and video timestamps derive from that same origin. Each role must encode content from the correct session time. Do not rebase a later role's first live frame to zero while leaving its audio at the original epoch; do not repair this with a guessed constant delay or by labeling newer content as old content.
3. Account explicitly for the FIFO dependency: muxers open/probe audio before encoded video. “All muxers have consumed video” cannot be a prerequisite to releasing an audio epoch they need to reach that state. Encoder preparation and output-writer readiness must be distinct; allow transport threads to wait independently and bound the whole startup.
4. Preserve discontinuities and duration on overload using existing bridge policy. Transport-specific rebasing must not erase offsets from the shared origin. ISO-off must continue on its existing optimized start path.
5. Add a time-varying source fixture whose visual frame identity and audio impulses share a known capture clock. Hold each participant at a deterministic preparation gate in turn, including a delay longer than the former expected startup skew, then release it. Test both first content and late-session events.
6. Distinguish temporary native target-ring exhaustion from other GPU failures. For a VideoToolbox recording consumer, keep the previous usable native frame during that bounded busy condition and preserve explicit diagnostics; do not replace it with CPU-only fallback or republish stale content as fresh. Keep the ring cap and failure/stall contracts, retain normal behavior for other consumers, and prove resumed composition after target release. The 4K artifact gate must still reject unacceptable held frames.

7. Keep ISO-enabled bridge frame selection anchored to the shared content epoch at every CFR tick. A sequence change alone must not make an older content timestamp acceptable after a held compositor tick. Wait for suitable content only inside the remaining CFR interval and existing encoder headroom; on expiry retain the honest held/latest frame, without resetting origin or compressing time. Preserve ISO-off selection, capture-latency calibration, held-screen normalization and overdue/Stop bounds. Prove rejection of a newer-but-stale frame, re-alignment after publication, 72 ms capture latency and bounded stalled-source fallback with deterministic tests.

8. Commit one ISO-enabled global Stop instant before requesting audio or
   video teardown. Share it with Combined and both role supervisors, with
   earlier committed source removal retaining precedence. Graceful video
   Stop must submit the bounded remaining CFR interval through that
   content-time boundary before draining its existing encoded/FIFO work;
   otherwise native capture latency becomes a missing audio tail under
   `-shortest`. Only pre-Stop eligible content or an explicitly held eligible
   final frame may cover that tail. Keep immediate cancellation for startup
   aborts, failures and uncommitted Drop, preserve ISO-off behavior, and
   retain the existing teardown and latency budgets. Reaping must not
   accidentally replace a graceful request with immediate cancellation.
   Add deterministic boundary/count/deadline tests and a 72 ms native-latency
   active-tone Stop artifact at 30/60 fps. Do not move the analyzer boundary
   to match an already shortened recording.

9. Coordinate ISO-enabled local selection by completed compositor batch
   and CFR index. The compositor already samples sources once per tick,
   but sequential publication lets independent readers choose opposite
   sides of an update. Publish a completed batch only after Combined and
   active ISO legs finish that tick; preserve every role's capture and
   presentation metadata. The first local reader latches a batch for its
   CFR index under the existing content floor and deadline, and the other
   local readers use that same batch. Dedicated stream output is excluded.
   Bound ownership to two indexed latches plus one latest completed batch:
   no more than three distinct pinned native slots per role within the
   unchanged five-slot-per-role/fifteen-slot global ring limits. Use actual
   native in-flight leases, not merely frame `Arc`s, and account them in
   existing retention diagnostics. A reader beyond bounded history must
   report terminal lag rather than retain unbounded frames. Retiring a role
   removes its membership; failures/removal cannot stall survivors. Busy
   native rings may retain honest prior content but must not publish it as
   fresh. Release cached leases during teardown. Verify readers straddling
   publication, role retirement, eviction, exact lease release, 60 fps
   artifacts and native pressure; do not widen timing or stop budgets.
   The three-slot coordinator bound does not itself prove native headroom:
   include startup, selected writer and older callback-held targets in the
   distinct retained-target accounting. Exercise three coordinator-held
   plus two encoder-held targets, then prove callback release permits
   progress without growing the ring. Frame zero must use one completed
   batch too. Keep leases continuous through submission, avoid waits under
   coordinator locks, and fence publication after membership retirement.

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
6. Build ISO scenes from confirmed selected-source authority independently
   of the Combined layout. CameraOnly omits the Screen node and ScreenOnly
   omits Camera entirely; absence from that composition is not source Off.
   Keep the hidden selected source publishing until committed removal,
   retain its canonical identity and orientation, and exercise real preset
   scene construction in both directions. Coordinated batch membership must
   not confuse layout omission with role retirement.
7. Include active ISO demand in source retirement and capture-health
   consumption, not only the visible primary/auxiliary scenes. Recheck
   confirmed demand at actual stop admission, including delayed camera
   retirement, so a layout cleanup cannot stop a newly armed ISO producer.
   Explicit Off, retired roles and ISO-off retain ordinary cleanup behavior.
   Keep lock ordering and source-transition ownership intact. Regress
   hidden Screen and Camera through real layout commits and continued
   publication, plus cleanup after ISO Stop.
8. Apply the same demand union to startup. Hidden-layout ISO starts are
   eligible by selected source IDs, but scene-node-only startup requirements
   can miss an idle-retired selected source. Restore required ISO sources
   through the existing native admission/readiness helpers before releasing
   the shared barrier. Keep ISO-off behavior and explicit startup failures.
   Regress CameraOnly with Screen initially stopped and ScreenOnly with
   Camera initially stopped; a fixture that preinstalls both producers is
   insufficient startup evidence.
9. Reconcile physical source consumers after global ISO Stop or role failure.
   Existing cleanup runs only on layout/source commits; preserving a hidden
   ISO producer must not leave it running indefinitely afterward. Retire
   terminal batch demand first, then use fresh primary/aux/preview and
   current ISO demand under existing startup/source admission. Stop has
   invalidated the old layout intent, so do not reuse its retirement token.
   Protect new recordings, pending visible layouts and active streams.
   Regress actual terminal hooks rather than manually invoking cleanup only.

**Regressions:** remove camera, remove screen/window, remove while Stop is pending, remove during source replacement, source re-added afterward, hidden-but-selected camera, ordinary scene transition and physical capture failure after its existing recovery budget. Verify remaining output frames advance, removed role stops at its boundary, durations reflect actual media, and its explanation survives restart.

**Verify:** `cargo test -p videorc-backend source_iso`, `cargo test -p videorc-backend live_source_switch`, `cargo test -p videorc-backend compositor::scene_switch_tests`, and `node --test scripts/lib/separate-source-take-gates.test.mjs` pass; run the corresponding S8 source-removal artifact scenarios.

### S7: Make production role metadata and acceptance agree

1. When ISO is enabled, stamp Combined's real audio track with both `title=Mix` and `handler_name=Mix` at the output metadata boundary. Keep its internal microphone/mix identity and ISO-off metadata contract unchanged. Cover ordinary, split-output and simulcast muxer argument paths that can carry the Combined file.
2. Retain `System audio` and `Microphone` for the two ISO roles. Verify those values after ordinary MKV-to-MP4 finalization; do not fix the problem by accepting Combined's `Microphone` tag as interchangeable with Camera.
3. Add a real production-argument/remux metadata test. Keep title checks distinct from decoded-source checks: correct labels alone never establish correct routing. Remove the fixture's ability to mask a production metadata discrepancy by supplying its own authoritative expected tags.
4. Explicitly declare the configured nominal video rate on ISO-enabled local MKV stream-copy outputs. Short MPEG-TS probing must not make Matroska infer its default frame duration from a transport-clock tick when native H.264 omits VUI timing. Preserve encoded packet payloads and PTS/DTS, configured profile, stream destinations and ISO-off behavior; cover Combined, sibling and shared/split argument placement. Verify actual 30/60 fps MKV/MP4 metadata without weakening analyzer checks.
5. Ensure the CLI supports S6's explicit interrupted-role expectations without relaxing default healthy-take validation. Preserve cross-platform sibling-path handling and `--` passthrough.

**Verify:** `node --test scripts/lib/separate-source-take-gates.test.mjs`, `cargo test -p videorc-backend source_iso`, and `pnpm --filter @videorc/desktop test -- src/renderer/src/lib/separate-source-recordings.test.ts src/renderer/src/lib/session-params.test.ts src/shared/backend-rpc-contract.test.ts` pass. `pnpm smoke:separate-source-take -- <actual-combined-file>` passes on both production MKV and finalized MP4 siblings; swapped labels and swapped content remain failing cases.

### S8: Close the production lifecycle and device acceptance gaps

1. Keep the existing CPU/Metal pixel and audio-bus fixture as a focused check. Make its source frames vary by tick so a frozen first frame cannot satisfy its assertions. The routing-only audio fixture must coordinate producer delivery and render admission explicitly, under `cfg(test)`, rather than rely on a wall-clock playout margin. Install readiness before render starts; wait without shared locks, bound both waits and producer lookahead, allow packet/chunk overlap, and release on Stop. Retain amplitude, exact summed samples, stereo routing and zero-drop assertions; preserve independent real-time capture tests.
   - Keep the controlled source's sample cursor, visual marker and captured timestamp on one scheduled capture clock. Record delivery/publication separately; delayed timer callbacks must not relabel older samples as newly captured. Preserve queued PCM and the explicit video capture-latency offset.
   - Decode the wrapping blue content marker from an identified screen region in Combined, rather than averaging different sources across a counter wrap. Preserve the existing whole-frame pulse/composition checks and protect the fixture-layout assumption.
   - Treat 10 ms tone measurements as intervals in the envelope check. Exclude only windows intersecting the unchanged transition tolerance; keep the strict ordered-event timing gate. Add 30/60 fps partial-window regressions, out-of-budget shifted-event negatives and retain encoded truncated-audio negatives. Do not increase the frame-plus-10-ms timing budget.
   - Refine coarse audio-edge candidates from decoded samples before strict
     ordered-event comparison. A window's left edge is not the actual tone
     transition. Refinement must use audio evidence alone, distinguish
     frequencies in offset mixed tracks and account for AAC artifacts;
     never snap candidates to video times or expected offsets. Verify
     arbitrary sub-window phases, mixed tones, encoded AAC and early/late
     changes just outside the unchanged 30/60 fps budgets.
     Keep every measurement-confidence diagnostic. The ordered-event gate
     applies confidence over exactly the audio interval it already consumes:
     first/last checked shifted video edges plus/minus its unchanged tolerance.
     A failed candidate whose possible audio-only edge interval intersects
     that interval remains fatal; global measurement failures remain fatal.
     This applicability check must not change the estimator, snap an edge,
     discard measured events, or weaken startup envelope, Stop coverage,
     active-tone or tail checks. Add crossing-uncertainty negative controls.
2. Add a maintained no-device runtime smoke, exposed as **new** `pnpm smoke:separate-source-runtime`, that feeds deterministic changing sources and timed audio through the production session orchestration, bridges, muxer args, Stop and finalization. Controlled capture adapters are acceptable; offline encoding of dumped frames cannot replace the production writer path. Wire it into recording-studio gates and test the command wiring.
3. Exercise healthy start/stop, delayed preparation per role, negative/positive sync offsets, startup cancellation, failed bridge with muxer exit zero, source removal and process interruption/restart against a temporary database/output directory. Provide an explicit diagnostic collect-failures mode for independent cases: retain owned-process cleanup, persist each failure, continue remaining cases, and return failure if any case failed; default fail-fast behavior and all acceptance thresholds remain unchanged. For process interruption, kill only the smoke-owned backend, clean up its known children and check recovered role rows/artifacts. Persist a small JSON manifest of expected role intervals, terminal causes, event times and measured verdicts beside the evidence.
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

The complete runtime diagnostic on pushed `35b6f71d` stopped after seven
successful MKV/MP4 take verdicts at the system-audio-off case. Camera video
fell one frame behind after a held tick; Camera and Combined microphone
samples agreed, and capture/encoder diagnostics showed no re-anchor or
queue pressure. A 1.767 s video event corresponded to audio near 1.721 s,
exceeding the unchanged one-frame-plus-10-ms criterion. Freshness-only
bridge selection accepts a newer sequence even when its content remains
behind the shared CFR tick. S4 now includes bounded content-time selection
and deterministic held-tick re-alignment regressions. This acceptance
failure is open; the diagnostic run did not reach its expected partial exit.
Evidence: `/tmp/videorc-pr632-runtime-remaining-final.log`, runtime `zxEmx7`.

The follow-up was pushed as `35b6f71d` after the full Rust pass and a
Shadscan score of 37 (baseline/floor 37). Its JS CI passed; Rust/Linux/
Windows CI was still running. The required shipping-profile recording
matrix passed 17/18 cases: all normal profiles, 1080p60 and 4K30 hard
content, and 4K30 transient FIFO pressure. Its final 1080p30 shared-pressure
case failed before recording because the app did not establish backend and
preview readiness within 90 seconds. That case requires a focused rerun;
the aggregate is not marked passed. Evidence:
`/tmp/videorc-pr632-recording-matrix-final.log`, report directory
`videorc-recording-matrix-1791385081628`.

The S4 selector correction now requires content suitable for the shared
CFR tick on ISO-enabled bridges. It uses stored presentation time for
held-screen normalization, retains calibrated capture latency, bounds waits
by the existing next-tick deadline minus encoder headroom, and adds no wait
when catching up. Initial-frame and ISO-off paths are unchanged. Deadline
misses are logged separately at teardown. Independent review found no
remaining defect; strict Clippy passed and three deterministic tests passed
for 30/60 fps re-alignment, delayed/held content and bounded Stop/deadline
fallback. Three system-audio-off real takes passed both MKV/MP4 with unchanged
artifact criteria (runtime `Ie0DTX`, `kTiuOc`, `iODaMb`). Evidence logs are
`/tmp/videorc-pr632-content-clock-system-off-{1,2,3}.log`. These are partial
quick selections; full runtime acceptance remains pending. The full Rust
suite on this exact source passed 80 helper, 3,181 backend and one wire
test, with 14 ignored (backend 37.13 s), recorded in
`/tmp/videorc-pr632-rust-content-clock-final.log`.

The next broad runtime passed the audio-event check that previously
failed, but stopped at one Combined/Screen marker mismatch at 3.367 s in
the system-audio-off take. All nine decoded pulse edges aligned across
roles. The fixture encodes marker time from a 10 ms timer iteration count,
while the timer's Burst behavior can advance that counter faster than wall
time after a delay. Bounded, test-only source/publication/selection timing
evidence is required to distinguish an invalid counter-time assumption
from a genuine early/late frame. Further production policy changes are
not justified yet. Strict content and timing criteria remain unchanged.
Evidence: `/tmp/videorc-pr632-runtime-content-clock-final.log`, runtime
`T2z5DV`.

The first three remaining maintained app gates passed on the selector
source: freeform editor (98 trusted gestures, landscape/portrait native
preview cadence and final recording artifact), captions transport contract,
and live caption mute/gain plus recording/RTMP artifacts and finalization.
Logs and exact commands are in `/tmp/videorc-pr632-studio-app-final/first-three.json`.
The full studio aggregate remains incomplete; these passes do not close the
separate-source timing or device acceptance gaps.

The first timestamp-traced take (`runtime-rqu4OZ`) reproduced an envelope
failure despite passing ordered events. Exact PCM starts at 1.528083333 s
and 3.328083333 s; matching video edges are 1.567/3.367 s, a 38.9167 ms
difference within the unchanged 43.3333 ms limit. Treating a partial 10 ms
tone window as a point at its start incorrectly reported 47 ms. S8 now
requires interval-aware envelope measurement plus unchanged strict event
and negative controls. The same trace shows 7.11–11.96 ms delivery spacing
for nominal 10 ms source-counter steps, confirming the need for one
scheduled capture clock. No additional production selection change is
supported by this evidence. Source-isolated blue-marker extraction is a
separate measurement correction; the earlier frame101 outlier persisted in
a screen-only pixel, so averaging alone was not its cause.

The coherent-clock 30 fps take passed both containers and all unchanged
gates (`runtime-SyZcgw`). Capture steps are exactly 10 ms despite delivery
lag up to 4.658 ms. The next 60 fps take exposed a real MKV metadata defect:
Combined and Screen reported `avg_frame_rate=30000/1`, although all three
files decode 242 frames with correct alternating 16/17 ms PTS gaps and
`r_frame_rate=60/1`. Their final MP4s report 60 fps. Native SPS timing-info
is absent for all three roles; level 4.2 and BT.709 remain correct.
Bad MKVs use an 11,111 ns default duration (one 90 kHz transport tick),
while Camera uses 16,666,666 ns. Remuxing with output-only `-r:v 60` fixes
that metadata and preserves all 242 packet PTS, DTS and SHA256 payload
hashes exactly. S7 therefore includes an explicit nominal-rate declaration
for ISO-enabled local MKV stream-copy outputs. No native timing or analyzer
tolerance change is justified. Evidence: `runtime-VFwMV4`,
`/tmp/videorc-pr632-coherent-system-off-60.log`.

The nominal-rate correction passed actual 60 fps MKV metadata checks for all
three outputs (`runtime-SRkNtp`). The unchanged marker check then found one
Camera frame 40 ms behind Combined/Screen during a publication transition;
the previous permanent phase debt is gone, but this transient mismatch
remains open. The native-latency 60 fps take (`runtime-JkmLyu`) passed
metadata, markers and ordered events, then failed terminal coverage: media
ends near 4.033 s against a committed Stop boundary of 4.093597 s. The bridge
paces from barrier release while audio uses the earlier content epoch.
Immediate video Stop therefore leaves an unsubmitted terminal interval,
and `-shortest` clips audio to that video endpoint. Preserve the committed
boundary and existing budgets; bounded terminal video submission plus a
native-latency active-tone Stop regression is required. Rebasing the
analyzer to the shorter output is not an acceptable fix.

The diagnostic runner now supports explicit
`VIDEORC_SOURCE_ISO_RUNTIME_COLLECT_FAILURES=1`: independent profile,
lifecycle, crash and latency cases continue after owned-child cleanup,
with per-case and aggregate failure evidence. Any collected failure forces
exit 1, taking precedence over partial-coverage exit 3. Default fail-fast
behavior remains unchanged. Review caught and corrected swallowed
interruptions and timeout-over-interrupt precedence; interruptions remain
fatal. The complete Node suite passed 1,969 tests and format checks passed
before those narrow interruption corrections; focused verification follows.
Evidence: `/tmp/videorc-pr632-scripts-collector-final.log` and
`/tmp/videorc-pr632-format-collector-final.log`.

The corrected nominal-rate argument regression passed for record-only,
shared and split graphs. The real Shared 60 fps take passed both MKV/MP4
and received-stream content checks (`runtime-p1Nn6T`). Its received FLV
reports 60/1 nominal rates, High 4.2 and 242 packets spanning 0.021–4.038 s
(59.995 measured fps). Evidence: `/tmp/videorc-pr632-nominal-rate-shared-60.log`.
Full Rust verification on this source passed 80 helper, 3,183 backend and
one wire test, with 14 ignored (backend 37.58 s), recorded in
`/tmp/videorc-pr632-rust-nominal-final.log`. This precedes the terminal
coverage and completed-batch selection fixes. Post-interruption-correction
Node tests passed all 16 focused cases and targeted formatting passed.

On pushed `35b6f71d`, JS, Linux, macOS Rust and Windows installer CI passed.
Windows source/audio 25-pass stability and three full Rust-suite repetitions
passed on this pushed commit. The complete source/audio CI job subsequently
passed, including the remaining advisory and TypeScript checks. Incident
diagnostics failed again: controlled and independent FFmpeg-tone cases
report receiver tails, repeated frames/freezes and an interior-silence
failure. Evidence: `/tmp/videorc-pr632-windows-followup-incident.log`.
This remains a failed, out-of-scope gate, not a waiver or proof of an ISO
regression. These CI results do not cover the uncommitted follow-up.

The first complete collected runtime finished with 57 successful take
verdicts and ten failed cases (`runtime-f9NQCx`). The failures cover native
terminal coverage, delayed-start frame selection, a coarse audio-edge
measurement, five hidden/removal Screen cases and process interruption.
Cold/warm coordinator start p95 was 363.58/146.49 ms, Stop p95 246.44 ms,
and finalization p95 764.99 ms; latency passed. Exact decoded PCM proves
the native 60 fps interior edge differences are 24.979–25.000 ms, within
the unchanged 26.667 ms criterion; labeling a 10 ms window by its start
produced false 27 ms differences. The five Screen cases share a production
bug: CameraOnly removes Screen from the scene, although it remains selected.
Screen ISO then repeats one frame while its audio and Camera advance.

Process interruption recovered the durable rows and ownership but found
all three MKVs empty at the two-second crash point. A live observation
shows the first write occurs about 286 ms after that readiness receipt,
in 262,144-byte chunks (`/tmp/videorc-pr632-crash-live-3tunu8ed`). Independent
FFmpeg controls killed after three seconds distinguish the mux behavior:
default output remains empty; packet flushing alone writes a header but
no readable media; flushing plus a 500 ms cluster limit yields readable
video/audio after SIGKILL. Evidence:
`/tmp/videorc-pr632-mkv-flush-7a50_afk` and
`/tmp/videorc-pr632-mkv-cluster-jjvv2atx`. S3 now includes scoped local
durability options and actual decodable-media crash readiness. These
observations precede implementation and are not final acceptance passes.

The follow-up source now passes `cargo check --tests` and strict production
Clippy. Read-only review found no concrete blocker in completed-batch
selection, native lease ownership, shared terminal Stop, hidden selected
sources or local crash durability. These checks do not replace the pending
real recording rerun. Coordinator storage holds at most two indexed batches
plus the latest complete batch; writer, candidate and VideoToolbox leases
also count against the unchanged five-slot native ring.

Precise audio-only tone-edge measurement passed all 22 focused helper tests
and the full 1,975-test Node suite. Maintained real AAC controls passed
subwindow mixed-tone edges and separate edges only 4.708 ms apart, at both
30 and 60 fps. Controls accept offsets one millisecond inside the existing
budget and reject offsets one millisecond outside it in both directions.
No video timestamps, expected offsets or increased tolerance enter the
audio estimator. Evidence:
`/tmp/videorc-pr632-scripts-refined-final.log` and
`/tmp/videorc-pr632-refined-aac-subwindow-controls.log`.

After final runtime integration, the full Node suite again passed all 1,975
tests and formatting passed with 2,122 tracked text files checked.
Evidence: `/tmp/videorc-pr632-scripts-batch-final.log` and
`/tmp/videorc-pr632-format-batch-final.log`. These results precede a narrow
cleanup correction found in final review: signal cancellation must remain
active across manually owned crash-child readiness and receiver-listener
waits, rather than only while `run()` owns an FFmpeg/ffprobe subprocess.

The frozen Rust follow-up passed 50 focused tests (one ignored), including
completed-batch interleaving/history, native ring occupancy and real guard
release, hidden selected-source snapshots, terminal Stop boundaries,
ownership/recovery and the real audio artifact fixture. Evidence:
`/tmp/videorc-pr632-batch-terminal-focused-final.log`. Signal cleanup now
covers complete manual-child transactions, waits for all parallel probes
to retire, and observes crash-backend close from spawn. Real native-latency
and collected runtime artifact verification is now running.

The first follow-up native72 active-tone takes reach their committed Stop
boundaries: at 30 fps, all three videos and decoded audio reach 3.600 s
against Stop 3.596648 s; Stop-to-idle is 269.1 ms and finalization 957.4 ms.
At 60 fps all three MKV analyzers also pass. Both full case verdicts remain
failed at this point: the new estimator rejects startup or terminal edge
candidates outside the existing interior ordered-event domain. Saved PCM
contains an actual 21.333–30.000 ms startup zero interval, not merely AAC
ringing. The fixture explicitly attaches its controlled system source after
`start_session` returns; startup provenance and all diagnostics stay visible.
Qualify confidence over the existing consumed interior interval rather than
silently accepting an unmeasurable edge or changing a timing budget.
Evidence: `/tmp/videorc-pr632-native72-terminal-30.log` and
`/tmp/videorc-pr632-native72-terminal-60.log`.

After gate-specific confidence qualification, the native72 active-tone
30 fps rerun passed both MKV and MP4 decoded content, ordered timing,
envelope, routing, real Stop-tail checks and deliberate encoded negatives.
This is a successful focused take, explicitly partial matrix coverage,
not whole-plan acceptance. Evidence:
`/tmp/videorc-pr632-native72-terminal-30-qualified.log`.

The first full Rust run on this production source passed 3,191 backend
tests but failed the existing Camera None-to-A round-trip fixture because
its initial snapshot lacked confirmed source authority. The actual scene,
layout and revision remained identical. Initialize the fixture's selected
camera authority before the round trip; preserve whole-snapshot equality.
The final linked suite must be rerun before reporting a full Rust pass.
Evidence: `/tmp/videorc-pr632-batch-terminal-rust-full.log`.

Native72 active-tone 60 fps also passed both MKV and MP4 strict decoded
and negative-control verdicts after confidence qualification. Evidence:
`/tmp/videorc-pr632-native72-terminal-60-qualified.log`.

The maintained crash-only case passed with explicit partial exit 3:
all three live MKVs became decodable 794 ms after ownership receipt,
each exposing 16 video and 50 audio frames. Deliberate backend SIGKILL
followed by real restart recovery passed (`runtime-JvOfs3`). Interruption
at the explicit owned-backend spawn boundary, before the PID receipt,
also produced fatal AbortError and left no owned process group. This
used readiness evidence rather than a sleep or broad process scan.
Evidence: `/tmp/videorc-pr632-live-cluster-crash-final.log` and
`/tmp/videorc-pr632-crash-interrupt-owned-final.log`.

The complete remaining collected runtime is now running on frozen
production source, with the confirmed 4K host limit explicitly omitted.
Its executable precedes only the round-trip fixture initialization fix;
all production code matches the frozen tree. Any remaining case failure
must produce exit 1; an otherwise successful omitted-4K run produces
partial exit 3. Evidence:
`/tmp/videorc-pr632-batch-terminal-runtime-collected.log`.

The collected run finished with exit 1: 68 take-analyzer verdicts and
seven failed cases (`runtime-hBLyxF`). All selected profile timing, offset,
preparation and native72 cases passed; crash recovery passed. Remaining
failures are dual-stream Camera Off timeout, frozen Screen envelopes in
Screen Off/re-add/Window Off/negative-offset cases, hidden Screen freeze,
and hidden Camera fixture admission. No partial-pass claim applies to this
failed run.

Read-only diagnosis found the hidden-source production cause:
`live_layout::retire_unused_sources_after_commit` unions visible scene
needs only and stops Screen capture when CameraOnly omits it. The selected
ISO snapshot cannot fetch a producer that layout cleanup stopped. Hidden
Screen traces retain compositor sequence 12 in all three bridges; Screen
Off retains Screen sequence 10 until retirement frees the batch. S6 now
includes retirement and health demand for active ISO consumers, including
the delayed Camera cleanup boundary. The hidden Camera fixture separately
uses a fake screen ID rejected by ScreenOnly's native-source validation;
correct its canonical fixture identity rather than weakening admission.
The dual-stream timeout still needs separate diagnosis.

S6 retirement/health implementation now checks confirmed selection and
live batch membership, takes the existing session-start source-transition
admission fence, and rechecks demand before stopping a producer. The
delayed Camera path rechecks after its grace. Pure demand, real-layout
continued-publication/retirement and startup-fence race regressions were
added. Strict Clippy passes; focused relinking is in progress.
The full Node suite passes 1,978 tests and formatting passes, recorded in
`/tmp/videorc-pr632-scripts-retirement-final.log` and
`/tmp/videorc-pr632-format-retirement-final.log`.

Read-only startup review identified a related gap: both renderer and
backend eligibility allow hidden-layout ISO by selected IDs, while native
startup requirements still derive only from scene nodes. An idle-retired
selected ISO producer therefore needs explicit reacquisition through the
existing startup readiness path. This is S6 step 8, not a new refusal or
fallback policy. Production cleanup when ISO demand disappears must also
be checked independently of tests that manually invoke retirement.

That terminal cleanup check confirms a production gap: neither ISO
membership retirement nor finalization triggers physical source retirement.
Preview reconciliation owns compositor runs, and the renderer delegates
omitted preset sources to backend retirement. Global Stop invalidates the
previous layout intent, so S6 step 9 needs fresh fenced consumer
reconciliation. Explicit source Off already reaches its cleanup path.

The S6 follow-up now reacquires idle-retired selected producers before ISO
startup readiness, reuses matching live generations, and unions selected
roles into the capture cadence requirements. Failed/cancelled startup
retires only its own batch and schedules fresh consumer reconciliation
after startup admission unwinds. Role and global terminal paths invoke
the same reconciliation. Reacquisition also preserves the last admitted
protected-window exclusions. Compiler checking passes in 42.28 seconds
and strict Clippy passes in 22.94 seconds on this follow-up;
focused relinking, lifecycle recordings and final full Rust verification
remain pending. The previous focused relink was killed by SIGKILL before
tests ran and is not a test verdict. Read-only review found no blocker in
the runner's partial-mode, timeout or owned-process interruption handling.
The independent lifecycle review likewise found no additional blocker in
the startup guard, cadence union or terminal reconciliation hooks.

A subsequent cancellation audit found one late-start edge: the native
command can return `Starting` at its bounded reply deadline while its
process-owned transition continues. Immediate rollback reconciliation
skips that generation, so it must first await a transition-fence snapshot
captured synchronously at guard Drop. The wait holds no startup admission
and excludes newer tickets; reconciliation then checks fresh consumers.
That narrow fix and its regression remain pending on the current linked
candidate. Formatting and runtime runner syntax checks pass.

The pre-late-start-fix candidate passes all 58 focused ISO tests, with one
ignored maintained runtime fixture, in 4.37 seconds. Its focused
`dual-stream-camera-off` recording completes source Off, Stop and terminal
idle and passes the maintained artifact gates: one take verdict, no failed
case, explicitly partial coverage. Evidence:
`/tmp/videorc-pr632-startup-retirement-focused.log` and
`/tmp/videorc-pr632-dual-off-retirement.log`. Both MKV/MP4 and both RTMP
receivers pass, including survivor motion after removal. The earlier
timeout did not reproduce; its cause remains unproven. The remaining
lifecycle sweep and final exact-source relink
are still required.

The first lifecycle sweep qualifies 14 cases and reports five runner
cleanup failures from transient `EPERM` on the post-exit group zero-signal
probe. No backend/artifact failure was observed. Screen Off/re-add, Window
Off, hidden Screen/Camera and terminal physical-source retirement pass;
idle-hidden startup also produces healthy artifacts. The corrected poll
keeps the original three-second bound and accepts only `ESRCH` as absence;
real termination errors remain fatal. All 19 cases are being rerun before
final exact-source Rust verification. Evidence:
`/tmp/videorc-pr632-lifecycle-retirement-final.log` and
`/tmp/videorc-pr632-lifecycle-reap-final.log`.

The corrected lifecycle sweep now passes all 19 cases with zero failures,
covering both containers, hidden/idle-hidden startup, terminal physical
cleanup, Off/re-add/Window removal and negative-limit boundaries. Three
dual-stream Camera Off runs complete across the focused run and sweeps;
the earlier intermittent timeout remains causally unproven. Evidence is
`videorc-separate-source-runtime-5a5o5V`; exit 3 explicitly records
lifecycle-only coverage. This binary predates only the captured-transition
late-start rollback fix. Final compiler/lint and exact-source full Rust
verification are in progress before commit/push.

The final source now includes captured-transition late-start rollback
cleanup and its readiness-channel regression. `cargo check --tests`
passes in 45.09 seconds; `cargo fmt --check` passes. On frozen final JS,
all 1,978 Node tests pass in 19.57 seconds, with no skipped/cancelled tests,
and formatting/text integrity passes for 2,122 tracked files. Evidence:
`/tmp/videorc-pr632-scripts-exact-final.log` and
`/tmp/videorc-pr632-format-exact-final.log`. Final strict Clippy passes in
26.05 seconds (`/tmp/videorc-pr632-late-start-clippy.log`). Exact-source
full Rust remains the pre-push gate.

The exact-source full Rust compile was killed by SIGKILL after roughly
14 minutes with two build jobs; it emitted no Rust error and ran no tests.
This is not a suite verdict. A narrowly scoped kernel-log query produced
no matching kill/memorystatus diagnostics, so the cause remains unproven.
The exact gate is retrying with the previously successful single-job
setting, with optimization/debug/source unchanged. Evidence:
`/tmp/videorc-pr632-rust-lifecycle-final.log` and
`/tmp/videorc-pr632-rust-lifecycle-serial-final.log`.

The serial retry passes the exact-source full Rust gate: 80 helper tests,
3,201 backend tests and one wire test pass, with 14 ignored tests.
Compilation takes 21 minutes 20 seconds; backend tests take 38.90 seconds.
The late-start rollback regression and full-scene round-trip fixture both
pass. The qualified source is frozen for commit/push. Final collected
runtime, app/device gates and new-head Windows stability remain pending;
the measured three-output 4K30 hardware block is unchanged.

Future writer additions must join the same origin and ownership protocol. Future source switching must preserve the distinction between committed removal and temporary unavailability. Future audio processing must retain the split between bus delays and whole-track correction. Future finalization/recovery changes must preserve per-role outcomes across crashes and retries. A test that only checks filenames, container durations or metadata is insufficient evidence for source routing, lip sync or complete output.
