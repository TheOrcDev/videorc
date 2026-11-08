import type { CloudStatus } from './backend'
import { formatCloudCountdown } from './cloud-toasts'

// The cloud show outside the Livestream page (plan 184 C4, C5 and C7): the Go
// Live dialog's cloud step, the Studio's Resume notice and the hold's
// countdown in the Stream Manager. Its own module, so the eager Studio
// provider never carries it: `cloud-toasts.ts` is all the provider says
// (the countdown lives there, because the 12-hour cap's toast counts too).

export { formatCloudCountdown }

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

/**
 * C4: the Go Live button while the session starts through the cloud: the
 * switch is on for an entitled account, or a show is still live on our
 * servers, which Go Live feeds whatever the switch or rollout says (plan 222
 * U4).
 */
export function goesThroughCloud(status: CloudStatus | null): boolean {
  if (status?.show?.resumable) return true
  return Boolean(status?.entitled && status.settings.enabled)
}
