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
 * Pure: no Electron, so the decisions are tested as data.
 */
export class LiveExitGuard {
  private onAir = false
  private allowed: AppExitKind | null = null

  /** A `recording.status` payload from the backend event socket. */
  observeRecordingStatus(payload: unknown): void {
    this.onAir = livestreamOnAirFromPayload(payload)
  }

  /** The event socket is gone: there is no livestream main could still protect. */
  transportLost(): void {
    this.onAir = false
  }

  get livestreamOnAir(): boolean {
    return this.onAir
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
    return this.onAir && rendererCanAnswer
  }
}
