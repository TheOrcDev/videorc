import { StrictMode, act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useFrameSource } from './use-frame-source'
import { useStudioMicMeterSource, useStudioMicVisualSource } from './use-studio-mic-sources'
import { MicVisualPipelineProvider } from './use-studio-mic-visual'
import { createMicVisualPipeline, type MicVisualAudioContextLike } from '../lib/mic-visual-pipeline'

type TestStream = { getTracks: () => Array<{ stop: () => void }> }

/** The Studio mixer's meter, readout and clip light all read this source (plan 092). */
function MixerMeterSourceProbe({
  onFrame,
  onRender
}: {
  onFrame: (peakDb: number) => void
  onRender: () => void
}): null {
  onRender()
  const source = useStudioMicMeterSource({ gainDb: 6, muted: false })
  useFrameSource(source, (frame) => onFrame(frame.channels[0].peakDb))
  return null
}

/** The session sliver and the picker preview both read this source (plan 092). */
function VisualSourceProbe({
  onFrame,
  onRender
}: {
  onFrame: (bandCount: number) => void
  onRender: () => void
}): null {
  onRender()
  const source = useStudioMicVisualSource()
  useFrameSource(source, (frame) => onFrame(frame.bands.length))
  return null
}

describe('Studio visual microphone consumers', () => {
  let root: Root | null = null
  let restoreDom: (() => void) | undefined

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    restoreDom?.()
    restoreDom = undefined
    vi.clearAllMocks()
  })

  it('paints three StrictMode consumers per frame without React render fanout', async () => {
    const testDom = installRenderEnvironment()
    restoreDom = testDom.restore
    const stopped = vi.fn()
    const stream: TestStream = { getTracks: () => [{ stop: stopped }] }
    const getUserMedia = vi.fn(async () => stream)
    const contexts: Array<MicVisualAudioContextLike<TestStream>> = []
    const scheduledFrames = new Map<number, (at: number) => void>()
    const microtasks: Array<() => void> = []
    let nextFrameId = 0
    const pipeline = createMicVisualPipeline<TestStream>({
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Studio microphone' }
        ],
        getUserMedia
      },
      createAudioContext: () => {
        const analyser = {
          fftSize: 2048,
          frequencyBinCount: 1024,
          smoothingTimeConstant: 0,
          getFloatFrequencyData: (samples: Float32Array) => samples.fill(-60),
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.2)
        }
        const context = {
          sampleRate: 48_000,
          createAnalyser: () => analyser,
          createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
          close: vi.fn(async () => undefined)
        }
        contexts.push(context)
        return context
      },
      requestFrame: (callback) => {
        const id = ++nextFrameId
        scheduledFrames.set(id, callback)
        return id
      },
      cancelFrame: (id) => void scheduledFrames.delete(id),
      queueMicrotask: (callback) => microtasks.push(callback)
    })
    const renderCounts = [0, 0, 0]
    const paintCounts = [0, 0, 0]
    const meterPeaks: number[] = []
    const bandCounts: number[] = []
    const probes: ReactElement[] = [
      createElement(MixerMeterSourceProbe, {
        key: 'mixer',
        onFrame: (peakDb) => {
          paintCounts[0] += 1
          meterPeaks.push(peakDb)
        },
        onRender: () => {
          renderCounts[0] += 1
        }
      }),
      createElement(VisualSourceProbe, {
        key: 'sliver',
        onFrame: (bandCount) => {
          paintCounts[1] += 1
          bandCounts.push(bandCount)
        },
        onRender: () => {
          renderCounts[1] += 1
        }
      }),
      createElement(VisualSourceProbe, {
        key: 'picker',
        onFrame: () => {
          paintCounts[2] += 1
        },
        onRender: () => {
          renderCounts[2] += 1
        }
      })
    ]

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            MicVisualPipelineProvider,
            {
              pipeline,
              source: {
                selectionKey: 'backend-mic-1',
                deviceName: 'Studio microphone',
                enabled: true,
                permissionStatus: 'granted'
              }
            },
            probes
          )
        )
      )
    })
    microtasks.splice(0).forEach((callback) => callback())
    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(scheduledFrames.size).toBe(1)
    const rendersAfterMount = [...renderCounts]

    for (let frameIndex = 1; frameIndex <= 8; frameIndex += 1) {
      const next = scheduledFrames.entries().next().value as
        | [number, (at: number) => void]
        | undefined
      expect(next).toBeDefined()
      if (!next) break
      scheduledFrames.delete(next[0])
      await act(async () => next[1](frameIndex * 48))
      expect(scheduledFrames.size).toBe(1)
    }

    expect(renderCounts).toEqual(rendersAfterMount)
    expect(paintCounts.every((count) => count >= 8)).toBe(true)
    // The meter reads what the recording gets: a 0.2 peak (-13.98 dBFS) plus
    // the 6 dB gain.
    expect(meterPeaks.at(-1)).toBeCloseTo(20 * Math.log10(0.2) + 6, 2)
    // Bars and waveforms get the pipeline's 32 bands.
    expect(bandCounts.at(-1)).toBe(32)
    expect(contexts).toHaveLength(1)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(scheduledFrames.size).toBe(1)
  })
})

function installRenderEnvironment(): {
  container: Element
  restore: () => void
} {
  class FakeElement {
    style: Record<string, string> = {}
    children: { length: number; item: (index: number) => FakeElement | null } = {
      length: 0,
      item: () => null
    }
  }
  const eventTarget = new EventTarget()
  const fakeWindow: Record<string, unknown> = {
    HTMLIFrameElement: FakeElement,
    HTMLElement: FakeElement,
    setTimeout,
    clearTimeout,
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    devicePixelRatio: 1
  }
  fakeWindow.window = fakeWindow
  const fakeDocument = {
    nodeType: 9,
    activeElement: null,
    defaultView: fakeWindow,
    documentElement: {},
    body: {},
    hidden: false,
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  const container = {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    ownerDocument: fakeDocument,
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => {},
    insertBefore: () => {},
    removeChild: () => {}
  } as unknown as Element
  const descriptors = new Map(
    ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name)
    ])
  )
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeElement })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true
  })

  return {
    container,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  }
}
