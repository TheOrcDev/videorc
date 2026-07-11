import { describe, expect, it } from 'vitest'

import {
  activeAudioProcessingUpdateParams,
  rejectedLiveAudioProcessingUpdate
} from './live-audio-processing'

describe('activeAudioProcessingUpdateParams', () => {
  it.each(['recording', 'streaming'] as const)(
    'maps shared mic controls to the active %s session',
    (state) => {
      expect(
        activeAudioProcessingUpdateParams(
          { state, sessionId: 'session-1' },
          { microphoneGainDb: 6, microphoneMuted: true }
        )
      ).toEqual({
        sessionId: 'session-1',
        microphoneGainDb: 6,
        microphoneMuted: true
      })
    }
  )

  it.each(['idle', 'starting', 'stopping', 'failed'] as const)(
    'does not target a %s session',
    (state) => {
      expect(
        activeAudioProcessingUpdateParams(
          { state, sessionId: 'session-1' },
          { microphoneGainDb: 6, microphoneMuted: false }
        )
      ).toBeNull()
    }
  )

  it('requires a backend session id so delayed updates cannot cross capture boundaries', () => {
    expect(
      activeAudioProcessingUpdateParams(
        { state: 'streaming' },
        { microphoneGainDb: -3, microphoneMuted: true }
      )
    ).toBeNull()
  })

  it('restores the last applied values and disables live edits when native audio is unavailable', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 8, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        result: {
          applied: false,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true,
          reasonCode: 'native-audio-unavailable'
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toEqual({
      rollback: { microphoneGainDb: -2, microphoneMuted: false },
      disableForSession: true,
      message:
        'Live microphone controls are unavailable for this capture. The previous gain and mute settings were restored.'
    })
  })

  it('ignores a stale rejection after the user has made a newer mic edit', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 3, microphoneMuted: false },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        result: {
          applied: false,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true,
          reasonCode: 'native-audio-unavailable'
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toBeNull()
  })

  it('does not roll back a live change the backend applied', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 8, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        result: {
          applied: true,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toBeNull()
  })

  it.each(['recording', 'streaming'] as const)(
    'restores and disables a current %s-session edit when the request rejects',
    (state) => {
      expect(
        rejectedLiveAudioProcessingUpdate({
          recording: { state, sessionId: 'session-1' },
          current: { microphoneGainDb: 8, microphoneMuted: true },
          requested: {
            sessionId: 'session-1',
            microphoneGainDb: 8,
            microphoneMuted: true
          },
          lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
        })
      ).toEqual({
        rollback: { microphoneGainDb: -2, microphoneMuted: false },
        disableForSession: true,
        message:
          'Live microphone controls are unavailable for this capture. The previous gain and mute settings were restored.'
      })
    }
  )

  it('ignores a rejected request after the active session changes', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'streaming', sessionId: 'session-2' },
        current: { microphoneGainDb: 8, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toBeNull()
  })
})
