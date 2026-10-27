// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import {
  BACKDROP_GUARD_WINDOW_MS,
  BACKDROP_MAX_CANVAS_SIDE,
  WELCOME_BACKDROP,
  backdropCanvasSize,
  backdropFrameDue,
  backdropStartStillReason,
  createBackdropGuard,
  isSoftwareRenderer,
  recordBackdropFrame,
  resetBackdropGuardWindow,
  startBackdropPlayer,
  welcomeBackdropClockSpec,
  welcomeBackdropDim,
  type BackdropGuard
} from './live-background-player'

// Plan 203 S4: the Liquid Chrome backdrop behind first-run setup.

function feed(guard: BackdropGuard, intervalMs: number, fromMs: number, untilMs: number) {
  let next = guard
  let now = fromMs
  while (now <= untilMs) {
    next = recordBackdropFrame(next, intervalMs, now)
    now += intervalMs
  }
  return next
}

describe('the welcome backdrop', () => {
  it('is Liquid Chrome, Polished, at Normal motion (D8)', () => {
    expect(WELCOME_BACKDROP).toMatchObject({
      id: 'liquid-chrome',
      look: 'polished',
      motion: 'normal'
    })
  })

  it('loads the shared player and clock, and reads the look from the export', () => {
    const scope = globalThis as Record<string, unknown>
    expect(scope.VideorcLiveBackground).toBeTruthy()
    expect(scope.VideorcLiveBackgroundClock).toBeTruthy()
    // The clock starts at the poster's phase, so the first moving frame is the poster.
    const spec = welcomeBackdropClockSpec('polished')
    expect(spec).toMatchObject({ id: 'liquid-chrome', look: 'polished', motion: 'normal' })
    expect(spec?.rate).toBeGreaterThan(0)
    expect(typeof spec?.posterPhase).toBe('number')
    expect(welcomeBackdropClockSpec('mercury')).not.toBeNull()
    expect(welcomeBackdropClockSpec('gold')).not.toBeNull()
  })

  it('dims only under dark, more with more contrast, never past the shader clamp', () => {
    expect(welcomeBackdropDim({ dark: true, moreContrast: false })).toBeCloseTo(0.3)
    expect(welcomeBackdropDim({ dark: false, moreContrast: false })).toBe(0)
    expect(welcomeBackdropDim({ dark: true, moreContrast: true })).toBeCloseTo(0.5)
    expect(welcomeBackdropDim({ dark: false, moreContrast: true })).toBeCloseTo(0.2)
  })

  it('stays still under reduced motion or without hardware acceleration', () => {
    expect(
      backdropStartStillReason({ reducedMotion: true, hardwareAccelerationDisabled: false })
    ).toBe('reduced-motion')
    expect(
      backdropStartStillReason({ reducedMotion: false, hardwareAccelerationDisabled: true })
    ).toBe('hardware-acceleration-off')
    expect(
      backdropStartStillReason({ reducedMotion: false, hardwareAccelerationDisabled: false })
    ).toBeNull()
  })

  it('knows a software GPU by its renderer name', () => {
    expect(isSoftwareRenderer('Google SwiftShader')).toBe(true)
    expect(
      isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)')
    ).toBe(true)
    expect(isSoftwareRenderer('llvmpipe (LLVM 17.0.6, 256 bits)')).toBe(true)
    expect(
      isSoftwareRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)')
    ).toBe(false)
    expect(isSoftwareRenderer('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)')).toBe(false)
    expect(isSoftwareRenderer(null)).toBe(false)
  })

  it('draws at most 30 frames a second on 60 and 120 Hz displays', () => {
    expect(backdropFrameDue(null, 0)).toBe(true)
    expect(backdropFrameDue(0, 16.7)).toBe(false)
    expect(backdropFrameDue(0, 33.3)).toBe(true)
    expect(backdropFrameDue(0, 25)).toBe(false)
    expect(backdropFrameDue(0, 33.4)).toBe(true)
    let last: number | null = null
    let draws = 0
    for (let tick = 0; tick < 120; tick += 1) {
      const now = tick * (1000 / 120)
      if (backdropFrameDue(last, now)) {
        draws += 1
        last = now
      }
    }
    expect(draws).toBeGreaterThanOrEqual(29)
    expect(draws).toBeLessThanOrEqual(31)
  })

  it('sizes the canvas in device pixels with the long side capped', () => {
    expect(backdropCanvasSize(800, 600, 1)).toEqual({ width: 800, height: 600 })
    expect(backdropCanvasSize(1440, 900, 2)).toEqual({
      width: BACKDROP_MAX_CANVAS_SIDE,
      height: 1200
    })
    expect(backdropCanvasSize(600, 1600, 2)).toEqual({ width: 720, height: 1920 })
    expect(backdropCanvasSize(0, 600, 2)).toBeNull()
    expect(backdropCanvasSize(800, 600, Number.NaN)).toEqual({ width: 800, height: 600 })
  })

  it('keeps full size while frames keep their pace', () => {
    const guard = feed(createBackdropGuard(), 33.3, 0, BACKDROP_GUARD_WINDOW_MS * 3)
    expect(guard.level).toBe('full')
  })

  it('drops to half, then to the poster, and never climbs back', () => {
    let guard = feed(createBackdropGuard(), 80, 0, BACKDROP_GUARD_WINDOW_MS + 80)
    expect(guard.level).toBe('half')
    guard = feed(guard, 33.3, BACKDROP_GUARD_WINDOW_MS + 200, BACKDROP_GUARD_WINDOW_MS * 3)
    expect(guard.level).toBe('half')
    guard = feed(guard, 80, BACKDROP_GUARD_WINDOW_MS * 3 + 80, BACKDROP_GUARD_WINDOW_MS * 5)
    expect(guard.level).toBe('still')
    expect(recordBackdropFrame(guard, 10, BACKDROP_GUARD_WINDOW_MS * 9)).toBe(guard)
  })

  it('judges the median, so one long frame is not a slow GPU', () => {
    let guard = createBackdropGuard()
    guard = recordBackdropFrame(guard, 900, 0)
    guard = feed(guard, 33.3, 33.3, BACKDROP_GUARD_WINDOW_MS + 40)
    expect(guard.level).toBe('full')
  })

  it('gives each player a canvas of its own and takes it away again', async () => {
    // A disposed player loses its context. A second player on the same canvas
    // (StrictMode's second effect run, a look change) got that lost context
    // and every shader failed to compile.
    const host = document.createElement('div')
    const options = { host, look: 'mercury' as const, dim: 0, onFirstFrame: vi.fn() }
    const first = startBackdropPlayer({ ...options, onStill: vi.fn() })
    const firstCanvas = host.querySelector('canvas')
    expect(firstCanvas).not.toBeNull()
    first.dispose()
    expect(host.querySelector('canvas')).toBeNull()

    const onStill = vi.fn()
    startBackdropPlayer({ ...options, onStill })
    const secondCanvas = host.querySelector('canvas')
    expect(secondCanvas).not.toBeNull()
    expect(secondCanvas).not.toBe(firstCanvas)
    // No WebGL here: the poster stays, and the canvas goes with the player.
    await vi.waitFor(() => expect(onStill).toHaveBeenCalledOnce())
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('forgets the window after a pause or a resize', () => {
    let guard = feed(createBackdropGuard(), 80, 0, BACKDROP_GUARD_WINDOW_MS - 100)
    expect(guard.intervals.length).toBeGreaterThan(0)
    guard = resetBackdropGuardWindow(guard)
    expect(guard).toEqual({ level: 'full', windowStartMs: null, intervals: [] })
  })
})
