# Plan 134: Dispose losing record-latency smoke waits

## Finding and evidence

Priority P2; effort S; risk LOW. Written against main`b66e5eac` (non-plans source`7f345759`) on2026-10-04. This is a smoke-controller lifecycle discrepancy, not a recording latency or artifact failure.

During the unchanged full local bundle (session56824), the record-latency gate reports all5 analyzed artifacts and enforced latency budgets PASS, yet its exact Node controller81592 remains alive afterward. Exact parent evidence is root69799 → shell69840 → pnpm81536 → controller81592. Read-only inspection finds no controller child and no network socket; no broad cleanup or user process signal is performed. The controller later needs its remaining event deadlines to expire before the package chain can advance; record the actual exit observation before asserting the observed linger duration.

The actual `BackendEventRecorder.waitFor` in `scripts/smoke-record-latency-app.mjs:190–207` owns a timeout and removes it only upon matching an event or deadline. `runCycle:400–424` arms a failed-start waiter for each cycle and races it against the successful recording event. On successful start, this losing failed-start waiter remains active with its original120s deadline. There is no waiter cancellation/disposal or recorder teardown in the finalizer (`698–705`). This is a direct missing lifecycle owner, distinct from the app's bounded stop/reap. Preserve the original latency/startup budgets, sessions, intended profiles and artifact gates.

## Correction sequence

1. Give these event waits an explicit cancellable owner (or bounded recorder disposal) that clears each losing timeout and unregisters its waiter without converting an actual start failure into success. Keep the recorder listener removable. Follow the existing pure-helper/test style; avoid exposing shipping renderer/backend internals. Include matching completion, unmatched disposal, failure completion, idempotent disposal and failed-run cleanup behavior.
2. Prove a meaningful RED using the actual event-wait owner with injected scheduling or supported fake timers: a successful recording path must leave zero failure-wait timer/registrations; disposal must not reject unobserved promises or fabricate a recording/ACK. Complement it with an actual failed-start case. Do not use a fixed sleep as readiness proof or write a test that merely asserts source text.
3. Wire teardown in `finally` to dispose recorder waits and close both renderer/remote sockets, awaiting bounded close when required, before final app teardown. Attempt every owned teardown even when an earlier step fails. Retain isolated profile/evidence if app cleanup is unproved; do not print discovery credentials. Preserve original operation errors and artifact verdicts.
4. Run the affected Node tests and type/lint checks appropriate to changed files. If an async/process Windows test is changed, run affected filters25times and full Windows Rust3times in PowerShell7 before handoff. Run the same full record-latency enforce gate after the fix batch, proving original5 artifacts/budgets and prompt controller terminal exit with captured owned cleanup. Perform the task Shadscan checkpoint immediately before its own commit/push/normal merge.

## Completion and boundaries

Close with a matching timer-owner regression and original artifact/latency PASS plus actual controller exit/owned teardown evidence. Do not change production session start/stop, compositor, encoder, microphone, timeout budgets or artifact limits to fix a controller timer. This newly written plan is pending; no source edit, test execution or supported production-cause claim has occurred.


Actual terminal observation: controller81592 is absent at05:45:42UTC and the original package chain has advanced to system audio. Its report generatedAt is`2026-10-04T05:43:01.552Z`; the controller remained observable at05:44:48UTC. These samples bound the observed linger but do not measure exact exit time. No process was killed to advance the chain. Its5 artifact cases and original enforce verdict pass. The missing losing-wait timer ownership remains a supported smoke cleanup issue.

## Actual regression and prepared repair

The same-byte actual caller/recorder regression produces2 expected failures and6 passing controls before repair; root independently reproduces the original losing120000ms deadline counts before fixture cleanup. A setup/import failure is retained separately and is not the behavioral RED. The prepared local cancellation/recorder/socket/app teardown repair passes19 focused cases and all1879 Node cases with zero failures, skips or cancellations. Owned-file formatting, syntax and diff checks pass. Root independently reconstructs the previously reviewed sources and proves final formatting is byte-for-byte the expected Prettier transformation. The original start/stop/final-artifact operation bodies and deadlines remain equivalent.

The four-file source/workflow correction is committed326b9881436341664b8045f73e9b98723eb8a685 and normally merged through PR585 to maincacc3c7e19d1dbfbfa6b7ad6d80cc923e7ebb722; immediate whole-worktree Shadscan score37 meets baseline/floor37; final actual five-artifact latency enforcement runs after the fix batch. Actual Windows25 repetitions and3 full Rust passes for this source remain pending. Its send-throw case also demonstrates a separate existing shared remote-client request timer/listener leak; [Plan137](137-clean-up-shared-remote-client-waits.md) owns that follow-up rather than silently treating the retained owners as cleaned up here.

## Final-batch real-app observation

The unchanged full local bundle on source6dbabec runs all five original cycles with artifact analysis and enforce=true; every latency budget passes. Cold click-to-recording is197ms; warm p95 is85ms. The report is generated07:04:17.664Z and the next system-audio stage is observed07:04:46.939Z, bounding advancement to29.275s afterward. Exact controller exit time is not measured, so this is not a precise terminal-latency claim. The bundle later fails at separate fake-provider accounting; its exact child/group and14observed app-ledger PIDs are absent. Actual Windows repeated raw evidence remains pending. Private report SHA2568f45d54d917ee90caf615be9ed45671b3169fd28a5bc989642d09fd788bc10a3; original failed run retained.
