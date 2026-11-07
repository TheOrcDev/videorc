// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  welcomeBackdropPictureFilter,
  type BackdropGuard
} from './live-background-player'

// Plan 203 S4: the Liquid Chrome backdrop behind first-run setup.

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function playerFixture() {
  const shared = (
    globalThis as unknown as {
      VideorcLiveBackground: {
        create: (...args: unknown[]) => unknown
        internalSize: (render: unknown, id: string, size: number[], level: string) => number[]
      }
    }
  ).VideorcLiveBackground
  const draw = vi.fn()
  const dispose = vi.fn()
  const create = vi.spyOn(shared, 'create').mockReturnValue({ draw, dispose })
  const gl = { getExtension: () => null, getParameter: () => 'Intel' }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    gl as unknown as WebGL2RenderingContext
  )
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('devicePixelRatio', 2)
  vi.spyOn(performance, 'now').mockReturnValue(0)
  const host = document.createElement('div')
  const onFirstFrame = vi.fn()
  const onStill = vi.fn()
  const player = startBackdropPlayer({ host, look: 'polished', dim: 0, onFirstFrame, onStill })
  const canvas = host.querySelector('canvas')!
  const cssWidth = vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(960)
  vi.spyOn(canvas, 'clientHeight', 'get').mockReturnValue(821)
  const render = create.mock.calls[0][1]
  return {
    canvas,
    cssWidth,
    draw,
    dispose,
    player,
    onFirstFrame,
    onStill,
    shaderSize: (size: number[], level: string) =>
      shared.internalSize(render, WELCOME_BACKDROP.id, size, level),
    tick(now: number) {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(now)
    }
  }
}

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

  it('dims the shader only under dark, more with more contrast, never past the shader clamp', () => {
    const dark = welcomeBackdropDim({ dark: true, moreContrast: false })
    expect(dark).toMatchObject({ tone: 'normal', brightness: 1 })
    expect(dark.shader).toBeCloseTo(0.3)
    const darkMore = welcomeBackdropDim({ dark: true, moreContrast: true })
    expect(darkMore).toMatchObject({ tone: 'normal', brightness: 1 })
    expect(darkMore.shader).toBeCloseTo(0.5)
    // Under dark nothing is inverted and nothing is filtered after the shader.
    expect(welcomeBackdropPictureFilter(dark)).toBeUndefined()
    expect(welcomeBackdropPictureFilter(darkMore)).toBeUndefined()
  })

  it('turns light around with no shader Dim, toned after the invert (plan 208 D3)', () => {
    // The shader's Dim darkens before the invert and would wash the chrome
    // out after it, so light's tone is a CSS brightness after the invert.
    const light = welcomeBackdropDim({ dark: false, moreContrast: false })
    expect(light).toEqual({ tone: 'inverse', shader: 0, brightness: 1 })
    // The owner's crisp invert: nothing after it.
    expect(welcomeBackdropPictureFilter(light)).toBe('invert(1)')
    // More contrast takes the white chrome down so the porcelain card separates.
    const lightMore = welcomeBackdropDim({ dark: false, moreContrast: true })
    expect(lightMore).toEqual({ tone: 'inverse', shader: 0, brightness: 0.85 })
    expect(welcomeBackdropPictureFilter(lightMore)).toBe('invert(1) brightness(0.85)')
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

  it('presents the existing shader resolution directly and halves it only once', () => {
    const f = playerFixture()
    try {
      f.tick(0)
      const full = f.shaderSize([1920, 1642], 'full')
      expect(full).toEqual([1263, 1080])
      expect([f.canvas.width, f.canvas.height]).toEqual(full)
      expect(f.draw).toHaveBeenLastCalledWith(
        expect.objectContaining({
          width: full[0],
          height: full[1],
          level: 'full'
        })
      )
      for (let now = 80; now <= 3360; now += 80) f.tick(now)
      const half = f.shaderSize([1920, 1642], 'half')
      expect(half).toEqual([631, 540])
      expect([f.canvas.width, f.canvas.height]).toEqual(half)
      const last = f.draw.mock.calls.at(-1)![0]
      expect(f.shaderSize([last.width, last.height], last.level)).toEqual(half)
      expect(f.onFirstFrame).toHaveBeenCalledOnce()
      expect(f.onStill).not.toHaveBeenCalled()
      // A small backing buffer must not reset the guard every frame.
      for (let now = 3440; now <= 6800; now += 80) f.tick(now)
      expect(f.onStill).toHaveBeenCalledExactlyOnceWith('gpu-budget', undefined)
      expect(f.dispose).toHaveBeenCalledOnce()
      expect(f.canvas.parentElement).toBeNull()
    } finally {
      f.player.dispose()
    }
  })

  it('keeps the phase and half-size choice across resize and pause', () => {
    const f = playerFixture()
    try {
      for (let now = 0; now <= 3360; now += 80) f.tick(now)
      const phaseBefore = f.draw.mock.calls.at(-1)![0].phase
      f.cssWidth.mockReturnValue(800)
      f.tick(3440)
      const resized = f.shaderSize([1600, 1642], 'half')
      expect([f.canvas.width, f.canvas.height]).toEqual(resized)
      expect(f.draw.mock.calls.at(-1)![0].phase).toBeGreaterThan(phaseBefore)
      vi.mocked(performance.now).mockReturnValue(3440)
      f.player.setRunning(false)
      const count = f.draw.mock.calls.length
      f.tick(20_000)
      expect(f.draw).toHaveBeenCalledTimes(count)
      vi.mocked(performance.now).mockReturnValue(20_000)
      f.player.setRunning(true)
      f.tick(20_000)
      expect(f.draw.mock.calls.at(-1)![0].phase).toBeCloseTo(f.draw.mock.calls.at(-2)![0].phase)
      expect([f.canvas.width, f.canvas.height]).toEqual(resized)
      expect(f.onStill).not.toHaveBeenCalled()
    } finally {
      f.player.dispose()
    }
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
