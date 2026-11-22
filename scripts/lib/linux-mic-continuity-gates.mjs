// Pure gates for the Linux microphone-continuity smoke (plan 257 S1): a take
// recorded while a continuous tone plays into the microphone must carry the
// tone for every second of it, and Stop must end FFmpeg without TERM or KILL.
// Kept off the box so `pnpm test:scripts` covers the contract.

/**
 * FFmpeg args that print one RMS level per window of the first audio stream
 * (`lavfi.astats.Overall.RMS_level`, "-inf" for digital silence). The
 * default window is 100 ms: a whole second averages a half-second hole with
 * the tone around it and passes, a 100 ms window does not.
 */
export function windowRmsArgs(path, windowFrames = 4800) {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-af',
    `asetnsamples=n=${windowFrames}:p=0,astats=metadata=1:reset=1,` +
      'ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f',
    'null',
    '-'
  ]
}

/** Parses `ametadata=mode=print` output into `[{ time, rmsDb }]`. */
export function parseWindowRms(text) {
  const windows = []
  let pending = null
  for (const line of String(text ?? '').split('\n')) {
    const frame = /pts_time:\s*([0-9.]+)/.exec(line)
    if (frame) {
      pending = Number(frame[1])
      continue
    }
    const level = /lavfi\.astats\.Overall\.RMS_level=(\S+)/.exec(line)
    if (level && pending != null) {
      const raw = level[1]
      const rmsDb = /^-?inf$/i.test(raw) ? -Infinity : Number(raw)
      windows.push({ time: pending, rmsDb })
      pending = null
    }
  }
  return windows
}

// The lab tone reads about -21 dB RMS through videorc_lab_mic; a real room
// mic with a speaker playing it is far quieter, but never below this. The
// session's zero-PCM filler is -inf.
export const TONE_FLOOR_DB = -60

/**
 * Every window that lies wholly inside the tone (file seconds, 0 = first
 * audio sample, `marginSeconds` trimmed from both ends) must carry it.
 * `silentSeconds` names the whole seconds that hold a silent window, and
 * `silentMs` how much of the window was silent.
 */
export function assessToneContinuity(
  windows,
  {
    toneStartSeconds,
    toneEndSeconds,
    windowSeconds = 0.1,
    floorDb = TONE_FLOOR_DB,
    marginSeconds = 0.5
  }
) {
  const failures = []
  const from = toneStartSeconds + marginSeconds
  const to = toneEndSeconds - marginSeconds
  const epsilon = 1e-6
  const inside = (windows ?? []).filter(
    (entry) => entry.time >= from - epsilon && entry.time + windowSeconds <= to + epsilon
  )
  const silent = inside.filter((entry) => !(entry.rmsDb >= floorDb))
  const expected = Math.max(0, Math.floor((to - from) / windowSeconds + epsilon))
  if (to <= from) failures.push(`the tone window ${from}-${to}s is empty`)
  const silentSeconds = [...new Set(silent.map((entry) => Math.floor(entry.time + epsilon)))]
  const silentMs = Math.round(silent.length * windowSeconds * 1000)
  if (silent.length > 0) {
    failures.push(
      `${silentMs} ms under ${floorDb} dB while the tone played ` +
        `(first at ${silent[0].time.toFixed(1)}s; seconds ${silentSeconds.join(',')})`
    )
  }
  if (to > from && inside.length < expected - 1) {
    const last = inside.at(-1)?.time ?? from
    failures.push(
      `the audio ends before the tone does: ${inside.length} of ${expected} windows, ` +
        `last at ${last.toFixed(1)}s`
    )
  }
  const levels = inside.map((entry) => entry.rmsDb)
  return {
    ok: failures.length === 0,
    failures,
    window: { fromSeconds: from, toSeconds: to },
    silentSeconds,
    silentMs,
    minRmsDb: levels.length > 0 ? Math.min(...levels) : null
  }
}

// Health codes that mean Stop did not end FFmpeg on its own: a TERM, a KILL,
// or a forced stop whose file was kept as recovery media.
export const FORCED_STOP_CODES = Object.freeze([
  'recording-stop-escalated',
  'recording-stop-forced',
  'recording-stop-finalize-overrun'
])

/**
 * Stop must end FFmpeg cleanly: no forced-stop health code, a published file,
 * and (when the caller measured it) a Stop that reached idle inside the
 * budget.
 */
export function assessCleanStop({ healthCodes, stopMs, outputPath, stopBudgetMs = 15000 }) {
  const failures = []
  const forced = (healthCodes ?? []).filter((code) => FORCED_STOP_CODES.includes(code))
  if (forced.length > 0) failures.push(`Stop was forced: ${[...new Set(forced)].join(', ')}`)
  if (!outputPath) failures.push('no published recording')
  if (Number.isFinite(stopMs) && stopMs > stopBudgetMs) {
    failures.push(`Stop took ${Math.round(stopMs)} ms (budget ${stopBudgetMs} ms)`)
  }
  return { ok: failures.length === 0, failures, forced }
}

/** Load average and core count, so a timing claim names the box it ran on. */
export function describeHostLoad(loadavg, cpuCount) {
  const [one, five, fifteen] = (loadavg ?? []).map((value) => Math.round(value * 100) / 100)
  return { load1: one, load5: five, load15: fifteen, cpus: cpuCount }
}
