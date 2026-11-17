import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import {
  CAPABILITY_TOPIC,
  capabilityCurrent,
  parseConsumerCapability,
  type CapabilityReceipt,
  CAPABILITY_RECEIPT_MAX_BYTES
} from './room-media-v2'
import {
  SCENE_LEASE_MS,
  SCENE_MAX_BYTES,
  SCENE_MOTION_MAX_MS,
  SCENE_TOPIC,
  parseSceneSnapshot,
  sceneContentKey,
  type CloudScene,
  type SceneOrientation,
  type SceneOutput,
  type SceneSnapshot
} from '../../../shared/cloud-scene'
import {
  BACKGROUND_ASSET_TOPIC,
  backgroundKey,
  encodeBackgroundAsset,
  type BackgroundDrawn,
  type BackgroundMime
} from '../../../shared/cloud-background'

/**
 * Plan 249 S14: a scene background's picture, ready to send. Immutable: its
 * SHA-256 names it, and each consumer gets it once per connection.
 */
export type PreparedBackgroundAsset = {
  hash: string
  mime: BackgroundMime
  width: number
  height: number
  bytes: Uint8Array
}
/** What the program pages drew for the scene's background (S14). */
export type RoomBackgroundStatus = {
  /** `backgroundKey` of what the scene asks for, per lane. */
  wanted: { h: string; v: string }
  /** Each capable lane's last drawn background. */
  drawn: Record<string, BackgroundDrawn>
  /** Egress pages that cannot draw scene backgrounds (older pages). */
  unsupported: number
  productionQualified: false
}

/**
 * Plan 249 S12. What the room's program draws for each orientation lane.
 * `null` for a lane: the room's own layouts. Stream and recording lanes of
 * one orientation show the same scene (a scene is a picture, not a graphic
 * with per-output switches).
 */
export type SceneContent = {
  h: CloudScene | null
  v: CloudScene | null
  transition: { kind: 'cut' | 'motion'; durationMs: number }
}
export type RoomSceneObservation = {
  revision: number
  output: SceneOutput
  orientation: SceneOrientation
}
export type RoomSceneStatus = {
  enabled: boolean
  state: 'off' | 'preview' | 'waiting' | 'applied' | 'failed'
  reason: string | null
  /** The commit generation; each targeted snapshot has its own revision. */
  generation: number
  sceneId: { h: string | null; v: string | null }
  /** What each lane is asked to draw: the Program preview draws the same. */
  content: SceneContent | null
  observed: Record<string, RoomSceneObservation>
  /** Plan 249 S14: present while the scene names a background. */
  background?: RoomBackgroundStatus
  productionQualified: false
}
/** What `commit` answers: the rendered revisions, or why there are none. */
export type RoomSceneCommit = {
  state: 'applied' | 'preview' | 'waiting' | 'failed' | 'superseded'
  reason: string | null
  observed: Record<string, RoomSceneObservation>
}

const RESEND_MS = 10_000
const COMMIT_WAIT_MS = 5_000

/**
 * Targeted scene snapshots to authorized program egress consumers only (S3
 * receipts with the S12 `scene` lane). Guests keep their own call view; no
 * scene is broadcast. A commit settles on each lane's rendered revision; a
 * page that never confirms leaves the commit `waiting`, never applied.
 */
export class RoomScenePublisher {
  #content: SceneContent | null = null
  #applyAt = 0
  #receipts = new Map<string, CapabilityReceipt>()
  #sent = new Map<string, { key: string; revision: number; at: number; generation: number }>()
  #revision = 0
  #generation = 0
  #busy = false
  #again = false
  #closed = false
  #timer: ReturnType<typeof setInterval> | undefined
  #error: string | null = null
  #lastStatus = ''
  #waiters = new Set<() => void>()
  #assets: readonly PreparedBackgroundAsset[] = []
  /** Picture hashes each consumer has, keyed by its participant SID. */
  #assetsSent = new Map<string, { sid: string; hashes: Set<string> }>()
  constructor(
    private room: Room,
    private changed: (status: RoomSceneStatus) => void,
    private now: () => number = Date.now
  ) {
    room.on(RoomEvent.DataReceived, this.#receive)
    room.on(RoomEvent.Reconnecting, this.#lost)
    room.on(RoomEvent.Disconnected, this.#lost)
    room.on(RoomEvent.ParticipantDisconnected, this.#refresh)
    room.on(RoomEvent.ParticipantConnected, this.#refresh)
  }
  get content(): SceneContent | null {
    return this.#content
  }
  /** Plan 249 S14: the pictures the next commit's backgrounds name. */
  setAssets(assets: readonly PreparedBackgroundAsset[]): void {
    this.#assets = assets
  }
  /**
   * Replace what every lane draws. Resolves with each egress lane's rendered
   * revision, `preview` when no egress runs, or `waiting` after a bounded wait.
   */
  async commit(content: SceneContent | null): Promise<RoomSceneCommit> {
    if (this.#closed) return { state: 'failed', reason: 'The room is closed.', observed: {} }
    if (
      content &&
      (content.transition.durationMs < 0 ||
        content.transition.durationMs > SCENE_MOTION_MAX_MS ||
        (content.transition.kind === 'cut' && content.transition.durationMs !== 0))
    )
      return { state: 'failed', reason: 'Invalid scene transition.', observed: {} }
    this.#content = content
    this.#applyAt = this.now()
    const generation = ++this.#generation
    this.#sent.clear()
    this.#error = null
    // Kept after a clear too: a clear is confirmed like any scene.
    this.#timer ??= setInterval(this.#refresh, 1000)
    this.#refresh()
    const deadline = this.now() + COMMIT_WAIT_MS
    for (;;) {
      const status = this.#status()
      if (generation !== this.#generation)
        return { state: 'superseded', reason: 'A newer scene replaced this one.', observed: {} }
      if (status.state !== 'waiting' || this.now() >= deadline)
        return {
          // A confirmed clear is applied; with no output running it is a preview.
          state:
            status.state === 'off'
              ? [...this.room.remoteParticipants.keys()].some((id) => id.startsWith('EG_'))
                ? 'applied'
                : 'preview'
              : status.state,
          reason: status.reason,
          observed: status.observed
        }
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          this.#waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, 250)
        this.#waiters.add(done)
      })
    }
  }
  #receive = (bytes: Uint8Array, participant?: unknown, _kind?: unknown, topic?: string): void => {
    if (participant || topic !== CAPABILITY_TOPIC || bytes.length > CAPABILITY_RECEIPT_MAX_BYTES)
      return
    try {
      const raw = JSON.parse(new TextDecoder().decode(bytes))
      const parsed = parseConsumerCapability(raw)
      if (
        !parsed ||
        !parsed.identity.startsWith('EG_') ||
        !parsed.scene ||
        !Number.isSafeInteger(raw.at) ||
        !capabilityCurrent(
          { ...parsed, at: raw.at },
          this.room.remoteParticipants.get(parsed.identity)?.sid ?? '',
          this.now()
        )
      )
        return
      const old = this.#receipts.get(parsed.identity)
      if (old && old.at >= raw.at) return
      this.#receipts.set(parsed.identity, { ...parsed, at: raw.at })
      this.#refresh()
    } catch {
      /* Untrusted input supplies no capability. */
    }
  }
  #lost = (): void => {
    this.#receipts.clear()
    this.#sent.clear()
    this.#assetsSent.clear()
    this.#report()
  }
  #wanted(lane: { output: SceneOutput; orientation: SceneOrientation }): CloudScene | null {
    void lane.output
    return this.#content?.[lane.orientation] ?? null
  }
  #status(): RoomSceneStatus {
    const observed: RoomSceneStatus['observed'] = {}
    const peers = [...this.room.remoteParticipants.values()].filter((p) =>
      p.identity.startsWith('EG_')
    )
    let capable = 0
    for (const peer of peers) {
      const receipt = this.#receipts.get(peer.identity)
      if (!capabilityCurrent(receipt, peer.sid, this.now()) || !receipt?.scene) continue
      capable++
      const ack = receipt.scene.applied
      const sent = this.#sent.get(peer.identity)
      if (
        sent?.generation === this.#generation &&
        ack?.publisherSid === this.room.localParticipant.sid &&
        ack.revision === sent.revision
      )
        observed[peer.identity] = {
          revision: ack.revision,
          output: receipt.scene.output,
          orientation: receipt.scene.orientation
        }
    }
    const backgroundWanted = {
      h: backgroundKey(this.#content?.h?.background),
      v: backgroundKey(this.#content?.v?.background)
    }
    let background: RoomBackgroundStatus | undefined
    if (backgroundWanted.h !== 'none' || backgroundWanted.v !== 'none') {
      const drawn: Record<string, BackgroundDrawn> = {}
      let unsupported = 0
      for (const peer of peers) {
        const receipt = this.#receipts.get(peer.identity)
        if (!capabilityCurrent(receipt, peer.sid, this.now()) || !receipt?.scene) continue
        const page = receipt.scene.background
        if (!page) unsupported++
        else if (page.drawn) drawn[peer.identity] = page.drawn
      }
      background = { wanted: backgroundWanted, drawn, unsupported, productionQualified: false }
    }
    const enabled = !!this.#content
    const committed = this.#generation > 0
    const connected = this.room.state === ConnectionState.Connected
    const confirmed = capable === peers.length && Object.keys(observed).length === peers.length
    // `off`: no scene, and every output confirmed the clear (or none runs).
    const state: RoomSceneStatus['state'] = this.#error
      ? 'failed'
      : !committed
        ? 'off'
        : !connected
          ? 'waiting'
          : !peers.length
            ? enabled
              ? 'preview'
              : 'off'
            : confirmed
              ? enabled
                ? 'applied'
                : 'off'
              : 'waiting'
    const reason =
      this.#error ??
      (!connected && committed
        ? 'Waiting for the room connection.'
        : state === 'preview'
          ? 'Accepted; no program output is running yet.'
          : state === 'waiting'
            ? capable < peers.length
              ? 'Scene unconfirmed: reload older program pages.'
              : 'Scene sent; waiting for each output to draw it.'
            : null)
    return {
      enabled,
      state,
      reason,
      generation: this.#generation,
      sceneId: { h: this.#content?.h?.id ?? null, v: this.#content?.v?.id ?? null },
      content: this.#content,
      observed,
      ...(background ? { background } : {}),
      productionQualified: false
    }
  }
  #report(): void {
    if (this.#closed) return
    const status = this.#status()
    const key = JSON.stringify(status)
    if (key !== this.#lastStatus) {
      this.#lastStatus = key
      this.changed(status)
    }
    for (const wake of [...this.#waiters]) wake()
  }
  #refresh = (): void => {
    if (this.#closed) return
    for (const identity of this.#receipts.keys())
      if (!this.room.remoteParticipants.has(identity)) {
        this.#receipts.delete(identity)
        this.#sent.delete(identity)
        this.#assetsSent.delete(identity)
      }
    this.#report()
    if (this.room.state !== ConnectionState.Connected) return
    if (this.#busy) {
      this.#again = true
      return
    }
    this.#busy = true
    const generation = this.#generation
    void this.#send(generation)
      .catch(() => {
        if (generation === this.#generation)
          this.#error = 'Scene delivery failed; the program is unconfirmed.'
      })
      .finally(() => {
        this.#busy = false
        this.#report()
        if (this.#again) {
          this.#again = false
          this.#refresh()
        }
      })
  }
  snapshotFor(lane: { output: SceneOutput; orientation: SceneOrientation }): SceneSnapshot {
    const now = this.now()
    const transition = this.#content?.transition ?? { kind: 'cut' as const, durationMs: 0 }
    return {
      version: 1,
      show: this.room.name,
      publisherSid: this.room.localParticipant.sid,
      revision: ++this.#revision,
      output: lane.output,
      orientation: lane.orientation,
      expiresAt: now + SCENE_LEASE_MS - 1000,
      scene: this.#wanted(lane),
      transition: {
        kind: transition.kind,
        durationMs: transition.kind === 'cut' ? 0 : transition.durationMs,
        applyAt: this.#applyAt || now
      }
    }
  }
  async #send(generation: number): Promise<void> {
    for (const peer of this.room.remoteParticipants.values()) {
      if (this.#closed || generation !== this.#generation) return
      const receipt = this.#receipts.get(peer.identity)
      if (
        !peer.identity.startsWith('EG_') ||
        !capabilityCurrent(receipt, peer.sid, this.now()) ||
        !receipt?.scene
      )
        continue
      const lane = { output: receipt.scene.output, orientation: receipt.scene.orientation }
      const key = JSON.stringify([
        peer.sid,
        this.room.localParticipant.sid,
        lane,
        sceneContentKey(this.#wanted(lane)),
        this.#content?.transition ?? null
      ])
      const old = this.#sent.get(peer.identity)
      if (old?.key === key && old.generation === generation && this.now() - old.at < RESEND_MS)
        continue
      // S14: the picture goes before the scene that names it, once per consumer.
      await this.#sendAsset(peer, this.#wanted(lane)?.background, generation)
      if (this.#closed || generation !== this.#generation) return
      const snapshot = this.snapshotFor(lane)
      if (!parseSceneSnapshot(snapshot, { ...snapshot, now: this.now() }))
        throw new Error('Invalid scene snapshot')
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
      if (bytes.length > SCENE_MAX_BYTES) throw new Error('Scene snapshot too large')
      const writer = await withTimeout(
        this.room.localParticipant.streamBytes({
          topic: SCENE_TOPIC,
          mimeType: 'application/json',
          totalSize: bytes.length,
          destinationIdentities: [peer.identity],
          attributes: { empty: String(snapshot.scene === null) }
        })
      )
      await withTimeout(writer.write(bytes))
      await withTimeout(writer.close())
      if (
        this.#closed ||
        generation !== this.#generation ||
        peer.sid !== this.room.remoteParticipants.get(peer.identity)?.sid
      )
        return
      this.#sent.set(peer.identity, {
        key,
        revision: snapshot.revision,
        at: this.now(),
        generation
      })
      this.#error = null
    }
  }
  async #sendAsset(
    peer: { identity: string; sid: string },
    background: CloudScene['background'],
    generation: number
  ): Promise<void> {
    if (background?.kind !== 'picture') return
    const asset = this.#assets.find((one) => one.hash === background.hash)
    if (!asset) throw new Error('The background picture is not ready.')
    let sent = this.#assetsSent.get(peer.identity)
    if (sent?.sid !== peer.sid) {
      sent = { sid: peer.sid, hashes: new Set() }
      this.#assetsSent.set(peer.identity, sent)
    }
    if (sent.hashes.has(asset.hash)) return
    const message = encodeBackgroundAsset(
      {
        version: 1,
        show: this.room.name,
        publisherSid: this.room.localParticipant.sid,
        hash: asset.hash,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
        size: asset.bytes.length
      },
      asset.bytes
    )
    const writer = await withTimeout(
      this.room.localParticipant.streamBytes({
        topic: BACKGROUND_ASSET_TOPIC,
        mimeType: 'application/octet-stream',
        totalSize: message.length,
        destinationIdentities: [peer.identity]
      }),
      15_000
    )
    await withTimeout(writer.write(message), 15_000)
    await withTimeout(writer.close(), 15_000)
    if (this.#closed || generation !== this.#generation) return
    if (peer.sid === this.room.remoteParticipants.get(peer.identity)?.sid)
      sent.hashes.add(asset.hash)
  }
  close(): void {
    this.#closed = true
    this.#generation++
    clearInterval(this.#timer)
    this.room.off(RoomEvent.DataReceived, this.#receive)
    this.room.off(RoomEvent.Reconnecting, this.#lost)
    this.room.off(RoomEvent.Disconnected, this.#lost)
    this.room.off(RoomEvent.ParticipantDisconnected, this.#refresh)
    this.room.off(RoomEvent.ParticipantConnected, this.#refresh)
    this.#content = null
    this.#assets = []
    this.#receipts.clear()
    this.#sent.clear()
    this.#assetsSent.clear()
    for (const wake of [...this.#waiters]) wake()
  }
}

function withTimeout<T>(job: Promise<T>, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Scene upload timed out')), ms)
    job.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
