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
}
