# Plan 120: Restore the detached Comments probe command contract

Discovered during final QA on clean main `812ba01a7dfe59f30b823aaace0f25ed95059002`, 2026-10-03 UTC. Priority P1; effort S–M; risk MED. Source attribution is unassigned. Preserve the failed aggregate and existing smoke authorization boundaries.

## Observed failure

`VIDEORC_PERF_RETAIN_ARTIFACTS=1 pnpm smoke:recording-studio` exits 1 at the maintained detached Comments command relay probe. The child `pnpm probe:comments-window` exits 2 with **Invalid smoke command or parameters.** The probe first passes live/history cache ownership, detached renderer authority, correlated highlight/send results, delayed acknowledgement, all six responsive widths, toggle-close/reopen, persisted frame restoration and live-cache restoration. The next command is rejected before its acceptance assertion. This is a real app IPC/probe discrepancy; it does not yet demonstrate a production Comments defect.

The preceding maintained steps pass, including the corrected caption HTTP contract, all-layout finished recording artifacts, app-quit finalization, record-latency gate, output-stall microphone survival, imported screen artifacts, real-user preview first frame, layout/source preview liveness, active-session live-layout recording and comment-highlight stream artifacts. The aggregate is **failed**, not passed. Keep `/tmp/videorc-fixes-final-recording-studio-caption-clock-fix.log` outside Git. Later maintained steps were not executed by this aggregate.

## Ordered work

1. Identify the exact first rejected caller command and compare its parameters with the actual main smoke router validator and target handler. Preserve bounded assertion/stage evidence and verify owned teardown. Keep raw app credentials, user profiles, media and full private status out of committed evidence.
2. Reproduce the demonstrated contract disagreement with a meaningful regression at the caller/validator boundary. Determine whether the maintained probe is stale, a legitimate command lost validation support, or a parameter shape is invalid. Do not widen smoke authorization, allow arbitrary renderer commands, skip the scenario or relax assertions.
3. Review the attributed failing-before result and implement the smallest scoped caller/validator repair. Preserve detached preload authority, correlation, state/cache ownership and normal production behavior.
4. Run focused checks, root review and immediate Shadscan floor37; commit/push/merge this repair separately through the normal PR flow. Run the unchanged Comments probe after the source batch, then complete or accurately account for all remaining final gates. Keep original failures visible.

## Done criteria

- [x] The exact rejected command and source owner are attributed.
- [x] A meaningful failing-before regression passes after the minimal repair.
- [x] The unchanged maintained Comments probe completes with owned teardown.
- [ ] Final aggregate results and remaining independent failures/device blockers are reported accurately.

Continue independent final checks while diagnosing this contract. No speculative production change is authorized by the generic error alone.

## Attributed static contract mismatch

Immediately after reopen, `probeCommentsArrivals` calls `comments-window-push-delta` with its adoption boundary. Main already implements this handler and passes its delta through `validateElectronInvokeArgs`, but `SMOKE_COMMAND_NAMES` omits the exact name. The generic smoke payload validator therefore returns null before the handler can run. The existing Node caller check sees source text instead of driving the real validator and missed this disagreement.

Both new helpers then send2,000-row snapshots. The generic smoke JSON key/entry budget is2,000 for the entire payload; the array alone consumes it, before any message fields. These retained-message fixtures cannot pass that unchanged generic validator. The HTTP body limit remains1MiB and depth8. Root has reviewed these source boundaries, but an actual failing-before caller/validator regression is still required.

Constrain any repair to the implemented delta command and schema-valid bounded Comments fixture snapshots. Preserve the generic budget, depth/body/prototype checks, authenticated loopback capability, mode allowlist, detached preload authority and ownership checks. Compare and reuse maintained snapshot/delta validation instead of permitting arbitrary large payloads. Do not shorten2,000-message rollover/accounting coverage.

## Actual HTTP RED independently reproduced

The new regression-only `smoke-comments-contract.test.ts` drives **both unchanged maintained helpers** through the actual loopback `handleSmokeCommandRequest`, with explicit HTTP readiness and bounded owned connection/server cleanup. Agent and root independently run the exact focused Vitest command: **17 expected failures/23 passing controls**, including all10 existing security tests. Both helpers reject initial adoptionHTTP400, independently valid2,000-row hydration rejectsHTTP400, packaged delta reaches400 instead of expected403, and13 malformed snapshot cases currently reach the route instead of being rejected. There are no import, instrumentation, readiness or cleanup failures. Typecheck/Prettier/diff whitespace checks pass.

Frozen RED fileSHA256 `60592b0852dc24b995943da9e187d0956a37a6ca61b1f51326e8bbf87e3c2eb6`; root log `/tmp/videorc-fix120-root-http-red.log`; agent `/tmp/videorc-fix120-http-red.log`. Production source remains unchanged during RED. Root has reviewed the complete test and approves only the previously scoped two-command repair: delta keeps the generic2,000-key limit; snapshot gets a specific finite100,000-key ceiling alongside existing IPC100,000-node validation, explicit<=2,000-message envelope/header/mode/receipt checks, unchanged depth8/body1MiB/prototype checks and unchanged packaged subset. The main snapshot handler must reuse the validated values. No shared IPC/public authorization changes, shortened fixtures or per-fix app/E2E are part of this slice.

## Reviewed GREEN and separate merge

Exactly three files change: main smoke security, main handler and the new actual-HTTP regression. Main validates before taking fixture ownership or clearing caches and reuses the validated view. Snapshot session ownership remains optional for valid idle/History hydration; all existing send/destination phases are accepted. Header/bounded IPC checks do not claim a full message/provider schema. The existing shared schema and packaged command subset are unchanged.

Root reviews the complete final patch and independently runs **118 desktop cases/10 Node cases**, typecheck, direct format and diff checks; all pass. Agent full lint/format checks also pass with only the existing hook warning. Three-file fingerprint `995249d2142e30695c95d31af6d74a4ff6a6178bf351ef19b2cdef180f88f653`; final patchSHA256 `0613ab698d8d754ce7a3645afb433e246c7a9ab181a6344a718d5a57fd83bc8f`. Root logs `/tmp/videorc-fix120-root-{desktop-green,node-green,typecheck,direct-format}.log`.

Immediate pre-commit Shadscan37 precedes commit `a58bef40fe747464c270eb929311324932f6bb9f`. The fix is pushed and normally merged through [PR567](https://github.com/TheOrcDev/videorc/pull/567), main `74e00e7c8371b62945acdb26ed2190bed19aa5e8`; execution checkout is clean and matches origin/main. App/E2E remains deferred to the final batch. The unchanged Comments probe is not yet rerun, the original aggregate stays failed, and Plans121/122 diagnosis precedes the next full batch.

Its complete JS CI job111321580092/run37163483104 succeeds on the exact source head. Root verifies the full log: **2,851 desktop cases pass/one existing skip,270 files**; Linux Node **1,804 pass/five skips,279 suites**. These platform/source counts stay distinct from the prior local1,824 Node pass result. Raw private log `/tmp/videorc-fix120-ci-js-green.log`; other runtime/native/device acceptance remains pending.

## Current maintained app acceptance

On clean main `9710de9a`, the unchanged Comments probe completes in the final `pnpm smoke:recording-studio:devices` batch. All **36 maintained stages pass**, with actual aggregate exit0 and `recording-studio-gates: PASS`, including all33 standard stages and all3 real-device stages. The initial rejection and failed main812 aggregate remain preserved. Private log `/tmp/videorc-fixes-final-recording-studio-devices-main9710de9a.log`. Broader local gates and independent original incident diagnoses remain separate.
