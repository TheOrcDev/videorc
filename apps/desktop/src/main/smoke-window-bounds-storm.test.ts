import { describe, expect, it } from 'vitest'

import { runTimedBoundsStorm } from './smoke-window-bounds-storm'

describe('runTimedBoundsStorm', () => {
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
    expect(result).toEqual({ applied: 3, elapsedMs: 35, maxStartLagMs: 0 })
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
})
