# Plan 037: Make Windows Electron fallback and background work recoverable and scoped

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 034 Windows metrics
- **Category**: perf / bug
- **Planned at**: commit `54229f8f`, 2026-07-18
- **Issue**: https://github.com/TheOrcDev/videorc/issues/158

## Why this matters

After two GPU-process crashes, Videorc persists `disableHardwareAcceleration` and subsequently uses Chromium software rendering until an undocumented environment override clears it. Separately, global Chromium switches disable occlusion/background throttling and every auxiliary BrowserWindow opts out of background throttling. These choices protect preview continuity, but can impose an ongoing CPU/battery penalty on Windows machines and make a transient GPU failure permanent.

## Current state

- `apps/desktop/src/main/gpu-fallback.ts` honors any persisted disable flag indefinitely unless `VIDEORC_FORCE_GPU=1` is set.
- `apps/desktop/src/main/index.ts:622-668` applies the fallback and global no-backgrounding switches.
- Main, notes, comments, captions, and preview windows all set `backgroundThrottling: false`; only the proof surface enables it.
- Runtime info reports the fallback state, but Windows support-bundle acceptance does not require it to be visible or intentionally waived.

## Scope

In scope: GPU fallback policy/state/tests, diagnostics/settings recovery UX, support-bundle schema/verifier updates, per-window background policy, focused lifecycle tests, Windows CPU comparison evidence.

Out of scope: removing the emergency GPU-disable escape hatch; forcing GPU use on known-broken drivers; changing media capture behavior.

## Steps

1. Record fallback source/reason/age in diagnostics and surface a safe user action to reset or retry hardware acceleration on the next launch.
2. Add a conservative recovery policy (explicit retry or bounded expiry) that preserves an opt-out after a failed retry; test persisted, reset, and failure paths.
3. Identify windows that truly require live background scheduling. Restore Chromium defaults for auxiliary windows that do not, and scope process-wide switches to the supported platform/window behavior if Electron permits it.
4. Add Windows support-bundle acceptance visibility for software-rendering mode and compare per-role CPU with occluded notes/comments/captions across the chosen policy.

## Verification

- `pnpm --filter @videorc/desktop test`, `pnpm typecheck`, and `pnpm lint` exit 0.
- `pnpm probe:preview-lifecycle` passes after the background-policy change.
- Windows proof-surface and capture smokes remain live; a persisted GPU fallback is visible and recoverable without manually setting an environment variable.

## STOP conditions

Stop if narrowing the policy freezes preview, captions, or required live controls while occluded. Stop if GPU retry can create a launch loop or hide the original fallback reason.

## Maintenance notes

Keep the fallback fail-safe for broken Windows GPU drivers. Any new auxiliary BrowserWindow must explicitly justify opting out of background throttling and be measured under Plan 034.
