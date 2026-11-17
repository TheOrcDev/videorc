/**
 * Plan 249 S12: edits made while a scene is on the room program (a Freeform
 * drag, a nudge, a reset, a source shown or hidden, a look change, new guest
 * roles) go to the room through the same scene adapter, coalesced:
 *
 * - Latest state: `send` reads the scene as it is when it runs, never a copy
 *   taken when the edit was made, so a burst of drags is one send of the last.
 * - Bounded: one send in flight and at most one waiting; sends start at
 *   least `minIntervalMs` apart.
 * - Fenced: `cancel` (a scene chosen, a clear, another room) bumps the
 *   generation; a waiting send is dropped and a running one is told it is stale.
 */
export type RoomSceneResenderDeps = {
  /** Sends the current scene. `stale()` turns true once a newer generation began. */
  send(stale: () => boolean): Promise<void>
  now(): number
  minIntervalMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export class RoomSceneResender {
  readonly #deps: RoomSceneResenderDeps
  #generation = 0
  #timer: unknown = null
  #inFlight = false
  #dirty = false
  #lastStart = -Infinity
  /** Sends started, for diagnostics and tests. */
  started = 0

  constructor(deps: RoomSceneResenderDeps) {
    this.#deps = deps
  }

  get generation(): number {
    return this.#generation
  }

  get pending(): boolean {
    return this.#dirty || this.#inFlight || this.#timer !== null
  }

  request(): void {
    this.#dirty = true
    this.#pump()
  }

  cancel(): void {
    this.#generation++
    this.#dirty = false
    if (this.#timer !== null) {
      ;(this.#deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(
        this.#timer
      )
      this.#timer = null
    }
  }

  #pump(): void {
    if (this.#inFlight || this.#timer !== null || !this.#dirty) return
    const interval = this.#deps.minIntervalMs ?? 120
    const wait = Math.max(0, this.#lastStart + interval - this.#deps.now())
    const setTimer = this.#deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.#timer = setTimer(() => {
      this.#timer = null
      void this.#run()
    }, wait)
  }

  async #run(): Promise<void> {
    if (!this.#dirty || this.#inFlight) return
    this.#dirty = false
    this.#inFlight = true
    this.#lastStart = this.#deps.now()
    this.started++
    const generation = this.#generation
    try {
      await this.#deps.send(() => generation !== this.#generation)
    } catch {
      /* The sender reports its own failures; a failed send never wedges the queue. */
    } finally {
      this.#inFlight = false
      this.#pump()
    }
  }
}

/** What the edit sync needs from the Studio, read when a send runs. */
export type RoomSceneEditSyncDeps<Room, Target, Result> = {
  /** A scene is on this room's program, scenes are on, and the room holds the camera. */
  live(): boolean
  /** The room connection now; a send for another one is dropped. */
  room(): Room | null
  /** The scene as it is now: the native working layout, sources, background, guest roles. */
  target(): Target
  /** One send through the scene adapter, as a cut; `current()` is checked at its commit. */
  send(target: Target, current: () => boolean): Promise<Result>
  /** A send that failed (not superseded, not merely unconfirmed). */
  failed(result: Result): string | null
  warn(message: string): void
  now(): number
  minIntervalMs?: number
  setTimer?: RoomSceneResenderDeps['setTimer']
  clearTimer?: RoomSceneResenderDeps['clearTimer']
}

/**
 * Plan 249 S12: edits made while a scene is on the room program, sent through
 * the scene adapter with the coalescing, latest-state and generation rules
 * above, and fenced to the room the edit was made in.
 */
export function createRoomSceneEditSync<Room, Target, Result>(
  deps: RoomSceneEditSyncDeps<Room, Target, Result>
): { request(): void; cancel(): void; readonly resender: RoomSceneResender } {
  let requestedRoom: Room | null = null
  const resender = new RoomSceneResender({
    now: deps.now,
    minIntervalMs: deps.minIntervalMs,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    send: async (stale) => {
      const room = deps.room()
      if (!deps.live() || room === null || room !== requestedRoom) return
      const result = await deps.send(
        deps.target(),
        () => !stale() && deps.live() && deps.room() === room
      )
      if (stale() || deps.room() !== room) return
      const failure = deps.failed(result)
      if (failure) deps.warn(failure)
    }
  })
  return {
    resender,
    request() {
      if (!deps.live()) return
      requestedRoom = deps.room()
      resender.request()
    },
    cancel() {
      resender.cancel()
    }
  }
}
