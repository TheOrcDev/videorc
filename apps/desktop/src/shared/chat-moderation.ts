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

// --- The Stream Manager relay (plan 140, S6) ---------------------------------------------

/** Every phase, in lifecycle order: the Electron IPC contract admits exactly these. */
export const MODERATION_PHASES = [
  'pending-confirm',
  'cancelled',
  'expired',
  'executing',
  'removed',
  'hidden-locally',
  'failed',
  'delivery-unknown'
] as const satisfies readonly ModerationPhase[]

type MissingModerationPhase = Exclude<ModerationPhase, (typeof MODERATION_PHASES)[number]>
/** Compile-time proof that `MODERATION_PHASES` names every phase. */
export const moderationPhasesComplete: Record<MissingModerationPhase, never> = {}

/**
 * Relay timing for `liveChat.moderation.*` from the Stream Manager. A manual
 * removal answers once it is done: up to two provider attempts of 8 s each,
 * a token refresh and the local tombstone. Studio gives the backend request
 * 24 s, then a 2 s look at the ledger for a lost reply; main keeps 6 s more
 * for renderer scheduling and IPC, like the chat-send relay.
 */
export const COMMENTS_MODERATION_TIMING_CONTRACT = Object.freeze({
  backendRequestMs: 24_000,
  reconciliationMs: 2_000,
  rendererIpcMarginMs: 6_000
})

export const COMMENTS_MODERATION_RELAY_TIMEOUT_MS = Object.values(
  COMMENTS_MODERATION_TIMING_CONTRACT
).reduce((total, durationMs) => total + durationMs, 0)

/** How many of a session's removals ride in the Stream Manager's snapshot. */
export const MAX_RELAYED_MODERATION_OPERATIONS = 100

/**
 * Whether "Remove from chat" applies to a row: a viewer's chat or paid
 * message that still exists. Never a notification row (Twitch's
 * `channel.chat.notification`), a tombstone, or the streamer's own message.
 * Mirrors `eligibility` in `live_chat_moderation.rs`; the backend re-checks
 * everything, so this only decides what the menu offers.
 */
export function chatMessageRemovable(
  message: Pick<LiveChatMessage, 'eventType' | 'isDeleted' | 'authorRoles' | 'rawProviderType'>
): boolean {
  if (message.isDeleted || message.eventType === 'deleted') return false
  if (message.eventType !== 'message' && message.eventType !== 'paid') return false
  if (message.rawProviderType?.startsWith('channel.chat.notification')) return false
  return !message.authorRoles.some((role) => {
    const normalized = role.trim().toLowerCase()
    return normalized === 'owner' || normalized === 'broadcaster'
  })
}

function timeOf(iso: string): number {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? time : 0
}

/** Newest first by creation, then by the last change, then stable on the id. */
function newestFirst(left: ModerationOperation, right: ModerationOperation): number {
  return (
    timeOf(right.createdAt) - timeOf(left.createdAt) ||
    timeOf(right.updatedAt) - timeOf(left.updatedAt) ||
    left.operationId.localeCompare(right.operationId)
  )
}

/**
 * The share of a session's removals the Stream Manager holds: only that
 * session's, every open one first (a card or a "Removing…" row must never
 * fall off), then the newest finished ones, at most 100.
 */
export function relayedModerationOperations(
  operations: Iterable<ModerationOperation>,
  sessionId: string | null | undefined
): ModerationOperation[] {
  if (!sessionId) return []
  const own = [...operations].filter((operation) => operation.sessionId === sessionId)
  const open = own.filter((operation) => !moderationOperationTerminal(operation))
  const done = own.filter(moderationOperationTerminal)
  return [...open.sort(newestFirst), ...done.sort(newestFirst)].slice(
    0,
    MAX_RELAYED_MODERATION_OPERATIONS
  )
}

/** Fold updates into a list, one row per operation id (`reconcileModerationOperation`). */
export function mergeModerationOperations(
  current: readonly ModerationOperation[],
  incoming: readonly ModerationOperation[]
): ModerationOperation[] {
  const byId = new Map(current.map((operation) => [operation.operationId, operation]))
  for (const operation of incoming) {
    byId.set(
      operation.operationId,
      reconcileModerationOperation(byId.get(operation.operationId), operation)
    )
  }
  return [...byId.values()]
}

/** Each message's newest removal: what its row shows. */
export function latestModerationOperationByMessage(
  operations: readonly ModerationOperation[]
): Map<string, ModerationOperation> {
  const latest = new Map<string, ModerationOperation>()
  for (const operation of operations) {
    const current = latest.get(operation.messageId)
    if (!current || newestFirst(operation, current) < 0) latest.set(operation.messageId, operation)
  }
  return latest
}

/**
 * Main's cache of the live session's removals after a Studio snapshot push:
 * a push that carries the list replaces it (scoped and bounded), a push
 * without it keeps the cache, and a new session drops it.
 */
export function nextRelayedModerationOperations(
  current: ModerationOperation[] | undefined,
  pushed: readonly ModerationOperation[] | undefined,
  sessionId: string | undefined,
  sessionChanged: boolean
): ModerationOperation[] | undefined {
  if (pushed !== undefined) return relayedModerationOperations(pushed, sessionId)
  return sessionChanged ? undefined : current
}
