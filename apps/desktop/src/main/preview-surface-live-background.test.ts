// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EffectiveSceneBackground } from '../shared/backend'
import {
  PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX,
  PREVIEW_SURFACE_LIVE_BACKGROUND_RUNTIME_SCRIPT,
  liveBackgroundDim,
  previewSurfaceBackgroundLayer,
  previewSurfaceLiveBackground,
  previewSurfaceLiveBackgroundLibraryScript,
  previewSurfaceLiveBackgroundLogLine,
  previewSurfaceLiveBackgroundStatusFrom,
  previewSurfaceLiveBackgroundStatusFromConsoleLine
} from './preview-surface-live-background'

const here = dirname(fileURLToPath(import.meta.url))
const toUrl = (path: string): string => `file://${path}`

function picture(overrides: Partial<EffectiveSceneBackground> = {}): EffectiveSceneBackground {
  return {
    assetId: 'builtin-bg-01',
    managedAssetPath: '/managed/builtin-bg-01.webp',
    fit: 'fill',
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    blurPx: 0,
    dimPercent: 0,
    saturationPercent: 100,
    vignettePercent: 0,
    visibilityPercent: 20,
    ...overrides
  }
}

function live(
  id: 'silk' | 'side-rays' | 'plasma-wave' | 'liquid-chrome' | 'line-waves',
  look: string,
  motion: 'calm' | 'normal',
  overrides: Partial<EffectiveSceneBackground> = {}
): EffectiveSceneBackground {
  return picture({
    assetId: `live-${id}-${look}`,
    managedAssetPath: `/bundled/live-${id}-${look}.webp`,
    live: { id, look, motion },
    ...overrides
  })
}

describe('proof surface background layer (plan 190 S6)', () => {
  it('builds a picture layer without a live field', () => {
    const layer = previewSurfaceBackgroundLayer(picture(), toUrl)
    expect(layer).toStrictEqual({
      id: 'background:builtin-bg-01',
      name: 'Scene background',
      kind: 'background',
      transform: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        cropLeft: 0,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0
      },
      visible: true,
      imageUrl: 'file:///managed/builtin-bg-01.webp',
      fit: 'cover',
      mirror: false
    })
    expect(layer).not.toHaveProperty('live')
    expect(previewSurfaceBackgroundLayer(undefined, toUrl)).toBeNull()
    expect(previewSurfaceBackgroundLayer(picture({ managedAssetPath: '  ' }), toUrl)).toBeNull()
  })

  it('keeps the poster and adds the spec, rate and poster phase from the render JSON', () => {
    const layer = previewSurfaceBackgroundLayer(
      live('silk', 'satin', 'calm', { dimPercent: 35 }),
      toUrl
    )
    expect(layer?.imageUrl).toBe('file:///bundled/live-silk-satin.webp')
    expect(layer?.kind).toBe('background')
    expect(layer?.live).toStrictEqual({
      id: 'silk',
      look: 'satin',
      motion: 'calm',
      dim: 0.35,
      rate: 0.5,
      posterPhase: 3
    })
  })

  it('names a live layer after its background, so a look change keeps the layer', () => {
    const satin = previewSurfaceBackgroundLayer(live('silk', 'satin', 'calm'), toUrl)
    const midnight = previewSurfaceBackgroundLayer(live('silk', 'midnight', 'normal'), toUrl)
    expect(satin?.id).toBe('background:live-silk')
    expect(midnight?.id).toBe(satin?.id)
    expect(midnight?.live).toMatchObject({
      look: 'midnight',
      motion: 'normal',
      rate: expect.closeTo(0.35, 9)
    })
    const plasma = previewSurfaceBackgroundLayer(live('plasma-wave', 'ember', 'calm'), toUrl)
    expect(plasma?.id).toBe('background:live-plasma-wave')
    expect(plasma?.live).toMatchObject({ rate: 1, posterPhase: 6 })
  })

  it('resolves an unknown look to the first look and clamps Dim to the shader range', () => {
    const unknown = previewSurfaceLiveBackground(
      live('side-rays', 'nope', 'calm', { dimPercent: 95 })
    )
    expect(unknown).toStrictEqual({
      id: 'side-rays',
      look: 'sunbeam',
      motion: 'calm',
      dim: 0.8,
      rate: 2.5,
      posterPhase: 15
    })
    expect(liveBackgroundDim(-10)).toBe(0)
    expect(liveBackgroundDim(Number.NaN)).toBe(0)
    expect(liveBackgroundDim(50)).toBe(0.5)
    expect(
      previewSurfaceLiveBackground(
        picture({ live: { id: 'nebula' as 'silk', look: 'x', motion: 'calm' } })
      )
    ).toBeUndefined()
  })
})

describe('proof surface live background status', () => {
  it('accepts the surface shape and drops anything else', () => {
    expect(
      previewSurfaceLiveBackgroundStatusFrom({
        id: 'silk',
        look: 'satin',
        rendering: 'still',
        reason: 'software-gpu',
        detail: 'x'.repeat(400),
        renderer: 'SwiftShader',
        frames: 0
      })
    ).toStrictEqual({
      id: 'silk',
      look: 'satin',
      rendering: 'still',
      reason: 'software-gpu',
      detail: 'x'.repeat(300),
      renderer: 'SwiftShader'
    })
    expect(
      previewSurfaceLiveBackgroundStatusFrom({
        id: 'silk',
        look: 'satin',
        rendering: 'shader',
        reason: 'made-up'
      })
    ).toStrictEqual({ id: 'silk', look: 'satin', rendering: 'shader' })
    expect(previewSurfaceLiveBackgroundStatusFrom(null)).toBeUndefined()
    expect(
      previewSurfaceLiveBackgroundStatusFrom({ id: 'nebula', look: 'a', rendering: 'shader' })
    ).toBeUndefined()
    expect(
      previewSurfaceLiveBackgroundStatusFrom({ id: 'silk', look: 'satin', rendering: 'half' })
    ).toBeUndefined()
  })

  it('reads the console line the surface prints, including the clearing null', () => {
    const line = `${PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX}{"id":"line-waves","look":"gold","rendering":"shader","renderer":"ANGLE"}`
    expect(previewSurfaceLiveBackgroundStatusFromConsoleLine(line)).toStrictEqual({
      status: { id: 'line-waves', look: 'gold', rendering: 'shader', renderer: 'ANGLE' }
    })
    expect(
      previewSurfaceLiveBackgroundStatusFromConsoleLine(
        `${PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX}null`
      )
    ).toStrictEqual({ status: undefined })
    expect(
      previewSurfaceLiveBackgroundStatusFromConsoleLine(
        `${PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX}{nope`
      )
    ).toStrictEqual({ status: undefined })
    expect(
      previewSurfaceLiveBackgroundStatusFromConsoleLine('Preview frame request failed')
    ).toBeNull()
  })

  it('logs a still as a warning with its reason, and a moving one once as info', () => {
    expect(
      previewSurfaceLiveBackgroundLogLine({
        id: 'silk',
        look: 'satin',
        rendering: 'still',
        reason: 'no-gpu',
        detail: 'WebGL context lost'
      })
    ).toStrictEqual({
      level: 'warn',
      message:
        '[proof-preview] live background silk (satin) shows its poster, reason no-gpu: WebGL context lost'
    })
    expect(
      previewSurfaceLiveBackgroundLogLine({
        id: 'silk',
        look: 'satin',
        rendering: 'shader',
        renderer: 'Metal'
      })
    ).toStrictEqual({
      level: 'info',
      message: '[proof-preview] live background silk (satin) is moving on Metal'
    })
    expect(
      previewSurfaceLiveBackgroundLogLine({ id: 'silk', look: 'satin', rendering: 'starting' })
    ).toBeNull()
    expect(previewSurfaceLiveBackgroundLogLine(undefined)).toBeNull()
  })
})

type Sandbox = {
  VideorcLiveBackground?: unknown
  VideorcLiveBackgroundClock?: unknown
}

function evaluateLibrary(): { sandbox: Sandbox; renderJson: string } {
  const sandbox: Sandbox = {}
  const renderJson = new Function(
    'globalThis',
    `${previewSurfaceLiveBackgroundLibraryScript()}\nreturn VIDEORC_LIVE_BACKGROUND_RENDER_JSON;`
  )(sandbox) as string
  return { sandbox, renderJson }
}

describe('proof surface live background library script', () => {
  it('inlines the runner, the clock and the render JSON as a string, safely for a script element', () => {
    const script = previewSurfaceLiveBackgroundLibraryScript()
    expect(script).not.toContain('</script')
    expect(script).not.toContain('<!--')
    expect(script).toContain('React Bits by David Haz')
    const { sandbox, renderJson } = evaluateLibrary()
    expect(typeof (sandbox.VideorcLiveBackground as { create?: unknown })?.create).toBe('function')
    expect(typeof (sandbox.VideorcLiveBackgroundClock as { start?: unknown })?.start).toBe(
      'function'
    )
    const render = JSON.parse(renderJson) as { backgrounds: { id: string }[] }
    expect(render.backgrounds.map((background) => background.id)).toStrictEqual([
      'silk',
      'side-rays',
      'plasma-wave',
      'liquid-chrome',
      'line-waves'
    ])
    expect(renderJson).toBe(
      readFileSync(join(here, '../shared/live-backgrounds.render.generated.json'), 'utf8')
    )
  })
})

// --- The glue, run against a real DOM (happy-dom) -----------------------------

type FakeGl = {
  getExtension: ReturnType<typeof vi.fn>
  getParameter: ReturnType<typeof vi.fn>
  RENDERER: number
  lose: ReturnType<typeof vi.fn>
}

function fakeGl(renderer = 'ANGLE (Fake GPU)'): FakeGl {
  const lose = vi.fn()
  return {
    RENDERER: 0x1f01,
    lose,
    getExtension: vi.fn((name: string) => {
      if (name === 'WEBGL_lose_context') return { loseContext: lose }
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246 }
      return null
    }),
    getParameter: vi.fn(() => renderer)
  }
}

type Glue = {
  syncLiveBackgroundLayer: (id: string, entry: Entry, spec: unknown, now: number) => void
  teardownLiveBackground: (id: string) => void
  drawLiveBackgrounds: (now: number, maxWidth: number) => void
  setLiveBackgroundsSuspended: (suspended: boolean, now: number) => void
  liveBackgroundMetrics: () => Record<string, unknown> | null
}

type Entry = { element: HTMLElement; image: HTMLImageElement }

type Harness = {
  glue: Glue
  entry: Entry
  root: HTMLElement
  getContext: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  draw: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  timers: Array<() => void>
  clock: { nowMs: number }
  statuses: () => unknown[]
  canvases: () => HTMLCanvasElement[]
}

const SILK_CALM = { id: 'silk', look: 'satin', motion: 'calm', dim: 0.2, rate: 0.5, posterPhase: 3 }
const SILK_MIDNIGHT_NORMAL = { ...SILK_CALM, look: 'midnight', motion: 'normal', rate: 0.35 }
const PLASMA_CALM = {
  id: 'plasma-wave',
  look: 'ember',
  motion: 'calm',
  dim: 0,
  rate: 1,
  posterPhase: 6
}

function harness(
  options: { context?: (attributes: Record<string, unknown>) => FakeGl | null } = {}
): Harness {
  document.body.innerHTML = '<div id="scene-root"></div>'
  delete document.body.dataset.liveBackground
  const root = document.getElementById('scene-root') as HTMLElement
  const element = document.createElement('div')
  element.className = 'scene-layer'
  const image = document.createElement('img')
  element.appendChild(image)
  root.appendChild(element)
  Object.defineProperty(element, 'clientWidth', { value: 1280, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: 720, configurable: true })

  const defaultGl = fakeGl()
  const context = options.context ?? (() => defaultGl)
  const getContext = vi.fn((kind: string, attributes: Record<string, unknown>) =>
    kind === 'webgl2' ? context(attributes) : null
  )
  HTMLCanvasElement.prototype.getContext =
    getContext as unknown as typeof HTMLCanvasElement.prototype.getContext

  const draw = vi.fn()
  const dispose = vi.fn()
  const create = vi.fn(() => ({ draw, dispose }))
  const info = vi.fn()
  const timers: Array<() => void> = []
  const clock = { nowMs: 0 }
  const { sandbox, renderJson } = evaluateLibrary()

  const glue = new Function(
    'document',
    'window',
    'performance',
    'console',
    'setTimeout',
    'clearTimeout',
    'VideorcLiveBackground',
    'VideorcLiveBackgroundClock',
    'VIDEORC_LIVE_BACKGROUND_RENDER_JSON',
    `${PREVIEW_SURFACE_LIVE_BACKGROUND_RUNTIME_SCRIPT}\nreturn {
      syncLiveBackgroundLayer,
      teardownLiveBackground,
      drawLiveBackgrounds,
      setLiveBackgroundsSuspended,
      liveBackgroundMetrics
    };`
  )(
    document,
    window,
    { now: () => clock.nowMs },
    { info },
    (callback: () => void) => {
      timers.push(callback)
      return timers.length
    },
    (handle: number) => {
      timers[handle - 1] = () => {}
    },
    { create },
    sandbox.VideorcLiveBackgroundClock,
    renderJson
  ) as Glue

  return {
    glue,
    entry: { element, image },
    root,
    getContext,
    create,
    draw,
    dispose,
    info,
    timers,
    clock,
    statuses: () =>
      info.mock.calls.map(([line]) =>
        JSON.parse(String(line).slice(PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX.length))
      ),
    canvases: () => Array.from(document.querySelectorAll('canvas'))
  }
}

describe('proof surface live background glue (DOM)', () => {
  let hidden = false
  const originalGetContext = HTMLCanvasElement.prototype.getContext

  beforeEach(() => {
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    window.devicePixelRatio = 1
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  })

  it('creates nothing for a picture background: no canvas, no context, no listener, no status', () => {
    const h = harness()
    const addListener = vi.spyOn(document, 'addEventListener')
    h.glue.syncLiveBackgroundLayer('background:builtin-bg-01', h.entry, undefined, 0)
    h.glue.drawLiveBackgrounds(16, 1920)
    h.glue.setLiveBackgroundsSuspended(true, 1)
    h.glue.setLiveBackgroundsSuspended(false, 2)
    expect(h.canvases()).toHaveLength(0)
    expect(h.getContext).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
    expect(addListener).not.toHaveBeenCalled()
    expect(h.info).not.toHaveBeenCalled()
    expect(h.glue.liveBackgroundMetrics()).toBeNull()
    expect(document.body.dataset.liveBackground).toBeUndefined()
    expect(h.entry.element.querySelector('img')).toBe(h.entry.image)
  })

  it('draws a live background over its poster, starting on the poster frame', () => {
    const h = harness()
    window.devicePixelRatio = 2
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 0)
    expect(h.getContext).toHaveBeenCalledTimes(1)
    expect(h.getContext.mock.calls[0]).toStrictEqual([
      'webgl2',
      {
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'default',
        failIfMajorPerformanceCaveat: true
      }
    ])
    const [canvas] = h.canvases()
    expect(h.canvases()).toHaveLength(1)
    expect(canvas.parentElement).toBe(h.entry.element)
    expect(canvas.previousElementSibling).toBe(h.entry.image)
    expect(canvas.className).toBe('live-background')
    expect(canvas.dataset.drawn).toBe('0')
    expect(h.create).toHaveBeenCalledTimes(1)
    expect((h.create.mock.calls[0] as unknown[])[1]).toMatchObject({ softMaxShortSide: 1080 })
    expect(h.statuses()).toStrictEqual([
      { id: 'silk', look: 'satin', rendering: 'starting', renderer: 'ANGLE (Fake GPU)' }
    ])
    expect(document.body.dataset.liveBackground).toBe('starting')

    h.glue.drawLiveBackgrounds(0, 1920)
    expect(h.draw).toHaveBeenCalledTimes(1)
    // 1280 x 720 at DPR 2 is 2560 wide: capped to the surface's 1920 frame width.
    expect(h.draw.mock.calls[0][0]).toStrictEqual({
      id: 'silk',
      look: 'satin',
      phase: 3,
      dim: 0.2,
      width: 1920,
      height: 1080,
      level: 'full'
    })
    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
    expect(canvas.dataset.drawn).toBe('1')
    expect(h.statuses().at(-1)).toStrictEqual({
      id: 'silk',
      look: 'satin',
      rendering: 'shader',
      renderer: 'ANGLE (Fake GPU)'
    })
    expect(document.body.dataset.liveBackground).toBe('shader')
    expect(h.glue.liveBackgroundMetrics()).toMatchObject({
      id: 'silk',
      rendering: 'shader',
      frames: 1,
      canvas: true,
      width: 1920,
      height: 1080
    })
  })

  it('runs Calm at half speed and re-bases a look or motion change without a jump', () => {
    const h = harness()
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 0)
    h.glue.drawLiveBackgrounds(0, 1920)
    h.glue.drawLiveBackgrounds(10_000, 1920)
    expect(h.draw.mock.calls[1][0].phase).toBeCloseTo(5.5, 9)
    // The same layer id with a new look and motion: same canvas, same context.
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_MIDNIGHT_NORMAL, 10)
    expect(h.getContext).toHaveBeenCalledTimes(1)
    expect(h.canvases()).toHaveLength(1)
    h.glue.drawLiveBackgrounds(11_000, 1920)
    expect(h.draw.mock.calls[2][0]).toMatchObject({
      look: 'midnight',
      phase: expect.closeTo(5.85, 9)
    })
    expect(h.statuses().at(-1)).toMatchObject({ look: 'midnight', rendering: 'shader' })
    // A Dim change is only a uniform.
    h.glue.syncLiveBackgroundLayer(
      'background:live-silk',
      h.entry,
      { ...SILK_MIDNIGHT_NORMAL, dim: 0.5 },
      11
    )
    h.glue.drawLiveBackgrounds(12_000, 1920)
    expect(h.draw.mock.calls[3][0]).toMatchObject({ dim: 0.5, phase: expect.closeTo(6.2, 9) })
    // An unchanged scene push costs nothing.
    const statusCount = h.info.mock.calls.length
    h.glue.syncLiveBackgroundLayer(
      'background:live-silk',
      h.entry,
      { ...SILK_MIDNIGHT_NORMAL, dim: 0.5 },
      12
    )
    expect(h.info.mock.calls.length).toBe(statusCount)
  })

  it('tears a live background down when its layer goes, and restarts another at its poster', () => {
    const h = harness()
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 0)
    h.glue.drawLiveBackgrounds(30_000, 1920)
    const firstGl = h.getContext.mock.results[0].value as FakeGl
    const removeListener = vi.spyOn(document, 'removeEventListener')
    // The scene replaced it with a picture: applyScene removes the old layer id.
    h.glue.teardownLiveBackground('background:live-silk')
    expect(h.dispose).toHaveBeenCalledTimes(1)
    expect(firstGl.lose).toHaveBeenCalledTimes(1)
    expect(h.canvases()).toHaveLength(0)
    expect(h.entry.element.querySelector('img')).toBe(h.entry.image)
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(h.info.mock.calls.at(-1)?.[0]).toBe(
      `${PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX}null`
    )
    expect(document.body.dataset.liveBackground).toBe('')
    expect(h.glue.liveBackgroundMetrics()).toBeNull()
    // Nothing left to draw.
    const draws = h.draw.mock.calls.length
    h.glue.drawLiveBackgrounds(31_000, 1920)
    expect(h.draw.mock.calls.length).toBe(draws)

    // A different background on a fresh layer starts again at its poster phase.
    h.glue.syncLiveBackgroundLayer('background:live-plasma-wave', h.entry, PLASMA_CALM, 40)
    expect(h.getContext).toHaveBeenCalledTimes(2)
    h.glue.drawLiveBackgrounds(40_000, 1920)
    expect(h.draw.mock.calls.at(-1)?.[0]).toMatchObject({
      id: 'plasma-wave',
      look: 'ember',
      phase: 6
    })
    expect(h.glue.liveBackgroundMetrics()).toMatchObject({ id: 'plasma-wave', frames: 1 })
  })

  it('keeps the poster and says software-gpu when Chromium would use a software GPU', () => {
    const probe = fakeGl('SwiftShader')
    const h = harness({
      context: (attributes) => (attributes.failIfMajorPerformanceCaveat === true ? null : probe)
    })
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 0)
    expect(h.canvases()).toHaveLength(0)
    expect(h.create).not.toHaveBeenCalled()
    expect(probe.lose).toHaveBeenCalledTimes(1)
    expect(h.statuses()).toStrictEqual([
      { id: 'silk', look: 'satin', rendering: 'still', reason: 'software-gpu' }
    ])
    expect(document.body.dataset.liveBackground).toBe('still:software-gpu')
    expect(h.glue.liveBackgroundMetrics()).toMatchObject({
      rendering: 'still',
      reason: 'software-gpu',
      canvas: false
    })
    // A repeated scene push does not probe again or re-report.
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 1)
    h.glue.drawLiveBackgrounds(1000, 1920)
    expect(h.getContext).toHaveBeenCalledTimes(2)
    expect(h.info).toHaveBeenCalledTimes(1)
    expect(h.draw).not.toHaveBeenCalled()
  })

  it('keeps the poster and says no-gpu when there is no WebGL2 at all', () => {
    const h = harness({ context: () => null })
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 0)
    expect(h.canvases()).toHaveLength(0)
    expect(h.statuses()).toStrictEqual([
      { id: 'silk', look: 'satin', rendering: 'still', reason: 'no-gpu' }
    ])
    expect(document.body.dataset.liveBackground).toBe('still:no-gpu')
  })

  it('keeps the poster and says shader-compile-failed when a draw throws', () => {
    const h = harness()
    h.draw.mockImplementationOnce(() => {
      throw new Error('live background shader failed to compile: ERROR: 0:12')
    })
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 0)
    h.glue.drawLiveBackgrounds(0, 1920)
    const gl = h.getContext.mock.results[0].value as FakeGl
    expect(h.dispose).toHaveBeenCalledTimes(1)
    expect(gl.lose).toHaveBeenCalledTimes(1)
    expect(h.canvases()).toHaveLength(0)
    expect(h.statuses().at(-1)).toStrictEqual({
      id: 'silk',
      look: 'satin',
      rendering: 'still',
      reason: 'shader-compile-failed',
      detail: 'live background shader failed to compile: ERROR: 0:12',
      renderer: 'ANGLE (Fake GPU)'
    })
    expect(document.body.dataset.liveBackground).toBe('still:shader-compile-failed')
    // No second attempt on later frames or scene pushes.
    h.glue.drawLiveBackgrounds(16, 1920)
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 1)
    expect(h.draw).toHaveBeenCalledTimes(1)
    expect(h.getContext).toHaveBeenCalledTimes(1)
  })

  it('holds the clock while the surface is suspended or the document is hidden, and resumes without a jump', () => {
    const h = harness()
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 0)
    h.glue.drawLiveBackgrounds(0, 1920)
    h.glue.setLiveBackgroundsSuspended(true, 5)
    h.glue.drawLiveBackgrounds(10_000, 1920)
    expect(h.draw).toHaveBeenCalledTimes(1)
    h.glue.setLiveBackgroundsSuspended(false, 20)
    h.glue.drawLiveBackgrounds(21_000, 1920)
    // Held at 3 + 0.25 x 5 = 4.25, then one more second at Calm.
    expect(h.draw.mock.calls[1][0].phase).toBeCloseTo(4.5, 9)

    hidden = true
    h.clock.nowMs = 25_000
    document.dispatchEvent(new Event('visibilitychange'))
    h.glue.drawLiveBackgrounds(30_000, 1920)
    expect(h.draw).toHaveBeenCalledTimes(2)
    hidden = false
    h.clock.nowMs = 60_000
    document.dispatchEvent(new Event('visibilitychange'))
    h.glue.drawLiveBackgrounds(61_000, 1920)
    // Held at 4.5 + 0.25 x 4 = 5.5 when hidden at 25 s; one more second after 60 s.
    expect(h.draw.mock.calls[2][0].phase).toBeCloseTo(5.75, 9)
  })

  it('starts while hidden on the poster frame, not ahead of it', () => {
    hidden = true
    const h = harness()
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 100)
    h.glue.drawLiveBackgrounds(100_000, 1920)
    expect(h.draw).not.toHaveBeenCalled()
    hidden = false
    h.clock.nowMs = 140_000
    document.dispatchEvent(new Event('visibilitychange'))
    h.glue.drawLiveBackgrounds(140_000, 1920)
    expect(h.draw.mock.calls[0][0].phase).toBe(3)
  })

  it('drops a lost context, reports it, retries once, then keeps the poster', () => {
    const h = harness()
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 0)
    h.glue.drawLiveBackgrounds(0, 1920)
    const [canvas] = h.canvases()
    canvas.dispatchEvent(new Event('webglcontextlost'))
    expect(h.canvases()).toHaveLength(0)
    expect(h.dispose).toHaveBeenCalledTimes(1)
    expect(h.statuses().at(-1)).toMatchObject({
      rendering: 'still',
      reason: 'no-gpu',
      detail: 'WebGL context lost'
    })
    expect(h.timers).toHaveLength(1)
    h.timers[0]()
    expect(h.getContext).toHaveBeenCalledTimes(2)
    expect(h.canvases()).toHaveLength(1)
    h.glue.drawLiveBackgrounds(3000, 1920)
    expect(h.statuses().at(-1)).toMatchObject({ rendering: 'shader' })
    // Its clock kept running across the loss: no restart at the poster.
    expect(h.draw.mock.calls.at(-1)?.[0].phase).toBeCloseTo(3.75, 9)
    h.canvases()[0].dispatchEvent(new Event('webglcontextlost'))
    expect(h.canvases()).toHaveLength(0)
    expect(h.timers).toHaveLength(1)
    expect(h.statuses().at(-1)).toMatchObject({ rendering: 'still', reason: 'no-gpu' })
  })

  it('ignores a late context-lost event from a canvas it already dropped', () => {
    const h = harness()
    h.glue.syncLiveBackgroundLayer('background:live-silk', h.entry, SILK_CALM, 0)
    const [canvas] = h.canvases()
    h.glue.teardownLiveBackground('background:live-silk')
    const statusCount = h.info.mock.calls.length
    canvas.dispatchEvent(new Event('webglcontextlost'))
    expect(h.info.mock.calls.length).toBe(statusCount)
    expect(h.timers).toHaveLength(0)
  })
})

describe('proof surface document wiring (main/index.ts)', () => {
  const source = readFileSync(join(here, 'index.ts'), 'utf8')
  const document = source.slice(
    source.indexOf('function nativePreviewSurfaceHtml('),
    source.indexOf('// Placement for the Electron proof surface window')
  )

  it('inlines the library under the nonce and the glue inside the surface script', () => {
    expect(document).toContain(
      '<script nonce="${scriptNonce}">${previewSurfaceLiveBackgroundLibraryScript()}</script>'
    )
    expect(document).toContain('${PREVIEW_SURFACE_LIVE_BACKGROUND_RUNTIME_SCRIPT}')
    expect(document).toContain('canvas.live-background')
  })

  it('syncs, draws, holds and tears down from the existing layer and tick paths', () => {
    expect(document).toContain(
      "if (layer.kind === 'background') {\n            syncLiveBackgroundLayer(id, entry, layer.live, liveBackgroundNow());"
    )
    expect(document).toContain('teardownLiveBackground(id);\n              entry.element.remove();')
    expect(document).toContain('drawLiveBackgrounds(now, framePollingMaxWidth);')
    expect(document).toContain(
      'setLiveBackgroundsSuspended(proofSurfaceSuspended, liveBackgroundNow());'
    )
    expect(document).toContain('liveBackground: liveBackgroundMetrics(),')
  })

  it('delegates the background layer to the shared builder', () => {
    expect(source).toContain('previewSurfaceBackgroundLayer(scene?.background, fileUrlFromPath)')
  })
})
