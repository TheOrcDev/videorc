import { DEFAULT_GATES } from './recording-analyzer.mjs'

export function recordingMatrixGates(recordingMs) {
  return {
    // The production synthetic source changes its pixels every frame. A CFR
    // container can conceal repeated content; both laws must hold.
    requireMotion: true,
    requireColorTags: true,
    requireValidLevel: true,
    requireNoDigitalZeroRuns: true,
    minDurationSeconds: (recordingMs / 1000) * (1 - DEFAULT_GATES.frameCountTolerance),
    requireKeyframeEvidence: true,
    keyframeMaxIntervalSeconds: 2.5,
    maxTailMismatchMs: 100
  }
}

function rendererReady(state) {
  return Boolean(
    state?.wsStatus === 'connected' &&
    state.testPattern === true &&
    !state.screenId &&
    !state.windowId &&
    state.layoutPreset === 'screen-only' &&
    state.committedLayoutPreset === 'screen-only' &&
    state.visualTransactionPending === false &&
    state.layoutSwitchPending === null
  )
}

/**
 * Backend-only session params do not select the renderer's source. After Stop
 * its automatic Clips re-arm can otherwise open a real screen-share dialog.
 * Establish the fixture through the UI actions and await their committed state.
 * The matrix still sends every original output profile/layout to session.start.
 */
export async function prepareRecordingMatrixFixture({
  command,
  request,
  timeoutMs,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const deadline = now() + timeoutMs
  const remaining = () => Math.max(1, deadline - now())
  await command('enable-synthetic-source', { settleMs: 0 }, remaining())
  await command(
    'eval-js',
    {
      code: `
        const scenes = window.__videorcSmokeScenePresets;
        if (!scenes) throw new Error('Studio scene actions are not ready.');
        scenes.layout({ layoutPreset: 'screen-only' });
        return true;
      `
    },
    remaining()
  )
  let last = null
  while (now() < deadline) {
    const response = await command(
      'eval-js',
      {
        code: `
          const hook = window.__videorcSmokeScenePresets;
          const state = hook?.state();
          const config = hook?.streamingState().captureConfig;
          return {
            wsStatus: state?.diagnostics?.wsStatus,
            testPattern: config?.sources?.testPattern,
            screenId: config?.sources?.screenId ?? null,
            windowId: config?.sources?.windowId ?? null,
            layoutPreset: config?.layout?.layoutPreset,
            committedLayoutPreset: state?.diagnostics?.confirmedVisual?.layout?.layoutPreset,
            visualTransactionPending: state?.diagnostics?.visualTransactionPending,
            layoutSwitchPending: state?.pendingLayout
          };
        `
      },
      remaining()
    )
    last = response?.result
    if (rendererReady(last)) {
      const scene = await request('scene.get', remaining())
      const visible = scene?.sources?.filter((source) => source?.visible === true)
      if (visible?.length === 1 && visible[0].kind === 'test-pattern') {
        return { layoutPreset: 'screen-only', visibleSourceKinds: ['test-pattern'] }
      }
    }
    await sleep(Math.min(100, remaining()))
  }
  throw new Error(`Recording matrix synthetic scene did not commit: ${JSON.stringify(last)}`)
}
