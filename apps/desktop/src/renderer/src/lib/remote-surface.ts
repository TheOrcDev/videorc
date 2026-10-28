import type { DeviceStatus, LayoutPreset } from '@/lib/backend'
import { layoutPresetLabel } from '@/lib/layout-labels'
import { soundboard, type SoundboardSnapshot, type SoundboardStore } from '@/lib/soundboard-store'
import { bannerSummaries, type BannerSummary } from '../../../shared/banner-commands'

/** The state projection deck keys render. Minimal by design and the ONLY
 * payload remote sockets receive — never widen it with tokens/paths/URLs. */
export interface RemoteSurfaceState {
  sessionState: string
  sessionActive: boolean
  recordEnabled: boolean
  streamEnabled: boolean
  micMuted: boolean
  layoutPreset: LayoutPreset
  savedScenes?: { id: string; name: string }[]
  activeSavedSceneId?: string | null
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
  banners: readonly BannerSummary[],
  savedScenes?: readonly { id: string; name: string }[],
  activeSavedSceneId?: string | null
]

function snapshotFromValues(
  values: RemoteSurfaceValues,
  sounds: RemoteSoundSummary[]
): RemoteSurfaceSnapshot {
  return {
    state: {
      savedScenes: (values[15] ?? []).map(({ id, name }) => ({ id, name })),
      activeSavedSceneId: values[16] ?? null,
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

// The intent executor lives in lib/studio-actions (plan 209 S5): one context
// and one executor per action, shared by remote intents and agent tools.
// These names stay here for the callers that read them from the surface.
export {
  REMOTE_INTENT_COPY,
  executeRemoteIntent,
  type StudioActionContext as RemoteIntentContext,
  type StudioActionOutcome as RemoteIntentOutcome
} from '@/lib/studio-actions'

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
