# Plan 126: Diagnose Windows audio mixer stability failures

Discovered during final CI verification on 2026-10-04 UTC. Priority P1; effort M; risk MED. Product versus timing-fixture attribution is unassigned.

## Observed discrepancies

The actual PowerShell 7 source-ownership loop failed on two source-equivalent audio implementations:

- PR568/head `10011128`, job111324743784: `session_audio` pass23/25, 63passed/5failed. Failed cases cover microphone/system recovery after an output stall, source-clock recovery, pre-sum level windows and the limited stereo mix/caption tap.
- PR569/head `570334b7`, job111326364402: `session_audio` pass3/25, 67passed/1failed. `an_output_stall_never_retires_a_healthy_microphone` observes 14,880 exact microphone frames instead of the required48,000 after the stall. The earlier job observes17,280 in the same check. Both jobs stop before their three full-suite passes; neither is accepted as Windows stability proof.

Private complete logs: `/tmp/videorc-fix122-ci-windows-source-failed.log` and `/tmp/videorc-fix123-ci-windows-source-failed.log`. Successful macOS/Linux checks and finished earlier Windows iterations remain separate evidence. The latest120-minute Windows job is still running; its larger allowance does not repair these assertion failures.

## Ranked hypotheses and predictions

1. Real-time fixture delivery is overtaken by host scheduling. The fixtures choose an epoch only100ms ahead and deliver packets against wall time. An explicit owned producer/readiness boundary followed by controlled delivery should distinguish fixture lateness from mixer data loss while preserving every PCM assertion.
2. Mixer catch-up or clock re-anchoring drops eligible PCM. A deterministic replay through the actual production writer/timeline with controlled capture, write and stall boundaries should reproduce the missing region and expose its counters despite on-time source admission.
3. Reader progress or attach/meter windows identify a region before all required production boundaries have completed. Exact frame/attach acknowledgements should identify the same intended stable interval without sleeps or weaker sample counts.

These are leads, not established causes. Existing failures do not authorize a production timing or loss-policy change.

## Ordered work

1. Retain all failed CI outcomes, exact source hashes, completed pass counts and failing assertions. Inspect actual timed producers, FIFO reader progress, writer-clock/skip behavior, source ownership and meter windows. Keep runtime recording failures in Plan112 separate.
2. After the current Plan125 fix closes its focused queue, construct a meaningful failing-before regression at the owning production or test-fixture boundary. Use explicit channels or spawn-boundary evidence; no fixed settling sleeps, temporary-file lifecycle handshakes, repeat-until-green tests or ignored cases. Bound cleanup and join each exact owned child/task before assertion failure.
3. Review the attributed RED and full minimal repair. Keep exact PCM counts, limiter/stereo/caption isolation assertions, source-loss versus output-stall contracts, three-second stall, deadlines and all shipping audio budgets unchanged. Run focused neighbors and Rust formatting/lint. Do not run broad app E2E after this individual fix.
4. Commit/push the reviewed slice through a normal PR after Shadscan baseline/floor/precommit37. Verify every affected Windows filter at least25 times and three complete Windows Rust suites from PowerShell7. Run the applicable final recording-studio/artifact and broader local gates after the product fixes are complete, preserving earlier failures.

## Done criteria

- [ ] The actual owning boundary and missing/mismatched PCM or meter values are attributed.
- [ ] A meaningful failing-before regression passes after the smallest reviewed repair.
- [ ] Affected Windows tests pass25 repetitions and three complete Windows Rust suites.
- [ ] Applicable final recording/audio and artifact gates complete, with all failed evidence retained.

## Observation slice — merged, attribution pending

Commit `d1858ac7037b6039f7297b0496b1723e18b976d8` merges through [PR 573](https://github.com/TheOrcDev/videorc/pull/573), main `4403adfdbfdbdd972e117fc5056a020b5bfc2551`. Only `session_audio.rs` changes. Five existing timed mixer tests now emit bounded delivery, loss, completed-write, reader-ACK/level and exact-window PCM classifications; the microphone-stall test retains both original playout variants. Assertions, exact windows/counts, packet schedules, three-second stalls and production timing/freshness policy remain unchanged. This slice observes failures; it does not repair or attribute them.

Local macOS validation passes 70 audio tests with zero failures/ignored cases, strict Clippy, Rust format and diff checks on Rust/Clippy 1.98. Shadscan stays 37. Root independently verifies the exact committed diff SHA256 `3b6fe34677602d32efd88506d0c6fd14585b64883a9a6d041f302a1c8109641a` and source SHA256 `94f0e0bc087d5d9a8ba70c06c8fd017ae4fcbd4346826a2296951d074f11f5d0`. Six parsed local records cover all inspected frames with expected PCM, no missing/zero/altered samples there, zero inspected-window loss deltas/stale-write overlap, at most six boundary rows and zero omissions. Delivery lateness is at most 7,420 µs in this run. Earlier intentional-stall losses remain separate. This successful local run does not invalidate the original Windows failures.

The optional collector defaults absent and exists only in test builds. Snapshot copying also runs in uninstrumented test-build buses, and observed fixtures acquire collector locks. Delivery lateness is aggregated per producer; individual delivery/chunk timelines are not retained. Initial ingestion can precede the first snapshot, and loss deltas cover reported completed-chunk boundaries. Those limitations are explicit in each record. The inherited `Bus.finish` reader `join` remains unbounded and unchanged; no bounded reader-cleanup claim is made. All owned local validation/audit/publication sessions finish successfully.

The actual Windows source job 111339072452/run 37169394914 remains pending its 25 affected-filter repetitions and three full Rust passes. No app/E2E ran for the individual observation slice. The root-owned unchanged final `smoke:local-gates` batch on main 4403adfd passes 2,994 Rust tests and strict Clippy, then stops at the first OAuth app readiness timeout (Plan 127). Its full 60-minute preview and 15-minute recording gates have not started. Final acceptance and Plan 126 done criteria remain incomplete.

An earlier source job, 111330354018/run 37166493873, now completes successfully. Its actual raw log shows all 25 audio repetitions passing 68 tests each, all 25 preview-bounds repetitions, and three full Windows backend suites passing 2,813 tests plus one integration test each (13 existing ignored per backend pass). All later format, lint and audit steps also succeed. The private complete log is `/tmp/videorc-fix124-ci-windows-source-green.log`. This establishes an earlier successful stability cohort; it does not attribute or invalidate the two retained failures, and it does not substitute for the new observation slice's Windows run or Plan 127's new Node ownership coverage.
