/**
 * Plan 249 S5: the avatar's animation on cloud outputs. Mirrored in the
 * program client (`lib/cloud/program/cloud-avatar-motion.ts`): the same
 * source reformatted by that repo's Prettier, nothing else.
 *
 * The desktop runs `BuddyAnimator` (the compositor's rules, ported in
 * `buddy-animator.ts`) on a fixed 60 Hz show clock, and sends consumers the
 * public inputs it applied: timestamped, id-numbered events and, every two
 * seconds, a keyframe of the whole state. Every consumer simulates the same
 * ticks from the same keyframe and events, so they draw the same cell and
 * motion at the same show time as each other and as the desktop monitor.
 *
 * - Late join: a consumer starts from the newest keyframe (with the events it
 *   had not applied yet), never from replayed history.
 * - No duplicate reactions: events carry ids; a keyframe names the last id it
 *   folded in; an id is applied at most once per simulation.
 * - Late delivery: an event older than the simulated time rewinds to the
 *   baseline keyframe and resimulates (bounded: a keyframe is at most a few
 *   seconds old), so every consumer converges on the producer's state.
 * - Nothing private crosses: utterances are mood, length and bubble time;
 *   reactions are chains the desktop already resolved. No text, prompt,
 *   persona table or local path.
 * - The atlas pixels and cell rects ride S4's avatar layer (`atlas` meta,
 *   validated against the PNG). This stream only names the atlas hash the
 *   simulation used; a consumer whose layer differs draws the neutral cell
 *   at rest instead of a wrong pose.
 */

import {
  ANIMATOR_DEFAULT_SETTINGS,
  BuddyAnimator,
  type AnimatorAvatarState,
  type AnimatorDraw,
  type AnimatorEvent,
  type AnimatorLeg,
  type AnimatorMood,
  type AnimatorPack,
  type AnimatorSettings,
  type AnimatorState
} from './buddy-animator'
import {
  AVATAR_ATLAS_MAX_CELLS,
  AVATAR_ATLAS_MAX_TALK,
  AVATAR_ATLAS_MIN_CELL_PX,
  parseAnimatorPack,
  parseAvatarAtlasMeta,
  type AvatarAtlasMeta
} from './cloud-avatar-atlas-meta'

export {
  AVATAR_ATLAS_MAX_CELLS,
  AVATAR_ATLAS_MAX_TALK,
  AVATAR_ATLAS_MIN_CELL_PX,
  parseAnimatorPack,
  parseAvatarAtlasMeta,
  type AvatarAtlasMeta
}

export const AVATAR_MOTION_TOPIC = 'videorc.presentation.avatar-motion.v1'
/** The simulation clock: every consumer steps the same ticks. */
export const AVATAR_MOTION_TICK_HZ = 60
/** One message's JSON, at most. */
export const AVATAR_MOTION_MAX_BYTES = 16 * 1024
export const AVATAR_MOTION_MAX_EVENTS = 16
/** Producer keyframe period; a consumer never resimulates much more than this. */
export const AVATAR_MOTION_KEYFRAME_MS = 2000
/** No message for this long: stop animating, draw the neutral cell at rest. */
export const AVATAR_MOTION_LEASE_MS = 10_000
/** Consumers draw this far behind the producer's clock to absorb delivery jitter. */
export const AVATAR_MOTION_PLAYOUT_MS = 200
/** Messages a consumer accepts per second (bursts beyond are dropped). */
export const AVATAR_MOTION_RATE_PER_SECOND = 20
/** The most ticks one `advance` simulates; beyond that the consumer waits for a keyframe. */
export const AVATAR_MOTION_MAX_CATCH_UP_TICKS = 6 * AVATAR_MOTION_TICK_HZ
export const AVATAR_REACTION_CHAIN_MAX = 8
/** Managed outputs are 1080p: `h` is 1920 x 1080 and `v` 1080 x 1920. */
export const AVATAR_MOTION_CANVAS = Object.freeze({
  h: [1920, 1080] as const,
  v: [1080, 1920] as const
})

export type MotionOrientation = 'h' | 'v'
const LEG: Record<MotionOrientation, AnimatorLeg> = { h: 0, v: 1 }
export type MotionRect = { x: number; y: number; w: number; h: number }

/** Inputs the simulation reads besides events: the compositor's leg context. */
export interface MotionInputs {
  avatarState: AnimatorAvatarState
  /** The Buddy's layout rect per orientation (`overlayLayout.buddy`). */
  rects: Record<MotionOrientation, MotionRect>
  /** The accepted highlight card's rect per orientation, while one shows. */
  cards: Record<MotionOrientation, MotionRect | null>
  /** The atlas PNG hash (S4 layer asset hash) the pack describes. */
  atlasHash: string
  pack: AnimatorPack
}

export type MotionEvent =
  | AnimatorEvent
  | { kind: 'state'; state: AnimatorAvatarState }
  | { kind: 'layout'; rects: Record<MotionOrientation, MotionRect> }
  | { kind: 'cards'; cards: Record<MotionOrientation, MotionRect | null> }
  | { kind: 'pack'; atlasHash: string; pack: AnimatorPack }

export interface StampedMotionEvent {
  /** Monotonic within the epoch, from 1. */
  id: number
  /** Show seconds (producer clock), millisecond precision. */
  at: number
  event: MotionEvent
}

export interface MotionKeyframe {
  tick: number
  /** Every event up to this id is folded into `animator`/`inputs`. */
  lastEventId: number
  animator: AnimatorState
  inputs: MotionInputs
  /** Events already sent but not applied at `tick`, for a consumer that missed them. */
  pending: StampedMotionEvent[]
}

export interface MotionMessage {
  version: 1
  show: string
  publisherSid: string
  /** One producer run; a new epoch resets every consumer. */
  epoch: string
  /** Per message, monotonic within the epoch. */
  seq: number
  /** Producer wall clock (ms) when sent, and when show time 0 was. */
  sentAt: number
  origin: number
  keyframe: MotionKeyframe | null
  events: StampedMotionEvent[]
}

// --- Geometry (Rust `buddy_sprite::buddy_box`) --------------------------------------------

/** The square the cell fills on a canvas, whole canvas pixels `[x, y, side, side]`. */
export function buddyBox(
  rect: MotionRect,
  canvasWidth: number,
  canvasHeight: number
): [number, number, number, number] {
  const width = Math.max(1, canvasWidth)
  const height = Math.max(1, canvasHeight)
  const cell = Math.max(1, Math.round(rect.w * width))
  const side = Math.min(cell, width, height)
  const left = Math.min(
    width - side,
    Math.max(0, Math.round((rect.x + rect.w / 2) * width - side / 2))
  )
  const bottomGravity = rect.y + rect.h / 2 >= 0.5
  const top = Math.min(
    height - side,
    Math.max(
      0,
      bottomGravity ? Math.round((rect.y + rect.h) * height) - side : Math.round(rect.y * height)
    )
  )
  return [left, top, side, side]
}

// --- Validation of untrusted input --------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown, min = -1e9, max = 1e9): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const int = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && finite(v, min, max)
const REACTION_ID = /^[a-z0-9-]{1,40}$/
const HASH = /^[a-f0-9]{64}$/
const SID = /^PA_[A-Za-z0-9]{1,64}$/
const EPOCH = /^[A-Za-z0-9_-]{8,64}$/
const MOODS = ['talk', 'laugh', 'think'] as const
const STATES = ['idle', 'talk', 'laugh', 'think'] as const

function parseRect(v: unknown): MotionRect | null {
  if (
    !isObject(v) ||
    !finite(v.x, 0, 1) ||
    !finite(v.y, 0, 1) ||
    !finite(v.w, 0, 1) ||
    !finite(v.h, 0, 1)
  )
    return null
  if (v.w <= 0 || v.h <= 0 || v.x + v.w > 1.00001 || v.y + v.h > 1.00001) return null
  return { x: v.x, y: v.y, w: v.w, h: v.h }
}
const pair = (v: unknown, min: number, max: number): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && finite(v[0], min, max) && finite(v[1], min, max)

function parseSettings(v: unknown): AnimatorSettings | null {
  if (!isObject(v) || !finite(v.intensity, 0, 1) || typeof v.breathing !== 'boolean') return null
  if (!int(v.sleepAfterSeconds, 0, 1800) || (v.sleepAfterSeconds !== 0 && v.sleepAfterSeconds < 30))
    return null
  return { intensity: v.intensity, breathing: v.breathing, sleepAfterSeconds: v.sleepAfterSeconds }
}

function parseOrientations<T>(
  v: unknown,
  item: (x: unknown) => T | undefined
): Record<MotionOrientation, T> | null {
  if (!isObject(v)) return null
  const h = item(v.h)
  const vv = item(v.v)
  return h === undefined || vv === undefined ? null : { h, v: vv }
}
const rectOrNull = (x: unknown): MotionRect | null | undefined =>
  x === null ? null : (parseRect(x) ?? undefined)
const rectOnly = (x: unknown): MotionRect | undefined => parseRect(x) ?? undefined

const EVENT_KEYS: Record<string, string[]> = {
  utterance: ['mood', 'chars', 'bubbleSeconds'],
  reaction: ['chain', 'activity'],
  highlight: ['ttlSeconds'],
  settings: ['settings'],
  state: ['state'],
  layout: ['rects'],
  cards: ['cards'],
  pack: ['atlasHash', 'pack']
}

/** One event; unknown fields refuse it (nothing extra, such as text, rides along). */
export function parseMotionEvent(v: unknown): MotionEvent | null {
  if (!isObject(v) || typeof v.kind !== 'string') return null
  const allowed = ['kind', ...(EVENT_KEYS[v.kind] ?? [])]
  if (!Object.keys(v).every((key) => allowed.includes(key))) return null
  switch (v.kind) {
    case 'utterance':
      if (
        !MOODS.includes(v.mood as never) ||
        !int(v.chars, 0, 4000) ||
        !finite(v.bubbleSeconds, 0, 120)
      )
        return null
      return {
        kind: 'utterance',
        mood: v.mood as AnimatorMood,
        chars: v.chars,
        bubbleSeconds: v.bubbleSeconds
      }
    case 'utterance-end':
    case 'think':
    case 'think-settle':
    case 'highlight-idle':
    case 'chat':
      return { kind: v.kind }
    case 'reaction': {
      if (
        !Array.isArray(v.chain) ||
        v.chain.length > AVATAR_REACTION_CHAIN_MAX ||
        typeof v.activity !== 'boolean'
      )
        return null
      if (!v.chain.every((id) => typeof id === 'string' && REACTION_ID.test(id))) return null
      return { kind: 'reaction', chain: [...(v.chain as string[])], activity: v.activity }
    }
    case 'highlight':
      return finite(v.ttlSeconds, 0, 600) ? { kind: 'highlight', ttlSeconds: v.ttlSeconds } : null
    case 'settings': {
      const settings = parseSettings(v.settings)
      return settings ? { kind: 'settings', settings } : null
    }
    case 'state':
      return STATES.includes(v.state as never)
        ? { kind: 'state', state: v.state as AnimatorAvatarState }
        : null
    case 'layout': {
      const rects = parseOrientations(v.rects, rectOnly)
      return rects ? { kind: 'layout', rects } : null
    }
    case 'cards': {
      const cards = parseOrientations(v.cards, rectOrNull)
      return cards ? { kind: 'cards', cards } : null
    }
    case 'pack': {
      const pack = parseAnimatorPack(v.pack)
      return pack && typeof v.atlasHash === 'string' && HASH.test(v.atlasHash)
        ? { kind: 'pack', atlasHash: v.atlasHash, pack }
        : null
    }
    default:
      return null
  }
}

function parseStamped(v: unknown): StampedMotionEvent | null {
  if (!isObject(v) || !int(v.id, 1, Number.MAX_SAFE_INTEGER) || !finite(v.at, 0, 7 * 24 * 3600))
    return null
  const event = parseMotionEvent(v.event)
  return event ? { id: v.id, at: v.at, event } : null
}

function parseInputs(v: unknown): MotionInputs | null {
  if (!isObject(v) || !STATES.includes(v.avatarState as never)) return null
  const rects = parseOrientations(v.rects, rectOnly)
  const cards = parseOrientations(v.cards, rectOrNull)
  const pack = parseAnimatorPack(v.pack)
  if (!rects || !cards || !pack || typeof v.atlasHash !== 'string' || !HASH.test(v.atlasHash))
    return null
  return {
    avatarState: v.avatarState as AnimatorAvatarState,
    rects,
    cards,
    atlasHash: v.atlasHash,
    pack
  }
}

const nullableTime = (v: unknown): v is number | null => v === null || finite(v, -1e7, 1e7)
const channels = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length === 5 && v.every((n) => finite(n, -1e4, 1e4))
const EASES = ['cubic', 'quartic', 'sine', 'elastic']

/** Shape and bounds of an untrusted animator state; `null` when anything is off. */
export function parseAnimatorState(v: unknown): AnimatorState | null {
  if (!isObject(v)) return null
  const settings = parseSettings(v.settings)
  const m = v.motion
  if (!settings || !isObject(m) || !channels(m.state) || !channels(m.velocity)) return null
  if (
    typeof m.springRunning !== 'boolean' ||
    typeof m.idle !== 'boolean' ||
    !finite(m.breathGain, 0, 1) ||
    !nullableTime(m.lastNow)
  )
    return null
  if (m.envelope !== null) {
    const e = m.envelope
    if (
      !isObject(e) ||
      !finite(e.start, -1e7, 1e7) ||
      !finite(e.total, 0, 60) ||
      !Array.isArray(e.segments) ||
      e.segments.length > 8
    )
      return null
    for (const s of e.segments) {
      if (
        !isObject(s) ||
        !finite(s.duration, 0, 60) ||
        !channels(s.from) ||
        !channels(s.to) ||
        typeof s.yoyo !== 'boolean'
      )
        return null
      if (!isObject(s.ease) || !EASES.includes(s.ease.kind as string)) return null
      if (
        s.ease.kind === 'elastic'
          ? !finite(s.ease.period, 0, 10) || Object.keys(s.ease).length !== 2
          : Object.keys(s.ease).length !== 1
      )
        return null
    }
  }
  if (typeof v.rng !== 'string' || !/^[0-9a-f]{1,16}$/.test(v.rng)) return null
  if (!nullableTime(v.frame) || !(v.lead === null || [0, 1, 2].includes(v.lead as number)))
    return null
  const sp = v.speech
  if (!isObject(sp) || !['quiet', 'think', 'bubble'].includes(sp.kind as string)) return null
  if (
    sp.kind === 'bubble'
      ? !MOODS.includes(sp.mood as never) || Object.keys(sp).length !== 2
      : Object.keys(sp).length !== 1
  )
    return null
  const t = v.talk
  if (
    t !== null &&
    (!isObject(t) ||
      !finite(t.until, -1e7, 1e7) ||
      !int(t.steps, 0, 1e7) ||
      !finite(t.nextStepAt, -1e7, 1e7))
  )
    return null
  const hl = v.highlight
  if (hl !== null && (!isObject(hl) || !finite(hl.since, -1e7, 1e7) || !finite(hl.ttl, 0, 600)))
    return null
  const g = v.glance
  if (g !== null && (!isObject(g) || !pair(g.point, -1, 1) || !finite(g.until, -1e7, 1e7)))
    return null
  const b = v.blink
  if (b !== null && (!isObject(b) || !int(b.serial, 0, 1e9) || !finite(b.until, -1e7, 1e7)))
    return null
  if (
    !nullableTime(v.nextGlanceAt) ||
    !nullableTime(v.nextBlinkAt) ||
    !nullableTime(v.lastActivity)
  )
    return null
  if (!int(v.blinkSerial, 0, 1e9) || typeof v.asleep !== 'boolean') return null
  const w = v.wake
  if (w !== null && (!isObject(w) || !finite(w.until, -1e7, 1e7) || typeof w.moved !== 'boolean'))
    return null
  const p = v.playing
  if (
    p !== null &&
    (!isObject(p) ||
      !(p.cell === null || (typeof p.cell === 'string' && REACTION_ID.test(p.cell))) ||
      !finite(p.until, -1e7, 1e7))
  )
    return null
  if (!Array.isArray(v.queue) || v.queue.length > 3) return null
  for (const q of v.queue) {
    if (
      !isObject(q) ||
      !finite(q.at, -1e7, 1e7) ||
      !Array.isArray(q.chain) ||
      q.chain.length < 1 ||
      q.chain.length > AVATAR_REACTION_CHAIN_MAX
    )
      return null
    if (!q.chain.every((id) => typeof id === 'string' && REACTION_ID.test(id))) return null
  }
  if (!Array.isArray(v.legs) || v.legs.length !== 3) return null
  for (const leg of v.legs) {
    if (
      !isObject(leg) ||
      !(leg.gaze === null || pair(leg.gaze, -1, 1)) ||
      !nullableTime(leg.cardSince)
    )
      return null
    if (
      !(
        leg.blink === null ||
        (Array.isArray(leg.blink) &&
          leg.blink.length === 2 &&
          int(leg.blink[0], 0, 1e9) &&
          typeof leg.blink[1] === 'boolean')
      )
    )
      return null
  }
  // Shape checked; a structured copy drops unknown fields' prototypes.
  return JSON.parse(JSON.stringify(v)) as AnimatorState
}

export function parseMotionMessage(
  v: unknown,
  page: { show: string; publisherSid: string }
): MotionMessage | null {
  if (
    !isObject(v) ||
    v.version !== 1 ||
    v.show !== page.show ||
    v.publisherSid !== page.publisherSid
  )
    return null
  if (
    typeof v.publisherSid !== 'string' ||
    !SID.test(v.publisherSid) ||
    typeof v.epoch !== 'string' ||
    !EPOCH.test(v.epoch)
  )
    return null
  if (
    !int(v.seq, 1, Number.MAX_SAFE_INTEGER) ||
    !int(v.sentAt, 1, 8.64e15) ||
    !int(v.origin, 1, 8.64e15) ||
    v.origin > v.sentAt
  )
    return null
  if (!Array.isArray(v.events) || v.events.length > AVATAR_MOTION_MAX_EVENTS) return null
  const events: StampedMotionEvent[] = []
  for (const raw of v.events) {
    const event = parseStamped(raw)
    if (!event || event.id <= (events[events.length - 1]?.id ?? 0)) return null
    events.push(event)
  }
  let keyframe: MotionKeyframe | null = null
  if (v.keyframe !== null) {
    const k = v.keyframe
    if (
      !isObject(k) ||
      !int(k.tick, 0, 7 * 24 * 3600 * AVATAR_MOTION_TICK_HZ) ||
      !int(k.lastEventId, 0, Number.MAX_SAFE_INTEGER)
    )
      return null
    const animator = parseAnimatorState(k.animator)
    const inputs = parseInputs(k.inputs)
    if (
      !animator ||
      !inputs ||
      !Array.isArray(k.pending) ||
      k.pending.length > AVATAR_MOTION_MAX_EVENTS
    )
      return null
    const pending: StampedMotionEvent[] = []
    for (const raw of k.pending) {
      const event = parseStamped(raw)
      if (!event || event.id <= k.lastEventId) return null
      pending.push(event)
    }
    keyframe = { tick: k.tick, lastEventId: k.lastEventId, animator, inputs, pending }
  }
  return {
    version: 1,
    show: page.show,
    publisherSid: page.publisherSid,
    epoch: v.epoch,
    seq: v.seq,
    sentAt: v.sentAt,
    origin: v.origin,
    keyframe,
    events
  }
}

// --- The deterministic simulation -----------------------------------------------------------

const tickTime = (tick: number): number => tick / AVATAR_MOTION_TICK_HZ

/** The animator plus its inputs, stepped tick by tick, both legs per tick (`h` leads). */
export class MotionSim {
  #animator: BuddyAnimator
  #inputs: MotionInputs
  #tick: number
  #lastEventId: number
  #pending: StampedMotionEvent[] = []
  #draws: Partial<Record<MotionOrientation, AnimatorDraw | null>> = {}

  private constructor(
    animator: BuddyAnimator,
    inputs: MotionInputs,
    tick: number,
    lastEventId: number
  ) {
    this.#animator = animator
    this.#inputs = inputs
    this.#tick = tick
    this.#lastEventId = lastEventId
  }

  /** A fresh simulation at tick 0 (the producer's start). */
  static start(seed: bigint, settings: AnimatorSettings, inputs: MotionInputs): MotionSim {
    return new MotionSim(new BuddyAnimator(settings, seed), structuredCloneJson(inputs), 0, 0)
  }

  static fromKeyframe(keyframe: MotionKeyframe): MotionSim {
    const sim = new MotionSim(
      BuddyAnimator.fromState(keyframe.animator),
      structuredCloneJson(keyframe.inputs),
      keyframe.tick,
      keyframe.lastEventId
    )
    for (const event of keyframe.pending) sim.add(event)
    return sim
  }

  get tick(): number {
    return this.#tick
  }
  get time(): number {
    return tickTime(this.#tick)
  }
  get lastEventId(): number {
    return this.#lastEventId
  }
  get inputs(): Readonly<MotionInputs> {
    return this.#inputs
  }

  /** Queue an event; ids at or below what was applied are ignored (no duplicates). */
  add(event: StampedMotionEvent): boolean {
    if (event.id <= this.#lastEventId || this.#pending.some((p) => p.id === event.id)) return false
    this.#pending.push(event)
    this.#pending.sort((a, b) => a.id - b.id)
    return true
  }

  /** Step every tick up to `tick`: due events (in id order), then the `h` and `v` legs. */
  advanceTo(tick: number): void {
    while (this.#tick < tick) {
      const next = this.#tick + 1
      const now = tickTime(next)
      for (let due = this.#pending[0]; due && due.at <= now; due = this.#pending[0]) {
        this.#pending.shift()
        this.#apply(due.event, due.at)
        this.#lastEventId = Math.max(this.#lastEventId, due.id)
      }
      for (const orientation of ['h', 'v'] as const) {
        const [width, height] = AVATAR_MOTION_CANVAS[orientation]
        const card = this.#inputs.cards[orientation]
        this.#draws[orientation] = this.#animator.draw({
          leg: LEG[orientation],
          now,
          buddyBox: buddyBox(this.#inputs.rects[orientation], width, height),
          highlightRect: card
            ? [card.x * width, card.y * height, card.w * width, card.h * height]
            : null,
          avatarState: this.#inputs.avatarState,
          pack: this.#inputs.pack
        })
      }
      this.#tick = next
    }
  }

  #apply(event: MotionEvent, at: number): void {
    switch (event.kind) {
      case 'state':
        this.#inputs.avatarState = event.state
        return
      case 'layout':
        this.#inputs.rects = structuredCloneJson(event.rects)
        return
      case 'cards':
        this.#inputs.cards = structuredCloneJson(event.cards)
        return
      case 'pack':
        this.#inputs.pack = structuredCloneJson(event.pack)
        this.#inputs.atlasHash = event.atlasHash
        return
      default:
        this.#animator.handle(event, at)
    }
  }

  /** The draw of the last stepped tick on one output. */
  draw(orientation: MotionOrientation): AnimatorDraw | null {
    return this.#draws[orientation] ?? null
  }

  keyframe(): MotionKeyframe {
    return {
      tick: this.#tick,
      lastEventId: this.#lastEventId,
      animator: this.#animator.saveState(),
      inputs: structuredCloneJson(this.#inputs),
      pending: structuredCloneJson(this.#pending)
    }
  }
}

function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// --- The producer (desktop renderer) ----------------------------------------------------------

/** Seconds since the producer started, as the show clock. */
export class MotionProducer {
  readonly epoch: string
  readonly origin: number
  #sim: MotionSim
  #nextId = 1
  #seq = 0
  #lastAt = 0
  #outbox: StampedMotionEvent[] = []
  #lastKeyframeAt = -Infinity

  constructor(
    private readonly deps: {
      show: string
      publisherSid: string
      now(): number
      epoch: string
      seed: bigint
    },
    settings: AnimatorSettings,
    inputs: MotionInputs
  ) {
    this.epoch = deps.epoch
    this.origin = deps.now()
    this.#sim = MotionSim.start(deps.seed, settings, inputs)
  }

  get sim(): MotionSim {
    return this.#sim
  }

  #showNow(): number {
    return (this.deps.now() - this.origin) / 1000
  }

  /** Step the producer's own simulation to now (its keyframes come from it). */
  advance(): void {
    this.#sim.advanceTo(Math.floor(this.#showNow() * AVATAR_MOTION_TICK_HZ))
  }

  /** Stamp an event: never at or before the simulated time, never before the last one. */
  push(event: MotionEvent): StampedMotionEvent {
    this.advance()
    const at = Math.max(
      Math.ceil(this.#showNow() * 1000) / 1000,
      this.#sim.time + 0.001,
      this.#lastAt
    )
    this.#lastAt = at
    const stamped: StampedMotionEvent = { id: this.#nextId++, at, event }
    this.#sim.add(stamped)
    this.#outbox.push(stamped)
    if (this.#outbox.length > 4 * AVATAR_MOTION_MAX_EVENTS)
      this.#outbox.splice(0, this.#outbox.length - 4 * AVATAR_MOTION_MAX_EVENTS)
    return stamped
  }

  /**
   * The messages to send now: queued events in chunks, and a keyframe when
   * one is due or `forceKeyframe` (a new consumer, a reconnect).
   */
  flush(forceKeyframe = false): MotionMessage[] {
    this.advance()
    const now = this.deps.now()
    const messages: MotionMessage[] = []
    const keyframeDue = forceKeyframe || now - this.#lastKeyframeAt >= AVATAR_MOTION_KEYFRAME_MS
    while (this.#outbox.length || (keyframeDue && !messages.some((m) => m.keyframe))) {
      const events = this.#outbox.splice(0, AVATAR_MOTION_MAX_EVENTS)
      const keyframe = keyframeDue && !this.#outbox.length ? this.#sim.keyframe() : null
      messages.push({
        version: 1,
        show: this.deps.show,
        publisherSid: this.deps.publisherSid,
        epoch: this.epoch,
        seq: ++this.#seq,
        sentAt: Math.max(this.origin, Math.round(now)),
        origin: Math.round(this.origin),
        keyframe,
        events
      })
    }
    if (messages.some((m) => m.keyframe)) this.#lastKeyframeAt = now
    return messages
  }
}

// --- The consumer (program page, monitor, any later projection) ---------------------------------

export type MotionReceiverStatus = 'waiting' | 'animating' | 'stale'

/**
 * Owner SID + epoch scoped. Bounded memory: one baseline keyframe, at most two
 * future keyframes and the events after the baseline.
 */
export class MotionReceiver {
  #owner: string | null = null
  #epoch: string | null = null
  #lastSeq = 0
  #offsets: { at: number; offset: number }[] = []
  #origin = 0
  #baseline: MotionKeyframe | null = null
  #future: MotionKeyframe[] = []
  #events: StampedMotionEvent[] = []
  #sim: MotionSim | null = null
  #lastMessageAt = 0
  #budget: { second: number; count: number } = { second: 0, count: 0 }
  /** Ids applied by the live simulation, for tests and diagnostics. */
  rewinds = 0

  /** `show` may be a getter: a program page learns its room's name after it starts. */
  constructor(private readonly deps: { show: string | (() => string); now(): number }) {}

  /** The current host SID; another SID (or `null`) clears everything. */
  owner(sid: string | null): void {
    if (sid === this.#owner) return
    this.#owner = sid
    this.clear()
  }

  clear(): void {
    this.#epoch = null
    this.#lastSeq = 0
    this.#offsets = []
    this.#baseline = null
    this.#future = []
    this.#events = []
    this.#sim = null
  }

  status(): MotionReceiverStatus {
    if (!this.#sim) return 'waiting'
    return this.deps.now() - this.#lastMessageAt > AVATAR_MOTION_LEASE_MS ? 'stale' : 'animating'
  }

  /** One untrusted message; returns whether it was accepted. */
  receive(raw: unknown): boolean {
    if (!this.#owner) return false
    const now = this.deps.now()
    const second = Math.floor(now / 1000)
    if (this.#budget.second !== second) this.#budget = { second, count: 0 }
    if (++this.#budget.count > AVATAR_MOTION_RATE_PER_SECOND) return false
    const show = typeof this.deps.show === 'function' ? this.deps.show() : this.deps.show
    if (!show) return false
    const message = parseMotionMessage(raw, { show, publisherSid: this.#owner })
    if (!message) return false
    if (message.epoch !== this.#epoch) {
      // A new producer run: only a keyframe can start it.
      if (!message.keyframe) return false
      this.clear()
      this.#epoch = message.epoch
    } else if (message.seq <= this.#lastSeq) {
      return false
    }
    this.#lastSeq = message.seq
    this.#origin = message.origin
    this.#lastMessageAt = now
    this.#offsets.push({ at: now, offset: now - message.sentAt })
    this.#offsets = this.#offsets.filter((o) => now - o.at <= 30_000).slice(-32)
    for (const event of message.events) this.#addEvent(event)
    if (message.keyframe) {
      if (!this.#baseline) this.#adopt(message.keyframe)
      else if (message.keyframe.tick > this.#baseline.tick) {
        this.#future = [...this.#future, message.keyframe].slice(-2)
      }
    }
    return true
  }

  #addEvent(event: StampedMotionEvent): void {
    if (this.#baseline && event.id <= this.#baseline.lastEventId) return
    if (this.#events.some((e) => e.id === event.id)) return
    this.#events.push(event)
    this.#events.sort((a, b) => a.id - b.id)
    if (this.#events.length > 8 * AVATAR_MOTION_MAX_EVENTS) this.#events.shift()
    if (!this.#sim) return
    if (event.at <= this.#sim.time) {
      // Arrived after its moment: replay from the baseline so state converges.
      this.#rebuild(this.#sim.tick)
    } else {
      this.#sim.add(event)
    }
  }

  #adopt(keyframe: MotionKeyframe): void {
    this.#baseline = keyframe
    this.#events = this.#events.filter((e) => e.id > keyframe.lastEventId)
    for (const pending of keyframe.pending) {
      if (!this.#events.some((e) => e.id === pending.id)) this.#events.push(pending)
    }
    this.#events.sort((a, b) => a.id - b.id)
  }

  #rebuild(toTick: number): void {
    if (!this.#baseline) return
    this.rewinds += 1
    const sim = MotionSim.fromKeyframe({ ...this.#baseline, pending: [] })
    for (const event of this.#events) sim.add(event)
    sim.advanceTo(
      Math.max(
        this.#baseline.tick,
        Math.min(toTick, this.#baseline.tick + AVATAR_MOTION_MAX_CATCH_UP_TICKS)
      )
    )
    this.#sim = sim
  }

  /** The producer's show time this consumer draws now (with the playout delay). */
  targetTick(): number | null {
    if (!this.#offsets.length) return null
    const offset = Math.min(...this.#offsets.map((o) => o.offset))
    const show = (this.deps.now() - offset - this.#origin - AVATAR_MOTION_PLAYOUT_MS) / 1000
    return Math.max(0, Math.floor(show * AVATAR_MOTION_TICK_HZ))
  }

  /** Step to the target time (adopting keyframes that are now due); bounded work. */
  advance(): void {
    const target = this.targetTick()
    if (target === null || !this.#baseline) return
    const due = this.#future.filter((k) => k.tick <= target).pop()
    if (due) {
      this.#future = this.#future.filter((k) => k.tick > target)
      this.#adopt(due)
      this.#rebuild(target)
      return
    }
    if (!this.#sim) {
      if (target < this.#baseline.tick) return
      this.#rebuild(target)
      return
    }
    if (target - this.#sim.tick > AVATAR_MOTION_MAX_CATCH_UP_TICKS) {
      // Far behind (a throttled page): wait for the next keyframe rather than burn a frame.
      return
    }
    this.#sim.advanceTo(target)
  }

  /** What to draw on one output, or `null` before a keyframe or after the lease. */
  draw(orientation: MotionOrientation, atlasHash: string): AnimatorDraw | null {
    if (this.status() !== 'animating' || !this.#sim || this.#sim.inputs.atlasHash !== atlasHash)
      return null
    return this.#sim.draw(orientation)
  }

  get sim(): MotionSim | null {
    return this.#sim
  }
}

// --- Drawing (shared by program and monitor) ---------------------------------------------------

/**
 * Paint one draw: the cell's square around its pivot, the CSS-order affine,
 * then the translation, all scaled from the 1080p reference canvas.
 */
export function paintAvatarDraw(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  cell: readonly [number, number, number, number],
  draw: AnimatorDraw,
  scale: number
): void {
  const size = draw.size * scale
  const left = draw.center[0] * scale - size / 2
  const top = draw.center[1] * scale - size / 2
  const [a, b, c, d] = draw.affine
  ctx.save()
  ctx.setTransform(
    a,
    b,
    c,
    d,
    left + draw.pivot[0] * size + draw.translate[0] * scale,
    top + draw.pivot[1] * size + draw.translate[1] * scale
  )
  ctx.drawImage(
    image,
    cell[0],
    cell[1],
    cell[2],
    cell[3],
    -draw.pivot[0] * size,
    -draw.pivot[1] * size,
    size,
    size
  )
  ctx.restore()
}

/**
 * The neutral cell at rest in an atlas layer's box (`rect`: the square the
 * cell fills, normalized): a consumer's draw before a keyframe, after the
 * motion lease, or when the motion's atlas hash differs from the layer's.
 */
export function restingDraw(
  meta: AvatarAtlasMeta,
  box: MotionRect,
  orientation: MotionOrientation
): AnimatorDraw {
  const [width, height] = AVATAR_MOTION_CANVAS[orientation]
  const w = box.w * width
  const h = box.h * height
  return {
    cell: meta.neutral,
    center: [box.x * width + w / 2, box.y * height + h / 2],
    size: Math.min(w, h),
    pivot: [meta.pivot[0], meta.pivot[1]],
    affine: [1, 0, 0, 1],
    translate: [0, 0]
  }
}

/** An atlas layer's box: the compositor's square for the Buddy's layout rect, normalized. */
export function atlasLayerRect(layout: MotionRect, orientation: MotionOrientation): MotionRect {
  const [width, height] = AVATAR_MOTION_CANVAS[orientation]
  const [x, y, w, h] = buddyBox(layout, width, height)
  return { x: x / width, y: y / height, w: w / width, h: h / height }
}

export { ANIMATOR_DEFAULT_SETTINGS }
