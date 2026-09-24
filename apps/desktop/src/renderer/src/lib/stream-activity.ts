import type {
  LiveChatEventDetails,
  LiveChatMessage,
  LiveChatSubscriptionKind,
  StreamPlatform
} from '@/lib/backend'

import type { DestinationEvent } from '../../../shared/live-dashboard'

// The Stream Manager's Activity pane (plan 053, D4): a projection of the chat
// snapshot's structured events and the relay's destination events, never of
// chat text. One pure module shared by the live pane, the stats strip and
// History, so the three can never count differently.

export type ActivityKind =
  | 'follow'
  | 'subscription'
  | 'membership'
  | 'cheer'
  | 'super-chat'
  | 'super-sticker'
  | 'raid'
  | 'announcement'
  | 'destination-failed'
  | 'destination-recovered'

/** The pane's filter chips. Announcements show only under All. */
export type ActivityFilter = 'follows' | 'support' | 'tips' | 'raids' | 'destinations'

export const ACTIVITY_FILTERS: readonly { id: ActivityFilter; label: string; title: string }[] = [
  { id: 'follows', label: 'Follows', title: 'New followers' },
  { id: 'support', label: 'Subs', title: 'Subs, gifts and memberships' },
  { id: 'tips', label: 'Tips', title: 'Bits, Super Chats and Super Stickers' },
  { id: 'raids', label: 'Raids', title: 'Raids into your channel' },
  { id: 'destinations', label: 'Destinations', title: 'A destination failed or came back' }
]

export interface ActivityItem {
  id: string
  kind: ActivityKind
  filter: ActivityFilter | null
  platform: StreamPlatform
  /** Who did it: the viewer, the raiding channel, or the destination. */
  name: string
  /** One line: "Resubscribed for 8 months at Tier 1", "Gifted 5 subs". */
  line: string
  /** The viewer's own words, when the event carried any. */
  message?: string
  at: string
  /** The chat row behind it: Show on stream highlights this message. */
  messageId?: string
  authorAvatarUrl?: string
  /** A gifted sub or membership: the row shows the gift glyph. */
  gift?: boolean
}

export interface TipTotal {
  currency: string
  amountMicros: number
}

export interface ActivityTotals {
  follows: number
  /** New and returning subs, members and gifts this stream. */
  supporters: number
  bits: number
  /** Super Chat and Super Sticker, per currency. */
  tips: TipTotal[]
  raids: number
}

const TIER_LABELS: Record<string, string> = {
  '1000': 'Tier 1',
  '2000': 'Tier 2',
  '3000': 'Tier 3'
}

export function subscriptionTierLabel(tier: string | undefined, isPrime: boolean): string {
  if (isPrime) return 'Prime'
  return (tier && TIER_LABELS[tier]) ?? 'a sub'
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

export function formatMicros(amountMicros: number, currency: string): string {
  const amount = amountMicros / 1_000_000
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toLocaleString()} ${currency}`
  }
}

type SubscriptionDetails = Extract<LiveChatEventDetails, { kind: 'subscription' }>
type MembershipDetails = Extract<LiveChatEventDetails, { kind: 'membership' }>

function subscriptionLine(details: SubscriptionDetails): string {
  const tier = subscriptionTierLabel(details.tier, details.isPrime)
  const lines: Record<LiveChatSubscriptionKind, () => string> = {
    sub: () => (details.isPrime ? 'Subscribed with Prime' : `Subscribed at ${tier}`),
    resub: () => {
      const months = details.months ? ` for ${plural(details.months, 'month', 'months')}` : ''
      const at = details.isPrime ? ' with Prime' : ` at ${tier}`
      return `Resubscribed${months}${at}`
    },
    'sub-gift': () =>
      details.recipientName
        ? `Gifted a ${tier} sub to ${details.recipientName}`
        : `Gifted a ${tier} sub`,
    'community-sub-gift': () => `Gifted ${plural(details.giftCount ?? 1, 'sub', 'subs')}`,
    'gift-paid-upgrade': () => 'Continued their gifted sub',
    'prime-paid-upgrade': () => `Upgraded from Prime to ${tier}`,
    'pay-it-forward': () => 'Paid a gifted sub forward'
  }
  return lines[details.subscription]()
}

function membershipLine(details: MembershipDetails): string {
  const level = details.levelName ? ` ${details.levelName}` : ''
  switch (details.membership) {
    case 'new':
      return details.levelName ? `Joined as${level}` : 'Became a member'
    case 'upgrade':
      return details.levelName ? `Upgraded to${level}` : 'Upgraded their membership'
    case 'milestone':
      return details.months
        ? `Member for ${plural(details.months, 'month', 'months')}`
        : 'Membership milestone'
    case 'gift':
      return `Gifted ${plural(details.giftCount ?? 1, 'membership', 'memberships')}`
    case 'gift-received':
      return 'Received a gifted membership'
  }
}

/** Supporters one event adds: a community gift counts its gifts. */
function supportersFrom(details: LiveChatEventDetails): number {
  if (details.kind === 'subscription') {
    return details.subscription === 'community-sub-gift' ? (details.giftCount ?? 1) : 1
  }
  if (details.kind === 'membership') {
    if (details.membership === 'gift') return details.giftCount ?? 1
    // A received gift is already counted on its gifter's row.
    return details.membership === 'gift-received' ? 0 : 1
  }
  return 0
}

function itemFromMessage(message: LiveChatMessage): ActivityItem | null {
  const details = message.details
  if (!details || message.isDeleted) return null
  const base = {
    id: message.id,
    platform: message.platform,
    name: message.authorName,
    at: message.receivedAt,
    messageId: message.id,
    ...(message.authorAvatarUrl ? { authorAvatarUrl: message.authorAvatarUrl } : {})
  }
  // Notices put Twitch's system text in messageText; only a viewer's own
  // words are worth quoting.
  const viewerWords =
    message.eventType === 'paid' || details.kind === 'membership'
      ? message.messageText.trim() || undefined
      : undefined
  switch (details.kind) {
    case 'follow':
      return { ...base, kind: 'follow', filter: 'follows', line: 'Followed' }
    case 'subscription':
      return {
        ...base,
        kind: 'subscription',
        filter: 'support',
        line: subscriptionLine(details),
        ...(details.subscription === 'sub-gift' || details.subscription === 'community-sub-gift'
          ? { gift: true }
          : {})
      }
    case 'membership':
      return {
        ...base,
        kind: 'membership',
        filter: 'support',
        line: membershipLine(details),
        ...(details.membership === 'gift' ? { gift: true } : {}),
        ...(viewerWords ? { message: viewerWords } : {})
      }
    case 'cheer': {
      const words = message.messageText.replace(/\bCheer\d+\b/gi, '').trim()
      return {
        ...base,
        kind: 'cheer',
        filter: 'tips',
        line: `Cheered ${plural(details.bits, 'bit', 'bits')}`,
        ...(words ? { message: words } : {})
      }
    }
    case 'super-chat':
      return {
        ...base,
        kind: 'super-chat',
        filter: 'tips',
        line: `Super Chat · ${details.amountDisplay}`,
        ...(viewerWords ? { message: viewerWords } : {})
      }
    case 'super-sticker':
      return {
        ...base,
        kind: 'super-sticker',
        filter: 'tips',
        line: `Super Sticker · ${details.amountDisplay}`,
        ...(details.altText ? { message: details.altText } : {})
      }
    case 'raid':
      return {
        ...base,
        kind: 'raid',
        filter: 'raids',
        line: `Raided with ${plural(details.viewerCount, 'viewer', 'viewers')}`
      }
    case 'announcement':
      return {
        ...base,
        kind: 'announcement',
        filter: null,
        line: 'Announcement',
        ...(message.messageText.trim() ? { message: message.messageText.trim() } : {})
      }
  }
}

function itemFromDestination(event: DestinationEvent): ActivityItem {
  const failed = event.kind === 'failed'
  return {
    id: `destination:${event.id}`,
    kind: failed ? 'destination-failed' : 'destination-recovered',
    filter: 'destinations',
    platform: event.platform,
    name: event.label,
    line: failed ? 'Destination failed' : 'Back on air',
    ...(failed && event.message ? { message: event.message } : {}),
    at: event.at
  }
}

/**
 * Activity rows, newest first. Twitch sends one notice per single gift inside
 * a community gift as well as the community notice; the singles are dropped
 * when their community notice is present, so a gift of 5 reads once.
 */
export function activityItems(
  messages: readonly LiveChatMessage[],
  destinationEvents: readonly DestinationEvent[] = []
): ActivityItem[] {
  const communityGifts = new Set<string>()
  for (const message of messages) {
    const details = message.details
    if (
      details?.kind === 'subscription' &&
      details.subscription === 'community-sub-gift' &&
      details.communityGiftId
    ) {
      communityGifts.add(details.communityGiftId)
    }
  }
  const items: ActivityItem[] = []
  for (const message of messages) {
    const details = message.details
    if (
      details?.kind === 'subscription' &&
      details.subscription === 'sub-gift' &&
      details.communityGiftId &&
      communityGifts.has(details.communityGiftId)
    ) {
      continue
    }
    const item = itemFromMessage(message)
    if (item) items.push(item)
  }
  for (const event of destinationEvents) items.push(itemFromDestination(event))
  return items.sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
}

export function activityTotals(messages: readonly LiveChatMessage[]): ActivityTotals {
  const totals: ActivityTotals = { follows: 0, supporters: 0, bits: 0, tips: [], raids: 0 }
  const tips = new Map<string, number>()
  const communityGifts = new Set<string>()
  for (const message of messages) {
    const details = message.details
    if (
      details?.kind === 'subscription' &&
      details.subscription === 'community-sub-gift' &&
      details.communityGiftId
    ) {
      communityGifts.add(details.communityGiftId)
    }
  }
  for (const message of messages) {
    const details = message.details
    if (!details || message.isDeleted) continue
    switch (details.kind) {
      case 'follow':
        totals.follows += 1
        break
      case 'subscription':
        if (
          details.subscription === 'sub-gift' &&
          details.communityGiftId &&
          communityGifts.has(details.communityGiftId)
        ) {
          break
        }
        totals.supporters += supportersFrom(details)
        break
      case 'membership':
        totals.supporters += supportersFrom(details)
        break
      case 'cheer':
        totals.bits += details.bits
        break
      case 'super-chat':
      case 'super-sticker':
        tips.set(details.currency, (tips.get(details.currency) ?? 0) + details.amountMicros)
        break
      case 'raid':
        totals.raids += 1
        break
      case 'announcement':
        break
    }
  }
  totals.tips = [...tips.entries()]
    .map(([currency, amountMicros]) => ({ currency, amountMicros }))
    .sort((left, right) => right.amountMicros - left.amountMicros)
  return totals
}

/** "12 follows · 5 subs · 1,500 bits · $42.00", leaving out what is zero. */
export function formatActivitySummary(totals: ActivityTotals): string {
  const parts: string[] = []
  if (totals.follows) parts.push(plural(totals.follows, 'follow', 'follows'))
  if (totals.supporters) parts.push(plural(totals.supporters, 'sub', 'subs'))
  if (totals.bits) parts.push(plural(totals.bits, 'bit', 'bits'))
  for (const tip of totals.tips) parts.push(formatMicros(tip.amountMicros, tip.currency))
  if (totals.raids) parts.push(plural(totals.raids, 'raid', 'raids'))
  return parts.join(' · ')
}

/** Tips as one short value: bits first, then each currency. */
export function formatTipsValue(totals: ActivityTotals): string | null {
  const parts: string[] = []
  if (totals.bits) parts.push(plural(totals.bits, 'bit', 'bits'))
  for (const tip of totals.tips) parts.push(formatMicros(tip.amountMicros, tip.currency))
  return parts.length ? parts.join(' · ') : null
}

export function filterActivity(
  items: readonly ActivityItem[],
  filter: ActivityFilter | 'all',
  platform: StreamPlatform | 'all' = 'all'
): ActivityItem[] {
  return items.filter(
    (item) =>
      (filter === 'all' || item.filter === filter) &&
      (platform === 'all' || item.platform === platform)
  )
}

const CHAT_KINDS = new Set(['message', 'paid'])

/**
 * Chat pace: messages in the last minute and unique chatters this stream.
 * Viewer messages only; notices, follows and moderation rows do not count.
 */
export function chatActivity(
  messages: readonly LiveChatMessage[],
  nowMs: number
): { perMinute: number; chatters: number } {
  const cutoff = nowMs - 60_000
  let perMinute = 0
  const chatters = new Set<string>()
  for (const message of messages) {
    if (!CHAT_KINDS.has(message.eventType) || message.isDeleted) continue
    chatters.add(`${message.platform}:${message.authorId ?? message.authorName}`)
    if (Date.parse(message.receivedAt) >= cutoff) perMinute += 1
  }
  return { perMinute, chatters: chatters.size }
}

/** The action text "Thank in chat" prefills for an activity row. */
export function thankYouDraft(item: ActivityItem): string {
  const name = item.name.startsWith('@') ? item.name : `@${item.name}`
  switch (item.kind) {
    case 'follow':
      return `Thanks for the follow, ${name}!`
    case 'subscription':
    case 'membership':
      return `Thank you for the support, ${name}!`
    case 'cheer':
    case 'super-chat':
    case 'super-sticker':
      return `Thank you so much, ${name}!`
    case 'raid':
      return `Thanks for the raid, ${name}! Welcome in, everyone!`
    case 'announcement':
    case 'destination-failed':
    case 'destination-recovered':
      return ''
  }
}
