import type {
  AudienceSnapshot,
  LiveChatEventDetails,
  LiveChatMessage,
  LiveChatSubscriptionKind,
  StreamPlatform
} from '@/lib/backend'

import type { DestinationEvent } from '../../../shared/live-dashboard'

// The Stream Manager's Activity pane (plan 055, D4): a projection of the chat
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
  /** The sentence: "Resubscribed for 8 months at Tier 1". Viewers read it on
   * the stream's highlight card, and Copy and the row's tooltip use it. */
  line: string
  /** The fact at a glance, for the pane (plan 057, D3): "Resub · 8 months". */
  short: string
  /** The viewer's own words, when the event carried any. */
  message?: string
  at: string
  /** The chat row behind it: Show on stream highlights this message. */
  messageId?: string
  authorAvatarUrl?: string
  /** A gifted sub or membership: the row shows the gift glyph. */
  gift?: boolean
  /** Follows the platform counted but never named (X, or Twitch without
   * the follow scope): the row thanks everyone instead of one viewer. */
  unnamed?: boolean
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

/** Tier 2 and 3 are worth naming at a glance; Tier 1 is the default. */
function notableTier(details: SubscriptionDetails): string | null {
  if (details.isPrime) return 'Prime'
  return details.tier && details.tier !== '1000' ? (TIER_LABELS[details.tier] ?? null) : null
}

function subscriptionShort(details: SubscriptionDetails): string {
  const tier = notableTier(details)
  const suffix = tier ? ` · ${tier}` : ''
  switch (details.subscription) {
    case 'sub':
      return details.isPrime ? 'Prime sub' : `New sub${suffix}`
    case 'resub':
      return `Resub${details.months ? ` · ${plural(details.months, 'month', 'months')}` : ''}${suffix}`
    case 'sub-gift':
      return details.recipientName ? `Gift sub → ${details.recipientName}` : 'Gift sub'
    case 'community-sub-gift':
      return `Gifted ${plural(details.giftCount ?? 1, 'sub', 'subs')}`
    case 'gift-paid-upgrade':
      return 'Kept a gift sub'
    case 'prime-paid-upgrade':
      return `Prime → ${subscriptionTierLabel(details.tier, false)}`
    case 'pay-it-forward':
      return 'Paid it forward'
  }
}

function membershipShort(details: MembershipDetails): string {
  switch (details.membership) {
    case 'new':
      return details.levelName ? `Member · ${details.levelName}` : 'New member'
    case 'upgrade':
      return details.levelName ? `Upgraded · ${details.levelName}` : 'Upgraded'
    case 'milestone':
      return details.months
        ? `Member · ${plural(details.months, 'month', 'months')}`
        : 'Member milestone'
    case 'gift':
      return `Gifted ${plural(details.giftCount ?? 1, 'membership', 'memberships')}`
    case 'gift-received':
      return 'Gift membership'
  }
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
      return { ...base, kind: 'follow', filter: 'follows', line: 'Followed', short: 'Follow' }
    case 'subscription':
      return {
        ...base,
        kind: 'subscription',
        filter: 'support',
        line: subscriptionLine(details),
        short: subscriptionShort(details),
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
        short: membershipShort(details),
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
        short: plural(details.bits, 'bit', 'bits'),
        ...(words ? { message: words } : {})
      }
    }
    case 'super-chat':
      return {
        ...base,
        kind: 'super-chat',
        filter: 'tips',
        line: `Super Chat · ${details.amountDisplay}`,
        short: `${details.amountDisplay} Super Chat`,
        ...(viewerWords ? { message: viewerWords } : {})
      }
    case 'super-sticker':
      return {
        ...base,
        kind: 'super-sticker',
        filter: 'tips',
        line: `Super Sticker · ${details.amountDisplay}`,
        short: `${details.amountDisplay} Super Sticker`,
        ...(details.altText ? { message: details.altText } : {})
      }
    case 'raid':
      return {
        ...base,
        kind: 'raid',
        filter: 'raids',
        line: `Raided with ${plural(details.viewerCount, 'viewer', 'viewers')}`,
        short: `Raid · ${plural(details.viewerCount, 'viewer', 'viewers')}`
      }
    case 'announcement':
      return {
        ...base,
        kind: 'announcement',
        filter: null,
        line: 'Announcement',
        short: 'Announcement',
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
    short: failed ? 'Failed' : 'Back on air',
    ...(failed && event.message ? { message: event.message } : {}),
    at: event.at
  }
}

/**
 * Follows only a follower total can show: X never names followers, and
 * Twitch names them only with the opt-in `moderator:read:followers` scope,
 * which sends real follow rows instead (so those gains are skipped).
 */
function itemsFromFollowerGains(audience: AudienceSnapshot | null | undefined): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const entry of audience?.platforms ?? []) {
    // Kick sends named follow rows and never a total, so it has no gains.
    const named =
      (entry.platform === 'twitch' && entry.audienceScopes === true) || entry.platform === 'kick'
    if (named || entry.metric !== 'followers') continue
    for (const gain of entry.followerGains ?? []) {
      items.push({
        id: `follower-gain:${entry.platform}:${gain.at}`,
        kind: 'follow',
        filter: 'follows',
        platform: entry.platform,
        name: gain.count === 1 ? 'New follower' : `${gain.count.toLocaleString()} new followers`,
        line: `${plural(gain.count, 'new follower', 'new followers')}. ${
          entry.platform === 'x'
            ? "X doesn't share who followed."
            : 'Reconnect Twitch in Livestream → Setup to see who followed.'
        }`,
        short: '',
        at: gain.at,
        unnamed: true
      })
    }
  }
  return items
}

/**
 * Activity rows, newest first. Twitch sends one notice per single gift inside
 * a community gift as well as the community notice; the singles are dropped
 * when their community notice is present, so a gift of 5 reads once.
 */
export function activityItems(
  messages: readonly LiveChatMessage[],
  destinationEvents: readonly DestinationEvent[] = [],
  audience?: AudienceSnapshot | null
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
  items.push(...itemsFromFollowerGains(audience))
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

/** How many rows each filter chip would show (plan 057, D3). */
export function activityFilterCounts(
  items: readonly ActivityItem[]
): Record<ActivityFilter, number> {
  const counts: Record<ActivityFilter, number> = {
    follows: 0,
    support: 0,
    tips: 0,
    raids: 0,
    destinations: 0
  }
  for (const item of items) {
    if (item.filter) counts[item.filter] += 1
  }
  return counts
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
  if (item.unnamed) return 'Thanks for the follows, and welcome in!'
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
