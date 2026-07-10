import type {
  CommentsSendOperation,
  DestinationDelivery,
  LiveChatProviderState,
  StreamPlatform
} from '@/lib/backend'

// Send-to-all-platforms (Comments upgrade S5): pure decisions for the
// Comments window's input row — where a message will go, its explicit pending
// operation, and how per-platform results read back. Never silently
// partial: failures always surface per platform.

export const CHAT_SEND_MAX_CHARS = 200

/** Platforms a message can actually reach right now. Backend write capability
 * is authoritative; the UI never hard-codes provider support. */
export function sendablePlatforms(providers: LiveChatProviderState[]): StreamPlatform[] {
  return [
    ...new Set(
      providers
        .filter((provider) => provider.write === 'ready')
        .map((provider) => provider.platform)
    )
  ]
}

export interface ChatSendFailure {
  destinationId: string
  platform: StreamPlatform
  reason: string
}

/** Immediate, explicitly-pending UI state while the correlated backend command
 * runs. It never invents a sent message; the backend terminal operation
 * replaces this shape before any destination can display success. */
export function pendingCommentsSendOperation({
  id,
  sessionId,
  text,
  providers,
  now = new Date().toISOString()
}: {
  id: string
  sessionId: string
  text: string
  providers: LiveChatProviderState[]
  now?: string
}): CommentsSendOperation {
  const destinations = providers.map<DestinationDelivery>((provider) => {
    if (provider.write === 'read-only') {
      return {
        destinationId: provider.id,
        platform: provider.platform,
        phase: 'read-only',
        reason: 'This destination supports receiving comments only.'
      }
    }
    if (provider.write === 'missing-scope') {
      return {
        destinationId: provider.id,
        platform: provider.platform,
        phase: 'unavailable',
        reason: 'Reconnect this account to grant chat write permission.'
      }
    }
    if (provider.write === 'failed') {
      return {
        destinationId: provider.id,
        platform: provider.platform,
        phase: 'failed',
        reason: "This destination's comment sender is unavailable."
      }
    }
    if (provider.write === 'ready') {
      return { destinationId: provider.id, platform: provider.platform, phase: 'pending' }
    }
    return {
      destinationId: provider.id,
      platform: provider.platform,
      phase: 'unavailable',
      reason: 'Sending is unavailable for this destination.'
    }
  })
  return {
    id,
    sessionId,
    text,
    phase: destinations.some((destination) => destination.phase === 'pending')
      ? 'sending'
      : 'failed',
    destinations,
    createdAt: now,
    updatedAt: now
  }
}

/** Failed and ambiguous destinations remain visible. Read-only/unavailable
 * rows are represented by the destination strip, not disguised as success. */
export function chatSendFailures(
  operation: CommentsSendOperation | null | undefined
): ChatSendFailure[] {
  if (!operation) return []
  return operation.destinations
    .filter(
      (destination) => destination.phase === 'failed' || destination.phase === 'timed-out-unknown'
    )
    .map((destination) => ({
      destinationId: destination.destinationId,
      platform: destination.platform,
      reason:
        destination.reason ??
        (destination.phase === 'timed-out-unknown'
          ? 'Delivery is unknown; Videorc did not retry.'
          : 'Send failed.')
    }))
}

export function destinationDelivery(
  operation: CommentsSendOperation | null | undefined,
  destinationId: string
): DestinationDelivery | undefined {
  return operation?.destinations.find((destination) => destination.destinationId === destinationId)
}

export function validateChatDraft(draft: string): string | null {
  const text = draft.trim()
  if (text.length === 0) {
    return null
  }
  return text.length > CHAT_SEND_MAX_CHARS ? null : text
}
