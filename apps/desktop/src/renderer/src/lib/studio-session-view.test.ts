import { describe, expect, it } from 'vitest'

import {
  outputSummary,
  qualityName,
  recordingQuality,
  sessionMode,
  isSessionTransportActive,
  sessionClockLabel,
  sessionStatusLabel,
  sessionStatusTone,
  streamingSummary
} from './studio-session-view'

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
  it('formats quality and output strings', () => {
    const video = { width: 3840, height: 2160, fps: 30 }
    expect(recordingQuality(video)).toBe('4K · 2160p30')
    expect(recordingQuality({ width: 2560, height: 1440, fps: 30 })).toBe('2K · 1440p30')
    // When the class IS the height, skip the redundant doubling.
    expect(recordingQuality({ width: 1920, height: 1080, fps: 60 })).toBe('1080p60')
    expect(outputSummary(video)).toBe('3840×2160 · 30fps')
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

describe('sessionStatusLabel / sessionStatusTone', () => {
  it('maps known states to label + tone', () => {
    expect(sessionStatusLabel('idle')).toBe('Ready')
    expect(sessionStatusTone('idle')).toBe('good')
    expect(sessionStatusLabel('recording')).toBe('Recording')
    expect(sessionStatusTone('recording')).toBe('error')
    expect(sessionStatusTone('streaming')).toBe('good')
    expect(sessionStatusTone('starting')).toBe('warn')
    expect(sessionStatusLabel('failed')).toBe('Failed')
  })
  it('capitalizes and stays neutral for unknown states', () => {
    expect(sessionStatusLabel('paused')).toBe('Paused')
    expect(sessionStatusTone('paused')).toBe('neutral')
  })
  // F-014: a dead backend socket must override every session state — the app
  // used to zombie with a green Ready badge after a backend crash.
  it('reports Backend offline over any state when the socket is down', () => {
    for (const state of ['idle', 'recording', 'streaming', 'failed']) {
      expect(sessionStatusLabel(state, 'failed')).toBe('Backend offline')
      expect(sessionStatusTone(state, 'failed')).toBe('error')
      expect(sessionStatusLabel(state, 'closed')).toBe('Backend offline')
    }
    expect(sessionStatusLabel('idle', 'connected')).toBe('Ready')
    expect(sessionStatusTone('idle', 'connected')).toBe('good')
    // Boot-time connecting is calm, not alarming.
    expect(sessionStatusLabel('idle', 'waiting')).toBe('Connecting…')
    expect(sessionStatusTone('idle', 'connecting')).toBe('warn')
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
