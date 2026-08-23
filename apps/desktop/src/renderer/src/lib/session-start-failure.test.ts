import { describe, expect, it, vi } from 'vitest'

import {
  reduceSessionStartFailure,
  SESSION_START_FAILED_TOAST_ID,
  sessionStartFailureMessage,
  sessionStartFailureToastOptions
} from './session-start-failure'

const BARRIER_MESSAGE =
  'Recording startup blocked before encoding: latest compositor frame gap 700ms exceeds startup cadence budget 200ms (recent gaps 700/690/710 ms; 4 fresh frame(s) in 2500ms); cadence budget 200ms.'

describe('sessionStartFailureMessage', () => {
  it('keeps the backend reason verbatim', () => {
    expect(sessionStartFailureMessage(new Error(BARRIER_MESSAGE))).toBe(BARRIER_MESSAGE)
  })

  it('stringifies non-Error rejections and never yields an empty line', () => {
    expect(sessionStartFailureMessage('No livestream destinations are ready.')).toBe(
      'No livestream destinations are ready.'
    )
    expect(sessionStartFailureMessage(new Error('   '))).toBe('The session could not start.')
  })
})

describe('reduceSessionStartFailure', () => {
  it('records a failure with its timestamp', () => {
    expect(
      reduceSessionStartFailure(null, { type: 'failed', message: BARRIER_MESSAGE, at: 1700 })
    ).toEqual({ message: BARRIER_MESSAGE, at: 1700 })
  })

  it('replaces an earlier failure so a repeat of the same reason still re-renders', () => {
    const first = reduceSessionStartFailure(null, {
      type: 'failed',
      message: BARRIER_MESSAGE,
      at: 1
    })
    const second = reduceSessionStartFailure(first, {
      type: 'failed',
      message: BARRIER_MESSAGE,
      at: 2
    })
    expect(second).toEqual({ message: BARRIER_MESSAGE, at: 2 })
    expect(second).not.toBe(first)
  })

  it('clears when the user starts again', () => {
    const failed = reduceSessionStartFailure(null, {
      type: 'failed',
      message: BARRIER_MESSAGE,
      at: 1
    })
    expect(reduceSessionStartFailure(failed, { type: 'start-attempted' })).toBeNull()
  })

  it('clears when the user dismisses it', () => {
    const failed = reduceSessionStartFailure(null, {
      type: 'failed',
      message: BARRIER_MESSAGE,
      at: 1
    })
    expect(reduceSessionStartFailure(failed, { type: 'dismissed' })).toBeNull()
  })

  it('is a no-op to dismiss or start with nothing pending', () => {
    expect(reduceSessionStartFailure(null, { type: 'dismissed' })).toBeNull()
    expect(reduceSessionStartFailure(null, { type: 'start-attempted' })).toBeNull()
  })
})

describe('sessionStartFailureToastOptions', () => {
  it('is persistent, keyed so it cannot stack, and carries a Retry action', () => {
    const retry = vi.fn()
    const dismiss = vi.fn()
    const options = sessionStartFailureToastOptions(retry, dismiss)

    expect(options.id).toBe(SESSION_START_FAILED_TOAST_ID)
    expect(options.id).toBe('session-start-failed')
    expect(options.duration).toBe(Infinity)
    expect(options.action.label).toBe('Retry')

    options.action.onClick()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(dismiss).not.toHaveBeenCalled()

    options.onDismiss()
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
