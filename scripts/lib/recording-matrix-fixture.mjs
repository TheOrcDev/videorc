import { DEFAULT_GATES } from './recording-analyzer.mjs'
import { startLinuxPulseFixtures } from './linux-pulse-fixture.mjs'
import { acquireHostSmokeLock } from './host-lock.mjs'
import { bandMaxDbfs, reportDbfs, toneEnvelope } from './system-audio-gates.mjs'

// Linux always opens the shared PCM bus, even with no selected microphone.
// That is correctly silent; it cannot supply this matrix's non-silent input.
// Keep owned tones alive through app teardown and never change system defaults.
export async function withRecordingMatrixAudio({
  platform,
  ffmpegPath,
  run,
  startFixtures = startLinuxPulseFixtures,
  acquireLock = acquireHostSmokeLock
}) {
  if (platform !== 'linux') return run(undefined)
  // The process keeps this lock across app relaunches. Create devices before
  // the app's initial enumeration, while still excluding other app smokes.
  await acquireLock()
  // Keep the unselected tone away from the selected tone's harmonics.
  const fixtures = await startFixtures({ ffmpegPath, otherFrequency: 997 })
  try {
    const source = fixtures.sources.find((source) => source.frequency === 440)
    if (!source?.deviceId?.startsWith('microphone:linux-pulse:')) {
      throw new Error('Recording matrix needs its owned 440 Hz Pulse microphone.')
    }
    return await run(source.deviceId)
  } finally {
    await fixtures.stop()
  }
}

export function assessRecordingMatrixTone(samples) {
  // Identify the sustained source, away from the encoder's start/stop edges.
  // The artifact analyzer still enforces gaps, take coverage and stop tails.
  const interior = { from: 0.5, to: samples.length / 48_000 - 0.5 }
  const selectedDbfs = bandMaxDbfs(toneEnvelope(samples, { frequency: 440 }), interior)
  const otherDbfs = bandMaxDbfs(toneEnvelope(samples, { frequency: 997 }), interior)
  const failures = []
  if (!(selectedDbfs >= -30)) failures.push('owned 440 Hz microphone tone is missing or too quiet')
  if (!(otherDbfs < -50))
    failures.push('unexpected 997 Hz energy exceeds the unselected-input limit')
  return {
    selectedDbfs: reportDbfs(selectedDbfs),
    otherDbfs: reportDbfs(otherDbfs),
    failures
  }
}

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

function rendererReady(state, microphoneId) {
  return Boolean(
    state?.wsStatus === 'connected' &&
    state.testPattern === true &&
    !state.screenId &&
    !state.windowId &&
    state.layoutPreset === 'screen-only' &&
    state.committedLayoutPreset === 'screen-only' &&
    state.visualTransactionPending === false &&
    state.layoutSwitchPending === null &&
    (!microphoneId ||
      (state.microphoneId === microphoneId &&
        state.microphoneMuted === false &&
        state.microphoneGainDb === 0))
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
  microphoneId,
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
  let microphoneSelected = !microphoneId
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
            microphoneId: config?.sources?.microphoneId ?? null,
            microphoneMuted: config?.audio?.microphoneMuted,
            microphoneGainDb: config?.audio?.microphoneGainDb,
            layoutPreset: config?.layout?.layoutPreset,
            committedLayoutPreset: state?.diagnostics?.confirmedVisual?.layout?.layoutPreset,
            visualTransactionPending: state?.diagnostics?.visualTransactionPending,
            layoutSwitchPending: state?.pendingLayout,
            microphoneSwitchReason: state?.diagnostics?.sourceSwitchReasons?.microphone
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
    if (!microphoneSelected && rendererReady(last) && last.microphoneSwitchReason === null) {
      await action(
        'eval-js',
        {
          code: `
            const scenes = window.__videorcSmokeScenePresets;
            if (!scenes) throw new Error('Studio scene actions are not ready.');
            const config = scenes.streamingState().captureConfig;
            // Use the picker's owner: a raw config write can be overwritten by
            // confirmation of the microphone already owned by the Clips ring.
            await scenes.source('microphone', {
              ...config.sources,
              microphoneId: ${JSON.stringify(microphoneId)},
              microphoneName: undefined,
              microphoneOff: undefined
            });
            scenes.configure({
              audio: { ...config.audio, microphoneMuted: false, microphoneGainDb: 0 }
            });
            return true;
          `
        },
        'select owned microphone'
      )
      microphoneSelected = true
      phase = 'confirm renderer and backend scene'
      continue
    }
    if (microphoneSelected && rendererReady(last, microphoneId)) {
      let scene
      try {
        scene = await request('scene.get', remaining())
      } catch (error) {
        throw failure(error)
      }
      const visible = scene?.sources?.filter((source) => source?.visible === true)
      visibleSourceKinds = visible?.map((source) => source.kind) ?? null
      if (visible?.length === 1 && visible[0].kind === 'test-pattern') {
        return {
          layoutPreset: 'screen-only',
          visibleSourceKinds: ['test-pattern'],
          ...(microphoneId ? { microphoneId } : {})
        }
      }
    }
    await sleep(Math.min(100, Math.max(0, deadline - now())))
  }
  throw failure()
}
