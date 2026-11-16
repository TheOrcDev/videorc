import type { AppExitKind } from '../shared/backend'
import { livestreamOnAirFromPayload } from '../shared/capture-state'

export type { AppExitKind }

/**
 * Quitting or closing the main window while on air asks first (plan 174
 * S3.1, D2). Main reads "on air" from the backend's own `recording.status`
 * events, holds the quit or the close, and asks the renderer to put up the
 * End livestream question; the renderer ends the livestream on a yes and
 * answers through `app:exit`, which lets that one exit through. A quit that
 * is not the person's (a smoke harness, a shutdown signal, the recovery
 * dialog's own Quit) is allowed up front and never waits.
 *
 * Plan 243 C5: on a managed cloud show the question also offers "Quit and
 * keep it live". The renderer hands the show off first (`cloud.show.handOff`,
 * which stops this computer's session without ending the show) and answers
 * through the same `app:exit` only once the hand-off succeeded, so a quit
 * never ends a show the person chose to keep live.
 *
 * Pure: no Electron, so the decisions are tested as data.
 */
export class LiveExitGuard {
  private onAir = false
  private talkOnAir = false
  private allowed: AppExitKind | null = null

  /** A `recording.status` payload from the backend event socket. */
  observeRecordingStatus(payload: unknown): void {
    this.onAir = livestreamOnAirFromPayload(payload)
  }

  /**
   * Plan 243 R2 B-M1: a `cloud.state` payload (or the `cloud.status` answer).
   * A talk show has no local session: its livestream is the room's.
   */
  observeCloudStatus(payload: unknown): void {
    this.talkOnAir = talkHostOnAirFromCloudStatus(payload)
  }

  /** The event socket is gone: there is no livestream main could still protect. */
  transportLost(): void {
    this.onAir = false
    this.talkOnAir = false
  }

  get livestreamOnAir(): boolean {
    return this.onAir || this.talkOnAir
  }

  /** Let the next exit of this kind through without asking. */
  allow(kind: AppExitKind): void {
    this.allowed = kind
  }

  /**
   * Whether this exit must wait for the renderer's answer. An allowance is
   * spent by the exit it was given for, so a later livestream asks again.
   * Only a renderer that can show the question is worth asking; without
   * one, the exit proceeds as it always did.
   */
  shouldAsk(kind: AppExitKind, rendererCanAnswer: boolean): boolean {
    if (this.allowed === kind) {
      this.allowed = null
      return false
    }
    return this.livestreamOnAir && rendererCanAnswer
  }
}

/**
 * Plan 243 R2 B-M1: this computer hosts a talk show that is on air: the room
 * is open and live, no stop was just reported (`stoppedBy`: handed off or
 * taken over), and `onAir`, when the web sends it, names this computer and
 * no wait. Read field by field: main never trusts more of the status.
 */
export function talkHostOnAirFromCloudStatus(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const status = payload as {
    room?: { phase?: unknown; live?: unknown } | null
    onAir?: { thisDevice?: unknown; waiting?: unknown } | null
    stoppedBy?: unknown
  }
  const onAir = status.onAir
  return (
    status.room?.phase === 'open' &&
    status.room.live === true &&
    status.stoppedBy === undefined &&
    (onAir === undefined || (onAir?.thisDevice === true && onAir.waiting !== true))
  )
}
