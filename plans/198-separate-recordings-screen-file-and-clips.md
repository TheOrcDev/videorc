# Plan 198: the Screen file dies at Record, and Clips loops after the take

**Status:** BUILT 2026-10-25 on `fix/198-screen-iso-startup` (S1–S5 done,
S6 local gates and smokes green; see [Execution notes](#execution-notes)).
Planned the same day from the owner's first real take with Separate source
recordings on (0.11.0, packaged app, this Mac). Owed: the owner's packaged
take (S6.4) and by-eye of the toast and the Library row in both themes.
**Priority:** P1, hotfix candidate. Both features shipped in 0.11.0
(Separate source recordings #632 `55c27f5d`, Clips #694 `c5033f62`). Clips
runs by default, so **every** user who turns Separate source recordings on
gets the Clips retry loop. **Size:** M: five small slices plus one acceptance
slice. **Planned against:** origin/main `61a045ce`. **Owner route:**
Diagnose (fit 9) owns S1 and S2, the recording behaviour. Implementation
(fit 8) owns S3 and S4. UI/Product Design (fit 9) owns S5. **Model lanes:**
S1 and S2 `fable-5`; S3 and S4 `gpt-5.5`; S5 `opus-4.8` with the
`videorc-design` skill.

## What the owner saw

Take `e4ad9e44-e968-4537-9489-50e6f3320b59` was a 15 s camera-in-screen take
at 4K30 with Separate source recordings on. It left two files instead of
three:

| File                    | Contents                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `…e4ad9e44….mp4`        | **Combined**: the screen with the camera inset, audio track "Mix". The owner took this for the Screen file. |
| `…e4ad9e44…-camera.mp4` | Camera alone + "Microphone" track. Correct.                                                                 |
| `…-screen.mp4`          | **Missing.** A 216 KB / 34 ms `-screen.mkv` was left in hidden `Recordings/.videorc-iso-d890b93d-…/`.       |

Nothing told the owner. The failure exists only as a Health-list event, plus
a Library row that reads "MP4 failed".

## Root causes (evidence: `~/Library/Application Support/Videorc/logs/backend.log` and `videorc.sqlite3`, read-only)

### 1. A recovery latch from an hour earlier killed the Screen file 12 ms into the take

- 16:57:51Z: screen capture delivered 0 callbacks (`screen_callbacks=0.0fps`).
  The coordinator force-restarted the screen twice (`capture-generation
generation=4/5 reason=force-recovery`). Verification then failed, so the
  coordinator latched `Failed` with `automatic_attempts_operator_latched`, scoped
  to the screen source.
- 17:25–17:28Z: eight recordings captured that same screen at 29 fps. The
  latch never cleared. This is by design: "A generic health edge … must never
  clear an explicit failure latch" (`capture_recovery.rs:1673`).
- 17:53:27.600Z: the take armed Screen + Camera. At 17:53:27.612Z, on the
  supervisor's first 10 ms tick, `supervise_role` asked
  `capture_recovery.source_failed_after_recovery(screen)`
  (`source_iso.rs:1195-1207`). The answer was **true**, from the stale latch,
  so the role failed with "Screen capture failed after source recovery". The
  bridge stopped, FFmpeg flushed 210 KiB and exited, and the row was saved as
  failed (`sessions` row `…-screen`: `finalization_state=failed`, 34 ms).
- The Combined writer kept recording the same screen for the whole take. The
  check is meant to end an ISO file when its source dies **mid-take**. It
  cannot tell an incident from before Record, because the coordinator is
  process-global and keeps its latch across sessions.

### 2. Clips buffer-only sessions arm Separate source recordings and are refused

- `start_session_with_timeline` raises `record_enabled = true` for a
  buffer-only session (`recording.rs:3598-3602`). Validation therefore passes,
  `armed_plan(&params.output)` arms the ISO legs (`recording.rs:3751`), and
  `output_path` is `None` because the session is replay-only
  (`recording.rs:3746`). The ISO start then bails with "Separate source
  recordings need a local recording path" (`recording.rs:5986`).
- Clips (#694) merged a day after #632. That merge never stripped the ISO
  settings from buffer-only starts.

### 3. The Clips give-up limit can never trigger

- A refused start publishes `Idle`, "the authoritative terminal replacement
  for Starting" (`recording_start_rejected_status`, about `recording.rs:3487`).
  The renderer resets `replayFailedStartsRef` on **any** Idle
  (`use-studio.tsx:7363`), so the count never reaches
  `REPLAY_START_RETRY_LIMIT = 3`.
- Result: 62 refused starts between 17:53:43Z and 17:54:22Z, about two a
  second. There was no "Clips could not start" toast, and the preview went
  through `preview-watch` healing the whole time. The loop ended only when the
  config changed.

### 4. A false "restart Videorc before recording again" warning

- All three writers were released by 17:53:43.132Z (`liveOuter=0`, session_logs
  seq 312). The warning at 43.319Z said `outer=1`.
- On macOS, the teardown takes its lifecycle snapshot when the **Combined**
  bridge batch finishes (`encoder_bridge.rs:2473/2740`). The Camera ISO bridge
  is still reaping under its own supervisor at that moment.
  `source_iso.finish()` runs afterwards, but the stale snapshot drives the
  check (`recording.rs:10137-10196`). The Windows branch already re-snapshots
  (`recording.rs:10134`).

### Not a cause, but noted

- The role-failed health event fires twice: once from `supervise_role`
  (`source_iso.rs:1232`) and again from `commit_finished_source_iso_roles`
  (`source_iso.rs:1714`).
- During the take the screen delivered 1 fresh frame in 16 s. The frames at
  1 s, 7 s and 14 s of the Combined file match at 47.6 dB PSNR, showing a
  still docs page, so this is most likely a still screen. If the owner was
  scrolling during the take, that is a separate stall (see F1).

## Design decisions

- **A take judges only what happens during the take.** A source incident
  latched before Record never fails an ISO role. The same source failing
  after Record still ends that role's file with a failure, as plan 158
  intended.
- **Clips never carries Separate source recordings.** The buffer writes no
  file, so the ISO legs have nowhere to go. Record and Go Live hand-overs
  still carry them through the user's own start params.
- **One rejected start is not a session.** Only an Idle that ends a session
  which reached `running` resets the Clips failure count.
- **Truthful teardown accounting.** Leak checks look at the registry after
  every writer of the take has been reaped.

## Owner decisions (recommended defaults; execution can start on them)

| #   | Question                                       | Recommendation                                                                                                                                                                 |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Tell the user live when a separate file stops? | **Yes.** One warning toast per role per take: "Screen file stopped. Your Combined recording keeps going." Only the icon is tinted (owner rule), and the toast links to Health. |
| D2  | Library row for a failed role                  | **"Not saved"** destructive badge in place of "MP4 failed", with a plain reason on hover, and no "Export MP4" for it (its MKV is a few-ms recovery stub, not a take).          |
| D3  | Ship as 0.11.1 hotfix?                         | **Yes.** S2 and S3 alone stop the Clips loop for everyone with the switch on.                                                                                                  |
| D4  | Fix the latch itself here?                     | **No; follow-up F1.** It changes the capture-recovery state machine, which needs its own plan and smokes.                                                                      |

## Slice S1: a pre-Record recovery latch cannot fail an ISO role

**Touches:** `capture_recovery.rs`, `source_iso.rs`.

1. In `CaptureRecoveryCoordinator`, expose the identity of the current
   terminal incident for a source, e.g. `terminal_incident_epoch(&SourceKey)
-> Option<u64>`. It returns `Some(self.epoch)` exactly when
   `source_failed_after_recovery` is true. `observe_degraded` already bumps
   `epoch` on every new incident (`capture_recovery.rs:1361`).
2. When the role supervisor starts (`SourceIsoRuntime::supervise` or the
   first iteration of `supervise_role`), record each role's armed baseline:
   `terminal_incident_epoch(role's confirmed source key)`.
3. In `supervise_role`, treat `terminal` as true only when the latch is set
   **and** its epoch differs from the armed baseline. A live source switch
   during the take changes the key, and a new key has no baseline, so it
   behaves as today.
4. Emit the role-failed health event once per role per take. Keep the live
   one in `supervise_role` (S5's toast keys on it). Have
   `commit_finished_source_iso_roles` skip its event when the supervisor
   already reported the same reason. A missing-after-Stop file still gets its
   event.

**Tests (Rust, `source_iso.rs` / `capture_recovery.rs`):**

- Latch seeded before arm (extend `test_camera_recovery_failed` with a screen
  twin): the role keeps running, the file publishes and the outcome is `Ok`.
- Latch formed after arm (a new `observe_degraded` → automatic attempts →
  `verification_failed`): the role fails with today's message.
- `source_iso_waits_for_scoped_terminal_recovery` stays green.
- Exactly one `separate-source-recordings-role-failed` event per failed role.

**Done when** the tests above pass, and a take started with a seeded screen
latch publishes Combined, `-screen` and `-camera` (proved in S6).

## Slice S2: Clips buffer-only sessions never arm Separate source recordings

**Touches:** `recording.rs` (one line plus a test).

1. In `start_session_with_timeline`'s `if replay_only { … }` block
   (`recording.rs:3599`), also clear `params.output.separate_source_recordings
= None`. The block already clears `captions`, so the style matches.
2. Check that the ISO capture-demand guard (`SourceIsoCaptureStartupGuard`,
   `recording.rs:3752`) and the `RecordingStartBarrier` participant count
   (`3 + …`, `recording.rs:5963`) both key off `source_iso_plan`, so they drop
   out with it.

**Tests:** a replay-only start with `separate_source_recordings.enabled =
true` reaches `running` without ISO writers. A non-replay record start with
the same settings still arms ISO. Use the nearest existing replay-only start
test in `recording.rs` as the template.

**Done when** both tests pass, and `pnpm smoke:replay-buffer` passes with the
switch on (add that case to the smoke).

## Slice S3: a rejected start's Idle does not reset the Clips failure count

**Touches:** `apps/desktop/src/renderer/src/hooks/use-studio.tsx` (around
7363), `lib/replay-buffer-reconcile.ts`, and its test.

1. Track whether the session that just ended ever reached `running`, e.g. the
   session id last seen in `running`. Reset `replayFailedStartsRef` on Idle
   only when the Idle ends that session.
2. Put the decision in a tiny pure helper in `replay-buffer-reconcile.ts`
   (lazy chunk) and unit-test it. `use-studio.tsx` is eager, so keep the
   eager change to a ref and one call (renderer budget, eager gzip ceiling
   395,000).

**Tests:** a starting → idle (rejected) sequence ×3 reaches `give-up`, and the
"Clips could not start" toast fires once. A running → idle sequence still
resets the count.

**Done when** the vitest passes, and a forced buffer refusal (e.g. revert S2
locally) stops after three attempts with one toast.

## Slice S4: the leak check counts after ISO teardown

**Touches:** `recording.rs` around 10137-10196 (non-Windows branch).

1. After `source_iso.finish(&state).await`, take
   `encoder_bridge_lifecycle = encoder_bridge_lifecycle_snapshot()` before the
   `live_resources > 0` check, mirroring the Windows branch at 10134.
2. Keep the Combined `teardown_report`'s terminal failures and detached
   counts as they are. Only the live counts move to the later snapshot.

**Tests:** extend `smoke:separate-source-runtime` (or its analyzer) to fail on
any `encoder-bridge-writer-leaked` health event for an ISO take.

**Done when** an ISO take's session log ends in `state=teardown-complete …
liveOuter=0` and the warning is absent.

## Slice S5: the user hears about a stopped file, and the Library row is honest

**Touches:** renderer only: the health-event handler path (lazy
`session-runtime-recovery` chunk preferred), `library-tab.tsx` around
1030-1045 and 1203-1207, and `separate-source-recordings-view.ts`. Read
`.claude/skills/videorc-design/SKILL.md` first.

1. D1: on `separate-source-recordings-role-failed` for the active take, call
   `notifyOnce('iso-role-failed:<session>:<role>', 'warning', …)`. Title
   "Screen file stopped" (or "Camera file stopped"); description "Your
   Combined recording keeps going." with `openHealthToastAction()`. Only the
   icon is tinted.
2. D2: a role row (`recordingRole` screen/camera) whose finalization failed
   shows a "Not saved" destructive badge with a plain reason tooltip, not
   "MP4 failed". `canExportMp4` is false for it. Plain reasons: map the
   backend strings ("… capture failed after source recovery", "… muxer exited
   before Stop", "… encoder failed …", "… artifact ended at …") to one
   sentence each, and fall back to the raw text.
3. Check both themes (owner rule).

**Tests:** a vitest for the reason mapping and the export gate, and a
renderer test (or the Library DOM contract) for the badge.

**Done when** the tests pass, and the owner's by-eye in light and dark is
recorded.

## Slice S6: acceptance on this Mac

1. Gates: `cargo fmt --check --all`; `cargo clippy -p videorc-backend -- -D
warnings`; targeted `cargo test -p videorc-backend source_iso`,
   `capture_recovery` and the new replay-only test (owner directive: no full
   suite locally); `pnpm typecheck`, `pnpm lint`, `pnpm format:check`;
   `pnpm --filter @videorc/desktop test`; `pnpm build`.
2. Smokes, on a quiet host: `pnpm smoke:separate-source-fixture`,
   `pnpm smoke:separate-source-runtime`, `pnpm smoke:replay-buffer`.
3. New smoke case: call `CAPTURE_RECOVERY_SMOKE_INJECT_SCREEN_METHOD` and let
   the screen latch go terminal, then record with ISO on. Assert three files,
   with `-screen` covering the Combined duration within 250 ms.
4. Owner take in the packaged build: Clips on (the default) + Separate source
   recordings on, a 15 s camera-in-screen take. Expect three files in Finder,
   Clips running again after Stop (one start in the log, no
   `session-start-failed`), and no "restart Videorc" event in Health.
   Then `pnpm smoke:separate-source-take -- <combined.mp4>`.

## Out of scope / follow-ups

- **F1: the latch itself (own plan).** A screen with 0 callbacks, here a
  still page or an idle display, was force-restarted twice and latched
  `Failed`. The latch then stayed for 56 minutes while the screen recorded at
  29 fps. Two questions for that plan: should zero callbacks on a still screen
  count as dead, and should the latch clear once the same source proves
  healthy? Both change `capture_recovery.rs`, whose comments say it must not
  (`capture_recovery.rs:1673`).
- Windows and Linux: Separate source recordings are macOS-only
  (`SEPARATE_SOURCE_RECORDINGS_SUPPORTED`). S3 is cross-platform renderer
  logic; no platform smokes are needed beyond CI.
- The owner's take: there is nothing to recover. The 34 ms stub holds one
  frame, and the screen exists only in the Combined file.

## Risks

- S1 keys on the coordinator's `epoch`. If some path latches `Failed` without
  a new `observe_degraded` epoch (e.g. `fail_unroutable_degradation`,
  `attempt_watchdog_expired`), a mid-take failure on that path would be
  ignored. The executor must list every path that sets
  `automatic_attempts_operator_latched = true` (1637, 1922, 1953) and prove
  each one runs inside a fresh epoch, or bump the epoch there.
- S3 touches the eager renderer. Check the gzip budget (`pnpm build` reports
  it).

## Execution notes

Built 2026-10-25 in one Claude Code session (Opus 5.5) in worktree
`~/projects/videorc-wt-198`, as one owner-route pass instead of the per-slice
model lanes. The diagnosis was already in that session's context, and one
writer per worktree avoids parallel Rust compiles.

- **S1.** `CaptureRecoveryCoordinator::terminal_incident_epoch` and
  `source_failed_after_recovery_since`. `supervise_role` records the epoch on
  entry. `FinishedSourceIsoRole::failure_reported` stops the commit from
  repeating the supervisor's event. The commit's own event now always names
  its file (`"{Role} file: …"`), and "missing after Stop" reads
  "{Role} file was missing after Stop.".
- **The risk on epochs is closed.** Every path that sets
  `automatic_attempts_operator_latched` (`verification_failed`,
  `attempt_watchdog_expired`, `fail_current_attempt`) requires
  `ticket_is_current`, which compares the ticket's epoch with the
  coordinator's. Tickets are minted by `begin_automatic`, on the epoch that
  `observe_degraded` just bumped, and by `begin_automatic_retry` and
  `begin_manual_retry`, which bump it. `fail_unroutable_degradation` never
  latches. So a latch from before Record keeps its epoch, and any newer
  incident gets a new one. A screen that degrades again while its old latch
  holds raises no new incident: `observe_degraded` returns early for the same
  scope while Failed. The ISO file then keeps held frames, as Combined does.
- **S2.** `normalize_replay_only_params` (extracted from
  `start_session_with_timeline`) clears `separate_source_recordings`. A
  smoke case was **not** added to `smoke:replay-buffer`. The renderer sends
  the ISO settings only when a camera is selected
  (`separateSourceRecordingsForSession`), and the dev app the smoke drives has
  no camera grant, so the case could not reach the bug. The unit test
  `buffer_only_session_never_arms_separate_source_recordings` covers the
  backend decision, and the owner's take (S6.4) covers it end to end.
- **S3.** `idleEndsSessionThatRan` in `shared/capture-state.ts`. The status
  handler computes `ranToIdle` once and uses it for both the session-finished
  notice (same condition as before) and the Clips count reset.
- **S4.** On macOS the lifecycle is snapshotted again after
  `source_iso.finish` when the take armed ISO. The runtime test now fails on
  any `encoder-bridge-writer-leaked` event.
- **S5.** The toast is `showSeparateFileFailed`, routed through the existing
  lazy `showSessionHealthEvent`, so the eager bundle adds only one argument.
  Library: `separateFileStopped` turns the backend reasons into one sentence
  each.
  - **D2 refined.** The plan said "Not saved, no export", but a Screen file
    that stops after minutes keeps those minutes. The row says **Stopped
    early** ("… The first 4:12 is kept."), and "Export MP4" stays available
    when the partial holds at least 1 s. A shorter stub disables it with "Nothing
    usable was recorded before this file stopped.". **Not saved** is kept for
    a file that is gone ("missing after Stop", or ownership unverified after a
    restart). An MP4 export failure after a good take still reads "MP4 failed"
    with Retry.
- **Renderer budget.** origin/main measures 394,848 eager gzip against the
  395,000 ceiling (152 bytes of headroom). This branch measures 394,996: it
  passes with 4 bytes to spare. The next eager addition must re-split or
  recalibrate.

Gates run on this Mac (2026-10-25):

- `cargo fmt --check --all`, and `cargo clippy -p videorc-backend -- -D
warnings`: clean.
- Targeted Rust tests: `capture_recovery::` 80/80, `source_iso` 62/62 (1
  ignored), `replay_ring_args` 8/8, `replay_buffer::` 20/20, plus the `replay`
  (45), `teardown` (8) and `separate` (10) filters, and the new
  `buffer_only_session_never_arms_separate_source_recordings`. The full suite
  was not run (owner directive: targeted tests locally).
- `pnpm typecheck`, `pnpm lint` (0 errors; one existing warning at
  `use-studio.tsx:12282`, not in this diff), `pnpm format:check`, `pnpm
build`, and `node scripts/check-renderer-asset-budget.mjs` (394,996 ≤
  395,000).
- Vitest: `separate-source-recordings-view` (9 tests), `capture-state` (23),
  `session-runtime-recovery`, plus the copy, toast and style guards.
- `pnpm smoke:separate-source-fixture`: PASS on CPU and Metal.
- `smoke-separate-source-runtime.mjs --lifecycle-only`, one case at a time
  against the built test binary: the new `stale-recovery-latch` case (three
  files of 4.07 s, analyzer pass), plus `capture-recovery`, `bridge-failure`,
  `early-eof`, `camera-off`, `screen-off`, `hidden-screen` and
  `live-audio-controls`. All passed with the new single-event and no-leak
  assertions. The full matrix (4K/60 profiles, cancellation and crash) was
  not rerun.
- `node scripts/smoke-replay-buffer-app.mjs` (default 30 s ring): PASS. The
  ring was on at launch and saved clips through `clip.mark` and the remote
  intent. Record handed over in 135 ms, and a mid-recording clip also kept
  its mark. After Stop the ring re-armed (S3's path), and the switch turned
  it off. Two earlier attempts proved nothing about this change. The first
  timed out at launch, because the backend dev build compiled inside the
  120 s launch window. The second failed `--seconds 10`, because the smoke
  expects the default ring to keep the requested length.
