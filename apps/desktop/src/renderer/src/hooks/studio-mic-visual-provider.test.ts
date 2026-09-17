import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const providerState = vi.hoisted(() => ({
  microphoneMuted: false,
  sessionActive: false,
  microphoneId: 'backend-mic-1',
  keepMicrophoneWarm: true as boolean | undefined,
  armWarmMicrophone: vi.fn(async () => null),
  disarmWarmMicrophone: vi.fn(async () => null)
}))

vi.mock('@/hooks/use-document-visible', () => ({ useDocumentVisible: () => true }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    captureConfig: {
      audio: { microphoneMuted: providerState.microphoneMuted, microphoneGainDb: 0 }
    },
    mediaAccess: { microphone: 'granted' },
    selectedMicrophone: { id: providerState.microphoneId, name: 'Studio microphone' },
    isSessionActive: providerState.sessionActive,
    settings: { keepMicrophoneWarm: providerState.keepMicrophoneWarm },
    armWarmMicrophone: providerState.armWarmMicrophone,
    disarmWarmMicrophone: providerState.disarmWarmMicrophone
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
    providerState.sessionActive = false
    providerState.microphoneId = 'backend-mic-1'
    providerState.keepMicrophoneWarm = true
    providerState.armWarmMicrophone.mockClear()
    providerState.disarmWarmMicrophone.mockClear()
  })

  // Instant record (P5): the backend keeps a CoreAudio microphone open under
  // the analyser's visibility discipline; a running session owns it. The
  // assertions are order-based because StrictMode double-invokes mount
  // effects (mount → simulated unmount → mount), which legitimately calls
  // disarm once between two arms.
  describe('warm microphone', () => {
    const lastCall = (spy: { mock: { invocationCallOrder: number[] } }): number =>
      spy.mock.invocationCallOrder.at(-1) ?? -1
    const armedLast = (): boolean =>
      lastCall(providerState.armWarmMicrophone) > lastCall(providerState.disarmWarmMicrophone)
    const renderProvider = async (environment: { container: Element }, enabled: boolean) => {
      await act(async () => {
        root ??= createRoot(environment.container)
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(StudioMicVisualProvider, { enabled, children: null })
          )
        )
        await Promise.resolve()
      })
    }

    it('arms a CoreAudio microphone while Studio is visible and releases it when it leaves', async () => {
      const environment = installBrowserAudioEnvironment()
      restoreEnvironment = environment.restore
      providerState.microphoneId = 'microphone:coreaudio:42'

      await renderProvider(environment, true)
      expect(providerState.armWarmMicrophone).toHaveBeenCalled()
      expect(armedLast()).toBe(true)

      const armCallsBefore = providerState.armWarmMicrophone.mock.calls.length
      await renderProvider(environment, false)
      expect(armedLast()).toBe(false)
      expect(providerState.armWarmMicrophone.mock.calls.length).toBe(armCallsBefore)
    })

    it('leaves a running session alone and re-arms once it ends', async () => {
      const environment = installBrowserAudioEnvironment()
      restoreEnvironment = environment.restore
      providerState.microphoneId = 'microphone:coreaudio:42'

      await renderProvider(environment, true)
      expect(armedLast()).toBe(true)
      const armCalls = providerState.armWarmMicrophone.mock.calls.length
      const disarmCalls = providerState.disarmWarmMicrophone.mock.calls.length

      providerState.sessionActive = true
      await renderProvider(environment, true)
      expect(providerState.armWarmMicrophone.mock.calls.length).toBe(armCalls)
      expect(providerState.disarmWarmMicrophone.mock.calls.length).toBe(disarmCalls)

      providerState.sessionActive = false
      await renderProvider(environment, true)
      expect(providerState.armWarmMicrophone.mock.calls.length).toBeGreaterThan(armCalls)
      expect(armedLast()).toBe(true)
    })

    it('releases the microphone when muted, when the setting is off, or for a non-CoreAudio input', async () => {
      const environment = installBrowserAudioEnvironment()
      restoreEnvironment = environment.restore

      for (const mutate of [
        () => (providerState.microphoneMuted = true),
        () => (providerState.keepMicrophoneWarm = false),
        () => (providerState.microphoneId = 'microphone:avfoundation:0')
      ]) {
        providerState.microphoneMuted = false
        providerState.keepMicrophoneWarm = true
        providerState.microphoneId = 'microphone:coreaudio:42'
        await renderProvider(environment, true)
        expect(armedLast()).toBe(true)
        const armCalls = providerState.armWarmMicrophone.mock.calls.length

        mutate()
        await renderProvider(environment, true)
        expect(armedLast()).toBe(false)
        expect(providerState.armWarmMicrophone.mock.calls.length).toBe(armCalls)
      }
    })

    it('releases the microphone on unmount', async () => {
      const environment = installBrowserAudioEnvironment()
      restoreEnvironment = environment.restore
      providerState.microphoneId = 'microphone:coreaudio:42'
      await renderProvider(environment, true)
      expect(armedLast()).toBe(true)
      await act(async () => root?.unmount())
      root = null
      expect(armedLast()).toBe(false)
    })
  })

  it('meters an idle mixer and releases the microphone when the mixer leaves', async () => {
    const environment = installBrowserAudioEnvironment()
    restoreEnvironment = environment.restore
    const lifecycleStates: boolean[] = []
    const renderProvider = async (enabled: boolean): Promise<void> => {
      await act(async () => {
        root?.render(
          createElement(
            StrictMode,
            null,
            createElement(StudioMicVisualProvider, {
              enabled,
              children: createElement(VisualConsumer, {
                onLifecycle: (active) => lifecycleStates.push(active)
              })
            })
          )
        )
        await import('../lib/browser-mic-visual-pipeline')
        await Promise.resolve()
      })
    }

    // No session, nothing armed, no toggle: the meter runs because the mixer
    // is on screen. "Is my microphone working?" is asked BEFORE recording, and
    // bars pinned at the floor cannot answer it.
    root = createRoot(environment.container)
    await renderProvider(true)
    await vi.waitFor(() => expect(environment.contexts).toHaveLength(1))
    expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
    expect(environment.scheduledFrames.size).toBe(1)
    expect(lifecycleStates.at(-1)).toBe(true)

    // The workspace moves elsewhere: the microphone is released immediately —
    // it is genuinely open while metering, so leaving must close it.
    await renderProvider(false)
    await vi.waitFor(() => expect(environment.contexts[0].close).toHaveBeenCalledTimes(1))
    expect(environment.stopTrack).toHaveBeenCalledTimes(1)
    expect(environment.scheduledFrames.size).toBe(0)
    expect(lifecycleStates.at(-1)).toBe(false)
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
  /** Dispatch a document keydown the way the M shortcut listener sees it. */
  pressKey: (
    key: string,
    options?: { editable?: boolean; metaKey?: boolean; repeat?: boolean }
  ) => void
  restore: () => void
} {
  class FakeElement {
    closest(): FakeElement | null {
      return null
    }
  }
  class FakeInputElement extends FakeElement {
    closest(): FakeElement {
      return this
    }
  }
  const documentTarget = new EventTarget()
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
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    dispatchEvent: documentTarget.dispatchEvent.bind(documentTarget)
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
    [
      'window',
      'document',
      'navigator',
      'AudioContext',
      'HTMLElement',
      'IS_REACT_ACT_ENVIRONMENT'
    ].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  )
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeElement })
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
    pressKey: (key, options = {}) => {
      const event = new Event('keydown', { cancelable: true }) as Event & {
        key: string
        metaKey: boolean
        ctrlKey: boolean
        altKey: boolean
        repeat: boolean
      }
      Object.assign(event, {
        key,
        metaKey: options.metaKey === true,
        ctrlKey: false,
        altKey: false,
        repeat: options.repeat === true
      })
      const target = options.editable ? new FakeInputElement() : new FakeElement()
      Object.defineProperty(event, 'target', { value: target })
      documentTarget.dispatchEvent(event)
    },
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  }
}
