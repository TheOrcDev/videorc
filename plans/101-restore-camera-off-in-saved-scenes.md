# Plan 101: Restore Camera Off in saved scenes and working checkpoints

> Fix plan only. Drift check: `git diff --stat 05ff9188..HEAD -- apps/desktop/src/renderer/src/lib/scene-presets.ts apps/desktop/src/renderer/src/lib/capture.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

## Status

- Priority: P1
- Effort: S
- Risk: LOW; legacy snapshots need an explicit normalization policy
- Depends on: none
- Category: bug
- Planned at: `05ff9188`, 2026-10-03, release 0.9.129
- Confidence: HIGH, reproduced through the production provider save action

## Problem and reproduction

Save a screen-only scene with Camera set to Off. Enable the camera in another setup, apply the saved scene, then Refresh devices or record/stop. Saved snapshots omit the explicit Off flag, so apply inherits the previous setup's flag and reconciliation may pick the first camera again. The saved visual setup should preserve Off.

Runtime reproduction in an isolated dev profile: configure `cameraOff: true`, verify the capture config still reports true, and save through `__videorcSmokeScenePresets.save`. The saved visual's sources omit `cameraOff`. Evidence: `/tmp/videorc-qa-scene-camera-off.log`. A second probe exactly matched the UI Off shape by clearing both camera ID and name; the saved sources were `{testPattern:true}` and the assertion again failed with `cameraOff` undefined instead of true (`/tmp/videorc-qa-evidence-followups-20261003/07/run.log`). This exploratory probe omitted the diagnostic functions identified in Plan 105; no application source was changed. The complete Off→On→apply device round trip remains an implementation acceptance criterion.

## Current state

- `lib/capture.ts::buildCameraSources` around 2497 stores Off as `{ cameraId: undefined, cameraName: undefined, cameraOff: true }`.
- `lib/scene-presets.ts:13` declares `VisualSources` without `cameraOff`; `visualSources` around line 40 also discards it.
- `hooks/use-studio.tsx:8550` applies `{ ...current.sources, ...visual.sources }`, which inherits the omitted flag.
- `lib/capture.ts:2619` only preserves Off when `nextSources.cameraOff === true && !nextSources.cameraId`; otherwise it selects a remembered or first camera.
- Existing `scene-presets.test.ts`, `capture.test.ts`, and `studio-provider.integration.test.ts` define the pure normalization and real provider round-trip conventions. Match them; audio selection remains outside saved visual snapshots.

## Scope and steps

In scope: `scene-presets.ts` and tests, saved apply/checkpoint wiring in `use-studio.tsx` and provider integration tests, and `capture.ts` tests if reconciliation needs characterization. Out of scope: scene layout geometry, microphone/system-audio settings, live camera capture implementation, and device naming.

1. Add a failing round-trip test: save explicit Off, switch On, reapply, reconcile new device discovery, and finish a session. Assert Off throughout. Run `pnpm --filter @videorc/desktop test scene-presets.test.ts capture.test.ts studio-provider.integration.test.ts`.
2. Include a normalized `cameraOff` boolean in the visual allowlist and explicitly restore it on apply/checkpoint hydration. For legacy snapshots, preserve existing documented behavior; do not infer Off from every absent camera ID unless the migration policy says so. Assert contradictory ID+Off normalization and untrusted snapshot validation. Run the focused tests and typecheck.
3. Extend `smoke:scene-presets` with the real renderer save/apply/reconciliation case. Run it and the broader recording gates.

## Done criteria and verification

- [ ] Off survives save/update/save-as, apply after On, refresh, stop and renderer restart.
- [ ] A saved On scene restores its camera after the current scene is Off.
- [ ] Legacy snapshots, missing devices and contradictory selections have explicit tests.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, desktop tests, `pnpm smoke:scene-presets`, `pnpm smoke:recording-studio`, and relevant real-device smoke pass.

## STOP and maintenance

Stop if source normalization would require changing audio ownership or broadening saved snapshots to all capture settings. Camera Off is visual intent; future camera selection flags must round-trip through the visual allowlist too.

## Execution status — 2026-10-03

Implementation committed as `43716ab32cd59f0ec573dffd91184553e48487b2` and merged through [PR 552](https://github.com/TheOrcDev/videorc/pull/552), main `1d3cabb2b0972f55d166faae0f296c02f4feeefb`. Visual snapshots/checkpoints include a validated boolean Off intent. Existing apply merges now explicitly restore it; legacy absent flags keep automatic camera selection and selected IDs retain precedence over contradictory Off. Audio remains outside the snapshot.

The actual provider regression failed before the fix (`undefined` versus `true`), and five malformed-flag cases also failed before validation. Root independently verified 263 desktop tests (126 provider, 119 capture, 13 pure scene and 5 scene UI), typecheck/lint/format, direct script formatting, syntax and diff checks. Lint retains one existing hook warning; Shadscan remains 37. Tests cover update/save-as, both Off/On directions, discovery, session stop, and remount over stale On capture storage.

Maintained scene smoke now checks both directions, refresh, restart and finished stop. It has not been launched in this slice: real-app, recording/device and full gates remain deferred until all fixes are merged, as requested.

Post-merge JS CI identified a production asset regression: 2,000,285 eager raw bytes exceeds the unchanged 2,000,000 ceiling. The predecessor passed at 1,999,851. [Plan 113](113-restore-renderer-initial-asset-budget.md) owns the required follow-up after the remaining implementations; do not claim production-build acceptance for this slice.
