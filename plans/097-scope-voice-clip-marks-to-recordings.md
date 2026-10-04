# Plan 097: Keep voice clip matching and deduplication inside each recording

> Executor: read this plan fully, preserve existing user changes, and run the verification gates. Implementation and focused verification are recorded below; final app acceptance remains pending.
> Drift check: `git diff --stat 05ff9188..HEAD -- crates/videorc-backend/src/clip_marks.rs crates/videorc-backend/src/cohost.rs crates/videorc-backend/src/state.rs`
Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

> The planning checkout is older than the tested release. Start from `05ff9188` or a later main checkout; verify the excerpts before editing.

## Status

- Priority: P1
- Effort: S–M
- Risk: MED; the last transcript from a stopped recording can arrive after another recording starts.
- Depends on: none
- Category: bug
- Planned at: `05ff9188`, 2026-10-03; release 0.9.129
- Confidence: HIGH, confirmed source defect; cloud speech was not exercised with a real provider during QA.

## Why this matters

Orcle's “Clip that” matcher is shared across recordings. It guesses that a lower file timestamp means a new recording, but a new recording can reach a timestamp equal to or slightly higher than the previous mark. In that case a valid voice mark is silently suppressed. Carried words can also join a phrase across recordings. Users lose highlights even though marks are stored under the correct recording ID later.

## Reproduction

1. Record session A and create a voice or manual mark at file time 10 seconds.
2. Stop A and start session B in the same app process.
3. Say “clip that” at file time 15 seconds in B.
4. The matcher rejects B's mark because 15−10 is inside its ten-second deduplication window. B is a separate recording and should accept it.

At the pure-helper boundary, `ClipMarkDetector::note_manual_mark(10.0)` followed by `note_final("clip that", &[], 15.0)` returns `None`. The detector has no session identity argument.

## Current state

- `crates/videorc-backend/src/clip_marks.rs:142` defines one `ClipMarkDetector` with `tail` and `last_mark_at_seconds`, but no recording ID.
- `clip_marks.rs:169` documents and implements a timestamp heuristic:

```rust
if let Some(last) = self.last_mark_at_seconds
    && at_seconds >= last
    && at_seconds - last < CLIP_MARK_DEDUPE_SECONDS
{
    return false;
}
```

- `clip_marks.rs:217` receives `Option<MarkTarget>` with `session_id` and `records_to_file`, but calls `detector.note_final(text, segments, offset_seconds)` before using the target in `record_mark`.
- `clip_marks.rs:306` advances the same dedupe state for manual marks.
- `state.rs:1354` constructs the detector once for `AppState`.
- `cohost.rs:3954` clears the cohost transcript and recent speech at a session boundary; it does not clear or scope the clip detector. Sign-out's `forget_words` clears only the tail.
- Match the existing pure-helper tests in `clip_marks.rs`, including `repeats_within_ten_seconds_dedupe_against_voice_and_manual_marks`, and existing capture-end mark tests. Keep the std lock short and never wait for an async recording lock under it.

## Scope

In scope: `clip_marks.rs`, its inline tests, and the minimal caller/state changes in `cohost.rs`, `state.rs`, or caption-task call sites required to provide recording ownership.

Execution coordination: Plan 098 now keeps recording clip-mark routing independent of Orcle listen-epoch ownership at real chunked/realtime result seams. Re-read those callers after 098 lands. In particular, test the actual late-caption callback, not only a direct helper call: a previous capture-epoch UI/Orcle suppression must not reattribute an old immutable mark target to the current recording. If the actual callback cannot retain the old recording's mark path, explicitly narrow and expand its ownership contract before changing it. Preserve caption presentation and Orcle consent fences introduced by 098.

Out of scope: clip wording, ten-second same-recording dedupe policy, provider speech transport, recording encoder, cloud AI pricing, and export formatting. Do not solve this by resetting a singleton on Start: that can discard A's late final or make it corrupt B.

## Ordered implementation

1. Add recording identity to the pure matcher boundary. Prefer per-recording matcher state or an equally explicit ownership model that supports a late final from A while B is active. Write a regression for A10→B15 before changing behavior; it must fail with current code. Verify with `cargo test -p videorc-backend clip_marks::tests::`.
2. Resolve the immutable mark target before matching. Pass that identity through voice and manual paths. An explicit non-recording target must not advance another recording's matcher. Preserve capture-end routing to the task's captured target. Bound state retention and retire it only after the relevant caption drain; document the rule. Verify the focused clip tests and `cargo test -p videorc-backend cohost::tests::`.
3. Cover lifecycle overlap and sign-out. A late A final must dedupe within A, never inherit or change B's tail/window, and never be reattributed to B. Add an async integration regression using the existing recording-mark fixtures. Run the full backend suite and cohost fake smoke.

## Verification

| Command | Expected result |
| --- | --- |
| `cargo test -p videorc-backend clip_marks::tests::` | All tests pass, including new ownership regressions |
| `cargo test -p videorc-backend cohost::tests::` | All pass |
| `cargo test -p videorc-backend` | All pass |
| `cargo fmt --check --all` | Exit 0 |
| `cargo clippy -p videorc-backend -- -D warnings` | Exit 0 |
| `pnpm smoke:cohost-fake` | PASS, with session mark assertions added if supported |

If the change touches capture start/stop or caption finalization ordering, additionally run `pnpm smoke:recording-studio` and `pnpm smoke:record-latency:gate` under AGENTS.md.

## Done criteria

- [x] A10→B15, A10→B10, and a lower-time new session all accept B's voice mark.
- [x] Same-recording voice/manual repeats inside ten seconds remain deduplicated.
- [x] Words from distinct recordings cannot combine into a clip phrase.
- [x] A late A final after B starts is routed and deduplicated under A only.
- [x] Stream-only/no-recording finals cannot suppress later recording marks.
- [x] Sign-out erases retained transcript words; ownership-state retention is bounded.
- [ ] All applicable gates pass and the plan index records completion evidence.

## STOP conditions

Stop and report if target ownership cannot be resolved before matching without changing the caption task contract, or if the implementation would introduce an async lock inside the detector's std lock. Expand the plan explicitly instead of inferring a timestamp-based reset.

## Maintenance

New caption transports and manual mark triggers must pass the same recording identity. File timestamps are coordinates within a recording, not identifiers for a recording.

## Execution preparation — actual caption ownership paths

Re-read `captions.rs::publish_chunked_caption_result`: it suppresses old capture epochs with an early return before the independent clip hook. Realtime completion uses retained item ownership, but capture re-anchor currently clears `items`. Test both actual callbacks for late A completion, preserving old-epoch suppression for caption UI and Orcle while retaining A's immutable clip target.

Also characterize caption-task reuse, not only fresh-task startup. `start_captions_with_bearer` joins a live listen-only task in place and can return an already-running caption task; its newly computed `mark_target` is then not installed into the existing task. The task's current target was captured when it started. Establish whether the maintained capture-end/restart paths retain that task across a different recording or stream-only capture, and test the actual lifecycle if they do. A task instance or lower audio timestamp is not itself recording identity. `None` currently resolves the active recording later in the spawned write, after matching, so it cannot serve as an immutable late-final owner. Resolve an explicit recording/non-recording target before matching and retain that exact target for the write. If lifecycle reuse requires an internal per-input/chunk/realtime-item recording owner, document that narrow caller contract expansion before implementing it; preserve all 098 consent and caption presentation fences. No real cloud provider is needed for these controlled callback/lifecycle regressions.

## Approved execution scope — matcher ownership and exact retirement

The proposed audio-frame ownership envelope was withdrawn after checking the real admission contract. `monitor_session` acquires `begin_finalizing()` before removing A from `state.recording`, retains its permit through caption drain and final artifact publication, and releases it after finalization. `start_session` awaits `begin_capture_when_available()` before attaching B's audio bus or publishing B. Manually replacing the recording slot while A's provider is draining bypasses that gate and does not establish a production overlap. Preserve this ordering and prove it with bounded provider completion/admission channels for recording and stream-only captures.

Use explicit recording IDs registered by real caption-task and manual-mark owners. `None` and explicit non-recording targets must never resolve a later active recording. Keep bounded retained matcher states, including a recently drained A while B is active; never evict an undrained owner or recreate a pruned/unknown owner from a late final. Preserve voice/manual deduplication and caption opt-out/on deduplication within one recording. Sign-out must erase every retained transcript tail. Test cross-recording isolation, same-recording out-of-order timestamps, bounded retention, and refusal of pruned late finals.

The minimal caller expansion is approved: `finish_captions_for_capture(state, session_id: &str)`. The sole production caller in `monitor_session` already holds the immutable ID after its recording slot is removed. Pass that exact ID without changing capture or finalization timing, and retire only that owner after the provider is confirmed joined (including abort followed by join). A failed bounded join leaves the owner undrained. This also covers manual-only recordings with no caption task; never derive retirement from a newer active slot.

Characterize capture end during `privacy_teardown_in_progress`, whose current finish path returns before the normal join. Exact owner retirement must not be permanently skipped when sign-out subsequently confirms the join, or repeated sign-outs can exhaust the bounded matcher capacity. Preserve the existing non-blocking capture finalization tests during sign-out filesystem cleanup and retain owners whose provider join actually failed. Any required deferred retirement state must have a concrete bounded owner contract approved before implementation.

The executor confirmed that early-return edge. The approved expansion flags awaiting retirement inside the existing two owner records and records whether the current serialized sign-out has confirmed its provider join. Capture end flags only its exact registered ID; successful join retires only flagged owners. An end arriving after join but during filesystem cleanup can retire immediately without waiting for that cleanup. Failed or unproven joins cannot become proven merely because a later retry finds no task handle. Keep this conservative evidence limited to affected clip-owner retirement, with no new owner set, producer change, filesystem scheduling change, or sign-out status/retry policy change. Cover repeated cycles, before/after-join barriers, manual-only captures, newer-owner preservation and failed-join refusal.

Join uncertainty belongs to the affected owner: copy the running task's existing immutable `MarkTarget` into coordinator metadata at real spawn and take/reset it with that exact task handle. On failed join, mark only that registered recording as unproven. A subsequent empty-runtime retry cannot clear its unproven bit, while unrelated newer/manual-only owners remain independently eligible for retirement. No global failure latch should poison unrelated recordings. Cover task-taking paths and same-capture opt-out/on reuse.

One cancellation path is source-confirmed reachable during the real finalization gate: after the monitor removes A and `stop_listen_with(DrainWithCapture)` clears listen intent while retaining its provider, an idle `captions.start` can acquire caption control before monitor finish and abort/drop that live task without joining. The narrow approved repair releases the coordinator while retaining `CAPTION_CONTROL`, uses existing `finish_caption_task(state, true, false)` and its unchanged bounded abort/join deadline before returning Ready, and leaves exact A retirement to the monitor. Preserve desired-enabled intent and recording/encoder ordering; add a controlled gated failing-before regression. No async conversion of `spawn_transcription_task` or changed live-replacement behavior is approved without a separately demonstrated production caller/status case and a concrete scope review.

The executor subsequently identified the active retry case: terminal handling publishes Blocked before its provider task finishes, while `start_captions` reuses live tasks only in Starting/Listening/Reconnecting/Degraded states. The approved narrow fix is in that existing async caller, after its reuse/eligibility checks: drop coordinator under retained caption control, prove bounded abort/join with the existing helper, then reacquire before synchronous spawn. Failed join must surface the existing error/blocked mechanism and refuse provider replacement. Preserve desired intent, language, ownership checks and deadlines. `start_listen` already reuses any alive task and needs no analogous behavior change. Test actual terminal publication plus controlled completion, successful retry preserving same-recording dedupe, and failed-join refusal; do not convert the spawn helper to async.

The approved retry helper also checks the current recording's sticky unproven-join bit after bounded finish. A later empty-runtime retry cannot authorize a new provider for that affected A merely because its taken handle is gone; newer owners stay independent. First-attempt join failure rejects replacement regardless of target, and detector lock failure cannot prove a recording safe. Focused retry coverage uses actual terminal publication and the production-called cleanup seam after unchanged eligibility checks, not a fabricated native microphone or eligibility bypass. Do not describe that seam test as full start-caller coverage; the no-capture case exercises the full caller, and final maintained fake-caption acceptance covers actual API retry where its eligible fixture supports it.

Both actual callbacks must also check the session's existing stop `AtomicBool` with Acquire under the coordinator lock before canonical/UI/Orcle/clip writes. Sign-out and explicit cancellation permanently set that flag before abort; graceful drain and consent changes retaining explicit captions leave it false. This closes the late-write case after a failed sign-out join and an empty-runtime retry clears coordinator privacy flags, including stream-only sessions with no matcher owner. A check only before awaiting the lock is insufficient. Test the exact canceled worker with bounded release/completion cleanup; do not create a new account policy or owner set.

Maintained final API-retry acceptance is approved in `smoke-captions-live-app.mjs`: its existing synthetic native microphone is genuinely eligible and its gateway is local/authenticated. Add a narrow `chunkFailureCode` fixture field at the existing chunk route, preserving authentication, body/WAV/purpose validation and safe counters; add fixture unit coverage. After existing baseline/gain assertions, trigger Blocked, remove the fixture error and explicitly retry via the caption API. Require unchanged recording ID/output process and a new confirmed caption client/fresh final before the existing producer-loss phase. Initial session-owned automatic caption start and renderer-owned overlay/cue-frame assertions remain mandatory; no API start may bootstrap the smoke and no overlay RPC may fabricate acceptance. Preserve every existing final-artifact assertion. This is API-retry coverage, not UI-retry coverage. The app smoke runs only after all fixes.

Actual chunked and realtime completion callbacks must still route an old capture epoch to its registered immutable clip owner exactly once while suppressing caption UI and Orcle delivery. Preserve all Plan 098 consent fences. No audio producer envelope, native capture contract, encoder change, or start/stop scheduling change is authorized by this narrowed scope.

## Failing-before execution evidence

The pure matcher regression fails for A's manual mark at 10 seconds followed by B's voice mark at 15 seconds: 9 existing cases passed and the new case failed (`/tmp/videorc-fix097-exec-clip-red.log`). The actual chunked callback regression also fails after registering immutable recording A, advancing the capture epoch and installing B: caption UI and Orcle remain suppressed as required, but no `clip.marked` event arrives for A within the bounded channel deadline (`/tmp/videorc-fix097-exec-late-chunk-red-corrected.log`, 0 passed / 1 failed). An earlier fixture assertion incorrectly expected absent recent speech rather than an empty buffer; that run is not the reported defect evidence. No app or real cloud provider was launched for these characterizations.

Realtime capture re-anchor independently fails the same actual completion routing assertion: no caption UI/Orcle publication, but no A clip event within the bounded deadline (`/tmp/videorc-fix097-exec-late-realtime-red.log`, 0 passed / 1 failed, 2.02 seconds). Its fix must retain bounded item ownership across re-anchor and refuse unknown/pruned completions without a current-recording fallback.

The full no-capture start caller fails its controlled finalizing-gate regression before the cancellation repair: 0 passed / 1 failed at `Ready must follow the provider join` (`/tmp/videorc-fix097-exec-no-capture-red-corrected.log`, 0.01 seconds). The initial attempt was compile-only due to a missed internal realtime type migration and is not RED evidence. Active retry independently fails after actual terminal handling publishes Blocked: `a Blocked retry must join the old provider`, 0 passed / 1 failed (`/tmp/videorc-fix097-exec-blocked-retry-red.log`). That second case covers the production cleanup seam after eligibility, not the whole native start caller.

## Implementation — final app acceptance pending

### Current isolated recording-ownership diagnostic — 2026-10-04

One predeclared private real-app diagnostic on source `26b296ad` exits 0. A keeps exactly one renderer manual mark at 10.336828417 seconds; after A is finalized, B accepts exactly one voice mark at 15.605403417 seconds. Two distinct canonical finals have cues at 15.605 and 16.875 seconds, so the second phrase remains within the unchanged ten-second deduplication window. A is unchanged. The original A caption/retry/producer-loss/artifact checks are preserved; B's received stream, clean recording, captioned recording and audio pass analysis (peak 0.12115478515625). Root independently checks the coordinates, counts, frozen source/fixture and completed cleanup: all 11 explicitly recorded PIDs and both recorded groups are absent, with no wrapper signal or timeout.

Private evidence is `/tmp/videorc-plan097-ab-run-26b-20261004`, including `root-terminal-review.json` (SHA256 `6543ec43a0ab5079ac4b4c1a59eca0820191b97f89aaef3bb37f8d2fdb7744d2`). The reviewed private fork uses local synthetic native PCM and authenticated fake captions, not physical-microphone, renderer Record eligibility or cloud-speech proof. It is one diagnostic attempt, not a replacement for the original full suite. The full local bundle remains failed at INVALID glass evidence; original long-soak acceptance is pending.

Source `07095db70cf4f4e925ff4f0ed4ab710ff2c9b4c7`, [PR 558](https://github.com/TheOrcDev/videorc/pull/558), merged main `fd0f31aa1712e834bb2a15e39b2511869acfcdaa`. The reviewer read all nine changed files and independently reran 203 Rust cases (110 captions, 15 clip marks, 75 Orcle, and three affected sign-out/capture-end/session-stop caller cases) plus seven fake-caption Node cases. Rust format, direct script Prettier/syntax, diff checks and Shadscan 37 pass. Logs are `/tmp/videorc-fix097-root-{captions,clip,cohost,signout,capture-end,session-stop,node}.log`; evidence stays outside the tree.

Registered IDs own a two-record matcher; exact retirement requires proven provider drain. Realtime retains at most 128 original item owners, and unknown/pruned items never resolve a newer recording. Canonical finals call the clip hook once. Privacy and permanent session-stop fences are checked under the coordinator lock. Failed join evidence stays with its affected recording; empty-runtime retries cannot erase it. The full capture gate regression covers recording and stream-only A, proving B cannot replace A before drain and finalization release. No producer envelope, native/encoder changes or finalization scheduling changes were made.

An initial focused run passed 109 captions cases and failed one new fixture assertion: the existing helper deliberately installs Degraded, while the assertion expected Listening. The corrected test requires full serialized confirmed-status equality and retains task-ID, dedupe and retirement checks. The original failed root log is preserved at `/tmp/videorc-fix097-root-unconfirmed-status-captions.log`; this was an invalid test expectation, not another production status defect.

The maintained authenticated fake-caption smoke now includes a separately identified API retry requiring a fresh caption client/final and unchanged recording/output process. Its session-owned startup and renderer/artifact assertions remain intact. This app smoke, full backend/clippy, cohost fake, recording-studio and record-latency gates run after all source fixes, per the user's instruction. Focused seam coverage does not claim real-cloud or UI-retry acceptance.
