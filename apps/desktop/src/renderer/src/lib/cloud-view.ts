import type {
  AiCapabilitiesCloud,
  CloudFallbackReason,
  CloudStatus,
  CloudTestResult,
  CloudTestStatus,
  CloudTestUpload
} from './backend'
import { formatBitrate } from './format-video'

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
    case 'cloud-show-limit':
      return `You've started this hour's Videorc Cloud shows. ${direct} for now.`
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

// --- Test cloud (C6b) ---

/** The Test row's description while no test ran. */
export const CLOUD_TEST_DESCRIPTION = 'Sends 10 seconds of test video. Nothing goes public.'
/** The session lock, in the words of the lock Alert (docs/ui-copy.md). */
export const CLOUD_TEST_SESSION_REASON = "Locked while you're recording or live."
export const CLOUD_TEST_SHOW_LIVE_REASON = 'A show is live through Videorc Cloud. End it first.'

const RESET_TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

/** "2:05 PM", the local time a limit frees up. */
function formatResetTime(resetAt: string | undefined): string | null {
  if (!resetAt) return null
  const date = new Date(resetAt)
  return Number.isNaN(date.getTime()) ? null : RESET_TIME.format(date)
}

/** "2.3 s": a short duration, the time the cloud took to go live. */
function formatShortSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`
}

/** "6.2 of 6 Mbps": what arrived against the stream quality's bitrate. */
function uploadFigure(upload: CloudTestUpload): string {
  const measured = formatBitrate(upload.measuredKbps ?? 0).replace(/ Mbps$/, '')
  return `${measured} of ${formatBitrate(upload.targetKbps)}`
}

/**
 * "Upload held 6.2 of 6 Mbps." for one stream; a dual-orientation test names
 * both: "... for the horizontal stream and 3.1 of 3 Mbps for the vertical."
 */
function uploadsLine(uploads: CloudTestUpload[] | undefined, verb: 'held' | 'reached'): string {
  const measured = (uploads ?? []).filter((upload) => upload.measuredKbps !== undefined)
  if (measured.length === 0) return ''
  if (measured.length === 1) return `Upload ${verb} ${uploadFigure(measured[0]!)}.`
  const [first, ...rest] = measured
  return `Upload ${verb} ${uploadFigure(first!)} for the ${first!.orientation} stream and ${rest
    .map((upload) => `${uploadFigure(upload)} for the ${upload.orientation}`)
    .join(' and ')}.`
}

/** A test is running: the button reads "Testing…" and stays disabled. */
export function cloudTestRunning(test: CloudTestStatus | undefined): boolean {
  return test !== undefined && test.phase !== 'done'
}

/** One line for the finished test: what works, or what to do. */
export function cloudTestResultLine(result: CloudTestResult): string {
  if (result.ok) {
    const live =
      typeof result.timeToLiveMs === 'number'
        ? ` Live in ${formatShortSeconds(result.timeToLiveMs)}.`
        : ''
    // Never an unmeasured zero: a feed the cloud saw but never measured
    // says so instead of a figure.
    const upload =
      uploadsLine(result.uploads, 'held') ||
      (result.uploads?.length ? "Videorc couldn't measure the upload." : '')
    return `Videorc Cloud works from here.${live}${upload ? ` ${upload}` : ''}`
  }
  const reset = formatResetTime(result.resetAt)
  switch (result.reason) {
    case 'too-slow': {
      // The control above this section reads "Stream quality".
      const upload = uploadsLine(result.uploads, 'reached')
      return `${upload ? `Your ${upload.charAt(0).toLowerCase()}${upload.slice(1)} ` : 'Your upload fell short. '}Choose a lower stream quality or use a wired connection.`
    }
    case 'cant-reach':
      return "Videorc Cloud couldn't be reached from here. Check your connection and try again."
    case 'off':
      return 'Videorc Cloud is off right now. Try again later.'
    case 'full':
      return 'Videorc Cloud is full right now. Try again in a few minutes.'
    case 'not-entitled':
      return CLOUD_PREMIUM_REASON
    case 'no-hours': {
      const day = formatCloudResetDate(result.resetAt)
      return day
        ? `You've used this month's cloud hours. They come back ${day}.`
        : "You've used this month's cloud hours."
    }
    case 'limit':
      return reset
        ? `You've run this hour's tests. Try again after ${reset}.`
        : "You've run this hour's tests. Try again in a while."
    case 'show-live':
      return CLOUD_TEST_SHOW_LIVE_REASON
    case 'certificate':
      return "Videorc Cloud's certificate couldn't be checked on this network. Try another network, or turn off apps that inspect secure connections."
    case 'no-feed':
      return "Videorc Cloud didn't receive the test video. This network or a firewall may block streaming. Try another network."
    case 'failed':
    case undefined:
      return "Couldn't test Videorc Cloud. Try again. If it keeps happening, export a support bundle from Health."
  }
}

/**
 * A finished test that failed in a way the streamer acts on: the upload,
 * this network or the run itself. A refusal (the hour's tests, the cloud off
 * or full, a live show, the plan) is a plain line, never an error.
 */
function cloudTestFailed(result: CloudTestResult): boolean {
  if (result.ok) return false
  switch (result.reason) {
    case 'too-slow':
    case 'cant-reach':
    case 'certificate':
    case 'no-feed':
    case 'failed':
    case undefined:
      return true
    case 'off':
    case 'full':
    case 'not-entitled':
    case 'no-hours':
    case 'limit':
    case 'show-live':
      return false
  }
}

/**
 * The Test row's two lines (plan 184 C6b): the description says what the
 * test does, the step under way or a result that works; a failure is the
 * row's own error instead (`FieldError`: monochrome words, the error glyph).
 * Never a toast.
 */
export function cloudTestRowLines(test: CloudTestStatus | undefined): {
  description: string | null
  error: string | null
} {
  const result = test?.phase === 'done' ? test.result : undefined
  if (result && cloudTestFailed(result)) {
    return { description: null, error: cloudTestResultLine(result) }
  }
  return { description: cloudTestLine(test), error: null }
}

/** The Test row's description: the step under way, the result, or what it does. */
export function cloudTestLine(test: CloudTestStatus | undefined): string {
  if (!test) return CLOUD_TEST_DESCRIPTION
  switch (test.phase) {
    case 'creating':
    case 'connecting':
      return 'Connecting to Videorc Cloud…'
    case 'pushing':
      return 'Sending 10 seconds of test video…'
    case 'ending':
      return 'Finishing the test…'
    case 'done':
      return test.result ? cloudTestResultLine(test.result) : CLOUD_TEST_DESCRIPTION
  }
}

/**
 * Why Test is disabled in an open section, one reason: a recording or
 * livestream runs, or a show is live or resumable through the cloud. Null
 * while a test may run (a running test disables the button on its own).
 */
export function cloudTestBlockedReason(
  status: CloudStatus | null,
  sessionActive: boolean
): string | null {
  if (sessionActive) return CLOUD_TEST_SESSION_REASON
  if (status?.show) return CLOUD_TEST_SHOW_LIVE_REASON
  return null
}
