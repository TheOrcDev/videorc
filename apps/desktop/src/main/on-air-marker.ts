import { join } from 'node:path'

/**
 * The on-air marker (2026-11-19 live incident): `<userData>/on-air.json`
 * exists while this app is live, and holds this process's pid.
 *
 * Builds and app smokes on the owner's Mac wait while Videorc is live
 * (`scripts/lib/host-lock.mjs`, `waitWhileVideorcLive`), so the stream keeps
 * the CPU. That guard looked only for a local ffmpeg pushing FLV to a real
 * ingest. A cloud talk show has no such process: the room publishes over
 * WebRTC and the runner encodes in the cloud. During one, agent builds and
 * tests ran at a 15-minute load of 38 on 10 cores; the host lost the room
 * and the picture dropped to ~360p. Main already knows when a livestream is
 * on air, local or cloud (`LiveExitGuard.livestreamOnAir`), so it says so
 * here for the guard to read.
 *
 * A lost backend socket does not clear the marker: a show stays live while
 * the backend restarts, and that is when the CPU matters most. The marker
 * goes when a status says the livestream is off air, or when the app quits.
 * The guard checks the pid, so a crashed app never holds builds back.
 */
export const ON_AIR_MARKER_FILE = 'on-air.json'

export function onAirMarkerPath(userDataDir: string): string {
  return join(userDataDir, ON_AIR_MARKER_FILE)
}

export type OnAirMarkerIo = {
  write: (path: string, text: string) => void
  remove: (path: string) => void
}

export class OnAirMarker {
  #onAir: boolean | null = null

  constructor(
    private readonly path: string,
    private readonly io: OnAirMarkerIo,
    private readonly pid: number = process.pid,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Writes or removes the marker when on air changes; never throws. */
  update(onAir: boolean): void {
    if (onAir === this.#onAir) return
    this.#onAir = onAir
    try {
      if (onAir) {
        this.io.write(
          this.path,
          JSON.stringify({ v: 1, onAir: true, pid: this.pid, since: this.now().toISOString() })
        )
      } else {
        this.io.remove(this.path)
      }
    } catch (error) {
      // The marker only steers local build tooling; the app never depends on it.
      console.warn(
        `[on-air-marker] could not ${onAir ? 'write' : 'remove'} ${this.path}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}
