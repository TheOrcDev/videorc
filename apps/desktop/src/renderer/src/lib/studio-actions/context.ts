// The Studio's action context (plan 209 S5): what every action needs from the
// Studio, assembled per intent in hooks/use-studio.tsx from the latest render's
// handlers. A Stream Deck key, the phone and (S6) an agent's tool call all run
// against the same one, through the same handlers as the on-screen buttons, so
// nothing away from the desk can start what the Studio would refuse. A tool
// that needs more than a key does (a notice, a headless Go Live) adds its
// field here, and the Studio fills it in the one place the context is built.

import type { Device, DeviceStatus, LayoutPreset, SourceSelection } from '@/lib/backend'
import type { HeadlessGoLiveOutcome, HeadlessGoLiveRequest } from '@/lib/go-live-headless'
import type { BannerSummary } from '../../../../shared/banner-commands'
import type { ClipLength } from '../../../../shared/clip-lengths'
import type { LiveBackgroundId } from '../../../../shared/live-background-ids'

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
}
