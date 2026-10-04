# Plan 105: Make scene-preset smoke state serializable across Electron

> Planned at `05ff9188`, 2026-10-03, release 0.9.129. Fix plan only. Drift check: `git diff --stat 05ff9188..HEAD -- apps/desktop/src/renderer/src/hooks/use-studio.tsx scripts/smoke-scene-presets-app.mjs`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

- Priority: P1; blocks the maintained saved-scene acceptance smoke
- Effort: S
- Risk: LOW; development diagnostic surface only
- Depends on: none
- Category: tests / dx
- Confidence: HIGH, reproduced through the real dev app

## Execution status

Development harness repair merged as `59a0cf0f` in [PR 549](https://github.com/TheOrcDev/videorc/pull/549), main `f09c4f4f`. The actual provider full-state clone regression, 130 focused desktop and 10 Node tests, TS checks and Shadscan 37 passed. Functions remain on the action surface; returned state contains evaluated reason data, and clone failures identify the field without filtering state. Save/apply/restart and final artifacts are deferred to the end; Plans 101 and 103 still own scene round-trip defects.

## Failure and evidence

`pnpm smoke:scene-presets` fails at its first state read with `Error: An object could not be cloned.` No save/apply/restart/recording scenarios are reached.

- `scripts/smoke-scene-presets-app.mjs:38` evaluates `return window.__videorcSmokeScenePresets?.state()` through the smoke command server.
- `hooks/use-studio.tsx:14696` returns a plain state object, but its diagnostics include `sourceSwitchReason` and `retrySourceStatus`, both function references (defined at lines 3608 and 3626).
- `main/index.ts:11642` transfers the executeJavaScript result across Electron's structured-clone boundary. Functions cannot cross it.

This is an automation regression, distinct from Plans 101 and 103's saved-scene product defects. Do not count a smoke that never reaches save/apply as acceptance evidence.

An exploratory copy of the smoke in `/tmp` still failed after removing only `sourceSwitchReason`; inspection identified `retrySourceStatus` as a second action in the data projection. No application source was changed. The regression must cover the complete projection, not just the first offending field.

## Scope and steps

In scope: the development scene-preset harness projection in `use-studio.tsx`, a small explicit projection helper/test if needed, and the existing scene-preset smoke. Out of scope: production scene behavior, backend protocol, smoke server authentication and packaged-build restrictions.

1. Replace function-valued diagnostics with useful evaluated data, such as concrete per-source blocked reasons, or remove that diagnostic if redundant. Preserve source selection/transaction diagnostics. Add a test that structured-clones the entire state projection, including nested values. Verify focused desktop tests and `pnpm typecheck`.
2. Run `pnpm smoke:scene-presets` from launch through both saved scenes, live apply, final artifact analysis and renderer restart. Add a startup assertion that state is serializable so future failures name the offending diagnostic field. Match existing smoke-command-client behavior; do not silently JSON-strip unknown fields at the main boundary.
3. Run `pnpm --filter @videorc/desktop test`, `pnpm lint`, `pnpm format:check` and `pnpm smoke:scene-presets`. Record whether Plans 101/103 need their additional regression scenarios separately.

## Done and STOP criteria

- [x] The full dev state projection contains only cloneable data and passes structuredClone coverage.
- [ ] The maintained smoke reaches save/apply/restart and analyzer assertions and exits 0.
- [x] No function-bearing objects are returned through the smoke state boundary; action functions remain separate.

Stop if the clone failure persists after replacing the known function: inspect every nested value rather than broadly filtering the result or disabling assertions. Future dev diagnostics must be a data projection, not a copy of action-bearing context.
