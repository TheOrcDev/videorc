# Plan 136: Renew scene-smoke output authority for each camera recording

## Evidence and scope

P2; effort S; risk LOW. Written against main `200880ec` (unchanged application source `7f345759`) on 2026-10-04. This is a maintained acceptance-runner defect, distinct from Plan133 camera visibility timeouts and Plan135 system-audio continuity.

`scripts/smoke-scene-presets-app.mjs:249–269` authorizes the output directory once and passes that capability to the initial recording. The later `recordCameraVisibility` function at431–442 reuses `directory.capabilityId` for both its visible and hidden camera recordings. `apps/desktop/src/main/index.ts:9242–9256` defaults issuance to `useCount:1`; `authorize-smoke-resource` at9760 calls that issuer without an override. `crates/videorc-backend/src/main.rs:8108–8165` consumes a supplied output-directory capability before parsing/starting a session, including on an Admin socket when the capability is present. `resource_authority.rs:104,204–209` decrements and removes the one-use entry; its next consume fails with the existing unknown/already-consumed error at166. Consequently the subsequent camera-recording starts cannot reuse this capability successfully.

The one full reviewed diagnostic on current main exits1 after20.4s in the camera-only `session.start` owning operation, after both original hide/show controls, Save-as, reapply and renderer restart pass. Its exact RPC error code/message was not retained, so this observed failure alone is not claimed to prove the rejection code or a device-permission cause. The actual source lifetime above independently proves the reusable-capability defect. Finished visible/hidden camera artifacts remain unexecuted in this diagnostic. Original four visibility timeout failures remain unresolved. Private evidence and profiles stay outside Git.

## Minimal correction

1. Read AGENTS.md, the exact script, main issuance/consume implementations, and the existing `resource_authority::tests::capability_is_typed_one_shot_and_unforgeable` test. Work in a separate disposable worktree on current main; preserve user files.
2. Keep the initial recording's existing authorization. Inside `recordCameraVisibility`, immediately before its existing `session.start`, request a fresh `authorize-smoke-resource` for the same isolated `outputDirectory`, exact `output-directory` kind and original timeout. Use this newly issued capability only for that invocation. Each visible/hidden invocation must acquire its own authority; do not request extra uses, bypass authority, use raw output paths, cache the ticket, or change production capability policy.
3. Preserve the complete original UI/select/visibility/save/restart paths, assertions, source/camera identity, camera-only/background-null profiles, recording timings, finalization, artifact analyzer and every-frame pixel oracle. Change only the recording-helper authorization lifetime. No renderer/backend/native capture behavior or existing limits need modification.

## Verification and publication

Use existing meaningful gates for this small script correction rather than a new test that merely mirrors its syntax: `node --check scripts/smoke-scene-presets-app.mjs`, formatter/lint checks for the touched file and `cargo test -p videorc-backend resource_authority::tests::capability_is_typed_one_shot_and_unforgeable` (existing one-use/forgery/wrong-kind contract must pass). Independently review the entire diff and confirm only per-invocation issuance and that invocation's capability use changed. Record exact outcomes; an import/build/setup failure is not a behavioral pass.

After all pending fixes, run the complete unchanged scene-presets smoke with all original hide/show and finished visible/hidden camera artifacts. Preserve failures separately: an earlier Plan133 toggle timeout blocks downstream acceptance but does not justify reverting fresh authority or weakening the one-use policy. Run recording-studio/preview/device gates as applicable under AGENTS.md; maintain original physical-camera proof and report a concrete permission limit if present. No per-fix full E2E run is required. Run the unchanged full local bundle and original long soaks after the batch.

Commit this fix separately, stage only intentional files, use the immediate complete-worktree Shadscan score floor37, and publish to main through its normal protected-branch PR flow. Mark the source correction and downstream acceptance separately; do not claim full scene acceptance without actual encoded-camera proof. Future additions of recording invocations must acquire new one-use authority at their own operation boundary.

## Source correction published

Exact seven-line per-invocation correction is committedb2c985b9726e4f4f87b6f5db4364044d77d177c4 and normally merged through PR586 to main37f49f45b15855ee6b1aa81a7c3c48bc2c9ea318. Syntax/owned-file formatting/diff checks and the exact existing Rust one-use test (1PASS/0FAIL/0ignored) pass. Existing ESLint rules target desktop TypeScript and do not cover this Node script. Immediate whole-worktree Shadscan37 meets baseline/floor37. No per-fix app/E2E run occurs; complete original scene and encoded-camera acceptance remains pending after the batch, separate from the four unresolved Plan133 visibility timeouts.

## Encoded-camera proof after the fix batch

The second of three predeclared full original scene-presets runs on main `6dbabec1` exits 0. All original scene/UI/save/restart/live stages complete, and separate visible and hidden camera recordings start and finalize with fresh per-invocation authority. The maintained artifact oracle passes every decoded frame: 52 visible-control frames and 175 hidden frames, zero failures. No production capability policy, timing, pixel limit or camera selection is changed.

Trials 1 and 3 fail earlier at the original camera-hide confirmation, so their final camera artifacts are unexecuted. The source repair has actual downstream acceptance proof; reliable whole-scene acceptance remains open under Plan 133. All three results and private recordings are retained. Broader final app gates remain pending.
