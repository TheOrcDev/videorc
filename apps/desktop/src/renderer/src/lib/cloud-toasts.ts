import type { AiCapabilitiesCloud, CloudFallbackReason, CloudStatus } from './backend'

// The Studio provider's Videorc Cloud toasts (plan 184): a Go Live that
// streamed directly says why once, a show the cloud lost while this
// computer fed it warns once, a runner restart says so once, and the
// 12-hour cap warns an hour before. The provider loads this module with the
// first cloud status and keeps only the toast id eager; the Livestream copy
// (`cloud-view.ts`) and the show's (`cloud-show-view.ts`) load with the
// surfaces that show them. Pure, so every line of copy is a test.

export { CLOUD_TOAST_ID } from './cloud-toast-id'

/** The Premium sentence (docs/ui-copy.md): Max includes Premium. */
export const CLOUD_PREMIUM_REASON = 'Videorc Cloud is part of Videorc Premium.'

const RESET_DATE = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC'
})

/** "Nov 1": cloud hours reset on the 1st, UTC (plan 185 D5). */
export function formatCloudResetDate(resetAt: string | undefined): string | null {
  if (!resetAt) return null
  const date = new Date(resetAt)
  return Number.isNaN(date.getTime()) ? null : RESET_DATE.format(date)
}

/** One toast line for a Go Live that streamed directly. */
export function cloudFallbackMessage(
  reason: CloudFallbackReason,
  allowance?: AiCapabilitiesCloud
): string {
  const direct = "You're streaming directly from this computer"
  switch (reason) {
    case 'cloud-full':
      return `Videorc Cloud is full right now. ${direct}.`
    case 'cloud-hours-used-up': {
      const reset = formatCloudResetDate(allowance?.resetAt)
      return reset
        ? `You've used this month's cloud hours. ${direct} until ${reset}.`
        : `You've used this month's cloud hours. ${direct}.`
    }
    case 'cloud-node-unreachable':
      return `Videorc Cloud couldn't be reached. ${direct}.`
    case 'cloud-show-limit':
      return `You've started this hour's Videorc Cloud shows. ${direct} for now.`
    case 'cloud-disabled':
      return `Videorc Cloud is off right now. ${direct}.`
    case 'not-entitled':
      return `${CLOUD_PREMIUM_REASON} ${direct}.`
    // Plan 222 D5: the first nodes carry up to 1080p60.
    case 'cloud-quality':
      return `Videorc Cloud carries up to 1080p60 for now. ${direct}.`
    // Plan 222 D6: a remembered show the web could not be asked about.
    case 'cloud-unchecked':
      return `Videorc couldn't check your last cloud show. ${direct}.`
    // Plan 224: a room that could not open never streams directly (there is
    // no talk show without a room); these name the refusal on the Guests tab.
    case 'cloud-guest-hours-used-up':
      return "This month's guest limit is reached. Guests already on stay."
    case 'cloud-rooms-unavailable':
      return "Rooms aren't available right now. Try again in a moment."
  }
}

/** The toast a status change asks for: a NEW fallback, once per Go Live. */
export function cloudFallbackToast(previous: CloudStatus | null, next: CloudStatus): string | null {
  const fallback = next.fallback
  if (!fallback) return null
  if (previous?.fallback?.sessionId === fallback.sessionId) return null
  return cloudFallbackMessage(fallback.reason, next.allowance)
}

/** The once-only warning when the cloud loses a show this computer fed (C2). */
export function cloudLostToast(previous: CloudStatus | null, next: CloudStatus): string | null {
  if (!next.directFallbackAvailable || previous?.directFallbackAvailable) return null
  return 'Videorc Cloud lost your show. Stop, then go live again to stream directly from this computer.'
}

/**
 * The runner restarted mid-show (plan 184 "When things break"): once per
 * restart, and once more if the platforms then could not be reconnected.
 */
export function cloudRestartToast(previous: CloudStatus | null, next: CloudStatus): string | null {
  const restart = next.restart
  if (!restart) return null
  const before = previous?.restart
  const unrecovered =
    "Videorc Cloud restarted your show, but your platforms couldn't be reconnected. Stop, then go live again."
  if (before?.at === restart.at) {
    return before.destinationsResent && !restart.destinationsResent ? unrecovered : null
  }
  return restart.destinationsResent
    ? 'Videorc Cloud restarted your show. Your platforms reconnect in a few seconds.'
    : unrecovered
}

/** "27 min" or "45 s", for a hold's or a cap's time left. */
export function formatCloudCountdown(seconds: number): string {
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} min`
  return `${Math.max(0, Math.round(seconds))} s`
}

/** D18: any single show ends after 12 hours on air, with a warning at 11. */
export const CLOUD_SHOW_MAX_SECONDS = 12 * 60 * 60
export const CLOUD_SHOW_WARN_SECONDS = 11 * 60 * 60

/**
 * The once-per-show warning an hour before the 12-hour cap (D18). The cap is
 * the runner's on-air clock, which `liveSeconds` reports.
 */
export function cloudShowCapToast(previous: CloudStatus | null, next: CloudStatus): string | null {
  const showId = next.show?.id
  if (!showId || (next.liveSeconds ?? 0) < CLOUD_SHOW_WARN_SECONDS) return null
  if (previous?.show?.id === showId && (previous.liveSeconds ?? 0) >= CLOUD_SHOW_WARN_SECONDS) {
    return null
  }
  const left = Math.max(0, CLOUD_SHOW_MAX_SECONDS - (next.liveSeconds ?? 0))
  return `Your livestream ends in ${formatCloudCountdown(left)}. A Videorc Cloud show runs 12 hours at most.`
}
