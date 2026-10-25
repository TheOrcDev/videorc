import { describe, expect, it } from 'vitest'

import {
  REPLAY_START_RETRY_LIMIT,
  replayBufferReconcileAction,
  replayBufferShouldRestartForSources,
  replayStartRetryDelayMs,
  type ReplayReconcileInput
} from './replay-buffer-reconcile'

const idle: ReplayReconcileInput = {
  armed: true,
  replayState: 'off',
  replayOnlyBuffer: false,
  recordingState: 'idle',
  recordingReplayOnly: false,
  startPending: false,
  stopPending: false,
  replayStartInFlight: false,
  failedStarts: 0
}

describe('replayBufferReconcileAction (plan 181 S4)', () => {
  it('starts the buffer-only session when the switch is on and nothing runs', () => {
    expect(replayBufferReconcileAction(idle)).toBe('start')
  })

  it('waits while a Record or Go Live is in flight: the backend hands over itself', () => {
    expect(replayBufferReconcileAction({ ...idle, startPending: true })).toBeNull()
    expect(replayBufferReconcileAction({ ...idle, stopPending: true })).toBeNull()
    expect(replayBufferReconcileAction({ ...idle, replayStartInFlight: true })).toBeNull()
  })

  it('leaves a buffer that is on, starting or riding a recording alone', () => {
    expect(replayBufferReconcileAction({ ...idle, replayState: 'on' })).toBeNull()
    expect(replayBufferReconcileAction({ ...idle, replayState: 'starting' })).toBeNull()
    expect(
      replayBufferReconcileAction({ ...idle, replayState: 'on', recordingState: 'recording' })
    ).toBeNull()
    // Armed during a recording with no ring: it attaches at the next start.
    expect(replayBufferReconcileAction({ ...idle, recordingState: 'recording' })).toBeNull()
  })

  it('re-arms after a recording ends and after a failed start, up to the limit', () => {
    // The recording's terminal status: idle, ring off, switch still on.
    expect(replayBufferReconcileAction({ ...idle, failedStarts: 1 })).toBe('start')
    expect(
      replayBufferReconcileAction({ ...idle, failedStarts: REPLAY_START_RETRY_LIMIT - 1 })
    ).toBe('start')
    expect(replayBufferReconcileAction({ ...idle, failedStarts: REPLAY_START_RETRY_LIMIT })).toBe(
      'give-up'
    )
  })

  it('never acts on an error state: the event handler turns the switch off and says why', () => {
    expect(replayBufferReconcileAction({ ...idle, replayState: 'error' })).toBeNull()
  })

  it('stops the buffer-only session when the switch goes off', () => {
    const on: ReplayReconcileInput = {
      ...idle,
      armed: false,
      replayState: 'on',
      replayOnlyBuffer: true,
      recordingState: 'recording',
      recordingReplayOnly: true
    }
    expect(replayBufferReconcileAction(on)).toBe('stop')
    expect(replayBufferReconcileAction({ ...on, replayState: 'starting' })).toBe('stop')
    expect(replayBufferReconcileAction({ ...on, stopPending: true })).toBeNull()
    expect(replayBufferReconcileAction({ ...on, startPending: true })).toBeNull()
  })

  it('never stops a recording that carries the ring: the switch decides what comes after', () => {
    expect(
      replayBufferReconcileAction({
        ...idle,
        armed: false,
        replayState: 'on',
        replayOnlyBuffer: false,
        recordingState: 'recording',
        recordingReplayOnly: false
      })
    ).toBeNull()
    expect(replayBufferReconcileAction({ ...idle, armed: false })).toBeNull()
  })

  it('restarts a buffer-only session when sources change, never a recording', () => {
    expect(
      replayBufferShouldRestartForSources({
        recordingReplayOnly: true,
        recordingState: 'recording'
      })
    ).toBe(true)
    expect(
      replayBufferShouldRestartForSources({
        recordingReplayOnly: true,
        recordingState: 'starting'
      })
    ).toBe(true)
    expect(
      replayBufferShouldRestartForSources({
        recordingReplayOnly: false,
        recordingState: 'recording'
      })
    ).toBe(false)
    expect(
      replayBufferShouldRestartForSources({
        recordingReplayOnly: true,
        recordingState: 'idle'
      })
    ).toBe(false)
  })

  it('backs off between failed starts', () => {
    expect(replayStartRetryDelayMs(0)).toBe(500)
    expect(replayStartRetryDelayMs(1)).toBe(500)
    expect(replayStartRetryDelayMs(2)).toBe(1000)
    expect(replayStartRetryDelayMs(3)).toBe(2000)
    expect(replayStartRetryDelayMs(9)).toBe(4000)
  })
})
