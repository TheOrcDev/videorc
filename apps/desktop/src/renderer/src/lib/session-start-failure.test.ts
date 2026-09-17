import { describe, expect, it, vi } from 'vitest'

import {
  reconcileSessionStartResponse,
  reduceSessionStartFailure,
  SESSION_START_FAILED_TOAST_ID,
  SESSION_START_FAILED_TOAST_TITLE,
  sessionStartFailureMessage,
  sessionStartFailureToastOptions
} from './session-start-failure'

describe('reconcileSessionStartResponse', () => {
  it.each(['stopping', 'idle', 'failed'] as const)(
    'keeps an exact-session %s event authoritative over a late active response',
    (authoritativeState) => {
      const authoritativeStatus = {
        state: authoritativeState,
        sessionId: 'session-raced',
        message: 'The session ended while start was replying.'
      } as const

      expect(
        reconcileSessionStartResponse(
          { state: 'streaming', sessionId: 'session-raced', streamUrl: 'rtmp://example/live' },
          authoritativeStatus
        )
      ).toEqual({
        status: authoritativeStatus,
        supersededByAuthoritativeEvent: true,
        sessionActive: false
      })
    }
  )

  it('does not let another session terminal event suppress the returned session', () => {
    const response = { state: 'recording', sessionId: 'session-current' } as const

    expect(
      reconcileSessionStartResponse(response, {
        state: 'failed',
        sessionId: 'session-previous'
      })
    ).toEqual({
      status: response,
      supersededByAuthoritativeEvent: false,
      sessionActive: true
    })
  })

  it('does not treat another active event as proof that the returned session is ending', () => {
    const response = { state: 'recording', sessionId: 'session-current' } as const

    expect(
      reconcileSessionStartResponse(response, {
        state: 'streaming',
        sessionId: 'session-current'
      })
    ).toEqual({
      status: response,
      supersededByAuthoritativeEvent: false,
      sessionActive: true
    })
  })
})

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
    const options = sessionStartFailureToastOptions(BARRIER_MESSAGE, retry, dismiss)

    expect(options.id).toBe(SESSION_START_FAILED_TOAST_ID)
    expect(options.id).toBe('session-start-failed')
    expect(SESSION_START_FAILED_TOAST_TITLE).toBe('Could not start')
    expect(options.description).toBe(BARRIER_MESSAGE)
    expect(options.duration).toBe(Infinity)
    expect(options.action.label).toBe('Retry')

    options.action.onClick()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(dismiss).not.toHaveBeenCalled()

    options.onDismiss()
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
