// Plan 260 Phase 3 (L6): `smoke:recording-native-preview` on the GPUI app
// (VIDEORC_APP=gpui; scripts/smoke-recording-native-preview-app.mjs hands over
// here). Electron's promise: during a take the native preview keeps
// presenting the current scene, and the recording is sound. The GPUI version
// (docs/gpui/native-preview-probes.md):
//
// 1. Test pattern, docked and presenting; a 10 s take (`studio-record`,
//    `studio-stop`).
// 2. During it: the camera corner moved twice (a new scene each time), and the
//    Preview window opened and docked back (macOS).
// 3. A sampler reads the element (frames, phase, presented scene) every 100 ms
//    and `compositor.status` every 250 ms.
// Holds when: the preview never stands still more than 1 s and stays
// presenting; it reaches each scene the compositor renders within 2 s; the
// layer sits on its slot after each placement change; the take lands in the
// isolated recordings folder and passes `analyzeRecording`.
//
// The variants Electron's script takes, on the same take:
// - VIDEORC_NATIVE_PREVIEW_SOURCE_COMPLETE_SCENE=1: the recording's
//   diagnostics must show a healthy source-complete compositor (the test
//   pattern is the synthetic source; `assertSourceCompleteCompositorHealthy`).
// - VIDEORC_ENCODER_BRIDGE_VIDEOTOOLBOX_PROBE / _VIDEO_OUTPUT: the backend
//   reads them (it inherits this env); the take's diagnostics must show the
//   chosen encoder-bridge output (`assertEncoderBridgeVideoOutputHealthy`).
// - VIDEORC_NATIVE_PREVIEW_REPORT_ONLY=1: those two gates and the take's
//   analysis warn, not fail (Electron's failOrWarn); the preview checks hold.
// - VIDEORC_NATIVE_PREVIEW_INCLUDE_HIDDEN=1: a second take with the Preview
//   closed (⌘P): the surface presents no frame during it, the diagnostics
//   carry no live preview samples or preview metrics, and the take is sound.

import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import {
  describePreview,
  enableTestPattern,
  launchGpuiApp,
  sleep,
  waitUntil
} from './lib/gpui-preview-probe.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import {
  arrivalStampedNote,
  bridgeOutputStampsByArrival,
  duplicatePtsGatesForBridgeOutput
} from './lib/bridge-output-timestamps.mjs'
import { assertEncoderBridgeVideoOutputHealthy } from './lib/encoder-bridge-output-gates.mjs'
import { summarizeNativePreviewRecordingDiagnostics } from './lib/native-preview-diagnostics.mjs'
import { assertSourceCompleteCompositorHealthy } from './lib/native-preview-source-gates.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'
import { continuity, continuityFailures } from './gpui-preview-interaction-stress.mjs'
import { geometryAligned } from './gpui-preview-window-probe.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const presentBudgetMs = Number(process.env.VIDEORC_GPUI_PREVIEW_BUDGET_MS ?? 20000)
const takeMs = Number(process.env.VIDEORC_RECORDING_NATIVE_PREVIEW_TAKE_MS ?? 10000)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const video = { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
const includeHidden = process.env.VIDEORC_NATIVE_PREVIEW_INCLUDE_HIDDEN === '1'
const sourceCompleteScene = process.env.VIDEORC_NATIVE_PREVIEW_SOURCE_COMPLETE_SCENE === '1'
const bridgeVideoOutput = process.env.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT ?? null
const bridgeVideoToolboxProbe = process.env.VIDEORC_ENCODER_BRIDGE_VIDEOTOOLBOX_PROBE === '1'
const reportOnly = process.env.VIDEORC_NATIVE_PREVIEW_REPORT_ONLY === '1'
const warmupMs = Number(process.env.VIDEORC_NATIVE_PREVIEW_WARMUP_MS ?? 1500)
const LAYOUT = {
  layoutPreset: 'screen-only',
  cameraTransformMode: 'preset',
  cameraTransform: null,
  cameraCorner: 'bottom-right',
  cameraSize: 'medium',
  cameraShape: 'rectangle',
  cameraMargin: 32,
  cameraFit: 'fill',
  cameraMirror: false,
  cameraZoom: 100,
  cameraOffsetX: 0,
  cameraOffsetY: 0,
  sideBySideSplit: '70-30',
  sideBySideCameraSide: 'right'
}

/**
 * Each scene revision the compositor rendered, and how long the preview took
 * to present it (null when it never did). Pure.
 */
export function sceneCatchUp(compositorSamples, previewSamples) {
  const firstSeen = new Map()
  for (const sample of compositorSamples) {
    const revision = sample.frameSceneRevision
    if (typeof revision === 'number' && !firstSeen.has(revision)) firstSeen.set(revision, sample.at)
  }
  return [...firstSeen].map(([revision, at]) => {
    const shown = previewSamples.find(
      (sample) =>
        typeof sample.scene === 'number' && sample.scene >= revision && sample.at >= at - 50
    )
    return { revision, lagMs: shown ? Math.max(0, shown.at - at) : null }
  })
}

/**
 * Electron's hidden-preview scenario on the GPUI app: the Preview closed (⌘P,
 * `preview-toggle-open`), a take, and the Preview opened again. The surface
 * must present nothing during the take, the backend's diagnostics must carry
 * no live preview samples or preview metrics, and the take must be sound.
 */
async function hiddenTake({ command, rpc, state, stateDir, takeStats, failures, notes }) {
  const label = 'gpui-native-preview-hidden-1080p30'
  await command('preview-toggle-open')
  await waitUntil('the Preview never closed', state, (seen) => seen?.closed === true, {
    budgetMs: 10000,
    label: describePreview
  })
  const presentedBefore = (await command('native-preview-surface-status').catch(() => null))
    ?.presentedFrameId
  const presented = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const surface = await command('native-preview-surface-status').catch(() => null)
      presented.push(surface?.presentedFrameId ?? null)
      await sleep(200)
    }
  })()
  const startedAt = Date.now()
  await command('studio-record')
  const started = await waitUntil(
    `[${label}] the take never started`,
    () => rpc('recording.status'),
    (status) => status?.state === 'recording',
    { budgetMs: 15000, everyMs: 200 }
  )
  await sleep(takeMs)
  const stopRequestedAt = Date.now()
  await command('studio-stop')
  const stopped = await waitUntil(
    `[${label}] the take never stopped`,
    () => rpc('recording.status'),
    (status) => status?.state !== 'recording' && status?.state !== 'stopping',
    { budgetMs: 60000, everyMs: 250 }
  )
  sampling = false
  await sampler
  const advanced = presented.filter(
    (id) => typeof id === 'number' && typeof presentedBefore === 'number' && id > presentedBefore
  )
  if (advanced.length > 0) {
    failures.push(
      `[${label}] the closed Preview presented frames during the take (${presentedBefore} -> ${Math.max(...advanced)})`
    )
  }
  const stats = takeStats(startedAt, stopRequestedAt)
  if ((stats.nativePreviewSamples ?? 0) > 0) {
    failures.push(
      `[${label}] the take still reported ${stats.nativePreviewSamples} live preview sample(s)`
    )
  }
  const stale = [
    ['previewPresentFps', stats.minPreviewPresentFps],
    ['previewInputToPresentLatencyP95Ms', stats.maxPreviewInputToPresentLatencyP95Ms],
    ['previewInputToPresentLatencyP99Ms', stats.maxPreviewInputToPresentLatencyP99Ms],
    ['previewCompositorFrameLag', stats.maxPreviewCompositorFrameLag],
    ['previewRenderFrameTimeP95Ms', stats.maxPreviewRenderFrameTimeP95Ms]
  ].filter(([, value]) => value !== null && value !== undefined)
  if (stale.length > 0) {
    failures.push(
      `[${label}] the diagnostics kept preview metrics: ${stale.map(([name, value]) => `${name}=${value}`).join(', ')}`
    )
  }
  const output = await resolveFinalRecordingPath({
    started: started.value,
    stopped: stopped.value,
    timeoutMs: 60000
  }).catch(() => stopped.value?.outputPath ?? started.value?.outputPath)
  if (!output || !existsSync(output)) {
    failures.push(`[${label}] the take's file is missing: ${output}`)
  } else if (relative(stateDir, output).startsWith('..')) {
    failures.push(`[${label}] the take left the smoke's folder: ${output}`)
  } else {
    const quality = await analyzeRecording(output, {
      ffmpegPath,
      ffprobePath,
      intendedFps: 30,
      expectAudio: false,
      gates: { requireMotion: false }
    })
    const reports = writeReports(quality)
    if (!quality.verdict.pass) {
      failures.push(
        `[${label}] the take failed analysis: ${quality.verdict.failures.join('; ')} (${reports.mdPath})`
      )
    }
  }
  notes.push(
    `[${label}] presented frame stayed at ${presentedBefore}; ${stats.nativePreviewSamples ?? 0} live preview sample(s)`
  )
  await command('preview-toggle-open')
}

export async function runGpuiRecordingNativePreview() {
  const stateDir = resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
      (await mkdtemp(join(tmpdir(), 'videorc-gpui-recording-native-preview-')))
  )
  const failures = []
  const notes = []
  const { app, command } = await launchGpuiApp({
    stateDir,
    timeoutMs,
    verbose: process.env.VIDEORC_SMOKE_VERBOSE === '1'
  })
  const ws = await connectBackend(app.connections['backend-ready'], timeoutMs)
  const rpc = (method, params = {}) => request(ws, 15000, method, params)
  // The backend's own diagnostics, as Electron's script reads them.
  const diagnostics = []
  const surfaceSamples = []
  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data)
      if (message.event === 'diagnostics.stats') {
        diagnostics.push({ ...message.payload, receivedAt: Date.now() })
      } else if (message.event === 'preview.surface.status') {
        surfaceSamples.push({ ...message.payload, receivedAt: Date.now() })
      }
    } catch {
      // Not an event.
    }
  })
  const takeStats = (startedAt, stopRequestedAt) =>
    summarizeNativePreviewRecordingDiagnostics(diagnostics, {
      targetFps: video.fps,
      startedAt,
      stopRequestedAt,
      warmupMs,
      previewSurfaceSamples: surfaceSamples
    })
  const variantGate = (label, check) => {
    try {
      check()
    } catch (error) {
      if (reportOnly) notes.push(`[report-only] ${label}: ${error.message}`)
      else failures.push(`${label}: ${error.message}`)
    }
  }
  const state = () => command('preview-window-state')
  const presenting = (seen) => seen?.phase === 'presenting' && seen?.closed !== true
  const preview = []
  const compositor = []
  let sampling = false
  let samplers = []
  try {
    await enableTestPattern(command)
    await waitUntil('the preview never presented', state, presenting, {
      budgetMs: presentBudgetMs,
      label: describePreview
    })
    const canFloat = (await state())?.canFloat === true
    sampling = true
    samplers = [
      (async () => {
        while (sampling) {
          const at = Date.now()
          const surface = await command('native-preview-surface-status').catch(() => null)
          const seen = await state().catch(() => null)
          preview.push({
            at,
            presented: surface?.presentedFrameId ?? null,
            phase: seen?.phase ?? null,
            scene: surface?.presentedSceneRevision ?? null
          })
          await sleep(100)
        }
      })(),
      (async () => {
        while (sampling) {
          const at = Date.now()
          const status = await rpc('compositor.status').catch(() => null)
          compositor.push({ at, frameSceneRevision: status?.frameSceneRevision ?? null })
          await sleep(250)
        }
      })()
    ]

    const takeStartedAt = Date.now()
    await command('studio-record')
    const started = await waitUntil(
      'the take never started',
      () => rpc('recording.status'),
      (status) => status?.state === 'recording',
      { budgetMs: 15000, everyMs: 200 }
    )
    const third = Math.round(takeMs / 3)
    await sleep(third)
    await rpc('scene.layout.apply_preview', {
      sources: { testPattern: true },
      layout: { ...LAYOUT, cameraCorner: 'top-left' },
      video
    }).catch((error) => notes.push(`apply_preview 1: ${error.message}`))
    if (canFloat) {
      await command('preview-window-open')
      await waitUntil(
        'the Preview window never presented',
        state,
        (seen) => seen?.floatingOpen && presenting(seen),
        {
          budgetMs: 10000,
          label: describePreview
        }
      )
      await geometryAligned(command, 'floating during the take').catch((error) =>
        failures.push(error.message)
      )
    }
    await sleep(third)
    await rpc('scene.layout.apply_preview', {
      sources: { testPattern: true },
      layout: { ...LAYOUT, cameraCorner: 'bottom-left' },
      video
    }).catch((error) => notes.push(`apply_preview 2: ${error.message}`))
    if (canFloat) {
      await command('preview-window-close')
      await waitUntil(
        'the Preview never docked back',
        state,
        (seen) => seen?.mode === 'docked' && presenting(seen),
        {
          budgetMs: 10000,
          label: describePreview
        }
      )
      await geometryAligned(command, 'docked back during the take').catch((error) =>
        failures.push(error.message)
      )
    }
    await sleep(Math.max(0, takeMs - 2 * third))
    const takeStopRequestedAt = Date.now()
    await command('studio-stop')
    const stopped = await waitUntil(
      'the take never stopped',
      () => rpc('recording.status'),
      (status) => status?.state !== 'recording' && status?.state !== 'stopping',
      { budgetMs: 60000, everyMs: 250 }
    )
    sampling = false
    await Promise.all(samplers)

    const judged = continuity(preview)
    failures.push(...continuityFailures('during the take', judged))
    const lags = sceneCatchUp(compositor, preview)
    for (const { revision, lagMs } of lags) {
      if (lagMs === null || lagMs > 2000) {
        failures.push(
          `scene ${revision}: the preview ${lagMs === null ? 'never showed it' : `took ${lagMs} ms`}`
        )
      }
    }
    // The MKV is finalized into an MP4 after the stop.
    const output = await resolveFinalRecordingPath({
      started: started.value,
      stopped: stopped.value,
      timeoutMs: 60000
    }).catch(() => stopped.value?.outputPath ?? started.value?.outputPath)
    if (!output || !existsSync(output)) {
      failures.push(`the take's file is missing: ${output}`)
    } else if (relative(stateDir, output).startsWith('..')) {
      failures.push(`the take left the smoke's folder: ${output}`)
    } else {
      // Duplicate PTS: exactly zero where each frame carries VideoToolbox's own
      // PTS (the default MPEG-TS output); reported, not gated, for the Annex-B
      // diagnostic output, where FFmpeg stamps frames on arrival.
      const bridgeOutput = process.env.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT
      const quality = await analyzeRecording(output, {
        ffmpegPath,
        ffprobePath,
        intendedFps: 30,
        expectAudio: false,
        gates: { requireMotion: false, ...duplicatePtsGatesForBridgeOutput(bridgeOutput) }
      })
      const reports = writeReports(quality)
      if (bridgeOutputStampsByArrival(bridgeOutput)) {
        notes.push(
          arrivalStampedNote(quality.metrics.duplicatePtsCount, quality.metrics.maxDuplicatePtsRun)
        )
      }
      if (!quality.verdict.pass) {
        // Electron's script sends analyzer failures through failOrWarn: a
        // report-only probe warns.
        const problem = `the take failed analysis: ${quality.verdict.failures.join('; ')} (${reports.mdPath})`
        if (reportOnly) notes.push(`[report-only] ${problem}`)
        else failures.push(problem)
      }
    }
    const stats = takeStats(takeStartedAt, takeStopRequestedAt)
    if (sourceCompleteScene) {
      variantGate('source-complete scene', () =>
        assertSourceCompleteCompositorHealthy({
          scenarioLabel: 'gpui-native-preview-1080p30',
          stats,
          sourceComplete: true,
          allowSyntheticSourceOnly: true,
          requiredLiveSourceKinds: []
        })
      )
    }
    if (bridgeVideoToolboxProbe || bridgeVideoOutput) {
      variantGate('encoder bridge output', () =>
        assertEncoderBridgeVideoOutputHealthy({
          scenarioLabel: 'gpui-native-preview-1080p30',
          stats,
          videoOutput: bridgeVideoOutput ?? 'videotoolbox-h264-mpegts'
        })
      )
    }
    if (includeHidden) {
      await hiddenTake({ command, rpc, state, stateDir, takeStats, failures, notes })
    }
    console.log(
      `gpui-recording-native-preview: still ≤ ${judged.longestStillMs} ms, +${judged.advance} frames, ` +
        `phases [${judged.phases.join(', ')}], scenes ${lags.map((lag) => `${lag.revision}:${lag.lagMs ?? 'never'}ms`).join(' ')}`
    )
  } catch (error) {
    failures.push(error?.message ?? String(error))
  } finally {
    sampling = false
    await Promise.all(samplers)
    ws.close()
    await app.stop()
    await writeFile(
      join(stateDir, 'gpui-recording-native-preview.json'),
      JSON.stringify({ platform: process.platform, failures, notes, preview, compositor }, null, 2)
    )
  }
  for (const note of notes) console.log(`gpui-recording-native-preview: note — ${note}`)
  for (const failure of failures) console.log(`gpui-recording-native-preview: FAIL — ${failure}`)
  console.log(
    `gpui-recording-native-preview: ${failures.length ? `FAIL (${failures.length})` : 'PASS'}`
  )
  return failures.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGpuiRecordingNativePreview().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exitCode = 1
    }
  )
}
