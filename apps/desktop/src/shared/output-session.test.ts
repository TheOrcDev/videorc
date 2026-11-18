import { describe, expect, it } from 'vitest'
import { cloudRoom, idleNative } from './output-session.fixture'
import { outputSessionFacts } from './output-session'

describe('output facts keep cloud ownership separate from native capture', () => {
  it.each([
    [false, false, 'room'],
    [true, false, 'recording'],
    [false, true, 'live'],
    [true, true, 'recording-and-live']
  ] as const)('%s/%s reads as %s', (record, live, activity) => {
    const facts = outputSessionFacts(idleNative, cloudRoom(record, live), true)
    expect(facts).toMatchObject({
      owner: 'cloud-room',
      activity,
      recording: record,
      live,
      nativeSessionId: null,
      showId: 'show-1',
      publisherEpoch: null,
      recordingTakeId: null,
      microphoneMuted: null,
      effectiveProfiles: null
    })
    expect(idleNative).toEqual({ state: 'idle' })
  })
  it('does not claim requested mute or lost publisher state is confirmed', () => {
    const media = {
      identity: 'host:show-1',
      state: 'connected',
      local: { micMuted: true, cameraOff: true, microphone: {} }
    }
    expect(outputSessionFacts(idleNative, cloudRoom(), true, media).microphoneMuted).toBe(true)
    expect(
      outputSessionFacts(idleNative, cloudRoom(), true, { ...media, identity: 'host:old-show' })
        .microphoneMuted
    ).toBeNull()
    expect(
      outputSessionFacts(idleNative, { ...cloudRoom(), connected: false }, true, media)
    ).toMatchObject({ freshness: 'stale', microphoneMuted: null })
    expect(
      outputSessionFacts(idleNative, cloudRoom(), true, { ...media, state: 'reconnecting' })
        .microphoneMuted
    ).toBeNull()
  })
  it('preserves native live/record semantics and excludes replay-only capture', () => {
    expect(
      outputSessionFacts(
        { state: 'recording', sessionId: 'native', streamUrl: 'secret' },
        null,
        true
      )
    ).toMatchObject({
      owner: 'native',
      recording: true,
      live: true,
      nativeSessionId: 'native',
      showId: null
    })
    expect(
      JSON.stringify(outputSessionFacts({ state: 'recording', streamUrl: 'secret' }, null, true))
    ).not.toContain('secret')
    expect(outputSessionFacts({ state: 'recording', replayOnly: true }, null, true).activity).toBe(
      'idle'
    )
  })
})

it('reports known terminal codes without publishing arbitrary error text', () => {
  expect(
    outputSessionFacts(idleNative, { ...cloudRoom(), endReason: 'hold-limit' }, true).terminalReason
  ).toBe('hold-limit')
  expect(
    outputSessionFacts(
      idleNative,
      { ...cloudRoom(), endReason: 'https://private.invalid/token' },
      true
    ).terminalReason
  ).toBeNull()
  expect(outputSessionFacts({ state: 'starting' }, null, true).activity).toBe('starting')
})

it('keeps an opening room as the owner even before its show identity is known', () => {
  const cloud = cloudRoom()
  cloud.show = undefined
  cloud.room!.phase = 'opening'
  expect(outputSessionFacts(idleNative, cloud, true)).toMatchObject({
    owner: 'cloud-room',
    showId: null,
    nativeSessionId: null
  })
})
