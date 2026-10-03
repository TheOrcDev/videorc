export interface TimedBoundsStormOptions<T> {
  updates: readonly T[]
  cadenceMs: number
  nowMs?: () => number
  wallNowMs?: () => number
  wait: (delayMs: number) => Promise<void>
  apply: (value: T, index: number) => void | Promise<void>
}

export interface TimedBoundsStormResult {
  applied: number
  elapsedMs: number
  maxStartLagMs: number
  timing: {
    monotonicStartedAtMs: number
    wallClockStartedAtMs: number
    entries: Array<{
      index: number
      scheduledAtMs: number
      appliedAtMs: number
      completedAtMs: number
    }>
    limit: number
    omitted: number
  }
}

const TIMING_LIMIT = 1_000

/** Runs a smoke-only window movement sequence inside Electron's main process. */
export async function runTimedBoundsStorm<T>(
  options: TimedBoundsStormOptions<T>
): Promise<TimedBoundsStormResult> {
  const nowMs = options.nowMs ?? (() => performance.now())
  const cadenceMs = Math.max(0, options.cadenceMs)
  const startedAtMs = nowMs()
  const wallClockStartedAtMs = (options.wallNowMs ?? Date.now)()
  const entries: TimedBoundsStormResult['timing']['entries'] = []
  let maxStartLagMs = 0

  for (const [index, update] of options.updates.entries()) {
    const scheduledAtMs = startedAtMs + index * cadenceMs
    const delayMs = Math.max(0, scheduledAtMs - nowMs())
    if (delayMs > 0) {
      await options.wait(delayMs)
    }
    const appliedAtMs = nowMs()
    maxStartLagMs = Math.max(maxStartLagMs, Math.max(0, appliedAtMs - scheduledAtMs))
    await options.apply(update, index)
    entries.push({ index, scheduledAtMs, appliedAtMs, completedAtMs: nowMs() })
    if (entries.length > TIMING_LIMIT) entries.shift()
  }

  return {
    applied: options.updates.length,
    elapsedMs: Math.max(0, nowMs() - startedAtMs),
    maxStartLagMs,
    timing: {
      monotonicStartedAtMs: startedAtMs,
      wallClockStartedAtMs,
      entries,
      limit: TIMING_LIMIT,
      omitted: Math.max(0, options.updates.length - entries.length)
    }
  }
}

/** The action boundary precedes any smoke wait or presentation verification. */
export function timeSmokeAction<T>(
  action: () => T,
  nowMs: () => number = () => performance.now(),
  wallNowMs: () => number = Date.now
): {
  value: T
  timing: { appliedAtMs: number; completedAtMs: number; wallClockAppliedAtMs: number }
} {
  const appliedAtMs = nowMs()
  const wallClockAppliedAtMs = wallNowMs()
  const value = action()
  return { value, timing: { appliedAtMs, completedAtMs: nowMs(), wallClockAppliedAtMs } }
}
