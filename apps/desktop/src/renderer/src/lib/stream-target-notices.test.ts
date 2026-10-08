import { describe, expect, it } from 'vitest'

import type { StreamTargetRuntime, StreamTargetState } from '@/lib/backend'
import { streamTargetNotices } from '@/lib/stream-target-notices'

function target(state: StreamTargetState, message?: string): StreamTargetRuntime {
  return {
    targetId: 'yt',
    platform: 'youtube',
    label: 'YouTube',
    state,
    ...(message ? { message } : {})
  }
}

const before = (state: StreamTargetState): Map<string, StreamTargetState> =>
  new Map([['yt', state]])

describe('streamTargetNotices', () => {
  it('stays quiet for a destination that goes live at start', () => {
    expect(streamTargetNotices(new Map(), [target('live')])).toEqual([])
  })

  it('warns once when a live destination starts reconnecting', () => {
    expect(
      streamTargetNotices(before('live'), [target('reconnecting', 'Reconnecting: End of file')])
    ).toEqual([
      expect.objectContaining({
        key: 'stream-target:yt',
        kind: 'warning',
        title: 'YouTube is reconnecting'
      })
    ])
    expect(streamTargetNotices(before('reconnecting'), [target('reconnecting')])).toEqual([])
  })

  it('says when the platform stops receiving and when it is back, on one key', () => {
    const [down] = streamTargetNotices(before('live'), [target('warning')])
    expect(down).toMatchObject({ kind: 'warning', title: "YouTube isn't receiving your stream" })
    const [back] = streamTargetNotices(before('warning'), [target('live')])
    expect(back).toMatchObject({ kind: 'success', title: 'YouTube is back', key: down.key })
    const [backFromReconnect] = streamTargetNotices(before('reconnecting'), [target('live')])
    expect(backFromReconnect.key).toBe(down.key)
  })

  it('keeps the stopped toast and its key', () => {
    expect(
      streamTargetNotices(before('reconnecting'), [
        target('failed', 'YouTube ended this broadcast')
      ])
    ).toEqual([
      {
        key: 'stream-target-failed:yt',
        kind: 'error',
        title: 'Streaming to YouTube stopped',
        description: 'YouTube ended this broadcast'
      }
    ])
  })
})
