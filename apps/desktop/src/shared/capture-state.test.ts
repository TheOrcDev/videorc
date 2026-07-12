import { describe, expect, it } from 'vitest'

import {
  captureStateAfterStatusPayload,
  captureStateAfterTransportLoss,
  captureStateBlocksInterruption,
  isActiveRecordingState,
  recordingStateFromPayload,
  type MainCaptureState
} from './capture-state'

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

  it('fails closed after malformed status or transport loss', () => {
    expect(captureStateAfterStatusPayload({ state: 'idle' })).toBe('idle')
    expect(captureStateAfterStatusPayload({ state: 'paused' })).toBe('unknown')
    expect(captureStateAfterStatusPayload(null)).toBe('unknown')
    expect(captureStateAfterTransportLoss()).toBe('unknown')
  })
})
