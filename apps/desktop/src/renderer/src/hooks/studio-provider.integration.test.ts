import { chatDeliveryProgress, deliveryCursor } from '../../../shared/chat-delivery'
import {
  applyCommentsSnapshotDelta,
  hydrateCommentsSnapshot,
  reconcileBrokerCommentsSnapshot
} from '../../../shared/comments-snapshot-delta'
import type {
  CommentsSnapshotDelta,
  CommentsViewSnapshot,
  OverlayLayout
} from '../../../shared/backend'
import {
  SCENE_LIBRARY_KEY,
  WORKING_SCENE_KEY,
  normalizeSceneVisual,
  sameSceneVisual
} from '../lib/scene-presets'
import { SCENES_KEY, type Scene as StoredScene, type SceneLibrary } from '../lib/scenes'
import { editVerticalStreamLayout } from '../components/studio/vertical-stream-layout-control'
// Loaded up front so the Studio's first-launch migration (its own chunk)
// resolves inside the mount's `act`, as a stored library does.
import { defaultScenes } from '../lib/scenes-migration'
import { act, createElement, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Window as TestWindow } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const toastSpies = vi.hoisted(() => ({
  dismiss: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
  warning: vi.fn()
}))
vi.mock('sonner', () => ({ toast: toastSpies }))
// The highlight card is painted on an OffscreenCanvas, which the node test
// environment lacks. Only the painter (and the card pair it paints, whose
// vertical card exists exactly when a vertical canvas is passed) is stubbed;
// layout stays real elsewhere.
vi.mock('@/lib/caption-overlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/caption-overlay')>()),
  renderCommentHighlightPng: async () => 'cG5n',
  renderCommentHighlightCards: async (
    _message: unknown,
    _avatarUrl: unknown,
    _stream: unknown,
    vertical?: unknown
  ) => (vertical ? { pngBase64: 'cG5n', verticalPngBase64: 'cG5n' } : { pngBase64: 'cG5n' })
}))

import { offersHandOff } from '@/lib/cloud-handoff-view'
import { notifications } from '@/lib/notifications'
import { revealInFileManagerLabel } from '@/lib/platform'
import { LayoutTab } from '@/components/tabs/layout-tab'
import { newScenes } from '@/lib/scene-app-picker'
import { sourceVisibilityFromScene } from '@/lib/scene-presets'
import { isMediaAccessSnapshotReady, systemAccessRows } from '@/lib/system-access'
import type {
  AccountCallbackEnvelope,
  AudioMeterResult,
  AudioTrack,
  BackendConnection,
  Banner,
  BuddyOverlaySnapshot,
  CaptionsStatus,
  CaptionsUpdate,
  CaptureRecoveryStatus,
  CloudStatus,
  CohostSettings,
  CohostSettingsPatch,
  CohostState,
  CommentHighlightCommand,
  CommentHighlightState,
  CommentsCommandResolution,
  CommentsSendCommand,
  CommentsSendOperation,
  CompositorStatus,
  DeviceList,
  Device,
  HealthEvent,
  LayoutPreset,
  LayoutSettings,
  LiveChatMessage,
  LiveChatSnapshot,
  NoiseCleanupJob,
  OAuthCallbackEnvelope,
  PerformanceCheckState,
  PlatformAccountValidation,
  PreviewSurfaceBounds,
  PreviewSurfaceStatus,
  PreviewWindowState,
  RecordingStatus,
  ResourceSelection,
  Scene,
  SceneCommitStatus,
  SessionLogEntry,
  SessionSources,
  SourceSwitchOperation,
  SourceSwitchParams,
  SourceSelection,
  SessionSummary,
  SessionChatTotals,
  StreamOutputTopologyProbeResult,
  StreamScreen,
  StreamingSettings,
  VideorcAccountRefreshResult,
  VideorcAccountSnapshot,
  VideorcApi
} from '../../../shared/backend'
import { resolveStreamOutputTopologyRequest } from '@/lib/go-live-output'
import { SCREEN_IMAGE_REFUSALS } from '../../../shared/screen-image-files'
import { DEFAULT_OVERLAY_LAYOUT, overlaySnapRect } from '@/lib/overlay-layout'
import { bannerSnapRect } from '@/lib/banner-place'
import { BackgroundAssetsProvider } from './use-background-assets'
import { useFrameSource } from './use-frame-source'
import { useStudioMicVisualSource } from './use-studio-mic-sources'
import { StudioMicVisualProvider, useStudioMicVisualLifecycle } from './use-studio-mic-visual'
import {
  StudioProvider,
  buildStreamOutputTopologyProbeParams,
  resolvedStreamingProfileEntitlementGate,
  STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON,
  streamOutputTopologyBlockReason,
  streamOutputTopologySplitRejected,
  streamOutputTopologyProbeRequestKey,
  useStudioAudio,
  useStudioBanners,
  useStudioCaptions,
  useStudioChat,
  useStudioCloud,
  useStudioCore,
  useStudioDiagnostics,
  useStudioRecording,
  useStudioReplay,
  useStudioShell,
  type StudioCloudContextValue,
  type StudioCoreContextValue,
  type StudioRecordingContextValue
} from './use-studio'
import { DEFAULT_BASIC_ENTITLEMENTS, STREAMING_LIMITS } from '../lib/entitlements'
import type { SessionStopOrigin } from '../lib/session-stop'
import {
  buildCameraSources,
  buildCaptureSources,
  buildMicrophoneSources,
  defaultCaptureConfig,
  ORIENTATION_DEFAULT_PRESET,
  STORAGE_KEYS,
  videoPresets,
  type CaptureConfig
} from '../lib/capture'
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
/** A deferred response that the test backend computes when it is released. */
const BACKEND_RESPONSE = Symbol('backend response')
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
    streaming: STREAMING_LIMITS
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
  dockSlot: null,
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
  dockSlot: null,
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
        visible: layout.sourceVisibility?.capture !== false,
        locked: false
      },
      {
        id: 'camera-source',
        name: 'Camera 1',
        kind: 'camera',
        deviceId: 'camera:1',
        transform: { ...transform, x: 0.7, y: 0.7, width: 0.25, height: 0.25 },
        defaultTransform: { ...transform, x: 0.7, y: 0.7, width: 0.25, height: 0.25 },
        // Freeform composes screen and camera whatever the preset (scene.rs
        // push_freeform_sources); only the preset Screen only leaves it out.
        visible:
          (layout.arrangementMode === 'freeform' || layout.layoutPreset !== 'screen-only') &&
          layout.sourceVisibility?.camera !== false,
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

// The horizontal output a fresh install records at; asserted by value so a
// default change (1440p30 → 1080p30 with the performance check) stays one edit.
const DEFAULT_OUTPUT = defaultCaptureConfig.video

class StudioBackend {
  hardwareStreamTopology = false
  scheduledConfirmation: {
    eventId: string
    fingerprint: string
    title: string
    privacy: string
    startUtc: string
  } | null = null
  scheduledConfirmationTargetId = 'youtube'
  /** Plan 209 S10: answer the Go Live check with a ready row per destination
   * sent, as the backend does, so a Go Live without the dialog sees rows. */
  confirmationRowsFromStreaming = false
  sockets: TestWebSocket[] = []
  performanceCheck: PerformanceCheckState = { running: false, stale: false }
  commands: BackendCommand[] = []
  sentCommands: BackendCommand[] = []
  currentLayout = defaultCaptureConfig.layout
  currentScene = sceneForLayout(this.currentLayout)
  revision = 1
  confirmedSources = { ...defaultCaptureConfig.sources }
  confirmedSourceRevision = 0
  sourceOperation: SourceSwitchOperation | null = null
  sourceFailure: string | null = null
  recordingState: RecordingStatus['state'] = 'idle'
  recordingReplayOnly = false
  recordingSessionId: string | undefined
  sourceCapabilities: SessionSources['capabilities'] | null = null
  chatTotals: SessionChatTotals | null = null
  recordingStatusOverride: RecordingStatus | undefined
  captionsStatus: CaptionsStatus = { state: 'idle' }
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
  latestLayoutIntentId = 0
  // Layouts the vertical simulcast leg was asked to show (explicit leg
  // requests never touch the program layout).
  simulcastLegLayouts: LayoutSettings[] = []
  // Opt-in live output proof: diagnostics report the committed revision as
  // the active output revision, so live layout commits settle instead of
  // waiting out the proof timeout.
  reportsActiveSceneRevision = false
  layoutApplyFailure:
    | 'definite'
    | 'camera-not-ready'
    | 'request-outcome-unknown-after-commit'
    | null = null
  screenActivateFailure: 'definite' | null = null
  screenClearFailure: 'request-outcome-unknown-before-commit' | null = null
  sessionStartResponseDelayMs = 0
  sessionStartCommitsScene = false
  sessionStartError: string | null = null
  emitRecordingStatusBeforeStartResponse = false
  authoritativeRecordingStatusBeforeStartResponse: 'stopping' | 'idle' | 'failed' | null = null
  terminalRecordingStatusOnMethod: string | null = null
  terminalRecordingStatusOnMethodEmitted = false
  youtubePrepareCount = 0
  /** Plan 184: what `cloud.status` answers; null is an older backend with no cloud. */
  cloudStatus: CloudStatus | null = null
  /** Plan 243: `cloud.show.handOff` refuses with this code and stops nothing. */
  handOffRefusal: string | null = null
  /** Plan 243 R2 A-M5: the stop happened, but videorc.com was not told. */
  handOffConfirmed = true
  youtubeCompleteFailuresRemaining = 0
  /** Plan 094: `complete` refused by the backend's quota breaker (coded). */
  youtubeCompleteQuotaFailuresRemaining = 0
  xPrepareCount = 0
  xPrepareFailuresRemaining = 0
  xPublishCount = 0
  xEndFailuresRemaining = 0
  platformAccountValidations: PlatformAccountValidation[] = []
  audioProcessingResponseDelayMs = 0
  audioProcessingReasonCode: string | null = null
  deviceListFailuresRemaining = 0
  audioMeterFailuresRemaining = 0
  sessionDetailFailuresRemaining = 0
  sessionSummaries: SessionSummary[] = []
  sessionListNextCursor: string | undefined
  /** Serve `sessions.list` by cursor + limit from `sessionSummaries`. */
  sessionListPaged = false
  sessionHealthEvents: HealthEvent[] = []
  sessionLogs: SessionLogEntry[] = []
  overlayLayout: OverlayLayout = DEFAULT_OVERLAY_LAYOUT
  cohostSettings: CohostSettings = {
    enabled: true,
    tone: 'friendly',
    notes: '',
    autoHighlight: false,
    voiceHighlight: false,
    rules: [],
    listen: false,
    wakeWordRequired: false,
    removeConfirm: 'confirm',
    persona: {
      id: 'default',
      name: 'Sidekick',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default',
      avatar: { kind: 'still' },
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {}
    },
    autoChat: {
      talk: 'off',
      mode: 'off',
      greetings: { enabled: false, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    }
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
  screenImportFailures = new Set<string>()
  activeScreen: StreamScreen | null = null
  banners: Banner[] = []
  audioMeterResult: AudioMeterResult = { status: 'ready', level: 0.4 }
  liveChatSnapshot: LiveChatSnapshot = {
    providers: [],
    messages: [],
    unreadCount: 0,
    updatedAt: now
  }
  commentHighlightState: CommentHighlightState = { generation: 0, phase: 'idle' }
  commentHighlightCanvases: { vertical?: { width: number; height: number } } = {}
  commentHighlightClearOutcomeUnknownRemaining = 0
  liveChatSendOperations: CommentsSendOperation[] = []
  liveChatSendFailure: { code: string; message: string } | null = null
  captureRecoveryStatus: CaptureRecoveryStatus = {
    revision: 0,
    phase: 'idle',
    retryable: false,
    attempts: 0
  }

  /** An event on the provider's socket, ahead of the reply being built. */
  pushEvent(event: string, payload: unknown): void {
    this.sockets[0]?.onmessage?.({ data: JSON.stringify({ event, payload }) })
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

  sourceSnapshot(sessionId: string): SessionSources {
    return {
      sessionId,
      sourceRevision: this.confirmedSourceRevision,
      outputProcessId: 42,
      audio: null,
      confirmed: {
        screenId: this.confirmedSources.screenId ?? null,
        windowId: this.confirmedSources.windowId ?? null,
        cameraId: this.confirmedSources.cameraId ?? null,
        microphoneId: this.confirmedSources.microphoneId ?? null,
        testPattern: this.confirmedSources.testPattern ?? false
      },
      health: [],
      pending: null,
      lastOperation: this.sourceOperation,
      capabilities: this.sourceCapabilities ?? [
        { kind: 'camera', supported: true, reason: null },
        { kind: 'capture', supported: true, reason: null },
        { kind: 'microphone', supported: true, reason: null }
      ]
    }
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
      case 'overlays.layout.get':
        return this.overlayLayout
      case 'overlays.layout.set':
        this.overlayLayout = params as OverlayLayout
        return this.overlayLayout
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
          reason: params.consentToProcessChat === true ? null : 'consent-required',
          listening: this.cohostSettings.listen
            ? params.consentToProcessChat === true
              ? { state: 'on' }
              : { state: 'blocked', reasonCode: 'consent-required' }
            : { state: 'off' }
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
      case 'sources.resolve_app_window': {
        // Plan 210: the app's front window is the listed window the scene
        // prefers, when the device list has it, else the first listed window
        // under the app's bundle id (a relaunched app's new window);
        // otherwise the app is not open.
        const listed = this.deviceList.devices.filter(
          (device) => device.kind === 'window' && device.status === 'available'
        )
        const preferred =
          listed.find((device) => device.id === params.preferWindowId) ??
          listed.find((device) => device.app?.bundleId === params.bundleId)
        return preferred
          ? { ok: true, windowId: preferred.id, title: preferred.name, width: 1280, height: 720 }
          : { ok: false, reason: 'not-running' }
      }
      case 'audio.meter.sample':
        if (this.audioMeterFailuresRemaining > 0) {
          this.audioMeterFailuresRemaining -= 1
          throw new Error('Temporary audio.meter.sample failure.')
        }
        return this.audioMeterResult
      case 'sessions.comments.totals':
        return this.chatTotals?.sessionId === params.sessionId ? this.chatTotals : null
      case 'recording.status':
        if (this.recordingStatusOverride) {
          return this.recordingStatusOverride
        }
        return {
          state: this.recordingState,
          ...(this.recordingSessionId ? { sessionId: this.recordingSessionId } : {}),
          ...(this.recordingReplayOnly ? { replayOnly: true } : {}),
          message: 'Ready.'
        }
      case 'stream.output.topology.probe':
        return {
          capabilityKey: `stream-output-topology-v1:${'0'.repeat(64)}`,
          streamProfile: params.streamProfile,
          ...(params.recordingProfile ? { recordingProfile: params.recordingProfile } : {}),
          outputRoles: params.outputRoles,
          requestedBridgeOutput: this.hardwareStreamTopology
            ? 'videotoolbox-h264-mpegts'
            : 'raw-yuv420p',
          effectiveBridgeOutput: this.hardwareStreamTopology
            ? 'videotoolbox-h264-mpegts'
            : 'raw-yuv420p',
          effectiveEncodeBackend: this.hardwareStreamTopology
            ? 'hardware-videotoolbox'
            : 'software-open-h264',
          probeState: 'not-required'
        }
      case 'diagnostics.stats':
        return {
          ...(this.reportsActiveSceneRevision ? { activeSceneRevision: this.revision } : {}),
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
        return this.captionsStatus
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
      case 'comments.highlight.canvases':
        return this.commentHighlightCanvases
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
      // A start answers with the source's status, as the backend does; the
      // launch start runs at once since PH-08, inside most tests.
      case 'preview.camera.start':
      case 'preview.camera.status':
        return {
          state: 'failed',
          targetFps: 30,
          framesCaptured: 0,
          droppedFrames: 0,
          updatedAt: now
        }
      case 'preview.screen.start':
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
        this.currentLayout = params.layout as LayoutSettings
        this.currentScene = {
          ...this.currentScene,
          // Rust `scene_from_capture_config`: the idle commit's scene has the
          // background it was given, and none when it was given none.
          background: params.background as Scene['background'],
          sources: this.currentScene.sources.map((source) => ({
            ...source,
            visible:
              source.kind === 'camera'
                ? this.currentLayout.sourceVisibility?.camera !== false &&
                  this.currentLayout.layoutPreset !== 'screen-only'
                : this.currentLayout.sourceVisibility?.capture !== false
          }))
        }
        return {
          applied: true,
          mode: 'idle',
          sceneRevision: this.revision,
          scene: this.currentScene,
          compositorStatus: compositorFor(this.currentScene, this.currentLayout, this.revision)
        }
      case 'scene.source.visibility.update': {
        this.currentScene = {
          ...this.currentScene,
          sources: this.currentScene.sources.map((source) =>
            source.id === params.sourceId ? { ...source, visible: params.visible === true } : source
          )
        }
        const sourceVisibility = sourceVisibilityFromScene(
          this.currentScene,
          this.currentLayout.sourceVisibility
        )
        this.currentLayout = { ...this.currentLayout, sourceVisibility }
        this.revision += 1
        return {
          applied: true,
          mode: this.recordingState === 'recording' ? 'hot' : 'idle',
          sceneRevision: this.revision,
          scene: this.currentScene,
          compositorStatus: compositorFor(this.currentScene, this.currentLayout, this.revision)
        }
      }
      case 'scene.layout.apply_preview':
      case 'scene.layout.apply_live': {
        if (params.simulcastLeg === true) {
          this.simulcastLegLayouts.push(params.layout as LayoutSettings)
          return {
            applied: true,
            mode: 'hot',
            intentId: params.intentId,
            sceneRevision: this.revision,
            presentationProven: true,
            scene: this.currentScene,
            compositorStatus: compositorFor(this.currentScene, this.currentLayout, this.revision)
          }
        }
        if (Number(params.intentId ?? 0) < this.latestLayoutIntentId)
          throw Object.assign(new Error('superseded'), { code: 'layout-intent-superseded' })
        this.latestLayoutIntentId = Number(params.intentId ?? 0)
        if (this.layoutApplyFailure === 'definite') {
          throw Object.assign(new Error('The test backend rejected the layout change.'), {
            code: 'layout-preview-failed'
          })
        }
        if (this.layoutApplyFailure === 'camera-not-ready') {
          // Plan 216 A3: the backend names the source that never sent a frame.
          throw Object.assign(
            new Error(
              'Live preview layout switch blocked after camera (15s) exceeded its source-start/readiness budget: camera session never delivered a frame (frames captured: 0, /Users/streamer/Library/Logs/camera.log).'
            ),
            { code: 'layout-camera-not-ready' }
          )
        }
        this.currentLayout = params.layout as LayoutSettings
        this.currentScene = sceneForLayout(this.currentLayout)
        const visualSources = params.sources as CaptureConfig['sources']
        this.currentScene = {
          ...this.currentScene,
          background: params.background as Scene['background'],
          sources: this.currentScene.sources.map((source) =>
            source.kind === 'camera'
              ? { ...source, deviceId: visualSources.cameraId }
              : source.kind === 'screen' || source.kind === 'window'
                ? {
                    ...source,
                    kind: visualSources.windowId ? ('window' as const) : ('screen' as const),
                    deviceId: visualSources.windowId ?? visualSources.screenId
                  }
                : source
          )
        }
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
      case 'session.source.switch': {
        const params = command.params as SourceSwitchParams
        if (params.expectedSourceRevision !== this.confirmedSourceRevision)
          throw Object.assign(new Error('Source revision changed'), {
            code: 'source-switch-stale-revision'
          })
        if (this.sourceFailure) {
          this.sourceOperation = {
            requestId: params.requestId,
            kind: params.kind,
            deviceId: params.deviceId,
            stage: 'failed',
            reason: this.sourceFailure,
            previousSource: 'preserved',
            outputObserved: false
          }
          return this.sourceSnapshot(params.sessionId)
        }
        const deviceId = params.deviceId ?? undefined
        if (params.kind === 'camera') this.confirmedSources.cameraId = deviceId
        else if (params.kind === 'microphone') this.confirmedSources.microphoneId = deviceId
        else {
          this.confirmedSources.screenId = deviceId?.startsWith('screen:') ? deviceId : undefined
          this.confirmedSources.windowId = deviceId?.startsWith('window:') ? deviceId : undefined
        }
        this.confirmedSourceRevision += 1
        this.sourceOperation = {
          requestId: params.requestId,
          kind: params.kind,
          deviceId: params.deviceId,
          stage: 'applied',
          reason: null,
          previousSource: 'preserved',
          outputObserved: false
        }
        return this.sourceSnapshot(params.sessionId)
      }
      case 'session.sources.get':
        return this.sourceSnapshot(String(params.sessionId))
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
      case 'screens.importImage': {
        const capabilityId = String(params.sourceCapability)
        if (this.screenImportFailures.has(capabilityId)) {
          throw new Error('The test backend could not read this image.')
        }
        const screen: StreamScreen = {
          ...takeoverScreen,
          id: `screen-${capabilityId}`,
          name: capabilityId,
          sortOrder: this.screens.length
        }
        this.screens.push(screen)
        return screen
      }
      case 'screens.list':
        return this.screens
      case 'screens.active':
        return this.activeScreen
      // Plan 186: a small in-memory banner store with the backend's replies.
      case 'banners.list':
        return this.banners
      case 'banners.show':
      case 'banners.update': {
        const { id, ...patch } = params as { id: string } & Partial<Banner>
        this.banners = this.banners.map((banner) =>
          banner.id === id
            ? { ...banner, ...(command.method === 'banners.show' ? { shown: true } : patch) }
            : banner
        )
        return this.banners.find((banner) => banner.id === id)
      }
      case 'banners.hide':
        this.banners = this.banners.map((banner) =>
          params.id === undefined || banner.id === params.id ? { ...banner, shown: false } : banner
        )
        return this.banners
      case 'banners.reorder':
        this.banners = (params.ids as string[]).map((id, sortOrder) => ({
          ...this.banners.find((banner) => banner.id === id)!,
          sortOrder
        }))
        return this.banners
      case 'banners.delete':
        this.banners = this.banners.filter((banner) => banner.id !== params.id)
        return this.banners
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
        if (this.confirmationRowsFromStreaming) {
          const sent = (params.streaming as StreamingSettings).targets.filter(
            (target) => target.enabled
          )
          return {
            valid: true,
            destinations: sent.map((target) => ({
              targetId: target.id,
              platform: target.platform,
              label: target.label,
              authMode: target.authMode,
              ready: true,
              title: 'Live',
              description: '',
              message: 'Ready for Go Live confirmation.',
              chatRead: 'ready',
              chatWrite: 'ready',
              chatMessage: ''
            })),
            issues: []
          }
        }
        return {
          valid: true,
          destinations: this.scheduledConfirmation
            ? [
                {
                  targetId: this.scheduledConfirmationTargetId,
                  platform: this.scheduledConfirmationTargetId,
                  scheduled: this.scheduledConfirmation
                }
              ]
            : [],
          issues: []
        }
      case 'scheduledStreams.get':
        return { id: params.eventId, revision: 1 }
      case 'scheduledStreams.prepareForGoLive':
        if (params.targetId === 'x') {
          return {
            id: params.operationId,
            eventId: params.eventId,
            action: 'prepareForGoLive',
            state: 'complete',
            stage: 'prepared',
            error: null,
            result: {
              platform: 'x',
              accountId: String(params.accountId ?? 'x-account-1'),
              accountLabel: 'X Test Account',
              sourceId: 'x-scheduled-source',
              region: 'x-scheduled-region',
              serverUrl: 'rtmps://x.example.test/live',
              streamKeySecretRef: `scheduled-event-key:${String(params.targetId)}`,
              streamKeyPresent: true,
              redactedUrl: 'rtmps://<x-ingest>/<stream-key>',
              isStreamActive: false,
              selection: 'created',
              deletedRetiredSourceIds: []
            }
          }
        }
        return {
          id: params.operationId,
          eventId: params.eventId,
          action: 'prepareForGoLive',
          state: 'complete',
          stage: 'prepared',
          error: null,
          result: {
            platform: 'youtube',
            accountId: String(params.accountId ?? 'youtube-account-1'),
            accountLabel: 'YouTube Test Channel',
            broadcastId: 'advertised-scheduled-id',
            streamId: 'scheduled-ingest-id',
            serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
            streamKeySecretRef: `scheduled-event-key:${String(params.targetId)}`,
            streamKeyPresent: true,
            redactedUrl: 'rtmp://<ingest>/<key>',
            title: 'Advertised scheduled title',
            description: 'Saved description',
            privacy: 'private',
            madeForKids: false,
            scheduledStartTime: '2035-01-01T12:00:00Z'
          }
        }
      case 'scheduledStreams.activate':
      case 'scheduledStreams.releasePreparation':
        if (
          command.method.endsWith('activate') &&
          this.sentCommands.some(
            (sent) =>
              sent.method === 'scheduledStreams.prepareForGoLive' &&
              (sent.params as { targetId?: string }).targetId === 'x' &&
              (sent.params as { eventId?: string }).eventId === params.eventId
          )
        ) {
          return {
            id: params.operationId,
            eventId: params.eventId,
            action: command.method,
            state: 'complete',
            stage: 'live',
            error: null,
            result: {
              platform: 'x',
              accountId: 'x-account-1',
              sourceId: 'x-scheduled-source',
              broadcastId: 'advertised-x-scheduled-id',
              mediaKey: 'x-scheduled-media-key',
              shareUrl: 'https://x.com/i/broadcasts/advertised-x-scheduled-id',
              state: 'RUNNING',
              message: 'Scheduled X broadcast is live.'
            }
          }
        }
        return {
          id: params.operationId,
          eventId: params.eventId,
          action: command.method,
          state: 'complete',
          stage: 'confirmed',
          error: null,
          result: {
            platform: 'youtube',
            accountId: 'youtube-account-1',
            broadcastId: 'advertised-scheduled-id',
            requestedStatus: command.method.endsWith('activate') ? 'live' : 'complete',
            lifecycleStatus: command.method.endsWith('activate') ? 'live' : 'ready',
            message: 'Scheduled lifecycle confirmed.'
          }
        }
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
        if (params.status === 'complete' && this.youtubeCompleteQuotaFailuresRemaining > 0) {
          this.youtubeCompleteQuotaFailuresRemaining -= 1
          throw Object.assign(
            new Error(
              "YouTube's daily API limit is used up. YouTube ends the broadcast on its own about a minute after you stop."
            ),
            { code: 'youtube-quota-paused' }
          )
        }
        return {
          platform: 'youtube',
          accountId: String(params.accountId ?? 'youtube-account-1'),
          broadcastId: String(params.broadcastId),
          requestedStatus: params.status,
          lifecycleStatus: params.status,
          message: `YouTube broadcast transitioned to ${String(params.status)}.`
        }
      case 'streamTargets.kick.searchCategories':
        return {
          categories: [{ id: 15, name: 'Just Chatting' }]
        }
      case 'streamTargets.kick.prepare':
        return {
          platform: 'kick',
          accountId: String(params.accountId ?? 'kick-account-1'),
          accountLabel: 'Kick Test Channel',
          serverUrl: 'rtmps://kick.example.test:443/app',
          streamKeySecretRef: 'platform:kick:kick-account-1:stream-key',
          streamKeyPresent: true,
          redactedUrl: 'rtmps://kick.example.test:443/app/<stream-key>',
          broadcasterUserId: 'kick-account-1',
          slug: 'kick-test',
          title: 'Provider test stream'
        }
      case 'streamTargets.kick.applyMetadata':
        return {
          platform: 'kick',
          accountId: String(params.accountId ?? 'kick-account-1'),
          accountLabel: 'Kick Test Channel',
          title: 'Provider test stream'
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
      case 'sessions.list': {
        if (!this.sessionListPaged) {
          return { items: this.sessionSummaries, nextCursor: this.sessionListNextCursor }
        }
        const start = params.cursor ? Number(params.cursor) : 0
        const end = start + Math.min(200, Number(params.limit ?? 50))
        return {
          items: this.sessionSummaries.slice(start, end),
          nextCursor: end < this.sessionSummaries.length ? String(end) : undefined
        }
      }
      case 'sessions.rename':
        this.sessionSummaries = this.sessionSummaries.map((session) =>
          session.id === params.sessionId ? { ...session, title: String(params.title) } : session
        )
        return null
      case 'sessions.healthEvents.list':
        if (this.sessionDetailFailuresRemaining > 0) {
          this.sessionDetailFailuresRemaining -= 1
          throw new Error('Session detail history is temporarily unavailable.')
        }
        return { events: this.sessionHealthEvents }
      case 'sessions.logs.list':
        return { entries: this.sessionLogs }
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
      case 'audio.processing.update': {
        const reasonCode =
          this.audioProcessingReasonCode === 'microphone-noise-suppression-unavailable' &&
          params.microphoneNoiseSuppression !== 'rnnoise'
            ? null
            : this.audioProcessingReasonCode
        return {
          sessionId: params.sessionId,
          applied: reasonCode === null,
          microphoneNoiseSuppression: params.microphoneNoiseSuppression ?? 'off',
          microphoneGainDb: params.microphoneGainDb,
          microphoneMuted: params.microphoneMuted,
          ...(reasonCode ? { reasonCode } : {}),
          ...(reasonCode === 'microphone-noise-suppression-unavailable'
            ? { confirmedMicrophoneNoiseSuppression: 'off' }
            : {})
        }
      }
      case 'session.start': {
        if (this.sessionStartError) {
          throw new Error(this.sessionStartError)
        }
        this.recordingState = 'recording'
        this.recordingSessionId = 'session-1'
        this.confirmedSources = { ...(params.sources as SourceSelection) }
        if (this.sessionStartCommitsScene) {
          // Like `requested_session_scene`: the request's scene, else its layout's.
          this.currentLayout = params.layout as LayoutSettings
          this.currentScene =
            (params.scene as Scene | undefined) ?? sceneForLayout(this.currentLayout)
          this.revision += 1
        }
        const output = params.output as
          | { recordEnabled?: boolean; streamEnabled?: boolean }
          | undefined
        this.recordingReplayOnly =
          params.replay != null && !output?.recordEnabled && !output?.streamEnabled
        return {
          state: 'recording',
          sessionId: 'session-1',
          startedAt: now,
          message: this.recordingReplayOnly ? 'Ready.' : 'Recording.',
          ...(this.recordingReplayOnly ? { replayOnly: true } : {})
        }
      }
      case 'cloud.status':
        if (!this.cloudStatus) {
          throw new Error('This backend has no cloud.')
        }
        return this.cloudStatus
      // Plan 184 C5b: the same start as `session.start`, bound to the live
      // cloud show; the backend reports the show fed again.
      case 'cloud.show.resume':
        if (!this.cloudStatus?.show?.resumable) {
          throw new Error('There is no Videorc Cloud show to resume.')
        }
        this.recordingState = 'recording'
        this.confirmedSources = { ...(params.sources as SourceSelection) }
        this.cloudStatus = {
          ...this.cloudStatus,
          phase: 'resuming',
          sessionId: 'cloud-resume-session',
          show: { ...this.cloudStatus.show, resumable: false }
        }
        return {
          state: 'recording',
          sessionId: 'cloud-resume-session',
          startedAt: now,
          streamUrl: 'rtmps://localhost:1936/live/***',
          message: 'Running both session.'
        }
      case 'session.stop':
        this.recordingState = 'idle'
        this.recordingReplayOnly = false
        return {
          state: 'idle',
          sessionId: 'session-1',
          outputPath: 'C:\\recordings\\session-1.mkv',
          durationMs: 1_000,
          message: 'Saved.'
        }
      case 'performance.check.get':
        // Measured and current: the provider must not start a check on mount.
        return this.performanceCheck
      case 'diagnostics.supportBundle.export':
        return {
          path: 'C:\\Videorc\\support-bundles\\videorc-support-bundle-20261011-093000Z.json',
          includedSections: [],
          redactionSummary: {
            secretValues: 0,
            databasePaths: 0,
            mediaPaths: 0,
            homePaths: 0,
            urlCredentials: 0,
            aiArtifactBodies: 0
          }
        }
      case 'encoder.preference.get':
        return { preference: 'auto', quickSyncAvailable: false, envOverride: false }
      case 'encoder.preference.set':
        return { preference: params.preference, quickSyncAvailable: true, envOverride: false }
      // Plan 224 D17: End livestream in a talk show ends the legs; the room
      // and the cloud recording stay.
      case 'cloud.show.legs.end':
        if (!this.cloudStatus?.room) throw new Error('The room is closed.')
        this.cloudStatus = {
          ...this.cloudStatus,
          room: { ...this.cloudStatus.room, live: false }
        }
        return this.cloudStatus
      // Plan 243 C2: the hand-off stop. The status that says so goes out
      // before the session stops (D7); a refusal stops nothing.
      case 'cloud.show.handOff': {
        if (this.handOffRefusal) {
          throw Object.assign(new Error('Not on air from this device.'), {
            code: this.handOffRefusal
          })
        }
        const show = this.cloudStatus ?? managedOnAirCloudStatus()
        this.cloudStatus = {
          ...show,
          phase: 'hold',
          stoppedBy: 'hand-off',
          ...(show.onAir ? { onAir: { ...show.onAir, waiting: true } } : {})
        }
        this.pushEvent('cloud.state', this.cloudStatus)
        if (this.recordingState !== 'idle') {
          this.recordingState = 'idle'
          this.pushEvent('recording.status', {
            state: 'idle',
            sessionId: 'session-1',
            message: 'Saved.'
          })
        }
        return { ok: true, confirmed: this.handOffConfirmed }
      }
      case 'cloud.show.check':
        return { ok: true }
      case 'cloud.recording.stop':
        if (!this.cloudStatus?.room) throw new Error('The room is closed.')
        this.cloudStatus = {
          ...this.cloudStatus,
          recording: { active: false, seconds: 0, bytes: 0 }
        }
        return this.cloudStatus
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
        const payload =
          deferredResponse && payloadOverride !== BACKEND_RESPONSE
            ? payloadOverride
            : this.backend.response(command)
        if (command.method === 'screens.importImage' && !deferredResponse) {
          // Like the real backend, the new list goes out before the import reply.
          this.onmessage?.({
            data: JSON.stringify({ event: 'screens.changed', payload: this.backend.screens })
          })
        }
        this.onmessage?.({ data: JSON.stringify({ id: command.id, ok: true, payload }) })
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
  banners: ReturnType<typeof useStudioBanners>
  captions: ReturnType<typeof useStudioCaptions>
  chat: ReturnType<typeof useStudioChat>
  cloud: StudioCloudContextValue
  core: StudioCoreContextValue
  diagnostics: ReturnType<typeof useStudioDiagnostics>
  recording: StudioRecordingContextValue
  replay: ReturnType<typeof useStudioReplay>
}

/** A mixer-like consumer: reads frames (which retains analyser demand) and reports lifecycle. */
function MicVisualProbe({ observe }: { observe: (active: boolean) => void }): null {
  useFrameSource(useStudioMicVisualSource(), () => undefined)
  const lifecycle = useStudioMicVisualLifecycle()
  useEffect(() => observe(lifecycle.active), [lifecycle.active, observe])
  return null
}

function Probe({ observe }: { observe: (value: StudioObservation) => void }): null {
  const audio = useStudioAudio()
  const banners = useStudioBanners()
  const captions = useStudioCaptions()
  const chat = useStudioChat()
  const cloud = useStudioCloud()
  const core = useStudioCore()
  const diagnostics = useStudioDiagnostics()
  const recording = useStudioRecording()
  const replay = useStudioReplay()
  useEffect(
    () => observe({ audio, banners, captions, chat, cloud, core, diagnostics, recording, replay }),
    [audio, banners, captions, chat, cloud, core, diagnostics, observe, recording, replay]
  )
  return null
}

// A test that times out keeps running after Vitest moves on. If its polling
// act() overlaps the next test's act(), the scopes close out of order, React's
// act depth never returns to zero, and no later act() flushes React work: every
// test after it in the file times out too (0.36.1's Linux candidate failed 146;
// Windows shards ran into the job limit). So each polling helper belongs to one
// test, and afterEach waits out its act() in flight before the next one starts.
let testEpoch = 0
let helperActInFlight: Promise<void> = Promise.resolve()

/** One polling turn for the test that started at `epoch`; refuses once it ended. */
async function pollAct(epoch: number, turn: () => Promise<void>): Promise<void> {
  if (epoch !== testEpoch) {
    throw new Error('The test ended (it timed out) before this wait finished.')
  }
  // act()'s thenable closes its scope on every then(): adopt it exactly once.
  const pending = Promise.resolve(act(turn))
  helperActInFlight = pending.catch(() => undefined)
  await pending
}

async function endTestHelpers(): Promise<void> {
  testEpoch += 1
  await helperActInFlight
}

/** Runs only 0 ms timers (setTimeout is faked) while real time passes for
 * module loads and socket replies, until `done` or `withinMs` runs out. */
async function turnZeroTimersUntil(done: () => boolean, withinMs = 3_000): Promise<void> {
  const epoch = testEpoch
  const deadline = performance.now() + withinMs
  while (!done() && performance.now() < deadline) {
    await pollAct(epoch, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

async function mountStudioProvider(
  container: Element,
  observe: (value: StudioObservation) => void,
  children?: ReactNode
): Promise<Root> {
  let mountedRoot!: Root
  await act(async () => {
    mountedRoot = createRoot(container)
    mountedRoot.render(
      createElement(
        BackgroundAssetsProvider,
        null,
        createElement(StudioProvider, null, createElement(Probe, { observe }), children)
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

/** Plan 243: a managed solo show this computer is on air for. */
function managedOnAirCloudStatus(overrides: Partial<CloudStatus> = {}): CloudStatus {
  return {
    phase: 'live',
    entitled: true,
    plan: 'max',
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300, 900, 1800, 3600] },
    show: { id: 'sh_managed', nodeId: 'livekit', resumable: false, kind: 'solo' },
    sessionId: 'session-1',
    connected: true,
    directFallbackAvailable: false,
    onAir: {
      name: 'Studio Mac',
      kind: 'computer',
      source: 'feed',
      waiting: false,
      thisDevice: true,
      since: now
    },
    ...overrides
  }
}

/** Plan 184 C5: a show live on the runner with no local feed, as `cloud.status` answers. */
function resumableCloudStatus(): CloudStatus {
  return {
    phase: 'hold',
    entitled: true,
    plan: 'max',
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300, 900, 1800, 3600] },
    show: { id: 'sh_test', nodeId: 'local-1', resumable: true },
    connected: true,
    hold: { active: true, reason: 'feed-lost', remainingSeconds: 1500 },
    directFallbackAvailable: false
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

// Two destinations on the default (Basic) snapshot: multistreaming is free
// for every plan, so this helper no longer needs a Premium switch.
function enableYouTubeAndXOauthForTest(backend: StudioBackend): void {
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

// Plan 231: the Studio always holds scenes (a new profile starts with the four
// default ones), and a scene saved from the current look goes at the end, so
// the tests find their scenes by name.
function sceneNamed(core: Pick<StudioCoreContextValue, 'savedScenes'>, name: string) {
  return core.savedScenes.find((scene) => scene.name === name)!
}
/** The scene as the library stores it (`videorc.scenes.v2`). */
function storedSceneNamed(name: string): StoredScene {
  return (JSON.parse(localStorage.getItem(SCENES_KEY)!) as SceneLibrary).scenes.find(
    (scene) => scene.name === name
  )!
}
function storedLibrary(): SceneLibrary {
  return JSON.parse(localStorage.getItem(SCENES_KEY)!) as SceneLibrary
}

// Plan 231 review: two displays and a library seeded before the Studio mounts.
const FIRST_DISPLAY_ID = 'screen:dxgi:0000000000000001:1'
const SECOND_DISPLAY = {
  id: 'screen:dxgi:second',
  name: 'Display 2',
  kind: 'screen' as const,
  status: 'available' as const
}
function displayShows(screenId: string, screenName: string): StoredScene['shows'] {
  return { kind: 'display', screenId, screenName }
}
function libraryScene(
  id: string,
  name: string,
  shows: StoredScene['shows'],
  [horizontal, vertical]: [LayoutPreset, LayoutPreset]
): StoredScene {
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    shows,
    layouts: {
      horizontal: { ...defaultCaptureConfig.layout, layoutPreset: horizontal },
      vertical: { ...defaultCaptureConfig.layout, layoutPreset: vertical }
    },
    background: null
  }
}
function seedSceneLibrary(
  scenes: StoredScene[],
  onStreamId: string,
  extra: Partial<SceneLibrary> = {}
): void {
  localStorage.setItem(SCENES_KEY, JSON.stringify({ version: 2, scenes, onStreamId, ...extra }))
}
/** The program's layout requests since `from`, or the vertical leg's (`leg`). */
function layoutApplies(backend: StudioBackend, from: number, leg: boolean) {
  return backend.sentCommands
    .slice(from)
    .filter(
      (command) =>
        command.method.startsWith('scene.layout.apply') &&
        ((command.params as { simulcastLeg?: boolean }).simulcastLeg === true) === leg
    ) as {
    method: string
    params: {
      layout: LayoutSettings
      sources: SourceSelection
      retainScreen?: true
      verticalLegScreen?: true
    }
  }[]
}
/** The screen capture runs (D18's existing owner). */
async function emitScreenStatus(backend: StudioBackend, sourceId: string): Promise<void> {
  await act(async () =>
    [...backend.sockets].forEach((socket) =>
      socket.onmessage?.({
        data: JSON.stringify({
          event: 'preview.screen.status',
          payload: {
            state: 'live',
            sourceId,
            sourceKind: 'screen',
            targetFps: 30,
            framesCaptured: 10,
            droppedFrames: 0,
            includeCursor: true,
            excludeCurrentProcessWindows: true,
            updatedAt: new Date().toISOString()
          }
        })
      })
    )
  )
}
/** A YouTube Vertical destination beside the 16:9 program (plan 231 D4). */
async function armVerticalStream(latest: () => StudioCoreContextValue): Promise<void> {
  const config = latest().captureConfig
  await act(async () => {
    latest().setCaptureConfig({
      ...config,
      streamEnabled: true,
      streaming: {
        ...config.streaming,
        enabled: true,
        enabledTargetIds: ['youtube', 'youtube-vertical'],
        targets: config.streaming.targets.map((target) =>
          target.id === 'youtube' || target.id === 'youtube-vertical'
            ? { ...target, enabled: true, streamKey: `key-${target.id}`, streamKeyPresent: true }
            : target
        )
      }
    })
  })
  await waitForObservation(() => latest().captureConfig.streaming.enabled === true)
}

/**
 * Plan 231 S7: saving the look on stream as a new scene left the app. The
 * dev smoke harness keeps that save and its "the look on stream is settled"
 * check for the smokes, and these tests build their scenes with it too.
 */
type SmokeScenePresets = {
  state: () => { canSave: boolean } & Record<string, unknown>
  save: (name: string, updateId?: string) => boolean
  apply: StudioCoreContextValue['applySavedScene']
  retrySourceStatus: StudioCoreContextValue['retrySourceStatus']
}
function smokeScenePresets(): SmokeScenePresets | undefined {
  return (window as Window & { __videorcSmokeScenePresets?: SmokeScenePresets })
    .__videorcSmokeScenePresets
}
/** The look on stream is settled: nothing is changing it. */
function canSaveScene(): boolean {
  return smokeScenePresets()?.state().canSave === true
}
/** The look on stream as a new scene at the end (or into `updateId`), put on stream. */
function saveScene(name: string, updateId?: string): boolean {
  return smokeScenePresets()!.save(name, updateId)
}

describe('real StudioProvider lifecycle', () => {
  let restoreEnvironment: (() => void) | undefined
  let root: Root | null = null

  afterEach(async () => {
    await endTestHelpers()
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    restoreEnvironment?.()
    restoreEnvironment = undefined
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.useRealTimers()
    // Plan 250: the notification store is one per window, so one per file.
    notifications.reset()
  })

  /** The entry behind the bell for a subject (plan 250). */
  const notification = (key: string) => notifications.snapshot().find((entry) => entry.key === key)

  async function mountFreeformTransformProvider(connected = true): Promise<{
    backend: StudioBackend
    latest: () => StudioObservation
  }> {
    const backend = new StudioBackend()
    backend.currentLayout = { ...defaultCaptureConfig.layout, arrangementMode: 'freeform' }
    backend.currentScene = sceneForLayout(backend.currentLayout)
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    if (!connected) api.getBackendConnection = async () => null
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({ ...defaultCaptureConfig, layout: backend.currentLayout })
    )
    let observation: StudioObservation | undefined
    root = await mountStudioProvider(testDom.container, (value) => {
      observation = value
    })
    if (connected) await waitForObservation(() => observation?.core.scene != null)
    return { backend, latest: () => observation! }
  }

  async function mountTakeoverImportProvider(
    imports: Pick<VideorcApi, 'pickScreenImages' | 'authorizeDroppedScreenImages'> &
      Partial<Pick<VideorcApi, 'releaseScreenImages'>>
  ): Promise<{ backend: StudioBackend; latest: () => StudioObservation }> {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = Object.assign(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      }),
      imports
    )
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    let observation: StudioObservation | undefined
    root = await mountStudioProvider(testDom.container, (value) => {
      observation = value
    })
    await waitForObservation(() => observation?.core.screensLoaded === true)
    return { backend, latest: () => observation! }
  }

  const pickedImage = (capabilityId: string): ResourceSelection => ({
    capabilityId,
    kind: 'input-file',
    displayName: `${capabilityId}.png`
  })

  it('imports every picked takeover image, past a failed one', async () => {
    const { backend, latest } = await mountTakeoverImportProvider({
      pickScreenImages: async () => [pickedImage('a'), pickedImage('b'), pickedImage('c')],
      authorizeDroppedScreenImages: vi.fn()
    })
    backend.screenImportFailures.add('b')

    await act(async () => latest().core.importScreenImages())

    expect(
      backend.sentCommands
        .filter((command) => command.method === 'screens.importImage')
        .map((command) => command.params)
    ).toEqual([{ sourceCapability: 'a' }, { sourceCapability: 'b' }, { sourceCapability: 'c' }])
    expect(latest().core.screens.map((screen) => screen.name)).toEqual(['a', 'c'])
    expect(latest().core.lastError).toBe('The test backend could not read this image.')
    expect(latest().core.pendingScreenImports).toEqual([])
  })

  it('keeps a later image whose reply comes without a list event, after an earlier one had one', async () => {
    const { backend, latest } = await mountTakeoverImportProvider({
      pickScreenImages: async () => [pickedImage('a'), pickedImage('b')],
      authorizeDroppedScreenImages: vi.fn()
    })
    const releaseB = backend.deferResponse(
      'screens.importImage',
      { ...takeoverScreen, id: 'screen-b', name: 'b' },
      (command) => (command.params as Record<string, unknown> | undefined)?.sourceCapability === 'b'
    )

    let importing!: Promise<void>
    act(() => {
      importing = latest().core.importScreenImages()
    })
    await waitForObservation(() => latest().core.screens.some((screen) => screen.name === 'a'))
    await act(async () => {
      releaseB()
      await importing
    })
    expect(latest().core.screens.map((screen) => screen.name)).toEqual(['a', 'b'])
  })

  it('holds each picked image as pending until its own import settles', async () => {
    const { backend, latest } = await mountTakeoverImportProvider({
      pickScreenImages: async () => [pickedImage('a'), pickedImage('b'), pickedImage('c')],
      authorizeDroppedScreenImages: vi.fn()
    })
    const importOf = (capabilityId: string) => (command: BackendCommand) =>
      (command.params as Record<string, unknown> | undefined)?.sourceCapability === capabilityId
    const releaseA = backend.deferResponse(
      'screens.importImage',
      { ...takeoverScreen, id: 'screen-a', name: 'a' },
      importOf('a')
    )
    const releaseB = backend.deferFailure(
      'screens.importImage',
      new Error('The test backend could not read this image.'),
      importOf('b')
    )
    const releaseC = backend.deferResponse(
      'screens.importImage',
      { ...takeoverScreen, id: 'screen-c', name: 'c' },
      importOf('c')
    )
    const pendingNames = (): string[] =>
      latest().core.pendingScreenImports.map((selection) => selection.displayName)

    let importing!: Promise<void>
    act(() => {
      importing = latest().core.importScreenImages()
    })
    await waitForObservation(() => pendingNames().length === 3)
    expect(pendingNames()).toEqual(['a.png', 'b.png', 'c.png'])

    act(() => releaseA())
    await waitForObservation(() => pendingNames().length === 2)
    expect(pendingNames()).toEqual(['b.png', 'c.png'])
    expect(latest().core.screens.map((screen) => screen.name)).toContain('a')

    act(() => releaseB())
    await waitForObservation(() => pendingNames().length === 1)
    expect(pendingNames()).toEqual(['c.png'])

    await act(async () => {
      releaseC()
      await importing
    })
    expect(pendingNames()).toEqual([])
  })

  it('clears the pending images and says so when the connection drops mid-batch', async () => {
    const releaseScreenImages = vi.fn<VideorcApi['releaseScreenImages']>(async () => undefined)
    const { backend, latest } = await mountTakeoverImportProvider({
      pickScreenImages: async () => [pickedImage('a'), pickedImage('b')],
      authorizeDroppedScreenImages: vi.fn(),
      releaseScreenImages
    })
    backend.deferResponse('screens.importImage', takeoverScreen)
    act(() => {
      void latest().core.importScreenImages()
    })
    await waitForObservation(() => latest().core.pendingScreenImports.length === 2)

    act(() => backend.sockets[0]?.close())

    await waitForObservation(() => latest().core.pendingScreenImports.length === 0)
    expect(latest().core.screenImportPhase).toBe('idle')
    // The toast's words come from the lazy takeover-import module.
    await waitForObservation(() =>
      Boolean(latest().core.lastError?.includes('before the last 2 images were imported'))
    )
    // 'a' was in flight when the connection dropped (the close rejects it);
    // only 'b' was never used, so only its capability is handed back.
    await waitForObservation(() => releaseScreenImages.mock.calls.length > 0)
    expect(releaseScreenImages).toHaveBeenCalledExactlyOnceWith(['b'])
  })

  it('shows a refused drop as written, whether the refusal throws or rejects', async () => {
    const refuse = vi
      .fn<VideorcApi['authorizeDroppedScreenImages']>()
      .mockImplementationOnce(() => {
        throw new Error(SCREEN_IMAGE_REFUSALS.tooMany)
      })
      .mockRejectedValueOnce(
        new Error(
          `Error invoking remote method 'screens:authorize-dropped-images': Error: ${SCREEN_IMAGE_REFUSALS.notImages}`
        )
      )
    const { latest } = await mountTakeoverImportProvider({
      pickScreenImages: vi.fn(),
      authorizeDroppedScreenImages: refuse
    })

    const lastToastDescription = (): unknown =>
      (toastSpies.error.mock.lastCall?.[1] as { description?: unknown } | undefined)?.description

    await act(async () => latest().core.importDroppedScreenImages([]))
    await waitForObservation(() => lastToastDescription() === SCREEN_IMAGE_REFUSALS.tooMany)
    await act(async () => latest().core.importDroppedScreenImages([]))
    await waitForObservation(() => lastToastDescription() === SCREEN_IMAGE_REFUSALS.notImages)
    expect(latest().core.pendingScreenImports).toEqual([])
  })

  it('refuses a second takeover import while the first is still choosing or importing', async () => {
    let choose!: (selections: ResourceSelection[]) => void
    const authorizeDroppedScreenImages = vi.fn(async () => [pickedImage('dropped')])
    const { backend, latest } = await mountTakeoverImportProvider({
      pickScreenImages: () =>
        new Promise((resolve) => {
          choose = resolve
        }),
      authorizeDroppedScreenImages
    })
    const releaseImport = backend.deferResponse('screens.importImage', {
      ...takeoverScreen,
      id: 'screen-picked'
    })

    let picking!: Promise<void>
    act(() => {
      picking = latest().core.importScreenImages()
    })
    await act(async () => latest().core.importDroppedScreenImages([new File([''], 'x.png')]))
    expect(authorizeDroppedScreenImages).not.toHaveBeenCalled()

    act(() => choose([pickedImage('picked')]))
    await waitForObservation(() => latest().core.pendingScreenImports.length > 0)
    await act(async () => latest().core.importDroppedScreenImages([new File([''], 'x.png')]))
    expect(authorizeDroppedScreenImages).not.toHaveBeenCalled()

    await act(async () => {
      releaseImport()
      await picking
    })
    expect(latest().core.pendingScreenImports).toEqual([])
    await act(async () => latest().core.importDroppedScreenImages([new File([''], 'x.png')]))
    expect(authorizeDroppedScreenImages).toHaveBeenCalledOnce()
  })

  it.each(['recording', 'streaming'] as const)(
    'imports a takeover while %s without applying it or refreshing active state',
    async (state) => {
      const { backend, latest } = await mountFreeformTransformProvider()
      const screen: StreamScreen = {
        id: 'live-import',
        name: 'Live import',
        imagePath: '/screens/live.png',
        sortOrder: 0,
        status: 'ready',
        createdAt: now,
        updatedAt: now
      }
      window.videorc.pickScreenImages = vi.fn(async () => [
        {
          capabilityId: 'chosen-image',
          kind: 'input-file' as const,
          displayName: 'live.png'
        }
      ])
      await act(async () => {
        for (const socket of backend.sockets)
          socket.onmessage?.({
            data: JSON.stringify({
              event: 'recording.status',
              payload: { state, sessionId: 'live-import-session', startedAt: now }
            })
          })
      })
      const release = backend.deferResponse('screens.importImage', screen)
      backend.commands.length = 0
      let pending!: Promise<void>
      act(() => {
        pending = latest().core.importScreenImages()
      })
      await waitForObservation(() => latest().core.screenImportPhase === 'importing')
      await act(async () => latest().core.importScreenImages())
      expect(window.videorc.pickScreenImages).toHaveBeenCalledTimes(1)
      await act(async () => {
        release()
        await pending
      })
      expect(latest().core.screens).toContainEqual(screen)
      expect(latest().core.activeScreen).toBeNull()
      expect(latest().core.screenImportPending).toBe(false)
      const methods = backend.commands.map((command) => command.method)
      expect(methods.filter((method) => method === 'screens.importImage')).toHaveLength(1)
      expect(methods).not.toContain('screens.active')
      expect(methods).not.toContain('screens.activate')
      expect(methods).not.toContain('screens.clear')
      expect(methods).not.toContain('session.stop')
      expect(methods).not.toContain('audio.processing.update')
    }
  )

  it('moves the Library total when a loaded recording finishes its MP4', async () => {
    // Release test 146, plan 0007: the row got its size from the finalization
    // event, but "N recordings · X MB" kept the old total until a page change.
    class TotalsBackend extends StudioBackend {
      storage = { count: 1, totalBytes: 10_000_000 }
      override response(command: BackendCommand): unknown {
        if (command.method === 'sessions.storage') return { ...this.storage }
        return super.response(command)
      }
    }
    const backend = new TotalsBackend()
    backend.sessionSummaries = [
      sessionSummary({ id: 'older', fileSizeBytes: 10_000_000 }),
      sessionSummary({ id: 'take-2', status: 'completed', finalizationState: 'finalizing' })
    ]
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
    let observation: StudioObservation | undefined
    root = await mountStudioProvider(testDom.container, (value) => {
      observation = value
    })
    await waitForObservation(
      () => observation?.core.sessionStorageTotals?.totalBytes === 10_000_000
    )
    await waitForObservation(
      () => observation?.core.sessions.some((row) => row.id === 'take-2') === true
    )

    backend.storage = { count: 2, totalBytes: 58_000_000 }
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'recording.finalization',
            payload: {
              sessionId: 'take-2',
              state: 'finalized',
              mp4Path: '/recordings/take-2.mp4',
              fileSizeBytes: 48_000_000,
              updatedAt: now
            }
          })
        })
      }
      await Promise.resolve()
    })
    await waitForObservation(
      () => observation?.core.sessionStorageTotals?.totalBytes === 58_000_000
    )
    expect(observation?.core.sessionStorageTotals?.count).toBe(2)
  }, 15_000)

  it("never saves the shipped overlay defaults over the backend's layout at launch", async () => {
    // ogre 2026-10-13: with captions burned on the stream (the default), every
    // launch seeded the caption switches into the DEFAULT layout before
    // `overlays.layout.get` answered and saved it: Buddy left the stream and
    // the recording, and every overlay placement reset.
    const backend = new StudioBackend()
    const stored: OverlayLayout = {
      ...DEFAULT_OVERLAY_LAYOUT,
      buddy: { ...DEFAULT_OVERLAY_LAYOUT.buddy, showOnStream: true, showInRecording: true },
      captions: { ...DEFAULT_OVERLAY_LAYOUT.captions, showOnStream: true }
    }
    backend.overlayLayout = stored
    const release = backend.deferResponse('overlays.layout.get', stored)
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
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        captions: { ...defaultCaptureConfig.captions, burnTarget: 'stream' }
      })
    )
    let observation: StudioObservation | undefined
    root = await mountStudioProvider(testDom.container, (value) => {
      observation = value
    })
    // Connected and bootstrapped while the layout is still on its way.
    await waitForObservation(() => observation?.core.scene != null)
    expect(backend.commands.map((command) => command.method)).not.toContain('overlays.layout.set')
    await act(async () => release())
    await waitForObservation(() => observation?.core.overlayLayout.buddy.showOnStream === true)
    expect(backend.overlayLayout).toEqual(stored)
    expect(backend.commands.map((command) => command.method)).not.toContain('overlays.layout.set')
  })

  it('keeps the picker and import alive across session start and stop', async () => {
    const { backend, latest } = await mountFreeformTransformProvider()
    const screen: StreamScreen = {
      id: 'session-boundary-import',
      name: 'Session boundary',
      imagePath: '/screens/boundary.png',
      sortOrder: 0,
      status: 'ready',
      createdAt: now,
      updatedAt: now
    }
    let choose!: (selections: ResourceSelection[]) => void
    window.videorc.pickScreenImages = vi.fn(
      () =>
        new Promise<ResourceSelection[]>((resolve) => {
          choose = resolve
        })
    )
    const release = backend.deferResponse('screens.importImage', screen)
    let pending!: Promise<void>
    act(() => {
      pending = latest().core.importScreenImages()
    })
    await waitForObservation(() => latest().core.screenImportPhase === 'choosing')
    await act(async () => {
      for (const socket of backend.sockets)
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'recording.status',
            payload: {
              state: 'recording',
              sessionId: 'picker-session',
              startedAt: now
            }
          })
        })
    })
    expect(latest().core.screenImportPhase).toBe('choosing')
    await act(async () =>
      choose([
        {
          capabilityId: 'boundary-image',
          kind: 'input-file',
          displayName: 'boundary.png'
        }
      ])
    )
    await waitForObservation(() => latest().core.screenImportPhase === 'importing')
    await act(async () => {
      for (const socket of backend.sockets)
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'recording.status',
            payload: {
              state: 'idle'
            }
          })
        })
    })
    expect(latest().core.screenImportPhase).toBe('importing')
    await act(async () => {
      release()
      await pending
    })
    expect(latest().core.screens).toContainEqual(screen)
    expect(latest().core.activeScreen).toBeNull()
    expect(latest().core.screenImportPhase).toBe('idle')
  })

  it('a newer authoritative takeover list wins over the import reply', async () => {
    const { backend, latest } = await mountFreeformTransformProvider()
    const screen: StreamScreen = {
      id: 'retired-import',
      name: 'Removed elsewhere',
      imagePath: '/screens/removed.png',
      sortOrder: 0,
      status: 'ready',
      createdAt: now,
      updatedAt: now
    }
    window.videorc.pickScreenImages = vi.fn(async () => [
      {
        capabilityId: 'chosen-image',
        kind: 'input-file' as const,
        displayName: 'image.png'
      }
    ])
    const release = backend.deferResponse('screens.importImage', screen)
    let pending!: Promise<void>
    act(() => {
      pending = latest().core.importScreenImages()
    })
    await waitForObservation(() => latest().core.screenImportPhase === 'importing')
    await act(async () => {
      for (const socket of backend.sockets)
        socket.onmessage?.({ data: JSON.stringify({ event: 'screens.changed', payload: [] }) })
      release()
      await pending
    })
    expect(latest().core.screens).toEqual([])
    expect(latest().core.screenImportPending).toBe(false)
  })

  // Plan 186 S5: the banner list, its actions and its refusals.
  const testBanner = (id: string, sortOrder: number, extra: Partial<Banner> = {}): Banner => ({
    id,
    name: id,
    imageFile: `${id}.png`,
    thumbnailFile: `${id}.thumb.png`,
    width: 2400,
    height: 400,
    hasAlpha: true,
    sortOrder,
    shown: false,
    horizontal: { x: 0.2, y: 0.8, w: 0.6, h: 0.1 },
    vertical: { x: 0.05, y: 0.8, w: 0.9, h: 0.06 },
    showOnStream: true,
    showInRecording: true,
    opacity: 1,
    createdAt: now,
    updatedAt: now,
    ...extra
  })

  async function mountBannerProvider(banners: Banner[]): Promise<{
    backend: StudioBackend
    latest: () => StudioObservation
  }> {
    const backend = new StudioBackend()
    backend.banners = banners
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
    let observation: StudioObservation | undefined
    root = await mountStudioProvider(testDom.container, (value) => {
      observation = value
    })
    await waitForObservation(() => observation?.banners.bannersLoaded === true)
    return { backend, latest: () => observation! }
  }

  function emitBanners(backend: StudioBackend, banners: Banner[]): void {
    for (const socket of backend.sockets)
      socket.onmessage?.({ data: JSON.stringify({ event: 'banners.changed', payload: banners }) })
  }

  it('loads banners at connect, follows banners.changed and forgets a deleted selection', async () => {
    const sponsor = testBanner('sponsor', 0)
    const logo = testBanner('logo', 1)
    const { backend, latest } = await mountBannerProvider([sponsor])
    expect(latest().banners.banners).toEqual([sponsor])
    expect(latest().banners.bannersOffline).toBe(false)
    expect(latest().banners.bannerImportPhase).toBe('idle')

    await act(async () => emitBanners(backend, [sponsor, logo]))
    expect(latest().banners.banners).toEqual([sponsor, logo])

    // Assets → Place on Scene: the Scene page reads this selection.
    await act(async () => latest().banners.selectBanner('logo'))
    expect(latest().banners.selectedBannerId).toBe('logo')
    await act(async () => emitBanners(backend, [sponsor]))
    expect(latest().banners.selectedBannerId).toBeNull()
  })

  // Plan 209 S11b (D22): an agent arranges the picture through the Studio's
  // own saves, landing where the Scene inspector's snaps would.
  it('moves Sidekick and a banner from an agent with the editor snaps, and reads them back', async () => {
    const { backend, latest } = await mountBannerProvider([testBanner('sponsor', 0)])
    await waitForObservation(() => latest().core.wsStatus === 'connected')
    // The agents' link listens only once its module has loaded; an intent
    // before that is lost.
    await act(async () => {
      await import('@/lib/agent-studio-link')
    })
    const pushIntent = async (intentId: string, tool: string, args: Record<string, unknown>) => {
      await act(async () => {
        backend.sockets[0]?.onmessage?.({
          data: JSON.stringify({
            event: 'agent.intent',
            payload: { intentId, agentId: 'agent-1', agentName: 'Claude', tool, args }
          })
        })
        await Promise.resolve()
      })
    }
    const ack = (intentId: string) =>
      backend.sentCommands
        .filter((command) => command.method === 'agent.intent.ack')
        .map((command) => command.params as { intentId: string; ok: boolean; result?: unknown })
        .find((params) => params.intentId === intentId)

    await pushIntent('move-1', 'move_on_scene', { item: 'buddy', place: 'top-left' })
    await waitForObservation(() => ack('move-1') !== undefined)
    expect(ack('move-1')).toMatchObject({ ok: true })
    expect(backend.overlayLayout.buddy.horizontal).toEqual(
      overlaySnapRect('buddy', 'horizontal', 'top-left')
    )
    expect(backend.overlayLayout.buddy.vertical).toEqual(
      overlaySnapRect('buddy', 'vertical', 'top-left')
    )

    const sponsor = testBanner('sponsor', 0)
    const video = latest().core.captureConfig.video
    await pushIntent('move-2', 'move_on_scene', { item: 'banner:sponsor', place: 'bottom-left' })
    await waitForObservation(() => ack('move-2') !== undefined)
    expect(ack('move-2')).toMatchObject({ ok: true })
    const update = backend.commands.filter((command) => command.method === 'banners.update').at(-1)
    expect(update?.params).toEqual({
      id: 'sponsor',
      horizontal: bannerSnapRect(
        sponsor,
        sponsor.horizontal,
        'horizontal',
        video.width / video.height,
        'bottom-left'
      ),
      vertical: bannerSnapRect(sponsor, sponsor.vertical, 'vertical', 9 / 16, 'bottom-left')
    })

    await pushIntent('set-1', 'set_scene_item', { item: 'buddy', showOnStream: true })
    await waitForObservation(() => ack('set-1') !== undefined)
    expect(backend.overlayLayout.buddy.showOnStream).toBe(true)

    await pushIntent('read-1', 'get_scene_layout', {})
    await waitForObservation(() => ack('read-1') !== undefined)
    const items = (ack('read-1')!.result as { items: { item: string; rects: unknown }[] }).items
    expect(items.find((item) => item.item === 'buddy')?.rects).toEqual({
      horizontal: {
        x: overlaySnapRect('buddy', 'horizontal', 'top-left').x,
        y: overlaySnapRect('buddy', 'horizontal', 'top-left').y,
        width: overlaySnapRect('buddy', 'horizontal', 'top-left').w,
        height: overlaySnapRect('buddy', 'horizontal', 'top-left').h
      },
      vertical: expect.any(Object)
    })
    expect(items.map((item) => item.item)).toContain('banner:sponsor')
  })

  it('shows, hides, renames and reorders through the backend without a success toast', async () => {
    const { backend, latest } = await mountBannerProvider([
      testBanner('sponsor', 0),
      testBanner('logo', 1)
    ])
    backend.commands.length = 0
    await act(async () => {
      expect(await latest().banners.toggleBanner('sponsor')).toBe(true)
    })
    expect(latest().banners.banners.find((banner) => banner.id === 'sponsor')?.shown).toBe(true)
    await act(async () => {
      expect(await latest().banners.toggleBanner('sponsor')).toBe(true)
    })
    expect(latest().banners.banners.find((banner) => banner.id === 'sponsor')?.shown).toBe(false)
    await act(async () => {
      await latest().banners.hideBanner()
      await latest().banners.updateBanner('sponsor', { name: 'ACME' })
      await latest().banners.reorderBanners(['logo', 'sponsor'])
    })
    expect(latest().banners.banners.map((banner) => [banner.id, banner.name])).toEqual([
      ['logo', 'logo'],
      ['sponsor', 'ACME']
    ])
    expect(
      backend.commands
        .filter((command) => command.method.startsWith('banners.'))
        .map((command) => [command.method, command.params])
    ).toEqual([
      ['banners.show', { id: 'sponsor' }],
      ['banners.hide', { id: 'sponsor' }],
      ['banners.hide', {}],
      ['banners.update', { name: 'ACME', id: 'sponsor' }],
      ['banners.reorder', { ids: ['logo', 'sponsor'] }]
    ])
    expect(toastSpies.success).not.toHaveBeenCalled()
    expect(toastSpies.error).not.toHaveBeenCalled()
  })

  it.each([
    ['delete', 'Hide this banner before you delete it.', "Couldn't delete the banner"],
    ['show', 'Four banners are showing. Hide one first.', "Couldn't show the banner"]
  ] as const)(
    'a %s refusal is a warning with the backend sentence, and changes nothing',
    async (action, sentence, title) => {
      const shown = testBanner('sponsor', 0, { shown: action === 'delete' })
      const { backend, latest } = await mountBannerProvider([shown])
      backend.deferFailure(
        `banners.${action}`,
        Object.assign(new Error(sentence), { code: `banner-${action}-failed` })
      )()
      let result: boolean | undefined
      await act(async () => {
        result =
          action === 'delete'
            ? await latest().banners.deleteBanner('sponsor')
            : await latest().banners.showBanner('sponsor')
      })
      expect(result).toBe(false)
      // The refusal copy loads on demand, so its toast lands a moment later.
      await waitForObservation(() => toastSpies.warning.mock.calls.length > 0)
      expect(toastSpies.warning).toHaveBeenCalledWith(
        title,
        expect.objectContaining({ description: sentence })
      )
      expect(toastSpies.error).not.toHaveBeenCalled()
      expect(toastSpies.success).not.toHaveBeenCalled()
      expect(latest().banners.banners).toEqual([shown])
    }
  )

  it('deletes a banner and names it, the one success a banner action says', async () => {
    const { latest } = await mountBannerProvider([testBanner('sponsor', 0)])
    await act(async () => {
      expect(await latest().banners.deleteBanner('sponsor')).toBe(true)
    })
    expect(latest().banners.banners).toEqual([])
    expect(toastSpies.success).toHaveBeenCalledWith('Deleted “sponsor”')
  })

  it('imports one banner at a time and never shows it; a refused import says why', async () => {
    const logo = testBanner('logo', 0)
    const { backend, latest } = await mountBannerProvider([])
    window.videorc.pickBannerImage = vi.fn(async () => ({
      capabilityId: 'chosen-banner',
      kind: 'input-file' as const,
      displayName: 'logo.png'
    }))
    const release = backend.deferResponse('banners.importImage', logo)
    backend.commands.length = 0
    let pending!: Promise<void>
    act(() => {
      pending = latest().banners.importBanner()
    })
    await waitForObservation(() => latest().banners.bannerImportPhase === 'importing')
    await act(async () => latest().banners.importBanner())
    expect(window.videorc.pickBannerImage).toHaveBeenCalledTimes(1)
    await act(async () => {
      release()
      await pending
    })
    expect(latest().banners.banners).toEqual([logo])
    expect(latest().banners.bannerImportPhase).toBe('idle')
    const methods = backend.commands.map((command) => command.method)
    expect(
      backend.commands.find((command) => command.method === 'banners.importImage')?.params
    ).toEqual({ sourceCapability: 'chosen-banner' })
    expect(methods).not.toContain('banners.show')

    backend.deferFailure(
      'banners.importImage',
      Object.assign(new Error("Animated images aren't supported yet. Export a still PNG."), {
        code: 'banner-import-failed'
      })
    )()
    await act(async () => latest().banners.importBanner())
    await waitForObservation(() => toastSpies.warning.mock.calls.length > 0)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      "Couldn't import the image",
      expect.objectContaining({
        description: "Animated images aren't supported yet. Export a still PNG."
      })
    )
    expect(latest().banners.bannerImportPhase).toBe('idle')
    expect(latest().banners.banners).toEqual([logo])
  })

  // Plan 186 S7: the Stream Manager's copy, its relay, and the remotes.
  it('pushes id, name and shown to the Stream Manager and answers its relay quietly', async () => {
    const sponsor = testBanner('sponsor', 0, { name: 'Sponsor' })
    const logo = testBanner('logo', 1, { name: 'Logo', shown: true })
    const backend = new StudioBackend()
    backend.banners = [sponsor, logo]
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emitIpc: ((name: string, value: unknown) => void) | undefined
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (emit) => {
        emitIpc = emit
      }
    })
    const pushed: unknown[] = []
    const answers: unknown[] = []
    api.pushCommentsBanners = async (banners) => {
      pushed.push(banners)
      return true
    }
    api.pushBannerResult = async (resolution) => {
      answers.push(resolution)
      return true
    }
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    let observation: StudioObservation | undefined
    root = await mountStudioProvider(testDom.container, (value) => {
      observation = value
    })
    await waitForObservation(() => observation?.banners.bannersLoaded === true)
    // Null until the list loads, then the projection: never a file or a place.
    expect(pushed[0]).toBeNull()
    expect(pushed.at(-1)).toEqual([
      { id: 'sponsor', name: 'Sponsor', shown: false },
      { id: 'logo', name: 'Logo', shown: true }
    ])

    backend.commands.length = 0
    await act(async () => {
      emitIpc!('onBannerRequest', { requestId: 'r-show', action: 'show', id: 'sponsor' })
      emitIpc!('onBannerRequest', { requestId: 'r-gone', action: 'hide', id: 'deleted' })
    })
    await waitForObservation(() => answers.length === 2)
    expect(answers).toEqual(
      expect.arrayContaining([
        { requestId: 'r-show', ok: true, value: true },
        { requestId: 'r-gone', ok: false, error: "That banner isn't available anymore." }
      ])
    )

    backend.deferFailure(
      'banners.show',
      Object.assign(new Error('Four banners are showing. Hide one first.'), {
        code: 'banner-show-failed'
      })
    )()
    await act(async () => {
      emitIpc!('onBannerRequest', { requestId: 'r-full', action: 'show', id: 'sponsor' })
    })
    await waitForObservation(() => answers.length === 3)
    expect(answers.at(-1)).toEqual({
      requestId: 'r-full',
      ok: false,
      error: 'Four banners are showing. Hide one first.'
    })
    expect(
      backend.commands
        .filter((command) => command.method.startsWith('banners.'))
        .map((command) => [command.method, command.params])
    ).toEqual([
      ['banners.show', { id: 'sponsor' }],
      ['banners.show', { id: 'sponsor' }]
    ])
    // The window that asked says why; Studio stays quiet.
    expect(toastSpies.warning).not.toHaveBeenCalled()
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(toastSpies.success).not.toHaveBeenCalled()

    // A banners.changed reaches the window as the new projection.
    await act(async () => emitBanners(backend, [{ ...sponsor, shown: true }]))
    await waitForObservation(() => pushed.length > 0 && (pushed.at(-1) as unknown[]).length === 1)
    expect(pushed.at(-1)).toEqual([{ id: 'sponsor', name: 'Sponsor', shown: true }])
  })

  it('runs banner intents from a deck or the phone and describes banners to them', async () => {
    const { backend, latest } = await mountBannerProvider([
      testBanner('sponsor', 0, { name: 'Sponsor', shown: true }),
      testBanner('logo', 1, { name: 'Logo' })
    ])
    const intent = (intentId: string, body: Record<string, unknown>): void => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({ event: 'remote.intent', payload: { intentId, intent: body } })
        })
      }
    }
    const ack = (intentId: string) =>
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === intentId
      )?.params
    // The remote surface publishes once the backend says it is ready.
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({ data: JSON.stringify({ event: 'backend.ready', payload: null }) })
      }
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.surface.publish' &&
          (command.params as { describe?: { banners?: unknown[] } }).describe?.banners?.length === 2
      )
    )
    const published = backend.sentCommands.filter(
      (command) => command.method === 'remote.surface.publish'
    )
    expect(
      (published.at(-1)!.params as { describe: { banners: unknown } }).describe.banners
    ).toEqual([
      { id: 'sponsor', name: 'Sponsor', shown: true },
      { id: 'logo', name: 'Logo', shown: false }
    ])
    expect(JSON.stringify(published.map((command) => command.params))).not.toMatch(/\.png/)

    backend.commands.length = 0
    await act(async () => intent('ri-toggle', { kind: 'bannerToggle', bannerId: 'sponsor' }))
    await waitForObservation(() => ack('ri-toggle') !== undefined)
    await act(async () => intent('ri-show', { kind: 'bannerShow', bannerId: 'logo' }))
    await waitForObservation(() => ack('ri-show') !== undefined)
    await act(async () => intent('ri-gone', { kind: 'bannerShow', bannerId: 'deleted' }))
    await waitForObservation(() => ack('ri-gone') !== undefined)
    expect(ack('ri-toggle')).toEqual({ intentId: 'ri-toggle', ok: true })
    expect(ack('ri-show')).toEqual({ intentId: 'ri-show', ok: true })
    expect(ack('ri-gone')).toEqual({
      intentId: 'ri-gone',
      ok: false,
      message: "That banner isn't available anymore."
    })
    expect(
      backend.commands
        .filter((command) => command.method.startsWith('banners.'))
        .map((command) => [command.method, command.params])
    ).toEqual([
      ['banners.hide', { id: 'sponsor' }],
      ['banners.show', { id: 'logo' }]
    ])
    expect(latest().banners.banners).toHaveLength(2)
  })

  function preciseTransformStatus(backend: StudioBackend): SceneCommitStatus {
    const scene: Scene = {
      ...backend.currentScene,
      sources: backend.currentScene.sources.map((source, index) => ({
        ...source,
        transform: {
          ...source.transform,
          x: index === 0 ? 0.012 : 0.0149,
          y: 0.301,
          width: 0.4,
          height: 0.4
        }
      }))
    }
    return {
      applied: true,
      mode: 'idle',
      sceneRevision: backend.revision + 1,
      scene,
      compositorStatus: compositorFor(scene, backend.currentLayout, backend.revision + 1)
    }
  }

  it.each(['screen-source', 'camera-source'])(
    'freeform transform waits for acknowledgement and persists precise %s and peer geometry',
    async (sourceId) => {
      const { backend, latest } = await mountFreeformTransformProvider()
      const before = latest().core.scene
      const status = preciseTransformStatus(backend)
      const release = backend.deferResponse('scene.source.transform.update', status)
      const patch = {
        x: sourceId === 'screen-source' ? 0.012 : 0.0149,
        y: 0.301,
        width: 0.4,
        height: 0.4
      }
      let pending!: ReturnType<StudioCoreContextValue['setSceneSourceTransform']>
      let settled = false
      act(() => {
        pending = latest().core.setSceneSourceTransform(sourceId, patch)
        void pending.then(() => {
          settled = true
        })
      })
      await waitForObservation(() =>
        backend.sentCommands.some((command) => command.method === 'scene.source.transform.update')
      )
      expect(settled).toBe(false)
      expect(latest().core.scene).toEqual(before)
      expect(
        backend.sentCommands.filter((command) => command.method === 'scene.source.transform.update')
      ).toEqual([expect.objectContaining({ params: { sourceId, transform: patch, snap: 'none' } })])
      await act(async () => {
        release()
        expect(await pending).toEqual({ ok: true, status })
      })
      expect(latest().core.scene).toEqual(status.scene)
      expect(latest().core.captureConfig.layout.sourceTransformOverrides).toEqual({
        'screen-source': { x: 0.012, y: 0.301, width: 0.4, height: 0.4 },
        'camera-source': { x: 0.0149, y: 0.301, width: 0.4, height: 0.4 }
      })
    }
  )

  it.each(['rejected', 'not-applied', 'disconnect'] as const)(
    'freeform transform reports %s without applying or persisting draft geometry',
    async (failure) => {
      const { backend, latest } = await mountFreeformTransformProvider()
      const before = latest().core.scene
      const overrides = latest().core.captureConfig.layout.sourceTransformOverrides
      const status = preciseTransformStatus(backend)
      const release =
        failure === 'rejected'
          ? backend.deferFailure('scene.source.transform.update', new Error('Transform rejected.'))
          : backend.deferResponse('scene.source.transform.update', {
              ...status,
              applied: failure !== 'not-applied',
              message: 'Transform not applied.'
            })
      let pending!: ReturnType<StudioCoreContextValue['setSceneSourceTransform']>
      act(() => {
        pending = latest().core.setSceneSourceTransform('camera-source', { x: 0.0149 })
      })
      await act(async () => {
        if (failure === 'disconnect') backend.sockets[0]?.close()
        release()
        expect(await pending).toEqual({ ok: false })
      })
      expect(latest().core.scene).toEqual(before)
      expect(latest().core.captureConfig.layout.sourceTransformOverrides).toEqual(overrides)
      expect(latest().core.lastError).toBeTruthy()
    }
  )

  // The engine closes a slow peer and keeps running; Main pushes no new
  // connection then, so the Studio must ask for it again.
  it('reconnects when the running engine drops its socket', async () => {
    const { backend, latest } = await mountFreeformTransformProvider()
    await waitForObservation(() => latest().core.wsStatus === 'connected')
    const socketsBefore = backend.sockets.length
    await act(async () => backend.sockets[0]?.close())
    expect(latest().core.wsStatus).toBe('closed')
    await waitForObservation(
      () => backend.sockets.length > socketsBefore && latest().core.wsStatus === 'connected'
    )
    expect(latest().core.scene).not.toBeNull()
  }, 15_000)

  it('freeform transform rejects editing without a backend connection', async () => {
    const { backend, latest } = await mountFreeformTransformProvider(false)
    await act(async () => {
      expect(await latest().core.setSceneSourceTransform('camera-source', { x: 0.0149 })).toEqual({
        ok: false
      })
    })
    expect(
      backend.sentCommands.filter((command) => command.method === 'scene.source.transform.update')
    ).toHaveLength(0)
    expect(latest().core.lastError).toContain('Reconnect')
  })

  it.each(['layout', 'device'] as const)(
    'freeform transform ignores acknowledgement after a newer %s intent',
    async (change) => {
      const { backend, latest } = await mountFreeformTransformProvider()
      const status = preciseTransformStatus(backend)
      const release = backend.deferResponse('scene.source.transform.update', status)
      let pending!: ReturnType<StudioCoreContextValue['setSceneSourceTransform']>
      act(() => {
        pending = latest().core.setSceneSourceTransform('camera-source', { x: 0.0149 })
      })
      await act(async () => {
        latest().core.setCaptureConfig((current) =>
          change === 'layout'
            ? { ...current, layout: { ...current.layout, arrangementMode: 'preset' } }
            : { ...current, sources: { ...current.sources, cameraId: 'camera:replacement' } }
        )
      })
      const afterChange = latest().core.scene
      const overrides = latest().core.captureConfig.layout.sourceTransformOverrides
      await act(async () => {
        release()
        expect(await pending).toEqual({ ok: false })
      })
      expect(latest().core.scene).toEqual(afterChange)
      expect(latest().core.captureConfig.layout.sourceTransformOverrides).toEqual(overrides)
    }
  )

  it('freeform transform cannot overwrite a newer saved-scene choice with identical sources and layout', async () => {
    const { backend, latest } = await mountFreeformTransformProvider()
    await waitForObservation(() => canSaveScene())
    await act(async () => {
      expect(saveScene('Identical A')).toBe(true)
    })
    const first = sceneNamed(latest().core, 'Identical A')
    await act(async () => {
      expect(saveScene('Identical B')).toBe(true)
    })
    const second = sceneNamed(latest().core, 'Identical B')
    expect(first.id).not.toBe(second.id)
    expect(sameSceneVisual(first.visual, second.visual)).toBe(true)
    expect(latest().core.activeSavedSceneId).toBe(second.id)

    const beforeScene = latest().core.scene
    const beforeConfig = latest().core.captureConfig
    const beforeCheckpoint = localStorage.getItem(WORKING_SCENE_KEY)
    const status = preciseTransformStatus(backend)
    const releaseTransform = backend.deferResponse('scene.source.transform.update', status)
    let transform!: ReturnType<StudioCoreContextValue['setSceneSourceTransform']>
    act(() => {
      transform = latest().core.setSceneSourceTransform('camera-source', { x: 0.0149 })
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'scene.source.transform.update')
    )

    // Hold the newer choice at its layout apply (plan 210 S3: the source
    // preflight reads the held device list, with no round trip to hold). Its
    // source/layout identities and authoritative revision have not changed,
    // so only intent ownership can reject the older transform acknowledgement
    // at this point.
    const releaseSelection = backend.deferResponse('scene.layout.apply_preview', BACKEND_RESPONSE)
    let selection!: Promise<boolean>
    act(() => {
      selection = latest().core.applySavedScene(first.id)
    })
    await waitForObservation(() => latest().core.savedScenePendingId === first.id)
    expect(latest().core.scene).toEqual(beforeScene)
    expect(latest().core.captureConfig.layout).toEqual(beforeConfig.layout)
    expect(latest().core.captureConfig.sources).toEqual(beforeConfig.sources)
    expect(backend.revision).toBeLessThan(status.sceneRevision)

    await act(async () => {
      releaseTransform()
      expect(await transform).toEqual({ ok: false })
    })
    expect(latest().core.scene).toEqual(beforeScene)
    expect(latest().core.captureConfig.layout.sourceTransformOverrides).toEqual(
      beforeConfig.layout.sourceTransformOverrides
    )
    expect(latest().core.savedScenePendingId).toBe(first.id)
    expect(latest().core.activeSavedSceneId).toBe(second.id)
    expect(localStorage.getItem(WORKING_SCENE_KEY)).toBe(beforeCheckpoint)

    await act(async () => {
      releaseSelection()
      expect(await selection).toBe(true)
    })
    await waitForObservation(() => latest().core.activeSavedSceneId === first.id && canSaveScene())
    expect(latest().core.captureConfig.layout.sourceTransformOverrides).toEqual(
      first.visual.layout.sourceTransformOverrides
    )
    expect(latest().core.savedSceneModified).toBe(false)
    expect(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).sceneId).toBe(first.id)
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

  it('orders delivery adoption, raw deltas and hydration across bootstrap, clear, session replacement and publisher remounts', async () => {
    const backend = new StudioBackend()
    backend.liveChatSnapshot = {
      sessionId: 'delivery-live',
      providers: [],
      messages: [],
      unreadCount: 0,
      updatedAt: now
    }
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emitIpc: ((name: string, value: unknown) => void) | undefined
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (emit) => {
        emitIpc = emit
      }
    })
    let main: LiveChatSnapshot | null = null
    let detached: LiveChatSnapshot = { providers: [], messages: [], unreadCount: 0, updatedAt: now }
    const publications: Array<{
      kind: string
      view?: CommentsViewSnapshot
      delta?: CommentsSnapshotDelta
    }> = []
    api.pushCommentsDelta = async (delta) => {
      publications.push({ kind: delta.kind, delta })
      const next = applyCommentsSnapshotDelta(main, delta)
      if (next !== main) detached = applyCommentsSnapshotDelta(detached, delta)
      main = next
    }
    api.pushCommentsSnapshot = async (view) => {
      publications.push({ kind: 'snapshot', view })
      if (view.mode.kind === 'live') {
        main = hydrateCommentsSnapshot(main, view.snapshot)
        detached = reconcileBrokerCommentsSnapshot(detached, main)
      }
    }
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = () => observations.at(-1)
    const mount = async () => {
      root = await mountStudioProvider(testDom.container, (value) => {
        observations.push(value)
      })
      await waitForObservation(
        () =>
          latest()?.core.wsStatus === 'connected' &&
          publications.some((entry) => entry.view?.snapshot.sessionId === 'delivery-live')
      )
    }
    const emit = async (event: string, payload: unknown) => {
      await act(async () => {
        for (const socket of backend.sockets)
          socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
      })
    }
    await mount()
    expect(publications[0].kind).toBe('adopt')
    expect(main!.sessionId).toBe('delivery-live')
    expect(main!.delivery!.source).toMatchObject({
      ownerId: latest()!.chat.liveChatSnapshot.delivery!.ownerId,
      generation: latest()!.chat.liveChatSnapshot.delivery!.generation
    })
    const first = { ...highlightMessage, sessionId: 'delivery-live', id: 'delivery-001' }
    await emit('liveChat.message', first)
    expect(main!.delivery!.sequence).toBe(1)
    const operation: CommentsSendOperation = {
      id: 'incidental',
      sessionId: 'delivery-live',
      text: 'fixture',
      phase: 'sent',
      destinations: [],
      createdAt: now,
      updatedAt: now
    }
    await emit('liveChat.sendOperation', operation)
    expect(main!.messages.some((message) => message.id === first.id)).toBe(true)
    expect(main!.delivery!.sequence).toBe(1)
    await waitForObservation(() => latest()?.chat.liveChatSnapshot.delivery?.sequence === 1)
    const priorJournal = main!.delivery
    const socketCount = backend.sockets.length
    const publicationCount = publications.length
    await act(async () =>
      emitIpc!('backend:connection', {
        host: '127.0.0.1',
        port: 9993,
        token: 'delivery-reconnected'
      })
    )
    await waitForObservation(
      () =>
        backend.sockets.length > socketCount &&
        latest()?.core.wsStatus === 'connected' &&
        publications
          .slice(publicationCount)
          .some((entry) => entry.view?.snapshot.sessionId === 'delivery-live')
    )
    expect(publications[publicationCount].kind).toBe('adopt')
    expect(main!.delivery!.ownerId).toBe(priorJournal!.ownerId)
    expect(main!.delivery!.generation).toBe(priorJournal!.generation)
    expect(main!.delivery!.sequence).toBe(1)
    const stale = publications.filter((entry) => entry.view).at(-1)?.view!.snapshot
    await emit('liveChat.cleared', backend.liveChatSnapshot)
    const clearGeneration = main!.delivery!.generation
    const next = { ...first, id: 'delivery-002' }
    await emit('liveChat.message', next)
    main = hydrateCommentsSnapshot(main, stale!)
    expect(main.messages.map((message) => message.id)).toEqual([next.id])
    expect(main.delivery?.generation).toBe(clearGeneration)
    expect(main.delivery?.sequence).toBe(1)
    await emit('liveChat.snapshot', { ...backend.liveChatSnapshot, sessionId: 'delivery-next' })
    expect(main!.sessionId).toBe('delivery-next')
    expect(main!.delivery?.sequence).toBe(0)
    expect(main!.delivery?.source).toMatchObject({
      ownerId: latest()!.chat.liveChatSnapshot.delivery!.ownerId,
      generation: latest()!.chat.liveChatSnapshot.delivery!.generation
    })
    const retired: LiveChatSnapshot[] = [stale!]
    for (let index = 0; index < 3; index++) {
      retired.push(latest()!.chat.liveChatSnapshot)
      await act(async () => root!.unmount())
      root = null
      observations.length = 0
      publications.length = 0
      await mount()
    }
    for (const old of retired) {
      const current = main
      main = hydrateCommentsSnapshot(main, old)
      expect(main).toBe(current)
    }
    expect(detached.delivery).toEqual(main!.delivery)
    await emit('recording.status', {
      state: 'idle',
      sessionId: 'delivery-live',
      message: 'Fixture completed.'
    })
    expect(latest()!.chat.liveChatSnapshot.sessionId).toBeUndefined()
    expect(main!.sessionId).toBeUndefined()
    expect(main!.delivery!.sequence).toBe(0)
    expect(
      publications.some(
        (entry) => entry.delta?.kind === 'clear' && entry.delta.sessionId === 'delivery-live'
      )
    ).toBe(true)
  })

  it('relays confirmed whole-session totals across overflow, clear, lag recovery and renderer reopen', async () => {
    const backend = new StudioBackend()
    const initial: SessionChatTotals = {
      status: 'available',
      sessionId: 'totals-live',
      revision: 6003,
      messageCount: 6003,
      chatters: 6002,
      supporters: 1,
      follows: 0,
      bits: 1500,
      raids: 0,
      platforms: ['twitch', 'youtube', 'x'],
      tips: [{ currency: 'USD', amountMicros: 20_000_000 }]
    }
    backend.chatTotals = initial
    backend.recordingState = 'recording'
    backend.recordingSessionId = initial.sessionId
    backend.liveChatSnapshot = {
      sessionId: initial.sessionId,
      providers: [],
      unreadCount: 0,
      updatedAt: now,
      messages: Array.from({ length: 5000 }, (_, index) => ({
        ...highlightMessage,
        platform: 'x',
        sessionId: initial.sessionId,
        id: `totals-row-${index}`,
        receivedAt: new Date(Date.parse(now) + index * 1000).toISOString()
      }))
    }
    const release = backend.deferResponse('sessions.comments.totals', initial)
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    let dashboard: import('../../../shared/live-dashboard').LiveDashboardState | null = null
    api.getDashboard = async () => dashboard
    api.pushDashboard = async (state) => {
      dashboard = state
    }
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const mount = async () => {
      root = await mountStudioProvider(testDom.container, (value) => {
        observations.push(value)
      })
      await waitForObservation(() => observations.at(-1)?.core.wsStatus === 'connected')
    }
    const emit = async (event: string, payload: unknown) => {
      await act(async () => {
        for (const socket of backend.sockets)
          socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
      })
    }
    await mount()
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'sessions.comments.totals')
    )
    const newer = { ...initial, revision: 6004, supporters: 2 }
    await emit('liveChat.totals', newer)
    await act(async () => release())
    await waitForObservation(
      () => dashboard?.chatTotals?.status === 'available' && dashboard.chatTotals.revision === 6004
    )
    expect(observations.at(-1)!.chat.liveChatSnapshot.messages).toHaveLength(2000)
    backend.liveChatSnapshot = { ...backend.liveChatSnapshot, messages: [], unreadCount: 0 }
    await emit('liveChat.cleared', backend.liveChatSnapshot)
    await waitForObservation(() => observations.at(-1)!.chat.liveChatSnapshot.messages.length === 0)
    expect(dashboard!.chatTotals).toEqual(newer)
    backend.chatTotals = { ...newer, revision: 6005, supporters: 3 }
    const requests = backend.sentCommands.filter(
      (command) => command.method === 'sessions.comments.totals'
    ).length
    await emit('events.lagged', { skipped: 1 })
    await waitForObservation(
      () => dashboard?.chatTotals?.status === 'available' && dashboard.chatTotals.revision === 6005
    )
    expect(
      backend.sentCommands.filter((command) => command.method === 'sessions.comments.totals').length
    ).toBe(requests + 1)
    await act(async () => root!.unmount())
    root = null
    observations.length = 0
    await mount()
    await waitForObservation(
      () =>
        backend.sentCommands.filter((command) => command.method === 'sessions.comments.totals')
          .length ===
        requests + 2
    )
    expect(dashboard!.chatTotals).toEqual(backend.chatTotals)
    await emit('recording.status', { state: 'recording', sessionId: 'replacement', startedAt: now })
    await emit('stream.audience', { sessionId: initial.sessionId, updatedAt: now, platforms: [] })
    await emit('liveChat.totals', { ...initial, revision: 9999 })
    await waitForObservation(() => dashboard?.sessionId === 'replacement')
    expect(dashboard!.chatTotals).toBeNull()
  })

  it('marks suspended recovery overflow as incomplete while main keeps every raw admission and retry hydration mints none', async () => {
    const backend = new StudioBackend()
    backend.liveChatSnapshot = {
      sessionId: 'delivery-overflow',
      providers: [],
      messages: [],
      unreadCount: 0,
      updatedAt: now
    }
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    let main: LiveChatSnapshot | null = null
    api.pushCommentsDelta = async (delta) => {
      main = applyCommentsSnapshotDelta(main, delta)
    }
    api.pushCommentsSnapshot = async (view) => {
      if (view.mode.kind === 'live') main = hydrateCommentsSnapshot(main, view.snapshot)
    }
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = () => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.chat.liveChatSnapshot.sessionId === 'delivery-overflow'
    )
    const before = deliveryCursor(latest()!.chat.liveChatSnapshot.delivery)
    const release = backend.deferResponse('liveChat.status', backend.liveChatSnapshot)
    const initialRequests = backend.sentCommands.filter(
      (command) => command.method === 'liveChat.status'
    ).length
    const emit = async (event: string, payload: unknown) => {
      await act(async () => {
        for (const socket of backend.sockets)
          socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
      })
    }
    await emit('events.lagged', { skipped: 1 })
    await waitForObservation(
      () =>
        backend.sentCommands.filter((command) => command.method === 'liveChat.status').length >
        initialRequests
    )
    const messages = Array.from({ length: 129 }, (_, index) => ({
      ...highlightMessage,
      sessionId: 'delivery-overflow',
      id: `overflow-${index}`,
      receivedAt: new Date(Date.parse(now) + index * 1000).toISOString()
    }))
    for (const message of messages) await emit('liveChat.message', message)
    backend.liveChatSnapshot = { ...backend.liveChatSnapshot, messages }
    await act(async () => release())
    await waitForObservation(() => latest()?.chat.liveChatSnapshot.messages.length === 129)
    const recovered = latest()!.chat.liveChatSnapshot
    expect(recovered.delivery?.lossRevision).toBe(1)
    expect(chatDeliveryProgress(recovered.delivery, before, () => true)).toMatchObject({
      count: 0,
      incomplete: true
    })
    expect(main!.delivery?.sequence).toBe(129)
    expect(main!.delivery?.lossRevision ?? 0).toBe(0)
    expect(main!.messages).toHaveLength(129)
  })

  it('replays a clear ahead of delayed bootstrap and permits current post-clear legacy recovery without minting hydration arrivals', async () => {
    const backend = new StudioBackend()
    const old = { ...highlightMessage, sessionId: 'delivery-live', id: 'old-before-clear' }
    backend.liveChatSnapshot = {
      sessionId: 'delivery-live',
      providers: [],
      messages: [old],
      unreadCount: 0,
      updatedAt: now
    }
    const release = backend.deferResponse('liveChat.status', backend.liveChatSnapshot)
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
    const latest = () => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'liveChat.status')
    )
    const emit = async (event: string, payload: unknown) => {
      await act(async () => {
        for (const socket of backend.sockets)
          socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
      })
    }
    const cleared = { ...backend.liveChatSnapshot, messages: [] }
    await emit('liveChat.cleared', cleared)
    await act(async () => release())
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    expect(latest()!.chat.liveChatSnapshot.messages).toEqual([])
    const missed = { ...old, id: 'valid-post-clear-history' }
    await emit('liveChat.snapshot', { ...cleared, messages: [missed] })
    expect(latest()!.chat.liveChatSnapshot.messages).toEqual([missed])
    expect(latest()!.chat.liveChatSnapshot.delivery?.sequence).toBe(0)
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

  it('sends the picked corner with a highlight and moves a live card when the pick changes', async () => {
    const backend = new StudioBackend()
    backend.liveChatSnapshot = {
      sessionId: highlightMessage.sessionId,
      providers: [],
      messages: [highlightMessage],
      unreadCount: 0,
      updatedAt: now
    }
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emitIpc: ((name: string, value: unknown) => void) | undefined
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (emit) => {
        emitIpc = emit
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    // The provider has the live chat once it has asked the backend for it.
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        backend.commands.some((command) => command.method === 'liveChat.status')
    )
    const windowState = (highlightAnchor: string): Record<string, unknown> => ({
      open: true,
      visible: true,
      bounds: null,
      alwaysOnTop: false,
      highlightAnchor,
      protected: false,
      enabled: true
    })
    const highlightSets = (): BackendCommand[] =>
      backend.commands.filter((command) => command.method === 'comments.highlight.set')

    // The pick arrives from main (the Chat window's corner menu persists there).
    await act(async () => emitIpc?.('onCommentsWindowState', windowState('bottom-right')))
    await act(async () => latest()!.core.toggleCommentHighlight(highlightMessage))
    await waitForObservation(() => latest()?.core.commentHighlightState.phase === 'live')

    expect(highlightSets()).toHaveLength(1)
    expect(highlightSets()[0]!.params).toMatchObject({
      messageId: highlightMessage.id,
      anchor: 'bottom-right'
    })
    expect(highlightSets()[0]!.params).not.toHaveProperty('position')

    // Changing the corner while the card is live re-sends the SAME message
    // (a move), never the un-pin a repeated click would mean.
    await act(async () => emitIpc?.('onCommentsWindowState', windowState('top-right')))
    await waitForObservation(() => highlightSets().length === 2)
    expect(highlightSets()[1]!.params).toMatchObject({
      messageId: highlightMessage.id,
      anchor: 'top-right'
    })
    expect(
      backend.commands.filter((command) => command.method === 'comments.highlight.clear')
    ).toHaveLength(0)
    expect(latest()?.core.commentHighlightState.phase).toBe('live')

    // An unknown value from an old prefs file lands on the default corner.
    await act(async () => emitIpc?.('onCommentsWindowState', windowState('middle')))
    await waitForObservation(() => highlightSets().length === 3)
    expect(highlightSets()[2]!.params).toMatchObject({ anchor: 'bottom-left' })
  })

  it('publishes where the Stream Manager is and its screens to the remotes (plan 230)', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emitIpc: ((name: string, value: unknown) => void) | undefined
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (emit) => {
        emitIpc = emit
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    // The remote surface publishes once the backend says it is ready.
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({ data: JSON.stringify({ event: 'backend.ready', payload: null }) })
      }
      await Promise.resolve()
    })
    type Published = {
      state?: {
        windows?: { comments?: boolean }
        streamManager?: { screenId: string | null; visible: boolean; hiddenFromStream: boolean }
      }
      describe?: { screens?: unknown; screenMoves?: unknown }
    }
    const published = (): Published[] =>
      backend.sentCommands
        .filter((command) => command.method === 'remote.surface.publish')
        .map((command) => command.params as Published)
    const windowState = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      open: true,
      visible: true,
      bounds: { x: 1920, y: 0, width: 600, height: 800 },
      windowId: 7,
      alwaysOnTop: false,
      hiddenFromStream: false,
      hideFromStreamMethod: 'capture-filter',
      screenId: '2',
      screens: [
        { id: '1', name: 'DELL U2723QE' },
        { id: '2', name: 'DELL U2311H' }
      ],
      screenMoves: 'supported',
      highlightAnchor: 'bottom-left',
      protected: false,
      enabled: true,
      ...overrides
    })

    // Main says the window sits on the Monitor screen: remotes read it.
    await act(async () => emitIpc?.('onCommentsWindowState', windowState({})))
    await waitForObservation(() =>
      published().some((p) => p.state?.streamManager?.screenId === '2')
    )
    expect(published().at(-1)).toMatchObject({
      state: {
        windows: { comments: true },
        streamManager: { screenId: '2', visible: true, hiddenFromStream: false }
      },
      describe: {
        screens: [
          { id: '1', name: 'DELL U2723QE' },
          { id: '2', name: 'DELL U2311H' }
        ],
        screenMoves: 'supported'
      }
    })
    // Never its frame or the window's id.
    expect(JSON.stringify(published().at(-1))).not.toContain('1920')
    expect(JSON.stringify(published().at(-1))).not.toContain('windowId')

    // On the Presenting screen with Hide from stream on: the key reads Hidden.
    await act(async () =>
      emitIpc?.('onCommentsWindowState', windowState({ screenId: '1', hiddenFromStream: true }))
    )
    await waitForObservation(
      () => published().at(-1)?.state?.streamManager?.hiddenFromStream === true
    )
    expect(published().at(-1)?.state?.streamManager).toEqual({
      screenId: '1',
      visible: true,
      hiddenFromStream: true
    })

    // A Wayland session: the key says a tap cannot move the window.
    await act(async () =>
      emitIpc?.('onCommentsWindowState', windowState({ screenMoves: 'wayland' }))
    )
    await waitForObservation(() => published().at(-1)?.describe?.screenMoves === 'wayland')

    // Minimized: on its screen but not shown.
    await act(async () =>
      emitIpc?.('onCommentsWindowState', windowState({ visible: false, screenMoves: 'wayland' }))
    )
    await waitForObservation(() => published().at(-1)?.state?.streamManager?.visible === false)
    expect(published().at(-1)?.state?.streamManager?.screenId).toBe('2')
  })

  it('sends a second card for the vertical leg only when the backend reports one', async () => {
    const backend = new StudioBackend()
    backend.liveChatSnapshot = {
      sessionId: highlightMessage.sessionId,
      providers: [],
      messages: [highlightMessage],
      unreadCount: 0,
      updatedAt: now
    }
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
        backend.commands.some((command) => command.method === 'liveChat.status')
    )
    const highlightSets = (): BackendCommand[] =>
      backend.commands.filter((command) => command.method === 'comments.highlight.set')

    // Horizontal-only session: one card, no vertical raster on the wire.
    await act(async () => latest()!.core.toggleCommentHighlight(highlightMessage))
    await waitForObservation(() => highlightSets().length === 1)
    expect(highlightSets()[0]!.params).not.toHaveProperty('verticalPngBase64')

    // Dual-orientation session (plan 074): the vertical leg gets its own card.
    await act(async () => latest()!.core.toggleCommentHighlight(highlightMessage))
    await waitForObservation(() => latest()?.core.commentHighlightState.phase === 'idle')
    backend.commentHighlightCanvases = { vertical: { width: 1080, height: 1920 } }
    await act(async () => latest()!.core.toggleCommentHighlight(highlightMessage))
    await waitForObservation(() => highlightSets().length === 2)
    expect(highlightSets()[1]!.params).toMatchObject({
      messageId: highlightMessage.id,
      pngBase64: 'cG5n',
      verticalPngBase64: 'cG5n'
    })
  })

  // Plan 260 S1.2b: the backend draws the caption bar from the line's text at
  // the leg's canvas; the renderer sends the text, the style, the canvas and
  // the rect, never its pixels.
  it('asks the backend to draw the caption line, never sending its pixels', async () => {
    const backend = new StudioBackend()
    backend.recordingState = 'streaming'
    backend.recordingSessionId = 'caption-session'
    backend.captionsStatus = {
      state: 'listening',
      desiredEnabled: true,
      sessionClientId: 'captions-1'
    }
    backend.overlayLayout = {
      ...DEFAULT_OVERLAY_LAYOUT,
      captions: { ...DEFAULT_OVERLAY_LAYOUT.captions, showOnStream: true }
    }
    // The start edge may run before bootstrap commits the status; the running
    // captions answer it with the same status.
    backend.deferResponse('captions.start', backend.captionsStatus)()
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
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        recordEnabled: false,
        streamEnabled: true,
        captions: {
          ...defaultCaptureConfig.captions,
          enabled: true,
          burnTarget: 'stream',
          styleId: 'high-contrast',
          textSize: 'l',
          position: 'bottom'
        }
      })
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.overlayLayout.captions.showOnStream === true &&
        latest()?.core.captionsStatus.state === 'listening'
    )
    const captionSets = (): BackendCommand[] =>
      backend.commands.filter((command) => command.method === 'captions.overlay.set')
    const line: CaptionsUpdate = {
      sessionClientId: 'captions-1',
      seq: 1,
      kind: 'final',
      text: 'Hello chat',
      chunkSeconds: 3
    }
    await act(async () => {
      for (const socket of backend.sockets)
        socket.onmessage?.({ data: JSON.stringify({ event: 'captions.update', payload: line }) })
      await Promise.resolve()
    })
    await waitForObservation(() => captionSets().length === 1)
    const params = captionSets()[0]!.params as Record<string, unknown>
    // A stream-only session: the bar goes on the primary leg, at its canvas,
    // wrapped to the captions rect for its orientation.
    expect(params).toMatchObject({
      text: 'Hello chat',
      textSize: 'l',
      styleId: 'high-contrast',
      position: 'bottom',
      rect: DEFAULT_OVERLAY_LAYOUT.captions.horizontal,
      target: 'primary',
      styleRevision: defaultCaptureConfig.captions.styleRevision
    })
    expect(params.canvasWidth).toBeGreaterThan(params.canvasHeight as number)
    expect(params).not.toHaveProperty('pngBase64')
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
      error: 'A newer highlight replaced this request.'
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

  it('releases a takeover-owned mute at launch even when another bootstrap request fails', async () => {
    // The previous run quit with a takeover on air: the mute and its ownership
    // record are still in storage, but a fresh backend has no active takeover.
    const backend = new StudioBackend()
    backend.screens = [takeoverScreen]
    backend.activeScreen = null
    const respond = backend.response.bind(backend)
    vi.spyOn(backend, 'response').mockImplementation((command) => {
      if (command.method === 'sessions.storage') {
        throw new Error('storage totals unavailable')
      }
      return respond(command)
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
    localStorage.setItem(
      SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY,
      JSON.stringify({ priorMicrophoneMuted: false })
    )
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        audio: { ...defaultCaptureConfig.audio, microphoneMuted: true }
      })
    )
    // Releasing stores the restored config before it drops the ownership
    // record, so the stored mute is never left without the record that
    // releases it.
    const releaseWrites: string[] = []
    const setItem = localStorage.setItem.bind(localStorage)
    const removeItem = localStorage.removeItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (
        key === STORAGE_KEYS.captureConfig &&
        JSON.parse(value).audio?.microphoneMuted === false
      ) {
        releaseWrites.push('unmuted config')
      }
      setItem(key, value)
    })
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
      if (key === SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY) {
        releaseWrites.push('ownership removed')
      }
      removeItem(key)
    })
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
        latest()?.core.activeScreen === null &&
        latest()?.core.captureConfig.audio.microphoneMuted === false
    )
    expect(localStorage.getItem(SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY)).toBeNull()
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEYS.captureConfig) ?? '{}').audio.microphoneMuted
    ).toBe(false)
    expect(releaseWrites.slice(0, 2)).toEqual(['unmuted config', 'ownership removed'])
  })

  // Plan 195 S4: `screens.active` rides the liveControl lane, which a slow
  // Record start (its reconciliation fence) or a long poster can hold past
  // the lane's queue age. The expiry used to fail the whole launch or focus
  // batch and toast "Videorc hit a problem" with "Videorc was busy…" for a
  // read the streamer never asked for. Background reads never toast; a live
  // control the streamer pressed names itself.
  const BUSY_DESCRIPTION = "Videorc was busy and didn't do it. Try again in a moment."
  const busyLaneError = (): Error =>
    Object.assign(
      new Error('The command expired while awaiting its reconciliation fence and was not applied.'),
      { code: 'command-expired-before-dispatch' }
    )
  const toastCalls = (): unknown[][] =>
    [toastSpies.error, toastSpies.warning, toastSpies.info, toastSpies.message].flatMap(
      (spy) => spy.mock.calls
    )
  const expectNoBusyOrGenericToast = (): void => {
    expect(
      toastCalls()
        .map(([title, options]) => [
          title,
          (options as { description?: unknown } | undefined)?.description
        ])
        .filter(
          ([title, description]) =>
            title === 'Videorc hit a problem' || description === BUSY_DESCRIPTION
        )
    ).toEqual([])
  }

  it('never toasts a busy takeover read at launch, commits the rest and retries it (plan 195 S4)', async () => {
    const backend = new StudioBackend()
    backend.screens = [takeoverScreen]
    backend.activeScreen = takeoverScreen
    let busyReads = 1
    const respond = backend.response.bind(backend)
    vi.spyOn(backend, 'response').mockImplementation((command) => {
      if (command.method === 'screens.active' && busyReads > 0) {
        busyReads -= 1
        throw busyLaneError()
      }
      return respond(command)
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
    const warn = vi.spyOn(console, 'warn')
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue | undefined => observations.at(-1)?.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })

    // The rest of the launch commits: the busy read no longer fails the batch.
    await waitForObservation(() => canSaveScene())
    expect(latest()?.screens).toEqual([takeoverScreen])
    // A retry reads the takeover once the lane is free.
    await waitForObservation(() => latest()?.activeScreen?.id === takeoverScreen.id)
    expect(
      backend.sentCommands.filter((command) => command.method === 'screens.active')
    ).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(
      '[takeover] reading the active takeover failed:',
      expect.objectContaining({ code: 'command-expired-before-dispatch' })
    )
    expectNoBusyOrGenericToast()
    expect(latest()?.lastError).toBeNull()
  })

  it('never toasts an idle scene reload a session superseded, and reloads once the slot frees', async () => {
    // A 0.36.0 Windows tester: first-run setup's performance check took the
    // session slot, the backend refused the idle reload ("superseded by
    // session startup") and the Studio said "Videorc hit a problem".
    const backend = new StudioBackend()
    let superseded = 1
    const respond = backend.response.bind(backend)
    vi.spyOn(backend, 'response').mockImplementation((command) => {
      if (command.method === 'scene.load_from_capture_config' && superseded > 0) {
        superseded -= 1
        throw Object.assign(
          new Error('Idle capture-config scene reload was superseded by session startup'),
          { code: 'scene-reload-superseded' }
        )
      }
      return respond(command)
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
    const latest = (): StudioCoreContextValue | undefined => observations.at(-1)?.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })

    const reloads = (): number =>
      backend.sentCommands.filter((command) => command.method === 'scene.load_from_capture_config')
        .length
    await waitForObservation(() => superseded === 0)
    // The refused reload tries again by itself (1 s) and commits.
    await waitForObservation(() => reloads() >= 2)
    expectNoBusyOrGenericToast()
    expect(latest()?.lastError).toBeNull()
  })

  it('never toasts a busy takeover read on a focus refresh, and commits the rest (plan 195 S4)', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => [],
        // Main owns the account refresh; it has nothing to say here.
        refreshAccount: async () => ({ outcome: 'deferred' as const })
      })
    )
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    toastSpies.error.mockClear()
    toastSpies.warning.mockClear()

    const respond = backend.response.bind(backend)
    vi.spyOn(backend, 'response').mockImplementation((command) => {
      if (command.method === 'screens.active') throw busyLaneError()
      return respond(command)
    })
    const plugged: Device = {
      id: 'camera:plugged',
      name: 'Plugged Camera',
      kind: 'camera',
      status: 'available'
    }
    backend.deviceList = {
      ...backend.deviceList,
      devices: [plugged, ...backend.deviceList.devices]
    }
    await act(async () => {
      await latest().refreshBackend({ fresh: true })
    })

    expect(latest().deviceList.devices).toContainEqual(plugged)
    expect(
      backend.sentCommands.filter((command) => command.method === 'screens.active').length
    ).toBeGreaterThanOrEqual(2)
    // Give a lazily loaded error toast the time it would need to land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expectNoBusyOrGenericToast()
    expect(latest().lastError).toBeNull()
  })

  it('names the takeover when a busy lane drops Show or Take off (plan 195 S4)', async () => {
    const backend = new StudioBackend()
    backend.screens = [takeoverScreen]
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())

    for (const [method, run, title] of [
      [
        'screens.activate',
        () => latest().activateScreen(takeoverScreen.id),
        "Couldn't show the takeover"
      ],
      ['screens.clear', () => latest().clearActiveScreen(), "Couldn't take off the takeover"]
    ] as const) {
      toastSpies.warning.mockClear()
      backend.deferFailure(method, busyLaneError())()
      let result: boolean | undefined
      await act(async () => {
        result = await run()
      })
      expect(result).toBe(false)
      // The failure copy loads on demand, so its toast lands a moment later.
      await waitForObservation(() => toastSpies.warning.mock.calls.length > 0)
      expect(toastSpies.warning).toHaveBeenCalledWith(
        title,
        expect.objectContaining({ description: BUSY_DESCRIPTION })
      )
    }
    expect(toastCalls().map(([title]) => title)).not.toContain('Videorc hit a problem')
  })

  it('names the banner when a busy lane drops Show or Hide (plan 195 S4)', async () => {
    const { backend, latest } = await mountBannerProvider([testBanner('sponsor', 0)])
    for (const [method, run, title] of [
      ['banners.show', () => latest().banners.showBanner('sponsor'), "Couldn't show the banner"],
      ['banners.hide', () => latest().banners.hideBanner('sponsor'), "Couldn't hide the banner"],
      ['banners.hide', () => latest().banners.hideBanner(), "Couldn't hide the banners"]
    ] as const) {
      toastSpies.warning.mockClear()
      backend.deferFailure(method, busyLaneError())()
      let result: boolean | undefined
      await act(async () => {
        result = await run()
      })
      expect(result).toBe(false)
      await waitForObservation(() => toastSpies.warning.mock.calls.length > 0)
      expect(toastSpies.warning).toHaveBeenCalledWith(
        title,
        expect.objectContaining({ description: BUSY_DESCRIPTION })
      )
    }
    expect(toastCalls().map(([title]) => title)).not.toContain('Videorc hit a problem')
  })

  // Plan 174 S3.18 (I-1): the bundle lands in a folder Finder hides, so the
  // export toast reveals it, through main, by the path the export returned.
  it('offers to show an exported support bundle in the file manager', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const revealSupportBundle = vi.fn(async (_path: string) => {})
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      revealSupportBundle
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => observations.at(-1)?.core.wsStatus === 'connected')

    await act(async () => {
      await observations.at(-1)!.core.exportSupportBundle()
    })
    const exported = toastSpies.success.mock.calls.find(
      ([title]) => title === 'Support bundle exported'
    )
    expect(exported?.[1]).toMatchObject({
      description: 'videorc-support-bundle-20261011-093000Z.json',
      action: { label: 'Show in Explorer' }
    })
    await act(async () => exported![1].action.onClick())
    expect(revealSupportBundle).toHaveBeenCalledExactlyOnceWith(
      'C:\\Videorc\\support-bundles\\videorc-support-bundle-20261011-093000Z.json'
    )
  })

  // Plan 216 A3 + A5: a switch that gave up on a camera says so, and the next
  // support bundle carries the raw refusal in the renderer's error ring.
  it('names the camera that never sent video, and the bundle keeps the raw refusal', async () => {
    const backend = new StudioBackend()
    backend.layoutApplyFailure = 'camera-not-ready'
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
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    const latest = (): StudioObservation => observations.at(-1)!
    await waitForObservation(() => latest().core.wsStatus === 'connected')

    await act(async () => latest().core.applyCameraPreset({ layoutPreset: 'camera-only' }))
    await waitForObservation(() =>
      toastSpies.error.mock.calls.some(([title]) => title === "Couldn't switch the scene")
    )
    expect(toastSpies.error).toHaveBeenCalledWith(
      "Couldn't switch the scene",
      expect.objectContaining({
        description: "Your camera isn't sending video. Check it in Sources, then try again."
      })
    )

    backend.layoutApplyFailure = null
    await act(async () => {
      await latest().core.exportSupportBundle()
    })
    const exported = backend.commands.find(
      (command) => command.method === 'diagnostics.supportBundle.export'
    )
    const ring = (
      exported!.params as {
        rendererDiagnostics?: { recentUserErrors?: Array<Record<string, unknown>> }
      }
    ).rendererDiagnostics?.recentUserErrors
    expect(ring?.at(-1)).toMatchObject({
      action: 'switch',
      object: 'the scene',
      code: 'layout-camera-not-ready',
      kind: 'known',
      title: "Couldn't switch the scene",
      raw: expect.stringContaining('camera session never delivered a frame')
    })
  })

  it('shows one persistent recovery error when an active recording fails', async () => {
    const backend = new StudioBackend()
    backend.recordingState = 'recording'
    backend.recordingSessionId = 'session-failed'
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
    const degraded: HealthEvent = {
      ...encoderFailure,
      id: 'degraded-before-failure',
      level: 'warn',
      code: 'recording-degraded',
      message: 'Recording is falling behind.'
    }
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'health.event', payload: degraded })
      })
    })
    // Plan 250: a warning during a recording waits behind the bell.
    await waitForObservation(
      () => notification('session-notice:recording-degraded')?.state === 'open'
    )
    expect(toastSpies.warning).not.toHaveBeenCalled()

    const failedStatus = {
      state: 'failed' as const,
      sessionId: 'session-failed',
      outputPath: 'C:\\recordings\\session-failed.mkv',
      message: 'Encoder FIFO write exceeded the complete-frame delivery budget.'
    }
    await act(async () => {
      // The lazy module continuation resumes only after the terminal push.
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'health.event', payload: degraded })
      })
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

    await waitForObservation(() => toastSpies.error.mock.calls.length === 1)
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'health.event',
          payload: {
            ...degraded,
            id: 'late-degradation',
            createdAt: '2026-08-25T09:55:27.033Z'
          }
        })
      })
      await Promise.resolve()
    })
    expect(toastSpies.warning).not.toHaveBeenCalledWith(
      'Recording is falling behind',
      expect.anything()
    )

    // Plan 250: the take's open problems ended with it, and the failure is
    // one urgent entry behind the bell with one 15 s toast, never pinned.
    expect(notification('session-notice:recording-degraded')?.state).not.toBe('open')
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Recording stopped unexpectedly',
      expect.objectContaining({
        id: 'notification:recording-failed:session-failed',
        description: failedStatus.message,
        duration: 15_000,
        action: expect.objectContaining({ label: 'Open in Library' })
      })
    )
    expect(notification('recording-failed:session-failed')).toMatchObject({
      tone: 'urgent',
      title: 'Recording stopped unexpectedly',
      detail: failedStatus.message,
      actions: [{ label: 'Open in Library' }, { label: revealInFileManagerLabel() }]
    })
    expect(toastSpies.success).not.toHaveBeenCalled()
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'recording-failed',
      activity: 'recording',
      sessionId: 'session-failed',
      outputPath: failedStatus.outputPath,
      message: failedStatus.message
    })

    await notifications.runAction('recording-failed:session-failed', 'open-library')
    await notifications.runAction('recording-failed:session-failed', 'reveal')
    expect(libraryNavigations).toEqual([{ tab: 'library', sessionId: 'session-failed' }])
    expect(revealSession).toHaveBeenCalledWith('session-failed')

    await act(async () => latest()!.core.dismissSessionRuntimeNotice())
    expect(latest()?.core.sessionRuntimeNotice).toBeNull()
    // Dismissing the Studio's inline alert leaves the entry behind the bell.
    expect(notification('recording-failed:session-failed')).toBeDefined()
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: {
            state: 'recording',
            sessionId: 'retry-session',
            message: 'Running recording.'
          }
        })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'health.event',
          payload: {
            ...degraded,
            id: 'new-session-degradation',
            sessionId: 'retry-session'
          }
        })
      })
    })
    // The next recording's own notice opens the subject again.
    await waitForObservation(
      () => notification('session-notice:recording-degraded')?.state === 'open'
    )
    expect(notification('session-notice:recording-degraded')).toMatchObject({
      title: 'Recording is falling behind',
      sessionId: 'retry-session'
    })
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
        id: `notification:recording-failed:${failedStatus.sessionId}`,
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
        id: 'notification:recording-failed:session-failed-in-gap',
        description: failureEvent.message,
        duration: 15_000,
        action: expect.objectContaining({ label: 'Open in Library' })
      })
    )
    expect(notification('recording-failed:session-failed-in-gap')?.actions).toMatchObject([
      { label: 'Open in Library' },
      { label: revealInFileManagerLabel() }
    ])
    expect(reconnectedBackend.commands).toContainEqual(
      expect.objectContaining({
        method: 'sessions.healthEvents.list',
        params: expect.objectContaining({ sessionId: 'session-failed-in-gap' })
      })
    )

    await notifications.runAction('recording-failed:session-failed-in-gap', 'open-library')
    await notifications.runAction('recording-failed:session-failed-in-gap', 'reveal')
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

    // A record+stream (Go Live) session was on air: its failure is a live
    // session's, and it keeps the saved file's actions (plan 174 B-6).
    expect(latest()?.recording.recording.state).toBe('failed')
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'recording-failed',
      activity: 'record+stream',
      sessionId: 'session-failed-snapshot',
      outputPath: 'C:\\recordings\\session-failed-snapshot.mkv',
      message: failedSnapshotEvent.message
    })
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Livestream stopped unexpectedly',
      expect.objectContaining({
        description: failedSnapshotEvent.message,
        action: expect.objectContaining({ label: 'Open in Library' })
      })
    )
    expect(notification('recording-failed:session-failed-snapshot')?.actions).toMatchObject([
      { label: 'Open in Library' },
      { label: revealInFileManagerLabel() }
    ])
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
    // Plan 250: one urgent entry on the microphone, one 15 s toast.
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Microphone stopped: recording continues with silence',
      expect.objectContaining({
        id: 'notification:microphone',
        description: microphoneLost.message,
        duration: 15_000,
        action: expect.objectContaining({ label: 'Open Audio' })
      })
    )
    expect(notification('microphone')).toMatchObject({ state: 'open', tone: 'urgent' })
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

    // A second reconnect is the same episode: one entry, one pop-up.
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
    expect(notification('microphone')).toMatchObject({ state: 'open', occurrences: 1 })

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

    // Plan 250: one urgent entry on the microphone, one 15 s toast.
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
    expect(toastSpies.error).toHaveBeenCalledWith(
      'Microphone stopped: recording continues with silence',
      expect.objectContaining({
        id: 'notification:microphone',
        description: microphoneLost.message,
        duration: 15_000,
        action: expect.objectContaining({ label: 'Open Audio' })
      })
    )
    expect(notification('microphone')).toMatchObject({ state: 'open', tone: 'urgent' })
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
      // Plan 250 (D13): the entry's short toast while idle, never 12 s.
      expect.objectContaining({ duration: 8_000 })
    )
    // The microphone's own pop-up, and no failure beside it.
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'microphone-input-lost',
      activity: 'recording',
      phase: 'ended',
      sessionId: 'session-with-silence',
      message: microphoneLost.message
    })
    // The entry takes the ended words and ends with the recording; nothing
    // pops up a second time.
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
    expect(notification('microphone')).toMatchObject({
      state: 'resolved',
      peakTone: 'urgent',
      title: 'Microphone stopped: saved recording contains silence',
      detail: `${microphoneLost.message} Ended with the recording.`
    })

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
    // The next session clears the Studio's notice; what happened stays listed.
    expect(notification('microphone')?.state).toBe('resolved')

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

    expect(toastSpies.error).toHaveBeenCalledWith(
      'Microphone stopped: livestream continues with silence',
      expect.objectContaining({ id: 'notification:microphone' })
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
    expect(notification('microphone')).toMatchObject({
      state: 'resolved',
      title: 'Microphone stopped during the livestream'
    })
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

    expect(notification('microphone')).toMatchObject({
      title: 'Microphone stopped during the livestream'
    })
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'microphone-input-lost',
      activity: 'live-stream',
      phase: 'ended',
      sessionId: 'late-live-loss'
    })
  })

  // Plan 095 S5: Go Live leaves recordEnabled on, and the backend reports a
  // record+stream session as `recording` with a stream URL. It is on air (the
  // Stream Manager opens, the X reminder fires) and it still saves a file.
  it('treats Go Live (record+stream) as live and still announces the saved recording', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const openCommentsWindow = vi.fn(async () => undefined)
    Object.assign(api, { openCommentsWindow })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({ openStreamManagerOnLive: true }))
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        recordEnabled: true,
        streamEnabled: true,
        streaming: {
          ...defaultCaptureConfig.streaming,
          enabled: true,
          enabledTargetIds: ['x'],
          targets: defaultCaptureConfig.streaming.targets.map((target) =>
            target.id === 'x' ? { ...target, enabled: true, authMode: 'manual-rtmp' } : target
          )
        }
      } satisfies CaptureConfig)
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    vi.clearAllMocks()

    const xReminderCalls = (): number =>
      toastSpies.info.mock.calls.filter(([message]) =>
        String(message).startsWith('X feed is connected')
      ).length
    const goLive: RecordingStatus = {
      state: 'recording',
      sessionId: 'go-live-session',
      startedAt: now,
      streamUrl: 'rtmp://127.0.0.1/live/***',
      message: 'Running both session.'
    }
    const pushStatus = async (status: RecordingStatus): Promise<void> => {
      await act(async () => {
        backend.sockets[0]?.onmessage?.({
          data: JSON.stringify({ event: 'recording.status', payload: status })
        })
        await Promise.resolve()
      })
    }

    await pushStatus(goLive)
    await waitForObservation(() => latest()?.recording.recording.sessionId === 'go-live-session')
    await waitForObservation(() => openCommentsWindow.mock.calls.length === 1)
    expect(xReminderCalls()).toBe(1)

    // A running tick repeats the state: no second window, no second reminder.
    await pushStatus({ ...goLive, message: 'Still running.' })
    await waitForObservation(() => latest()?.recording.recording.message === 'Still running.')
    expect(openCommentsWindow).toHaveBeenCalledTimes(1)
    expect(xReminderCalls()).toBe(1)

    await pushStatus({
      state: 'idle',
      sessionId: 'go-live-session',
      outputPath: '/recordings/go-live-session.mp4',
      durationMs: 65_000,
      message: 'Saved.'
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
    await waitForObservation(() => toastSpies.success.mock.calls.length === 1)
    expect(toastSpies.success).toHaveBeenCalledWith(
      'Recording saved',
      // Plan 250 (D13): the entry's short toast while idle, never 12 s.
      expect.objectContaining({ duration: 8_000 })
    )
  })

  // Plan 174 B-6: the runtime notices read that `recording` + stream URL
  // session as live. A microphone dropout tells the streamer the live session
  // goes on silent (the audience hears it), and the saved file is still
  // announced when it ends.
  it('reports a microphone loss during Go Live (record+stream) as a live-session notice', async () => {
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
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    vi.clearAllMocks()

    const push = async (event: string, payload: unknown): Promise<void> => {
      await act(async () => {
        backend.sockets[0]?.onmessage?.({ data: JSON.stringify({ event, payload }) })
        await Promise.resolve()
      })
    }
    await push('recording.status', {
      state: 'recording',
      sessionId: 'go-live-silent',
      startedAt: now,
      streamUrl: 'rtmp://127.0.0.1/live/***',
      message: 'Running both session.'
    } satisfies RecordingStatus)
    await waitForObservation(() => latest()?.recording.recording.sessionId === 'go-live-silent')
    await push('health.event', {
      id: 'go-live-microphone-lost',
      sessionId: 'go-live-silent',
      level: 'warn',
      code: 'microphone-input-lost',
      message: 'The selected microphone stopped providing audio.',
      permissionPane: null,
      createdAt: now
    } satisfies HealthEvent)
    await waitForObservation(
      () => latest()?.core.sessionRuntimeNotice?.kind === 'microphone-input-lost'
    )

    expect(toastSpies.error).toHaveBeenCalledWith(
      'Microphone stopped: livestream continues with silence',
      expect.objectContaining({ id: 'notification:microphone' })
    )
    expect(toastSpies.error).not.toHaveBeenCalledWith(
      'Microphone stopped: recording continues with silence',
      expect.anything()
    )
    expect(latest()?.core.sessionRuntimeNotice).toMatchObject({
      kind: 'microphone-input-lost',
      activity: 'record+stream',
      phase: 'active',
      sessionId: 'go-live-silent'
    })

    await push('recording.status', {
      state: 'idle',
      sessionId: 'go-live-silent',
      outputPath: '/recordings/go-live-silent.mp4',
      durationMs: 65_000,
      message: 'Saved.'
    } satisfies RecordingStatus)
    await waitForObservation(() => toastSpies.success.mock.calls.length === 1)
    expect(toastSpies.success).toHaveBeenCalledWith(
      'Recording saved',
      // Plan 250 (D13): the entry's short toast while idle, never 12 s.
      expect.objectContaining({ duration: 8_000 })
    )
    expect(notification('microphone')).toMatchObject({
      state: 'resolved',
      title: 'Microphone stopped during the livestream'
    })
  })

  // Plan 174 S0.1 (D2): every stop path asks through requestStopSession. While
  // live, an in-app origin opens the End livestream question (the shell hosts
  // it), a global hotkey arms for a second press, and the device intents keep
  // their contract. A recording that is not live stops at once.
  it('asks before ending a livestream, arms a hotkey, and keeps the device contract', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
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
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        recordEnabled: true,
        streamEnabled: true,
        streaming: {
          ...defaultCaptureConfig.streaming,
          enabled: true,
          enabledTargetIds: ['twitch'],
          targets: defaultCaptureConfig.streaming.targets.map((target) =>
            target.id === 'twitch' ? { ...target, enabled: true, authMode: 'manual-rtmp' } : target
          )
        }
      } satisfies CaptureConfig)
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation => observations.at(-1)!
    let shell: ReturnType<typeof useStudioShell> | undefined
    function ShellProbe(): null {
      const value = useStudioShell()
      useEffect(() => {
        shell = value
      }, [value])
      return null
    }
    root = await mountStudioProvider(
      testDom.container,
      (value) => {
        observations.push(value)
      },
      createElement(ShellProbe)
    )
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    vi.clearAllMocks()

    const pushStatus = async (status: RecordingStatus): Promise<void> => {
      await act(async () => {
        backend.sockets[0]?.onmessage?.({
          data: JSON.stringify({ event: 'recording.status', payload: status })
        })
        await Promise.resolve()
      })
    }
    const goLive = (sessionId: string): RecordingStatus => ({
      state: 'recording',
      sessionId,
      startedAt: now,
      streamUrl: 'rtmp://127.0.0.1/live/***',
      message: 'Running both session.'
    })
    const stopsSent = (): number =>
      backend.sentCommands.filter((command) => command.method === 'session.stop').length
    const request = async (origin: SessionStopOrigin): Promise<boolean> => {
      let outcome = false
      await act(async () => {
        outcome = await latest().core.requestStopSession(origin)
      })
      return outcome
    }

    await pushStatus(goLive('go-live-1'))
    await waitForObservation(() => latest().recording.recording.sessionId === 'go-live-1')

    // Every in-app origin asks first, naming the session and its audience.
    for (const origin of ['button', 'space', 'palette', 'failure-banner'] as const) {
      expect(await request(origin)).toBe(false)
      await waitForObservation(() => shell?.stopConfirmation?.origin === origin)
      expect(stopsSent()).toBe(0)
    }
    expect(shell?.stopConfirmation).toMatchObject({
      sessionId: 'go-live-1',
      platforms: ['Twitch'],
      alsoRecords: true
    })
    // Keep streaming: nothing is sent, the question goes away.
    await act(async () => shell!.cancelStopSession())
    await waitForObservation(() => shell?.stopConfirmation === null)
    expect(stopsSent()).toBe(0)

    // A global hotkey arms with one plain keyed toast; an expired arm starts
    // over; a second press within the window ends the livestream.
    expect(await request('global-hotkey')).toBe(false)
    expect(toastSpies.message).toHaveBeenCalledExactlyOnceWith(
      'Press again to end the livestream',
      expect.objectContaining({ id: 'end-livestream-armed', duration: 2000 })
    )
    expect(shell?.stopConfirmation).toBeNull()
    expect(stopsSent()).toBe(0)
    vi.setSystemTime(new Date(Date.parse(now) + 2001))
    expect(await request('global-hotkey')).toBe(false)
    expect(toastSpies.message).toHaveBeenCalledTimes(2)
    expect(stopsSent()).toBe(0)
    vi.setSystemTime(new Date(Date.parse(now) + 3000))
    expect(await request('global-hotkey')).toBe(true)
    expect(stopsSent()).toBe(1)
    expect(toastSpies.dismiss).toHaveBeenCalledWith('end-livestream-armed')
    await waitForObservation(() => latest().recording.recording.state === 'idle')

    // Stream Deck and phone intents are deliberate: they stop at once.
    await pushStatus(goLive('go-live-2'))
    await waitForObservation(() => latest().recording.recording.sessionId === 'go-live-2')
    expect(await request('remote-control')).toBe(true)
    expect(stopsSent()).toBe(2)
    expect(shell?.stopConfirmation).toBeNull()
    await waitForObservation(() => latest().recording.recording.state === 'idle')

    // The confirm button is the stop.
    await pushStatus(goLive('go-live-3'))
    await waitForObservation(() => latest().recording.recording.sessionId === 'go-live-3')
    expect(await request('palette')).toBe(false)
    await waitForObservation(() => shell?.stopConfirmation?.sessionId === 'go-live-3')
    await act(async () => shell!.confirmStopSession())
    await waitForObservation(() => stopsSent() === 3)
    await waitForObservation(() => shell?.stopConfirmation === null)
    await waitForObservation(() => latest().recording.recording.state === 'idle')

    // A recording that is not live never asks.
    await pushStatus({
      state: 'recording',
      sessionId: 'rec-1',
      startedAt: now,
      message: 'Recording.'
    })
    await waitForObservation(() => latest().recording.recording.sessionId === 'rec-1')
    expect(await request('button')).toBe(true)
    expect(stopsSent()).toBe(4)
    expect(shell?.stopConfirmation).toBeNull()
    expect(toastSpies.message).toHaveBeenCalledTimes(2)
  })

  // Plan 174 S3.1 (the Phase 0 review): a remote's stop goes through the one
  // stop door, where a Stream Deck intent is a deliberate device action that
  // stops at once; whatever ends the session clears an armed hotkey press;
  // and recordStart records, whatever mode the Studio saved last (B-3).
  it('routes remote intents through the stop door and the explicit starts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
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
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        recordEnabled: true,
        streamEnabled: true,
        streaming: {
          ...defaultCaptureConfig.streaming,
          enabled: true,
          enabledTargetIds: ['twitch'],
          targets: defaultCaptureConfig.streaming.targets.map((target) =>
            target.id === 'twitch' ? { ...target, enabled: true, authMode: 'manual-rtmp' } : target
          )
        }
      } satisfies CaptureConfig)
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation => observations.at(-1)!
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    vi.clearAllMocks()

    const pushEvent = async (event: string, payload: unknown): Promise<void> => {
      await act(async () => {
        backend.sockets[0]?.onmessage?.({ data: JSON.stringify({ event, payload }) })
        await Promise.resolve()
      })
    }
    const goLive = (sessionId: string): RecordingStatus => ({
      state: 'recording',
      sessionId,
      startedAt: now,
      streamUrl: 'rtmp://127.0.0.1/live/***',
      message: 'Running both session.'
    })
    const acks = (): Array<{ intentId?: string; ok?: boolean; message?: string }> =>
      backend.sentCommands
        .filter((command) => command.method === 'remote.intent.ack')
        .map((command) => command.params as { intentId?: string; ok?: boolean; message?: string })
    const stopsSent = (): number =>
      backend.sentCommands.filter((command) => command.method === 'session.stop').length

    // A global hotkey arms; the remote's stop then stops at once and clears it.
    await pushEvent('recording.status', goLive('go-live-1'))
    await waitForObservation(() => latest().recording.recording.sessionId === 'go-live-1')
    await act(async () => {
      expect(await latest().core.requestStopSession('global-hotkey')).toBe(false)
    })
    expect(toastSpies.message).toHaveBeenCalledTimes(1)
    await pushEvent('remote.intent', { intentId: 'stop-1', intent: { kind: 'recordStop' } })
    await waitForObservation(() => acks().some((ack) => ack.intentId === 'stop-1'))
    expect(acks().find((ack) => ack.intentId === 'stop-1')).toEqual({
      intentId: 'stop-1',
      ok: true
    })
    expect(stopsSent()).toBe(1)
    expect(toastSpies.dismiss).toHaveBeenCalledWith('end-livestream-armed')
    await waitForObservation(() => latest().recording.recording.state === 'idle')

    // The backend ending the session clears the arm too: the next press on a
    // later livestream arms again instead of ending it.
    await pushEvent('recording.status', goLive('go-live-2'))
    await waitForObservation(() => latest().recording.recording.sessionId === 'go-live-2')
    vi.clearAllMocks()
    await act(async () => {
      expect(await latest().core.requestStopSession('global-hotkey')).toBe(false)
    })
    expect(toastSpies.message).toHaveBeenCalledTimes(1)
    await pushEvent('recording.status', {
      state: 'idle',
      sessionId: 'go-live-2',
      message: 'Ended.'
    })
    await waitForObservation(() => latest().recording.recording.state === 'idle')
    expect(toastSpies.dismiss).toHaveBeenCalledWith('end-livestream-armed')
    await pushEvent('recording.status', goLive('go-live-3'))
    await waitForObservation(() => latest().recording.recording.sessionId === 'go-live-3')
    vi.clearAllMocks()
    await act(async () => {
      expect(await latest().core.requestStopSession('global-hotkey')).toBe(false)
    })
    expect(stopsSent()).toBe(1)
    expect(toastSpies.message).toHaveBeenCalledTimes(1)
    await pushEvent('recording.status', {
      state: 'idle',
      sessionId: 'go-live-3',
      message: 'Ended.'
    })
    await waitForObservation(() => latest().recording.recording.state === 'idle')

    // recordStart records, even though the saved mode is Go Live (B-3): the
    // dialog never opens, the file is written, the saved mode is untouched,
    // and remotes see a Record take, not the saved Go Live.
    await pushEvent('backend.ready', null)
    await pushEvent('remote.intent', { intentId: 'rec-1', intent: { kind: 'recordStart' } })
    await waitForObservation(() => acks().some((ack) => ack.intentId === 'rec-1'))
    expect(acks().find((ack) => ack.intentId === 'rec-1')).toEqual({ intentId: 'rec-1', ok: true })
    const start = backend.sentCommands.find((command) => command.method === 'session.start')
    expect(start?.params).toMatchObject({ output: { recordEnabled: true, streamEnabled: false } })
    expect(latest().core.goLiveConfirmationOpen).toBe(false)
    expect(latest().core.captureConfig.streamEnabled).toBe(true)
    await waitForObservation(() => latest().recording.recording.state === 'recording')
    type PublishedOutputs = {
      state?: { sessionActive?: boolean; recordEnabled?: boolean; streamEnabled?: boolean }
    }
    const publishedDuringSession = (): PublishedOutputs['state'][] =>
      backend.sentCommands
        .filter((command) => command.method === 'remote.surface.publish')
        .map((command) => (command.params as PublishedOutputs).state)
        .filter((state) => state?.sessionActive === true)
    await waitForObservation(() => publishedDuringSession().length > 0)
    for (const state of publishedDuringSession()) {
      expect(state).toMatchObject({ recordEnabled: true, streamEnabled: false })
    }
    // The take's end is missed and a Go Live started elsewhere replaces it:
    // remotes read the new session, not the old Record intent.
    await pushEvent('recording.status', goLive('go-live-elsewhere'))
    await waitForObservation(() =>
      publishedDuringSession().some((state) => state?.streamEnabled === true)
    )
    expect(publishedDuringSession().at(-1)).toMatchObject({
      recordEnabled: true,
      streamEnabled: true
    })
    await act(async () => {
      await latest().core.stopSession()
    })
    await waitForObservation(() => latest().recording.recording.state === 'idle')

    // A Go Live started elsewhere wins while this Record start is in flight,
    // and the start fails: remotes read the Go Live, not the lost Record.
    const startsSent = (): number =>
      backend.sentCommands.filter((command) => command.method === 'session.start').length
    const startsBefore = startsSent()
    const releaseFailedStart = backend.deferFailure(
      'session.start',
      new Error('A capture session is already running.')
    )
    await pushEvent('remote.intent', { intentId: 'rec-2', intent: { kind: 'recordStart' } })
    await waitForObservation(() => startsSent() > startsBefore)
    await pushEvent('recording.status', goLive('go-live-winner'))
    await act(async () => {
      releaseFailedStart()
      await Promise.resolve()
    })
    await waitForObservation(() => acks().some((ack) => ack.intentId === 'rec-2'))
    expect(acks().find((ack) => ack.intentId === 'rec-2')?.ok).toBe(false)
    await waitForObservation(() => latest().recording.recording.sessionId === 'go-live-winner')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(publishedDuringSession().at(-1)).toMatchObject({
      recordEnabled: true,
      streamEnabled: true
    })
  })

  // The remote envelope is `{intentId, intent: {kind}}`: a deck or phone press
  // is a real click for the record-latency clock, not a session-call. (The
  // handler once read `payload.kind`, so no remote press was ever noted.)
  it('notes remote record, stop and toggle presses as clicks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
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
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        recordEnabled: true,
        streamEnabled: false
      } satisfies CaptureConfig)
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation => observations.at(-1)!
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    vi.clearAllMocks()

    const pushEvent = async (event: string, payload: unknown): Promise<void> => {
      await act(async () => {
        backend.sockets[0]?.onmessage?.({ data: JSON.stringify({ event, payload }) })
        await Promise.resolve()
      })
    }
    const acked = (intentId: string): boolean =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === intentId
      )
    const session = (sessionId: string, state: 'recording' | 'idle'): RecordingStatus => ({
      state,
      sessionId,
      ...(state === 'recording' ? { startedAt: now } : {}),
      message: state === 'recording' ? 'Recording.' : 'Ended.'
    })

    // recordStart: the start sample is closed by the status that completes it.
    await pushEvent('backend.ready', null)
    await pushEvent('remote.intent', { intentId: 'lat-start', intent: { kind: 'recordStart' } })
    await waitForObservation(() => acked('lat-start'))
    await pushEvent('recording.status', session('lat-1', 'recording'))
    await waitForObservation(() => latest().diagnostics.recordLatency.start !== null)
    expect(latest().diagnostics.recordLatency.start?.origin).toBe('click')

    // recordStop.
    await pushEvent('remote.intent', { intentId: 'lat-stop', intent: { kind: 'recordStop' } })
    await waitForObservation(() => acked('lat-stop'))
    await pushEvent('recording.status', session('lat-1', 'idle'))
    await waitForObservation(() => latest().diagnostics.recordLatency.stop !== null)
    expect(latest().diagnostics.recordLatency.stop?.origin).toBe('click')

    // recordToggle on a running session stops it, and counts as a stop press.
    const firstStop = latest().diagnostics.recordLatency.stop
    await pushEvent('recording.status', session('lat-2', 'recording'))
    await waitForObservation(() => latest().recording.recording.sessionId === 'lat-2')
    await pushEvent('remote.intent', { intentId: 'lat-toggle', intent: { kind: 'recordToggle' } })
    await waitForObservation(() => acked('lat-toggle'))
    await pushEvent('recording.status', session('lat-2', 'idle'))
    await waitForObservation(() => latest().diagnostics.recordLatency.stop !== firstStop)
    expect(latest().diagnostics.recordLatency.stop?.origin).toBe('click')
  })

  it.each([false, true])(
    'allows stopping cloud outputs without a local session (live=%s)',
    async (live) => {
      const backend = new StudioBackend()
      backend.cloudStatus = {
        ...resumableCloudStatus(),
        phase: 'live',
        plan: 'premium',
        show: { id: 'sh_test', nodeId: 'local-1', resumable: false, kind: 'talk' },
        room: {
          phase: 'open',
          doorOpen: false,
          declinedCount: 0,
          stage: { layout: 'solo', onStage: ['host:sh_test'] },
          hostAway: false,
          connected: true,
          client: 'connected',
          returnEnabled: false,
          stageSet: true,
          live
        },
        recording: { active: true, seconds: 0, bytes: 0 }
      }
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
      const latest = (): StudioObservation => observations.at(-1)!
      root = await mountStudioProvider(testDom.container, (value) => {
        observations.push(value)
      })
      await waitForObservation(() => latest()?.cloud.cloudStatus?.room?.phase === 'open')
      expect(backend.recordingState).toBe('idle')
      expect(latest().recording.recording.state).toBe(live ? 'streaming' : 'recording')
      expect(latest().core.canStop).toBe(true)
    }
  )

  // Live test 3 (owner, 2026-11-20): "I cannot switch asset background while
  // in a room". The room holds the camera, so the backend answers a native
  // layout transaction with the camera's 15 s readiness failure; the working
  // background never changed, and the room camera is keyed onto it. In a room
  // the change commits idle, on air or not, and with no room it stays a
  // native transaction.
  it.each([false, true])(
    'switches the background while a room holds the camera (live=%s)',
    async (live) => {
      const backend = new StudioBackend()
      backend.cloudStatus = {
        ...resumableCloudStatus(),
        phase: 'live',
        plan: 'premium',
        show: { id: 'sh_test', nodeId: 'local-1', resumable: false, kind: 'talk' },
        room: {
          phase: 'open',
          doorOpen: false,
          declinedCount: 0,
          stage: { layout: 'solo', onStage: ['host:sh_test'] },
          hostAway: false,
          connected: true,
          client: 'connected',
          returnEnabled: false,
          stageSet: true,
          live
        },
        recording: { active: true, seconds: 0, bytes: 0 }
      }
      TestWebSocket.backend = backend
      vi.stubGlobal('WebSocket', TestWebSocket)
      const api = createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      })
      api.backgroundAssetExists = async () => true
      const testDom = installProviderTestEnvironment(api)
      restoreEnvironment = testDom.restore
      const observations: StudioObservation[] = []
      const latest = (): StudioObservation => observations.at(-1)!
      root = await mountStudioProvider(testDom.container, (value) => {
        observations.push(value)
      })
      await waitForObservation(
        () => latest()?.cloud.cloudStatus?.room?.phase === 'open' && canSaveScene()
      )
      // The real backend in a room: the lent camera never becomes ready.
      backend.layoutApplyFailure = 'camera-not-ready'
      const layoutApplies = (): number =>
        backend.commands.filter((command) => command.method.startsWith('scene.layout.apply_'))
          .length
      const appliesBefore = layoutApplies()
      const loadedBackground = (assetId: string | null): boolean =>
        backend.commands.some(
          (command) =>
            command.method === 'scene.load_from_capture_config' &&
            ((command.params as { background?: { assetId: string } }).background?.assetId ??
              null) === assetId
        )

      await act(async () => latest().core.applyBackgroundSlot('bg-01'))
      await waitForObservation(() => latest().core.scene?.background?.assetId === 'builtin-bg-01')
      expect(loadedBackground('builtin-bg-01')).toBe(true)

      // A second pick while still in the room, then none.
      await act(async () => latest().core.applyBackgroundSlot('bg-02'))
      await waitForObservation(() => latest().core.scene?.background?.assetId === 'builtin-bg-02')
      await act(async () => latest().core.applyBackgroundSlot(null))
      await waitForObservation(() => latest().core.scene?.background == null)

      expect(layoutApplies()).toBe(appliesBefore)
      // No "Couldn't switch the scene" (the room's own join toast is not ours).
      expect(toastSpies.error.mock.calls.filter(([title]) => /scene/i.test(String(title)))).toEqual(
        []
      )

      // The room closed: the camera is back, and a pick is a native transaction again.
      backend.layoutApplyFailure = null
      backend.cloudStatus = { ...backend.cloudStatus!, room: undefined, recording: undefined }
      await act(async () => {
        backend.pushEvent('cloud.state', backend.cloudStatus)
      })
      await waitForObservation(() => latest().cloud.cloudStatus?.room === undefined)
      await act(async () => latest().core.applyBackgroundSlot('bg-01'))
      await waitForObservation(() => latest().core.scene?.background?.assetId === 'builtin-bg-01')
      expect(layoutApplies()).toBe(appliesBefore + 1)
    },
    30000
  )

  // 0.28.1 (owner, 11-16): the host never got into the room, and End
  // livestream sent nothing to the cloud; only videorc.com/live ended the
  // show. The stop must reach the cloud whatever the room connection did.
  it('ends a live talk show through cloud.show.legs.end from End livestream', async () => {
    const backend = new StudioBackend()
    backend.cloudStatus = {
      ...resumableCloudStatus(),
      phase: 'live',
      plan: 'premium',
      show: { id: 'sh_test', nodeId: 'local-1', resumable: false, kind: 'talk' },
      room: {
        phase: 'open',
        doorOpen: false,
        declinedCount: 0,
        stage: { layout: 'solo', onStage: ['host:sh_test'] },
        hostAway: true,
        connected: true,
        client: 'disconnected',
        returnEnabled: false,
        stageSet: true,
        live: true
      },
      recording: { active: true, seconds: 0, bytes: 0 }
    }
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
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify(youtubeOauthStreamCaptureConfig())
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation => observations.at(-1)!
    let shell: ReturnType<typeof useStudioShell> | undefined
    function ShellProbe(): null {
      const value = useStudioShell()
      useEffect(() => {
        shell = value
      }, [value])
      return null
    }
    root = await mountStudioProvider(
      testDom.container,
      (value) => {
        observations.push(value)
      },
      createElement(ShellProbe)
    )
    await waitForObservation(() => latest()?.cloud.cloudStatus?.room?.live === true)
    expect(latest().recording.recording.state).toBe('streaming')

    // The End livestream button asks first, then the confirm is the stop.
    let asked = true
    await act(async () => {
      asked = await latest().core.requestStopSession('button')
    })
    expect(asked).toBe(false)
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'button')
    await act(async () => shell!.confirmStopSession())
    await waitForObservation(() =>
      backend.commands.some((command) => command.method === 'cloud.show.legs.end')
    )
    await waitForObservation(() => latest().cloud.cloudStatus?.room?.live === false)
    // End livestream keeps the room and the cloud recording (D17).
    expect(backend.commands.map((command) => command.method)).not.toContain('cloud.room.close')
    await waitForObservation(() => latest().recording.recording.state === 'recording')

    // Stop recording reaches the cloud too, with the host still out of the room.
    await waitForObservation(() => latest().cloud.talkShow.hostIdentity !== null)
    await act(async () => {
      await latest().cloud.talkShow.stopCloudRecording()
    })
    expect(backend.commands.map((command) => command.method)).toContain('cloud.recording.stop')
    await waitForObservation(() => latest().cloud.cloudStatus?.recording?.active === false)
  })

  // Plan 184 C5b: the Resume notice feeds the live cloud show again and sets
  // nothing up on a platform. The runner holds the legs (the live YouTube
  // broadcast among them), so Resume never opens the Go Live dialog, never
  // runs the preflight or the metadata update, and never prepares a broadcast;
  // the start goes to `cloud.show.resume` with the saved destinations as rows,
  // a YouTube sign-in without a key included.
  it('resumes the cloud show through cloud.show.resume with no platform setup', async () => {
    const backend = new StudioBackend()
    backend.cloudStatus = resumableCloudStatus()
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
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify(youtubeOauthStreamCaptureConfig())
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation => observations.at(-1)!
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    await waitForObservation(() => latest().cloud.cloudStatus?.show?.resumable === true)
    backend.commands.length = 0
    vi.clearAllMocks()

    let resumed!: Promise<boolean>
    await act(async () => {
      resumed = latest().cloud.resumeCloudShow()
    })
    await waitForObservation(() =>
      backend.commands.some((command) => command.method === 'cloud.show.resume')
    )
    expect(await resumed).toBe(true)
    const methods = backend.commands.map((command) => command.method)
    expect(methods).not.toContain('session.start')
    expect(methods).not.toContain('streamTargets.youtube.prepare')
    expect(methods).not.toContain('streamTargets.confirmation.validate')
    expect(methods).not.toContain('streamTargets.metadata.update')
    expect(methods).not.toContain('platformAccounts.validate')
    expect(methods).not.toContain('streamTargets.youtube.transition')
    expect(latest().core.goLiveConfirmationOpen).toBe(false)
    const resume = backend.commands.find((command) => command.method === 'cloud.show.resume')
    expect(resume?.params).toMatchObject({
      output: { streamEnabled: true },
      streaming: {
        enabled: true,
        targets: expect.arrayContaining([
          expect.objectContaining({ id: 'youtube', authMode: 'oauth', enabled: true })
        ])
      }
    })
    await waitForObservation(
      () => latest().recording.recording.sessionId === 'cloud-resume-session'
    )
    expect(latest().recording.recording.state).toBe('recording')
    expect(toastSpies.error).not.toHaveBeenCalled()
  })

  // Plan 174 S3.1 (D2): main holds a quit or a main-window close while on air
  // and asks the renderer. Not live, the exit goes through at once; live, the
  // End livestream question names the exit, "Keep streaming" leaves the app as
  // it was, and the yes ends the livestream and then lets the app go.
  it('asks before a quit or a window close ends a livestream, then lets the app go', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emit: (name: string, value: unknown) => void = () => {}
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (next) => {
        emit = next
      }
    })
    const exitApp = vi.fn(async (_kind: 'quit' | 'close') => undefined)
    ;(api as unknown as { exitApp: typeof exitApp }).exitApp = exitApp
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        recordEnabled: true,
        streamEnabled: true,
        streaming: {
          ...defaultCaptureConfig.streaming,
          enabled: true,
          enabledTargetIds: ['twitch'],
          targets: defaultCaptureConfig.streaming.targets.map((target) =>
            target.id === 'twitch' ? { ...target, enabled: true, authMode: 'manual-rtmp' } : target
          )
        }
      } satisfies CaptureConfig)
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation => observations.at(-1)!
    let shell: ReturnType<typeof useStudioShell> | undefined
    function ShellProbe(): null {
      const value = useStudioShell()
      useEffect(() => {
        shell = value
      }, [value])
      return null
    }
    root = await mountStudioProvider(
      testDom.container,
      (value) => {
        observations.push(value)
      },
      createElement(ShellProbe)
    )
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    const pushStatus = async (status: RecordingStatus): Promise<void> => {
      await act(async () => {
        backend.sockets[0]?.onmessage?.({
          data: JSON.stringify({ event: 'recording.status', payload: status })
        })
        await Promise.resolve()
      })
    }
    const stopsSent = (): number =>
      backend.sentCommands.filter((command) => command.method === 'session.stop').length

    // Not live: nothing to protect, main may go.
    await act(async () => emit('onExitRequest', 'quit'))
    expect(exitApp).toHaveBeenCalledExactlyOnceWith('quit')
    expect(shell?.stopConfirmation).toBeNull()

    // Live: the question, titled for the exit. Keep streaming changes nothing.
    await pushStatus({
      state: 'recording',
      sessionId: 'go-live-1',
      startedAt: now,
      streamUrl: 'rtmp://127.0.0.1/live/***',
      message: 'Running both session.'
    })
    await waitForObservation(() => latest().recording.recording.sessionId === 'go-live-1')
    exitApp.mockClear()
    await act(async () => emit('onExitRequest', 'quit'))
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'quit')
    expect(exitApp).not.toHaveBeenCalled()
    expect(stopsSent()).toBe(0)
    await act(async () => shell!.cancelStopSession())
    await waitForObservation(() => shell?.stopConfirmation === null)
    expect(exitApp).not.toHaveBeenCalled()
    expect(latest().recording.recording.sessionId).toBe('go-live-1')

    // A window close asks the same way; yes ends the livestream, then the window goes.
    await act(async () => emit('onExitRequest', 'close'))
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'close-window')
    expect(exitApp).not.toHaveBeenCalled()
    await act(async () => shell!.confirmStopSession())
    await waitForObservation(() => stopsSent() === 1)
    await waitForObservation(() => exitApp.mock.calls.length === 1)
    expect(exitApp).toHaveBeenCalledExactlyOnceWith('close')
    await waitForObservation(() => latest().recording.recording.state === 'idle')
  })

  // Plan 243 D7: a take-over stops this computer's session and the show goes
  // on elsewhere, so the stop completes no YouTube broadcast and ends no X
  // broadcast (the autonomous terminal path), the next Go Live settles nothing
  // of the old show, and that Go Live's own stop completes as always.
  it('completes no broadcast when another device takes the show over (plan 243 D7)', async () => {
    const backend = new StudioBackend()
    enableYouTubeAndXOauthForTest(backend)
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
    const pushEvent = async (event: string, payload: unknown): Promise<void> => {
      await act(async () => {
        backend.pushEvent(event, payload)
        await Promise.resolve()
      })
    }
    const completions = (): string[] =>
      backend.sentCommands
        .filter(
          (command) =>
            command.method === 'streamTargets.youtube.transition' &&
            (command.params as { status?: string }).status === 'complete'
        )
        .map((command) => String((command.params as { broadcastId?: string }).broadcastId))
    const xEnds = (): number =>
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end').length
    const goLive = async (): Promise<void> => {
      await openYouTubeAndXGoLiveConfirmation(latest)
      await act(async () => {
        await latest()!.core.confirmGoLive()
      })
      await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    }

    await goLive()
    expect(backend.youtubePrepareCount).toBe(1)
    expect(backend.xPublishCount).toBe(1)
    await pushEvent('cloud.state', managedOnAirCloudStatus())
    // The status that names the take-over comes first, then the session stops.
    await pushEvent(
      'cloud.state',
      managedOnAirCloudStatus({
        phase: 'hold',
        onAir: {
          name: 'iPhone',
          kind: 'phone',
          source: 'camera',
          waiting: false,
          thisDevice: false,
          since: now
        },
        stoppedBy: 'taken-over'
      })
    )
    backend.recordingState = 'idle'
    await pushEvent('recording.status', {
      state: 'idle',
      sessionId: 'session-1',
      message: 'Saved.'
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
    // Plan 250: news behind the bell, in the streamer's own words for the
    // device (R2 B-M2: the name never meets the raw-provider-text guard).
    await waitForObservation(() => notification('cloud-taken-over') !== undefined)
    expect(notification('cloud-taken-over')).toMatchObject({
      tone: 'news',
      title: 'Your show continues on iPhone'
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(completions()).toEqual([])
    expect(xEnds()).toBe(0)

    // A later show of this computer is its own: its stop completes it. (The
    // fake reuses session ids; the new show's status puts this computer on
    // air, which ends the latch.)
    await pushEvent('cloud.state', { ...resumableCloudStatus(), phase: 'off', show: undefined })
    await goLive()
    await pushEvent(
      'cloud.state',
      managedOnAirCloudStatus({ show: { ...managedOnAirCloudStatus().show!, id: 'sh_next' } })
    )
    expect(backend.youtubePrepareCount).toBe(2)
    expect(completions()).toEqual([])
    backend.recordingState = 'idle'
    await pushEvent('recording.status', {
      state: 'idle',
      sessionId: 'session-1',
      message: 'Saved.'
    })
    await waitForObservation(() => completions().length === 1)
    expect(completions()).toEqual(['youtube-broadcast-2'])
    await waitForObservation(() => xEnds() === 1)
  }, 20_000)

  // Plan 243 C5 (D7): on a managed show this computer is on air for, the End
  // livestream question offers the hand-off. Quit and keep it live hands off
  // and then lets the app go; a refusal leaves the session fed, the app open,
  // and the broadcast's owner back, so a real End still completes it.
  it('hands the show off from the quit question and the End livestream question (plan 243)', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emit: (name: string, value: unknown) => void = () => {}
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (next) => {
        emit = next
      }
    })
    const exitApp = vi.fn(async (_kind: 'quit' | 'close') => undefined)
    ;(api as unknown as { exitApp: typeof exitApp }).exitApp = exitApp
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    let shell: ReturnType<typeof useStudioShell> | undefined
    function ShellProbe(): null {
      const value = useStudioShell()
      useEffect(() => {
        shell = value
      }, [value])
      return null
    }
    root = await mountStudioProvider(
      testDom.container,
      (value) => {
        observations.push(value)
      },
      createElement(ShellProbe)
    )
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    const pushEvent = async (event: string, payload: unknown): Promise<void> => {
      await act(async () => {
        backend.pushEvent(event, payload)
        await Promise.resolve()
      })
    }
    const sent = (method: string): number =>
      backend.sentCommands.filter((command) => command.method === method).length
    const completions = (): string[] =>
      backend.sentCommands
        .filter(
          (command) =>
            command.method === 'streamTargets.youtube.transition' &&
            (command.params as { status?: string }).status === 'complete'
        )
        .map((command) => String((command.params as { broadcastId?: string }).broadcastId))
    const goLive = async (): Promise<void> => {
      await openYouTubeGoLiveConfirmation(latest)
      await act(async () => {
        await latest()!.core.confirmGoLive()
      })
      await waitForObservation(() => latest()?.recording.recording.state === 'recording')
      // On air: the backend's status carries the (redacted) stream URL.
      await pushEvent('recording.status', {
        state: 'recording',
        sessionId: 'session-1',
        startedAt: now,
        streamUrl: 'rtmps://localhost:1936/live/***',
        message: 'Running both session.'
      })
      await waitForObservation(() => Boolean(latest()?.recording.recording.streamUrl))
      backend.cloudStatus = managedOnAirCloudStatus()
      await pushEvent('cloud.state', backend.cloudStatus)
      await waitForObservation(() => latest()?.cloud.cloudStatus?.onAir?.thisDevice === true)
    }

    // Quit and keep it live: the hand-off, then the app goes; no completion.
    await goLive()
    expect(offersHandOff(latest()!.cloud.cloudStatus)).toBe(true)
    await act(async () => emit('onExitRequest', 'quit'))
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'quit')
    expect(exitApp).not.toHaveBeenCalled()
    await act(async () => shell!.handOffStopSession())
    await waitForObservation(() => exitApp.mock.calls.length === 1)
    expect(exitApp).toHaveBeenCalledExactlyOnceWith('quit')
    expect(sent('cloud.show.handOff')).toBe(1)
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
    expect(shell?.stopConfirmation).toBeNull()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(sent('session.stop')).toBe(0)
    expect(completions()).toEqual([])

    // A refused hand-off: the session stays fed and the app stays.
    await pushEvent('cloud.state', { ...resumableCloudStatus(), phase: 'off', show: undefined })
    await goLive()
    backend.handOffRefusal = 'cloud-not-on-air'
    exitApp.mockClear()
    await act(async () => {
      await latest()!.core.requestStopSession('button')
    })
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'button')
    await act(async () => shell!.handOffStopSession())
    await waitForObservation(() => toastSpies.warning.mock.calls.length > 0)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      "Couldn't continue on another device",
      expect.objectContaining({ description: 'Your show is live from another device now.' })
    )
    expect(exitApp).not.toHaveBeenCalled()
    expect(latest()?.recording.recording.state).toBe('recording')

    // End livestream still completes the broadcast the refusal gave back.
    await act(async () => {
      await latest()!.core.requestStopSession('button')
    })
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'button')
    await act(async () => shell!.confirmStopSession())
    await waitForObservation(() => completions().length === 1)
    expect(completions()).toEqual(['youtube-broadcast-2'])
    expect(sent('session.stop')).toBe(1)
  }, 20_000)

  // Plan 243 R2 B-H1: after a hand-off the phone carries the show, and the
  // saved destinations a Continue here sends along are reconnect candidates,
  // never permission to complete. A refused resume completes no YouTube
  // broadcast, ends no X broadcast and ends no show; the retry continues,
  // and the continued session's own stop completes nothing either.
  it('completes nothing when Continue here is refused or the continued session stops (plan 243 R2 B-H1)', async () => {
    const backend = new StudioBackend()
    enableYouTubeAndXOauthForTest(backend)
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
    let shell: ReturnType<typeof useStudioShell> | undefined
    function ShellProbe(): null {
      const value = useStudioShell()
      useEffect(() => {
        shell = value
      }, [value])
      return null
    }
    root = await mountStudioProvider(
      testDom.container,
      (value) => {
        observations.push(value)
      },
      createElement(ShellProbe)
    )
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    const pushEvent = async (event: string, payload: unknown): Promise<void> => {
      await act(async () => {
        backend.pushEvent(event, payload)
        await Promise.resolve()
      })
    }
    const sent = (method: string): number =>
      backend.sentCommands.filter((command) => command.method === method).length
    const completions = (): number =>
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      ).length
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
    }

    await openYouTubeAndXGoLiveConfirmation(latest)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    await pushEvent('recording.status', {
      state: 'recording',
      sessionId: 'session-1',
      startedAt: now,
      streamUrl: 'rtmps://localhost:1936/live/***',
      message: 'Running both session.'
    })
    backend.cloudStatus = managedOnAirCloudStatus()
    await pushEvent('cloud.state', backend.cloudStatus)
    await waitForObservation(() => latest()?.cloud.cloudStatus?.onAir?.thisDevice === true)
    await act(async () => {
      await latest()!.core.requestStopSession('button')
    })
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'button')
    await act(async () => shell!.handOffStopSession())
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')

    // The phone continues the show; this computer shows Continue here.
    backend.cloudStatus = managedOnAirCloudStatus({
      phase: 'live',
      sessionId: undefined,
      show: { id: 'sh_managed', nodeId: 'livekit', resumable: true, kind: 'solo' },
      onAir: {
        name: 'iPhone',
        kind: 'phone',
        source: 'camera',
        waiting: false,
        thisDevice: false,
        since: now
      }
    })
    await pushEvent('cloud.state', backend.cloudStatus)
    await waitForObservation(() => latest()?.cloud.cloudStatus?.onAir?.thisDevice === false)
    await settle()
    expect(completions()).toBe(0)

    // Continue here is refused before any session exists.
    const release = backend.deferFailure(
      'cloud.show.resume',
      Object.assign(new Error('Videorc Cloud could not prepare this computer.'), {
        code: 'cloud-source-not-ready'
      })
    )
    let refused!: Promise<boolean>
    await act(async () => {
      refused = latest()!.cloud.resumeCloudShow()
      await Promise.resolve()
    })
    release()
    expect(await refused).toBe(false)
    await settle()
    expect(sent('cloud.show.resume')).toBe(1)
    expect(completions()).toBe(0)
    expect(sent('streamTargets.x.end')).toBe(0)
    expect(sent('cloud.show.end')).toBe(0)

    // The retry continues the show here; its stop completes nothing either.
    let continued!: Promise<boolean>
    await act(async () => {
      continued = latest()!.cloud.resumeCloudShow()
    })
    expect(await continued).toBe(true)
    await waitForObservation(
      () => latest()?.recording.recording.sessionId === 'cloud-resume-session'
    )
    await pushEvent('recording.status', {
      state: 'idle',
      sessionId: 'cloud-resume-session',
      message: 'Saved.'
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
    await settle()
    expect(completions()).toBe(0)
    expect(sent('streamTargets.x.end')).toBe(0)
    expect(sent('cloud.show.end')).toBe(0)
  }, 20_000)

  // Plan 243 R2 B-M1: a live talk show has no local session; its session is
  // the room's (as End livestream reads it). Quitting or closing the window
  // asks first, offers the hand-off, and leaves only after it succeeded; a
  // refusal keeps the app.
  it('asks before a quit or a window close ends a live talk show (plan 243 R2 B-M1)', async () => {
    const backend = new StudioBackend()
    const talk: CloudStatus = {
      ...resumableCloudStatus(),
      phase: 'live',
      plan: 'premium',
      show: { id: 'sh_talk', nodeId: 'livekit', resumable: false, kind: 'talk' },
      hold: undefined,
      room: {
        phase: 'open',
        doorOpen: false,
        declinedCount: 0,
        stage: { layout: 'solo', onStage: ['host:sh_talk'] },
        hostAway: false,
        connected: true,
        client: 'connected',
        returnEnabled: false,
        stageSet: true,
        live: true
      },
      onAir: { kind: 'computer', source: 'host', waiting: false, thisDevice: true, since: now }
    }
    backend.cloudStatus = talk
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emit: (name: string, value: unknown) => void = () => {}
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (next) => {
        emit = next
      }
    })
    const exitApp = vi.fn(async (_kind: 'quit' | 'close') => undefined)
    ;(api as unknown as { exitApp: typeof exitApp }).exitApp = exitApp
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation => observations.at(-1)!
    let shell: ReturnType<typeof useStudioShell> | undefined
    function ShellProbe(): null {
      const value = useStudioShell()
      useEffect(() => {
        shell = value
      }, [value])
      return null
    }
    root = await mountStudioProvider(
      testDom.container,
      (value) => {
        observations.push(value)
      },
      createElement(ShellProbe)
    )
    await waitForObservation(() => latest()?.cloud.cloudStatus?.room?.live === true)
    expect(latest().recording.recording.sessionId).toBe('sh_talk')
    const sent = (method: string): number =>
      backend.sentCommands.filter((command) => command.method === method).length

    // A window close asks; a refused hand-off keeps the app and the show.
    await act(async () => emit('onExitRequest', 'close'))
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'close-window')
    expect(exitApp).not.toHaveBeenCalled()
    expect(offersHandOff(latest().cloud.cloudStatus)).toBe(true)
    backend.handOffRefusal = 'cloud-not-on-air'
    await act(async () => shell!.handOffStopSession())
    await waitForObservation(() => toastSpies.warning.mock.calls.length > 0)
    expect(sent('cloud.show.handOff')).toBe(1)
    expect(exitApp).not.toHaveBeenCalled()
    expect(sent('cloud.show.legs.end')).toBe(0)

    // A quit asks too; Quit and keep it live leaves once the show is handed off.
    backend.handOffRefusal = null
    await act(async () => emit('onExitRequest', 'quit'))
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'quit')
    expect(exitApp).not.toHaveBeenCalled()
    await act(async () => shell!.handOffStopSession())
    await waitForObservation(() => exitApp.mock.calls.length === 1)
    expect(exitApp).toHaveBeenCalledExactlyOnceWith('quit')
    expect(sent('cloud.show.handOff')).toBe(2)
    expect(sent('cloud.show.legs.end')).toBe(0)
    expect(sent('cloud.room.close')).toBe(0)
  }, 20_000)

  // Plan 243 R2 A-M5: a hand-off that stopped this computer but could not
  // tell videorc.com is still a hand-off: Quit and keep it live quits, no
  // broadcast is completed, and one neutral toast says what viewers see.
  it('quits after an unconfirmed hand-off and completes nothing (plan 243 R2 A-M5)', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.handOffConfirmed = false
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emit: (name: string, value: unknown) => void = () => {}
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (next) => {
        emit = next
      }
    })
    const exitApp = vi.fn(async (_kind: 'quit' | 'close') => undefined)
    ;(api as unknown as { exitApp: typeof exitApp }).exitApp = exitApp
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    let shell: ReturnType<typeof useStudioShell> | undefined
    function ShellProbe(): null {
      const value = useStudioShell()
      useEffect(() => {
        shell = value
      }, [value])
      return null
    }
    root = await mountStudioProvider(
      testDom.container,
      (value) => {
        observations.push(value)
      },
      createElement(ShellProbe)
    )
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )
    await openYouTubeGoLiveConfirmation(latest)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    await act(async () => {
      backend.pushEvent('recording.status', {
        state: 'recording',
        sessionId: 'session-1',
        startedAt: now,
        streamUrl: 'rtmps://localhost:1936/live/***',
        message: 'Running both session.'
      })
      backend.cloudStatus = managedOnAirCloudStatus()
      backend.pushEvent('cloud.state', backend.cloudStatus)
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.cloud.cloudStatus?.onAir?.thisDevice === true)

    await act(async () => emit('onExitRequest', 'quit'))
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'quit')
    await act(async () => shell!.handOffStopSession())
    await waitForObservation(() => exitApp.mock.calls.length === 1)
    expect(exitApp).toHaveBeenCalledExactlyOnceWith('quit')
    expect(toastSpies.info).toHaveBeenCalledWith(
      "Videorc Cloud didn't confirm the hand-off. Viewers see Be right back until a device continues.",
      expect.objectContaining({ id: 'videorc-cloud' })
    )
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(toastSpies.warning).not.toHaveBeenCalled()
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      )
    ).toHaveLength(0)
  }, 20_000)

  // Plan 243 R2 A-M6: Go Live on a computer that holds a show another device
  // is on air for is refused by the backend. Go Live stays where it is and
  // surfaces the refusal in its own words; the backend's (which may name the
  // device) never reach the toast or a log.
  it('surfaces a Go Live refused for a show live elsewhere (plan 243 R2 A-M6)', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
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
    const warn = vi.spyOn(console, 'warn')
    await openYouTubeGoLiveConfirmation(latest)
    const release = backend.deferFailure(
      'session.start',
      Object.assign(new Error('Your show is live from Alice {work}. Continue here.'), {
        code: 'cloud-show-live-elsewhere'
      })
    )
    let started!: Promise<void>
    await act(async () => {
      started = latest()!.core.confirmGoLive()
      await Promise.resolve()
    })
    release()
    await act(async () => {
      await started
    })
    const copy = 'Your show is live on another device. Use Continue here, or end it first.'
    await waitForObservation(() => latest()?.core.lastError === copy)
    expect(toastSpies.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ description: copy })
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Alice')
    expect(latest()?.recording.recording.state).not.toBe('recording')
  }, 20_000)

  // Plan 243 D7: a talk show taken over (or handed off) goes on elsewhere, so
  // End livestream on this computer ends none of its legs, until Continue
  // here puts this computer back on air.
  it('ends no talk show legs once the show is taken over (plan 243 D7)', async () => {
    const backend = new StudioBackend()
    const talk: CloudStatus = {
      ...resumableCloudStatus(),
      phase: 'live',
      plan: 'premium',
      show: { id: 'sh_talk', nodeId: 'livekit', resumable: false, kind: 'talk' },
      room: {
        phase: 'open',
        doorOpen: false,
        declinedCount: 0,
        stage: { layout: 'solo', onStage: ['host:sh_talk'] },
        hostAway: false,
        connected: true,
        client: 'connected',
        returnEnabled: false,
        stageSet: true,
        live: true
      },
      onAir: { kind: 'computer', source: 'host', waiting: false, thisDevice: true, since: now }
    }
    backend.cloudStatus = talk
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
    const latest = (): StudioObservation => observations.at(-1)!
    let shell: ReturnType<typeof useStudioShell> | undefined
    function ShellProbe(): null {
      const value = useStudioShell()
      useEffect(() => {
        shell = value
      }, [value])
      return null
    }
    root = await mountStudioProvider(
      testDom.container,
      (value) => {
        observations.push(value)
      },
      createElement(ShellProbe)
    )
    await waitForObservation(() => latest()?.cloud.cloudStatus?.room?.live === true)
    await act(async () => {
      await latest().core.requestStopSession('button')
    })
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'button')
    expect(offersHandOff(latest().cloud.cloudStatus)).toBe(true)
    await act(async () => shell!.cancelStopSession())

    // Another device took the host seat; the room still reads live here.
    await act(async () => {
      backend.pushEvent('cloud.state', {
        ...talk,
        onAir: { ...talk.onAir!, name: 'iPad', kind: 'browser', thisDevice: false },
        stoppedBy: 'taken-over'
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest().cloud.cloudStatus?.stoppedBy === 'taken-over')
    await act(async () => {
      await latest().core.requestStopSession('button')
    })
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'button')
    expect(offersHandOff(latest().cloud.cloudStatus)).toBe(false)
    await act(async () => shell!.confirmStopSession())
    await waitForObservation(() => shell?.stopConfirmation === null)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const methods = backend.commands.map((command) => command.method)
    expect(methods).not.toContain('cloud.show.legs.end')
    expect(methods).not.toContain('streamTargets.youtube.transition')

    // Continue here (the room's resume) puts this computer back on air: End
    // livestream ends the legs again.
    await act(async () => {
      backend.pushEvent('cloud.state', talk)
      await Promise.resolve()
    })
    await waitForObservation(() => latest().cloud.cloudStatus?.onAir?.thisDevice === true)
    await act(async () => {
      await latest().core.requestStopSession('button')
    })
    await waitForObservation(() => shell?.stopConfirmation?.origin === 'button')
    await act(async () => shell!.confirmStopSession())
    await waitForObservation(() =>
      backend.commands.some((command) => command.method === 'cloud.show.legs.end')
    )
  }, 20_000)

  // Plan 243 D10: focus asks videorc.com for a show live from another
  // device, at most once per 10 s, and never while this computer is live.
  it('checks for a show live elsewhere when the window gains focus (plan 243 D10)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
    const backend = new StudioBackend()
    backend.cloudStatus = { ...resumableCloudStatus(), phase: 'off', show: undefined }
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
    const latest = (): StudioObservation => observations.at(-1)!
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.cloud.cloudStatus?.phase === 'off')
    const checks = (): number =>
      backend.sentCommands.filter((command) => command.method === 'cloud.show.check').length
    const focus = async (): Promise<void> => {
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })
    }
    await focus()
    await waitForObservation(() => checks() === 1)
    await focus()
    vi.setSystemTime(new Date(Date.parse(now) + 9_000))
    await focus()
    expect(checks()).toBe(1)
    vi.setSystemTime(new Date(Date.parse(now) + 10_000))
    await focus()
    await waitForObservation(() => checks() === 2)

    await act(async () => {
      backend.pushEvent('recording.status', {
        state: 'recording',
        sessionId: 'go-live-1',
        startedAt: now,
        streamUrl: 'rtmp://127.0.0.1/live/***',
        message: 'Running both session.'
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest().recording.recording.sessionId === 'go-live-1')
    vi.setSystemTime(new Date(Date.parse(now) + 30_000))
    await focus()
    expect(checks()).toBe(2)
  }, 20_000)

  it('returns a fully cloneable development scene-preset state with evaluated source diagnostics', async () => {
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => latest().applyBackgroundSlot('bg-01'))
    await waitForObservation(
      () => latest().scene?.background?.assetId === 'builtin-bg-01' && canSaveScene()
    )
    await act(async () => {
      expect(saveScene('Cloneable scene')).toBe(true)
    })

    const harness = smokeScenePresets()
    expect(harness).toBeDefined()
    const state = harness!.state()
    // Clone the actual complete projection, including saved and confirmed visuals.
    expect(structuredClone(state)).toEqual(state)
    expect(state).toMatchObject({
      canSave: true,
      scenes: latest().savedScenes,
      visual: { background: { assetId: 'builtin-bg-01' } },
      diagnostics: {
        sourceSelectionState: latest().sourceSelectionState,
        sourceSwitchReasons: { capture: null, camera: null, microphone: null },
        confirmedVisual: { background: { assetId: 'builtin-bg-01' } }
      }
    })
    // The save is the harness's own now (plan 231 S7): never on the core.
    expect(harness!.save).toEqual(expect.any(Function))
    expect(latest()).not.toHaveProperty('saveScene')
    expect(latest()).not.toHaveProperty('canSaveScene')
    expect(harness!.apply).toBe(latest().applySavedScene)
    expect(harness!.retrySourceStatus).toBe(latest().retrySourceStatus)
  })

  it('saves scenes from the current look, applies one atomic target and keeps a layout inside its scene', async () => {
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => latest().applyCameraPreset({ cameraZoom: 150, cameraOffsetX: 25 }))
    await waitForObservation(
      () =>
        latest().captureConfig.layout.cameraZoom === 150 && latest().layoutSwitchPending === null
    )
    await act(async () => {
      expect(saveScene('Presentation')).toBe(true)
    })
    const first = sceneNamed(latest(), 'Presentation')
    // Plan 231 D5: a scene made from the current look goes at the end, on stream.
    expect(latest().savedScenes.at(-1)!.id).toBe(first.id)
    expect(latest().activeSavedSceneId).toBe(first.id)
    await act(async () => {
      expect(saveScene('Closeup')).toBe(true)
    })
    const closeup = sceneNamed(latest(), 'Closeup')
    expect(latest().activeSavedSceneId).toBe(closeup.id)
    // Plan 231 D2: a layout is a choice inside the scene on stream. It never
    // leaves the scene, and each layout recalls its own camera framing.
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'camera-only' }))
    await waitForObservation(
      () =>
        latest().captureConfig.layout.layoutPreset === 'camera-only' &&
        latest().layoutSwitchPending === null &&
        sceneNamed(latest(), 'Closeup').visual.layout.layoutPreset === 'camera-only'
    )
    expect(latest().activeSavedSceneId).toBe(closeup.id)
    expect(latest().captureConfig.layout.cameraZoom).toBe(100)
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'screen-camera' }))
    await waitForObservation(
      () =>
        latest().captureConfig.layout.layoutPreset === 'screen-camera' &&
        latest().layoutSwitchPending === null
    )
    expect(latest().activeSavedSceneId).toBe(closeup.id)
    expect(latest().captureConfig.layout.cameraZoom).toBe(150)
    await act(async () => latest().applyCameraPreset({ cameraZoom: 175 }))
    await waitForObservation(
      () =>
        latest().captureConfig.layout.cameraZoom === 175 &&
        latest().layoutSwitchPending === null &&
        sceneNamed(latest(), 'Closeup').visual.layout.cameraZoom === 175
    )
    // Only the scene on stream took the edits.
    expect(sceneNamed(latest(), 'Presentation').visual.layout.cameraZoom).toBe(150)
    const start = backend.sentCommands.length
    await act(async () => {
      await latest().applySavedScene(first.id)
    })
    await waitForObservation(
      () => latest().activeSavedSceneId === first.id && latest().layoutSwitchPending === null
    )
    expect(latest().captureConfig.layout.cameraZoom).toBe(150)
    expect(
      backend.sentCommands
        .slice(start)
        .filter((command) => command.method.startsWith('scene.layout.apply'))
    ).toHaveLength(1)
    // A scene going on stream brings its own framing and leaves the layouts' memory.
    expect(latest().captureConfig.layoutFramingMemory.layouts['screen-camera'].cameraZoom).toBe(175)
    await act(async () => latest().applyCameraPreset({ cameraZoom: 160 }))
    // Plan 231 D11: an edit made while a scene is on stream saves into it.
    await waitForObservation(
      () =>
        latest().captureConfig.layout.cameraZoom === 160 &&
        latest().layoutSwitchPending === null &&
        sceneNamed(latest(), 'Presentation').visual.layout.cameraZoom === 160
    )
    expect(latest().savedSceneModified).toBe(false)
    expect(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.layout.cameraZoom).toBe(160)
    expect(storedSceneNamed('Presentation').layouts.horizontal.cameraZoom).toBe(160)
    expect(storedSceneNamed('Closeup').layouts.horizontal.cameraZoom).toBe(175)
    // The library is v2 only: the v1 key is never written (D15).
    expect(localStorage.getItem(SCENE_LIBRARY_KEY)).toBeNull()
    expect(storedLibrary().onStreamId).toBe(first.id)
    // Undo is one more commit while the scene is on: it keeps the undone look.
    await act(async () => {
      expect(await latest().undoLayoutPatch()).toBe(true)
    })
    await waitForObservation(
      () =>
        latest().captureConfig.layout.cameraZoom === 150 &&
        latest().layoutSwitchPending === null &&
        sceneNamed(latest(), 'Presentation').visual.layout.cameraZoom === 150
    )
    expect(latest().activeSavedSceneId).toBe(first.id)
    // Choosing the layout the scene already has changes nothing and leaves nothing.
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'screen-camera' }))
    await waitForObservation(() => latest().layoutSwitchPending === null)
    expect(latest().activeSavedSceneId).toBe(first.id)
    expect(latest().captureConfig.layout.cameraZoom).toBe(150)
  })

  // Plan 231 D11 on a scene made for an app: the Scene page's Freeform entry
  // (an arrangement and a placement, no preset) saves into the scene on stream
  // as it lands, with its app kept and still no audio. The same placement sent
  // with a layout preset is the same kind of edit (D2): it sets the scene's
  // layout and never leaves the scene.
  it('auto-saves a freeform placement into the app scene on stream and keeps its app and silence', async () => {
    const backend = new StudioBackend()
    backend.deviceList.devices.push({
      id: 'window:2',
      name: 'Presentation',
      kind: 'window',
      status: 'available'
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    // The mount's own scene load lands first, so the apply below is not
    // crossed by it (an app scene resolves its window before committing).
    await act(async () => latest().applyCameraPreset({ cameraZoom: 150 }))
    await waitForObservation(
      () =>
        latest().captureConfig.layout.cameraZoom === 150 && latest().layoutSwitchPending === null
    )
    // Add scene… (plan 231 D6): the app's scene in the look of the scene on stream.
    const onStreamBefore = latest().sceneOnStream!
    const libraryBefore = storedLibrary()
    const {
      scenes: [added],
      windowHints
    } = newScenes(
      [
        {
          kind: 'app',
          app: {
            bundleId: 'com.example.presentation',
            name: 'Presentation',
            windowCount: 1,
            frontWindowId: 'window:2',
            frontWindowTitle: 'Presentation'
          }
        }
      ],
      onStreamBefore,
      latest().savedScenes,
      {
        cameraOn: true,
        id: () => 'app-scene-presentation',
        now: () => '2026-10-29T10:00:00.000Z'
      }
    )
    const appScene = added!
    const appSource = { bundleId: 'com.example.presentation', name: 'Presentation', follows: true }
    expect(added!.audio).toBeUndefined()
    expect(added!.layouts.horizontal.arrangementMode).toBe('preset')
    const commandsBefore = backend.commands.length
    await act(async () => {
      expect(latest().sceneLibraryActions.add([added!], windowHints)).toBe(true)
    })
    // Plan 231 D5, D6: a new scene goes at the end, and what's on stream
    // stays: no scene is applied, no source switched, the same scene on stream.
    await waitForObservation(() => latest().savedScenes.at(-1)?.id === appScene.id)
    expect(latest().activeSavedSceneId).toBe(onStreamBefore.id)
    expect(storedLibrary().onStreamId).toBe(libraryBefore.onStreamId)
    expect(storedLibrary().scenes.map((scene) => scene.id)).toEqual([
      ...libraryBefore.scenes.map((scene) => scene.id),
      appScene.id
    ])
    expect(
      backend.commands
        .slice(commandsBefore)
        .filter(
          (command) =>
            command.method.startsWith('scene.') || command.method.startsWith('session.source')
        )
    ).toEqual([])
    expect(latest().captureConfig.sources.windowId).not.toBe('window:2')
    const appSceneNow = () => sceneNamed(latest(), 'Presentation')
    await act(async () => {
      expect(await latest().applySavedSceneResult(appScene.id)).toEqual({ ok: true })
    })
    await waitForObservation(
      () =>
        latest().activeSavedSceneId === appScene.id &&
        latest().layoutSwitchPending === null &&
        latest().captureConfig.sources.windowId === 'window:2'
    )
    // Putting the scene on stream is a switch, not an edit: nothing written.
    expect(appSceneNow().updatedAt).toBe('2026-10-29T10:00:00.000Z')

    const placement = { 'source:base': { x: 0.15, y: 0.15, width: 0.7, height: 0.7 } }
    await act(async () =>
      latest().applyCameraPreset({
        arrangementMode: 'freeform',
        sourceTransformOverrides: placement
      })
    )
    await waitForObservation(
      () =>
        latest().captureConfig.layout.arrangementMode === 'freeform' &&
        latest().layoutSwitchPending === null &&
        appSceneNow().visual.layout.arrangementMode === 'freeform'
    )
    const saved = appSceneNow()
    expect(latest().activeSavedSceneId).toBe(appScene.id)
    // The look is what the scene keeps now, with its own screen.
    expect(latest().savedSceneModified).toBe(false)
    expect(
      sameSceneVisual(saved.visual, {
        ...(smokeScenePresets()!.state().visual as typeof saved.visual),
        sources: saved.visual.sources
      })
    ).toBe(true)
    expect(saved.visual.layout.sourceTransformOverrides).toEqual(placement)
    expect(saved.visual.sources.app).toEqual(appSource)
    // The scene keeps the app, never one of its windows: the window on
    // stream is the working capture's.
    expect(saved.visual.sources.windowId).toBeUndefined()
    expect(storedSceneNamed('Presentation').shows).toEqual({ kind: 'app', ...appSource })
    expect(saved.audio).toBeUndefined()
    expect(saved.updatedAt).not.toBe('2026-10-29T10:00:00.000Z')
    expect(storedSceneNamed('Presentation').layouts.horizontal.sourceTransformOverrides).toEqual(
      placement
    )

    // The same placement with a layout preset sets the scene's layout: the
    // scene stays on stream and keeps the edit.
    const moved = { 'source:base': { x: 0.2, y: 0.2, width: 0.6, height: 0.6 } }
    await act(async () =>
      latest().applyCameraPreset({
        layoutPreset: 'screen-only',
        arrangementMode: 'freeform',
        sourceTransformOverrides: moved
      })
    )
    await waitForObservation(
      () =>
        latest().layoutSwitchPending === null &&
        appSceneNow().visual.layout.layoutPreset === 'screen-only'
    )
    expect(latest().activeSavedSceneId).toBe(appScene.id)
    expect(appSceneNow().visual.layout.sourceTransformOverrides).toEqual(moved)
    expect(appSceneNow().visual.sources.app).toEqual(appSource)
  })

  // Plan 210 D1: quitting and relaunching the app never breaks its scene. At
  // launch with the app gone, the scene stays on with no screen (never a whole
  // display under the app's name), Record says why in S2's words, and the
  // refresh that lists the app's next window applies it.
  it('holds an app scene at Screen None while its app is gone, and takes its next window', async () => {
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
    const app = { bundleId: 'com.example.presentation', name: 'Presentation' }
    // A plan 210 (v1) scene for the app, as New scene… made them.
    const appScene = {
      id: 'app-scene-presentation',
      name: 'Presentation',
      createdAt: '2026-10-29T10:00:00.000Z',
      updatedAt: '2026-10-29T10:00:00.000Z',
      visual: normalizeSceneVisual({
        layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' },
        sources: {
          windowId: 'window:2',
          windowName: 'Presentation',
          captureOff: false,
          testPattern: false,
          app: { ...app, follows: true }
        },
        background: null
      })
    }
    localStorage.setItem(SCENE_LIBRARY_KEY, JSON.stringify({ version: 1, scenes: [appScene] }))
    localStorage.setItem(
      WORKING_SCENE_KEY,
      JSON.stringify({ version: 1, origin: 'saved', sceneId: appScene.id, visual: appScene.visual })
    )
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        sources: { windowId: 'window:2', windowName: 'Presentation' }
      })
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () => canSaveScene() && observations.at(-1)?.core.captureConfig.sources.captureOff === true
    )
    expect(latest().activeSavedSceneId).toBe(appScene.id)
    expect(latest().captureConfig.sources.screenId).toBeUndefined()
    expect(latest().captureConfig.sources.windowId).toBeUndefined()
    expect(latest().savedSceneAppStates[appScene.id]).toBe('not-running')
    expect(latest().recordBlockedReason).toBe("Presentation isn't open")
    expect(latest().canStart).toBe(false)

    backend.deviceList = {
      ...backend.deviceList,
      devices: [
        ...backend.deviceList.devices,
        {
          id: 'window:2',
          name: 'Presentation',
          kind: 'window',
          status: 'available',
          width: 1280,
          height: 720,
          app: { ...app, pid: 7 }
        }
      ]
    }
    await act(async () => latest().refreshDevices())
    await waitForObservation(() => latest().captureConfig.sources.windowId === 'window:2')
    expect(latest().activeSavedSceneId).toBe(appScene.id)
    expect(latest().captureConfig.sources.captureOff).toBe(false)
    expect(latest().captureConfig.sources.screenId).toBeUndefined()
    expect(latest().savedSceneAppStates[appScene.id]).toBe('ready')
    expect(latest().recordBlockedReason).not.toBe("Presentation isn't open")
  })

  // Owner, 2026-10-27: a scene saved from the current look keeps its screen,
  // microphone and System audio, and choosing it brings its audio back, idle
  // and while recording. Plan 231 D2: a Screen pick changes the screen of the
  // scene on stream and never leaves it.
  it('saves the screen, microphone and System audio with a scene, and a Screen pick edits the scene on stream', async () => {
    const screen1 = 'screen:dxgi:0000000000000001:1'
    const screen2 = 'screen:dxgi:0000000000000001:2'
    const backend = new StudioBackend()
    backend.deviceList = {
      ...backend.deviceList,
      devices: [
        ...backend.deviceList.devices,
        {
          id: screen2,
          name: 'Display 2',
          kind: 'screen',
          status: 'available',
          width: 1920,
          height: 1080
        },
        { id: 'mic:2', name: 'Microphone 2', kind: 'microphone', status: 'available' }
      ]
    }
    backend.reportsActiveSceneRevision = true
    const respond = backend.response.bind(backend)
    backend.response = (command) => {
      const result = respond(command)
      if (command.method === 'scene.layout.apply_live') {
        // Like the real backend: a live scene commit moves the session's
        // source revision on, so a switch built before it is refused.
        backend.confirmedSourceRevision += 1
        queueMicrotask(() =>
          backend.sockets[0]?.onmessage?.({
            data: JSON.stringify({
              event: 'session.sources.changed',
              payload: backend.sourceSnapshot(backend.recordingSessionId ?? '')
            })
          })
        )
      }
      return result
    }
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        canSaveScene() &&
        latest().captureConfig.sources.screenId === screen1 &&
        latest().captureConfig.sources.microphoneId === 'mic:1'
    )
    await act(async () => {
      expect(saveScene('Desk')).toBe(true)
    })
    const desk = sceneNamed(latest(), 'Desk')
    expect(desk.visual.sources.screenId).toBe(screen1)
    expect(desk.audio).toStrictEqual({
      microphoneId: 'mic:1',
      microphoneName: 'Microphone 1',
      microphoneOff: false,
      systemAudioEnabled: false
    })
    expect(storedSceneNamed('Desk').audio).toMatchObject({
      microphoneId: 'mic:1',
      systemAudioEnabled: false
    })
    expect(storedSceneNamed('Desk').shows).toMatchObject({ kind: 'display', screenId: screen1 })
    const others = latest().savedScenes.filter((scene) => scene.id !== desk.id)

    const devices = latest().deviceList.devices
    const pickOthers = async (): Promise<void> => {
      await act(async () =>
        latest().switchSourceDeviceLive(
          'microphone',
          buildMicrophoneSources(
            latest().captureConfig.sources,
            devices.filter((device) => device.kind === 'microphone'),
            'mic:2'
          )
        )
      )
      await act(async () =>
        latest().setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, systemAudioEnabled: true }
        }))
      )
    }
    await act(async () =>
      latest().switchSourceDeviceLive(
        'capture',
        buildCaptureSources(
          latest().captureConfig.sources,
          devices.filter((device) => device.kind === 'screen'),
          screen2
        )
      )
    )
    await pickOthers()
    await waitForObservation(
      () =>
        latest().captureConfig.sources.screenId === screen2 &&
        latest().captureConfig.sources.microphoneId === 'mic:2' &&
        latest().captureConfig.audio.systemAudioEnabled
    )
    // Plan 231 D2: another screen is the scene's screen from now on. The
    // scene stays on stream, no other scene changes, and its audio is its own.
    expect(latest().activeSavedSceneId).toBe(desk.id)
    expect(sceneNamed(latest(), 'Desk').visual.sources.screenId).toBe(screen2)
    expect(storedSceneNamed('Desk').shows).toMatchObject({
      kind: 'display',
      screenId: screen2,
      screenName: 'Display 2'
    })
    expect(sceneNamed(latest(), 'Desk').audio).toStrictEqual(desk.audio)
    expect(latest().savedScenes.filter((scene) => scene.id !== desk.id)).toEqual(others)

    const idleFrom = backend.sentCommands.length
    await act(async () => {
      expect(await latest().applySavedScene(desk.id)).toBe(true)
    })
    await waitForObservation(
      () =>
        latest().layoutSwitchPending === null &&
        latest().captureConfig.sources.microphoneId === 'mic:1' &&
        !latest().captureConfig.audio.systemAudioEnabled
    )
    expect(latest().captureConfig.sources.screenId).toBe(screen2)
    expect(latest().savedSceneModified).toBe(false)
    const idleSent = backend.sentCommands.slice(idleFrom)
    expect(
      idleSent.find((command) => command.method.startsWith('scene.layout.apply'))?.params
    ).toMatchObject({ sources: { screenId: screen2, microphoneId: 'mic:1' } })
    expect(idleSent.some((command) => command.method === 'session.source.switch')).toBe(false)

    // While recording, the session switches to the scene's microphone.
    await act(async () => latest().startSession())
    await waitForObservation(
      () =>
        observations.at(-1)?.recording.recording.state === 'recording' &&
        latest().sourceSelectionState.snapshot !== null
    )
    await pickOthers()
    await waitForObservation(
      () =>
        backend.confirmedSources.microphoneId === 'mic:2' &&
        latest().captureConfig.sources.microphoneId === 'mic:2' &&
        latest().captureConfig.audio.systemAudioEnabled &&
        latest().sourceSelectionState.pending === null
    )
    const liveFrom = backend.sentCommands.length
    await act(async () => {
      expect(await latest().applySavedScene(desk.id)).toBe(true)
    })
    await waitForObservation(
      () =>
        backend.confirmedSources.microphoneId === 'mic:1' &&
        latest().captureConfig.sources.microphoneId === 'mic:1' &&
        latest().layoutSwitchPending === null
    )
    expect(latest().captureConfig.audio.systemAudioEnabled).toBe(false)
    const switches = backend.sentCommands
      .slice(liveFrom)
      .filter((command) => command.method === 'session.source.switch')
    expect(switches).toHaveLength(1)
    expect(switches[0].params).toMatchObject({ kind: 'microphone', deviceId: 'mic:1' })
    expect(latest().savedSceneModified).toBe(false)
  }, 15_000)

  it('refreshes only the device list from Sources, and keeps it when other reads would fail (C-32)', async () => {
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    backend.deviceList = {
      ...backend.deviceList,
      devices: [
        { id: 'camera:plugged', name: 'Plugged Camera', kind: 'camera', status: 'available' },
        ...backend.deviceList.devices
      ]
    }
    const sentBefore = backend.sentCommands.length
    await act(async () => latest().refreshDevices())
    const sent = backend.sentCommands.slice(sentBefore).map((command) => command.method)
    expect(sent).toEqual(['devices.list'])
    expect(latest().deviceList.devices.some((device) => device.id === 'camera:plugged')).toBe(true)
  })

  // Plan 0027: a scene click (any layout transaction) or a device refresh
  // must not turn a microphone set to None back on before the next take.
  it('keeps Microphone None through scene clicks, device refresh and a recording', async () => {
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await waitForObservation(() => latest().captureConfig.sources.microphoneId === 'mic:1')
    const microphones = latest().deviceList.devices.filter((device) => device.kind === 'microphone')
    await act(async () =>
      latest().switchSourceDeviceLive(
        'microphone',
        buildMicrophoneSources(latest().captureConfig.sources, microphones, undefined)
      )
    )
    await waitForObservation(() => latest().captureConfig.sources.microphoneOff === true)
    const scenesFrom = backend.sentCommands.length
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => latest().captureConfig.layout.layoutPreset === 'screen-only' && canSaveScene()
    )
    // The same scene again: still a layout transaction that reconciles sources.
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(() => canSaveScene())
    expect(latest().captureConfig.sources.microphoneId).toBeUndefined()
    expect(latest().captureConfig.sources.microphoneOff).toBe(true)
    for (const command of backend.sentCommands.slice(scenesFrom)) {
      if (!command.method.startsWith('scene.layout.apply_')) continue
      const sources = (command.params as { sources?: { microphoneId?: string } }).sources
      expect(sources?.microphoneId).toBeUndefined()
    }
    backend.deviceList.devices.unshift({
      id: 'mic:new',
      name: 'USB Microphone',
      kind: 'microphone',
      status: 'available'
    })
    await act(async () => latest().refreshBackend({ fresh: true }))
    expect(latest().captureConfig.sources.microphoneId).toBeUndefined()
    await act(async () => latest().startSession())
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')
    const start = backend.sentCommands.find((command) => command.method === 'session.start')
    expect(
      (start!.params as { sources?: { microphoneId?: string } }).sources?.microphoneId
    ).toBeUndefined()
    expect(backend.confirmedSources.microphoneId).toBeUndefined()
    await act(async () => {
      expect(await latest().stopSession()).toBe(true)
    })
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'idle')
    expect(latest().captureConfig.sources.microphoneOff).toBe(true)
    expect(latest().captureConfig.sources.microphoneId).toBeUndefined()
  }, 15_000)

  it('keeps the camera background on every commit after it is picked, and never in a scene (plan 258 S5)', async () => {
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    const cameras = latest().deviceList.devices.filter((device) => device.kind === 'camera')
    await act(async () =>
      latest().switchSourceDeviceLive(
        'camera',
        buildCameraSources(latest().captureConfig.sources, cameras, 'camera:1')
      )
    )
    await waitForObservation(
      () => latest().captureConfig.sources.cameraId === 'camera:1' && canSaveScene()
    )
    // The D4 migration settled on this profile (no keyed scene, nothing moved).
    await waitForObservation(() => latest().settings.cameraBackgroundMigration === 1)
    const layoutCommand = (from: number) =>
      backend.sentCommands
        .slice(from)
        .filter((command) => command.method.startsWith('scene.layout.apply'))
        .at(-1)?.params as { layout?: Record<string, unknown> } | undefined
    // The Studio's pick: stored for the camera and committed at once.
    let from = backend.sentCommands.length
    await act(async () => {
      expect(
        await latest().applyCameraBackground({ mode: 'blur', blurPct: 70, edges: 'balanced' })
      ).toBe(true)
    })
    expect(layoutCommand(from)?.layout).toMatchObject({
      cameraBackground: { mode: 'blur', blurPct: 70 },
      cameraChromaKeyEnabled: false
    })
    // An explicit pick settles D4 itself, so a migration still loading can't
    // replace it with a scene's key.
    expect(latest().settings.cameraBackgroundMigration).toBe(1)
    // A later edit is built from the scene's own layout, which never carries
    // the background; the commit still does (S3's smoke put it on the layout
    // and a commit like this one disarmed it).
    from = backend.sentCommands.length
    await act(async () => {
      await latest().applyLayoutPatch({ cameraSize: 'large' })
    })
    expect(layoutCommand(from)?.layout).toMatchObject({
      cameraSize: 'large',
      cameraBackground: { mode: 'blur', blurPct: 70 }
    })
    // Kept per camera in the settings, never in a scene or the capture config.
    await waitForObservation(
      () =>
        JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) ?? '{}').cameraBackgrounds?.[
          'camera:1'
        ]?.mode === 'blur'
    )
    expect(JSON.stringify(storedLibrary())).not.toContain('cameraBackground')
    expect(localStorage.getItem(STORAGE_KEYS.captureConfig)).not.toContain('cameraBackground')
    // Record carries it too.
    await act(async () => latest().startSession())
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')
    const sessionStart = backend.sentCommands.find((command) => command.method === 'session.start')
    expect(sessionStart?.params).toMatchObject({
      layout: { cameraBackground: { mode: 'blur', blurPct: 70 } }
    })
    await act(async () => {
      expect(await latest().stopSession()).toBe(true)
    })
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'idle')
  }, 15_000)

  it('never changes the camera when a scene goes on stream (plan 231 D9), and keeps Camera Off through device discovery and a finished session', async () => {
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => latest().captureConfig.layout.layoutPreset === 'screen-only' && canSaveScene()
    )
    const cameras = latest().deviceList.devices.filter((device) => device.kind === 'camera')
    await act(async () =>
      latest().switchSourceDeviceLive(
        'camera',
        buildCameraSources(latest().captureConfig.sources, cameras, undefined)
      )
    )
    await waitForObservation(
      () => latest().captureConfig.sources.cameraOff === true && canSaveScene()
    )
    await act(async () => {
      expect(saveScene('Camera Off')).toBe(true)
    })
    const saved = sceneNamed(latest(), 'Camera Off')
    await act(async () =>
      latest().switchSourceDeviceLive(
        'camera',
        buildCameraSources(latest().captureConfig.sources, cameras, 'camera:1')
      )
    )
    await waitForObservation(
      () => latest().captureConfig.sources.cameraId === 'camera:1' && canSaveScene()
    )
    await act(async () => {
      expect(saveScene('Camera On')).toBe(true)
    })
    const savedOn = sceneNamed(latest(), 'Camera On')
    // Plan 231 D9: a scene never changes the camera. The scene made while the
    // camera was off goes on stream with the camera Sources holds now.
    let start = backend.sentCommands.length
    await act(async () => {
      expect(await latest().applySavedScene(saved.id)).toBe(true)
    })
    expect(latest().activeSavedSceneId).toBe(saved.id)
    expect(latest().captureConfig.sources.cameraOff).not.toBe(true)
    expect(latest().captureConfig.sources.cameraId).toBe('camera:1')
    expect(
      backend.sentCommands
        .slice(start)
        .find((command) => command.method.startsWith('scene.layout.apply'))?.params
    ).toMatchObject({ sources: { cameraId: 'camera:1' } })
    // The library keeps no camera device.
    expect(JSON.stringify(storedLibrary())).not.toMatch(/cameraId|cameraName|camera:1/)
    // Camera Off in Sources is every scene's camera too.
    await act(async () =>
      latest().switchSourceDeviceLive(
        'camera',
        buildCameraSources(latest().captureConfig.sources, cameras, undefined)
      )
    )
    await waitForObservation(
      () => latest().captureConfig.sources.cameraOff === true && canSaveScene()
    )
    start = backend.sentCommands.length
    await act(async () => {
      expect(await latest().applySavedScene(savedOn.id)).toBe(true)
    })
    expect(latest().activeSavedSceneId).toBe(savedOn.id)
    expect(latest().captureConfig.sources.cameraOff).toBe(true)
    expect(latest().captureConfig.sources.cameraId).toBeUndefined()
    const layoutApply = backend.sentCommands
      .slice(start)
      .find((command) => command.method.startsWith('scene.layout.apply'))
    expect(layoutApply).toBeDefined()
    expect(
      (layoutApply!.params as { sources: { cameraId?: string } }).sources.cameraId
    ).toBeUndefined()
    expect(latest().savedSceneModified).toBe(false)
    await act(async () => latest().applyCameraPreset({ cameraZoom: 135 }))
    // Plan 231 D11: the edit saves into the scene on stream, Camera Off kept.
    await waitForObservation(
      () =>
        latest().captureConfig.layout.cameraZoom === 135 &&
        canSaveScene() &&
        sceneNamed(latest(), 'Camera On').visual.layout.cameraZoom === 135
    )
    expect(latest().captureConfig.sources.cameraOff).toBe(true)
    expect(latest().savedSceneModified).toBe(false)
    await act(async () => {
      expect(saveScene('Camera Off copy')).toBe(true)
    })
    const savedCopy = sceneNamed(latest(), 'Camera Off copy')
    expect(savedCopy.visual.sources.cameraOff).toBe(true)
    backend.deviceList.devices.unshift({
      id: 'camera:new',
      name: 'New Camera',
      kind: 'camera',
      status: 'available'
    })
    await act(async () => latest().refreshBackend({ fresh: true }))
    expect(latest().captureConfig.sources.cameraOff).toBe(true)
    expect(latest().captureConfig.sources.cameraId).toBeUndefined()
    await act(async () => latest().startSession())
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')
    expect(backend.confirmedSources.cameraId).toBeUndefined()
    expect(latest().captureConfig.sources.cameraOff).toBe(true)
    await act(async () => {
      expect(await latest().stopSession()).toBe(true)
    })
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'idle')
    await act(async () => latest().refreshBackend({ fresh: true }))
    expect(latest().captureConfig.sources.cameraOff).toBe(true)
    expect(latest().captureConfig.sources.cameraId).toBeUndefined()
    expect(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.sources.cameraOff).toBe(true)
    const staleOnConfig = {
      ...latest().captureConfig,
      sources: buildCameraSources(latest().captureConfig.sources, cameras, 'camera:1')
    }
    await act(async () => root!.unmount())
    root = null
    // The working checkpoint owns visual intent even if capture storage is older.
    localStorage.setItem(STORAGE_KEYS.captureConfig, JSON.stringify(staleOnConfig))
    observations.length = 0
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => latest().refreshBackend({ fresh: true }))
    expect(latest().activeSavedSceneId).toBe(savedCopy.id)
    expect(latest().captureConfig.sources.cameraOff).toBe(true)
    expect(latest().captureConfig.sources.cameraId).toBeUndefined()
    expect(latest().savedSceneModified).toBe(false)
  }, 15_000)

  it('persists acknowledged camera visibility through auto-save, Update, Save-as, apply and remount', async () => {
    const backend = new StudioBackend()
    backend.deviceList.devices.push({
      id: 'camera:1',
      name: 'Camera 1',
      kind: 'camera',
      status: 'available'
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () => canSaveScene() && latest().captureConfig.sources.cameraId === 'camera:1'
    )
    await act(async () => {
      expect(saveScene('Visible')).toBe(true)
    })
    const visible = sceneNamed(latest(), 'Visible')
    const byId = (id: string) => latest().savedScenes.find((scene) => scene.id === id)!
    const cameraId = latest().scene!.sources.find((source) => source.kind === 'camera')!.id
    await act(async () => latest().setSceneSourceVisible(cameraId, false))
    expect(latest().scene!.sources.find((source) => source.id === cameraId)!.visible).toBe(false)
    // Plan 231 D11: the scene on stream keeps the edit; there is no Modified.
    await waitForObservation(
      () => byId(visible.id).visual.layout.sourceVisibility?.camera === false
    )
    expect(latest().savedSceneModified).toBe(false)
    expect(latest().captureConfig.sources.cameraId).toBe('camera:1')
    expect(latest().captureConfig.sources.cameraOff).not.toBe(true)
    expect(canSaveScene()).toBe(true)
    await act(async () => {
      expect(saveScene('Hidden', visible.id)).toBe(true)
    })
    expect(latest().savedSceneModified).toBe(false)
    expect(byId(visible.id).name).toBe('Hidden')
    expect(byId(visible.id).visual.layout).toHaveProperty('sourceVisibility', {
      camera: false,
      capture: true
    })
    await act(async () => {
      expect(saveScene('Hidden copy')).toBe(true)
    })
    const hidden = byId(visible.id)
    await act(async () => latest().setSceneSourceVisible(cameraId, true))
    // The copy is on stream: it keeps the camera; Hidden doesn't change.
    await waitForObservation(
      () => sceneNamed(latest(), 'Hidden copy').visual.layout.sourceVisibility?.camera === true
    )
    expect(byId(visible.id).visual.layout.sourceVisibility?.camera).toBe(false)
    expect(latest().savedSceneModified).toBe(false)
    backend.layoutApplyFailure = 'definite'
    await act(async () => {
      expect(await latest().applySavedScene(hidden.id)).toBe(false)
    })
    expect(latest().scene!.sources.find((source) => source.kind === 'camera')!.visible).toBe(true)
    expect(latest().captureConfig.layout.sourceVisibility?.camera).toBe(true)
    expect(
      JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.layout.sourceVisibility.camera
    ).toBe(true)
    backend.layoutApplyFailure = null
    await act(async () => {
      expect(await latest().applySavedScene(hidden.id)).toBe(true)
    })
    expect(latest().scene!.sources.find((source) => source.kind === 'camera')!.visible).toBe(false)
    expect(latest().savedSceneModified).toBe(false)
    expect(latest().captureConfig.sources.cameraId).toBe('camera:1')
    expect(
      JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.layout.sourceVisibility.camera
    ).toBe(false)
    expect(
      backend.sentCommands.filter((command) => command.method === 'scene.source.visibility.update')
    ).toHaveLength(2)
    await act(async () => root!.unmount())
    root = null
    observations.length = 0
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    expect(latest().scene!.sources.find((source) => source.kind === 'camera')!.visible).toBe(false)
    expect(latest().savedSceneModified).toBe(false)
    expect(latest().captureConfig.sources.cameraId).toBe('camera:1')
    expect(latest().captureConfig.sources.cameraOff).not.toBe(true)
  })

  it('keeps hidden saved visibility atomic through live lost responses and failed apply rollback', async () => {
    const backend = new StudioBackend()
    backend.reportsActiveSceneRevision = true
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => {
      expect(saveScene('Visible')).toBe(true)
    })
    const visible = sceneNamed(latest(), 'Visible')
    // Plan 231 D11: a second scene goes on stream first, so hiding the camera
    // saves into it instead of into Visible.
    await act(async () => {
      expect(saveScene('Hidden')).toBe(true)
    })
    const cameraId = latest().scene!.sources.find((source) => source.kind === 'camera')!.id
    await act(async () => latest().setSceneSourceVisible(cameraId, false))
    await waitForObservation(
      () => sceneNamed(latest(), 'Hidden').visual.layout.sourceVisibility?.camera === false
    )
    expect(sceneNamed(latest(), 'Visible').visual.layout.sourceVisibility?.camera).not.toBe(false)
    const hidden = sceneNamed(latest(), 'Hidden')
    await act(async () => {
      expect(await latest().applySavedScene(visible.id)).toBe(true)
    })
    await act(async () => latest().startSession())
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')
    backend.layoutApplyFailure = 'definite'
    await act(async () => {
      expect(await latest().applySavedScene(hidden.id)).toBe(false)
    })
    expect(latest().scene!.sources.find((source) => source.kind === 'camera')!.visible).toBe(true)
    expect(latest().captureConfig.layout.sourceVisibility?.camera).toBe(true)
    expect(
      JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.layout.sourceVisibility.camera
    ).toBe(true)
    backend.layoutApplyFailure = 'request-outcome-unknown-after-commit'
    const start = backend.sentCommands.length
    await act(async () => {
      expect(await latest().applySavedScene(hidden.id)).toBe(true)
    })
    expect(latest().activeSavedSceneId).toBe(hidden.id)
    expect(latest().savedSceneModified).toBe(false)
    expect(latest().scene!.sources.find((source) => source.kind === 'camera')!.visible).toBe(false)
    expect(latest().captureConfig.sources.cameraId).toBe(hidden.visual.sources.cameraId)
    expect(latest().captureConfig.sources.cameraOff).not.toBe(true)
    expect(
      JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.layout.sourceVisibility.camera
    ).toBe(false)
    expect(
      backend.sentCommands
        .slice(start)
        .filter((command) => command.method === 'scene.layout.apply_live')
    ).toHaveLength(1)
    expect(
      backend.sentCommands
        .slice(start)
        .filter((command) => command.method === 'scene.source.visibility.update')
    ).toHaveLength(0)
    await act(async () => {
      expect(await latest().stopSession()).toBe(true)
    })
  })

  it.each([
    'acknowledged',
    'event-before-ack',
    'event-and-compositor-before-ack',
    'rejected',
    'not-applied',
    'superseded',
    'source-replaced',
    'unrelated-transform',
    'other-visibility',
    'newer-revision'
  ] as const)(
    'persists visibility only after a current %s backend acknowledgement',
    async (outcome) => {
      const backend = new StudioBackend()
      backend.deviceList.devices.push({
        id: 'camera:1',
        name: 'Camera 1',
        kind: 'camera',
        status: 'available'
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
      const latest = (): StudioCoreContextValue => observations.at(-1)!.core
      root = await mountStudioProvider(testDom.container, (value) => {
        observations.push(value)
      })
      await waitForObservation(() => canSaveScene())
      await act(async () => {
        expect(saveScene('Visible')).toBe(true)
      })
      const checkpoint = localStorage.getItem(WORKING_SCENE_KEY)
      const camera = latest().scene!.sources.find((source) => source.kind === 'camera')!
      const hiddenScene = {
        ...backend.currentScene,
        sources: backend.currentScene.sources.map((source) =>
          source.id === camera.id ? { ...source, visible: false } : source
        )
      }
      const hiddenLayout = {
        ...backend.currentLayout,
        sourceVisibility: { camera: false, capture: true }
      }
      const status = {
        applied: outcome !== 'not-applied',
        mode: 'idle',
        sceneRevision: backend.revision + 1,
        scene: hiddenScene,
        compositorStatus: compositorFor(hiddenScene, hiddenLayout, backend.revision + 1)
      }
      const release =
        outcome === 'rejected'
          ? backend.deferFailure(
              'scene.source.visibility.update',
              new Error('Visibility rejected.')
            )
          : backend.deferResponse('scene.source.visibility.update', status)
      let pending: Promise<void> | undefined
      try {
        await act(async () => {
          pending = latest().setSceneSourceVisible(camera.id, false)
        })
        await waitForObservation(() =>
          backend.sentCommands.some(
            (command) => command.method === 'scene.source.visibility.update'
          )
        )
        expect(canSaveScene()).toBe(false)
        expect(latest().savedSceneModified).toBe(false)
        expect(localStorage.getItem(WORKING_SCENE_KEY)).toBe(checkpoint)
        if (outcome === 'superseded') {
          await act(async () => latest().applyCameraPreset({ cameraZoom: 143 }))
          await waitForObservation(
            () =>
              latest().captureConfig.layout.cameraZoom === 143 &&
              latest().layoutSwitchPending === null
          )
        }
        if (outcome === 'acknowledged' || outcome.startsWith('event-')) {
          backend.currentScene = hiddenScene
          backend.currentLayout = hiddenLayout
          backend.revision = status.sceneRevision
          if (outcome.startsWith('event-')) {
            await act(async () => {
              for (const socket of backend.sockets) {
                socket.onmessage?.({
                  data: JSON.stringify({ event: 'scene.changed', payload: hiddenScene })
                })
                if (outcome === 'event-and-compositor-before-ack')
                  socket.onmessage?.({
                    data: JSON.stringify({
                      event: 'compositor.status',
                      payload: status.compositorStatus
                    })
                  })
              }
            })
            expect(latest().scene!.sources.find((source) => source.id === camera.id)!.visible).toBe(
              false
            )
            expect(localStorage.getItem(WORKING_SCENE_KEY)).toBe(checkpoint)
          }
        }
        if (
          ['source-replaced', 'unrelated-transform', 'other-visibility', 'newer-revision'].includes(
            outcome
          )
        ) {
          const changed = {
            ...backend.currentScene,
            sources: backend.currentScene.sources.map((source) => {
              if (outcome === 'source-replaced' && source.id === camera.id)
                return { ...source, deviceId: 'camera:2' }
              if (outcome === 'unrelated-transform' && source.id === camera.id)
                return { ...source, transform: { ...source.transform, x: 0.25 } }
              if (outcome === 'other-visibility' && source.id !== camera.id)
                return { ...source, visible: false }
              return source
            })
          }
          await act(async () => {
            for (const socket of backend.sockets) {
              socket.onmessage?.({
                data: JSON.stringify({ event: 'scene.changed', payload: changed })
              })
              if (outcome === 'newer-revision')
                socket.onmessage?.({
                  data: JSON.stringify({
                    event: 'compositor.status',
                    payload: { ...status.compositorStatus, sceneRevision: status.sceneRevision + 1 }
                  })
                })
            }
          })
        }
        await act(async () => {
          release()
          await pending
        })
        if (outcome === 'acknowledged' || outcome.startsWith('event-')) {
          // Plan 231 D11: the acknowledged edit saves into the scene on stream.
          await waitForObservation(
            () => sceneNamed(latest(), 'Visible').visual.layout.sourceVisibility?.camera === false
          )
          expect(latest().savedSceneModified).toBe(false)
          expect(
            JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.layout.sourceVisibility
              .camera
          ).toBe(false)
          expect(latest().captureConfig.layout.sourceVisibility?.camera).toBe(false)
        } else {
          expect(latest().captureConfig.layout.sourceVisibility?.camera).toBe(true)
          expect(sceneNamed(latest(), 'Visible').visual.layout.sourceVisibility?.camera).not.toBe(
            false
          )
          expect(latest().scene!.sources.find((source) => source.kind === 'camera')!.visible).toBe(
            true
          )
          expect(
            JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.layout.sourceVisibility
              .camera
          ).toBe(true)
        }
        expect(latest().captureConfig.sources.cameraId).toBe('camera:1')
      } finally {
        release()
        await act(async () => {
          await pending
        })
      }
    }
  )

  it('refuses missing saved sources without fallback and preserves storage on failed saves', async () => {
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => {
      expect(saveScene('Original')).toBe(true)
    })
    const saved = sceneNamed(latest(), 'Original')
    const count = latest().savedScenes.length
    const start = backend.sentCommands.length
    await act(async () => {
      expect(
        await latest().applySavedScene(saved.id, {
          ...saved.visual,
          sources: { ...saved.visual.sources, windowId: 'closed-window', screenId: undefined }
        })
      ).toBe(false)
    })
    expect(
      backend.sentCommands
        .slice(start)
        .filter((command) => command.method.startsWith('scene.layout.apply'))
    ).toHaveLength(0)
    expect(latest().captureConfig.sources.windowId).toBeUndefined()
    expect(latest().activeSavedSceneId).toBe(saved.id)
    expect(latest().captureConfig.layoutFramingMemory.layouts['screen-camera'].cameraZoom).toBe(100)
    const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    await act(async () => {
      expect(saveScene('Cannot save')).toBe(false)
    })
    expect(latest().savedScenes).toHaveLength(count)
    storage.mockRestore()
  })

  it('recovers complete same-layout saved targets with distinct sources and backgrounds after a lost response', async () => {
    const backend = new StudioBackend()
    backend.deviceList.devices.push(
      { id: 'camera:2', name: 'Camera 2', kind: 'camera', status: 'available' },
      { id: 'window:2', name: 'Presentation', kind: 'window', status: 'available' }
    )
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    api.backgroundAssetExists = async () => true
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => latest().applyBackgroundSlot('bg-01'))
    await waitForObservation(
      () => latest().scene?.background?.assetId === 'builtin-bg-01' && canSaveScene()
    )
    await act(async () => latest().applyWorkingBackgroundStyle({ blurPx: 20, scale: 150 }))
    await waitForObservation(() => latest().scene?.background?.scale === 150 && canSaveScene())
    await act(async () => {
      expect(saveScene('A')).toBe(true)
    })
    const first = sceneNamed(latest(), 'A')
    const alternate = {
      ...first.visual,
      layout: { ...first.visual.layout, cameraZoom: 175, cameraOffsetY: -25 },
      sources: {
        ...first.visual.sources,
        cameraId: 'camera:2',
        cameraName: 'Camera 2',
        screenId: undefined,
        screenName: undefined,
        windowId: 'window:2',
        windowName: 'Presentation'
      },
      background: { ...first.visual.background!, assetId: 'builtin-bg-02', blurPx: 5, scale: 100 }
    }
    await act(async () => {
      expect(await latest().applySavedScene(first.id, alternate)).toBe(true)
    })
    await waitForObservation(
      () => latest().captureConfig.sources.windowId === 'window:2' && canSaveScene()
    )
    await act(async () => {
      expect(saveScene('B')).toBe(true)
    })
    const second = sceneNamed(latest(), 'B')
    // Plan 231 D9: the sources chosen again for A carried a camera, and it is
    // the camera of every scene from then on.
    expect(latest().captureConfig.sources.cameraId).toBe('camera:2')
    const firstNow = sceneNamed(latest(), 'A')
    expect(firstNow.visual.sources.cameraId).toBe('camera:2')
    const memory = latest().captureConfig.layoutFramingMemory
    backend.layoutApplyFailure = 'request-outcome-unknown-after-commit'
    const start = backend.sentCommands.length
    await act(async () => {
      expect(await latest().applySavedScene(first.id)).toBe(true)
    })
    await waitForObservation(() => latest().activeSavedSceneId === first.id && canSaveScene())
    const applies = backend.sentCommands
      .slice(start)
      .filter((command) => command.method.startsWith('scene.layout.apply'))
    expect(applies).toHaveLength(1)
    expect(applies[0].params).toMatchObject({
      layout: first.visual.layout,
      sources: { screenId: first.visual.sources.screenId, cameraId: 'camera:2' },
      background: { assetId: 'builtin-bg-01', blurPx: 20, scale: 150 }
    })
    expect(latest().captureConfig.sources.cameraId).toBe('camera:2')
    expect(latest().captureConfig.sources.screenId).toBe(first.visual.sources.screenId)
    expect(latest().captureConfig.sources.windowId).toBeUndefined()
    expect(latest().scene?.background?.assetId).toBe('builtin-bg-01')
    expect(latest().captureConfig.layoutFramingMemory).toEqual(memory)
    expect(
      sameSceneVisual(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual, firstNow.visual)
    ).toBe(true)
    backend.layoutApplyFailure = 'definite'
    await act(async () => {
      expect(await latest().applySavedScene(second.id)).toBe(false)
    })
    expect(latest().activeSavedSceneId).toBe(first.id)
    expect(latest().captureConfig.layoutFramingMemory).toEqual(memory)
    expect(
      sameSceneVisual(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual, firstNow.visual)
    ).toBe(true)
    backend.layoutApplyFailure = null
    await act(async () => latest().applyWorkingBackgroundStyle({ dimPercent: 35 }))
    await waitForObservation(() => latest().scene?.background?.dimPercent === 35 && canSaveScene())
    expect(latest().scene?.background?.scale).toBe(150)
    expect(latest().scene?.background?.blurPx).toBe(20)
    expect(second.visual.background?.assetId).toBe('builtin-bg-02')
    // Plan 231 D11: the background edit saved into A, the scene on stream.
    await waitForObservation(() => sceneNamed(latest(), 'A').visual.background?.dimPercent === 35)
    expect(sceneNamed(latest(), 'B').visual.background?.assetId).toBe('builtin-bg-02')
    // Plan 231 D16: off air, deleting the scene on stream first switches to
    // the scene before it, then deletes.
    const before = latest().savedScenes[latest().savedScenes.indexOf(sceneNamed(latest(), 'A')) - 1]
    await act(async () => {
      expect(await latest().deleteSavedScene(first.id)).toBe(true)
    })
    await waitForObservation(() => latest().activeSavedSceneId === before.id && canSaveScene())
    expect(latest().savedScenes.some((scene) => scene.id === first.id)).toBe(false)
    expect(storedLibrary().onStreamId).toBe(before.id)
    const checkpoint = JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!)
    expect(checkpoint.sceneId).toBe(before.id)
    expect(latest().captureConfig.layout.layoutPreset).toBe(before.visual.layout.layoutPreset)
  })

  it('keeps the latest named identity through overlapping A to B to A and never saves an unresolved target', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    api.backgroundAssetExists = async () => true
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => latest().applyBackgroundSlot('bg-01'))
    await waitForObservation(
      () => latest().scene?.background?.assetId === 'builtin-bg-01' && canSaveScene()
    )
    await act(async () => {
      expect(saveScene('A')).toBe(true)
    })
    const first = sceneNamed(latest(), 'A')
    // Plan 231 D11: B goes on stream first, so the edits below save into B
    // instead of into A.
    await act(async () => {
      expect(saveScene('B')).toBe(true)
    })
    await act(async () => latest().applyCameraPreset({ cameraZoom: 175 }))
    await waitForObservation(
      () => latest().captureConfig.layout.cameraZoom === 175 && canSaveScene()
    )
    await act(async () => latest().applyBackgroundSlot('bg-02'))
    await waitForObservation(
      () =>
        latest().scene?.background?.assetId === 'builtin-bg-02' &&
        canSaveScene() &&
        sceneNamed(latest(), 'B').visual.background?.assetId === 'builtin-bg-02' &&
        sceneNamed(latest(), 'B').visual.layout.cameraZoom === 175
    )
    expect(sceneNamed(latest(), 'A').visual.background?.assetId).toBe('builtin-bg-01')
    const second = sceneNamed(latest(), 'B')
    const count = latest().savedScenes.length
    // Hold the stale pick at its layout apply (plan 210 S3: the source
    // preflight reads the held device list, with no round trip to hold).
    const release = backend.deferResponse('scene.layout.apply_preview', BACKEND_RESPONSE)
    let stale: Promise<boolean> | undefined
    await act(async () => {
      stale = latest().applySavedScene(first.id)
    })
    await waitForObservation(() => latest().savedScenePendingId === first.id)
    // Issue #1275: the pending switch keeps the scene's name and says what it waits for.
    await waitForObservation(() => latest().sceneSwitchProgress?.phase === 'starting')
    expect(latest().sceneSwitchProgress).toMatchObject({ target: 'A', replaced: null })
    expect(canSaveScene()).toBe(false)
    await act(async () => {
      expect(saveScene('Uncommitted')).toBe(false)
    })
    // B takes the pending switch to A over, and says so while it runs.
    const releaseSecond = backend.deferResponse('scene.layout.apply_preview', BACKEND_RESPONSE)
    let switchToSecond: Promise<boolean> | undefined
    await act(async () => {
      switchToSecond = latest().applySavedScene(second.id)
    })
    await waitForObservation(() => latest().sceneSwitchProgress?.target === 'B')
    expect(latest().sceneSwitchProgress?.replaced).toBe('A')
    await act(async () => {
      releaseSecond()
      expect(await switchToSecond).toBe(true)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => {
      expect(await latest().applySavedScene(first.id)).toBe(true)
    })
    await waitForObservation(() => canSaveScene() && latest().activeSavedSceneId === first.id)
    await act(async () => {
      release()
      await stale
    })
    expect(latest().activeSavedSceneId).toBe(first.id)
    expect(latest().sceneSwitchProgress).toBeNull()
    expect(latest().captureConfig.layout.cameraZoom).toBe(first.visual.layout.cameraZoom)
    expect(latest().savedScenes).toHaveLength(count)
    expect(latest().scene?.background?.assetId).toBe('builtin-bg-01')
    expect(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.background.assetId).toBe(
      'builtin-bg-01'
    )
    expect(backend.currentLayout.cameraZoom).toBe(first.visual.layout.cameraZoom)
    expect(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).sceneId).toBe(first.id)
  })

  it('keeps actual Scene controls eligible across composition retirement and ignores delayed older proof', async () => {
    const cameraId = 'camera:avfoundation:0'
    const screenId = 'screen:screencapturekit:1'
    const backend = new StudioBackend()
    backend.deviceList.devices = [
      { id: cameraId, name: 'Camera', kind: 'camera', status: 'available' },
      { id: screenId, name: 'Display', kind: 'screen', status: 'available' }
    ]
    backend.recordingState = 'recording'
    backend.recordingSessionId = 'session-1'
    backend.confirmedSources = { cameraId, screenId }
    backend.reportsActiveSceneRevision = true
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const testDom = installProviderDomEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => []
      })
    )
    restoreEnvironment = testDom.restore
    localStorage.setItem(
      STORAGE_KEYS.captureConfig,
      JSON.stringify({
        ...defaultCaptureConfig,
        sources: { cameraId, screenId }
      })
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    const heldProofs: Array<{ release: () => void; payload: { activeSceneRevision: number } }> = []
    const respond = backend.response.bind(backend)
    backend.response = (command) => {
      const result = respond(command)
      if (command.method === 'scene.layout.apply_live') {
        const params = command.params as { layout: LayoutSettings; sources: SourceSelection }
        // The backend owner regression proves this corrected contract:
        // confirmed is selected intent, independent of visible composition.
        // Only visual fields belong to this layout; the mic owns its receipt.
        backend.confirmedSources = {
          ...params.sources,
          microphoneId: backend.confirmedSources.microphoneId
        }
        if (params.layout.layoutPreset !== 'side-by-side') {
          const payload = { activeSceneRevision: 0 }
          const release = backend.deferResponse('diagnostics.stats', payload)
          heldProofs.push({ payload, release })
        }
        queueMicrotask(() =>
          backend.sockets[0]?.onmessage?.({
            data: JSON.stringify({
              event: 'session.sources.changed',
              payload: backend.sourceSnapshot('session-1')
            })
          })
        )
      }
      return result
    }
    const button = (preset: string): HTMLButtonElement => {
      const found = document.querySelector<HTMLButtonElement>(
        `[data-videorc-layout-preset="${preset}"]`
      )
      expect(found).not.toBeNull()
      return found!
    }
    try {
      root = await mountStudioProvider(
        testDom.container,
        (value) => {
          observations.push(value)
        },
        createElement(LayoutTab)
      )
      await waitForObservation(
        () =>
          observations.at(-1)?.recording.recording.state === 'recording' &&
          latest().sourceSelectionState.snapshot !== null &&
          latest().deviceList.devices.some((device) => device.id === cameraId)
      )
      expect(button('camera-only').disabled).toBe(false)
      await act(async () => button('camera-only').click())
      await waitForObservation(
        () =>
          latest().sourceSelectionState.snapshot?.confirmed.screenId === screenId &&
          heldProofs.length === 1
      )
      expect(latest().layoutSwitchPending).toEqual({
        layoutPreset: 'camera-only',
        arrangementMode: 'preset'
      })
      expect(latest().captureConfig.layout.layoutPreset).toBe('screen-camera')
      // The first committed composition is camera-only while its output proof
      // is held. A newer screen or mixed intent must still have selected IDs.
      expect(button('screen-only').disabled).toBe(false)
      expect(button('side-by-side').disabled).toBe(false)
      await act(async () => button('screen-only').click())
      await waitForObservation(
        () =>
          heldProofs.length === 2 &&
          latest().sourceSelectionState.snapshot?.confirmed.cameraId === cameraId
      )
      expect(button('camera-only').disabled).toBe(false)
      expect(button('side-by-side').disabled).toBe(false)
      await act(async () => button('side-by-side').click())
      await waitForObservation(
        () =>
          latest().captureConfig.layout.layoutPreset === 'side-by-side' &&
          latest().layoutSwitchPending === null
      )
      await act(async () => {
        for (const proof of heldProofs) {
          proof.payload.activeSceneRevision = backend.revision
          proof.release()
        }
      })
      expect(latest().captureConfig.sources).toMatchObject({ cameraId, screenId })
      expect(latest().captureConfig.layout.layoutPreset).toBe('side-by-side')
      expect(
        backend.sentCommands
          .filter((command) => command.method === 'scene.layout.apply_live')
          .map((command) => (command.params as { layout: LayoutSettings }).layout.layoutPreset)
      ).toEqual(['camera-only', 'screen-only', 'side-by-side'])
      expect(
        observations.some(({ core }) =>
          ['camera-only', 'screen-only'].includes(core.captureConfig.layout.layoutPreset)
        )
      ).toBe(false)
      expect(toastSpies.error).not.toHaveBeenCalled()
    } finally {
      for (const proof of heldProofs) {
        proof.payload.activeSceneRevision = backend.revision
        proof.release()
      }
    }
  }, 15_000)

  it.each([
    {
      name: 'explicit Camera Off',
      sources: { screenId: 'screen:screencapturekit:1', cameraOff: true },
      blocked: ['camera-only', 'side-by-side'],
      unavailable: undefined
    },
    {
      name: 'explicit capture None',
      sources: { cameraId: 'camera:avfoundation:0' },
      blocked: ['screen-only', 'side-by-side'],
      unavailable: undefined
    },
    {
      name: 'missing camera',
      sources: { cameraId: 'camera:missing', screenId: 'screen:screencapturekit:1' },
      blocked: [],
      unavailable: 'camera-only'
    },
    {
      name: 'unavailable display',
      sources: { cameraId: 'camera:avfoundation:0', screenId: 'screen:screencapturekit:1' },
      blocked: [],
      unavailable: 'screen-only'
    }
  ])(
    'does not accept a live layout requiring $name through actual Scene controls',
    async ({ sources, blocked, unavailable }) => {
      const backend = new StudioBackend()
      backend.deviceList.devices = [
        { id: 'camera:avfoundation:0', name: 'Camera', kind: 'camera', status: 'available' },
        {
          id: 'screen:screencapturekit:1',
          name: 'Display',
          kind: 'screen',
          status: unavailable === 'screen-only' ? 'unavailable' : 'available'
        }
      ]
      backend.recordingState = 'recording'
      backend.recordingSessionId = 'session-1'
      backend.confirmedSources = sources
      TestWebSocket.backend = backend
      vi.stubGlobal('WebSocket', TestWebSocket)
      const testDom = installProviderDomEnvironment(
        createVideorcApi({
          acknowledge: async () => true,
          pending: async () => [],
          acknowledgeProvider: async () => true,
          pendingProvider: async () => []
        })
      )
      restoreEnvironment = testDom.restore
      localStorage.setItem(
        STORAGE_KEYS.captureConfig,
        JSON.stringify({ ...defaultCaptureConfig, sources })
      )
      const observations: StudioObservation[] = []
      const latest = (): StudioCoreContextValue => observations.at(-1)!.core
      root = await mountStudioProvider(
        testDom.container,
        (value) => {
          observations.push(value)
        },
        createElement(LayoutTab)
      )
      await waitForObservation(
        () =>
          observations.at(-1)?.recording.recording.state === 'recording' &&
          latest().sourceSelectionState.snapshot !== null &&
          latest().deviceList.devices.length === 2
      )
      const button = (preset: string): HTMLButtonElement =>
        document.querySelector<HTMLButtonElement>(`[data-videorc-layout-preset="${preset}"]`)!
      for (const preset of blocked) {
        expect(button(preset).disabled).toBe(true)
        await act(async () => button(preset).click())
      }
      if (unavailable) {
        // A selected ID may survive device loss, but the real provider still
        // validates discovery before admitting its layout to the backend.
        expect(button(unavailable).disabled).toBe(false)
        await act(async () => button(unavailable).click())
        await waitForObservation(() => toastSpies.warning.mock.calls.length > 0)
      }
      expect(
        backend.sentCommands.filter((command) => command.method === 'scene.layout.apply_live')
      ).toHaveLength(0)
      expect(latest().layoutSwitchPending).toBeNull()
      if ('cameraOff' in sources) expect(latest().captureConfig.sources.cameraOff).toBe(true)
    }
  )

  it('routes global scene and layout keys through confirmed switches and coalesces repeat bursts', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emit: (name: string, value: unknown) => void = () => {}
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (next) => {
        emit = next
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => {
      expect(saveScene('Named shortcut target')).toBe(true)
    })
    const saved = sceneNamed(latest(), 'Named shortcut target')
    // A new profile's scenes: Screen + camera, Screen only, Camera only, Side
    // by side, then the one saved above.
    const [screenCamera, screenOnly, cameraOnly] = latest().savedScenes
    expect(latest().savedScenes.map((scene) => scene.visual.layout.layoutPreset)).toEqual([
      'screen-camera',
      'screen-only',
      'camera-only',
      'side-by-side',
      'screen-camera'
    ])
    const applies = (from: number) =>
      backend.sentCommands
        .slice(from)
        .filter((entry) => entry.method.startsWith('scene.layout.apply'))
    await act(async () => {
      latest().setSettings((current) => ({
        ...current,
        globalShortcuts: { scenes: { [saved.id]: 'Control+F13' } }
      }))
      latest().renameSavedScene(saved.id, 'Renamed shortcut target')
      emit('onGlobalShortcut', 'scene-slot-2')
    })
    // Plan 231 D5: a position key switches to that scene. It never changes
    // the layout of the scene on stream.
    await waitForObservation(() => latest().activeSavedSceneId === screenOnly.id && canSaveScene())
    expect(latest().captureConfig.layout.layoutPreset).toBe('screen-only')
    expect(sceneNamed(latest(), 'Renamed shortcut target').visual.layout.layoutPreset).toBe(
      'screen-camera'
    )
    expect(latest().settings.globalShortcuts?.scenes?.[saved.id]).toBe('Control+F13')
    await act(async () => {
      emit('onGlobalShortcut', `scene:${saved.id}`)
    })
    await waitForObservation(() => latest().activeSavedSceneId === saved.id && canSaveScene())
    // A reorder changes the position key immediately; the id's custom key stays.
    await act(async () => {
      latest().sceneLibraryActions.move(screenOnly.id, 0)
    })
    await act(async () => emit('onGlobalShortcut', 'scene-slot-1'))
    await waitForObservation(() => latest().activeSavedSceneId === screenOnly.id && canSaveScene())
    expect(latest().settings.globalShortcuts?.scenes?.[saved.id]).toBe('Control+F13')
    await act(async () => latest().sceneLibraryActions.move(screenOnly.id, 1))
    await act(async () => emit('onGlobalShortcut', `scene:${saved.id}`))
    await waitForObservation(() => latest().activeSavedSceneId === saved.id && canSaveScene())
    // Next and Previous walk the scenes, in their order, and a burst is one switch.
    let start = backend.sentCommands.length
    await act(async () => {
      emit('onGlobalShortcut', 'layout-next')
      emit('onGlobalShortcut', 'layout-next')
      emit('onGlobalShortcut', 'layout-next')
    })
    await waitForObservation(() => latest().activeSavedSceneId === cameraOnly.id && canSaveScene())
    expect(latest().captureConfig.layout.layoutPreset).toBe('camera-only')
    expect(applies(start)).toHaveLength(1)
    // A layout chosen on the canvas takes a pending key over, and sets the
    // layout of the scene on stream (D2).
    await act(async () => {
      emit('onGlobalShortcut', 'layout-next')
      latest().applyCameraPreset({ cameraZoom: 120 })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    await waitForObservation(
      () => latest().captureConfig.layout.cameraZoom === 120 && canSaveScene()
    )
    expect(latest().activeSavedSceneId).toBe(cameraOnly.id)
    await act(async () => {
      emit('onGlobalShortcut', 'layout-previous')
    })
    await waitForObservation(() => latest().activeSavedSceneId === screenOnly.id && canSaveScene())
    await act(async () => {
      emit('onGlobalShortcut', 'scene-slot-3')
    })
    await waitForObservation(() => latest().activeSavedSceneId === cameraOnly.id && canSaveScene())
    expect(latest().captureConfig.layout.layoutPreset).toBe('camera-only')
    backend.deviceList.devices = backend.deviceList.devices.filter(
      (device) => device.kind !== 'camera'
    )
    await act(async () => latest().refreshBackend({ fresh: true }))
    // A scene that needs the missing camera is refused before any commit.
    start = backend.sentCommands.length
    await act(async () => {
      emit('onGlobalShortcut', 'scene-slot-1')
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    await waitForObservation(() => canSaveScene())
    expect(applies(start)).toHaveLength(0)
    expect(latest().activeSavedSceneId).toBe(cameraOnly.id)
    // Next skips the scenes that need it.
    await act(async () => {
      emit('onGlobalShortcut', 'layout-next')
    })
    await waitForObservation(() => latest().activeSavedSceneId === screenOnly.id && canSaveScene())
    expect(latest().activeSavedSceneId).not.toBe(screenCamera.id)
    await act(async () => latest().startSession())
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')
    // An empty position and a retired layout action do nothing, even live.
    start = backend.sentCommands.length
    toastSpies.info.mockClear()
    await act(async () => {
      emit('onGlobalShortcut', 'scene-slot-9')
      emit('onGlobalShortcut', 'layout:vertical-screen-only')
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(latest().captureConfig.layout.layoutPreset).toBe('screen-only')
    expect(applies(start)).toHaveLength(0)
    expect(toastSpies.info).not.toHaveBeenCalled()
    // Plan 231 D16: a scene that is not on stream can go while recording,
    // and the scene on stream can't.
    await act(async () => {
      expect(await latest().deleteSavedScene(screenOnly.id)).toBe(false)
    })
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'Switch to another scene first.',
      expect.objectContaining({ id: 'scene-delete-refused' })
    )
    await act(async () => {
      expect(await latest().deleteSavedScene(saved.id)).toBe(true)
    })
    expect(latest().savedScenes.some((scene) => scene.id === saved.id)).toBe(false)
    expect(latest().savedScenes.some((scene) => scene.id === screenOnly.id)).toBe(true)
    expect(latest().settings.globalShortcuts?.scenes?.[saved.id]).toBeUndefined()
  }, 15000)

  it('restores an auto-saved checkpoint and saveability across a renderer remount with synthetic preview mapping', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const runtimeInfo = api.getRuntimeInfo
    api.getRuntimeInfo = async () => ({ ...(await runtimeInfo()), previewSmokeMode: true })
    api.backgroundAssetExists = async () => true
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        observations.at(-1)?.core.wsStatus === 'connected' &&
        latest().captureConfig.sources.cameraId != null
    )
    await act(async () =>
      latest().applyCameraPreset({ layoutPreset: 'screen-only', cameraZoom: 125 })
    )
    await waitForObservation(
      () => latest().captureConfig.layout.cameraZoom === 125 && canSaveScene()
    )
    await act(async () => latest().applyBackgroundSlot('bg-01'))
    await waitForObservation(
      () => latest().scene?.background?.assetId === 'builtin-bg-01' && canSaveScene()
    )
    await act(async () => {
      expect(saveScene('Restart')).toBe(true)
    })
    const saved = sceneNamed(latest(), 'Restart')
    await act(async () => latest().applyCameraPreset({ cameraZoom: 145 }))
    await waitForObservation(
      () => latest().captureConfig.layout.cameraZoom === 145 && canSaveScene()
    )
    const cameraId = latest().captureConfig.sources.cameraId
    await act(async () => root!.unmount())
    observations.length = 0
    const start = backend.sentCommands.length
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() =>
      backend.sentCommands
        .slice(start)
        .some((command) => command.method === 'scene.load_from_capture_config')
    )
    await act(async () => latest().refreshBackend({ fresh: true }))
    expect(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.sources.cameraId).toBe(
      cameraId
    )
    expect(latest().captureConfig.layout.cameraZoom).toBe(145)
    expect(latest().activeSavedSceneId).toBe(saved.id)
    // Plan 231 D11: the edit saved into the scene before the remount.
    expect(sceneNamed(latest(), 'Restart').visual.layout.cameraZoom).toBe(145)
    expect(latest().savedSceneModified).toBe(false)
    expect(canSaveScene()).toBe(true)
    await act(async () => {
      expect(saveScene('After restart')).toBe(true)
    })
  })

  // Plan 210 STOP condition: a saved scene is never rewritten without the
  // streamer's action. A look that drifted before auto-save existed
  // (Modified, never Updated) stays out of the scene at launch.
  it('never writes a drifted working look into its saved scene at launch (plan 210 D3)', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    const runtimeInfo = api.getRuntimeInfo
    api.getRuntimeInfo = async () => ({ ...(await runtimeInfo()), previewSmokeMode: true })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => {
      expect(saveScene('Launch')).toBe(true)
    })
    const saved = sceneNamed(latest(), 'Launch')
    await act(async () => root!.unmount())
    observations.length = 0
    const working = JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!)
    localStorage.setItem(
      WORKING_SCENE_KEY,
      JSON.stringify({
        ...working,
        visual: { ...working.visual, layout: { ...working.visual.layout, cameraZoom: 160 } }
      })
    )
    const start = backend.sentCommands.length
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        backend.sentCommands
          .slice(start)
          .some((command) => command.method === 'scene.load_from_capture_config') && canSaveScene()
    )
    await act(async () => latest().refreshBackend({ fresh: true }))
    expect(latest().activeSavedSceneId).toBe(saved.id)
    expect(latest().captureConfig.layout.cameraZoom).toBe(160)
    expect(sceneNamed(latest(), 'Launch').visual.layout.cameraZoom).toBe(
      saved.visual.layout.cameraZoom
    )
    expect(storedSceneNamed('Launch').layouts.horizontal.cameraZoom).toBe(
      saved.visual.layout.cameraZoom
    )
    // The streamer's next edit is theirs: it saves.
    await act(async () => latest().applyCameraPreset({ cameraZoom: 170 }))
    await waitForObservation(() => sceneNamed(latest(), 'Launch').visual.layout.cameraZoom === 170)
  })

  it('keeps a live scene source confirmation out of the scene being left', async () => {
    const backend = new StudioBackend()
    backend.deviceList.devices.push(
      { id: 'window:alpha', name: 'Alpha', kind: 'window', status: 'available' },
      { id: 'window:beta', name: 'Beta', kind: 'window', status: 'available' }
    )
    backend.deviceList.devices.push({
      id: 'mic:2',
      name: 'Microphone 2',
      kind: 'microphone',
      status: 'available'
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => canSaveScene() && latest().captureConfig.layout.layoutPreset === 'screen-only'
    )
    const template = latest().sceneOnStream!
    const windowScene = (key: string): StoredScene => ({
      ...template,
      id: `fixed-${key}`,
      name: key,
      shows: { kind: 'window', windowId: `window:${key}`, windowName: key }
    })
    const alpha = windowScene('alpha'),
      beta = windowScene('beta')
    await act(async () => {
      expect(latest().sceneLibraryActions.add([alpha, beta], {})).toBe(true)
    })
    await act(async () => {
      expect(await latest().applySavedScene(beta.id)).toBe(true)
    })
    await waitForObservation(() => canSaveScene() && latest().activeSavedSceneId === beta.id)

    await act(async () => latest().startSession())
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')
    const from = backend.sentCommands.length
    const release = backend.deferResponse('scene.layout.apply_live', BACKEND_RESPONSE)
    let switching!: Promise<boolean>
    await act(async () => {
      switching = latest().applySavedScene(alpha.id)
    })
    try {
      await waitForObservation(() =>
        backend.sentCommands
          .slice(from)
          .some((command) => command.method === 'scene.layout.apply_live')
      )
      // The backend commits and publishes sources before its scene RPC receipt.
      // Beta still owns the renderer's working scene until Alpha is reconciled.
      backend.confirmedSources = {
        ...latest().captureConfig.sources,
        screenId: undefined,
        windowId: 'window:alpha',
        microphoneId: 'mic:2'
      }
      backend.confirmedSourceRevision += 1
      const reads = backend.sentCommands.filter(
        (command) => command.method === 'session.sources.get'
      ).length
      await act(async () => {
        backend.sockets[0]?.onmessage?.({
          data: JSON.stringify({
            event: 'session.sources.changed',
            payload: backend.sourceSnapshot(backend.recordingSessionId!)
          })
        })
      })
      await waitForObservation(
        () =>
          backend.sentCommands.filter((command) => command.method === 'session.sources.get')
            .length > reads && latest().captureConfig.sources.microphoneId === 'mic:2'
      )
      expect(latest().activeSavedSceneId).toBe(beta.id)
      expect(latest().captureConfig.sources.microphoneId).toBe('mic:2')
      expect(storedSceneNamed('beta').shows).toEqual(beta.shows)
      await act(async () => {
        release()
        expect(await switching).toBe(true)
      })
      await waitForObservation(() => canSaveScene() && latest().activeSavedSceneId === alpha.id)
      expect(storedSceneNamed('alpha').shows).toEqual(alpha.shows)
      expect(storedSceneNamed('beta').shows).toEqual(beta.shows)
      expect(latest().captureConfig.sources.windowId).toBe('window:alpha')
    } finally {
      release()
      await switching.catch(() => {})
    }
  }, 20_000)

  it('does not save a late idle reload into the window scene put on stream while recording', async () => {
    const backend = new StudioBackend()
    backend.deviceList.devices.push(
      { id: 'window:alpha', name: 'Alpha', kind: 'window', status: 'available' },
      { id: 'window:beta', name: 'Beta', kind: 'window', status: 'available' }
    )
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => canSaveScene() && latest().captureConfig.layout.layoutPreset === 'screen-only'
    )
    const template = latest().sceneOnStream!
    const windowScene = (key: string): StoredScene => ({
      ...template,
      id: `fixed-${key}`,
      name: key,
      shows: { kind: 'window', windowId: `window:${key}`, windowName: key }
    })
    const alpha = windowScene('alpha'),
      beta = windowScene('beta')
    await act(async () => {
      expect(latest().sceneLibraryActions.add([alpha, beta], {})).toBe(true)
    })
    await act(async () => {
      expect(await latest().applySavedScene(beta.id)).toBe(true)
    })
    await waitForObservation(() => canSaveScene() && latest().activeSavedSceneId === beta.id)

    await act(async () => latest().startSession())
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')
    // A reload issued for Beta can finish after a live switch to Alpha.
    // Its persisted source must stay owned by Beta, never the new program id.
    const from = backend.sentCommands.length
    const release = backend.deferResponse(
      'scene.load_from_capture_config',
      BACKEND_RESPONSE,
      (command) =>
        (command.params as { sources?: SourceSelection }).sources?.windowId === 'window:beta'
    )
    let lateReload!: Promise<void>
    await act(async () => {
      lateReload = latest().reloadSceneFromCaptureConfig()
    })
    try {
      await waitForObservation(() =>
        backend.sentCommands
          .slice(from)
          .some((command) => command.method === 'scene.load_from_capture_config')
      )
      await act(async () => {
        expect(await latest().applySavedScene(alpha.id)).toBe(true)
      })
      await waitForObservation(() => canSaveScene() && latest().activeSavedSceneId === alpha.id)
      expect(storedSceneNamed('alpha').shows).toEqual(alpha.shows)
      await act(async () => {
        release()
        await lateReload
      })
      expect(storedSceneNamed('alpha').shows).toEqual(alpha.shows)
      expect(storedSceneNamed('beta').shows).toEqual(beta.shows)
      expect(latest().activeSavedSceneId).toBe(alpha.id)
      expect(latest().captureConfig.sources.windowId).toBe('window:alpha')
      expect(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).visual.sources.windowId).toBe(
        'window:alpha'
      )
      expect(canSaveScene()).toBe(true)
    } finally {
      release()
      await lateReload.catch(() => {})
    }
  }, 20_000)

  // A scene switch while recording waits up to 5 s for the recording to draw
  // it. When the window's engine connection closes during that wait (the
  // window closed, or a newer connection replaced it), nobody is looking at
  // that switch any more and connection recovery reads the scene again: no
  // "Couldn't confirm the scene change" toast. On a loaded CI runner the old
  // toast landed in whichever test ran next (the co-host and Sidekick flakes).
  it('says nothing about a scene switch whose engine connection closed while it waited for the recording', async () => {
    const backend = new StudioBackend()
    // The recording never reports drawing the new scene: the wait runs its course.
    backend.reportsActiveSceneRevision = false
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene() && latest().savedScenes.length >= 3)
    const cameraOnly = latest().savedScenes[2]
    await act(async () => latest().startSession())
    await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')

    const from = backend.sentCommands.length
    let switched: Promise<boolean> | undefined
    await act(async () => {
      switched = latest().applySavedScene(cameraOnly.id)
    })
    await waitForObservation(() =>
      backend.sentCommands
        .slice(from)
        .some((command) => command.method === 'scene.layout.apply_live')
    )
    const warn = vi.spyOn(console, 'warn')
    const unproven = (): boolean =>
      warn.mock.calls.some((call) => String(call[0]).includes('preview proof was not observed'))
    // The window goes away while the switch waits for the recording's proof.
    await act(async () => root?.unmount())
    root = null
    await vi.waitFor(() => expect(unproven()).toBe(true), { timeout: 8_000, interval: 50 })
    await switched?.catch(() => false)
    // A report goes out through the lazily loaded recovery module: load it
    // here too, so any report the switch made has landed before the check.
    await import('@/lib/session-runtime-recovery')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toastSpies.error).not.toHaveBeenCalled()
  }, 15_000)

  // Plan 231 D18: Camera only shows no screen, and going on stream leaves the
  // running capture as it is, so going back to a screen scene is a swap in
  // place. Idle and while recording.
  it.each(['live', 'failed'] as const)(
    'keeps an existing capture under a scene that shows no screen (plan 231 D18, %s)',
    async (screenState) => {
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
      const latest = (): StudioCoreContextValue => observations.at(-1)!.core
      root = await mountStudioProvider(testDom.container, (value) => {
        observations.push(value)
      })
      await waitForObservation(
        () =>
          canSaveScene() &&
          latest().captureConfig.sources.screenId != null &&
          latest().savedScenes[0].visual.sources.screenId != null
      )
      const screenId = latest().captureConfig.sources.screenId
      const [screenCamera, , cameraOnly] = latest().savedScenes
      expect(latest().activeSavedSceneId).toBe(screenCamera.id)
      // A new profile: the screen scenes show the main display, Camera only none (D3).
      expect(storedSceneNamed('Screen + camera').shows).toMatchObject({ kind: 'display', screenId })
      expect(storedSceneNamed('Camera only').shows).toEqual({ kind: 'none' })
      await act(async () =>
        [...backend.sockets].forEach((socket) =>
          socket.onmessage?.({
            data: JSON.stringify({
              event: 'preview.screen.status',
              payload: {
                state: screenState,
                sourceId: screenId,
                sourceKind: 'screen',
                targetFps: 30,
                framesCaptured: 10,
                droppedFrames: 0,
                includeCursor: true,
                excludeCurrentProcessWindows: true,
                updatedAt: new Date().toISOString()
              }
            })
          })
        )
      )
      const lastApply = (from: number) =>
        backend.sentCommands
          .slice(from)
          .filter((command) => command.method.startsWith('scene.layout.apply'))
          .at(-1) as
          | {
              method: string
              params: { layout: LayoutSettings; sources: SourceSelection; retainScreen?: true }
            }
          | undefined
      const switchTo = async (id: string): Promise<NonNullable<ReturnType<typeof lastApply>>> => {
        const from = backend.sentCommands.length
        await act(async () => {
          expect(await latest().applySavedScene(id)).toBe(true)
        })
        await waitForObservation(() => latest().activeSavedSceneId === id && canSaveScene())
        // The capture is never switched, stopped or restarted for it.
        expect(
          backend.sentCommands
            .slice(from)
            .some((command) =>
              ['session.source.switch', 'preview.screen.stop'].includes(command.method)
            )
        ).toBe(false)
        return lastApply(from)!
      }

      let apply = await switchTo(cameraOnly.id)
      expect(apply.params.retainScreen).toBe(screenState === 'live' ? true : undefined)
      expect(apply.params.layout.layoutPreset).toBe('camera-only')
      expect(apply.params.sources.screenId).toBe(screenId)
      expect(apply.params.sources.captureOff).not.toBe(true)
      expect(latest().captureConfig.sources.screenId).toBe(screenId)
      expect(latest().captureConfig.sources.captureOff).not.toBe(true)
      // An edit made on it saves its look; the screen under it is not its screen.
      await act(async () => latest().applyCameraPreset({ cameraZoom: 140 }))
      await waitForObservation(
        () => sceneNamed(latest(), 'Camera only').visual.layout.cameraZoom === 140
      )
      expect(storedSceneNamed('Camera only').shows).toEqual({ kind: 'none' })
      expect(latest().savedSceneModified).toBe(false)

      apply = await switchTo(screenCamera.id)
      expect(apply.params.layout.layoutPreset).toBe('screen-camera')
      expect(apply.params.sources.screenId).toBe(screenId)
      expect(storedSceneNamed('Screen + camera').shows).toMatchObject({ kind: 'display', screenId })

      await act(async () => latest().startSession())
      await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')
      apply = await switchTo(cameraOnly.id)
      expect(apply.method).toBe('scene.layout.apply_live')
      expect(apply.params.retainScreen).toBe(screenState === 'live' ? true : undefined)
      expect(apply.params.sources.screenId).toBe(screenId)
      expect(apply.params.sources.captureOff).not.toBe(true)
      expect(backend.confirmedSources.screenId).toBe(screenId)
      apply = await switchTo(screenCamera.id)
      expect(apply.params.sources.screenId).toBe(screenId)
      await act(async () => {
        expect(await latest().stopSession()).toBe(true)
      })
      await waitForObservation(
        () => canSaveScene() && observations.at(-1)?.recording.recording.state === 'idle'
      )
      // Sources → No screen is an explicit stop, even with a running owner.
      const beforeOff = backend.sentCommands.length
      await act(async () => {
        await latest().switchSourceDeviceLive('capture', {
          ...latest().captureConfig.sources,
          screenId: undefined,
          screenName: undefined,
          screenUuid: undefined,
          windowId: undefined,
          windowName: undefined,
          captureOff: true,
          testPattern: false
        })
        latest().applyCameraPreset({ layoutPreset: 'camera-only' })
      })
      await waitForObservation(
        () => canSaveScene() && latest().captureConfig.layout.layoutPreset === 'camera-only'
      )
      expect(lastApply(beforeOff)?.params.retainScreen).toBeUndefined()
      expect(lastApply(beforeOff)?.params.sources.captureOff).toBe(true)
    },
    30_000
  )

  // Plan 231 review #1: the vertical stream is a leg. A scene that shows
  // Camera only on the program and its own screen on the 9:16 leg goes on
  // with its own screen, which the backend starts for the leg; the screen an
  // earlier scene left running never shows under it.
  it('a scene whose vertical leg draws its screen goes on with its own screen (review #1)', async () => {
    const backend = new StudioBackend()
    backend.deviceList.devices.push(SECOND_DISPLAY)
    backend.recordingState = 'recording'
    backend.recordingSessionId = 'session-review-1'
    backend.confirmedSources = {
      ...backend.confirmedSources,
      screenId: FIRST_DISPLAY_ID,
      cameraId: 'camera:1'
    }
    backend.reportsActiveSceneRevision = true
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
    seedSceneLibrary(
      [
        libraryScene('desk', 'Desk', displayShows(FIRST_DISPLAY_ID, 'Display 1'), [
          'screen-camera',
          'vertical-camera-top'
        ]),
        libraryScene('board', 'Board', displayShows(SECOND_DISPLAY.id, 'Display 2'), [
          'camera-only',
          'vertical-screen-only'
        ])
      ],
      'desk'
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest().wsStatus === 'connected' &&
        observations.at(-1)?.recording.recording.state === 'recording' &&
        latest().captureConfig.sources.screenId === FIRST_DISPLAY_ID &&
        latest().deviceList.devices.some((device) => device.id === 'camera:1')
    )
    expect(latest().activeSavedSceneId).toBe('desk')
    await armVerticalStream(latest)
    await emitScreenStatus(backend, FIRST_DISPLAY_ID)
    const from = backend.sentCommands.length
    await act(async () => {
      expect(await latest().applySavedScene('board')).toBe(true)
    })
    await waitForObservation(
      () =>
        latest().activeSavedSceneId === 'board' &&
        latest().layoutSwitchPending == null &&
        layoutApplies(backend, from, true).length > 0
    )
    const [program] = layoutApplies(backend, from, false)
    expect(program!.params.layout.layoutPreset).toBe('camera-only')
    expect(program!.params.sources.screenId).toBe(SECOND_DISPLAY.id)
    expect(program!.params.verticalLegScreen).toBe(true)
    expect(program!.params.retainScreen).toBeUndefined()
    const leg = layoutApplies(backend, from, true).at(-1)!
    expect(leg.params.layout.layoutPreset).toBe('vertical-screen-only')
    expect(leg.params.sources.screenId).toBe(SECOND_DISPLAY.id)
    expect(latest().captureConfig.sources.screenId).toBe(SECOND_DISPLAY.id)
    expect(storedSceneNamed('Board').shows).toMatchObject({ screenId: SECOND_DISPLAY.id })
  }, 20_000)

  // Plan 231 review #1 and #4: a scene that drew no screen and kept the
  // capture another scene left running takes its own screen back when it
  // gets a layout that draws one; a scene that shows none is refused, never
  // given the screen it kept (D19).
  it('a layout that starts drawing a screen shows the scene’s own, never a kept one (review #1, #4)', async () => {
    const backend = new StudioBackend()
    backend.deviceList.devices.push(SECOND_DISPLAY)
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
    seedSceneLibrary(
      [
        libraryScene('desk', 'Desk', displayShows(FIRST_DISPLAY_ID, 'Display 1'), [
          'screen-camera',
          'vertical-camera-top'
        ]),
        libraryScene('board', 'Board', displayShows(SECOND_DISPLAY.id, 'Display 2'), [
          'camera-only',
          'vertical-camera-only'
        ]),
        libraryScene('break', 'Break', { kind: 'none' }, ['camera-only', 'vertical-camera-only'])
      ],
      'desk'
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () => canSaveScene() && latest().captureConfig.sources.screenId === FIRST_DISPLAY_ID
    )
    await emitScreenStatus(backend, FIRST_DISPLAY_ID)
    // Board shows no screen in Camera only: Desk's capture keeps running (D18).
    let from = backend.sentCommands.length
    await act(async () => {
      expect(await latest().applySavedScene('board')).toBe(true)
    })
    await waitForObservation(() => latest().activeSavedSceneId === 'board' && canSaveScene())
    let apply = layoutApplies(backend, from, false).at(-1)!
    expect(apply.params.sources.screenId).toBe(FIRST_DISPLAY_ID)
    expect(apply.params.retainScreen).toBe(true)
    // Screen + camera on Board: Board's own Display 2, never Desk's Display 1.
    from = backend.sentCommands.length
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'screen-camera' }))
    await waitForObservation(
      () =>
        canSaveScene() &&
        latest().activeSavedSceneId === 'board' &&
        latest().captureConfig.layout.layoutPreset === 'screen-camera'
    )
    apply = layoutApplies(backend, from, false).at(-1)!
    expect(apply.params.layout.layoutPreset).toBe('screen-camera')
    expect(apply.params.sources.screenId).toBe(SECOND_DISPLAY.id)
    expect(latest().captureConfig.sources.screenId).toBe(SECOND_DISPLAY.id)
    expect(storedSceneNamed('Board').shows).toMatchObject({ screenId: SECOND_DISPLAY.id })
    expect(storedSceneNamed('Board').layouts.horizontal.layoutPreset).toBe('screen-camera')
    expect(storedSceneNamed('Desk').shows).toMatchObject({ screenId: FIRST_DISPLAY_ID })

    // Break shows no screen: a screen layout asks for one, it never takes the
    // capture Board left running.
    await act(async () => {
      expect(await latest().applySavedScene('break')).toBe(true)
    })
    await waitForObservation(() => latest().activeSavedSceneId === 'break' && canSaveScene())
    from = backend.sentCommands.length
    toastSpies.warning.mockClear()
    await act(async () => latest().applyCameraPreset({ layoutPreset: 'screen-only' }))
    expect(toastSpies.warning).toHaveBeenCalledWith(
      '“Break” shows no screen. Choose one with Change screen… first.',
      expect.anything()
    )
    expect(layoutApplies(backend, from, false)).toEqual([])
    expect(latest().captureConfig.layout.layoutPreset).toBe('camera-only')
    expect(storedSceneNamed('Break').shows).toEqual({ kind: 'none' })
    expect(storedSceneNamed('Break').layouts.horizontal.layoutPreset).toBe('camera-only')
  }, 20_000)

  // Plan 231 review #2: a scene going on stream can't be deleted, while its
  // switch waits for its source and after the backend committed it while the
  // preview's proof is still on its way. The stream never names a scene the
  // library doesn't have.
  it('refuses to delete a scene while its switch is pending or unproven (review #2)', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let showPreview = false
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      nativePreview: {
        getWindowState: () =>
          showPreview
            ? previewWindowOpen({ x: 0, y: 0, width: 960, height: 540 })
            : previewWindowClosed,
        drainHostCommands: async () => nativePreviewStatus()
      }
    })
    const runtimeInfo = api.getRuntimeInfo
    api.getRuntimeInfo = async () => ({ ...(await runtimeInfo()), disableAutoPreview: true })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    const screenOnly = sceneNamed(latest(), 'Screen only')
    const sideBySide = sceneNamed(latest(), 'Side by side')
    const goingOn = 'This scene is going on stream. Try again in a moment.'

    // The switch waits for its source.
    const release = backend.deferResponse('scene.layout.apply_preview', BACKEND_RESPONSE)
    let switching: Promise<boolean> | undefined
    await act(async () => {
      switching = latest().applySavedScene(screenOnly.id)
    })
    await waitForObservation(() => latest().savedScenePendingId === screenOnly.id)
    toastSpies.warning.mockClear()
    await act(async () => {
      expect(await latest().deleteSavedScene(screenOnly.id)).toBe(false)
    })
    expect(toastSpies.warning).toHaveBeenCalledWith(goingOn, expect.anything())
    expect(storedLibrary().scenes.some((scene) => scene.id === screenOnly.id)).toBe(true)
    await act(async () => {
      release()
      expect(await switching).toBe(true)
    })
    await waitForObservation(() => canSaveScene() && latest().activeSavedSceneId === screenOnly.id)

    // Committed, while the preview's proof lags: still going on stream.
    showPreview = true
    api.getNativePreviewSurfaceStatus = async () => nativePreviewStatus()
    await act(async () => {
      expect(await latest().applySavedScene(sideBySide.id)).toBe(true)
    })
    expect(latest().activeSavedSceneId).toBe(screenOnly.id)
    toastSpies.warning.mockClear()
    await act(async () => {
      expect(await latest().deleteSavedScene(sideBySide.id)).toBe(false)
    })
    expect(toastSpies.warning).toHaveBeenCalledWith(goingOn, expect.anything())
    await waitForObservation(() => canSaveScene() && latest().activeSavedSceneId === sideBySide.id)
    expect(storedLibrary().scenes.some((scene) => scene.id === sideBySide.id)).toBe(true)
    expect(storedLibrary().onStreamId).toBe(sideBySide.id)
    showPreview = false
    // Settled: the scene that went on before can go now.
    await act(async () => {
      expect(await latest().deleteSavedScene(screenOnly.id)).toBe(true)
    })
    expect(storedLibrary().scenes.some((scene) => scene.id === screenOnly.id)).toBe(false)
  }, 20_000)

  // Plan 231 review #3: a remote's scene and screen together are one switch:
  // the scene it names goes on showing that screen, and the scene that was
  // on stream while the switch waited for the preview's proof keeps its own.
  it('a remote sceneId with a screenId puts that scene on with that screen (review #3)', async () => {
    const backend = new StudioBackend()
    backend.deviceList.devices.push(SECOND_DISPLAY)
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let showPreview = false
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      nativePreview: {
        getWindowState: () =>
          showPreview
            ? previewWindowOpen({ x: 0, y: 0, width: 960, height: 540 })
            : previewWindowClosed,
        drainHostCommands: async () => nativePreviewStatus()
      }
    })
    const runtimeInfo = api.getRuntimeInfo
    api.getRuntimeInfo = async () => ({ ...(await runtimeInfo()), disableAutoPreview: true })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () => canSaveScene() && latest().captureConfig.sources.screenId === FIRST_DISPLAY_ID
    )
    const onStream = latest().activeSavedSceneId!
    const before = storedLibrary().scenes.find((scene) => scene.id === onStream)!.shows
    const screenOnly = sceneNamed(latest(), 'Screen only')
    // The preview's proof lags, so the switch's identity lands late.
    showPreview = true
    api.getNativePreviewSurfaceStatus = async () => nativePreviewStatus()
    await act(async () => {
      for (const socket of backend.sockets)
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: {
              intentId: 'scene-and-screen',
              intent: { kind: 'sceneApply', sceneId: screenOnly.id, screenId: SECOND_DISPLAY.id }
            }
          })
        })
    })
    const ack = () =>
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId: string }).intentId === 'scene-and-screen'
      )?.params
    await waitForObservation(() => ack() !== undefined)
    expect(ack()).toEqual({ intentId: 'scene-and-screen', ok: true })
    await waitForObservation(() => canSaveScene() && latest().activeSavedSceneId === screenOnly.id)
    showPreview = false
    expect(storedSceneNamed('Screen only').shows).toMatchObject({
      kind: 'display',
      screenId: SECOND_DISPLAY.id
    })
    expect(storedLibrary().scenes.find((scene) => scene.id === onStream)!.shows).toEqual(before)
    expect(latest().captureConfig.sources.screenId).toBe(SECOND_DISPLAY.id)
    // One switch carried the screen: no Screen pick ran after it.
    expect(backend.sentCommands.some((command) => command.method === 'session.source.switch')).toBe(
      false
    )
  }, 20_000)

  // Plan 231 review #5: the launch that migrated stored the library, then
  // never stored its settings. The next launch saves the migrated keys from
  // the library again (the library is not made again), and lets them go once
  // the settings hold them.
  it('replays a shortcut migration whose settings were never stored (review #5)', async () => {
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
    const scenes = defaultScenes(
      { id: FIRST_DISPLAY_ID, name: 'Display 1', displayUuid: undefined },
      now
    ).map((scene) => (scene.id === 'default-side-by-side' ? { ...scene, name: 'Beside' } : scene))
    const migrated = {
      scenes: { 'default-screen-only': 'Control+F14', 'default-side-by-side': 'Control+F15' }
    }
    seedSceneLibrary(scenes, 'default-screen-camera', { pendingShortcuts: migrated })
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        animateSceneChanges: true,
        globalShortcuts: {
          layouts: { 'screen-only': 'Control+F14', 'side-by-side': 'Control+F15' }
        }
      })
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await waitForObservation(() => storedLibrary().pendingShortcuts === undefined)
    expect(latest().settings.globalShortcuts).toEqual(migrated)
    expect(latest().settings.animateSceneChanges).toBe(true)
    const settings = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings)!)
    expect(settings.globalShortcuts).toEqual(migrated)
    // The library stays the one stored: never made again.
    expect(storedLibrary().scenes.map((scene) => scene.name)).toEqual(
      scenes.map((scene) => scene.name)
    )
  })

  // Plan 231 review #6: a scene no leg draws a screen for needs no window of
  // its app. Camera only made for Figma, with Figma closed, is not blocked:
  // its card, its key and Next scene all reach it.
  it('never blocks a scene that shows no screen on its closed app (review #6)', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emit: (name: string, value: unknown) => void = () => {}
    const testDom = installProviderTestEnvironment(
      createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => [],
        registerEmitter: (next) => {
          emit = next
        }
      })
    )
    restoreEnvironment = testDom.restore
    const figma = {
      kind: 'app' as const,
      bundleId: 'com.figma.Desktop',
      name: 'Figma',
      follows: true
    }
    seedSceneLibrary(
      [
        libraryScene('desk', 'Desk', displayShows(FIRST_DISPLAY_ID, 'Display 1'), [
          'screen-camera',
          'vertical-camera-top'
        ]),
        libraryScene('figma-cam', 'Figma cam', figma, ['camera-only', 'vertical-camera-only']),
        libraryScene('figma', 'Figma', figma, ['screen-camera', 'vertical-camera-top'])
      ],
      'desk'
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () => canSaveScene() && latest().captureConfig.sources.screenId === FIRST_DISPLAY_ID
    )
    // Figma isn't open: only the scene that draws its window waits for it.
    expect(latest().savedSceneAppStates['figma-cam']).toBeUndefined()
    expect(latest().savedSceneAppStates['figma']).toBe('not-running')
    // Next scene from Desk: Figma cam, not "no other scene".
    toastSpies.info.mockClear()
    await act(async () => {
      emit('onGlobalShortcut', 'layout-next')
    })
    await waitForObservation(() => latest().activeSavedSceneId === 'figma-cam' && canSaveScene())
    expect(toastSpies.info).not.toHaveBeenCalledWith(
      'No other scene to switch to',
      expect.anything()
    )
    expect(
      backend.sentCommands.some((command) => command.method === 'sources.resolve_app_window')
    ).toBe(false)
    // Its own click as well, and Desk's screen keeps running under it (D18).
    await act(async () => {
      expect(await latest().applySavedScene('desk')).toBe(true)
    })
    await waitForObservation(() => latest().activeSavedSceneId === 'desk' && canSaveScene())
    await act(async () => {
      expect(await latest().applySavedScene('figma-cam')).toBe(true)
    })
    await waitForObservation(() => latest().activeSavedSceneId === 'figma-cam' && canSaveScene())
    expect(latest().captureConfig.sources.screenId).toBe(FIRST_DISPLAY_ID)
    expect(
      backend.sentCommands.some((command) => command.method === 'sources.resolve_app_window')
    ).toBe(false)
  }, 20_000)

  // Plan 231 D15: the launch that makes the scene library moves the layout
  // keys to scene keys and saves them with the settings, once.
  it('saves the migrated layout keys as scene keys once (plan 231 D15)', async () => {
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
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        animateSceneChanges: true,
        globalShortcuts: {
          layouts: { 'screen-only': 'Control+F14', 'side-by-side': 'Control+F15' }
        }
      })
    )
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    const keys = (name: string): string | undefined =>
      latest().settings.globalShortcuts?.scenes?.[sceneNamed(latest(), name).id]
    expect(keys('Screen only')).toBe('Control+F14')
    expect(keys('Side by side')).toBe('Control+F15')
    expect(latest().settings.globalShortcuts?.layouts).toBeUndefined()
    // The other settings are untouched, and the keys are stored with them.
    expect(latest().settings.animateSceneChanges).toBe(true)
    await waitForObservation(
      () =>
        JSON.parse(localStorage.getItem(STORAGE_KEYS.settings)!).globalShortcuts?.scenes?.[
          sceneNamed(latest(), 'Screen only').id
        ] === 'Control+F14'
    )
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEYS.settings)!).globalShortcuts.layouts
    ).toBeUndefined()

    // The streamer changes a key: the next launch keeps it, and migrates nothing.
    await act(async () =>
      latest().setSettings((current) => ({
        ...current,
        globalShortcuts: {
          ...current.globalShortcuts,
          scenes: {
            ...current.globalShortcuts?.scenes,
            [sceneNamed(latest(), 'Screen only').id]: 'Control+F16'
          }
        }
      }))
    )
    await waitForObservation(() => keys('Screen only') === 'Control+F16')
    await act(async () => root!.unmount())
    observations.length = 0
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    expect(keys('Screen only')).toBe('Control+F16')
    expect(keys('Side by side')).toBe('Control+F15')
    expect(latest().settings.globalShortcuts?.layouts).toBeUndefined()
  })

  it('keeps named metadata and the committed background when native presentation proof times out', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let showPreview = false
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      nativePreview: {
        getWindowState: () =>
          showPreview
            ? previewWindowOpen({ x: 0, y: 0, width: 960, height: 540 })
            : previewWindowClosed,
        drainHostCommands: async () => nativePreviewStatus()
      }
    })
    const runtimeInfo = api.getRuntimeInfo
    api.getRuntimeInfo = async () => ({ ...(await runtimeInfo()), disableAutoPreview: true })
    api.backgroundAssetExists = async () => true
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => canSaveScene())
    await act(async () => latest().applyBackgroundSlot('bg-01'))
    await waitForObservation(
      () => latest().scene?.background?.assetId === 'builtin-bg-01' && canSaveScene()
    )
    await act(async () => {
      expect(saveScene('Native A')).toBe(true)
    })
    const saved = sceneNamed(latest(), 'Native A')
    // Plan 231 D11: Native B goes on stream first, so the new background
    // saves into it and not into Native A.
    await act(async () => {
      expect(saveScene('Native B')).toBe(true)
    })
    await act(async () => latest().applyBackgroundSlot('bg-02'))
    await waitForObservation(
      () =>
        latest().scene?.background?.assetId === 'builtin-bg-02' &&
        canSaveScene() &&
        sceneNamed(latest(), 'Native B').visual.background?.assetId === 'builtin-bg-02'
    )
    const memory = latest().captureConfig.layoutFramingMemory
    showPreview = true
    // A real stale native status exhausts the provider's bounded proof wait.
    api.getNativePreviewSurfaceStatus = async () => nativePreviewStatus()
    await act(async () => {
      expect(await latest().applySavedScene(saved.id)).toBe(true)
    })
    // Plan 174 S2.4, plan 250: a lagging preview is neutral news, so it is
    // an entry behind the bell and never a pop-up.
    await waitForObservation(() => canSaveScene() && notification('preview-behind') !== undefined)
    expect(latest().activeSavedSceneId).toBe(saved.id)
    expect(latest().scene?.background?.assetId).toBe('builtin-bg-01')
    expect(latest().captureConfig.layoutFramingMemory).toEqual(memory)
    expect(JSON.parse(localStorage.getItem(WORKING_SCENE_KEY)!).sceneId).toBe(saved.id)
    expect(notification('preview-behind')).toMatchObject({
      tone: 'news',
      title: 'The preview may be behind'
    })
    expect(toastSpies.info).not.toHaveBeenCalled()
    showPreview = false
    api.getNativePreviewSurfaceStatus = async () => nativePreviewStatus()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
  }, 10000)

  // Plan 231 D4: one list in both orientations. The 16:9 / 9:16 toggle puts
  // the scene on stream on in its own 9:16 layout, the list keeps every scene
  // in its order, each drawn in its 9:16 layout, and a switch in a 9:16
  // studio applies that scene's 9:16 layout.
  it('a 9:16 studio lists the same scenes in their own 9:16 layouts (plan 231 D4)', async () => {
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
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        canSaveScene() &&
        latest().captureConfig.sources.screenId != null &&
        latest().captureConfig.sources.cameraId != null
    )
    const ids = latest().savedScenes.map((scene) => scene.id)
    const screenCamera = sceneNamed(latest(), 'Screen + camera')
    const cameraOnly = sceneNamed(latest(), 'Camera only')
    expect(latest().activeSavedSceneId).toBe(screenCamera.id)

    // The toggle names the orientation; the scene goes on in its own layout.
    await act(async () => {
      latest().applyCameraPreset(
        { layoutPreset: ORIENTATION_DEFAULT_PRESET.vertical },
        { toOrientation: true }
      )
    })
    await waitForObservation(
      () =>
        latest().captureConfig.layout.layoutPreset === 'vertical-camera-top' &&
        latest().layoutSwitchPending == null &&
        canSaveScene()
    )
    expect(latest().captureConfig.video.height).toBeGreaterThan(latest().captureConfig.video.width)
    expect(latest().activeSavedSceneId).toBe(screenCamera.id)
    expect(latest().savedScenes.map((scene) => scene.id)).toEqual(ids)
    expect(latest().savedScenes.map((scene) => scene.visual.layout.layoutPreset)).toEqual(
      ids.map(
        (id) =>
          storedLibrary().scenes.find((scene) => scene.id === id)!.layouts.vertical.layoutPreset
      )
    )

    // A switch in a 9:16 studio applies the scene's own 9:16 layout.
    const from = backend.sentCommands.length
    await act(async () => {
      expect(await latest().applySavedScene(cameraOnly.id)).toBe(true)
    })
    await waitForObservation(() => latest().activeSavedSceneId === cameraOnly.id && canSaveScene())
    const apply = backend.sentCommands
      .slice(from)
      .filter((command) => command.method.startsWith('scene.layout.apply'))
      .at(-1) as { params: { layout: LayoutSettings } }
    expect(apply.params.layout.layoutPreset).toBe('vertical-camera-only')
    expect(latest().captureConfig.layout.layoutPreset).toBe('vertical-camera-only')
    // Each scene keeps its 16:9 layout for the way back.
    expect(storedSceneNamed('Camera only').layouts.horizontal.layoutPreset).toBe('camera-only')
    expect(storedSceneNamed('Screen + camera').layouts.horizontal.layoutPreset).toBe(
      'screen-camera'
    )
  }, 15_000)

  // Plan 231 D4: one scene, both orientations. The vertical stream shows the
  // scene on stream in its own 9:16 layout, so one switch (a click or a key)
  // cuts both legs to the same scene, and the Vertical stream panel edits
  // that scene's 9:16 layout.
  it('cuts both legs to the same scene on one switch, each in its own layout (plan 231 D4)', async () => {
    const backend = new StudioBackend()
    backend.recordingState = 'recording'
    backend.recordingSessionId = 'session-vertical'
    backend.confirmedSources = {
      ...backend.confirmedSources,
      screenId: 'screen:dxgi:0000000000000001:1',
      cameraId: 'camera:1'
    }
    backend.reportsActiveSceneRevision = true
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    let emit: (name: string, value: unknown) => void = () => {}
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (next) => {
        emit = next
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
        latest()?.recording.recording.state === 'recording' &&
        latest()?.core.captureConfig.sources.screenId != null &&
        latest()?.core.captureConfig.sources.cameraId != null &&
        latest()?.core.deviceList.devices.some((device) => device.id === 'camera:1') === true
    )
    // A new profile's scenes: Screen + camera (on stream, 9:16 Camera top)
    // and Camera only (9:16 Camera only) among them.
    const screenCamera = sceneNamed(latest()!.core, 'Screen + camera')
    const cameraOnly = sceneNamed(latest()!.core, 'Camera only')
    expect(latest()!.core.activeSavedSceneId).toBe(screenCamera.id)
    expect(latest()!.core.sceneOnStream?.layouts.vertical.layoutPreset).toBe('vertical-camera-top')

    // A live horizontal program with the YouTube Vertical leg armed on its
    // own key. The settings that steered the leg before plan 231 say
    // otherwise: they steer nothing now.
    const config = latest()!.core.captureConfig
    await act(async () => {
      latest()!.core.setCaptureConfig({
        ...config,
        streamEnabled: true,
        lastVerticalPreset: 'vertical-camera-bottom',
        simulcastFollowsProgram: false,
        simulcastScreenFraming: 'fill',
        streaming: {
          ...config.streaming,
          enabled: true,
          enabledTargetIds: ['youtube', 'youtube-vertical'],
          targets: config.streaming.targets.map((target) =>
            target.id === 'youtube' || target.id === 'youtube-vertical'
              ? { ...target, enabled: true, streamKey: `key-${target.id}`, streamKeyPresent: true }
              : target
          )
        }
      })
    })
    await waitForObservation(() => latest()?.core.captureConfig.streaming.enabled === true)

    const programApplies = (from: number) =>
      backend.sentCommands
        .slice(from)
        .filter(
          (command) =>
            command.method === 'scene.layout.apply_live' &&
            (command.params as { simulcastLeg?: boolean }).simulcastLeg !== true
        )
    const legApplies = (from: number) =>
      backend.sentCommands
        .slice(from)
        .filter(
          (command) =>
            command.method === 'scene.layout.apply_live' &&
            (command.params as { simulcastLeg?: boolean }).simulcastLeg === true
        )
    const layoutOf = (command: { params?: unknown }) =>
      (command.params as { layout: LayoutSettings }).layout

    // The Vertical stream panel, from this 16:9 studio: the scene on
    // stream's 9:16 layout, saved into the scene and sent to the leg only.
    const panelEdit = (patch: Parameters<typeof editVerticalStreamLayout>[1]): void => {
      expect(editVerticalStreamLayout(latest()!.core, patch)).toBe(true)
    }
    let from = backend.sentCommands.length
    await act(async () => {
      panelEdit({ layoutPreset: 'vertical-split' })
    })
    await waitForObservation(() => legApplies(from).length === 1)
    expect(layoutOf(legApplies(from)[0]!)).toMatchObject({
      layoutPreset: 'vertical-split',
      verticalScreenFraming: 'fit'
    })
    expect(storedSceneNamed('Screen + camera').layouts.vertical).toMatchObject({
      layoutPreset: 'vertical-split',
      verticalScreenFraming: 'fit'
    })
    expect(storedSceneNamed('Screen + camera').layouts.horizontal.layoutPreset).toBe(
      'screen-camera'
    )
    await waitForObservation(
      () => latest()?.core.sceneOnStream?.layouts.vertical.layoutPreset === 'vertical-split'
    )
    from = backend.sentCommands.length
    await act(async () => {
      panelEdit({ verticalScreenFraming: 'fill' })
    })
    await waitForObservation(() => legApplies(from).length === 1)
    expect(layoutOf(legApplies(from)[0]!)).toMatchObject({
      layoutPreset: 'vertical-split',
      verticalScreenFraming: 'fill'
    })
    expect(storedSceneNamed('Screen + camera').layouts.vertical.verticalScreenFraming).toBe('fill')
    expect(programApplies(0)).toEqual([])
    expect(latest()!.core.captureConfig.layout.layoutPreset).toBe('screen-camera')

    // One switch by click: the program commits Camera only, then the leg
    // takes Camera only's own 9:16 layout. No frame of the old scene's leg
    // layout follows the program's commit.
    from = backend.sentCommands.length
    await act(async () => {
      expect(await latest()!.core.applySavedScene(cameraOnly.id)).toBe(true)
    })
    await waitForObservation(
      () =>
        latest()?.core.activeSavedSceneId === cameraOnly.id &&
        latest()?.core.layoutSwitchPending == null
    )
    const clickProgram = programApplies(from)
    const clickLeg = legApplies(from)
    expect(clickProgram.map((command) => layoutOf(command).layoutPreset)).toEqual(['camera-only'])
    expect(clickLeg.map((command) => layoutOf(command).layoutPreset)).toEqual([
      'vertical-camera-only'
    ])
    expect(backend.sentCommands.indexOf(clickLeg[0]!)).toBeGreaterThan(
      backend.sentCommands.indexOf(clickProgram[0]!)
    )

    // One switch by key: both legs back on Screen + camera, the vertical one
    // in the 9:16 layout the panel gave it.
    from = backend.sentCommands.length
    await act(async () => {
      emit('onGlobalShortcut', 'scene-slot-1')
    })
    await waitForObservation(
      () =>
        latest()?.core.activeSavedSceneId === screenCamera.id &&
        latest()?.core.layoutSwitchPending == null &&
        legApplies(from).length > 0
    )
    const keyProgram = programApplies(from)
    const keyLeg = legApplies(from)
    expect(keyProgram.map((command) => layoutOf(command).layoutPreset)).toEqual(['screen-camera'])
    expect(keyLeg.map((command) => layoutOf(command).layoutPreset)).toEqual(['vertical-split'])
    expect(layoutOf(keyLeg[0]!).verticalScreenFraming).toBe('fill')
    expect(backend.sentCommands.indexOf(keyLeg[0]!)).toBeGreaterThan(
      backend.sentCommands.indexOf(keyProgram[0]!)
    )

    // A fast double switch: Camera only, then straight back before the first
    // commit returns. Each commit sends its own scene's leg, in commit order,
    // so the leg ends on the scene the program ends on.
    backend.layoutResponseDelayMs = 150
    from = backend.sentCommands.length
    await act(async () => {
      emit('onGlobalShortcut', 'scene-slot-3')
    })
    await waitForObservation(() => programApplies(from).length > 0)
    await act(async () => emit('onGlobalShortcut', 'scene-slot-1'))
    await waitForObservation(
      () =>
        latest()?.core.layoutSwitchPending == null &&
        latest()?.core.activeSavedSceneId === screenCamera.id &&
        latest()?.core.captureConfig.layout.layoutPreset === 'screen-camera'
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(backend.simulcastLegLayouts.at(-1)).toMatchObject({
      layoutPreset: 'vertical-split',
      verticalScreenFraming: 'fill'
    })
    expect(backend.currentLayout.layoutPreset).toBe('screen-camera')
    expect(
      toastSpies.info.mock.calls.some(([message]) => message === "That scene couldn't be applied")
    ).toBe(false)
    // Leg requests are explicit and never reach the program.
    for (const command of backend.sentCommands) {
      if (command.method !== 'scene.layout.apply_live') continue
      const params = command.params as { simulcastLeg?: boolean; layout: LayoutSettings }
      expect(params.layout.layoutPreset.startsWith('vertical-')).toBe(params.simulcastLeg === true)
    }
    // Drain: every response lands before unmount, so nothing from this test
    // can surface later, and the whole run stayed free of error toasts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(toastSpies.error).not.toHaveBeenCalled()
  }, 15_000)

  // Plan 080 S4: the Studio Camera row's Off must stick. Device reconcile
  // used to refill an empty camera slot with the first camera.
  it('keeps camera Off through a device refresh, and a live Off is recorded as intent', async () => {
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
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.cameraId === 'camera:1'
    )
    const cameras = latest()!.core.deviceList.devices.filter((device) => device.kind === 'camera')

    await act(async () => {
      await latest()!.core.switchSourceDeviceLive(
        'camera',
        buildCameraSources(latest()!.core.captureConfig.sources, cameras, undefined)
      )
    })
    expect(latest()?.core.captureConfig.sources.cameraId).toBeUndefined()
    expect(latest()?.core.captureConfig.sources.cameraOff).toBe(true)

    await act(async () => {
      await latest()!.core.refreshBackend({ fresh: true })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(latest()?.core.captureConfig.sources.cameraId).toBeUndefined()
    expect(latest()?.core.captureConfig.sources.cameraOff).toBe(true)

    // Picking the camera again ends Off.
    await act(async () => {
      await latest()!.core.switchSourceDeviceLive(
        'camera',
        buildCameraSources(latest()!.core.captureConfig.sources, cameras, 'camera:1')
      )
    })
    expect(latest()?.core.captureConfig.sources.cameraId).toBe('camera:1')
    expect(latest()?.core.captureConfig.sources.cameraOff).toBeUndefined()
  }, 15_000)

  it('keeps source pickers enabled on a buffer-only session and re-arms with the new microphone', async () => {
    const backend = new StudioBackend()
    backend.sourceCapabilities = [
      {
        kind: 'capture',
        supported: false,
        reason: "Changing the screen during a session isn't available on Linux yet."
      },
      {
        kind: 'camera',
        supported: false,
        reason: "Changing the camera during a session isn't available on Linux yet."
      },
      {
        kind: 'microphone',
        supported: false,
        reason: 'Live microphone replacement is not available on Linux yet.'
      }
    ]
    backend.deviceList = {
      ...backend.deviceList,
      devices: [
        ...backend.deviceList.devices,
        { id: 'mic:2', name: 'Microphone 2', kind: 'microphone', status: 'available' }
      ]
    }
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
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1' &&
        latest()?.core.recordBlockedReason == null
    )
    await act(async () => latest()!.replay.setEnabled(true))
    await waitForObservation(() => latest()?.recording.recording.replayOnly === true)
    expect(latest()?.core.audioBusActive).toBe(true)
    expect(latest()?.core.isSessionActive).toBe(false)
    expect(latest()?.core.sourceSwitchReason('capture')).toBeNull()
    expect(latest()?.core.sourceSwitchReason('camera')).toBeNull()
    expect(latest()?.core.sourceSwitchReason('microphone')).toBeNull()

    const microphones = latest()!.core.deviceList.devices.filter(
      (device) => device.kind === 'microphone'
    )
    const startsBefore = backend.sentCommands.filter(
      (command) => command.method === 'session.start'
    ).length
    await act(async () => {
      await latest()!.core.switchSourceDeviceLive(
        'microphone',
        buildMicrophoneSources(latest()!.core.captureConfig.sources, microphones, 'mic:2')
      )
    })
    await waitForObservation(() => latest()?.core.captureConfig.sources.microphoneId === 'mic:2')
    expect(backend.sentCommands.some((command) => command.method === 'session.source.switch')).toBe(
      false
    )
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'session.stop')
    )
    await waitForObservation(() => {
      const starts = backend.sentCommands.filter((command) => command.method === 'session.start')
      const rearm = starts.at(-1)
      return (
        starts.length > startsBefore &&
        (rearm?.params as { sources?: { microphoneId?: string } } | undefined)?.sources
          ?.microphoneId === 'mic:2'
      )
    })
    expect(latest()?.recording.recording.replayOnly).toBe(true)
    expect(latest()?.core.audioBusActive).toBe(true)
    expect(latest()?.core.isSessionActive).toBe(false)
    expect(latest()?.core.sourceSwitchReason('microphone')).toBeNull()
  }, 15_000)

  // The ring holds the session while the camera is turned off, so the idle
  // scene reload skips it. The ring used to re-arm before that reload ran:
  // the scene kept the camera and the look never confirmed (Save stayed off).
  it('loads a camera Off picked during a buffer-only session before the ring re-arms', async () => {
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
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.cameraId === 'camera:1' &&
        latest()?.core.recordBlockedReason == null
    )
    // A scene without the camera, so turning it off leaves nothing to block.
    await act(async () => latest()!.core.applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => latest()?.core.captureConfig.layout.layoutPreset === 'screen-only' && canSaveScene()
    )
    await act(async () => latest()!.replay.setEnabled(true))
    await waitForObservation(
      () => latest()?.recording.recording.replayOnly === true && canSaveScene()
    )

    const cameras = latest()!.core.deviceList.devices.filter((device) => device.kind === 'camera')
    const commandsBefore = backend.sentCommands.length
    await act(async () => {
      await latest()!.core.switchSourceDeviceLive(
        'camera',
        buildCameraSources(latest()!.core.captureConfig.sources, cameras, undefined)
      )
    })
    await waitForObservation(() =>
      backend.sentCommands
        .slice(commandsBefore)
        .some((command) => command.method === 'session.start')
    )
    const after = backend.sentCommands.slice(commandsBefore)
    const load = after.findIndex(
      (command) =>
        command.method === 'scene.load_from_capture_config' &&
        (command.params as { sources?: SourceSelection }).sources?.cameraOff === true
    )
    const stop = after.findIndex((command) => command.method === 'session.stop')
    const rearm = after.findIndex((command) => command.method === 'session.start')
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(load).toBeGreaterThan(stop)
    expect(load).toBeLessThan(rearm)
    expect((after[rearm]!.params as { sources?: SourceSelection }).sources?.cameraOff).toBe(true)
    await waitForObservation(
      () => latest()?.recording.recording.replayOnly === true && canSaveScene()
    )
  }, 15_000)

  // The ring's own start answers after the pick (ogre, 2026-11-06): that start
  // carried the old camera, and the idle reload skipped the ring it started.
  it('restarts a buffer-only ring on a camera Off picked while its start is in flight', async () => {
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
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.cameraId === 'camera:1' &&
        latest()?.core.recordBlockedReason == null
    )
    await act(async () => latest()!.core.applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => latest()?.core.captureConfig.layout.layoutPreset === 'screen-only' && canSaveScene()
    )
    const releaseStart = backend.deferResponse('session.start', BACKEND_RESPONSE)
    await act(async () => latest()!.replay.setEnabled(true))
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'session.start')
    )

    const cameras = latest()!.core.deviceList.devices.filter((device) => device.kind === 'camera')
    await act(async () => {
      await latest()!.core.switchSourceDeviceLive(
        'camera',
        buildCameraSources(latest()!.core.captureConfig.sources, cameras, undefined)
      )
    })
    await waitForObservation(() => latest()?.core.captureConfig.sources.cameraOff === true)
    const commandsBefore = backend.sentCommands.length
    await act(async () => {
      releaseStart()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands
        .slice(commandsBefore)
        .some((command) => command.method === 'session.start')
    )
    const after = backend.sentCommands.slice(commandsBefore)
    const stop = after.findIndex((command) => command.method === 'session.stop')
    const load = after.findIndex(
      (command) =>
        command.method === 'scene.load_from_capture_config' &&
        (command.params as { sources?: SourceSelection }).sources?.cameraOff === true
    )
    const rearm = after.findIndex((command) => command.method === 'session.start')
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(load).toBeGreaterThan(stop)
    expect(load).toBeLessThan(rearm)
    expect((after[rearm]!.params as { sources?: SourceSelection }).sources?.cameraOff).toBe(true)
    await waitForObservation(
      () =>
        latest()?.recording.recording.replayOnly === true &&
        backend.confirmedSources.cameraOff === true &&
        canSaveScene()
    )
  }, 15_000)

  // Clips waits for the Screen Recording grant, and turning the screen off
  // ends the wait with the ring idle between sessions: its start (150 ms) used
  // to overtake the idle scene reload (250 ms), carry the old scene and,
  // holding the session, cancel that reload, so Save stayed off (ogre,
  // 2026-11-06: a camera Off while the ring waited to re-arm).
  it('loads a screen Off picked while the ring is idle before the ring starts', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      getMediaAccessStatus: async () => ({
        camera: 'granted',
        microphone: 'granted',
        screen: 'not-determined'
      })
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
        latest()?.core.captureConfig.sources.cameraId === 'camera:1' &&
        latest()?.core.mediaAccess?.screen === 'not-determined'
    )
    // A scene without the screen, so turning it off leaves nothing to block.
    await act(async () => latest()!.core.applyCameraPreset({ layoutPreset: 'camera-only' }))
    await waitForObservation(
      () => latest()?.core.captureConfig.layout.layoutPreset === 'camera-only' && canSaveScene()
    )
    await act(async () => latest()!.replay.setEnabled(true))
    await waitForObservation(
      () => latest()?.replay.armed === true && latest()?.replay.waitReason != null
    )
    expect(backend.sentCommands.some((command) => command.method === 'session.start')).toBe(false)

    const screens = latest()!.core.deviceList.devices.filter((device) => device.kind === 'screen')
    const commandsBefore = backend.sentCommands.length
    await act(async () => {
      await latest()!.core.switchSourceDeviceLive(
        'capture',
        buildCaptureSources(latest()!.core.captureConfig.sources, screens, undefined)
      )
    })
    await waitForObservation(() =>
      backend.sentCommands
        .slice(commandsBefore)
        .some((command) => command.method === 'session.start')
    )
    const after = backend.sentCommands.slice(commandsBefore)
    const load = after.findIndex(
      (command) =>
        command.method === 'scene.load_from_capture_config' &&
        (command.params as { sources?: SourceSelection }).sources?.captureOff === true
    )
    const start = after.findIndex((command) => command.method === 'session.start')
    expect(load).toBeGreaterThanOrEqual(0)
    expect(load).toBeLessThan(start)
    expect((after[start]!.params as { sources?: SourceSelection }).sources?.captureOff).toBe(true)
    await waitForObservation(
      () => latest()?.recording.recording.replayOnly === true && canSaveScene()
    )
  }, 15_000)

  // 0.36.1 release pass: the backend commits a session.start's scene as the
  // session starts, and the Studio's scene takes a layout transaction only
  // once its proof lands. A ring start between the two put the old scene back
  // (an agent's background answered "Silk is on the scene" over a scene
  // without one; a Freeform entry kept the previous layout's rectangle).
  const ringScene = (command: BackendCommand | undefined) =>
    (command?.params as { scene?: Scene } | undefined)?.scene
  const liveBackgroundId = (background: unknown) =>
    (background as Scene['background'] | null | undefined)?.live?.id
  const isLayoutApply = (command: BackendCommand) =>
    (command.method === 'scene.layout.apply_preview' ||
      command.method === 'scene.layout.apply_live') &&
    (command.params as { simulcastLeg?: boolean }).simulcastLeg !== true

  it('holds the Clips ring start while a scene change awaits its proof, then starts it with that scene', async () => {
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
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.cameraId === 'camera:1' &&
        latest()?.core.recordBlockedReason == null
    )
    await act(async () => latest()!.core.applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => latest()?.core.captureConfig.layout.layoutPreset === 'screen-only' && canSaveScene()
    )

    const commandsBefore = backend.sentCommands.length
    const releaseApply = backend.deferResponse('scene.layout.apply_preview', BACKEND_RESPONSE)
    await act(async () => {
      void latest()!.core.applyLiveBackground('silk')
    })
    await waitForObservation(() => backend.sentCommands.slice(commandsBefore).some(isLayoutApply))
    await act(async () => latest()!.replay.setEnabled(true))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(
      backend.sentCommands
        .slice(commandsBefore)
        .some((command) => command.method === 'session.start')
    ).toBe(false)

    await act(async () => {
      releaseApply()
      await Promise.resolve()
    })
    await waitForObservation(() =>
      backend.sentCommands
        .slice(commandsBefore)
        .some((command) => command.method === 'session.start')
    )
    const start = backend.sentCommands
      .slice(commandsBefore)
      .find((command) => command.method === 'session.start')
    expect(liveBackgroundId(ringScene(start)?.background)).toBe('silk')
    await waitForObservation(() => latest()?.recording.recording.replayOnly === true)
  }, 15_000)

  it('runs a scene change asked for while the Clips ring starts once the start answers, on its session', async () => {
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
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' &&
        latest()?.core.captureConfig.sources.cameraId === 'camera:1' &&
        latest()?.core.recordBlockedReason == null
    )
    await act(async () => latest()!.core.applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => latest()?.core.captureConfig.layout.layoutPreset === 'screen-only' && canSaveScene()
    )

    const releaseStart = backend.deferResponse('session.start', BACKEND_RESPONSE)
    await act(async () => latest()!.replay.setEnabled(true))
    await waitForObservation(() =>
      backend.sentCommands.some((command) => command.method === 'session.start')
    )
    const commandsBefore = backend.sentCommands.length
    let committed: Promise<unknown> | undefined
    await act(async () => {
      committed = Promise.resolve(latest()!.core.applyLiveBackground('silk'))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    // Sent now, it would commit before the start's scene commit and be lost.
    expect(backend.sentCommands.slice(commandsBefore).some(isLayoutApply)).toBe(false)

    await act(async () => {
      releaseStart()
      await Promise.resolve()
    })
    await waitForObservation(() => backend.sentCommands.slice(commandsBefore).some(isLayoutApply))
    const apply = backend.sentCommands.slice(commandsBefore).find(isLayoutApply)!
    // The ring's session is running now: the change goes to it.
    expect(apply.method).toBe('scene.layout.apply_live')
    expect(liveBackgroundId((apply.params as { background?: unknown }).background)).toBe('silk')
    await act(async () => {
      await committed
    })
    await waitForObservation(() => liveBackgroundId(backend.currentScene.background) === 'silk')
  }, 15_000)

  // Release pass 2026-11-23 (smoke:freeform-editor, mask law): Screen only
  // from a portrait scene crosses the orientation, so the ring stops, the
  // layout lands and the ring re-arms 150 ms after the next commit's proof.
  // A commit reached the Studio's refs only at the render after it, so on a
  // busy renderer the re-armed ring's start sent the layout and the scene
  // from before the Freeform entry; the backend commits a start's scene, and
  // the camera left it. The act scope below holds those renders back.
  it('keeps a Freeform entry, camera and all, when the Clips ring re-arms before the Studio renders it', async () => {
    const backend = new StudioBackend()
    backend.sessionStartCommitsScene = true
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
        latest()?.core.captureConfig.sources.cameraId === 'camera:1' &&
        latest()?.core.recordBlockedReason == null
    )
    // Selecting a stage source turns edit mode on: the ring's start carries the scene.
    await act(async () => latest()!.core.setSceneEditMode(true))
    await act(async () =>
      latest()!.core.applyCameraPreset({ layoutPreset: 'vertical-screen-only' })
    )
    await waitForObservation(
      () =>
        latest()?.core.captureConfig.layout.layoutPreset === 'vertical-screen-only' &&
        canSaveScene()
    )
    await act(async () => latest()!.replay.setEnabled(true))
    await waitForObservation(() => latest()?.recording.recording.replayOnly === true)

    backend.layoutResponseDelayMs = 100
    backend.sessionStartResponseDelayMs = 500
    await act(async () => latest()!.core.applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => latest()?.core.captureConfig.layout.layoutPreset === 'screen-only' && canSaveScene()
    )
    const commandsBefore = backend.sentCommands.length
    await act(async () => {
      latest()!.core.applyCameraPreset({
        arrangementMode: 'freeform',
        sourceTransformOverrides: {}
      })
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    })
    await waitForObservation(
      () =>
        latest()?.core.captureConfig.layout.arrangementMode === 'freeform' &&
        latest()?.recording.recording.replayOnly === true
    )

    const after = backend.sentCommands.slice(commandsBefore)
    const start = after.find((command) => command.method === 'session.start')
    expect(start).toBeDefined()
    expect((start!.params as { layout: LayoutSettings }).layout.arrangementMode).toBe('freeform')
    expect(ringScene(start)?.sources.find((source) => source.kind === 'camera')?.visible).toBe(true)
    expect(backend.currentLayout.arrangementMode).toBe('freeform')
    expect(backend.currentScene.sources.find((source) => source.kind === 'camera')?.visible).toBe(
      true
    )
  }, 15_000)

  // The same race on a Record or Go Live click (after #1640): their
  // session.start carries the scene as the Studio held it too, and the
  // backend commits it as the session starts.
  const mountForStartRace = async (start: 'record' | 'live') => {
    const backend = new StudioBackend()
    if (start === 'live') enableYouTubeOauthForTest(backend)
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
        latest()?.core.captureConfig.sources.cameraId === 'camera:1' &&
        latest()?.core.recordBlockedReason == null
    )
    await act(async () => latest()!.core.applyCameraPreset({ layoutPreset: 'screen-only' }))
    await waitForObservation(
      () => latest()?.core.captureConfig.layout.layoutPreset === 'screen-only' && canSaveScene()
    )
    if (start === 'live') {
      // Go Live's checks run and its dialog opens before the scene work: the
      // click under test is the dialog's Go Live.
      await act(async () => {
        const current = latest()!.core.captureConfig
        latest()!.core.setCaptureConfig({
          ...youtubeOauthStreamCaptureConfig(),
          layout: current.layout,
          sources: current.sources
        })
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
    const clickStart = (): Promise<unknown> =>
      start === 'live' ? latest()!.core.confirmGoLive() : latest()!.core.startRecording()
    return { backend, latest, clickStart }
  }
  const sessionStarts = (commands: BackendCommand[]) =>
    commands.filter((command) => command.method === 'session.start')

  it.each(['record', 'live'] as const)(
    'holds a %s start while a scene change awaits its proof, then starts it with that scene',
    async (start) => {
      const { backend, latest, clickStart } = await mountForStartRace(start)
      const commandsBefore = backend.sentCommands.length
      const releaseApply = backend.deferResponse('scene.layout.apply_preview', BACKEND_RESPONSE)
      await act(async () => {
        void latest()!.core.applyLiveBackground('silk')
      })
      await waitForObservation(() => backend.sentCommands.slice(commandsBefore).some(isLayoutApply))
      let started: Promise<unknown> | undefined
      await act(async () => {
        started = clickStart()
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400))
      })
      // Sent now, it would commit the scene the change is leaving.
      expect(sessionStarts(backend.sentCommands.slice(commandsBefore))).toHaveLength(0)

      await act(async () => {
        releaseApply()
        await Promise.resolve()
      })
      await waitForObservation(
        () => sessionStarts(backend.sentCommands.slice(commandsBefore)).length > 0
      )
      const sent = sessionStarts(backend.sentCommands.slice(commandsBefore))
      expect(sent).toHaveLength(1)
      expect(liveBackgroundId(ringScene(sent[0])?.background)).toBe('silk')
      await act(async () => {
        await started
      })
      await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    },
    20_000
  )

  it.each(['record', 'live'] as const)(
    'runs a scene change asked for while a %s start is in flight once the start answers, on its session',
    async (start) => {
      const { backend, latest, clickStart } = await mountForStartRace(start)
      const releaseStart = backend.deferResponse('session.start', BACKEND_RESPONSE)
      let started: Promise<unknown> | undefined
      await act(async () => {
        started = clickStart()
      })
      await waitForObservation(() => sessionStarts(backend.sentCommands).length > 0)
      const commandsBefore = backend.sentCommands.length
      let committed: Promise<unknown> | undefined
      await act(async () => {
        committed = Promise.resolve(latest()!.core.applyLiveBackground('silk'))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
      // Sent now, it would commit before the start's scene commit and be lost.
      expect(backend.sentCommands.slice(commandsBefore).some(isLayoutApply)).toBe(false)

      await act(async () => {
        releaseStart()
        await Promise.resolve()
      })
      await waitForObservation(() => backend.sentCommands.slice(commandsBefore).some(isLayoutApply))
      const apply = backend.sentCommands.slice(commandsBefore).find(isLayoutApply)!
      // The session is running now: the change goes to it.
      expect(apply.method).toBe('scene.layout.apply_live')
      expect(liveBackgroundId((apply.params as { background?: unknown }).background)).toBe('silk')
      await act(async () => {
        await Promise.all([committed, started])
      })
      await waitForObservation(() => liveBackgroundId(backend.currentScene.background) === 'silk')
    },
    20_000
  )

  it('records a live camera Off as intent that survives confirmation', async () => {
    const backend = new StudioBackend()
    backend.recordingState = 'recording'
    backend.recordingSessionId = 'session-1'
    backend.confirmedSources = { ...backend.confirmedSources, cameraId: 'camera:1' }
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
        latest()?.recording.recording.state === 'recording'
    )
    expect(latest()?.core.sourceSwitchReason('camera')).toBeNull()

    await act(async () => {
      await latest()!.core.switchSourceDeviceLive('camera', {
        ...latest()!.core.captureConfig.sources,
        cameraId: undefined,
        cameraName: undefined,
        cameraOff: true
      })
    })
    await waitForObservation(
      () => latest()?.core.sourceSelectionState.snapshot?.lastOperation?.stage === 'applied'
    )
    expect(backend.confirmedSources.cameraId).toBeUndefined()
    expect(latest()?.core.captureConfig.sources.cameraId).toBeUndefined()
    expect(latest()?.core.captureConfig.sources.cameraOff).toBe(true)
    expect(toastSpies.error).not.toHaveBeenCalled()
  }, 15_000)

  it('keeps a committed live source selection when output proof catches up late', async () => {
    const backend = new StudioBackend()
    backend.recordingState = 'recording'
    backend.recordingSessionId = 'session-1'
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
    expect(latest()?.core.sourceSwitchReason('capture')).toBeNull()
    vi.clearAllMocks()

    const sources = {
      ...latest()!.core.captureConfig.sources,
      screenId: 'screen:screencapturekit:2',
      windowId: undefined
    }
    await act(async () => {
      await latest()!.core.switchSourceDeviceLive('capture', sources)
    })

    expect(latest()?.core.captureConfig.sources.screenId).toBe(sources.screenId)
    expect(latest()?.core.sourceSelectionState.snapshot?.lastOperation).toMatchObject({
      stage: 'applied',
      outputObserved: false
    })
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(
      backend.sentCommands.some((command) => command.method === 'scene.source.device.switch')
    ).toBe(false)

    backend.sourceFailure = 'The selected display is unavailable.'
    await act(async () => {
      await latest()!.core.switchSourceDeviceLive('capture', {
        ...sources,
        screenId: 'screen:missing'
      })
      await latest()!.core.retrySourceStatus()
      await latest()!.core.retrySourceStatus()
    })
    expect(latest()?.core.captureConfig.sources.screenId).toBe(sources.screenId)
    expect(toastSpies.error).toHaveBeenCalledTimes(1)
    expect(toastSpies.error).toHaveBeenCalledWith("Couldn't switch the screen", {
      id: expect.stringContaining('source-switch-'),
      description: 'The selected display is unavailable. Choose it again in Sources.',
      duration: 8_000,
      action: expect.objectContaining({ label: 'Copy' })
    })
    expect(toastSpies.success).not.toHaveBeenCalled()
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
        burnTarget: 'stream' as const
      }
    }

    const shared = buildStreamOutputTopologyProbeParams(sharedConfig)
    expect(shared).toEqual({
      streamProfile: streamVideo,
      recordingProfile: streamVideo,
      outputRoles: ['recording', 'stream']
    })
    expect(
      buildStreamOutputTopologyProbeParams(sharedConfig, sharedConfig.streaming, true).outputRoles
    ).toEqual(['recording', 'stream'])

    // Live captions on always burn the stream (one switch, 2026-11-20).
    const captionSplit = buildStreamOutputTopologyProbeParams({
      ...sharedConfig,
      captions: { ...sharedConfig.captions, enabled: true }
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

  it('allows the provider-resolved profile on Basic — streaming quality is free (Plan 075)', () => {
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

    // The higher-rate YouTube profiles used to be Premium-only; since Plan
    // 075 the whole streaming-quality ceiling is shared by every tier.
    for (const preset of [
      'stream-youtube-1080p30',
      'stream-youtube-1080p60',
      'stream-youtube-4k30'
    ] as const) {
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
            enabled: target.id === 'youtube'
          }))
        }
      }

      expect(
        resolvedStreamingProfileEntitlementGate(captureConfig, DEFAULT_BASIC_ENTITLEMENTS)
      ).toEqual({ allowed: true })
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
    ).toBe(STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON)
    // The technical probe reason stays out of the toast.
    expect(STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON).not.toMatch(/HRESULT|Media Foundation|kbps/)
    expect(
      streamOutputTopologyBlockReason(
        { state: 'ready', requestKey: `${requestKey}:stale`, result },
        requestKey
      )
    ).toContain('Checking')
  })

  it('re-plans a rejected split as one shared encode at the stream profile', () => {
    const streamVideo = {
      preset: 'stream-safe-1080p30' as const,
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 6000
    }
    const config = {
      ...defaultCaptureConfig,
      recordEnabled: true,
      streamEnabled: true,
      // The recording asks for more than the stream: the shape that used to
      // make the user lower the bitrate by hand.
      video: { ...streamVideo, preset: 'custom' as const, bitrateKbps: 8000 },
      streaming: {
        ...defaultCaptureConfig.streaming,
        enabled: true,
        defaultOutputPreset: streamVideo.preset,
        defaultBitrateKbps: streamVideo.bitrateKbps,
        enabledTargetIds: ['youtube'],
        targets: defaultCaptureConfig.streaming.targets.map((target) =>
          target.id === 'youtube' ? { ...target, enabled: true } : { ...target, enabled: false }
        )
      }
    }

    const optimistic = resolveStreamOutputTopologyRequest(
      config,
      config.streaming,
      false,
      new Set()
    )
    expect(optimistic.params.outputRoles).toEqual(['recording', 'stream'])
    expect(optimistic.sharedFallbackVideo).toBeNull()

    const rejected = new Set([streamOutputTopologyProbeRequestKey(optimistic.params)])
    const shared = resolveStreamOutputTopologyRequest(config, config.streaming, false, rejected)
    expect(shared.params.outputRoles).toEqual(['shared'])
    expect(shared.sharedFallbackVideo).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 6000
    })
    expect(shared.params.recordingProfile).toMatchObject({ bitrateKbps: 6000 })
    expect(shared.params.streamProfile).toMatchObject({ bitrateKbps: 6000 })

    // Equal profiles share one encode with nothing to announce.
    const equal = { ...config, video: streamVideo }
    const equalSplit = resolveStreamOutputTopologyRequest(equal, equal.streaming, false, new Set())
    if (equalSplit.params.outputRoles.includes('stream')) {
      const equalShared = resolveStreamOutputTopologyRequest(
        equal,
        equal.streaming,
        false,
        new Set([streamOutputTopologyProbeRequestKey(equalSplit.params)])
      )
      expect(equalShared.params.outputRoles).toEqual(['shared'])
      expect(equalShared.sharedFallbackVideo).toBeNull()
    }

    // Live captions burned into the stream only need a clean recording, which
    // one encode cannot give: that session stays blocked.
    const captioned = {
      ...config,
      captions: { ...config.captions, enabled: true, burnTarget: 'stream' as const }
    }
    const captionedSplit = resolveStreamOutputTopologyRequest(
      captioned,
      captioned.streaming,
      false,
      new Set()
    )
    expect(
      resolveStreamOutputTopologyRequest(
        captioned,
        captioned.streaming,
        false,
        new Set([streamOutputTopologyProbeRequestKey(captionedSplit.params)])
      ).params.outputRoles
    ).toEqual(['recording', 'stream'])

    // A rejection of some other profile never changes this session's plan.
    expect(
      resolveStreamOutputTopologyRequest(config, config.streaming, false, new Set(['other']))
        .sharedFallbackVideo
    ).toBeNull()
    expect(
      streamOutputTopologySplitRejected({
        outputRoles: ['recording', 'stream'],
        effectiveBridgeOutput: 'raw-yuv420p'
      })
    ).toBe(true)
    expect(
      streamOutputTopologySplitRejected({
        outputRoles: ['shared'],
        effectiveBridgeOutput: 'raw-yuv420p'
      })
    ).toBe(false)
  })

  it('makes Go Live wait for its exact topology probe instead of refusing', async () => {
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
    // A check that is still running is not an error: nothing is reported and
    // Go Live simply has not moved on yet.
    expect(latest()?.core.startBlockedReason).toBeNull()

    let startPromise: Promise<boolean> | undefined
    await act(async () => {
      startPromise = latest()!.core.startSession()
      await Promise.resolve()
    })
    expect(
      backend.sentCommands.some((command) =>
        ['session.start', 'streamTargets.confirmation.validate'].includes(command.method)
      )
    ).toBe(false)
    expect(latest()?.core.lastError).toBeNull()

    await act(async () => {
      releaseTopology()
      await startPromise
    })
    // The same click carries on to the Go Live confirmation once it answers.
    expect(
      backend.sentCommands.some(
        (command) => command.method === 'streamTargets.confirmation.validate'
      )
    ).toBe(true)
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
    ).toHaveLength(2)
  })

  it('keeps MP4 completion when an older Library refresh arrives afterward', async () => {
    const backend = new StudioBackend()
    backend.sessionSummaries = [
      sessionSummary({ id: 'session-1', finalizationState: 'finalizing' })
    ]
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
    const latest = () => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () => latest()?.core.wsStatus === 'connected' && latest()?.core.sessions.length === 1
    )
    const release = backend.deferResponse('sessions.list', { items: backend.sessionSummaries })
    const before = backend.sentCommands.filter(
      (command) => command.method === 'sessions.list'
    ).length
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: { state: 'idle', message: 'Ready.' }
        })
      })
    })
    await vi.waitFor(() =>
      expect(
        backend.sentCommands.filter((command) => command.method === 'sessions.list').length
      ).toBeGreaterThan(before)
    )
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.finalization',
          payload: {
            sessionId: 'session-1',
            state: 'finalized',
            mp4Path: '/tmp/final.mp4',
            updatedAt: now
          }
        })
      })
    })
    await waitForObservation(() => latest()?.core.sessions[0]?.finalizationState === 'finalized')
    await act(async () => {
      release()
      await Promise.resolve()
    })
    expect(latest()?.core.sessions[0]).toMatchObject({
      finalizationState: 'finalized',
      mp4Path: '/tmp/final.mp4'
    })
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

  it('keeps every loaded Library page when an older recording is renamed (QA F5)', async () => {
    const backend = new StudioBackend()
    backend.sessionListPaged = true
    backend.sessionSummaries = Array.from({ length: 220 }, (_, index) =>
      sessionSummary({ id: `session-${index}`, title: `Session ${index}` })
    )
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
    const latest = () => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(
      () => latest()?.core.wsStatus === 'connected' && latest()?.core.sessions.length === 50
    )
    // Load more to 200 rows (the most one page refetch holds): a rename on page 4.
    for (let loaded = 100; loaded <= 200; loaded += 50) {
      await act(async () => {
        await latest()!.core.loadMoreSessions()
      })
      await waitForObservation(() => latest()?.core.sessions.length === loaded)
    }

    await act(async () => {
      await latest()!.core.renameSession('session-199', 'Renamed older recording')
    })

    const sessions = latest()!.core.sessions
    expect(sessions).toHaveLength(200)
    expect(sessions.find((session) => session.id === 'session-199')?.title).toBe(
      'Renamed older recording'
    )
    expect(latest()?.core.sessionsNextCursor).toBe('200')
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
    let detailLoad!: Promise<void>
    await act(async () => {
      detailLoad = latest()!.core.loadSessionDetails('session-1')
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(
        backend.sentCommands.filter((command) =>
          ['sessions.healthEvents.list', 'sessions.logs.list'].includes(command.method)
        )
      ).toHaveLength(2)
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
      await detailLoad
    })

    expect(latest()?.core.sessionDetails['session-1']?.healthEvents).toEqual([healthEvent])
    expect(latest()?.core.sessionDetails['session-1']?.sessionLogs).toEqual([logEntry])
    expect(
      backend.sentCommands.filter((command) =>
        ['sessions.healthEvents.list', 'sessions.logs.list'].includes(command.method)
      )
    ).toHaveLength(2)
  })

  // Plan 191: these events used to publish a new core value that no core
  // consumer reads, so every mounted Studio view re-rendered for each one.
  describe('events no core consumer reads keep the core value (plan 191)', () => {
    async function mountQuietProvider(setup?: (backend: StudioBackend) => void): Promise<{
      api: VideorcApi
      latest: () => StudioObservation
      shell: () => ReturnType<typeof useStudioShell> | undefined
      emit: (event: string, payload: unknown) => Promise<void>
    }> {
      const backend = new StudioBackend()
      setup?.(backend)
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
      const latest = (): StudioObservation => observations.at(-1)!
      let shell: ReturnType<typeof useStudioShell> | undefined
      function ShellProbe(): null {
        const value = useStudioShell()
        useEffect(() => {
          shell = value
        }, [value])
        return null
      }
      root = await mountStudioProvider(
        testDom.container,
        (value) => {
          observations.push(value)
        },
        createElement(ShellProbe)
      )
      await waitForObservation(
        () =>
          observations.at(-1)?.core.wsStatus === 'connected' &&
          observations.at(-1)?.core.cohostSettings != null &&
          observations.at(-1)?.core.sessions.length === backend.sessionSummaries.length
      )
      // Bootstrap is done publishing: core keeps its identity for 30 sequential
      // 10 ms ticks, which outlasts the 250 ms debounce of the post-connect
      // scene reload (it re-applies the same scene as a new object).
      let quietTicks = 0
      const epoch = testEpoch
      for (let attempt = 0; attempt < 400 && quietTicks < 30; attempt += 1) {
        const before = latest().core
        await pollAct(epoch, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
        quietTicks = latest().core === before ? quietTicks + 1 : 0
      }
      expect(quietTicks, 'the core value never settled after bootstrap').toBe(30)
      const emit = async (event: string, payload: unknown): Promise<void> => {
        await act(async () => {
          for (const socket of backend.sockets)
            socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
          await Promise.resolve()
        })
      }
      return { api, latest, shell: () => shell, emit }
    }

    it('streams caption partials to captions readers without a new core or shell value', async () => {
      const { api, latest, shell, emit } = await mountQuietProvider()
      const core = latest().core
      const shellValue = shell()
      expect(shellValue).toBeDefined()
      expect(latest().captions.captionLines).toEqual([])
      const line = (
        seq: number,
        text: string,
        kind: CaptionsUpdate['kind'] = 'partial'
      ): CaptionsUpdate => ({ sessionClientId: 'captions-1', seq, kind, text, chunkSeconds: 0 })

      await emit('captions.update', line(1, 'Hello'))
      expect(latest().captions.captionLines).toEqual([line(1, 'Hello')])
      await emit('captions.update', line(1, 'Hello every'))
      await emit('captions.update', line(1, 'Hello everyone', 'final'))
      await emit('captions.update', line(2, 'Welcome'))
      expect(latest().captions.captionLines).toEqual([
        line(1, 'Hello everyone', 'final'),
        line(2, 'Welcome')
      ])
      expect(latest().core === core, 'a caption partial published a new core value').toBe(true)
      expect(shell()).toBe(shellValue)

      // Opening the reader still hands it the latest lines.
      const pushCaptionSnapshot = vi.fn<VideorcApi['pushCaptionSnapshot']>(async () => {})
      api.pushCaptionSnapshot = pushCaptionSnapshot
      await act(async () => {
        await latest().core.openCaptionsWindow()
      })
      expect(pushCaptionSnapshot).toHaveBeenCalledTimes(1)
      expect(pushCaptionSnapshot.mock.calls[0]?.[0].lines).toEqual(latest().captions.captionLines)
    }, 15_000)

    it('shows and expires a Sidekick bubble without a new core value', async () => {
      const { api, latest, emit } = await mountQuietProvider()
      const core = latest().core
      const pushCohostWindowState = vi.fn<VideorcApi['pushCohostWindowState']>(async () => {})
      api.pushCohostWindowState = pushCohostWindowState
      const talking: BuddyOverlaySnapshot = {
        personaId: 'default',
        state: 'talk',
        bubble: { text: 'Hello chat', until: '2026-10-24T00:00:06.000Z' }
      }

      await emit('cohost.buddy.state', talking)
      // The provider still reads it: the Comments window shows the bubble.
      expect(pushCohostWindowState.mock.lastCall?.[0].buddy).toMatchObject({
        state: 'talk',
        bubble: 'Hello chat'
      })
      await emit('cohost.buddy.state', { ...talking, state: 'idle', bubble: null })
      expect(pushCohostWindowState.mock.lastCall?.[0].buddy).toMatchObject({
        state: 'idle',
        bubble: null
      })
      expect(latest().core === core, 'a Sidekick bubble published a new core value').toBe(true)
    }, 15_000)

    it("keeps the sessions array for a session the Library hasn't loaded, and still counts a loaded one", async () => {
      const { latest, emit } = await mountQuietProvider((backend) => {
        backend.sessionSummaries = [sessionSummary()]
      })
      const core = latest().core
      const sessions = core.sessions
      expect(sessions).toHaveLength(1)
      const health = (sessionId: string): HealthEvent => ({
        id: `health-${sessionId}`,
        sessionId,
        level: 'warn',
        code: 'live-health',
        message: 'A health event.',
        permissionPane: null,
        createdAt: '2026-10-24T00:00:01.000Z'
      })
      const log = (sessionId: string): SessionLogEntry => ({
        id: `log-${sessionId}`,
        sessionId,
        level: 'info',
        code: 'live-log',
        message: 'A session log.',
        sourceId: null,
        permissionPane: null,
        createdAt: '2026-10-24T00:00:01.000Z'
      })

      await emit('health.event', health('session-elsewhere'))
      await emit('session.log', log('session-elsewhere'))
      // Diagnostics heard it; the Library's array and core did not change.
      expect(latest().diagnostics.healthEvents[0]?.id).toBe('health-session-elsewhere')
      expect(latest().core.sessions).toBe(sessions)
      expect(latest().core === core, 'another session published a new core value').toBe(true)

      await emit('health.event', health('session-1'))
      await emit('session.log', log('session-1'))
      expect(latest().core.sessions).not.toBe(sessions)
      expect(latest().core.sessions[0]).toMatchObject({
        id: 'session-1',
        healthEventCount: 1,
        sessionLogCount: 1
      })
    }, 15_000)
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
          ['sessions.healthEvents.list', 'sessions.logs.list'].includes(command.method)
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
    let invalidatedLoad!: Promise<void>
    await act(async () => {
      invalidatedLoad = latest()!.core.loadSessionDetails('session-1')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(detailCommandCount()).toBe(4))

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
    let replacementLoad!: Promise<void>
    await act(async () => {
      replacementLoad = latest()!.core.loadSessionDetails('session-1')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(detailCommandCount()).toBe(6))

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
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'health.event', payload: healthEvent })
      })
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({ event: 'session.log', payload: logEntry })
      })
      await Promise.resolve()
    })

    await act(async () => {
      releaseOldHealth()
      releaseOldLogs()
      await invalidatedLoad
    })

    // The stale request settled first. The replacement's pages are empty, so
    // the events can only come from the buffer the stale one had to leave.
    await act(async () => {
      releaseNewHealth()
      releaseNewLogs()
      await replacementLoad
    })

    expect(latest()?.core.sessionDetails['session-1']).toEqual({
      healthEvents: [healthEvent],
      sessionLogs: [logEntry]
    })
    expect(detailCommandCount()).toBe(6)
  })

  it('reads a Linux media-access snapshot as not-applicable and renders no permission chips', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      platform: 'linux',
      getMediaAccessStatus: async () => ({
        camera: 'not-applicable',
        microphone: 'not-applicable',
        screen: 'not-applicable'
      })
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
        latest()?.core.mediaAccess?.camera === 'not-applicable' &&
        latest()?.core.mediaAccess?.microphone === 'not-applicable'
    )

    const core = latest()!.core
    expect(isMediaAccessSnapshotReady(core.mediaAccess)).toBe(true)
    expect(
      systemAccessRows({
        deviceList: core.deviceList,
        audioMeter: null,
        platform: core.runtimeInfo?.platform,
        mediaAccess: core.mediaAccess
      })
    ).toEqual([])
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
        microphone: 'granted',
        screen: 'granted'
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

  it('a remote screenId edits the scene on stream and legacy layouts switch or refuse (plan 231 S9)', async () => {
    const backend = new StudioBackend()
    const secondScreen = {
      id: 'screen:dxgi:second',
      name: 'Display 2',
      kind: 'screen' as const,
      status: 'available' as const
    }
    backend.deviceList.devices.push(secondScreen)
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
    let current: StudioObservation | undefined
    root = await mountStudioProvider(testDom.container, (value) => {
      current = value
    })
    await waitForObservation(
      () => canSaveScene() && current!.core.captureConfig.sources.screenId != null
    )
    const onStreamId = current!.core.activeSavedSceneId
    const send = async (intentId: string, intent: Record<string, unknown>) => {
      await act(async () => {
        for (const socket of backend.sockets)
          socket.onmessage?.({
            data: JSON.stringify({
              event: 'remote.intent',
              payload: { intentId, intent: { kind: 'sceneApply', ...intent } }
            })
          })
      })
      const ack = () =>
        backend.sentCommands.find(
          (command) =>
            command.method === 'remote.intent.ack' &&
            (command.params as { intentId: string }).intentId === intentId
        )?.params
      await waitForObservation(() => ack() !== undefined)
      return ack()
    }
    expect(await send('screen-pick', { screenId: secondScreen.id })).toEqual({
      intentId: 'screen-pick',
      ok: true
    })
    await waitForObservation(
      () =>
        storedSceneNamed('Screen + camera').shows.kind === 'display' &&
        current!.core.captureConfig.sources.screenId === secondScreen.id
    )
    expect(current!.core.activeSavedSceneId).toBe(onStreamId)
    expect(storedSceneNamed('Screen + camera').shows).toMatchObject({
      kind: 'display',
      screenId: secondScreen.id
    })
    expect(await send('legacy', { layoutPreset: 'screen-only' })).toEqual({
      intentId: 'legacy',
      ok: true
    })
    await waitForObservation(
      () =>
        current!.core.activeSavedSceneId === storedSceneNamed('Screen only').id && canSaveScene()
    )
    // Layout edits keep the scene. With no scene left on Screen only, the
    // same old Deck key is refused instead of rewriting a scene's layout.
    await act(async () => current!.core.applyCameraPreset({ layoutPreset: 'screen-camera' }))
    await waitForObservation(
      () => canSaveScene() && current!.core.captureConfig.layout.layoutPreset === 'screen-camera'
    )
    expect(await send('no-match', { layoutPreset: 'screen-only' })).toEqual({
      intentId: 'no-match',
      ok: false,
      message: 'No scene uses Screen only'
    })
  }, 15_000)

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
        microphone: 'granted',
        screen: 'granted'
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
      message: "Couldn't change the microphone."
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
      message: "Couldn't switch the scene."
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
    // Plan 231 D14: a remote's layout is the first scene with that layout. It
    // went on stream; no scene's layout changed.
    await waitForObservation(
      () =>
        latest()?.core.activeSavedSceneId ===
        latest()?.core.savedScenes.find(
          (scene) => scene.visual.layout.layoutPreset === 'side-by-side'
        )?.id
    )
    expect(latest()?.core.savedScenes.map((scene) => scene.visual.layout.layoutPreset)).toEqual([
      'screen-camera',
      'screen-only',
      'camera-only',
      'side-by-side'
    ])
    // A layout no scene uses is refused, in words, with no commit.
    const start = backend.sentCommands.length
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'remote.intent',
            payload: {
              intentId: 'ri-test-scene-no-layout',
              intent: { kind: 'sceneApply', layoutPreset: 'vertical-split' }
            }
          })
        })
      }
    })
    await waitForObservation(() =>
      backend.sentCommands.some(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-scene-no-layout'
      )
    )
    expect(
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === 'ri-test-scene-no-layout'
      )?.params
    ).toEqual({
      intentId: 'ri-test-scene-no-layout',
      ok: false,
      message: 'No scene uses Split'
    })
    expect(
      backend.sentCommands
        .slice(start)
        .some((command) => command.method.startsWith('scene.layout.apply'))
    ).toBe(false)
    expect(latest()?.core.captureConfig.layout.layoutPreset).toBe('side-by-side')
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
      message: "Couldn't show the takeover."
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
      message: "Couldn't hide the takeover."
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
        microphone: 'granted',
        screen: 'granted'
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

  it('applies cloud-AI preference flips to the same active Sidekick session from backend replies', async () => {
    const backend = new StudioBackend()
    backend.entitlements = premiumEntitlements
    backend.cohostSettings.listen = true
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
    await waitForObservation(() => latest()?.core.cohostSettings?.listen === true)
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'liveChat.snapshot',
            payload: {
              sessionId: 'consent-live',
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
    await waitForObservation(() => latest()?.chat.cohostState?.listening?.state === 'on')
    const started = latest()!.chat.cohostState!
    const captureCommands = backend.sentCommands.filter((command) =>
      [
        'session.start',
        'session.stop',
        'liveChat.start',
        'liveChat.stop',
        'captions.start',
        'captions.stop'
      ].includes(command.method)
    )
    for (const consent of [false, true]) {
      await act(async () => latest()!.core.setAiConsent(consent))
      await waitForObservation(
        () => latest()?.chat.cohostState?.status === (consent ? 'listening' : 'paused')
      )
      expect(latest()!.chat.cohostState).toMatchObject({
        sessionId: 'consent-live',
        reason: consent ? null : 'consent-required',
        questions: started.questions,
        tickSeq: started.tickSeq,
        listening: consent ? { state: 'on' } : { state: 'blocked', reasonCode: 'consent-required' }
      })
      expect(latest()!.chat.liveChatSnapshot.sessionId).toBe('consent-live')
      expect(localStorage.getItem('videorc.aiConsent')).toBe(consent ? '1' : '0')
    }
    expect(
      backend.sentCommands
        .filter((command) => command.method === 'cohost.start')
        .map((command) => command.params)
    ).toEqual([
      expect.objectContaining({ sessionId: 'consent-live', consentToProcessChat: true }),
      expect.objectContaining({ sessionId: 'consent-live', consentToProcessChat: false }),
      expect.objectContaining({ sessionId: 'consent-live', consentToProcessChat: true })
    ])
    expect(
      backend.sentCommands.filter((command) =>
        [
          'session.start',
          'session.stop',
          'liveChat.start',
          'liveChat.stop',
          'captions.start',
          'captions.stop'
        ].includes(command.method)
      )
    ).toEqual(captureCommands)
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

  // Plan 174 S3.14a (D7): the Buddy Live switch writes `enabled` and nothing
  // else. On asks for cloud-AI consent first (the Buddy page's dialog) and
  // never grants the microphone in the same click: listening keeps its own
  // switch. Cloud AI is its own choice and never rewrites them.
  async function mountBuddyLiveProvider(consent: '0' | '1'): Promise<{
    backend: StudioBackend
    latest: () => StudioObservation | undefined
    settingsWrites: () => unknown[]
    emitApi: (name: string, value: unknown) => void
    pushCohostEnableResult: ReturnType<typeof vi.fn>
  }> {
    const backend = new StudioBackend()
    backend.entitlements = premiumEntitlements
    backend.cohostSettings = { ...backend.cohostSettings, enabled: false, listen: false }
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emitApi: ((name: string, value: unknown) => void) | undefined
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (emit) => {
        emitApi = emit
      }
    })
    const pushCohostEnableResult = vi.fn(async () => true)
    Object.assign(api, { pushCohostEnableResult })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    localStorage.setItem('videorc.aiConsent', consent)
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    await waitForObservation(() => latest()?.core.cohostSettings !== null)
    return {
      backend,
      latest,
      settingsWrites: () =>
        backend.sentCommands
          .filter((command) => command.method === 'cohost.settings.set')
          .map((command) => command.params),
      emitApi: (name, value) => emitApi?.(name, value),
      pushCohostEnableResult
    }
  }

  it('turns Sidekick Live on only through the consent dialog, never the microphone with it', async () => {
    const { latest, settingsWrites } = await mountBuddyLiveProvider('0')

    await act(async () => latest()!.core.setBuddyLive(true))
    await waitForObservation(() => latest()?.core.buddyConsentRequested === true)
    // Asking writes nothing: no consent and no settings until the answer.
    expect(settingsWrites()).toEqual([])
    expect(localStorage.getItem('videorc.aiConsent')).toBe('0')

    await act(async () => latest()!.core.answerBuddyConsent(true))
    await waitForObservation(() => latest()?.core.cohostSettings?.enabled === true)
    expect(latest()!.core.buddyConsentRequested).toBe(false)
    expect(latest()!.core.aiConsent).toBe(true)
    expect(localStorage.getItem('videorc.aiConsent')).toBe('1')
    // One click never grants consent and listening at once (the Phase 0 review).
    expect(settingsWrites()).toEqual([{ enabled: true }])
    expect(latest()!.core.cohostSettings).toMatchObject({ enabled: true, listen: false })

    // Off is `enabled` alone: listening and consent stay as they were.
    await act(async () => latest()!.core.patchCohostSettings({ listen: true }))
    await waitForObservation(() => latest()?.core.cohostSettings?.listen === true)
    await act(async () => latest()!.core.setBuddyLive(false))
    await waitForObservation(() => latest()?.core.cohostSettings?.enabled === false)
    expect(settingsWrites()).toEqual([{ enabled: true }, { listen: true }, { enabled: false }])
    expect(latest()!.core.cohostSettings?.listen).toBe(true)
    expect(localStorage.getItem('videorc.aiConsent')).toBe('1')
    expect(toastSpies.error).not.toHaveBeenCalled()
  }, 15_000)

  it('changes nothing when the Sidekick Live consent dialog is declined', async () => {
    const { latest, settingsWrites } = await mountBuddyLiveProvider('0')

    await act(async () => latest()!.core.setBuddyLive(true))
    await waitForObservation(() => latest()?.core.buddyConsentRequested === true)
    await act(async () => latest()!.core.answerBuddyConsent(false))
    await waitForObservation(() => latest()?.core.buddyConsentRequested === false)

    expect(latest()!.core.aiConsent).toBe(false)
    expect(localStorage.getItem('videorc.aiConsent')).toBe('0')
    expect(settingsWrites()).toEqual([])
    expect(latest()!.core.cohostSettings?.enabled).toBe(false)
  }, 15_000)

  it('turns Sidekick Live on without a dialog once cloud AI is allowed', async () => {
    const { latest, settingsWrites } = await mountBuddyLiveProvider('1')

    await act(async () => latest()!.core.setBuddyLive(true))
    await waitForObservation(() => latest()?.core.cohostSettings?.enabled === true)
    expect(latest()!.core.buddyConsentRequested).toBe(false)
    expect(settingsWrites()).toEqual([{ enabled: true }])
  }, 15_000)

  it('revokes cloud AI without rewriting Sidekick settings, and asks again on the next on', async () => {
    const { latest, settingsWrites } = await mountBuddyLiveProvider('1')
    await act(async () => latest()!.core.setBuddyLive(true))
    await waitForObservation(() => latest()?.core.cohostSettings?.enabled === true)

    await act(async () => latest()!.core.setAiConsent(false))
    await waitForObservation(() => latest()?.core.aiConsent === false)
    expect(localStorage.getItem('videorc.aiConsent')).toBe('0')
    expect(settingsWrites()).toEqual([{ enabled: true }])
    expect(latest()!.core.cohostSettings?.enabled).toBe(true)

    await act(async () => latest()!.core.setBuddyLive(true))
    await waitForObservation(() => latest()?.core.buddyConsentRequested === true)
    expect(settingsWrites()).toEqual([{ enabled: true }])
  }, 15_000)

  // Plan 174 S0.2: a Comments-window command saves only what it names. The
  // relay never adds listening on its own, so consent and the microphone are
  // never one click.
  it('saves only what a Comments-window command names: consent without listening', async () => {
    const { latest, settingsWrites, emitApi, pushCohostEnableResult } =
      await mountBuddyLiveProvider('0')

    // The consent dialog's Allow: consent and Buddy on, nothing about the mic.
    await act(async () => {
      emitApi('onCohostEnableRequest', { requestId: 'enable-1', enabled: true, grantConsent: true })
    })
    await waitForObservation(() => pushCohostEnableResult.mock.calls.length === 1)
    expect(localStorage.getItem('videorc.aiConsent')).toBe('1')
    expect(settingsWrites()).toEqual([{ enabled: true }])
    expect(pushCohostEnableResult).toHaveBeenLastCalledWith({
      requestId: 'enable-1',
      ok: true,
      value: expect.objectContaining({ consented: true, enabled: true, listen: false })
    })
    expect(latest()!.core.buddyConsentRequested).toBe(false)

    // A later `listen` with Buddy already on is dropped unless the listening
    // card grants it (plan 174 S3.14a): nothing is saved, the state answers.
    await act(async () => {
      emitApi('onCohostEnableRequest', { requestId: 'enable-2', enabled: true, listen: true })
    })
    await waitForObservation(() => pushCohostEnableResult.mock.calls.length === 2)
    expect(settingsWrites()).toEqual([{ enabled: true }])
    expect(latest()!.core.cohostSettings).toMatchObject({ enabled: true, listen: false })

    // The listening card's own Turn on: `listen` alone.
    await act(async () => {
      emitApi('onCohostEnableRequest', {
        requestId: 'enable-2b',
        enabled: true,
        listen: true,
        grantListen: true
      })
    })
    await waitForObservation(() => pushCohostEnableResult.mock.calls.length === 3)
    expect(settingsWrites().at(-1)).toEqual({ listen: true })
    expect(latest()!.core.cohostSettings).toMatchObject({ enabled: true, listen: true })

    // The Buddy Live switch, off: `enabled` alone; listening stays.
    await act(async () => {
      emitApi('onCohostEnableRequest', { requestId: 'enable-3', enabled: false })
    })
    await waitForObservation(() => pushCohostEnableResult.mock.calls.length === 4)
    expect(settingsWrites().at(-1)).toEqual({ enabled: false })
    expect(latest()!.core.cohostSettings?.listen).toBe(true)

    // The Buddy Live switch on again (the header, the nudge): `enabled`
    // alone, the same save as the Buddy page's switch.
    await act(async () => {
      emitApi('onCohostEnableRequest', { requestId: 'enable-4', enabled: true })
    })
    await waitForObservation(() => pushCohostEnableResult.mock.calls.length === 5)
    expect(settingsWrites().at(-1)).toEqual({ enabled: true })
    expect(latest()!.core.buddyConsentRequested).toBe(false)
  }, 15_000)

  it('keeps listening off when a Greetings switch rides the relay', async () => {
    const { latest, settingsWrites, emitApi, pushCohostEnableResult } =
      await mountBuddyLiveProvider('1')

    // Buddy on without listening (a talk change the window sent no `listen` for).
    await act(async () => {
      emitApi('onCohostEnableRequest', {
        requestId: 'mode-1',
        enabled: true,
        autoChat: { talk: 'suggest' }
      })
    })
    await waitForObservation(() => pushCohostEnableResult.mock.calls.length === 1)
    expect(settingsWrites().at(-1)).toEqual({
      enabled: true,
      autoChat: expect.objectContaining({ talk: 'suggest' })
    })
    expect(latest()!.core.cohostSettings).toMatchObject({ enabled: true, listen: false })

    // Greetings on: `{autoChat}` alone, the templates and cooldowns kept.
    await act(async () => {
      emitApi('onCohostEnableRequest', {
        requestId: 'greetings-1',
        enabled: true,
        autoChat: { greetings: true }
      })
    })
    await waitForObservation(() => pushCohostEnableResult.mock.calls.length === 2)
    // Plan 211 D3: `talk` is the mode; the legacy `mode` rides along as
    // stored and the backend re-projects it.
    expect(settingsWrites().at(-1)).toEqual({
      autoChat: {
        talk: 'suggest',
        mode: 'off',
        greetings: { enabled: true, templates: [] },
        answers: { enabled: false, cooldownSeconds: 20 },
        banter: { enabled: false, cooldownSeconds: 240 }
      }
    })
    expect(latest()!.core.cohostSettings).toMatchObject({ enabled: true, listen: false })
    expect(pushCohostEnableResult).toHaveBeenLastCalledWith({
      requestId: 'greetings-1',
      ok: true,
      value: expect.objectContaining({ enabled: true, listen: false })
    })

    // A command that changes nothing saves nothing, and still answers.
    await act(async () => {
      emitApi('onCohostEnableRequest', { requestId: 'same-1', enabled: true })
    })
    await waitForObservation(() => pushCohostEnableResult.mock.calls.length === 3)
    expect(settingsWrites()).toHaveLength(2)
    expect(pushCohostEnableResult).toHaveBeenLastCalledWith({
      requestId: 'same-1',
      ok: true,
      value: expect.objectContaining({ enabled: true, listen: false })
    })
  }, 15_000)

  // Stop never starts a cloud job on its own: a streamed, recorded session
  // Buddy heard finalizes with its transcript, and only the cloud-AI
  // readiness reads go out.
  it('starts no cloud job when a streamed recording Sidekick heard finalizes', async () => {
    // Cloud AI reads ready, so only a missing trigger keeps a job from going out.
    class CloudReadyBackend extends StudioBackend {
      override response(command: BackendCommand): unknown {
        if (command.method === 'ai.capabilities.get') {
          return {
            entitlement: { cloudAi: true },
            features: { cloudAiEnabled: true },
            models: { defaultTextModel: 'test-model' },
            readiness: {
              access: { cloudAiEntitled: true, globallyDisabled: false },
              gateway: { configured: true, configError: null },
              transcription: { configured: true, configError: null },
              worker: { configured: true, configError: null }
            },
            workflow: { inputModes: [{ enabled: true, kind: 'transcript' }] }
          }
        }
        if (command.method === 'ai.quota.get') {
          return {
            access: { allowed: true, code: null, message: null, status: null },
            today: { limit: 20, remaining: 20 },
            monthly: { limit: 500, remaining: 500 }
          }
        }
        return super.response(command)
      }
    }
    const backend = new CloudReadyBackend()
    backend.entitlements = premiumEntitlements
    backend.accountSnapshot = signedInAccount
    backend.cohostSettings = { ...backend.cohostSettings, enabled: true, listen: true }
    backend.sessionSummaries = [
      sessionSummary({
        id: 'pack-1',
        title: 'Streamed and recorded',
        mode: 'record+stream',
        mp4Path: '/recordings/pack-1.mp4'
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
    localStorage.setItem('videorc.aiConsent', '1')
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    await waitForObservation(() => latest()?.core.account?.status === 'signed-in')
    await waitForObservation(() => latest()?.core.aiCapabilities !== null)
    await waitForObservation(
      () => latest()?.core.sessions.some((row) => row.id === 'pack-1') === true
    )
    await waitForObservation(() => latest()?.core.cohostSettings?.listen === true)

    const emit = async (event: string, payload: unknown): Promise<void> => {
      await act(async () => {
        for (const socket of backend.sockets) {
          socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
        }
        await Promise.resolve()
      })
    }
    // Everything a post-recording job could key on: Buddy heard the stream,
    // the transcript landed, and the MP4 finalized.
    await emit('liveChat.snapshot', {
      sessionId: 'pack-1',
      providers: [],
      messages: [],
      unreadCount: 0,
      updatedAt: now
    })
    await waitForObservation(() => latest()?.chat.cohostState?.listening?.state === 'on')
    await emit('health.event', {
      id: 'srt-pack-1',
      sessionId: 'pack-1',
      level: 'info',
      code: 'captions-srt-written',
      message: 'The transcript was saved next to the recording.',
      createdAt: now
    } satisfies HealthEvent)
    await emit('recording.finalization', {
      sessionId: 'pack-1',
      state: 'finalized',
      mp4Path: '/recordings/pack-1.mp4',
      updatedAt: now
    })
    // Room for any lazy import a job would go through.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    const readinessReads = new Set(['ai.capabilities.get', 'ai.quota.get'])
    expect(
      backend.sentCommands
        .map((command) => command.method)
        .filter((method) => method.startsWith('ai.') && !readinessReads.has(method))
    ).toEqual([])
  }, 15_000)

  // Plan 119 S15: with "Make a clean cut of every recording" on, a recording
  // that finalizes starts one clean cut; a second finalized event for it starts
  // nothing, and a completed cut is announced once per cut-list revision.
  it('starts one clean cut when a recording finalizes with the switch on', async () => {
    class CleanCutBackend extends StudioBackend {
      override response(command: BackendCommand): unknown {
        if (command.method === 'ai.capabilities.get') {
          return {
            entitlement: { cloudAi: true },
            features: { cloudAiEnabled: true, cleanCutEnabled: true },
            models: { defaultTextModel: 'test-model' },
            readiness: {
              access: { cloudAiEntitled: true, globallyDisabled: false },
              gateway: { configured: true, configError: null },
              transcription: { configured: true, configError: null },
              worker: { configured: true, configError: null }
            },
            workflow: { inputModes: [{ enabled: true, kind: 'transcript' }] },
            cleanCut: { supported: true, available: true, reasonCode: null }
          }
        }
        if (command.method === 'ai.quota.get') {
          return {
            access: { allowed: true, code: null, message: null, status: null },
            today: { limit: 20, remaining: 20 },
            monthly: { limit: 500, remaining: 500 }
          }
        }
        if (command.method === 'cleanCut.start') {
          return {
            id: 'clean-job-1',
            sourceSessionId: 'clean-cut-1',
            mode: 'clean',
            state: 'queued',
            progress: 0,
            edlRevision: 0,
            createdAt: now,
            updatedAt: now
          }
        }
        return super.response(command)
      }
    }
    const backend = new CleanCutBackend()
    backend.entitlements = premiumEntitlements
    backend.accountSnapshot = signedInAccount
    backend.sessionSummaries = [
      sessionSummary({
        id: 'clean-cut-1',
        title: 'Tutorial',
        mode: 'record',
        durationMs: 600_000,
        mp4Path: '/recordings/clean-cut-1.mp4'
      }),
      sessionSummary({
        id: 'clean-cut-stream-only',
        title: 'Stream only',
        mode: 'stream',
        durationMs: 600_000
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
    localStorage.setItem('videorc.aiConsent', '1')
    localStorage.setItem('videorc.cleanCutAuto', '1')
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    await waitForObservation(() => latest()?.core.account?.status === 'signed-in')
    await waitForObservation(() => latest()?.core.aiCapabilities !== null)
    await waitForObservation(
      () => latest()?.core.sessions.some((row) => row.id === 'clean-cut-1') === true
    )

    const emit = async (event: string, payload: unknown): Promise<void> => {
      await act(async () => {
        for (const socket of backend.sockets) {
          socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
        }
        await Promise.resolve()
      })
    }
    const settle = async (): Promise<void> => {
      // Room for the lazy import the auto-run goes through.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
      })
    }
    const starts = (): unknown[] =>
      backend.sentCommands
        .filter((command) => command.method === 'cleanCut.start')
        .map((command) => command.params)

    for (const sessionId of ['clean-cut-1', 'clean-cut-1', 'clean-cut-stream-only']) {
      await emit('recording.finalization', {
        sessionId,
        state: 'finalized',
        mp4Path: `/recordings/${sessionId}.mp4`,
        updatedAt: now
      })
      await settle()
    }
    expect(starts()).toEqual([
      { sessionId: 'clean-cut-1', mode: 'clean', consentToUploadAudio: true }
    ])
    expect(JSON.parse(localStorage.getItem('videorc.cleanCutAttempted') ?? '[]')).toEqual([
      'clean-cut-1'
    ])

    const completed = {
      id: 'clean-job-1',
      sourceSessionId: 'clean-cut-1',
      mode: 'clean',
      state: 'completed',
      progress: 1,
      edlRevision: 0,
      edlSummary: { durationMs: 600_000, keptMs: 450_000, removalCount: 12, byKind: [] },
      outputSessionId: 'clean-cut-1-out',
      createdAt: now,
      updatedAt: now
    }
    const listsBefore = backend.sentCommands.filter(
      (command) => command.method === 'sessions.list'
    ).length
    await emit('cleanCut.status', completed)
    await settle()
    await emit('cleanCut.status', completed)
    await settle()
    // Work that finished out of view waits behind the bell: one entry, no
    // toast (the owner, 2026-11-22).
    expect(
      toastSpies.success.mock.calls.filter(
        ([title]) => typeof title === 'string' && title.startsWith('Your clean cut is ready')
      )
    ).toHaveLength(0)
    const ready = notifications
      .snapshot()
      .filter((entry) => entry.title.startsWith('Your clean cut is ready'))
    expect(ready).toHaveLength(1)
    expect(ready[0]).toMatchObject({
      title: 'Your clean cut is ready (10:00 → 7:30)',
      actions: [{ label: 'Review' }]
    })
    // The cut copy joins the Library without a click.
    expect(
      backend.sentCommands.filter((command) => command.method === 'sessions.list').length
    ).toBeGreaterThan(listsBefore)
  }, 15_000)

  it('starts no clean cut with the switch off', async () => {
    const backend = new StudioBackend()
    backend.entitlements = premiumEntitlements
    backend.accountSnapshot = signedInAccount
    backend.sessionSummaries = [
      sessionSummary({
        id: 'clean-cut-off',
        mode: 'record',
        durationMs: 600_000,
        mp4Path: '/recordings/clean-cut-off.mp4'
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
    localStorage.setItem('videorc.aiConsent', '1')
    const observations: StudioObservation[] = []
    const latest = (): StudioObservation | undefined => observations.at(-1)
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    await waitForObservation(() => latest()?.core.wsStatus === 'connected')
    await waitForObservation(
      () => latest()?.core.sessions.some((row) => row.id === 'clean-cut-off') === true
    )
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({
          data: JSON.stringify({
            event: 'recording.finalization',
            payload: {
              sessionId: 'clean-cut-off',
              state: 'finalized',
              mp4Path: '/recordings/clean-cut-off.mp4',
              updatedAt: now
            }
          })
        })
      }
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(backend.sentCommands.some((command) => command.method.startsWith('cleanCut.'))).toBe(
      false
    )
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
        return { camera: 'not-determined', microphone: 'granted', screen: 'granted' }
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
    expect(toastSpies.error).toHaveBeenCalledWith("Couldn't check Camera permission", {
      description: 'Try again before changing access.',
      duration: 8_000,
      action: expect.objectContaining({ label: 'Copy' })
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
      getMediaAccessStatus: async () => ({
        camera: 'granted',
        microphone: 'denied',
        screen: 'granted'
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
    expect(latest()?.core.systemAccessContext.pendingPane).toBe('microphone')
    expect(openSystemPermissions).toHaveBeenCalledWith('microphone')
    expect(requestMediaAccess).not.toHaveBeenCalled()
  })

  it.each(['available', 'permission-required'] as const)(
    'keeps screen grants checking until a replacement publishes %s devices',
    async (replacementStatus) => {
      const initial = new StudioBackend()
      const screenDevices = (status: Device['status']): DeviceList => ({
        devices: [{ id: 'screen:screencapturekit:1', kind: 'screen', name: 'Display', status }],
        warnings: []
      })
      initial.deviceList = screenDevices('permission-required')
      TestWebSocket.backend = initial
      vi.stubGlobal('WebSocket', TestWebSocket)
      let screen: 'not-determined' | 'granted' = 'not-determined'
      let emit: ((name: string, value: unknown) => void) | undefined
      const api = createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => [],
        platform: 'darwin',
        backendConnection: { host: '127.0.0.1', port: 9988, pid: 401, token: 'initial' },
        getMediaAccessStatus: async () => ({ camera: 'granted', microphone: 'granted', screen }),
        registerEmitter: (nextEmit) => {
          emit = nextEmit
        }
      })
      api.requestScreenAccess = vi.fn(async () => {
        screen = 'granted'
        return {
          granted: true,
          status: screen,
          restarted: false,
          staleBackend: { port: 9988, pid: 401 }
        }
      })
      const testDom = installProviderTestEnvironment(api)
      restoreEnvironment = testDom.restore
      const observations: StudioObservation[] = []
      const latest = () => observations.at(-1)!
      const access = () =>
        systemAccessRows({
          ...latest().core.systemAccessContext,
          deviceList: latest().core.deviceList,
          audioMeter: latest().audio.audioMeter,
          mediaAccess: latest().core.mediaAccess,
          platform: 'darwin'
        })[0]
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
          latest()?.core.mediaAccess?.screen === 'not-determined'
      )
      expect(access().state).toBe('first-use')
      await act(async () => {
        await latest().core.handleSystemPermission('screen-recording')
      })
      expect(latest().core.systemAccessContext.pendingPane).toBeNull()
      expect(access()).toMatchObject({ checking: true })
      expect(access().state).not.toBe('not-granted')
      expect(access().state).not.toBe('needs-relaunch')

      // A new renderer client on the retired process is not replacement proof.
      act(() =>
        emit?.('backend:connection', { host: '127.0.0.1', port: 9988, pid: 401, token: 'retired' })
      )
      await waitForObservation(
        () => initial.commands.filter((command) => command.method === 'devices.list').length > 1
      )
      expect(access().checking).toBe(true)

      const replacement = new StudioBackend()
      replacement.deviceList = screenDevices(replacementStatus)
      const releaseDevices = replacement.deferResponse('devices.list', replacement.deviceList)
      TestWebSocket.backend = replacement
      act(() =>
        emit?.('backend:connection', {
          host: '127.0.0.1',
          port: 9991,
          pid: 402,
          token: 'replacement'
        })
      )
      await waitForObservation(() =>
        replacement.sentCommands.some((command) => command.method === 'devices.list')
      )
      expect(access().checking).toBe(true)
      await act(async () => releaseDevices())
      await waitForObservation(() => !access().checking)
      expect(access().state).toBe(replacementStatus === 'available' ? 'granted' : 'needs-relaunch')
      expect(latest().core.systemAccessContext.captureRestarting).toBe(false)
      expect(latest().core.systemAccessContext.screenGrantStale).toBe(false)
    }
  )

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
        microphone: 'granted',
        screen: 'granted'
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
        microphone: 'granted',
        screen: 'granted'
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
        microphone: microphoneStatus,
        screen: 'granted'
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
        microphone: microphoneStatus,
        screen: 'granted'
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
            target.id === 'twitch'
              ? {
                  ...target,
                  enabled: true,
                  authMode: 'oauth' as const,
                  accountId: 'twitch-account',
                  status: { state: 'ready' as const }
                }
              : target.id === 'x'
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
          (target) => target.id === 'twitch' && target.enabled && target.authMode === 'oauth'
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
      backend.sentCommands.find((command) => command.method === 'session.start')!.params as {
        audio?: { microphoneGainDb?: number; microphoneMuted?: boolean }
      }
    ).audio
    expect(startAudio).toMatchObject({ microphoneGainDb: 0, microphoneMuted: false })

    await act(async () => {
      latest()?.core.setCaptureConfig((current) => ({
        ...current,
        audio: {
          ...current.audio,
          microphoneGainDb: 6,
          microphoneMuted: true,
          microphoneNoiseSuppression: 'rnnoise'
        }
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
          microphoneNoiseSuppression: 'rnnoise',
          microphoneGainDb: 6,
          microphoneMuted: true
        }
      })
    ])
  })

  it('sends one latest-wins system audio update live and shows the confirmed mix without a toast', async () => {
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
        latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
    )

    await act(async () => {
      await latest()?.core.startSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    const startAudio = (
      backend.sentCommands.find((command) => command.method === 'session.start')!.params as {
        audio?: Record<string, unknown>
      }
    ).audio
    expect(startAudio).toMatchObject({ systemAudioEnabled: false, systemAudioGainDb: -6 })
    const audioUpdates = (): BackendCommand[] =>
      backend.sentCommands.filter((command) => command.method === 'audio.processing.update')
    expect(audioUpdates()).toEqual([])
    // No track reports its mix yet: the switch falls back to the request.
    expect(latest()?.core.systemAudioConfirmed).toBeNull()
    vi.clearAllMocks()

    // Flip On, Off, On and move the level in one burst: the session gets one
    // update with only the system fields that changed since session.start.
    await act(async () => {
      for (const systemAudioEnabled of [true, false, true]) {
        latest()?.core.setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, systemAudioEnabled }
        }))
      }
      latest()?.core.setCaptureConfig((current) => ({
        ...current,
        audio: { ...current.audio, systemAudioGainDb: -9 }
      }))
    })
    await waitForObservation(() => audioUpdates().length === 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(audioUpdates()).toEqual([
      expect.objectContaining({
        params: {
          sessionId: 'session-1',
          microphoneNoiseSuppression: 'off',
          microphoneGainDb: 0,
          microphoneMuted: false,
          systemAudioEnabled: true,
          systemAudioGainDb: -9
        }
      })
    ])

    const micTrack = { id: 'microphone', label: 'Microphone', source: 'microphone' }
    const emitStatus = (mixSources: string[]): void => {
      backend.recordingStatusOverride = {
        state: 'recording',
        sessionId: 'session-1',
        startedAt: now,
        message: 'Recording.',
        audioTracks: [{ ...micTrack, mixSources } as AudioTrack]
      }
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'recording.status',
          payload: backend.recordingStatusOverride
        })
      })
    }
    await act(async () => {
      emitStatus(['microphone'])
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.core.systemAudioConfirmed === false)
    await act(async () => {
      emitStatus(['microphone', 'system-audio'])
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.core.systemAudioConfirmed === true)
    expect(latest()?.core.systemAudioIssue).toBeNull()

    // Lost mid-session: the mix drops the source, the issue names why, and
    // the requested switch state is untouched.
    await act(async () => {
      backend.sockets[0]?.onmessage?.({
        data: JSON.stringify({
          event: 'health.event',
          payload: {
            id: 'health-system-audio-lost',
            sessionId: 'session-1',
            microphoneNoiseSuppression: 'off',
            level: 'warn',
            code: 'system-audio-lost',
            message: 'System audio stopped. The session continues with the microphone.',
            permissionPane: null,
            createdAt: now
          }
        })
      })
      emitStatus(['microphone'])
      await Promise.resolve()
    })
    await waitForObservation(
      () =>
        latest()?.core.systemAudioIssue === 'lost' && latest()?.core.systemAudioConfirmed === false
    )
    expect(latest()?.core.captureConfig.audio.systemAudioEnabled).toBe(true)
    expect(audioUpdates()).toHaveLength(1)
    expect(toastSpies.warning).not.toHaveBeenCalled()
    expect(toastSpies.error).not.toHaveBeenCalled()
    expect(toastSpies.success).not.toHaveBeenCalled()
  })

  it('turns system audio on and off from remote intents and the shortcut, only while it can run', async () => {
    const backend = new StudioBackend()
    backend.deviceList = {
      ...backend.deviceList,
      devices: [
        ...backend.deviceList.devices,
        {
          id: 'system-audio:default',
          name: 'System audio',
          kind: 'system-audio',
          status: 'available'
        }
      ]
    }
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    let emit: (name: string, value: unknown) => void = () => {}
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      registerEmitter: (next) => {
        emit = next
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const observations: StudioObservation[] = []
    const latest = (): StudioCoreContextValue => observations.at(-1)!.core
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    type PublishedState = { systemAudioOn?: boolean; systemAudioAvailable?: boolean }
    const published = (): PublishedState[] =>
      backend.sentCommands
        .filter((command) => command.method === 'remote.surface.publish')
        .map((command) => (command.params as { state: PublishedState }).state)
    const ack = (intentId: string): unknown =>
      backend.sentCommands.find(
        (command) =>
          command.method === 'remote.intent.ack' &&
          (command.params as { intentId?: string }).intentId === intentId
      )?.params
    const sendIntent = async (intentId: string, kind: string): Promise<void> => {
      await act(async () => {
        for (const socket of backend.sockets) {
          socket.onmessage?.({
            data: JSON.stringify({
              event: 'remote.intent',
              payload: { intentId, intent: { kind } }
            })
          })
        }
      })
    }
    await waitForObservation(() => latest().wsStatus === 'connected')
    await act(async () => {
      for (const socket of backend.sockets) {
        socket.onmessage?.({ data: JSON.stringify({ event: 'backend.ready', payload: null }) })
      }
      await Promise.resolve()
    })
    await waitForObservation(() => published().some((state) => state.systemAudioAvailable === true))
    expect(latest().captureConfig.audio.systemAudioEnabled).toBe(false)

    await sendIntent('ri-sa-toggle', 'systemAudioToggle')
    await waitForObservation(() => latest().captureConfig.audio.systemAudioEnabled === true)
    await waitForObservation(() => ack('ri-sa-toggle') !== undefined)
    expect(ack('ri-sa-toggle')).toEqual({ intentId: 'ri-sa-toggle', ok: true })
    await waitForObservation(() => published().at(-1)?.systemAudioOn === true)

    await act(async () => {
      emit('onGlobalShortcut', 'system-audio-toggle')
    })
    await waitForObservation(() => latest().captureConfig.audio.systemAudioEnabled === false)
    await waitForObservation(() => published().at(-1)?.systemAudioOn === false)
    expect(latest().captureConfig.audio.microphoneMuted).toBe(false)
    // The phone and the deck learn two booleans, never the device itself.
    const remoteBodies = JSON.stringify(
      backend.sentCommands.filter((command) => command.method === 'remote.surface.publish')
    )
    expect(remoteBodies).not.toContain('system-audio:default')

    // Without the Screen Recording grant: both paths refuse, nothing flips.
    backend.deviceList = {
      ...backend.deviceList,
      devices: backend.deviceList.devices.map((device) =>
        device.kind === 'system-audio' ? { ...device, status: 'permission-required' } : device
      )
    }
    await act(async () => {
      await latest().refreshBackend()
    })
    await waitForObservation(() => published().at(-1)?.systemAudioAvailable === false)
    await sendIntent('ri-sa-on', 'systemAudioOn')
    await waitForObservation(() => ack('ri-sa-on') !== undefined)
    expect(ack('ri-sa-on')).toEqual({
      intentId: 'ri-sa-on',
      ok: false,
      message: "System audio isn't available."
    })
    await act(async () => {
      emit('onGlobalShortcut', 'system-audio-toggle')
    })
    await waitForObservation(() => toastSpies.warning.mock.calls.length > 0)
    expect(toastSpies.warning).toHaveBeenCalledWith(
      'System audio needs Screen Recording access',
      expect.objectContaining({ id: 'global-shortcut-system-audio' })
    )
    expect(latest().captureConfig.audio.systemAudioEnabled).toBe(false)
    expect(published().at(-1)).toMatchObject({ systemAudioOn: false, systemAudioAvailable: false })
  })

  describe('system audio after a failure (PR #477 review)', () => {
    const withSystemAudioDevice = (backend: StudioBackend): void => {
      backend.deviceList = {
        ...backend.deviceList,
        devices: [
          ...backend.deviceList.devices,
          {
            id: 'system-audio:default',
            name: 'System audio',
            kind: 'system-audio',
            status: 'available'
          }
        ]
      }
    }

    async function startSystemAudioSession(
      backend: StudioBackend,
      beforeStart?: (latest: () => StudioCoreContextValue) => Promise<void>
    ): Promise<{
      latest: () => StudioCoreContextValue
      emit: (name: string, value: unknown) => void
      updates: () => Array<Record<string, unknown>>
      emitMix: (mixSources: string[]) => Promise<void>
      emitIssue: (code: string) => Promise<void>
      sendIntent: (intentId: string, kind: string) => Promise<void>
    }> {
      withSystemAudioDevice(backend)
      TestWebSocket.backend = backend
      vi.stubGlobal('WebSocket', TestWebSocket)
      let emit: (name: string, value: unknown) => void = () => {}
      const api = createVideorcApi({
        acknowledge: async () => true,
        pending: async () => [],
        acknowledgeProvider: async () => true,
        pendingProvider: async () => [],
        registerEmitter: (next) => {
          emit = next
        }
      })
      const testDom = installProviderTestEnvironment(api)
      restoreEnvironment = testDom.restore
      const observations: StudioObservation[] = []
      const latest = (): StudioCoreContextValue => observations.at(-1)!.core
      root = await mountStudioProvider(testDom.container, (value) => {
        observations.push(value)
      })
      await waitForObservation(
        () =>
          latest().wsStatus === 'connected' &&
          latest().captureConfig.sources.microphoneId === 'mic:1'
      )
      if (beforeStart) await beforeStart(latest)
      await act(async () => {
        await latest().startSession()
      })
      await waitForObservation(() => observations.at(-1)?.recording.recording.state === 'recording')
      const broadcast = (event: string, payload: unknown): void => {
        for (const socket of backend.sockets) {
          socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
        }
      }
      const emitMix = async (mixSources: string[]): Promise<void> => {
        backend.recordingStatusOverride = {
          state: 'recording',
          sessionId: 'session-1',
          startedAt: now,
          message: 'Recording.',
          audioTracks: [
            {
              id: 'microphone',
              label: 'Microphone',
              source: 'microphone',
              mixSources
            } as AudioTrack
          ]
        }
        await act(async () => {
          broadcast('recording.status', backend.recordingStatusOverride)
          await Promise.resolve()
        })
      }
      const emitIssue = async (code: string): Promise<void> => {
        await act(async () => {
          broadcast('health.event', {
            id: `health-${code}-${backend.sentCommands.length}`,
            sessionId: 'session-1',
            level: 'warn',
            code,
            message: 'System audio could not start.',
            permissionPane: null,
            createdAt: now
          })
          await Promise.resolve()
        })
      }
      const sendIntent = async (intentId: string, kind: string): Promise<void> => {
        await act(async () => {
          broadcast('remote.intent', { intentId, intent: { kind } })
        })
      }
      const updates = (): Array<Record<string, unknown>> =>
        backend.sentCommands
          .filter((command) => command.method === 'audio.processing.update')
          .map((command) => command.params as Record<string, unknown>)
      return {
        latest,
        emit: (name, value) => emit(name, value),
        updates,
        emitMix,
        emitIssue,
        sendIntent
      }
    }

    it('toggles off after unavailable and lost, re-sends mid-transition, and On again retries', async () => {
      const backend = new StudioBackend()
      const { latest, emit, updates, emitMix, emitIssue, sendIntent } =
        await startSystemAudioSession(backend)
      const toggle = async (): Promise<void> => {
        await act(async () => {
          emit('onGlobalShortcut', 'system-audio-toggle')
        })
      }

      await toggle()
      await waitForObservation(() => updates().length === 1)
      expect(updates()[0]).toMatchObject({ systemAudioEnabled: true })
      expect(latest().captureConfig.audio.systemAudioEnabled).toBe(true)

      // Mid-transition: requested On, the session still mixes only the mic
      // ("Turning on…"). The switch shows Off, so the toggle asks for On
      // again, and that request is sent, not dropped as unchanged.
      await emitMix(['microphone'])
      await waitForObservation(() => latest().systemAudioConfirmed === false)
      await toggle()
      await waitForObservation(() => updates().length === 2)
      expect(updates()[1]).toMatchObject({ systemAudioEnabled: true })
      expect(latest().captureConfig.audio.systemAudioEnabled).toBe(true)

      // Unavailable: the switch stays On with the issue; a toggle turns it Off.
      await emitIssue('system-audio-unavailable')
      await waitForObservation(() => latest().systemAudioIssue === 'unavailable')
      await toggle()
      await waitForObservation(() => latest().captureConfig.audio.systemAudioEnabled === false)
      await waitForObservation(() => updates().length === 3)
      expect(updates()[2]).toMatchObject({ systemAudioEnabled: false })
      expect(latest().systemAudioIssue).toBeNull()

      // On again: sent, and the old issue does not come back while it starts.
      await toggle()
      await waitForObservation(() => latest().captureConfig.audio.systemAudioEnabled === true)
      await waitForObservation(() => updates().length === 4)
      expect(updates()[3]).toMatchObject({ systemAudioEnabled: true })
      expect(latest().systemAudioIssue).toBeNull()

      // Lost mid-session: the phone or deck toggle turns it Off too.
      await emitMix(['microphone', 'system-audio'])
      await waitForObservation(() => latest().systemAudioConfirmed === true)
      await emitIssue('system-audio-lost')
      await emitMix(['microphone'])
      await waitForObservation(
        () => latest().systemAudioIssue === 'lost' && latest().systemAudioConfirmed === false
      )
      await sendIntent('ri-sa-after-lost', 'systemAudioToggle')
      await waitForObservation(() => latest().captureConfig.audio.systemAudioEnabled === false)
      await waitForObservation(() => updates().length === 5)
      expect(updates()[4]).toMatchObject({ systemAudioEnabled: false })
      expect(latest().systemAudioIssue).toBeNull()
    })

    it('restores Off after unavailable RNNoise while keeping gain and mute live', async () => {
      const backend = new StudioBackend()
      backend.audioProcessingReasonCode = 'microphone-noise-suppression-unavailable'
      const { latest, updates } = await startSystemAudioSession(backend)
      await act(async () => {
        latest().setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, microphoneNoiseSuppression: 'rnnoise' }
        }))
      })
      await waitForObservation(
        () =>
          updates().length >= 1 && latest().captureConfig.audio.microphoneNoiseSuppression === 'off'
      )
      expect(latest().lastError).toContain('Noise reduction is unavailable')
      backend.audioProcessingReasonCode = null
      await act(async () => {
        latest().setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, microphoneGainDb: 6, microphoneMuted: true }
        }))
      })
      await waitForObservation(() => updates().at(-1)?.microphoneGainDb === 6)
      expect(updates().at(-1)).toMatchObject({
        microphoneNoiseSuppression: 'off',
        microphoneGainDb: 6,
        microphoneMuted: true
      })
    })

    const startWithNoiseReduction = async (latest: () => StudioCoreContextValue): Promise<void> => {
      await act(async () => {
        latest().setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, microphoneNoiseSuppression: 'rnnoise' }
        }))
      })
    }

    it('confirms noise reduction once after a start that asked for it', async () => {
      const backend = new StudioBackend()
      const { latest, updates } = await startSystemAudioSession(backend, startWithNoiseReduction)
      const started = backend.sentCommands.find((command) => command.method === 'session.start')
      expect(
        (started!.params as { audio: { microphoneNoiseSuppression?: string } }).audio
      ).toMatchObject({ microphoneNoiseSuppression: 'rnnoise' })
      await waitForObservation(() => updates().length === 1)
      expect(updates()[0]).toMatchObject({
        sessionId: 'session-1',
        microphoneNoiseSuppression: 'rnnoise'
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      expect(updates()).toHaveLength(1)
      expect(latest().captureConfig.audio.microphoneNoiseSuppression).toBe('rnnoise')
      expect(latest().lastError).toBeNull()
      expect(toastSpies.error).not.toHaveBeenCalled()
      expect(toastSpies.warning).not.toHaveBeenCalled()
    })

    it('shows Off and one message when the started session cannot run noise reduction', async () => {
      // A microphone that bypasses the session audio bus starts without
      // noise reduction: the confirmation after start is rejected, the
      // rollback shows Off, and the backend's own record of the downgrade
      // (its health event) adds no second notice.
      const backend = new StudioBackend()
      backend.audioProcessingReasonCode = 'microphone-noise-suppression-unavailable'
      const { latest, updates, emitIssue } = await startSystemAudioSession(
        backend,
        startWithNoiseReduction
      )
      await waitForObservation(
        () =>
          updates().length >= 1 && latest().captureConfig.audio.microphoneNoiseSuppression === 'off'
      )
      expect(updates()[0]).toMatchObject({ microphoneNoiseSuppression: 'rnnoise' })
      expect(latest().lastError).toContain(
        'Noise reduction is unavailable for this capture. It is Off.'
      )
      // The sync runs on its own (the Clips ring starts it at launch too), so
      // its notice is an entry behind the bell (the owner, 2026-11-22), and
      // still only one: no toast besides it, no second entry.
      const notices = (): number =>
        toastSpies.error.mock.calls.length +
        toastSpies.warning.mock.calls.length +
        notifications.snapshot().filter((entry) => entry.kind === 'backend-error').length
      await waitForObservation(() => notices() === 1)
      // Recording with quiet on: the entry waits behind the bell, no toast.
      expect(toastSpies.error).not.toHaveBeenCalled()
      expect(toastSpies.warning).not.toHaveBeenCalled()
      expect(
        notifications.snapshot().filter((entry) => entry.kind === 'backend-error')
      ).toHaveLength(1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      // A rejection re-sends the system audio fields (PR #477 review); that
      // and anything after it asks for Off, never for noise reduction again.
      const settled = updates().length
      expect(
        updates()
          .slice(1)
          .map((update) => update.microphoneNoiseSuppression)
      ).toEqual(
        updates()
          .slice(1)
          .map(() => 'off')
      )
      await emitIssue('microphone-noise-suppression-unavailable')
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      expect(updates()).toHaveLength(settled)
      expect(latest().captureConfig.audio.microphoneNoiseSuppression).toBe('off')
      expect(notices()).toBe(1)
    })

    it('sends a rejected system audio update again instead of treating it as sent', async () => {
      const backend = new StudioBackend()
      backend.audioProcessingReasonCode = 'stale-session'
      const { latest, updates } = await startSystemAudioSession(backend)
      await act(async () => {
        latest().setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, systemAudioEnabled: true }
        }))
      })
      await waitForObservation(() => updates().length === 1)
      expect(updates()[0]).toMatchObject({ systemAudioEnabled: true })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      // The session never applied it; the next update carries it again.
      backend.audioProcessingReasonCode = null
      await act(async () => {
        latest().setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, systemAudioGainDb: -9 }
        }))
      })
      await waitForObservation(() => updates().length === 2)
      expect(updates()[1]).toMatchObject({ systemAudioEnabled: true, systemAudioGainDb: -9 })

      // Once applied, a level change carries only the level.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      await act(async () => {
        latest().setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, systemAudioGainDb: -12 }
        }))
      })
      await waitForObservation(() => updates().length === 3)
      expect(updates()[2]).not.toHaveProperty('systemAudioEnabled')
      expect(updates()[2]).toMatchObject({ systemAudioGainDb: -12 })
    })
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

  it('requires another confirmation when a saved event becomes public before preparation', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.scheduledConfirmation = {
      eventId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'private-v1',
      title: 'Saved',
      privacy: 'private',
      startUtc: '2035-01-01T12:00:00Z'
    }
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
    const latest = () => observations.at(-1)
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
      latest()!.core.patchStreamingTarget('youtube', {
        scheduledEventId: backend.scheduledConfirmation!.eventId
      })
    })
    backend.scheduledConfirmation = {
      ...backend.scheduledConfirmation,
      fingerprint: 'public-v2',
      privacy: 'public'
    }
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })
    expect(
      backend.sentCommands.filter(
        (command) => command.method === 'scheduledStreams.prepareForGoLive'
      )
    ).toHaveLength(0)
    expect(latest()!.core.goLiveConfirmationOpen).toBe(true)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })
    expect(
      backend.sentCommands.filter(
        (command) => command.method === 'scheduledStreams.prepareForGoLive'
      )[0]?.params
    ).toMatchObject({ confirmationFingerprint: 'public-v2' })
    await act(async () => {
      await latest()!.core.stopSession()
    })
  })

  it.each([false, true])(
    'uses the saved identity and preserves pre-live scheduled cleanup (start rejected: %s)',
    async (rejectStart) => {
      const backend = new StudioBackend()
      enableYouTubeOauthForTest(backend)
      if (rejectStart) backend.sessionStartError = 'The encoder rejected this start.'
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
        latest()!.core.patchStreamingTarget('youtube', {
          scheduledEventId: '11111111-1111-4111-8111-111111111111',
          scheduledEventTitle: 'Saved title',
          scheduledPrivacy: 'private'
        })
      })
      await act(async () => {
        await latest()!.core.confirmGoLive()
      })
      expect(backend.youtubePrepareCount).toBe(0)
      expect(
        backend.sentCommands.filter(
          (command) => command.method === 'scheduledStreams.prepareForGoLive'
        )
      ).toHaveLength(1)
      expect(
        backend.sentCommands.filter(
          (command) => command.method === 'streamTargets.youtube.transition'
        )
      ).toHaveLength(0)
      if (rejectStart) {
        expect(
          backend.sentCommands.filter(
            (command) => command.method === 'scheduledStreams.releasePreparation'
          )
        ).toHaveLength(1)
        expect(
          backend.sentCommands.filter((command) => command.method === 'scheduledStreams.activate')
        ).toHaveLength(0)
      } else {
        expect(
          backend.sentCommands.filter((command) => command.method === 'scheduledStreams.activate')
        ).toHaveLength(1)
        expect(
          latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
            ?.platformBroadcastId
        ).toBe('advertised-scheduled-id')
        await act(async () => {
          await latest()!.core.stopSession()
        })
        expect(
          backend.sentCommands.filter(
            (command) => command.method === 'scheduledStreams.releasePreparation'
          )
        ).toHaveLength(1)
      }
    }
  )

  it.each([false, true])(
    'starts a saved X broadcast through its schedule and releases it on stop (start rejected: %s)',
    async (rejectStart) => {
      const backend = new StudioBackend()
      enableXOauthForTest(backend)
      backend.scheduledConfirmationTargetId = 'x'
      backend.scheduledConfirmation = {
        eventId: '22222222-2222-4222-8222-222222222222',
        fingerprint: 'x-v1',
        title: 'Saved X broadcast',
        privacy: '',
        startUtc: '2035-01-01T12:00:00Z'
      }
      if (rejectStart) backend.sessionStartError = 'The encoder rejected this start.'
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
        latest()!.core.patchStreamingTarget('x', {
          scheduledEventId: '22222222-2222-4222-8222-222222222222',
          scheduledEventTitle: 'Saved X broadcast'
        })
      })
      await act(async () => {
        await latest()!.core.confirmGoLive()
      })
      // The saved broadcast owns its source: no fresh session source, and no
      // create+publish pair — the schedule itself goes live.
      expect(backend.xPrepareCount).toBe(0)
      expect(backend.xPublishCount).toBe(0)
      expect(
        backend.sentCommands.filter(
          (command) => command.method === 'scheduledStreams.prepareForGoLive'
        )
      ).toHaveLength(1)
      if (rejectStart) {
        expect(
          backend.sentCommands.filter((command) => command.method === 'scheduledStreams.activate')
        ).toHaveLength(0)
        expect(
          backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
        ).toHaveLength(0)
        expect(
          backend.sentCommands.filter(
            (command) => command.method === 'scheduledStreams.releasePreparation'
          )
        ).toHaveLength(1)
      } else {
        expect(
          backend.sentCommands.filter((command) => command.method === 'scheduledStreams.activate')
        ).toHaveLength(1)
        const live = latest()?.core.captureConfig.streaming.targets.find(
          (target) => target.id === 'x'
        )
        expect(live?.platformBroadcastId).toBe('advertised-x-scheduled-id')
        expect(live?.platformStreamId).toBe('x-scheduled-media-key')
        expect(
          backend.sentCommands.filter((command) => command.method === 'liveChat.x.start')[0]?.params
        ).toMatchObject({
          broadcastId: 'advertised-x-scheduled-id',
          mediaKey: 'x-scheduled-media-key'
        })
        await act(async () => {
          await latest()!.core.stopSession()
        })
        // END goes to the exact advertised broadcast, then the schedule is
        // released exactly once.
        expect(
          backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
        ).toEqual([
          expect.objectContaining({
            params: expect.objectContaining({ broadcastId: 'advertised-x-scheduled-id' })
          })
        ])
        expect(
          backend.sentCommands.filter(
            (command) => command.method === 'scheduledStreams.releasePreparation'
          )
        ).toHaveLength(1)
      }
    }
  )

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

  // Plan 174 S2.2 (D3) and S3.1 (B-3): the Studio transport and ⌘K share the
  // provider's two starts, and each is an explicit intent. Go Live… opens the
  // Go Live dialog and starts nothing on its own; Record starts a local take
  // at once. Neither writes the saved output mode: the Output page's "Save
  // local recording" and the Destinations page's destinations stay as they are.
  it('starts Go Live… and Record through the shared provider starts', async () => {
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
    await act(async () => {
      latest()!.core.setCaptureConfig({
        ...youtubeOauthStreamCaptureConfig(),
        recordEnabled: true,
        streamEnabled: false
      })
    })
    await waitForObservation(() => latest()?.core.startBlockedReason === null)
    // Both reasons come from one function (S3.1): with a ready destination
    // and a saved record-only mode, both starts can run.
    expect(latest()!.core.recordBlockedReason).toBeNull()
    expect(latest()!.core.liveStreamBlockedReason).toBeNull()

    let goLive!: Promise<boolean>
    await act(async () => {
      goLive = latest()!.core.startLivestream()
    })
    await waitForObservation(() => latest()?.core.goLiveConfirmationOpen === true)
    // Opening the dialog is not a started stream, and the saved mode is untouched.
    expect(await goLive).toBe(false)
    expect(latest()!.core.captureConfig).toMatchObject({
      recordEnabled: true,
      streamEnabled: false
    })
    expect(backend.commands.some((command) => command.method === 'session.start')).toBe(false)

    await act(async () => {
      latest()!.core.cancelGoLiveConfirmation()
    })
    await waitForObservation(() => latest()?.core.goLiveConfirmationOpen === false)

    // Record while "Save local recording" is OFF still records: Record is a
    // take, and the Output switch only decides whether a Go Live records too.
    await act(async () => {
      latest()!.core.setCaptureConfig({
        ...latest()!.core.captureConfig,
        recordEnabled: false
      })
    })
    await waitForObservation(() => latest()?.core.captureConfig.recordEnabled === false)
    let recorded!: Promise<boolean>
    await act(async () => {
      recorded = latest()!.core.startRecording()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    expect(await recorded).toBe(true)
    expect(latest()!.core.sessionStartIntent).toEqual({ record: true, stream: false })
    const start = backend.sentCommands.find((command) => command.method === 'session.start')
    expect(start?.params).toMatchObject({ output: { recordEnabled: true, streamEnabled: false } })
    expect(latest()!.core.captureConfig).toMatchObject({
      recordEnabled: false,
      streamEnabled: false
    })
    expect(latest()?.core.goLiveConfirmationOpen).toBe(false)
    await act(async () => {
      await latest()!.core.stopSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
    expect(latest()!.core.sessionStartIntent).toBeNull()
  })

  // Plan 174 S3.1 (the Phase 0 review): a Go Live preflight that is still
  // pending owns the transport, so Record (the button, Space, a hotkey, ⌘K,
  // a remote) cannot start a record-only take underneath it.
  it('ignores Record while the Go Live preflight is pending', async () => {
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
    await act(async () => {
      latest()!.core.setCaptureConfig(youtubeOauthStreamCaptureConfig())
    })
    await waitForObservation(() => latest()?.core.liveStreamBlockedReason === null)

    const releasePreflight = backend.deferResponse('streamTargets.confirmation.validate', {
      valid: true,
      destinations: [],
      issues: []
    })
    let goLive!: Promise<boolean>
    await act(async () => {
      goLive = latest()!.core.startLivestream()
    })
    await waitForObservation(() => latest()?.core.goLiveConfirmationPending === true)
    // "Checking…" is on, the dialog is not yet in the DOM, and Record is held.
    expect(latest()!.core.goLiveConfirmationOpen).toBe(false)
    let recorded: boolean | undefined
    await act(async () => {
      recorded = await latest()!.core.startRecording()
    })
    expect(recorded).toBe(false)
    expect(backend.commands.some((command) => command.method === 'session.start')).toBe(false)
    // A second Go Live click joins the first instead of running a second preflight.
    let secondGoLive!: Promise<boolean>
    await act(async () => {
      secondGoLive = latest()!.core.startLivestream()
    })
    await act(async () => {
      releasePreflight()
      await Promise.all([goLive, secondGoLive])
    })
    await waitForObservation(() => latest()?.core.goLiveConfirmationOpen === true)
    expect(
      backend.sentCommands.filter(
        (command) => command.method === 'streamTargets.confirmation.validate'
      )
    ).toHaveLength(1)
    expect(backend.commands.some((command) => command.method === 'session.start')).toBe(false)
    await act(async () => {
      latest()!.core.cancelGoLiveConfirmation()
    })
  })

  // Plan 094 (bug 1): the owner's failed `complete` on quota was retained and
  // every later Record retried it ("Finish cleaning up the previous livestream
  // providers before starting again") until midnight Pacific. YouTube ends the
  // broadcast itself (enableAutoStop), so a quota refusal is settled.
  it('settles a quota-refused completion so the next start never retries it', async () => {
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.sessionStartError = 'The encoder rejected this start.'
    backend.youtubeCompleteQuotaFailuresRemaining = 1
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

    const completions = (): number =>
      backend.sentCommands.filter(
        (command) =>
          command.method === 'streamTargets.youtube.transition' &&
          (command.params as { status?: string }).status === 'complete'
      ).length
    expect(backend.youtubePrepareCount).toBe(1)
    expect(completions()).toBe(1)
    const youtubeTarget = latest()!.core.captureConfig.streaming.targets.find(
      (target) => target.platform === 'youtube'
    )
    expect(youtubeTarget?.status?.state).toBe('stopped')
    expect(youtubeTarget?.status?.message).toContain('ends the broadcast on its own')

    // A recording-only start proceeds at once: no completion retry, no
    // "finish cleaning up" error.
    backend.sessionStartError = null
    await act(async () => {
      latest()!.core.setCaptureConfig({
        ...latest()!.core.captureConfig,
        recordEnabled: true,
        streamEnabled: false
      })
    })
    await act(async () => {
      await latest()!.core.startSession()
    })
    expect(completions()).toBe(1)
    expect(latest()?.core.lastError ?? null).toBeNull()
    expect(
      backend.sentCommands.filter((command) => command.method === 'session.start')
    ).toHaveLength(2)
  })

  // Plan 174 S3.4 (B-8): "Go live without X" used to switch X off in the
  // saved settings, so every later Go Live skipped it too.
  it('leaves a destination out of one Go Live only, and never saves it', async () => {
    const backend = new StudioBackend()
    enableYouTubeAndXOauthForTest(backend)
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
    const savedX = () =>
      latest()!.core.captureConfig.streaming.targets.find((target) => target.id === 'x')
    const lastValidation = () =>
      backend.sentCommands
        .filter((command) => command.method === 'streamTargets.confirmation.validate')
        .at(-1)?.params as { streaming: StreamingSettings } | undefined

    // Left out, then brought back, then left out again: the saved X stays on.
    await openYouTubeAndXGoLiveConfirmation(latest)
    await act(async () => {
      await latest()!.core.resolveGoLiveBlocker('x', 'exclude')
    })
    expect(latest()!.core.goLiveExcludedTargetIds).toEqual(['x'])
    expect(lastValidation()?.streaming.enabledTargetIds).toEqual(['youtube'])
    await act(async () => {
      await latest()!.core.resolveGoLiveBlocker('x', 'include')
    })
    expect(latest()!.core.goLiveExcludedTargetIds).toEqual([])
    expect(lastValidation()?.streaming.enabledTargetIds).toEqual(['youtube', 'x'])
    await act(async () => {
      await latest()!.core.resolveGoLiveBlocker('x', 'exclude')
    })
    expect(savedX()?.enabled).toBe(true)
    expect(latest()!.core.captureConfig.streaming.enabledTargetIds).toContain('x')

    // Cancelling forgets it.
    await act(async () => {
      latest()!.core.cancelGoLiveConfirmation()
    })
    expect(latest()!.core.goLiveExcludedTargetIds).toEqual([])

    // Going live without X: X is never prepared or started, and stays saved on.
    await act(async () => {
      await latest()!.core.startSession()
    })
    await waitForObservation(() => latest()?.core.goLiveConfirmationOpen === true)
    expect(lastValidation()?.streaming.enabledTargetIds).toEqual(['youtube', 'x'])
    await act(async () => {
      await latest()!.core.resolveGoLiveBlocker('x', 'exclude')
    })
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    const start = backend.sentCommands.find((command) => command.method === 'session.start')
    expect((start!.params as { streaming: StreamingSettings }).streaming.enabledTargetIds).toEqual([
      'youtube'
    ])
    expect(backend.xPrepareCount).toBe(0)
    expect(backend.youtubePrepareCount).toBe(1)
    expect(savedX()?.enabled).toBe(true)

    // The attempt over, the next Go Live starts from the saved destinations.
    await act(async () => {
      await latest()!.core.stopSession()
    })
    await waitForObservation(
      () =>
        latest()?.recording.recording.state === 'idle' &&
        latest()?.core.goLiveExcludedTargetIds.length === 0
    )
    expect(savedX()?.enabled).toBe(true)
  })

  // Plan 209 S10 (D13): an agent's go_live runs the dialog's own preflight,
  // gate and confirm with no dialog, and refuses what the dialog would hold.
  it('goes live from an agent without the Go Live dialog, through its own checks', async () => {
    const backend = new StudioBackend()
    enableYouTubeAndXOauthForTest(backend)
    backend.xPrepareFailuresRemaining = 1
    backend.confirmationRowsFromStreaming = true
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
      latest()!.core.setCaptureConfig(youtubeAndXOauthStreamCaptureConfig())
    })
    await waitForObservation(
      () =>
        latest()?.core.streamOutputTopologyPreflight.state === 'ready' &&
        latest()?.core.startBlockedReason === null
    )
    const pushIntent = async (intentId: string, args: Record<string, unknown>): Promise<void> => {
      await act(async () => {
        backend.sockets[0]?.onmessage?.({
          data: JSON.stringify({
            event: 'agent.intent',
            payload: { intentId, agentId: 'agent-1', agentName: 'Claude', tool: 'go_live', args }
          })
        })
        await Promise.resolve()
      })
    }
    const ack = (intentId: string) =>
      backend.sentCommands
        .filter((command) => command.method === 'agent.intent.ack')
        .map(
          (command) =>
            command.params as { intentId: string; ok: boolean; message?: string; result?: unknown }
        )
        .find((params) => params.intentId === intentId)
    const starts = () =>
      backend.sentCommands.filter((command) => command.method === 'session.start')

    const sentTargets = (index: number): string[] =>
      (starts()[index]!.params as { streaming: StreamingSettings }).streaming.targets
        .filter((target) => target.enabled)
        .map((target) => target.id)
    const stop = async (): Promise<void> => {
      await act(async () => {
        await latest()!.core.stopSession()
      })
      await waitForObservation(() => latest()?.recording.recording.state === 'idle')
    }

    // YouTube goes out Unlisted (the saved draft): an agent is refused unless
    // the call accepts it, as the dialog asks the streamer once more
    // (owner report, 2026-11-12). Nothing is prepared or started.
    await pushIntent('go-0', { destinations: ['youtube'], title: 'Building an MCP live' })
    await waitForObservation(() => ack('go-0') !== undefined)
    expect(ack('go-0')).toMatchObject({ ok: false })
    expect(ack('go-0')?.message).toContain(
      'YouTube is Unlisted. Only people with the link can watch.'
    )
    expect(ack('go-0')?.message).toContain('allowNonPublic')
    expect(starts()).toHaveLength(0)

    // Naming YouTube leaves X out of this livestream only, like the dialog's
    // "Go live without X": X is never prepared and stays on. The title is
    // the dialog's Title field, saved before the check.
    await pushIntent('go-1', {
      destinations: ['youtube'],
      title: 'Building an MCP live',
      allowNonPublic: true
    })
    await waitForObservation(() => ack('go-1') !== undefined)
    expect(ack('go-1')).toMatchObject({
      ok: true,
      message: "You're live on YouTube.",
      result: { live: true, destinations: [{ id: 'youtube', platform: 'youtube' }] }
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    expect(starts()).toHaveLength(1)
    expect(sentTargets(0)).toEqual(['youtube'])
    expect(
      (starts()[0]!.params as { streaming: StreamingSettings }).streaming.enabledTargetIds
    ).toEqual(['youtube'])
    expect(backend.xPrepareCount).toBe(0)
    expect(
      latest()!.core.captureConfig.streaming.targets.find((target) => target.id === 'x')?.enabled
    ).toBe(true)
    const savedDraft = backend.sentCommands
      .filter((command) => command.method === 'streamTargets.metadata.update')
      .at(-1)?.params as { title?: string } | undefined
    expect(savedDraft?.title).toBe('Building an MCP live')

    // Already live: the same refusal a deck reads.
    await pushIntent('go-2', {})
    await waitForObservation(() => ack('go-2') !== undefined)
    expect(ack('go-2')).toMatchObject({ ok: false, message: "You're already recording or live." })
    await stop()

    // X fails its platform setup: without allowPartial the agent is told the
    // dialog's words and nothing starts...
    backend.xPrepareFailuresRemaining = 1
    await pushIntent('go-3', { allowNonPublic: true })
    await waitForObservation(() => ack('go-3') !== undefined)
    expect(ack('go-3')).toMatchObject({ ok: false })
    expect(ack('go-3')?.message).toContain("Some destinations couldn't be set up")
    expect(ack('go-3')?.message).toContain('Ready: YouTube')
    expect(ack('go-3')?.message).toContain('allowPartial')
    expect(starts()).toHaveLength(1)

    // ...and with allowPartial it goes live on the ready one, as "Go live on
    // YouTube" does.
    await act(async () => {
      latest()!.core.setCaptureConfig(youtubeAndXOauthStreamCaptureConfig())
    })
    await waitForObservation(() => latest()?.core.startBlockedReason === null)
    backend.xPrepareFailuresRemaining = 1
    await pushIntent('go-4', { allowPartial: true, allowNonPublic: true })
    await waitForObservation(() => ack('go-4') !== undefined)
    expect(ack('go-4')).toMatchObject({
      ok: true,
      result: { destinations: [{ id: 'youtube' }] }
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    expect(starts()).toHaveLength(2)
    expect(sentTargets(1)).toEqual(['youtube'])
    // Never once through the dialog.
    expect(observations.some((value) => value.core.goLiveConfirmationOpen)).toBe(false)
    await act(async () => {
      await latest()!.core.stopSession()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'idle')
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
        latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
          ?.status?.state
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
        latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
          ?.status?.state
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
          (target) => target.id === 'youtube' && target.status?.state === 'live'
        )
      )
    ).toBe(false)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
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
          (target) => target.id === 'youtube' && target.status?.state === 'live'
        )
      )
    ).toBe(false)
    expect(latest()?.recording.recording).toMatchObject({
      state: 'failed',
      sessionId: 'session-1'
    })
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
        ?.status?.state
    ).toBe('stopped')
  })

  it('ends the actual X broadcast when the session dies during publish', async () => {
    const backend = new StudioBackend()
    enableXOauthForTest(backend)
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
          (target) => target.id === 'x' && target.status?.state === 'live'
        )
      )
    ).toBe(false)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'x')?.status
        ?.state
    ).toBe('stopped')
  })

  it('shows a published X broadcast live with its share link and no error', async () => {
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

    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'x')?.status
    ).toMatchObject({
      state: 'live',
      message: 'X broadcast is live: https://x.com/i/broadcasts/1',
      redactedUrl: 'https://x.com/i/broadcasts/1'
    })
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'x')?.status
        ?.lastError
    ).toBeUndefined()
    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.publish')
    ).toEqual([
      expect.objectContaining({
        params: expect.not.objectContaining({ region: expect.anything() })
      })
    ])
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
            (target) => target.id === 'youtube' || target.id === 'x'
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
        latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
          ?.status?.state === 'warning'
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
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
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
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
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
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
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
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'youtube')
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
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'x')?.status
        ?.state
    ).toBe('warning')

    await act(async () => {
      await latest()!.core.startSession()
    })

    expect(
      backend.sentCommands.filter((command) => command.method === 'streamTargets.x.end')
    ).toHaveLength(2)
    expect(
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'x')?.status
        ?.state
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
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'x')?.status
        ?.state
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
            target.id === 'x'
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
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'x')
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
      latest()?.core.captureConfig.streaming.targets.find((target) => target.id === 'x')?.status
        ?.state
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
    const releaseStart = backend.deferResponse('session.start', {
      state: 'recording',
      sessionId: 'session-1',
      startedAt: now,
      message: 'Recording.'
    })
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
      releaseStart()
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

  it.each([
    { recordEnabled: true, streamPreset: 'stream-safe-1080p30' as const },
    { recordEnabled: false, streamPreset: 'stream-safe-1080p30' as const },
    { recordEnabled: true, streamPreset: 'stream-youtube-4k30' as const },
    { recordEnabled: true, streamPreset: 'stream-safe-1080p30' as const, vertical: true },
    { recordEnabled: true, streamPreset: 'stream-safe-1080p30' as const, scheduled: true }
  ])(
    'prepares $streamPreset independently of a 4K recording profile (record: $recordEnabled)',
    async (scenario) => {
      const { recordEnabled, streamPreset } = scenario
      const vertical = 'vertical' in scenario && scenario.vertical
      const scheduled = 'scheduled' in scenario && scenario.scheduled
      const backend = new StudioBackend()
      backend.hardwareStreamTopology = true
      if (scheduled)
        backend.scheduledConfirmation = {
          eventId: '11111111-1111-4111-8111-111111111111',
          fingerprint: 'private-v1',
          title: 'Scheduled HD',
          privacy: 'private',
          startUtc: '2035-01-01T12:00:00Z'
        }
      enableYouTubeOauthForTest(backend)
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
      const latest = () => observations.at(-1)
      root = await mountStudioProvider(testDom.container, (value) => {
        observations.push(value)
      })
      await waitForObservation(
        () =>
          latest()?.core.wsStatus === 'connected' &&
          latest()?.core.captureConfig.sources.microphoneId === 'mic:1'
      )
      await act(async () => {
        latest()!.core.setCaptureConfig({
          ...youtubeOauthStreamCaptureConfig(),
          recordEnabled,
          streaming: {
            ...youtubeOauthStreamCaptureConfig().streaming,
            defaultOutputPreset: streamPreset,
            defaultBitrateKbps: videoPresets[streamPreset].bitrateKbps,
            targets: youtubeOauthStreamCaptureConfig().streaming.targets.map((target) =>
              target.id === 'youtube'
                ? {
                    ...target,
                    ...(vertical ? { outputOrientation: 'vertical' as const } : {}),
                    ...(scheduled
                      ? { scheduledEventId: backend.scheduledConfirmation!.eventId }
                      : {})
                  }
                : target
            )
          },
          video: videoPresets['record-4k30']
        })
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
      await act(async () => {
        await latest()!.core.confirmGoLive()
      })
      expect(
        backend.sentCommands.find(
          (c) =>
            c.method ===
            (scheduled ? 'scheduledStreams.prepareForGoLive' : 'streamTargets.youtube.prepare')
        )?.params
      ).toMatchObject({
        video: vertical
          ? { width: 1080, height: 1920, fps: 30, bitrateKbps: 6000 }
          : videoPresets[streamPreset]
      })
      if (recordEnabled) {
        expect(
          backend.sentCommands.find((c) => c.method === 'session.start')?.params
        ).toMatchObject({
          output: { recordEnabled: true, video: { width: 3840, height: 2160, bitrateKbps: 30000 } }
        })
      }
      if (vertical) {
        expect(
          backend.sentCommands.find((c) => c.method === 'session.start')?.params
        ).toMatchObject({
          simulcast: { video: { width: 1080, height: 1920, fps: 30, bitrateKbps: 6000 } }
        })
      }
      await act(async () => {
        await latest()!.core.stopSession()
      })
    }
  )

  it('goes live on one shared encode when the host rejects a separate stream encoder', async () => {
    // The fake backend answers every probe with the raw path, i.e. a host
    // with no usable hardware encoder: a split request comes back rejected.
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

    const base = youtubeOauthStreamCaptureConfig()
    const streamBitrateKbps = base.streaming.defaultBitrateKbps
    const recordingBitrateKbps = streamBitrateKbps + 2000
    await act(async () => {
      latest()!.core.setCaptureConfig({
        ...base,
        recordEnabled: true,
        video: { ...base.video, preset: 'custom', bitrateKbps: recordingBitrateKbps }
      })
    })
    // No manual bitrate matching: the rejected split re-plans by itself.
    await waitForObservation(
      () =>
        latest()?.core.streamOutputTopologyPreflight.state === 'ready' &&
        latest()?.core.streamSharedEncodeFallbackVideo !== null
    )
    expect(latest()?.core.startBlockedReason).toBeNull()
    expect(latest()?.core.streamSharedEncodeFallbackVideo).toMatchObject({
      bitrateKbps: streamBitrateKbps
    })
    const probes = backend.sentCommands.filter(
      (command) => command.method === 'stream.output.topology.probe'
    )
    expect(probes.at(-2)?.params).toMatchObject({ outputRoles: ['recording', 'stream'] })
    expect(probes.at(-1)?.params).toMatchObject({
      outputRoles: ['shared'],
      recordingProfile: { bitrateKbps: streamBitrateKbps },
      streamProfile: { bitrateKbps: streamBitrateKbps }
    })

    await act(async () => {
      await latest()!.core.startSession()
    })
    await waitForObservation(() => latest()?.core.goLiveConfirmationOpen === true)
    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    const start = backend.sentCommands.find((command) => command.method === 'session.start')
    expect(start?.params).toMatchObject({
      output: {
        recordEnabled: true,
        streamEnabled: true,
        video: { bitrateKbps: streamBitrateKbps }
      }
    })
    // The saved Output setting is untouched; only this session shares.
    expect(latest()?.core.captureConfig.video.bitrateKbps).toBe(recordingBitrateKbps)
    expect(latest()?.core.lastError).toBeNull()
  })

  it('steps a software-encoded stream down to what this computer measurably holds', async () => {
    // The fake backend answers every probe with the raw path and OpenH264.
    // The saved performance check says 1080p30 is too heavy and 720p30 held.
    const backend = new StudioBackend()
    enableYouTubeOauthForTest(backend)
    backend.performanceCheck = {
      running: false,
      stale: false,
      result: {
        capabilityKey: 'performance-check-v2:test',
        checkedAt: now,
        appVersion: '0.9.126',
        durationMs: 12_000,
        recommended: videoPresets['tutorial-720p30'],
        belowFloor: false,
        rungs: [
          {
            video: videoPresets['tutorial-1080p30'],
            verdict: 'failed',
            reasons: ['encoder-below-realtime']
          },
          { video: videoPresets['tutorial-720p30'], verdict: 'passed', reasons: [] }
        ]
      }
    }
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
    await waitForObservation(() => latest()?.core.performanceCheck?.result !== undefined)

    await act(async () => {
      await latest()!.core.confirmGoLive()
    })

    const prepare = backend.sentCommands.find(
      (command) => command.method === 'streamTargets.youtube.prepare'
    )
    expect(prepare?.params).toMatchObject({ video: { width: 1280, height: 720, fps: 30 } })
    const start = backend.sentCommands.find((command) => command.method === 'session.start')
    expect(start?.params).toMatchObject({
      output: { streamEnabled: true },
      streaming: {
        defaultOutputPreset: 'tutorial-720p30',
        defaultBitrateKbps: 4000,
        targets: expect.arrayContaining([
          expect.objectContaining({
            id: 'youtube',
            outputPreset: 'tutorial-720p30',
            outputBitrateKbps: 4000
          })
        ])
      }
    })
    // Only the session moved. The saved destination settings are untouched.
    expect(latest()?.core.captureConfig.streaming.defaultOutputPreset).toBe('stream-safe-1080p30')
    expect(latest()?.core.lastError).toBeNull()
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
    const epoch = testEpoch
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await pollAct(epoch, async () => {
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
    // Plan 250: one entry behind the bell with both buttons, and no toast
    // (the owner, 2026-11-22: everything goes into the notifications).
    expect(
      toastSpies.success.mock.calls.filter(([message]) => message === 'Noise cleanup complete')
    ).toHaveLength(0)
    const cleaned = notifications.snapshot().find((entry) => entry.key.startsWith('noise-cleanup:'))
    expect(cleaned).toMatchObject({
      tone: 'done',
      title: 'Noise cleanup complete',
      occurrences: 1,
      actions: [{ label: 'Play' }, { label: revealInFileManagerLabel() }]
    })
    await notifications.runAction(cleaned!.key, 'play')
    await notifications.runAction(cleaned!.key, 'reveal')
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
        params.video?.width === DEFAULT_OUTPUT.width &&
        params.video?.height === DEFAULT_OUTPUT.height
      )
    })
    expect(reverseMixedReloads).toEqual([])
    await waitForObservation(
      () =>
        latest()?.core.captureConfig.layout.layoutPreset === 'screen-camera' &&
        latest()?.core.captureConfig.video.width === DEFAULT_OUTPUT.width &&
        latest()?.core.captureConfig.video.height === DEFAULT_OUTPUT.height
    )
    expect(previewAspectCalls.at(-1)).toEqual([DEFAULT_OUTPUT.width, DEFAULT_OUTPUT.height])

    await act(async () => {
      await latest()?.core.startSession()
    })
    expect(
      backend.commands.filter((command) => command.method === 'session.start').at(-1)?.params
    ).toMatchObject({
      layout: { layoutPreset: 'screen-camera' },
      output: { video: { width: DEFAULT_OUTPUT.width, height: DEFAULT_OUTPUT.height } }
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

  async function mountSignedInWithAccountRefresh(
    refreshAccount: VideorcApi['refreshAccount']
  ): Promise<{ backend: StudioBackend; latest: () => StudioObservation | undefined }> {
    const backend = new StudioBackend()
    backend.accountSnapshot = signedInAccount
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
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
    root = await mountStudioProvider(testDom.container, (value) => {
      observations.push(value)
    })
    const latest = (): StudioObservation | undefined => observations.at(-1)
    await waitForObservation(
      () =>
        latest()?.core.wsStatus === 'connected' && latest()?.core.account?.status === 'signed-in'
    )
    return { backend, latest }
  }

  function emitRecordingStatus(backend: StudioBackend, status: RecordingStatus): void {
    backend.sockets[0]?.onmessage?.({
      data: JSON.stringify({ event: 'recording.status', payload: status })
    })
  }

  const cameraConnectedMidSession: Device = {
    id: 'camera:connected-mid-session',
    name: 'Camera connected mid-session',
    kind: 'camera',
    status: 'available'
  }

  it('commits a live Refresh even though Main defers the account refresh (plan 073)', async () => {
    const refreshAccount = vi.fn(async () => ({ outcome: 'deferred' as const }))
    const { backend, latest } = await mountSignedInWithAccountRefresh(refreshAccount)
    await waitForObservation(() => refreshAccount.mock.calls.length >= 1)
    const accountBefore = latest()?.core.account
    toastSpies.error.mockClear()

    backend.deviceList = {
      ...backend.deviceList,
      devices: [...backend.deviceList.devices, cameraConnectedMidSession]
    }
    const callsBefore = refreshAccount.mock.calls.length
    await act(async () => {
      await latest()!.core.refreshBackend({ fresh: true })
    })

    expect(refreshAccount.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(latest()?.core.deviceList.devices).toContainEqual(cameraConnectedMidSession)
    expect(latest()?.core.account).toBe(accountBefore)
    expect(latest()?.core.lastError).toBeNull()
    expect(toastSpies.error).not.toHaveBeenCalled()
  })

  it('commits a Refresh when the account refresh fails, then reports the failure', async () => {
    const refreshAccount = vi.fn<VideorcApi['refreshAccount']>(async () => ({
      outcome: 'refreshed',
      snapshot: signedInAccount
    }))
    const { backend, latest } = await mountSignedInWithAccountRefresh(refreshAccount)
    await waitForObservation(() => refreshAccount.mock.calls.length >= 1)
    refreshAccount.mockRejectedValue(new Error('Account provider is offline.'))

    backend.deviceList = {
      ...backend.deviceList,
      devices: [...backend.deviceList.devices, cameraConnectedMidSession]
    }
    await act(async () => {
      await latest()!.core.refreshBackend({ fresh: true })
    })

    expect(latest()?.core.deviceList.devices).toContainEqual(cameraConnectedMidSession)
    expect(latest()?.core.account).toEqual(signedInAccount)
    expect(latest()?.core.lastError).toBe('Account provider is offline.')
  })

  it('replays one deferred account refresh when the live session goes idle', async () => {
    let mainCaptureActive = false
    const refreshedAfterSession: VideorcAccountSnapshot = {
      ...signedInAccount,
      displayName: 'Provider Test Upgraded Mid-Stream'
    }
    const refreshAccount = vi.fn<VideorcApi['refreshAccount']>(
      async (): Promise<VideorcAccountRefreshResult> =>
        mainCaptureActive
          ? { outcome: 'deferred' }
          : {
              outcome: 'refreshed',
              snapshot:
                refreshAccount.mock.calls.length === 1 ? signedInAccount : refreshedAfterSession
            }
    )
    const { backend, latest } = await mountSignedInWithAccountRefresh(refreshAccount)
    await waitForObservation(() => refreshAccount.mock.calls.length >= 1)
    const startedAt = new Date().toISOString()

    await act(async () => {
      mainCaptureActive = true
      emitRecordingStatus(backend, {
        state: 'recording',
        sessionId: 'session-073',
        startedAt,
        message: 'Recording.'
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    const callsBeforeFocus = refreshAccount.mock.calls.length
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    await waitForObservation(() => refreshAccount.mock.calls.length === callsBeforeFocus + 1)
    expect(latest()?.core.account).toEqual(signedInAccount)

    await act(async () => {
      mainCaptureActive = false
      emitRecordingStatus(backend, { state: 'idle', message: 'Ready.' })
      await Promise.resolve()
    })
    await waitForObservation(
      () => latest()?.core.account?.displayName === refreshedAfterSession.displayName
    )
    expect(refreshAccount).toHaveBeenCalledTimes(callsBeforeFocus + 2)

    // A later session with nothing deferred owes no replay.
    await act(async () => {
      emitRecordingStatus(backend, {
        state: 'recording',
        sessionId: 'session-073-b',
        startedAt,
        message: 'Recording.'
      })
      await Promise.resolve()
    })
    await waitForObservation(() => latest()?.recording.recording.state === 'recording')
    await act(async () => {
      emitRecordingStatus(backend, { state: 'idle', message: 'Ready.' })
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    })
    expect(refreshAccount).toHaveBeenCalledTimes(callsBeforeFocus + 2)
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
    const refreshAccount = vi.fn(async () => ({
      outcome: 'refreshed' as const,
      snapshot: await (refreshAccount.mock.calls.length === 1 ? signedInAccount : providerRefresh)
    }))
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

  it.each([
    { chosen: false, expectedHeight: 720, label: 'moves an untouched install to' },
    {
      chosen: true,
      expectedHeight: DEFAULT_OUTPUT.height,
      label: 'only suggests to a chosen output'
    }
  ])('$label the measured output', async ({ chosen, expectedHeight }) => {
    const backend = new StudioBackend()
    // The UHD 600 shape: the shipped default is too heavy, only 720p30 held.
    backend.performanceCheck = {
      running: false,
      stale: false,
      result: {
        capabilityKey: 'performance-check-v1:test',
        checkedAt: '2026-09-20T00:00:00Z',
        appVersion: '0.9.96',
        durationMs: 12_000,
        recommended: videoPresets['tutorial-720p30'],
        belowFloor: false,
        rungs: [
          { video: videoPresets['tutorial-1080p30'], verdict: 'failed', reasons: ['x'] },
          { video: videoPresets['tutorial-720p30'], verdict: 'passed', reasons: [] }
        ]
      }
    }
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)

    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => []
    })
    // A packaged launch: before plan 212 D1 only packaged builds measured on
    // their own, 8 s after launch.
    const runtimeInfo = api.getRuntimeInfo
    api.getRuntimeInfo = async () => ({ ...(await runtimeInfo()), isPackaged: true })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    if (chosen) {
      localStorage.setItem(STORAGE_KEYS.outputChosenByUser, '1')
    }
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
    await waitForObservation(() => latest()?.core.performanceCheck?.result !== undefined)
    await waitForObservation(() => latest()?.core.captureConfig.video.height === expectedHeight)
    // Plan 212 D1: the provider never starts a check itself, packaged or not.
    // Only first-run setup and Recording → Output do.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(backend.commands.some((command) => command.method === 'performance.check.run')).toBe(
      false
    )
  })

  // PH-08 (11-20): the launch batch gates health, devices and the Preview
  // start, so it reads the backend's entitlements as they stand. The
  // revalidation with the Videorc API (up to 10 s) runs beside it.
  it('commits health and devices while the launch entitlement revalidation is out (PH-08)', async () => {
    const backend = new StudioBackend()
    backend.entitlements = premiumEntitlements
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const releaseRefresh = backend.deferResponse('entitlements.refresh', DEFAULT_BASIC_ENTITLEMENTS)
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
        latest()?.core.health?.ffmpeg.available === true &&
        (latest()?.core.deviceList.devices.length ?? 0) > 0
    )
    expect(backend.sentCommands.some((command) => command.method === 'entitlements.refresh')).toBe(
      true
    )
    expect(latest()?.core.entitlements?.tier).toBe('premium')

    // The revalidation answers with the effective snapshot: it commits.
    await act(async () => {
      releaseRefresh()
    })
    await waitForObservation(() => latest()?.core.entitlements?.tier === 'basic')
  })

  it('keeps an entitlement event newer than the launch read over the late revalidation (PH-08)', async () => {
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const releaseStaleBasic = backend.deferResponse(
      'entitlements.refresh',
      DEFAULT_BASIC_ENTITLEMENTS
    )
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
    await waitForObservation(() => latest()?.core.health?.ffmpeg.available === true)
    expect(latest()?.core.entitlements?.tier).toBe('basic')

    await act(async () => {
      backend.pushEvent('entitlements.updated', premiumEntitlements)
    })
    await waitForObservation(() => latest()?.core.entitlements?.tier === 'premium')
    await act(async () => {
      releaseStaleBasic()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(latest()?.core.entitlements?.tier).toBe('premium')
  })

  // PH-08 (11-20): a connection's first Preview start runs once the working
  // sources are reconciled with the launch's device list; the 500 ms debounce
  // is for the changes after it. Only setTimeout is faked and no timer is
  // advanced past 0 ms; real time still passes for the launch's lazy modules.
  it('starts the launch Preview without the 500 ms debounce (PH-08)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      nativePreview: {
        getWindowState: () => previewWindowClosed,
        drainHostCommands: async () => nativePreviewStatus()
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const previewSourceCommands = (): number =>
      backend.sentCommands.filter((command) =>
        /^preview\.(camera|screen)\.(start|stop)$/.test(command.method)
      ).length
    // The shell's report once it decided setup stays closed.
    function DecidedShell(): null {
      const { setFirstRunSetupOpen } = useStudioShell()
      useEffect(() => setFirstRunSetupOpen(false), [setFirstRunSetupOpen])
      return null
    }
    root = await mountStudioProvider(testDom.container, () => {}, createElement(DecidedShell))

    await turnZeroTimersUntil(() => previewSourceCommands() > 0)

    expect(previewSourceCommands()).toBeGreaterThan(0)
  })

  // PH-08: first-run setup holds preview, and the shell decides whether it
  // opens a few renders after runtime info. The launch start waits for that
  // decision, so a 0 ms start never beats setup opening.
  it('holds the launch Preview start until the shell decides first-run setup (PH-08)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const backend = new StudioBackend()
    TestWebSocket.backend = backend
    vi.stubGlobal('WebSocket', TestWebSocket)
    const api = createVideorcApi({
      acknowledge: async () => true,
      pending: async () => [],
      acknowledgeProvider: async () => true,
      pendingProvider: async () => [],
      nativePreview: {
        getWindowState: () => previewWindowClosed,
        drainHostCommands: async () => nativePreviewStatus()
      }
    })
    const testDom = installProviderTestEnvironment(api)
    restoreEnvironment = testDom.restore
    const previewSourceStarts = (): number =>
      backend.sentCommands.filter((command) =>
        /^preview\.(camera|screen)\.start$/.test(command.method)
      ).length
    const observations: StudioObservation[] = []
    let shell: ReturnType<typeof useStudioShell> | undefined
    function ShellProbe(): null {
      const value = useStudioShell()
      useEffect(() => {
        shell = value
      }, [value])
      return null
    }
    root = await mountStudioProvider(
      testDom.container,
      (value) => {
        observations.push(value)
      },
      createElement(ShellProbe)
    )
    await turnZeroTimersUntil(
      () =>
        observations.at(-1)?.core.wsStatus === 'connected' &&
        observations.at(-1)?.core.health?.ffmpeg.available === true &&
        backend.sentCommands.some((command) => command.method === 'devices.list'),
      1_000
    )
    await turnZeroTimersUntil(() => previewSourceStarts() > 0, 500)
    expect(previewSourceStarts()).toBe(0)

    await act(async () => shell?.setFirstRunSetupOpen(true))
    await turnZeroTimersUntil(() => previewSourceStarts() > 0, 500)
    expect(previewSourceStarts()).toBe(0)

    await act(async () => shell?.setFirstRunSetupOpen(false))
    await turnZeroTimersUntil(() => previewSourceStarts() > 0)
    expect(previewSourceStarts()).toBeGreaterThan(0)
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
      getMediaAccessStatus: async () => ({
        camera: 'granted',
        microphone: 'granted',
        screen: 'granted'
      })
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
  revealSupportBundle?: VideorcApi['revealSupportBundle']
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
        firstRunSuppressed: false,
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
        (async () => ({ camera: 'granted', microphone: 'granted', screen: 'granted' })),
      requestMediaAccess: options.requestMediaAccess,
      openSystemPermissions: options.openSystemPermissions,
      getViewerSample: async () => null,
      getCommentsSnapshot: async () => null,
      getCommentHighlightState: async () => ({ generation: 0, phase: 'idle' }),
      pushCommentHighlightResult: options.pushCommentHighlightResult ?? (async () => true),
      pushChatSendResult: options.pushChatSendResult ?? (async () => true),
      getCaptionSnapshot: async () => null,
      getCaptionLines: async () => null,
      openSession: options.openSession ?? (async () => ''),
      revealSession: options.revealSession ?? (async () => {}),
      revealSupportBundle: options.revealSupportBundle ?? (async () => {}),
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

function installProviderDomEnvironment(api: VideorcApi): {
  container: Element
  restore: () => void
} {
  const page = new TestWindow({ url: 'http://localhost/' })
  Object.assign(page, { videorc: api })
  const globals = {
    window: page,
    document: page.document,
    localStorage: page.localStorage,
    navigator: page.navigator,
    HTMLElement: page.HTMLElement,
    Element: page.Element,
    Node: page.Node,
    SVGElement: page.SVGElement,
    MutationObserver: page.MutationObserver,
    ResizeObserver: page.ResizeObserver,
    getComputedStyle: page.getComputedStyle.bind(page),
    requestAnimationFrame: page.requestAnimationFrame.bind(page),
    cancelAnimationFrame: page.cancelAnimationFrame.bind(page),
    IS_REACT_ACT_ENVIRONMENT: true
  }
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value)
  const container = page.document.createElement('div')
  page.document.body.append(container)
  return {
    container: container as unknown as Element,
    restore: () => {
      void page.happyDOM.close()
    }
  }
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
    // Every element has a dataset: lib/platform reads data-platform from it.
    documentElement: { dataset: {} },
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
  const epoch = testEpoch
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await pollAct(epoch, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  throw new Error('Timed out waiting for StudioProvider observation.')
}
