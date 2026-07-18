import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const toastSpies = vi.hoisted(() => ({
  dismiss: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn()
}))
vi.mock('sonner', () => ({ toast: toastSpies }))

import type {
  AccountCallbackEnvelope,
  AiArtifact,
  AudioMeterResult,
  BackendConnection,
  CompositorStatus,
  DeviceList,
  HealthEvent,
  LayoutSettings,
  NoiseCleanupJob,
  OAuthCallbackEnvelope,
  PreviewSurfaceBounds,
  PreviewSurfaceStatus,
  PreviewWindowState,
  Scene,
  SessionLogEntry,
  SessionSummary,
  VideorcApi
} from '../../../shared/backend'
import { BackgroundAssetsProvider } from './use-background-assets'
import {
  StudioProvider,
  useStudioAudio,
  useStudioCore,
  useStudioRecording,
  type StudioCoreContextValue,
  type StudioRecordingContextValue
} from './use-studio'
import { DEFAULT_BASIC_ENTITLEMENTS } from '../lib/entitlements'
import { defaultCaptureConfig } from '../lib/capture'
import { deriveNoiseCleanupView } from '../lib/noise-cleanup-view'
import type {
  WindowsLiveAudioSmokeRequest,
  WindowsLiveAudioSmokeState
} from '../../../shared/windows-live-audio-smoke'

type BackendCommand = { id: string; method: string; params?: unknown }

const now = '2026-07-12T00:00:00.000Z'
const signedInAccount = {
  status: 'signed-in' as const,
  username: 'provider-test',
  displayName: 'Provider Test',
  email: 'provider@example.test'
}

const premiumEntitlements = {
  ...DEFAULT_BASIC_ENTITLEMENTS,
  tier: 'premium' as const,
  source: 'creem' as const,
  capabilities: DEFAULT_BASIC_ENTITLEMENTS.capabilities.map((capability) => ({
    ...capability,
    state: 'enabled' as const,
    reason: undefined
  }))
}

function cleanupJob(overrides: Partial<NoiseCleanupJob> = {}): NoiseCleanupJob {
  return {
    id: 'cleanup-1',
    sourceSessionId: 'session-1',
    status: 'queued',
    progressPercent: 0,
    preset: 'speech-v1',
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    title: 'Session 1',
    startedAt: now,
    status: 'completed',
    mode: 'recording',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

const callbackEnvelope: AccountCallbackEnvelope = {
  id: 'callback-1',
  state: 'state-0123456789abcdef',
  intentGeneration: 7,
  receivedAtMs: 1,
  expiresAtMs: Date.now() + 120_000,
  url:
    'videorc://account/callback?code=opaque-code-0123456789&state=state-0123456789abcdef&verifier=' +
    'v'.repeat(43)
}

const providerCallbackEnvelope: OAuthCallbackEnvelope = {
  id: 'provider-callback-1',
  state: 'provider-state-0123456789abcdef',
  receivedAtMs: Date.now(),
  url:
    'videorc://oauth/callback?code=provider-code-0123456789&state=' +
    'provider-state-0123456789abcdef'
}

const previewWindowClosed: PreviewWindowState = {
  open: false,
  visible: false,
  contentBounds: null,
  scaleFactor: 1,
  screenHeight: 1080,
  alwaysOnTop: false,
  mode: 'floating',
  dockEpoch: 0,
  dockHiddenReason: null,
  supervisor: {
    lifecycleState: 'closed',
    generation: 0,
    windowOpen: false,
    windowVisible: false,
    surfaceRequested: false,
    surfaceActive: false,
    transport: 'none',
    backing: 'none',
    permissionStatus: 'ok',
    updatedAt: now
  }
}

const previewWindowOpen = (contentBounds: {
  x: number
  y: number
  width: number
  height: number
}): PreviewWindowState => ({
  open: true,
  visible: true,
  contentBounds,
  scaleFactor: 1,
  screenHeight: 1080,
  alwaysOnTop: false,
  mode: 'floating',
  dockEpoch: 0,
  dockHiddenReason: null,
  supervisor: {
    lifecycleState: 'surface-live',
    generation: 1,
    windowOpen: true,
    windowVisible: true,
    surfaceRequested: true,
    surfaceActive: true,
    transport: 'native-surface',
    backing: 'cametal-layer',
    permissionStatus: 'ok',
    updatedAt: now
  }
})

function nativePreviewStatus(bounds?: PreviewSurfaceBounds): PreviewSurfaceStatus {
  return {
    state: 'live',
    source: 'screen',
    transport: 'native-surface',
    backing: 'cametal-layer',
    targetFps: 60,
    width: bounds?.width ?? 960,
    height: bounds?.height ?? 540,
    framesRendered: 1,
    presentedFrameId: 1,
    droppedFrames: 0,
    framePollingSuppressed: false,
    sourcePixelsPresent: true,
    nativePreviewHostKind: 'in-process',
    nativePreviewHostAttached: true,
    pendingHostCommandCount: 0,
    bounds,
    updatedAt: now
  }
}

function sceneForLayout(layout: LayoutSettings): Scene {
  const transform = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
  return {
    id: 'scene-1',
    name: 'Studio scene',
    sources: [
      {
        id: 'screen-source',
        name: 'Display 1',
        kind: 'screen',
        deviceId: 'screen:dxgi:0000000000000001:1',
        transform,
        defaultTransform: transform,
        visible: true,
        locked: false
      },
      {
        id: 'camera-source',
        name: 'Camera 1',
        kind: 'camera',
        deviceId: 'camera:1',
        transform: { ...transform, x: 0.7, y: 0.7, width: 0.25, height: 0.25 },
        defaultTransform: { ...transform, x: 0.7, y: 0.7, width: 0.25, height: 0.25 },
        visible: layout.layoutPreset !== 'screen-only',
        locked: false
      }
    ],
    outputs: [{ id: 'preview', kind: 'preview', width: 2560, height: 1440, fps: 30 }]
  }
}

function compositorFor(scene: Scene, layout: LayoutSettings, revision: number): CompositorStatus {
  return {
    state: 'live',
    targetFps: 30,
    width: 2560,
    height: 1440,
    sceneRevision: revision,
    frameSceneRevision: revision,
    sceneId: scene.id,
    sceneLayout: layout,
    sceneSources: [],
    sources: [],
    framesRendered: 10,
    repeatedFrames: 0,
    droppedFrames: 0,
    updatedAt: now
  }
}

class StudioBackend {
  sockets: TestWebSocket[] = []
  commands: BackendCommand[] = []
  sentCommands: BackendCommand[] = []
  currentLayout = defaultCaptureConfig.layout
  currentScene = sceneForLayout(this.currentLayout)
  revision = 1
  recordingState: 'idle' | 'recording' = 'idle'
  accountTransportFailuresRemaining = 0
  accountSignInSuperseded = false
  oauthTransportFailuresRemaining = 1
  oauthRetryFailuresRemaining = 1
  oauthCompletedStates = new Set<string>()
  entitlements = DEFAULT_BASIC_ENTITLEMENTS
  noiseCleanupJobs: NoiseCleanupJob[] = []
  sourceMutationRevision = 4
  layoutResponseDelayMs = 0
  sessionStartResponseDelayMs = 0
  emitRecordingStatusBeforeStartResponse = false
  audioProcessingResponseDelayMs = 0
  audioProcessingReasonCode: 'session-ended' | null = null
  deviceListFailuresRemaining = 0
  audioMeterFailuresRemaining = 0
  sessionDetailFailuresRemaining = 0
  sessionSummaries: SessionSummary[] = []
  sessionListNextCursor: string | undefined
  sessionHealthEvents: HealthEvent[] = []
  sessionLogs: SessionLogEntry[] = []
  sessionAiArtifacts: AiArtifact[] = []
  private readonly deferredResponses = new Map<
    string,
    Array<{
      payload: unknown
      ready: Promise<void>
      release: () => void
      matches?: (command: BackendCommand) => boolean
    }>
  >()
  deviceList: DeviceList = {
    devices: [
      {
        id: 'screen:dxgi:0000000000000001:1',
        name: 'Display 1',
        kind: 'screen',
        status: 'available',
        width: 2560,
        height: 1440
      },
      { id: 'camera:1', name: 'Camera 1', kind: 'camera', status: 'available' },
      { id: 'mic:1', name: 'Microphone 1', kind: 'microphone', status: 'available' }
    ],
    warnings: []
  }
  audioMeterResult: AudioMeterResult = { status: 'ready', level: 0.4 }

  deferResponse(
    method: string,
    payload: unknown,
    matches?: (command: BackendCommand) => boolean
  ): () => void {
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = this.deferredResponses.get(method) ?? []
    pending.push({ payload, ready, release, matches })
    this.deferredResponses.set(method, pending)
    return release
  }

  takeDeferredResponse(
    method: string,
    command: BackendCommand
  ):
    | {
        payload: unknown
        ready: Promise<void>
        release: () => void
        matches?: (command: BackendCommand) => boolean
      }
    | undefined {
    const pending = this.deferredResponses.get(method)
    const index = pending?.findIndex((candidate) => candidate.matches?.(command) ?? true) ?? -1
    const next = index >= 0 ? pending?.splice(index, 1)[0] : undefined
    if (pending?.length === 0) {
      this.deferredResponses.delete(method)
    }
    return next
  }

  invalidateCompletedNoiseCleanup(message: string): void {
    this.sourceMutationRevision += 1
    this.noiseCleanupJobs = this.noiseCleanupJobs.map((job) =>
      job.status === 'completed'
        ? cleanupJob({
            ...job,
            status: 'failed',
            progressPercent: 0,
            outputSessionId: undefined,
            outputPath: undefined,
            errorCode: 'source-changed',
            errorMessage: message,
            updatedAt: `2026-07-12T00:00:${this.sourceMutationRevision.toString().padStart(2, '0')}.000Z`
          })
        : job
    )
  }

  response(command: BackendCommand): unknown {
    this.commands.push(command)
    const params = (command.params ?? {}) as Record<string, unknown>
    switch (command.method) {
      case 'health.ping':
        return {
          status: 'ok',
          version: 'test',
          platform: 'win32',
          ffmpeg: { path: 'C:\\ffmpeg.exe', available: true },
          databasePath: 'C:\\videorc-test.db',
          secretStoreBackend: 'test'
        }
      case 'entitlements.get':
      case 'entitlements.refresh':
        return this.entitlements
      case 'account.get':
        return { status: 'signed-out' }
      case 'account.complete_sign_in':
        if (this.accountSignInSuperseded) {
          throw Object.assign(new Error('Desktop account sign-in was superseded.'), {
            code: 'account-sign-in-superseded'
          })
        }
        if (this.accountTransportFailuresRemaining > 0) {
          this.accountTransportFailuresRemaining -= 1
          throw new Error('Temporary account sign-in transport failure.')
        }
        return signedInAccount
      case 'account.sign_out':
        return { status: 'signed-out' }
      case 'ai.capabilities.get':
      case 'ai.quota.get':
        throw new Error('AI web dependency is intentionally offline in this lifecycle test.')
      case 'devices.list':
        if (this.deviceListFailuresRemaining > 0) {
          this.deviceListFailuresRemaining -= 1
          throw new Error('Temporary devices.list failure.')
        }
        return this.deviceList
      case 'audio.meter.sample':
        if (this.audioMeterFailuresRemaining > 0) {
          this.audioMeterFailuresRemaining -= 1
          throw new Error('Temporary audio.meter.sample failure.')
        }
        return this.audioMeterResult
      case 'recording.status':
        return { state: this.recordingState, message: 'Ready.' }
      case 'diagnostics.stats':
        return {
          activeFfmpegProcesses: 0,
          activeFfprobeProcesses: 0,
          micDroppedFrames: 0,
          previewCameraDroppedFrames: 0,
          previewScreenDroppedFrames: 0,
          previewSourceFrameDroppedFrames: 0,
          droppedFrames: 0,
          skippedFrames: 0,
          updatedAt: now
        }
      case 'captions.status.get':
        return { state: 'idle' }
      case 'liveChat.status':
        return { providers: [], messages: [], unreadCount: 0, updatedAt: now }
      case 'comments.highlight.status':
        return { generation: 0, phase: 'idle' }
      case 'preview.live.status':
        return {
          state: 'unavailable',
          source: 'idle-preview',
          transport: 'unavailable',
          backing: 'none',
          message: 'Disabled in provider integration test.'
        }
      case 'preview.surface.status':
        return {
          state: 'stopped',
          source: 'synthetic',
          transport: 'unavailable',
          backing: 'none',
          targetFps: 30,
          width: 0,
          height: 0,
          framesRendered: 0,
          droppedFrames: 0,
          framePollingSuppressed: false,
          sourcePixelsPresent: false,
          pendingHostCommandCount: 0,
          updatedAt: now
        }
      case 'preview.surface.create':
      case 'preview.surface.update_bounds':
        return nativePreviewStatus(params.bounds as PreviewSurfaceBounds)
      case 'preview.surface.take_native_host_commands':
        throw new Error('Renderer attempted to use the main-only native host command drain.')
      case 'preview.camera.status':
        return {
          state: 'failed',
          targetFps: 30,
          framesCaptured: 0,
          droppedFrames: 0,
          updatedAt: now
        }
      case 'preview.screen.status':
        return {
          state: 'failed',
          targetFps: 30,
          framesCaptured: 0,
          droppedFrames: 0,
          includeCursor: true,
          excludeCurrentProcessWindows: true,
          updatedAt: now
        }
      case 'scene.get':
        return this.currentScene
      case 'compositor.status':
        return compositorFor(this.currentScene, this.currentLayout, this.revision)
      case 'scene.load_from_capture_config':
        return {
          applied: true,
          mode: 'idle',
          sceneRevision: this.revision,
          scene: this.currentScene,
          compositorStatus: compositorFor(this.currentScene, this.currentLayout, this.revision)
        }
      case 'scene.layout.apply_preview':
      case 'scene.layout.apply_live': {
        this.currentLayout = params.layout as LayoutSettings
        this.currentScene = sceneForLayout(this.currentLayout)
        this.revision += 1
        return {
          applied: true,
          mode: command.method.endsWith('live') ? 'hot' : 'idle',
          intentId: params.intentId,
          sceneRevision: this.revision,
          presentationProven: true,
          scene: this.currentScene,
          compositorStatus: compositorFor(this.currentScene, this.currentLayout, this.revision)
        }
      }
      case 'screens.list':
        return []
      case 'screens.active':
        return null
      case 'streamTargets.metadata.get':
        return {
          title: '',
          description: '',
          defaultPrivacy: 'unlisted',
          targetOverrides: [],
          updatedAt: now
        }
      case 'streamTargets.metadata.validate':
        return { valid: true, issues: [] }
      case 'sessions.list':
        return { items: this.sessionSummaries, nextCursor: this.sessionListNextCursor }
      case 'sessions.healthEvents.list':
        if (this.sessionDetailFailuresRemaining > 0) {
          this.sessionDetailFailuresRemaining -= 1
          throw new Error('Session detail history is temporarily unavailable.')
        }
        return { events: this.sessionHealthEvents }
      case 'sessions.logs.list':
        return { entries: this.sessionLogs }
      case 'sessions.aiArtifacts.list':
        return { artifacts: this.sessionAiArtifacts }
      case 'sessions.delete': {
        const deletedSessionIds = new Set(params.sessionIds as string[])
        this.noiseCleanupJobs = this.noiseCleanupJobs.map((job) =>
          job.status === 'completed' &&
          job.outputSessionId &&
          deletedSessionIds.has(job.outputSessionId)
            ? cleanupJob({
                ...job,
                status: 'failed',
                progressPercent: 0,
                outputSessionId: undefined,
                outputPath: undefined,
                errorCode: 'file-missing',
                errorMessage: 'The cleaned recording was deleted.',
                updatedAt: '2026-07-12T00:00:04.000Z'
              })
            : job
        )
        return []
      }
      case 'sessions.delete.pending':
        return []
      case 'sessions.storage':
        return { count: 0, totalBytes: 0 }
      case 'session.remux_mp4':
        this.invalidateCompletedNoiseCleanup('The source recording changed after remux.')
        return null
      case 'repair.repair_file':
        this.invalidateCompletedNoiseCleanup('The source recording changed after repair.')
        return {
          status: 'repaired',
          path: 'C:\\recordings\\session-1.mkv',
          interpolated: false
        }
      case 'repair.restore_file':
        this.invalidateCompletedNoiseCleanup('The source recording changed after restore.')
        return { restored: true }
      case 'noiseCleanup.list':
        return this.noiseCleanupJobs
      case 'noiseCleanup.start': {
        const job = cleanupJob({ sourceSessionId: String(params.sessionId) })
        this.noiseCleanupJobs = [job]
        return job
      }
      case 'noiseCleanup.cancel': {
        const current = this.noiseCleanupJobs.find((job) => job.id === params.jobId) ?? cleanupJob()
        const job = cleanupJob({
          ...current,
          status: 'cancelled',
          updatedAt: '2026-07-12T00:00:01.000Z'
        })
        this.noiseCleanupJobs = [job]
        return job
      }
      case 'platformAccounts.list':
      case 'platformAccounts.validate':
      case 'platformAccounts.oauth.providerCredentials':
        return []
      case 'platformAccounts.oauth.complete':
        if (this.oauthCompletedStates.has(String(params.state))) {
          return {
            state: params.state,
            status: 'unknown-state',
            codePresent: true,
            tokenStored: false,
            accountConnected: false,
            retryable: false,
            message: 'OAuth callback state is not recognized.',
            receivedAt: now
          }
        }
        if (this.oauthTransportFailuresRemaining > 0) {
          this.oauthTransportFailuresRemaining -= 1
          throw new Error('Temporary OAuth RPC transport failure.')
        }
        if (this.oauthRetryFailuresRemaining > 0) {
          this.oauthRetryFailuresRemaining -= 1
          return {
            platform: 'twitch',
            state: params.state,
            status: 'failed',
            codePresent: true,
            tokenStored: false,
            accountConnected: false,
            retryable: true,
            message: 'Temporary provider failure.',
            receivedAt: now
          }
        }
        this.oauthCompletedStates.add(String(params.state))
        return {
          platform: 'twitch',
          state: params.state,
          status: 'success',
          codePresent: true,
          tokenStored: true,
          accountConnected: true,
          retryable: false,
          receivedAt: now
        }
      case 'events.setIncluded':
      case 'events.setExcluded':
        return null
      case 'audio.processing.update':
        return {
          sessionId: params.sessionId,
          applied: this.audioProcessingReasonCode === null,
          microphoneGainDb: params.microphoneGainDb,
          microphoneMuted: params.microphoneMuted,
          ...(this.audioProcessingReasonCode ? { reasonCode: this.audioProcessingReasonCode } : {})
        }
      case 'session.start':
        this.recordingState = 'recording'
        return {
          state: 'recording',
          sessionId: 'session-1',
          startedAt: now,
          message: 'Recording.'
        }
      case 'session.stop':
        this.recordingState = 'idle'
        return {
          state: 'idle',
          sessionId: 'session-1',
          outputPath: 'C:\\recordings\\session-1.mkv',
          durationMs: 1_000,
          message: 'Saved.'
        }
      default:
        return null
    }
  }
}

class TestWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static backend: StudioBackend
  static nextGeneration = 0

  readyState = TestWebSocket.OPEN
  readonly backend: StudioBackend
  readonly generation: number
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    this.backend = TestWebSocket.backend
    this.generation = ++TestWebSocket.nextGeneration
    this.backend.sockets.push(this)
    queueMicrotask(() => this.onopen?.())
  }

  send(raw: string): void {
    if (this.readyState !== TestWebSocket.OPEN) {
      throw new Error(`Test WebSocket generation ${this.generation} is closed.`)
    }
    const command = JSON.parse(raw) as BackendCommand
    this.backend.sentCommands.push(command)
    const deferredResponse = this.backend.takeDeferredResponse(command.method, command)
    if (command.method === 'session.start' && this.backend.emitRecordingStatusBeforeStartResponse) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            event: 'recording.status',
            payload: {
              state: 'recording',
              sessionId: 'session-1',
              startedAt: now,
              message: 'Recording.'
            }
          })
        })
      })
    }
    const respond = (payloadOverride?: unknown): void => {
      if (this.readyState !== TestWebSocket.OPEN) {
        return
      }
      try {
        if (deferredResponse) {
          this.backend.commands.push(command)
        }
        this.onmessage?.({
          data: JSON.stringify({
            id: command.id,
            ok: true,
            payload: deferredResponse ? payloadOverride : this.backend.response(command)
          })
        })
      } catch (error) {
        this.onmessage?.({
          data: JSON.stringify({
            id: command.id,
            ok: false,
            error: {
              code:
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                typeof error.code === 'string'
                  ? error.code
                  : 'test-error',
              message: error instanceof Error ? error.message : String(error)
            }
          })
        })
      }
    }
    const responseDelayMs = command.method.startsWith('scene.layout.apply_')
      ? this.backend.layoutResponseDelayMs
      : command.method === 'session.start'
        ? this.backend.sessionStartResponseDelayMs
        : command.method === 'audio.processing.update'
          ? this.backend.audioProcessingResponseDelayMs
          : 0
    if (deferredResponse) {
      void deferredResponse.ready.then(() => respond(deferredResponse.payload))
    } else if (responseDelayMs > 0) {
      setTimeout(respond, responseDelayMs)
    } else {
      queueMicrotask(respond)
    }
  }

  close(): void {
    if (this.readyState === TestWebSocket.CLOSED) return
    this.readyState = TestWebSocket.CLOSED
    this.onclose?.()
  }
}

type StudioObservation = {
  audio: ReturnType<typeof useStudioAudio>
  core: StudioCoreContextValue
  recording: StudioRecordingContextValue
}

function Probe({ observe }: { observe: (value: StudioObservation) => void }): null {
  const audio = useStudioAudio()
  const core = useStudioCore()
  const recording = useStudioRecording()
  useEffect(() => observe({ audio, core, recording }), [audio, core, observe, recording])
  return null
}

describe('real StudioProvider lifecycle', () => {
  let restoreEnvironment: (() => void) | undefined
  let root: Root | null = null

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    restoreEnvironment?.()
    restoreEnvironment = undefined
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('coalesces duplicate session-detail refreshes and settles a retryable error', async () => {
    const backend = new StudioBackend()
    backend.sessionSummaries = [sessionSummary()]
    backend.sessionDetailFailuresRemaining = 1
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () => latest()?.core.wsStatus === 'connected' && latest()?.core.sessions.length === 1
    )

    await act(async () => {
      const first = latest()!.core.loadSessionDetails('session-1')
      const duplicate = latest()!.core.loadSessionDetails('session-1')
      await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined])
    })
    await waitForObservation(() => latest()?.core.sessionDetailError?.sessionId === 'session-1')

    expect(latest()?.core.sessionDetailsLoading.has('session-1')).toBe(false)
    expect(latest()?.core.sessionDetailError?.message).toContain(
      'Session detail history is temporarily unavailable.'
    )
    expect(latest()?.core.lastError).toContain('Session detail history is temporarily unavailable.')
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method.startsWith('sessions.') &&
          command.method !== 'sessions.list' &&
          command.method !== 'sessions.storage'
      )
    ).toHaveLength(3)
  })

  it('ignores a stale load-more response after the first Library page refreshes', async () => {
    const backend = new StudioBackend()
    backend.sessionSummaries = [
      sessionSummary({ id: 'session-3', title: 'Session 3' }),
      sessionSummary({ id: 'session-2', title: 'Session 2' })
    ]
    backend.sessionListNextCursor = 'cursor-old'
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.sessionsNextCursor === 'cursor-old'
    )

    const releaseStalePage = backend.deferResponse('sessions.list', {
      items: [sessionSummary({ id: 'session-1', title: 'Session 1' })],
      nextCursor: 'cursor-stale-tail'
    })
    let staleLoadMore!: Promise<void>
    await act(async () => {
      staleLoadMore = latest()!.core.loadMoreSessions()
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(
        backend.sentCommands.some(
          (command) =>
            command.method === 'sessions.list' &&
            (command.params as { cursor?: string } | undefined)?.cursor === 'cursor-old'
        )
      ).toBe(true)
    )

    backend.sessionSummaries = [
      sessionSummary({ id: 'session-4', title: 'Session 4' }),
      sessionSummary({ id: 'session-3', title: 'Session 3' })
    ]
    backend.sessionListNextCursor = 'cursor-fresh'
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: { state: 'idle', message: 'Ready.' }
        })
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () =>
        latest()
          ?.core.sessions.map((session) => session.id)
          .join(',') === 'session-4,session-3' &&
        latest()?.core.sessionsNextCursor === 'cursor-fresh'
    )

    await act(async () => {
      releaseStalePage()
      await staleLoadMore
    })

    expect(latest()?.core.sessions.map((session) => session.id)).toEqual(['session-4', 'session-3'])
    expect(latest()?.core.sessionsNextCursor).toBe('cursor-fresh')
    expect(latest()?.core.sessionsLoadingMore).toBe(false)
  })

  it('does not let a stale focus refresh replace a newer Library first page', async () => {
    const backend = new StudioBackend()
    backend.sessionSummaries = [
      sessionSummary({ id: 'session-3', title: 'Session 3' }),
      sessionSummary({ id: 'session-2', title: 'Session 2' })
    ]
    backend.sessionListNextCursor = 'cursor-old'
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.sessionsNextCursor === 'cursor-old'
    )

    const releaseStaleFocusPage = backend.deferResponse('sessions.list', {
      items: [sessionSummary({ id: 'session-1', title: 'Session 1' })],
      nextCursor: 'cursor-stale'
    })
    let staleFocusRefresh!: Promise<void>
    await act(async () => {
      staleFocusRefresh = latest()!.core.refreshBackend()
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(
        backend.sentCommands.filter((command) => command.method === 'sessions.list')
      ).toHaveLength(2)
    )

    backend.sessionSummaries = [
      sessionSummary({ id: 'session-4', title: 'Session 4' }),
      sessionSummary({ id: 'session-3', title: 'Session 3' })
    ]
    backend.sessionListNextCursor = 'cursor-fresh'
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: { state: 'idle', message: 'Ready.' }
        })
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () =>
        latest()
          ?.core.sessions.map((session) => session.id)
          .join(',') === 'session-4,session-3' &&
        latest()?.core.sessionsNextCursor === 'cursor-fresh'
    )

    await act(async () => {
      releaseStaleFocusPage()
      await staleFocusRefresh
    })

    expect(latest()?.core.sessions.map((session) => session.id)).toEqual(['session-4', 'session-3'])
    expect(latest()?.core.sessionsNextCursor).toBe('cursor-fresh')
  })

  it('merges health and log events during detail load without another RPC batch', async () => {
    const backend = new StudioBackend()
    backend.sessionSummaries = [sessionSummary()]
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () => latest()?.core.wsStatus === 'connected' && latest()?.core.sessions.length === 1
    )

    const releaseHealth = backend.deferResponse('sessions.healthEvents.list', { events: [] })
    const releaseLogs = backend.deferResponse('sessions.logs.list', { entries: [] })
    const releaseArtifacts = backend.deferResponse('sessions.aiArtifacts.list', { artifacts: [] })
    let detailLoad!: Promise<void>
    await act(async () => {
      detailLoad = latest()!.core.loadSessionDetails('session-1')
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(
        backend.sentCommands.filter((command) =>
          [
            'sessions.healthEvents.list',
            'sessions.logs.list',
            'sessions.aiArtifacts.list'
          ].includes(command.method)
        )
      ).toHaveLength(3)
    )

    const healthEvent: HealthEvent = {
      id: 'health-live',
      sessionId: 'session-1',
      level: 'warn',
      code: 'live-health',
      message: 'Health arrived while details were loading.',
      permissionPane: null,
      createdAt: '2026-07-12T00:00:01.000Z'
    }
    const logEntry: SessionLogEntry = {
      id: 'log-live',
      sessionId: 'session-1',
      level: 'info',
      code: 'live-log',
      message: 'Log arrived while details were loading.',
      sourceId: null,
      permissionPane: null,
      createdAt: '2026-07-12T00:00:01.000Z'
    }
    backend.sessionHealthEvents = [healthEvent]
    backend.sessionLogs = [logEntry]
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({ event: 'health.event', payload: healthEvent })
        })
        socket.onmessage?.({
          data: JSON.stringify({ event: 'session.log', payload: logEntry })
        })
      }
      await Promise.resolve()
    })
    expect(latest()?.core.sessions[0]?.healthEventCount).toBe(1)
    expect(latest()?.core.sessions[0]?.sessionLogCount).toBe(1)

    await act(async () => {
      releaseHealth()
      releaseLogs()
      releaseArtifacts()
      await detailLoad
    })

    expect(latest()?.core.sessionDetails['session-1']?.healthEvents).toEqual([healthEvent])
    expect(latest()?.core.sessionDetails['session-1']?.sessionLogs).toEqual([logEntry])
    expect(
      backend.sentCommands.filter((command) =>
        ['sessions.healthEvents.list', 'sessions.logs.list', 'sessions.aiArtifacts.list'].includes(
          command.method
        )
      )
    ).toHaveLength(3)
  })

  it('runs one trailing detail refresh when AI artifacts change during a load', async () => {
    const backend = new StudioBackend()
    backend.sessionSummaries = [sessionSummary()]
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () => latest()?.core.wsStatus === 'connected' && latest()?.core.sessions.length === 1
    )
    await act(async () => latest()!.core.loadSessionDetails('session-1'))

    const releaseHealth = backend.deferResponse('sessions.healthEvents.list', { events: [] })
    const releaseLogs = backend.deferResponse('sessions.logs.list', { entries: [] })
    const releaseArtifacts = backend.deferResponse('sessions.aiArtifacts.list', { artifacts: [] })
    let detailReload!: Promise<void>
    await act(async () => {
      detailReload = latest()!.core.loadSessionDetails('session-1')
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(
        backend.sentCommands.filter((command) =>
          [
            'sessions.healthEvents.list',
            'sessions.logs.list',
            'sessions.aiArtifacts.list'
          ].includes(command.method)
        )
      ).toHaveLength(6)
    )

    const artifact: AiArtifact = {
      id: 'artifact-live',
      sessionId: 'session-1',
      kind: 'summary',
      status: 'ready',
      content: { text: 'Fresh summary' },
      filePath: null,
      createdAt: '2026-07-12T00:00:02.000Z'
    }
    backend.sessionAiArtifacts = [artifact]
    backend.sessionSummaries = [sessionSummary({ aiArtifactCount: 1 })]
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'ai.artifacts.changed',
            payload: { sessionId: 'session-1' }
          })
        })
      }
      await Promise.resolve()
    })

    const releaseTrailingHealth = backend.deferResponse('sessions.healthEvents.list', {
      events: []
    })
    const releaseTrailingLogs = backend.deferResponse('sessions.logs.list', { entries: [] })
    const releaseTrailingArtifacts = backend.deferResponse('sessions.aiArtifacts.list', {
      artifacts: [artifact]
    })
    await act(async () => {
      releaseHealth()
      releaseLogs()
      releaseArtifacts()
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(
        backend.sentCommands.filter((command) =>
          [
            'sessions.healthEvents.list',
            'sessions.logs.list',
            'sessions.aiArtifacts.list'
          ].includes(command.method)
        )
      ).toHaveLength(9)
    )

    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'ai.artifacts.changed',
            payload: { sessionId: 'session-1' }
          })
        })
      }
      await Promise.resolve()
    })
    await act(async () => {
      releaseTrailingHealth()
      releaseTrailingLogs()
      releaseTrailingArtifacts()
      await detailReload
    })

    expect(latest()?.core.sessionDetails['session-1']?.aiArtifacts).toEqual([artifact])
    expect(
      backend.sentCommands.filter((command) =>
        ['sessions.healthEvents.list', 'sessions.logs.list', 'sessions.aiArtifacts.list'].includes(
          command.method
        )
      )
    ).toHaveLength(9)
  })

  it('keeps replacement detail buffers when an invalidated request settles late', async () => {
    const backend = new StudioBackend()
    backend.sessionSummaries = [sessionSummary()]
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () => latest()?.core.wsStatus === 'connected' && latest()?.core.sessions.length === 1
    )
    await act(async () => latest()!.core.loadSessionDetails('session-1'))

    const matchesSessionOne = (command: BackendCommand): boolean =>
      (command.params as { sessionId?: string } | undefined)?.sessionId === 'session-1'
    const detailCommandCount = (): number =>
      backend.sentCommands.filter(
        (command) =>
          matchesSessionOne(command) &&
          [
            'sessions.healthEvents.list',
            'sessions.logs.list',
            'sessions.aiArtifacts.list'
          ].includes(command.method)
      ).length

    const releaseOldHealth = backend.deferResponse(
      'sessions.healthEvents.list',
      { events: [] },
      matchesSessionOne
    )
    const releaseOldLogs = backend.deferResponse(
      'sessions.logs.list',
      { entries: [] },
      matchesSessionOne
    )
    const releaseOldArtifacts = backend.deferResponse(
      'sessions.aiArtifacts.list',
      { artifacts: [] },
      matchesSessionOne
    )
    let invalidatedLoad!: Promise<void>
    await act(async () => {
      invalidatedLoad = latest()!.core.loadSessionDetails('session-1')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(detailCommandCount()).toBe(6))

    // Fill the bounded detail LRU through the public provider API. Committing
    // session 9 evicts session 1 and invalidates its still-pending request.
    for (let session = 2; session <= 9; session += 1) {
      await act(async () => latest()!.core.loadSessionDetails(`session-${session}`))
    }
    expect(latest()?.core.sessionDetails['session-1']).toBeUndefined()

    const releaseNewHealth = backend.deferResponse(
      'sessions.healthEvents.list',
      { events: [] },
      matchesSessionOne
    )
    const releaseNewLogs = backend.deferResponse(
      'sessions.logs.list',
      { entries: [] },
      matchesSessionOne
    )
    const releaseNewArtifacts = backend.deferResponse(
      'sessions.aiArtifacts.list',
      { artifacts: [] },
      matchesSessionOne
    )
    let replacementLoad!: Promise<void>
    await act(async () => {
      replacementLoad = latest()!.core.loadSessionDetails('session-1')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(detailCommandCount()).toBe(9))

    const healthEvent: HealthEvent = {
      id: 'health-replacement',
      sessionId: 'session-1',
      level: 'warn',
      code: 'replacement-health',
      message: 'Health arrived for the replacement request.',
      permissionPane: null,
      createdAt: '2026-07-12T00:00:03.000Z'
    }
    const logEntry: SessionLogEntry = {
      id: 'log-replacement',
      sessionId: 'session-1',
      level: 'info',
      code: 'replacement-log',
      message: 'Log arrived for the replacement request.',
      sourceId: null,
      permissionPane: null,
      createdAt: '2026-07-12T00:00:03.000Z'
    }
    const artifact: AiArtifact = {
      id: 'artifact-replacement',
      sessionId: 'session-1',
      kind: 'summary',
      status: 'ready',
      content: { text: 'Replacement summary' },
      filePath: null,
      createdAt: '2026-07-12T00:00:03.000Z'
    }
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'health.event', payload: healthEvent })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'session.log', payload: logEntry })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'ai.artifacts.changed',
          payload: { sessionId: 'session-1' }
        })
      })
      await Promise.resolve()
    })

    await act(async () => {
      releaseOldHealth()
      releaseOldLogs()
      releaseOldArtifacts()
      await invalidatedLoad
    })

    const releaseTrailingHealth = backend.deferResponse(
      'sessions.healthEvents.list',
      { events: [healthEvent] },
      matchesSessionOne
    )
    const releaseTrailingLogs = backend.deferResponse(
      'sessions.logs.list',
      { entries: [logEntry] },
      matchesSessionOne
    )
    const releaseTrailingArtifacts = backend.deferResponse(
      'sessions.aiArtifacts.list',
      { artifacts: [artifact] },
      matchesSessionOne
    )
    await act(async () => {
      releaseNewHealth()
      releaseNewLogs()
      releaseNewArtifacts()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(detailCommandCount()).toBe(12))

    await act(async () => {
      releaseTrailingHealth()
      releaseTrailingLogs()
      releaseTrailingArtifacts()
      await replacementLoad
    })

    expect(latest()?.core.sessionDetails['session-1']).toEqual({
      healthEvents: [healthEvent],
      sessionLogs: [logEntry],
      aiArtifacts: [artifact]
    })
  })

  it('requests fresh macOS camera access, then routes a denial to System Settings', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let cameraStatus: 'not-determined' | 'denied' = 'not-determined'
    const requestMediaAccess = vi.fn(async () => {
      cameraStatus = 'denied'
      return { granted: false, restarted: false }
    })
    const openSystemPermissions = vi.fn(async () => undefined)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      getMediaAccessStatus: async () => ({
        camera: cameraStatus,
        microphone: 'granted'
      }),
      requestMediaAccess,
      openSystemPermissions
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.mediaAccess?.camera === 'not-determined'
    )

    await act(async () => {
      await latest()?.core.handleSystemPermission('camera')
    })
    await waitForObservation(() => latest()?.core.mediaAccess?.camera === 'denied')
    expect(requestMediaAccess).toHaveBeenCalledOnce()
    expect(requestMediaAccess).toHaveBeenCalledWith('camera')
    expect(openSystemPermissions).not.toHaveBeenCalled()

    await act(async () => {
      await latest()?.core.handleSystemPermission('camera')
    })
    expect(requestMediaAccess).toHaveBeenCalledOnce()
    expect(openSystemPermissions).toHaveBeenCalledOnce()
    expect(openSystemPermissions).toHaveBeenCalledWith('camera')
  })

  it('executes remote intents through the same handlers and acks them', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      getMediaAccessStatus: async () => ({
        camera: 'not-determined',
        microphone: 'granted'
      }),
      requestMediaAccess: vi.fn(async () => ({ granted: false, restarted: false })),
      openSystemPermissions: vi.fn(async () => undefined)
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')

    const micBefore = latest()?.core.captureConfig.audio.microphoneMuted ?? false
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: { intentId: 'ri-test-1', intent: { kind: 'micToggle' } }
          })
        })
      }
    })
    await waitForObservation(
      () => latest()?.core.captureConfig.audio.microphoneMuted === !micBefore
    )
    // The renderer must ack the executed intent so deck keys learn the result.
    const ack = backend.sentCommands.find((command) => command.method === 'remote.intent.ack')
    expect(ack?.params).toMatchObject({ intentId: 'ri-test-1', ok: true })
  })

  it('never revokes persisted cloud-AI consent when readiness is not ready', async () => {
    // 2026-07-16 owner incident: an effect silently flipped the consent
    // toggle off whenever cloud AI readiness was not ready (signed-out,
    // server unconfigured, ...), which also made the run-time readiness
    // error toast unreachable — every AI run downgraded to local-only with
    // no visible reason. Consent is the user's durable intent: readiness
    // gates the RUN, never the stored preference.
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      getMediaAccessStatus: async () => ({
        camera: 'not-determined',
        microphone: 'granted'
      }),
      requestMediaAccess: vi.fn(async () => ({ granted: false, restarted: false })),
      openSystemPermissions: vi.fn(async () => undefined)
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    localStorage.setItem('videorc.aiConsent', '1')
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')

    // No account is signed in on this fake backend, so cloud AI readiness is
    // NOT ready — and the persisted consent must survive untouched. (The
    // removed auto-revoke effect flipped it to '0' on mount.)
    expect(localStorage.getItem('videorc.aiConsent')).toBe('1')
  })

  it('does not reuse a stale permission snapshot when the click-time status read fails', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let statusReadAvailable = true
    const requestMediaAccess = vi.fn(async () => ({ granted: false, restarted: false }))
    const openSystemPermissions = vi.fn(async () => undefined)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      getMediaAccessStatus: async () => {
        if (!statusReadAvailable) {
          throw new Error('TCC status read failed')
        }
        return { camera: 'not-determined', microphone: 'granted' }
      },
      requestMediaAccess,
      openSystemPermissions
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.mediaAccess?.camera === 'not-determined'
    )

    statusReadAvailable = false
    await act(async () => {
      await latest()?.core.handleSystemPermission('camera')
    })

    expect(requestMediaAccess).not.toHaveBeenCalled()
    expect(openSystemPermissions).not.toHaveBeenCalled()
    expect(toastSpies.error).toHaveBeenCalledWith('Could not check Camera permission.', {
      description: 'Try again before changing access.'
    })
  })

  it('clears stale microphone evidence before opening System Settings', async () => {
    const backend = new StudioBackend()
    backend.audioMeterResult = {
      status: 'permission-required',
      message: 'Microphone permission is required.'
    }
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const requestMediaAccess = vi.fn(async () => ({ granted: false, restarted: false }))
    const openSystemPermissions = vi.fn(async () => undefined)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      getMediaAccessStatus: async () => ({ camera: 'granted', microphone: 'denied' }),
      requestMediaAccess,
      openSystemPermissions
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.mediaAccess?.microphone === 'denied'
    )
    await act(async () => {
      await latest()?.core.sampleAudioMeter()
    })
    await waitForObservation(() => latest()?.audio.audioMeter?.status === 'permission-required')

    await act(async () => {
      await latest()?.core.handleSystemPermission('microphone')
    })

    expect(latest()?.audio.audioMeter).toBeNull()
    expect(openSystemPermissions).toHaveBeenCalledWith('microphone')
    expect(requestMediaAccess).not.toHaveBeenCalled()
  })

  it('refreshes exact permission and devices through the reconnected backend after a grant', async () => {
    const initialBackend = new StudioBackend()
    const reconnectedBackend = new StudioBackend()
    TestWebSocket.backend = initialBackend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let cameraStatus: 'not-determined' | 'granted' = 'not-determined'
    let emit: ((name: string, value: unknown) => void) | undefined
    const requestMediaAccess = vi.fn(async () => {
      cameraStatus = 'granted'
      TestWebSocket.backend = reconnectedBackend
      queueMicrotask(() => {
        emit?.('backend:connection', {
          host: '127.0.0.1',
          port: 9989,
          token: 'restarted-test-token'
        })
      })
      return { granted: true, restarted: true }
    })
    const openSystemPermissions = vi.fn(async () => undefined)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      getMediaAccessStatus: async () => ({
        camera: cameraStatus,
        microphone: 'granted'
      }),
      requestMediaAccess,
      openSystemPermissions,
      registerEmitter: (nextEmit) => {
        emit = nextEmit
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.mediaAccess?.camera === 'not-determined'
    )
    const devicesBefore = initialBackend.commands.filter(
      (command) => command.method === 'devices.list'
    ).length

    let permissionAction: Promise<void> | undefined
    act(() => {
      permissionAction = latest()?.core.handleSystemPermission('camera')
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' && latest()?.core.mediaAccess?.camera === 'granted'
    )
    await act(async () => {
      await permissionAction
    })

    expect(requestMediaAccess).toHaveBeenCalledOnce()
    expect(openSystemPermissions).not.toHaveBeenCalled()
    expect(
      initialBackend.commands.filter((command) => command.method === 'devices.list').length
    ).toBe(devicesBefore)
    expect(
      reconnectedBackend.commands.filter((command) => command.method === 'devices.list').length
    ).toBeGreaterThan(0)
    expect(
      initialBackend.sockets.every((socket) => socket.readyState === TestWebSocket.CLOSED)
    ).toBe(true)

    await act(async () => {
      await latest()?.core.handleSystemPermission('camera')
    })
    expect(requestMediaAccess).toHaveBeenCalledOnce()
    expect(openSystemPermissions).not.toHaveBeenCalled()
  })

  it('waits past a prompt-time backend generation that the permission restart retires', async () => {
    const initialBackend = new StudioBackend()
    const promptBackend = new StudioBackend()
    const restartedBackend = new StudioBackend()
    TestWebSocket.backend = initialBackend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let cameraStatus: 'not-determined' | 'granted' = 'not-determined'
    let emit: ((name: string, value: unknown) => void) | undefined
    let resolveRequest:
      | ((value: Awaited<ReturnType<NonNullable<VideorcApi['requestMediaAccess']>>>) => void)
      | undefined
    const requestMediaAccess = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<NonNullable<VideorcApi['requestMediaAccess']>>>>(
          (resolve) => {
            resolveRequest = resolve
          }
        )
    )
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      backendConnection: { host: '127.0.0.1', port: 9988, token: 'initial', pid: 101 },
      getMediaAccessStatus: async () => ({
        camera: cameraStatus,
        microphone: 'granted'
      }),
      requestMediaAccess,
      registerEmitter: (nextEmit) => {
        emit = nextEmit
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.mediaAccess?.camera === 'not-determined'
    )

    let permissionAction: Promise<void> | undefined
    act(() => {
      permissionAction = latest()?.core.handleSystemPermission('camera')
    })
    await waitForObservation(() => requestMediaAccess.mock.calls.length === 1)

    TestWebSocket.backend = promptBackend
    await act(async () => {
      emit?.('backend:connection', {
        host: '127.0.0.1',
        port: 9989,
        token: 'prompt-generation',
        pid: 202
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        promptBackend.commands.some((command) => command.method === 'devices.list')
    )

    let actionSettled = false
    void permissionAction?.then(() => {
      actionSettled = true
    })
    cameraStatus = 'granted'
    await act(async () => {
      resolveRequest?.({
        granted: true,
        restarted: true,
        staleBackend: { port: 9989, pid: 202 }
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(actionSettled).toBe(false)

    TestWebSocket.backend = restartedBackend
    await act(async () => {
      emit?.('backend:connection', {
        host: '127.0.0.1',
        port: 9990,
        token: 'post-grant-generation',
        pid: 303
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        restartedBackend.commands.some((command) => command.method === 'devices.list')
    )
    await act(async () => {
      await permissionAction
    })

    expect(restartedBackend.commands.some((command) => command.method === 'devices.list')).toBe(
      true
    )
    expect(actionSettled).toBe(true)
  })

  it('samples the microphone only after a fresh grant has reconnected and refreshed devices', async () => {
    const initialBackend = new StudioBackend()
    const reconnectedBackend = new StudioBackend()
    TestWebSocket.backend = initialBackend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let microphoneStatus: 'not-determined' | 'granted' = 'not-determined'
    let emit: ((name: string, value: unknown) => void) | undefined
    const requestMediaAccess = vi.fn(async () => {
      microphoneStatus = 'granted'
      TestWebSocket.backend = reconnectedBackend
      queueMicrotask(() => {
        emit?.('backend:connection', {
          host: '127.0.0.1',
          port: 9990,
          token: 'microphone-restart-token'
        })
      })
      return { granted: true, restarted: true }
    })
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      getMediaAccessStatus: async () => ({
        camera: 'granted',
        microphone: microphoneStatus
      }),
      requestMediaAccess,
      registerEmitter: (nextEmit) => {
        emit = nextEmit
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.mediaAccess?.microphone === 'not-determined' &&
        latest()?.core.canSampleAudio === true
    )

    let permissionAction: Promise<void> | undefined
    act(() => {
      permissionAction = latest()?.core.handleSystemPermission('microphone')
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.mediaAccess?.microphone === 'granted'
    )
    await act(async () => {
      await permissionAction
    })

    const commandMethods = reconnectedBackend.commands.map((command) => command.method)
    const deviceRefreshIndex = commandMethods.lastIndexOf('devices.list')
    const meterSampleIndex = commandMethods.lastIndexOf('audio.meter.sample')
    expect(requestMediaAccess).toHaveBeenCalledWith('microphone')
    expect(deviceRefreshIndex).toBeGreaterThan(-1)
    expect(meterSampleIndex).toBeGreaterThan(deviceRefreshIndex)
    expect(initialBackend.commands.some((command) => command.method === 'audio.meter.sample')).toBe(
      false
    )
    expect(
      initialBackend.sockets.every((socket) => socket.readyState === TestWebSocket.CLOSED)
    ).toBe(true)
  })

  it('invalidates stale microphone evidence and defers proof to the eventual backend generation', async () => {
    const initialBackend = new StudioBackend()
    initialBackend.deviceList = {
      ...initialBackend.deviceList,
      devices: initialBackend.deviceList.devices.map((device) =>
        device.kind === 'microphone'
          ? {
              ...device,
              status: 'permission-required',
              detail: 'Microphone permission is required.'
            }
          : device
      )
    }
    initialBackend.audioMeterResult = {
      status: 'permission-required',
      message: 'Microphone permission is required.'
    }
    TestWebSocket.backend = initialBackend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let microphoneStatus: 'not-determined' | 'granted' = 'not-determined'
    let emit: ((name: string, value: unknown) => void) | undefined
    const requestMediaAccess = vi.fn(async () => {
      microphoneStatus = 'granted'
      return {
        granted: true,
        restarted: false,
        staleBackend: { port: 9988, pid: 401 }
      }
    })
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      backendConnection: { host: '127.0.0.1', port: 9988, token: 'initial', pid: 401 },
      getMediaAccessStatus: async () => ({
        camera: 'granted',
        microphone: microphoneStatus
      }),
      requestMediaAccess,
      registerEmitter: (nextEmit) => {
        emit = nextEmit
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.mediaAccess?.microphone === 'not-determined'
    )
    await act(async () => {
      await latest()?.core.sampleAudioMeter()
    })
    await waitForObservation(() => latest()?.audio.audioMeter?.status === 'permission-required')
    const initialDeviceRefreshes = initialBackend.commands.filter(
      (command) => command.method === 'devices.list'
    ).length

    await act(async () => {
      await latest()?.core.handleSystemPermission('microphone')
    })

    expect(requestMediaAccess).toHaveBeenCalledWith('microphone')
    expect(latest()?.core.mediaAccess?.microphone).toBe('granted')
    expect(latest()?.audio.audioMeter).toBeNull()
    expect(
      initialBackend.commands.filter((command) => command.method === 'devices.list').length
    ).toBe(initialDeviceRefreshes)

    const reconnectedBackend = new StudioBackend()
    reconnectedBackend.deviceListFailuresRemaining = 3
    reconnectedBackend.audioMeterFailuresRemaining = 1
    TestWebSocket.backend = reconnectedBackend
    act(() => {
      emit?.('backend:connection', {
        host: '127.0.0.1',
        port: 9991,
        token: 'deferred-microphone-restart-token'
      })
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' && latest()?.audio.audioMeter?.status === 'ready'
    )

    const reconnectedMethods = reconnectedBackend.commands.map((command) => command.method)
    expect(
      reconnectedMethods.filter((method) => method === 'devices.list').length
    ).toBeGreaterThanOrEqual(4)
    expect(reconnectedMethods.lastIndexOf('audio.meter.sample')).toBeGreaterThan(
      reconnectedMethods.lastIndexOf('devices.list')
    )
    expect(reconnectedMethods.filter((method) => method === 'audio.meter.sample').length).toBe(2)
    expect(
      initialBackend.sockets.every((socket) => socket.readyState === TestWebSocket.CLOSED)
    ).toBe(true)
    expect(
      reconnectedBackend.sockets.every((socket) => socket.backend === reconnectedBackend)
    ).toBe(true)
  })

  it('boots, commits a layout, records, stops, and acknowledges a bound account callback', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const acknowledgedCallbacks: string[] = []
    const acknowledgedProviderCallbacks: string[] = []
    let providerAcknowledgementFailuresRemaining = 1
    let pendingCallbacks = [callbackEnvelope]
    let pendingProviderCallbacks = [providerCallbackEnvelope]
    const api = createVideorcApi({
      acknowledge: async (id) => {
        acknowledgedCallbacks.push(id)
        pendingCallbacks = pendingCallbacks.filter((item) => item.id !== id)
        return true
      },
      pending: async () => pendingCallbacks,
      acknowledgeProvider: async (id) => {
        if (providerAcknowledgementFailuresRemaining > 0) {
          providerAcknowledgementFailuresRemaining -= 1
          throw new Error('Temporary OAuth acknowledgement persistence failure.')
        }
        acknowledgedProviderCallbacks.push(id)
        pendingProviderCallbacks = pendingProviderCallbacks.filter((item) => item.id !== id)
        return true
      },
      pendingProvider: async () => pendingProviderCallbacks
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore

    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    const observe = (value: StudioObservation): void => {
      observations.push(value)
    }
    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(StudioProvider, null, createElement(Probe, { observe }))
        )
      )
    })

    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.account?.status === 'signed-in' &&
        acknowledgedCallbacks.includes(callbackEnvelope.id) &&
        acknowledgedProviderCallbacks.includes(providerCallbackEnvelope.id)
    )
    expect(latest()?.core.deviceList.devices.map((device) => device.id)).toEqual([
      'screen:dxgi:0000000000000001:1',
      'camera:1',
      'mic:1'
    ])
    expect(
      (window as Window & { __videorcWindowsLiveAudioHarness?: unknown })
        .__videorcWindowsLiveAudioHarness
    ).toBeUndefined()
    expect(latest()?.core.captureConfig.sources).toMatchObject({
      screenId: 'screen:dxgi:0000000000000001:1',
      cameraId: 'camera:1',
      microphoneId: 'mic:1'
    })
    expect(
      backend.commands.find((command) => command.method === 'account.complete_sign_in')?.params
    ).toEqual({
      code: 'opaque-code-0123456789',
      state: callbackEnvelope.state,
      verifier: 'v'.repeat(43),
      intentGeneration: callbackEnvelope.intentGeneration
    })
    expect(
      backend.commands.find((command) => command.method === 'platformAccounts.oauth.complete')
        ?.params
    ).toEqual({
      code: 'provider-code-0123456789',
      error: undefined,
      errorDescription: undefined,
      state: providerCallbackEnvelope.state
    })
    expect(
      backend.commands.filter((command) => command.method === 'platformAccounts.oauth.complete')
    ).toHaveLength(4)
    expect(acknowledgedProviderCallbacks).toEqual([providerCallbackEnvelope.id])

    await act(async () => {
      latest()?.core.applyLayoutPatch({ layoutPreset: 'screen-only' })
    })
    await waitForObservation(
      () => latest()?.core.captureConfig.layout.layoutPreset === 'screen-only'
    )
    const layoutCommand = backend.commands.find(
      (command) => command.method === 'scene.layout.apply_preview'
    )
    expect(layoutCommand?.params).toMatchObject({
      layout: { layoutPreset: 'screen-only' },
      sources: { screenId: 'screen:dxgi:0000000000000001:1' }
    })

    await act(async () => {
      await latest()?.core.startSession()
    })
    expect(latest()?.core.lastError).toBeNull()
    expect(backend.commands.some((command) => command.method === 'session.start')).toBe(true)
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    expect(
      backend.commands.filter((command) => command.method === 'audio.processing.update')
    ).toEqual([])
    expect(
      backend.commands.find((command) => command.method === 'session.start')?.params
    ).toMatchObject({
      sources: {
        screenId: 'screen:dxgi:0000000000000001:1',
        cameraId: 'camera:1',
        microphoneId: 'mic:1'
      },
      layout: { layoutPreset: 'screen-only' },
      output: { recordEnabled: true, streamEnabled: false }
    })

    await act(async () => {
      await latest()?.core.stopSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
    expect(latest()?.recording.recording).toMatchObject({
      state: 'idle',
      sessionId: 'session-1',
      durationMs: 1_000
    })
  })

  it('starts record-only without validating or activating saved OAuth livestream targets', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.screenId != null
    )

    await act(async () => {
      latest()?.core.setCaptureConfig((current) => ({
        ...current,
        recordEnabled: true,
        streamEnabled: false,
        streaming: {
          ...current.streaming,
          enabled: true,
          enabledTargetIds: ['twitch', 'x'],
          targets: current.streaming.targets.map((target) =>
            target.platform === 'twitch'
              ? {
                  ...target,
                  enabled: true,
                  authMode: 'oauth' as const,
                  accountId: 'twitch-account',
                  status: { state: 'ready' as const }
                }
              : target.platform === 'x'
                ? {
                    ...target,
                    enabled: true,
                    authMode: 'oauth' as const,
                    accountId: 'x-account',
                    platformBroadcastId: 'x-broadcast',
                    platformStreamId: 'x-source',
                    status: { state: 'live' as const }
                  }
                : target
          )
        }
      }))
    })
    await waitForObservation(
      () =>
        latest()?.core.captureConfig.streamEnabled === false &&
        latest()?.core.captureConfig.streaming.targets.some(
          (target) => target.platform === 'twitch' && target.enabled && target.authMode === 'oauth'
        ) === true
    )

    const commandStart = backend.sentCommands.length
    await act(async () => {
      await latest()?.core.startSession()
    })

    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    const startCommand = backend.sentCommands
      .slice(commandStart)
      .find((command) => command.method === 'session.start')
    expect(latest()?.core.lastError).toBeNull()
    expect(startCommand?.params).toMatchObject({
      output: { recordEnabled: true, streamEnabled: false }
    })
    expect(startCommand?.params).not.toHaveProperty('streaming')

    await act(async () => {
      await latest()?.core.stopSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')

    const recordLifecycleCommands = backend.sentCommands.slice(commandStart)
    expect(
      recordLifecycleCommands.filter(
        (command) =>
          command.method === 'platformAccounts.validate' ||
          command.method.startsWith('streamTargets.') ||
          command.method.startsWith('liveChat.')
      )
    ).toEqual([])
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(toastSpies.warning).not.toHaveBeenCalled()
  })

  it('applies one latest microphone edit made while the session is starting', async () => {
    const backend = new StudioBackend()
    backend.sessionStartResponseDelayMs = 100
    backend.emitRecordingStatusBeforeStartResponse = true
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )

    let startPromise: Promise<void> | undefined
    await act(async () => {
      startPromise = latest()?.core.startSession()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'session.start')
    )
    const startAudio = (
      backend.sentCommands.find((command) => command.method === 'session.start')?.params as {
        audio?: { microphoneGainDb?: number; microphoneMuted?: boolean }
      }
    ).audio
    expect(startAudio).toMatchObject({ microphoneGainDb: 0, microphoneMuted: false })

    await act(async () => {
      latest()?.core.setCaptureConfig((current) => ({
        ...current,
        audio: { ...current.audio, microphoneGainDb: 6, microphoneMuted: true }
      }))
    })
    await act(async () => {
      await startPromise
    })
    await waitForObservation(
      () =>
        backend.sentCommands.filter((command) => command.method === 'audio.processing.update')
          .length === 1
    )

    expect(
      backend.sentCommands.filter((command) => command.method === 'audio.processing.update')
    ).toEqual([
      expect.objectContaining({
        params: {
          sessionId: 'session-1',
          microphoneGainDb: 6,
          microphoneMuted: true
        }
      })
    ])
  })

  it('drops pending microphone edits without warning when the capture session ended', async () => {
    const backend = new StudioBackend()
    backend.audioProcessingResponseDelayMs = 100
    backend.audioProcessingReasonCode = 'session-ended'
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await act(async () => {
      await latest()?.core.startSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')

    await act(async () => {
      latest()?.core.setCaptureConfig((current) => ({
        ...current,
        audio: { ...current.audio, microphoneGainDb: 3 }
      }))
    })
    await waitForObservation(
      () =>
        backend.sentCommands.filter((command) => command.method === 'audio.processing.update')
          .length === 1
    )
    await act(async () => {
      latest()?.core.setCaptureConfig((current) => ({
        ...current,
        audio: { ...current.audio, microphoneGainDb: 9, microphoneMuted: true }
      }))
      await new Promise((resolve) => setTimeout(resolve, 150))
    })

    expect(
      backend.sentCommands.filter((command) => command.method === 'audio.processing.update')
    ).toHaveLength(1)
    expect(latest()?.core.captureConfig.audio).toMatchObject({
      microphoneGainDb: 9,
      microphoneMuted: true
    })
    expect(latest()?.core.lastError).toBeNull()
  })

  it('drives the real StudioProvider start, audio queue, and stop through the packaged harness', async () => {
    const backend = new StudioBackend()
    backend.audioProcessingResponseDelayMs = 50
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      windowsLiveAudioSmokeMode: true
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })

    type HarnessWindow = Window & {
      __videorcWindowsLiveAudioHarness?: (
        request: WindowsLiveAudioSmokeRequest
      ) => Promise<WindowsLiveAudioSmokeState>
    }
    const invoke = (request: WindowsLiveAudioSmokeRequest): Promise<WindowsLiveAudioSmokeState> => {
      const harness = (window as HarnessWindow).__videorcWindowsLiveAudioHarness
      if (!harness) throw new Error('Windows live audio harness is not installed.')
      return harness(request)
    }
    await waitForObservation(
      () =>
        observations.at(-1)?.core.wsStatus === 'connected' &&
        typeof (window as HarnessWindow).__videorcWindowsLiveAudioHarness === 'function'
    )

    let state: WindowsLiveAudioSmokeState | undefined
    await act(async () => {
      state = await invoke({
        action: 'configure',
        screenId: 'screen:dxgi:0000000000000001:1',
        cameraId: 'camera:1',
        microphoneId: 'mic:1'
      })
    })
    expect(state).toMatchObject({
      sources: {
        screenId: 'screen:dxgi:0000000000000001:1',
        cameraId: 'camera:1',
        microphoneId: 'mic:1',
        testPattern: false
      },
      layout: { layoutPreset: 'screen-camera' },
      video: { width: 1280, height: 720, fps: 30 },
      output: { recordEnabled: true, streamEnabled: false },
      audio: { microphoneGainDb: 0, microphoneMuted: false }
    })

    await act(async () => {
      state = await invoke({ action: 'start' })
    })
    expect(state?.recording).toEqual({ state: 'recording', sessionId: 'session-1' })
    expect(
      backend.commands.find((command) => command.method === 'session.start')?.params
    ).toMatchObject({
      sources: {
        screenId: 'screen:dxgi:0000000000000001:1',
        cameraId: 'camera:1',
        microphoneId: 'mic:1'
      },
      layout: { layoutPreset: 'screen-camera' },
      output: {
        recordEnabled: true,
        streamEnabled: false,
        video: { width: 1280, height: 720, fps: 30 }
      },
      audio: { microphoneGainDb: 0, microphoneMuted: false }
    })

    await act(async () => {
      await invoke({ action: 'set-audio', microphoneGainDb: 6, microphoneMuted: true })
    })
    await waitForObservation(
      () =>
        backend.sentCommands.filter((command) => command.method === 'audio.processing.update')
          .length >= 1
    )
    await act(async () => {
      await invoke({ action: 'rapid-burst' })
    })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await act(async () => {
        state = await invoke({ action: 'state' })
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      const observed = state
      if (
        observed &&
        observed.telemetry.requestedCount >= 2 &&
        observed.telemetry.requestedCount === observed.telemetry.settledCount &&
        observed.telemetry.lastSettled?.settings?.microphoneGainDb === 0 &&
        observed.telemetry.lastSettled.settings.microphoneMuted === false
      ) {
        break
      }
    }
    expect(state?.audio).toEqual({ microphoneGainDb: 0, microphoneMuted: false })
    expect(state?.telemetry.requestedCount).toBeGreaterThanOrEqual(2)
    expect(state?.telemetry.settledCount).toBe(state?.telemetry.requestedCount)
    expect(state?.telemetry.lastSettled).toMatchObject({
      applied: true,
      settings: { microphoneGainDb: 0, microphoneMuted: false }
    })

    await act(async () => {
      state = await invoke({ action: 'stop' })
    })
    expect(state?.recording).toEqual({ state: 'idle', sessionId: 'session-1' })
    expect(JSON.stringify(state)).not.toContain('recordings')
  })

  it('refreshes entitlements on focus and keeps cleanup jobs durable across row lifetimes', async () => {
    const backend = new StudioBackend()
    backend.noiseCleanupJobs = [cleanupJob()]
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const openedSessions: string[] = []
    const revealedSessions: string[] = []
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      openSession: async (sessionId) => {
        openedSessions.push(sessionId)
        return ''
      },
      revealSession: async (sessionId) => {
        revealedSessions.push(sessionId)
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(() => observations.at(-1)?.core.noiseCleanupJobs.length === 1)
    expect(observations.at(-1)?.core.noiseCleanupJobs[0]?.status).toBe('queued')
    await act(async () => {
      await observations.at(-1)?.core.startNoiseCleanup('session-1')
    })
    expect(backend.commands.at(-1)).toMatchObject({
      method: 'noiseCleanup.start',
      params: { sessionId: 'session-1' }
    })

    const initialRefreshes = backend.commands.filter(
      (command) => command.method === 'entitlements.refresh'
    ).length
    backend.entitlements = premiumEntitlements
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitForObservation(() => observations.at(-1)?.core.entitlements?.tier === 'premium')
    expect(
      backend.commands.filter((command) => command.method === 'entitlements.refresh').length
    ).toBeGreaterThan(initialRefreshes)

    const processing = cleanupJob({
      status: 'processing',
      progressPercent: 42,
      updatedAt: '2026-07-12T00:00:02.000Z'
    })
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'noiseCleanup.status', payload: processing })
      })
    })
    await waitForObservation(
      () => observations.at(-1)?.core.noiseCleanupJobs[0]?.status === 'processing'
    )
    expect(observations.at(-1)?.core.noiseCleanupJobs[0]?.progressPercent).toBe(42)

    const completed = cleanupJob({
      status: 'completed',
      progressPercent: 100,
      outputSessionId: 'cleaned-session',
      outputPath: 'C:\\recordings\\cleaned-session.mkv',
      updatedAt: '2026-07-12T00:00:03.000Z'
    })
    await act(async () => {
      for (let duplicate = 0; duplicate < 2; duplicate += 1) {
        backend.sockets[0]?.onmessage?.({
          data: JSON.stringify({ event: 'noiseCleanup.status', payload: completed })
        })
      }
    })
    await waitForObservation(
      () => observations.at(-1)?.core.noiseCleanupJobs[0]?.status === 'completed'
    )
    const completionToasts = toastSpies.success.mock.calls.filter(
      ([message]) => message === 'Noise cleanup complete'
    )
    expect(completionToasts).toHaveLength(1)
    const completionToast = completionToasts[0]?.[1] as
      | {
          action?: { label: string; onClick: () => void }
          cancel?: { label: string; onClick: () => void }
        }
      | undefined
    expect(completionToast?.action?.label).toBe('Play')
    expect(completionToast?.cancel?.label).toBe('Show in Finder')
    completionToast?.action?.onClick()
    completionToast?.cancel?.onClick()
    await act(async () => Promise.resolve())
    expect(openedSessions).toEqual(['cleaned-session'])
    expect(revealedSessions).toEqual(['cleaned-session'])

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'entitlements.updated',
          payload: DEFAULT_BASIC_ENTITLEMENTS
        })
      })
    })
    await waitForObservation(() => observations.at(-1)?.core.entitlements?.tier === 'basic')
  })

  it('reconciles completed jobs after deletion, remux, and repair mutations', async () => {
    const backend = new StudioBackend()
    backend.entitlements = premiumEntitlements
    backend.noiseCleanupJobs = [
      cleanupJob({
        status: 'completed',
        progressPercent: 100,
        outputSessionId: 'cleaned-session',
        outputPath: 'C:\\recordings\\cleaned-session.mkv'
      })
    ]
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () => observations.at(-1)?.core.noiseCleanupJobs[0]?.status === 'completed'
    )

    expect(
      toastSpies.success.mock.calls.filter(([message]) => message === 'Noise cleanup complete')
    ).toEqual([])

    await act(async () => {
      await observations.at(-1)?.core.deleteSessions([{ id: 'cleaned-session' } as SessionSummary])
    })
    await waitForObservation(
      () => observations.at(-1)?.core.noiseCleanupJobs[0]?.status === 'failed'
    )
    const nextCore = observations.at(-1)?.core
    const failedJob = nextCore?.noiseCleanupJobs[0] ?? null
    expect(failedJob).toMatchObject({
      status: 'failed',
      errorCode: 'file-missing',
      errorMessage: 'The cleaned recording was deleted.'
    })
    expect(
      deriveNoiseCleanupView({
        session: {
          id: 'session-1',
          status: 'completed',
          mode: 'record',
          outputPath: 'C:\\recordings\\session-1.mkv'
        },
        entitlements: nextCore?.entitlements ?? null,
        job: failedJob,
        captureActive: false
      }).directLabel
    ).toBe('Retry cleanup')

    for (const mutation of ['remux', 'repair'] as const) {
      const completed = cleanupJob({
        id: `cleanup-${mutation}`,
        status: 'completed',
        progressPercent: 100,
        outputSessionId: `cleaned-${mutation}`,
        outputPath: `C:\\recordings\\cleaned-${mutation}.mkv`,
        updatedAt: `2026-07-12T00:00:${mutation === 'remux' ? '10' : '20'}.000Z`
      })
      backend.noiseCleanupJobs = [completed]
      await act(async () => {
        backend.sockets[0]?.onmessage?.({
          data: JSON.stringify({ event: 'noiseCleanup.status', payload: completed })
        })
      })
      await waitForObservation(
        () =>
          observations
            .at(-1)
            ?.core.noiseCleanupJobs.some(
              (job) => job.id === completed.id && job.status === 'completed'
            ) === true
      )

      if (mutation === 'remux') {
        await act(async () => {
          await observations.at(-1)?.core.remuxSession('session-1')
        })
      } else {
        await act(async () => {
          await observations.at(-1)?.core.repairRecording('session-1')
        })
      }
      await waitForObservation(
        () => observations.at(-1)?.core.noiseCleanupJobs[0]?.status === 'failed'
      )
      expect(observations.at(-1)?.core.noiseCleanupJobs[0]).toMatchObject({
        status: 'failed',
        errorCode: 'source-changed',
        errorMessage: `The source recording changed after ${mutation}.`
      })
    }

    expect(
      backend.commands.filter((command) => command.method === 'noiseCleanup.list').length
    ).toBeGreaterThanOrEqual(4)
  })

  it('commits an orientation change atomically before preview and recording consume it', async () => {
    const backend = new StudioBackend()
    // Windows proof presentation can take longer than the generic idle-scene
    // reload debounce. A mode switch must not expose its portrait canvas until
    // the matching vertical scene transaction is committed.
    backend.layoutResponseDelayMs = 400
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const previewAspectCalls: Array<[number, number]> = []
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      setPreviewAspectRatio: async (width, height) => {
        previewAspectCalls.push([width, height])
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore

    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.screenId != null &&
        latest()?.core.captureConfig.sources.cameraId != null
    )

    const commandStart = backend.commands.length
    await act(async () => {
      latest()?.core.applyCameraPreset({ layoutPreset: 'vertical-screen-camera' })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 325))
    })

    const mixedReloads = backend.commands.slice(commandStart).filter((command) => {
      if (command.method !== 'scene.load_from_capture_config') return false
      const params = command.params as {
        layout?: { layoutPreset?: string }
        video?: { width?: number; height?: number }
      }
      return (
        params.layout?.layoutPreset === 'screen-camera' &&
        params.video?.width === 1080 &&
        params.video?.height === 1920
      )
    })
    expect(mixedReloads).toEqual([])

    await waitForObservation(
      () =>
        latest()?.core.captureConfig.layout.layoutPreset === 'vertical-screen-camera' &&
        latest()?.core.captureConfig.video.width === 1080 &&
        latest()?.core.captureConfig.video.height === 1920
    )
    expect(previewAspectCalls.at(-1)).toEqual([1080, 1920])
    expect(
      backend.commands.find((command) => command.method === 'scene.layout.apply_preview')?.params
    ).toMatchObject({
      layout: { layoutPreset: 'vertical-screen-camera' },
      video: { width: 1080, height: 1920 }
    })

    await act(async () => {
      await latest()?.core.startSession()
    })
    expect(
      backend.commands.find((command) => command.method === 'session.start')?.params
    ).toMatchObject({
      layout: { layoutPreset: 'vertical-screen-camera' },
      output: { video: { width: 1080, height: 1920 } }
    })
    await act(async () => {
      await latest()?.core.stopSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')

    const reverseCommandStart = backend.commands.length
    await act(async () => {
      latest()?.core.applyCameraPreset({ layoutPreset: 'screen-camera' })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 325))
    })
    const reverseMixedReloads = backend.commands.slice(reverseCommandStart).filter((command) => {
      if (command.method !== 'scene.load_from_capture_config') return false
      const params = command.params as {
        layout?: { layoutPreset?: string }
        video?: { width?: number; height?: number }
      }
      return (
        params.layout?.layoutPreset === 'vertical-screen-camera' &&
        params.video?.width === 2560 &&
        params.video?.height === 1440
      )
    })
    expect(reverseMixedReloads).toEqual([])
    await waitForObservation(
      () =>
        latest()?.core.captureConfig.layout.layoutPreset === 'screen-camera' &&
        latest()?.core.captureConfig.video.width === 2560 &&
        latest()?.core.captureConfig.video.height === 1440
    )
    expect(previewAspectCalls.at(-1)).toEqual([2560, 1440])

    await act(async () => {
      await latest()?.core.startSession()
    })
    expect(
      backend.commands.filter((command) => command.method === 'session.start').at(-1)?.params
    ).toMatchObject({
      layout: { layoutPreset: 'screen-camera' },
      output: { video: { width: 2560, height: 1440 } }
    })
    await act(async () => {
      await latest()?.core.stopSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
  })

  it('recovers in cooldown on the same healthy websocket and ACKs exactly once', async () => {
    vi.useFakeTimers()
    const receivedAtMs = 1_000_000
    vi.setSystemTime(receivedAtMs)
    const backend = new StudioBackend()
    backend.oauthTransportFailuresRemaining = 0
    backend.oauthRetryFailuresRemaining = 7
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const pendingProviderCallbacks = [{ ...providerCallbackEnvelope, receivedAtMs }]
    const acknowledgedProviderCallbacks: string[] = []
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async (id) => {
        acknowledgedProviderCallbacks.push(id)
        return true
      },
      pendingProvider: async () => pendingProviderCallbacks
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const oauthAttemptCount = (): number =>
      backend.commands.filter((command) => command.method === 'platformAccounts.oauth.complete')
        .length
    const flushAsyncWork = async (): Promise<void> => {
      for (let iteration = 0; iteration < 12; iteration += 1) {
        await act(async () => {
          await Promise.resolve()
          await vi.advanceTimersByTimeAsync(0)
          await Promise.resolve()
        })
      }
    }

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(StudioProvider, null, createElement(Probe, { observe: () => {} }))
        )
      )
    })
    await flushAsyncWork()
    expect(oauthAttemptCount()).toBe(1)
    const connectedSocketCount = backend.sockets.length

    for (const delayMs of [500, 1_000, 2_000, 4_000, 8_000, 10_000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delayMs))
      await flushAsyncWork()
    }
    expect(oauthAttemptCount()).toBe(7)
    expect(acknowledgedProviderCallbacks).toEqual([])
    expect(backend.sockets).toHaveLength(connectedSocketCount)

    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    await flushAsyncWork()
    expect(oauthAttemptCount()).toBe(8)
    expect(acknowledgedProviderCallbacks).toEqual([providerCallbackEnvelope.id])
    expect(backend.sockets).toHaveLength(connectedSocketCount)
  })

  it('creates one preview surface then updates bounds without renderer admin RPCs', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emit: ((name: string, value: unknown) => void) | undefined
    let currentWindow = previewWindowOpen({ x: 180, y: 120, width: 960, height: 540 })
    const drainHostCommands = vi.fn(async () => nativePreviewStatus())
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      nativePreview: {
        getWindowState: () => currentWindow,
        drainHostCommands,
        registerEmitter: (nextEmit) => {
          emit = nextEmit
        }
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore

    const observations: StudioObservation[] = []
    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(Probe, {
              observe: (value) => {
                observations.push(value)
              }
            })
          )
        )
      )
    })

    const methodCount = (method: string): number =>
      backend.commands.filter((command) => command.method === method).length
    await waitForObservation(
      () =>
        observations.at(-1)?.core.wsStatus === 'connected' &&
        methodCount('preview.surface.create') === 1 &&
        drainHostCommands.mock.calls.length === 1
    )

    for (const x of [220, 260]) {
      currentWindow = {
        ...currentWindow,
        contentBounds: { ...currentWindow.contentBounds!, x },
        supervisor: {
          ...currentWindow.supervisor,
          updatedAt: `2026-07-12T00:00:0${x / 40}.000Z`
        }
      }
      await act(async () => emit?.('preview-window:state', currentWindow))
    }
    await waitForObservation(() => methodCount('preview.surface.update_bounds') >= 1)

    expect(methodCount('preview.surface.create')).toBe(1)
    expect(methodCount('preview.surface.update_bounds')).toBeGreaterThanOrEqual(1)
    expect(methodCount('preview.surface.take_native_host_commands')).toBe(0)
    expect(drainHostCommands.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(observations.at(-1)?.core.lastError).toBeNull()
  })

  it('retries account exchange and ACK failures on the same healthy websocket', async () => {
    vi.useFakeTimers()
    const receivedAtMs = 1_000_000
    vi.setSystemTime(receivedAtMs)
    const backend = new StudioBackend()
    backend.accountTransportFailuresRemaining = 1
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const pendingCallbacks = [
      {
        ...callbackEnvelope,
        receivedAtMs,
        expiresAtMs: receivedAtMs + 120_000
      }
    ]
    const acknowledgedCallbacks: string[] = []
    let acknowledgementFailuresRemaining = 1
    const api = createVideorcApi({
      acknowledge: async (id) => {
        if (acknowledgementFailuresRemaining > 0) {
          acknowledgementFailuresRemaining -= 1
          throw new Error('Temporary account acknowledgement persistence failure.')
        }
        acknowledgedCallbacks.push(id)
        return true
      },
      pending: async () => pendingCallbacks,
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const accountAttemptCount = (): number =>
      backend.commands.filter((command) => command.method === 'account.complete_sign_in').length
    const flushAsyncWork = async (): Promise<void> => {
      for (let iteration = 0; iteration < 12; iteration += 1) {
        await act(async () => {
          await Promise.resolve()
          await vi.advanceTimersByTimeAsync(0)
          await Promise.resolve()
        })
      }
    }

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(StudioProvider, null, createElement(Probe, { observe: () => {} }))
        )
      )
    })
    await flushAsyncWork()
    expect(accountAttemptCount()).toBe(1)
    const connectedSocketCount = backend.sockets.length

    await act(async () => vi.advanceTimersByTimeAsync(500))
    await flushAsyncWork()
    expect(accountAttemptCount()).toBe(2)
    expect(acknowledgedCallbacks).toEqual([])

    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    await flushAsyncWork()
    expect(accountAttemptCount()).toBe(3)
    expect(acknowledgedCallbacks).toEqual([callbackEnvelope.id])
    expect(backend.sockets).toHaveLength(connectedSocketCount)
  })

  it('ACKs a sign-out-superseded callback once and never retries it', async () => {
    vi.useFakeTimers()
    const receivedAtMs = 1_000_000
    vi.setSystemTime(receivedAtMs)
    const backend = new StudioBackend()
    backend.accountSignInSuperseded = true
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const acknowledgedCallbacks: string[] = []
    const api = createVideorcApi({
      acknowledge: async (id) => {
        acknowledgedCallbacks.push(id)
        return true
      },
      pending: async () => [
        { ...callbackEnvelope, receivedAtMs, expiresAtMs: receivedAtMs + 120_000 }
      ],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const attemptCount = (): number =>
      backend.commands.filter((command) => command.method === 'account.complete_sign_in').length
    const flushAsyncWork = async (): Promise<void> => {
      for (let iteration = 0; iteration < 12; iteration += 1) {
        await act(async () => {
          await Promise.resolve()
          await vi.advanceTimersByTimeAsync(0)
          await Promise.resolve()
        })
      }
    }

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(StudioProvider, null, createElement(Probe, { observe: () => {} }))
        )
      )
    })
    await flushAsyncWork()

    expect(attemptCount()).toBe(1)
    expect(acknowledgedCallbacks).toEqual([callbackEnvelope.id])
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    await flushAsyncWork()
    expect(attemptCount()).toBe(1)
    expect(acknowledgedCallbacks).toEqual([callbackEnvelope.id])
  })

  it('does not ACK an expired account callback after exchange failure', async () => {
    const backend = new StudioBackend()
    backend.accountTransportFailuresRemaining = 100
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const pendingCallbacks = [{ ...callbackEnvelope, receivedAtMs: 0 }]
    const acknowledgedCallbacks: string[] = []
    const api = createVideorcApi({
      acknowledge: async (id) => {
        acknowledgedCallbacks.push(id)
        return true
      },
      pending: async () => pendingCallbacks,
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const accountAttemptCount = (): number =>
      backend.commands.filter((command) => command.method === 'account.complete_sign_in').length

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(StudioProvider, null, createElement(Probe, { observe: () => {} }))
        )
      )
    })
    await waitForObservation(() => accountAttemptCount() >= 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(accountAttemptCount()).toBe(1)
    expect(acknowledgedCallbacks).toEqual([])
    expect(await api.getPendingAccountCallbacks()).toEqual(pendingCallbacks)
  })

  it('stops expired OAuth retries without ACK and leaves the envelope for remount', async () => {
    const backend = new StudioBackend()
    backend.oauthTransportFailuresRemaining = 100
    backend.oauthRetryFailuresRemaining = 100
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const pendingProviderCallbacks = [{ ...providerCallbackEnvelope, receivedAtMs: 0 }]
    const acknowledgedProviderCallbacks: string[] = []
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async (id) => {
        acknowledgedProviderCallbacks.push(id)
        return true
      },
      pendingProvider: async () => pendingProviderCallbacks
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore

    const mount = async (): Promise<void> => {
      await act(async () => {
        root = createRoot(testDom.container)
        root.render(
          createElement(
            BackgroundAssetsProvider,
            null,
            createElement(StudioProvider, null, createElement(Probe, { observe: () => {} }))
          )
        )
      })
    }
    const oauthAttemptCount = (): number =>
      backend.commands.filter((command) => command.method === 'platformAccounts.oauth.complete')
        .length

    await mount()
    await waitForObservation(() => oauthAttemptCount() >= 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750))
    })
    expect(oauthAttemptCount()).toBe(1)
    expect(acknowledgedProviderCallbacks).toEqual([])
    expect(await api.getPendingOAuthCallbacks()).toEqual(pendingProviderCallbacks)

    await act(async () => root?.unmount())
    root = null
    await mount()
    await waitForObservation(() => oauthAttemptCount() >= 2)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750))
    })
    expect(oauthAttemptCount()).toBe(2)
    expect(acknowledgedProviderCallbacks).toEqual([])
    expect(await api.getPendingOAuthCallbacks()).toEqual(pendingProviderCallbacks)
  })
})

function createVideorcApi(options: {
  pending: () => Promise<AccountCallbackEnvelope[]>
  acknowledge: (id: string) => Promise<boolean>
  pendingProvider: () => Promise<OAuthCallbackEnvelope[]>
  acknowledgeProvider: (id: string) => Promise<boolean>
  openSession?: (sessionId: string) => Promise<string>
  revealSession?: (sessionId: string) => Promise<void>
  setPreviewAspectRatio?: (width: number, height: number) => Promise<void>
  nativePreview?: {
    getWindowState: () => PreviewWindowState
    drainHostCommands: (generation?: number) => Promise<PreviewSurfaceStatus>
    registerEmitter?: (emit: (name: string, value: unknown) => void) => void
  }
  windowsLiveAudioSmokeMode?: boolean
  platform?: string
  getMediaAccessStatus?: VideorcApi['getMediaAccessStatus']
  requestMediaAccess?: VideorcApi['requestMediaAccess']
  openSystemPermissions?: VideorcApi['openSystemPermissions']
  backendConnection?: BackendConnection
  registerEmitter?: (emit: (name: string, value: unknown) => void) => void
}): VideorcApi {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const subscribe = (name: string, callback: (value: unknown) => void): (() => void) => {
    const bucket = listeners.get(name) ?? new Set()
    bucket.add(callback)
    listeners.set(name, bucket)
    return () => bucket.delete(callback)
  }
  const emit = (name: string, value: unknown): void => {
    for (const callback of listeners.get(name) ?? []) callback(value)
  }
  options.registerEmitter?.(emit)
  options.nativePreview?.registerEmitter?.((name, value) => {
    emit(name, value)
  })
  const idleNotes = {
    open: false,
    visible: false,
    bounds: null,
    alwaysOnTop: false,
    protected: true,
    enabled: false
  }
  const idleComments = { ...idleNotes }
  const idleCaptions = {
    open: false,
    visible: false,
    bounds: null,
    alwaysOnTop: false,
    enabled: false
  }
  const api = new Proxy<Record<string, unknown>>(
    {
      getBackendConnection: async () =>
        options.backendConnection ?? { host: '127.0.0.1', port: 9988, token: 'test-token' },
      getBackendLogs: async () => [],
      getRuntimeInfo: async () => ({
        version: 'test',
        platform: options.platform ?? 'win32',
        arch: 'x64',
        osRelease: 'test',
        gpuDevices: [],
        hardwareAccelerationDisabled: false,
        isPackaged: false,
        permissionTargetName: 'Videorc',
        permissionTargetPath: 'C:\\Videorc.exe',
        capturePermissionTargetName: 'Videorc',
        capturePermissionTargetPath: 'C:\\Videorc.exe',
        nativePreviewSurfaceProofEnabled: Boolean(options.nativePreview),
        windowsLiveAudioSmokeMode: options.windowsLiveAudioSmokeMode === true,
        disableAutoPreview: !options.nativePreview
      }),
      getBundledBackgroundAssets: async () => [],
      getPendingAccountCallbacks: options.pending,
      acknowledgeAccountCallback: options.acknowledge,
      getPendingOAuthCallbacks: options.pendingProvider,
      acknowledgeOAuthCallback: options.acknowledgeProvider,
      getNativePreviewSurfaceMode: async () => false,
      getNativePreviewMainPumpActive: async () => true,
      getNativePreviewSurfaceStatus: async () =>
        options.nativePreview ? nativePreviewStatus() : null,
      drainNativePreviewHostCommands:
        options.nativePreview?.drainHostCommands ?? (async () => nativePreviewStatus()),
      createNativePreviewSurface: async (bounds: PreviewSurfaceBounds) =>
        nativePreviewStatus(bounds),
      updateNativePreviewSurfaceBounds: async (bounds: PreviewSurfaceBounds) =>
        nativePreviewStatus(bounds),
      setNativePreviewSurfaceFramePollingSuppressed: async () => nativePreviewStatus(),
      getPreviewWindowState: async () =>
        options.nativePreview?.getWindowState() ?? previewWindowClosed,
      setPreviewWindowAspectRatio: options.setPreviewAspectRatio ?? (async () => undefined),
      getNotesWindowState: async () => idleNotes,
      getCommentsWindowState: async () => idleComments,
      getCaptionsWindowState: async () => idleCaptions,
      getMediaAccessStatus:
        options.getMediaAccessStatus ??
        (async () => ({ camera: 'granted', microphone: 'granted' })),
      requestMediaAccess: options.requestMediaAccess,
      openSystemPermissions: options.openSystemPermissions,
      getViewerSample: async () => null,
      getCommentsSnapshot: async () => null,
      getCommentHighlightState: async () => ({ generation: 0, phase: 'idle' }),
      getCaptionSnapshot: async () => null,
      getCaptionLines: async () => null,
      getGlassWallpaper: async () => null,
      openSession: options.openSession ?? (async () => ''),
      revealSession: options.revealSession ?? (async () => {}),
      getUpdateStatus: async () => ({ phase: 'unsupported' }),
      onBackendConnection: (callback: (value: unknown) => void) =>
        subscribe('backend:connection', callback),
      onBackendLog: (callback: (value: unknown) => void) => subscribe('backend:log', callback),
      onBackendLifecycle: (callback: (value: unknown) => void) =>
        subscribe('backend:lifecycle', callback),
      onPreviewWindowState: (callback: (value: unknown) => void) =>
        subscribe('preview-window:state', callback),
      onAccountCallback: (callback: (value: unknown) => void) =>
        subscribe('account:callback', callback),
      onOAuthCallbackUrl: (callback: (value: unknown) => void) =>
        subscribe('oauth:callback-url', callback)
    },
    {
      get(target, property) {
        if (typeof property !== 'string') return Reflect.get(target, property)
        if (property in target) return target[property]
        if (property.startsWith('on')) {
          return (callback: (value: unknown) => void) => subscribe(property, callback)
        }
        return async () => undefined
      }
    }
  )
  return api as unknown as VideorcApi
}

function installProviderTestEnvironment(api: VideorcApi): {
  container: Element
  restore: () => void
} {
  class FakeElement {}
  const eventTarget = new EventTarget()
  const fakeWindow: Record<string, unknown> = {
    HTMLIFrameElement: FakeElement,
    HTMLElement: FakeElement,
    videorc: api,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    open: () => null,
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

  const storage = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size
    }
  }
  const descriptors = new Map(
    ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name)
    ])
  )
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage })
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

async function waitForObservation(predicate: () => boolean, attempts = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  throw new Error('Timed out waiting for StudioProvider observation.')
}
