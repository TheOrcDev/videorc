/**
 * The Buddy's animator, the TypeScript twin of
 * `crates/videorc-backend/src/buddy_animator.rs` (plan 168 S-C2), for the
 * cloud program (plan 249 S5). Same rules, same order, same seeded SplitMix64
 * draws: driven with the same events at the same times it picks the same
 * cells and the same motion as the compositor. `buddy-animator.test.ts`
 * replays the Rust module's pinned scripted session cell by cell, and
 * `protocol-fixtures/buddy-animator-events.json` pins the cloud driver.
 * Keep every rule and its evaluation order identical to the Rust module.
 *
 * Mirrored in the program client (`lib/cloud/program/buddy-animator.ts`):
 * the same source reformatted by that repo's Prettier, nothing else.
 *
 * Differences from the Rust module, all at the edges:
 * - The atlas is `AnimatorPack`: ids, kinds and gaze points only. Pixels,
 *   cell rects and the PNG live with the presentation layer.
 * - Events are `AnimatorEvent`: the public projection (`reaction` carries the
 *   chain the desktop already resolved from the trigger and the persona, so
 *   no persona table crosses the room).
 * - `saveState()` / `loadState()` serialize everything, the random source
 *   included, so a late consumer continues from a keyframe.
 *
 * The rules are documented on the Rust module; they are not repeated here.
 */

import { BuddyMotion, type BuddyMotionState, cssMatrix, isIdentityTransform } from './buddy-motion'

// --- The numbers (D11 to D15), as `buddy_animator.rs` ------------------------------

export const IDLE_GLANCE_EVERY_SECONDS: readonly [number, number] = [7.0, 14.0]
export const IDLE_GLANCE_FOR_SECONDS: readonly [number, number] = [0.8, 1.6]
export const IDLE_GLANCE_REACH = 0.5
export const CARD_LOOK_SECONDS = 1.5
export const CARD_GLANCE_SECONDS = 1.2
export const CARD_TTL_SECONDS = 10.0
export const GAZE_RADIUS_PER_SIZE = 1.3
export const GAZE_MIN_RADIUS_PX = 120.0
export const THINK_GAZE: readonly [number, number] = [-0.5, -1.0]
export const VIEWER_GAZE: readonly [number, number] = [0.0, 0.0]
export const TALK_STEP_SECONDS: readonly [number, number] = [0.11, 0.15]
export const TALK_SECONDS_PER_CHAR = 0.065
export const BLINK_FIRST_SECONDS = 3.5
export const BLINK_EVERY_SECONDS: readonly [number, number] = [3.5, 6.0]
export const BLINK_SECONDS = 0.16
export const WAKE_SECONDS = 0.6
export const REACTION_HOLD_SECONDS = 1.1
export const REACTION_QUEUE_MAX = 2
export const REACTION_MAX_AGE_SECONDS = 6.0
export const HOP_REACTION_ID = 'hop'
const BLINK_ID = 'blink'
const SLEEP_ID = 'sleep'
const SURPRISED_ID = 'surprised'
const LAUGH_ID = 'laugh'
const THINK_ID = 'think'
const TALK_CATCH_UP_STEPS = 32

/** Motion defaults (D10, D13, D15; owner defaults 2 and 3), as `buddy_pet.rs`. */
export const ANIMATOR_DEFAULT_SETTINGS: Readonly<AnimatorSettings> = Object.freeze({
  intensity: 0.45,
  sleepAfterSeconds: 180,
  breathing: true
})

// --- Inputs ----------------------------------------------------------------------------

export type AnimatorCellKind = 'gaze' | 'reaction'
export interface AnimatorCell {
  id: string
  kind: AnimatorCellKind
  /** Gaze cells: page-pet's `[x, y]` in [-1, 1]². */
  gaze: readonly [number, number] | null
}
/** What the animator knows about the worn pack (Rust `BuddySpriteAtlas` minus pixels). */
export interface AnimatorPack {
  neutral: string
  pivot: readonly [number, number]
  /** Normalized top of the neutral silhouette in its cell (D16). */
  headTop: number
  /** Talk frames the pack names (D12), in order. */
  talk: readonly string[]
  cells: readonly AnimatorCell[]
}

export type AnimatorMood = 'talk' | 'laugh' | 'think'
export type AnimatorAvatarState = 'idle' | AnimatorMood

/** The persona's motion (Rust `BuddyMotionSettings`). */
export interface AnimatorSettings {
  intensity: number
  sleepAfterSeconds: number
  breathing: boolean
}

/** Public projection of Rust `BuddyAnimatorEvent`. No text, no persona table. */
export type AnimatorEvent =
  | { kind: 'utterance'; mood: AnimatorMood; chars: number; bubbleSeconds: number }
  | { kind: 'utterance-end' }
  | { kind: 'think' }
  | { kind: 'think-settle' }
  /** A trigger (resolved chain; `activity` false for a failed destination) or a manual react. */
  | { kind: 'reaction'; chain: readonly string[]; activity: boolean }
  | { kind: 'highlight'; ttlSeconds: number }
  | { kind: 'highlight-idle' }
  | { kind: 'chat' }
  | { kind: 'settings'; settings: AnimatorSettings }

/** Leg 0 draws first (the lead: its gaze changes turn the body). */
export type AnimatorLeg = 0 | 1 | 2

export interface AnimatorLegContext {
  leg: AnimatorLeg
  now: number
  /** The untransformed square the cell fills, canvas pixels `[x, y, w, h]`. */
  buddyBox: readonly [number, number, number, number]
  /** The highlight card on this leg, canvas pixels, while one shows here. */
  highlightRect: readonly [number, number, number, number] | null
  avatarState: AnimatorAvatarState
  pack: AnimatorPack
}

/** Rust `BuddySpriteDraw`, with the cell named instead of its atlas pixels. */
export interface AnimatorDraw {
  cell: string
  center: [number, number]
  size: number
  pivot: [number, number]
  /** CSS `[a, b, c, d]` about the pivot (f32, as the compositor's). */
  affine: [number, number, number, number]
  translate: [number, number]
}

// --- The random source -------------------------------------------------------------------

// BigInt() calls, not literals: the web program targets ES2017 syntax.
const MASK = (BigInt(1) << BigInt(64)) - BigInt(1)
const GOLDEN = BigInt('0x9e3779b97f4a7c15')
const MIX_1 = BigInt('0xbf58476d1ce4e5b9')
const MIX_2 = BigInt('0x94d049bb133111eb')
const [S11, S27, S30, S31] = [BigInt(11), BigInt(27), BigInt(30), BigInt(31)]

/** SplitMix64, bit for bit Rust's: the state is a u64 kept as a BigInt. */
export class SplitMix64 {
  constructor(public state: bigint) {
    this.state = BigInt.asUintN(64, state)
  }
  nextU64(): bigint {
    this.state = (this.state + GOLDEN) & MASK
    let z = this.state
    z = ((z ^ (z >> S30)) * MIX_1) & MASK
    z = ((z ^ (z >> S27)) * MIX_2) & MASK
    return z ^ (z >> S31)
  }
  /** Uniform in `[0, 1)`. */
  unit(): number {
    return Number(this.nextU64() >> S11) / 2 ** 53
  }
  range([low, high]: readonly [number, number]): number {
    return low + (high - low) * this.unit()
  }
  index(count: number): number {
    return Math.min(Math.trunc(this.unit() * count), Math.max(0, count - 1))
  }
}

// --- State ---------------------------------------------------------------------------------

type Speech = { kind: 'quiet' } | { kind: 'think' } | { kind: 'bubble'; mood: AnimatorMood }
interface Talk {
  until: number
  steps: number
  nextStepAt: number
}
interface LegMemory {
  gaze: [number, number] | null
  cardSince: number | null
  blink: [number, boolean] | null
}

/** Everything the animator carries, as plain JSON (`rng` is the u64 in hex). */
export interface AnimatorState {
  settings: AnimatorSettings
  motion: BuddyMotionState
  rng: string
  frame: number | null
  lead: AnimatorLeg | null
  speech: Speech
  talk: Talk | null
  highlight: { since: number; ttl: number } | null
  glance: { point: [number, number]; until: number } | null
  nextGlanceAt: number | null
  blink: { serial: number; until: number } | null
  blinkSerial: number
  nextBlinkAt: number | null
  lastActivity: number | null
  asleep: boolean
  wake: { until: number; moved: boolean } | null
  playing: { cell: string | null; until: number } | null
  queue: { chain: string[]; at: number }[]
  legs: [LegMemory, LegMemory, LegMemory]
}

const sameSpeech = (a: Speech, b: Speech): boolean =>
  a.kind === b.kind && (a.kind !== 'bubble' || a.mood === (b as { mood: AnimatorMood }).mood)
const samePoint = (a: readonly number[] | null, b: readonly number[] | null): boolean =>
  a !== null && b !== null && a[0] === b[0] && a[1] === b[1]
const freshLeg = (): LegMemory => ({ gaze: null, cardSince: null, blink: null })
const f32 = Math.fround

// --- Pack helpers (Rust `BuddySpriteAtlas` lookups) ---------------------------------------

export function packCell(pack: AnimatorPack, id: string): AnimatorCell | null {
  return pack.cells.find((cell) => cell.id === id) ?? null
}
function reactionCell(pack: AnimatorPack, id: string): AnimatorCell | null {
  return pack.cells.find((cell) => cell.kind === 'reaction' && cell.id === id) ?? null
}
function neutralCell(pack: AnimatorPack): AnimatorCell | null {
  return packCell(pack, pack.neutral)
}
export function cellForState(pack: AnimatorPack, state: AnimatorAvatarState): AnimatorCell | null {
  if (state !== 'idle') {
    const cell = reactionCell(pack, state)
    if (cell) return cell
  }
  return neutralCell(pack)
}
function talkFrameIds(pack: AnimatorPack): string[] {
  return pack.talk.filter((id) => packCell(pack, id) !== null)
}
/** page-pet's `nearestGaze`: the gaze cell closest to `(x, y)`; ties keep the first. */
export function nearestGaze(
  pack: AnimatorPack,
  [x, y]: readonly [number, number]
): AnimatorCell | null {
  let best: AnimatorCell | null = null
  let bestDistance = Infinity
  for (const cell of pack.cells) {
    if (cell.kind !== 'gaze' || !cell.gaze) continue
    const distance = (cell.gaze[0] - x) ** 2 + (cell.gaze[1] - y) ** 2
    if (distance < bestDistance) {
      best = cell
      bestDistance = distance
    }
  }
  return best
}
/** page-pet's tracking vector from the head anchor to the card's centre. */
export function cardGaze(
  buddyBox: readonly [number, number, number, number],
  headTop: number,
  card: readonly [number, number, number, number]
): [number, number] {
  const [boxX, boxY, boxWidth, boxHeight] = [
    f32(buddyBox[0]),
    f32(buddyBox[1]),
    f32(buddyBox[2]),
    f32(buddyBox[3])
  ]
  const [cardX, cardY, cardWidth, cardHeight] = [
    f32(card[0]),
    f32(card[1]),
    f32(card[2]),
    f32(card[3])
  ]
  const size = Math.min(boxWidth, boxHeight)
  const head: [number, number] = [
    boxX + boxWidth / 2,
    boxY + Math.min(1, Math.max(0, headTop)) * boxHeight
  ]
  const centre: [number, number] = [cardX + cardWidth / 2, cardY + cardHeight / 2]
  const radius = Math.max(GAZE_RADIUS_PER_SIZE * size, GAZE_MIN_RADIUS_PX)
  const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v))
  return [clamp1((centre[0] - head[0]) / radius), clamp1((centre[1] - head[1]) / radius)]
}

/** The cell at rest filling `buddyBox` (Rust `BuddySpriteDraw::at_rest`). */
function atRest(
  cell: string,
  box: readonly [number, number, number, number],
  pivot: readonly [number, number]
): AnimatorDraw {
  const [x, y, w, h] = [f32(box[0]), f32(box[1]), f32(box[2]), f32(box[3])]
  return {
    cell,
    center: [f32(x + w / 2), f32(y + h / 2)],
    size: f32(Math.min(w, h)),
    pivot: [f32(pivot[0]), f32(pivot[1])],
    affine: [1, 0, 0, 1],
    translate: [0, 0]
  }
}

// --- The state machine ------------------------------------------------------------------

export class BuddyAnimator {
  #settings: AnimatorSettings
  #motion: BuddyMotion
  #rng: SplitMix64
  #frame: number | null = null
  #lead: AnimatorLeg | null = null
  #speech: Speech = { kind: 'quiet' }
  #talk: Talk | null = null
  #highlight: { since: number; ttl: number } | null = null
  #glance: { point: [number, number]; until: number } | null = null
  #nextGlanceAt: number | null = null
  #blink: { serial: number; until: number } | null = null
  #blinkSerial = 0
  #nextBlinkAt: number | null = null
  #lastActivity: number | null = null
  #asleep = false
  #wake: { until: number; moved: boolean } | null = null
  #playing: { cell: string | null; until: number } | null = null
  #queue: { chain: string[]; at: number }[] = []
  #legs: [LegMemory, LegMemory, LegMemory] = [freshLeg(), freshLeg(), freshLeg()]

  constructor(settings: AnimatorSettings, seed: bigint) {
    this.#settings = { ...settings }
    this.#motion = new BuddyMotion({ intensity: settings.intensity, breathing: settings.breathing })
    this.#rng = new SplitMix64(seed)
  }

  get asleep(): boolean {
    return this.#asleep
  }

  setSettings(settings: AnimatorSettings): void {
    if (settings.sleepAfterSeconds === 0) this.#asleep = false
    this.#motion.setConfig({ intensity: settings.intensity, breathing: settings.breathing })
    this.#settings = { ...settings }
  }

  /** Apply one event that happened at `at` (never later than the next frame). */
  handle(event: AnimatorEvent, at: number): void {
    switch (event.kind) {
      case 'utterance': {
        this.#noteActivity(at)
        this.#speech = { kind: 'bubble', mood: event.mood }
        this.#glance = null
        const bubbleSeconds = Number.isFinite(event.bubbleSeconds)
          ? Math.max(0, event.bubbleSeconds)
          : 0
        const talkSeconds = Math.min(event.chars * TALK_SECONDS_PER_CHAR, bubbleSeconds)
        this.#talk = talkSeconds > 0 ? { until: at + talkSeconds, steps: 0, nextStepAt: at } : null
        if (event.mood === 'laugh') this.#enqueue([LAUGH_ID], at)
        return
      }
      case 'utterance-end':
        if (this.#speech.kind === 'bubble') this.#speech = { kind: 'quiet' }
        this.#talk = null
        return
      case 'think':
        this.#noteActivity(at)
        if (this.#speech.kind === 'quiet') {
          this.#speech = { kind: 'think' }
          this.#glance = null
        }
        return
      case 'think-settle':
        if (this.#speech.kind === 'think') this.#speech = { kind: 'quiet' }
        return
      case 'reaction':
        if (event.activity) this.#noteActivity(at)
        this.#enqueue([...event.chain], at)
        return
      case 'highlight': {
        this.#noteActivity(at)
        const ttl =
          Number.isFinite(event.ttlSeconds) && event.ttlSeconds > 0
            ? event.ttlSeconds
            : CARD_TTL_SECONDS
        this.#highlight = { since: at, ttl }
        this.#glance = null
        return
      }
      case 'highlight-idle':
        this.#highlight = null
        return
      case 'chat':
        this.#noteActivity(at)
        return
      case 'settings':
        this.setSettings(event.settings)
        return
    }
  }

  #noteActivity(at: number): void {
    this.#lastActivity = this.#lastActivity === null ? at : Math.max(this.#lastActivity, at)
    if (this.#asleep) {
      this.#asleep = false
      this.#wake = { until: at + WAKE_SECONDS, moved: false }
    }
  }

  #enqueue(chain: string[], at: number): void {
    if (chain.length === 0) return
    this.#queue = this.#queue.filter((queued) => at - queued.at <= REACTION_MAX_AGE_SECONDS)
    const room = REACTION_QUEUE_MAX + (this.#playing === null ? 1 : 0)
    if (this.#queue.length >= room) return
    this.#queue.push({ chain, at })
  }

  /** One leg's draw. The first call at a new time steps the state; later calls read it. */
  draw(context: AnimatorLegContext): AnimatorDraw | null {
    const { now, pack } = context
    if (!Number.isFinite(now)) {
      const cell = cellForState(pack, context.avatarState)
      return cell ? atRest(cell.id, context.buddyBox, pack.pivot) : null
    }
    if (this.#frame !== now) {
      this.#step(context)
      this.#frame = now
      this.#lead = context.leg
    }
    const leg = context.leg
    if (context.highlightRect) {
      if (this.#legs[leg].cardSince === null) this.#legs[leg].cardSince = now
    } else {
      this.#legs[leg].cardSince = null
    }
    const target = this.#gazeTarget(context)
    const gazeCell = nearestGaze(pack, target) ?? neutralCell(pack)
    const overrideCell = this.#overrideCell(now, pack)
    const blinkCell = overrideCell === null ? this.#legBlink(leg, now, pack, gazeCell) : null
    if (blinkCell === null && gazeCell?.gaze) {
      const point: [number, number] = [gazeCell.gaze[0], gazeCell.gaze[1]]
      const previous = this.#legs[leg].gaze
      this.#legs[leg].gaze = point
      if (previous && !samePoint(previous, point) && this.#lead === leg && overrideCell === null) {
        this.#motion.gazeTurn(point[0] - previous[0])
      }
    }
    const cell = overrideCell ?? blinkCell ?? gazeCell ?? cellForState(pack, context.avatarState)
    if (!cell) return null
    this.#motion.setConfig({ size: Math.min(f32(context.buddyBox[2]), f32(context.buddyBox[3])) })
    const transform = this.#motion.transform()
    const draw = atRest(cell.id, context.buddyBox, pack.pivot)
    if (!isIdentityTransform(transform)) {
      const css = cssMatrix(transform)
      draw.affine = [f32(css[0]), f32(css[1]), f32(css[2]), f32(css[3])]
      draw.translate = [f32(css[4]), f32(css[5])]
    }
    return draw
  }

  #step(context: AnimatorLegContext): void {
    const { now, pack } = context
    if (this.#lastActivity === null) this.#lastActivity = now
    if (this.#nextBlinkAt === null) this.#nextBlinkAt = now + BLINK_FIRST_SECONDS
    if (this.#nextGlanceAt === null)
      this.#nextGlanceAt = now + this.#rng.range(IDLE_GLANCE_EVERY_SECONDS)
    this.#reconcile(context.avatarState)

    if (this.#highlight && now >= this.#highlight.since + this.#highlight.ttl)
      this.#highlight = null
    if (this.#glance && now >= this.#glance.until) this.#glance = null
    if (this.#blink && now >= this.#blink.until) this.#blink = null
    if (this.#wake && now >= this.#wake.until) this.#wake = null
    if (this.#playing && now >= this.#playing.until) this.#playing = null

    if (this.#asleep && packCell(pack, SLEEP_ID) === null) this.#asleep = false
    const sleepAfter = this.#settings.sleepAfterSeconds
    if (
      !this.#asleep &&
      sleepAfter > 0 &&
      packCell(pack, SLEEP_ID) !== null &&
      this.#speech.kind === 'quiet' &&
      !this.#cardUp() &&
      this.#playing === null &&
      this.#queue.length === 0 &&
      this.#wake === null &&
      this.#lastActivity !== null &&
      now - this.#lastActivity >= sleepAfter
    ) {
      this.#asleep = true
      this.#glance = null
      this.#blink = null
    }

    if (this.#wake && !this.#wake.moved) {
      this.#wake.moved = true
      this.#motion.react(SURPRISED_ID, now)
    }

    if (this.#playing === null && this.#wake === null && !this.#asleep) {
      let queued = this.#queue.shift()
      while (queued) {
        if (now - queued.at > REACTION_MAX_AGE_SECONDS) {
          queued = this.#queue.shift()
          continue
        }
        const cell = queued.chain.find((id) => reactionCell(pack, id) !== null) ?? null
        this.#motion.react(cell ?? HOP_REACTION_ID, now)
        const envelopeEnds = this.#motion.reactionEndsAt() ?? now
        this.#playing = { cell, until: Math.max(envelopeEnds, now + REACTION_HOLD_SECONDS) }
        break
      }
    }

    const bobs = talkFrameIds(pack).length === 0
    const talk = this.#talk
    if (talk) {
      let caughtUp = 0
      while (now >= talk.nextStepAt && talk.nextStepAt < talk.until) {
        talk.steps += 1
        if (bobs) this.#motion.talkBob()
        talk.nextStepAt += this.#rng.range(TALK_STEP_SECONDS)
        caughtUp += 1
        if (caughtUp >= TALK_CATCH_UP_STEPS) {
          talk.nextStepAt = now + this.#rng.range(TALK_STEP_SECONDS)
          break
        }
      }
      if (now >= talk.until) this.#talk = null
    }

    if (this.#nextBlinkAt !== null && now >= this.#nextBlinkAt) {
      if (
        !this.#asleep &&
        this.#wake === null &&
        this.#playing === null &&
        this.#talk === null &&
        reactionCell(pack, BLINK_ID) !== null
      ) {
        this.#blinkSerial += 1
        this.#blink = { serial: this.#blinkSerial, until: now + BLINK_SECONDS }
      }
      this.#nextBlinkAt = now + this.#rng.range(BLINK_EVERY_SECONDS)
    }

    if (this.#nextGlanceAt !== null && now >= this.#nextGlanceAt) {
      if (
        this.#speech.kind === 'quiet' &&
        !this.#asleep &&
        this.#wake === null &&
        this.#highlight === null &&
        this.#glance === null
      ) {
        const candidates = pack.cells
          .filter((cell) => cell.kind === 'gaze' && cell.gaze !== null)
          .map((cell) => cell.gaze as readonly [number, number])
          .filter(
            ([x, y]) =>
              Math.abs(x) <= IDLE_GLANCE_REACH + 1e-9 &&
              Math.abs(y) <= IDLE_GLANCE_REACH + 1e-9 &&
              !(x === VIEWER_GAZE[0] && y === VIEWER_GAZE[1])
          )
        const point =
          candidates.length > 0 ? candidates[this.#rng.index(candidates.length)] : undefined
        if (point) {
          this.#glance = {
            point: [point[0], point[1]],
            until: now + this.#rng.range(IDLE_GLANCE_FOR_SECONDS)
          }
        }
      }
      this.#nextGlanceAt = now + this.#rng.range(IDLE_GLANCE_EVERY_SECONDS)
    }

    this.#motion.setConfig({
      intensity: this.#settings.intensity,
      breathing: this.#settings.breathing,
      pivot: pack.pivot
    })
    const resting = this.#overrideCell(now, pack) === null && this.#talk === null
    this.#motion.setIdle(resting)
    this.#motion.advance(now)
  }

  #reconcile(avatar: AnimatorAvatarState): void {
    switch (avatar) {
      case 'idle':
        if (this.#speech.kind !== 'quiet') {
          this.#speech = { kind: 'quiet' }
          this.#talk = null
        }
        return
      case 'think':
        if (this.#speech.kind === 'quiet') this.#speech = { kind: 'think' }
        else if (this.#speech.kind === 'bubble' && this.#speech.mood !== 'think') {
          this.#speech = { kind: 'think' }
          this.#talk = null
        }
        return
      case 'talk':
      case 'laugh': {
        const mood: Speech = { kind: 'bubble', mood: avatar }
        if (!sameSpeech(this.#speech, mood)) this.#speech = mood
        return
      }
    }
  }

  #legBlink(
    leg: AnimatorLeg,
    now: number,
    pack: AnimatorPack,
    gazeCell: AnimatorCell | null
  ): AnimatorCell | null {
    const blink = this.#blink && now < this.#blink.until ? this.#blink : null
    if (!blink) return null
    const memory = this.#legs[leg]
    let shows: boolean
    if (memory.blink && memory.blink[0] === blink.serial) {
      shows = memory.blink[1]
    } else {
      shows =
        gazeCell !== null &&
        gazeCell.id === pack.neutral &&
        gazeCell.gaze !== null &&
        samePoint(memory.gaze, gazeCell.gaze)
      memory.blink = [blink.serial, shows]
    }
    return shows ? reactionCell(pack, BLINK_ID) : null
  }

  #cardUp(): boolean {
    return this.#highlight !== null || this.#legs.some((leg) => leg.cardSince !== null)
  }

  #overrideCell(now: number, pack: AnimatorPack): AnimatorCell | null {
    if (this.#wake && now < this.#wake.until) {
      const cell = reactionCell(pack, SURPRISED_ID)
      if (cell) return cell
    }
    if (this.#playing && now < this.#playing.until && this.#playing.cell !== null) {
      const cell = reactionCell(pack, this.#playing.cell)
      if (cell) return cell
    }
    if (this.#asleep) return packCell(pack, SLEEP_ID)
    const talkFrames = talkFrameIds(pack)
    if (this.#talk && this.#talk.steps > 0 && talkFrames.length > 0) {
      const id = talkFrames[(this.#talk.steps - 1) % (talkFrames.length + 1)]
      return id === undefined ? neutralCell(pack) : packCell(pack, id)
    }
    if (this.#speech.kind === 'bubble' && talkFrames.length === 0)
      return reactionCell(pack, this.#speech.mood)
    if (this.#speech.kind === 'think') return reactionCell(pack, THINK_ID)
    return null
  }

  #gazeTarget(context: AnimatorLegContext): readonly [number, number] {
    const { now, leg } = context
    let card: {
      rect: readonly [number, number, number, number]
      since: number
      ttl: number
    } | null = null
    const seen = this.#legs[leg].cardSince
    if (context.highlightRect && seen !== null) {
      card = this.#highlight
        ? {
            rect: context.highlightRect,
            since: Math.max(seen, this.#highlight.since),
            ttl: this.#highlight.ttl
          }
        : { rect: context.highlightRect, since: seen, ttl: CARD_TTL_SECONDS }
    }
    if (card && now < card.since + CARD_LOOK_SECONDS) {
      return cardGaze(context.buddyBox, context.pack.headTop, card.rect)
    }
    if (this.#speech.kind === 'think') return THINK_GAZE
    if (this.#speech.kind === 'bubble') return VIEWER_GAZE
    if (card) {
      const glanceAt = card.since + card.ttl / 2
      if (now >= glanceAt && now < glanceAt + CARD_GLANCE_SECONDS) {
        return cardGaze(context.buddyBox, context.pack.headTop, card.rect)
      }
    }
    if (this.#glance) return this.#glance.point
    return VIEWER_GAZE
  }

  /** A deep, JSON-safe copy of everything (plan 249 S5 keyframes). */
  saveState(): AnimatorState {
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    return {
      settings: { ...this.#settings },
      motion: this.#motion.saveState(),
      rng: this.#rng.state.toString(16),
      frame: this.#frame,
      lead: this.#lead,
      speech: { ...this.#speech },
      talk: this.#talk ? { ...this.#talk } : null,
      highlight: this.#highlight ? { ...this.#highlight } : null,
      glance: this.#glance ? clone(this.#glance) : null,
      nextGlanceAt: this.#nextGlanceAt,
      blink: this.#blink ? { ...this.#blink } : null,
      blinkSerial: this.#blinkSerial,
      nextBlinkAt: this.#nextBlinkAt,
      lastActivity: this.#lastActivity,
      asleep: this.#asleep,
      wake: this.#wake ? { ...this.#wake } : null,
      playing: this.#playing ? { ...this.#playing } : null,
      queue: clone(this.#queue),
      legs: clone(this.#legs)
    }
  }

  /** An animator continuing from `saveState()`'s copy (validated by the caller). */
  static fromState(saved: AnimatorState): BuddyAnimator {
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const animator = new BuddyAnimator(saved.settings, BigInt(`0x${saved.rng}`))
    animator.#motion.loadState(saved.motion)
    animator.#frame = saved.frame
    animator.#lead = saved.lead
    animator.#speech = { ...saved.speech }
    animator.#talk = saved.talk ? { ...saved.talk } : null
    animator.#highlight = saved.highlight ? { ...saved.highlight } : null
    animator.#glance = saved.glance ? clone(saved.glance) : null
    animator.#nextGlanceAt = saved.nextGlanceAt
    animator.#blink = saved.blink ? { ...saved.blink } : null
    animator.#blinkSerial = saved.blinkSerial
    animator.#nextBlinkAt = saved.nextBlinkAt
    animator.#lastActivity = saved.lastActivity
    animator.#asleep = saved.asleep
    animator.#wake = saved.wake ? { ...saved.wake } : null
    animator.#playing = saved.playing ? { ...saved.playing } : null
    animator.#queue = clone(saved.queue)
    animator.#legs = clone(saved.legs)
    return animator
  }
}
