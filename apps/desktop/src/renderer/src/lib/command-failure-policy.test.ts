import { describe, expect, it } from 'vitest'

import {
  captionsStartFailureCanReconcile,
  captionsStopFailureCanReconcile,
  commentHighlightClearFailureCanReconcile,
  commentHighlightSetFailureCanReconcile,
  commentsSendFailureCanReconcile,
  screenActivateFailureCanReconcile,
  screenClearFailureCanReconcile
} from './command-failure-policy'

describe('outcome-unknown command reconciliation', () => {
  it('never suppresses explicit screen activate or clear failures', () => {
    const failure = { code: 'command-expired-before-dispatch' }
    expect(
      screenActivateFailureCanReconcile(failure, 'screen-1', { id: 'screen-1' } as never)
    ).toBe(false)
    expect(screenClearFailureCanReconcile(failure, null)).toBe(false)
  })

  it('reconciles screen activate and clear only after a matching fenced read', () => {
    const failure = { code: 'request-outcome-unknown' }
    expect(
      screenActivateFailureCanReconcile(failure, 'screen-1', { id: 'screen-1' } as never)
    ).toBe(true)
    expect(
      screenActivateFailureCanReconcile(failure, 'screen-1', { id: 'screen-2' } as never)
    ).toBe(false)
    expect(screenClearFailureCanReconcile(failure, null)).toBe(true)
    expect(screenClearFailureCanReconcile({ name: 'AbortError', outcomeUnknown: true }, null)).toBe(
      true
    )
    expect(
      screenClearFailureCanReconcile({ name: 'AbortError', outcomeUnknown: false }, null)
    ).toBe(false)
  })

  it('does not mistake a signed-out prior-ready caption status for a successful start', () => {
    expect(
      captionsStartFailureCanReconcile(
        { code: 'captions-start-failed' },
        { state: 'ready', desiredEnabled: true }
      )
    ).toBe(false)
  })

  it('allows caption start/stop reconciliation only for outcome-unknown terminal evidence', () => {
    expect(
      captionsStartFailureCanReconcile(
        { code: 'request-outcome-unknown' },
        { state: 'listening', desiredEnabled: true }
      )
    ).toBe(true)
    expect(
      captionsStopFailureCanReconcile(
        { code: 'captions-stop-failed' },
        { state: 'idle', desiredEnabled: false }
      )
    ).toBe(false)
  })

  it('reconciles comment highlights only for an exact outcome-unknown terminal state', () => {
    const outcomeUnknown = { code: 'request-outcome-unknown' }
    const explicitFailure = { code: 'comments-highlight-failed' }
    const liveState = {
      sessionId: 'session-1',
      messageId: 'message-1',
      generation: 2,
      phase: 'live' as const
    }

    expect(
      commentHighlightSetFailureCanReconcile(outcomeUnknown, 'session-1', 'message-1', liveState)
    ).toBe(true)
    expect(
      commentHighlightSetFailureCanReconcile(outcomeUnknown, 'session-1', 'message-2', liveState)
    ).toBe(false)
    expect(
      commentHighlightSetFailureCanReconcile(explicitFailure, 'session-1', 'message-1', liveState)
    ).toBe(false)
    expect(
      commentHighlightClearFailureCanReconcile(outcomeUnknown, {
        generation: 3,
        phase: 'idle'
      })
    ).toBe(true)
    expect(
      commentHighlightClearFailureCanReconcile(explicitFailure, {
        generation: 3,
        phase: 'idle'
      })
    ).toBe(false)
  })

  it('does not turn an explicit operation-id collision into a successful chat send', () => {
    const storedOperation = {
      id: 'operation-1',
      sessionId: 'session-1',
      text: 'the earlier message',
      phase: 'sent' as const,
      destinations: [],
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:01.000Z'
    }

    expect(
      commentsSendFailureCanReconcile(
        { code: 'live-chat-send-failed' },
        {
          operationId: storedOperation.id,
          sessionId: storedOperation.sessionId,
          text: 'the new unsent message'
        },
        storedOperation
      )
    ).toBe(false)
    expect(
      commentsSendFailureCanReconcile(
        { code: 'request-outcome-unknown' },
        {
          operationId: storedOperation.id,
          sessionId: storedOperation.sessionId,
          text: 'the new unsent message'
        },
        storedOperation
      )
    ).toBe(false)
    expect(
      commentsSendFailureCanReconcile(
        { code: 'request-outcome-unknown' },
        {
          operationId: storedOperation.id,
          sessionId: storedOperation.sessionId,
          text: storedOperation.text
        },
        storedOperation
      )
    ).toBe(true)
  })
})
