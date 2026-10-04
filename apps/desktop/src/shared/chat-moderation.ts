import type { LiveChatMessage, ModerationOperation, ModerationPhase } from './backend'

// Chat moderation helpers (plan 140 S4), shared by the renderer windows.
//
// A removal rewrites the original chat row in place through the normal
// tombstone path: same `id`, `isDeleted: true`, `eventType: 'deleted'`, empty
// fragments. The row tells "Removed by you" from "Hidden in Videorc" by
// `rawProviderType`:
//
// | rawProviderType   | messageText         | viewers            |
// | ----------------- | ------------------- | ------------------ |
// | `videorc.removed` | `Removed by you`    | no longer see it   |
// | `videorc.hidden`  | `Hidden in Videorc` | still see it       |
//
// A provider's own deletion keeps its provider type and is neither.

/** The platform deleted the message on the streamer's request. */
export const REMOVED_BY_YOU_PROVIDER_TYPE = 'videorc.removed'
/** The platform could not delete it; Videorc hides it locally and says so. */
export const HIDDEN_IN_VIDEORC_PROVIDER_TYPE = 'videorc.hidden'

export type LocalRemovalKind = 'removed' | 'hidden'

/** How a chat row was removed by the streamer, or `null` for any other row. */
export function localRemovalKind(
  message: Pick<LiveChatMessage, 'isDeleted' | 'rawProviderType'>
): LocalRemovalKind | null {
  if (!message.isDeleted) return null
  switch (message.rawProviderType) {
    case REMOVED_BY_YOU_PROVIDER_TYPE:
      return 'removed'
    case HIDDEN_IN_VIDEORC_PROVIDER_TYPE:
      return 'hidden'
    default:
      return null
  }
}

const TERMINAL_PHASES: ReadonlySet<ModerationPhase> = new Set<ModerationPhase>([
  'cancelled',
  'expired',
  'removed',
  'hidden-locally',
  'failed',
  'delivery-unknown'
])

/** Nothing changes a terminal operation again. */
export function moderationOperationTerminal(
  operation: Pick<ModerationOperation, 'phase'>
): boolean {
  return TERMINAL_PHASES.has(operation.phase)
}

/** The card is open: the streamer can still confirm or cancel. */
export function moderationOperationOpen(operation: Pick<ModerationOperation, 'phase'>): boolean {
  return operation.phase === 'pending-confirm'
}

/**
 * Merge an operation update into the one a window holds. Events and RPC
 * results can cross: a terminal row never rolls back to `executing` or
 * `pending-confirm`, and between two non-terminal rows the later `updatedAt`
 * wins. Different ids always replace (the caller keys by `operationId`).
 */
export function reconcileModerationOperation(
  current: ModerationOperation | undefined,
  candidate: ModerationOperation
): ModerationOperation {
  if (!current || current.operationId !== candidate.operationId) return candidate
  if (moderationOperationTerminal(current) && !moderationOperationTerminal(candidate)) {
    return current
  }
  if (!moderationOperationTerminal(current) && moderationOperationTerminal(candidate)) {
    return candidate
  }
  return candidate.updatedAt >= current.updatedAt ? candidate : current
}
