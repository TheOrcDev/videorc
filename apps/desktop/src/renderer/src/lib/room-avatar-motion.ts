import type { AnimatorSettings } from '../../../shared/buddy-animator'
import type { CohostPetAnimatorEvent } from '../../../shared/buddy-animator-public'
import {
  AVATAR_MOTION_MAX_BYTES,
  MotionProducer,
  type MotionInputs,
  type MotionMessage,
  type MotionOrientation,
  type MotionRect
} from '../../../shared/cloud-avatar-motion'

/**
 * Plan 249 S5: the desktop side of the avatar's cloud animation. Turns the
 * backend's public animator inputs (`cohost.pet.animator`), the Buddy's
 * layout, the accepted highlight card and the worn atlas into the bounded
 * motion stream, and hands each message to the transport for the consumers
 * S4's capability receipts authorize (EG_ identities advertising
 * `graphics.animation: 1`). It never sees bubble text or prompts: the
 * backend's projection already dropped them.
 *
 * Transport-agnostic so S4's publisher owns targeting, receipts and leases;
 * this class owns the clock, ids, keyframes and their cadence.
 */
export const ROOM_AVATAR_MOTION_FLUSH_MS = 100

export interface RoomAvatarMotionDeps {
  show: string
  publisherSid: string
  now(): number
  /** Send one message to these identities; failures are reported, never retried as stale bytes. */
  send(bytes: Uint8Array<ArrayBuffer>, identities: string[]): Promise<void>
  random?: () => Uint8Array
}

export type RoomAvatarMotionStatus = {
  consumers: number
  sent: number
  failed: string | null
  epoch: string
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export class RoomAvatarMotion {
  readonly #producer: MotionProducer
  readonly #deps: RoomAvatarMotionDeps
  #consumers = new Set<string>()
  #sent = 0
  #failed: string | null = null
  #busy = false
  #closed = false
  #forceKeyframe = true

  constructor(deps: RoomAvatarMotionDeps, settings: AnimatorSettings, inputs: MotionInputs) {
    this.#deps = deps
    const random = deps.random ?? randomBytes
    const seedBytes = random(8)
    const seed = seedBytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
    const epoch = Array.from(random(12), (b) => b.toString(16).padStart(2, '0')).join('')
    this.#producer = new MotionProducer(
      { show: deps.show, publisherSid: deps.publisherSid, now: deps.now, epoch, seed },
      settings,
      inputs
    )
  }

  get epoch(): string {
    return this.#producer.epoch
  }

  /** The producer's own simulation: the desktop monitor may draw it directly. */
  get sim() {
    return this.#producer.sim
  }

  status(): RoomAvatarMotionStatus {
    return {
      consumers: this.#consumers.size,
      sent: this.#sent,
      failed: this.#failed,
      epoch: this.#producer.epoch
    }
  }

  /** Step the producer's simulation to now without sending (the desktop's Program preview). */
  advance(): void {
    if (!this.#closed) this.#producer.advance()
  }

  /** A public projection from the backend. State first, as the backend applies them together. */
  backend(payload: CohostPetAnimatorEvent): void {
    if (this.#closed) return
    if (payload.avatarState) this.#producer.push({ kind: 'state', state: payload.avatarState })
    if (payload.event) this.#producer.push(payload.event)
  }

  layout(rects: Record<MotionOrientation, MotionRect>): void {
    if (!this.#closed) this.#producer.push({ kind: 'layout', rects })
  }

  /** The accepted highlight card per output (S4/S6's card overlay rect), or nulls. */
  cards(cards: Record<MotionOrientation, MotionRect | null>): void {
    if (!this.#closed) this.#producer.push({ kind: 'cards', cards })
  }

  /** A persona switch: the new atlas hash and its animator meta. */
  pack(atlasHash: string, pack: MotionInputs['pack']): void {
    if (this.#closed) return
    this.#producer.push({ kind: 'pack', atlasHash, pack })
    this.#forceKeyframe = true
  }

  /** The currently authorized motion consumers; a newcomer gets a keyframe at once. */
  setConsumers(identities: Iterable<string>): void {
    const next = new Set(identities)
    for (const identity of next) if (!this.#consumers.has(identity)) this.#forceKeyframe = true
    this.#consumers = next
  }

  /** Call every `ROOM_AVATAR_MOTION_FLUSH_MS`: step the clock, send what is due. */
  async flush(): Promise<void> {
    if (this.#closed || this.#busy) return
    this.#busy = true
    try {
      const messages: MotionMessage[] = this.#producer.flush(this.#forceKeyframe)
      this.#forceKeyframe = false
      const targets = [...this.#consumers]
      if (!targets.length) return
      let failed: string | null = null
      for (const message of messages) {
        const bytes = new TextEncoder().encode(JSON.stringify(message))
        if (bytes.length > AVATAR_MOTION_MAX_BYTES) {
          failed = "Couldn't send the avatar's motion: it is too large. Outputs hold its pose."
          continue
        }
        await this.#deps.send(bytes, targets)
        this.#sent += 1
      }
      this.#failed = failed
    } catch {
      this.#failed = "Couldn't send the avatar's motion. Outputs hold its pose and catch up."
      this.#forceKeyframe = true
    } finally {
      this.#busy = false
    }
  }

  close(): void {
    this.#closed = true
    this.#consumers.clear()
  }
}
