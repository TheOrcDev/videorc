import type {
  AudienceSnapshot,
  CommentsHistoryStats,
  LiveChatMessage,
  LiveChatProviderState,
  PlatformAudience,
  StreamPlatform,
  ViewerSample,
  SessionChatTotals
} from '@/lib/backend'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
import { chatActivity, type ActivityTotals } from '@/lib/stream-activity'
import { formatViewerCount, viewerSampleStale } from '@/lib/viewer-count-view'

import type { LiveDashboardState } from '../../../shared/live-dashboard'

// The Stream Manager's stats bar (plan 057, D1), as pure item models. A stat
// exists only when its source exists for this session, and a value is never
// a zero nobody measured: a platform that cannot report says why on hover.

export type StatId = 'session' | 'viewers' | 'followers' | 'supporters' | 'tips' | 'chat'

export type StatTone = 'neutral' | 'subtle' | 'good' | 'warning' | 'error'
export type SessionBadge = 'live' | 'recording' | 'off-air' | 'history'

/** One row of a stat's hover card. */
export interface StatDetailRow {
  label: string
  value: string
  platform?: StreamPlatform
  note?: string
}

export interface StatItemModel {
  id: StatId
  /** The hover card's heading: "Viewers", "Followers". */
  label: string
  /** What the bar shows: the number, or the problem when there is one. */
  value: string
  /** A short muted word after the value: "followers", "subs", "peak". */
  unit?: string
  /** A signed change after the value: "+83". */
  delta?: string
  tone: StatTone
  /** Session only. */
  badge?: SessionBadge
  /** Sparkline points, oldest first. */
  spark?: number[]
  details: StatDetailRow[]
  /** The whole reading in words: the screen reader label and the tooltip. */
  description: string
}

export interface StatsInput {
  /** The actual view owner, which may advance before the dashboard relay. */
  sessionId?: string | null
  dashboard: LiveDashboardState | null
  /** The live chip's sample, when the dashboard has not been relayed yet. */
  viewerSample: ViewerSample | null
  messages: readonly LiveChatMessage[]
  providers: readonly LiveChatProviderState[]
  nowMs: number
  history?: { stats?: CommentsHistoryStats; sessionId?: string; startedAt: string; title: string }
}

function confirmedTotals(input: StatsInput): SessionChatTotals | null {
  const totals = input.history ? input.history.stats?.chatTotals : input.dashboard?.chatTotals
  const owner =
    input.sessionId !== undefined
      ? input.sessionId
      : (input.history?.sessionId ?? input.dashboard?.sessionId)
  return totals && totals.sessionId === owner ? totals : null
}

function missingTotal(id: 'supporters' | 'tips', input: StatsInput): StatItemModel {
  const reason =
    confirmedTotals(input)?.status === 'legacy-unavailable'
      ? 'This earlier session has no complete total.'
      : 'Session total not available yet.'
  return {
    id,
    label: id === 'supporters' ? 'Supporters this stream' : 'Tips this stream',
    value: '–',
    tone: 'subtle',
    details: [{ label: 'This stream', value: 'Not available', note: reason }],
    description: reason
  }
}

/** The bar's order when the streamer has not rearranged it (plan 057, D2). */
export const DEFAULT_STAT_ORDER: readonly StatId[] = [
  'session',
  'viewers',
  'followers',
  'supporters',
  'tips',
  'chat'
]

const TIP_PLATFORMS = new Set<StreamPlatform>(['twitch', 'youtube'])
const VIEWER_PLATFORMS = new Set<StreamPlatform>(['twitch', 'youtube', 'kick', 'x'])

export function formatClock(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

function signed(delta: number): string {
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString()}`
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

/** "$20" for a whole amount, "$4.99" otherwise. */
export function formatMoneyShort(amountMicros: number, currency: string): string {
  const amount = amountMicros / 1_000_000
  const whole = amountMicros % 1_000_000 === 0
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {})
    }).format(amount)
  } catch {
    return `${amount.toLocaleString()} ${currency}`
  }
}

function timeOfDay(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function sessionItem(input: StatsInput): StatItemModel {
  const session = input.dashboard?.session
  if (input.history) {
    const started = new Date(input.history.startedAt)
    const date = Number.isNaN(started.getTime())
      ? 'History'
      : started.toLocaleDateString([], { month: 'short', day: 'numeric' })
    return {
      id: 'session',
      label: 'Session',
      value: date,
      tone: 'neutral',
      badge: 'history',
      details: [{ label: 'Title', value: input.history.title }],
      description: `History: ${input.history.title}, ${date}`
    }
  }
  if (session && session.state !== 'off-air' && session.startedAt) {
    const clock = formatClock(input.nowMs - Date.parse(session.startedAt))
    const live = session.state === 'live'
    return {
      id: 'session',
      label: 'Session',
      value: clock,
      tone: 'neutral',
      badge: live ? 'live' : 'recording',
      details: [{ label: 'Started', value: timeOfDay(session.startedAt) }],
      description: `${live ? 'On air' : 'Recording'} for ${clock}`
    }
  }
  return {
    id: 'session',
    label: 'Session',
    value: 'Off air',
    tone: 'subtle',
    badge: 'off-air',
    details: [],
    description: 'Off air'
  }
}

function viewersItem(input: StatsInput, livePlatforms: ReadonlySet<StreamPlatform>) {
  const viewers = input.dashboard?.viewers
  const latest = viewers?.latest ?? input.viewerSample
  const history = viewers?.history ?? []
  if (input.history) {
    const samples = input.history.stats?.viewers ?? []
    if (samples.length === 0) return null
    const peak = Math.max(...samples.map((sample) => sample.total))
    const average = Math.round(
      samples.reduce((sum, sample) => sum + sample.total, 0) / samples.length
    )
    return {
      id: 'viewers',
      label: 'Viewers',
      value: formatViewerCount(peak),
      unit: 'peak',
      tone: 'neutral',
      spark: samples.map((sample) => sample.total),
      details: [
        { label: 'Peak', value: formatViewerCount(peak) },
        { label: 'Average', value: formatViewerCount(average) }
      ],
      description: `Peak ${formatViewerCount(peak)} viewers, average ${formatViewerCount(average)}`
    } satisfies StatItemModel
  }
  const live = input.dashboard?.session.state === 'live'
  const canCount = [...livePlatforms].some((platform) => VIEWER_PLATFORMS.has(platform))
  // While live the count holds its place (plan 047: never hidden while live),
  // as "–" until the first platform reports.
  if (!latest && history.length === 0 && !(live && canCount)) return null
  const peak = viewers?.peak ?? latest?.total ?? null
  const stale = !latest || viewerSampleStale(latest, input.nowMs)
  const count = latest ? formatViewerCount(latest.total) : '–'
  // A live platform with no count yet says so instead of vanishing: Kick
  // reports nothing until it marks the stream live (plan 066).
  const reported = new Set((latest?.platforms ?? []).map((entry) => entry.platform))
  const waiting = live
    ? [...livePlatforms].filter(
        (platform) => VIEWER_PLATFORMS.has(platform) && !reported.has(platform)
      )
    : []
  return {
    id: 'viewers',
    label: 'Viewers',
    value: count,
    tone: stale ? 'subtle' : 'neutral',
    spark: history.map((point) => point.total),
    details: [
      ...(latest?.platforms ?? []).map((entry) => ({
        label: CHAT_PLATFORM_LABELS[entry.platform],
        value: formatViewerCount(entry.count),
        platform: entry.platform
      })),
      ...waiting.map((platform) => ({
        label: CHAT_PLATFORM_LABELS[platform],
        value: 'waiting',
        platform
      })),
      ...(peak !== null ? [{ label: 'Peak', value: formatViewerCount(peak) }] : []),
      ...(latest && stale ? [{ label: 'Updated', value: 'over a minute ago' }] : [])
    ],
    description: latest
      ? `${count} viewers${peak !== null ? `, peak ${formatViewerCount(peak)}` : ''}`
      : 'No viewer count yet'
  } satisfies StatItemModel
}

const METRIC_LABELS: Record<PlatformAudience['metric'], string> = {
  followers: 'followers',
  subscribers: 'subscribers'
}

function audienceNote(entry: PlatformAudience): string | undefined {
  switch (entry.capability) {
    case 'pending':
      return 'Reading…'
    case 'hidden':
      return 'Hidden by the channel'
    case 'needs-reconnect':
    case 'unavailable':
      return entry.message
    case 'available':
      return entry.delta ? `${signed(entry.delta)} this stream` : undefined
    case 'delta-only':
      return `New follows only: ${plural(entry.delta ?? 0, 'new follower', 'new followers')} this stream`
  }
}

function followersItem(audience: AudienceSnapshot | null): StatItemModel | null {
  const platforms = audience?.platforms ?? []
  const reporting = platforms.filter((entry) => entry.capability !== 'unavailable')
  if (reporting.length === 0) return null
  const available = reporting.filter(
    (entry) => entry.capability === 'available' && entry.total !== undefined
  )
  // Kick reports follow events, not a total (plan 063 S6).
  const deltaOnly = reporting.filter((entry) => entry.capability === 'delta-only')
  const newFollows = deltaOnly.reduce((sum, entry) => sum + (entry.delta ?? 0), 0)
  const total = available.reduce((sum, entry) => sum + (entry.total ?? 0), 0)
  const delta = available.reduce((sum, entry) => sum + (entry.delta ?? 0), 0) + newFollows
  const pending = reporting.every((entry) => entry.capability === 'pending')
  const blocked = reporting.find((entry) => entry.capability === 'needs-reconnect')
  const details = platforms.map((entry) => {
    const note = audienceNote(entry)
    return {
      label: `${CHAT_PLATFORM_LABELS[entry.platform]} ${METRIC_LABELS[entry.metric]}`,
      value: entry.total !== undefined ? entry.total.toLocaleString() : '–',
      platform: entry.platform,
      ...(note ? { note } : {})
    }
  })
  if (available.length === 0 && deltaOnly.length > 0) {
    return {
      id: 'followers',
      label: 'New followers',
      value: newFollows.toLocaleString(),
      unit: newFollows === 1 ? 'new follower' : 'new followers',
      tone: newFollows ? 'neutral' : 'subtle',
      details,
      description: `${plural(newFollows, 'new follower', 'new followers')} this stream`
    }
  }
  if (available.length === 0) {
    const reason = blocked?.message ?? (pending ? 'Reading…' : 'Not shared')
    return {
      id: 'followers',
      label: 'Followers',
      value: pending ? '…' : '–',
      unit: 'followers',
      tone: 'subtle',
      details,
      description: `Followers: ${reason}`
    }
  }
  return {
    id: 'followers',
    label: 'Followers',
    value: total.toLocaleString(),
    unit: 'followers',
    ...(delta !== 0 ? { delta: signed(delta) } : {}),
    tone: 'neutral',
    details,
    description: `${plural(total, 'follower', 'followers')}${delta !== 0 ? `, ${signed(delta)} this stream` : ''}`
  }
}

/** Subs on Twitch, members on YouTube, supporters when both are live. */
export function supportersUnit(platforms: ReadonlySet<StreamPlatform>, count: number): string {
  const twitch = platforms.has('twitch')
  const youtube = platforms.has('youtube')
  if (youtube && !twitch) return count === 1 ? 'member' : 'members'
  if (youtube && twitch) return count === 1 ? 'supporter' : 'supporters'
  return count === 1 ? 'sub' : 'subs'
}

function supportersItem(
  totals: ActivityTotals,
  platforms: ReadonlySet<StreamPlatform>,
  audience: AudienceSnapshot | null
): StatItemModel {
  const twitch = audience?.platforms.find((entry) => entry.platform === 'twitch')
  const unit = supportersUnit(platforms, totals.supporters)
  return {
    id: 'supporters',
    label: 'Supporters this stream',
    value: totals.supporters.toLocaleString(),
    unit,
    tone: totals.supporters ? 'neutral' : 'subtle',
    details: [
      { label: 'New this stream', value: totals.supporters.toLocaleString() },
      ...(twitch?.subscribers !== undefined
        ? [
            { label: 'Twitch subs', value: twitch.subscribers.toLocaleString() },
            { label: 'Sub points', value: (twitch.subscriberPoints ?? 0).toLocaleString() }
          ]
        : [])
    ],
    description: `${totals.supporters.toLocaleString()} new ${unit} this stream`
  }
}

function tipsItem(totals: ActivityTotals): StatItemModel {
  const parts = [
    ...totals.tips.map((tip) => formatMoneyShort(tip.amountMicros, tip.currency)),
    ...(totals.bits ? [plural(totals.bits, 'bit', 'bits')] : [])
  ]
  const none = parts.length === 0
  return {
    id: 'tips',
    label: 'Tips this stream',
    value: none ? '0' : parts.join(' · '),
    ...(none ? { unit: 'tips' } : {}),
    tone: none ? 'subtle' : 'neutral',
    details: [
      ...totals.tips.map((tip) => ({
        label: `Super Chats (${tip.currency})`,
        value: formatMoneyShort(tip.amountMicros, tip.currency)
      })),
      ...(totals.bits ? [{ label: 'Bits', value: totals.bits.toLocaleString() }] : [])
    ],
    description: none ? 'No tips yet this stream' : `Tips this stream: ${parts.join(', ')}`
  }
}

function chatItem(input: StatsInput): StatItemModel {
  const pace = chatActivity(input.messages, input.nowMs)
  const confirmed = confirmedTotals(input)
  const totals = confirmed?.status === 'available' ? confirmed : null
  const chatters = { label: 'Chatters', value: totals ? totals.chatters.toLocaleString() : '–' }
  if (input.history) {
    const count = totals?.messageCount
    return {
      id: 'chat',
      label: 'Chat',
      value: count === undefined ? '–' : count.toLocaleString(),
      unit: count === 1 ? 'message' : 'messages',
      tone: 'neutral',
      details: [chatters],
      description: totals
        ? `${plural(totals.messageCount, 'message', 'messages')}, ${plural(totals.chatters, 'chatter', 'chatters')}`
        : 'Session chat total not available'
    }
  }
  return {
    id: 'chat',
    label: 'Chat',
    value: pace.perMinute.toLocaleString(),
    unit: 'msg/min',
    tone: 'neutral',
    details: [
      { label: 'Messages in the last minute', value: pace.perMinute.toLocaleString() },
      chatters
    ],
    description: `${plural(pace.perMinute, 'message', 'messages')} a minute${totals ? `, ${plural(totals.chatters, 'chatter', 'chatters')}` : ', session chatters not available'}`
  }
}

/** Every stat this session can show, in the default order. */
export function statItems(input: StatsInput): StatItemModel[] {
  const dashboard = input.history ? null : input.dashboard
  const confirmed = confirmedTotals(input)
  const totals = confirmed?.status === 'available' ? confirmed : null
  // Tips and subs are only measured where chat is read; viewers can come
  // from any destination with a viewer API.
  const chatPlatforms = new Set<StreamPlatform>([
    ...input.providers.map((provider) => provider.platform),
    ...input.messages.map((message) => message.platform),
    ...(totals?.platforms ?? [])
  ])
  const livePlatforms = new Set<StreamPlatform>([
    ...chatPlatforms,
    ...(dashboard?.targets ?? []).map((target) => target.platform)
  ])
  const items: (StatItemModel | null)[] = [
    sessionItem(input),
    viewersItem(input, livePlatforms),
    followersItem(
      input.history ? (input.history.stats?.audience ?? null) : (dashboard?.audience ?? null)
    )
  ]
  if ([...chatPlatforms].some((platform) => TIP_PLATFORMS.has(platform))) {
    items.push(
      totals
        ? supportersItem(totals, chatPlatforms, dashboard?.audience ?? null)
        : missingTotal('supporters', input),
      totals ? tipsItem(totals) : missingTotal('tips', input)
    )
  }
  if (input.providers.length > 0 || input.messages.length > 0 || (totals?.messageCount ?? 0) > 0)
    items.push(chatItem(input))
  return items.filter((item): item is StatItemModel => item !== null)
}
