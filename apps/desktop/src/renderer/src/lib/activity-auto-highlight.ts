import type { LiveChatMessage } from '@/lib/backend'

import { commentCanHighlight } from '@/lib/live-chat-view'

// The Activity auto-show policy (plan 156): one switch makes celebrations pop
// onto the stream as the existing highlight card. This module is the pure
// half — what qualifies, what waits, what is too old to still thank — so the
// engine effect in use-studio stays a thin shell. Manual and Buddy cards
// always win; the engine only consults this module when the slot is idle.

/** Celebrations the switch auto-shows (plan 156, D2). Announcements are the
 * streamer's or a mod's own system text, not a viewer celebration, and
 * destination rows and unnamed follower counts have no chat row at all, so
 * none of them are here. */
export const AUTO_SHOW_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  'follow',
  'subscription',
  'membership',
  'cheer',
  'kicks',
  'super-chat',
  'super-sticker',
  'raid',
  'watch-streak',
  // Plan 162: Power-ups are bits. Plan 163: channel point redemptions show
  // too, on the owner's call; AUTO_SHOW_MAX_PENDING keeps a run of them to a
  // rolling sample.
  'power-up',
  'redemption'
])

/** A hype train shows a rolling sample, never a backlog (plan 156, D4). */
export const AUTO_SHOW_MAX_PENDING = 3
/** Older than this at drain time, a thank-you reads stale: drop it. */
export const AUTO_SHOW_MAX_AGE_MS = 30_000

/** Whether this chat row may auto-appear on stream (plan 156, D2). A single
 * gift inside a community gift is skipped: the community notice fires once
 * for the whole bomb, matching how Activity lists it. */
export function activityAutoShowEligible(message: LiveChatMessage): boolean {
  const details = message.details
  if (!details || message.isDeleted) return false
  if (!AUTO_SHOW_ACTIVITY_KINDS.has(details.kind)) return false
  if (
    details.kind === 'subscription' &&
    details.subscription === 'sub-gift' &&
    details.communityGiftId
  ) {
    return false
  }
  return commentCanHighlight(message)
}

export interface AutoShowQueue {
  /** Message ids already considered this session (never re-fired). */
  seen: ReadonlySet<string>
  /** Eligible ids waiting for the slot, oldest first. */
  pending: readonly string[]
}

/** The queue a session (or a mid-stream switch-on) starts from (plan 156,
 * D7): everything already in the snapshot is seen, nothing is pending, so a
 * backlog or History view never replays onto the stream. */
export function seedAutoShowQueue(messages: readonly LiveChatMessage[]): AutoShowQueue {
  return { seen: new Set(messages.map((message) => message.id)), pending: [] }
}

/** Folds newly arrived messages in: every unseen id becomes seen (eligible or
 * not, so scanning stays O(new)), eligible ones join pending, and overflow
 * past AUTO_SHOW_MAX_PENDING drops the OLDEST. Returns the same object when
 * nothing changed, so effects can bail on reference equality. */
export function enqueueAutoShow(
  queue: AutoShowQueue,
  messages: readonly LiveChatMessage[]
): AutoShowQueue {
  let seen: Set<string> | null = null
  let pending: string[] | null = null
  for (const message of messages) {
    if ((seen ?? queue.seen).has(message.id)) continue
    seen ??= new Set(queue.seen)
    seen.add(message.id)
    if (activityAutoShowEligible(message)) {
      pending ??= [...queue.pending]
      pending.push(message.id)
    }
  }
  if (!seen) return queue
  const kept = pending ?? [...queue.pending]
  return { seen, pending: kept.slice(Math.max(0, kept.length - AUTO_SHOW_MAX_PENDING)) }
}

/** Pops the next card to fire: head-first, skipping ids whose message is
 * gone, deleted, or older than AUTO_SHOW_MAX_AGE_MS at drain time. */
export function takeNextAutoShow(
  queue: AutoShowQueue,
  messages: readonly LiveChatMessage[],
  nowMs: number
): { queue: AutoShowQueue; message: LiveChatMessage | null } {
  if (queue.pending.length === 0) return { queue, message: null }
  const byId = new Map(messages.map((message) => [message.id, message]))
  for (let index = 0; index < queue.pending.length; index += 1) {
    const candidate = byId.get(queue.pending[index])
    if (!candidate || !activityAutoShowEligible(candidate)) continue
    const receivedAtMs = Date.parse(candidate.receivedAt)
    if (Number.isFinite(receivedAtMs) && nowMs - receivedAtMs > AUTO_SHOW_MAX_AGE_MS) continue
    return {
      queue: { seen: queue.seen, pending: queue.pending.slice(index + 1) },
      message: candidate
    }
  }
  return { queue: { seen: queue.seen, pending: [] }, message: null }
}
