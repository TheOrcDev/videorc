import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const providerState = vi.hoisted(() => ({ microphoneMuted: false }))

vi.mock('@/hooks/use-document-visible', () => ({ useDocumentVisible: () => true }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    captureConfig: { audio: { microphoneMuted: providerState.microphoneMuted } },
    mediaAccess: { microphone: 'granted' },
    selectedMicrophone: { id: 'backend-mic-1', name: 'Studio microphone' }
  })
}))

import {
  StudioMicVisualProvider,
  useStudioMicVisualLifecycle,
  useStudioMicVisualPainter
} from './use-studio-mic-visual'

function VisualConsumer({ onLifecycle }: { onLifecycle: (active: boolean) => void }): null {
  useStudioMicVisualPainter(() => undefined)
  onLifecycle(useStudioMicVisualLifecycle().active)
  return null
}

function LifecycleObserver(): null {
  useStudioMicVisualLifecycle()
  return null
}

describe('StudioMicVisualProvider', () => {
  let root: Root | null = null
  let restoreEnvironment: (() => void) | undefined

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    restoreEnvironment?.()
    restoreEnvironment = undefined
    providerState.microphoneMuted = false
  })

  it('tears down visual microphone resources and stops reporting live when muted', async () => {
    const environment = installBrowserAudioEnvironment()
    restoreEnvironment = environment.restore
    const lifecycleStates: boolean[] = []

    await act(async () => {
      root = createRoot(environment.container)
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(StudioMicVisualProvider, {
            enabled: true,
            children: createElement(VisualConsumer, {
              onLifecycle: (active) => lifecycleStates.push(active)
            })
          })
        )
      )
      await import('../lib/browser-mic-visual-pipeline')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(environment.contexts).toHaveLength(1))
    expect(lifecycleStates.at(-1)).toBe(true)
    expect(environment.scheduledFrames.size).toBe(1)

    providerState.microphoneMuted = true
    await act(async () => {
      root?.render(
        createElement(
          StrictMode,
          null,
          createElement(StudioMicVisualProvider, {
            enabled: true,
            children: createElement(VisualConsumer, {
              onLifecycle: (active) => lifecycleStates.push(active)
            })
          })
        )
      )
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(environment.contexts[0].close).toHaveBeenCalledTimes(1))
    expect(environment.stopTrack).toHaveBeenCalledTimes(1)
    expect(environment.scheduledFrames.size).toBe(0)
    expect(lifecycleStates.at(-1)).toBe(false)
  })

  it('releases on the last visual consumer and reacquires from remembered source config', async () => {
    const environment = installBrowserAudioEnvironment()
    restoreEnvironment = environment.restore
    const renderProvider = async (showConsumer: boolean): Promise<void> => {
      await act(async () => {
        root?.render(
          createElement(
            StrictMode,
            null,
            createElement(StudioMicVisualProvider, {
              enabled: true,
              children: showConsumer
                ? createElement(VisualConsumer, { onLifecycle: () => undefined })
                : createElement(LifecycleObserver)
            })
          )
        )
        await import('../lib/browser-mic-visual-pipeline')
        await Promise.resolve()
      })
    }

    root = createRoot(environment.container)
    await renderProvider(true)
    await vi.waitFor(() => expect(environment.contexts).toHaveLength(1))
    expect(environment.getUserMedia).toHaveBeenCalledTimes(1)

    await renderProvider(false)
    await vi.waitFor(() => expect(environment.contexts[0].close).toHaveBeenCalledTimes(1))
    expect(environment.scheduledFrames.size).toBe(0)
    expect(environment.stopTrack).toHaveBeenCalledTimes(1)

    await renderProvider(true)
    await vi.waitFor(() => expect(environment.contexts).toHaveLength(2))
    expect(environment.getUserMedia).toHaveBeenCalledTimes(2)
    expect(environment.scheduledFrames.size).toBe(1)
  })
})

function installBrowserAudioEnvironment(): {
  container: Element
  contexts: Array<{ close: ReturnType<typeof vi.fn> }>
  scheduledFrames: Map<number, FrameRequestCallback>
  getUserMedia: ReturnType<typeof vi.fn>
  stopTrack: ReturnType<typeof vi.fn>
  restore: () => void
} {
  class FakeElement {}
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = []
  const scheduledFrames = new Map<number, FrameRequestCallback>()
  const stopTrack = vi.fn()
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }))
  let nextFrameId = 0
  const eventTarget = new EventTarget()
  const fakeWindow: Record<string, unknown> = {
    HTMLIFrameElement: FakeElement,
    HTMLElement: FakeElement,
    setTimeout,
    clearTimeout,
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      scheduledFrames.set(id, callback)
      return id
    },
    cancelAnimationFrame: (id: number) => void scheduledFrames.delete(id),
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
  class FakeAudioContext {
    sampleRate = 48_000
    close = vi.fn(async () => undefined)

    constructor() {
      contexts.push(this)
    }

    createAnalyser(): {
      fftSize: number
      frequencyBinCount: number
      smoothingTimeConstant: number
      getFloatFrequencyData: (samples: Float32Array) => void
      getFloatTimeDomainData: (samples: Float32Array) => void
    } {
      return {
        fftSize: 2048,
        frequencyBinCount: 1024,
        smoothingTimeConstant: 0,
        getFloatFrequencyData: (samples) => samples.fill(-60),
        getFloatTimeDomainData: (samples) => samples.fill(0.2)
      }
    }

    createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
      return { connect: () => {}, disconnect: () => {} }
    }
  }
  const descriptors = new Map(
    ['window', 'document', 'navigator', 'AudioContext', 'IS_REACT_ACT_ENVIRONMENT'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name)
    ])
  )
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Studio microphone' }
        ],
        getUserMedia
      }
    }
  })
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: FakeAudioContext
  })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true
  })

  return {
    container,
    contexts,
    scheduledFrames,
    getUserMedia,
    stopTrack,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  }
}
