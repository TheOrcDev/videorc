import { readFileSync } from 'node:fs'

import { act, createElement, memo, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

import {
  capSessionDetailBuffer,
  SESSION_DETAIL_BUFFER_LIMIT,
  StudioContextProviders,
  useStudioCore,
  useStudioPreview,
  useStudioRecording,
  useStudioRecordingState,
  type StudioCoreContextValue,
  type StudioPreviewContextValue,
  type StudioRecordingContextValue,
  type StudioRecordingStateContextValue
} from './use-studio'

const emptyContextValue = Object.freeze({})

function installNullRenderDom(): { container: Element; restore: () => void } {
  class FakeElement {}

  const fakeWindow: Record<string, unknown> = {
    HTMLIFrameElement: FakeElement,
    HTMLElement: FakeElement
  }
  fakeWindow.window = fakeWindow
  const fakeDocument = {
    nodeType: 9,
    activeElement: null,
    defaultView: fakeWindow,
    documentElement: {},
    body: {},
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
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousActEnvironment = Object.getOwnPropertyDescriptor(
    globalThis,
    'IS_REACT_ACT_ENVIRONMENT'
  )

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: fakeWindow
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: fakeDocument
  })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true
  })

  const restoreProperty = (name: string, descriptor?: PropertyDescriptor): void => {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
    } else {
      Reflect.deleteProperty(globalThis, name)
    }
  }

  return {
    container,
    restore: () => {
      restoreProperty('window', previousWindow)
      restoreProperty('document', previousDocument)
      restoreProperty('IS_REACT_ACT_ENVIRONMENT', previousActEnvironment)
    }
  }
}

describe('studio context invalidation boundaries', () => {
  it('caps selected-session live detail buffers to the rendered history window', () => {
    const entries = Array.from({ length: SESSION_DETAIL_BUFFER_LIMIT + 5 }, (_, index) => index)

    expect(capSessionDetailBuffer(entries)).toEqual(entries.slice(-SESSION_DETAIL_BUFFER_LIMIT))
  })
  it('keeps high-frequency media state out of the core context memo', () => {
    const source = readFileSync(new URL('./use-studio.tsx', import.meta.url), 'utf8')
    const coreStart = source.indexOf('const value = useMemo<StudioCoreContextValue>')
    const providerStart = source.indexOf('return (', coreStart)
    const coreMemo = source.slice(coreStart, providerStart)

    expect(coreStart).toBeGreaterThan(-1)
    expect(providerStart).toBeGreaterThan(coreStart)
    expect(coreMemo).not.toMatch(/\baudioMeter\b/)
    expect(coreMemo).not.toMatch(/\baudioMeterLoading\b/)
    expect(coreMemo).not.toMatch(/\bmeterLevel\b/)
    expect(coreMemo).not.toMatch(/\bpreviewSurfaceStatus\b/)
    expect(coreMemo).not.toMatch(/\bstreamHealth\b/)
    expect(coreMemo).not.toMatch(/\blogs\b/)
    expect(coreMemo).not.toMatch(/\bhealthEvents\b/)
    expect(coreMemo).not.toMatch(/\brecording\b/)
    expect(coreMemo).not.toMatch(/\bpreviewLiveStatus\b/)
    expect(coreMemo).not.toMatch(/\bpreviewCameraStatus\b/)
    expect(coreMemo).not.toMatch(/\bpreviewScreenStatus\b/)
  })

  it('keeps the microphone analyser runtime behind a demand-loaded boundary', () => {
    const provider = readFileSync(new URL('./use-studio-mic-visual.tsx', import.meta.url), 'utf8')
    const eagerConsumers = [
      '../components/studio/audio-mixer.tsx',
      '../components/studio/session-mic-sliver.tsx',
      '../components/ui/live-waveform.tsx'
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

    expect(provider).toContain("import('@/lib/browser-mic-visual-pipeline')")
    expect(provider).not.toMatch(/import\s*\{[^}]*createMicVisualPipeline[^}]*\}\s*from/)
    for (const consumer of eagerConsumers) {
      expect(consumer).not.toContain("from '@/lib/mic-visual-pipeline'")
    }
  })

  it('keeps below-the-fold Studio editors out of the launch chunk', () => {
    const source = readFileSync(
      new URL('../components/tabs/studio-tab.tsx', import.meta.url),
      'utf8'
    )

    expect(source).toContain("await import('@/components/studio/studio-dashboard-bottom-row')")
    expect(source).not.toContain("from '@/components/studio/audio-mixer'")
    expect(source).not.toContain("from '@/components/studio/scenes-gallery'")
    expect(source).toMatch(/<Suspense fallback=\{<StudioDashboardBottomRowFallback \/>\}>/)
  })

  it('preserves core provider identity across elapsed-time and preview telemetry updates', async () => {
    const core = { wsStatus: 'connected' } as StudioCoreContextValue
    const observedCoreValues: StudioCoreContextValue[] = []
    const observedRecordingDurations: Array<number | undefined> = []
    const observedPreviewAges: Array<number | undefined> = []
    let coreRenderCount = 0
    let recordingStateRenderCount = 0
    let volatileRenderCount = 0

    const CoreConsumer = memo(function CoreConsumer() {
      coreRenderCount += 1
      observedCoreValues.push(useStudioCore())
      return null
    })
    const VolatileConsumer = memo(function VolatileConsumer() {
      volatileRenderCount += 1
      observedRecordingDurations.push(useStudioRecording().recording.durationMs)
      observedPreviewAges.push(useStudioPreview().previewCameraStatus.frameAgeMs)
      return null
    })
    const RecordingStateConsumer = memo(function RecordingStateConsumer() {
      recordingStateRenderCount += 1
      useStudioRecordingState()
      return null
    })

    function Harness({ durationMs, frameAgeMs }: { durationMs: number; frameAgeMs: number }) {
      const recordingState = useMemo<StudioRecordingStateContextValue>(
        () => ({ recording: { state: 'recording', sessionId: 'active-session' } }),
        []
      )
      const recording = useMemo<StudioRecordingContextValue>(
        () => ({ recording: { state: 'recording', message: 'Recording', durationMs } }),
        [durationMs]
      )
      const preview = useMemo<StudioPreviewContextValue>(
        () => ({
          previewLiveStatus: {
            state: 'live',
            source: 'idle-preview',
            transport: 'native-surface',
            backing: 'cametal-layer',
            message: 'Previewing'
          },
          previewCameraStatus: {
            state: 'live',
            targetFps: 60,
            frameAgeMs,
            framesCaptured: 1,
            droppedFrames: 0,
            updatedAt: new Date(0).toISOString()
          },
          previewScreenStatus: {
            state: 'live',
            targetFps: 60,
            frameAgeMs,
            framesCaptured: 1,
            droppedFrames: 0,
            includeCursor: true,
            excludeCurrentProcessWindows: true,
            updatedAt: new Date(0).toISOString()
          }
        }),
        [frameAgeMs]
      )

      return createElement(
        StudioContextProviders,
        {
          audio: emptyContextValue as never,
          chat: emptyContextValue as never,
          core,
          diagnostics: emptyContextValue as never,
          preview,
          recording,
          recordingState
        },
        createElement(CoreConsumer),
        createElement(RecordingStateConsumer),
        createElement(VolatileConsumer)
      )
    }

    const testDom = installNullRenderDom()
    let root: Root | null = null
    try {
      await act(async () => {
        root = createRoot(testDom.container)
        root.render(createElement(Harness, { durationMs: 1_000, frameAgeMs: 16 }))
      })
      const initialCore = observedCoreValues.at(-1)

      await act(async () => {
        root?.render(createElement(Harness, { durationMs: 2_000, frameAgeMs: 16 }))
      })
      await act(async () => {
        root?.render(createElement(Harness, { durationMs: 2_000, frameAgeMs: 33 }))
      })

      expect(coreRenderCount).toBe(1)
      expect(recordingStateRenderCount).toBe(1)
      expect(observedCoreValues).toEqual([initialCore])
      expect(initialCore).toBe(core)
      expect(volatileRenderCount).toBe(3)
      expect(observedRecordingDurations).toEqual([1_000, 2_000, 2_000])
      expect(observedPreviewAges).toEqual([16, 16, 33])
    } finally {
      await act(async () => root?.unmount())
      testDom.restore()
    }
  })

  it('commits critical device and preview state before optional platform validation', () => {
    const source = readFileSync(new URL('./use-studio.tsx', import.meta.url), 'utf8')
    const bootstrapStart = source.indexOf('nextClient\n      .connect()')
    const criticalDeviceCommit = source.indexOf('setDeviceList(nextDevices)', bootstrapStart)
    const criticalPreviewCommit = source.indexOf(
      'applyPreviewLiveStatus(nextPreview)',
      bootstrapStart
    )
    const optionalPlatformLoad = source.indexOf(
      'loadValidatedPlatformAccountsOnIsolatedClient<',
      bootstrapStart
    )

    expect(bootstrapStart).toBeGreaterThan(-1)
    expect(criticalDeviceCommit).toBeGreaterThan(bootstrapStart)
    expect(criticalPreviewCommit).toBeGreaterThan(bootstrapStart)
    expect(optionalPlatformLoad).toBeGreaterThan(criticalDeviceCommit)
    expect(optionalPlatformLoad).toBeGreaterThan(criticalPreviewCommit)
  })

  it('keeps diagnostics and chat consumers below the Studio tab root', () => {
    const source = readFileSync(
      new URL('../components/tabs/studio-tab.tsx', import.meta.url),
      'utf8'
    )
    const rootStart = source.indexOf('export function StudioTab')
    const previewStart = source.indexOf('function StudioPreviewPanel', rootStart)
    const chatStart = source.indexOf('function StudioLiveChatRail', previewStart)
    const rootComponent = source.slice(rootStart, previewStart)
    const previewComponent = source.slice(previewStart, chatStart)
    const chatComponent = source.slice(chatStart)

    expect(rootStart).toBeGreaterThan(-1)
    expect(previewStart).toBeGreaterThan(rootStart)
    expect(chatStart).toBeGreaterThan(previewStart)
    expect(rootComponent).not.toMatch(/useStudioDiagnostics\s*\(/)
    expect(rootComponent).not.toMatch(/useStudioChat\s*\(/)
    expect(rootComponent).not.toMatch(/\bdiagnosticStats\b/)
    expect(rootComponent).not.toMatch(/\bliveChatSnapshot\b/)
    expect(previewComponent).toMatch(/useStudioDiagnostics\s*\(/)
    expect(chatComponent).toMatch(/useStudioChat\s*\(/)
  })

  it('coalesces websocket chat messages before updating React state', () => {
    const source = readFileSync(new URL('./use-studio.tsx', import.meta.url), 'utf8')
    const handlerStart = source.indexOf("nextClient.on('liveChat.message'")
    const nextHandlerStart = source.indexOf("nextClient.on('liveChat.providerStatus'", handlerStart)
    const handler = source.slice(handlerStart, nextHandlerStart)

    expect(handlerStart).toBeGreaterThan(-1)
    expect(nextHandlerStart).toBeGreaterThan(handlerStart)
    expect(handler).toMatch(/liveChatMessageBatcher\.enqueue\(message\)/)
    expect(handler).not.toMatch(/setLiveChatSnapshot\s*\(/)
    expect(source).toMatch(
      /updateLiveChatSnapshot\(\(current\) => applyLiveChatMessages\(current, messages\)\)/
    )
  })

  it('uses deltas for ordinary chat messages without a snapshot-dependent relay effect', () => {
    const source = readFileSync(new URL('./use-studio.tsx', import.meta.url), 'utf8')
    const handlerStart = source.indexOf("nextClient.on('liveChat.message'")
    const nextHandlerStart = source.indexOf("nextClient.on('liveChat.providerStatus'", handlerStart)
    const handler = source.slice(handlerStart, nextHandlerStart)
    const snapshotDependentRelayEffect =
      /useEffect\(\(\) => \{[\s\S]{0,800}?pushCommentsSnapshot[\s\S]{0,800}?\}, \[[^\]]*\bliveChatSnapshot\b[^\]]*\]\)/

    expect(handler).toMatch(/pushCommentsDelta/)
    expect(handler).not.toMatch(/pushCommentsSnapshot/)
    expect(source).not.toMatch(snapshotDependentRelayEffect)
  })

  it('retries overflowed lag recovery and revision-guards all live send-operation queries', () => {
    const source = readFileSync(new URL('./use-studio.tsx', import.meta.url), 'utf8')
    const recoveryStart = source.indexOf('function recoverLiveChatSnapshot')
    const recoveryEnd = source.indexOf('setClient(nextClient)', recoveryStart)
    const recovery = source.slice(recoveryStart, recoveryEnd)

    expect(recoveryStart).toBeGreaterThan(-1)
    expect(recoveryEnd).toBeGreaterThan(recoveryStart)
    expect(recovery).toMatch(/runBoundedLiveChatRecovery/)
    expect(recovery).toMatch(/overflowed: pending\.overflowed/)
    expect(recovery).toMatch(/scheduleLiveChatRecoveryRetry/)
    expect(recovery).toMatch(/sendOperationRevisionAtStart/)
    expect(source.match(/requestLiveChatSendOperations\(/g)).toHaveLength(4)
    expect(source.match(/applyLiveChatSendOperationsQuery\(/g)).toHaveLength(3)
  })
})
