// Plan 260 Phase 3 (L6): `smoke:preview-interaction-stress` on the GPUI app
// (VIDEORC_APP=gpui; scripts/smoke-preview-interaction-stress-app.mjs hands
// over here). Electron's gate keeps sampling its native layer while
// placement, focus and scene intent change with no settle period; this does
// the same to the GPUI native preview. A sampler reads the element's live
// `presentedFrameId` and the preview's phase every 100 ms through every
// phase, and each phase must keep presenting:
//
// 1. Rapid scenes: an overlapping burst of layout intents (the last must
//    win), then VIDEORC_PREVIEW_STRESS_SCENE_ROUNDS (3) rounds of Electron's
//    sequence (`PREVIEW_INTERACTION_STRESS_PROFILE.sceneSequence`), each
//    converging on the compositor's scene. A preset the backend refuses
//    without a real screen or camera is a named SKIP for the phase.
// 2. The Preview window (macOS): a storm of moves and resizes
//    (`preview-window-set-bounds` every 40 ms, no settle), then the layer's
//    geometry check (displayed = set = slot, as probe:preview-window).
// 3. Docked: the main window moved and sized in a storm
//    (`main-window-set-bounds`).
//
// A phase fails when the preview stood still longer than
// VIDEORC_PREVIEW_STRESS_MAX_STILL_MS (1000), left presenting (healing,
// stalled, fallback), or presented nothing. Functional contract only; the fps
// budgets stay in Electron's gate.
//
// Device mode (`smoke:preview-interaction-stress:devices`,
// VIDEORC_PREVIEW_INTERACTION_DEVICE_SMOKE=1; OWNER RUN ONLY: it records the
// real screen and camera): the real screen and camera instead of the test
// pattern, and every phase runs inside a take
// (VIDEORC_PREVIEW_INTERACTION_RECORDING_MS, 60 s; 640x360 at 30 fps, the
// screen-camera layout, as Electron's) whose file must pass the recording
// analyzer and last the take. A self-check without the owner's content:
// VIDEORC_PREVIEW_INTERACTION_DEVICE_SCREEN=<sourceId> (a fixture window) and
// VIDEORC_PREVIEW_INTERACTION_DEVICE_CAMERA=0 (camera off). Not ported, said
// in the evidence: Electron's ScreenCaptureKit pixel oracle (the Swift oracle
// inside smoke-preview-interaction-stress-app.mjs, matched to Electron's
// windows); here the presented-frame and layer-geometry oracles judge.

import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  describePreview,
  enableTestPattern,
  launchGpuiApp,
  sleep,
  waitUntil
} from './lib/gpui-preview-probe.mjs'
import { PREVIEW_INTERACTION_STRESS_PROFILE } from './lib/preview-interaction-stress.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { geometryAligned } from './gpui-preview-window-probe.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 240000)
const presentBudgetMs = Number(process.env.VIDEORC_GPUI_PREVIEW_BUDGET_MS ?? 20000)
const maxStillMs = Number(process.env.VIDEORC_PREVIEW_STRESS_MAX_STILL_MS ?? 1000)
const sceneRounds = Math.max(1, Number(process.env.VIDEORC_PREVIEW_STRESS_SCENE_ROUNDS ?? 3))
const STORM_STEPS = 60
const STORM_EVERY_MS = 40
const SAMPLE_EVERY_MS = 100
const deviceMode = process.env.VIDEORC_PREVIEW_INTERACTION_DEVICE_SMOKE === '1'
const deviceRecordingMs = Number(process.env.VIDEORC_PREVIEW_INTERACTION_RECORDING_MS ?? 60000)
const DEVICE_VIDEO = { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 }
const PIXEL_ORACLE_GAP =
  "Electron's ScreenCaptureKit pixel oracle is not ported to the GPUI app (its Swift oracle matches Electron's windows); the presented-frame and layer-geometry oracles judge"

/**
 * Device mode's take: the capture sources the picks name, as
 * `session.start` takes them. Pure.
 */
export function deviceCaptureSources(screen, camera) {
  return {
    ...(screen.kind === 'window' ? { windowId: screen.id } : { screenId: screen.id }),
    cameraId: camera?.cameraId ?? null,
    testPattern: false
  }
}

/** Electron's device-mode layout (`deviceLayout`), by preset. Pure. */
export function deviceLayout(layoutPreset) {
  return {
    layoutPreset,
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraCornerRadiusPct: 12,
    cameraAspect: 'source',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  }
}

/** Device mode's take must last this long (Electron's floor). Pure. */
export function minimumTakeSeconds(requestedMs) {
  return Math.max(2, requestedMs / 1000 - 8)
}

/**
 * What a phase's samples say: the longest stretch the presented frame stood
 * still, the phases seen, and how far it advanced. Pure.
 */
export function continuity(samples) {
  let longestStillMs = 0
  let stillSince = samples[0]?.at ?? 0
  for (let index = 1; index < samples.length; index++) {
    if (samples[index].presented !== samples[index - 1].presented) {
      stillSince = samples[index].at
    }
    longestStillMs = Math.max(longestStillMs, samples[index].at - stillSince)
  }
  const ids = samples.map((sample) => sample.presented).filter((id) => typeof id === 'number')
  return {
    longestStillMs,
    phases: [...new Set(samples.map((sample) => sample.phase))],
    advance: ids.length ? ids.at(-1) - ids[0] : 0,
    samples: samples.length
  }
}

/** A phase's continuity failures. Pure. */
export function continuityFailures(label, summary, limitMs = maxStillMs) {
  const failures = []
  if (!(summary.advance > 0)) failures.push(`${label}: no frames presented`)
  if (summary.longestStillMs > limitMs) {
    failures.push(`${label}: the preview stood still for ${summary.longestStillMs} ms`)
  }
  const bad = summary.phases.filter((phase) => phase && phase !== 'presenting')
  if (bad.length) failures.push(`${label}: the preview left presenting (${bad.join(', ')})`)
  return failures
}

/** Samples the preview every 100 ms until stopped. */
function startSampler(command) {
  let running = true
  let samples = []
  const loop = (async () => {
    while (running) {
      const at = Date.now()
      const [surface, state] = await Promise.all([
        command('native-preview-surface-status').catch(() => null),
        command('preview-window-state').catch(() => null)
      ])
      samples.push({
        at,
        presented: surface?.presentedFrameId ?? null,
        phase: state?.phase ?? null
      })
      await sleep(SAMPLE_EVERY_MS)
    }
  })()
  return {
    /** The samples since the last take, and a fresh start. */
    take() {
      const taken = samples
      samples = []
      return taken
    },
    async stop() {
      running = false
      await loop
    }
  }
}

const results = []
function record(name, verdict, detail = {}) {
  results.push({ name, verdict, ...detail })
  const words = detail.reason ?? detail.summary ?? ''
  console.log(`gpui-preview-stress: ${verdict} ${name}${words ? ` — ${words}` : ''}`)
}

export async function runGpuiPreviewInteractionStress() {
  const stateDir = resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
      (await mkdtemp(join(tmpdir(), 'videorc-gpui-preview-stress-')))
  )
  const { app, command } = await launchGpuiApp({
    stateDir,
    timeoutMs,
    verbose: process.env.VIDEORC_SMOKE_VERBOSE === '1'
  })
  const ws = await connectBackend(app.connections['backend-ready'], timeoutMs)
  const rpc = (method, params = {}) => request(ws, 15000, method, params)
  const state = () => command('preview-window-state')
  const presenting = (seen) => seen?.phase === 'presenting' && seen?.closed !== true
  let sampler
  /** Runs `body` with the sampler's window around it and judges continuity. */
  const phase = async (name, body) => {
    sampler.take()
    let detail
    try {
      detail = (await body()) ?? {}
    } catch (error) {
      sampler.take()
      record(name, 'FAIL', { reason: error?.message ?? String(error) })
      return
    }
    if (detail.skip) {
      sampler.take()
      record(name, 'SKIP', detail)
      return
    }
    const summary = continuity(sampler.take())
    const failures = [...(detail.failures ?? []), ...continuityFailures(name, summary)]
    record(name, failures.length ? 'FAIL' : 'PASS', {
      summary: `still ≤ ${summary.longestStillMs} ms, +${summary.advance} frames, phases [${summary.phases.join(', ')}]${detail.summary ? `; ${detail.summary}` : ''}`,
      failures,
      continuity: summary
    })
  }

  let take = null
  let takeDone = false
  try {
    if (deviceMode) {
      const screen = await command('select-screen-device', {
        settleMs: 1000,
        ...(process.env.VIDEORC_PREVIEW_INTERACTION_DEVICE_SCREEN
          ? { sourceId: process.env.VIDEORC_PREVIEW_INTERACTION_DEVICE_SCREEN }
          : {})
      })
      const camera =
        process.env.VIDEORC_PREVIEW_INTERACTION_DEVICE_CAMERA === '0'
          ? await command('select-camera-device', { off: true, settleMs: 500 })
          : await command('select-camera-device', { settleMs: 1000 })
      const sources = deviceCaptureSources(screen, camera)
      const directory = await command('authorize-smoke-resource', {
        path: stateDir,
        kind: 'output-directory'
      })
      const started = await rpc('session.start', {
        sources,
        layout: deviceLayout(sources.cameraId ? 'screen-camera' : 'screen-only'),
        output: {
          recordEnabled: true,
          streamEnabled: false,
          outputDirectoryCapability: directory.capabilityId,
          video: DEVICE_VIDEO,
          rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
        }
      })
      if (started?.state !== 'recording') {
        throw new Error(`the device take did not start: ${JSON.stringify(started)}`)
      }
      take = { started, startedAt: Date.now(), sources: { screen, camera } }
      console.log(
        `gpui-preview-stress: device mode, recording ${screen.kind} ${screen.id}${sources.cameraId ? ` + camera ${sources.cameraId}` : ', camera off'}`
      )
    } else {
      await enableTestPattern(command)
    }
    await waitUntil('the docked preview never presented', state, presenting, {
      budgetMs: presentBudgetMs,
      label: describePreview
    })
    sampler = startSampler(command)

    await phase('rapid scenes (latest intent wins)', async () => {
      const failures = []
      const converge = async (preset) => {
        await waitUntil(
          `the compositor never showed ${preset}`,
          () => rpc('compositor.status'),
          (status) => status?.sceneLayout?.layoutPreset === preset,
          { budgetMs: 10000, everyMs: 100 }
        )
      }
      // The presets this run can show: a camera layout needs a camera, which
      // a test-pattern run has none of (Electron's gate supplies one with its
      // synthetic motion), so the Studio refuses it by name.
      const available = []
      const refused = []
      for (const preset of PREVIEW_INTERACTION_STRESS_PROFILE.sceneSequence) {
        try {
          await command('select-layout-preset', { preset, settleMs: 0 })
          await converge(preset)
          available.push(preset)
        } catch (error) {
          if (
            /Could not find layout preset|Layout preset \S+ is disabled|blocked|needs a (screen|camera)/i.test(
              error.message
            )
          ) {
            refused.push(preset)
          } else {
            failures.push(`${preset}: ${error.message}`)
          }
        }
      }
      if (available.length < 2) {
        return {
          skip: true,
          reason: `only [${available.join(', ')}] can show without a camera (refused: ${refused.join(', ')}); run with a camera for this phase`
        }
      }
      // The overlapping burst: every available intent in flight at once; the
      // last must win.
      await Promise.allSettled(
        available.map((preset) => command('select-layout-preset', { preset, settleMs: 0 }))
      )
      try {
        await converge(available.at(-1))
      } catch (error) {
        failures.push(`burst: ${error.message}`)
      }
      for (let round = 1; round <= sceneRounds; round++) {
        for (const preset of available) {
          try {
            await command('select-layout-preset', { preset, settleMs: 0 })
            await converge(preset)
          } catch (error) {
            failures.push(`round ${round} ${preset}: ${error.message}`)
          }
        }
      }
      return {
        failures,
        summary: `${sceneRounds} rounds of [${available.join(', ')}]${refused.length ? `; refused without a camera: ${refused.join(', ')}` : ''}`
      }
    })

    await phase('the Preview window: move and resize storm', async () => {
      if ((await state())?.canFloat !== true) {
        return {
          skip: true,
          reason: 'the Preview window opens only on macOS with the native preview'
        }
      }
      await command('preview-window-open')
      await waitUntil(
        'the Preview window never presented',
        state,
        (seen) => seen?.floatingOpen === true && presenting(seen),
        { budgetMs: presentBudgetMs, label: describePreview }
      )
      for (let step = 0; step < STORM_STEPS; step++) {
        const wave = Math.abs((step % 20) - 10) / 10
        await command('preview-window-set-bounds', {
          x: 120 + Math.round(wave * 240),
          y: 100 + Math.round(wave * 120),
          width: 640 + Math.round(wave * 420),
          height: 360 + (step % 3) * 90
        })
        await sleep(STORM_EVERY_MS)
      }
      await sleep(600)
      const failures = []
      let aligned = 'aligned'
      try {
        await geometryAligned(command, 'after the storm')
      } catch (error) {
        aligned = 'misaligned'
        failures.push(error.message)
      }
      await command('preview-window-close')
      await waitUntil(
        'the Preview never docked back',
        state,
        (seen) => seen?.mode === 'docked' && presenting(seen),
        {
          budgetMs: presentBudgetMs,
          label: describePreview
        }
      )
      return { failures, summary: `${STORM_STEPS} moves, then the layer ${aligned}` }
    })

    await phase('docked: main-window move and resize storm', async () => {
      for (let step = 0; step < STORM_STEPS; step++) {
        const wave = Math.abs((step % 20) - 10) / 10
        await command('main-window-set-bounds', {
          x: 80 + Math.round(wave * 160),
          y: 60 + Math.round(wave * 80),
          width: 1100 + Math.round(wave * 300),
          height: 740 + (step % 3) * 40
        })
        await sleep(STORM_EVERY_MS)
      }
      await command('main-window-set-bounds', { x: 100, y: 90, width: 1180, height: 780 })
      await sleep(600)
      return { summary: `${STORM_STEPS} moves` }
    })

    if (take) {
      await phase('device take: the whole run recorded', async () => {
        const remainingMs = Math.max(0, deviceRecordingMs - (Date.now() - take.startedAt))
        if (remainingMs > 0) await sleep(remainingMs)
        const stopRequestedAt = Date.now()
        const stopped = await rpc('session.stop')
        takeDone = true
        const file = await resolveFinalRecordingPath({
          started: take.started,
          stopped,
          stopRequestedAt,
          timeoutMs
        })
        if (!file || !existsSync(file)) return { failures: [`the take's file is missing: ${file}`] }
        const quality = await analyzeRecording(file, {
          ffmpegPath: process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg',
          ffprobePath: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe',
          intendedFps: DEVICE_VIDEO.fps,
          expectAudio: false,
          gates: {
            requireMotion: false,
            avSyncTargetMs: Number.POSITIVE_INFINITY,
            avSyncHardFailMs: Number.POSITIVE_INFINITY
          }
        })
        const reports = writeReports(quality)
        const failures = []
        if (!quality.verdict.pass) {
          failures.push(
            `the take failed analysis: ${quality.verdict.failures.join('; ')} (${reports.mdPath})`
          )
        }
        const seconds = quality.metrics.durationSeconds ?? 0
        if (seconds < minimumTakeSeconds(deviceRecordingMs)) {
          failures.push(
            `the take lasted ${seconds}s, under ${minimumTakeSeconds(deviceRecordingMs)}s`
          )
        }
        return { failures, summary: `${seconds.toFixed(1)}s take, ${file}` }
      })
    }
  } finally {
    if (take && !takeDone) await rpc('session.stop').catch(() => undefined)
    await sampler?.stop()
    ws.close()
    await app.stop()
    await writeFile(
      join(stateDir, 'gpui-preview-stress.json'),
      JSON.stringify(
        {
          platform: process.platform,
          maxStillMs,
          sceneRounds,
          deviceMode,
          ...(deviceMode ? { pixelOracle: PIXEL_ORACLE_GAP, deviceSources: take?.sources } : {}),
          results
        },
        null,
        2
      )
    )
    console.log(`gpui-preview-stress: evidence ${join(stateDir, 'gpui-preview-stress.json')}`)
  }
  const failed = results.filter((each) => each.verdict === 'FAIL')
  console.log(`gpui-preview-stress: ${failed.length ? `FAIL (${failed.length})` : 'PASS'}`)
  return failed.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGpuiPreviewInteractionStress().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exitCode = 1
    }
  )
}
