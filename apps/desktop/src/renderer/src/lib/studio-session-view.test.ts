import { describe, expect, it } from 'vitest'

import {
  outputSummary,
  qualityName,
  recordingQuality,
  sessionMode,
  isSessionTransportActive,
  sessionAlsoRecords,
  sessionClockLabel,
  sessionElapsedMs,
  sessionIsLive,
  sessionStatusLabel,
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

describe('qualityName', () => {
  it('classifies common heights and falls back to <h>p', () => {
    expect(qualityName(2160)).toBe('4K')
    // Q7 (plan 022): 1440 gets its class name — "1440p · 1440p30" read as a
    // stutter in the compact Output control.
    expect(qualityName(1440)).toBe('2K')
    expect(qualityName(1080)).toBe('1080p')
    expect(qualityName(720)).toBe('720p')
    expect(qualityName(480)).toBe('480p')
  })
})

describe('recordingQuality / outputSummary', () => {
  const portraitCases = [
    { width: 1080, height: 1920, fps: 30, label: '1080p30', summary: '1080×1920 · 30fps' },
    { width: 1080, height: 1920, fps: 60, label: '1080p60', summary: '1080×1920 · 60fps' },
    { width: 1440, height: 2560, fps: 30, label: '2K · 1440p30', summary: '1440×2560 · 30fps' },
    { width: 1440, height: 2560, fps: 60, label: '2K · 1440p60', summary: '1440×2560 · 60fps' },
    { width: 2160, height: 3840, fps: 30, label: '4K · 2160p30', summary: '2160×3840 · 30fps' }
  ]

  it('formats quality and output strings', () => {
    const video = { width: 3840, height: 2160, fps: 30 }
    expect(recordingQuality(video)).toBe('4K · 2160p30')
    expect(recordingQuality({ width: 2560, height: 1440, fps: 30 })).toBe('2K · 1440p30')
    // When the class IS the height, skip the redundant doubling.
    expect(recordingQuality({ width: 1920, height: 1080, fps: 60 })).toBe('1080p60')
    expect(outputSummary(video)).toBe('3840×2160 · 30fps')
  })
  it.each(portraitCases)(
    'labels portrait $width×$height at $fps fps',
    ({ width, height, fps, label }) => {
      expect(recordingQuality({ width, height, fps })).toBe(label)
    }
  )

  it('preserves each landscape orientation twin', () => {
    for (const { width, height, fps, label } of portraitCases) {
      expect(recordingQuality({ width: height, height: width, fps })).toBe(label)
    }
  })

  it('preserves floor and square labels', () => {
    expect(recordingQuality({ width: 640, height: 360, fps: 24 })).toBe('360p24')
    expect(recordingQuality({ width: 1080, height: 1080, fps: 60 })).toBe('1080p60')
    expect(recordingQuality({ width: 1440, height: 1440, fps: 30 })).toBe('2K · 1440p30')
    expect(recordingQuality({ width: 2160, height: 2160, fps: 30 })).toBe('4K · 2160p30')
  })

  it('preserves the full portrait dimensions in output summaries', () => {
    for (const { width, height, fps, summary } of portraitCases) {
      expect(outputSummary({ width, height, fps })).toBe(summary)
    }
  })
})

describe('streamingSummary', () => {
  const yt = { enabled: true, label: 'YouTube', platform: 'youtube' }
  const tw = { enabled: true, label: '', platform: 'twitch' }

  it('reads Disabled when streaming is off', () => {
    expect(streamingSummary(false, [yt])).toBe('Disabled')
  })
  it('handles zero / one / many enabled destinations', () => {
    expect(streamingSummary(true, [])).toBe('No destinations')
    expect(streamingSummary(true, [{ ...yt, enabled: false }])).toBe('No destinations')
    expect(streamingSummary(true, [yt])).toBe('YouTube')
    expect(streamingSummary(true, [tw])).toBe('twitch') // falls back to platform when unlabeled
    expect(streamingSummary(true, [yt, tw])).toBe('2 destinations')
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

describe('sessionStatusLabel / sessionStatusTone', () => {
  it('maps known states to label + tone', () => {
    expect(sessionStatusLabel({ state: 'idle' })).toBe('Ready')
    expect(sessionStatusTone({ state: 'idle' })).toBe('good')
    expect(sessionStatusLabel({ state: 'recording' })).toBe('Recording')
    expect(sessionStatusTone({ state: 'recording' })).toBe('error')
    expect(sessionStatusTone({ state: 'starting' })).toBe('warn')
    expect(sessionStatusLabel({ state: 'failed' })).toBe('Failed')
  })
  it('reads Streaming in the live tone for every on-air session (plan 095 S5)', () => {
    expect(sessionStatusLabel(recordOnly, 'connected')).toBe('Recording')
    expect(sessionStatusTone(recordOnly, 'connected')).toBe('error')
    expect(sessionStatusLabel(streamOnly, 'connected')).toBe('Streaming')
    expect(sessionStatusTone(streamOnly, 'connected')).toBe('live')
    // Go Live: the owner saw "Recording" here on 2026-10-02.
    expect(sessionStatusLabel(recordAndStream, 'connected')).toBe('Streaming')
    expect(sessionStatusTone(recordAndStream, 'connected')).toBe('live')
  })
  it('capitalizes and stays neutral for unknown states', () => {
    expect(sessionStatusLabel({ state: 'paused' })).toBe('Paused')
    expect(sessionStatusTone({ state: 'paused' })).toBe('neutral')
  })
  // F-014: a dead backend socket must override every session state — the app
  // used to zombie with a green Ready badge after a backend crash.
  it('reports Backend offline over any state when the socket is down', () => {
    for (const status of [
      { state: 'idle' },
      recordOnly,
      streamOnly,
      recordAndStream,
      { state: 'failed' }
    ]) {
      expect(sessionStatusLabel(status, 'failed')).toBe('Backend offline')
      expect(sessionStatusTone(status, 'failed')).toBe('error')
      expect(sessionStatusLabel(status, 'closed')).toBe('Backend offline')
    }
    expect(sessionStatusLabel({ state: 'idle' }, 'connected')).toBe('Ready')
    expect(sessionStatusTone({ state: 'idle' }, 'connected')).toBe('good')
    // Boot-time connecting is calm, not alarming.
    expect(sessionStatusLabel({ state: 'idle' }, 'waiting')).toBe('Connecting…')
    expect(sessionStatusTone({ state: 'idle' }, 'connecting')).toBe('warn')
  })
})

describe('sessionStopControl', () => {
  it('ends a livestream, and says when that also stops the recording (plan 095 S5)', () => {
    expect(sessionStopControl(recordOnly, false)).toEqual({ label: 'Stop recording' })
    expect(sessionStopControl(streamOnly, false)).toEqual({ label: 'End livestream' })
    expect(sessionStopControl(recordAndStream, false)).toEqual({
      label: 'End livestream',
      title: 'Also stops the recording'
    })
  })
  it('keeps the in-flight labels', () => {
    expect(sessionStopControl(recordAndStream, true)).toEqual({ label: 'Stopping…' })
    expect(sessionStopControl({ state: 'stopping', streamUrl: STREAM_URL }, false)).toEqual({
      label: 'Force stop'
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
