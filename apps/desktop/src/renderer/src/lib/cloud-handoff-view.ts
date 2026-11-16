import type { CloudOnAir, CloudStatus } from './backend'
import { endLivestreamBody, type SessionStopOrigin } from './session-stop'

// Plan 243 C5: continuing a live cloud show on another device, in words. The
// End livestream question's third answer, the Studio's cloud notice and the
// taken-over toast read it. Pure, and only those lazy surfaces import it, so
// none of this copy joins the eager renderer bundle.

/**
 * The hand-off is offered on a managed show (videorc.com runs it, `nodeId`
 * "livekit") that this computer is on air for, solo or talk. Read when the
 * question shows, so a show taken over meanwhile drops the answer.
 */
export function offersHandOff(status: CloudStatus | null): boolean {
  const onAir = status?.onAir
  return Boolean(
    status?.show?.nodeId === 'livekit' &&
    status.show.kind !== 'test' &&
    onAir?.thisDevice &&
    !onAir.waiting
  )
}

/** The End livestream question's hand-off answer, inside the app. */
export const HAND_OFF_LABEL = 'Continue on another device'

/** What the hand-off does for viewers, named by the answer that does it. */
export const HAND_OFF_CONSEQUENCE =
  'viewers see Be right back until you continue on your phone or another computer.'

/** Where a phone picks the show up (the web's `/live/continue`, D5). */
export const CONTINUE_ON_PHONE = 'On your phone, open videorc.com/live/continue.'

/** The hand-off answer says the exit too when the app is leaving. */
export function handOffLabel(origin: SessionStopOrigin): string {
  switch (origin) {
    case 'quit':
      return 'Quit and keep it live'
    case 'close-window':
      return 'Close and keep it live'
    default:
      return HAND_OFF_LABEL
  }
}

/**
 * The question's body when the hand-off is offered: what End does, what the
 * hand-off does, and the recording, which stops and is saved either way.
 */
export function handOffQuestionBody({
  origin,
  platforms,
  alsoRecords
}: {
  origin: SessionStopOrigin
  platforms: readonly string[]
  alsoRecords: boolean
}): string {
  return [
    endLivestreamBody({ platforms, alsoRecords: false }),
    `With ${handOffLabel(origin)}, ${HAND_OFF_CONSEQUENCE}`,
    alsoRecords ? 'Your recording stops either way and is saved to the Library.' : null
  ]
    .filter(Boolean)
    .join(' ')
}

/** "iPhone", or the kind when the device sent no name (an old desktop). */
export function onAirDeviceName(onAir: CloudOnAir | undefined): string {
  if (onAir?.name) return onAir.name
  switch (onAir?.kind) {
    case 'phone':
      return 'a phone'
    case 'browser':
      return 'a browser'
    case 'computer':
      return 'another computer'
    default:
      return 'another device'
  }
}

/** The neutral toast when another device continued the show (C5). */
export function cloudTakenOverToast(onAir: CloudOnAir | undefined): string {
  return `Your show continues on ${onAirDeviceName(onAir)}.`
}
