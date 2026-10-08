/**
 * The Golem's body motion (plan 168, S-C1): the TypeScript twin of
 * `crates/videorc-backend/src/golem_motion.rs`, both ports of page-pet's
 * `runtime/motion.js` (MIT, Cristian 2026) without GSAP and without the DOM
 * (D6). The app preview (Phase D) drives this one; the compositor drives the
 * Rust one. `protocol-fixtures/golem-motion.json` pins both to the same
 * samples within 1e-4; keep every formula and its evaluation order identical.
 *
 * Five channels, `x, y, angle, skew, squash`, in page-pet's 180 px tuning
 * space, moved by a damped spring (impulses: the gaze-turn nudge, the talk
 * bob) and by the reaction envelope (page-pet's tween segments with GSAP's
 * `power2.out`, `sine.inOut` and `elastic.out` formulas, from the pose
 * table). D15's breathing is a squash sine added while idle, faded in and
 * out over 0.35 s. The output is a `MotionTransform` about a normalized
 * pivot: the clamped channels, translation scaled by `size / 180`, every
 * impulse and pose multiplied by the persona's Motion intensity (D10).
 */

/** page-pet's tuning constants (`motionOptions`); `strength` is `intensity` here. */
export interface MotionTuning {
  /** 0..1: how springy the return is (`motion-bounce`). */
  bounce: number
  /** 0..1: lowers the spring stiffness (`motion-weight`). */
  weight: number
  /** 0..1: spring damping (`motion-damping`). */
  damping: number
  /** 0..1: multiplies the reaction poses (`reaction-motion`). */
  reaction: number
  /** 0.5..1.5: reaction playback speed (`reaction-speed`). */
  speed: number
}

/** page-pet's defaults, which the plan's motion numbers were tuned with. */
export const PAGE_PET_TUNING: Readonly<MotionTuning> = Object.freeze({
  bounce: 0.4,
  weight: 0.45,
  damping: 0.55,
  reaction: 0.7,
  speed: 1
})

export interface MotionConfig {
  /** The persona's Motion setting, 0..1 (D10). 0 removes every transform. */
  intensity: number
  /** The drawn size in pixels; translations scale by `size / 180`. */
  size: number
  /** The persona's Breathing setting (D15). */
  breathing: boolean
  /** Normalized transform origin inside the cell; page-pet's `50% 90%`. */
  pivot: readonly [number, number]
  tuning: MotionTuning
}

/** page-pet's default Motion (`motion` attribute). */
export const DEFAULT_MOTION_INTENSITY = 0.45
/** page-pet's display size the limits were tuned at. */
export const TUNING_SIZE_PX = 180
/** page-pet's transform origin. */
export const DEFAULT_PIVOT: readonly [number, number] = Object.freeze([0.5, 0.9]) as readonly [
  number,
  number
]

export function defaultMotionConfig(): MotionConfig {
  return {
    intensity: DEFAULT_MOTION_INTENSITY,
    size: TUNING_SIZE_PX,
    breathing: true,
    pivot: DEFAULT_PIVOT,
    tuning: { ...PAGE_PET_TUNING }
  }
}

/** page-pet's `render()` clamps, in 180 px tuning units. */
export const MOTION_LIMITS = Object.freeze({
  xPx: 20,
  yPx: 26,
  rotationDeg: 10,
  skewDeg: 7,
  squash: 0.18
})

/** D15: squash amplitude per unit intensity and the breath rate. */
export const BREATH_AMPLITUDE = 0.012
export const BREATH_HZ = 0.22
/** Breathing fades with this time constant so a reaction never steps the scale. */
export const BREATH_FADE_SECONDS = 0.35
/** D11: a gaze change nudges the angle spring by `deltaX * 9` (page-pet's `track()`). */
export const GAZE_TURN_ANGLE_PER_UNIT = 9
/**
 * D12: a pack without talk frames bobs on the neutral cell; each talk step
 * adds this upward y velocity (180 px units per second) times the intensity.
 */
export const TALK_BOB_VELOCITY = -64

const NUDGE_LIMIT_Y = 70
const NUDGE_LIMIT_ANGLE = 45
const SETTLE_POSITION = 0.025
const SETTLE_VELOCITY = 0.1
const SETTLE_SQUASH_POSITION = 0.0003
const SETTLE_SQUASH_VELOCITY = 0.003
const MAX_STEP_SECONDS = 0.05
const SUBSTEP_HZ = 120
const TAU = Math.PI * 2

const X = 0
const Y = 1
const ANGLE = 2
const SKEW = 3
const SQUASH = 4
const CHANNEL_COUNT = 5

type Channels = [number, number, number, number, number]

const zero = (): Channels => [0, 0, 0, 0, 0]

export type ReactionPose = readonly [y: number, angle: number, squash: number]

/** page-pet's pose table, `[y, angle, squash]` per reaction id, 180 px units. */
export const REACTION_POSES: Readonly<Record<string, ReactionPose>> = Object.freeze({
  surprised: [-17, -3, -0.1],
  laugh: [-9, 3, 0.065],
  kiss: [-4, 5, -0.025],
  wink: [-4, -5, 0.035],
  excited: [-20, 4, -0.11],
  celebrate: [-20, 4, -0.11],
  worried: [3, -3, 0.025],
  confused: [-2, -6, 0.025],
  annoyed: [2, 4, 0.045],
  proud: [-5, 2, -0.04],
  calm: [2, 0, 0.02],
  sleep: [2, -2, 0.025],
  wave: [-7, 6, -0.025],
  dance: [-12, 7, -0.06],
  shy: [3, -4, 0.04]
})

/** The pose of any id not in the table (D14's motion-only hop too). */
export const DEFAULT_REACTION_POSE: ReactionPose = Object.freeze([-8, 3, -0.05]) as ReactionPose

/** A blink is a frame change only; page-pet never animates it. */
export const BLINK_REACTION_ID = 'blink'

export function reactionPose(id: string): ReactionPose {
  return Object.prototype.hasOwnProperty.call(REACTION_POSES, id)
    ? REACTION_POSES[id]
    : DEFAULT_REACTION_POSE
}

/** GSAP `sine.in`: `1 - cos(p * pi / 2)`, exactly 1 at `p == 1`. */
function sineIn(p: number): number {
  return p === 1 ? 1 : -Math.cos((p * Math.PI) / 2) + 1
}

/** GSAP 3 easing formulas, reimplemented from their definitions. */
export const ease = Object.freeze({
  /** GSAP `power2.out` (Cubic.easeOut): `1 - (1 - p)^3`. */
  power2Out(p: number): number {
    return 1 - Math.pow(1 - p, 3)
  },
  /** GSAP `power3.out` (Quart.easeOut): `1 - (1 - p)^4`. */
  power3Out(p: number): number {
    return 1 - Math.pow(1 - p, 4)
  },
  /** GSAP `sine.inOut`, built from `sine.in` as GSAP builds every inOut. */
  sineInOut(p: number): number {
    return p < 0.5 ? sineIn(p * 2) / 2 : 1 - sineIn((1 - p) * 2) / 2
  },
  /**
   * GSAP `elastic.out(amplitude, period)`: with `p1 = max(amplitude, 1)`,
   * `p2 = period / min(amplitude, 1)` (0.3 when the period is 0),
   * `p3 = p2 / (2 pi) * asin(1 / p1)`, the curve is
   * `p1 * 2^(-10 p) * sin((p - p3) * 2 pi / p2) + 1`, exactly 1 at `p == 1`.
   */
  elasticOut(p: number, amplitude: number, period: number): number {
    if (p === 1) return 1
    const p1 = amplitude >= 1 ? amplitude : 1
    const basePeriod = period !== 0 ? period : 0.3
    const p2 = basePeriod / (amplitude < 1 ? amplitude : 1)
    const p3 = (p2 / TAU) * Math.asin(1 / p1)
    return p1 * Math.pow(2, -10 * p) * Math.sin((p - p3) * (TAU / p2)) + 1
  }
})

type Ease =
  | { kind: 'cubic' }
  | { kind: 'quartic' }
  | { kind: 'sine' }
  | { kind: 'elastic'; period: number }

function applyEase(e: Ease, p: number): number {
  switch (e.kind) {
    case 'cubic':
      return ease.power2Out(p)
    case 'quartic':
      return ease.power3Out(p)
    case 'sine':
      return ease.sineInOut(p)
    case 'elastic':
      return ease.elasticOut(p, 1, e.period)
  }
}

/** One GSAP tween; `yoyo` is `repeat: 1, yoyo: true` (forward then back). */
interface Segment {
  duration: number
  ease: Ease
  from: Channels
  to: Channels
  yoyo: boolean
}

function segmentSpan(segment: Segment): number {
  return segment.yoyo ? segment.duration * 2 : segment.duration
}

/**
 * GSAP's tween ratio at `local` seconds into the segment: a yoyo iteration
 * flips the time and eases the flipped time with the same ease.
 */
function segmentRatio(segment: Segment, local: number): number {
  const span = segmentSpan(segment)
  if (local <= 0) return applyEase(segment.ease, 0)
  if (local >= span) return applyEase(segment.ease, segment.yoyo ? 0 : 1)
  const time = segment.yoyo && local > segment.duration ? span - local : local
  return applyEase(segment.ease, time / segment.duration)
}

function segmentAt(segment: Segment, local: number): Channels {
  const ratio = segmentRatio(segment, local)
  const out = zero()
  for (let k = 0; k < CHANNEL_COUNT; k += 1) {
    out[k] = segment.from[k] + (segment.to[k] - segment.from[k]) * ratio
  }
  return out
}

/** page-pet's reaction timeline: sequential segments from `start`. */
interface Envelope {
  start: number
  segments: Segment[]
  total: number
}

function envelopeAt(envelope: Envelope, now: number): Channels {
  const elapsed = now - envelope.start
  if (elapsed >= envelope.total) return zero()
  let offset = 0
  for (const segment of envelope.segments) {
    const span = segmentSpan(segment)
    if (elapsed < offset + span) return segmentAt(segment, elapsed - offset)
    offset += span
  }
  return zero()
}

/** The clamped channel sum (spring + envelope + breath) in 180 px units. */
export interface MotionChannels {
  x: number
  y: number
  angle: number
  skew: number
  squash: number
}

/**
 * The transform to draw the sprite with, about `pivot` (normalized cell
 * coordinates). Compose it CSS-style: translate, rotate, skewX, scale, with
 * the pivot as the origin (`cssMatrix`).
 */
export interface MotionTransform {
  /** Canvas pixels at the drawn size. */
  translateX: number
  translateY: number
  /** Clockwise degrees (CSS `rotate`). */
  rotationDeg: number
  /** CSS `skewX` degrees. */
  skewXDeg: number
  scaleX: number
  /** Always `1 / scaleX`: the squash preserves area. */
  scaleY: number
  pivot: readonly [number, number]
}

export function identityTransform(pivot: readonly [number, number]): MotionTransform {
  return {
    translateX: 0,
    translateY: 0,
    rotationDeg: 0,
    skewXDeg: 0,
    scaleX: 1,
    scaleY: 1,
    pivot
  }
}

/** Exactly no motion (the pivot does not count). */
export function isIdentityTransform(t: MotionTransform): boolean {
  return (
    t.translateX === 0 &&
    t.translateY === 0 &&
    t.rotationDeg === 0 &&
    t.skewXDeg === 0 &&
    t.scaleX === 1 &&
    t.scaleY === 1
  )
}

/**
 * The CSS `matrix(a, b, c, d, e, f)` of `translate(tx, ty) rotate(r)
 * skewX(s) scale(sx, sy)` about the origin. Callers move the pivot to the
 * origin first (and back after), as `transform-origin` does.
 */
export function cssMatrix(t: MotionTransform): [number, number, number, number, number, number] {
  const r = (t.rotationDeg * Math.PI) / 180
  const sin = Math.sin(r)
  const cos = Math.cos(r)
  const tan = Math.tan((t.skewXDeg * Math.PI) / 180)
  return [
    cos * t.scaleX,
    sin * t.scaleX,
    (cos * tan - sin) * t.scaleY,
    (sin * tan + cos) * t.scaleY,
    t.translateX,
    t.translateY
  ]
}

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value))

/**
 * The motion model: feed it impulses and reactions, advance it with the
 * frame clock (seconds), read the transform.
 */
export class GolemMotion {
  private current: MotionConfig
  private state: Channels = zero()
  private velocity: Channels = zero()
  private springRunning = false
  private envelope: Envelope | null = null
  private idleFlag = true
  private breathGain = 0
  private lastNow: number | null = null

  constructor(config: Partial<MotionConfig> = {}) {
    this.current = { ...defaultMotionConfig(), ...config }
  }

  get config(): Readonly<MotionConfig> {
    return this.current
  }

  /**
   * Replace the configuration without disturbing motion in flight: a new
   * intensity applies to the next impulse or reaction and to breathing at
   * once, a new size rescales the output at once.
   */
  setConfig(config: Partial<MotionConfig>): void {
    this.current = { ...this.current, ...config }
  }

  /** page-pet's `stop()`: everything to rest, at once. */
  stop(): void {
    this.state = zero()
    this.velocity = zero()
    this.springRunning = false
    this.envelope = null
    this.breathGain = 0
  }

  /**
   * Whether the pet rests on a gaze cell (D15: breathing runs only then).
   * A reaction in flight already counts as not idle; the caller reports the
   * frame hold after it, talking and sleep.
   */
  setIdle(idle: boolean): void {
    this.idleFlag = idle
  }

  get idle(): boolean {
    return this.idleFlag
  }

  /** page-pet's `nudge(y, angle)`: velocity impulses times the intensity, clamped. */
  nudge(y: number, angle: number): void {
    const amount = this.current.intensity
    if (amount <= 0) return
    this.velocity[Y] = clamp(this.velocity[Y] + y * amount, NUDGE_LIMIT_Y)
    this.velocity[ANGLE] = clamp(this.velocity[ANGLE] + angle * amount, NUDGE_LIMIT_ANGLE)
    this.springRunning = true
  }

  /** D11: the gaze moved by `deltaX` (page-pet gaze units) and the body turns a little. */
  gazeTurn(deltaX: number): void {
    this.nudge(0, deltaX * GAZE_TURN_ANGLE_PER_UNIT)
  }

  /** D12: one talk step for a pack without talk frames. */
  talkBob(): void {
    this.nudge(TALK_BOB_VELOCITY, 0)
  }

  /**
   * page-pet's `reaction(id)` with the on-stream origin (the foot pivot, no
   * click): starts the envelope at `now` and returns its length in seconds
   * (0 when nothing will move). A reaction in flight is replaced from its
   * current values. `blink` never moves (page-pet's rule).
   */
  react(id: string, now: number): number {
    if (id === BLINK_REACTION_ID) return 0
    const tuning = this.current.tuning
    const amount = this.current.intensity * tuning.reaction
    const from = this.gestureAt(now)
    this.envelope = null
    if (amount <= 0) return 0
    const [poseY, poseAngle, poseSquash] = reactionPose(id)
    const speed = tuning.speed
    const segments: Segment[] = []
    let cursor = from
    let total = 0
    const push = (duration: number, e: Ease, yoyo: boolean, to: Channels): void => {
      const segment: Segment = { duration, ease: e, from: cursor, to, yoyo }
      segments.push(segment)
      total += segmentSpan(segment)
      if (!yoyo) cursor = to
    }
    // The crouch: page-pet's first tween with `impact = 0` (no click).
    const crouch: Channels = [...cursor]
    crouch[X] = 0
    crouch[Y] = 3 * amount
    crouch[SQUASH] = 0.045 * amount
    crouch[ANGLE] = -poseAngle * 0.25 * amount
    push(0.11 / speed, { kind: 'cubic' }, false, crouch)
    // The pose.
    const pose: Channels = [...cursor]
    pose[X] = 0
    pose[Y] = poseY * amount
    pose[ANGLE] = poseAngle * amount
    pose[SQUASH] = poseSquash * amount
    push(0.19 / speed, { kind: 'cubic' }, false, pose)
    // The laugh shake, forward then back (yoyo), on y and squash only.
    if (id === 'laugh') {
      const shake: Channels = [...cursor]
      shake[Y] = -3 * amount
      shake[SQUASH] = -0.025 * amount
      push(0.11 / speed, { kind: 'sine' }, true, shake)
    }
    // The return to rest.
    const back: Ease =
      tuning.bounce > 0
        ? { kind: 'elastic', period: 0.55 - tuning.bounce * 0.25 }
        : { kind: 'quartic' }
    push((0.45 + tuning.bounce * 0.3) / speed, back, false, zero())
    this.envelope = { start: now, segments, total }
    return total
  }

  /** When the reaction envelope in flight completes, if any. */
  reactionEndsAt(): number | null {
    return this.envelope ? this.envelope.start + this.envelope.total : null
  }

  /** Nothing is moving: the spring settled, no envelope, breath faded. */
  isResting(): boolean {
    return !this.springRunning && this.envelope === null && this.breathGain === 0
  }

  /**
   * page-pet's `step()`: integrate the spring from the previous call to
   * `now` (at most 50 ms, 120 Hz substeps), settle it, fade the breath,
   * retire a finished envelope. Returns the transform at `now`.
   */
  advance(now: number): MotionTransform {
    const dt =
      this.lastNow === null ? 0 : Math.max(0, Math.min(MAX_STEP_SECONDS, now - this.lastNow))
    this.lastNow = now
    if (this.springRunning) {
      const tuning = this.current.tuning
      const stiffness = 300 - tuning.weight * 210
      const damping = 2 * Math.sqrt(stiffness) * (0.3 + tuning.damping * 0.8)
      const steps = Math.max(1, Math.ceil(dt * SUBSTEP_HZ))
      const h = dt / steps
      for (let i = 0; i < steps; i += 1) {
        for (let k = 0; k < CHANNEL_COUNT; k += 1) {
          this.velocity[k] += (-stiffness * this.state[k] - damping * this.velocity[k]) * h
          this.state[k] += this.velocity[k] * h
        }
      }
      if (this.springSettled()) {
        this.state = zero()
        this.velocity = zero()
        this.springRunning = false
      }
    }
    if (this.envelope && now - this.envelope.start >= this.envelope.total) {
      this.envelope = null
    }
    const breathing = this.current.breathing && this.idleFlag && this.envelope === null
    const target = breathing ? 1 : 0
    this.breathGain += (target - this.breathGain) * (1 - Math.exp(-dt / BREATH_FADE_SECONDS))
    if (Math.abs(this.breathGain - target) < 1e-4) this.breathGain = target
    return this.transform()
  }

  private springSettled(): boolean {
    for (let k = 0; k < CHANNEL_COUNT; k += 1) {
      const position = k === SQUASH ? SETTLE_SQUASH_POSITION : SETTLE_POSITION
      const velocity = k === SQUASH ? SETTLE_SQUASH_VELOCITY : SETTLE_VELOCITY
      if (!(Math.abs(this.state[k]) < position && Math.abs(this.velocity[k]) < velocity)) {
        return false
      }
    }
    return true
  }

  private gestureAt(now: number): Channels {
    return this.envelope ? envelopeAt(this.envelope, now) : zero()
  }

  private breath(): number {
    if (this.lastNow === null || this.breathGain <= 0) return 0
    return (
      this.breathGain *
      BREATH_AMPLITUDE *
      this.current.intensity *
      Math.sin(TAU * BREATH_HZ * this.lastNow)
    )
  }

  /** page-pet's `render()` sums and clamps, in 180 px units, as of the last `advance`. */
  channels(): MotionChannels {
    const gesture = this.gestureAt(this.lastNow ?? 0)
    const state = this.state
    return {
      x: clamp(state[X] + gesture[X], MOTION_LIMITS.xPx),
      y: clamp(state[Y] + gesture[Y], MOTION_LIMITS.yPx),
      angle: clamp(state[ANGLE] + gesture[ANGLE], MOTION_LIMITS.rotationDeg),
      skew: clamp(state[SKEW] + gesture[SKEW], MOTION_LIMITS.skewDeg),
      squash: clamp(state[SQUASH] + gesture[SQUASH] + this.breath(), MOTION_LIMITS.squash)
    }
  }

  /** The transform as of the last `advance`; the identity at intensity 0. */
  transform(): MotionTransform {
    const pivot = this.current.pivot
    if (this.current.intensity <= 0) return identityTransform(pivot)
    const c = this.channels()
    const scale = this.current.size / TUNING_SIZE_PX
    return {
      translateX: c.x * scale,
      translateY: c.y * scale,
      rotationDeg: c.angle,
      skewXDeg: c.skew,
      scaleX: 1 + c.squash,
      scaleY: 1 / (1 + c.squash),
      pivot
    }
  }
}
