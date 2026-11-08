import { isActiveRecordingState, type MainCaptureState } from '../shared/capture-state'

/**
 * Keeps the display awake while a recording or livestream runs. macOS stops
 * every ScreenCaptureKit stream when the display sleeps (-3815), so a take
 * with no keyboard or mouse input past the display-sleep timer froze the
 * screen and lost System audio for the rest of the session (E2E 2026-11-01).
 *
 * Only a session that writes or sends something holds it: main reads the
 * buffer-only Clips session as idle, and an unknown state (no event socket)
 * never holds the display.
 *
 * Pure: no Electron. `start` returns the blocker id `stop` releases
 * (Electron's `powerSaveBlocker`).
 */
export class DisplaySleepGuard {
  private blocker: number | null = null

  constructor(
    private readonly start: () => number,
    private readonly stop: (id: number) => void
  ) {}

  /** Main's capture state after a `recording.status` or a lost event socket. */
  update(state: MainCaptureState): void {
    const wanted = state !== 'unknown' && isActiveRecordingState(state)
    if (wanted && this.blocker === null) {
      this.blocker = this.start()
    } else if (!wanted && this.blocker !== null) {
      this.stop(this.blocker)
      this.blocker = null
    }
  }

  get holding(): boolean {
    return this.blocker !== null
  }
}
