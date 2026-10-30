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
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onProgress = () => {}
}) {
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  let phase = 'select synthetic source'
  let last = null
  let visibleSourceKinds = null
  const failure = (cause) =>
    new Error(
      `Recording matrix synthetic scene did not commit during ${phase} after ${now() - startedAt}ms: ` +
        JSON.stringify({ renderer: last, visibleSourceKinds }) +
        (cause ? ` (${cause.message ?? cause})` : ''),
      cause ? { cause } : undefined
    )
  const remaining = () => {
    if (now() >= deadline) throw failure()
    return deadline - now()
  }
  const action = async (name, params, label) => {
    phase = label
    onProgress({ phase, elapsedMs: now() - startedAt })
    try {
      return await command(name, params, remaining())
    } catch (error) {
      throw failure(error)
    }
  }
  await action('enable-synthetic-source', { settleMs: 0 }, phase)
  await action(
    'eval-js',
    {
      code: `
        const scenes = window.__videorcSmokeScenePresets;
        if (!scenes) throw new Error('Studio scene actions are not ready.');
        scenes.layout({ layoutPreset: 'screen-only' });
        return true;
      `
    },
    'apply screen-only layout'
  )
  phase = 'confirm renderer and backend scene'
  onProgress({ phase, elapsedMs: now() - startedAt })
  while (now() < deadline) {
    let response
    try {
      response = await command(
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
    } catch (error) {
      // Preserve the last meaningful renderer state instead of replacing it
      // with a final clamped HTTP timeout. This is a read, never a replay of
      // either source/layout mutation.
      throw failure(error)
    }
    last = response?.result
    if (rendererReady(last)) {
      let scene
      try {
        scene = await request('scene.get', remaining())
      } catch (error) {
        throw failure(error)
      }
      const visible = scene?.sources?.filter((source) => source?.visible === true)
      visibleSourceKinds = visible?.map((source) => source.kind) ?? null
      if (visible?.length === 1 && visible[0].kind === 'test-pattern') {
        return { layoutPreset: 'screen-only', visibleSourceKinds: ['test-pattern'] }
      }
    }
    await sleep(Math.min(100, Math.max(0, deadline - now())))
  }
  throw failure()
}
