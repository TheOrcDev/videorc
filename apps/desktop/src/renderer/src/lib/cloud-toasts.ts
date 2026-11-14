import type { AiCapabilitiesCloud, CloudFallbackReason, CloudStatus } from './backend'

// The Studio provider's Videorc Cloud toasts (plan 184): a Go Live that
// streamed directly says why once, a show the cloud lost while this
// computer fed it warns once, a runner restart says so once, and a show's
// end warns an hour before. The provider loads this module with the
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
    // Plan 222 D5, plan 234 D12: a node carries up to 1080p60, a managed
    // show 1080p30, and the desktop can't know which before the create.
    case 'cloud-quality':
      return `Videorc Cloud can't carry this stream's quality yet. ${direct}.`
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

/** D18: a show on a node ends after 12 hours on air, with a warning at 11. */
export const CLOUD_SHOW_MAX_SECONDS = 12 * 60 * 60
export const CLOUD_SHOW_WARN_SECONDS = 11 * 60 * 60
/** Plan 234: a managed show's id on its node (wire `control.managedNodeId`). */
const MANAGED_NODE_ID = 'livekit'
const HOUR_MS = 60 * 60 * 1000
// Managed shows warned in this window: their clock is the web's expiresAt,
// and no earlier status says whether the hour before it had begun.
const warnedManagedShows = new Set<string>()

/**
 * The once-per-show warning an hour before the show ends. On a node that is
 * the runner's 12-hour on-air clock, which `liveSeconds` reports. A managed
 * show (plan 234 D12) ends at its `expiresAt`, 11 h 55 min after the create,
 * which comes before the first frame, so it counts down to that instead.
 */
export function cloudShowCapToast(
  previous: CloudStatus | null,
  next: CloudStatus,
  nowMs = Date.now()
): string | null {
  const show = next.show
  if (!show?.id) return null
  const endsAtMs =
    show.nodeId === MANAGED_NODE_ID && show.expiresAt ? Date.parse(show.expiresAt) : Number.NaN
  let left: number
  if (Number.isFinite(endsAtMs)) {
    const leftMs = endsAtMs - nowMs
    if (leftMs > HOUR_MS || warnedManagedShows.has(show.id)) return null
    warnedManagedShows.add(show.id)
    left = leftMs / 1000
  } else {
    if ((next.liveSeconds ?? 0) < CLOUD_SHOW_WARN_SECONDS) return null
    if (previous?.show?.id === show.id && (previous.liveSeconds ?? 0) >= CLOUD_SHOW_WARN_SECONDS) {
      return null
    }
    left = CLOUD_SHOW_MAX_SECONDS - (next.liveSeconds ?? 0)
  }
  return `Your livestream ends in ${formatCloudCountdown(Math.max(0, left))}. A Videorc Cloud show runs about 12 hours at most.`
}
