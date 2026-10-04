# Plan 118: Restore the listen-only caption transport contract

Discovered during final QA against committed `133a2a702f7a633241ae8a0885558f43305c2f8c`, 2026-10-03 UTC. Priority P1; effort M; risk MED. Debug PCM producer cadence/ownership is independently attributed and corrected. Preserve consent/privacy fences and the original failed gate.

## Observed failure

`VIDEORC_PERF_RETAIN_ARTIFACTS=1 pnpm smoke:recording-studio` exits **1** at `smoke:captions-contract`. Its actual debug backend and authenticated local fake service complete realtime captions, assistant-response safety fallback and chunk fallback, then fail with **Timed out waiting for listen-only chunk upload.** The smoke explicitly sets `enabled: true, listen: true`, starts Orcle with chat consent, and its deterministic PCM injection reports accepted frames. No new fake chunk request arrives within the unchanged 180-second deadline. Accepted injection does not prove that frames passed the newer speech-admission fence.

The preceding recording-studio subset passes 503 desktop cases, the script suite, focused backend layout/scene/recording/audio/noise checks, scene-switch recording/stream pixels and the landscape/portrait freeform editor with finished-artifact proof. The aggregate stopped here and is **not a pass**. Log: `/tmp/videorc-fixes-final-recording-studio-camera-fix.log`. The maintained caption smoke tears down its owned backend and deletes its isolated profile in `finally`; no failed profile or final listen snapshot is retained by that existing harness. Do not claim a public provider or physical microphone trial.

## Scope and boundaries

Inspect `scripts/smoke-captions-contract.mjs`, its fake service/audio injector, and actual `cohost.start` → speech grant → `start_listen` → caption task → frame admission → chunk upload callers in `crates/videorc-backend/src/cohost.rs` and `captions.rs`. Plans 098 and 097 changed speech/capture ownership; neither is blamed without failing-before caller evidence. Camera preview source changes are separate.

The current admission contract rejects audio whose entire frame predates or crosses the explicit speech/listen grant. Check whether deterministic injection timestamps represent the buffer end and whether its clock/PCM durations satisfy that contract. Also inspect actual task reuse, consent/epoch ownership and pending chunk formation. A harness timestamp discrepancy must be proved at the actual injection/admission boundary; never bypass consent or accept pre-grant PCM to make the smoke green.

## Ordered work

1. Preserve this nonzero aggregate result. Reduce current source/injection semantics and collect bounded stage/status/admission counters using existing debug-only seams. Use a clean comparative source control if needed. No raw tokens, PCM, user speech, IDs or full private status dumps in committed evidence.
2. Add a meaningful failing-before regression exercising the actual injection and production frame-admission/upload path. Separate pre-grant/crossing rejection from valid post-grant listening. Preserve explicit captions, listen-only renderer silence, purpose=listen, one chunk, allowance and tap teardown assertions.
3. Root reviews the attributed cause and minimal scope before implementation. Correct either the demonstrated production owner/admission bug or the demonstrated fixture timestamp contract, with no deadline increase, sleep-based handshake, skipped scenario, privacy weakening or changed API purpose.
4. Run focused Rust/Node tests and the unchanged real-backend `pnpm smoke:captions-contract`. If production speech/capture code changes, include adjacent cohost/caption tests, strict Rust format/Clippy, desktop caller checks as appropriate, and required recording-studio/device/A/V gates. Commit/push/merge separately through the normal PR flow after immediate Shadscan baseline 37; preserve the final-batch discipline.

## Done criteria

- [x] Actual injection/consent/task ownership explains the missing upload.
- [x] Valid post-grant input fails before and passes after the scoped correction; private old/crossing input remains rejected.
- [x] The unchanged maintained caption contract passes every realtime, fallback and listen-only assertion with owned teardown.
- [x] Final recording-studio gate completes, or remaining independent failures/physical blockers are stated accurately.

Stop before speculative production changes. Keep the failure unresolved while continuing independent final checks.

## Initial static lead

At current-source `captions.rs:208`, the debug injector creates 20 ms PCM frames in a tight loop, stamps each buffer with `Instant::now()` and only yields between frames. Production admission subtracts the frame duration and requires that entire frame to follow the explicit speech/listen grant. The chunk buffer intersects every contributing frame admission. This can contaminate the first complete injected chunk with crossing/pre-grant ownership and prevent a listen-purpose upload. It remains a hypothesis until the actual injector/production admission sequence fails a meaningful regression. Do not label production consent broken or weaken that fence. A realistic debug producer clock/cadence is a possible fixture correction only after attribution.

## Candidate RED boundary and fixture-only scope

Use the existing serialized caption lifecycle test lock and actual installed audio tap, production `CaptionSession::admitted_orcle_audio_for_frame` and chunk ownership intersection. If necessary, mechanically extract the existing debug injector body into a private producer called by the same gated RPC, without first changing its timestamps or behavior. A test should establish a real speech/listen grant, receive the actual first injected 20 ms frame through the tap, and show that a supposedly fresh fixture frame is classified as crossing/unowned. Keep an independent pre-grant/crossing rejection control. The current full maintained contract timeout is already real-backend failing-before evidence; the narrow regression must explain it rather than merely mirror the helper.

A proposed correction may pace this debug-only PCM producer against sample-duration deadlines and stamp completed buffer ends, with the first buffer starting after admission. Such pacing represents the audio fixture clock, not a fixed delay used as a readiness handshake. Do not use future wall-clock timestamps, arbitrary settle sleeps, broader production admission, a second injection solely to skip the bad chunk, or changed expected upload counts. Retain debug/environment guards and explicit tap readiness, bound owned receiver/task cleanup, and review the actual RED before authorizing any fix.

## Actual failing-before fixture attribution

The isolated unchanged producer regression compiles and fails at the intended admission assertion. Agent and root independently run `cargo test -p videorc-backend --bin videorc-backend caption_contract_fixture -- --nocapture`: **one rejected-input control passes; one fresh-input case fails**. The actual first buffer ends 26µs/13µs after the latest explicit grant but contains 20,000µs PCM. Both first-frame admission and the sole completed three-second speech chunk are `{ speech_epoch: None, listen_epoch: None }`, versus real granted epochs `Some(1)`. Accepted150, zero dropped frames, one speech chunk, Listen purpose, no future timestamps and owned tap/cohost cleanup assertions pass before the failure. Root log: `/tmp/videorc-fix118-root-rust-red.log`; frozen source fingerprint `e540cc8da74ae0873c409174428f5ec47e825be2ee5f61c09be3b0e3ff260102`.

Production `run_chunked_caption_session` skips an unowned listen-purpose chunk before beginning HTTP upload. This explains the fixture's missing upload without demonstrating a production privacy defect. Root approves only debug-producer cadence correction: pace completed PCM against absolute sample-duration deadlines, stamp actual buffer-end time and preserve all production fences, environment/release guards, expected counts and rejected-input controls. Add a measured full-duration assertion to distinguish realistic pacing from a first-frame delay followed by an immediate burst. Actual maintained HTTP smoke and final aggregate acceptance remain pending; the narrow RED does not claim HTTP coverage.

## Reviewed correction and independent focused GREEN

The debug producer now waits each absolute 20ms sample-duration deadline and stamps its actual completed-buffer end. Sample timestamps, PCM, yield fairness, debug/environment/tap guards and accepted-frame counting stay unchanged. Production admission, chunk-purpose and provider callers stay unchanged. The actual installed-tap regression verifies the full three-second production interval, all150 frames' ownership and valid timing, the completed speech chunk and cleanup; the pre-grant/crossing control remains rejected.

Root reviews the entire one-file patch and independently verifies **112 caption/75 Orcle tests pass**. Rust format, strict Clippy (local1.98) and diff checks pass. Frozen source fingerprint: `88ff704f1c2456aead81f0749d21583ccb5114071da0a84bf3e6d1785c243e4c`; full diff SHA256 `29a4cf67fd9a9878029567a19fc6ea464c6acde9190d12dbebe032f725181b07`. Root logs: `/tmp/videorc-fix118-root-{captions,cohost}-green.log`. This is scoped GREEN; unchanged HTTP contract/final recording-studio remain pending and no provider/device acceptance is inferred.

## Commit and final-batch continuation

The existing Windows PowerShell25 ownership loop now explicitly includes `caption_contract_fixture`; no job, retry, threshold or three-full-suite requirement changes. Root reviews the exact one-literal workflow expansion, direct format and scope checks. Two-file fingerprint `1135ff82299472f8b8ffcf5fce7319549c0d5e5b23993920c5396410cb08fd4e`; pre-commit Shadscan37. Commit `901bcd4e2303b50e1c0316ef37d21cde4423a773` is pushed and merges normally through [PR566](https://github.com/TheOrcDev/videorc/pull/566), main `812ba01a7dfe59f30b823aaace0f25ed95059002`. Actual Windows25/three-full runtime verification remains pending CI.

The complete unchanged `pnpm smoke:recording-studio` is restarted on clean main `812ba01a` after all source slices merge. Log: `/tmp/videorc-fixes-final-recording-studio-caption-clock-fix.log`. Its prior failed attempt is preserved; the new aggregate is running, not passed. No additional app/evidence claim follows from the source merge.

The unchanged HTTP contract now **passes** inside that aggregate: realtime partial/final and repeated completion, assistant-response safety fallback, chunk fallback/provider-ready/stall truth and listen-only transcription without caption events. Actual summary: realtime appends46, chunk requests3, **listen chunks1**. Its owned backend/fake-service teardown completes before the next maintained step starts. Captions-live post-controls record/stream artifact and final-artifact noise cleanup then pass. Evidence uses the actual debug backend and local fake Gateway, not public providers or physical microphone qualification. All-layout finished artifacts, finalization/latency and subsequent preview/artifact steps pass, but the full aggregate exits1 at the later detached Comments probe (**Invalid smoke command or parameters.**). [Plan120](120-restore-detached-comments-probe-command-contract.md) preserves that independent failure; later maintained steps continue separately. Actual Windows fixture25/three-full CI is still pending. Caption contract acceptance is not a whole-suite pass.


## Actual Windows fixture stability verified

Root verifies raw completed output from job111316233045: both `caption_contract_fixture` cases pass28 times each (25 filter passes+three full suites), with every expected filter/pass marker present and actual PowerShell7 execution. Each full Windows backend run passes2808/13 existing ignored plus one integration case. The overall job is **cancelled**, because GitHub's75-minute limit stops the later Rust auditor install; its Rust audit is skipped. Plan124 owns that independent CI orchestration discrepancy. This completes fixture stability proof without claiming the cancelled full job passed. Current-main9710de9a caption HTTP contract separately passes again in the ongoing device aggregate: realtime appends46, chunk requests3, listen chunks1.

Current-main9710de9a final `smoke:recording-studio:devices` completes all36 maintained stages, actual exit0/PASS; the unchanged real-backend HTTP caption contract includes one accepted listen-only upload and every prior assertion. The prior failed aggregates remain retained. Plan124 independently tracks required whole-job Windows audit completion after the fixture stability evidence already passes.
