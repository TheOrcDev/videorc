# Plan 108: Restore OBS import smoke coverage and owned process teardown

> Diagnosis-first fix plan. Planned at `05ff9188`, 2026-10-03, release 0.9.129. Drift check: `git diff --stat 05ff9188..HEAD -- scripts/smoke-obs-import.mjs scripts/lib/app-launcher.mjs scripts/lib/smoke-command-client.mjs apps/desktop/src/main/obs-import.ts apps/desktop/src/main/index.ts`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

- Priority: P1
- Effort: S–M
- Risk: LOW for harness repair; production IPC changes need separate evidence
- Depends on: none
- Category: tests / process lifecycle
- Confidence: HIGH for smoke timeout and invalid teardown API; timeout cause pending

## Execution status

Harness repair merged as `205a6f5e` in [PR 550](https://github.com/TheOrcDev/videorc/pull/550), main `50333be7`. The original owner-stop regression failed 0 vs 1; 47 focused Node tests now pass, including actual one-shot HTTP failure paths and canonical CLI entry paths. Root independently ran 43 OBS/parser/apply/directory-authority desktop tests with one existing platform skip. Production OBS and protected storage are unchanged. The prior `obsRead` stall remains unassigned; three clean real-IPC runs and operator-Deny characterization are deferred until all fixes. Harness implementation is not full acceptance.

## Failure and confirmed defect

`pnpm smoke:obs-import` exited 1 after 125.7 seconds with `Error: smoke command timeout`. The smoke does not identify which OBS operation timed out, so this is not yet proof that product import is broken. Evidence: `/tmp/videorc-qa-evidence-20261003/28-smoke-obs-import/run.log`.

Its `finally` calls `stopProcess(launched.child, { timeoutMs: 15000 })`. The real launcher returns `{ connections, process: child, stop }` (`scripts/lib/app-launcher.mjs:408`), without `child`. `stopProcess` returns `skipped` for a missing PID; its options use `childExitTimeoutMs`, not `timeoutMs`. Thus this smoke's cleanup does not stop the app it launched, on either success or failure. This can leave capture resources alive and invalidate later performance evidence.

The failed run actually left its app and backend alive. The QA cleanup verified the backend birth token/executable from the app-owned process ledger, the app PID from its isolated profile SingletonLock, their parent relationship, and zero sessions in that profile. Both exact owned PIDs were stopped with bounded escalation; `/tmp/videorc-qa-obs-owned-cleanup.json` records `remainingPids: []`. This proves the teardown defect; it does not identify the stalled OBS operation. Performance-check and short session-decay runs that followed the failed smoke passed their scenario assertions, but ran while the leaked idle app was alive and should not be used alone as isolated hardware-performance evidence.

The harness also implements a separate HTTP client using the default pooled agent and retries every eval failure until the overall deadline. The maintained `smoke-command-client.mjs` instead validates the per-run capability and uses one-shot connections with explicit error/retry classification. The divergent client is a lead; replacing it is not, by itself, proof of the timeout cause.

A diagnostic-only copy used the maintained one-shot client, logged operation boundaries, and awaited `launched.stop()`. The diagnostic waited for both backend-ready and preview-motion-ready. Discovery passed; `window.videorc.obsRead('Fixture Collection', 'Fixture Profile')` timed out after 15 seconds, before the key-channel assertion. Teardown completed. Evidence: `/tmp/videorc-qa-evidence-followups-20261003/08/run.log` (18.2 seconds total). This rules out blanket retries and the pooled client as a sufficient explanation; it does not yet identify the production IPC cause. A direct probe of the production filesystem/parser functions against the same scrubbed fixture passed discovery, setup, key stripping and the dedicated key read (`/tmp/videorc-qa-obs-parser-probe.log`). That is parser evidence only; it does not close the real IPC timeout.

`main/index.ts::readObsSetupForRenderer` parses first, then issues an output-directory capability and imports image-source capabilities through the backend admin channel. Characterize these boundaries separately, including admin-channel readiness and failure deadlines, before blaming the pure parser. There is also a concrete OS-dialog lead: the fixture's recording folder exists on this host, `outputDirectoryAuthority().remember()` writes via `PersistentDirectoryAuthority::writeDocument`, and the codec calls Electron `safeStorage.encryptString` synchronously. A pending macOS Keychain prompt can block that path. Clean operator-Deny reproduction is required to distinguish prompt-blocked storage from backend/parser failure; do not weaken encryption or auto-approve the prompt. Preserve the guarded/stale-path behavior and secret separation.

## Current state and scope

`scripts/smoke-obs-import.mjs` assembles scrubbed OBS fixtures, launches an isolated dev app and calls `window.videorc.obsDiscover`, `obsRead` and `obsReadStreamKey` through real IPC. It must verify discovery, canvas/scenes, key stripping from setup and the dedicated apply-time key channel.

`main/index.ts:13700` registers these three secure IPC handlers, backed by `main/obs-import.ts`. Do not weaken sender validation, capability authentication, path validation or secret separation to repair the smoke. Follow existing launcher and one-shot command-client tests for lifecycle/transport conventions.

In scope: the OBS smoke, a focused harness contract test, shared command client use and the launcher stop API. Inspect production OBS/preload/IPC code only to diagnose a reproducible operation failure; any needed production edit requires an explicit narrowed cause and corresponding test first. Out of scope: changing OBS configurations, importing the user's real stream key, blanket retries of mutations, broad process scans/reaping, and extending timeouts to conceal a stall.

## Ordered work and verification

1. Add a harness contract regression that provides a launcher exposing `stop` and proves it is awaited once on success, discovery failure, malformed response and timeout. Replace the invalid teardown with `await launched.stop()` in `finally`. Keep fixture/profile data isolated and clean up only after owned teardown completes. Run the focused Node tests and `pnpm test:scripts`; expect exit 0 and no orphaned owned child.
2. Log each operation boundary without values or credentials. Use the maintained command client and retry only explicit bootstrap/transport cases. Run `pnpm smoke:obs-import` with a unique evidence directory and identify the exact stalled operation. Preserve the failure when production IPC is implicated; do not reclassify all errors as “not ready”.
3. If a real OBS IPC defect remains, reproduce that operation in isolation against the same scrubbed fixture and add a failing-before parser/IPC regression before fixing the minimal path. Run focused desktop OBS/IPC tests, TS typecheck/lint/format, the full Node suite and at least three fresh OBS smoke runs. Verify that every run exits and every owned child is gone.

## Done and STOP criteria

- [ ] Discovery, setup parsing, secret stripping and apply-time key-channel assertions are all reached and pass through real IPC.
- [x] Smoke teardown uses the actual launcher API and is proved on success and every failure path.
- [ ] No user OBS data or credentials are copied into logs/evidence; fixtures remain scrubbed.
- [ ] Three fresh `pnpm smoke:obs-import` runs exit 0 with bounded cleanup.

Stop if cleanup cannot establish exact ownership or if a production operation still hangs after the client is corrected. Record the concrete pending operation and add focused IPC evidence before expanding scope. Future launcher API changes must have harness consumers checked for stale property names.

## Current three real-IPC trials

Three predeclared full original runs on main `6dbabec1` all exit 1: trial 1 takes 19.54 seconds, trial 2 18.43 seconds, and trial 3 18.68 seconds. Each launches the real isolated app, passes backend/preview readiness and `obsDiscover`, then times out in `obsRead` at its unchanged 15,000 ms operation deadline. Canvas/scenes/key-stripped setup and the dedicated apply-time key channel remain unexecuted. No timeout extension, ambiguous request replay, fixture substitution or stop-on-green sampling is used.

Each run awaits the maintained owned teardown. The exact controllers 67713, 69292 and 70933 are reaped; their groups and observed app-ledger PIDs are absent. This does not establish cleanup of unrecorded descendants. Private logs and profiles remain under `/tmp/videorc-obs108-final-main6db-20261004`.

A read-only Computer Use observation of the exact QA app times out; later inventory shows no running Electron QA app. No current SecurityAgent prompt or automatic approval rejection is observed. The older Keychain lead remains a hypothesis, not the cause of these current timeouts. Read-only continuation must distinguish pure parsing, synchronous directory-authority persistence, backend capability registration and image import before a supported repair. The original diagnosis scope and protected-storage boundaries above still apply.
