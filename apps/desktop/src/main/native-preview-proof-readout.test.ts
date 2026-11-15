import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { PROOF_SURFACE_CONTENT_RUNTIME_SCRIPT } from './proof-surface-content'

// Execute the callbacks embedded in the real proof document, without starting
// Electron. The regression is their interaction, not either label in isolation.
const documentSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function callbackSource(start: string, end: string): string {
  const from = documentSource.indexOf(start)
  const to = documentSource.indexOf(end, from)
  if (from < 0 || to < from) throw new Error(`Missing proof callback: ${start}`)
  return documentSource.slice(from, to)
}

function proofRuntime() {
  const context = createContext({
    sourceFrames: new Map(),
    pollers: new Map(),
    layers: new Map([
      ['screen', { image: { dataset: { live: '1' } }, layer: { kind: 'screen-image' } }]
    ]),
    scene: { sources: [{ id: 'screen', kind: 'screen-image' }] },
    liveLayerCount: 1,
    readout: { textContent: '' },
    document: { body: { classList: { add() {} }, dataset: {}, style: { setProperty() {} } } },
    console: { info() {} },
    liveBackgrounds: new Map(),
    window: { innerWidth: 1280 },
    pendingCompositorStatus: null,
    pendingCompositorReceivedAt: 0,
    compositorStatus: null,
    presentedCompositorFrame: 0,
    skippedCompositorFrames: 0,
    proofMeasurementEpoch: {},
    recordNativePreviewProofMeasurementLatency() {}
  })
  runInContext(PROOF_SURFACE_CONTENT_RUNTIME_SCRIPT, context)
  // Load the shared renderer when present, so the test fails on the old
  // competing-writer implementation as well as exercising its replacement.
  const start = documentSource.includes('function updateProofReadout(')
    ? 'function updateProofReadout('
    : 'function markLive('
  runInContext(callbackSource(start, 'function stopMissingPollers('), context)
  runInContext(
    callbackSource(
      'function presentLatestCompositorStatus(',
      'window.__videorcSetCompositorStatus'
    ),
    context
  )
  return {
    context,
    sourceFrame() {
      runInContext("markLive('screen-image', 'screen')", context)
      return context.readout.textContent
    },
    compositor(state = 'live') {
      context.pendingCompositorStatus = {
        state,
        framesRendered: 1,
        width: 1280,
        sources: [
          { state: 'live', kind: 'screen' },
          { state: 'live', kind: 'camera' }
        ]
      }
      runInContext('presentLatestCompositorStatus(0)', context)
      return context.readout.textContent
    }
  }
}

describe('proof preview readout', () => {
  it('keeps one label when live source and compositor callbacks interleave', () => {
    const runtime = proofRuntime()
    const label = runtime.compositor()
    expect(label).toBe('proof compositor: screen + camera')
    for (let frame = 0; frame < 3; frame++) {
      expect(runtime.sourceFrame()).toBe(label)
      expect(runtime.compositor()).toBe(label)
    }
  })

  it('shows source liveness before the compositor starts and after it stops', () => {
    const runtime = proofRuntime()
    expect(runtime.sourceFrame()).toBe('proof scene + screen image')
    runtime.compositor()
    expect(runtime.compositor('stopped')).toBe('proof scene + screen image')
  })

  it('reports waiting or synthetic content after the compositor stops without live pixels', () => {
    const runtime = proofRuntime()
    runtime.compositor()
    runtime.context.layers.clear()
    expect(runtime.compositor('stopped')).toBe('proof scene waiting for source')
    runtime.context.scene = { sources: [] }
    expect(runtime.compositor('stopped')).toBe('proof synthetic surface')
  })

  // Linux plan 0012: Linux and Windows users see this surface as their real
  // preview, so the harness label is hidden unless a smoke or debug run asks.
  it('hides the harness label from users and never calls the proof surface native', () => {
    const readoutCss = documentSource.slice(
      documentSource.indexOf('#readout {'),
      documentSource.indexOf('body.proof-readout #readout')
    )
    expect(readoutCss).toContain('visibility: hidden')
    expect(documentSource).toContain(
      "nativePreviewProofReadoutVisible() ? ' class=\"proof-readout\"' : ''"
    )
    const runtime = proofRuntime()
    for (const label of [
      runtime.compositor(),
      runtime.sourceFrame(),
      runtime.compositor('stopped')
    ]) {
      expect(label).not.toMatch(/native/i)
    }
  })
})

type ContentLayer = {
  layer?: { kind: string }
  image: { dataset: { live?: string; loaded?: string } }
  element: { remove(): void }
  picture?: boolean
}

// Plan 238 S1: the page says when it starts and stops drawing pixels of its
// own. These run the document's real callbacks around the real content glue;
// only what they call into (pollers, layer DOM, measurement) is stubbed.
function contentRuntime() {
  const layers = new Map<string, ContentLayer>()
  const liveBackgrounds = new Map<string, { canvas: { dataset: { drawn: string } } | null }>()
  const lines: string[] = []
  const bodyClasses = new Set<string>()
  const backdropWrites: string[] = []
  const body = {
    classList: {
      add: (name: string) => bodyClasses.add(name),
      remove: (name: string) => bodyClasses.delete(name)
    },
    dataset: {} as Record<string, string>,
    style: { setProperty: (name: string) => backdropWrites.push(name) }
  }
  const context = createContext({
    sourceFrames: new Map(),
    pollers: new Map(),
    layers,
    liveBackgrounds,
    scene: null,
    liveLayerCount: 0,
    readout: { textContent: '' },
    document: { body },
    console: { info: (line: string) => lines.push(line) },
    window: { innerWidth: 1280 },
    performance: { now: () => 0 },
    pendingCompositorStatus: null,
    pendingCompositorReceivedAt: 0,
    compositorStatus: null,
    presentedCompositorFrame: 0,
    skippedCompositorFrames: 0,
    blankFrames: 0,
    frames: 0,
    framePollingSuppressed: false,
    framePollingMaxWidth: 1920,
    proofSurfaceSuspended: false,
    animationFrameId: null,
    proofMeasurementEpoch: {},
    createNativePreviewProofMeasurementEpoch: () => ({}),
    recordNativePreviewProofMeasurementFrame() {},
    recordNativePreviewProofMeasurementLatency() {},
    cancelAnimationFrame() {},
    scheduleTick() {},
    layoutSceneStage() {},
    orderSceneLayers() {},
    stopMissingPollers() {},
    stopMissingOverlayPollers() {},
    teardownLiveBackground: (id: string) => liveBackgrounds.delete(id),
    setLiveBackgroundsSuspended() {},
    liveBackgroundNow: () => 0,
    drawLiveBackgrounds() {},
    // The real one stops each poller and clears its img; a picture has none.
    stopAllPollers() {
      for (const entry of layers.values()) {
        if (!entry.picture) {
          entry.image.dataset.live = '0'
        }
      }
    },
    upsertLayer(layer: { id: string; kind: string; picture?: boolean }) {
      const id = String(layer.id)
      const entry = layers.get(id) ?? {
        image: { dataset: { live: '0' } },
        element: { remove() {} }
      }
      entry.layer = { kind: layer.kind }
      entry.picture = layer.picture === true
      if (layer.kind === 'banner') {
        entry.image.dataset.loaded = '1'
      }
      layers.set(id, entry)
    }
  })
  runInContext(PROOF_SURFACE_CONTENT_RUNTIME_SCRIPT, context)
  runInContext(
    callbackSource('function updateProofReadout(', 'function stopMissingPollers('),
    context
  )
  runInContext(
    callbackSource('function setFramePollingSuppressed(', 'function setFramePollingProfile('),
    context
  )
  runInContext(callbackSource('function applyScene(', 'window.__videorcSetPreviewScene'), context)
  runInContext(
    callbackSource(
      'function presentLatestCompositorStatus(',
      'window.__videorcSetCompositorStatus'
    ),
    context
  )
  runInContext(
    callbackSource(
      'function setProofSurfaceSuspended(',
      'window.__videorcSetProofSurfaceSuspended'
    ),
    context
  )
  runInContext(callbackSource('function tick(now) {', 'applyScene(scene);'), context)
  return {
    lines,
    body,
    bodyClasses,
    backdropWrites,
    liveBackgrounds,
    scene(sources: { id: string; kind: string; picture?: boolean }[]) {
      runInContext(`applyScene(${JSON.stringify({ revision: 1, sources })})`, context)
    },
    frame(id: string, kind = 'camera') {
      const entry = layers.get(id)
      if (!entry) throw new Error(`No layer ${id}`)
      entry.image.dataset.live = '1'
      runInContext(`markLive(${JSON.stringify(kind)}, ${JSON.stringify(id)})`, context)
    },
    compositor() {
      context.pendingCompositorStatus = { state: 'live', framesRendered: 1, width: 1280 }
      runInContext('presentLatestCompositorStatus(0)', context)
    },
    suppressPolling(suppressed: boolean) {
      runInContext(`setFramePollingSuppressed(${suppressed})`, context)
    },
    suspend(suspended: boolean) {
      runInContext(`setProofSurfaceSuspended(${suspended})`, context)
    },
    tick() {
      runInContext('tick(16)', context)
    }
  }
}

const CAMERA = { id: 'camera', kind: 'camera' }
const SCREEN = { id: 'screen', kind: 'screen' }
const LIVE = '[proof-preview] content live'
const NONE = '[proof-preview] content none'

describe('proof preview content line', () => {
  it('prints nothing while the page waits for its first frame', () => {
    const page = contentRuntime()
    page.scene([])
    page.scene([SCREEN, CAMERA])
    page.tick()
    expect(page.lines).toEqual([])
    expect(page.body.dataset.proofContent).toBeUndefined()
  })

  it('says live once on the first source frame and stays quiet after', () => {
    const page = contentRuntime()
    page.scene([SCREEN, CAMERA])
    page.frame('camera')
    expect(page.lines).toEqual([LIVE])
    page.frame('camera')
    page.frame('screen', 'screen')
    page.scene([SCREEN, CAMERA])
    page.tick()
    expect(page.lines).toEqual([LIVE])
    expect(page.body.dataset.proofContent).toBe('live')
  })

  it('does not take a live compositor for content: its pixels are not this page', () => {
    const page = contentRuntime()
    page.scene([CAMERA])
    page.compositor()
    page.tick()
    // The body class keeps its meaning; only the content line asks for pixels.
    expect(page.bodyClasses.has('surface-live')).toBe(true)
    expect(page.lines).toEqual([])
  })

  it('does not take a banner for content', () => {
    const page = contentRuntime()
    page.scene([{ id: 'banner:1', kind: 'banner' }])
    page.tick()
    expect(page.lines).toEqual([])
  })

  it('says none when a scene drops every live layer, and live again on the next frame', () => {
    const page = contentRuntime()
    page.scene([SCREEN])
    page.frame('screen', 'screen')
    page.scene([CAMERA])
    expect(page.lines).toEqual([LIVE, NONE])
    expect(page.body.dataset.proofContent).toBe('none')
    page.frame('camera')
    expect(page.lines).toEqual([LIVE, NONE, LIVE])
  })

  it('keeps live across a scene change that keeps one live layer', () => {
    const page = contentRuntime()
    page.scene([SCREEN, CAMERA])
    page.frame('screen', 'screen')
    page.scene([SCREEN])
    page.scene([SCREEN, CAMERA])
    expect(page.lines).toEqual([LIVE])
  })

  it('says none when frame polling is suppressed and its imgs are cleared', () => {
    const page = contentRuntime()
    page.scene([CAMERA])
    page.frame('camera')
    page.suppressPolling(true)
    expect(page.lines).toEqual([LIVE, NONE])
    page.suppressPolling(false)
    page.frame('camera')
    expect(page.lines).toEqual([LIVE, NONE, LIVE])
  })

  it('says none when the surface is suspended, with no tick left to say it', () => {
    const page = contentRuntime()
    page.scene([CAMERA])
    page.frame('camera')
    page.suspend(true)
    expect(page.lines).toEqual([LIVE, NONE])
    page.suspend(false)
    expect(page.lines).toEqual([LIVE, NONE])
    page.frame('camera')
    expect(page.lines).toEqual([LIVE, NONE, LIVE])
  })

  it('keeps live through suppression while a picture is still drawn', () => {
    const page = contentRuntime()
    page.scene([{ id: 'background:1', kind: 'background', picture: true }, CAMERA])
    page.frame('background:1', 'background')
    page.frame('camera')
    page.suppressPolling(true)
    page.suspend(true)
    expect(page.lines).toEqual([LIVE])
  })

  it('reads a live background canvas on the tick, drawn or dropped outside a scene update', () => {
    const page = contentRuntime()
    page.scene([{ id: 'background:live-silk', kind: 'background' }])
    const canvas = { dataset: { drawn: '0' } }
    page.liveBackgrounds.set('background:live-silk', { canvas })
    page.tick()
    expect(page.lines).toEqual([])
    canvas.dataset.drawn = '1'
    page.tick()
    page.tick()
    expect(page.lines).toEqual([LIVE])
    page.liveBackgrounds.set('background:live-silk', { canvas: null })
    page.tick()
    expect(page.lines).toEqual([LIVE, NONE])
  })

  it('animates no backdrop: neither the tick nor a compositor frame writes a body style', () => {
    const page = contentRuntime()
    page.scene([CAMERA])
    page.tick()
    page.compositor()
    page.tick()
    expect(page.backdropWrites).toEqual([])
  })
})
