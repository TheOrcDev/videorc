// The Studio's projection for agents (plan 209 S6): what `get_status` and the
// `list_*` tools read about the renderer-owned truth (the scene, the
// microphone, System audio, takeovers, sounds, sources, destinations),
// published through `agent.surface.publish` and merged by the backend with
// its own truth (agent_look.rs).
//
// Built by ALLOWLIST, field by field, like the remote surface: never a token,
// a key, a server URL, an account id or a file path (D9). Device and scene
// names are the streamer's own words on this computer; the Library tools are
// the only ones that return paths, and they read the backend.
//
// Published only while Agents is on, or (plan 209 S19) while Buddy may use
// the tools (Premium): Buddy's planner reads the scene and destination names
// from it. Nothing crosses for a streamer who has neither. Deliberately not a React effect: the Studio's render
// body hands the publisher its latest inputs (`sync`), and the publisher
// builds, dedupes, debounces, republishes on reconnect and retries on its own
// timeline, like `RemoteSurfacePublisher`.

import type { DeviceList, LayoutPreset } from '@/lib/backend'
import { isStreamTargetStartReady } from '@/lib/capture'
import { layoutPresetLabel } from '@/lib/layout-labels'
import { destinationLabel } from '@/lib/platform-copy'
import { soundboard, type SoundboardStore } from '@/lib/soundboard-store'
import type {
  CaptionsStatus,
  CohostSettings,
  CohostState,
  DeviceStatus,
  EffectiveSceneBackground,
  SourceSelection,
  StreamMetadataDraft,
  StreamingSettings
} from '../../../shared/backend'

export interface AgentSurfaceScene {
  id: string
  name: string
  kind: 'saved' | 'layout'
}

export interface AgentSurfaceDestination {
  id: string
  platform: string
  label: string
  on: boolean
  ready: boolean
  reason?: string
  title?: string
  category?: string
}

export interface AgentSurface {
  version: 1
  recordBlockedReason?: string
  liveBlockedReason?: string
  scene: AgentSurfaceScene & { modified: boolean }
  scenes: AgentSurfaceScene[]
  microphone: { muted: boolean; name?: string }
  systemAudio: { on: boolean; available: boolean }
  takeoverId?: string
  takeovers: { id: string; name: string }[]
  sounds: { id: string; name: string; playing: boolean }[]
  /** A live background by its catalog id and look; a picture says only that. */
  background?: { liveId: string; look: string } | { picture: true }
  captions: { on: boolean; state: string }
  buddy: { on: boolean; status?: string }
  sources: {
    devices: { id: string; name: string; kind: string; available: boolean }[]
    chosen: { screenId?: string; windowId?: string; cameraId?: string; microphoneId?: string }
  }
  destinations: AgentSurfaceDestination[]
  windows: { notes: boolean; streamManager: boolean; preview: boolean }
}

/** What the Studio hands over each render: references, built lazily. */
export interface AgentSurfaceInput {
  recordBlockedReason: string | null
  liveStreamBlockedReason: string | null
  layoutPreset: LayoutPreset
  layoutPresets: readonly LayoutPreset[]
  activeSavedSceneId: string | null
  savedSceneModified: boolean
  savedScenes: readonly { id: string; name: string }[]
  microphoneMuted: boolean
  sources: SourceSelection
  devices: DeviceList['devices']
  systemAudioStatus: DeviceStatus | undefined
  systemAudioShown: boolean
  activeTakeoverId: string | null
  takeovers: readonly { id: string; name: string }[]
  background: EffectiveSceneBackground | undefined
  captionsEnabled: boolean
  captionsStatus: CaptionsStatus
  cohostSettings: CohostSettings | null
  cohostState: CohostState | null
  streaming: StreamingSettings
  streamMetadataDraft: StreamMetadataDraft | null
  windows: { notes: boolean; streamManager: boolean; preview: boolean }
  /** Plan 209 S19: Buddy may use the tools (Premium), so its planner reads
   * the projection too, Agents on or not. */
  buddyCanAct?: boolean
}

const CAPTIONS_RUNNING = new Set(['starting', 'listening', 'reconnecting', 'degraded'])

function present(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim()
  return trimmed ? trimmed : undefined
}

function destinationProjection(
  streaming: StreamingSettings,
  draft: StreamMetadataDraft | null
): AgentSurfaceDestination[] {
  return streaming.targets.map((target) => {
    const label = destinationLabel(target.label)
    const ready = isStreamTargetStartReady(target)
    const override = draft?.targetOverrides.find((entry) => entry.platform === target.platform)
    const title = present(override?.customize ? override.title : draft?.title)
    const category = present(override?.twitchCategoryName ?? override?.kickCategoryName)
    return {
      id: target.id,
      platform: target.platform,
      label,
      on: target.enabled,
      ready,
      ...(ready ? {} : { reason: `Finish setting up ${label} in Livestream.` }),
      ...(title ? { title } : {}),
      ...(category ? { category } : {})
    }
  })
}

/** The allowlisted projection. Pure, so the leak rules are tested in node. */
export function buildAgentSurface(
  input: AgentSurfaceInput,
  playingSounds: readonly { id: string; name: string; playing: boolean }[]
): AgentSurface {
  const bothOrientations =
    input.layoutPresets.some((preset) => preset.startsWith('vertical-')) &&
    input.layoutPresets.some((preset) => !preset.startsWith('vertical-'))
  const layouts: AgentSurfaceScene[] = input.layoutPresets.map((preset) => ({
    id: preset,
    name: layoutPresetLabel(preset, { bothOrientations }),
    kind: 'layout'
  }))
  const saved: AgentSurfaceScene[] = input.savedScenes.map(({ id, name }) => ({
    id,
    name,
    kind: 'saved'
  }))
  const activeSaved = saved.find((scene) => scene.id === input.activeSavedSceneId)
  const activeLayout = layouts.find((scene) => scene.id === input.layoutPreset) ?? {
    id: input.layoutPreset,
    name: layoutPresetLabel(input.layoutPreset, { bothOrientations }),
    kind: 'layout' as const
  }
  const scene = activeSaved
    ? { ...activeSaved, modified: input.savedSceneModified }
    : { ...activeLayout, modified: false }
  const microphoneName = present(
    input.devices.find((device) => device.id === input.sources.microphoneId)?.name ??
      input.sources.microphoneName
  )
  const systemAudioAvailable = input.systemAudioStatus === 'available'
  const live = input.background?.live
  const devices = input.devices
    .filter((device) => device.kind !== 'system-audio')
    .map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      available: device.status === 'available'
    }))
  const chosen = {
    ...(input.sources.screenId ? { screenId: input.sources.screenId } : {}),
    ...(input.sources.windowId ? { windowId: input.sources.windowId } : {}),
    ...(input.sources.cameraId ? { cameraId: input.sources.cameraId } : {}),
    ...(input.sources.microphoneId ? { microphoneId: input.sources.microphoneId } : {})
  }
  const recordBlockedReason = present(input.recordBlockedReason)
  const liveBlockedReason = present(input.liveStreamBlockedReason)
  return {
    version: 1,
    ...(recordBlockedReason ? { recordBlockedReason } : {}),
    ...(liveBlockedReason ? { liveBlockedReason } : {}),
    scene,
    scenes: [...saved, ...layouts],
    microphone: {
      muted: input.microphoneMuted,
      ...(microphoneName ? { name: microphoneName } : {})
    },
    systemAudio: {
      on: systemAudioAvailable && input.systemAudioShown,
      available: systemAudioAvailable
    },
    ...(input.activeTakeoverId ? { takeoverId: input.activeTakeoverId } : {}),
    takeovers: input.takeovers.map(({ id, name }) => ({ id, name })),
    sounds: playingSounds.map(({ id, name, playing }) => ({ id, name, playing })),
    ...(live
      ? { background: { liveId: live.id, look: live.look } }
      : input.background
        ? { background: { picture: true as const } }
        : {}),
    captions: {
      on: input.captionsEnabled && CAPTIONS_RUNNING.has(input.captionsStatus.state),
      state: input.captionsStatus.state
    },
    buddy: {
      on: input.cohostSettings?.enabled === true,
      ...(input.cohostState?.status ? { status: input.cohostState.status } : {})
    },
    sources: { devices, chosen },
    destinations: destinationProjection(input.streaming, input.streamMetadataDraft),
    windows: { ...input.windows }
  }
}

/** The board as agents see it: board order, without a sound waiting for its Undo. */
function soundsFrom(store: SoundboardStore): { id: string; name: string; playing: boolean }[] {
  const snapshot = store.getSnapshot()
  const playing = new Set(snapshot.voices.map((voice) => voice.soundId))
  return (snapshot.board?.sounds ?? [])
    .filter((sound) => !snapshot.hidden.has(sound.id))
    .map(({ id, name }) => ({ id, name, playing: playing.has(id) }))
}

interface AgentSurfaceClient {
  request<T>(method: string, params?: unknown): Promise<T>
}

/** Coalesce render bursts; an agent polls far slower than this. */
const PUBLISH_DEBOUNCE_MS = 150
const PUBLISH_RETRY_DELAYS_MS = [1000, 2000, 4000]

export class AgentSurfacePublisher {
  private client: AgentSurfaceClient | null = null
  private connected = false
  private agentsEnabled = false
  private latest: AgentSurfaceInput | null = null
  private lastPublishedBody: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private offSounds: (() => void) | null = null

  constructor(private readonly sounds: SoundboardStore = soundboard) {}

  attach(client: AgentSurfaceClient): void {
    this.client = client
    this.connected = false
    this.offSounds?.()
    // A sound starting or stopping changes the projection, not the Studio's inputs.
    this.offSounds = this.sounds.subscribe(() => this.schedule(PUBLISH_DEBOUNCE_MS))
  }

  /** The socket is live: the backend's slate is blank, so republish. */
  markConnected(): void {
    this.connected = true
    this.lastPublishedBody = null
    this.retryAttempt = 0
    this.schedule(0)
  }

  /** Published while Agents is on or Buddy may act (`buddyCanAct`). */
  private get enabled(): boolean {
    return this.agentsEnabled || this.latest?.buddyCanAct === true
  }

  /** Agents on or off (`agents.status`). Off publishes nothing (unless Buddy
   * may act); turning it on publishes now. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.agentsEnabled) return
    const was = this.enabled
    this.agentsEnabled = enabled
    if (!was && this.enabled) {
      this.lastPublishedBody = null
      this.schedule(0)
    }
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

  /** Record the Studio's latest inputs; safe from a render body (no work, one timer). */
  sync(input: AgentSurfaceInput): void {
    const was = this.enabled
    this.latest = input
    if (!this.enabled || !this.connected) return
    if (was) {
      this.schedule(PUBLISH_DEBOUNCE_MS)
    } else {
      // Buddy just became able to act: publish now, like turning Agents on.
      this.lastPublishedBody = null
      this.schedule(0)
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    const { client, latest } = this
    if (!client || !this.connected || !this.enabled || !latest) return
    const surface = buildAgentSurface(latest, soundsFrom(this.sounds))
    const body = JSON.stringify(surface)
    if (body === this.lastPublishedBody) return
    try {
      await client.request('agent.surface.publish', { surface })
      this.lastPublishedBody = body
      this.retryAttempt = 0
    } catch (error) {
      if (this.retryAttempt < PUBLISH_RETRY_DELAYS_MS.length) {
        this.schedule(PUBLISH_RETRY_DELAYS_MS[this.retryAttempt])
        this.retryAttempt += 1
        return
      }
      this.retryAttempt = 0
      console.error('[agents] surface publish failed after retries', error)
    }
  }
}
