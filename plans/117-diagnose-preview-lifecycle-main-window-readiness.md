# Plan 117: Diagnose main-window loss during the native preview lifecycle probe

Planned against `133a2a702f7a633241ae8a0885558f43305c2f8c`, 2026-10-03 UTC. Priority P1; effort M; risk MED. Diagnosis first: functional failure confirmed, production cause and attribution unassigned. Discovered during final QA after all original implementation slices. Preserve the original checkout, existing user changes and failed evidence.

## Failure and evidence

`VIDEORC_SMOKE_OUTPUT_DIR=/tmp/videorc-fixes-final-evidence-20261003/preview-lifecycle-camera-fix VIDEORC_PERF_RETAIN_ARTIFACTS=1 pnpm probe:preview-lifecycle` exits **2** before completing its unchanged **100 cycles**. Progress reaches the 20-cycle checkpoint; the precise failing cycle is not yet recorded. The error is **Main window is not ready for preview motion smoke.** Last detached preview state is closed at supervisor generation/dock epoch 29, with unavailable native presentation because the lifecycle is closed. The final memory gate has four checkpoints versus 13 required because the functional run ended early; that sample-count failure is consequential, not proof of a separate memory regression. Teardown reports clean.

Log: `/tmp/videorc-fixes-final-preview-lifecycle-camera-fix.log`. Performance report: execution-worktree `docs/acceptance/artifacts/performance/preview-lifecycle-2026-10-03T22-21-58-602Z.json`. Scratch: `/tmp/videorc-fixes-final-evidence-20261003/preview-lifecycle-camera-fix`. Logs contain transient local command credentials: use reduced projections/redaction; never copy raw readiness lines, tokens or process/window handles into plans or commits.

The preceding three isolated synthetic native stress runs on this same committed source pass: floating freshness p95 **10/16/15 ms**, resize **21/9/15 ms**, docked **4/3/5 ms**, zero measured blank/skipped frames and all 41 rapid scene transitions per run. These passes do not erase the lifecycle failure. Plan 107 changes only two Rust camera-source files; main/probe TypeScript remains identical to parent `6f9995eb`. Do not attribute the new lifecycle failure to the camera repair without a matching mechanism or baseline evidence.

## Existing boundary and scope

`apps/desktop/src/main/index.ts` around 9887 rejects smoke commands if `mainWindow` is null or its webContents is destroyed. The main-window closed handler around 2190 clears the global reference. The before-quit guard around 14418 prevents app quit while the lifecycle probe owns the app. `scripts/preview-lifecycle-probe.mjs` around 395 deliberately attempts app quit once, then around 411 repeatedly opens, docks, undocks and closes preview windows. The current report omits the exact failed command/cycle and main-window close/renderer-loss ownership.

In scope for diagnosis: the maintained lifecycle probe, existing desktop smoke command owner, main/preview window lifecycle and existing quit-guard/recovery tests. Add narrowly bounded owner/cycle/command evidence if needed. Native addon/backend code remains out of scope unless an attributable trace requires explicit expansion. Preserve production transport, immutable frame ownership, stacking fields, gate thresholds, all 100 cycles and owned process cleanup. No arbitrary sleeps, fewer cycles, ignored failures, silent fallback or raw window/PID/title/token publication.

## Ordered work

1. Inspect the exact readiness guard, main close/recovery paths, preview open/dock/undock/close commands and intentional app-quit attempt. Check retained teardown and recorded owner PIDs without broad process scans. Establish whether the missing owner is the main BrowserWindow or only its webContents.
2. Repeat the unchanged maintained probe serially in new evidence directories after owned teardown. Record the exact failing cycle/action and bounded main/preview lifecycle evidence. If attribution remains ambiguous, run a clean parent-source control in an isolated checkout; do not rewrite or discard either result. Distinguish actual user/system interference, renderer loss, stale window callbacks/handles and deferred quit. A passing retry alone does not close this finding.
3. Reproduce the actual owner-loss sequence with an existing meaningful main/preview/quit-guard test seam before changing production. If the harness falsely demands the wrong owner, reproduce its actual caller contract before correcting it. Root reviews the failing-before evidence and narrowly proposed correction before implementation.
4. Commit and push the reviewed fix separately after focused desktop tests, typecheck, lint, format and immediate pre-commit Shadscan (baseline 37). Run `pnpm probe:preview-lifecycle`, `pnpm probe:preview-window` if placement changes, `pnpm smoke:preview-surface`, and final `pnpm smoke:recording-studio`. Shared Windows async/process test changes require 25 affected-filter runs plus three full Windows Rust suites in PowerShell 7. Keep final app checks in the ongoing final batch rather than restarting per-fix E2E.

## Done and stop criteria

- [ ] An attributable cause or explicit evidence-validity explanation reproduces the original owner-loss sequence.
- [ ] A meaningful regression fails before and passes after the scoped correction.
- [ ] The maintained 100-cycle lifecycle probe completes with all required memory checkpoints and clean owned teardown.
- [ ] Relevant native preview and full recording-studio gates pass at unchanged limits, with physical-device restrictions stated separately.

Stop before a speculative production change if the failed command/owner cannot be established. Improve bounded evidence, preserve this unresolved gate and continue independent final checks.


## Read-only attribution and repetition 2

The readiness client already retries this error for up to five seconds. The first run therefore establishes persistent owner unavailability over the request deadline, but not whether the global reference is absent or the webContents is destroyed. Fixed-pattern, reduced logs contain one intentionally prevented quit and no abnormal-renderer/main-close marker. The main closed handler clears the global without owner comparison; its relevance requires a newer owner to have been created first. Quit ownership is monotonic until the harness finally permits teardown, which lowers deferred quit as a hypothesis. Native code is not implicated by these facts. Main/probe/quit/recovery source is byte-identical to parent `6f9995eb`.

Ranked falsifiable hypotheses: actual main close (close→closed/null, no abnormal renderer exit); destroyed webContents while the main window remains assigned (live window, destroyed/gone contents); stale old-owner closed callback after newer create (old close clears newer reference); unprevented deferred quit (another before-quit/quitting transition despite ownership). None is a confirmed cause. Existing tests separately cover quit/recovery/preview generation policy and do not exercise the actual main closed callback with this readiness boundary.

A second unchanged, isolated default run **passes all 100 cycles**, all required checkpoints and clean teardown. Log `/tmp/videorc-fixes-final-preview-lifecycle-camera-fix-2.log`; report `preview-lifecycle-2026-10-03T22-27-25-685Z.json`. It does not erase the first failed run. A third unchanged repetition is proceeding serially. Root has asked the user an optional factual question about closing a test window during the first run; no response or external interference is assumed.


## Repetition 3 and controlled source comparison

The third unchanged default 100-cycle run also exits **2** with the same main-window readiness error after its 10-cycle checkpoint. Log `/tmp/videorc-fixes-final-preview-lifecycle-camera-fix-3.log`; report `preview-lifecycle-2026-10-03T22-29-55-324Z.json`. Teardown is clean; three/13 memory checkpoints again follow from early functional abort. Current-source repetitions are **FAIL / PASS100 / FAIL**. Preserve all three; no threshold, cycle count or retry change.

Before production instrumentation or a lifecycle correction, prepare an isolated clean predecessor control at exact `6f9995eb6fefc3c9e6239d4c8ce832782d6202f2`. Use frozen offline dependencies and its own ignored build target; an APFS copy-on-write target clone is acceptable, shared writable hardlinks are not. Record actual build source/binary digest and run the same maintained 100-cycle probe serially with separate outputs. Current `133a2a70` target/source must stay untouched. This comparison determines whether the camera source change is attributable before the reviewed source PR merges; it does not prove a lifecycle cause if both versions fail. No new production changes are authorized by the two failures alone.

## Clean predecessor control results

The isolated predecessor at exact `6f9995eb6fefc3c9e6239d4c8ce832782d6202f2` completed all three unchanged 100-cycle controls: **PASS / PASS / PASS**, each with 13 required memory checkpoints and clean teardown. Frozen offline install and ordinary backend/native-addon builds passed. Backend SHA256 `29ecf109d792356de593faba36cb99a73a4ec0456c50a7a483a3ac0e7d0e0ea2`; addon SHA256 `1d05c898eea832f63b15cf174b00fa52aec3b88ce60a33fcec03c01ad08ac8f4`. Current execution source and backend remain unchanged. Reduced control projection: `/tmp/videorc-fixes-final-evidence-20261003/preview-lifecycle-predecessor-projection.json`.

The comparison does not reproduce owner loss in the predecessor and does not identify the mechanism in current source. PR 564 remains open. Add bounded, actual owner/cycle/command evidence in an isolated diagnosis checkout before considering any behavior correction. Preserve both versions’ results; no causal or interference claim is established.

## Bounded diagnostic implementation and actual traces

An isolated six-file diagnostic slice adds opt-in actual main-window callbacks and request evidence, without changing readiness predicates, lifecycle behavior, retries or cycle counts. Root independently reproduces missing-evidence RED (desktop five expected failures/13 passing controls; Node three expected failures/two passing controls), reviews the full implementation and verifies GREEN (23 desktop/11 Node cases), typecheck, lint, format and direct checks. Final source fingerprint is `87aa7cc55f98d88dd93854ca9eff164947f4d20c97875d29fa707994f162a999`; source remains uncommitted at base `133a2a70`.

Three instrumented default probes then complete **PASS100 / PASS100 / PASS100**, each with 13 memory checkpoints and clean teardown. Main-window ownership remains ready during all cycles. Each trace observes the deliberately prevented initial quit, then the explicitly allowed final quit, contents destruction and exact current-owner cleanup. No renderer loss or stale-owner callback occurs in these runs. The original owner-loss failures are **not reproduced or resolved**; passing diagnostic repetitions do not replace them.

Reduced evidence: `/tmp/videorc-fixes-final-evidence-20261003/preview-lifecycle-diagnosis-projection.json`. Build projection: `preview-lifecycle-diagnosis-build-projection.json` in the same directory. Ordinary probe startup rebuilt backend/native addon in the isolated checkout on run one, then used normal incremental builds for runs two and three; the preflight copied backend digest must not be presented as their executed binary. Post-run backend SHA256 is `22e8ff70bcfe2cf68d14741a252c19b2c7d79e9276d7da8e07b1754e5ea90a71`. Exact per-run binary digests were not sampled. Rust source remains unchanged at base `133a2a70`, diagnostic source fingerprint is unchanged, and retained owned-process ledgers are empty after all three runs. Keep the finding open while continuing independent acceptance and meaningful caption diagnosis.

The reviewed diagnostic slice commits `d8d9b826d0f921a31e67f9afd6bedc9275482af3`, with immediate Shadscan37, and merges normally through [PR565](https://github.com/TheOrcDev/videorc/pull/565), main `fdba0d3423e9fecd91f6d1846b47e904c00a83ee`. Original owner-loss cause remains open; this commit supplies maintained evidence rather than a speculative lifecycle correction.


## Clean current-main final probe

The independent maintained remainder runs `pnpm probe:preview-lifecycle` on clean main812ba01a after the aggregate stops at the unrelated Comments contract. It passes100 cycles,13 memory checkpoints and exact owned teardown with zero alive recorded owners. Its bounded trace has no failed request or main readiness loss; main closes only after explicit allowed final quit. Report: `/tmp/videorc-fixes-20261003/docs/acceptance/artifacts/performance/preview-lifecycle-2026-10-03T23-46-47-899Z.json`; log `/tmp/videorc-fixes-final-independent-probe-preview-lifecycle.log`. This additional passing run does not explain or erase the original FAIL/PASS/FAIL episode.
