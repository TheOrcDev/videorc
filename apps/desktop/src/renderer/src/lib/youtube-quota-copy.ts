import type {
  LiveChatProviderState,
  StreamPlatform,
  YouTubeQuotaBudgetStep,
  YouTubeQuotaStatus
} from '@/lib/backend'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'

// Plan 094: the copy for YouTube's shared paused state and the per-install
// budget, in local time. Lazy on purpose: `use-studio` imports it with
// `import()` where a toast or message is shown, and the lazy tabs and windows
// import it statically. The eager codes and predicates are in
// `@/lib/youtube-quota` and re-exported here for those lazy importers.

export {
  YOUTUBE_BROADCAST_NOT_FOUND_CODE,
  YOUTUBE_QUOTA_PAUSED_CODE,
  isSettledYouTubeCompletionError,
  isYouTubeQuotaPausedError,
  youtubeQuotaPausedUntil
} from '@/lib/youtube-quota'

/** Where a streamer finds the key when the API path is paused (G5). */
export const YOUTUBE_STREAM_KEY_URL = 'https://studio.youtube.com'
export const YOUTUBE_STREAM_KEY_LINK_LABEL = 'YouTube Studio → Go live → Stream key'

/**
 * "09:00" for a resume today, "tomorrow 09:00" otherwise, in the user's local
 * zone. Quota resets at midnight Pacific, so for most of the world the reset
 * reads as a morning time on the same or the next calendar day.
 */
export function formatResumeTime(at: Date | string, now: Date = new Date()): string {
  const date = typeof at === 'string' ? new Date(at) : at
  if (Number.isNaN(date.getTime())) return 'the reset'
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return time
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const isTomorrow =
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate()
  return isTomorrow
    ? `tomorrow ${time}`
    : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

/**
 * The provider's own words for a parked connector, with the resume time the
 * backend gave as `retryAt` ("YouTube chat is paused: … It resumes at 09:00.
 * Your stream keeps going."). The backend's message alone otherwise.
 */
export function waitingProviderMessage(
  provider: Pick<LiveChatProviderState, 'platform' | 'state' | 'message' | 'retryAt'>,
  now: Date = new Date()
): string {
  const message = provider.message.trim()
  if (provider.state !== 'waiting' || !provider.retryAt) return message
  const resume = `It resumes at ${formatResumeTime(provider.retryAt, now)}.`
  const keepsGoing = provider.platform === 'youtube' ? ' Your stream keeps going.' : ''
  return `${message} ${resume}${keepsGoing}`.trim()
}

/** Go Live preflight refusal for a YouTube OAuth destination while paused (G5). */
export function youtubeGoLivePausedMessage(pausedUntil: Date | string, now?: Date): string {
  return `YouTube's API is paused until ${formatResumeTime(pausedUntil, now)}, so Videorc can't create the YouTube broadcast. Go live on YouTube with your stream key instead.`
}

/** The Livestream page row while paused: what is off, until when, what still works. */
export function youtubeDestinationPausedMessage(pausedUntil: Date | string, now?: Date): string {
  return `YouTube's API is paused until ${formatResumeTime(pausedUntil, now)}: Videorc's daily YouTube API limit is used up. Chat, viewers and subscribers resume on their own; to go live on YouTube before then, use your stream key.`
}

/** The connect flow while paused (plan 094, S3). */
export function youtubeConnectPausedMessage(pausedUntil: Date | string, now?: Date): string {
  return `Couldn't finish connecting YouTube. Videorc's daily YouTube API limit is used up. Try again after ${formatResumeTime(pausedUntil, now)}.`
}

/**
 * The toast for a broadcast transition that failed: "Couldn't start the
 * YouTube broadcast." / "Couldn't end the YouTube broadcast.", naming the
 * destination only when its label is not just the platform's name (the owner
 * saw "Could not complete YouTube on YouTube." on 2026-10-02).
 */
export function youtubeBroadcastToast(
  step: 'start' | 'end',
  target: { label: string; platform: StreamPlatform },
  description: string
): { title: string; description: string } {
  const platformName = CHAT_PLATFORM_LABELS[target.platform]
  const label = target.label.trim()
  const named =
    label && label.toLowerCase() !== platformName.toLowerCase()
      ? `${label}: ${description}`
      : description
  return {
    title:
      step === 'start'
        ? "Couldn't start the YouTube broadcast."
        : "Couldn't end the YouTube broadcast.",
    description: named
  }
}

// --- Per-install daily budget (plan 094, S6) --------------------------------------

const BUDGET_STEP_ORDER: readonly YouTubeQuotaBudgetStep[] = [
  'normal',
  'shed-extras',
  'shed-viewers',
  'essentials-only'
]

/** The quiet notice for a step the budget just reached; null for `normal`. */
export function youtubeBudgetNotice(
  step: YouTubeQuotaBudgetStep
): { title: string; description: string } | null {
  switch (step) {
    case 'shed-extras':
      return {
        title: "YouTube subscriber count paused to save Videorc's daily YouTube limit.",
        description:
          'Thumbnails are skipped too and the YouTube viewer count updates every 2 minutes. Chat and your stream are not affected.'
      }
    case 'shed-viewers':
      return {
        title: "YouTube viewer count paused to save Videorc's daily YouTube limit.",
        description:
          'Chat keeps reading and your stream is not affected. Everything resumes tomorrow.'
      }
    case 'essentials-only':
      return {
        title: "YouTube extras paused for today to save Videorc's daily YouTube limit.",
        description:
          'Chat keeps reading, and Go Live and Stop still work. Sending to YouTube chat, viewer and subscriber counts resume tomorrow.'
      }
    case 'normal':
      return null
  }
}

/**
 * Which step to announce when the budget moves from `previous` to `next`:
 * only a climb (more shedding) is news, and only once per step. A reset to
 * `normal` (new Pacific day, a raised remote limit) is silent.
 */
export function youtubeBudgetStepToAnnounce(
  previous: YouTubeQuotaStatus | null | undefined,
  next: YouTubeQuotaStatus | null | undefined
): YouTubeQuotaBudgetStep | null {
  const after = next?.budget?.step
  if (!after || after === 'normal') return null
  const before = previous?.budget?.step ?? 'normal'
  return BUDGET_STEP_ORDER.indexOf(after) > BUDGET_STEP_ORDER.indexOf(before) ? after : null
}
