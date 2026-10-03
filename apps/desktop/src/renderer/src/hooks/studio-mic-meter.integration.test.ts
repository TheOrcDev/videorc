// @vitest-environment happy-dom
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MediaAccessStatus } from '@/lib/backend'

const fixture = vi.hoisted(() => ({
  microphoneId: 'microphone:coreaudio:42' as string | undefined,
  microphoneName: 'Studio microphone',
  muted: false,
  gainDb: 0,
  permission: 'granted' as MediaAccessStatus | undefined,
  sessionActive: false,
  pending: null as 'microphone' | null,
  checking: false,
  keepWarm: false,
  liveLevel: null as number | null,
  livePeak: null as number | null,
  arm: vi.fn(async () => null),
  disarm: vi.fn(async () => null),
  now: 0,
  timers: [] as Array<{ at: number; callback: () => void }>
}))

vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    captureConfig: {
      ...defaultCaptureConfig,
      sources: {
        ...defaultCaptureConfig.sources,
        microphoneId: fixture.microphoneId,
        microphoneName: fixture.microphoneName
      },
      audio: {
        ...defaultCaptureConfig.audio,
        microphoneMuted: fixture.muted,
        microphoneGainDb: fixture.gainDb
      }
    },
    selectedMicrophone: fixture.microphoneId
      ? { id: fixture.microphoneId, name: fixture.microphoneName }
      : undefined,
    deviceList: {
      devices: [
        {
          id: 'microphone:coreaudio:42',
          name: 'Studio microphone',
          kind: 'microphone',
          status: 'available'
        },
        {
          id: 'microphone:coreaudio:43',
          name: 'Replacement microphone',
          kind: 'microphone',
          status: 'available'
        }
      ]
    },
    mediaAccess: { microphone: fixture.permission },
    sourceSelectionState: { pending: fixture.pending, checking: fixture.checking },
    isSessionActive: fixture.sessionActive,
    settings: { keepMicrophoneWarm: fixture.keepWarm },
    armWarmMicrophone: fixture.arm,
    disarmWarmMicrophone: fixture.disarm,
    sourceSwitchReason: () => null,
    switchSourceDeviceLive: vi.fn(),
    setCaptureConfig: vi.fn(),
    retrySourceStatus: vi.fn(),
    wsStatus: 'connected',
    systemAudioConfirmed: null,
    systemAudioIssue: null,
    runtimeInfo: { platform: 'darwin' }
  }),
  useStudioDiagnostics: () => ({
    diagnosticStats: { micLiveLevel: fixture.liveLevel, micLivePeakDb: fixture.livePeak }
  })
}))
vi.mock('@/components/workspace-nav', () => ({
  useWorkspaceNav: () => ({ openSettings: vi.fn() })
}))
vi.mock('@/lib/backend-audio-levels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend-audio-levels')>()
  return {
    ...actual,
    backendAudioLevels: actual.createBackendAudioLevelsStore({
      now: () => fixture.now,
      setTimer: (callback, delayMs) => {
        fixture.timers.push({ at: fixture.now + delayMs, callback })
      }
    })
  }
})

import { MicrophoneSection } from '@/components/studio/microphone-section'
import { SessionMicSliver } from '@/components/studio/session-mic-sliver'
import { SourcesAudioMixer } from '@/components/sources/sources-audio-mixer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { backendAudioLevels } from '@/lib/backend-audio-levels'
import { defaultCaptureConfig } from '@/lib/capture'
import { StudioMicVisualProvider } from './use-studio-mic-visual'

describe('production microphone meter demand', () => {
  let root: Root
  let container: HTMLDivElement
  let environment: ReturnType<typeof installBrowserAudio>
  let frameAt = 0

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    environment = installBrowserAudio()
    frameAt = 0
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    advanceBackendClock(2_000)
    fixture.microphoneId = 'microphone:coreaudio:42'
    fixture.microphoneName = 'Studio microphone'
    fixture.muted = false
    fixture.gainDb = 0
    fixture.permission = 'granted'
    fixture.sessionActive = false
    fixture.pending = null
    fixture.checking = false
    fixture.keepWarm = false
    fixture.liveLevel = null
    fixture.livePeak = null
    fixture.arm.mockClear()
    fixture.disarm.mockClear()
    environment.restore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function render(
    consumer: typeof MicrophoneSection | typeof SourcesAudioMixer | null,
    enabled = true,
    sliver = false
  ) {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(StudioMicVisualProvider, {
            enabled,
            children: createElement(
              TooltipProvider,
              null,
              consumer ? createElement(consumer) : null,
              sliver
                ? createElement(SessionMicSliver, {
                    sessionActive: true,
                    deviceName: fixture.microphoneName,
                    muted: false
                  })
                : null
            )
          })
        )
      )
      await import('@/lib/browser-mic-visual-pipeline')
    })
  }

  async function frames(count = 16) {
    for (let index = 0; index < count; index += 1) {
      frameAt += 48
      const callbacks = [...environment.scheduled.values()]
      environment.scheduled.clear()
      await act(async () => callbacks.forEach((callback) => callback(frameAt)))
    }
  }

  for (const [label, consumer] of [
    ['Studio', MicrophoneSection],
    ['Sources', SourcesAudioMixer]
  ] as const) {
    it(`starts and paints ${label}'s idle fallback with warming disabled`, async () => {
      expect(backendAudioLevels.isLive()).toBe(false)
      await render(consumer)
      await vi.waitFor(() => expect(environment.getUserMedia).toHaveBeenCalledTimes(1))
      expect(fixture.arm).not.toHaveBeenCalled()
      await frames()
      const meter = container.querySelector('[role="meter"][aria-label="Microphone level"]')
      expect(meter).not.toBeNull()
      expect(Number(meter?.getAttribute('aria-valuenow'))).toBeGreaterThan(-30)
      expect(
        container.querySelector('[data-videorc-mic-monitor-state="monitoring"]')
      ).not.toBeNull()
    })

    it(`releases ${label}'s demand on mute, hide, and unmount and resumes without reopening on gain updates`, async () => {
      await render(consumer)
      expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
      fixture.gainDb = 6
      await render(consumer)
      await frames()
      expect(environment.getUserMedia).toHaveBeenCalledTimes(1)

      fixture.muted = true
      await render(consumer)
      expect(environment.stopped).toHaveBeenCalledTimes(1)
      expect(container.querySelector('[data-videorc-mic-monitor-state="muted"]')).not.toBeNull()
      fixture.muted = false
      await render(consumer)
      expect(environment.getUserMedia).toHaveBeenCalledTimes(2)

      await render(consumer, false)
      expect(environment.stopped).toHaveBeenCalledTimes(2)
      await render(consumer)
      expect(environment.getUserMedia).toHaveBeenCalledTimes(3)

      await act(async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(environment.stopped).toHaveBeenCalledTimes(3)
      await render(null)
      await act(async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(environment.getUserMedia).toHaveBeenCalledTimes(3)
      await render(consumer)
      expect(environment.getUserMedia).toHaveBeenCalledTimes(4)
      await render(null)
      expect(environment.stopped).toHaveBeenCalledTimes(4)
      expect(environment.contexts.every((context) => context.close.mock.calls.length === 1)).toBe(
        true
      )
    })

    it(`uses backend levels first for ${label}, recovers after standby stalls, and releases fallback when levels return`, async () => {
      fixture.keepWarm = true
      await publishLevels(-6)
      await render(consumer)
      await publishLevels(-6)
      await frames()
      expect(environment.getUserMedia).not.toHaveBeenCalled()
      expect(fixture.arm).toHaveBeenCalled()
      expect(readMeter()).toBeCloseTo(-6, 1)

      await act(async () => advanceBackendClock(1_001))
      expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
      await frames()
      expect(readMeter()).toBeCloseTo(20 * Math.log10(0.2), 1)
      expect(
        container.querySelector('[data-videorc-mic-monitor-state="monitoring"]')
      ).not.toBeNull()

      await publishLevels(-3)
      await publishLevels(-3)
      await frames()
      expect(environment.stopped).toHaveBeenCalledTimes(1)
      expect(readMeter()).toBeCloseTo(-3, 1)
      expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
    })
  }

  function readMeter() {
    const meter = container.querySelector('[role="meter"][aria-label="Microphone level"]')
    expect(meter).not.toBeNull()
    return Number(meter?.getAttribute('aria-valuenow'))
  }

  async function publishLevels(peakDb: number) {
    await act(async () =>
      backendAudioLevels.publish({
        sessionId: 'standby',
        microphone: { peakDb, rmsDb: peakDb - 6 },
        masterClippedSamples: 0
      })
    )
  }

  it('starts the real Sources fallback when attempted standby warming supplies no levels', async () => {
    fixture.keepWarm = true
    await render(SourcesAudioMixer)
    expect(fixture.arm).toHaveBeenCalled()
    expect(backendAudioLevels.isLive()).toBe(false)
    expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
    await frames()
    expect(readMeter()).toBeGreaterThan(-30)
    expect(container.querySelector('[data-videorc-mic-monitor-state="monitoring"]')).not.toBeNull()
  })

  it('keeps another production visual consumer alive when the meter returns to backend levels', async () => {
    fixture.sessionActive = true
    await render(MicrophoneSection, true, true)
    expect(container.querySelector('[data-videorc-session-mic-sliver]')).not.toBeNull()
    expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
    await publishLevels(-6)
    expect(environment.stopped).not.toHaveBeenCalled()
    await render(MicrophoneSection)
    expect(environment.stopped).toHaveBeenCalledTimes(1)
    expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending old device acquisition and attaches only the newly selected microphone', async () => {
    let resolveOld!: (stream: TestStream) => void
    const retiredStop = vi.fn()
    const retired: TestStream = { getTracks: () => [{ stop: retiredStop }] }
    const current: TestStream = { getTracks: () => [{ stop: environment.stopped }] }
    environment.getUserMedia.mockImplementationOnce(
      () =>
        new Promise<TestStream>((resolve) => {
          resolveOld = resolve
        })
    )
    environment.getUserMedia.mockResolvedValueOnce(current)
    await render(SourcesAudioMixer)
    expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
    fixture.microphoneId = 'microphone:coreaudio:43'
    fixture.microphoneName = 'Replacement microphone'
    await render(SourcesAudioMixer)
    expect(environment.getUserMedia).toHaveBeenCalledTimes(2)
    expect(environment.getUserMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ deviceId: { exact: 'mic-2' } })
      })
    )
    await act(async () => resolveOld(retired))
    expect(retiredStop).toHaveBeenCalledTimes(1)
    expect(environment.connected).toEqual([current])
    expect(environment.contexts).toHaveLength(1)
    await frames()
    expect(readMeter()).toBeGreaterThan(-30)
  })

  it('releases real meter demand while source selection is pending or checking and when no mic is selected', async () => {
    await render(MicrophoneSection)
    fixture.pending = 'microphone'
    await render(MicrophoneSection)
    expect(environment.stopped).toHaveBeenCalledTimes(1)
    fixture.pending = null
    fixture.checking = true
    await render(MicrophoneSection)
    expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
    fixture.checking = false
    await render(MicrophoneSection)
    expect(environment.getUserMedia).toHaveBeenCalledTimes(2)
    fixture.microphoneId = undefined
    await render(SourcesAudioMixer)
    expect(environment.stopped).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('No microphone')
  })

  it.each(['denied', 'restricted', 'not-determined', undefined] as const)(
    'does not request browser permission or retain meter demand when OS access is %s',
    async (permission) => {
      fixture.permission = permission
      await render(SourcesAudioMixer)
      await frames()
      expect(environment.getUserMedia).not.toHaveBeenCalled()
      expect(container.querySelector('[data-videorc-mic-monitor-state="idle"]')).not.toBeNull()
    }
  )

  it.each([
    ['NotAllowedError', "Videorc can't use this mic. Check Settings → Permissions."],
    [
      'NotReadableError',
      "Another app is using this mic. Its level comes back when it's free. Recording still works."
    ]
  ])(
    'keeps %s truthful without repeatedly trying the failed browser device',
    async (name, copy) => {
      environment.getUserMedia.mockRejectedValue(new DOMException('refused', name))
      await render(SourcesAudioMixer)
      expect(container.textContent).toContain(copy)
      expect(container.querySelector('[data-videorc-mic-monitor-state="idle"]')).not.toBeNull()
      for (let index = 0; index < 3; index += 1) {
        fixture.gainDb += 1
        await render(SourcesAudioMixer)
        await frames()
      }
      expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps the session diagnostic reading when analyser acquisition fails', async () => {
    fixture.sessionActive = true
    fixture.liveLevel = 0.1
    fixture.livePeak = -18
    environment.getUserMedia.mockRejectedValue(new DOMException('busy', 'NotReadableError'))
    await render(SourcesAudioMixer)
    await frames()
    expect(readMeter()).toBeCloseTo(-18, 1)
    expect(container.querySelector('[data-videorc-mic-monitor-state="live"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Another app is using this mic')
    expect(environment.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable media APIs without an acquisition loop', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    await render(SourcesAudioMixer)
    expect(container.textContent).toContain('Live level unavailable. Recording still works.')
    await render(SourcesAudioMixer)
    await frames()
    expect(environment.getUserMedia).not.toHaveBeenCalled()
    expect(container.querySelector('[data-videorc-mic-monitor-state="idle"]')).not.toBeNull()
  })
})

type TestStream = { getTracks: () => Array<{ stop: () => void }> }

function advanceBackendClock(ms: number) {
  fixture.now += ms
  for (const timer of fixture.timers.splice(0)) {
    if (timer.at <= fixture.now) timer.callback()
    else fixture.timers.push(timer)
  }
}

function installBrowserAudio() {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = []
  const stopped = vi.fn()
  const getUserMedia = vi.fn(
    async (): Promise<TestStream> => ({ getTracks: () => [{ stop: stopped }] })
  )
  const media = new EventTarget()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Studio microphone' },
        { kind: 'audioinput', deviceId: 'mic-2', label: 'Replacement microphone' }
      ]),
      getUserMedia,
      addEventListener: media.addEventListener.bind(media),
      removeEventListener: media.removeEventListener.bind(media)
    }
  })
  const connected: TestStream[] = []
  class FakeAudioContext {
    sampleRate = 48_000
    close = vi.fn(async () => undefined)
    constructor() {
      contexts.push(this)
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        frequencyBinCount: 1024,
        smoothingTimeConstant: 0,
        getFloatFrequencyData: (samples: Float32Array) => samples.fill(-60),
        getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.2)
      }
    }
    createMediaStreamSource(stream: TestStream) {
      connected.push(stream)
      return { connect: vi.fn(), disconnect: vi.fn() }
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  const scheduled = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++frameId
    scheduled.set(id, callback)
    return id
  }
  const cancelFrame = (id: number) => {
    scheduled.delete(id)
  }
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(requestFrame)
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(cancelFrame)
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  return {
    contexts,
    stopped,
    getUserMedia,
    scheduled,
    connected,
    restore: () => {
      if (descriptor) Object.defineProperty(navigator, 'mediaDevices', descriptor)
      else Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  }
}
