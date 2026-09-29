import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

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
    document: { body: { classList: { add() {} }, style: { setProperty() {} } } },
    window: { innerWidth: 1280 },
    pendingCompositorStatus: null,
    pendingCompositorReceivedAt: 0,
    compositorStatus: null,
    presentedCompositorFrame: 0,
    skippedCompositorFrames: 0,
    proofMeasurementEpoch: {},
    recordNativePreviewProofMeasurementLatency() {}
  })
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
    expect(label).toBe('native compositor: screen + camera')
    for (let frame = 0; frame < 3; frame++) {
      expect(runtime.sourceFrame()).toBe(label)
      expect(runtime.compositor()).toBe(label)
    }
  })

  it('shows source liveness before the compositor starts and after it stops', () => {
    const runtime = proofRuntime()
    expect(runtime.sourceFrame()).toBe('native scene + screen image')
    runtime.compositor()
    expect(runtime.compositor('stopped')).toBe('native scene + screen image')
  })

  it('reports waiting or synthetic content after the compositor stops without live pixels', () => {
    const runtime = proofRuntime()
    runtime.compositor()
    runtime.context.layers.clear()
    expect(runtime.compositor('stopped')).toBe('native scene waiting for source')
    runtime.context.scene = { sources: [] }
    expect(runtime.compositor('stopped')).toBe('native synthetic surface')
  })
})
