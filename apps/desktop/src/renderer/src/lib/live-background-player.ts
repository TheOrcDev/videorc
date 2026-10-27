// The Liquid Chrome backdrop behind first-run setup (plan 203 S4). It runs the
// same WebGL2 player and phase clock the Electron proof surface inlines
// (plans 190 and 194), imported here as modules for their side effect: they
// set `globalThis.VideorcLiveBackground` and `VideorcLiveBackgroundClock`.
// Only the lazy setup chunk imports this file, so none of it reaches the eager
// bundle. Nothing here changes what those shared files draw: they serve the
// Windows and Linux preview.

import '../../../shared/live-background-clock.js'
import '../../../shared/live-background-webgl.js'
import renderJsonText from '../../../shared/live-backgrounds.render.generated.json?raw'

export type WelcomeBackdropLook = 'polished' | 'gold' | 'mercury'
export type BackdropLevel = 'full' | 'half'

/**
 * Why the backdrop shows its poster instead of moving. Logged to the console
 * and carried on the smoke's DOM contract; never UI copy.
 */
export type BackdropStillReason =
  | 'reduced-motion'
  | 'hardware-acceleration-off'
  | 'no-gpu'
  | 'software-gpu'
  | 'shader-compile-failed'
  | 'context-lost'
  | 'gpu-budget'

/**
 * Plan 203 D8: Liquid Chrome in its first look, Polished, the one a click on
 * its tile applies, at Normal motion: the owner's by-eye (2026-10-27) found
 * Mercury at Calm too slow to read as live. The same look in both themes.
 * Dim only under dark, so the card's rim reads against the chrome; more under
 * `prefers-contrast: more`.
 */
export const WELCOME_BACKDROP = {
  id: 'liquid-chrome',
  look: 'polished' as WelcomeBackdropLook,
  motion: 'normal',
  dimDark: 0.3,
  dimLight: 0,
  moreContrastDim: 0.2
} as const

/** Decoration never needs more than 30 frames a second. */
export const BACKDROP_FPS = 30
const FRAME_INTERVAL_MS = 1000 / BACKDROP_FPS
// rAF ticks land a little either side of the ideal interval; without the
// slack a 60 Hz display would draw every third tick instead of every second.
const FRAME_SLACK_MS = 2

/** The canvas's long side, in device pixels. The chrome is soft; CSS scales it up. */
export const BACKDROP_MAX_CANVAS_SIDE = 1920

/** The budget guard: each 3 s window, a median frame interval over 50 ms steps down. */
export const BACKDROP_GUARD_WINDOW_MS = 3000
export const BACKDROP_GUARD_SLOW_INTERVAL_MS = 50

/** Dim as the shaders take it (`u[1].z`), clamped like the proof surface's. */
export function welcomeBackdropDim({
  dark,
  moreContrast
}: {
  dark: boolean
  moreContrast: boolean
}): number {
  const base = dark ? WELCOME_BACKDROP.dimDark : WELCOME_BACKDROP.dimLight
  const dim = base + (moreContrast ? WELCOME_BACKDROP.moreContrastDim : 0)
  return Math.min(0.8, Math.max(0, dim))
}

/** A still before any GL work: the system asked for it, or there's no GPU to ask. */
export function backdropStartStillReason({
  reducedMotion,
  hardwareAccelerationDisabled
}: {
  reducedMotion: boolean
  hardwareAccelerationDisabled: boolean
}): BackdropStillReason | null {
  if (reducedMotion) return 'reduced-motion'
  if (hardwareAccelerationDisabled) return 'hardware-acceleration-off'
  return null
}

/** SwiftShader, llvmpipe and friends: a software GPU draws, but at the CPU's cost. */
export function isSoftwareRenderer(name: string | null | undefined): boolean {
  return typeof name === 'string' && /swiftshader|llvmpipe|softpipe|software/i.test(name)
}

export function backdropFrameDue(lastDrawMs: number | null, nowMs: number): boolean {
  return lastDrawMs === null || nowMs - lastDrawMs >= FRAME_INTERVAL_MS - FRAME_SLACK_MS
}

/** The canvas size for a box of CSS pixels: device pixels, long side capped. */
export function backdropCanvasSize(
  boxWidth: number,
  boxHeight: number,
  devicePixelRatio: number
): { width: number; height: number } | null {
  if (!(boxWidth > 0) || !(boxHeight > 0)) return null
  const scale = Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1)
  let width = Math.max(1, Math.round(boxWidth * scale))
  let height = Math.max(1, Math.round(boxHeight * scale))
  const longSide = Math.max(width, height)
  if (longSide > BACKDROP_MAX_CANVAS_SIDE) {
    const shrink = BACKDROP_MAX_CANVAS_SIDE / longSide
    width = Math.max(1, Math.round(width * shrink))
    height = Math.max(1, Math.round(height * shrink))
  }
  return { width, height }
}

export type BackdropGuardLevel = BackdropLevel | 'still'

export interface BackdropGuard {
  level: BackdropGuardLevel
  windowStartMs: number | null
  intervals: number[]
}

export function createBackdropGuard(): BackdropGuard {
  return { level: 'full', windowStartMs: null, intervals: [] }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Like the backend's guard (`live_background/guard.rs`), simpler: one window
 * of drawn-frame intervals at a time. Slow at full size drops to half; slow
 * at half shows the poster for the rest of setup. It never climbs back.
 */
export function recordBackdropFrame(
  guard: BackdropGuard,
  intervalMs: number,
  nowMs: number
): BackdropGuard {
  if (guard.level === 'still') return guard
  const windowStartMs = guard.windowStartMs ?? nowMs
  const intervals = [...guard.intervals, intervalMs]
  if (nowMs - windowStartMs < BACKDROP_GUARD_WINDOW_MS) {
    return { level: guard.level, windowStartMs, intervals }
  }
  const slow = median(intervals) > BACKDROP_GUARD_SLOW_INTERVAL_MS
  const level: BackdropGuardLevel = !slow ? guard.level : guard.level === 'full' ? 'half' : 'still'
  return { level, windowStartMs: nowMs, intervals: [] }
}

/** After a pause or a resize, the intervals since are not the GPU's fault. */
export function resetBackdropGuardWindow(guard: BackdropGuard): BackdropGuard {
  return { level: guard.level, windowStartMs: null, intervals: [] }
}

// The shared scripts' globals, typed for what this file calls.
type DrawOptions = {
  id: string
  look: string
  phase: number
  dim: number
  width: number
  height: number
  level: BackdropLevel
}
type Runner = { draw: (options: DrawOptions) => void; dispose: () => void }
type RunnerGlobal = { create: (gl: WebGL2RenderingContext, render: unknown) => Runner }
type ClockSpec = { id: string; look: string; motion: string; rate: number; posterPhase: number }
type Clock = { readonly id: string }
type ClockGlobal = {
  start: (spec: ClockSpec, now: number) => Clock
  phaseAt: (clock: Clock, now: number) => number
  hold: (clock: Clock, now: number) => void
  release: (clock: Clock, now: number) => void
}
type RenderLook = { id: string; rate: number; posterPhase: number }
type RenderData = { backgrounds: { id: string; looks: RenderLook[] }[] }

let renderData: RenderData | null = null

function render(): RenderData {
  renderData ??= JSON.parse(renderJsonText) as RenderData
  return renderData
}

function sharedGlobals(): { player: RunnerGlobal; clock: ClockGlobal } | null {
  const scope = globalThis as {
    VideorcLiveBackground?: RunnerGlobal
    VideorcLiveBackgroundClock?: ClockGlobal
  }
  return scope.VideorcLiveBackground && scope.VideorcLiveBackgroundClock
    ? { player: scope.VideorcLiveBackground, clock: scope.VideorcLiveBackgroundClock }
    : null
}

/** The look's clock constants from the backend's export (the poster phase and rate). */
export function welcomeBackdropClockSpec(look: WelcomeBackdropLook): ClockSpec | null {
  const background = render().backgrounds.find((entry) => entry.id === WELCOME_BACKDROP.id)
  const entry = background?.looks.find((candidate) => candidate.id === look)
  return entry
    ? {
        id: WELCOME_BACKDROP.id,
        look: entry.id,
        motion: WELCOME_BACKDROP.motion,
        rate: entry.rate,
        posterPhase: entry.posterPhase
      }
    : null
}

const CONTEXT_OPTIONS: WebGLContextAttributes = {
  antialias: false,
  alpha: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  // Decoration: never wake a discrete GPU for it.
  powerPreference: 'low-power',
  failIfMajorPerformanceCaveat: true
}

function loseContext(gl: WebGL2RenderingContext | null): void {
  try {
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    // Already lost.
  }
}

/**
 * Chromium refused a context with the performance caveat: a software GPU, or
 * none. One throwaway context without the caveat tells which.
 */
function refusedContextReason(): BackdropStillReason {
  try {
    const probe = document.createElement('canvas').getContext('webgl2', {
      failIfMajorPerformanceCaveat: false
    })
    if (probe) {
      loseContext(probe)
      return 'software-gpu'
    }
  } catch {
    // No WebGL2 at all.
  }
  return 'no-gpu'
}

function rendererName(gl: WebGL2RenderingContext): string | null {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

export interface BackdropPlayerHandle {
  setDim: (dim: number) => void
  /** Hold the clock and stop drawing while the window is hidden. */
  setRunning: (running: boolean) => void
  dispose: () => void
}

/**
 * Draws Liquid Chrome into a canvas of its own inside `host` until disposed.
 * `onFirstFrame` fires once the first frame is on the canvas (the host can
 * fade in over the poster without a jump: the clock starts at the poster
 * phase). `onStill` fires at most once, after which nothing is left
 * allocated. The canvas is the player's because a disposed player loses its
 * context: a canvas used again (a look change, StrictMode's second effect
 * run) would hand the next player that lost context.
 */
export function startBackdropPlayer({
  host,
  look,
  dim: initialDim,
  onFirstFrame,
  onStill
}: {
  host: HTMLElement
  look: WelcomeBackdropLook
  dim: number
  onFirstFrame: () => void
  onStill: (reason: BackdropStillReason, detail?: string) => void
}): BackdropPlayerHandle {
  let dim = initialDim
  let running = true
  let disposed = false
  let frame: number | null = null
  let lastDrawMs: number | null = null
  let drawn = false
  let guard = createBackdropGuard()
  let gl: WebGL2RenderingContext | null = null
  let runner: Runner | null = null
  let clock: Clock | null = null
  const globals = sharedGlobals()
  const spec = welcomeBackdropClockSpec(look)
  const canvas = document.createElement('canvas')
  canvas.className = 'block size-full'
  host.append(canvas)

  const teardown = (lose: boolean): void => {
    disposed = true
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    canvas.removeEventListener('webglcontextlost', onContextLost)
    try {
      runner?.dispose()
    } catch {
      // The context may already be gone; its objects went with it.
    }
    runner = null
    if (lose) loseContext(gl)
    gl = null
    canvas.remove()
  }

  const still = (reason: BackdropStillReason, detail?: string): void => {
    if (disposed) return
    teardown(reason !== 'context-lost')
    onStill(reason, detail)
  }

  function onContextLost(): void {
    still('context-lost')
  }

  const tick = (nowMs: number): void => {
    frame = null
    if (disposed || !running || !runner || !clock || !globals) return
    frame = requestAnimationFrame(tick)
    if (!backdropFrameDue(lastDrawMs, nowMs)) return
    const size = backdropCanvasSize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio)
    if (!size) return
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width
      canvas.height = size.height
      guard = resetBackdropGuardWindow(guard)
      lastDrawMs = null
    }
    const level = guard.level === 'half' ? 'half' : 'full'
    try {
      runner.draw({
        id: WELCOME_BACKDROP.id,
        look,
        phase: globals.clock.phaseAt(clock, nowMs / 1000),
        dim,
        width: size.width,
        height: size.height,
        level
      })
    } catch (error) {
      still('shader-compile-failed', error instanceof Error ? error.message : String(error))
      return
    }
    if (!drawn) {
      drawn = true
      onFirstFrame()
    }
    if (lastDrawMs !== null) {
      guard = recordBackdropFrame(guard, nowMs - lastDrawMs, nowMs)
      if (guard.level === 'still') {
        still('gpu-budget')
        return
      }
    }
    lastDrawMs = nowMs
  }

  const handle: BackdropPlayerHandle = {
    setDim: (next) => {
      dim = next
    },
    setRunning: (next) => {
      if (disposed || next === running || !clock || !globals) return
      running = next
      const nowSeconds = performance.now() / 1000
      if (!next) {
        globals.clock.hold(clock, nowSeconds)
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        return
      }
      globals.clock.release(clock, nowSeconds)
      guard = resetBackdropGuardWindow(guard)
      lastDrawMs = null
      frame = requestAnimationFrame(tick)
    },
    dispose: () => {
      if (!disposed) teardown(true)
    }
  }

  if (!globals || !spec) {
    // The shared scripts didn't load or the look isn't in the export: a
    // packaging fault, never expected. The poster stays.
    queueMicrotask(() => still('shader-compile-failed', 'live background player unavailable'))
    return handle
  }

  try {
    gl = canvas.getContext('webgl2', CONTEXT_OPTIONS)
  } catch {
    gl = null
  }
  if (!gl) {
    const reason = refusedContextReason()
    queueMicrotask(() => still(reason))
    return handle
  }
  const name = rendererName(gl)
  if (isSoftwareRenderer(name)) {
    queueMicrotask(() => still('software-gpu', name ?? undefined))
    return handle
  }
  canvas.addEventListener('webglcontextlost', onContextLost)
  try {
    runner = globals.player.create(gl, render())
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    queueMicrotask(() => still('shader-compile-failed', detail))
    return handle
  }
  clock = globals.clock.start(spec, performance.now() / 1000)
  frame = requestAnimationFrame(tick)
  return handle
}
