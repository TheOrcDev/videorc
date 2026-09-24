import type {
  AudienceSnapshot,
  CommentsHistoryStats,
  LiveChatMessage,
  LiveChatProviderState,
  PlatformAudience,
  StreamPlatform,
  ViewerSample
} from '@/lib/backend'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
import { activityTotals, chatActivity, formatTipsValue } from '@/lib/stream-activity'
import { formatViewerCount, viewerSampleStale } from '@/lib/viewer-count-view'

import type { LiveDashboardState } from '../../../shared/live-dashboard'

// The Stream Manager's stats strip (plan 053, D2), as pure tile models. A
// tile exists only when its source exists for this session, and a value is
// never a zero nobody measured: a platform that cannot report says why.

export type StatTileId =
  | 'session'
  | 'viewers'
  | 'followers'
  | 'supporters'
  | 'tips'
  | 'chat'
  | 'health'

export type StatTone = 'neutral' | 'subtle' | 'warning'
export type SessionBadge = 'live' | 'recording' | 'off-air' | 'history'

export interface StatSplitRow {
  platform: StreamPlatform
  label: string
  value: string
  note?: string
}

export interface StatTileModel {
  id: StatTileId
  label: string
  value: string
  detail?: string
  tone: StatTone
  /** Sparkline points, oldest first. */
  spark?: number[]
  /** The per-platform breakdown a hover card shows. */
  split?: StatSplitRow[]
  /** Session tile only. */
  badge?: SessionBadge
  /** Health tile only: one dot per destination. */
  destinations?: { targetId: string; label: string; state: string; message?: string }[]
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

const TIP_PLATFORMS = new Set<StreamPlatform>(['twitch', 'youtube'])

export function formatClock(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

function signed(delta: number): string {
  if (delta === 0) return '±0'
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString()}`
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

function followersTile(audience: AudienceSnapshot | null): StatTileModel | null {
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
  return {
    id: 'followers',
    label: 'Followers',
    value: available.length > 0 ? total.toLocaleString() : pending ? '…' : '–',
    detail:
      available.length > 0
        ? `${signed(delta)} this stream`
        : (blocked?.message ?? (pending ? 'Reading…' : 'Not shared')),
    tone: available.length > 0 ? 'neutral' : 'subtle',
    split: platforms.map((entry) => ({
      platform: entry.platform,
      label: `${CHAT_PLATFORM_LABELS[entry.platform]} ${METRIC_LABELS[entry.metric]}`,
      value: entry.total !== undefined ? entry.total.toLocaleString() : '–',
      ...(audienceNote(entry) ? { note: audienceNote(entry) } : {})
    }))
  }
}

function viewersTile(input: StatsInput): StatTileModel | null {
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
      label: 'Peak viewers',
      value: formatViewerCount(peak),
      detail: `Average ${formatViewerCount(average)}`,
      tone: 'neutral',
      spark: samples.map((sample) => sample.total)
    }
  }
  if (!latest && history.length === 0) return null
  const peak = viewers?.peak ?? latest?.total ?? null
  return {
    id: 'viewers',
    label: 'Viewers',
    value: latest ? formatViewerCount(latest.total) : '–',
    detail: peak !== null ? `Peak ${formatViewerCount(peak)}` : undefined,
    tone: !latest || viewerSampleStale(latest, input.nowMs) ? 'subtle' : 'neutral',
    spark: history.map((point) => point.total),
    split: (latest?.platforms ?? []).map((entry) => ({
      platform: entry.platform,
      label: CHAT_PLATFORM_LABELS[entry.platform],
      value: formatViewerCount(entry.count)
    }))
  }
}

function healthTile(dashboard: LiveDashboardState | null, nowMs: number): StatTileModel | null {
  const health = dashboard?.health
  if (!health || dashboard?.session.state !== 'live') return null
  const latest = health.latest
  const points = health.bitrateHistory
  const minuteAgo = points.find((point) => Date.parse(point.at) >= nowMs - 60_000)
  const droppedLastMinute =
    typeof latest.droppedFrames === 'number' && typeof minuteAgo?.droppedFrames === 'number'
      ? Math.max(0, latest.droppedFrames - minuteAgo.droppedFrames)
      : 0
  const recent = points.slice(-150).map((point) => point.kbps)
  const typical = recent.length
    ? [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)]
    : 0
  const sagging =
    typeof latest.bitrateKbps === 'number' && typical > 0 && latest.bitrateKbps < typical * 0.7
  const parts: string[] = []
  if (typeof latest.fps === 'number') parts.push(`${Math.round(latest.fps)} fps`)
  parts.push(droppedLastMinute > 0 ? `${droppedLastMinute} dropped/min` : 'No drops')
  return {
    id: 'health',
    label: 'Stream health',
    value:
      typeof latest.bitrateKbps === 'number'
        ? `${Math.round(latest.bitrateKbps).toLocaleString()} kbps`
        : '–',
    detail: parts.join(' · '),
    tone: droppedLastMinute > 0 || sagging ? 'warning' : 'neutral',
    spark: points.map((point) => point.kbps),
    destinations: (dashboard?.targets ?? []).map((target) => ({
      targetId: target.targetId,
      label: target.label,
      state: target.state,
      ...(target.message ? { message: target.message } : {})
    }))
  }
}

export function statTiles(input: StatsInput): StatTileModel[] {
  const tiles: StatTileModel[] = []
  const dashboard = input.dashboard
  const session = dashboard?.session
  if (input.history) {
    const started = new Date(input.history.startedAt)
    tiles.push({
      id: 'session',
      label: 'Session',
      value: Number.isNaN(started.getTime())
        ? 'History'
        : started.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      detail: input.history.title,
      tone: 'neutral',
      badge: 'history'
    })
  } else if (session && session.state !== 'off-air' && session.startedAt) {
    tiles.push({
      id: 'session',
      label: 'Session',
      value: formatClock(input.nowMs - Date.parse(session.startedAt)),
      tone: 'neutral',
      badge: session.state === 'live' ? 'live' : 'recording'
    })
  } else {
    tiles.push({
      id: 'session',
      label: 'Session',
      value: 'Off air',
      tone: 'subtle',
      badge: 'off-air'
    })
  }

  const viewers = viewersTile(input)
  if (viewers) tiles.push(viewers)

  const followers = followersTile(
    input.history ? (input.history.stats?.audience ?? null) : (dashboard?.audience ?? null)
  )
  if (followers) tiles.push(followers)

  const platforms = new Set<StreamPlatform>([
    ...input.providers.map((provider) => provider.platform),
    ...input.messages.map((message) => message.platform)
  ])
  const canTip = [...platforms].some((platform) => TIP_PLATFORMS.has(platform))
  const totals = activityTotals(input.messages)
  if (canTip) {
    const twitch = dashboard?.audience?.platforms.find((entry) => entry.platform === 'twitch')
    tiles.push({
      id: 'supporters',
      label: 'Supporters',
      value: totals.supporters.toLocaleString(),
      detail:
        twitch?.subscribers !== undefined
          ? `${twitch.subscribers.toLocaleString()} subs · ${(twitch.subscriberPoints ?? 0).toLocaleString()} pts`
          : 'New this stream',
      tone: 'neutral'
    })
    tiles.push({
      id: 'tips',
      label: 'Tips',
      value: formatTipsValue(totals) ?? 'None yet',
      detail: 'This stream',
      tone: totals.bits || totals.tips.length ? 'neutral' : 'subtle'
    })
  }

  if (platforms.size > 0 || input.messages.length > 0) {
    const pace = chatActivity(input.messages, input.nowMs)
    tiles.push({
      id: 'chat',
      label: 'Chat',
      value: input.history ? input.messages.length.toLocaleString() : `${pace.perMinute}/min`,
      detail: `${pace.chatters.toLocaleString()} ${pace.chatters === 1 ? 'chatter' : 'chatters'}`,
      tone: 'neutral'
    })
  }

  if (!input.history) {
    const health = healthTile(dashboard, input.nowMs)
    if (health) tiles.push(health)
  }
  return tiles
}

/** The narrow tier's one line: session, viewers, followers. */
export function statsSummary(tiles: readonly StatTileModel[]): StatTileModel[] {
  return tiles.filter(
    (tile) => tile.id === 'session' || tile.id === 'viewers' || tile.id === 'followers'
  )
}
