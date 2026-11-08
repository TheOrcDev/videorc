import type {
  CommunityPerson,
  LiveChatMessage,
  CommunityPersonRow,
  CommunitySupport,
  CommunitySummary,
  StreamPlatform,
  ViewerArrival,
  ViewerMilestone
} from '@/lib/backend'
import { platformLabel } from '@/lib/platform-copy'

// Know your viewers (plan 225): the words every community surface shows,
// as pure functions over the wire shapes. No React, no fetch: a chat row's
// chip is rendered from `message.arrival` alone (D11, D14).

/** "1st", "2nd", "3rd", "10th", "11th", "22nd". */
export function ordinal(value: number): string {
  const n = Math.max(0, Math.round(value))
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/** Weeks under 8, then months (D7). Short: "3 wk" / "3 mo"; long: "3 weeks". */
export function awayLabel(days: number, form: 'short' | 'long'): string {
  const weeks = Math.max(1, Math.floor(days / 7))
  if (weeks < 8) {
    if (form === 'short') return `${weeks} wk`
    return weeks === 1 ? '1 week' : `${weeks} weeks`
  }
  const months = Math.max(2, Math.floor(days / 30))
  if (form === 'short') return `${months} mo`
  return `${months} months`
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

/** "2026-03" or an RFC 3339 time → "March 2026"; null when unreadable. */
export function sinceLabel(value: string | undefined): string | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})/.exec(value)
  if (!match) return null
  const month = MONTHS[Number(match[2]) - 1]
  return month ? `${month} ${match[1]}` : null
}

/** A milestone in a few words: "10th stream", "5 in a row", "1 year". */
export function milestoneLabel(milestone: ViewerMilestone): string {
  switch (milestone.kind) {
    case 'streams':
      return `${ordinal(milestone.value)} stream`
    case 'row':
      return `${milestone.value} in a row`
    case 'anniversary':
      return '1 year'
  }
}

export type ArrivalChipKind = 'milestone' | 'back' | 'regular'

export interface ArrivalChip {
  kind: ArrivalChipKind
  /** The chip's words: "10th stream", "Back · 3 wk", "Regular · 14". */
  label: string
  /** The hover line: "14 streams · since March 2026 · Twitch · YouTube". */
  hint: string
}

/** The platforms as words, joined: "Twitch · YouTube". */
export function platformsLine(platforms: readonly StreamPlatform[] | undefined): string {
  return (platforms ?? []).map((platform) => platformLabel(platform)).join(' · ')
}

/**
 * The one chip an arrival row carries (D11), in priority order: the
 * milestone, then Back, then Regular. A returning person who is none of the
 * three gets no chip: the row stays quiet.
 */
export function arrivalChip(arrival: ViewerArrival | undefined): ArrivalChip | null {
  if (!arrival) return null
  const parts = [arrival.streams === 1 ? '1 stream' : `${arrival.streams.toLocaleString()} streams`]
  const since = sinceLabel(arrival.since)
  if (since) parts.push(`since ${since}`)
  const platforms = platformsLine(arrival.platforms)
  if (platforms) parts.push(platforms)
  const hint = parts.join(' · ')
  if (arrival.milestone) {
    return { kind: 'milestone', label: milestoneLabel(arrival.milestone), hint }
  }
  if (arrival.awayDays !== undefined) {
    return { kind: 'back', label: `Back · ${awayLabel(arrival.awayDays, 'short')}`, hint }
  }
  if (arrival.regular) {
    return { kind: 'regular', label: `Regular · ${arrival.streams.toLocaleString()}`, hint }
  }
  return null
}

/** The card's stats line: "14 streams · since March 2026 · 5 in a row · 812 messages". */
export function personStatsLine(
  person: Pick<CommunityPerson, 'streams' | 'firstSeenAt' | 'inARow' | 'messages'>
): string {
  const parts = [person.streams === 1 ? '1 stream' : `${person.streams.toLocaleString()} streams`]
  const since = sinceLabel(person.firstSeenAt)
  if (since) parts.push(`since ${since}`)
  if (person.inARow >= 2) parts.push(`${person.inARow} in a row`)
  parts.push(person.messages === 1 ? '1 message' : `${person.messages.toLocaleString()} messages`)
  return parts.join(' · ')
}

const TIP_FORMAT_CACHE = new Map<string, Intl.NumberFormat>()

function formatTip(currency: string, micros: number): string {
  const amount = micros / 1_000_000
  try {
    let format = TIP_FORMAT_CACHE.get(currency)
    if (!format) {
      format = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        maximumFractionDigits: 2
      })
      TIP_FORMAT_CACHE.set(currency, format)
    }
    return format.format(amount)
  } catch {
    return `${amount.toLocaleString()} ${currency}`
  }
}

/** The support line: "4,500 bits · 3 gifted subs · $20.00"; null when none. */
export function supportLine(support: CommunitySupport | undefined): string | null {
  if (!support) return null
  const parts: string[] = []
  if (support.bits) parts.push(`${support.bits.toLocaleString()} bits`)
  if (support.kicks) parts.push(`${support.kicks.toLocaleString()} KICKs`)
  if (support.giftedSubs) {
    parts.push(
      support.giftedSubs === 1
        ? '1 gifted sub'
        : `${support.giftedSubs.toLocaleString()} gifted subs`
    )
  }
  if (support.subMonths) {
    parts.push(
      support.subMonths === 1 ? '1 month subscribed' : `${support.subMonths} months subscribed`
    )
  }
  for (const [currency, micros] of Object.entries(support.tips ?? {})) {
    if (micros > 0) parts.push(formatTip(currency, micros))
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The YouTube retention line (D3), word for word. */
export const YOUTUBE_RETENTION_LINE =
  "YouTube viewers are remembered for 30 days after they chat (YouTube's rules)."

/** Why "Buddy remembers" is locked without Premium (D6). */
export const BUDDY_REMEMBERS_LOCK_REASON =
  'Buddy remembers what your regulars tell it with Premium.'

/** Why the manual link refuses an X account (D4 a). */
export const X_SELF_LINK_REASON = 'X viewers link themselves with !link'

/** The person may be linked by hand: never an X account (D4). */
export function personHasX(person: Pick<CommunityPerson, 'accounts'>): boolean {
  return person.accounts.some((account) => account.platform === 'x')
}

export function rowHasX(row: Pick<CommunityPersonRow, 'platforms'>): boolean {
  return row.platforms.includes('x')
}

/** "Forget Ada…": the confirm's title and its one sentence (D13). */
export function forgetCopy(name: string): { title: string; description: string; confirm: string } {
  return {
    title: `Forget ${name}?`,
    description: `Videorc deletes what it remembers about ${name} on this computer and never learns it again, unless ${name} types !rememberme.`,
    confirm: `Forget ${name}`
  }
}

/**
 * The Community header (D12): "Videorc knows 312 people from your 41
 * streams on this computer. 18 are regulars.", or the line before the first
 * stream.
 */
export function communityHeaderLine(summary: CommunitySummary | null): string {
  if (!summary || summary.people === 0) {
    return 'Videorc starts remembering your chat from your next stream.'
  }
  const people = summary.people === 1 ? '1 person' : `${summary.people.toLocaleString()} people`
  const streams =
    summary.streams === 1 ? 'your 1 stream' : `your ${summary.streams.toLocaleString()} streams`
  const regulars =
    summary.regulars === 1
      ? '1 is a regular.'
      : `${summary.regulars.toLocaleString()} are regulars.`
  return `Videorc knows ${people} from ${streams} on this computer. ${regulars}`
}

/** "Reading your past streams… 12 of 41"; null when the backfill is not running. */
export function backfillLine(summary: CommunitySummary | null): string | null {
  if (!summary || summary.backfill.state !== 'running') return null
  const { done, total } = summary.backfill
  return total > 0
    ? `Reading your past streams… ${done.toLocaleString()} of ${total.toLocaleString()}`
    : 'Reading your past streams…'
}

/** The People row's context: "14 streams · last Friday" style, short. */
export function personRowContext(row: CommunityPersonRow, nowMs: number): string {
  const streams = row.streams === 1 ? '1 stream' : `${row.streams.toLocaleString()} streams`
  const last = row.lastSeenAt ? lastChatLabel(row.lastSeenAt, nowMs) : null
  return last ? `${streams} · ${last}` : streams
}

/** "today", "yesterday", "3 days ago", "3 weeks ago", "Mar 2026". */
export function lastChatLabel(iso: string, nowMs: number): string | null {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const days = Math.floor(Math.max(0, nowMs - at) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  return sinceLabel(new Date(at).toISOString()) ?? null
}

/** The disclosure line for the channel description (H2), with Copy. */
export const COMMUNITY_DISCLOSURE_LINE =
  'Videorc remembers regulars so Buddy can greet you. Type !forgetme in chat anytime and it forgets you. Type !link word in two of my chats to be one person.'

/** A link event in the person dialog's history. */
export function linkEventLabel(kind: 'self' | 'manual' | 'split' | 'suggestion-accepted'): string {
  switch (kind) {
    case 'self':
      return 'Linked with !link'
    case 'manual':
      return 'Linked by you'
    case 'split':
      return 'Split off'
    case 'suggestion-accepted':
      return 'Linked from a suggestion'
  }
}

/** Platforms whose chat carries an author id Videorc can remember (D1). */
const IDENTITY_PLATFORMS: ReadonlySet<StreamPlatform> = new Set(['youtube', 'twitch', 'kick', 'x'])

/**
 * The person a chat row is about, for "About {name}" and the right-click
 * menu (D11): only a viewer's row with an author id on a platform with
 * identity, never the streamer's own (the streamer is never a person, D1).
 */
export function chatRowPerson(
  message: Pick<
    LiveChatMessage,
    'platform' | 'authorId' | 'authorName' | 'authorRoles' | 'eventType'
  >
): { platform: StreamPlatform; authorId: string; name: string } | null {
  const authorId = message.authorId?.trim()
  if (!authorId || !IDENTITY_PLATFORMS.has(message.platform)) return null
  if (message.eventType === 'system' || message.eventType === 'moderation') return null
  if (
    message.authorRoles.some((role) => {
      const value = role.trim().toLowerCase()
      return value === 'owner' || value === 'broadcaster'
    })
  ) {
    return null
  }
  return { platform: message.platform, authorId, name: message.authorName.trim() || 'this viewer' }
}
