import { StrictMode, act, createElement, useRef, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MicVisualPipelineProvider, useStudioMicVisualPeakDb } from './use-studio-mic-visual'
import { useAudioMixerFramePainter } from '../components/studio/audio-mixer'
import { useMicPickerFramePainter } from '../components/studio/mic-picker-preview'
import { useSessionMicFramePainter } from '../components/studio/session-mic-sliver'
import type { LiveWaveformHandle } from '../components/ui/live-waveform'
import { createMicVisualPipeline, type MicVisualAudioContextLike } from '../lib/mic-visual-pipeline'

type TestStream = { getTracks: () => Array<{ stop: () => void }> }

function AudioMixerPainterProbe({
  element,
  onRender
}: {
  element: HTMLDivElement
  onRender: () => void
}): null {
  onRender()
  const elementRef = useRef<HTMLDivElement>(element)
  useAudioMixerFramePainter(elementRef)
  return null
}

function SessionMicPainterProbe({
  element,
  onRender
}: {
  element: HTMLDivElement
  onRender: () => void
}): null {
  onRender()
  const elementRef = useRef<HTMLDivElement>(element)
  useSessionMicFramePainter(elementRef)
  return null
}

function MicPickerPainterProbe({
  onPaint,
  onRender
}: {
  onPaint: () => void
  onRender: () => void
}): null {
  onRender()
  const waveformRef = useRef<LiveWaveformHandle>({ paint: onPaint })
  useMicPickerFramePainter(waveformRef)
  return null
}

function PeakLabelProbe({ onRender }: { onRender: () => void }): null {
  onRender()
  useStudioMicVisualPeakDb()
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
    let peakLabelRenderCount = 0
    const probes: ReactElement[] = [
      createElement(AudioMixerPainterProbe, {
        key: 'mixer',
        element: testDom.createBarVisualizer(28, () => {
          paintCounts[0] += 1
        }),
        onRender: () => {
          renderCounts[0] += 1
        }
      }),
      createElement(SessionMicPainterProbe, {
        key: 'sliver',
        element: testDom.createBarVisualizer(5, () => {
          paintCounts[1] += 1
        }),
        onRender: () => {
          renderCounts[1] += 1
        }
      }),
      createElement(MicPickerPainterProbe, {
        key: 'picker',
        onPaint: () => {
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
            [
              ...probes,
              createElement(PeakLabelProbe, {
                key: 'peak-label',
                onRender: () => {
                  peakLabelRenderCount += 1
                }
              })
            ]
          )
        )
      )
    })
    microtasks.splice(0).forEach((callback) => callback())
    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(scheduledFrames.size).toBe(1)
    const rendersAfterMount = [...renderCounts]
    const peakRendersAfterMount = peakLabelRenderCount

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
    // The dB/clip label may commit the first peak, but never once per frame.
    expect(peakLabelRenderCount - peakRendersAfterMount).toBeLessThanOrEqual(2)
    expect(contexts).toHaveLength(1)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(scheduledFrames.size).toBe(1)
  })
})

function installRenderEnvironment(): {
  container: Element
  createBarVisualizer: (barCount: number, onPaint: () => void) => HTMLDivElement
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
  const createBarVisualizer = (barCount: number, onPaint: () => void): HTMLDivElement => {
    const bars = Array.from({ length: barCount }, () => {
      const bar = new FakeElement()
      let height = ''
      Object.defineProperty(bar.style, 'height', {
        configurable: true,
        get: () => height,
        set: (value: string) => {
          height = value
          onPaint()
        }
      })
      return bar
    })
    const visualizer = new FakeElement()
    visualizer.children = {
      length: bars.length,
      item: (index) => bars[index] ?? null
    }
    return visualizer as unknown as HTMLDivElement
  }
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
    createBarVisualizer,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  }
}
