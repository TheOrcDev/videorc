// The Studio's action context (plan 209 S5): what every action needs from the
// Studio, built per intent (studio-context.ts) from the latest render's
// handlers that hooks/use-studio.tsx hands over. A Stream Deck key, the phone
// and (S6) an agent's tool call all run against the same one, through the
// same handlers as the on-screen buttons, so nothing away from the desk can
// start what the Studio would refuse. A tool that needs more than a key does
// (a notice, a headless Go Live) adds its field here, and studio-context.ts
// fills it in, the one place the context is built.

import type {
  Banner,
  Device,
  DeviceStatus,
  LayoutPreset,
  LayoutSettings,
  OverlayLayout,
  OverlayOrientation,
  Scene,
  SourceSelection
} from '@/lib/backend'
import type { HeadlessGoLiveOutcome, HeadlessGoLiveRequest } from '@/lib/go-live-headless'
import type { BannerSummary } from '../../../../shared/banner-commands'
import type { ClipLength } from '../../../../shared/clip-lengths'
import type { LiveBackgroundId } from '../../../../shared/live-background-ids'
import type {
  CohostSettings,
  CohostSettingsPatch,
  EntitlementsSnapshot,
  SessionSummary,
  StreamMetadataDraft,
  StreamTargetSettings,
  StreamingSettings,
  VideoSettings
} from '../../../../shared/backend'
import type { CaptureConfig, SettingsState } from '@/lib/capture'

export interface StudioActionClient {
  request<T>(method: string, params?: unknown): Promise<T>
}

/** What one action resolves to. `message` is the sentence a deck, a phone or
 * an agent reads when Videorc refuses or fails; a success carries none. */
export interface StudioActionOutcome {
  ok: boolean
  message?: string
}

/** An intent's fields beside its kind (`layoutPreset`, `bannerId`, ...), or a
 * tool call's args. An executor reads what it needs and checks it itself. */
export type StudioActionFields = Readonly<Record<string, unknown>>

/** One action: the Studio context and the intent's fields, to an outcome. It
 * never acks and never toasts; the entry point that called it does. */
export type StudioActionExecutor = (
  context: StudioActionContext,
  fields: StudioActionFields
) => Promise<StudioActionOutcome>

export interface StudioActionContext {
  client: StudioActionClient
  sessionActive: boolean
  /**
   * The Studio's two explicit starts (plan 174 S3.1): `recordStart` records
   * and `streamStart` goes live, whatever mode was saved last. The start
   * itself refuses (and says so in the Studio); the reason it cannot run
   * right now rides on the failed ack, so a deck key can say why.
   */
  recordBlockedReason: string | null
  liveStreamBlockedReason: string | null
  startRecording: () => Promise<boolean>
  startLivestream: () => Promise<boolean>
  /** Every stop goes through the provider's stop decision (S0.1): a remote
   * intent is a deliberate device action, so it stops at once. */
  stopSession: () => Promise<boolean>
  setMicrophoneMuted: (mode: 'mute' | 'unmute' | 'toggle') => Promise<boolean>
  /** Plan 069 S6: the system-audio device status and the state the remotes
   * are shown (`systemAudioOn` before the availability mask). */
  systemAudio: readonly [status: DeviceStatus | undefined, shown: boolean]
  /** Sets captureConfig.audio.systemAudioEnabled, exactly as the switch does;
   * a live session picks it up through the latest-wins audio update. */
  setSystemAudioEnabled: (enabled: boolean) => void
  knownLayoutPresets: readonly LayoutPreset[]
  applyLayoutPreset: (layoutPreset: LayoutPreset) => Promise<boolean>
  hasTakeover: (assetId: string) => boolean
  activateTakeover: (assetId: string) => Promise<boolean>
  clearTakeover: () => Promise<boolean>
  openWindow: (name: string) => Promise<boolean>
  /** Phone remote: EXPLICIT show (never the button's toggle) — a double tap
   * must not flash the card off. Resolves the user-facing refusal reason. */
  showCommentHighlight: (messageId: string) => Promise<StudioActionOutcome>
  clearCommentHighlight: () => Promise<StudioActionOutcome>
  /** Save a clip (plan 068 D6; plan 181 R4): the last seconds whenever the
   * ring holds frames, and a mark while recording. The backend stamps the
   * capture clock; `ok: false` carries why nothing was kept. Plan 199:
   * `seconds` is 30 or 60; absent is today's 30 s. */
  markClip: (seconds?: ClipLength) => Promise<StudioActionOutcome>
  /** Plan 181: the ring holds frames right now. */
  replayOn: boolean
  /** Plan 186 S7: the banner list the remotes are shown. `bannerShow` and
   * `bannerHide` run the backend's own explicit RPCs; `bannerToggle` picks
   * its verb from `shown` here. */
  banners: readonly BannerSummary[]
  /** Plan 189 S10: the board `soundPlay` and `soundStop` act on; the
   * soundboard store's own when left out. */
  sounds?: readonly { id: string }[]
  // Agent tools (plan 209 S6). Optional: a remote key never reads them.
  /** A livestream runs now (it may also record): what `stop` ends. */
  sessionLive?: boolean
  /** The streamer's saved scenes, by id and name (`switch_scene`). */
  savedScenes?: readonly { id: string; name: string }[]
  /** Applies a saved scene exactly as clicking it in the Studio does. */
  applySavedScene?: (id: string) => Promise<boolean>
  /** Each built-in layout's name; `layoutPresetLabel` when left out. */
  layoutLabels?: Readonly<Record<string, string>>
  /** The record-latency probe's click for an agent's `start_recording` and
   * `stop` (a deck key notes its own in the Studio). */
  noteRecordClick?: (kind: 'start' | 'stop') => void
  // Run the show, PR B (plan 209 S10). Optional: a remote key never reads them.
  /** Go live without the dialog (D13): the dialog's own preflight, gate and
   * confirm. A deck's or a phone's `streamStart` never calls it (D2, D19). */
  goLive?: (request: HeadlessGoLiveRequest) => Promise<HeadlessGoLiveOutcome>
  // (plan 209 S11)
  /** The Sources tab's pickers: the sources chosen and what each offers. */
  sourcePicker?: {
    sources: SourceSelection
    capture: readonly Device[]
    cameras: readonly Device[]
    microphones: readonly Device[]
  }
  /** The Sources tab's own switch (`switchSourceDeviceLive`): idle it saves
   * the pick, while recording or live it switches the running session. A
   * refusal is the picker's own reason. */
  switchSource?: (
    kind: 'capture' | 'camera' | 'microphone',
    sources: SourceSelection
  ) => Promise<StudioActionOutcome>
  /** The Gain faders: whole dB, written to captureConfig.audio as they do. */
  setAudioGain?: (patch: { microphoneGainDb?: number; systemAudioGainDb?: number }) => void
  /** The Live captions switch, and why it can't turn on. */
  captions?: {
    enabled: boolean
    pending: boolean
    blockedReason: string | null
    set: (enabled: boolean) => void
  }
  /** Assets → Backgrounds: what is on the scene, and a live tile's click. */
  background?: {
    liveId: string | null
    picture: boolean
    apply: (liveId: LiveBackgroundId | null) => Promise<boolean>
  }
  // Arrange the picture (plan 209 S11b, D22).
  /** The Scene page's canvas and inspector: what is where, and the saves a
   * drag, a snap or a switch makes. lib/studio-actions/scene-layout.ts. */
  arrange?: SceneArrangeContext
  // Plan 209 PR B, S13 to S15. Optional: a remote key never reads them.
  /** Buddy (S13): what `set_buddy` reads, and the Stream Manager's own saves. */
  buddy?: StudioBuddyAccess
  /** The next stream (S14): the Go Live draft and the destinations. */
  prepare?: StudioPrepareAccess
  /** The curated settings (S14, D16). */
  settings?: StudioSettingsAccess
  /** The Library (S15): its rows and its own delete and export. */
  library?: StudioLibraryAccess
}

/** What the Scene canvas shows, read fresh for each step of an Arrange tool. */
export interface SceneArrangeSnapshot {
  /** The committed scene: its sources and where each is drawn. */
  scene: Scene | null
  layout: LayoutSettings
  overlayLayout: OverlayLayout
  banners: readonly Banner[]
  /** Each orientation's canvas shape (width / height), as the stage draws it. */
  canvasAspect: Readonly<Record<OverlayOrientation, number>>
  /** The program canvas's orientation. */
  orientation: OverlayOrientation
  /** A vertical stream is armed beside the program (its own 9:16 rects). */
  verticalStream: boolean
  sessionActive: boolean
  /** The Windows D3D11 pump keeps the overlay input it started with
   * (docs/overlays.md): a change mid-session shows from the next one. */
  startTimeOverlays: boolean
  /** Why the canvas takes no edit now (offline, a scene switching), or null. */
  blockedReason: string | null
}

export interface SceneArrangeContext {
  read: () => SceneArrangeSnapshot
  /** `overlays.layout.set`, as the canvas's overlay gestures and switches. */
  setOverlayLayout: (layout: OverlayLayout) => Promise<void>
  /** `banners.update`; false when it failed (the Studio said why). */
  updateBanner: (
    id: string,
    patch: Partial<Pick<Banner, 'horizontal' | 'vertical' | 'showOnStream' | 'showInRecording'>>
  ) => Promise<boolean>
  /** The camera preset controls' transaction (corner, Freeform). */
  applyCameraPreset: (patch: Partial<LayoutSettings>) => Promise<boolean>
  /** The inspector's layout patch (the camera's Shape). */
  applyLayoutPatch: (patch: Partial<LayoutSettings>) => Promise<boolean>
  /** A released source drag in freeform (`scene.source.transform.update`). */
  setSourceTransform: (
    sourceId: string,
    rect: { x: number; y: number; width: number; height: number }
  ) => Promise<boolean>
  /** The inspector's Visible switch; false when it did not land. */
  setSourceVisible: (sourceId: string, visible: boolean) => Promise<boolean>
}

/** Buddy as the Stream Manager's switch, mode control and header see it. */
export interface StudioBuddyAccess {
  /** `cohost.settings` as loaded; null until the backend answered. */
  settings: Pick<CohostSettings, 'enabled' | 'autoChat'> | null
  /** The Premium gate (`liveCohostGate`): Buddy Live needs it. */
  entitled: boolean
  entitlementReason: string | null
  /** The renderer-local Cloud AI consent Buddy Live needs. */
  consented: boolean
  /** `overlayLayout.buddy.showOnStream`. */
  showOnStream: boolean
  /** Saves a `cohostEnableRelayPatch` patch, as the Stream Manager's command does. */
  saveSettings: (patch: CohostSettingsPatch) => Promise<CohostSettings>
  /** The Stream Manager header's "on stream" switch. */
  setShowOnStream: (on: boolean) => Promise<void>
}

/** The next stream: the Go Live draft (Stream details) and Destinations. */
export interface StudioPrepareAccess {
  /** The Go Live draft as the Studio holds it; null while it loads. */
  draft: StreamMetadataDraft | null
  /** Stream details' Save: `streamTargets.metadata.update`, then the Studio's draft. */
  saveDraft: (draft: StreamMetadataDraft) => Promise<StreamMetadataDraft>
  /** The category search the Stream details picker uses. */
  searchCategories: (
    platform: 'twitch' | 'kick',
    query: string
  ) => Promise<{ id: string | number; name: string }[]>
  streaming: StreamingSettings
  entitlements: EntitlementsSnapshot | null
  /** The Go Live dialog is open: its draft and destinations are being confirmed. */
  goLivePending: boolean
  /** A destination's switch (`patchStreamingTarget`). */
  patchTarget: (targetId: string, patch: Partial<StreamTargetSettings>) => void
}

/** What the curated settings read and write (D16), through their own controls' setters. */
export interface StudioSettingsAccess {
  captureConfig: Pick<
    CaptureConfig,
    'video' | 'layout' | 'recordEnabled' | 'separateSourceRecordings' | 'replayBuffer' | 'captions'
  >
  settings: Pick<SettingsState, 'outputDirectory' | 'keepOriginalRecording' | 'studioChat'>
  /** next-themes' stored choice. */
  theme: string | undefined
  platform: string | undefined
  entitlements: EntitlementsSnapshot | null
  /** Output's own setter: a size or rate, the preset becomes Custom. */
  patchVideo: (patch: Partial<VideoSettings>) => void
  setCaptureConfig: (update: (current: CaptureConfig) => CaptureConfig) => void
  setSettings: (update: (current: SettingsState) => SettingsState) => void
  /** Output → Clips' one switch. */
  setClipsEnabled: (enabled: boolean) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
}

/** The Library's rows and its own file actions. */
export interface StudioLibraryAccess {
  /** The rows the Library has loaded (newest first). */
  recordings: readonly SessionSummary[]
  /** The Library's delete: the backend's tombstone, then the files to the Trash. */
  deleteRecordings: (ids: readonly string[]) => Promise<void>
  /** Export MP4 (plan 200's export): resolves to the MP4's path. */
  exportMp4: (id: string) => Promise<string | null>
}
