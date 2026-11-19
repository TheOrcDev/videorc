// Plan 250 S6: chat connections, platform steps and the Videorc account as
// notifications. Each was a toast of its own; each is now one entry with its
// way out. The browser-approval step and "Connected {platform}" stay toasts:
// they answer Connect.

import type { BackendClient } from '@/backendClient'
import type { XPlaybackEvent, YouTubeThumbnailResult } from '@/lib/backend'
import { notifications } from '@/lib/notifications'
import { CURRENT_SESSION } from '@/lib/notifications/sources/health'
import type { NotificationStore } from '@/lib/notifications/store'
import type { NotificationAction } from '@/lib/notifications/types'
import { openDestinations } from '@/lib/section-doors'
import { X_MEDIA_STUDIO_URL } from '@/lib/studio-toasts'
import { userErrorMessage } from '@/lib/user-error'
import { beginVideorcSignIn } from '@/lib/videorc-web-links'
import { youtubeThumbnailFailure } from '@/lib/youtube-thumbnail-toast'

function openDestinationsAction(targetId?: string): NotificationAction {
  return {
    id: 'open-destinations',
    label: 'Open Destinations',
    kind: 'door',
    run: () => openDestinations(targetId)
  }
}

const SIGN_IN: NotificationAction = {
  id: 'sign-in',
  label: 'Sign in',
  kind: 'fix',
  run: beginVideorcSignIn
}

const OPEN_MEDIA_STUDIO: NotificationAction = {
  id: 'open-media-studio',
  label: 'Open Media Studio',
  kind: 'fix',
  run: () => void window.videorc?.openOAuthUrl?.(X_MEDIA_STUDIO_URL)
}

// --- Chat -------------------------------------------------------------------

/** A destination's chat did not connect at Go Live. The stream is fine. */
export function publishChatNotConnected(
  warning: { id: string; message: string },
  platformLabel: string,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: `chat:${warning.id}`,
    kind: 'chat',
    title: `${platformLabel} chat isn't connected`,
    detail: warning.message,
    actions: [openDestinationsAction(warning.id)],
    sessionId: CURRENT_SESSION
  })
}

/** The chat that was not connected is: its entry resolves. */
export function resolveChatNotConnected(
  id: string,
  platformLabel: string,
  store: NotificationStore = notifications
): void {
  store.resolve(`chat:${id}`, { title: `${platformLabel} chat is connected` })
}

export function publishXChatNotConnected(
  target: { id: string; label: string },
  store: NotificationStore = notifications
): void {
  store.publish({
    key: `chat:${target.id}`,
    kind: 'chat',
    title: `X chat isn't connected for ${target.label}`,
    detail: 'Your stream is fine. Check X in Destinations.',
    actions: [openDestinationsAction(target.id)],
    sessionId: CURRENT_SESSION
  })
}

// --- The Videorc account ----------------------------------------------------

export function chatSignInKey(platformLabel: string): string {
  return `chat-sign-in:${platformLabel}`
}

/**
 * A chat connector waits on the Videorc sign-in (plan 215 A3). The entry
 * names the account, never the platform: the platform is fine. Sign in is
 * the fix, and it attaches chat without a restart.
 */
export function publishChatNeedsSignIn(
  platformLabel: string,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: chatSignInKey(platformLabel),
    kind: 'account-sign-in',
    title: `${platformLabel} chat needs your Videorc sign-in`,
    detail: 'Your stream is fine. Sign in to read chat.',
    actions: [SIGN_IN]
  })
}

export const ACCOUNT_SESSION_KEY = 'account-session'

/** The server refused the stored session and the desktop signed itself out. */
export function publishSignInExpired(store: NotificationStore = notifications): void {
  store.publish({
    key: ACCOUNT_SESSION_KEY,
    kind: 'account-sign-in',
    title: 'Your Videorc sign-in expired',
    detail: 'Sign in again.',
    actions: [SIGN_IN]
  })
}

/** Signed in again: everything that waited on the sign-in resolves. */
export function resolveSignedIn(
  platformLabels: readonly string[],
  store: NotificationStore = notifications
): void {
  store.resolve(ACCOUNT_SESSION_KEY, { title: 'Signed in to Videorc' })
  for (const label of platformLabels) {
    store.resolve(chatSignInKey(label), { title: `${label} chat is connected to your account` })
  }
}

// --- X ----------------------------------------------------------------------

/**
 * An X broadcast step that failed while the stream goes on, so a warning
 * (plan 174 S2.4). The words match the YouTube broadcast notice.
 */
export function publishXBroadcastProblem(
  step: 'start' | 'end' | 'chat',
  target: { id: string; label: string },
  error: unknown,
  store: NotificationStore = notifications
): void {
  const copy = userErrorMessage(error, {
    action: step === 'end' ? 'end' : 'start',
    object: 'the X broadcast'
  })
  console.warn(`[x] ${step} failed for ${target.label}:`, copy.raw)
  if (step === 'chat') {
    publishXChatNotConnected(target, store)
    return
  }
  if (step === 'end') {
    store.publish({
      key: `x-broadcast-end:${target.id}`,
      kind: 'platform-step',
      title: copy.title,
      detail: 'End it in X Media Studio.',
      actions: [OPEN_MEDIA_STUDIO],
      once: true
    })
    return
  }
  store.publish({
    key: `x-broadcast-start:${target.id}`,
    kind: 'platform-step',
    title: copy.title,
    detail: copy.description,
    actions: [openDestinationsAction(target.id)],
    once: true
  })
}

/**
 * A Stream key feed reached X: the broadcast still has to be started there.
 * The caller says it once per Go Live, so each call is that attempt's own
 * reminder: it pops up and counts again, never an update of the last one.
 */
export function publishXStartBroadcast(store: NotificationStore = notifications): void {
  store.publish({
    key: 'x-start-broadcast',
    kind: 'go-live-step',
    title: 'X feed is connected: start the broadcast on X',
    detail:
      "X doesn't go live from the RTMP feed alone: open Media Studio → Producer → Broadcasts, " +
      'create a broadcast from your source, and press Broadcast.',
    actions: [OPEN_MEDIA_STUDIO]
  })
}

export const X_PLAYBACK_KEY = 'x-playback'

/**
 * X's own word on whether viewers can watch. Preparing is a warning, "X
 * ended your broadcast" is urgent, and "viewers can watch" resolves either,
 * or is the late answer to Go Live when nothing was wrong.
 */
export function publishXPlayback(
  event: Pick<XPlaybackEvent, 'status' | 'shareUrl'>,
  store: NotificationStore = notifications
): void {
  if (event.status === 'verified') {
    const title = 'Viewers can watch your X broadcast'
    if (store.has(X_PLAYBACK_KEY)) {
      store.resolve(X_PLAYBACK_KEY, { title, was: 'X was preparing it' })
    } else {
      store.publish({
        key: 'x-live',
        kind: 'x-live',
        title,
        ...(event.shareUrl ? { detail: event.shareUrl } : {}),
        once: true
      })
    }
    return
  }
  if (event.status === 'pending') {
    store.publish({
      key: X_PLAYBACK_KEY,
      kind: 'x-playback',
      title: 'X is still preparing your stream',
      detail:
        'Viewers may see a loading spinner for a few minutes. Keep streaming. Videorc keeps checking.',
      sessionId: CURRENT_SESSION
    })
    return
  }
  // X's API exposes no playback URL any more: `unavailable` means X ended
  // the broadcast (usually TIMED_OUT: no video reached X in 5 minutes).
  store.publish({
    key: X_PLAYBACK_KEY,
    kind: 'x-playback',
    tone: 'urgent',
    title: 'X ended your broadcast',
    detail:
      'X stopped it while Videorc was still streaming, usually because no video reached X. Your local recording is unaffected.',
    actions: [OPEN_MEDIA_STUDIO],
    sessionId: CURRENT_SESSION
  })
}

// --- YouTube and Discord ----------------------------------------------------

export function publishYouTubeBroadcastProblem(
  step: 'start' | 'end',
  target: { id: string },
  words: { title: string; description?: string },
  store: NotificationStore = notifications
): void {
  store.publish({
    key: `youtube-broadcast-${step}:${target.id}`,
    kind: 'platform-step',
    title: words.title,
    detail: words.description,
    actions: [openDestinationsAction(target.id)],
    once: true
  })
}

/** One quiet notice per daily-budget step reached (plan 094, S6). */
export function publishYouTubeBudget(
  step: string,
  words: { title: string; description?: string },
  store: NotificationStore = notifications
): void {
  store.publish({
    key: `youtube-budget:${step}`,
    kind: 'platform-news',
    title: words.title,
    detail: words.description,
    once: true
  })
}

/** A go-live post to Discord that failed, with the way to fix it. */
export function publishDiscordFailure(
  failure: { title: string; description?: string },
  store: NotificationStore = notifications
): void {
  store.publish({
    key: 'discord-announce',
    kind: 'platform-step',
    title: failure.title,
    detail: failure.description,
    actions: [openDestinationsAction()]
  })
}

export function youtubeThumbnailKey(failure: Pick<YouTubeThumbnailResult, 'broadcastId'>): string {
  return `youtube-thumbnail:${failure.broadcastId}`
}

/**
 * A failed Broadcast info thumbnail (plan 083): one entry per broadcast,
 * with Retry while a retry can help. A retry uses the draft's current
 * thumbnail; one that works resolves the entry and says nothing more.
 */
export function publishYouTubeThumbnailFailure(
  client: Pick<BackendClient, 'request'>,
  failure: YouTubeThumbnailResult,
  store: NotificationStore = notifications
): void {
  const key = youtubeThumbnailKey(failure)
  const retry = async (): Promise<void> => {
    try {
      const result = await client.request<YouTubeThumbnailResult>(
        'streamTargets.youtube.thumbnail.retry',
        {
          accountId: failure.accountId,
          broadcastId: failure.broadcastId,
          targetId: failure.targetId
        }
      )
      const again = youtubeThumbnailFailure(result)
      if (again) publishYouTubeThumbnailFailure(client, again, store)
      else store.resolve(key, { title: 'Thumbnail set on YouTube', detail: 'The retry worked.' })
    } catch (error) {
      const copy = userErrorMessage(error)
      console.warn('[youtube] thumbnail retry failed:', copy.raw)
      store.publish({
        key,
        kind: 'youtube-thumbnail',
        title: 'Thumbnail not set on YouTube',
        detail: copy.description,
        actions: [{ id: 'retry', label: 'Retry', kind: 'fix', run: retry }]
      })
    }
  }
  store.publish({
    key,
    kind: 'youtube-thumbnail',
    title: 'Thumbnail not set on YouTube',
    detail: failure.message,
    actions: failure.retryable ? [{ id: 'retry', label: 'Retry', kind: 'fix', run: retry }] : []
  })
}

// --- Go Live's own notes ----------------------------------------------------

/** A stream key saved the old way could not be moved to the keychain. */
export function publishStreamKeyMigration(
  label: string,
  targetId: string,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: `stream-key-migration:${targetId}`,
    kind: 'platform-step',
    title: `Save your ${label} stream key again`,
    detail: 'Paste it in Destinations → Setup so Videorc can store it securely. It works for now.',
    actions: [openDestinationsAction(targetId)],
    once: true
  })
}

/** Go Live changed the output to what the destinations can take. */
export function publishStreamOutputAdjusted(
  notice: { title: string; description?: string },
  store: NotificationStore = notifications
): void {
  store.publish({
    key: 'stream-output-adjusted',
    kind: 'go-live-step',
    title: notice.title,
    detail: notice.description
  })
}
