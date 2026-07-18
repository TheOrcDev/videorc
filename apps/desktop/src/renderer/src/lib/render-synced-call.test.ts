import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RenderSyncedCall } from './render-synced-call'

describe('RenderSyncedCall', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends once per changed content, after the commit tick', () => {
    const sent: Array<{ width: number }> = []
    const call = new RenderSyncedCall<{ width: number }>((value) => sent.push(value))

    call.sync({ width: 1920 })
    call.sync({ width: 1920 }) // re-render with identical content: free
    expect(sent).toEqual([])
    vi.advanceTimersByTime(0)
    expect(sent).toEqual([{ width: 1920 }])

    call.sync({ width: 1080 })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual([{ width: 1920 }, { width: 1080 }])
  })

  it('coalesces a same-tick burst into the final value', () => {
    const sent: number[] = []
    const call = new RenderSyncedCall<number>((value) => sent.push(value))
    call.sync(1)
    call.sync(2)
    call.sync(3)
    vi.advanceTimersByTime(0)
    expect(sent).toEqual([3])
  })
})
