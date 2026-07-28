# Plan 037: Make Windows Electron fallback and background work recoverable and scoped

## Status

- **State**: DONE (2026-07-28)
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 038 Windows metrics (satisfied by #160 / #155)
- **Category**: perf / bug
- **Planned at**: commit `54229f8f`, 2026-07-18
- **Issue**: https://github.com/TheOrcDev/videorc/issues/158
- **Implementation**: #167 (`b6686eb1`)
- **Physical Windows acceptance**:
  [`docs/acceptance/2026-07-28-windows-electron-background-policy.md`](../docs/acceptance/2026-07-28-windows-electron-background-policy.md)

## Why this matters

After two GPU-process crashes, Videorc persists `disableHardwareAcceleration` and subsequently uses Chromium software rendering until an undocumented environment override clears it. Separately, global Chromium switches disable occlusion/background throttling and every auxiliary BrowserWindow opts out of background throttling. These choices protect preview continuity, but can impose an ongoing CPU/battery penalty on Windows machines and make a transient GPU failure permanent.

## Completed state

- Persisted fallback diagnostics retain source, reason, crash count, age, and retry attempts.
- Settings exposes software-rendering state and schedules one accelerated retry for the next launch.
  Two GPU-process crashes restore the fallback; a stable one-minute retry clears it.
- Windows keeps Chromium's process-wide background policy. Only the main capture owner and
  detached preview opt out of per-window background throttling; notes, comments, captions,
  and the proof surface use Chromium defaults.
- Windows support-bundle acceptance requires explicit graphics fallback status and recovery
  evidence.

## Scope

In scope: GPU fallback policy/state/tests, diagnostics/settings recovery UX, support-bundle schema/verifier updates, per-window background policy, focused lifecycle tests, Windows CPU comparison evidence.

Out of scope: removing the emergency GPU-disable escape hatch; forcing GPU use on known-broken drivers; changing media capture behavior.

## Steps

1. [x] Record fallback source/reason/age in diagnostics and surface a safe user action to reset or retry hardware acceleration on the next launch.
2. [x] Add a conservative recovery policy (explicit retry or bounded expiry) that preserves an opt-out after a failed retry; test persisted, reset, and failure paths.
3. [x] Identify windows that truly require live background scheduling. Restore Chromium defaults for auxiliary windows that do not, and scope process-wide switches to the supported platform/window behavior if Electron permits it.
4. [x] Add Windows support-bundle acceptance visibility for software-rendering mode and compare per-role CPU with occluded notes/comments/captions across the chosen policy.

## Verification

- `pnpm --filter @videorc/desktop test`, `pnpm typecheck`, and `pnpm lint` exit 0.
- `pnpm probe:preview-lifecycle` passes after the background-policy change.
- Windows proof-surface and capture smokes remain live; a persisted GPU fallback is visible and recoverable without manually setting an environment variable.

All verification items passed on physical Windows 11 x64 build 26200. The scoped and
legacy-unthrottled controls used the same packaged payload and clean commit. Static occluded
auxiliary windows were effectively idle under both policies; the scoped policy introduced no
CPU regression and improved the observed proof-surface and recording cadence in this comparison.

## STOP conditions

Stop if narrowing the policy freezes preview, captions, or required live controls while occluded. Stop if GPU retry can create a launch loop or hide the original fallback reason.

## Maintenance notes

Keep the fallback fail-safe for broken Windows GPU drivers. Any new auxiliary BrowserWindow must explicitly justify opting out of background throttling and be measured under Plan 038.
