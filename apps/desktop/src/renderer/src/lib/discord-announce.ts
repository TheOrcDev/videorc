/**
 * The Discord go-live announcement (plan 187): the pure rules behind the
 * Livestream → Setup Discord section and its failure toast. The backend owns
 * the webhook, the links and the posting; this only shapes what the section
 * sends and says.
 */
import type {
  DiscordAnnounceError,
  DiscordAnnounceErrorCode,
  DiscordAnnounceSnapshot,
  DiscordLinkTarget,
  DiscordPing,
  DiscordPostAs,
  DiscordWebhookSnapshot,
  StreamTargetSettings
} from '@/lib/backend'

/** The configured destinations, as the backend's link preview reads them. */
export function discordLinkTargets(targets: readonly StreamTargetSettings[]): DiscordLinkTarget[] {
  return targets.map((target) => ({
    id: target.id,
    platform: target.platform,
    label: target.label,
    authMode: target.authMode,
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.outputOrientation ? { outputOrientation: target.outputOrientation } : {}),
    ...(target.platformBroadcastId ? { platformBroadcastId: target.platformBroadcastId } : {})
  }))
}

const WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com'
])

/**
 * The paste's shape, checked as it is typed (D6). `null` when it looks like a
 * Discord webhook URL; the backend checks it again and asks Discord.
 */
export function discordWebhookFormatError(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return NOT_A_WEBHOOK
  }
  if (url.protocol !== 'https:' || !WEBHOOK_HOSTS.has(url.hostname) || url.port !== '') {
    return NOT_A_WEBHOOK
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const tail =
    segments.length === 5 && /^v\d+$/.test(segments[1] ?? '')
      ? [segments[0], segments[2], segments[3], segments[4]]
      : segments
  const [api, webhooks, id, token] = tail
  if (
    tail.length !== 4 ||
    api !== 'api' ||
    webhooks !== 'webhooks' ||
    !/^\d{1,25}$/.test(id ?? '') ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(token ?? '')
  ) {
    return NOT_A_WEBHOOK
  }
  return null
}

export const NOT_A_WEBHOOK = "That isn't a Discord webhook URL."

export const DISCORD_PING_OPTIONS: ReadonlyArray<{ value: DiscordPing; label: string }> = [
  { value: 'none', label: 'No ping' },
  { value: 'here', label: '@here' },
  { value: 'everyone', label: '@everyone' }
]

/** A Select value for a "Post as" choice, and back. */
export function postAsKey(postAs: DiscordPostAs): string {
  return postAs.kind === 'platform' ? `platform:${postAs.accountId}` : postAs.kind
}

export function postAsFromKey(key: string): DiscordPostAs {
  if (key.startsWith('platform:')) return { kind: 'platform', accountId: key.slice(9) }
  if (key === 'videorc' || key === 'webhook') return { kind: key }
  return { kind: 'automatic' }
}

/** Ticked rows after a checkbox flips: the backend stores the exclusions. */
export function nextExcludedTargetIds(
  excluded: readonly string[],
  targetId: string,
  included: boolean
): string[] {
  const rest = excluded.filter((id) => id !== targetId)
  return included ? rest : [...rest, targetId]
}

/** How long after it happened a failure is still news worth a toast. */
const FAILURE_TOAST_WINDOW_MS = 10 * 60 * 1000

export interface DiscordFailureToast {
  at: string
  type: 'error' | 'warning'
  title: string
  description: string
}

/** The failure's copy; a named webhook is named, so servers tell apart. */
function failureCopy(
  code: DiscordAnnounceErrorCode,
  name: string | undefined
): Omit<DiscordFailureToast, 'at'> {
  const title = "Couldn't post to Discord"
  const webhook = name ? `The ${name} webhook` : 'The webhook'
  switch (code) {
    case 'webhook-deleted':
      return {
        type: 'error',
        title,
        description: `${webhook} was deleted in Discord. Paste a new one in Livestream → Setup.`
      }
    case 'unreachable':
      return {
        type: 'warning',
        title,
        description: name
          ? `Discord couldn't be reached for 5 minutes (${name}). Your stream is fine.`
          : "Discord couldn't be reached for 5 minutes. Your stream is fine."
      }
    case 'rejected':
      return {
        type: 'error',
        title,
        description: name
          ? `Discord refused the post to ${name}. Check the webhook in Livestream → Setup.`
          : 'Discord refused the post. Check the webhook in Livestream → Setup.'
      }
  }
}

/** The webhook whose failure is newest, if any has one. */
export function newestDiscordFailure(
  webhooks: readonly Pick<DiscordWebhookSnapshot, 'name' | 'lastError'>[]
): { name?: string; error: DiscordAnnounceError } | null {
  let newest: { name?: string; error: DiscordAnnounceError } | null = null
  for (const webhook of webhooks) {
    if (!webhook.lastError) continue
    if (!newest || Date.parse(webhook.lastError.at) > Date.parse(newest.error.at)) {
      newest = { error: webhook.lastError, ...(webhook.name ? { name: webhook.name } : {}) }
    }
  }
  return newest
}

/**
 * The toast for a new announcement failure (D13), or `null`: the newest
 * failure across the webhooks, the same failure never toasts twice, and an
 * old one carried by a settings change never toasts at all.
 */
export function discordFailureToast(
  lastToastedAt: string | null,
  snapshot: Pick<DiscordAnnounceSnapshot, 'webhooks'>,
  nowMs: number
): DiscordFailureToast | null {
  const newest = newestDiscordFailure(snapshot.webhooks)
  if (!newest || newest.error.at === lastToastedAt) return null
  const atMs = Date.parse(newest.error.at)
  if (!Number.isFinite(atMs) || nowMs - atMs > FAILURE_TOAST_WINDOW_MS) return null
  return { at: newest.error.at, ...failureCopy(newest.error.code, newest.name) }
}

/** The webhook row's error line while a failure stands. */
export function discordErrorLine(code: DiscordAnnounceErrorCode): string {
  switch (code) {
    case 'webhook-deleted':
      return 'This webhook was deleted in Discord. Paste a new one.'
    case 'unreachable':
      return "The last post couldn't reach Discord."
    case 'rejected':
      return 'Discord refused the last post. Check the webhook, or paste a new one.'
  }
}
