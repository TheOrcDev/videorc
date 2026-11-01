import { describe, expect, it } from 'vitest'

import { captureStateAfterStatusPayload } from '../shared/capture-state'
import { DisplaySleepGuard } from './display-sleep-guard'

function guard(): { guard: DisplaySleepGuard; calls: string[] } {
  const calls: string[] = []
  let next = 7
  return {
    calls,
    guard: new DisplaySleepGuard(
      () => {
        calls.push(`start:${next}`)
        return next++
      },
      (id) => calls.push(`stop:${id}`)
    )
  }
}

describe('DisplaySleepGuard', () => {
  it('holds the display awake from Record to the end of the session, once', () => {
    const { guard: g, calls } = guard()
    for (const state of ['idle', 'starting', 'recording', 'recording', 'stopping'] as const) {
      g.update(state)
    }
    expect(g.holding).toBe(true)
    g.update('idle')
    expect(g.holding).toBe(false)
    expect(calls).toEqual(['start:7', 'stop:7'])
  })

  it('holds it for a stream-only livestream and lets go when it fails', () => {
    const { guard: g, calls } = guard()
    g.update('streaming')
    g.update('failed')
    expect(calls).toEqual(['start:7', 'stop:7'])
  })

  it('never holds it for the Clips buffer, which main reads as idle', () => {
    const { guard: g, calls } = guard()
    g.update(captureStateAfterStatusPayload({ state: 'recording', replayOnly: true }))
    expect(g.holding).toBe(false)
    expect(calls).toEqual([])
  })

  it('lets go when the event socket is lost (unknown state)', () => {
    const { guard: g, calls } = guard()
    g.update('recording')
    g.update('unknown')
    expect(calls).toEqual(['start:7', 'stop:7'])
    g.update('unknown')
    expect(calls).toEqual(['start:7', 'stop:7'])
  })
})
