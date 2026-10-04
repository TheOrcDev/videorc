# Plan 109: Diagnose recording layout controls blocking a newer intent

> Diagnosis-first fix plan. Planned at `05ff9188`, 2026-10-03, release 0.9.129. Drift check: `git diff --stat 05ff9188..HEAD -- scripts/smoke-preview-interaction-stress-app.mjs apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx apps/desktop/src/renderer/src/hooks/use-studio.tsx apps/desktop/src/renderer/src/lib/capture.ts`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

- Priority: P1; device recording-studio acceptance fails
- Effort: S–M
- Risk: MED; maintain source eligibility and latest-intent ordering
- Depends on: none; coordinate repetitions with plan 107
- Category: correctness / acceptance tests
- Confidence: HIGH for observed blocked control; cause and repeatability pending

## Failure and evidence

`pnpm smoke:preview-interaction-stress:devices` exited 1 after 84 seconds. Before recording, the Camera-only → Screen-only → Side-by-side overlapping burst passed. During the real-device recording phase, the same burst failed with `Layout button screen-only blocked a newer intent`. The smoke clicks the actual Scene buttons ten milliseconds apart, checking each native disabled state. This is a contract discrepancy, not yet an attributed production defect.

Evidence: `/tmp/videorc-qa-evidence-extra-20261003/06/run.log` and `/tmp/videorc-qa-evidence-extra-20261003/06/artifacts/report.json`. The selected screen was a real ScreenCaptureKit display; selected camera was AVFoundation. The 59.733-second recording passed the final-artifact analyzer. Floating, resize and docked native presentation phases passed; no measured dropped frames or geometry offset. The separate real-screen live-layout-switch recording smoke also passed. Do not discard these differences when diagnosing the rapid burst.

## Current implementation and boundaries

`scripts/smoke-preview-interaction-stress-app.mjs::issueLayoutIntentBurst` around line 323 runs the Camera-only, Screen-only and Side-by-side clicks in the renderer; it throws if any button is disabled. `runDeviceRecordingPhase` around line 374 starts recording through backend RPC, floats the native preview and opens Scene before repeating the burst.

`components/tabs/layout-tab.tsx:135` derives `hasCamera`/`hasScreen` from selected capture sources. At line 255, each preset is disabled for missing required sources or `stageBusy`. The comment explicitly requires presets to remain clickable while an earlier layout warms. The buttons do not directly disable for `layoutSwitchPending`.

`hooks/use-studio.tsx:8059` allocates a new intent ID, records pending proof, reconciles sources and sends `scene.layout.apply_live` during a session. Existing `studio-provider.integration.test.ts` and `lib/layout-transaction-policy.test.ts` establish backend proof, latest-intent and rollback conventions. Read those examples before adding coverage; retain asynchronous observations rather than fixed sleeps.

In scope: source eligibility during layout retirement, Scene button disabled-state ownership, live layout transaction reconciliation, and the smoke's recorded-session initialization/diagnostics. Out of scope: accepting genuinely unavailable devices, direct DOM re-enabling, bypassing backend proof, changing ten-millisecond overlap to sequential waiting, preview transports, encoders or broader source-switch behavior without evidence.

## Ordered work and verification

### Execution reconciliation — source ownership, 2026-10-03

Offline source-chain probe reproduced the eligibility loss without E2E. `live_source_switch.rs::reconcile_scenes` clears screen/window/camera slots, then repopulates only visible sources in the committed compositions. `live_layout.rs` calls it at layout commit and emits the resulting session-source snapshot. Renderer `sourceSelectionController.confirmed` unconditionally passes that snapshot to `source-selection-confirmed.ts::confirmedSourceSelection`, which replaces all selected IDs. With stable screen+camera selections and a camera-only confirmation, the helper produces `screenId: undefined`; `hasSelectedScreenSource` then makes Screen-only and Side-by-side ineligible. This explains why preview-only switching passes while live-session confirmation can disable the second rapid click. No device failure is needed to reproduce this chain; final device repetitions remain required after the batch.

Narrowly expand scope to `apps/desktop/src/renderer/src/lib/source-selection-confirmed.ts`, its `live-source-selection.test.ts` contract, and `crates/videorc-backend/src/live_source_switch.rs`/`live_layout.rs` only if needed to express the distinction. Selected source intent must remain separate from sources active in the current composition. Do not blindly keep every absent backend slot: an explicitly acknowledged Camera Off or capture None, genuine device loss, and successful source replacement must still update the proper selection. Build the real LayoutTab/provider regression through an actual session-source event after the first camera-only commit, with delayed proof and stable device-shaped IDs. Assert all three valid controls accept overlapping newer intents and only the latest commits, plus negative missing/off/explicit None cases. Preserve acknowledged source-switch and rollback semantics. Add bounded per-click diagnostics to the maintained smoke so the final device runs identify the owner if this source-chain fix is insufficient.

1. Run three isolated fresh-profile device stress repetitions, with unique output directories and no parallel media workload. Record only non-sensitive snapshots before/after each burst click: selected IDs/Off flags, device availability, current and pending layout intent, stage gesture state, backend scene revision and recording state. Compare direct-RPC session initialization with the real renderer Record action. Prove whether the source disappeared, a gesture busy state leaked, or the harness constructed a different session state. Do not infer the cause from `button.disabled` alone.
2. If the actual UI discards stable selected sources or leaves a busy state latched during a live layout transition, add a failing-before integration regression using the real LayoutTab, delayed backend proof and stable real-device-shaped selections. Prove that all three valid controls accept newer intents and that only the last intent commits. Keep a negative case for genuinely missing sources. Make the smallest correction to the proven owner; run focused desktop integration tests, typecheck/lint/format and `pnpm --filter @videorc/desktop test`.
3. If the discrepancy instead comes from the smoke's backend-only start, correct its initialization to reflect the production session contract and add a harness regression. Preserve the overlap and source eligibility assertions. Run the three device stress repetitions, `pnpm smoke:live-layout-switch-recording:devices`, `pnpm smoke:freeform-editor` and full `pnpm smoke:recording-studio:devices`. Run native lifecycle/placement probes when their ownership is touched, and Rust fmt/tests/clippy when Rust changes.

## Done and STOP criteria

- [x] The exact disabled owner and session initialization differences are documented with a bounded timeline.
- [x] A meaningful failing-before regression covers the cause, including genuine source loss and latest-intent supersession.
- [ ] Three fresh device stress runs meet existing button, scene, preview and final-artifact contracts.
- [ ] No extra settle wait, source-eligibility bypass, missing failure sample or silent preview fallback obtains the pass.

Stop if source permission/readiness cannot be established or the repeated failures are not attributable. Keep this an unresolved acceptance discrepancy and improve the diagnostic seam before altering production behavior. Future live-layout changes must preserve selected source identity independently of which sources the current composition uses.

## Execution preparation — actual UI RED and owner contract

The maintained actual-provider test now mounts the real `LayoutTab`, starts with stable AVFoundation/SCK-shaped selected IDs in a recording session, clicks Camera-only, consumes the actual session-source notification/status read, and holds older output proof. It fails on `screen-only.disabled` (expected false, received true), rather than a fixture timeout. Evidence: `/tmp/videorc-fix109-red.log`, one failure and 126 unrelated skipped tests.

`SessionSources.confirmed` and the source coordinator's start/`commit_video` paths already represent selected intent. Generic composition reconciliation was the conflicting writer. Health does not distinguish omission from explicit None: status reads derive health IDs from `confirmed` and mark missing fields None. Likewise `lastOperation` can be retained from an older request. Do not infer selection retirement from either. The planned narrow owner repair is an explicit primary visual-selection commit under the successful latest-intent/scene commit fence; generic transforms/visibility/reorders and secondary/simulcast composition edits must not derive selection from visible slots. Actual source operations remain authoritative for replacement and explicit None. Preserve microphone authority independently of possibly older layout params.

The corrected provider transport fixture must follow the verified Rust production response. Keep evidence distinct: actual UI RED proves the symptom, Rust failing-before ownership tests prove the backend repair, and the provider test checks the corrected contract through real controls. No protocol addition is required merely to force an unchanged frontend test to become green. No real-app/device run has occurred during this slice.

## Execution status — 2026-10-03

Implementation committed as `d28b71baf734de66e48644884e1820e31b0ef816` and merged through [PR 553](https://github.com/TheOrcDev/videorc/pull/553), main `6006e101d8951dc2eb4fd1c929cca4c64840b544`. `SessionSources.confirmed` remains selected intent. Only successful primary config transactions install visual selections inside the shared scene commit and latest-intent fence. Generic/secondary edits preserve selections, and visual commits preserve the current independent microphone receipt. No protocol field was added; actual source operations still own replacement/None. Source health remains truthful.

Focused verification passed 285 desktop, 64 Rust (52 live-layout + 12 source owner), and 22 Node tests. Root independently verified five actual UI cases, 154 source/layout tests, both Rust filters and final Node projection, plus TS checks, direct script formatting/syntax, Rust fmt and diff checks. One existing hook warning remains; Shadscan stays 37. Negative UI coverage preserves Off/None disabled states and rejects missing/unavailable selections before backend admission. Rust tests cover explicit capture tuples, interleaved mic receipt, stale/rejected commits, generic hidden/reordered scenes and secondary ownership. The actual UI GREEN uses the corrected backend fixture response; separate Rust RED/GREEN proves the production owner repair.

The maintained stress smoke records a bounded before/after/completion timeline with selected IDs/availability, pending intent/gesture, source revision, and distinct latest observed backend versus last proven scene revisions. The ten-millisecond overlap is unchanged. Three device stresses and full native/recording/freeform/E2E acceptance remain deferred to the end. Dev camera TCC is still a concrete limitation; this source/harness repair does not establish device acceptance.

## Current real-device evidence

The current9710de9a final36-stage recording/device batch passes its maintained real AVFoundation/SCK interaction stress with analyzed59.866-second recording, its real ScreenCaptureKit layout switch smoke and its native source-complete layout stress. The script requires both selected real sources and backend liveness before device recording. This is one of the required three fresh real-device interaction runs; two further isolated repetitions remain pending. The earlier development-camera permission limitation is historical and is not a current blocker for this successful run. Original failed rapid burst remains retained.
