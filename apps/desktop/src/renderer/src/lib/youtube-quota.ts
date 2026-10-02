import type { LiveChatProviderState, StreamPlatform, YouTubeQuotaStatus } from '@/lib/backend'
import { BackendRequestError } from '@/backendClient'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'

// Plan 094: one shared paused state for YouTube's Data API. The backend owns
// the breaker (`youtube.quota` event, `youtube.quota.status` RPC, and the chat
// provider's `retryAt`); this module turns it into Videorc copy, in local time.

/** Backend error codes a failed YouTube call can carry (plan 094, S2). */
export const YOUTUBE_QUOTA_PAUSED_CODE = 'youtube-quota-paused'
export const YOUTUBE_BROADCAST_NOT_FOUND_CODE = 'youtube-broadcast-not-found'

/** Where a streamer finds the key when the API path is paused (G5). */
export const YOUTUBE_STREAM_KEY_URL = 'https://studio.youtube.com'
export const YOUTUBE_STREAM_KEY_LINK_LABEL = 'YouTube Studio → Go live → Stream key'

/** The breaker's end as `pausedUntil`, or null when YouTube calls may run. */
export function youtubeQuotaPausedUntil(
  status: YouTubeQuotaStatus | null | undefined
): Date | null {
  const raw = status?.pausedUntil
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

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
 * A failed `complete` the next start must never wait on: YouTube ends the
 * broadcast on its own (`enableAutoStop`) when the quota is out, and a
 * broadcast that no longer exists has nothing to end. Network and 5xx
 * failures keep the retain-and-retry path.
 */
export function isSettledYouTubeCompletionError(error: unknown): boolean {
  return (
    error instanceof BackendRequestError &&
    (error.code === YOUTUBE_QUOTA_PAUSED_CODE || error.code === YOUTUBE_BROADCAST_NOT_FOUND_CODE)
  )
}

export function isYouTubeQuotaPausedError(error: unknown): boolean {
  return error instanceof BackendRequestError && error.code === YOUTUBE_QUOTA_PAUSED_CODE
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
