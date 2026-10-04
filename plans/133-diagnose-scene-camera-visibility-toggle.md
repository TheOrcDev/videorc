# Plan 133: Diagnose the scene camera-visibility toggle

## Observed failure

Planned against main `9fd54cef4afe95d0eaac5434e4d147c2ff1458ee`, whose non-plans tree is byte-identical to source `7f345759dba8ab33613cad399be24bb54a9f733e`. Serial actual `pnpm smoke:scene-presets` exits1 under owned child75530 in root feature queue93435. Camera Off/On save/apply round trips, working renderer restart, live A/B selection and finished initial recording pass. The scene reaches a selected real MacBook Pro camera, camera-only layout and no background asset, then times out at the original120,000ms wait for `camera visibility false`. Last state remains visibilitytrue/modifiedfalse, canSavetrue, cameraOfffalse, same selected camera identity, availabilityavailable, connected backend, no pending layout/visual/source/gesture transaction, and matching confirmed/backend scene revision1791090273986.

Private retained log/artifacts: `/tmp/videorc-fixes-final-evidence-20261003/features-main7f345759/scene-presets`. Hidden-camera save/update/show/apply/restart and visible/hidden finished camera-only artifact comparisons are unexecuted. This is not a proved TCC denial, inactive camera, product-handler defect or harness-click defect. Preserve the full failed snapshot privately. Priority P1; effort M; repair risk MED; symptom confidence HIGH/cause UNASSIGNED. Original Plan103 visibility-snapshot regression and Plan101 Camera Off semantics remain separate.

## Verified current boundaries

`scripts/smoke-scene-presets-app.mjs:355–380` reads actual backend `scene.get`, selects its camera inspector button, awaits the exact `source-visible-{camera.id}` element, rejects disabled controls and clicks when its aria-checked differs from the target. It then checks actual provider canSave/sourceVisibility and selected-device identity. No explicit synchronous native pointer dispatch is claimed from this script's DOM click.

`components/tabs/layout-tab.tsx:978–1007` disables SourceVisibilityField only for active sessions/stageBusy; the actual Radix Switch has `checked={source.visible}` and `onCheckedChange={(visible) => void onVisibilityChange(source.id, visible)}`. `components/scene/scene-stage.tsx:533–556` owns the source selection ToggleGroup. `hooks/use-studio.tsx:7771–7840` silently refuses unavailable client/source ID, snapshots scene identity/layout intent, requests `scene.source.visibility.update`, validates the ACK against scene/intent/client/native revision, applies committed scene and persists the resulting layout sourceVisibility. Current identity compares the whole scene except this source's visibility. Existing `studio-provider.integration.test.ts` visibility cases around4516/4534/4596/4713 exercise the actual provider but do not by themselves attribute this real-backend/UI failure.

## Ranked hypotheses and discriminating evidence

1. The actual DOM selection/click does not dispatch the intended owning callback (stale/duplicate inspector, delayed selection, wrong aria state, detached node). Prediction: exact current control identity/connectedness/aria/disabled state and handler admission show no matching visibility RPC.
2. Provider admission or response fencing retires this request against a legitimate or erroneous scene/intent/revision change. Prediction: actual source IDs and bounded admission/ACK/echo/proof milestones identify the failing comparison; original source identity and selected-device contracts must remain intact.
3. Backend visibility mutation or a subsequent preview scene rebuild restores visibilitytrue. Prediction: ordered actual scene.changed/ACK/config/proof records identify the first restoration and its owning scene revision. A direct provider action is only a discriminating control, never a replacement for original UI acceptance.

## Ordered work and boundaries

1. Read AGENTS/domain docs/ADRs, Plan103 and the actual script, inspector, provider action, native-preview reconciliation and backend visibility mutation. Inspect original retained state/finished initial artifact report. Root feature queue is terminal exit1 with seven independent passes; all recorded queue/PNPM owners are absent. The executor owns one exclusive diagnostic workload; no competing local app/compiler/audit/media workload.
2. Return a bounded read-only attribution/proposal first. When required, propose ONE owning diagnostic reproducing the actual UI path and recording control identity, callback admission, visibility RPC, ACK/echo and scene/native revision/config ordering. Preserve source device identity, actual camera selection, every original120s/final artifact deadline and all scene semantics. Use explicit readiness/ack/ownership channels; no retries-until-green, bypass/direct-action substitution, threshold relaxation, fake camera relabeling or guessed policy repair.
3. Root reviews the actual reproduction/evidence and a meaningful test-first boundary before source correction. Reproduce actual handler/backend behavior or the actual harness selector with the same test body before/after; a mocked desired outcome is insufficient. If instrumentation is necessary, keep bounded sanitized observations/debug scope and disclose overhead/omissions. Complete exact task/RPC/app/backend/helper child/group/profile cleanup before assertions; preserve every failure and never broad-scan processes.
4. Apply only the supported minimal repair after actual RED and whole-diff review. Keep Camera Off separate from visibility, selected device identity, pending-intent fences, native transport, capture ownership and saved/restarted/live snapshot contracts. No UI redesign, public protocol expansion, capture/audio/encoder behavior changes or user-worktree mutation is authorized by this symptom. One isolated executor is the sole source writer.
5. Run meaningful focused provider/inspector/helper/Node/Rust neighbors as touched, TS typecheck/lint/format, Rust fmt/strictClippy/tests if needed, and immediate complete-tree Shadscan baseline/floor37 before exact in-scope commit/push/normal main merge. Windows async/process tests require affected filters25times and full suite3times.
6. Run the complete unchanged scene-presets smoke after merge, including the original real-camera visible/hidden every-frame artifact comparison and save/apply/restart/live visibility. Camera denied/unavailable/dark is an explicit acceptance blocker, never a synthetic PASS. Run affected recording/native-preview gates and remaining full local bundle with unshortened60-minute preview/15-minute recording endurance. Earlier independent source/caption/vertical passes remain distinct, justified by unchanged paths.

Scratch/raw logs/media/profiles remain private `/tmp`; only maintained reviewed diagnostics/tests enter source. No code edits or additional local workloads are approved until root reviews attribution/RED/proposal. A supported harness fix must preserve the actual UI goal rather than replacing it with direct backend mutation.

## Done criteria

- [ ] Original UI failure and exact control/RPC/scene ownership cause attributed.
- [ ] Actual owning RED/GREEN and minimally scoped reviewed source fix, if supported.
- [ ] Complete real-camera scene smoke including hidden/visible artifacts passes, or an actual separately documented capability blocker exists.
- [ ] Relevant full gates, intentional commit/main merge and user-change preservation verified.

## Read-only review and approved diagnostic

Existing retained log records entry into the confirmation wait but no click/RPC/ACK disposition. Absence of method names in that log is not evidence that no RPC occurred. Existing actual-provider regressions cover return-only, scene/compositor echoes before ACK and stale/replaced/unrelated guards; they invoke the action directly and do not establish the actual Radix control behavior in this run.

Root approves ONE scratch-only diagnostic on unchanged source/binary, reproducing the complete original save/apply/restart/live prefix before the exact camera inspector and single Switch click. At most32 sanitized milestones plus omissions record DOM selector identity/multiplicity/connectedness/role/aria/disabled/inert ancestors and click admission; transient observation correlates only target visibility/config-load request, ACK/error, visibility echo and scene/compositor revisions. Never retain credentials or full scenes/payloads, change payloads, dispatch a substitute event, bypass the original120s gate or substitute direct-action acceptance. Restore observations and await exact owned cleanup before final assertions; suppressed cleanup is disclosed rather than claimed as success.

Use attributed ordering for a same-body actual LayoutTab plus StudioProvider regression with real Radix selection/click and explicit deferred RPC/echo barriers, then review the actual RED and minimal owning repair. No production source edit, commit or further workload is approved by the read-only finding alone.

## Single observed positive control

Scratch diagnostic75106 is terminal exit0 on unchanged9fd/source7f and the same f9748a31backend. The full original prefix and first hide/Modified assertion pass: unique enabled/connected radio and Switch, no disabled/inert/hidden ancestor, one visibility click/RPC, applied ACK in5.2ms, same baseline identity apart from visibility, then hidden scene/compositor proof and canSave/Modified/visibilityfalse. All26bounded observations remain, with zero omissions/errors/pending observed requests. Observer restoration, socket close and shared stop complete before the final result; recorded controller13674/wrapper13677/backend13870 and exact group13677 are absent. Profiles remain retained.

This is a positive control, not cause attribution: instrumentation timing may affect scheduling and the downstream camera artifact stages were omitted. The original120s failure remains open, and no actual production RED or supported repair is claimed. Root will run THREE predeclared fresh complete unchanged scene-presets gates, retaining every result and original deadlines/artifact assertions without stopping on green.
