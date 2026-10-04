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
