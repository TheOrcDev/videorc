import {
  DEFAULT_PIVOT,
  GolemMotion,
  identityTransform,
  type MotionTransform
} from '../../../shared/golem-motion'
import type { GolemMotionSettings } from '../../../shared/golem-pet'

/**
 * The in-app living preview's brain (plan 168 S-D1): page-pet's
 * `runtime/page-pet.js` (MIT, Cristian 2026) without the DOM, the drag or
 * the two-layer packs, driven by an injected clock so tests can step it.
 * The canvas (`components/golem-pet-preview.tsx`) feeds it the pointer, the
 * clicks and the frame clock and draws `frame` with `advance(now)`.
 *
 * Kept from page-pet, number for number: the 160 ms idle tick, the nearest
 * gaze cell to the pointer (16 px dead zone, radius `max(120, 1.3 × size)`),
 * the click cycle over every reaction but blink and sleep (250 ms cooldown,
 * a hold of `max(1.1 s, the motion envelope)`), the blink every 3.5 to 6 s
 * only on the neutral cell (160 ms), sleep after a quiet spell (the
 * persona's `sleepAfterSeconds` instead of page-pet's fixed 14 s), and
 * `prefers-reduced-motion`: no tracking, no idle, no transforms, but a click
 * still shows its drawn reaction. Motion comes from `shared/golem-motion.ts`
 * (S-C1), the same model the stream uses.
 */

export interface GolemPetPlayerFrame {
  id: string
  kind: 'gaze' | 'reaction'
  /** Gaze frames only: page-pet coordinates in [-1, 1]². */
  gaze?: readonly [number, number]
}

export interface GolemPetPlayerPack {
  neutral: string
  pivot?: readonly [number, number]
  frames: readonly GolemPetPlayerFrame[]
}

export interface GolemPreviewRect {
  left: number
  top: number
  width: number
  height: number
}

/** page-pet's idle clock (`setInterval(tick, 160)`). */
export const GOLEM_PREVIEW_TICK_MS = 160
/** Pointer offsets under this many pixels count as straight ahead. */
export const GOLEM_PREVIEW_DEAD_ZONE_PX = 16
/** The tracking radius: `max(120, 1.3 × the drawn size)`. */
export const GOLEM_PREVIEW_MIN_RADIUS_PX = 120
export const GOLEM_PREVIEW_RADIUS_PER_SIZE = 1.3
export const GOLEM_PREVIEW_CLICK_COOLDOWN_MS = 250
/** A reaction frame holds at least this long (page-pet's 1100 ms). */
export const GOLEM_PREVIEW_REACTION_HOLD_MS = 1100
export const GOLEM_PREVIEW_BLINK_MS = 160
export const GOLEM_PREVIEW_BLINK_EVERY_MS = 3500
export const GOLEM_PREVIEW_BLINK_JITTER_MS = 2500
/** Reactions a click never cycles to (page-pet's `clickReaction`). */
export const GOLEM_PREVIEW_IDLE_REACTIONS: readonly string[] = ['blink', 'sleep']
/** The spring settles well inside this after an impulse (about 0.5 s at page-pet's tuning). */
const SPRING_SETTLE_MS = 1500

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

/** page-pet's `nearestGaze`: the gaze frame closest to `(x, y)`; ties keep the first. */
export function nearestGazeFrame<T extends GolemPetPlayerFrame>(
  frames: readonly T[],
  x: number,
  y: number
): T | null {
  let best: T | null = null
  let bestDistance = Infinity
  for (const frame of frames) {
    if (!frame.gaze) continue
    const distance = (frame.gaze[0] - x) ** 2 + (frame.gaze[1] - y) ** 2
    if (distance < bestDistance) {
      best = frame
      bestDistance = distance
    }
  }
  return best
}

/**
 * page-pet's `track()` geometry: where the pointer is, as a gaze point,
 * from the centre of the pet's box. Within 16 px of the centre on an axis
 * that axis is 0; beyond, the offset over the radius, clamped to [-1, 1].
 */
export function pointerGaze(
  pointerX: number,
  pointerY: number,
  rect: GolemPreviewRect
): [number, number] {
  const radius = Math.max(GOLEM_PREVIEW_MIN_RADIUS_PX, rect.width * GOLEM_PREVIEW_RADIUS_PER_SIZE)
  const dx = pointerX - rect.left - rect.width / 2
  const dy = pointerY - rect.top - rect.height / 2
  const x = Math.abs(dx) < GOLEM_PREVIEW_DEAD_ZONE_PX ? 0 : clamp(dx / radius, -1, 1)
  const y = Math.abs(dy) < GOLEM_PREVIEW_DEAD_ZONE_PX ? 0 : clamp(dy / radius, -1, 1)
  return [x, y]
}

/** How often the canvas needs to run: every frame, at breathing pace, or only the idle tick. */
export type GolemPreviewCadence = 'frame' | 'breath' | 'tick'

export interface GolemPetPlayerOptions {
  pack: GolemPetPlayerPack
  /** The drawn size in CSS pixels (motion translations scale by size / 180). */
  size: number
  motion: GolemMotionSettings
  reducedMotion: boolean
  /** Milliseconds, the same clock every later call uses. */
  now: number
  random?: () => number
}

export class GolemPetPlayer {
  private readonly pack: GolemPetPlayerPack
  private readonly gazes: GolemPetPlayerFrame[]
  private readonly neutralFrame: GolemPetPlayerFrame
  private readonly motion: GolemMotion
  private readonly random: () => number
  private readonly pivot: readonly [number, number]
  private settings: GolemMotionSettings
  private reduced: boolean
  /** Where the pet looks (page-pet's `gaze`). */
  private gaze: GolemPetPlayerFrame
  /** What is drawn (page-pet's `currentFrame`). */
  private current: GolemPetPlayerFrame
  private reactionUntil = 0
  private lastActivity: number
  private nextBlink: number
  private locked = false
  private clickIndex = 0
  private lastClick = -Infinity
  private liveUntil = 0

  constructor(options: GolemPetPlayerOptions) {
    this.pack = options.pack
    this.gazes = options.pack.frames.filter((frame) => frame.kind === 'gaze' && frame.gaze)
    const neutral = options.pack.frames.find(
      (frame) => frame.id === options.pack.neutral && frame.kind === 'gaze'
    )
    if (!neutral) throw new Error('A Golem pack needs a neutral gaze frame.')
    this.neutralFrame = neutral
    this.gaze = neutral
    this.current = neutral
    this.random = options.random ?? Math.random
    this.settings = { ...options.motion }
    this.reduced = options.reducedMotion
    this.pivot = options.pack.pivot ?? DEFAULT_PIVOT
    this.motion = new GolemMotion({
      intensity: options.motion.intensity,
      breathing: options.motion.breathing,
      size: options.size,
      pivot: this.pivot
    })
    this.lastActivity = options.now
    this.nextBlink = options.now + GOLEM_PREVIEW_BLINK_EVERY_MS
  }

  /** The frame to draw now. */
  get frame(): GolemPetPlayerFrame {
    return this.current
  }

  /** Where the pet looks, which is drawn unless a reaction holds. */
  get gazeFrame(): GolemPetPlayerFrame {
    return this.gaze
  }

  get isLocked(): boolean {
    return this.locked
  }

  /** The pack's reaction ids, in manifest order. */
  reactions(): string[] {
    return this.pack.frames.filter((frame) => frame.kind === 'reaction').map((frame) => frame.id)
  }

  hasReaction(id: string): boolean {
    return this.reactionFrame(id) !== null
  }

  setMotionSettings(settings: GolemMotionSettings): void {
    this.settings = { ...settings }
    this.motion.setConfig({ intensity: settings.intensity, breathing: settings.breathing })
  }

  setSize(size: number): void {
    this.motion.setConfig({ size })
  }

  /** page-pet's reduced-motion change: back to the neutral cell, motion off. */
  setReducedMotion(reduced: boolean): boolean {
    if (reduced === this.reduced) return false
    this.reduced = reduced
    if (reduced) this.motion.stop()
    return this.center()
  }

  /** page-pet's `resetMotion()`: the canvas went hidden or offscreen. */
  stop(): void {
    this.motion.stop()
    this.liveUntil = 0
  }

  /**
   * page-pet's `track()`: the pointer moved somewhere in the window. The
   * gaze follows; a turn nudges the body (`Δx × 9`, S-C1's `gazeTurn`) unless
   * a reaction holds. Returns whether the drawn frame changed (a sleeping
   * pet wakes here).
   */
  track(pointerX: number, pointerY: number, rect: GolemPreviewRect, now: number): boolean {
    if (this.locked || this.reduced) return false
    this.lastActivity = now
    const [x, y] = pointerGaze(pointerX, pointerY, rect)
    const previous = this.gaze
    this.gaze = nearestGazeFrame(this.gazes, x, y) ?? this.neutralFrame
    if (previous !== this.gaze && !this.reactionUntil) {
      this.motion.gazeTurn((this.gaze.gaze?.[0] ?? 0) - (previous.gaze?.[0] ?? 0))
      this.liveUntil = Math.max(this.liveUntil, now + SPRING_SETTLE_MS)
    }
    if (!this.reactionUntil && this.current !== this.gaze) {
      this.current = this.gaze
      return true
    }
    return false
  }

  /** page-pet's `center()`: the pointer left the window. */
  center(): boolean {
    if (this.locked) return false
    this.gaze = this.neutralFrame
    if (!this.reactionUntil && this.current !== this.gaze) {
      this.current = this.gaze
      return true
    }
    return false
  }

  /**
   * page-pet's `clickReaction()` with `click-reaction="cycle"`: the next
   * reaction other than blink and sleep, at most one per 250 ms. Returns
   * the id played, or null.
   */
  click(now: number): string | null {
    if (now - this.lastClick < GOLEM_PREVIEW_CLICK_COOLDOWN_MS) return null
    this.lastClick = now
    const cycle = this.pack.frames.filter(
      (frame) => frame.kind === 'reaction' && !GOLEM_PREVIEW_IDLE_REACTIONS.includes(frame.id)
    )
    if (cycle.length === 0) return null
    const id = cycle[this.clickIndex++ % cycle.length]!.id
    return this.react(id, now) ? id : null
  }

  /**
   * page-pet's `react(id, duration, activity)`: show the reaction frame for
   * `durationMs` (160 ms to 30 s) or the motion envelope, whichever is
   * longer. A blink or a non-activity reaction never moves. False when the
   * pack has no such reaction.
   */
  react(
    id: string,
    now: number,
    durationMs = GOLEM_PREVIEW_REACTION_HOLD_MS,
    activity = true
  ): boolean {
    const frame = this.reactionFrame(id)
    if (!frame) return false
    this.locked = false
    if (activity) this.lastActivity = now
    this.reactionUntil =
      now + clamp(Number(durationMs) || GOLEM_PREVIEW_REACTION_HOLD_MS, 160, 30_000)
    this.current = frame
    if (activity && id !== 'blink' && !this.reduced) {
      const seconds = this.motion.react(id, now / 1000)
      this.reactionUntil = Math.max(this.reactionUntil, now + seconds * 1000)
    }
    return true
  }

  /**
   * D14's last fallback: a reaction the pack has no frame for plays as a
   * motion-only hop (its pose, or page-pet's default pose) on the current
   * frame. False under reduced motion or at Motion 0.
   */
  hop(id: string, now: number): boolean {
    if (this.reduced || this.locked) return false
    this.lastActivity = now
    const seconds = this.motion.react(id, now / 1000)
    return seconds > 0
  }

  /**
   * page-pet's `pose(id)` / `unlock()`: hold one frame (no tracking, no
   * idle, motion at rest) until released with null. Returns whether the
   * drawn frame changed.
   */
  pose(id: string | null, now: number): boolean {
    if (id === null) {
      if (!this.locked) return false
      this.locked = false
      this.reactionUntil = 0
      this.lastActivity = now
      const before = this.current
      this.center()
      this.current = this.gaze
      return before !== this.current
    }
    const frame = this.pack.frames.find((candidate) => candidate.id === id)
    if (!frame) return false
    this.motion.stop()
    this.locked = true
    this.reactionUntil = 0
    const changed = this.current !== frame
    this.current = frame
    return changed
  }

  /** page-pet's `tick()`, every 160 ms. Returns whether the drawn frame changed. */
  tick(now: number): boolean {
    if (this.locked) return false
    const before = this.current
    if (this.reactionUntil) {
      if (now < this.reactionUntil) return false
      this.reactionUntil = 0
      this.current = this.gaze
    }
    if (this.reduced) return this.current !== before
    const sleep = this.pack.frames.find((frame) => frame.id === 'sleep')
    const sleepAfterMs = this.settings.sleepAfterSeconds * 1000
    if (sleep && sleepAfterMs > 0 && now - this.lastActivity > sleepAfterMs) {
      this.current = sleep
    } else if (now > this.nextBlink) {
      // page-pet: the blink is front-facing, so a turned head never snaps
      // forward for 160 ms.
      if (this.gaze === this.neutralFrame) {
        this.react('blink', now, GOLEM_PREVIEW_BLINK_MS, false)
      }
      this.nextBlink =
        now + GOLEM_PREVIEW_BLINK_EVERY_MS + this.random() * GOLEM_PREVIEW_BLINK_JITTER_MS
    }
    return this.current !== before
  }

  /** The transform to draw `frame` with at `now`; the identity under reduced motion. */
  advance(now: number): MotionTransform {
    if (this.reduced) return identityTransform(this.pivot)
    // D15: breathing only while resting on a gaze cell.
    this.motion.setIdle(this.current.kind === 'gaze' && !this.reactionUntil && !this.locked)
    return this.motion.advance(now / 1000)
  }

  /** How soon the canvas must run again for the motion to look smooth. */
  cadence(now: number): GolemPreviewCadence {
    if (this.reduced || this.settings.intensity <= 0) return 'tick'
    if (now < this.liveUntil || this.motion.reactionEndsAt() !== null) return 'frame'
    return this.motion.isResting() ? 'tick' : 'breath'
  }

  private reactionFrame(id: string): GolemPetPlayerFrame | null {
    return this.pack.frames.find((frame) => frame.id === id && frame.kind === 'reaction') ?? null
  }
}
