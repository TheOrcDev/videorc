import { describe, expect, it } from 'vitest'

import type {
  CaptionsState,
  LiveChatProviderState,
  PreviewCameraState,
  PreviewLiveState,
  PreviewScreenState,
  StreamTargetState
} from '@/lib/backend'

import {
  captionsStatusLabel,
  captionsStatusTone,
  chatStateLabel,
  connectionBlockedReason,
  destinationStateLabel,
  micSignalLabel,
  previewSourceStateLabel,
  previewStateLabel,
  sessionStatusLabel,
  START_BLOCKED_COPY
} from './state-labels'
import { isRawStatusValue } from './status-word'

// Plan 174 S1.3: Health printed the preview's raw states ("device-missing",
// "permission-needed") into its chips.

const PREVIEW_STATES: PreviewLiveState[] = ['connecting', 'live', 'reconnecting', 'unavailable']
const SOURCE_STATES: (PreviewCameraState | PreviewScreenState)[] = [
  'starting',
  'live',
  'permission-needed',
  'device-missing',
  'source-missing',
  'failed'
]

describe('previewStateLabel', () => {
  it('names each preview state in a word', () => {
    expect(previewStateLabel('connecting')).toBe('Connecting…')
    expect(previewStateLabel('live')).toBe('Running')
    expect(previewStateLabel('reconnecting')).toBe('Reconnecting…')
    expect(previewStateLabel('unavailable')).toBe('Unavailable')
  })

  it('falls back to a sentence-case word for a state the map does not know', () => {
    expect(previewStateLabel('warming-up' as PreviewLiveState)).toBe('Warming up')
  })
})

describe('previewSourceStateLabel', () => {
  it('names each source state in a word', () => {
    expect(previewSourceStateLabel('starting')).toBe('Starting…')
    expect(previewSourceStateLabel('live')).toBe('Receiving')
    expect(previewSourceStateLabel('permission-needed')).toBe('Needs permission')
    expect(previewSourceStateLabel('failed')).toBe('Failed')
  })

  it('reads the idle-or-missing state as Not running, never Not found (plan 173)', () => {
    expect(previewSourceStateLabel('device-missing')).toBe('Not running')
    expect(previewSourceStateLabel('source-missing')).toBe('Not running')
  })
})

const DESTINATION_STATES: StreamTargetState[] = [
  'not-configured',
  'ready',
  'connecting',
  'live',
  'warning',
  'reconnecting',
  'failed',
  'stopped'
]
const CAPTIONS_STATES: CaptionsState[] = [
  'idle',
  'ready',
  'starting',
  'listening',
  'reconnecting',
  'degraded',
  'blocked',
  'error',
  'live'
]

function chat(overrides: Partial<LiveChatProviderState> = {}): LiveChatProviderState {
  return {
    id: 'twitch',
    platform: 'twitch',
    read: 'ready',
    write: 'ready',
    state: 'connected',
    message: '',
    ...overrides
  }
}

describe('destinationStateLabel (plan 174 S2.3a, J2-4)', () => {
  it('names a destination one way on every surface', () => {
    expect(destinationStateLabel('live')).toBe('On air')
    expect(destinationStateLabel('failed')).toBe('Failed')
    expect(destinationStateLabel('stopped')).toBe('Ended')
    expect(destinationStateLabel('reconnecting')).toBe('Reconnecting…')
    expect(destinationStateLabel('warning')).toBe('Not receiving')
    expect(destinationStateLabel('not-configured')).toBe('Skipped')
  })
})

describe('captionsStatusLabel (plan 174 S2.3a, D-26)', () => {
  it('says Off when captions are off, whatever the backend last reported', () => {
    expect(captionsStatusLabel({ state: 'listening' }, { enabled: false })).toBe('Off')
    // The reader has no switch to read: the backend's idle is its off.
    expect(captionsStatusLabel({ state: 'idle' })).toBe('Off')
    expect(captionsStatusLabel({ state: 'idle', desiredEnabled: false })).toBe('Off')
  })

  it('has one word per state: Ready, Listening, Failed, never Armed or Live', () => {
    expect(captionsStatusLabel({ state: 'idle' }, { enabled: true })).toBe('Ready')
    expect(captionsStatusLabel({ state: 'idle' }, { enabled: true, sessionActive: true })).toBe(
      'Waiting…'
    )
    expect(captionsStatusLabel({ state: 'ready', desiredEnabled: true })).toBe('Ready')
    expect(captionsStatusLabel({ state: 'live', desiredEnabled: true })).toBe('Listening')
    expect(captionsStatusLabel({ state: 'listening', desiredEnabled: true })).toBe('Listening')
    expect(captionsStatusLabel({ state: 'error', desiredEnabled: true })).toBe('Failed')
    expect(captionsStatusLabel({ state: 'starting', desiredEnabled: true })).toBe('Starting…')
  })

  it('glows only where the state means something', () => {
    expect(captionsStatusTone({ state: 'listening', desiredEnabled: true })).toBe('good')
    expect(captionsStatusTone({ state: 'live', desiredEnabled: true })).toBe('good')
    expect(captionsStatusTone({ state: 'reconnecting', desiredEnabled: true })).toBe('warn')
    expect(captionsStatusTone({ state: 'degraded', desiredEnabled: true })).toBe('warn')
    expect(captionsStatusTone({ state: 'blocked', desiredEnabled: true })).toBe('error')
    expect(captionsStatusTone({ state: 'error', desiredEnabled: true })).toBe('error')
    expect(captionsStatusTone({ state: 'starting', desiredEnabled: true })).toBe('neutral')
    expect(captionsStatusTone({ state: 'error' }, { enabled: false })).toBe('neutral')
  })
})

describe('chatStateLabel (plan 174 S2.3a, H-13)', () => {
  it('names the connection first, then what chat cannot do', () => {
    expect(chatStateLabel(chat())).toBe('Connected')
    expect(chatStateLabel(chat({ write: 'read-only' }))).toBe('Read-only')
    expect(chatStateLabel(chat({ write: 'unavailable' }))).toBe('Read-only')
    expect(chatStateLabel(chat({ write: 'missing-scope' }))).toBe('Reconnect to send')
    expect(chatStateLabel(chat({ write: 'failed' }))).toBe('Send failed')
    expect(chatStateLabel(chat({ state: 'connecting', write: 'read-only' }))).toBe('Connecting…')
    expect(chatStateLabel(chat({ state: 'reconnecting' }))).toBe('Reconnecting…')
    expect(chatStateLabel(chat({ state: 'failed' }))).toBe('Failed')
    expect(chatStateLabel(chat({ state: 'ended' }))).toBe('Ended')
  })

  it('says Off for chat turned off and Unavailable for a platform without it, never Idle', () => {
    expect(chatStateLabel(chat({ state: 'disabled' }))).toBe('Off')
    expect(chatStateLabel(chat({ state: 'unsupported' }))).toBe('Unavailable')
    expect(chatStateLabel(chat({ read: 'unavailable' }))).toBe('Unavailable')
  })

  it('pauses a parked connector that resumes on its own', () => {
    expect(chatStateLabel(chat({ state: 'waiting', retryAt: '2026-10-11T20:00:00Z' }))).toBe(
      'Paused'
    )
    expect(chatStateLabel(chat({ state: 'waiting' }))).toBe('Waiting…')
  })
})

describe('micSignalLabel (plan 174 S2.3a, C-38)', () => {
  it('says Receiving for a working microphone, never Live or Monitoring', () => {
    expect(micSignalLabel('live')).toBe('Receiving')
    expect(micSignalLabel('monitoring')).toBe('Receiving')
    expect(micSignalLabel('muted')).toBe('Muted')
    expect(micSignalLabel('idle')).toBe('No signal')
  })
})

describe('start-blocking copy (plan 174 S2.3a, B-22)', () => {
  it('says what to do in the streamer’s words, never the socket or FFmpeg', () => {
    expect(connectionBlockedReason('connected')).toBeNull()
    expect(connectionBlockedReason('connecting')).toBe("Starting Videorc's capture engine…")
    expect(connectionBlockedReason('waiting')).toBe("Starting Videorc's capture engine…")
    expect(connectionBlockedReason('closed')).toBe(
      'Videorc is reconnecting. Try again in a moment.'
    )
    expect(connectionBlockedReason('failed')).toBe(
      'Videorc is reconnecting. Try again in a moment.'
    )
    expect(START_BLOCKED_COPY.noOutput).toBe('Turn on Save local recording in Output, or go live.')
    expect(START_BLOCKED_COPY.checkingRecorder).toBe('Checking the recorder…')
    for (const copy of Object.values(START_BLOCKED_COPY)) {
      expect(copy).not.toMatch(/backend|socket|ffmpeg|RTMP|MKV|session/i)
    }
  })
})

describe('state labels', () => {
  it('never return a raw value, and keep "On air" for the livestream alone (D4)', () => {
    const labels = [
      ...PREVIEW_STATES.map(previewStateLabel),
      ...SOURCE_STATES.map(previewSourceStateLabel),
      ...CAPTIONS_STATES.map((state) => captionsStatusLabel({ state, desiredEnabled: true })),
      ...(['live', 'monitoring', 'muted', 'idle'] as const).map(micSignalLabel)
    ]
    for (const label of labels) {
      expect(isRawStatusValue(label)).toBe(false)
      expect(label).not.toMatch(/^(live|on air|armed|monitoring)$/i)
    }
    for (const state of DESTINATION_STATES) {
      expect(isRawStatusValue(destinationStateLabel(state))).toBe(false)
      expect(destinationStateLabel(state)).not.toMatch(/^(live|stopped)$/i)
    }
    expect(sessionStatusLabel({ state: 'streaming' }, 'connected')).toBe('On air')
  })
})
