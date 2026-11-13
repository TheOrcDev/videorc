import { describe, expect, it, vi } from 'vitest'

import type { CloudStatus } from '@/lib/backend'
import {
  TALK_SHOW_STREAM_URL,
  startTalkShowLivestream,
  talkShowStartBlockedReason,
  talkShowLiveStartedAt,
  talkShowSessionView
} from '@/lib/talk-show-session'
import { sessionIsLive, sessionOwnsTransport } from '../../../shared/capture-state'
import { sessionStopControl } from '@/lib/studio-session-view'

function status(
  room: Partial<NonNullable<CloudStatus['room']>> | null,
  recording?: CloudStatus['recording'],
  liveSeconds?: number
): CloudStatus {
  return {
    phase: 'live',
    entitled: true,
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300] },
    show: { id: 'sh_talk', nodeId: 'eu-1', resumable: false, kind: 'talk' },
    connected: true,
    directFallbackAvailable: false,
    ...(liveSeconds === undefined ? {} : { liveSeconds }),
    ...(room
      ? {
          room: {
            phase: 'open',
            doorOpen: false,
            declinedCount: 0,
            stage: { layout: 'solo', onStage: [] },
            hostAway: false,
            connected: true,
            client: 'connected',
            returnEnabled: false,
            stageSet: false,
            live: false,
            ...room
          }
        }
      : {}),
    ...(recording ? { recording } : {})
  }
}

// Plan 224 C-G6: the room projects into the recording-state view the
// transport already reads, so Record and Go Live stay the same buttons.
describe('talkShowSessionView', () => {
  it('is nothing outside an open room, and nothing while the room idles', () => {
    expect(talkShowSessionView(null, null)).toBeNull()
    expect(talkShowSessionView(status(null), null)).toBeNull()
    expect(talkShowSessionView(status({ phase: 'closed' }), null)).toBeNull()
    expect(talkShowSessionView(status({}), null)).toBeNull()
  })

  it('reads the cloud recording as a recording with its start (D10)', () => {
    const view = talkShowSessionView(
      status({}, { active: true, since: '2026-11-08T12:04:00.000Z', seconds: 5, bytes: 1 }),
      null
    )
    expect(view).toEqual({
      state: 'recording',
      sessionId: 'sh_talk',
      startedAt: '2026-11-08T12:04:00.000Z'
    })
    expect(sessionOwnsTransport(view!)).toBe(true)
    expect(sessionIsLive(view!)).toBe(false)
    expect(sessionStopControl(view!, false)).toEqual({ label: 'Stop recording' })
  })

  it('reads a live room as on air, and End livestream never says the recording stops too (D17)', () => {
    const view = talkShowSessionView(
      status({ live: true }, { active: true, seconds: 5, bytes: 1 }),
      '2026-11-08T12:00:00.000Z'
    )
    expect(view).toEqual({
      state: 'streaming',
      sessionId: 'sh_talk',
      streamUrl: TALK_SHOW_STREAM_URL,
      startedAt: '2026-11-08T12:00:00.000Z'
    })
    expect(sessionIsLive(view!)).toBe(true)
    expect(sessionStopControl(view!, false)).toEqual({ label: 'End livestream' })
  })

  it('takes the on-air start from the runner clock once', () => {
    expect(
      talkShowLiveStartedAt(status({ live: true }, undefined, 90), Date.UTC(2026, 10, 8, 12, 1, 30))
    ).toBe('2026-11-08T12:00:00.000Z')
    expect(talkShowLiveStartedAt(null, Date.UTC(2026, 10, 8, 12, 0, 0))).toBe(
      '2026-11-08T12:00:00.000Z'
    )
    // This desktop's hand-over stamp wins over the runner's clock (D17: a
    // Go Live after End livestream starts a fresh clock).
    expect(
      talkShowLiveStartedAt(
        status({ live: true, liveSince: '2026-11-08T12:30:00.000Z' }, undefined, 3600),
        Date.UTC(2026, 10, 8, 12, 31, 0)
      )
    ).toBe('2026-11-08T12:30:00.000Z')
    expect(
      talkShowLiveStartedAt(
        status({ live: true, liveSince: 'not a date' }, undefined, 90),
        Date.UTC(2026, 10, 8, 12, 1, 30)
      )
    ).toBe('2026-11-08T12:00:00.000Z')
  })
})

it('starts requested cloud recording before live and preserves an existing recording', async () => {
  const calls: string[] = []
  const record = async () => {
    calls.push('record')
  }
  const live = async () => {
    calls.push('live')
    return status({ live: true })
  }
  await startTalkShowLivestream(true, false, record, live)
  expect(calls).toEqual(['record', 'live'])
  calls.length = 0
  await startTalkShowLivestream(true, true, record, live)
  expect(calls).toEqual(['live'])
  calls.length = 0
  await startTalkShowLivestream(false, false, record, live)
  expect(calls).toEqual(['live'])
  const goLive = vi.fn(live)
  await expect(
    startTalkShowLivestream(
      true,
      false,
      async () => {
        throw new Error('recording refused')
      },
      goLive
    )
  ).rejects.toThrow('recording refused')
  expect(goLive).not.toHaveBeenCalled()
})

it('allows each cloud output to start while only the other is running', () => {
  expect(
    talkShowStartBlockedReason(status({ live: true }), { record: true, stream: false })
  ).toBeNull()
  expect(
    talkShowStartBlockedReason(status({}, { active: true, seconds: 1, bytes: 1 }), {
      record: true,
      stream: true
    })
  ).toBeNull()
  expect(
    talkShowStartBlockedReason(status({ live: true }), { record: false, stream: true })
  ).not.toBeNull()
})
