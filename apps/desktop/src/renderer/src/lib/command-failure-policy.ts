import type {
  CaptionsStatus,
  CommentHighlightState,
  CommentsSendOperation,
  StreamScreen
} from '../../../shared/backend'

/**
 * A sent request can be reconciled from an authoritative read only when the
 * transport explicitly says its outcome is unknown. Backend rejections and
 * pre-send failures are terminal failures even if unrelated state happens to
 * match the requested end state.
 */
export function outcomeUnknownCommandCanReconcile(input: {
  failure: unknown
  authoritativeTerminalStateMatches: boolean
}): boolean {
  return (
    failureCode(input.failure) === 'request-outcome-unknown' &&
    input.authoritativeTerminalStateMatches
  )
}

export function failureCode(failure: unknown): string | undefined {
  if (!failure || typeof failure !== 'object') return undefined
  if ('code' in failure) {
    const code = (failure as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'outcomeUnknown' in failure &&
    (failure as { outcomeUnknown?: unknown }).outcomeUnknown === true
    ? 'request-outcome-unknown'
    : undefined
}

const activeCaptionsStates = new Set<CaptionsStatus['state']>([
  'starting',
  'listening',
  'reconnecting',
  'degraded',
  'live'
])

export function captionsStartFailureCanReconcile(
  failure: unknown,
  status: CaptionsStatus | null
): boolean {
  return outcomeUnknownCommandCanReconcile({
    failure,
    authoritativeTerminalStateMatches:
      status !== null && activeCaptionsStates.has(status.state) && status.desiredEnabled !== false
  })
}

export function captionsStopFailureCanReconcile(
  failure: unknown,
  status: CaptionsStatus | null
): boolean {
  return outcomeUnknownCommandCanReconcile({
    failure,
    authoritativeTerminalStateMatches:
      status !== null && !activeCaptionsStates.has(status.state) && status.desiredEnabled !== true
  })
}

export function screenActivateFailureCanReconcile(
  failure: unknown,
  requestedScreenId: string,
  activeScreen: StreamScreen | null | undefined
): boolean {
  return outcomeUnknownCommandCanReconcile({
    failure,
    authoritativeTerminalStateMatches: activeScreen?.id === requestedScreenId
  })
}

export function screenClearFailureCanReconcile(
  failure: unknown,
  activeScreen: StreamScreen | null | undefined
): boolean {
  return outcomeUnknownCommandCanReconcile({
    failure,
    authoritativeTerminalStateMatches: activeScreen === null
  })
}

export function commentHighlightSetFailureCanReconcile(
  failure: unknown,
  requestedSessionId: string,
  requestedMessageId: string,
  status: CommentHighlightState | null
): boolean {
  return outcomeUnknownCommandCanReconcile({
    failure,
    authoritativeTerminalStateMatches:
      status?.phase === 'live' &&
      status.sessionId === requestedSessionId &&
      status.messageId === requestedMessageId
  })
}

export function commentHighlightClearFailureCanReconcile(
  failure: unknown,
  status: CommentHighlightState | null
): boolean {
  return outcomeUnknownCommandCanReconcile({
    failure,
    authoritativeTerminalStateMatches: status?.phase === 'idle'
  })
}

export function commentsSendFailureCanReconcile(
  failure: unknown,
  requested: { operationId: string; sessionId: string; text: string },
  operation: CommentsSendOperation | undefined
): operation is CommentsSendOperation {
  return outcomeUnknownCommandCanReconcile({
    failure,
    authoritativeTerminalStateMatches:
      operation?.id === requested.operationId &&
      operation.sessionId === requested.sessionId &&
      operation.text === requested.text
  })
}
