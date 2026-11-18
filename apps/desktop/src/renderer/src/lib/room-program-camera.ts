/**
 * Plan 249 S23 (D10): the host's opt-in to show the room's Program preview on
 * Videorc Camera, and the producer that sends its frames.
 *
 * - The opt-in is per room: it starts off, is never remembered, and ends with
 *   the room (`retireRoomProgramCamera`). Turning it on opens one upload in
 *   main for a new generation; Videorc Camera follows that upload.
 * - The producer runs only while the Program preview is mounted. When it is
 *   not (another page, the room view collapsed), no frame is sent and the
 *   camera pauses on a black still: it never switches back to the Studio
 *   program by itself while the opt-in is on.
 * - A broken upload (`closed`: the backend restarted or refused) reopens once
 *   under a new generation, at most once a second; generations only grow.
 */
import {
  ROOM_PROGRAM_CAMERA_FPS,
  ROOM_PROGRAM_CAMERA_HEIGHT,
  ROOM_PROGRAM_CAMERA_WIDTH,
  type RoomProgramCameraFrame,
  type RoomProgramCameraSendOutcome
} from '../../../shared/room-program-camera'
import { collectRasterOps, paintRasterOps } from './room-program-raster'

export interface RoomProgramCameraApi {
  openRoomProgramCamera: (generation: number) => Promise<unknown>
  sendRoomProgramCameraFrame: (
    frame: RoomProgramCameraFrame
  ) => Promise<RoomProgramCameraSendOutcome>
  closeRoomProgramCamera: (generation: number) => Promise<unknown>
}

export type RoomProgramCameraState = {
  on: boolean
  /** The open upload's generation; null while off or reopening. */
  generation: number | null
  /** The room the opt-in belongs to (`host:<showId>`). */
  hostIdentity: string | null
  error: string | null
}

const OFF: RoomProgramCameraState = Object.freeze({
  on: false,
  generation: null,
  hostIdentity: null,
  error: null
})

/** Seconds since the epoch, or one past the last: generations only grow, even
 * across a renderer reload (main remembers the last one it saw). */
export function nextRoomProgramGeneration(last: number, nowMs: number): number {
  return Math.max(last + 1, Math.floor(nowMs / 1000))
}

export class RoomProgramCameraStore {
  private state: RoomProgramCameraState = OFF
  private readonly listeners = new Set<() => void>()
  private lastGeneration = 0
  private lastReopenAt = -Infinity
  /** Serializes open/close so a quick toggle never leaves two uploads. */
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly api: () => RoomProgramCameraApi | null,
    private readonly now: () => number = Date.now
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): RoomProgramCameraState => this.state

  private set(next: RoomProgramCameraState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  private queue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => {})
    return run
  }

  /** Turn the room program on or off for `hostIdentity`'s room. */
  setOn(on: boolean, hostIdentity: string | null): Promise<void> {
    return this.queue(async () => {
      if (on) {
        if (!hostIdentity) throw new Error('No room is open.')
        if (this.state.on && this.state.hostIdentity === hostIdentity) return
        await this.closeCurrent()
        await this.open(hostIdentity)
      } else {
        await this.closeCurrent()
        this.set(OFF)
      }
    })
  }

  /** The room ended or changed: an opt-in for another room ends. */
  retire(hostIdentity: string | null): Promise<void> {
    if (!this.state.on || this.state.hostIdentity === hostIdentity) return Promise.resolve()
    return this.setOn(false, null)
  }

  /** The upload broke: reopen under a new generation, at most once a second. */
  reopen(generation: number): Promise<void> {
    return this.queue(async () => {
      if (!this.state.on || this.state.generation !== generation) return
      const hostIdentity = this.state.hostIdentity
      if (this.now() - this.lastReopenAt < 1000 || !hostIdentity) {
        this.set({
          ...this.state,
          generation: null,
          error: 'Videorc Camera lost the room program.'
        })
        return
      }
      this.lastReopenAt = this.now()
      await this.open(hostIdentity)
    })
  }

  private async open(hostIdentity: string): Promise<void> {
    const api = this.api()
    if (!api) throw new Error('Videorc Camera is unavailable here.')
    const generation = nextRoomProgramGeneration(this.lastGeneration, this.now())
    this.lastGeneration = generation
    try {
      await api.openRoomProgramCamera(generation)
      this.set({ on: true, generation, hostIdentity, error: null })
    } catch (error) {
      this.set({ ...OFF, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  private async closeCurrent(): Promise<void> {
    const generation = this.state.generation
    if (generation === null) return
    this.set({ ...this.state, generation: null })
    await this.api()
      ?.closeRoomProgramCamera(generation)
      .catch(() => {})
  }
}

// --- Producer -------------------------------------------------------------------

export interface RoomProgramProducerDeps {
  /** The Program preview's picture box, or null while it is not mounted. */
  container: () => HTMLElement | null
  send: (frame: RoomProgramCameraFrame) => Promise<RoomProgramCameraSendOutcome>
  /** The upload is gone: the store opens a new generation. */
  onClosed: (generation: number) => void
  /** A 1280x720 2D context that reads back cheaply. */
  context: () => CanvasRenderingContext2D | null
  now?: () => number
}

export interface RoomProgramProducerStats {
  framesSent: number
  framesBusy: number
  framesSkipped: number
}

/**
 * Draws the Program preview 30 times a second and sends each frame; one send
 * in flight at most (a tick while one is in flight is skipped, never queued).
 * Timers, not animation frames: a hidden window still sends.
 */
export class RoomProgramCameraProducer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private sequence = 0
  private inFlight = false
  private deadline = 0
  readonly stats: RoomProgramProducerStats = { framesSent: 0, framesBusy: 0, framesSkipped: 0 }

  constructor(
    private readonly generation: number,
    private readonly deps: RoomProgramProducerDeps
  ) {}

  start(): void {
    if (this.timer !== null || this.stopped) return
    this.deadline = this.now()
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))()
  }

  private schedule(): void {
    const interval = 1000 / ROOM_PROGRAM_CAMERA_FPS
    const now = this.now()
    this.deadline += interval
    // More than one interval late: re-sync instead of bursting.
    if (this.deadline + interval < now) this.deadline = now
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.tick()
        if (this.timer === null && !this.stopped) this.schedule()
      },
      Math.max(0, this.deadline - now)
    )
  }

  /** One frame now (exposed for tests). */
  tick(): void {
    if (this.stopped) return
    if (this.inFlight) {
      this.stats.framesSkipped += 1
      return
    }
    const container = this.deps.container()
    const context = this.deps.context()
    if (!container || !context) {
      this.stats.framesSkipped += 1
      return
    }
    const raster = collectRasterOps(
      container,
      ROOM_PROGRAM_CAMERA_WIDTH,
      ROOM_PROGRAM_CAMERA_HEIGHT
    )
    if (!raster) {
      // Not displayed: send nothing, so the camera pauses rather than show a guess.
      this.stats.framesSkipped += 1
      return
    }
    paintRasterOps(
      context,
      ROOM_PROGRAM_CAMERA_WIDTH,
      ROOM_PROGRAM_CAMERA_HEIGHT,
      raster.ground,
      raster.ops
    )
    const image = context.getImageData(0, 0, ROOM_PROGRAM_CAMERA_WIDTH, ROOM_PROGRAM_CAMERA_HEIGHT)
    this.sequence += 1
    const frame: RoomProgramCameraFrame = {
      generation: this.generation,
      sequence: this.sequence,
      drawnAtUs: Math.round(Date.now() * 1000),
      pixels: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    }
    this.inFlight = true
    void this.deps
      .send(frame)
      .then((outcome) => {
        if (outcome === 'sent') this.stats.framesSent += 1
        else if (outcome === 'busy' || outcome === 'offline') this.stats.framesBusy += 1
        else {
          const running = !this.stopped
          this.stop()
          if (running) this.deps.onClosed(this.generation)
        }
      })
      .catch(() => {
        this.stats.framesBusy += 1
      })
      .finally(() => {
        this.inFlight = false
      })
  }
}
