# Plan 102: Start the idle microphone analyser when backend levels are unavailable

> Fix plan only. Drift check: `git diff --stat 05ff9188..HEAD -- apps/desktop/src/renderer/src/hooks/use-studio-mic-sources.ts apps/desktop/src/renderer/src/hooks/use-studio-mic-visual.tsx apps/desktop/src/renderer/src/lib/mic-frame-sources.ts apps/desktop/src/renderer/src/lib/mic-visual-pipeline.ts apps/desktop/src/renderer/src/components/studio/microphone-section.tsx`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

## Execution status

Source repair merged as `1a69b9d6` in [PR 547](https://github.com/TheOrcDev/videorc/pull/547), main `c9d72752`. One hundred four focused tests passed, including 18 actual Studio/Sources consumer cases with real pipeline ownership and mocked browser transport; TS checks and Shadscan 37 passed. Separate eligible demand now starts idle fallback without waiting for analyser activity. Full app/recording gates and physical microphone acceptance remain pending.

## Status

- Priority: P1
- Effort: S–M
- Risk: MED; microphone demand must release on visibility, mute and source changes
- Depends on: none
- Category: bug
- Planned at: `05ff9188`, 2026-10-03, release 0.9.129
- Confidence: HIGH; conditional deadlock confirmed in source and installed UI

## Runtime reproduction

On installed macOS 0.9.129, with microphone permission granted and MacBook Pro Microphone selected/unmuted:

1. Settings → Recording → turn off “Keep microphone ready while Studio is visible”.
2. Open idle Studio. The level remains −∞ dB and status Idle.
3. Open Sources. Its microphone level also remains −∞ dB and Idle.
4. Neither page starts the renderer analyser promised as its fallback. Sources had previously shown Monitoring and approximately −40 dB when warming was enabled.

The preference was restored after testing. A later installed-app check with warming enabled showed Monitoring in both Sources and Studio (approximately −47 dB in Studio). The initial warm-enabled Idle observation is not a separate confirmed defect; this plan is scoped to the reproducible fallback failure with warming disabled.

## Current state and conventions

- `hooks/use-studio-mic-sources.ts:101` selects the analyser only with `analyserDriven: micVisual.active && !muted`.
- `lib/mic-meter-input.ts` returns a source only when analyser-driven; otherwise the meter is a static/no-reading input.
- `components/studio/mic-level-meter.tsx:20` subscribes `LevelMeter` only for `meter.kind === 'source'`.
- `lib/mic-frame-sources.ts:42` calls `feed.retain()` only upon subscription.
- `lib/mic-visual-pipeline.ts:464` refuses acquisition if `demandCount === 0`.
- Provider configuration alone cannot create demand. Production waits for active state before subscribing, but becoming active needs that subscription.
- `hooks/studio-mic-visual-provider.test.ts` uses a `VisualConsumer` that unconditionally subscribes, avoiding this cycle. `microphone-section.test.ts` renders a prop-only view rather than the production hook.
- Match the existing retained-feed ownership, permission handling, generation cancellation and backend-first meter selection. Use `videorc-design` for any UI change.

## Scope and steps

In scope: consumer demand ownership in `use-studio-mic-sources.ts`/`use-studio-mic-visual.tsx`, existing feed lifecycle helpers only if necessary, and integration tests that mount production MicrophoneSection and Sources mixer. Out of scope: new meter visuals, encoder/capture audio transport, changing the user's warm preference, and automatically requesting microphone permission.

1. Add a production-consumer integration test with selected unmuted mic, allowed access, warming disabled, no backend levels and a fake browser stream. Assert stream acquisition and non-idle frames. It must fail before the fix. Run `pnpm --filter @videorc/desktop test studio-mic-visual-provider.test.ts microphone-section.test.ts mic-frame-sources.test.ts mic-meter-input.test.ts`.
2. Retain demand from an eligible visible meter consumer independently of current analyser active state. Keep demand separate from which source paints the meter, retain once per ownership unit, and release on hide/mute/unmount/source replacement. Preserve backend-first selection and avoid unnecessary duplicate capture. Run focused pipeline/ownership tests and typecheck.
3. Add integration cases for absent/failed standby, source switching, permission denied, no selected mic, mute/unmute and backend levels returning. Reproduce through the app with warming disabled and enabled, then restore prior settings. Run recording/audio gates.

## Done criteria and verification

- [ ] Both idle Studio and Sources obtain live fallback levels with warming disabled.
- [x] Hide/unmount/mute release owned demand; stale acquisitions cannot attach after source replacement.
- [x] Backend levels continue to take precedence and fallback recovers after a standby failure.
- [x] Denied/unavailable inputs report truthful status without an endless acquisition loop.
- [ ] Desktop tests, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm smoke:recording-studio` and `pnpm smoke:record-latency:gate` pass.

## STOP and maintenance

Stop if adding demand changes session microphone ownership or starts a permission prompt without an explicit user action. Future meter selection logic must not condition the first subscription on state that only a subscription can produce.

## Current automated proof and pending device spotcheck

Current production JS CI head570334b7/job111326363846 executes all18 real Studio/Sources consumer tests in `studio-mic-meter.integration.test.ts`, including warming-disabled acquisition, live frames, visibility/mute/unmount ownership, pending old-device rejection, backend precedence/recovery and denied/unavailable truthful state. They pass alongside the full2851-case desktop suite. Browser microphone transport is mocked, so this does not establish physical browser microphone permission/capture. The final36-stage recording/device batch and enforced five-cycle latency gate pass separately; device interaction selects camera/screen, and record-latency intentionally disables native microphone. The explicit warming-off/on physical meter spotcheck remains pending after the current local capture queue, without granting or bypassing OS permissions.
