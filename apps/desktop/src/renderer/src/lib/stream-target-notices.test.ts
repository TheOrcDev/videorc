import { describe, expect, it } from 'vitest'

import type { StreamTargetRuntime, StreamTargetState } from '@/lib/backend'
import {
  otherDestinationsLine,
  otherDestinationsOnAir,
  streamTargetNotices
} from '@/lib/stream-target-notices'

function target(state: StreamTargetState, message?: string): StreamTargetRuntime {
  return {
    targetId: 'yt',
    platform: 'youtube',
    label: 'YouTube',
    state,
    ...(message ? { message } : {})
  }
}

function other(id: string, state: StreamTargetState, label = 'Twitch'): StreamTargetRuntime {
  return { targetId: id, platform: 'twitch', label, state }
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

  it('keeps the stopped toast, on the destination’s one key', () => {
    expect(
      streamTargetNotices(before('reconnecting'), [
        target('failed', 'YouTube ended this broadcast')
      ])
    ).toEqual([
      {
        key: 'stream-target:yt',
        kind: 'error',
        title: 'Streaming to YouTube stopped',
        description: 'YouTube ended this broadcast'
      }
    ])
  })

  it('ends "Streaming to {X} stopped" with "{X} is back" on the same key (plan 174 S2.3a)', () => {
    const [stopped] = streamTargetNotices(before('live'), [target('failed')])
    const [back] = streamTargetNotices(before('failed'), [target('live')])
    expect(back).toMatchObject({
      kind: 'success',
      title: 'YouTube is back',
      description: 'Streaming to YouTube resumed.',
      key: stopped.key
    })
    // A destination that only finished, or was never on air, is not news.
    expect(streamTargetNotices(before('stopped'), [target('live')])).toEqual([])
    expect(streamTargetNotices(before('connecting'), [target('live')])).toEqual([])
  })

  it('says what viewers still see by counting the other destinations on air (J2-19)', () => {
    const [alone] = streamTargetNotices(before('live'), [target('reconnecting')])
    expect(alone.description).toBe("Viewers see nothing until it's back.")
    expect(alone.description).not.toMatch(/other destinations/)

    const [withOne] = streamTargetNotices(before('live'), [
      target('reconnecting'),
      other('tw', 'live')
    ])
    expect(withOne.description).toBe(
      "Viewers there see nothing until it's back. The other destination keeps streaming."
    )

    const [failedAlone] = streamTargetNotices(before('live'), [
      target('failed'),
      other('tw', 'reconnecting')
    ])
    expect(failedAlone.description).toBe(
      'No other destination is streaming, so viewers see nothing.'
    )
    const [failedWithTwo] = streamTargetNotices(before('live'), [
      target('failed'),
      other('tw', 'live'),
      other('kick', 'live', 'Kick')
    ])
    expect(failedWithTwo.description).toBe('The other 2 destinations keep streaming.')
  })

  it('names the retired X default as X (D-36)', () => {
    const [notice] = streamTargetNotices(new Map([['x', 'live']]), [
      { targetId: 'x', platform: 'x', label: 'X / Twitter', state: 'failed' }
    ])
    expect(notice.title).toBe('Streaming to X stopped')
  })
})

describe('otherDestinationsLine', () => {
  it('counts only the other destinations that are on air', () => {
    expect(otherDestinationsOnAir([target('live'), other('tw', 'live')], 'yt')).toBe(1)
    expect(otherDestinationsOnAir([target('live'), other('tw', 'warning')], 'yt')).toBe(0)
    expect(otherDestinationsLine(0)).toBeNull()
    expect(otherDestinationsLine(1)).toBe('The other destination keeps streaming.')
    expect(otherDestinationsLine(3)).toBe('The other 3 destinations keep streaming.')
  })
})
