import { describe, expect, it } from 'vitest'

import {
  captureStateAfterStatusPayload,
  captureStateAfterTransportLoss,
  captureStateBlocksInterruption,
  isActiveRecordingState,
  livestreamOnAirFromPayload,
  recordingStateFromPayload,
  idleEndsSessionThatRan,
  sessionActivity,
  sessionIsReplayOnly,
  sessionOwnsTransport,
  takeRunning,
  type MainCaptureState
} from './capture-state'

// Plan 198: 0.11.0 refused a Clips start 62 times in 40 s because every
// refusal's Idle reset the failed-start count and the give-up never tripped.
describe('idleEndsSessionThatRan', () => {
  it('counts an Idle after a session that recorded or streamed', () => {
    expect(idleEndsSessionThatRan('recording', 'idle')).toBe(true)
    expect(idleEndsSessionThatRan('streaming', 'idle')).toBe(true)
    expect(idleEndsSessionThatRan('stopping', 'idle')).toBe(true)
  })

  it('never counts a refused start, a failure, or a non-Idle status', () => {
    expect(idleEndsSessionThatRan('starting', 'idle')).toBe(false)
    expect(idleEndsSessionThatRan('failed', 'idle')).toBe(false)
    expect(idleEndsSessionThatRan('idle', 'idle')).toBe(false)
    expect(idleEndsSessionThatRan(undefined, 'idle')).toBe(false)
    expect(idleEndsSessionThatRan('recording', 'stopping')).toBe(false)
  })
})

// Plan 174 S3.1 (D2): main asks before a quit or a window close ends a
// livestream, so it reads "on air" straight from the status payload.
describe('livestreamOnAirFromPayload', () => {
  it('is on air for a stream-only session and for Go Live (record+stream)', () => {
    expect(
      livestreamOnAirFromPayload({ state: 'streaming', streamUrl: 'rtmp://127.0.0.1/live/***' })
    ).toBe(true)
    expect(
      livestreamOnAirFromPayload({ state: 'recording', streamUrl: 'rtmp://127.0.0.1/live/***' })
    ).toBe(true)
    expect(livestreamOnAirFromPayload({ state: 'streaming' })).toBe(true)
  })

  it('is never on air for a recording, a transition, or a malformed status', () => {
    expect(livestreamOnAirFromPayload({ state: 'recording' })).toBe(false)
    expect(livestreamOnAirFromPayload({ state: 'recording', streamUrl: null })).toBe(false)
    expect(livestreamOnAirFromPayload({ state: 'recording', streamUrl: 7 })).toBe(false)
    for (const state of ['idle', 'starting', 'stopping', 'failed']) {
      expect(livestreamOnAirFromPayload({ state, streamUrl: 'rtmp://127.0.0.1/live/***' })).toBe(
        false
      )
    }
    expect(livestreamOnAirFromPayload({ state: 'bogus', streamUrl: 'rtmp://x' })).toBe(false)
    expect(livestreamOnAirFromPayload(null)).toBe(false)
    expect(livestreamOnAirFromPayload('recording')).toBe(false)
  })
})

// Plan 174 B-6: Go Live (record+stream) reports `recording` with a stream URL,
// and its notices must speak of the live session while it still saves a file.
describe('sessionActivity', () => {
  it('reads Go Live as record+stream, never as a plain recording', () => {
    expect(sessionActivity({ state: 'recording', streamUrl: 'rtmp://127.0.0.1/live/***' })).toBe(
      'record+stream'
    )
  })

  it('tells a stream-only session from a recording-only one', () => {
    expect(sessionActivity({ state: 'streaming', streamUrl: 'rtmp://127.0.0.1/live/***' })).toBe(
      'live-stream'
    )
    expect(sessionActivity({ state: 'streaming' })).toBe('live-stream')
    expect(sessionActivity({ state: 'recording' })).toBe('recording')
    expect(sessionActivity({ state: 'recording', streamUrl: null })).toBe('recording')
  })
})

describe('isActiveRecordingState', () => {
  it.each(['starting', 'recording', 'streaming', 'stopping'] as const)(
    'treats %s as capture-active',
    (state) => expect(isActiveRecordingState(state)).toBe(true)
  )

  it.each(['idle', 'failed'] as const)('treats %s as capture-idle', (state) =>
    expect(isActiveRecordingState(state)).toBe(false)
  )
})

describe('captureStateBlocksInterruption', () => {
  it.each(['unknown', 'starting', 'recording', 'streaming', 'stopping'] as MainCaptureState[])(
    'blocks a privileged interruption while the connected backend is %s',
    (state) => expect(captureStateBlocksInterruption(state, true)).toBe(true)
  )

  it.each(['idle', 'failed'] as MainCaptureState[])(
    'allows a privileged interruption while the connected backend is %s',
    (state) => expect(captureStateBlocksInterruption(state, true)).toBe(false)
  )

  it('allows install when no backend process is connected', () => {
    expect(captureStateBlocksInterruption('unknown', false)).toBe(false)
  })
})

describe('recordingStateFromPayload', () => {
  it('accepts only protocol recording states', () => {
    expect(recordingStateFromPayload({ state: 'starting' })).toBe('starting')
    expect(recordingStateFromPayload({ state: 'idle', extra: true })).toBe('idle')
    expect(recordingStateFromPayload({ state: 'paused' })).toBeNull()
    expect(recordingStateFromPayload(null)).toBeNull()
  })

  it('reads a buffer-only session as idle, so it blocks no quit or update (plan 181)', () => {
    expect(recordingStateFromPayload({ state: 'recording', replayOnly: true })).toBe('idle')
    expect(recordingStateFromPayload({ state: 'starting', replayOnly: true })).toBe('idle')
    expect(recordingStateFromPayload({ state: 'recording', replayOnly: false })).toBe('recording')
    expect(captureStateAfterStatusPayload({ state: 'stopping', replayOnly: true })).toBe('idle')
    expect(sessionIsReplayOnly({ replayOnly: true })).toBe(true)
    expect(sessionIsReplayOnly({})).toBe(false)
    expect(sessionOwnsTransport({ state: 'recording', replayOnly: true })).toBe(false)
    expect(sessionOwnsTransport({ state: 'recording' })).toBe(true)
    expect(sessionOwnsTransport({ state: 'idle' })).toBe(false)
  })

  it('fails closed after malformed status or transport loss', () => {
    expect(captureStateAfterStatusPayload({ state: 'idle' })).toBe('idle')
    expect(captureStateAfterStatusPayload({ state: 'paused' })).toBe('unknown')
    expect(captureStateAfterStatusPayload(null)).toBe('unknown')
    expect(captureStateAfterTransportLoss()).toBe('unknown')
  })
})

// 2026-10-28: the chrome ground holds still while a take runs.
describe('takeRunning', () => {
  it('is a recording or livestream from starting through stopping', () => {
    for (const state of ['starting', 'recording', 'streaming', 'stopping'] as const) {
      expect(takeRunning(state), state).toBe(true)
    }
    for (const state of ['idle', 'failed', 'unknown'] as const) {
      expect(takeRunning(state), state).toBe(false)
    }
  })

  it('is never a Clips-only ring, which main reads as idle', () => {
    const ring = { state: 'recording', replayOnly: true, sessionId: 'ring' }
    expect(takeRunning(captureStateAfterStatusPayload(ring))).toBe(false)
    expect(takeRunning(captureStateAfterStatusPayload({ ...ring, replayOnly: false }))).toBe(true)
  })

  it('is no take after a lost socket, so the ground never holds still forever', () => {
    expect(takeRunning(captureStateAfterTransportLoss())).toBe(false)
  })
})
