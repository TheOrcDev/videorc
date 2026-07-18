# Plan 036: Bound Windows proof-surface transport and presentation work

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 034 Windows metrics
- **Category**: perf
- **Planned at**: commit `54229f8f`, 2026-07-18
- **Issue**: https://github.com/TheOrcDev/videorc/issues/157

## Why this matters

Windows production preview is an Electron proof surface rather than CAMetalLayer. Its idle profile fetches uncompressed 1920px BMPs every 40ms, and a 4K source is copied then CPU-resized for each new response. The main process also serializes full compositor scene/source/cache diagnostics into the proof window and waits for a second paint/metrics round trip per accepted update.

## Current state

- `apps/desktop/src/shared/native-preview-proof-polling.ts` uses a fixed 1920px/40ms idle profile and 960px/125ms recording profile.
- `crates/videorc-backend/src/preview_bmp.rs` copies 4K bytes before Triangle resizing to `maxWidth`.
- `apps/desktop/src/main/index.ts:5454-5465` injects a full `effectiveStatus` payload then reads metrics after paint.
- The renderer fallback timer can resubmit an unchanged compositor status at 60Hz while main-pump ownership is unavailable.

## Scope

In scope: proof-polling profile/geometry helpers and tests, BMP conversion optimization, compact proof-present DTO, renderer fallback deduplication, Windows preview smoke metrics.

Out of scope: claiming a native CAMetalLayer transport on Windows; removing source liveness/first-frame contracts; changing macOS native presentation.

## Steps

1. Add Windows proof-surface metrics for request rate, bytes, source-to-present latency, decode/present cadence, and per-layer source dimensions.
2. Compute a DPR-aware image cap from the proof-window content bounds and update it on resize. Preserve a documented quality floor and retain a lower recording profile.
3. Avoid unnecessary full-source allocations during downscale where feasible; retain duplicate-sequence suppression before expensive work.
4. Define a compact proof-present payload containing only fields consumed by the proof script. Keep full diagnostics on the normal status/diagnostics channel.
5. Deduplicate renderer fallback presents by `{runId, framesRendered, sceneRevision}` while preserving a bounded liveness refresh and immediate new-frame delivery.

## Verification

- `pnpm --filter @videorc/desktop test` and `cargo test -p videorc-backend` exit 0.
- `pnpm smoke:windows-native-screen` and `pnpm smoke:recording-native-preview` pass on Windows.
- Plan 034 reports demonstrate lower proof bytes/CPU without missing first-frame, source-liveness, resize, or recording-preview contracts.

## STOP conditions

Stop if geometry-derived caps visibly underfill a large proof surface, if compact payloads omit a field needed for liveness correctness, or if a dedupe suppresses a changed scene/run/frame.

## Maintenance notes

The proof surface remains a supported Windows production transport but must continue to identify itself as `electron-proof-surface` / `electron-browser-window`. New status fields do not automatically belong in the frame-cadence payload.
