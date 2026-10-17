import type { AiCapabilitiesCloud, CloudFallbackReason, CloudStatus } from './backend'

// What the renderer says about Videorc Cloud (plan 184 C4 to C7), derived
// from the backend's `CloudStatus`. Pure, so every line of copy is a test.
// Copy rules: plain words ("Be right back", "cloud hours"), never "relay" or
// "runner"; a Go Live that streamed directly says why once; nothing is said
// when the cloud was never expected (the backend decides that, D11).

export const CLOUD_TOAST_ID = 'videorc-cloud'

/** The Premium sentence (docs/ui-copy.md): Max includes Premium. */
export const CLOUD_PREMIUM_REASON = 'Videorc Cloud is part of Videorc Premium.'

/** A paid plan whose cloud isn't on yet: the rollout switch or the cohort. */
export const CLOUD_NOT_YET_REASON =
  "Videorc Cloud isn't on for your account yet. Go Live streams directly from this computer."

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
    case 'cloud-disabled':
      return `Videorc Cloud is off right now. ${direct}.`
    case 'not-entitled':
      return `${CLOUD_PREMIUM_REASON} ${direct}.`
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

function hoursOrMinutes(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  const minutes = Math.max(0, Math.floor(seconds / 60))
  return `${minutes} min`
}

/**
 * "37 of 100 cloud hours left · resets Nov 1". Under an hour left counts
 * minutes; past the allowance it says so plainly, with no charge (D6).
 */
export function cloudHoursLine(allowance: AiCapabilitiesCloud | undefined): string | null {
  if (!allowance || allowance.secondsPerMonth <= 0) return null
  const total = hoursOrMinutes(allowance.secondsPerMonth)
  const reset = formatCloudResetDate(allowance.resetAt)
  const suffix = reset ? ` · resets ${reset}` : ''
  if (allowance.overageSeconds > 0) {
    return `${hoursOrMinutes(allowance.overageSeconds)} over this month's ${total}, no charge${suffix}`
  }
  const left = Math.max(0, allowance.secondsPerMonth - allowance.secondsUsed)
  if (left >= 3600) {
    return `${Math.floor(left / 3600)} of ${Math.floor(allowance.secondsPerMonth / 3600)} cloud hours left${suffix}`
  }
  return `${hoursOrMinutes(left)} of ${total} left${suffix}`
}

/** "5 min", "30 min", "1 hour": the hold limit choices (D12). */
export function formatHoldLimit(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  return `${Math.round(seconds / 60)} min`
}

/** "27 min" or "45 s", for a hold's time left. */
export function formatCloudCountdown(seconds: number): string {
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} min`
  return `${Math.max(0, Math.round(seconds))} s`
}

export type CloudResumeNotice = { detail: string; title: string }

/**
 * C5: a show is live on our servers and this computer isn't feeding it (a
 * crash, a relaunch, an update). Shown only while no local session runs.
 */
export function cloudResumeNotice(
  status: CloudStatus | null,
  sessionActive: boolean
): CloudResumeNotice | null {
  if (!status?.show?.resumable || sessionActive) return null
  if (status.phase === 'off' || status.phase === 'ending' || status.phase === 'failed') {
    return null
  }
  const remaining = status.hold?.remainingSeconds
  const detail =
    status.hold?.active && typeof remaining === 'number'
      ? `Viewers see Be right back. The stream ends in ${formatCloudCountdown(remaining)} unless you resume.`
      : status.hold?.active
        ? 'Viewers see Be right back until you resume.'
        : 'Your stream is still on air.'
  return { detail, title: "You're still live through Videorc Cloud." }
}

/** C4: the Go Live button while the session starts through the cloud. */
export function goesThroughCloud(status: CloudStatus | null): boolean {
  return Boolean(status?.entitled && status.settings.enabled)
}

export type CloudSectionState =
  | { kind: 'upsell' }
  | { kind: 'unavailable' }
  | { kind: 'available'; hours: string | null }

/** What the Livestream page's Videorc Cloud section shows (C6). */
export function cloudSectionState(status: CloudStatus | null): CloudSectionState | null {
  if (!status) return null
  if (status.entitled) return { hours: cloudHoursLine(status.allowance), kind: 'available' }
  // A paid plan whose cloud isn't on yet (the rollout switch, the cohort):
  // say so plainly rather than selling the plan it already has.
  if (status.plan) return { kind: 'unavailable' }
  return { kind: 'upsell' }
}
