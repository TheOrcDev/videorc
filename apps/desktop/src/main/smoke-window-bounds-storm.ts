export interface TimedBoundsStormOptions<T> {
  updates: readonly T[]
  cadenceMs: number
  nowMs?: () => number
  wait: (delayMs: number) => Promise<void>
  apply: (value: T, index: number) => void | Promise<void>
}

export interface TimedBoundsStormResult {
  applied: number
  elapsedMs: number
  maxStartLagMs: number
}

/** Runs a smoke-only window movement sequence inside Electron's main process. */
export async function runTimedBoundsStorm<T>(
  options: TimedBoundsStormOptions<T>
): Promise<TimedBoundsStormResult> {
  const nowMs = options.nowMs ?? (() => performance.now())
  const cadenceMs = Math.max(0, options.cadenceMs)
  const startedAtMs = nowMs()
  let maxStartLagMs = 0

  for (const [index, update] of options.updates.entries()) {
    const scheduledAtMs = startedAtMs + index * cadenceMs
    const delayMs = Math.max(0, scheduledAtMs - nowMs())
    if (delayMs > 0) {
      await options.wait(delayMs)
    }
    maxStartLagMs = Math.max(maxStartLagMs, Math.max(0, nowMs() - scheduledAtMs))
    await options.apply(update, index)
  }

  return {
    applied: options.updates.length,
    elapsedMs: Math.max(0, nowMs() - startedAtMs),
    maxStartLagMs
  }
}
