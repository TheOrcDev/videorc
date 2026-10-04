# Plan 103: Persist source visibility in saved scenes and working checkpoints

> Fix plan only. Drift check: `git diff --stat 05ff9188..HEAD -- apps/desktop/src/renderer/src/lib/scene-presets.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx crates/videorc-backend/src/scene.rs crates/videorc-backend/src/protocol.rs apps/desktop/src/shared/backend.ts`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

## Status

- Priority: P1
- Effort: M
- Risk: MED; preserve atomic visual commits and protocol mirrors
- Depends on: Plan 101 schema coordination and Plan 109 selected-intent/active-composition distinction during execution
- Category: bug
- Planned at: `05ff9188`, 2026-10-03, release 0.9.129
- Confidence: HIGH, reproduced through the isolated dev app

## Problem and reproduction

Save a Screen + Cam scene, apply it, select Camera in Scene and turn “Visible in scene” off. The saved card does not become Modified because visibility is not part of its visual snapshot. Save/Update cannot store the hidden state. Switching away/reapplying or rebuilding the scene reveals the camera again.

Runtime reproduction at `05ff9188`: save a scene through the production provider action, click the actual Camera visibility switch, and reload the renderer. The switch changed `true → false → true`; the hidden state reported `modified: false`. Evidence: `/tmp/videorc-qa-scene-visibility.log`. This exploratory probe used an isolated profile and omitted the development harness's two non-cloneable diagnostic functions (Plan 105); no application source was changed.

## Current state

- `components/tabs/layout-tab.tsx:999` exposes the “Visible in scene” switch, bound to `SceneSource.visible`.
- `hooks/use-studio.tsx:7672` sends `scene.source.visibility.update` and applies the backend acknowledgement; it does not persist the changed visibility into working visual intent.
- `use-studio.tsx:8474` builds `workingVisual` from layout, `visualSources(captureConfig.sources)` and background only. Modified compares this against the saved snapshot.
- `lib/scene-presets.ts:20` defines the same three-field `SceneVisual`, without source visibility.
- `crates/videorc-backend/src/scene.rs:467` and `:491` constructs screen/camera sources with `visible: true` on scene rebuild.
- Match existing saved-scene normalization and provider atomic visual transaction tests, especially `studio-provider.integration.test.ts` saved apply round trip. Preserve stable source-role identity and default legacy scenes to visible.

## Scope

In scope: saved/working snapshot types and normalization; acknowledged visibility persistence; existing atomic scene application/reconstruction contract and Rust/TS mirrors; backend scene tests and renderer/provider tests. Out of scope: source locks, source deletion, canvas geometry, background appearance, and audio mute (visibility is not audio mute).

## Steps and verification

Execution ordering: implement Plan 109 before this plan. Its source-chain probe established that live-session active-source confirmation currently removes selected IDs for sources absent from the visible composition. Hidden-camera round trips must keep the camera selection and explicit Off intent independent of visibility; do not let source confirmation accidentally turn Hide into Camera Off or erase the saved source identity. Add this assertion to the provider visibility regression.

1. Add failing pure and provider round-trip tests: visibility edit sets Modified, update preserves hidden camera, switch away/reapply/restart keeps it hidden. Run `pnpm --filter @videorc/desktop test scene-presets.test.ts studio-provider.integration.test.ts`.
2. Add normalized visibility by stable visual source role to saved and working snapshots. Define legacy defaults, reject unknown/untrusted roles, and update working intent only after backend acknowledgement. Run focused desktop tests/typecheck.
3. Thread visibility through the existing atomic scene transaction/rebuild, preserving all Rust/shared TS mirrors. Do not replay a separate visibility mutation after publishing an all-visible scene: it can flash the hidden camera on live output. Add backend reconstruction/commit tests. Run `cargo test -p videorc-backend scene::tests::` and relevant live-layout tests.
4. Extend `smoke:scene-presets` with visibility round trips and inspect recording artifacts to confirm no camera flash on apply. Run scene/freeform and recording-studio smokes.

## Done criteria

- [x] Hide/show is reflected in Modified and persists through Save/Update/Save-as and restart in focused provider regressions.
- [ ] Saved scene apply commits intended visibility atomically; no hidden source flashes on output.
- [x] Legacy scenes default predictably; failed commits do not persist unacknowledged edits.
- [ ] `pnpm smoke:scene-presets`, `pnpm smoke:freeform-editor`, `pnpm smoke:recording-studio`, desktop/backend tests, TS typecheck/lint/format and Rust fmt/clippy pass.

## STOP and maintenance

Stop if visibility must be implemented as a second post-commit RPC or cannot use stable source-role identity. Expand the atomic transaction first. New visual attributes must participate in normalized saved intent, Modified comparison and acknowledged working checkpoints.

## Execution reconciliation — dependencies merged

Begin after main `6006e101` (PR 553) with a clean execution worktree. Plan 101 now normalizes/validates a boolean `cameraOff` in saved visual sources; preserve its legacy automatic and ID-over-Off policy. Plan 109 removed composition-derived selection writes: generic/secondary scene edits retain selected identity, while successful primary visual config commits selection under the scene/latest-intent fence and preserve microphone authority. Its narrow Rust owner tests cover all-hidden generic edits and source tuple commits; extend the atomic visibility tests against that contract. `use-studio.tsx` drift outside these owners consists of the 098 consent comment and 105/109 DEV smoke diagnostics. `scene.rs`, protocol and shared backend mirrors are otherwise unchanged since the QA base. Preserve the cloneable diagnostic state and new per-click projections. Full E2E for dependencies is deferred by the user's explicit batch instruction; focused implementations are merged and ready for this schema slice.

## Execution review — acknowledgement ordering

Production `scene.changed` updates `transformSceneRef` independently of the visibility RPC response. The transform identity helper includes `source.visible`, so borrowing it unchanged as a visibility stale guard rejects the operation’s own event when it arrives before its response. Add a maintained actual-provider event-before-ACK regression. Visibility ownership must tolerate only its acknowledged visibility echo while still rejecting replaced source identity, superseded layout/client and newer scene revision; do not weaken the transform guard globally. Only a current successful acknowledgement may update Modified and the working checkpoint.


## Execution status — implemented, final app acceptance pending

Commit `aa86df0eca118de72209a99a5e578eeed5f01827` merged through [PR 554](https://github.com/TheOrcDev/videorc/pull/554), main `15ac74b493abc3467d43f619a671e7d7f0714213`. Independent camera/capture visibility lives in the existing layout envelope, defaulting legacy roles to visible. Rust construction applies visibility before publication; generic acknowledged edits update the committed layout projection. Selected source IDs, Camera Off and microphone intent remain independent. All Rust/shared TS/RPC/Electron mirrors and constructor sites are preserved.

Actual provider regressions cover Modified, Update, Save-as, saved apply, restart, pending/failed/stale acknowledgements, source/transform/layout supersession and event-before-response ordering. The visibility guard ignores only its target source’s visibility echo; the transform guard is unchanged. Live saved-apply failure rolls back and a lost response reconciles one atomic layout RPC with no visibility replay. Initial snapshot/provider tests failed before the fix, as did Rust reconstruction and both event-order cases.

Executor verification: 338 desktop cases, 66 scene + 53 live-layout Rust cases and 15 Node cases. Root independently passed 343 desktop cases (including five scene UI cases and the final live provider case), the same 119 Rust and 15 Node cases. Typecheck, lint (one existing hook warning), global/direct script formatting, script syntax, Rust fmt and diff checks passed; Shadscan remained 37 immediately before commit. Evidence remains outside the tree in `/tmp/videorc-fix103-*.log`.

Maintained `smoke:scene-presets` retains Camera Off acceptance and adds actual Scene visibility controls plus a real selected-camera positive control. Camera-only recordings use no background asset; every decoded hidden frame is checked, including atomic hidden startup and a hidden live rebuild. Missing/dark camera pixels and incomplete frame evidence fail acceptance. No real app or E2E was launched for this slice. Dev camera TCC remains ungranted; final real-camera artifact acceptance is pending and must report that limitation honestly if still blocked. Full suites, clippy and scene/freeform/recording-studio gates run after the batch. Plan 113 also repairs the known default production renderer budget before final build acceptance.

Automatic PR 554 Linux CI subsequently exposed a missed shared fixture expectation: `protocol-fixtures/high-risk-contracts.json` lacked the new visibility defaults in its normalized layout. One exact Rust fixture test failed with 2,712 passing and 11 ignored. [Plan 114](114-sync-source-visibility-protocol-fixture.md) repaired that mirror separately in PR 556 after Plan 099, retaining strict complete equality and the legacy wire case. Root independently passed 216 desktop and 16 backend cases for the follow-up, including both exact fixture consumers. The original focused set did not cover this fixture; final full-suite acceptance remains deferred.
