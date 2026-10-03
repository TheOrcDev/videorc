import { describe, expect, it } from 'vitest'

import { runTimedBoundsStorm, timeSmokeAction } from './smoke-window-bounds-storm'

describe('runTimedBoundsStorm', () => {
  it('retains actual scheduled, applied and completed input times', async () => {
    let nowMs = 1_000
    const result = await runTimedBoundsStorm({
      updates: [10, 20, 30],
      cadenceMs: 4,
      nowMs: () => nowMs,
      wait: async (delayMs) => {
        nowMs += delayMs
      },
      apply: () => {
        nowMs += 10
      }
    })
    expect(result).toMatchObject({
      timing: {
        monotonicStartedAtMs: 1_000,
        entries: [
          { index: 0, scheduledAtMs: 1_000, appliedAtMs: 1_000, completedAtMs: 1_010 },
          { index: 1, scheduledAtMs: 1_004, appliedAtMs: 1_010, completedAtMs: 1_020 },
          { index: 2, scheduledAtMs: 1_008, appliedAtMs: 1_020, completedAtMs: 1_030 }
        ],
        omitted: 0
      }
    })
  })

  it('applies bounds on one absolute cadence without accumulating apply time', async () => {
    let nowMs = 1_000
    const applied: Array<{ value: number; at: number }> = []

    const result = await runTimedBoundsStorm({
      updates: [10, 20, 30],
      cadenceMs: 16,
      nowMs: () => nowMs,
      wait: async (delayMs) => {
        nowMs += delayMs
      },
      apply: (value) => {
        applied.push({ value, at: nowMs })
        nowMs += 3
      }
    })

    expect(applied).toEqual([
      { value: 10, at: 1_000 },
      { value: 20, at: 1_016 },
      { value: 30, at: 1_032 }
    ])
    expect(result).toMatchObject({ applied: 3, elapsedMs: 35, maxStartLagMs: 0 })
  })

  it('reports event-loop lag while preserving update order', async () => {
    let nowMs = 0
    const applied: number[] = []

    const result = await runTimedBoundsStorm({
      updates: [1, 2, 3],
      cadenceMs: 4,
      nowMs: () => nowMs,
      wait: async (delayMs) => {
        nowMs += delayMs
      },
      apply: (value) => {
        applied.push(value)
        nowMs += 10
      }
    })

    expect(applied).toEqual([1, 2, 3])
    expect(result.maxStartLagMs).toBe(12)
  })

  it('bounds evidence without shrinking the applied workload', async () => {
    let nowMs = 0
    let applied = 0
    const result = await runTimedBoundsStorm({
      updates: Array.from({ length: 1_002 }, (_, index) => index),
      cadenceMs: 0,
      nowMs: () => nowMs,
      wallNowMs: () => 10_000,
      wait: async () => undefined,
      apply: () => {
        applied += 1
        nowMs += 1
      }
    })
    expect(applied).toBe(1_002)
    expect(result.timing.entries).toHaveLength(1_000)
    expect(result.timing.entries[0].index).toBe(2)
    expect(result.timing.entries.at(-1)?.index).toBe(1_001)
    expect(result.timing.omitted).toBe(2)
    expect(result.timing.wallClockStartedAtMs).toBe(10_000)
  })

  it('timestamps an action before its later verification wait', () => {
    let nowMs = 100
    const action = timeSmokeAction(
      () => {
        nowMs += 3
        return true
      },
      () => nowMs,
      () => 10_000
    )
    nowMs += 80
    expect(action).toEqual({
      value: true,
      timing: { appliedAtMs: 100, completedAtMs: 103, wallClockAppliedAtMs: 10_000 }
    })
  })
})
