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
  CohostSettings,
  CohostSettingsPatch,
  CohostState,
  AudioMeterResult,
  BackendConnection,
  CommentHighlightCommand,
  CommentHighlightState,
  CompositorStatus,
  CaptureRecoveryStatus,
  CommentsCommandResolution,
  CommentsSendCommand,
  CommentsSendOperation,
  DeviceList,
  HealthEvent,
  LayoutSettings,
  LiveChatMessage,
  LiveChatSnapshot,
  NoiseCleanupJob,
  OAuthCallbackEnvelope,
  PlatformAccountValidation,
  PreviewSurfaceBounds,
  PreviewSurfaceStatus,
  PreviewWindowState,
  RecordingStatus,
  Scene,
  SessionLogEntry,
  SessionSummary,
  StreamScreen,
  StreamOutputTopologyProbeResult,
  VideorcAccountSnapshot,
  VideorcApi
} from '../../../shared/backend'
import { BackgroundAssetsProvider } from './use-background-assets'
import {
  StudioMicVisualProvider,
  useStudioMicVisualLifecycle,
  useStudioMicVisualPainter
} from './use-studio-mic-visual'
import {
  StudioProvider,
  buildStreamOutputTopologyProbeParams,
  resolvedStreamingProfileEntitlementGate,
  streamOutputTopologyBlockReason,
  streamOutputTopologyProbeRequestKey,
  useStudioAudio,
  useStudioChat,
  useStudioCore,
  useStudioDiagnostics,
  useStudioRecording,
  type StudioCoreContextValue,
  type StudioRecordingContextValue
} from './use-studio'
import { DEFAULT_BASIC_ENTITLEMENTS, PREMIUM_STREAMING_LIMITS } from '../lib/entitlements'
import { defaultCaptureConfig, videoPresets, type CaptureConfig } from '../lib/capture'
import { deriveNoiseCleanupView } from '../lib/noise-cleanup-view'
import { SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY } from '../lib/screen-takeover-microphone'
import type {
  WindowsLiveAudioSmokeRequest,
  WindowsLiveAudioSmokeState
} from '../../../shared/windows-live-audio-smoke'

type BackendCommand = { id: string; method: string; params?: unknown }
type DeferredBackendResponse = {
  payload?: unknown
  error?: Error
  ready: Promise<void>
  release: () => void
  matches?: (command: BackendCommand) => boolean
}

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
  })),
  limits: {
    ...DEFAULT_BASIC_ENTITLEMENTS.limits,
    streaming: PREMIUM_STREAMING_LIMITS
  }
}

const takeoverScreen: StreamScreen = {
  id: 'screen-takeover-1',
  name: 'Be right back',
  imagePath: 'C:\\screens\\brb.png',
  sortOrder: 0,
  status: 'ready',
  createdAt: now,
  updatedAt: now
}

const highlightMessage: LiveChatMessage = {
  id: 'youtube:message-1',
  providerMessageId: 'message-1',
  platform: 'youtube',
  sessionId: 'live-1',
  authorName: 'Viewer',
  authorBadges: [],
  authorRoles: [],
  publishedAt: now,
  receivedAt: now,
  messageText: 'Hello from chat',
  fragments: [],
  eventType: 'message',
  isDeleted: false
}

const liveHighlightState: CommentHighlightState = {
  sessionId: highlightMessage.sessionId,
  messageId: highlightMessage.id,
  generation: 1,
  phase: 'live'
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
  recordingState: RecordingStatus['state'] = 'idle'
  recordingSessionId: string | undefined
  recordingStatusOverride: RecordingStatus | undefined
  accountSnapshot: VideorcAccountSnapshot = { status: 'signed-out' }
  accountTransportFailuresRemaining = 0
  accountSignInSuperseded = false
  oauthTransportFailuresRemaining = 1
  oauthRetryFailuresRemaining = 1
  oauthCompletedStates = new Set<string>()
  entitlements = DEFAULT_BASIC_ENTITLEMENTS
  noiseCleanupJobs: NoiseCleanupJob[] = []
  sourceMutationRevision = 4
  layoutResponseDelayMs = 0
  layoutApplyFailure: 'definite' | 'request-outcome-unknown-after-commit' | null = null
  screenActivateFailure: 'definite' | null = null
  screenClearFailure: 'request-outcome-unknown-before-commit' | null = null
  sessionStartResponseDelayMs = 0
  sessionStartError: string | null = null
  emitRecordingStatusBeforeStartResponse = false
  authoritativeRecordingStatusBeforeStartResponse: 'stopping' | 'idle' | 'failed' | null = null
  terminalRecordingStatusOnMethod: string | null = null
  terminalRecordingStatusOnMethodEmitted = false
  youtubePrepareCount = 0
  youtubeCompleteFailuresRemaining = 0
  xPrepareCount = 0
  xPrepareFailuresRemaining = 0
  xPublishCount = 0
  xPublishTweetError: string | undefined
  xEndFailuresRemaining = 0
  platformAccountValidations: PlatformAccountValidation[] = []
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
  cohostSettings: CohostSettings = {
    enabled: true,
    tone: 'friendly',
    notes: '',
    autoHighlight: false
  }
  cohostState: CohostState = {
    sessionId: null,
    status: 'off',
    reason: null,
    questions: [],
    flags: [],
    mood: null,
    lastTickAt: null,
    tickSeq: 0,
    partial: false
  }
  private readonly deferredResponses = new Map<string, DeferredBackendResponse[]>()
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
  screens: StreamScreen[] = []
  activeScreen: StreamScreen | null = null
  audioMeterResult: AudioMeterResult = { status: 'ready', level: 0.4 }
  liveChatSnapshot: LiveChatSnapshot = {
    providers: [],
    messages: [],
    unreadCount: 0,
    updatedAt: now
  }
  commentHighlightState: CommentHighlightState = { generation: 0, phase: 'idle' }
  commentHighlightClearOutcomeUnknownRemaining = 0
  liveChatSendOperations: CommentsSendOperation[] = []
  liveChatSendFailure: { code: string; message: string } | null = null
  captureRecoveryStatus: CaptureRecoveryStatus = {
    revision: 0,
    phase: 'idle',
    retryable: false,
    attempts: 0
  }

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

  deferFailure(
    method: string,
    error: Error,
    matches?: (command: BackendCommand) => boolean
  ): () => void {
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = this.deferredResponses.get(method) ?? []
    pending.push({ error, ready, release, matches })
    this.deferredResponses.set(method, pending)
    return release
  }

  takeDeferredResponse(
    method: string,
    command: BackendCommand
  ): DeferredBackendResponse | undefined {
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
        return this.accountSnapshot
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
      case 'cohost.settings.get':
        return this.cohostSettings
      case 'cohost.settings.set':
        this.cohostSettings = { ...this.cohostSettings, ...(params as CohostSettingsPatch) }
        return this.cohostSettings
      case 'cohost.status':
      case 'cohost.stop':
        return this.cohostState
      case 'cohost.start':
        this.cohostState = {
          ...this.cohostState,
          sessionId: params.sessionId as string,
          status: params.consentToProcessChat === true ? 'listening' : 'paused',
          reason: params.consentToProcessChat === true ? null : 'consent-required'
        }
        return this.cohostState
      case 'cohost.question.answered':
      case 'cohost.question.dismiss':
        this.cohostState = {
          ...this.cohostState,
          questions: this.cohostState.questions.filter(
            (question) => question.id !== (params.questionId as string)
          )
        }
        return this.cohostState
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
        if (this.recordingStatusOverride) {
          return this.recordingStatusOverride
        }
        return {
          state: this.recordingState,
          ...(this.recordingSessionId ? { sessionId: this.recordingSessionId } : {}),
          message: 'Ready.'
        }
      case 'stream.output.topology.probe':
        return {
          capabilityKey: `stream-output-topology-v1:${'0'.repeat(64)}`,
          streamProfile: params.streamProfile,
          ...(params.recordingProfile ? { recordingProfile: params.recordingProfile } : {}),
          outputRoles: params.outputRoles,
          requestedBridgeOutput: 'raw-yuv420p',
          effectiveBridgeOutput: 'raw-yuv420p',
          effectiveEncodeBackend: 'software-open-h264',
          probeState: 'not-required'
        }
      case 'diagnostics.stats':
        return {
          activeFfmpegProcesses: 0,
          activeFfprobeProcesses: 0,
          micDroppedFrames: 0,
          compositorSourceCaptureTextureReuses: 0,
          compositorCameraSourceCaptureTextureReuses: 0,
          compositorScreenSourceCaptureTextureReuses: 0,
          compositorSourceTextureCacheFlushes: 0,
          previewCameraDroppedFrames: 0,
          previewCameraCaptureCallbackCount: 0,
          previewCameraDidDropCallbackCount: 0,
          previewCameraFrameStorePublications: 0,
          previewCameraDropReasons: {
            frameWasLate: 0,
            outOfBuffers: 0,
            discontinuity: 0,
            unknown: 0
          },
          previewCameraSurfaceBacking: {
            liveCount: 0,
            peakCount: 0,
            estimatedBytes: 0,
            peakEstimatedBytes: 0
          },
          previewScreenDroppedFrames: 0,
          previewScreenCaptureCallbackCount: 0,
          previewScreenFrameStorePublications: 0,
          previewScreenFrameStatuses: {
            complete: 0,
            idle: 0,
            blank: 0,
            suspended: 0,
            started: 0,
            stopped: 0,
            unknown: 0
          },
          previewScreenSurfaceBacking: {
            liveCount: 0,
            peakCount: 0,
            estimatedBytes: 0,
            peakEstimatedBytes: 0
          },
          previewSourceFrameDroppedFrames: 0,
          droppedFrames: 0,
          skippedFrames: 0,
          updatedAt: now
        }
      case 'capture.recovery.status':
        return this.captureRecoveryStatus
      case 'capture.recovery.retry':
        this.captureRecoveryStatus = {
          ...this.captureRecoveryStatus,
          revision: this.captureRecoveryStatus.revision + 1,
          phase: 'restarting',
          retryable: false,
          trigger: 'manual',
          attempts: this.captureRecoveryStatus.attempts + 1,
          updatedAt: now
        }
        return this.captureRecoveryStatus
      case 'captions.status.get':
        return { state: 'idle' }
      case 'liveChat.status':
        return this.liveChatSnapshot
      case 'liveChat.send':
        if (this.liveChatSendFailure) {
          throw Object.assign(new Error(this.liveChatSendFailure.message), {
            code: this.liveChatSendFailure.code
          })
        }
        return this.liveChatSendOperations.find(
          (operation) => operation.id === String(params.operationId)
        )
      case 'liveChat.sendOperations.list':
        return this.liveChatSendOperations.filter(
          (operation) => operation.sessionId === String(params.sessionId)
        )
      case 'comments.highlight.status':
        return this.commentHighlightState
      case 'comments.highlight.clear':
        this.commentHighlightState = {
          generation: this.commentHighlightState.generation + 1,
          phase: 'idle'
        }
        if (this.commentHighlightClearOutcomeUnknownRemaining > 0) {
          this.commentHighlightClearOutcomeUnknownRemaining -= 1
          throw Object.assign(new Error('The highlight clear result was not observed.'), {
            code: 'request-outcome-unknown'
          })
        }
        return this.commentHighlightState
      case 'comments.highlight.set':
        this.commentHighlightState = {
          sessionId: String(params.sessionId),
          messageId: String(params.messageId),
          generation: this.commentHighlightState.generation + 1,
          phase: 'live'
        }
        return this.commentHighlightState
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
        if (this.layoutApplyFailure === 'definite') {
          throw Object.assign(new Error('The test backend rejected the layout change.'), {
            code: 'layout-preview-failed'
          })
        }
        this.currentLayout = params.layout as LayoutSettings
        this.currentScene = sceneForLayout(this.currentLayout)
        this.revision += 1
        if (this.layoutApplyFailure === 'request-outcome-unknown-after-commit') {
          const video = params.video as { width: number; height: number; fps: number }
          this.currentScene = {
            ...this.currentScene,
            outputs: [
              {
                id: 'recording',
                kind: 'recording',
                width: video.width,
                height: video.height,
                fps: video.fps
              }
            ]
          }
          throw Object.assign(new Error('The committed layout response was not observed.'), {
            code: 'request-outcome-unknown'
          })
        }
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
      case 'scene.source.device.switch': {
        this.revision += 1
        return {
          applied: true,
          mode: 'warm',
          intentId: this.revision,
          sceneRevision: this.revision,
          presentationProven: true,
          scene: this.currentScene,
          compositorStatus: compositorFor(this.currentScene, this.currentLayout, this.revision)
        }
      }
      case 'screens.list':
        return this.screens
      case 'screens.active':
        return this.activeScreen
      case 'screens.activate': {
        if (this.screenActivateFailure === 'definite') {
          throw Object.assign(new Error('The test backend rejected takeover activation.'), {
            code: 'screen-activate-failed'
          })
        }
        const screen = this.screens.find((candidate) => candidate.id === params.screenId)
        if (!screen) throw new Error('Screen not found.')
        this.activeScreen = screen
        return screen
      }
      case 'screens.clear':
        if (this.screenClearFailure === 'request-outcome-unknown-before-commit') {
          throw Object.assign(new Error('The takeover clear result was not observed.'), {
            code: 'request-outcome-unknown'
          })
        }
        this.activeScreen = null
        return null
      case 'streamTargets.metadata.get':
        return {
          title: '',
          description: '',
          defaultPrivacy: 'unlisted',
          targetOverrides: [],
          updatedAt: now
        }
      case 'streamTargets.metadata.update':
        return params
      case 'streamTargets.metadata.validate':
        return { valid: true, issues: [] }
      case 'streamTargets.confirmation.validate':
        return { valid: true, destinations: [], issues: [] }
      case 'streamTargets.youtube.prepare': {
        const prepareSequence = ++this.youtubePrepareCount
        return {
          platform: 'youtube',
          accountId: String(params.accountId ?? 'youtube-account-1'),
          accountLabel: 'YouTube Test Channel',
          broadcastId: `youtube-broadcast-${prepareSequence}`,
          streamId: `youtube-stream-${prepareSequence}`,
          serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
          streamKeySecretRef: `stream-key:youtube-${prepareSequence}`,
          streamKeyPresent: true,
          redactedUrl: 'rtmp://a.rtmp.youtube.com/live2/••••test',
          title: 'Provider test stream',
          description: '',
          privacy: 'unlisted',
          madeForKids: false,
          scheduledStartTime: now
        }
      }
      case 'streamTargets.youtube.streamStatus':
        return {
          platform: 'youtube',
          accountId: String(params.accountId ?? 'youtube-account-1'),
          streamId: String(params.streamId),
          streamStatus: 'active',
          active: true,
          message: 'YouTube ingest is active.'
        }
      case 'streamTargets.youtube.transition':
        if (params.status === 'complete' && this.youtubeCompleteFailuresRemaining > 0) {
          this.youtubeCompleteFailuresRemaining -= 1
          throw new Error('Temporary YouTube completion failure.')
        }
        return {
          platform: 'youtube',
          accountId: String(params.accountId ?? 'youtube-account-1'),
          broadcastId: String(params.broadcastId),
          requestedStatus: params.status,
          lifecycleStatus: params.status,
          message: `YouTube broadcast transitioned to ${String(params.status)}.`
        }
      case 'streamTargets.x.capability':
        return {
          platform: 'x',
          state: 'native-available',
          nativeAvailable: true,
          manualRtmpAvailable: true,
          oauthConnected: true,
          accountId: String(params.accountId ?? 'x-account-1'),
          accountLabel: 'X Test Account',
          credentialSource: 'test',
          message: 'X native live is available.',
          evidence: ['provider-test'],
          docsUrl: 'https://developer.x.com/docs',
          apiOverviewUrl: 'https://developer.x.com/en/docs/twitter-api'
        }
      case 'streamTargets.x.prepare': {
        if (this.xPrepareFailuresRemaining > 0) {
          this.xPrepareFailuresRemaining -= 1
          throw new Error('Temporary X preparation failure.')
        }
        const prepareSequence = ++this.xPrepareCount
        return {
          platform: 'x',
          accountId: String(params.accountId ?? 'x-account-1'),
          accountLabel: 'X Test Account',
          sourceId: `x-source-${prepareSequence}`,
          region: `x-region-${prepareSequence}`,
          serverUrl: 'rtmp://x.example.test/live',
          streamKeySecretRef: `stream-key:x-${prepareSequence}`,
          streamKeyPresent: true,
          redactedUrl: 'rtmp://x.example.test/live/••••test',
          isStreamActive: true,
          selection: 'created',
          deletedRetiredSourceIds: []
        }
      }
      case 'streamTargets.x.publish': {
        const publishSequence = ++this.xPublishCount
        return {
          platform: 'x',
          accountId: String(params.accountId ?? 'x-account-1'),
          sourceId: String(params.sourceId),
          broadcastId: `x-broadcast-${publishSequence}`,
          mediaKey: `x-media-key-${publishSequence}`,
          shareUrl: `https://x.com/i/broadcasts/${publishSequence}`,
          state: 'running',
          ...(this.xPublishTweetError ? { tweetError: this.xPublishTweetError } : {}),
          message: 'X broadcast published.'
        }
      }
      case 'streamTargets.x.end':
        if (this.xEndFailuresRemaining > 0) {
          this.xEndFailuresRemaining -= 1
          throw new Error('Temporary X END failure.')
        }
        return {
          platform: 'x',
          accountId: String(params.accountId ?? 'x-account-1'),
          broadcastId: String(params.broadcastId),
          message: 'X broadcast ended.'
        }
      case 'streamTargets.manualKey.store':
        return {
          targetId: params.targetId,
          streamKeySecretRef: `stream-key:${String(params.targetId)}`,
          streamKeyPresent: Boolean(params.streamKey),
          streamKeyHint: params.streamKey ? String(params.streamKey).slice(-4) : undefined,
          previousStreamKeyPresent: false
        }
      case 'streamTargets.manualKey.inspect':
        return {
          targetId: params.targetId,
          streamKeySecretRef: `stream-key:${String(params.targetId)}`,
          streamKeyPresent: true,
          streamKeyHint: '••••test',
          previousStreamKeyPresent: false
        }
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
      case 'platformAccounts.oauth.providerCredentials':
        return []
      case 'platformAccounts.validate':
        return this.platformAccountValidations
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
        if (this.sessionStartError) {
          throw new Error(this.sessionStartError)
        }
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
  readonly sentCommands: BackendCommand[] = []
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
    this.sentCommands.push(command)
    this.backend.sentCommands.push(command)
    const deferredResponse = this.backend.takeDeferredResponse(command.method, command)
    const emitRecordingStatus = (
      state: 'recording' | 'stopping' | 'idle' | 'failed',
      message: string
    ) => {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            event: 'recording.status',
            payload: {
              state,
              sessionId: 'session-1',
              startedAt: now,
              message
            }
          })
        })
      })
    }
    if (
      command.method === 'session.start' &&
      (this.backend.emitRecordingStatusBeforeStartResponse ||
        this.backend.authoritativeRecordingStatusBeforeStartResponse)
    ) {
      const state =
        this.backend.authoritativeRecordingStatusBeforeStartResponse ?? ('recording' as const)
      emitRecordingStatus(
        state,
        state === 'recording' ? 'Recording.' : 'Session ended before start replied.'
      )
    }
    if (
      command.method === this.backend.terminalRecordingStatusOnMethod &&
      this.backend.recordingState === 'recording' &&
      !this.backend.terminalRecordingStatusOnMethodEmitted
    ) {
      this.backend.terminalRecordingStatusOnMethodEmitted = true
      this.backend.recordingState = 'stopping'
      emitRecordingStatus('stopping', `Session ended during ${command.method}.`)
    }
    const respond = (payloadOverride?: unknown): void => {
      if (this.readyState !== TestWebSocket.OPEN) {
        return
      }
      try {
        if (deferredResponse) {
          this.backend.commands.push(command)
        }
        if (deferredResponse?.error) {
          throw deferredResponse.error
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
  chat: ReturnType<typeof useStudioChat>
  core: StudioCoreContextValue
  diagnostics: ReturnType<typeof useStudioDiagnostics>
  recording: StudioRecordingContextValue
}

/** A mixer-like consumer: paints frames (which retains analyser demand) and reports lifecycle. */
function MicVisualProbe({ observe }: { observe: (active: boolean) => void }): null {
  useStudioMicVisualPainter(() => undefined)
  const lifecycle = useStudioMicVisualLifecycle()
  useEffect(() => observe(lifecycle.active), [lifecycle.active, observe])
  return null
}

function Probe({ observe }: { observe: (value: StudioObservation) => void }): null {
  const audio = useStudioAudio()
  const chat = useStudioChat()
  const core = useStudioCore()
  const diagnostics = useStudioDiagnostics()
  const recording = useStudioRecording()
  useEffect(
    () => observe({ audio, chat, core, diagnostics, recording }),
    [audio, chat, core, diagnostics, observe, recording]
  )
  return null
}

async function mountStudioProvider(
  container: Element,
  observe: (value: StudioObservation) => void
): Promise<Root> {
  let mountedRoot!: Root
  await act(async () => {
    mountedRoot = createRoot(container)
    mountedRoot.render(
      createElement(
        BackgroundAssetsProvider,
        null,
        createElement(StudioProvider, null, createElement(Probe, { observe }))
      )
    )
  })
  return mountedRoot
}

function youtubeOauthStreamCaptureConfig(): CaptureConfig {
  const streamVideo = videoPresets['stream-safe-1080p30']
  return {
    ...defaultCaptureConfig,
    recordEnabled: false,
    streamEnabled: true,
    video: streamVideo,
    streaming: {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      defaultOutputPreset: streamVideo.preset,
      defaultBitrateKbps: streamVideo.bitrateKbps,
      enabledTargetIds: ['youtube'],
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.id === 'youtube'
          ? {
              ...target,
              enabled: true,
              authMode: 'oauth',
              accountId: 'youtube-account-1',
              accountLabel: 'YouTube Test Channel',
              status: { state: 'ready' as const }
            }
          : target
      )
    }
  }
}

function xOauthStreamCaptureConfig(): CaptureConfig {
  const streamVideo = videoPresets['stream-safe-1080p30']
  return {
    ...defaultCaptureConfig,
    recordEnabled: false,
    streamEnabled: true,
    video: streamVideo,
    streaming: {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      defaultOutputPreset: streamVideo.preset,
      defaultBitrateKbps: streamVideo.bitrateKbps,
      enabledTargetIds: ['x'],
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.id === 'x'
          ? {
              ...target,
              enabled: true,
              authMode: 'oauth',
              accountId: 'x-account-1',
              accountLabel: 'X Test Account',
              status: { state: 'ready' as const }
            }
          : target
      )
    }
  }
}

function youtubeAndXOauthStreamCaptureConfig(): CaptureConfig {
  const youtubeConfig = youtubeOauthStreamCaptureConfig()
  return {
    ...youtubeConfig,
    streaming: {
      ...youtubeConfig.streaming,
      enabledTargetIds: ['youtube', 'x'],
      targets: youtubeConfig.streaming.targets.map((target) =>
        target.id === 'x'
          ? {
              ...target,
              enabled: true,
              authMode: 'oauth',
              accountId: 'x-account-1',
              accountLabel: 'X Test Account',
              status: { state: 'ready' as const }
            }
          : target
      )
    }
  }
}

function enableYouTubeOauthForTest(backend: StudioBackend): void {
  backend.entitlements = premiumEntitlements
  backend.platformAccountValidations = [
    {
      platform: 'youtube',
      state: 'valid',
      accountId: 'youtube-account-1',
      accountLabel: 'YouTube Test Channel',
      scopes: [],
      message: 'YouTube account is connected.'
    }
  ]
}

function enableXOauthForTest(backend: StudioBackend): void {
  backend.entitlements = premiumEntitlements
  backend.platformAccountValidations = [
    {
      platform: 'x',
      state: 'valid',
      accountId: 'x-account-1',
      accountLabel: 'X Test Account',
      scopes: [],
      message: 'X account is connected.'
    }
  ]
}

function enableYouTubeAndXOauthForTest(backend: StudioBackend): void {
  backend.entitlements = premiumEntitlements
  backend.platformAccountValidations = [
    {
      platform: 'youtube',
      state: 'valid',
      accountId: 'youtube-account-1',
      accountLabel: 'YouTube Test Channel',
      scopes: [],
      message: 'YouTube account is connected.'
    },
    {
      platform: 'x',
      state: 'valid',
      accountId: 'x-account-1',
      accountLabel: 'X Test Account',
      scopes: [],
      message: 'X account is connected.'
    }
  ]
}

async function openYouTubeGoLiveConfirmation(
  latest: () => StudioObservation | undefined
): Promise<void> {
  await act(async () => {
    latest()!.core.setCaptureConfig(youtubeOauthStreamCaptureConfig())
  })
  await waitForObservation(
    () =>
      latest()?.core.streamOutputTopologyPreflight.state === 'ready' &&
      latest()?.core.startBlockedReason === null
  )
  await act(async () => {
    await latest()!.core.startSession()
  })
  await waitForObservation(() => latest()?.core.goLiveConfirmationOpen === true)
}

async function openXGoLiveConfirmation(latest: () => StudioObservation | undefined): Promise<void> {
  await act(async () => {
    latest()!.core.setCaptureConfig(xOauthStreamCaptureConfig())
  })
  await waitForObservation(
    () =>
      latest()?.core.streamOutputTopologyPreflight.state === 'ready' &&
      latest()?.core.startBlockedReason === null
  )
  await act(async () => {
    await latest()!.core.startSession()
  })
  await waitForObservation(() => latest()?.core.goLiveConfirmationOpen === true)
}

async function openYouTubeAndXGoLiveConfirmation(
  latest: () => StudioObservation | undefined
): Promise<void> {
  await act(async () => {
    latest()!.core.setCaptureConfig(youtubeAndXOauthStreamCaptureConfig())
  })
  await waitForObservation(
    () =>
      latest()?.core.streamOutputTopologyPreflight.state === 'ready' &&
      latest()?.core.startBlockedReason === null
  )
  await act(async () => {
    await latest()!.core.startSession()
  })
  await waitForObservation(() => latest()?.core.goLiveConfirmationOpen === true)
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

  it('rehydrates failed recovery, single-flights retry, and rejects its stale response', async () => {
    const backend = new StudioBackend()
    backend.captureRecoveryStatus = {
      revision: 4,
      phase: 'failed',
      retryable: true,
      attempts: 1,
      stage: 'camera-delivery',
      source: 'camera',
      trigger: 'automatic',
      sourceGeneration: 7,
      lastError: 'Camera cadence stayed below the recovery floor.',
      updatedAt: now
    }
    const restarting: CaptureRecoveryStatus = {
      ...backend.captureRecoveryStatus,
      revision: 5,
      phase: 'restarting',
      retryable: false,
      trigger: 'manual',
      attempts: 2
    }
    const releaseRetry = backend.deferResponse('capture.recovery.retry', restarting)
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      })
    )
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })

    await waitForObservation(() => latest()?.diagnostics.captureRecoveryStatus.phase === 'failed')
    expect(latest()?.diagnostics.captureRecoveryStatus.lastError).toContain('recovery floor')

    let firstRetry!: Promise<void>
    let duplicateRetry!: Promise<void>
    act(() => {
      firstRetry = latest()!.diagnostics.retryCaptureRecovery()
      duplicateRetry = latest()!.diagnostics.retryCaptureRecovery()
    })
    await waitForObservation(() => latest()?.diagnostics.captureRecoveryRetryPending === true)
    expect(
      backend.sentCommands.filter((command) => command.method === 'capture.recovery.retry')
    ).toHaveLength(1)

    const verifying: CaptureRecoveryStatus = {
      ...restarting,
      revision: 6,
      phase: 'verifying',
      message: 'Camera restarted; verifying cadence.'
    }
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'capture.recovery.status', payload: verifying })
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () => latest()?.diagnostics.captureRecoveryStatus.phase === 'verifying'
    )

    releaseRetry()
    await act(async () => Promise.all([firstRetry, duplicateRetry]))
    expect(latest()?.diagnostics.captureRecoveryStatus).toMatchObject({
      revision: 6,
      phase: 'verifying'
    })
    expect(latest()?.diagnostics.captureRecoveryRetryPending).toBe(false)
  })

  it('resets capture recovery revision ordering for a new backend connection', async () => {
    const initialBackend = new StudioBackend()
    initialBackend.captureRecoveryStatus = {
      revision: 12,
      phase: 'recovered',
      retryable: false,
      attempts: 1,
      stage: 'camera-delivery',
      source: 'camera',
      trigger: 'automatic',
      sourceGeneration: 8,
      updatedAt: now
    }
    TestWebSocket.backend = initialBackend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emit: ((name: string, value: unknown) => void) | undefined
    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => [],
        registerEmitter: (nextEmit) => {
          emit = nextEmit
        }
      })
    )
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })

    await waitForObservation(() => latest()?.diagnostics.captureRecoveryStatus.revision === 12)

    const reconnectedBackend = new StudioBackend()
    reconnectedBackend.captureRecoveryStatus = {
      revision: 1,
      phase: 'degraded',
      retryable: false,
      attempts: 0,
      stage: 'camera-delivery',
      source: 'camera',
      trigger: 'automatic',
      sourceGeneration: 2,
      updatedAt: now
    }
    TestWebSocket.backend = reconnectedBackend
    await act(async () => {
      emit?.('backend:connection', {
        host: '127.0.0.1',
        port: 9992,
        token: 'capture-recovery-new-generation'
      })
      await Promise.resolve()
    })

    await waitForObservation(() => latest()?.diagnostics.captureRecoveryStatus.phase === 'degraded')
    expect(latest()?.diagnostics.captureRecoveryStatus.revision).toBe(1)
  })

  it('reconciles an outcome-unknown local comment highlight toggle', async () => {
    const backend = new StudioBackend()
    backend.liveChatSnapshot = {
      sessionId: highlightMessage.sessionId,
      providers: [],
      messages: [highlightMessage],
      unreadCount: 0,
      updatedAt: now
    }
    backend.commentHighlightState = liveHighlightState
    backend.commentHighlightClearOutcomeUnknownRemaining = 1
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
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })

    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.highlightedCommentId === highlightMessage.id
    )

    await act(async () => latest()!.core.toggleCommentHighlight(highlightMessage))

    await waitForObservation(() => latest()?.core.commentHighlightState.phase === 'idle')
    expect(latest()?.core.commentHighlightFailure).toBeNull()
    expect(
      backend.commands.filter((command) => command.method === 'comments.highlight.clear')
    ).toHaveLength(1)
  })

  it('returns success to Main after reconciling an outcome-unknown detached highlight request', async () => {
    const backend = new StudioBackend()
    backend.liveChatSnapshot = {
      sessionId: highlightMessage.sessionId,
      providers: [],
      messages: [highlightMessage],
      unreadCount: 0,
      updatedAt: now
    }
    backend.commentHighlightState = liveHighlightState
    backend.commentHighlightClearOutcomeUnknownRemaining = 1
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emitIpc: ((name: string, value: unknown) => void) | undefined
    const resolutions: CommentsCommandResolution<CommentHighlightState>[] = []
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (emit) => {
        emitIpc = emit
      },
      pushCommentHighlightResult: async (resolution) => {
        resolutions.push(resolution)
        return true
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })

    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.highlightedCommentId === highlightMessage.id
    )

    const command: CommentHighlightCommand = {
      requestId: 'highlight-request-1',
      sessionId: highlightMessage.sessionId,
      messageId: highlightMessage.id
    }
    await act(async () => emitIpc?.('onCommentHighlightRequest', command))

    await waitForObservation(() => resolutions.length === 1)
    expect(resolutions).toEqual([
      {
        requestId: command.requestId,
        ok: true,
        value: { generation: 2, phase: 'idle' }
      }
    ])
    expect(latest()?.core.commentHighlightFailure).toBeNull()
  })

  it('rejects a detached highlight request superseded by a newer command', async () => {
    const backend = new StudioBackend()
    backend.liveChatSnapshot = {
      sessionId: highlightMessage.sessionId,
      providers: [],
      messages: [highlightMessage],
      unreadCount: 0,
      updatedAt: now
    }
    backend.commentHighlightState = liveHighlightState
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emitIpc: ((name: string, value: unknown) => void) | undefined
    const resolutions: CommentsCommandResolution<CommentHighlightState>[] = []
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (emit) => {
        emitIpc = emit
      },
      pushCommentHighlightResult: async (resolution) => {
        resolutions.push(resolution)
        return true
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })

    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.highlightedCommentId === highlightMessage.id
    )

    const first: CommentHighlightCommand = {
      requestId: 'highlight-request-superseded',
      sessionId: highlightMessage.sessionId,
      messageId: highlightMessage.id
    }
    const second: CommentHighlightCommand = {
      requestId: 'highlight-request-current',
      sessionId: highlightMessage.sessionId,
      messageId: highlightMessage.id
    }
    await act(async () => {
      emitIpc?.('onCommentHighlightRequest', first)
      emitIpc?.('onCommentHighlightRequest', second)
    })

    await waitForObservation(() => resolutions.length === 2)
    expect(resolutions.find(({ requestId }) => requestId === first.requestId)).toEqual({
      requestId: first.requestId,
      ok: false,
      error: 'A newer comment highlight replaced this request.'
    })
    expect(resolutions.find(({ requestId }) => requestId === second.requestId)).toEqual({
      requestId: second.requestId,
      ok: true,
      value: { generation: 3, phase: 'idle' }
    })
  })

  it('keeps an explicit chat-send operation-id collision as a failure', async () => {
    const command: CommentsSendCommand = {
      requestId: 'send-request-1',
      operationId: 'operation-1',
      sessionId: 'live-1',
      text: 'the new unsent message'
    }
    const existingOperation: CommentsSendOperation = {
      id: command.operationId,
      sessionId: command.sessionId,
      text: 'the earlier message',
      phase: 'sent',
      destinations: [],
      createdAt: now,
      updatedAt: now
    }
    const backend = new StudioBackend()
    backend.liveChatSnapshot = {
      sessionId: command.sessionId,
      providers: [],
      messages: [],
      unreadCount: 0,
      updatedAt: now
    }
    backend.liveChatSendOperations = [existingOperation]
    backend.liveChatSendFailure = {
      code: 'live-chat-send-failed',
      message: 'operationId is already bound to a different Comments message.'
    }
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emitIpc: ((name: string, value: unknown) => void) | undefined
    const resolutions: CommentsCommandResolution<CommentsSendOperation>[] = []
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (emit) => {
        emitIpc = emit
      },
      pushChatSendResult: async (resolution) => {
        resolutions.push(resolution)
        return true
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })

    await waitForObservation(() => observations.at(-1)?.core.wsStatus === 'connected')
    await act(async () => emitIpc?.('onChatSendRequest', command))
    await waitForObservation(() => resolutions.length === 1)

    expect(resolutions).toEqual([
      {
        requestId: command.requestId,
        ok: false,
        error: backend.liveChatSendFailure.message
      }
    ])
    expect(
      backend.commands.filter((candidate) => candidate.method === 'liveChat.sendOperations.list')
    ).not.toHaveLength(0)
  })

  it('preserves takeover microphone ownership across bootstrap, reload, responses, and events', async () => {
    const backend = new StudioBackend()
    backend.screens = [takeoverScreen]
    backend.activeScreen = takeoverScreen
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
    let observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    const renderProvider = async (): Promise<void> => {
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
    }

    await renderProvider()
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.activeScreen?.id === takeoverScreen.id &&
        latest()?.core.captureConfig.audio.microphoneMuted === true
    )
    expect(
      JSON.parse(localStorage.getItem(SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY) ?? 'null')
    ).toEqual({ priorMicrophoneMuted: false })

    // A full renderer reload retains both the backend takeover and ownership of
    // the mute it introduced, so clearing can still restore the user's intent.
    await act(async () => root?.unmount())
    root = null
    observations = []
    await renderProvider()
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.activeScreen?.id === takeoverScreen.id &&
        latest()?.core.captureConfig.audio.microphoneMuted === true
    )

    await act(async () => latest()?.core.clearActiveScreen())
    await waitForObservation(
      () =>
        latest()?.core.activeScreen === null &&
        latest()?.core.captureConfig.audio.microphoneMuted === false
    )
    expect(localStorage.getItem(SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY)).toBeNull()

    await act(async () => latest()?.core.activateScreen(takeoverScreen.id))
    await waitForObservation(
      () =>
        latest()?.core.activeScreen?.id === takeoverScreen.id &&
        latest()?.core.captureConfig.audio.microphoneMuted === true
    )

    backend.activeScreen = null
    const commandSocket = [...backend.sockets]
      .reverse()
      .find((socket) =>
        socket.sentCommands.some((command) => command.method === 'screens.activate')
      )
    expect(commandSocket).toBeDefined()
    await act(async () => {
      commandSocket?.onmessage?.({
        data: JSON.stringify({ event: 'screens.active.changed', payload: null })
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () =>
        latest()?.core.activeScreen === null &&
        latest()?.core.captureConfig.audio.microphoneMuted === false
    )
    expect(localStorage.getItem(SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY)).toBeNull()
  })

  it('shows one persistent recovery error when an active recording fails', async () => {
    const backend = new StudioBackend()
    backend.recordingState = 'recording'
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const revealSession = vi.fn(async () => {})
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      revealSession
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    const libraryNavigations: unknown[] = []

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
        latest()?.recording.recording.state === 'recording'
    )
    window.addEventListener('videorc:navigate-workspace', (event) => {
      libraryNavigations.push((event as CustomEvent).detail)
    })
    vi.clearAllMocks()

    const encoderFailure: HealthEvent = {
      id: 'health-encoder-failure',
      sessionId: 'session-failed',
      level: 'error',
      code: 'encoder-bridge-failed',
      message: 'The encoder bridge stopped before capture finalization.',
      permissionPane: null,
      createdAt: '2026-08-25T09:55:26.585Z'
    }
    const failedStatus = {
      state: 'failed' as const,
      sessionId: 'session-failed',
      outputPath: 'C:\\recordings\\session-failed.mkv',
      message: 'Encoder FIFO write exceeded the complete-frame delivery budget.'
    }
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'health.event', payload: encoderFailure })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'recording.status', payload: failedStatus })
      })
      // The backend can repeat both the terminal status and its correlated
      // health event. They still represent one user-visible failure.
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'health.event', payload: encoderFailure })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'recording.status', payload: failedStatus })
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'failed')

    expect(toastSpies.error).toHaveBeenCalledTimes(1)
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Recording stopped unexpectedly',
      expect.objectContaining({
        id: 'recording-stopped-unexpectedly',
        description: failedStatus.message,
        duration: Infinity,
        action: expect.objectContaining({ label: 'Open Library' }),
        cancel: expect.objectContaining({ label: 'Show in Finder' })
      })
    )
    expect(toastSpies.success).not.toHaveBeenCalled()
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'recording-failed',
      activity: 'recording',
      sessionId: 'session-failed',
      outputPath: failedStatus.outputPath,
      message: failedStatus.message
    })

    const toastOptions = toastSpies.error.mock.calls[0]?.[1] as {
      action: { onClick: () => void }
      cancel: { onClick: () => void }
    }
    toastOptions.action.onClick()
    toastOptions.cancel.onClick()
    expect(libraryNavigations).toEqual([{ tab: 'library', sessionId: 'session-failed' }])
    expect(revealSession).toHaveBeenCalledWith('session-failed')

    await act(async () => latest()!.core.dismissSessionRuntimeNotice())
    expect(latest()?.core.sessionRuntimeNotice).toBeNull()
    expect(toastSpies.dismiss).toHaveBeenCalledWith('recording-stopped-unexpectedly')
  })

  it('publishes a terminal recording failure that races initial bootstrap', async () => {
    const backend = new StudioBackend()
    const failedStatus = {
      state: 'failed' as const,
      sessionId: 'session-failed-during-bootstrap',
      outputPath: 'C:\\recordings\\session-failed-during-bootstrap.mkv',
      message: 'The encoder stopped while Studio was loading.'
    }
    const releaseRecordingStatus = backend.deferResponse('recording.status', failedStatus)
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
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'recording.status')
    )
    vi.clearAllMocks()

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'recording.status', payload: failedStatus })
      })
      releaseRecordingStatus()
      await Promise.resolve()
    })
    await waitForObservation(
      () => latest()?.core.sessionRuntimeNotice?.kind === 'recording-failed',
      100
    )

    expect(latest()?.recording.recording.state).toBe('failed')
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'recording-failed',
      sessionId: failedStatus.sessionId,
      message: failedStatus.message
    })
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Recording stopped unexpectedly',
      expect.objectContaining({
        id: 'recording-stopped-unexpectedly',
        description: failedStatus.message
      })
    )
  })

  it('recovers a recording failure missed during reconnect from durable session history', async () => {
    const initialBackend = new StudioBackend()
    initialBackend.recordingState = 'recording'
    TestWebSocket.backend = initialBackend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emit: ((name: string, value: unknown) => void) | undefined
    const revealSession = vi.fn(async () => {})
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      revealSession,
      registerEmitter: (nextEmit) => {
        emit = nextEmit
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    const libraryNavigations: unknown[] = []

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
        latest()?.recording.recording.state === 'recording'
    )
    await act(async () => {
      initialBackend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'recording',
            sessionId: 'session-failed-in-gap',
            startedAt: now,
            message: 'Recording.'
          }
        })
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () => latest()?.recording.recording.sessionId === 'session-failed-in-gap'
    )
    window.addEventListener('videorc:navigate-workspace', (event) => {
      libraryNavigations.push((event as CustomEvent).detail)
    })
    vi.clearAllMocks()

    const failureEvent: HealthEvent = {
      id: 'health-failure-in-gap',
      sessionId: 'session-failed-in-gap',
      level: 'error',
      code: 'encoder-bridge-failed',
      message: 'Encoder FIFO write exceeded the complete-frame delivery budget.',
      permissionPane: null,
      createdAt: '2026-08-25T11:00:00.000Z'
    }
    const reconnectedBackend = new StudioBackend()
    reconnectedBackend.sessionSummaries = [
      sessionSummary({
        id: 'session-failed-in-gap',
        status: 'failed',
        mode: 'record',
        outputPath: 'C:\\recordings\\session-failed-in-gap.mkv',
        healthEventCount: 1
      })
    ]
    reconnectedBackend.sessionHealthEvents = [failureEvent]
    TestWebSocket.backend = reconnectedBackend

    await act(async () => {
      emit?.('backend:connection', {
        host: '127.0.0.1',
        port: 9992,
        token: 'failure-gap-reconnect-token'
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.core.sessionRuntimeNotice?.kind === 'recording-failed')

    expect(latest()?.recording.recording.state).toBe('idle')
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'recording-failed',
      activity: 'recording',
      sessionId: 'session-failed-in-gap',
      outputPath: 'C:\\recordings\\session-failed-in-gap.mkv',
      message: failureEvent.message
    })
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Recording stopped unexpectedly',
      expect.objectContaining({
        id: 'recording-stopped-unexpectedly',
        description: failureEvent.message,
        duration: Infinity,
        action: expect.objectContaining({ label: 'Open Library' }),
        cancel: expect.objectContaining({ label: 'Show in Finder' })
      })
    )
    expect(reconnectedBackend.commands).toContainEqual(
      expect.objectContaining({
        method: 'sessions.healthEvents.list',
        params: expect.objectContaining({ sessionId: 'session-failed-in-gap' })
      })
    )

    const toastOptions = toastSpies.error.mock.calls.at(-1)?.[1] as {
      action: { onClick: () => void }
      cancel: { onClick: () => void }
    }
    toastOptions.action.onClick()
    toastOptions.cancel.onClick()
    expect(libraryNavigations).toEqual([{ tab: 'library', sessionId: 'session-failed-in-gap' }])
    expect(revealSession).toHaveBeenCalledWith('session-failed-in-gap')

    await act(async () => {
      reconnectedBackend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'health.event',
          payload: {
            ...failureEvent,
            id: 'late-microphone-loss-after-failure',
            level: 'warn',
            code: 'microphone-input-lost',
            message: 'The microphone stopped before the failed session ended.'
          }
        })
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'recording-failed',
      sessionId: 'session-failed-in-gap'
    })
    expect(toastSpies.warning).not.toHaveBeenCalled()

    vi.clearAllMocks()
    const failedSnapshotEvent: HealthEvent = {
      ...failureEvent,
      id: 'health-failed-snapshot',
      sessionId: 'session-failed-snapshot',
      message: 'FFmpeg exited before the recording could be finalized.'
    }
    const failedSnapshotBackend = new StudioBackend()
    failedSnapshotBackend.recordingStatusOverride = {
      state: 'failed',
      sessionId: 'session-failed-snapshot'
    }
    failedSnapshotBackend.sessionSummaries = [
      sessionSummary({
        id: 'session-failed-snapshot',
        status: 'failed',
        mode: 'record+stream',
        outputPath: 'C:\\recordings\\session-failed-snapshot.mkv',
        healthEventCount: 1
      })
    ]
    failedSnapshotBackend.sessionHealthEvents = [failedSnapshotEvent]
    TestWebSocket.backend = failedSnapshotBackend

    await act(async () => {
      emit?.('backend:connection', {
        host: '127.0.0.1',
        port: 9995,
        token: 'failed-snapshot-reconnect-token'
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () => latest()?.core.sessionRuntimeNotice?.sessionId === 'session-failed-snapshot'
    )

    expect(latest()?.recording.recording.state).toBe('failed')
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'recording-failed',
      activity: 'recording',
      sessionId: 'session-failed-snapshot',
      outputPath: 'C:\\recordings\\session-failed-snapshot.mkv',
      message: failedSnapshotEvent.message
    })
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Recording stopped unexpectedly',
      expect.objectContaining({
        description: failedSnapshotEvent.message,
        cancel: expect.objectContaining({ label: 'Show in Finder' })
      })
    )
  })

  it('recovers a microphone loss missed during reconnect for the still-active session', async () => {
    const initialBackend = new StudioBackend()
    initialBackend.recordingState = 'recording'
    initialBackend.recordingSessionId = 'session-mic-lost-in-gap'
    TestWebSocket.backend = initialBackend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emit: ((name: string, value: unknown) => void) | undefined
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
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
        latest()?.recording.recording.sessionId === 'session-mic-lost-in-gap'
    )
    vi.clearAllMocks()

    const microphoneLost: HealthEvent = {
      id: 'health-mic-lost-in-gap',
      sessionId: 'session-mic-lost-in-gap',
      level: 'warn',
      code: 'microphone-input-lost',
      message:
        'Microphone "Desk Mic" stopped after 92.3 seconds. Videorc replaced the missing input with silence.',
      permissionPane: null,
      createdAt: '2026-08-25T11:10:00.000Z'
    }
    const reconnectedBackend = new StudioBackend()
    reconnectedBackend.recordingState = 'recording'
    reconnectedBackend.recordingSessionId = 'session-mic-lost-in-gap'
    reconnectedBackend.sessionSummaries = [
      sessionSummary({
        id: 'session-mic-lost-in-gap',
        status: 'running',
        mode: 'record',
        healthEventCount: 1
      })
    ]
    reconnectedBackend.sessionHealthEvents = [microphoneLost]
    TestWebSocket.backend = reconnectedBackend

    await act(async () => {
      emit?.('backend:connection', {
        host: '127.0.0.1',
        port: 9993,
        token: 'microphone-gap-reconnect-token'
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () => latest()?.core.sessionRuntimeNotice?.kind === 'microphone-input-lost'
    )

    expect(latest()?.recording.recording.state).toBe('recording')
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'microphone-input-lost',
      activity: 'recording',
      phase: 'active',
      sessionId: 'session-mic-lost-in-gap',
      message: microphoneLost.message
    })
    expect(toastSpies.warning).toHaveBeenCalledTimes(1)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Microphone stopped — recording continues with silence',
      {
        id: 'microphone-input-lost',
        description: microphoneLost.message,
        duration: Infinity
      }
    )
    expect(reconnectedBackend.commands).toContainEqual(
      expect.objectContaining({
        method: 'sessions.healthEvents.list',
        params: expect.objectContaining({ sessionId: 'session-mic-lost-in-gap' })
      })
    )

    const secondReconnectBackend = new StudioBackend()
    secondReconnectBackend.recordingState = 'recording'
    secondReconnectBackend.recordingSessionId = 'session-mic-lost-in-gap'
    secondReconnectBackend.sessionSummaries = reconnectedBackend.sessionSummaries
    secondReconnectBackend.sessionHealthEvents = [microphoneLost]
    TestWebSocket.backend = secondReconnectBackend
    await act(async () => {
      emit?.('backend:connection', {
        host: '127.0.0.1',
        port: 9994,
        token: 'microphone-gap-second-reconnect-token'
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        secondReconnectBackend.commands.some(
          (command) => command.method === 'sessions.healthEvents.list'
        )
    )

    expect(toastSpies.warning).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    const replacementSessionBackend = new StudioBackend()
    replacementSessionBackend.recordingState = 'stopping'
    replacementSessionBackend.recordingSessionId = 'replacement-session'
    replacementSessionBackend.sessionSummaries = [
      sessionSummary({
        id: 'session-mic-lost-in-gap',
        status: 'failed',
        mode: 'record',
        healthEventCount: 1
      }),
      sessionSummary({
        id: 'replacement-session',
        status: 'running',
        mode: 'record',
        healthEventCount: 0
      })
    ]
    replacementSessionBackend.sessionHealthEvents = [
      {
        ...microphoneLost,
        id: 'old-session-terminal-failure',
        level: 'error',
        code: 'encoder-bridge-failed',
        message: 'The prior session failed while the renderer was disconnected.'
      }
    ]
    TestWebSocket.backend = replacementSessionBackend
    await act(async () => {
      emit?.('backend:connection', {
        host: '127.0.0.1',
        port: 9996,
        token: 'replacement-session-reconnect-token'
      })
      await Promise.resolve()
    })
    await waitForObservation(
      () => latest()?.recording.recording.sessionId === 'replacement-session'
    )

    expect(latest()?.core.sessionRuntimeNotice).toBeNull()
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(toastSpies.warning).not.toHaveBeenCalled()
    expect(
      replacementSessionBackend.commands.some(
        (command) => command.method === 'sessions.healthEvents.list'
      )
    ).toBe(false)
  })

  it('does not resurrect historical runtime failures during a fresh bootstrap', async () => {
    const backend = new StudioBackend()
    backend.sessionSummaries = [
      sessionSummary({
        id: 'historical-failed-session',
        status: 'failed',
        mode: 'record',
        healthEventCount: 2
      })
    ]
    backend.sessionHealthEvents = [
      {
        id: 'historical-mic-loss',
        sessionId: 'historical-failed-session',
        level: 'warn',
        code: 'microphone-input-lost',
        message: 'Historical microphone loss.',
        permissionPane: null,
        createdAt: '2026-08-24T10:00:00.000Z'
      },
      {
        id: 'historical-recording-failure',
        sessionId: 'historical-failed-session',
        level: 'error',
        code: 'ffmpeg-exit',
        message: 'Historical recording failure.',
        permissionPane: null,
        createdAt: '2026-08-24T10:01:00.000Z'
      }
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

    expect(latest()?.core.sessionRuntimeNotice).toBeNull()
    expect(
      backend.commands.some((command) => command.method === 'sessions.healthEvents.list')
    ).toBe(false)
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(toastSpies.warning).not.toHaveBeenCalled()
  })

  it('warns once when the microphone is lost while recording and still reports a saved take', async () => {
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
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    vi.clearAllMocks()

    const microphoneLost: HealthEvent = {
      id: 'health-microphone-lost',
      sessionId: 'session-with-silence',
      level: 'warn',
      code: 'microphone-input-lost',
      message: 'The selected microphone stopped providing audio.',
      permissionPane: null,
      createdAt: '2026-08-25T10:01:00.000Z'
    }
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'recording',
            sessionId: 'session-with-silence',
            startedAt: now,
            message: 'Recording.'
          }
        })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'health.event', payload: microphoneLost })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'health.event',
          payload: { ...microphoneLost, id: 'health-microphone-lost-repeat' }
        })
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')

    expect(toastSpies.warning).toHaveBeenCalledTimes(1)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Microphone stopped — recording continues with silence',
      {
        id: 'microphone-input-lost',
        description: microphoneLost.message,
        duration: Infinity
      }
    )
    expect(latest()?.recording.recording.state).toBe('recording')

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'idle',
            sessionId: 'session-with-silence',
            outputPath: 'C:\\recordings\\session-with-silence.mp4',
            durationMs: 5_000,
            message: 'Saved.'
          }
        })
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')

    expect(toastSpies.success).toHaveBeenCalledTimes(1)
    expect(toastSpies.success).toHaveBeenCalledWith(
      'Recording saved',
      expect.objectContaining({ duration: 12000 })
    )
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'microphone-input-lost',
      activity: 'recording',
      phase: 'ended',
      sessionId: 'session-with-silence',
      message: microphoneLost.message
    })
    expect(toastSpies.warning).toHaveBeenCalledTimes(2)
    expect(toastSpies.warning).toHaveBeenLastCalledWith(
      'Microphone stopped — saved recording contains silence',
      {
        id: 'microphone-input-lost',
        description: microphoneLost.message,
        duration: Infinity
      }
    )

    vi.clearAllMocks()
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'streaming',
            sessionId: 'next-session',
            startedAt: '2026-08-25T10:05:00.000Z',
            message: 'Live.'
          }
        })
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.recording.recording.sessionId === 'next-session')
    expect(latest()?.core.sessionRuntimeNotice).toBeNull()
    expect(toastSpies.dismiss).toHaveBeenCalledWith('microphone-input-lost')

    vi.clearAllMocks()
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'health.event',
          payload: {
            ...microphoneLost,
            id: 'health-stale-microphone-lost',
            sessionId: 'session-with-silence'
          }
        })
      })
      await Promise.resolve()
    })

    expect(toastSpies.warning).not.toHaveBeenCalled()
    expect(latest()?.core.sessionRuntimeNotice).toBeNull()

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'health.event',
          payload: {
            ...microphoneLost,
            id: 'health-live-microphone-lost',
            sessionId: 'next-session'
          }
        })
      })
      await Promise.resolve()
    })

    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Microphone stopped — live session continues with silence',
      expect.objectContaining({ id: 'microphone-input-lost' })
    )
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'microphone-input-lost',
      activity: 'live-stream',
      phase: 'active',
      sessionId: 'next-session'
    })

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'idle',
            sessionId: 'next-session',
            message: 'Live session ended.'
          }
        })
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')

    expect(toastSpies.success).not.toHaveBeenCalled()
    expect(toastSpies.warning).toHaveBeenLastCalledWith(
      'Microphone stopped during the live session',
      expect.objectContaining({ id: 'microphone-input-lost' })
    )
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'microphone-input-lost',
      activity: 'live-stream',
      phase: 'ended'
    })

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'streaming',
            sessionId: 'late-live-loss',
            message: 'Live.'
          }
        })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'stopping',
            sessionId: 'late-live-loss',
            message: 'Ending live session.'
          }
        })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'idle',
            sessionId: 'late-live-loss',
            message: 'Live session ended.'
          }
        })
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')

    vi.clearAllMocks()
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'health.event',
          payload: {
            ...microphoneLost,
            id: 'health-late-live-microphone-lost',
            sessionId: 'late-live-loss'
          }
        })
      })
      await Promise.resolve()
    })

    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Microphone stopped during the live session',
      expect.objectContaining({ id: 'microphone-input-lost' })
    )
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'microphone-input-lost',
      activity: 'live-stream',
      phase: 'ended',
      sessionId: 'late-live-loss'
    })
  })

  it('keeps a committed live source selection when output proof catches up late', async () => {
    const backend = new StudioBackend()
    backend.recordingState = 'recording'
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
        latest()?.recording.recording.state === 'recording'
    )
    vi.clearAllMocks()

    const sources = {
      ...latest()!.core.captureConfig.sources,
      screenId: 'screen:screencapturekit:2',
      windowId: undefined
    }
    await act(async () => {
      await latest()!.core.switchSourceDeviceLive('capture', sources)
    })

    expect(latest()?.core.captureConfig.sources).toEqual(sources)
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Switch committed — output catching up.',
      expect.objectContaining({ id: 'live-source-switch-output-catching-up' })
    )
  }, 10_000)

  it('builds the exact secret-free shared and split output topology shapes', () => {
    const streamVideo = {
      preset: 'stream-safe-1080p30' as const,
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 6000
    }
    const sharedConfig = {
      ...defaultCaptureConfig,
      recordEnabled: true,
      streamEnabled: true,
      video: streamVideo,
      streaming: {
        ...defaultCaptureConfig.streaming,
        enabled: true,
        defaultOutputPreset: streamVideo.preset,
        defaultBitrateKbps: streamVideo.bitrateKbps
      },
      captions: {
        ...defaultCaptureConfig.captions,
        enabled: false,
        burnTarget: 'off' as const
      }
    }

    const shared = buildStreamOutputTopologyProbeParams(sharedConfig)
    expect(shared).toEqual({
      streamProfile: streamVideo,
      recordingProfile: streamVideo,
      outputRoles: ['shared']
    })

    const captionSplit = buildStreamOutputTopologyProbeParams({
      ...sharedConfig,
      captions: { ...sharedConfig.captions, burnTarget: 'stream' }
    })
    expect(captionSplit.outputRoles).toEqual(['recording', 'stream'])

    const streamOnly = buildStreamOutputTopologyProbeParams({
      ...sharedConfig,
      recordEnabled: false
    })
    expect(streamOnly).toEqual({
      streamProfile: streamVideo,
      outputRoles: ['shared']
    })

    const youtubeHighRate = buildStreamOutputTopologyProbeParams({
      ...sharedConfig,
      streaming: {
        ...sharedConfig.streaming,
        defaultOutputPreset: 'stream-youtube-1080p60',
        defaultBitrateKbps: 12000,
        enabledTargetIds: ['youtube'],
        targets: sharedConfig.streaming.targets.map((target) =>
          target.id === 'youtube'
            ? {
                ...target,
                enabled: true,
                outputPreset: 'stream-youtube-1080p60',
                outputBitrateKbps: 12000
              }
            : target
        )
      }
    })
    expect(youtubeHighRate).toMatchObject({
      streamProfile: {
        preset: 'stream-youtube-1080p60',
        width: 1920,
        height: 1080,
        fps: 60,
        bitrateKbps: 12000
      },
      recordingProfile: streamVideo,
      outputRoles: ['recording', 'stream']
    })

    for (const platform of ['twitch', 'x'] as const) {
      const providerSafe = buildStreamOutputTopologyProbeParams({
        ...sharedConfig,
        recordEnabled: false,
        streaming: {
          ...sharedConfig.streaming,
          defaultOutputPreset: 'stream-youtube-1080p30',
          defaultBitrateKbps: 10000,
          enabledTargetIds: [platform],
          targets: sharedConfig.streaming.targets.map((target) => ({
            ...target,
            enabled: target.platform === platform
          }))
        }
      })
      expect(providerSafe).toEqual({
        streamProfile: videoPresets['stream-safe-1080p30'],
        outputRoles: ['shared']
      })
    }

    expect(JSON.stringify(streamOnly).toLowerCase()).not.toMatch(
      /streamkey|serverurl|oauth|accesstoken|refreshtoken/
    )
  })

  it('gates the provider-resolved profile for Basic Twitch/X and high-rate YouTube', () => {
    for (const platform of ['twitch', 'x'] as const) {
      const captureConfig = {
        ...defaultCaptureConfig,
        recordEnabled: false,
        streamEnabled: true,
        streaming: {
          ...defaultCaptureConfig.streaming,
          enabled: true,
          defaultOutputPreset: 'stream-youtube-1080p30' as const,
          defaultBitrateKbps: 10000,
          enabledTargetIds: [platform],
          targets: defaultCaptureConfig.streaming.targets.map((target) => ({
            ...target,
            enabled: target.platform === platform
          }))
        }
      }

      expect(
        resolvedStreamingProfileEntitlementGate(captureConfig, DEFAULT_BASIC_ENTITLEMENTS)
      ).toEqual({ allowed: true })
    }

    for (const preset of ['stream-youtube-1080p30', 'stream-youtube-1080p60'] as const) {
      const captureConfig = {
        ...defaultCaptureConfig,
        recordEnabled: false,
        streamEnabled: true,
        streaming: {
          ...defaultCaptureConfig.streaming,
          enabled: true,
          defaultOutputPreset: preset,
          defaultBitrateKbps: videoPresets[preset].bitrateKbps,
          enabledTargetIds: ['youtube'],
          targets: defaultCaptureConfig.streaming.targets.map((target) => ({
            ...target,
            enabled: target.platform === 'youtube'
          }))
        }
      }

      expect(
        resolvedStreamingProfileEntitlementGate(captureConfig, DEFAULT_BASIC_ENTITLEMENTS)
      ).toMatchObject({
        allowed: false,
        featureId: 'livestreaming',
        reason: expect.stringContaining('Videorc Premium')
      })
    }
  })

  it('keeps pending, failed, and stale topology verdicts start-blocking', () => {
    const params = buildStreamOutputTopologyProbeParams({
      ...defaultCaptureConfig,
      recordEnabled: false,
      streamEnabled: true
    })
    const requestKey = streamOutputTopologyProbeRequestKey(params)
    const result = {
      capabilityKey: `stream-output-topology-v1:${'a'.repeat(64)}`,
      streamProfile: params.streamProfile,
      outputRoles: params.outputRoles,
      requestedBridgeOutput: 'windows-media-foundation-h264-mpegts',
      effectiveBridgeOutput: 'raw-yuv420p',
      effectiveEncodeBackend: 'software-open-h264',
      probeState: 'rejected',
      fallbackReason: 'Hardware topology rejected this exact profile.'
    } satisfies StreamOutputTopologyProbeResult

    expect(streamOutputTopologyBlockReason({ state: 'pending', requestKey }, requestKey)).toContain(
      'Checking'
    )
    expect(
      streamOutputTopologyBlockReason(
        { state: 'failed', requestKey, message: 'probe timed out' },
        requestKey
      )
    ).toContain('probe timed out')
    expect(
      streamOutputTopologyBlockReason({ state: 'ready', requestKey, result }, requestKey)
    ).toBeNull()

    const splitResult = {
      ...result,
      recordingProfile: params.streamProfile,
      outputRoles: ['recording', 'stream']
    } satisfies StreamOutputTopologyProbeResult
    expect(
      streamOutputTopologyBlockReason(
        { state: 'ready', requestKey, result: splitResult },
        requestKey
      )
    ).toContain('Use one shared provider-safe profile')
    expect(
      streamOutputTopologyBlockReason(
        { state: 'ready', requestKey: `${requestKey}:stale`, result },
        requestKey
      )
    ).toContain('Checking')
  })

  it('keeps the real Go Live action blocked until its exact topology probe resolves', async () => {
    const backend = new StudioBackend()
    backend.entitlements = premiumEntitlements
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
        latest()?.core.wsStatus === 'connected' && latest()?.core.health?.ffmpeg.available === true
    )

    const streamVideo = {
      preset: 'stream-safe-1080p30' as const,
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 6000
    }
    const streamConfig = {
      ...defaultCaptureConfig,
      recordEnabled: false,
      streamEnabled: true,
      video: streamVideo,
      streaming: {
        ...defaultCaptureConfig.streaming,
        enabled: true,
        defaultOutputPreset: streamVideo.preset,
        defaultBitrateKbps: streamVideo.bitrateKbps,
        enabledTargetIds: ['youtube'],
        targets: defaultCaptureConfig.streaming.targets.map((target) =>
          target.id === 'youtube'
            ? {
                ...target,
                enabled: true,
                streamKey: 'secret-test-key',
                streamKeyPresent: false,
                status: { state: 'ready' as const }
              }
            : target
        )
      }
    }
    const topologyParams = buildStreamOutputTopologyProbeParams(streamConfig)
    const topologyResult = {
      capabilityKey: `stream-output-topology-v1:${'a'.repeat(64)}`,
      streamProfile: topologyParams.streamProfile,
      outputRoles: topologyParams.outputRoles,
      requestedBridgeOutput: 'windows-media-foundation-h264-mpegts',
      effectiveBridgeOutput: 'raw-yuv420p',
      effectiveEncodeBackend: 'software-open-h264',
      probeState: 'rejected',
      fallbackReason: 'Media Foundation rejected this exact stream profile.'
    } satisfies StreamOutputTopologyProbeResult
    const releaseTopology = backend.deferResponse('stream.output.topology.probe', topologyResult)

    await act(async () => {
      latest()!.core.setCaptureConfig(streamConfig)
    })
    await waitForObservation(() => latest()?.core.streamOutputTopologyPreflight.state === 'pending')
    expect(latest()?.core.startBlockedReason).toContain('Checking the exact livestream')

    await act(async () => {
      await latest()!.core.startSession()
    })
    expect(backend.sentCommands.some((command) => command.method === 'session.start')).toBe(false)

    await act(async () => {
      releaseTopology()
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.core.streamOutputTopologyPreflight.state === 'ready')

    expect(latest()?.core.streamOutputTopologyPreflight).toMatchObject({
      state: 'ready',
      result: {
        effectiveBridgeOutput: 'raw-yuv420p',
        effectiveEncodeBackend: 'software-open-h264',
        fallbackReason: 'Media Foundation rejected this exact stream profile.'
      }
    })
    expect(latest()?.core.startBlockedReason).toBeNull()
    expect(
      backend.sentCommands.filter((command) => command.method === 'stream.output.topology.probe')
    ).toHaveLength(1)
    expect(
      JSON.stringify(
        backend.sentCommands.find((command) => command.method === 'stream.output.topology.probe')
          ?.params
      ).toLowerCase()
    ).not.toMatch(/streamkey|serverurl|oauth|accesstoken|refreshtoken/)
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

    backend.layoutResponseDelayMs = 100
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: {
              intentId: 'ri-test-scene',
              intent: { kind: 'sceneApply', layoutPreset: 'screen-only' }
            }
          })
        })
      }
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'scene.layout.apply_preview')
    )
    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-scene'
      )
    ).toBeUndefined()

    await waitForObservation(
      () => latest()?.core.captureConfig.layout.layoutPreset === 'screen-only'
    )
    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-scene'
      )?.params
    ).toMatchObject({ intentId: 'ri-test-scene', ok: true })
  })

  it('serializes a delayed remote start followed by stop so the final stop wins', async () => {
    const backend = new StudioBackend()
    const releaseStart = backend.deferResponse('session.start', {
      state: 'recording',
      sessionId: 'session-1',
      startedAt: now,
      message: 'Recording.'
    })
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      })
    )
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')

    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: { intentId: 'ri-delayed-start', intent: { kind: 'recordStart' } }
          })
        })
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: { intentId: 'ri-following-stop', intent: { kind: 'recordStop' } }
          })
        })
      }
      await Promise.resolve()
    })

    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'session.start')
    )
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.start')
    ).toHaveLength(1)
    expect(backend.sentCommands.some((command) => command.method === 'session.stop')).toBe(false)

    await act(async () => {
      releaseStart()
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')

    const lifecycleMethods = backend.sentCommands
      .filter((command) => command.method === 'session.start' || command.method === 'session.stop')
      .map((command) => command.method)
    expect(lifecycleMethods).toEqual(['session.start', 'session.stop'])
    expect(
      backend.sentCommands
        .filter((command) => command.method === 'remote.intent.ack')
        .map((command) => command.params)
    ).toEqual(
      expect.arrayContaining([
        { intentId: 'ri-delayed-start', ok: true },
        { intentId: 'ri-following-stop', ok: true }
      ])
    )
  })

  it('waits for active-session microphone truth before ACK and remote projection', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      })
    )
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({ event: 'backend.ready', payload: null })
        })
      }
      await Promise.resolve()
    })
    await act(async () => {
      await latest()?.core.startSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.surface.publish' &&
          (command.params as { state?: { micMuted?: boolean } }).state?.micMuted === false
      )
    )

    const commandStart = backend.sentCommands.length
    const releaseAudioUpdate = backend.deferResponse('audio.processing.update', {
      applied: true,
      sessionId: 'session-1',
      microphoneGainDb: 0,
      microphoneMuted: true
    })
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: { intentId: 'ri-test-mic-active', intent: { kind: 'micToggle' } }
          })
        })
      }
    })
    await waitForObservation(
      () =>
        latest()?.core.captureConfig.audio.microphoneMuted === true &&
        backend.sentCommands
          .slice(commandStart)
          .some((command) => command.method === 'audio.processing.update')
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })

    expect(
      backend.sentCommands
        .slice(commandStart)
        .find(
          (command) =>
            command.method === 'remote.intent.ack' &&
            (command.params as { intentId?: string }).intentId === 'ri-test-mic-active'
        )
    ).toBeUndefined()
    expect(
      backend.sentCommands
        .slice(commandStart)
        .filter((command) => command.method === 'remote.surface.publish')
        .every(
          (command) =>
            (command.params as { state?: { micMuted?: boolean } }).state?.micMuted === false
        )
    ).toBe(true)

    releaseAudioUpdate()
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-mic-active'
      )
    )
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.surface.publish' &&
          (command.params as { state?: { micMuted?: boolean } }).state?.micMuted === true
      )
    )
    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-mic-active'
      )?.params
    ).toEqual({ intentId: 'ri-test-mic-active', ok: true })

    const reconciliationStart = backend.sentCommands.length
    const releaseReconciliation = backend.deferResponse('audio.processing.update', {
      applied: false,
      sessionId: 'session-1',
      microphoneGainDb: 0,
      microphoneMuted: false,
      reasonCode: 'live-audio-control-unavailable',
      confirmedMicrophoneGainDb: 0,
      confirmedMicrophoneMuted: false
    })
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: { intentId: 'ri-test-mic-reconciled', intent: { kind: 'micUnmute' } }
          })
        })
      }
    })
    await waitForObservation(
      () =>
        latest()?.core.captureConfig.audio.microphoneMuted === false &&
        backend.sentCommands
          .slice(reconciliationStart)
          .some((command) => command.method === 'audio.processing.update')
    )
    expect(
      backend.sentCommands
        .slice(reconciliationStart)
        .find(
          (command) =>
            command.method === 'remote.intent.ack' &&
            (command.params as { intentId?: string }).intentId === 'ri-test-mic-reconciled'
        )
    ).toBeUndefined()

    releaseReconciliation()
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-mic-reconciled'
      )
    )
    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-mic-reconciled'
      )?.params
    ).toEqual({ intentId: 'ri-test-mic-reconciled', ok: true })
  })

  it('NACKs an active remote microphone rejection and projects confirmed rollback truth', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      })
    )
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({ event: 'backend.ready', payload: null })
        })
      }
      await Promise.resolve()
    })
    await act(async () => {
      await latest()?.core.startSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')

    const commandStart = backend.sentCommands.length
    const releaseAudioUpdate = backend.deferResponse('audio.processing.update', {
      applied: false,
      sessionId: 'session-1',
      microphoneGainDb: 0,
      microphoneMuted: true,
      reasonCode: 'live-audio-control-unavailable',
      confirmedMicrophoneGainDb: 0,
      confirmedMicrophoneMuted: false
    })
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: { intentId: 'ri-test-mic-rejected', intent: { kind: 'micMute' } }
          })
        })
      }
    })
    await waitForObservation(
      () =>
        latest()?.core.captureConfig.audio.microphoneMuted === true &&
        backend.sentCommands
          .slice(commandStart)
          .some((command) => command.method === 'audio.processing.update')
    )
    expect(
      backend.sentCommands
        .slice(commandStart)
        .find(
          (command) =>
            command.method === 'remote.intent.ack' &&
            (command.params as { intentId?: string }).intentId === 'ri-test-mic-rejected'
        )
    ).toBeUndefined()

    releaseAudioUpdate()
    await waitForObservation(() => latest()?.core.captureConfig.audio.microphoneMuted === false)
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-mic-rejected'
      )
    )

    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-mic-rejected'
      )?.params
    ).toEqual({
      intentId: 'ri-test-mic-rejected',
      ok: false,
      message: 'The microphone change was not applied.'
    })
    expect(
      backend.sentCommands
        .slice(commandStart)
        .filter((command) => command.method === 'remote.surface.publish')
        .some(
          (command) =>
            (command.params as { state?: { micMuted?: boolean } }).state?.micMuted === true
        )
    ).toBe(false)
  })

  it('keeps the layout unchanged and acks false when a remote scene is rejected', async () => {
    const backend = new StudioBackend()
    backend.layoutApplyFailure = 'definite'
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      })
    )
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    const layoutBefore = latest()?.core.captureConfig.layout

    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: {
              intentId: 'ri-test-scene-rejected',
              intent: { kind: 'sceneApply', layoutPreset: 'screen-only' }
            }
          })
        })
      }
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-scene-rejected'
      )
    )

    expect(latest()?.core.captureConfig.layout).toEqual(layoutBefore)
    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-scene-rejected'
      )?.params
    ).toEqual({
      intentId: 'ri-test-scene-rejected',
      ok: false,
      message: 'The layout change was not committed.'
    })
  })

  it('reconciles an outcome-unknown remote scene commit and acks true', async () => {
    const backend = new StudioBackend()
    backend.layoutApplyFailure = 'request-outcome-unknown-after-commit'
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      })
    )
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')

    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: {
              intentId: 'ri-test-scene-outcome-unknown',
              intent: { kind: 'sceneApply', layoutPreset: 'side-by-side' }
            }
          })
        })
      }
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-scene-outcome-unknown'
      )
    )

    expect(latest()?.core.captureConfig.layout.layoutPreset).toBe('side-by-side')
    expect(latest()?.core.lastError).toBeNull()
    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-scene-outcome-unknown'
      )?.params
    ).toEqual({ intentId: 'ri-test-scene-outcome-unknown', ok: true })
  })

  it('acks false for definite takeover failure and outcome-unknown clear mismatch', async () => {
    const backend = new StudioBackend()
    backend.screens = [takeoverScreen]
    backend.screenActivateFailure = 'definite'
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      })
    )
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')

    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: {
              intentId: 'ri-test-takeover-definite-failure',
              intent: { kind: 'takeoverShow', assetId: takeoverScreen.id }
            }
          })
        })
      }
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-takeover-definite-failure'
      )
    )
    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-takeover-definite-failure'
      )?.params
    ).toEqual({
      intentId: 'ri-test-takeover-definite-failure',
      ok: false,
      message: 'The takeover was not activated.'
    })
    expect(backend.activeScreen).toBeNull()

    backend.screenActivateFailure = null
    backend.screenClearFailure = 'request-outcome-unknown-before-commit'
    backend.activeScreen = takeoverScreen
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'screens.active.changed',
            payload: takeoverScreen
          })
        })
      }
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.core.activeScreen?.id === takeoverScreen.id)

    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: {
              intentId: 'ri-test-takeover-clear-outcome-unknown',
              intent: { kind: 'takeoverHide' }
            }
          })
        })
      }
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId ===
            'ri-test-takeover-clear-outcome-unknown'
      )
    )
    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId ===
            'ri-test-takeover-clear-outcome-unknown'
      )?.params
    ).toEqual({
      intentId: 'ri-test-takeover-clear-outcome-unknown',
      ok: false,
      message: 'The takeover was not cleared.'
    })
    expect(backend.activeScreen?.id).toBe(takeoverScreen.id)
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

  // Live Chat Co-host S2: the renderer must start the engine for the live chat
  // session, carry the RENDERER-owned consent on every start, render the
  // backend's state verbatim, and clear a question through the real RPC.
  it('starts the co-host for a live chat session, carries consent, and answers a question', async () => {
    const backend = new StudioBackend()
    backend.entitlements = premiumEntitlements
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
    await waitForObservation(() => latest()?.core.cohostSettings !== null)
    expect(latest()?.core.cohostSettings?.enabled).toBe(true)

    const emit = async (event: string, payload: unknown): Promise<void> => {
      await act(async () => {
        for (const socket of backend.sockets) {
          socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
        }
        await Promise.resolve()
      })
    }

    await emit('liveChat.snapshot', {
      sessionId: 'live-1',
      providers: [],
      messages: [],
      unreadCount: 0,
      updatedAt: now
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'cohost.start')
    )

    const start = backend.sentCommands.find((command) => command.method === 'cohost.start')!
    expect(start.params).toMatchObject({ sessionId: 'live-1', consentToProcessChat: true })

    await emit('cohost.state', {
      sessionId: 'live-1',
      status: 'listening',
      reason: null,
      questions: [
        {
          id: 'q-1',
          text: 'What keyboard is that?',
          messageIds: ['twitch:m-1'],
          askers: ['Ada'],
          platforms: ['twitch'],
          priority: 'high',
          suggestedReply: 'Keychron Q1.',
          fromNotes: false,
          firstSeenAt: now,
          updatedAt: now
        }
      ],
      flags: [],
      mood: 'hype',
      lastTickAt: now,
      tickSeq: 1,
      partial: false
    })
    await waitForObservation(() => latest()?.chat.cohostState?.questions.length === 1)
    expect(latest()?.chat.cohostState?.status).toBe('listening')

    backend.cohostState = {
      ...backend.cohostState,
      sessionId: 'live-1',
      status: 'listening',
      tickSeq: 1,
      questions: latest()!.chat.cohostState!.questions
    }
    await act(async () => {
      latest()!.core.markCohostQuestionAnswered('q-1')
    })
    await waitForObservation(() => latest()?.chat.cohostState?.questions.length === 0)

    const answered = backend.sentCommands.find(
      (command) => command.method === 'cohost.question.answered'
    )
    expect(answered?.params).toEqual({ sessionId: 'live-1', questionId: 'q-1' })
    expect(toastSpies.error).not.toHaveBeenCalled()
  }, 15_000)

  it('never starts the co-host without the renderer-owned cloud-AI consent flag', async () => {
    const backend = new StudioBackend()
    backend.entitlements = premiumEntitlements
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
    localStorage.setItem('videorc.aiConsent', '0')
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
    await waitForObservation(() => latest()?.core.cohostSettings !== null)

    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'liveChat.snapshot',
            payload: {
              sessionId: 'live-2',
              providers: [],
              messages: [],
              unreadCount: 0,
              updatedAt: now
            }
          })
        })
      }
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'cohost.start')
    )

    const start = backend.sentCommands.find((command) => command.method === 'cohost.start')!
    expect(start.params).toMatchObject({ sessionId: 'live-2', consentToProcessChat: false })
    // The engine — not the renderer — decides what a missing consent means.
    await waitForObservation(() => latest()?.chat.cohostState?.reason === 'consent-required')
    expect(latest()?.chat.cohostState?.status).toBe('paused')
  }, 15_000)

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

    let startPromise: Promise<boolean> | undefined
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

  it('keeps an exact-session stopping event authoritative when start responds late', async () => {
    const backend = new StudioBackend()
    backend.authoritativeRecordingStatusBeforeStartResponse = 'stopping'
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )

    let started: boolean | undefined
    await act(async () => {
      started = await latest()?.core.startSession()
    })

    expect(started).toBe(false)
    expect(latest()?.recording.recording).toMatchObject({
      state: 'stopping',
      sessionId: 'session-1',
      message: 'Session ended before start replied.'
    })
  })

  it('coalesces overlapping starts when an exact-session terminal event wins the response race', async () => {
    const backend = new StudioBackend()
    backend.sessionStartResponseDelayMs = 100
    backend.authoritativeRecordingStatusBeforeStartResponse = 'stopping'
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )

    let results: boolean[] = []
    await act(async () => {
      const firstStart = latest()!.core.startSession()
      const secondStart = latest()!.core.startSession()
      results = await Promise.all([firstStart, secondStart])
    })

    expect(results).toEqual([false, false])
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.start')
    ).toHaveLength(1)
    expect(latest()?.recording.recording).toMatchObject({
      state: 'stopping',
      sessionId: 'session-1',
      message: 'Session ended before start replied.'
    })
  })

  it('cleans up one prepared broadcast without activating it after a coalesced start ends early', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.sessionStartResponseDelayMs = 100
    backend.authoritativeRecordingStatusBeforeStartResponse = 'stopping'
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )

    await openYouTubeGoLiveConfirmation(latest)

    await act(async () => {
      const firstConfirmation = latest()!.core.confirmGoLive()
      const secondConfirmation = latest()!.core.confirmGoLive()
      await Promise.all([firstConfirmation, secondConfirmation])
    })

    expect(
      backend.sentCommands.filter((command) => command.method === 'session.start')
    ).toHaveLength(1)
    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.youtube.prepare')
    ).toHaveLength(1)
    expect(backend.youtubePrepareCount).toBe(1)
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ broadcastId: 'youtube-broadcast-1' })
      })
    ])
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'live'
      )
    ).toHaveLength(0)
    expect(
      backend.sentCommands.filter(
        (command) => command.method === 'streamTargets.youtube.streamStatus'
      )
    ).toHaveLength(0)
    expect(latest()?.recording.recording).toMatchObject({
      state: 'stopping',
      sessionId: 'session-1'
    })
  })

  it('retains rejected pre-session cleanup and retries it before preparing another broadcast', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.sessionStartError = 'The encoder rejected this start.'
    backend.youtubeCompleteFailuresRemaining = 1
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    expect(backend.youtubePrepareCount).toBe(1)
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(1)

    backend.sessionStartError = null
    await act(async () => {
      await latest()!.core.startSession()
    })

    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(2)
    expect(backend.youtubePrepareCount).toBe(1)
    expect(latest()?.core.goLiveConfirmationOpen).toBe(true)
  })

  it('retains cancelled partial-setup cleanup and retries it before preparing again', async () => {
    const backend = new StudioBackend()
    enableYouTubeAndXOauthForTest(backend)
    backend.xPrepareFailuresRemaining = 1
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeAndXGoLiveConfirmation(latest)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })
    await waitForObservation(() => latest()?.core.goLivePartialSetup !== null)

    backend.youtubeCompleteFailuresRemaining = 1
    await act(async () => {
      latest()!.core.cancelGoLiveConfirmation()
    })
    await waitForObservation(
      () =>
        backend.sentCommands.filter(
          (command) =>
            command.method === 'streamTargets.youtube.transition' &&
            (command.params as { status?: string }).status === 'complete'
        ).length === 1
    )

    await act(async () => {
      await latest()!.core.startSession()
    })

    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(2)
    expect(backend.youtubePrepareCount).toBe(1)
    expect(latest()?.core.goLiveConfirmationOpen).toBe(true)
  })

  it('joins a pending start response before Stop cleans its prepared broadcast', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    const releaseStart = backend.deferResponse('session.start', {
      state: 'recording',
      sessionId: 'session-1',
      startedAt: now,
      message: 'Recording.'
    })
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)

    let confirmationPromise!: Promise<void>
    await act(async () => {
      confirmationPromise = latest()!.core.confirmGoLive()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'session.start')
    )

    let stopPromise!: Promise<boolean>
    await act(async () => {
      stopPromise = latest()!.core.stopSession()
      await Promise.resolve()
    })
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(0)
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.stop')
    ).toHaveLength(0)

    await act(async () => {
      releaseStart()
      await Promise.all([confirmationPromise, stopPromise])
    })

    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(1)
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'live'
      )
    ).toHaveLength(0)
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.stop')
    ).toHaveLength(1)
    expect(latest()?.recording.recording.state).toBe('idle')
  })

  it('does not activate a prepared broadcast when the session ends during Library refresh', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.terminalRecordingStatusOnMethod = 'sessions.list'
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)

    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    expect(backend.terminalRecordingStatusOnMethodEmitted).toBe(true)
    expect(
      backend.sentCommands.filter(
        (command) => command.method === 'streamTargets.youtube.streamStatus'
      )
    ).toHaveLength(0)
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'live'
      )
    ).toHaveLength(0)
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(1)
    expect(latest()?.recording.recording).toMatchObject({
      state: 'stopping',
      sessionId: 'session-1'
    })
  })

  it('does not transition a prepared broadcast live when the session ends during ingest proof', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.terminalRecordingStatusOnMethod = 'streamTargets.youtube.streamStatus'
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)

    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    expect(backend.terminalRecordingStatusOnMethodEmitted).toBe(true)
    expect(
      backend.sentCommands.filter(
        (command) => command.method === 'streamTargets.youtube.streamStatus'
      )
    ).toHaveLength(1)
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'live'
      )
    ).toHaveLength(0)
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(1)
  })

  it.each(['success', 'failure'] as const)(
    'does not overwrite stopped YouTube state when a deferred ingest poll resolves with %s',
    async (outcome) => {
      const backend = new StudioBackend()
      enableYouTubeOauthForTest(backend)
      const releasePoll =
        outcome === 'success'
          ? backend.deferResponse('streamTargets.youtube.streamStatus', {
              platform: 'youtube',
              accountId: 'youtube-account-1',
              streamId: 'youtube-stream-1',
              streamStatus: 'active',
              active: true,
              message: 'YouTube ingest is active.'
            })
          : backend.deferFailure(
              'streamTargets.youtube.streamStatus',
              new Error('Deferred YouTube ingest probe failed.')
            )
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

      root = await mountStudioProvider(testDom.container, (value) => {
        observations.push(value)
      })
      await waitForObservation(
        () =>
          latest()?.core.wsStatus === 'connected' &&
          latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
      )
      await openYouTubeGoLiveConfirmation(latest)

      let confirmationPromise!: Promise<void>
      await act(async () => {
        confirmationPromise = latest()!.core.confirmGoLive()
        await Promise.resolve()
      })
      await waitForObservation(() =>
        backend.sentCommands.some(
          (command) => command.method === 'streamTargets.youtube.streamStatus'
        )
      )

      let stopped: boolean | undefined
      await act(async () => {
        stopped = await latest()!.core.stopSession()
      })
      expect(stopped).toBe(true)
      expect(
        latest()?.core.captureConfig.streaming.targets.find(
          (target) => target.platform === 'youtube'
        )?.status?.state
      ).toBe('stopped')

      await act(async () => {
        releasePoll()
        await confirmationPromise
      })

      expect(
        backend.sentCommands.filter(
          (command) =>
            command.method === 'streamTargets.youtube.transition' &&
            (command.params as { status?: string }).status === 'live'
        )
      ).toHaveLength(0)
      expect(
        backend.sentCommands.filter(
          (command) =>
            command.method === 'streamTargets.youtube.transition' &&
            (command.params as { status?: string }).status === 'complete'
        )
      ).toHaveLength(1)
      expect(
        latest()?.core.captureConfig.streaming.targets.find(
          (target) => target.platform === 'youtube'
        )?.status?.state
      ).toBe('stopped')
      expect(
        toastSpies.warning.mock.calls.some(([message]) =>
          String(message).startsWith('Could not transition')
        )
      ).toBe(false)
    }
  )

  it('does not publish a live target state when the session ends during the transition RPC', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.terminalRecordingStatusOnMethod = 'streamTargets.youtube.transition'
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)

    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    expect(backend.terminalRecordingStatusOnMethodEmitted).toBe(true)
    expect(
      backend.sentCommands
        .filter((command) => command.method === 'streamTargets.youtube.transition')
        .map((command) => (command.params as { status?: string }).status)
    ).toEqual(['live', 'complete'])
    expect(
      observations.some((observation) =>
        observation.core.captureConfig.streaming.targets.some(
          (target) => target.platform === 'youtube' && target.status?.state === 'live'
        )
      )
    ).toBe(false)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'youtube')
        ?.status?.state
    ).toBe('stopped')
  })

  it('correlates a sessionless terminal push while the YouTube transition is pending', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    const releaseLiveTransition = backend.deferResponse(
      'streamTargets.youtube.transition',
      {
        platform: 'youtube',
        accountId: 'youtube-account-1',
        broadcastId: 'youtube-broadcast-1',
        requestedStatus: 'live',
        lifecycleStatus: 'live',
        message: 'YouTube broadcast transitioned to live.'
      },
      (command) => (command.params as { status?: string }).status === 'live'
    )
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)

    let confirmationPromise!: Promise<void>
    await act(async () => {
      confirmationPromise = latest()!.core.confirmGoLive()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'live'
      )
    )

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'failed',
            message: 'Encoder stopped without a session ID.'
          }
        })
      })
      releaseLiveTransition()
      await confirmationPromise
    })

    expect(
      backend.sentCommands
        .filter((command) => command.method === 'streamTargets.youtube.transition')
        .map((command) => (command.params as { status?: string }).status)
    ).toEqual(['live', 'complete'])
    expect(
      observations.some((observation) =>
        observation.core.captureConfig.streaming.targets.some(
          (target) => target.platform === 'youtube' && target.status?.state === 'live'
        )
      )
    ).toBe(false)
    expect(latest()?.recording.recording).toMatchObject({
      state: 'failed',
      sessionId: 'session-1'
    })
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'youtube')
        ?.status?.state
    ).toBe('stopped')
  })

  it('ends the actual X broadcast when the session dies during publish', async () => {
    const backend = new StudioBackend()
    enableXOauthForTest(backend)
    backend.xPublishTweetError = 'The announcement post was rejected.'
    backend.terminalRecordingStatusOnMethod = 'streamTargets.x.publish'
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openXGoLiveConfirmation(latest)

    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    expect(backend.terminalRecordingStatusOnMethodEmitted).toBe(true)
    expect(backend.xPrepareCount).toBe(1)
    expect(backend.xPublishCount).toBe(1)
    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ broadcastId: 'x-broadcast-1' })
      })
    ])
    expect(
      backend.sentCommands.some(
        (command) =>
          command.method === 'streamTargets.x.end' &&
          (command.params as { broadcastId?: string }).broadcastId === 'x-region-1'
      )
    ).toBe(false)
    expect(
      backend.sentCommands.filter((command) => command.method === 'liveChat.x.start')
    ).toHaveLength(0)
    expect(
      observations.some((observation) =>
        observation.core.captureConfig.streaming.targets.some(
          (target) => target.platform === 'x' && target.status?.state === 'live'
        )
      )
    ).toBe(false)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'x')
        ?.status?.state
    ).toBe('stopped')
  })

  it('keeps a published X broadcast live when only the announcement post fails', async () => {
    const backend = new StudioBackend()
    enableXOauthForTest(backend)
    backend.xPublishTweetError = 'The announcement post was rejected.'
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openXGoLiveConfirmation(latest)

    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'x')
        ?.status
    ).toMatchObject({
      state: 'live',
      lastError: 'The announcement post was rejected.',
      redactedUrl: 'https://x.com/i/broadcasts/1'
    })
    expect(
      backend.sentCommands.filter((command) => command.method === 'liveChat.x.start')
    ).toHaveLength(1)

    await act(async () => {
      await latest()!.core.stopSession()
    })
    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toHaveLength(1)
  })

  it('cleans the exact owner after an autonomous terminal status omits its session ID', async () => {
    const backend = new StudioBackend()
    enableYouTubeAndXOauthForTest(backend)
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeAndXGoLiveConfirmation(latest)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'liveChat.snapshot',
          payload: {
            sessionId: 'session-1',
            providers: [],
            messages: [],
            unreadCount: 0,
            updatedAt: now
          }
        })
      })
    })
    await waitForObservation(() => latest()?.chat.liveChatSnapshot.sessionId === 'session-1')

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'failed',
            message: 'Encoder stopped unexpectedly.'
          }
        })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'failed',
            message: 'Repeated encoder terminal status.'
          }
        })
      })
    })
    await waitForObservation(() =>
      Boolean(
        latest()
          ?.core.captureConfig.streaming.targets.filter(
            (target) => target.platform === 'youtube' || target.platform === 'x'
          )
          .every((target) => target.status?.state === 'stopped')
      )
    )

    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ broadcastId: 'x-broadcast-1' })
      })
    ])
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ broadcastId: 'youtube-broadcast-1' })
      })
    ])
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.stop')
    ).toHaveLength(0)
    expect(latest()?.recording.recording.state).toBe('failed')
    expect(latest()?.chat.liveChatSnapshot.sessionId).toBeUndefined()
  })

  it('retains an autonomous cleanup owner after failure and retries it before another Go Live', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    backend.youtubeCompleteFailuresRemaining = 1
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'failed',
            sessionId: 'session-1',
            message: 'Encoder stopped unexpectedly.'
          }
        })
      })
    })
    await waitForObservation(
      () =>
        backend.sentCommands.filter(
          (command) =>
            command.method === 'streamTargets.youtube.transition' &&
            (command.params as { status?: string }).status === 'complete'
        ).length === 1 &&
        latest()?.core.captureConfig.streaming.targets.find(
          (target) => target.platform === 'youtube'
        )?.status?.state === 'warning'
    )

    await act(async () => {
      await latest()!.core.startSession()
    })

    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(2)
    expect(backend.youtubePrepareCount).toBe(1)
    expect(latest()?.core.goLiveConfirmationOpen).toBe(true)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'youtube')
        ?.status?.state
    ).toBe('stopped')
  })

  it('completes YouTube once when Stop races its pending live transition', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    const releaseLiveTransition = backend.deferResponse(
      'streamTargets.youtube.transition',
      {
        platform: 'youtube',
        accountId: 'youtube-account-1',
        broadcastId: 'youtube-broadcast-1',
        requestedStatus: 'live',
        lifecycleStatus: 'live',
        message: 'YouTube broadcast transitioned to live.'
      },
      (command) => (command.params as { status?: string }).status === 'live'
    )
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)

    let confirmationPromise!: Promise<void>
    await act(async () => {
      confirmationPromise = latest()!.core.confirmGoLive()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'live'
      )
    )

    let stopPromise!: Promise<boolean>
    await act(async () => {
      stopPromise = latest()!.core.stopSession()
      await Promise.resolve()
    })
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(0)
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.stop')
    ).toHaveLength(0)
    await act(async () => {
      releaseLiveTransition()
      await Promise.all([confirmationPromise, stopPromise])
    })

    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(1)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'youtube')
        ?.status?.state
    ).toBe('stopped')
  })

  it('retries YouTube completion after a real failure during a Stop/start race', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.youtubeCompleteFailuresRemaining = 1
    const releaseLiveTransition = backend.deferResponse(
      'streamTargets.youtube.transition',
      {
        platform: 'youtube',
        accountId: 'youtube-account-1',
        broadcastId: 'youtube-broadcast-1',
        requestedStatus: 'live',
        lifecycleStatus: 'live',
        message: 'YouTube broadcast transitioned to live.'
      },
      (command) => (command.params as { status?: string }).status === 'live'
    )
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)

    let confirmationPromise!: Promise<void>
    await act(async () => {
      confirmationPromise = latest()!.core.confirmGoLive()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'live'
      )
    )

    let stopPromise!: Promise<boolean>
    await act(async () => {
      stopPromise = latest()!.core.stopSession()
      await Promise.resolve()
    })
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(0)
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.stop')
    ).toHaveLength(0)
    await act(async () => {
      releaseLiveTransition()
      await Promise.all([confirmationPromise, stopPromise])
    })

    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(1)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'youtube')
        ?.status?.state
    ).toBe('warning')

    await act(async () => {
      await latest()!.core.startSession()
    })

    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(2)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'youtube')
        ?.status?.state
    ).toBe('stopped')
  })

  it('retries an X END after a real failure instead of caching the rejection', async () => {
    const backend = new StudioBackend()
    enableXOauthForTest(backend)
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openXGoLiveConfirmation(latest)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    backend.xEndFailuresRemaining = 1
    await act(async () => {
      await latest()!.core.stopSession()
    })

    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toHaveLength(1)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'x')
        ?.status?.state
    ).toBe('warning')

    await act(async () => {
      await latest()!.core.startSession()
    })

    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toHaveLength(2)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'x')
        ?.status?.state
    ).toBe('stopped')
    expect(latest()?.core.goLiveConfirmationOpen).toBe(true)
  })

  it('bounds a hung X END, stops the encoder, and retains cleanup for the next start', async () => {
    const backend = new StudioBackend()
    enableXOauthForTest(backend)
    const releaseEnd = backend.deferResponse('streamTargets.x.end', {
      platform: 'x',
      accountId: 'x-account-1',
      broadcastId: 'x-broadcast-1',
      message: 'X broadcast ended.'
    })
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openXGoLiveConfirmation(latest)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    let stopPromise!: Promise<boolean>
    await act(async () => {
      stopPromise = latest()!.core.stopSession()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'streamTargets.x.end')
    )
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.stop')
    ).toHaveLength(0)

    let stopped: boolean | undefined
    await act(async () => {
      stopped = await stopPromise
    })

    expect(stopped).toBe(true)
    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toHaveLength(1)
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.stop')
    ).toHaveLength(1)
    expect(latest()?.recording.recording.state).toBe('idle')

    await act(async () => {
      releaseEnd()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await latest()!.core.startSession()
    })

    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toHaveLength(1)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'x')
        ?.status?.state
    ).toBe('stopped')
    expect(latest()?.core.goLiveConfirmationOpen).toBe(true)
  })

  it('waits for an in-flight X publish and ENDs its actual broadcast before encoder Stop', async () => {
    const backend = new StudioBackend()
    enableXOauthForTest(backend)
    const releasePublish = backend.deferResponse('streamTargets.x.publish', {
      platform: 'x',
      accountId: 'x-account-1',
      sourceId: 'x-source-1',
      broadcastId: 'x-broadcast-1',
      mediaKey: 'x-media-key-1',
      shareUrl: 'https://x.com/i/broadcasts/1',
      state: 'running',
      message: 'X broadcast published.'
    })
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openXGoLiveConfirmation(latest)

    let confirmationPromise!: Promise<void>
    await act(async () => {
      confirmationPromise = latest()!.core.confirmGoLive()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'streamTargets.x.publish')
    )

    let stopPromise!: Promise<boolean>
    await act(async () => {
      stopPromise = latest()!.core.stopSession()
      await Promise.resolve()
    })
    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toHaveLength(0)
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.stop')
    ).toHaveLength(0)

    await act(async () => {
      releasePublish()
      await Promise.all([confirmationPromise, stopPromise])
    })

    const xEndIndex = backend.sentCommands.findIndex(
      (command) => command.method === 'streamTargets.x.end'
    )
    const sessionStopIndex = backend.sentCommands.findIndex(
      (command) => command.method === 'session.stop'
    )
    expect(xEndIndex).toBeGreaterThan(-1)
    expect(sessionStopIndex).toBeGreaterThan(xEndIndex)
    expect(backend.sentCommands[xEndIndex]).toEqual(
      expect.objectContaining({
        params: expect.objectContaining({ broadcastId: 'x-broadcast-1' })
      })
    )
    expect(
      backend.sentCommands.filter((command) => command.method === 'liveChat.x.start')
    ).toHaveLength(0)
    expect(latest()?.recording.recording.state).toBe('idle')
  })

  it('ends X once from its exact owner when Stop races stale UI and pending chat', async () => {
    const backend = new StudioBackend()
    enableXOauthForTest(backend)
    const releaseChatStart = backend.deferResponse('liveChat.x.start', {
      sessionId: 'session-1',
      providers: [],
      messages: [],
      unreadCount: 0,
      updatedAt: now
    })
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openXGoLiveConfirmation(latest)

    let confirmationPromise!: Promise<void>
    await act(async () => {
      confirmationPromise = latest()!.core.confirmGoLive()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'liveChat.x.start')
    )

    await act(async () => {
      const current = latest()!.core.captureConfig
      latest()!.core.setCaptureConfig({
        ...current,
        streaming: {
          ...current.streaming,
          targets: current.streaming.targets.map((target) =>
            target.platform === 'x'
              ? {
                  ...target,
                  platformBroadcastId: 'x-region-1',
                  platformStreamId: 'x-source-1',
                  status: { state: 'ready' as const, message: 'Stale prepared UI snapshot.' }
                }
              : target
          )
        }
      })
    })
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'x')
        ?.platformBroadcastId
    ).toBe('x-region-1')

    await act(async () => {
      await latest()!.core.stopSession()
    })
    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ broadcastId: 'x-broadcast-1' })
      })
    ])
    await act(async () => {
      releaseChatStart()
      await confirmationPromise
    })

    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ broadcastId: 'x-broadcast-1' })
      })
    ])
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.platform === 'x')
        ?.status?.state
    ).toBe('stopped')
    expect(latest()?.recording.recording.state).toBe('idle')
    expect(latest()?.chat.liveChatSnapshot).toMatchObject({
      messages: [],
      unreadCount: 0
    })
    expect(latest()?.chat.liveChatSnapshot.sessionId).toBeUndefined()
  })

  it('rejects a conflicting record start while a prepared livestream start is pending', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.sessionStartResponseDelayMs = 100
    backend.authoritativeRecordingStatusBeforeStartResponse = 'stopping'
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

    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    const recordStart = latest()!.core.startSession
    await openYouTubeGoLiveConfirmation(latest)

    let confirmationPromise!: Promise<void>
    await act(async () => {
      confirmationPromise = latest()!.core.confirmGoLive()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'session.start')
    )

    let conflictingRecordResult: boolean | undefined
    await act(async () => {
      conflictingRecordResult = await recordStart()
      await confirmationPromise
    })

    expect(conflictingRecordResult).toBe(false)
    const startCommands = backend.sentCommands.filter(
      (command) => command.method === 'session.start'
    )
    expect(startCommands).toHaveLength(1)
    expect(startCommands[0]?.params).toMatchObject({
      output: { recordEnabled: false, streamEnabled: true }
    })
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

    backend.sessionStartError = 'Stale physical-source readiness warning.'
    await act(async () => {
      await invoke({ action: 'start' })
    })
    await waitForObservation(
      () => observations.at(-1)?.core.lastError === 'Stale physical-source readiness warning.'
    )
    state = await invoke({ action: 'state' })
    expect(state?.lastError).toBe('Stale physical-source readiness warning.')
    backend.sessionStartError = null
    await act(async () => {
      state = await invoke({
        action: 'configure',
        screenId: 'screen:dxgi:0000000000000001:1',
        cameraId: 'camera:1',
        microphoneId: 'mic:1'
      })
    })
    expect(state?.lastError).toBeNull()

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

  it('does not let Settings overwrite a newer Main-owned account refresh', async () => {
    const backend = new StudioBackend()
    backend.accountSnapshot = signedInAccount
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const refreshedAccount: VideorcAccountSnapshot = {
      ...signedInAccount,
      displayName: 'Provider Test Refreshed'
    }
    let resolveProviderRefresh!: (snapshot: VideorcAccountSnapshot) => void
    const providerRefresh = new Promise<VideorcAccountSnapshot>((resolve) => {
      resolveProviderRefresh = resolve
    })
    const refreshAccount = vi.fn(async () =>
      refreshAccount.mock.calls.length === 1 ? signedInAccount : providerRefresh
    )
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      refreshAccount
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
        latest()?.core.account?.status === 'signed-in' &&
        refreshAccount.mock.calls.length >= 1
    )

    const accountGetsBeforeRefresh = backend.sentCommands.filter(
      (command) => command.method === 'account.get'
    ).length
    const releaseStaleAccountGet = backend.deferResponse('account.get', signedInAccount)
    let maintenance!: Promise<void>
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      maintenance = latest()!.core.refreshBackend()
      await Promise.resolve()
    })
    await waitForObservation(() => refreshAccount.mock.calls.length >= 2)

    await act(async () => {
      resolveProviderRefresh(refreshedAccount)
      releaseStaleAccountGet()
      await maintenance
    })
    await waitForObservation(
      () =>
        latest()?.core.account?.status === 'signed-in' &&
        latest()?.core.account === refreshedAccount
    )

    expect(latest()?.core.account).toEqual(refreshedAccount)
    expect(backend.sentCommands.filter((command) => command.method === 'account.get').length).toBe(
      accountGetsBeforeRefresh
    )
  })

  it('keeps a newer Basic entitlement event over a stale Premium focus response', async () => {
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
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')

    const releaseStalePremium = backend.deferResponse('entitlements.refresh', premiumEntitlements)
    let maintenance!: Promise<void>
    await act(async () => {
      maintenance = latest()!.core.refreshBackend()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'entitlements.refresh' &&
          backend.commands.every((completed) => completed.id !== command.id)
      )
    )

    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'entitlements.updated', payload: DEFAULT_BASIC_ENTITLEMENTS })
      })
      releaseStalePremium()
      await maintenance
    })
    await waitForObservation(() => latest()?.core.entitlements?.tier === 'basic')

    expect(latest()?.core.entitlements).toEqual(DEFAULT_BASIC_ENTITLEMENTS)
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

  it('meters the mic on a real idle Studio and keeps it open across a session', async () => {
    // The meter is armed by the mixer being on screen, not by a session: the
    // question it answers ("is my microphone working?") is asked before
    // recording starts. B2 previously kept it closed while idle; that made an
    // idle meter indistinguishable from a dead microphone.
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'darwin',
      getMediaAccessStatus: async () => ({ camera: 'granted', microphone: 'granted' })
    })
    const testDom = installProviderTestEnvironment(api)
    const audio = installVisualMicAudioEnvironment()
    restoreEnvironment = () => {
      audio.restore()
      testDom.restore()
    }
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    const micLifecycle: boolean[] = []

    await act(async () => {
      root = createRoot(testDom.container)
      root.render(
        createElement(
          BackgroundAssetsProvider,
          null,
          createElement(
            StudioProvider,
            null,
            createElement(StudioMicVisualProvider, {
              enabled: true,
              children: [
                createElement(Probe, {
                  key: 'studio',
                  observe: (value) => {
                    observations.push(value)
                  }
                }),
                createElement(MicVisualProbe, {
                  key: 'mic',
                  observe: (active) => {
                    micLifecycle.push(active)
                  }
                })
              ]
            })
          )
        )
      )
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.mediaAccess?.microphone === 'granted' &&
        latest()?.core.selectedMicrophone?.id === 'mic:1'
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(latest()?.core.isSessionActive).toBe(false)
    // Idle, with no toggle flipped: the analyser is already running.
    await waitForObservation(() => micLifecycle.at(-1) === true)
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1)
    expect(audio.contexts).toHaveLength(1)

    await act(async () => {
      await latest()?.core.startSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    expect(micLifecycle.at(-1)).toBe(true)
    // Starting a session must REUSE the open stream, not open a second one.
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1)
    expect(audio.getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    })
    expect(audio.contexts).toHaveLength(1)

    await act(async () => {
      await latest()?.core.stopSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
    // Stopping the session leaves the meter running: the mixer is still on
    // screen, and the user is still entitled to see their level.
    expect(micLifecycle.at(-1)).toBe(true)
    expect(audio.contexts[0]?.close).not.toHaveBeenCalled()
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1)
  }, 15_000)
})

/**
 * navigator.mediaDevices + AudioContext fakes for the visual mic pipeline,
 * layered over installProviderTestEnvironment (which supplies window/document).
 */
function installVisualMicAudioEnvironment(): {
  contexts: Array<{ close: ReturnType<typeof vi.fn> }>
  getUserMedia: ReturnType<typeof vi.fn>
  stopTrack: ReturnType<typeof vi.fn>
  restore: () => void
} {
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = []
  const stopTrack = vi.fn()
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }))
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
        getFloatFrequencyData: (samples) => samples.fill(Number.NEGATIVE_INFINITY),
        getFloatTimeDomainData: (samples) => samples.fill(0)
      }
    }

    createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
      return { connect: () => {}, disconnect: () => {} }
    }
  }
  const descriptors = new Map(
    ['navigator', 'AudioContext'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name)
    ])
  )
  // The analyser clock is a held frame queue here: lifecycle (open/close) is
  // what this environment proves, and the provider env's rAF-as-setTimeout(0)
  // would spin the sampler at `at = 0` forever.
  const fakeWindow = window as unknown as Record<string, unknown>
  const previousRequestFrame = fakeWindow.requestAnimationFrame
  const previousCancelFrame = fakeWindow.cancelAnimationFrame
  const heldFrames = new Map<number, FrameRequestCallback>()
  let nextFrameId = 0
  fakeWindow.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = ++nextFrameId
    heldFrames.set(id, callback)
    return id
  }
  fakeWindow.cancelAnimationFrame = (id: number): void => void heldFrames.delete(id)
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone 1' }
        ],
        getUserMedia
      }
    }
  })
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: FakeAudioContext
  })
  return {
    contexts,
    getUserMedia,
    stopTrack,
    restore: () => {
      fakeWindow.requestAnimationFrame = previousRequestFrame
      fakeWindow.cancelAnimationFrame = previousCancelFrame
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  }
}

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
  refreshAccount?: VideorcApi['refreshAccount']
  signOutAccount?: VideorcApi['signOutAccount']
  backendConnection?: BackendConnection
  registerEmitter?: (emit: (name: string, value: unknown) => void) => void
  pushCommentHighlightResult?: VideorcApi['pushCommentHighlightResult']
  pushChatSendResult?: VideorcApi['pushChatSendResult']
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
      ...(options.refreshAccount ? { refreshAccount: options.refreshAccount } : {}),
      ...(options.signOutAccount ? { signOutAccount: options.signOutAccount } : {}),
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
      pushCommentHighlightResult: options.pushCommentHighlightResult ?? (async () => true),
      pushChatSendResult: options.pushChatSendResult ?? (async () => true),
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
