// The Studio's action context (plan 209 S5): what every action needs from the
// Studio, assembled per intent in hooks/use-studio.tsx from the latest render's
// handlers. A Stream Deck key, the phone and (S6) an agent's tool call all run
// against the same one, through the same handlers as the on-screen buttons, so
// nothing away from the desk can start what the Studio would refuse. A tool
// that needs more than a key does (a notice, a headless Go Live) adds its
// field here, and the Studio fills it in the one place the context is built.

import type { DeviceStatus, LayoutPreset } from '@/lib/backend'
import type { BannerSummary } from '../../../../shared/banner-commands'
import type { ClipLength } from '../../../../shared/clip-lengths'
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
