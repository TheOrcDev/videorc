import {
  LATENCY_RELAY_MAX_BYTES,
  LATENCY_SAMPLE_MS,
  LATENCY_TTL_MS,
  NetSampler,
  parseLatencyRelay,
  roomLatency,
  type HeldNetBlock,
  type NetBlock,
  type NetTrack,
  type RoomLatency
} from '../../../shared/room-latency'

// Plan 253 S4: the host measures (docs/cloud/253-latency-contract.md). Three
// reports meet here: the host's own sample of its WebRTC stats, each guest's
// block and the program page's, the last two relayed by the web on
// `videorc.latency.v1`. This joins them into one number per guest and one
// for the program, and lets a number go the moment its report is 25 s old.
//
// It lives in the room client's lazy chunk and imports no LiveKit: the room
// client hands it the tracks of the moment and the bytes it received.

/** What this needs of the room the host is in. */
export type RoomLatencySource = {
  /** `host:<showId>`, or null while the host is not in the room. */
  hostIdentity(): string | null
  /** Is this identity in the room now? A report from someone gone is nobody's. */
  present(identity: string): boolean
  /** The cameras and microphones to sample: each person's, and the host's own. */
  tracks(): NetTrack[]
}

export type RoomLatencyDeps = {
  /** The numbers changed: publish the snapshot again. */
  changed(): void
  clearTimer(handle: unknown): void
  /** Only managed shows measure (D10). Asked before every sample and receipt. */
  enabled(): boolean
  /** A monotonic clock, in ms. */
  now(): number
  /**
   * Plan 253 S7: the numbers after each 10 s sample, for the show's record.
   * Once per sample and never between two: a relay alone reports nothing.
   */
  sampled?(latency: RoomLatency): void
  setInterval(run: () => void, everyMs: number): unknown
  setTimeout(run: () => void, afterMs: number): unknown
}

const NOTHING: RoomLatency = { people: {} }

export class RoomLatencyHost {
  readonly #deps: RoomLatencyDeps
  readonly #sampler: NetSampler
  #source: RoomLatencySource | null = null
  #timer: unknown = null
  #expiry: unknown = null
  #host: { block: NetBlock; atMs: number } | null = null
  readonly #reports = new Map<string, { block: NetBlock; atMs: number }>()
  #current: RoomLatency = NOTHING
  #sampling = false

  constructor(deps: RoomLatencyDeps) {
    this.#deps = deps
    this.#sampler = new NetSampler(deps.now)
  }

  /** The numbers as of the last change. Never older than a report's 25 s. */
  get current(): RoomLatency {
    return this.#current
  }

  /**
   * The host is in (or joining) this room. On a managed show: a first
   * reading at once, then one sample per 10 s. On any other show nothing
   * runs, not even a timer (D10).
   */
  start(source: RoomLatencySource): void {
    this.stop()
    this.#source = source
    this.#arm()
  }

  /**
   * The sample timer, once the show is known to be managed. Asked again at
   * a relay, in case the show's status arrived after the room did.
   */
  #arm(): void {
    if (this.#timer !== null || !this.#source || !this.#deps.enabled()) return
    void this.#sample()
    this.#timer = this.#deps.setInterval(() => void this.#sample(), LATENCY_SAMPLE_MS)
  }

  stop(): void {
    if (this.#timer !== null) this.#deps.clearTimer(this.#timer)
    if (this.#expiry !== null) this.#deps.clearTimer(this.#expiry)
    this.#timer = null
    this.#expiry = null
    this.#source = null
    this.#sampler.reset()
    this.#host = null
    this.#reports.clear()
    this.#current = NOTHING
  }

  /** The connection was replaced: its counters start again. Reports stay. */
  reconnected(): void {
    this.#sampler.reset()
  }

  /** Someone left: their report is nobody's now. */
  left(identity: string): void {
    if (this.#reports.delete(identity)) this.#recompute()
  }

  /**
   * A message on `videorc.latency.v1` that the server sent (the caller has
   * checked it has no participant as its sender). Anything else than a
   * well-formed block from someone in the room is dropped.
   */
  received(payload: Uint8Array): void {
    const source = this.#source
    if (!source || !this.#deps.enabled() || payload.length > LATENCY_RELAY_MAX_BYTES) return
    this.#arm()
    let relay: ReturnType<typeof parseLatencyRelay>
    try {
      relay = parseLatencyRelay(JSON.parse(new TextDecoder().decode(payload)))
    } catch {
      return
    }
    if (!relay || relay.identity === source.hostIdentity() || !source.present(relay.identity))
      return
    // Aged from its arrival here, on this clock. The web's `at` is not used (D1).
    this.#reports.set(relay.identity, { block: relay.net, atMs: this.#deps.now() })
    this.#recompute()
  }

  async #sample(): Promise<void> {
    const source = this.#source
    if (!source || this.#sampling) return
    if (!this.#deps.enabled() || source.hostIdentity() === null) {
      // A node show, or between rooms: nothing is measured or kept.
      this.#sampler.reset()
      if (this.#host || this.#reports.size > 0) {
        this.#host = null
        this.#reports.clear()
        this.#recompute()
      }
      return
    }
    this.#sampling = true
    try {
      const block = await this.#sampler.sample(source.tracks())
      if (this.#source !== source) return
      if (block) this.#host = { block, atMs: this.#deps.now() }
    } catch {
      // A failed sample is no block this time. The last one ages out.
    } finally {
      this.#sampling = false
    }
    if (this.#source !== source) return
    this.#recompute()
    this.#deps.sampled?.(this.#current)
  }

  #recompute(): void {
    const source = this.#source
    if (!source) return
    const now = this.#deps.now()
    const hostIdentity = source.hostIdentity()
    for (const [identity, report] of this.#reports)
      if (now - report.atMs > LATENCY_TTL_MS || !source.present(identity))
        this.#reports.delete(identity)
    if (this.#host && now - this.#host.atMs > LATENCY_TTL_MS) this.#host = null
    const host: HeldNetBlock | null =
      this.#host && hostIdentity ? { identity: hostIdentity, ...this.#host } : null
    const next = roomLatency({
      nowMs: now,
      host,
      reports: [...this.#reports].map(([identity, report]) => ({ identity, ...report }))
    })
    // The 25 s rule, to the millisecond: look again when the oldest block
    // in use runs out, so its number goes away instead of going stale.
    if (this.#expiry !== null) this.#deps.clearTimer(this.#expiry)
    this.#expiry = null
    const oldest = Math.min(
      this.#host?.atMs ?? Infinity,
      ...[...this.#reports.values()].map((report) => report.atMs)
    )
    if (Number.isFinite(oldest))
      this.#expiry = this.#deps.setTimeout(
        () => {
          this.#expiry = null
          this.#recompute()
        },
        Math.max(0, oldest + LATENCY_TTL_MS - now) + 1
      )
    if (JSON.stringify(next) === JSON.stringify(this.#current)) return
    this.#current = next
    this.#deps.changed()
  }
}
