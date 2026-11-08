import { describe, expect, it } from 'vitest'

import {
  RECORDING_STOP_FINALIZE_OVERRUN_CODE,
  STOP_FINALIZE_OVERRUN_ALERT,
  sessionMode,
  isSessionTransportActive,
  sessionAlsoRecords,
  sessionClockLabel,
  sessionElapsedMs,
  sessionIsLive,
  sessionStatusGlyph,
  sessionStatusLabel,
  sessionStatusPulses,
  sessionStatusTone,
  sessionStopControl,
  streamingSummary
} from './studio-session-view'

const STREAM_URL = 'rtmp://live.twitch.tv/app/***'
// Go Live leaves recordEnabled on: the backend reports record+stream as
// `recording`, and only stream-only as `streaming` (plan 095 S5).
const recordOnly = { state: 'recording', sessionId: 's' }
const streamOnly = { state: 'streaming', sessionId: 's', streamUrl: STREAM_URL }
const recordAndStream = { state: 'recording', sessionId: 's', streamUrl: STREAM_URL }

describe('sessionMode', () => {
  it('names each record/stream combination', () => {
    expect(sessionMode(true, true)).toBe('Recording + streaming')
    expect(sessionMode(false, true)).toBe('Streaming only')
    expect(sessionMode(true, false)).toBe('Local recording')
    expect(sessionMode(false, false)).toBe('No output')
  })
})

describe('streamingSummary', () => {
  const yt = { enabled: true, label: 'YouTube', platform: 'youtube' }
  const tw = { enabled: true, label: '', platform: 'twitch' }

  // Plan 174 S3.1 (B-3): the row shows what is set up whatever the last mode
  // was; Go Live is an explicit start, so there is no "Disabled" any more.
  it('handles zero / one / many enabled destinations', () => {
    expect(streamingSummary([])).toBe('No destinations')
    expect(streamingSummary([{ ...yt, enabled: false }])).toBe('No destinations')
    expect(streamingSummary([yt])).toBe('YouTube')
    expect(streamingSummary([tw])).toBe('twitch') // falls back to platform when unlabeled
    expect(streamingSummary([yt, tw])).toBe('2 destinations')
  })
})

describe('a buffer-only session (plan 181)', () => {
  const bufferOnly = { state: 'recording', sessionId: 's', replayOnly: true }

  it('reads Ready, never Recording, and never pulses', () => {
    expect(sessionStatusLabel(bufferOnly, 'connected')).toBe('Ready')
    expect(sessionStatusTone(bufferOnly, 'connected')).toBe('good')
    expect(sessionStatusLabel(bufferOnly, 'connected', { startBlocked: true })).toBe('Not ready')
    expect(sessionStatusPulses(bufferOnly, 'connected')).toBe(false)
    expect(sessionStatusGlyph(bufferOnly, 'connected')).toBeNull()
    // A dropped socket still wins over the ring.
    expect(sessionStatusLabel(bufferOnly, 'reconnecting')).toBe('Videorc is reconnecting…')
  })

  it('leaves Record and Go Live on the transport', () => {
    expect(isSessionTransportActive('recording', true)).toBe(false)
    expect(isSessionTransportActive('starting', true)).toBe(false)
    expect(isSessionTransportActive('recording')).toBe(true)
    expect(isSessionTransportActive('recording', false)).toBe(true)
  })
})

describe('STOP_FINALIZE_OVERRUN_ALERT (plan 174 S3.1, B-16)', () => {
  it('explains Force stop in the streamer’s words, with the backend code it answers', () => {
    expect(RECORDING_STOP_FINALIZE_OVERRUN_CODE).toBe('recording-stop-finalize-overrun')
    expect(STOP_FINALIZE_OVERRUN_ALERT.title).toBe('Stopping is taking longer than expected')
    expect(STOP_FINALIZE_OVERRUN_ALERT.description).toContain(
      'Force stop ends it now; the last seconds may be lost.'
    )
    expect(STOP_FINALIZE_OVERRUN_ALERT.description).not.toMatch(/session|endpoint/i)
  })
})

describe('sessionIsLive', () => {
  it('is on air for stream-only and record+stream, never for a recording', () => {
    expect(sessionIsLive(streamOnly)).toBe(true)
    expect(sessionIsLive(recordAndStream)).toBe(true)
    expect(sessionIsLive(recordOnly)).toBe(false)
    expect(sessionIsLive({ state: 'recording', streamUrl: '' })).toBe(false)
  })
  it('is never on air outside a running state, stream URL or not', () => {
    for (const state of ['idle', 'starting', 'stopping', 'failed']) {
      expect(sessionIsLive({ state, streamUrl: STREAM_URL })).toBe(false)
    }
  })
  it('marks only record+stream as also recording', () => {
    expect(sessionAlsoRecords(recordAndStream)).toBe(true)
    expect(sessionAlsoRecords(streamOnly)).toBe(false)
    expect(sessionAlsoRecords(recordOnly)).toBe(false)
  })
})

describe('sessionStatusLabel / sessionStatusTone (plan 174 S1.3)', () => {
  it('maps every session state to a word and a tone', () => {
    expect(sessionStatusLabel({ state: 'idle' })).toBe('Ready')
    expect(sessionStatusTone({ state: 'idle' })).toBe('good')
    expect(sessionStatusLabel({ state: 'starting' })).toBe('Starting…')
    expect(sessionStatusTone({ state: 'starting' })).toBe('neutral')
    expect(sessionStatusLabel({ state: 'recording' })).toBe('Recording')
    expect(sessionStatusTone({ state: 'recording' })).toBe('live')
    expect(sessionStatusLabel({ state: 'stopping' })).toBe('Stopping…')
    expect(sessionStatusTone({ state: 'stopping' })).toBe('neutral')
    expect(sessionStatusLabel({ state: 'failed' })).toBe('Failed')
    expect(sessionStatusTone({ state: 'failed' })).toBe('error')
  })
  it('reads On air in the live tone for every on-air session (plan 095 S5, D4)', () => {
    expect(sessionStatusLabel(recordOnly, 'connected')).toBe('Recording')
    expect(sessionStatusTone(recordOnly, 'connected')).toBe('live')
    expect(sessionStatusLabel(streamOnly, 'connected')).toBe('On air')
    expect(sessionStatusTone(streamOnly, 'connected')).toBe('live')
    // Go Live: the owner saw "Recording" here on 2026-10-02.
    expect(sessionStatusLabel(recordAndStream, 'connected')).toBe('On air')
    expect(sessionStatusTone(recordAndStream, 'connected')).toBe('live')
  })
  it('says a sentence-case word, never the raw value, for a state no map names', () => {
    expect(sessionStatusLabel({ state: 'paused' })).toBe('Paused')
    expect(sessionStatusLabel({ state: 'warming-up' })).toBe('Warming up')
    expect(sessionStatusTone({ state: 'paused' })).toBe('neutral')
  })
  it('reads a blocked idle session as a neutral Not ready, never a green Ready (B-17)', () => {
    expect(sessionStatusLabel({ state: 'idle' }, 'connected', { startBlocked: true })).toBe(
      'Not ready'
    )
    expect(sessionStatusTone({ state: 'idle' }, 'connected', { startBlocked: true })).toBe(
      'neutral'
    )
    // A running session is never "Not ready": the block only describes idle.
    expect(sessionStatusLabel(recordOnly, 'connected', { startBlocked: true })).toBe('Recording')
    expect(sessionStatusLabel(recordAndStream, 'connected', { startBlocked: true })).toBe('On air')
  })
  // F-014: a dead backend socket must override every session state — the app
  // used to zombie with a green Ready badge after a backend crash.
  it('reports Videorc is reconnecting over any state when the socket is down', () => {
    for (const status of [
      { state: 'idle' },
      recordOnly,
      streamOnly,
      recordAndStream,
      { state: 'failed' }
    ]) {
      for (const wsStatus of ['failed', 'closed']) {
        expect(sessionStatusLabel(status, wsStatus)).toBe('Videorc is reconnecting…')
        expect(sessionStatusTone(status, wsStatus)).toBe('warn')
        expect(sessionStatusPulses(status, wsStatus)).toBe(false)
        expect(sessionStatusGlyph(status, wsStatus)).toBe('alert')
      }
    }
    expect(sessionStatusLabel({ state: 'idle' }, 'connected')).toBe('Ready')
    expect(sessionStatusTone({ state: 'idle' }, 'connected')).toBe('good')
    // Boot-time connecting is calm, not alarming.
    expect(sessionStatusLabel({ state: 'idle' }, 'waiting')).toBe('Connecting…')
    expect(sessionStatusLabel({ state: 'idle' }, 'connecting')).toBe('Connecting…')
    expect(sessionStatusTone({ state: 'idle' }, 'connecting')).toBe('neutral')
  })
  it('never says a raw socket or session enum', () => {
    const states = ['idle', 'starting', 'recording', 'streaming', 'stopping', 'failed', 'paused']
    const sockets = [undefined, 'waiting', 'connecting', 'connected', 'failed', 'closed']
    for (const state of states) {
      for (const wsStatus of sockets) {
        for (const startBlocked of [false, true]) {
          const label = sessionStatusLabel({ state }, wsStatus, { startBlocked })
          expect(label).not.toMatch(/^[a-z-]+$/)
          expect(label).not.toMatch(/backend|connected|closed|waiting|streaming/i)
        }
      }
    }
  })
})

describe('sessionStatusPulses (A-4)', () => {
  it('pulses only while recording or on air', () => {
    expect(sessionStatusPulses(recordOnly)).toBe(true)
    expect(sessionStatusPulses(streamOnly, 'connected')).toBe(true)
    expect(sessionStatusPulses(recordAndStream, 'connected')).toBe(true)
    for (const state of ['idle', 'starting', 'stopping', 'failed']) {
      expect(sessionStatusPulses({ state }, 'connected')).toBe(false)
    }
    expect(sessionStatusPulses({ state: 'idle' }, 'waiting')).toBe(false)
  })
})

describe('sessionStatusGlyph (B-17)', () => {
  it('gives recording, on air and trouble their own icon', () => {
    expect(sessionStatusGlyph(recordOnly, 'connected')).toBe('record')
    expect(sessionStatusGlyph(streamOnly, 'connected')).toBe('live')
    expect(sessionStatusGlyph(recordAndStream, 'connected')).toBe('live')
    expect(sessionStatusGlyph({ state: 'failed' }, 'connected')).toBe('alert')
    expect(sessionStatusGlyph({ state: 'idle' }, 'connected')).toBeNull()
    expect(sessionStatusGlyph({ state: 'starting' }, 'connected')).toBeNull()
    expect(sessionStatusGlyph({ state: 'idle' }, 'waiting')).toBeNull()
  })
})

describe('sessionStopControl', () => {
  it('ends a livestream, and says visibly when that also stops the recording (plan 095 S5, 174 D19)', () => {
    expect(sessionStopControl(recordOnly, false)).toEqual({ label: 'Stop recording' })
    expect(sessionStopControl(streamOnly, false)).toEqual({ label: 'End livestream' })
    expect(sessionStopControl(recordAndStream, false)).toEqual({
      label: 'End livestream',
      note: 'Your recording stops too.'
    })
  })
  it('keeps the in-flight labels', () => {
    expect(sessionStopControl(recordAndStream, true)).toEqual({ label: 'Stopping…' })
    expect(sessionStopControl({ state: 'stopping', streamUrl: STREAM_URL }, false)).toEqual({
      label: 'Force stop'
    })
  })
  it('cancels a Go Live that is still starting, and stops a starting recording (B-16)', () => {
    expect(sessionStopControl({ state: 'starting' }, false, true)).toEqual({
      label: 'Cancel livestream'
    })
    expect(sessionStopControl({ state: 'starting' }, false, false)).toEqual({
      label: 'Stop recording'
    })
    expect(sessionStopControl({ state: 'starting' }, false)).toEqual({ label: 'Stop recording' })
    // Once the stream is up the session is live whatever the flag says.
    expect(sessionStopControl(recordAndStream, false, true)).toEqual({
      label: 'End livestream',
      note: 'Your recording stops too.'
    })
  })
})

describe('isSessionTransportActive', () => {
  // F-020: the Stop/Force-stop control must stay reachable through EVERY
  // in-flight state — starting/stopping used to flip the transport to idle.
  it('keeps the transport owned across all in-flight states', () => {
    for (const state of ['recording', 'streaming', 'starting', 'stopping']) {
      expect(isSessionTransportActive(state)).toBe(true)
    }
    for (const state of ['idle', 'failed', 'unknown']) {
      expect(isSessionTransportActive(state)).toBe(false)
    }
  })
})

describe('sessionElapsedMs', () => {
  const startedAt = '2026-10-02T18:00:00.000Z'
  const startedMs = Date.parse(startedAt)

  it('counts from the session start (plan 095 S5)', () => {
    expect(sessionElapsedMs(startedAt, startedMs)).toBe(0)
    expect(sessionElapsedMs(startedAt, startedMs + 61_000)).toBe(61_000)
    expect(sessionClockLabel(sessionElapsedMs(startedAt, startedMs + 61_000))).toBe('1:01')
  })
  it('clamps a start in the future to 0', () => {
    expect(sessionElapsedMs(startedAt, startedMs - 5_000)).toBe(0)
  })
  it('is undefined for missing or invalid input', () => {
    expect(sessionElapsedMs(undefined, startedMs)).toBeUndefined()
    expect(sessionElapsedMs(null, startedMs)).toBeUndefined()
    expect(sessionElapsedMs('', startedMs)).toBeUndefined()
    expect(sessionElapsedMs('not a date', startedMs)).toBeUndefined()
    expect(sessionElapsedMs(startedAt, Number.NaN)).toBeUndefined()
  })
})

describe('sessionClockLabel', () => {
  it('counts m:ss under an hour and h:mm:ss after (plan 050 S12)', () => {
    expect(sessionClockLabel(undefined)).toBe('0:00')
    expect(sessionClockLabel(Number.NaN)).toBe('0:00')
    expect(sessionClockLabel(-500)).toBe('0:00')
    expect(sessionClockLabel(999)).toBe('0:00')
    expect(sessionClockLabel(61_000)).toBe('1:01')
    expect(sessionClockLabel(59 * 60_000 + 59_999)).toBe('59:59')
    expect(sessionClockLabel(3_600_000 + 2 * 60_000 + 3_000)).toBe('1:02:03')
  })
})
