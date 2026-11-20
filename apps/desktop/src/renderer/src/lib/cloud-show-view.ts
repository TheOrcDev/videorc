import type { CloudStatus } from './backend'
import { CONTINUE_ON_PHONE, onAirDeviceName } from './cloud-handoff-view'
import { formatCloudCountdown } from './cloud-toasts'

// The cloud show outside the Destinations page (plan 184 C4, C5 and C7): the Go
// Live dialog's cloud step, the Studio's Resume notice and the hold's
// countdown in the Stream Manager. Its own module, so the eager Studio
// provider never carries it: `cloud-toasts.ts` is all the provider says
// (the countdown lives there, because the 12-hour cap's toast counts too).

export { formatCloudCountdown }

export type CloudResumeNotice = {
  title: string
  detail: string | null
  /**
   * Plan 243: "Continue here" once the show waits for a device or another
   * device is on air; "Resume" for a show this computer stopped feeding.
   */
  action: 'resume' | 'continue'
  /** A show live from another device is fine; the rest needs the streamer. */
  tone: 'warning' | 'default'
  /** Plan 243: where a phone picks the show up, while it waits for one. */
  pointer: string | null
}

/**
 * C5: a show is live on our servers and this computer isn't feeding it (a
 * crash, a relaunch, an update). Shown only while no local session runs.
 *
 * Plan 243 C5: after a hand-off the show waits for a device ("Your show is
 * waiting for another device." with the hold's countdown and the phone's
 * address), and while another device is on air the notice names it ("Your
 * show is live from iPhone."). Both offer Continue here.
 */
export function cloudResumeNotice(
  status: CloudStatus | null,
  sessionActive: boolean
): CloudResumeNotice | null {
  const onAir = status?.onAir
  const elsewhere = Boolean(onAir && !onAir.thisDevice && !onAir.waiting)
  // R2 A-M6: a show held while another device is on air always leads with
  // Continue here (Go Live is refused for it), resumable or not.
  if (!status?.show || !(status.show.resumable || elsewhere) || sessionActive) return null
  if (status.phase === 'off' || status.phase === 'ending' || status.phase === 'failed') {
    return null
  }
  const talk = status.show.kind === 'talk'
  const guests = talk ? 'Your guests are still on.' : null
  if (onAir && elsewhere) {
    // D2: a computer taking over from a computer's feed breaks before it makes.
    const brief =
      !talk && onAir.source === 'feed'
        ? 'Viewers see Be right back for a few seconds when you continue here.'
        : null
    return {
      title: `Your show is live from ${onAirDeviceName(onAir)}.`,
      detail: guests ?? brief,
      action: 'continue',
      tone: 'default',
      pointer: null
    }
  }
  const remaining = status.hold?.remainingSeconds
  const until = onAir?.waiting ? 'continue' : 'resume'
  const hold = status.hold?.active
    ? typeof remaining === 'number' && !talk
      ? `Viewers see Be right back. The stream ends in ${formatCloudCountdown(remaining)} unless you ${until}.`
      : `Viewers see Be right back until you ${until}.`
    : null
  if (onAir?.waiting) {
    return {
      title: 'Your show is waiting for another device.',
      detail: [guests, hold].filter(Boolean).join(' ') || null,
      action: 'continue',
      tone: 'warning',
      pointer: CONTINUE_ON_PHONE
    }
  }
  // Plan 224 C-G8: a talk show's guests keep talking; Resume rejoins the room.
  return {
    title: "You're still live through Videorc Cloud.",
    detail: talk
      ? [guests, hold].filter(Boolean).join(' ')
      : (hold ?? 'Your stream is still on air.'),
    action: 'resume',
    tone: 'warning',
    pointer: null
  }
}

/**
 * The notice while the Studio goes back into the room by itself after a
 * backend restart (2026-11-19, `lib/talk-show-auto-rejoin.ts`): it says so,
 * and nothing is asked of the host. Only a talk show this computer resumes:
 * a show another device has keeps its own words and Continue here.
 */
export function rejoiningResumeNotice(notice: CloudResumeNotice): CloudResumeNotice {
  if (notice.action !== 'resume') return notice
  return { ...notice, title: 'Reconnecting to your show…', tone: 'default' }
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
