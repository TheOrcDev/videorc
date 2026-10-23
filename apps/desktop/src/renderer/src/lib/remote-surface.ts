import type { DeviceStatus, LayoutPreset } from '@/lib/backend'
import { BANNER_ACTION_COPY, runBannerAction } from '@/lib/banners'
import { layoutPresetLabel } from '@/lib/layout-labels'
import { soundboard, type SoundboardSnapshot, type SoundboardStore } from '@/lib/soundboard-store'
import { SOUND_ACTION_COPY, runSoundAction } from '@/lib/sounds'
import { systemAudioTarget } from '@/lib/system-audio'
import {
  bannerSummaries,
  type BannerRelayAction,
  type BannerSummary
} from '../../../shared/banner-commands'

/** The state projection deck keys render. Minimal by design and the ONLY
 * payload remote sockets receive — never widen it with tokens/paths/URLs. */
export interface RemoteSurfaceState {
  sessionState: string
  sessionActive: boolean
  recordEnabled: boolean
  streamEnabled: boolean
  micMuted: boolean
  layoutPreset: LayoutPreset
  activeTakeoverId: string | null
  windows: {
    notes: boolean
    comments: boolean
    preview: boolean
  }
  /** Plan 069: whether the session mixes system audio (confirmed, else the
   * request while idle or unreported). Always false when not available. */
  systemAudioOn: boolean
  /** The device can run: present, supported, and granted. Only a boolean —
   * never the device name or the permission state's detail. */
  systemAudioAvailable: boolean
}

export interface RemoteSurfaceDescribe {
  layoutPresets: readonly LayoutPreset[]
  /**
   * Plan 174 S2.3a (I-14): each preset's name as the desktop shows it
   * ("Screen + camera", "Vertical split"), so the phone never title-cases an
   * id. Fixed strings derived from the built-in ids already listed above:
   * nothing user-made, nothing about the machine. Additive; older clients
   * ignore it.
   */
  layoutLabels: Readonly<Record<string, string>>
  takeovers: { id: string; name: string }[]
  /**
   * Plan 186 S7: every banner as `{id, name, shown}`, in Assets order. Ids
   * are opaque, names are labels the streamer typed for graphics viewers
   * see; never an image, a file name or a path. A banner key renders
   * `shown` from here, so a client re-reads describe after `remote.state`.
   */
  banners: BannerSummary[]
  /**
   * Plan 189 S10: every sound as `{id, name, playing}`, in board order. Ids
   * are opaque, names are labels the streamer typed for sounds they play to
   * viewers; never a file, a path or any audio. A sound key renders
   * `playing` from here, so a client re-reads describe after `remote.state`.
   */
  sounds: RemoteSoundSummary[]
  windows: readonly string[]
}

/** One sound as the remotes see it (plan 189 S10). */
export interface RemoteSoundSummary {
  id: string
  name: string
  playing: boolean
}

/** The board as the remotes see it: board order, without a sound waiting for its Undo. */
export function remoteSoundSummaries(snapshot: SoundboardSnapshot): RemoteSoundSummary[] {
  const playing = new Set(snapshot.voices.map((voice) => voice.soundId))
  return (snapshot.board?.sounds ?? [])
    .filter((sound) => !snapshot.hidden.has(sound.id))
    .map(({ id, name }) => ({ id, name, playing: playing.has(id) }))
}

/** The phone's scene keys read the desktop's layout names (plan 174 I-14). */
export function remoteLayoutLabels(presets: readonly LayoutPreset[]): Record<string, string> {
  const bothOrientations =
    presets.some((preset) => preset.startsWith('vertical-')) &&
    presets.some((preset) => !preset.startsWith('vertical-'))
  return Object.fromEntries(
    presets.map((preset) => [preset, layoutPresetLabel(preset, { bothOrientations })])
  )
}

export interface RemoteSurfaceSnapshot {
  state: RemoteSurfaceState
  describe: RemoteSurfaceDescribe
}

export type RemoteSurfaceValues = readonly [
  sessionState: string,
  sessionActive: boolean,
  recordEnabled: boolean,
  streamEnabled: boolean,
  micMuted: boolean,
  layoutPreset: LayoutPreset,
  activeTakeoverId: string | null,
  notesOpen: boolean,
  commentsOpen: boolean,
  previewOpen: boolean,
  layoutPresets: readonly LayoutPreset[],
  takeovers: { id: string; name: string }[],
  systemAudioStatus: DeviceStatus | undefined,
  systemAudioShown: boolean,
  banners: readonly BannerSummary[]
]

function snapshotFromValues(
  values: RemoteSurfaceValues,
  sounds: RemoteSoundSummary[]
): RemoteSurfaceSnapshot {
  return {
    state: {
      sessionState: values[0],
      sessionActive: values[1],
      recordEnabled: values[2],
      streamEnabled: values[3],
      micMuted: values[4],
      layoutPreset: values[5],
      activeTakeoverId: values[6],
      windows: { notes: values[7], comments: values[8], preview: values[9] },
      systemAudioOn: values[12] === 'available' && values[13],
      systemAudioAvailable: values[12] === 'available'
    },
    describe: {
      layoutPresets: values[10],
      layoutLabels: remoteLayoutLabels(values[10]),
      takeovers: values[11],
      // Whitelisted here: Studio hands over its whole banner list.
      banners: bannerSummaries(values[14]),
      sounds,
      windows: ['notes', 'comments', 'preview']
    }
  }
}

interface RemoteSurfaceClient {
  request<T>(method: string, params?: unknown): Promise<T>
}

export interface RemoteIntentContext {
  client: RemoteSurfaceClient
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
  showCommentHighlight: (messageId: string) => Promise<RemoteIntentOutcome>
  clearCommentHighlight: () => Promise<RemoteIntentOutcome>
  /** Plan 068 D6: mark the current moment for a clip. The backend stamps the
   * capture clock; `ok: false` carries why nothing was kept. */
  markClip: () => Promise<RemoteIntentOutcome>
  /** Plan 186 S7: the banner list the remotes are shown. `bannerShow` and
   * `bannerHide` run the backend's own explicit RPCs; `bannerToggle` picks
   * its verb from `shown` here. */
  banners: readonly BannerSummary[]
  /** Plan 189 S10: the board `soundPlay` and `soundStop` act on; the
   * soundboard store's own when left out. */
  sounds?: readonly { id: string }[]
}

export interface RemoteIntentOutcome {
  ok: boolean
  message?: string
}

/** Coalesce same-commit bursts; deck latency is invisible below ~50ms. */
const PUBLISH_DEBOUNCE_MS = 25
/** Bounded backoff for a transiently failing publish — without it a failed
 * FIRST publish leaves remote.describe empty until unrelated state changes. */
const PUBLISH_RETRY_DELAYS_MS = [1000, 2000, 4000]

/**
 * Pushes the remote-control state projection to the backend so deck keys
 * render backend-confirmed truth.
 *
 * Deliberately NOT a React effect: the studio render body hands it the latest
 * snapshot (`sync`, the same latest-value pattern as the hook's render-synced
 * refs) and it owns the change detection, post-commit debounce, reconnect
 * republish, and bounded retry on its own timeline.
 */
export class RemoteSurfacePublisher {
  private client: RemoteSurfaceClient | null = null
  private connected = false
  private latest: RemoteSurfaceSnapshot | null = null
  private latestValues: RemoteSurfaceValues | null = null
  private lastPublishedBody: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private offSounds: (() => void) | null = null

  /** Plan 189: the soundboard the remotes are shown, followed outside React. */
  constructor(private readonly sounds: SoundboardStore = soundboard) {}

  attach(client: RemoteSurfaceClient): void {
    this.client = client
    this.connected = false
    // A sound starting or stopping changes describe, not Studio's values.
    this.offSounds?.()
    this.offSounds = this.sounds.subscribe(() => {
      if (this.latestValues) this.syncValues(this.latestValues)
    })
  }

  /** The socket is live: the backend's surface slate is blank, so the last
   * published body no longer counts — republish immediately. */
  markConnected(): void {
    this.connected = true
    this.lastPublishedBody = null
    this.retryAttempt = 0
    this.schedule(0)
  }

  detach(): void {
    this.offSounds?.()
    this.offSounds = null
    this.client = null
    this.connected = false
    this.lastPublishedBody = null
    this.retryAttempt = 0
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * Record the latest snapshot and schedule a deduped publish. Safe to call
   * from a render body: it mutates only this object and schedules a timer
   * that fires after the commit; identical snapshots are no-ops, so repeated
   * renders (StrictMode, discarded passes) cannot double-publish.
   */
  sync(snapshot: RemoteSurfaceSnapshot): void {
    this.latest = snapshot
    if (JSON.stringify(snapshot) === this.lastPublishedBody) {
      return
    }
    this.schedule(PUBLISH_DEBOUNCE_MS)
  }

  syncValues(values: RemoteSurfaceValues): void {
    this.latestValues = values
    this.sync(snapshotFromValues(values, remoteSoundSummaries(this.sounds.getSnapshot())))
  }

  private schedule(delayMs: number): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    const { client, latest } = this
    if (!client || !this.connected || !latest) {
      return
    }
    const body = JSON.stringify(latest)
    if (body === this.lastPublishedBody) {
      return
    }
    try {
      await client.request('remote.surface.publish', latest)
      this.lastPublishedBody = body
      this.retryAttempt = 0
    } catch (error) {
      if (this.retryAttempt < PUBLISH_RETRY_DELAYS_MS.length) {
        this.schedule(PUBLISH_RETRY_DELAYS_MS[this.retryAttempt])
        this.retryAttempt += 1
        return
      }
      // Out of retries: say so once, then wait for the next change or
      // reconnect. Deck keys keep rendering the last state they saw.
      this.retryAttempt = 0
      console.error('[remote-control] surface publish failed after retries', error)
    }
  }
}

/** What a phone or a deck reads when Videorc refuses a key (plan 174 I-11). */
export const REMOTE_INTENT_COPY = {
  recordDidNotStart: "Recording didn't start. Check Studio on your computer.",
  notRunning: "You're not recording or live.",
  didNotStop: "Couldn't stop. Check Studio on your computer.",
  toggleFailed: "That didn't work. Check Studio on your computer.",
  streamNotSetUp: 'Use Go Live… on your computer first.',
  streamDidNotStart: "The livestream didn't start. Finish going live on your computer.",
  microphone: "Couldn't change the microphone.",
  systemAudio: "System audio isn't available.",
  sceneMissing: "That scene isn't available anymore.",
  sceneFailed: "Couldn't switch the scene.",
  takeoverMissing: "That takeover isn't available anymore.",
  takeoverShow: "Couldn't show the takeover.",
  takeoverHide: "Couldn't hide the takeover.",
  bannerMissing: BANNER_ACTION_COPY.missing,
  bannerShow: BANNER_ACTION_COPY.show,
  bannerHide: BANNER_ACTION_COPY.hide,
  bannersHide: BANNER_ACTION_COPY.hideAll,
  soundMissing: SOUND_ACTION_COPY.missing,
  windowMissing: "That window isn't available.",
  messageMissing: 'Choose a message to put on stream.',
  unsupported: "This version of Videorc can't do that. Update Videorc.",
  failed: 'Something went wrong. Check Studio on your computer.'
} as const

/** Executes a remote intent through the Studio's existing action handlers. */
export async function executeRemoteIntent(
  payload: unknown,
  context: RemoteIntentContext
): Promise<void> {
  const envelope = payload as {
    intentId?: string
    intent?: { kind?: string } & Record<string, unknown>
  } | null
  const intentId = envelope?.intentId
  const intent = envelope?.intent
  if (!intentId || !intent?.kind) return

  const ack = async (ok: boolean, message?: string): Promise<void> => {
    try {
      await context.client.request('remote.intent.ack', {
        intentId,
        ok,
        ...(message ? { message } : {})
      })
    } catch {
      // The remote client also observes state; a lost ack is non-fatal.
    }
  }

  // Plan 174 I-11: phones and decks show these words as they are, so they
  // are plain copy (docs/ui-copy.md): no ids, no "session", one next step.
  const alreadyRunning = "You're already recording or live."
  try {
    switch (intent.kind) {
      case 'recordStart':
        if (context.sessionActive) return void (await ack(false, alreadyRunning))
        return void ((await context.startRecording())
          ? await ack(true)
          : await ack(false, context.recordBlockedReason ?? REMOTE_INTENT_COPY.recordDidNotStart))
      case 'recordStop':
      case 'streamStop':
        if (!context.sessionActive) return void (await ack(false, REMOTE_INTENT_COPY.notRunning))
        return void ((await context.stopSession())
          ? await ack(true)
          : await ack(false, REMOTE_INTENT_COPY.didNotStop))
      case 'recordToggle': {
        const stopping = context.sessionActive
        const committed = stopping ? await context.stopSession() : await context.startRecording()
        return void (committed
          ? await ack(true)
          : await ack(
              false,
              (!stopping && context.recordBlockedReason) || REMOTE_INTENT_COPY.toggleFailed
            ))
      }
      case 'streamStart':
        if (context.sessionActive) return void (await ack(false, alreadyRunning))
        return void ((await context.startLivestream())
          ? await ack(true)
          : await ack(
              false,
              context.liveStreamBlockedReason ?? REMOTE_INTENT_COPY.streamDidNotStart
            ))
      case 'micMute':
      case 'micUnmute':
      case 'micToggle': {
        const applied = await context.setMicrophoneMuted(
          intent.kind === 'micToggle' ? 'toggle' : intent.kind === 'micMute' ? 'mute' : 'unmute'
        )
        if (!applied) {
          return void (await ack(false, REMOTE_INTENT_COPY.microphone))
        }
        return void (await ack(true))
      }
      case 'systemAudioOn':
      case 'systemAudioOff':
      case 'systemAudioToggle': {
        const [status, shown] = context.systemAudio
        const target = systemAudioTarget(
          intent.kind === 'systemAudioToggle'
            ? 'toggle'
            : intent.kind === 'systemAudioOn'
              ? 'on'
              : 'off',
          status,
          shown
        )
        if (target === null) return void (await ack(false, REMOTE_INTENT_COPY.systemAudio))
        // Accepted = requested. The key renders the confirmed mix from
        // remote.state, which follows once the session reports it.
        context.setSystemAudioEnabled(target)
        return void (await ack(true))
      }
      case 'sceneApply': {
        const layoutPreset = intent.layoutPreset as LayoutPreset | undefined
        if (
          !layoutPreset ||
          !(context.knownLayoutPresets as readonly string[]).includes(layoutPreset)
        ) {
          return void (await ack(false, REMOTE_INTENT_COPY.sceneMissing))
        }
        const committed = await context.applyLayoutPreset(layoutPreset)
        if (!committed) {
          return void (await ack(false, REMOTE_INTENT_COPY.sceneFailed))
        }
        return void (await ack(true))
      }
      case 'takeoverShow': {
        const assetId = intent.assetId as string | undefined
        if (!assetId || !context.hasTakeover(assetId)) {
          return void (await ack(false, REMOTE_INTENT_COPY.takeoverMissing))
        }
        const activated = await context.activateTakeover(assetId)
        if (!activated) {
          return void (await ack(false, REMOTE_INTENT_COPY.takeoverShow))
        }
        return void (await ack(true))
      }
      case 'takeoverHide': {
        const cleared = await context.clearTakeover()
        if (!cleared) {
          return void (await ack(false, REMOTE_INTENT_COPY.takeoverHide))
        }
        return void (await ack(true))
      }
      case 'bannerShow':
      case 'bannerHide':
      case 'bannerToggle': {
        // Plan 186 S7: by id; without one, `bannerHide` hides them all.
        const bannerId = typeof intent.bannerId === 'string' ? intent.bannerId : undefined
        const banner = context.banners.find((candidate) => candidate.id === bannerId)
        if (bannerId !== undefined ? !banner : intent.kind !== 'bannerHide') {
          return void (await ack(false, REMOTE_INTENT_COPY.bannerMissing))
        }
        const action: BannerRelayAction = !banner
          ? { action: 'hideAll' }
          : intent.kind === 'bannerShow' || (intent.kind === 'bannerToggle' && !banner.shown)
            ? { action: 'show', id: banner.id }
            : { action: 'hide', id: banner.id }
        const outcome = await runBannerAction(context.client, action, context.banners)
        return void (await ack(outcome.ok, outcome.message))
      }
      case 'soundPlay':
      case 'soundStop': {
        // Plan 189 S10: `soundPlay` is a press (the backend applies the
        // sound's mode, like a key); `soundStop` without an id stops them all.
        const soundId = typeof intent.soundId === 'string' ? intent.soundId : undefined
        const sounds = context.sounds ?? soundboard.getSnapshot().board?.sounds ?? []
        if (soundId === undefined && intent.kind === 'soundPlay') {
          return void (await ack(false, REMOTE_INTENT_COPY.soundMissing))
        }
        const outcome = await runSoundAction(
          context.client,
          soundId === undefined
            ? { action: 'stopAll' }
            : { action: intent.kind === 'soundPlay' ? 'press' : 'stop', id: soundId },
          sounds
        )
        return void (await ack(outcome.ok, outcome.message))
      }
      case 'windowFront': {
        const windowName = intent.window as string | undefined
        if (!windowName || !(await context.openWindow(windowName))) {
          return void (await ack(false, REMOTE_INTENT_COPY.windowMissing))
        }
        return void (await ack(true))
      }
      case 'commentHighlight': {
        const messageId = intent.messageId as string | undefined
        if (!messageId) return void (await ack(false, REMOTE_INTENT_COPY.messageMissing))
        const outcome = await context.showCommentHighlight(messageId)
        return void (await ack(outcome.ok, outcome.message))
      }
      case 'commentHighlightClear': {
        const outcome = await context.clearCommentHighlight()
        return void (await ack(outcome.ok, outcome.message))
      }
      case 'clipMark': {
        if (!context.sessionActive) return void (await ack(false, REMOTE_INTENT_COPY.notRunning))
        const outcome = await context.markClip()
        return void (await ack(outcome.ok, outcome.message))
      }
      default:
        return void (await ack(false, REMOTE_INTENT_COPY.unsupported))
    }
  } catch (error) {
    // The raw error is for the console, never the phone (docs/ui-copy.md).
    console.error('[remote-control] intent failed', intent.kind, error)
    await ack(false, REMOTE_INTENT_COPY.failed)
  }
}
