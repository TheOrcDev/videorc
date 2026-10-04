# Plan 116: Keep full-suite chat rollover coverage without rendering thousands of unrelated Activity rows

> New verification defect during final QA fix validation, 2026-10-03. Base: merged main `c508520da655f8a5ab176b8d2daadff5612cd759`. This is an integration-fixture stability repair, not an attributed production rendering regression.

## Status

- Priority: P1; the maintained default full desktop command fails
- Effort: S
- Risk: LOW if every rollover/unread assertion and real consumer is preserved
- Depends on: 099, 100 and completed 113
- Confidence: HIGH for full-suite failure; production latency remains unmeasured

## Evidence and owner

Root's full `pnpm --filter @videorc/desktop test` runs alone on clean merged main. Result: 2 failed / 2,806 passed / 1 existing skip across 268 files. Both failures are the existing provider and detached `counts fresh follow deliveries on its hidden pane at rollover` cases in `apps/desktop/src/renderer/src/components/stream-manager/chat-arrival.integration.test.ts`; their unchanged 5,000 ms deadlines expire at 5,706 ms and 6,353 ms. Log: `/tmp/videorc-fixes-final-desktop.log`. The same cases fail with competing compiler checks and pass in the isolated six-file subset (3,148 / 2,922 ms). Preserve every run; do not report a full-suite pass from the subset.

The fixture seeds all 1,999 retained messages as follows. The actual StreamManager mounts ActivityPane, whose existing `shown.map(ActivityRow)` renders those 1,999 unrelated rows repeatedly for this unread-counter test. Root inspected both production files. The fixture needs a full 2,000-message retention buffer and constant Activity identity count during eviction, but does not need 2,000 expensive row menus to prove arrival ownership. Happy DOM timing does not establish the native browser's product latency.

## Concrete fix plan

1. Minimize only the two follow rollover fixtures: retain exactly 1,999 initial messages, with the oldest five messages as real follow rows and the remainder ordinary chat. Append the same five fresh follow deliveries through the same real provider/detached reducers and actual StreamManager.
2. Keep the existing unread assertions at 1, 2 and 5. Add explicit retention length assertions (1,999 then 2,000, fixed through eviction) and verify Activity row count remains constant after reaching 2,000 while old follow identities are replaced. This preserves the failure trigger for a count-based unread implementation, filtered admission ownership and the real Activity consumer with a bounded number of expensive mounted rows.
3. Do not mock ActivityPane, skip provider/detached cases, lower message-buffer size, change production behavior, alter Vitest concurrency/timeouts, add sleeps or change existing deadlines. Avoid unrelated product memoization/virtualization in this fixture repair.
4. Run the unchanged full desktop command, relevant focused chat/delivery/activity cases, typecheck/lint/format and Shadscan. Root reviews the complete small diff, commits and pushes this repair through its own normal PR/main merge. Rerun the full desktop suite on the final source if required; continue the deferred broad and app/E2E batch.

## Acceptance and STOP

- [x] Both real owners still prove 1,999→2,000 and constant-size rollover, filtered follow unread counts and real mounted Activity identity replacement.
- [x] The unchanged default full desktop suite passes without dropped assertions, deadline/concurrency changes or production changes.
- [x] All failed logs are preserved and the subset pass is not relabeled full-suite acceptance.

Stop if a bounded mixed fixture cannot preserve the actual regression trigger. Diagnose that trigger before any further change. A separately measured production Activity performance defect needs its own plan and evidence.

[PR 562 JS CI](https://github.com/TheOrcDev/videorc/actions/runs/37153421327/job/111291780520) independently reproduces the two five-second follow rollover deadlines after the repaired asset gate passes. Its full desktop result is preserved in `/tmp/videorc-fix113-ci-js.log`. This confirms the maintained runner discrepancy, not a need to raise timeouts or weaken the asset check.

## Independent final review and full-suite result

Root reviewed the entire frozen one-file patch (`3fe9b133f6a8fb4e97b89c0f194cbfddbcce26787b9a3e7996598994510cd5ec`): 23 additions / 4 deletions, only the fixture selector and explicit retention/mounted-identity assertions. Both existing owners, real UI, all unread assertions and maintained deadlines/configuration remain unchanged. The exact Activity identities prove six mounted rows remain constant while the oldest follow is replaced. No production file changed.

Root independently repeats the unchanged full desktop command alone: **2,808 passed / 1 existing skip across 268 files**, 40.44 seconds; `/tmp/videorc-fix116-root-desktop-full.log`. The executor's independent full run passes the same counts in 36.53 seconds, with 98 additional focused chat/delivery/activity cases passing. Earlier local and CI RED logs remain retained. Subsequent final broad checks and app/E2E acceptance are separate.

Root's subsequent typecheck, lint, format and diff checks pass under maintained commands; one existing use-studio hook warning remains. These are `/tmp/videorc-fixes-final-{typecheck,lint,format}.log`. No timeout, test runner option or production source has changed.

Plan 116 is committed as `a67bd666068c13fca138eccb0a36be7428c9067e`, pushed and normally merged through [PR 563](https://github.com/TheOrcDev/videorc/pull/563) to main `6f9995eb6fefc3c9e6239d4c8ce832782d6202f2` at 21:05:34 UTC. Root's immediately preceding Shadscan stays at 37/54 findings. The final desktop/typecheck/lint/format checks above exercised the exact source tree now merged; the execution checkout is clean and equal to origin/main. Full Node/Rust and app gates remain separate.
