import { describe, expect, it } from 'vitest'

import { formatSlowestPhase, formatWebSocketQueue } from './diagnostics-tab'

describe('Diagnostics WebSocket queue copy', () => {
  it('shows bounded depth, oldest age, coalescing, and dropped work together', () => {
    expect(
      formatWebSocketQueue({
        currentDepth: 3,
        maxDepth: 8,
        oldestAgeMs: 42,
        coalescedCount: 11,
        evictedOrDroppedCount: 2
      })
    ).toBe('3/8 current/max · 42 ms oldest · 11 coalesced · 2 evicted/dropped')
  })

  it('keeps an empty queue explicit without inventing an oldest age', () => {
    expect(
      formatWebSocketQueue({
        currentDepth: 0,
        maxDepth: 4,
        coalescedCount: 0,
        evictedOrDroppedCount: 0
      })
    ).toBe('0/4 current/max · -- oldest · 0 coalesced · 0 evicted/dropped')
  })
})

describe('Diagnostics record latency copy', () => {
  it('names the slowest backend phase with its delta', () => {
    expect(
      formatSlowestPhase({
        kind: 'start',
        totalMs: 900,
        outcome: 'running',
        marks: [
          { phase: 'admission', atMs: 5 },
          { phase: 'mic-warm', atMs: 400 },
          { phase: 'running', atMs: 900 }
        ]
      })
    ).toBe('running · 500 ms')
  })

  it('keeps the placeholder when no timeline has been published', () => {
    expect(formatSlowestPhase(undefined)).toBe('--')
  })
})
