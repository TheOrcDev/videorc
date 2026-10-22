// A/V sync (lip-sync) measurement on a finished recording — plan Phase 5.
//
// Duration skew (analyzer) tells you the streams are the same length; it does NOT tell
// you whether a visible event and its sound line up. This measures the real thing: it
// finds visual flashes and audio clicks in the recorded file and reports the offset
// between each flash and its nearest click. Recorded against a flash+click fixture (a
// visual flash and an audio tone emitted on the same schedule, or a physical clap), the
// median offset IS the measured lip-sync error.
//
// Pure parsers/measurement are exported separately from the ffmpeg runners so the logic
// is unit-tested against fixtures with a known injected offset.

import { spawn } from 'node:child_process'

import { parseSilencedetect } from './recording-analyzer.mjs'

export const DEFAULT_AV_SYNC_GATES = Object.freeze({
  targetMs: 100, // |median offset| at/under this is in spec
  hardFailMs: 150, // above this hard-fails
  requireTarget: false, // when true, target misses fail instead of warn
  flashLumaThreshold: 100, // YAVG above this is a flash frame (0..255)
  clickNoiseDb: -40, // silencedetect noise floor for click onsets
  pairWindowMs: 500 // a flash/click further apart than this is not a pair
})

export const MICROPHONE_SYNC_OFFSET_LIMITS = Object.freeze({
  minMs: -1000,
  maxMs: 1000
})

// ---------------------------------------------------------------------------
// Pure parsers / measurement
// ---------------------------------------------------------------------------

/**
 * Parse FFmpeg `signalstats,metadata=print` stderr into per-frame average luma.
 * Each frame prints a `pts_time:T` line followed by a `lavfi.signalstats.YAVG=Y` line.
 * @returns {{ptsTime:number, yavg:number}[]}
 */
export function parseSignalstatsYavg(stderr) {
  const frames = []
  let pendingPts = null
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim()
    const ptsIdx = line.indexOf('pts_time:')
    if (ptsIdx !== -1) {
      const value = Number.parseFloat(line.slice(ptsIdx + 'pts_time:'.length).trim())
      pendingPts = Number.isFinite(value) ? value : null
      continue
    }
    const yIdx = line.indexOf('YAVG=')
    if (yIdx !== -1 && pendingPts !== null) {
      const yavg = Number.parseFloat(line.slice(yIdx + 'YAVG='.length).trim())
      if (Number.isFinite(yavg)) {
        frames.push({ ptsTime: pendingPts, yavg })
      }
      pendingPts = null
    }
  }
  return frames
}

/**
 * Collapse bright frames into discrete flash events (the leading edge of each run of
 * frames above `threshold`). A flash spanning a couple of frames yields one event.
 * @returns {number[]} flash onset times (seconds), sorted
 */
export function clusterFlashes(frames, threshold, minGapSec = 0.2) {
  const bright = frames
    .filter((frame) => frame.yavg > threshold)
    .map((frame) => frame.ptsTime)
    .sort((a, b) => a - b)
  const events = []
  for (const time of bright) {
    if (events.length === 0 || time - events[events.length - 1] > minGapSec) {
      events.push(time)
    }
  }
  return events
}

/**
 * Click onsets are the silence-end timestamps from silencedetect (each tone burst ends a
 * silence). Returns sorted onset times in seconds.
 * @returns {number[]}
 */
export function clickOnsetsFromSilences(silences) {
  return silences
    .map((segment) => segment.end)
    .filter((end) => typeof end === 'number' && Number.isFinite(end))
    .sort((a, b) => a - b)
}

/**
 * Pair each flash with its nearest click within the window and report the offset
 * distribution. A positive offset means audio lags video (click after flash).
 * @returns {{pairs:{flash:number, click:number, offsetMs:number}[], medianOffsetMs:number|null,
 *   meanOffsetMs:number|null, maxAbsOffsetMs:number|null}}
 */
export function measureAvOffset(
  flashes,
  clicks,
  pairWindowMs = DEFAULT_AV_SYNC_GATES.pairWindowMs
) {
  const windowSec = pairWindowMs / 1000
  const pairs = []
  for (const flash of flashes) {
    let nearest = null
    let nearestDist = Infinity
    for (const click of clicks) {
      const dist = Math.abs(click - flash)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = click
      }
    }
    if (nearest !== null && nearestDist <= windowSec) {
      pairs.push({ flash, click: nearest, offsetMs: (nearest - flash) * 1000 })
    }
  }
  if (pairs.length === 0) {
    return { pairs, medianOffsetMs: null, meanOffsetMs: null, maxAbsOffsetMs: null }
  }
  const offsets = pairs.map((pair) => pair.offsetMs)
  const sorted = [...offsets].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  const mean = offsets.reduce((sum, v) => sum + v, 0) / offsets.length
  const maxAbs = Math.max(...offsets.map(Math.abs))
  return { pairs, medianOffsetMs: median, meanOffsetMs: mean, maxAbsOffsetMs: maxAbs }
}

/**
 * Translate a measured flash/click offset into the next microphone sync setting. A
 * positive measured offset means audio is late, so the microphone offset must move
 * negative by that amount.
 */
export function recommendMicrophoneSyncOffsetMs(
  measurement,
  currentOffsetMs = 0,
  limits = MICROPHONE_SYNC_OFFSET_LIMITS
) {
  if (measurement.medianOffsetMs == null || !Number.isFinite(measurement.medianOffsetMs)) {
    return null
  }
  const current = Number.isFinite(currentOffsetMs) ? currentOffsetMs : 0
  const recommended = Math.round(current - measurement.medianOffsetMs)
  return Math.max(limits.minMs, Math.min(limits.maxMs, recommended))
}

export function buildAvSyncRecommendationReport(result, gates = DEFAULT_AV_SYNC_GATES) {
  return {
    schemaVersion: 1,
    pass: result.pass === true,
    positiveOffsetMeans: 'audio-lags-video',
    medianOffsetMs: result.medianOffsetMs,
    meanOffsetMs: result.meanOffsetMs,
    maxAbsOffsetMs: result.maxAbsOffsetMs,
    currentMicrophoneSyncOffsetMs: result.currentMicrophoneSyncOffsetMs,
    recommendedMicrophoneSyncOffsetMs: result.recommendedMicrophoneSyncOffsetMs,
    targetMs: gates.targetMs,
    hardFailMs: gates.hardFailMs,
    requireTarget: gates.requireTarget === true,
    flashCount: result.flashCount,
    clickCount: result.clickCount,
    pairCount: Array.isArray(result.pairs) ? result.pairs.length : 0,
    failures: result.failures ?? [],
    warnings: result.warnings ?? []
  }
}

/** Apply the A/V sync gates to a measured offset. */
export function evaluateAvSync(measurement, gates = DEFAULT_AV_SYNC_GATES) {
  const failures = []
  const warnings = []
  if (measurement.medianOffsetMs == null) {
    failures.push(
      'no flash/click pairs detected — record against the flash+click fixture before accepting lip-sync'
    )
    return { pass: false, failures, warnings }
  }
  const abs = Math.abs(measurement.medianOffsetMs)
  if (abs > gates.hardFailMs) {
    failures.push(
      `A/V sync ${measurement.medianOffsetMs.toFixed(0)}ms exceeds hard-fail ${gates.hardFailMs}ms`
    )
  } else if (abs > gates.targetMs) {
    const message = `A/V sync ${measurement.medianOffsetMs.toFixed(0)}ms exceeds target ${gates.targetMs}ms`
    if (gates.requireTarget) {
      failures.push(message)
    } else {
      warnings.push(message)
    }
  }
  return { pass: failures.length === 0, failures, warnings }
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args)
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => {
      stderr += text
    })
    child.on('error', rejectRun)
    child.on('close', () => resolveRun(stderr))
  })
}

export async function runSignalstats(filePath, { ffmpegPath = 'ffmpeg' } = {}) {
  const stderr = await run(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-an',
    '-vf',
    'signalstats,metadata=print',
    '-f',
    'null',
    '-'
  ])
  return parseSignalstatsYavg(stderr)
}

/**
 * The click-onset audio filter. `bandpassHz` narrows detection to the
 * stimulus's 1 kHz click, for recordings that carry other sound (System
 * audio captures everything the computer plays). The two-pole band-pass
 * delays onsets by about 1 ms, far under the gates.
 */
export function clickOnsetFilter({
  noiseDb = DEFAULT_AV_SYNC_GATES.clickNoiseDb,
  bandpassHz
} = {}) {
  const detect = `silencedetect=noise=${noiseDb}dB:d=0.02`
  return Number.isFinite(bandpassHz)
    ? `bandpass=f=${bandpassHz}:width_type=h:w=300,${detect}`
    : detect
}

export async function runClickOnsets(
  filePath,
  { ffmpegPath = 'ffmpeg', noiseDb = DEFAULT_AV_SYNC_GATES.clickNoiseDb, bandpassHz } = {}
) {
  const stderr = await run(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-af',
    clickOnsetFilter({ noiseDb, bandpassHz }),
    '-f',
    'null',
    '-'
  ])
  return clickOnsetsFromSilences(parseSilencedetect(stderr))
}

/**
 * Measure lip-sync on a recording made against the flash+click fixture.
 * @returns {{pass:boolean, medianOffsetMs:number|null, maxAbsOffsetMs:number|null,
 *   flashCount:number, clickCount:number, failures:string[], warnings:string[]}}
 */
export async function measureAvSync(filePath, options = {}) {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg'
  const gates = { ...DEFAULT_AV_SYNC_GATES, ...(options.gates ?? {}) }
  const currentMicrophoneSyncOffsetMs = Number.isFinite(options.currentMicrophoneSyncOffsetMs)
    ? options.currentMicrophoneSyncOffsetMs
    : 0
  const [frames, clicks] = await Promise.all([
    runSignalstats(filePath, { ffmpegPath }),
    runClickOnsets(filePath, {
      ffmpegPath,
      noiseDb: gates.clickNoiseDb,
      bandpassHz: options.clickBandpassHz
    })
  ])
  const flashes = clusterFlashes(frames, gates.flashLumaThreshold)
  const measurement = measureAvOffset(flashes, clicks, gates.pairWindowMs)
  const verdict = evaluateAvSync(measurement, gates)
  const recommendedMicrophoneSyncOffsetMs = recommendMicrophoneSyncOffsetMs(
    measurement,
    currentMicrophoneSyncOffsetMs
  )
  return {
    pass: verdict.pass,
    medianOffsetMs: measurement.medianOffsetMs,
    meanOffsetMs: measurement.meanOffsetMs,
    maxAbsOffsetMs: measurement.maxAbsOffsetMs,
    currentMicrophoneSyncOffsetMs,
    recommendedMicrophoneSyncOffsetMs,
    flashCount: flashes.length,
    clickCount: clicks.length,
    failures: verdict.failures,
    warnings: verdict.warnings,
    pairs: measurement.pairs
  }
}

// ---------------------------------------------------------------------------
// Fixture generation (for the lip-sync acceptance test and for real recordings)
// ---------------------------------------------------------------------------

/**
 * FFmpeg args that build a flash+click fixture: a white flash on the first frame of each
 * second and a 1 kHz tone burst on the same schedule (optionally delayed to inject a
 * known A/V offset). Used by the test, and as the reference an operator can play on
 * screen + through speakers while recording for a real lip-sync acceptance pass.
 */
export function flashClickFixtureArgs(
  outputPath,
  {
    seconds = 5,
    audioDelayMs = 0,
    fps = 30,
    videoCodecArgs = ['-c:v', 'libx264', '-preset', 'ultrafast']
  } = {}
) {
  const audioFilter = audioDelayMs > 0 ? `,adelay=${audioDelayMs}|${audioDelayMs}` : ''
  return [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=320x240:r=${fps}`,
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=sin(1000*2*PI*t)*lt(mod(t\\,1)\\,0.06):s=48000:channel_layout=stereo',
    '-t',
    String(seconds),
    '-vf',
    'drawbox=t=fill:color=white:enable=lt(mod(t\\,1)\\,0.04)',
    '-af',
    `aresample=48000${audioFilter}`,
    '-fps_mode',
    'cfr',
    ...videoCodecArgs,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    outputPath
  ]
}
