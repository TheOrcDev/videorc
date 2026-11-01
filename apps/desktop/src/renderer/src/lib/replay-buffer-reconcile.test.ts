import { describe, expect, it } from 'vitest'

import {
  REPLAY_START_RETRY_LIMIT,
  replayBufferReconcileAction,
  replayBufferShouldRestartForSources,
  replayShouldRearmAfterError,
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

  it('waits for the camera after a not-ready refusal, without spending a strike', () => {
    // Launch: the ring is asked for before the camera preview delivers.
    expect(replayBufferReconcileAction({ ...idle, waitingForCamera: true })).toBeNull()
    expect(
      replayBufferReconcileAction({ ...idle, waitingForCamera: true, failedStarts: 2 })
    ).toBeNull()
    // The camera's live edge clears the wait; the count was never touched.
    expect(replayBufferReconcileAction({ ...idle, waitingForCamera: false })).toBe('start')
    // Turning the switch off still stops a running ring.
    expect(
      replayBufferReconcileAction({
        ...idle,
        armed: false,
        waitingForCamera: true,
        replayState: 'on',
        replayOnlyBuffer: true,
        recordingReplayOnly: true,
        recordingState: 'recording'
      })
    ).toBe('stop')
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

  it('restarts a ring that died with its session only once something arms it again', () => {
    // The event handler disarms on the error, so the dead session is not retried in a loop.
    expect(replayBufferReconcileAction({ ...idle, armed: false, replayState: 'error' })).toBeNull()
    // The switch, a source change or a session's end armed it again: start as from off.
    expect(replayBufferReconcileAction({ ...idle, replayState: 'error' })).toBe('start')
    // The ring's own session ends 'failed', not 'idle': that is over too.
    expect(
      replayBufferReconcileAction({
        ...idle,
        replayState: 'error',
        recordingState: 'failed',
        recordingReplayOnly: true
      })
    ).toBe('start')
    expect(
      replayBufferReconcileAction({ ...idle, replayState: 'error', recordingState: 'recording' })
    ).toBeNull()
  })

  it('re-arms after an error only while the switch is on and nothing refused it', () => {
    const dead = { armed: false, replayState: 'error' as const, switchOn: true, blocked: false }
    expect(replayShouldRearmAfterError(dead)).toBe(true)
    expect(replayShouldRearmAfterError({ ...dead, armed: true })).toBe(false)
    expect(replayShouldRearmAfterError({ ...dead, replayState: 'off' })).toBe(false)
    expect(replayShouldRearmAfterError({ ...dead, switchOn: false })).toBe(false)
    expect(replayShouldRearmAfterError({ ...dead, blocked: true })).toBe(false)
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
