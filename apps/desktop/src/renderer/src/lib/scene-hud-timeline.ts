import { SCENE_HUD_FADE_MS, SCENE_HUD_HOLD_MS } from '../../../shared/scene-hud'

/**
 * The key HUD's clock (plan 231 D20): the chip shows at once, holds 900 ms,
 * then fades over 120 ms on opacity alone. Reduced motion drops it at the end
 * of the hold with no fade. A second switch inside the hold replaces the chip
 * and starts the clock again, so only the last scene is ever named.
 */
export type SceneHudPhase = 'shown' | 'fading' | 'hidden'

export interface SceneHudView<T> {
  item: T | null
  phase: SceneHudPhase
  /** The fade's length while `fading`; 0 otherwise. */
  fadeMs: number
}

export interface SceneHudTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: SceneHudTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export const HIDDEN_SCENE_HUD: SceneHudView<never> = Object.freeze({
  item: null,
  phase: 'hidden',
  fadeMs: 0
})

export class SceneHudTimeline<T> {
  private timer: unknown = null

  constructor(
    private readonly onChange: (view: SceneHudView<T>) => void,
    private readonly timers: SceneHudTimers = realTimers
  ) {}

  present(item: T, options: { reducedMotion: boolean; holdMs?: number }): void {
    this.cancel()
    this.onChange({ item, phase: 'shown', fadeMs: 0 })
    this.timer = this.timers.setTimeout(() => {
      if (options.reducedMotion) {
        this.timer = null
        this.onChange(HIDDEN_SCENE_HUD)
        return
      }
      this.onChange({ item, phase: 'fading', fadeMs: SCENE_HUD_FADE_MS })
      this.timer = this.timers.setTimeout(() => {
        this.timer = null
        this.onChange(HIDDEN_SCENE_HUD)
      }, SCENE_HUD_FADE_MS)
    }, options.holdMs ?? SCENE_HUD_HOLD_MS)
  }

  dispose(): void {
    this.cancel()
  }

  private cancel(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
  }
}
