# Plan 123: Update the production deadline wiring contract check

Discovered by final `pnpm smoke:recording-studio:devices` on clean main `1b50883d677a242b19972493dfd670b474c1bfaa`, 2026-10-04 UTC. Priority P1; effort S; risk LOW. Test-only discrepancy after the reviewed Plan122 arm-factory extraction; production policy is unchanged in this slice.

## Observed failure

The aggregate exits1 at its Node analyzer/A/V script stage: desktop503 pass; Node **1,823 pass/one fail/zero skips,1,824 tests/279 suites**. The failing existing test is `production lane cannot dispatch without an independent deadline`, `scripts/lib/live-control-recycle-smoke.test.mjs:91`. Its whole-file regex expects the direct arm call after `let Some(execution_deadline_completion)` and before an `else`/`command-not-applied` branch. The production wrapper now passes that unchanged arm call to the reviewed helper; the helper binds `arm(state.clone())` and returns `DeadlineUnavailable` before executor dispatch. The response mapping remains separate. Meaningful Plan122 actual-owner/invocation tests independently pass13, with fullRust2993/12ignored. The Node failure does not demonstrate missing production safety wiring.

Keep the complete private aggregate log `/tmp/videorc-fixes-final-recording-studio-devices-main1b50883d.log` and root focused RED `/tmp/videorc-fix123-root-red.log`. This aggregate remains failed. Its live-audio, backend, app, artifact and device stages are unexecuted, not passed. The five preceding maintained native-surface trials independently pass at unchanged limits and remain distinct evidence.

## Ordered work

1. Reproduce the exact unchanged Node test, trace production entry→arm factory→helper guard→dispatch→fail-closed response mapping. Review the single-file test-only correction before committing.
2. Scope existing wiring assertions to the actual production wrapper/helper and fail-closed response owner. Verify the wrapper still supplies the real independent arm and original budget; verify a missing completion returns `DeadlineUnavailable` before executor dispatch. Preserve existing runtime worker-floor assertions and the no-application response contract. Do not weaken to a permissive whole-file name match, delete the safety assertion, or change production code/timing. Keep Plan122 actual runtime tests as the behavior proof; no redundant implementation-mirroring test suite.
3. Run affected Node file and full `pnpm test:scripts`, direct/full formatting and whitespace checks. Root independently reruns focused GREEN and reviews exact scope/fingerprint. No app/E2E per fix.
4. Immediate Shadscan37; one test-only commit/push/normal PR merge to main. Restart the maintained final recording-studio/device batch after this source queue is merged. CI/Windows runtime evidence for Plan122 remains separately pending.

## Done criteria

- [x] Exact focused RED and source-wiring discrepancy are verified.
- [x] Existing check preserves fail-closed production wiring with the new scoped call boundary.
- [x] Focused/full Node and format gates pass; reviewed one-file fix is merged.
- [x] Final maintained app/device results retain the original failed aggregate.

## Independent focused RED and matching source CI

Root runs the unchanged affected Node file: **one failure/eight passing controls, nine tests**, exit1. Exact failed assertion and original production call boundaries match the aggregate. PR568 exact head10011128 also completes its JS job111324743439 with the same contract failure: full desktop2,851 pass/one existing skip; Linux Node1,803 pass/one failure/five existing skips. Overall JS CI is failed, not green. Source run37164567164 and private log `/tmp/videorc-fix122-ci-js-stale-contract-failed.log` establish provenance. This confirms the single test-only follow-up; no new production attribution is inferred.

## Reviewed correction verified and merged

Root reviews the complete one-file27-insertion/two-deletion diff and verifies SHA256 `15ab691a118f5023508abfcc14af613eaadc09a3fc45651d73988478ed764b1d`; test fileSHA256 `8f99ea3ee1f3bfc10af2b9069172cd7b954490a9a6fe2e41e5c43ae19331ee28`. The existing test scopes all three actual top-level production bodies, preserves original arm/budget forwarding and verifies the missing-completion refusal precedes first executor dispatch. Response and worker-floor checks remain present. No new tests or production edits are added. Root independently verifies GREEN9/9, `/tmp/videorc-fix123-root-green.log`. Agent full Node actually exits0 with **1,824 passing cases/279 suites/zero failures or skips**; full/direct formatting, syntax and whitespace checks exit0. Private logs `/tmp/videorc-fix123-{full-node,full-format,direct-format}.log`.

Immediate Shadscan remains37. Commit `570334b7d30ef90d0b349f2477f2388b540281ea` merges normally through [PR569](https://github.com/TheOrcDev/videorc/pull/569), main `9710de9ae19a48f23a74d64c53489b2cee5de18b`, 2026-10-04T00:30:01Z. Backend sourceSHA256 remains `9d092ed03dc7ffce2984819f7543cffd7efdc65f6631d0ab4047801bf0a54c13`, identical to the independently verified Plan122 correction and five preceding native trials. Final maintained recording-studio/device batch restarts afterward; CI/Windows and broader app acceptance remain pending. Original failed aggregate is retained.

The exact correction head570334b7 subsequently passes its complete JS CI job111326363846/run37165123560. Root verifies full private log `/tmp/videorc-fix123-ci-js-green.log`: desktop2,851 pass/one existing skip,270 files; Linux Node1,804 pass/zero fail/five existing skips,279 suites. This supersedes the stale-contract failure for current source without discarding its original evidence. Rust/Windows and final app/device results remain separate/pending.

## Final recording-studio/device batch

The corrected current-main `9710de9a` batch completes all **36 maintained stages**, actual exit0 with `recording-studio-gates: PASS`: desktop503 and Node1824 pass, every maintained recording/preview/artifact stage passes, and all3 real-device stages pass. This establishes current app/device acceptance for the maintained aggregate. The prior failed main1b aggregate remains failed and retained; broader local/feature and Windows gates remain separate.
