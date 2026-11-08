// Plan 069 S7: pure assessment logic for `pnpm smoke:system-audio` and
// `measure:av-sync --system-audio`.
//
// Artifact verdicts are computed from the finished artifact's decoded audio. The
// measure is 1 kHz-selective (a sliding Goertzel filter), so other sound the
// computer plays during a run (music, a notification) cannot fake a tone or,
// unless it carries real energy at 1 kHz, fail a silence check. Broadband
// levels are reported next to it for diagnosis; only the System audio Off case
// (the privacy gate) also requires broadband digital silence, because with no
// microphone and no system source the bus writes exact zeros.
//
// Time base ("file time"): seconds from the first video frame of the file,
// i.e. the session's video epoch. Decoded audio sample i sits at
// `audioStart - videoStart + i / sampleRate`, using the streams' ffprobe
// start_time values. The bus's own sample counter starts at the same epoch, so
// a mix cutover reported by the backend at bus sample N lands at
// `audioStart - videoStart + N / sampleRate` (the FFmpeg track shift is
// min(o_mic, o_sys) = 0 for these sessions).

import { spawn } from 'node:child_process'

export const SYSTEM_AUDIO_SAMPLE_RATE = 48_000
export const SYSTEM_AUDIO_TONE_HZ = 1_000

export const SYSTEM_AUDIO_GATES = Object.freeze({
  // 20 ms Hann windows (20 cycles of 1 kHz at 48 kHz) read a pure tone at its
  // true amplitude; 5 ms hops give edges to a few ms.
  windowMs: 20,
  hopMs: 5,
  // Tone present: its 1 kHz amplitude is at least this loud.
  tonePresentDbfs: -30,
  // Silence at 1 kHz: nothing above this in the band.
  bandSilenceDbfs: -50,
  // System audio Off: the whole track is digital silence (the bus writes zeros).
  digitalSilenceDbfs: -80,
  // Gaps inside one tone this short are merged; shorter blips are ignored.
  mergeGapMs: 60,
  minToneMs: 150,
  // A live toggle must cut the tone within this of the bus cutover, plus the
  // bus's 5 ms enable ramp.
  toggleToleranceMs: 50,
  rampMs: 5,
  // Turning On can only add sound from the capture's first sample. The slot
  // joins at the cutover (the bus cursor, which plays out 150 ms behind the
  // wall clock) on the capture's first buffer, so a sound already playing
  // enters between the cutover and the cutover + the playout delay.
  playoutDelayMs: 150,
  // A window inside a tone more than this far under its median is a dropout.
  dropoutDb: 6,
  interiorMarginMs: 60,
  // Band silence is checked this far away from a tone's edges.
  silenceMarginMs: 60,
  // Wall-clock expectations (an afplay spawn, a renderer tone) map to file
  // time only roughly, and one-sidedly: a sound can start late (afplay
  // start-up, a waking output device: 0.3 to 1.9 s was seen on a cold
  // device) but never before it was requested. File time 0 is the receipt
  // of recording.status(recording), a little after the true epoch, hence the
  // early allowance. These bounds identify "the right tone in the right
  // place"; they are never the 50 ms toggle gate.
  wallEarlyToleranceMs: 300,
  wallLateToleranceMs: 1500,
  toneDurationToleranceMs: 250,
  // A toggle proves it cut (or opened) the tone only if the tone was still
  // playing this long after (or had started this long before) it.
  cutProofMs: 1000
})

export function amplitudeToDbfs(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity
}

/** JSON-safe dBFS (reports never carry -Infinity). */
export function reportDbfs(dbfs) {
  return Number.isFinite(dbfs) ? Math.round(dbfs * 10) / 10 : -200
}

const hannCache = new Map()

function hannWindow(length) {
  let window = hannCache.get(length)
  if (!window) {
    window = new Float64Array(length)
    for (let index = 0; index < length; index += 1) {
      window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (index + 0.5)) / length)
    }
    hannCache.set(length, window)
  }
  return window
}

/**
 * Amplitude (0..1, peak) of `frequency` in samples[start, start + length) by
 * a Hann-weighted Goertzel filter. Hann keeps loud content a few hundred Hz
 * away (music) out of the 1 kHz reading; the window is symmetric, so a step
 * on/off still reads half amplitude when the window centre meets it.
 */
export function goertzelAmplitude(samples, start, length, frequency, sampleRate) {
  if (length <= 0) return 0
  const weights = hannWindow(length)
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate)
  let s1 = 0
  let s2 = 0
  let weightSum = 0
  const end = Math.min(samples.length, start + length)
  for (let index = start; index < end; index += 1) {
    const weight = weights[index - start]
    weightSum += weight
    const s0 = samples[index] * weight + coefficient * s1 - s2
    s2 = s1
    s1 = s0
  }
  if (weightSum === 0) return 0
  const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2
  return (2 * Math.sqrt(Math.max(0, power))) / weightSum
}

/**
 * Sliding 1 kHz envelope: one point per hop, timed at the window centre in
 * file time.
 * @returns {{t:number, amplitude:number, dbfs:number}[]}
 */
export function toneEnvelope(
  samples,
  {
    sampleRate = SYSTEM_AUDIO_SAMPLE_RATE,
    frequency = SYSTEM_AUDIO_TONE_HZ,
    windowMs = SYSTEM_AUDIO_GATES.windowMs,
    hopMs = SYSTEM_AUDIO_GATES.hopMs,
    timeOffsetSeconds = 0
  } = {}
) {
  const windowLength = Math.round((windowMs / 1000) * sampleRate)
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate))
  const points = []
  for (let start = 0; start + windowLength <= samples.length; start += hop) {
    const amplitude = goertzelAmplitude(samples, start, windowLength, frequency, sampleRate)
    points.push({
      t: timeOffsetSeconds + (start + windowLength / 2) / sampleRate,
      amplitude,
      dbfs: amplitudeToDbfs(amplitude)
    })
  }
  return points
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Linear interpolation of the time where the envelope crosses `level`. */
function crossingTime(before, after, level) {
  const span = after.amplitude - before.amplitude
  if (span === 0) return (before.t + after.t) / 2
  const fraction = (level - before.amplitude) / span
  return before.t + Math.min(1, Math.max(0, fraction)) * (after.t - before.t)
}

/**
 * Tone regions: runs of envelope points at or above `thresholdDbfs`, merged
 * across short gaps. Each edge is refined to the half-amplitude crossing,
 * which for a sliding rectangular window is where the window centre meets the
 * true on/off edge.
 * @returns {{start:number, end:number, durationMs:number, medianDbfs:number,
 *   minInteriorDbfs:number}[]}
 */
export function findToneRegions(
  envelope,
  {
    thresholdDbfs = SYSTEM_AUDIO_GATES.tonePresentDbfs,
    mergeGapMs = SYSTEM_AUDIO_GATES.mergeGapMs,
    minToneMs = SYSTEM_AUDIO_GATES.minToneMs,
    interiorMarginMs = SYSTEM_AUDIO_GATES.interiorMarginMs
  } = {}
) {
  const runs = []
  let current = null
  for (let index = 0; index < envelope.length; index += 1) {
    const loud = envelope[index].dbfs >= thresholdDbfs
    if (loud) {
      if (current && envelope[index].t - envelope[current.last].t <= mergeGapMs / 1000) {
        current.last = index
      } else {
        current = { first: index, last: index }
        runs.push(current)
      }
    }
  }
  const regions = []
  for (const run of runs) {
    const inside = envelope.slice(run.first, run.last + 1)
    const medianAmplitude = median(inside.map((point) => point.amplitude))
    const half = medianAmplitude / 2
    // The run's edges are where the envelope crosses the presence threshold;
    // move each to the first/last point at half the median amplitude.
    let startIndex = run.first
    while (startIndex < run.last && envelope[startIndex].amplitude < half) startIndex += 1
    while (startIndex > 0 && envelope[startIndex - 1].amplitude >= half) startIndex -= 1
    let endIndex = run.last
    while (endIndex > startIndex && envelope[endIndex].amplitude < half) endIndex -= 1
    while (endIndex < envelope.length - 1 && envelope[endIndex + 1].amplitude >= half) {
      endIndex += 1
    }
    const start =
      startIndex > 0
        ? crossingTime(envelope[startIndex - 1], envelope[startIndex], half)
        : envelope[startIndex].t
    const end =
      endIndex < envelope.length - 1
        ? crossingTime(envelope[endIndex], envelope[endIndex + 1], half)
        : envelope[endIndex].t
    const durationMs = (end - start) * 1000
    if (durationMs < minToneMs) continue
    const margin = interiorMarginMs / 1000
    const interior = inside.filter((point) => point.t >= start + margin && point.t <= end - margin)
    const minInterior = interior.length
      ? Math.min(...interior.map((point) => point.amplitude))
      : medianAmplitude
    regions.push({
      start,
      end,
      durationMs,
      medianDbfs: amplitudeToDbfs(medianAmplitude),
      minInteriorDbfs: amplitudeToDbfs(minInterior)
    })
  }
  return regions
}

/**
 * Loudest 1 kHz level in [from, to] (file seconds), skipping the excluded
 * intervals. -Infinity when nothing is in range.
 */
export function bandMaxDbfs(envelope, { from = -Infinity, to = Infinity, exclude = [] } = {}) {
  let max = -Infinity
  for (const point of envelope) {
    if (point.t < from || point.t > to) continue
    if (exclude.some(([a, b]) => point.t >= a && point.t <= b)) continue
    if (point.dbfs > max) max = point.dbfs
  }
  return max
}

/** Broadband sample peak in [fromSeconds, toSeconds] of file time. */
export function broadbandPeakDbfs(
  samples,
  {
    sampleRate = SYSTEM_AUDIO_SAMPLE_RATE,
    timeOffsetSeconds = 0,
    fromSeconds = -Infinity,
    toSeconds = Infinity
  } = {}
) {
  const first = Math.max(0, Math.floor((fromSeconds - timeOffsetSeconds) * sampleRate))
  const last = Math.min(
    samples.length,
    Number.isFinite(toSeconds)
      ? Math.ceil((toSeconds - timeOffsetSeconds) * sampleRate)
      : samples.length
  )
  let peak = 0
  for (let index = first; index < last; index += 1) {
    const value = Math.abs(samples[index])
    if (value > peak) peak = value
  }
  return amplitudeToDbfs(peak)
}

/** The backend's mix cutover log line (system_audio_session.rs). */
export function parseSystemAudioMixCutover(line) {
  const match = /System audio (joined|left) the session mix at sample (\d+)/.exec(line ?? '')
  if (!match) return null
  return { kind: match[1] === 'joined' ? 'attach' : 'detach', sample: Number(match[2]) }
}

/**
 * The backend's one-shot startup record ("Recording audio epoch established
 * from first video presentation"), or null. The dev backend colours tracing
 * field names, so ANSI escapes are stripped before the fields are read.
 */
export function parseRecordingEpochLine(line) {
  // eslint-disable-next-line no-control-regex
  const plain = String(line ?? '').replace(/\u001b\[[0-9;]*m/g, '')
  if (!plain.includes('Recording audio epoch established from first video presentation'))
    return null
  const field = (name) => {
    const match = new RegExp(`\\b${name}=(\\d+)`).exec(plain)
    return match ? Number(match[1]) : undefined
  }
  return {
    sourceAgeMs: field('source_age_ms'),
    presentationAgeMs: field('presentation_age_ms'),
    epochAgeMs: field('epoch_age_ms')
  }
}

export function cutoverFileSeconds(
  sample,
  { sampleRate = SYSTEM_AUDIO_SAMPLE_RATE, audioStartSeconds = 0, videoStartSeconds = 0 } = {}
) {
  return audioStartSeconds - videoStartSeconds + sample / sampleRate
}

/**
 * Maps a wall-clock instant (ms, same clock as `anchor.wallMs`) to file time.
 * The smoke anchors file time 0 at the receipt of `recording.status
 * (recording)`: the video epoch is fixed just before that status is
 * published, and the bus plays out 150 ms behind the wall clock, so a sound
 * made at wall time W lands near file time (W - anchor) / 1000 within the
 * tolerances above.
 */
export function wallToFileSeconds(wallMs, anchor) {
  return (anchor.fileSeconds ?? 0) + (wallMs - anchor.wallMs) / 1000
}

export function mixSourcesIncludeSystemAudio(status) {
  return (status?.audioTracks ?? []).some((track) =>
    (track?.mixSources ?? []).includes('system-audio')
  )
}

/**
 * The `recording.status` that starts the session a case drives (Record or
 * Go Live). With Clips on (plan 181) the ring's buffer-only session re-arms
 * right after every Stop and publishes its own `recording` status, marked
 * `replayOnly`; the Record that follows hands over from it and runs under a
 * new session id. A waiter that accepts the ring's status latches onto a
 * session that ends at the handover, so it never sees the mix or the terminal
 * status it then waits for.
 */
export function startedSessionStatus(status) {
  return (
    (status?.state === 'recording' || status?.state === 'streaming') &&
    typeof status?.sessionId === 'string' &&
    status.replayOnly !== true
  )
}

function describeRegions(regions) {
  if (regions.length === 0) return 'none'
  return regions
    .map(
      (region) =>
        `${region.start.toFixed(3)}-${region.end.toFixed(3)}s @ ${reportDbfs(region.medianDbfs)} dBFS`
    )
    .join(', ')
}

function checkSingleTone(regions, gates, label, failures) {
  if (regions.length !== 1) {
    failures.push(
      `${label}: expected exactly one 1 kHz tone region, found ${regions.length} (${describeRegions(regions)})`
    )
    return null
  }
  const [region] = regions
  if (region.medianDbfs < gates.tonePresentDbfs) {
    failures.push(
      `${label}: tone at ${reportDbfs(region.medianDbfs)} dBFS is under ${gates.tonePresentDbfs} dBFS`
    )
  }
  if (region.minInteriorDbfs < region.medianDbfs - gates.dropoutDb) {
    failures.push(
      `${label}: tone dropped out inside the region (min ${reportDbfs(region.minInteriorDbfs)} dBFS vs median ${reportDbfs(region.medianDbfs)} dBFS)`
    )
  }
  return region
}

function checkAligned(actual, expected, toleranceMs, what, failures) {
  const deltaMs = (actual - expected) * 1000
  if (Math.abs(deltaMs) > toleranceMs) {
    failures.push(
      `${what} at ${actual.toFixed(3)}s is ${deltaMs.toFixed(0)} ms from the expected ${expected.toFixed(3)}s (tolerance ${toleranceMs} ms)`
    )
  }
  return Math.round(deltaMs)
}

/** A wall-mapped expectation: the sound may start late, never early. */
function checkWallAligned(actual, expected, gates, what, failures) {
  const deltaMs = (actual - expected) * 1000
  if (deltaMs < -gates.wallEarlyToleranceMs || deltaMs > gates.wallLateToleranceMs) {
    failures.push(
      `${what} at ${actual.toFixed(3)}s is ${deltaMs.toFixed(0)} ms from the requested ${expected.toFixed(3)}s (allowed -${gates.wallEarlyToleranceMs} to +${gates.wallLateToleranceMs} ms)`
    )
  }
  return Math.round(deltaMs)
}

function checkBandSilent(envelope, range, gates, what, failures) {
  const level = bandMaxDbfs(envelope, range)
  if (level >= gates.bandSilenceDbfs) {
    failures.push(
      `${what}: 1 kHz band reached ${reportDbfs(level)} dBFS (must stay under ${gates.bandSilenceDbfs} dBFS)`
    )
  }
  return reportDbfs(level)
}

function verdict(failures, evidence) {
  return { pass: failures.length === 0, failures, evidence }
}

/** Plan 201 S0: the idle Clips bus, measured on the renderer's audio.levels wire. */
export const CLIPS_IDLE_LEVEL_GATES = Object.freeze({
  settleMs: 500,
  minReadings: 3,
  tonePresentDbfs: -50,
  expectedDropDb: 12,
  dropToleranceDb: 2,
  floorDbfs: -120
})

/**
 * Receive times are monotonic milliseconds, as recorded by the smoke. Ignore
 * the capture/playout and gain-update edges; compare the median window peaks
 * of the steady tone, then require continued readings at the wire floor.
 * Keep all payloads in failure evidence so a STOP reports what the ring sent.
 */
export function evaluateClipsIdleCase(
  { levels, sessionId, toneStartAt, gainChangedAt, toneEndAt },
  gates = CLIPS_IDLE_LEVEL_GATES
) {
  const failures = []
  if (!sessionId || levels.some(({ payload }) => payload?.sessionId !== sessionId)) {
    failures.push('clips-idle: every audio.levels event must carry the ring session id')
  }
  const readings = levels.filter(({ payload }) => Number.isFinite(payload?.systemAudio?.peakDb))
  const window = (from, to) =>
    readings
      .filter(({ at }) => at >= from && at < to)
      .map(({ payload }) => payload.systemAudio.peakDb)
  const before = window(toneStartAt + gates.settleMs, gainChangedAt)
  const after = window(gainChangedAt + gates.settleMs, toneEndAt)
  const floor = window(toneEndAt + gates.settleMs, Infinity)
  for (const [name, samples] of [
    ['before gain', before],
    ['after gain', after],
    ['after tone', floor]
  ]) {
    if (samples.length < gates.minReadings) {
      failures.push(`clips-idle: only ${samples.length} systemAudio readings ${name}`)
    }
  }
  const beforeDbfs = median(before)
  const afterDbfs = median(after)
  const dropDb = beforeDbfs === null || afterDbfs === null ? null : beforeDbfs - afterDbfs
  if (
    beforeDbfs === null ||
    afterDbfs === null ||
    beforeDbfs < gates.tonePresentDbfs ||
    afterDbfs < gates.tonePresentDbfs
  ) {
    failures.push('clips-idle: no systemAudio tone readings before and after the gain change')
  }
  if (dropDb === null || Math.abs(dropDb - gates.expectedDropDb) > gates.dropToleranceDb) {
    failures.push(
      `clips-idle: gain dropped the peak by ${dropDb ?? 'unmeasured'} dB, expected ${gates.expectedDropDb} +/- ${gates.dropToleranceDb} dB`
    )
  }
  const floorPeakDbfs = floor.length ? Math.max(...floor) : null
  if (floorPeakDbfs === null || floorPeakDbfs > gates.floorDbfs) {
    failures.push(
      `clips-idle: readings did not return to the ${gates.floorDbfs} dBFS floor after the tone`
    )
  }
  return verdict(failures, {
    sessionId,
    levelEventCount: levels.length,
    systemAudioReadingCount: readings.length,
    beforeCount: before.length,
    afterCount: after.length,
    floorCount: floor.length,
    beforeDbfs,
    afterDbfs,
    dropDb,
    floorPeakDbfs,
    ...(failures.length ? { levels } : {})
  })
}

/**
 * Case a: System audio On, a tone played in the computer. The tone is in the
 * file, loud and continuous, in the right place, and the band is silent
 * everywhere else.
 */
export function evaluateToneCapturedCase(
  { envelope, regions, expectedPlay },
  gates = SYSTEM_AUDIO_GATES
) {
  const failures = []
  const region = checkSingleTone(regions, gates, 'system audio on', failures)
  const evidence = { regions: regions.map(reportRegion) }
  if (region) {
    evidence.startDeltaMs = checkWallAligned(
      region.start,
      expectedPlay.start,
      gates,
      'tone start',
      failures
    )
    const expectedMs = (expectedPlay.end - expectedPlay.start) * 1000
    if (Math.abs(region.durationMs - expectedMs) > gates.toneDurationToleranceMs) {
      failures.push(
        `system audio on: tone lasted ${region.durationMs.toFixed(0)} ms, expected ${expectedMs.toFixed(0)} ms`
      )
    }
    const margin = gates.silenceMarginMs / 1000
    evidence.bandOutsideDbfs = checkBandSilent(
      envelope,
      { exclude: [[region.start - margin, region.end + margin]] },
      gates,
      'system audio on, outside the tone',
      failures
    )
  }
  return verdict(failures, evidence)
}

/** Mixed-input acceptance allows speech outside the known, stronger test tone. */
export function evaluateMixedToneCapturedCase(
  { envelope, expectedPlay },
  gates = SYSTEM_AUDIO_GATES
) {
  const regions = findToneRegions(envelope, {
    thresholdDbfs: -24,
    mergeGapMs: gates.mergeGapMs,
    minToneMs: gates.minToneMs,
    interiorMarginMs: gates.interiorMarginMs
  })
  const failures = []
  const region = checkSingleTone(regions, gates, 'mixed-input test tone', failures)
  const evidence = { regions: regions.map(reportRegion) }
  if (region) {
    evidence.startDeltaMs = checkWallAligned(
      region.start,
      expectedPlay.start,
      gates,
      'mixed tone start',
      failures
    )
    if (
      Math.abs(region.durationMs - (expectedPlay.end - expectedPlay.start) * 1000) >
      gates.toneDurationToleranceMs
    ) {
      failures.push('mixed-input test tone duration or continuity is incorrect')
    }
  }
  return verdict(failures, evidence)
}

/**
 * Plan 070: a static screen keeps its old content time (honest freshness), but
 * the recording epoch comes from the current composition (half a tick before
 * it), so no audio lands ahead of the cap or late in the file.
 */
export function evaluateStaticScreenEpoch({
  sourceAgeMs,
  presentationAgeMs,
  epochAgeMs,
  aheadCapDrops
}) {
  const failures = []
  if (!(sourceAgeMs >= 9000))
    failures.push('first recorded frame did not retain the held static content')
  if (!(presentationAgeMs >= 0 && presentationAgeMs < 250))
    failures.push('first recorded frame is not a current compositor presentation')
  if (!(epochAgeMs >= 0 && epochAgeMs < 100))
    failures.push('recording epoch follows the held content age, not the presentation')
  if (aheadCapDrops !== 0) failures.push('audio samples were rejected ahead of the timeline cap')
  return verdict(failures, { sourceAgeMs, presentationAgeMs, epochAgeMs, aheadCapDrops })
}

/**
 * Case b: System audio turned Off while the tone plays. The tone stops at the
 * bus cutover (within the toggle tolerance plus the ramp), well before the
 * player finished, and nothing at 1 kHz follows.
 */
export function evaluateToggleOffCase(
  { envelope, regions, expectedPlay, cutoverSeconds },
  gates = SYSTEM_AUDIO_GATES
) {
  const failures = []
  const region = checkSingleTone(regions, gates, 'toggle off', failures)
  const evidence = { regions: regions.map(reportRegion), cutoverSeconds }
  if (!Number.isFinite(cutoverSeconds)) {
    failures.push('toggle off: no confirmed system-audio detach cutover was observed')
  }
  if (region && Number.isFinite(cutoverSeconds)) {
    evidence.startDeltaMs = checkWallAligned(
      region.start,
      expectedPlay.start,
      gates,
      'tone start',
      failures
    )
    evidence.stopDeltaMs = checkAligned(
      region.end,
      cutoverSeconds,
      gates.toggleToleranceMs + gates.rampMs,
      'tone stop',
      failures
    )
    if (region.end > expectedPlay.end - gates.cutProofMs / 1000) {
      failures.push(
        `toggle off: the tone ran to ${region.end.toFixed(3)}s, so the player ending (${expectedPlay.end.toFixed(3)}s) and not the switch may have stopped it`
      )
    }
    evidence.bandAfterDbfs = checkBandSilent(
      envelope,
      { from: region.end + gates.silenceMarginMs / 1000 },
      gates,
      'toggle off, after the cutover',
      failures
    )
  }
  return verdict(failures, evidence)
}

/**
 * Mid-session On: the tone was already playing when System audio was turned
 * on. It enters the file at the attach cutover, never before it, and no later
 * than the bus playout delay (+ tolerance) after it: the capture can only
 * contribute from its own first sample, which the bus cursor meets up to one
 * playout delay after the slot joined.
 */
export function evaluateToggleOnCase(
  { envelope, regions, expectedPlay, cutoverSeconds },
  gates = SYSTEM_AUDIO_GATES
) {
  const failures = []
  const region = checkSingleTone(regions, gates, 'toggle on', failures)
  const evidence = { regions: regions.map(reportRegion), cutoverSeconds }
  if (!Number.isFinite(cutoverSeconds)) {
    failures.push('toggle on: no confirmed system-audio attach cutover was observed')
  }
  if (region && Number.isFinite(cutoverSeconds)) {
    const deltaMs = (region.start - cutoverSeconds) * 1000
    evidence.startDeltaMs = Math.round(deltaMs)
    if (deltaMs < -gates.rampMs) {
      failures.push(
        `toggle on: the tone entered at ${region.start.toFixed(3)}s, ${(-deltaMs).toFixed(0)} ms BEFORE the attach cutover (${cutoverSeconds.toFixed(3)}s)`
      )
    } else if (deltaMs > gates.playoutDelayMs + gates.toggleToleranceMs) {
      failures.push(
        `toggle on: the tone entered ${deltaMs.toFixed(0)} ms after the attach cutover (allowed ${gates.playoutDelayMs} ms playout + ${gates.toggleToleranceMs} ms)`
      )
    }
    if (region.start < expectedPlay.start + gates.cutProofMs / 1000) {
      failures.push(
        `toggle on: the tone entered at ${region.start.toFixed(3)}s, too close to the player start (${expectedPlay.start.toFixed(3)}s) to prove the switch opened it`
      )
    }
    evidence.endDeltaMs = checkWallAligned(
      region.end,
      expectedPlay.end,
      gates,
      'tone end',
      failures
    )
    evidence.bandBeforeDbfs = checkBandSilent(
      envelope,
      { to: region.start - gates.silenceMarginMs / 1000 },
      gates,
      'toggle on, before the attach',
      failures
    )
  }
  return verdict(failures, evidence)
}

/**
 * Case c, the privacy gate: System audio Off for the whole session. No tone,
 * no system source in the mix at any point, and (no microphone either) the
 * track is digital silence.
 */
export function evaluateSystemAudioOffCase(
  { envelope, regions, broadbandPeak, mixedStatusCount },
  gates = SYSTEM_AUDIO_GATES
) {
  const failures = []
  if (regions.length > 0) {
    failures.push(`system audio off: a 1 kHz tone reached the file (${describeRegions(regions)})`)
  }
  const bandDbfs = checkBandSilent(envelope, {}, gates, 'system audio off', failures)
  if (broadbandPeak > gates.digitalSilenceDbfs) {
    failures.push(
      `system audio off: the track peaks at ${reportDbfs(broadbandPeak)} dBFS; with no microphone and no system source it must be digital silence (under ${gates.digitalSilenceDbfs} dBFS)`
    )
  }
  if (mixedStatusCount > 0) {
    failures.push(
      `system audio off: ${mixedStatusCount} recording.status event(s) listed system-audio in the mix`
    )
  }
  return verdict(failures, {
    regions: regions.map(reportRegion),
    bandMaxDbfs: bandDbfs,
    broadbandPeakDbfs: reportDbfs(broadbandPeak),
    mixedStatusCount
  })
}

/**
 * Case d, self-exclusion: a tone Videorc's own renderer played is absent,
 * while a control tone from another app in the same session is present (so
 * the absence is not a dead capture).
 */
export function evaluateSelfExclusionCase(
  { envelope, regions, rendererPlay, controlPlay, renderer },
  gates = SYSTEM_AUDIO_GATES
) {
  const failures = []
  if (renderer?.contextState !== 'running' || !(renderer?.analyserPeak >= 0.1)) {
    failures.push(
      `self-exclusion: the renderer tone did not demonstrably play (${JSON.stringify(renderer ?? null)}); its absence would prove nothing`
    )
  }
  const rendererBandDbfs = checkBandSilent(
    envelope,
    {
      from: rendererPlay.start - gates.wallEarlyToleranceMs / 1000,
      to: rendererPlay.end + gates.wallLateToleranceMs / 1000
    },
    gates,
    "self-exclusion, Videorc's own tone",
    failures
  )
  const control = checkSingleTone(regions, gates, 'self-exclusion control', failures)
  const evidence = { regions: regions.map(reportRegion), rendererBandDbfs, renderer }
  if (control) {
    evidence.controlStartDeltaMs = checkWallAligned(
      control.start,
      controlPlay.start,
      gates,
      'control tone start',
      failures
    )
  }
  return verdict(failures, evidence)
}

/** Case e: record + stream. The tone is in the file and in the stream. */
export function evaluateRecordAndStreamCase(
  { file, stream, expectedPlay },
  gates = SYSTEM_AUDIO_GATES
) {
  const failures = []
  const fileRegion = checkSingleTone(file.regions, gates, 'record+stream file', failures)
  const streamRegion = checkSingleTone(stream.regions, gates, 'record+stream stream', failures)
  const expectedMs = (expectedPlay.end - expectedPlay.start) * 1000
  for (const [label, region] of [
    ['file', fileRegion],
    ['stream', streamRegion]
  ]) {
    if (region && Math.abs(region.durationMs - expectedMs) > gates.toneDurationToleranceMs) {
      failures.push(
        `record+stream ${label}: tone lasted ${region.durationMs.toFixed(0)} ms, expected ${expectedMs.toFixed(0)} ms`
      )
    }
  }
  if (fileRegion) {
    checkWallAligned(fileRegion.start, expectedPlay.start, gates, 'file tone start', failures)
  }
  return verdict(failures, {
    fileRegions: file.regions.map(reportRegion),
    streamRegions: stream.regions.map(reportRegion)
  })
}

function reportRegion(region) {
  return {
    start: Math.round(region.start * 1000) / 1000,
    end: Math.round(region.end * 1000) / 1000,
    durationMs: Math.round(region.durationMs),
    medianDbfs: reportDbfs(region.medianDbfs),
    minInteriorDbfs: reportDbfs(region.minInteriorDbfs)
  }
}

// ---------------------------------------------------------------------------
// o_sys end to end (measure:av-sync --system-audio)
// ---------------------------------------------------------------------------

export const SYSTEM_AUDIO_SYNC_TOLERANCE_MS = 25
/** Consistently this far off means the constant is wrong: report, don't edit. */
export const SYSTEM_AUDIO_SYNC_STOP_MS = 15
export const SYSTEM_AUDIO_SYNC_MIN_PAIRS = 5

/** Reads `SYSTEM_AUDIO_SYNC_OFFSET_MS` from system_audio_session.rs. */
export function parseSystemAudioSyncOffsetMs(rustSource) {
  const match = /const SYSTEM_AUDIO_SYNC_OFFSET_MS:\s*i32\s*=\s*(-?\d+)\s*;/.exec(rustSource ?? '')
  if (!match) throw new Error('SYSTEM_AUDIO_SYNC_OFFSET_MS was not found in the backend source.')
  return Number(match[1])
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

function describeOffset(offsetMs) {
  return `${Math.abs(offsetMs).toFixed(1)} ms ${offsetMs > 0 ? 'behind' : 'ahead of'} the screen`
}

/**
 * One end-to-end o_sys run. The recording already carries `o_sys`, so the
 * flash/click offset (positive = system audio later than the screen) is the
 * residual error.
 *
 * A single run can only resolve the flash to a video frame: the screen
 * capture and the compositor each sample the display once per frame, at a
 * phase that is fixed for a session (the stimulus period is a whole number of
 * frames) and random between sessions. Pair offsets within a run therefore
 * sit on levels one frame apart, and a run's median can sit up to a frame
 * from the true offset. A run fails only beyond the tolerance plus one frame;
 * the o_sys gate itself is the pooled mean over runs
 * ({@link summarizeSystemAudioSyncRuns}).
 */
export function evaluateSystemAudioSyncRun(
  { offsetsMs = [], medianOffsetMs },
  {
    systemAudioSyncOffsetMs,
    frameMs,
    toleranceMs = SYSTEM_AUDIO_SYNC_TOLERANCE_MS,
    minPairs = SYSTEM_AUDIO_SYNC_MIN_PAIRS
  }
) {
  const failures = []
  if (!Number.isFinite(medianOffsetMs) || offsetsMs.length < minPairs) {
    failures.push(
      `only ${offsetsMs.length} flash/click pair(s) (need ${minPairs}); the screen did not show the stimulus or system audio did not carry its clicks`
    )
    return { pass: false, failures, residualMs: null, meanMs: null, offsetsMs }
  }
  const runBoundMs = toleranceMs + frameMs
  if (Math.abs(medianOffsetMs) > runBoundMs) {
    failures.push(
      `system audio is ${describeOffset(medianOffsetMs)} in this run, beyond ${toleranceMs} ms + one ${frameMs.toFixed(1)} ms frame; SYSTEM_AUDIO_SYNC_OFFSET_MS (${systemAudioSyncOffsetMs}) or the pipeline is off`
    )
  }
  return {
    pass: failures.length === 0,
    failures,
    residualMs: round1(medianOffsetMs),
    meanMs: round1(mean(offsetsMs)),
    offsetsMs
  }
}

/**
 * The o_sys verdict: the mean of every flash/click pair over all runs
 * averages out the per-session frame phase. It must sit within the tolerance
 * of zero (the constant is already applied), every run must pass, and a mean
 * beyond the STOP bound with every run on the same side is reported for the
 * owner, never fixed here.
 */
export function summarizeSystemAudioSyncRuns(
  runs,
  {
    systemAudioSyncOffsetMs = 0,
    toleranceMs = SYSTEM_AUDIO_SYNC_TOLERANCE_MS,
    stopMs = SYSTEM_AUDIO_SYNC_STOP_MS
  } = {}
) {
  const residuals = runs.map((run) => run.residualMs).filter(Number.isFinite)
  const pooled = runs.flatMap((run) => run.offsetsMs ?? [])
  const pooledMeanMs = round1(mean(pooled))
  const failures = []
  if (runs.length === 0 || runs.some((run) => !run.pass)) {
    failures.push('not every run passed')
  }
  if (pooledMeanMs === null) {
    failures.push('no flash/click pairs at all')
  } else if (Math.abs(pooledMeanMs) > toleranceMs) {
    failures.push(
      `system audio is ${describeOffset(pooledMeanMs)} over ${runs.length} run(s); SYSTEM_AUDIO_SYNC_OFFSET_MS (${systemAudioSyncOffsetMs}) is off by more than ${toleranceMs} ms`
    )
  }
  const sameSide =
    pooledMeanMs !== null &&
    residuals.length === runs.length &&
    residuals.every((residual) => Math.sign(residual) === Math.sign(pooledMeanMs))
  const stop = pooledMeanMs !== null && Math.abs(pooledMeanMs) > stopMs && sameSide
  return {
    pass: failures.length === 0,
    failures,
    runs: runs.length,
    pairs: pooled.length,
    residualsMs: residuals,
    pooledMeanMs,
    impliedOffsetMs:
      pooledMeanMs === null ? null : Math.round(systemAudioSyncOffsetMs - pooledMeanMs),
    spreadMs: residuals.length ? round1(Math.max(...residuals) - Math.min(...residuals)) : null,
    stop,
    stopReason: stop
      ? `system audio is consistently ${describeOffset(pooledMeanMs)} (more than ${stopMs} ms); report to the owner, do not edit the constant here`
      : null
  }
}

// ---------------------------------------------------------------------------
// Runners (ffprobe/ffmpeg)
// ---------------------------------------------------------------------------

function runBinary(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectRun)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun(Buffer.concat(stdout))
        return
      }
      rejectRun(
        new Error(`${command} failed: code=${code} signal=${signal} ${stderr.join('').trim()}`)
      )
    })
  })
}

/** ffprobe the first video and audio streams of a finished artifact. */
export async function probeSystemAudioArtifact(filePath, { ffprobePath = 'ffprobe' } = {}) {
  const output = await runBinary(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'stream=index,codec_type,codec_name,sample_rate,channels,start_time,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    filePath
  ])
  const payload = JSON.parse(output.toString('utf8'))
  const streams = payload.streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video') ?? null
  const audio = streams.find((stream) => stream.codec_type === 'audio') ?? null
  const number = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return {
    video: video ? { codec: video.codec_name, startSeconds: number(video.start_time) } : null,
    audio: audio
      ? {
          codec: audio.codec_name,
          sampleRate: number(audio.sample_rate),
          channels: number(audio.channels),
          startSeconds: number(audio.start_time)
        }
      : null,
    durationSeconds: number(payload.format?.duration)
  }
}

/** Decode the first audio stream to mono f32 at 48 kHz. */
export async function decodeMonoF32(
  filePath,
  { ffmpegPath = 'ffmpeg', sampleRate = SYSTEM_AUDIO_SAMPLE_RATE } = {}
) {
  const pcm = await runBinary(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-f',
    'f32le',
    'pipe:1'
  ])
  const samples = new Float32Array(Math.floor(pcm.length / 4))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readFloatLE(index * 4)
  }
  return samples
}

/**
 * Probe + decode + 1 kHz envelope + tone regions for one artifact, in file
 * time (seconds from the first video frame).
 */
export async function analyzeSystemAudioArtifact(
  filePath,
  { ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', gates = SYSTEM_AUDIO_GATES } = {}
) {
  const probe = await probeSystemAudioArtifact(filePath, { ffprobePath })
  if (!probe.video) throw new Error(`${filePath} has no video stream`)
  if (!probe.audio) throw new Error(`${filePath} has no audio stream`)
  const samples = await decodeMonoF32(filePath, { ffmpegPath })
  const timeOffsetSeconds = probe.audio.startSeconds - probe.video.startSeconds
  const envelope = toneEnvelope(samples, {
    timeOffsetSeconds,
    windowMs: gates.windowMs,
    hopMs: gates.hopMs
  })
  const regions = findToneRegions(envelope, {
    thresholdDbfs: gates.tonePresentDbfs,
    mergeGapMs: gates.mergeGapMs,
    minToneMs: gates.minToneMs,
    interiorMarginMs: gates.interiorMarginMs
  })
  return {
    probe,
    samples,
    timeOffsetSeconds,
    envelope,
    regions,
    audioSeconds: samples.length / SYSTEM_AUDIO_SAMPLE_RATE,
    broadbandPeak: broadbandPeakDbfs(samples, { timeOffsetSeconds })
  }
}

/**
 * FFmpeg args for the stimulus tone: a stereo s16 WAV at 48 kHz with a peak of
 * `amplitude` (0.5 = -6 dBFS). `afplay` plays it about 3 dB lower (S0) and the
 * System audio slot's default -6 dB gain applies, so it lands near -15 dBFS.
 * (lavfi `sine` is fixed at 1/8 amplitude, too quiet after both.)
 */
export function toneWavArgs(outputPath, { seconds, amplitude = 0.5 } = {}) {
  return [
    '-y',
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=${amplitude}*sin(${SYSTEM_AUDIO_TONE_HZ}*2*PI*t):s=${SYSTEM_AUDIO_SAMPLE_RATE}:d=${seconds}`,
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    outputPath
  ]
}
