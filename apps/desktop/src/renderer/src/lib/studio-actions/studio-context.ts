import type { SavedSceneApplyResult } from '../scene-window-resolution'
// The Studio's action context, built from the Studio's handles (plan 209 S5).
// hooks/use-studio.tsx hands over, per intent, the latest render's handlers,
// state and refs (`StudioActionSource`); this module turns them into the
// `StudioActionContext` every executor runs against, so a Stream Deck key, the
// phone and an agent's tool call all go through the on-screen controls' own
// handlers. It lives here, loaded with the executors, to keep the context's
// logic out of the eager Studio bundle. Refs are read when the context is
// built, after the executors loaded, and again where a step reads fresh.

import type { BackendClient } from '@/backendClient'
import type {
  Banner,
  ClipMarkedEvent,
  CohostSettings,
  CommentHighlightState,
  DeviceList,
  DeviceStatus,
  EffectiveSceneBackground,
  EntitlementsSnapshot,
  KickCategory,
  LayoutPreset,
  LayoutSettings,
  LiveChatMessage,
  OverlayLayout,
  PlatformAccount,
  RecordingStatus,
  ReplayStateEvent,
  Scene,
  SessionSummary,
  SourceSelection,
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamScreen,
  StreamTargetSettings,
  TwitchCategory,
  VideoSettings
} from '@/lib/backend'
import {
  HORIZONTAL_LAYOUT_PRESETS,
  VERTICAL_LAYOUT_PRESETS,
  capturePickerDevices,
  microphonePickerDevices,
  simulcastLegLiveRequest,
  type CaptureConfig,
  type SettingsState,
  type WsStatus
} from '@/lib/capture'
import { cloudAiUploadGate, type EntitlementUiGate } from '@/lib/entitlement-ui'
import { goLiveWithoutDialog, type HeadlessGoLiveStudio } from '@/lib/go-live-headless'
import type { LiveSourceSelectionState } from '@/lib/live-source-selection'
import { OFFLINE_LOCK_REASON } from '@/lib/lock-reason'
import { overlayOrientationForCanvas } from '@/lib/overlay-layout'
import { clipMarkKeptSomething, clipMarkedToast } from '../../../../shared/clip-marks'
import { sessionIsLive, sessionOwnsTransport } from '../../../../shared/capture-state'
import type { LiveBackgroundId } from '../../../../shared/live-background-ids'
import { executeAgentIntent, type AgentIntent, type AgentIntentOutcome } from './agent'
import type { StudioActionContext } from './context'

type SourceKind = 'capture' | 'camera' | 'microphone'
type Ref<T> = { readonly current: T }

/** What the Studio hands over to build an action context: its own handlers,
 * the latest render's state, and the refs a step reads fresh. The Go Live
 * dialog's own handlers and state are among them, for `go_live` (D13). */
export interface StudioActionSource extends Omit<
  HeadlessGoLiveStudio,
  'connected' | 'wsStatus' | 'recording' | 'config'
> {
  runScreenPrivacy?: (
    mode: 'hide' | 'show' | 'toggle',
    caller: import('./privacy').PrivacyCaller
  ) => Promise<import('./context').StudioActionOutcome>
  client: BackendClient
  recordingRef: Ref<RecordingStatus>
  replayStateRef: Ref<ReplayStateEvent>
  recordBlockedReason: string | null
  liveStreamBlockedReason: string | null
  startRecording: () => Promise<boolean>
  startLivestream: () => Promise<boolean>
  requestStopSession: (origin: 'remote-control') => Promise<boolean>
  requestRemoteMicrophoneMute: (mode: 'mute' | 'unmute' | 'toggle') => Promise<boolean>
  systemAudioStatus: DeviceStatus | undefined
  systemAudioShown: boolean
  setSystemAudioEnabled: (enabled: boolean) => void
  requestCameraPresetTransaction: (patch: Partial<LayoutSettings>) => Promise<boolean>
  screens: readonly Pick<StreamScreen, 'id'>[]
  activateScreen: (assetId: string) => Promise<boolean>
  clearActiveScreen: () => Promise<boolean>
  openNotesWindow: () => Promise<void>
  openCommentsWindow: () => Promise<void>
  openPreviewWindow: () => Promise<void>
  liveChatMessages: readonly LiveChatMessage[]
  commentHighlightIntentRef: { current: number }
  setCommentHighlightFailure: (failure: null) => void
  applyCommentHighlight: (
    message: LiveChatMessage,
    expectedSessionId: undefined,
    intent: number,
    options: { alwaysSet: true }
  ) => Promise<CommentHighlightState | null>
  publishCommentHighlightState: (state: CommentHighlightState) => void
  bannerListRef: Ref<readonly Banner[] | null>
  savedScenes: readonly { id: string; name: string }[]
  applySavedSceneResult?: (id: string) => Promise<SavedSceneApplyResult>
  applySavedScene: (id: string) => Promise<boolean>
  captureConfigRef: Ref<CaptureConfig>
  deviceListRef: Ref<DeviceList>
  sourceSwitchReason: (kind: SourceKind) => string | null
  switchSourceDeviceLive: (kind: SourceKind, sources: SourceSelection) => Promise<unknown>
  sourceSelectionStateRef: Ref<LiveSourceSelectionState>
  setCaptureConfig: (update: (current: CaptureConfig) => CaptureConfig) => void
  captionsCommandPending: boolean
  entitlements: EntitlementsSnapshot | null
  captionsPlatformUnavailable: string | null
  background: EffectiveSceneBackground | undefined
  applyLiveBackground: (liveId: LiveBackgroundId | null) => Promise<boolean>
  transformSceneRef: Ref<Scene | null>
  overlayLayoutRef: Ref<OverlayLayout>
  platform: string | undefined
  wsStatusRef: Ref<WsStatus>
  /** A layout switch or a saved scene is being applied (either is set). */
  layoutSwitchPending: unknown
  savedScenePendingId: string | null
  setOverlayLayout: (layout: OverlayLayout) => Promise<void>
  updateBanner: (
    id: string,
    patch: Partial<Pick<Banner, 'horizontal' | 'vertical' | 'showOnStream' | 'showInRecording'>>
  ) => Promise<unknown>
  applyLayoutPatch: (patch: Partial<LayoutSettings>) => Promise<boolean>
  setSceneSourceTransform: (
    sourceId: string,
    rect: { x: number; y: number; width: number; height: number }
  ) => Promise<{ ok: boolean }>
  setSceneSourceVisible: (sourceId: string, visible: boolean) => Promise<void>
  cohostSettingsRef: Ref<CohostSettings | null>
  cohostGate: EntitlementUiGate
  aiConsent: boolean
  setCohostSettings: (settings: CohostSettings) => void
  streamMetadataDraft: StreamMetadataDraft | null
  setStreamMetadataDraft: (draft: StreamMetadataDraft) => void
  setStreamMetadataValidation: (validation: StreamMetadataValidation) => void
  platformAccounts: readonly Pick<PlatformAccount, 'platform' | 'accountId'>[]
  /** The Go Live dialog holds a partial setup (with
   * `goLiveConfirmationPending`: the dialog is busy). */
  goLivePartialSetup: unknown
  patchStreamingTarget: (targetId: string, patch: Partial<StreamTargetSettings>) => void
  settings: SettingsState
  theme: string | undefined
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  patchVideo: (patch: Partial<VideoSettings>) => void
  setSettings: (update: (current: SettingsState) => SettingsState) => void
  setReplayEnabled: (enabled: boolean) => void
  sessions: readonly SessionSummary[]
  deleteSessions: (targets: readonly { id: string }[]) => Promise<void>
  refreshSessions: (client: BackendClient) => Promise<unknown>
  refreshNoiseCleanupJobs: (client: BackendClient) => Promise<unknown>
  noteRecordClick: (kind: 'start' | 'stop') => void
}

const NO_BANNERS: readonly Banner[] = []

/** The Studio's agent lane (hooks/use-studio.tsx hands over its source per
 * intent: null without a backend client, undefined once that Studio socket
 * went away): the intent against the context built from it. Here, not in
 * the Studio, to keep the eager bundle small. */
export function executeStudioAgentIntent(
  intent: AgentIntent,
  studio: StudioActionSource | null | undefined
): Promise<AgentIntentOutcome> {
  if (!studio) {
    return Promise.resolve({
      ok: false,
      message:
        studio === null ? "Videorc's Studio isn't connected yet." : "Videorc's Studio went away."
    })
  }
  return executeAgentIntent(intent, studioActionContext(studio))
}

/** The action context for one intent, from the Studio's handles. */
export function studioActionContext(studio: StudioActionSource): StudioActionContext {
  const { client, captureConfigRef, overlayLayoutRef, transformSceneRef } = studio
  const config = captureConfigRef.current
  const devices = studio.deviceListRef.current.devices
  const knownLayoutPresets: readonly LayoutPreset[] = [
    ...HORIZONTAL_LAYOUT_PRESETS,
    ...VERTICAL_LAYOUT_PRESETS
  ]
  const captionsGate = cloudAiUploadGate(studio.entitlements)
  return {
    client,
    runScreenPrivacy: studio.runScreenPrivacy,
    sessionActive: sessionOwnsTransport(studio.recordingRef.current),
    replayOn: studio.replayStateRef.current.state === 'on',
    recordBlockedReason: studio.recordBlockedReason,
    liveStreamBlockedReason: studio.liveStreamBlockedReason,
    startRecording: studio.startRecording,
    startLivestream: studio.startLivestream,
    // A remote intent is a deliberate device action (plan 174 S0.1, D2):
    // it stops at once, through the one door every stop takes.
    stopSession: () => studio.requestStopSession('remote-control'),
    setMicrophoneMuted: studio.requestRemoteMicrophoneMute,
    systemAudio: [studio.systemAudioStatus, studio.systemAudioShown],
    setSystemAudioEnabled: studio.setSystemAudioEnabled,
    knownLayoutPresets,
    applyLayoutPreset: (layoutPreset) => studio.requestCameraPresetTransaction({ layoutPreset }),
    hasTakeover: (assetId) => studio.screens.some((screen) => screen.id === assetId),
    activateTakeover: studio.activateScreen,
    clearTakeover: studio.clearActiveScreen,
    openWindow: async (name) => {
      if (name === 'notes') await studio.openNotesWindow()
      else if (name === 'comments') await studio.openCommentsWindow()
      else if (name === 'preview') await studio.openPreviewWindow()
      else return false
      return true
    },
    showCommentHighlight: async (messageId) => {
      const message = studio.liveChatMessages.find((candidate) => candidate.id === messageId)
      if (!message || message.isDeleted) {
        return { ok: false, message: 'That comment is no longer available.' }
      }
      const highlightIntent = ++studio.commentHighlightIntentRef.current
      studio.setCommentHighlightFailure(null)
      try {
        const state = await studio.applyCommentHighlight(message, undefined, highlightIntent, {
          alwaysSet: true
        })
        if (!state) return { ok: false, message: 'A newer comment replaced this one.' }
        studio.publishCommentHighlightState(state)
        return state.phase === 'live'
          ? { ok: true }
          : { ok: false, message: state.reason ?? "The comment didn't reach the stream." }
      } catch (error) {
        // The backend's eligibility reason ("not live", ...) verbatim.
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Highlight failed.'
        }
      }
    },
    clearCommentHighlight: async () => {
      ++studio.commentHighlightIntentRef.current
      try {
        const state = await client.request<CommentHighlightState>('comments.highlight.clear')
        studio.publishCommentHighlightState(state)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Couldn't clear the comment."
        }
      }
    },
    banners: studio.bannerListRef.current ?? NO_BANNERS,
    // Plan 209 S6: what agent tools read beside a deck key's fields.
    noteRecordClick: (kind) => studio.noteRecordClick(kind),
    sessionLive: sessionIsLive(studio.recordingRef.current),
    savedScenes: studio.savedScenes,
    applySavedSceneResult: studio.applySavedSceneResult,
    applySavedScene: (id) => studio.applySavedScene(id),
    // Plan 209 PR B: what the Run the show and Arrange tools add. A deck
    // key never reads them.
    goLive: (request) =>
      goLiveWithoutDialog(request, {
        ...studio,
        // The context exists only while the Studio has a backend client.
        connected: true,
        wsStatus: studio.wsStatusRef.current,
        recording: studio.recordingRef.current,
        config: captureConfigRef.current
      }),
    sourcePicker: {
      sources: config.sources,
      capture: capturePickerDevices(devices),
      cameras: devices.filter((device) => device.kind === 'camera'),
      microphones: microphonePickerDevices(devices)
    },
    switchSource: async (kind, sources) => {
      // The picker is disabled with this reason; the switch would only toast it.
      const blocked = studio.sourceSwitchReason(kind)
      if (blocked) return { ok: false, message: blocked }
      await studio.switchSourceDeviceLive(kind, sources)
      const state = studio.sourceSelectionStateRef.current
      return state.error && state.errorKind === kind
        ? { ok: false, message: state.error }
        : { ok: true }
    },
    setAudioGain: (patch) =>
      studio.setCaptureConfig((current) => ({ ...current, audio: { ...current.audio, ...patch } })),
    captions: {
      enabled: config.captions.enabled,
      pending: studio.captionsCommandPending,
      blockedReason: captionsGate.allowed
        ? studio.captionsPlatformUnavailable
        : captionsGate.reason,
      // The switch's own patch: only `enabled` changes.
      set: (enabled) =>
        studio.setCaptureConfig((current) =>
          current.captions.enabled === enabled
            ? current
            : { ...current, captions: { ...current.captions, enabled } }
        )
    },
    background: {
      liveId: studio.background?.live?.id ?? null,
      picture: Boolean(studio.background && !studio.background.live),
      apply: studio.applyLiveBackground
    },
    // Plan 209 S11b (D22): the Scene canvas, read fresh at every step.
    arrange: {
      read: () => {
        const current = captureConfigRef.current
        const orientation = overlayOrientationForCanvas(current.video.width, current.video.height)
        const verticalLeg = simulcastLegLiveRequest(current)
        // The stage's own shapes: the Output, or the vertical stream's 9:16.
        const programAspect = current.video.width / Math.max(1, current.video.height)
        const sessionActive = sessionOwnsTransport(studio.recordingRef.current)
        return {
          scene: transformSceneRef.current,
          layout: current.layout,
          overlayLayout: overlayLayoutRef.current,
          banners: studio.bannerListRef.current ?? NO_BANNERS,
          canvasAspect: {
            horizontal: orientation === 'horizontal' ? programAspect : 16 / 9,
            vertical:
              orientation === 'vertical'
                ? programAspect
                : verticalLeg?.video
                  ? verticalLeg.video.width / Math.max(1, verticalLeg.video.height)
                  : 9 / 16
          },
          orientation,
          verticalStream: Boolean(verticalLeg),
          sessionActive,
          startTimeOverlays: sessionActive && studio.platform === 'win32',
          blockedReason:
            studio.wsStatusRef.current !== 'connected'
              ? OFFLINE_LOCK_REASON
              : studio.layoutSwitchPending !== null || studio.savedScenePendingId !== null
                ? 'The scene is changing.'
                : null
        }
      },
      setOverlayLayout: studio.setOverlayLayout,
      updateBanner: async (id, patch) => (await studio.updateBanner(id, patch)) !== null,
      applyCameraPreset: studio.requestCameraPresetTransaction,
      applyLayoutPatch: studio.applyLayoutPatch,
      setSourceTransform: async (sourceId, rect) =>
        (await studio.setSceneSourceTransform(sourceId, rect)).ok,
      setSourceVisible: async (sourceId, visible) => {
        await studio.setSceneSourceVisible(sourceId, visible)
        return (
          transformSceneRef.current?.sources.find((source) => source.id === sourceId)?.visible ===
          visible
        )
      }
    },
    markClip: async (seconds) => {
      try {
        const event = await client.request<ClipMarkedEvent>('clip.mark', seconds && { seconds })
        // Plan 181 R4: a saved clip is a success for a deck key, mark or not.
        return clipMarkKeptSomething(event)
          ? { ok: true }
          : { ok: false, message: clipMarkedToast(event).title }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Couldn't mark the clip."
        }
      }
    },
    // Plan 209 PR B, S13 to S15: what the Buddy, Prepare and Library tools
    // need, each through the control the streamer would use.
    buddy: {
      settings: studio.cohostSettingsRef.current,
      entitled: studio.cohostGate.allowed,
      entitlementReason: studio.cohostGate.allowed ? null : studio.cohostGate.reason,
      consented: studio.aiConsent,
      showOnStream: overlayLayoutRef.current.buddy.showOnStream,
      // The Stream Manager's enable command's save (`cohostEnableRelayPatch`).
      saveSettings: async (patch) => {
        const next = await client.request<CohostSettings>('cohost.settings.set', patch)
        studio.setCohostSettings(next)
        return next
      },
      // The Stream Manager header's "on stream" switch.
      setShowOnStream: async (on) => {
        const current = overlayLayoutRef.current
        await studio.setOverlayLayout({ ...current, buddy: { ...current.buddy, showOnStream: on } })
      }
    },
    prepare: {
      draft: studio.streamMetadataDraft,
      // Stream details' Save, after the executor ran its check.
      saveDraft: async (draft) => {
        const saved = await client.request<StreamMetadataDraft>(
          'streamTargets.metadata.update',
          draft
        )
        studio.setStreamMetadataDraft(saved)
        studio.setStreamMetadataValidation({ valid: true, issues: [] })
        return saved
      },
      searchCategories: async (platform, query) => {
        const accountId = studio.platformAccounts.find(
          (item) => item.platform === platform
        )?.accountId
        if (platform === 'kick') {
          const found = await client.request<{ categories: KickCategory[] }>(
            'streamTargets.kick.searchCategories',
            { accountId, query, limit: 10 }
          )
          return found.categories
        }
        const found = await client.request<{ categories: TwitchCategory[] }>(
          'streamTargets.twitch.searchCategories',
          { accountId, query, first: 10 }
        )
        return found.categories
      },
      streaming: config.streaming,
      entitlements: studio.entitlements,
      goLivePending: studio.goLiveConfirmationPending || Boolean(studio.goLivePartialSetup),
      patchTarget: studio.patchStreamingTarget
    },
    settings: {
      captureConfig: config,
      settings: studio.settings,
      theme: studio.theme,
      platform: studio.platform,
      entitlements: studio.entitlements,
      patchVideo: studio.patchVideo,
      setCaptureConfig: studio.setCaptureConfig,
      setSettings: studio.setSettings,
      setClipsEnabled: studio.setReplayEnabled,
      setTheme: studio.setTheme
    },
    library: {
      recordings: studio.sessions,
      deleteRecordings: (ids) => studio.deleteSessions(ids.map((id) => ({ id }))),
      // Export MP4's request; the Library row refreshes like the menu's.
      exportMp4: async (id) => {
        const exported = await client.request<{ mp4Path?: string } | null>('session.remux_mp4', {
          sessionId: id
        })
        await Promise.all([studio.refreshSessions(client), studio.refreshNoiseCleanupJobs(client)])
        return exported?.mp4Path ?? null
      }
    }
  }
}
