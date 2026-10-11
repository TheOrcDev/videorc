import { describe, expect, it } from 'vitest'

import type { PreviewCameraState, PreviewLiveState, PreviewScreenState } from '@/lib/backend'

import { previewSourceStateLabel, previewStateLabel, sessionStatusLabel } from './state-labels'
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

describe('state labels', () => {
  it('never return a raw value, and keep "On air" for the session alone (D4)', () => {
    const labels = [
      ...PREVIEW_STATES.map(previewStateLabel),
      ...SOURCE_STATES.map(previewSourceStateLabel)
    ]
    for (const label of labels) {
      expect(isRawStatusValue(label)).toBe(false)
      expect(label).not.toMatch(/^(live|on air)$/i)
    }
    expect(sessionStatusLabel({ state: 'streaming' }, 'connected')).toBe('On air')
  })
})
