import type {
  AudienceSnapshot,
  CommentsHistoryStats,
  LiveChatMessage,
  LiveChatProviderState,
  PlatformAudience,
  StreamPlatform,
  StreamTargetRuntime,
  StreamTargetState,
  ViewerSample
} from '@/lib/backend'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
import { activityTotals, chatActivity, type ActivityTotals } from '@/lib/stream-activity'
import { formatViewerCount, viewerSampleStale } from '@/lib/viewer-count-view'

import type { LiveDashboardState } from '../../../shared/live-dashboard'

// The Stream Manager's stats bar (plan 057, D1), as pure item models. A stat
// exists only when its source exists for this session, and a value is never
// a zero nobody measured: a platform that cannot report says why on hover.
// Quiet when fine, specific when not: health shows the bitrate until
// something needs the streamer, then it names the problem instead.

export type StatId = 'session' | 'viewers' | 'health' | 'followers' | 'supporters' | 'tips' | 'chat'

export type StatTone = 'neutral' | 'subtle' | 'good' | 'warning' | 'error'
export type SessionBadge = 'live' | 'recording' | 'off-air' | 'history'
export type StatDot = 'good' | 'warn' | 'error' | 'neutral'

/** One row of a stat's hover card. */
export interface StatDetailRow {
  label: string
  value: string
  platform?: StreamPlatform
  /** A destination's state, drawn as a status dot. */
  dot?: StatDot
  note?: string
}

export interface StatItemModel {
  id: StatId
  /** The hover card's heading: "Viewers", "Stream health". */
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
  dashboard: LiveDashboardState | null
  /** The live chip's sample, when the dashboard has not been relayed yet. */
  viewerSample: ViewerSample | null
  messages: readonly LiveChatMessage[]
  providers: readonly LiveChatProviderState[]
  nowMs: number
  history?: { stats?: CommentsHistoryStats; startedAt: string; title: string }
}

/** The bar's order when the streamer has not rearranged it (plan 057, D2). */
export const DEFAULT_STAT_ORDER: readonly StatId[] = [
  'session',
  'viewers',
  'health',
  'followers',
  'supporters',
  'tips',
  'chat'
]

const TIP_PLATFORMS = new Set<StreamPlatform>(['twitch', 'youtube'])
const VIEWER_PLATFORMS = new Set<StreamPlatform>(['twitch', 'youtube', 'x'])

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
      ...(peak !== null ? [{ label: 'Peak', value: formatViewerCount(peak) }] : []),
      ...(latest && stale ? [{ label: 'Updated', value: 'over a minute ago' }] : [])
    ],
    description: latest
      ? `${count} viewers${peak !== null ? `, peak ${formatViewerCount(peak)}` : ''}`
      : 'No viewer count yet'
  } satisfies StatItemModel
}

const TARGET_STATE_LABELS: Record<StreamTargetState, string> = {
  'not-configured': 'Not set up',
  ready: 'Ready',
  connecting: 'Connecting',
  live: 'Live',
  warning: 'Unstable',
  failed: 'Failed',
  stopped: 'Stopped'
}

const TARGET_DOTS: Partial<Record<StreamTargetState, StatDot>> = {
  live: 'good',
  connecting: 'warn',
  warning: 'warn',
  failed: 'error'
}

/**
 * The one health reading the bar shows, most urgent first: a failed
 * destination, dropped frames, a sagging bitrate, a destination still
 * connecting. Healthy is just the bitrate.
 */
function healthReading(
  targets: readonly StreamTargetRuntime[],
  droppedLastMinute: number,
  sagging: boolean,
  bitrate: string
): { value: string; tone: StatTone } {
  const failed = targets.filter((target) => target.state === 'failed')
  if (failed.length === 1) return { value: `${failed[0].label} failed`, tone: 'error' }
  if (failed.length > 1) return { value: `${failed.length} failed`, tone: 'error' }
  if (droppedLastMinute > 0) return { value: `${droppedLastMinute} dropped/min`, tone: 'warning' }
  if (sagging) return { value: 'Low bitrate', tone: 'warning' }
  const unsettled = targets.find(
    (target) => target.state === 'connecting' || target.state === 'warning'
  )
  if (unsettled) {
    return {
      value: unsettled.state === 'connecting' ? 'Connecting' : `${unsettled.label} unstable`,
      tone: 'warning'
    }
  }
  return { value: bitrate, tone: bitrate === '–' ? 'neutral' : 'good' }
}

function healthItem(dashboard: LiveDashboardState | null, nowMs: number): StatItemModel | null {
  if (dashboard?.session.state !== 'live') return null
  const health = dashboard.health
  const latest = health?.latest
  const points = health?.bitrateHistory ?? []
  const minuteAgo = points.find((point) => Date.parse(point.at) >= nowMs - 60_000)
  const droppedLastMinute =
    typeof latest?.droppedFrames === 'number' && typeof minuteAgo?.droppedFrames === 'number'
      ? Math.max(0, latest.droppedFrames - minuteAgo.droppedFrames)
      : 0
  const recent = points.slice(-150).map((point) => point.kbps)
  const typical = recent.length
    ? [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)]
    : 0
  const kbps = latest?.bitrateKbps
  const sagging = typeof kbps === 'number' && typical > 0 && kbps < typical * 0.7
  const bitrate = typeof kbps === 'number' ? `${Math.round(kbps).toLocaleString()} kbps` : '–'
  const reading = healthReading(dashboard.targets, droppedLastMinute, sagging, bitrate)
  const fps = typeof latest?.fps === 'number' ? `${Math.round(latest.fps)} fps` : null
  const dropped = droppedLastMinute > 0 ? `${droppedLastMinute} in the last minute` : 'None'
  return {
    id: 'health',
    label: 'Stream health',
    value: reading.value,
    tone: reading.tone,
    spark: points.map((point) => point.kbps),
    details: [
      { label: 'Bitrate', value: bitrate },
      ...(fps ? [{ label: 'Frame rate', value: fps }] : []),
      { label: 'Dropped frames', value: dropped },
      ...dashboard.targets.map((target) => ({
        label: target.label,
        value: TARGET_STATE_LABELS[target.state],
        platform: target.platform,
        dot: TARGET_DOTS[target.state] ?? 'neutral',
        ...(target.message ? { note: target.message } : {})
      }))
    ],
    description:
      reading.value === bitrate
        ? `Stream health: ${[bitrate, fps, droppedLastMinute > 0 ? `${dropped} dropped` : 'no dropped frames'].filter(Boolean).join(', ')}`
        : `Stream health: ${reading.value}`
  }
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
  }
}

function followersItem(audience: AudienceSnapshot | null): StatItemModel | null {
  const platforms = audience?.platforms ?? []
  const reporting = platforms.filter((entry) => entry.capability !== 'unavailable')
  if (reporting.length === 0) return null
  const available = reporting.filter(
    (entry) => entry.capability === 'available' && entry.total !== undefined
  )
  const total = available.reduce((sum, entry) => sum + (entry.total ?? 0), 0)
  const delta = available.reduce((sum, entry) => sum + (entry.delta ?? 0), 0)
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
  const chatters = { label: 'Chatters', value: pace.chatters.toLocaleString() }
  if (input.history) {
    const count = input.messages.length
    return {
      id: 'chat',
      label: 'Chat',
      value: count.toLocaleString(),
      unit: count === 1 ? 'message' : 'messages',
      tone: 'neutral',
      details: [chatters],
      description: `${plural(count, 'message', 'messages')}, ${plural(pace.chatters, 'chatter', 'chatters')}`
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
    description: `${plural(pace.perMinute, 'message', 'messages')} a minute, ${plural(pace.chatters, 'chatter', 'chatters')}`
  }
}

/** Every stat this session can show, in the default order. */
export function statItems(input: StatsInput): StatItemModel[] {
  const dashboard = input.history ? null : input.dashboard
  // Tips and subs are only measured where chat is read; viewers can come
  // from any destination with a viewer API.
  const chatPlatforms = new Set<StreamPlatform>([
    ...input.providers.map((provider) => provider.platform),
    ...input.messages.map((message) => message.platform)
  ])
  const livePlatforms = new Set<StreamPlatform>([
    ...chatPlatforms,
    ...(dashboard?.targets ?? []).map((target) => target.platform)
  ])
  const items: (StatItemModel | null)[] = [
    sessionItem(input),
    viewersItem(input, livePlatforms),
    input.history ? null : healthItem(dashboard, input.nowMs),
    followersItem(
      input.history ? (input.history.stats?.audience ?? null) : (dashboard?.audience ?? null)
    )
  ]
  const totals = activityTotals(input.messages)
  if ([...chatPlatforms].some((platform) => TIP_PLATFORMS.has(platform))) {
    items.push(supportersItem(totals, chatPlatforms, dashboard?.audience ?? null), tipsItem(totals))
  }
  if (input.providers.length > 0 || input.messages.length > 0) items.push(chatItem(input))
  return items.filter((item): item is StatItemModel => item !== null)
}
