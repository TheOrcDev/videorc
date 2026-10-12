#!/usr/bin/env node
// CLI for the A/V sync (lip-sync) measurement — plan Phase 5.
//
// Record against the flash+click fixture (a visual flash + an audio tone on the same
// schedule, or a physical clap on camera), then measure how far the sound lags the
// picture in the finished file:
//
//   node scripts/measure-av-sync.mjs <recording.mp4> [--click-noise-db -55]
//   node scripts/measure-av-sync.mjs <run.evidence.json> [--click-noise-db -55]
//   node scripts/measure-av-sync.mjs <recording.mp4> --json
//
// To generate the reference fixture to play while recording (or to self-test):
//   node scripts/measure-av-sync.mjs --make-fixture out.mp4 [--seconds 10] [--audio-delay-ms 0]
//
// Exits non-zero when the median A/V offset hard-fails (>150ms), or when
// `--require-target` is set and the median misses the 100ms target.
//
// System audio end to end (plan 069 S7): record the flash+click stimulus
// through the real dev app with a screen-only scene and System audio On (no
// microphone, so the clicks reach the file only as captured system audio),
// then measure how far the clicks sit from the flashes:
//
//   node scripts/measure-av-sync.mjs --system-audio [--runs 3] [--fps 60] [--recording-ms 12000]
//
// The recording already carries SYSTEM_AUDIO_SYNC_OFFSET_MS (read from
// system_audio_session.rs), so the residual offset is the error. The gate is
// the mean of every flash/click pair over the runs (within 25 ms); a single
// run may sit up to one video frame further off, because the flash is only
// resolved to a frame (see evaluateSystemAudioSyncRun). A mean beyond 15 ms
// with every run on the same side prints a STOP for the owner (the constant is
// never edited here). Needs the dev app's Screen Recording grant and Google
// Chrome for the stimulus; it records the main display and flashes it white
// once a second.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_AV_SYNC_GATES,
  buildAvSyncRecommendationReport,
  flashClickFixtureArgs,
  measureAvSync
} from './lib/av-sync.mjs'
import { fixtureH264EncoderArgs } from './lib/ffmpeg-available.mjs'
import {
  SYSTEM_AUDIO_SYNC_TOLERANCE_MS,
  SYSTEM_AUDIO_TONE_HZ,
  evaluateSystemAudioSyncRun,
  parseSystemAudioSyncOffsetMs,
  summarizeSystemAudioSyncRuns
} from './lib/system-audio-gates.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  let argv = process.argv.slice(2)
  if (argv[0] === '--') argv = argv.slice(1)
  const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'

  if (argv.includes('--system-audio')) {
    return await measureSystemAudioSync(argv, ffmpegPath)
  }

  if (argv[0] === '--make-fixture') {
    const out = argv[1]
    if (!out) {
      console.error('Usage: --make-fixture <out.mp4> [--seconds N] [--audio-delay-ms N]')
      process.exit(2)
    }
    const seconds = numFlag(argv, '--seconds') ?? 10
    const audioDelayMs = numFlag(argv, '--audio-delay-ms') ?? 0
    await runFfmpeg(
      ffmpegPath,
      flashClickFixtureArgs(out, {
        seconds,
        audioDelayMs,
        videoCodecArgs: fixtureH264EncoderArgs(ffmpegPath)
      })
    )
    console.log(`Wrote flash+click fixture: ${out} (${seconds}s, audio delay ${audioDelayMs}ms)`)
    return 0
  }

  const input = argv[0]
  if (!input) {
    console.error('Usage: node scripts/measure-av-sync.mjs <recording.mp4|run.evidence.json>')
    process.exit(2)
  }
  const json = argv.includes('--json')
  const file = recordingFileFromInput(input, { quiet: json })

  const requireTarget = argv.includes('--require-target')
  const currentMicrophoneSyncOffsetMs = numFlag(argv, '--current-offset-ms') ?? 0
  const clickNoiseDb = numFlag(argv, '--click-noise-db')
  const targetMs = 100
  const gates = { ...DEFAULT_AV_SYNC_GATES, requireTarget, targetMs }
  if (Number.isFinite(clickNoiseDb)) gates.clickNoiseDb = clickNoiseDb
  const result = await measureAvSync(file, {
    ffmpegPath,
    currentMicrophoneSyncOffsetMs,
    gates
  })
  if (json) {
    console.log(JSON.stringify(buildAvSyncRecommendationReport(result, gates), null, 2))
    return result.pass ? 0 : 1
  }
  console.log(
    `A/V sync: ${result.medianOffsetMs == null ? 'n/a' : `${result.medianOffsetMs.toFixed(0)}ms median`} (positive = audio lags video)`
  )
  console.log(
    `  flashes ${result.flashCount}, clicks ${result.clickCount}, pairs ${result.pairs.length}, max |offset| ${result.maxAbsOffsetMs == null ? 'n/a' : `${result.maxAbsOffsetMs.toFixed(0)}ms`}`
  )
  if (result.recommendedMicrophoneSyncOffsetMs != null) {
    const withinTarget = Math.abs(result.medianOffsetMs) <= targetMs
    const label = withinTarget ? 'current within target; zero-error estimate' : 'suggested'
    console.log(
      `  microphoneSyncOffsetMs: current ${result.currentMicrophoneSyncOffsetMs}ms -> ${label} ${result.recommendedMicrophoneSyncOffsetMs}ms`
    )
  }
  for (const f of result.failures) console.log(`  ❌ ${f}`)
  for (const w of result.warnings) console.log(`  ⚠️  ${w}`)
  console.log(result.pass ? 'PASS' : 'FAIL')
  return result.pass ? 0 : 1
}

async function measureSystemAudioSync(argv, ffmpegPath) {
  if (process.platform !== 'darwin') {
    console.error('--system-audio needs macOS (ScreenCaptureKit system audio).')
    return 2
  }
  const runs = numFlag(argv, '--runs') ?? 3
  const recordingMs = numFlag(argv, '--recording-ms') ?? 12000
  const fps = numFlag(argv, '--fps') ?? 60
  const systemAudioSyncOffsetMs = parseSystemAudioSyncOffsetMs(
    readFileSync(
      join(repoRoot, 'crates', 'videorc-backend', 'src', 'system_audio_session.rs'),
      'utf8'
    )
  )
  const root = mkdtempSync(join(tmpdir(), 'videorc-av-sync-system-audio-'))
  console.log(
    `System audio o_sys: SYSTEM_AUDIO_SYNC_OFFSET_MS = ${systemAudioSyncOffsetMs} ms; ${runs} run(s) of ${recordingMs} ms at ${fps} fps into ${root}`
  )
  const results = []
  for (let index = 0; index < runs; index += 1) {
    const outputDirectory = join(root, `run-${index + 1}`)
    const code = await runNode(join(repoRoot, 'scripts', 'real-source-baseline-app.mjs'), [], {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_BASELINE_RECORDING_MS: String(recordingMs),
      VIDEORC_BASELINE_FPS: String(fps),
      VIDEORC_BASELINE_WARMUP_MS: '2000',
      VIDEORC_BASELINE_PREVIEW_MEASUREMENT_MS: '2000',
      VIDEORC_BASELINE_SOURCE_READINESS_MS: '60000',
      VIDEORC_BASELINE_NO_CAMERA: '1',
      VIDEORC_BASELINE_NO_MIC: '1',
      VIDEORC_BASELINE_LAYOUT_PRESET: 'screen-only',
      VIDEORC_BASELINE_AV_SYNC_STIMULUS: '1',
      VIDEORC_BASELINE_SYSTEM_AUDIO: '1'
    })
    const manifestPath = join(outputDirectory, 'latest-real-source-evidence.json')
    const recording = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8'))?.paths?.recording
      : null
    if (code !== 0 || typeof recording !== 'string' || !existsSync(recording)) {
      const failure = `run ${index + 1}: the real-source recording did not complete (exit ${code}, recording ${recording ?? 'none'})`
      console.log(`  ❌ ${failure}`)
      results.push({ pass: false, failures: [failure], residualMs: null, offsetsMs: [] })
      continue
    }
    const measurement = await measureAvSync(recording, {
      ffmpegPath,
      clickBandpassHz: SYSTEM_AUDIO_TONE_HZ,
      gates: { ...DEFAULT_AV_SYNC_GATES }
    })
    const run = evaluateSystemAudioSyncRun(
      {
        offsetsMs: measurement.pairs.map((pair) => pair.offsetMs),
        medianOffsetMs: measurement.medianOffsetMs
      },
      { systemAudioSyncOffsetMs, frameMs: 1000 / fps }
    )
    results.push({
      ...run,
      recording,
      flashCount: measurement.flashCount,
      clickCount: measurement.clickCount,
      pairCount: measurement.pairs.length,
      meanOffsetMs: measurement.meanOffsetMs,
      maxAbsOffsetMs: measurement.maxAbsOffsetMs
    })
    console.log(
      `run ${index + 1}: median ${run.residualMs ?? 'n/a'} ms, mean ${run.meanMs ?? 'n/a'} ms (positive = system audio late), pairs ${measurement.pairs.length}, flashes ${measurement.flashCount}, clicks ${measurement.clickCount}, pair offsets [${measurement.pairs.map((pair) => pair.offsetMs.toFixed(1)).join(', ')}] ${run.pass ? 'PASS' : 'FAIL'}`
    )
    for (const failure of run.failures) console.log(`  ❌ ${failure}`)
  }
  const summary = summarizeSystemAudioSyncRuns(results, { systemAudioSyncOffsetMs })
  console.log(
    `System audio o_sys: pooled mean ${summary.pooledMeanMs ?? 'n/a'} ms over ${summary.pairs} pairs (gate ±${SYSTEM_AUDIO_SYNC_TOLERANCE_MS} ms), run medians [${summary.residualsMs.join(', ')}] ms (spread ${summary.spreadMs ?? 'n/a'} ms), implied o_sys ${summary.impliedOffsetMs ?? 'n/a'} ms`
  )
  console.log(
    `  A ${(1000 / fps).toFixed(1)} ms frame bounds one run's resolution: the screen capture and compositor sample the flash once per frame, at a phase fixed per session, so single runs differ by up to a frame; the pooled mean is the o_sys estimate.`
  )
  for (const failure of summary.failures) console.log(`  ❌ ${failure}`)
  if (summary.stop) console.log(`  STOP: ${summary.stopReason}`)
  console.log(summary.pass ? 'PASS' : 'FAIL')
  return summary.pass ? 0 : 1
}

function runNode(script, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    })
    child.on('error', rejectRun)
    child.on('close', (code) => resolveRun(code))
  })
}

function recordingFileFromInput(input, { quiet = false } = {}) {
  if (!input.endsWith('.json')) return input
  const manifest = JSON.parse(readFileSync(input, 'utf8'))
  const recording = manifest?.paths?.recording ?? manifest?.diagnostics?.finalFile?.path
  if (typeof recording !== 'string' || recording.trim() === '') {
    throw new Error(`Evidence manifest does not include a recording path: ${input}`)
  }
  if (!quiet) {
    console.log(`Using recording from evidence manifest: ${recording}`)
  }
  return recording
}

function numFlag(argv, name) {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] != null ? Number(argv[i + 1]) : undefined
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpegPath, args)
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (t) => (stderr += t))
    child.on('error', rejectRun)
    child.on('close', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(stderr.trim()))))
  })
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`measure-av-sync failed: ${error.message}`)
    process.exit(2)
  })
