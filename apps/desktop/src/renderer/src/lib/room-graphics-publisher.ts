import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import {
  CAPABILITY_TOPIC,
  capabilityCurrent,
  consumerSid,
  parseConsumerCapability,
  roomConsumers,
  type CapabilityReceipt,
  CAPABILITY_RECEIPT_MAX_BYTES
} from './room-media-v2'
import { SentAssets, withReferences } from './room-asset-references'
import {
  GRAPHICS_TOPIC,
  GRAPHICS_LEASE_MS,
  GRAPHICS_MAX_BYTES,
  parseGraphicsSnapshot,
  type GraphicsLayer,
  type GraphicsSnapshot
} from '../../../shared/cloud-graphics'

import type { GraphicsContent } from '../../../shared/cloud-graphics'
export type { GraphicsContent } from '../../../shared/cloud-graphics'

export function graphicsLayers(
  content: GraphicsContent | null,
  output: 'stream' | 'recording',
  orientation: 'h' | 'v',
  captions = true
): GraphicsLayer[] {
  return (content?.[orientation] ?? [])
    .filter((l) => l[output] && (l.kind !== 'caption' || captions))
    .map(({ stream: _s, recording: _r, outputRects, ...layer }) => ({
      ...layer,
      rect: outputRects?.[output] ?? layer.rect
    }))
}
/**
 * What the room sends to its program pages (plan 249 S9, S15). With the
 * room's Graphics switch on, everything. Off, only the layers whose own
 * controls already put them on the stream: captions (Captions on) and the
 * comment card (a Highlight, or the Sidekick's pick). The switch names
 * banners, timers and the chat box; before S9 a managed show sent captions
 * and cards through the room overlay path whatever it said, and S9 moved
 * them behind it, so on 0.31.0 to 0.32.1 a managed show's captions and cards
 * never reached the viewers while the desktop reported them on stream (the
 * owner, 2026-11-19). HTML banners are banners: their placements go only
 * with the switch on.
 */
export function roomGraphicsContent(
  content: GraphicsContent | null,
  graphicsEnabled: boolean
): GraphicsContent | null {
  if (!content || graphicsEnabled) return content
  const own = (layers: GraphicsContent['h']) =>
    layers.filter((layer) => layer.kind === 'caption' || layer.kind === 'highlight')
  const h = own(content.h)
  const v = own(content.v)
  return h.length || v.length ? { h, v, unsupported: [] } : null
}
export type RoomGraphicsStatus = {
  enabled: boolean
  state: 'off' | 'preview' | 'waiting' | 'applied' | 'failed'
  reason: string | null
  revision: number
  preview: GraphicsSnapshot | null
  observed: Record<
    string,
    { revision: number; output: 'stream' | 'recording'; orientation: 'h' | 'v' }
  >
  productionQualified: false
}
/**
 * Plan 249 S24: one output view a program page applied, exactly as it was
 * sent to that page, for the cloud to keep for the next controller (or to
 * forget, when it is empty). Banners only survive there (D9).
 */
export type AcceptedGraphicsView = {
  output: 'stream' | 'recording'
  orientation: 'h' | 'v'
  publisherSid: string
  revision: number
  layers: GraphicsLayer[]
}
/** Independently enabled by the existing graphics output switches. Never broadcasts
 * pixels to guests, or infers graphic support from S3's auxiliary version. */
export class RoomGraphicsPublisher {
  #content: GraphicsContent | null = null
  #receipts = new Map<string, CapabilityReceipt>()
  /** Per peer: the exact sanitized envelope it was sent (S24 keeps it as sent). */
  #sent = new Map<
    string,
    {
      key: string
      revision: number
      at: number
      layers: GraphicsLayer[]
      output: 'stream' | 'recording'
      orientation: 'h' | 'v'
      publisherSid: string
      expiresAt: number
    }
  >()
  /**
   * Plan 249 S24: the highest revision reported as accepted per output view
   * (`output/orientation/publisherSid`). Pages sharing a view get different
   * revisions; a late acknowledgement of an older one never replaces it.
   */
  #accepted = new Map<string, number>()
  /** PERF-06: which pictures each program page provably holds (survives `set`). */
  #assets = new SentAssets()
  #revision = 0
  #generation = 0
  #busy = false
  #closed = false
  #preview: GraphicsSnapshot | null = null
  #timer: ReturnType<typeof setInterval> | undefined
  #error: string | null = null
  #lastStatus = ''
  constructor(
    private room: Room,
    private changed: (status: RoomGraphicsStatus) => void,
    /** Plan 249 S24: called once per view a program page applied, clears too. */
    private accepted?: (view: AcceptedGraphicsView) => void
  ) {
    room.on(RoomEvent.DataReceived, this.#receive)
    room.on(RoomEvent.Reconnecting, this.#lost)
    room.on(RoomEvent.Disconnected, this.#lost)
    room.on(RoomEvent.ParticipantDisconnected, this.#left)
  }
  set(content: GraphicsContent | null): void {
    const captionRemoved = (['h', 'v'] as const).some((orientation) =>
      (['stream', 'recording'] as const).some(
        (output) =>
          graphicsLayers(this.#content, output, orientation).some((l) => l.kind === 'caption') &&
          !graphicsLayers(content, output, orientation).some((l) => l.kind === 'caption')
      )
    )
    this.#content = content
    clearInterval(this.#timer)
    this.#timer = content ? setInterval(this.#refresh, 1000) : undefined
    this.#generation++
    this.#sent.clear()
    this.#error = content?.unsupported.length ? content.unsupported.join(' ') : null
    this.#makePreview()
    // Hide is a tiny independent snapshot; it never waits behind an asset
    // writer. The older upload is fenced before its next chunk/trailer.
    if (
      (captionRemoved || !content || (!content.h.length && !content.v.length)) &&
      this.#busy &&
      this.room.state === ConnectionState.Connected
    ) {
      const generation = this.#generation
      void this.#send(generation)
        .catch(() => {
          if (generation === this.#generation) this.#error = 'Graphics clear unconfirmed.'
        })
        .finally(() => this.#report())
    }
    this.#refresh()
  }
  fail(): void {
    this.set(null)
    this.#error = 'Graphics assets unavailable. Nothing was published.'
    this.#report()
  }
  #makePreview(): void {
    const sid = this.room.localParticipant.sid
    const content = this.#content
    this.#preview =
      content && sid
        ? this.#snapshot(
            content.h.some((l) => l.stream) ? 'stream' : 'recording',
            'h',
            graphicsLayers(content, content.h.some((l) => l.stream) ? 'stream' : 'recording', 'h')
          )
        : null
  }
  #snapshot(
    output: 'stream' | 'recording',
    orientation: 'h' | 'v',
    layers: GraphicsLayer[]
  ): GraphicsSnapshot {
    const now = Date.now()
    return {
      version: 1,
      show: this.room.name,
      publisherSid: this.room.localParticipant.sid,
      revision: ++this.#revision,
      output,
      orientation,
      expiresAt: now + GRAPHICS_LEASE_MS - 1000,
      layers: layers
        .filter((l) => l.expiresAt === null || l.expiresAt > now)
        .map((l) => ({
          ...l,
          expiresAt:
            l.expiresAt === null ? null : Math.min(l.expiresAt, now + GRAPHICS_LEASE_MS - 1000)
        }))
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
        !parsed.graphics?.static ||
        !Number.isSafeInteger(raw.at) ||
        !capabilityCurrent(
          { ...parsed, at: raw.at },
          consumerSid(this.room, parsed.identity, { ...parsed, at: raw.at }, Date.now()),
          Date.now()
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
    this.#generation++
    this.#receipts.clear()
    this.#sent.clear()
    this.#assets.clear()
    this.#preview = null
    this.#report()
  }
  #report(): void {
    if (this.#closed) return
    const observed: RoomGraphicsStatus['observed'] = {}
    const peers = roomConsumers(this.room, this.#receipts, Date.now()).filter((p) =>
      p.identity.startsWith('EG_')
    )
    let capable = 0
    let wanted = 0
    for (const peer of peers) {
      const receipt = this.#receipts.get(peer.identity)
      if (!capabilityCurrent(receipt, peer.sid, Date.now()) || !receipt?.graphics?.static) continue
      const needsCaptions = graphicsLayers(
        this.#content,
        receipt.graphics.output,
        receipt.graphics.orientation
      ).some((l) => l.kind === 'caption')
      if (!needsCaptions || receipt.graphics.static.captions === 1) capable++
      // Before the visibility check: an applied empty view (Hide, an output
      // switched off, nothing retained) must reach the cloud too, or a
      // takeover would bring back banners that were taken off.
      this.#noteAccepted(peer.identity, receipt.graphics)
      const visible = graphicsLayers(
        this.#content,
        receipt.graphics.output,
        receipt.graphics.orientation
      ).some((l) => l.expiresAt === null || l.expiresAt > Date.now())
      if (!visible) continue
      wanted++
      const ack = receipt.graphics.static.applied
      const sent = this.#sent.get(peer.identity)
      if (ack?.publisherSid === this.room.localParticipant.sid && ack.revision === sent?.revision)
        observed[peer.identity] = {
          revision: ack.revision,
          output: receipt.graphics.output,
          orientation: receipt.graphics.orientation
        }
    }
    const enabled = !!this.#content
    const connected = this.room.state === ConnectionState.Connected
    const state: RoomGraphicsStatus['state'] = this.#error
      ? 'failed'
      : !enabled
        ? 'off'
        : !connected
          ? 'waiting'
          : !peers.length
            ? 'preview'
            : capable === peers.length && wanted > 0 && Object.keys(observed).length === wanted
              ? 'applied'
              : 'waiting'
    const reason =
      this.#error ??
      (!connected && enabled
        ? 'Waiting for the room connection.'
        : state === 'preview'
          ? 'Local preview only; no egress is running.'
          : state === 'waiting'
            ? capable < peers.length
              ? 'Graphics output unconfirmed: reload older program consumers.'
              : 'Graphics sent; waiting for each output to apply it.'
            : null)
    const status: RoomGraphicsStatus = {
      enabled: !!this.#content,
      state,
      reason,
      revision: this.#revision,
      preview: this.#preview,
      observed,
      productionQualified: false
    }
    const key = JSON.stringify(status)
    if (key !== this.#lastStatus) {
      this.#lastStatus = key
      this.changed(status)
    }
  }
  /**
   * Plan 249 S24: report a view once its page applied exactly what it was
   * sent: the current receipt's lane, this session, the sent revision and an
   * envelope still valid. Only the applied acknowledgement counts, never an
   * upload or the local preview; set/lost/close clear `#sent` first.
   */
  #noteAccepted(
    identity: string,
    graphics: {
      output: 'stream' | 'recording'
      orientation: 'h' | 'v'
      static?: { applied?: { publisherSid: string; revision: number } }
    }
  ): void {
    const ack = graphics.static?.applied
    const localSid = this.room.localParticipant.sid
    if (!this.accepted || !ack || ack.publisherSid !== localSid) return
    const sent = this.#sent.get(identity)
    if (
      !sent ||
      sent.revision !== ack.revision ||
      sent.publisherSid !== localSid ||
      sent.output !== graphics.output ||
      sent.orientation !== graphics.orientation ||
      sent.expiresAt <= Date.now()
    )
      return
    const view = `${sent.output}/${sent.orientation}/${sent.publisherSid}`
    if ((this.#accepted.get(view) ?? 0) >= sent.revision) return
    this.#accepted.set(view, sent.revision)
    if (this.#accepted.size > 64) {
      const oldest = this.#accepted.keys().next().value
      if (oldest !== undefined) this.#accepted.delete(oldest)
    }
    this.accepted({
      output: sent.output,
      orientation: sent.orientation,
      publisherSid: sent.publisherSid,
      revision: sent.revision,
      layers: sent.layers
    })
  }
  #refresh = (): void => {
    if (this.#closed) return
    for (const [identity, receipt] of this.#receipts)
      if (!consumerSid(this.room, identity, receipt, Date.now())) {
        this.#receipts.delete(identity)
        this.#sent.delete(identity)
        this.#assets.forget(identity)
      }
    this.#report()
    if (this.#busy || this.room.state !== ConnectionState.Connected) return
    this.#busy = true
    const generation = this.#generation
    void this.#send(generation)
      .catch(() => {
        if (generation === this.#generation)
          this.#error = 'Graphics delivery failed; output is unconfirmed.'
      })
      .finally(() => {
        this.#busy = false
        this.#report()
      })
  }
  async #send(generation: number): Promise<void> {
    if (!this.#preview || this.#preview.expiresAt - Date.now() < 15_000) this.#makePreview()
    for (const peer of roomConsumers(this.room, this.#receipts, Date.now())) {
      if (this.#closed || generation !== this.#generation) return
      const receipt = this.#receipts.get(peer.identity)
      if (
        !peer.identity.startsWith('EG_') ||
        !capabilityCurrent(receipt, peer.sid, Date.now()) ||
        !receipt?.graphics?.static
      )
        continue
      const { output, orientation } = receipt.graphics
      const content = this.#content
      const layers = graphicsLayers(
        content,
        output,
        orientation,
        receipt.graphics.static.captions === 1
      )
      const key = JSON.stringify([
        peer.sid,
        this.room.localParticipant.sid,
        output,
        orientation,
        layers
      ])
      const old = this.#sent.get(peer.identity)
      if (old?.key === key && Date.now() - old.at < 10_000) continue
      const snapshot = this.#snapshot(output, orientation, layers)
      if (!parseGraphicsSnapshot(snapshot, { ...snapshot, now: Date.now() }))
        throw new Error('Invalid graphics snapshot')
      const held = this.#assets.held(
        peer.identity,
        {
          refs: receipt.graphics.static.refs === 1,
          applied: receipt.graphics.static.applied,
          sid: peer.sid
        },
        this.room.localParticipant.sid
      )
      const bytes = new TextEncoder().encode(JSON.stringify(withReferences(snapshot, held)))
      if (bytes.length > GRAPHICS_MAX_BYTES) throw new Error('Graphics snapshot too large')
      const timeout = AbortSignal.timeout(8000)
      const bounded = <T>(job: Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          const abort = () => reject(new Error('Graphics upload timed out'))
          if (timeout.aborted) {
            abort()
            return
          }
          timeout.addEventListener('abort', abort, { once: true })
          job
            .then(resolve, reject)
            .finally(() => timeout.removeEventListener('abort', abort))
            .catch(() => {})
        })
      const writer = await bounded(
        this.room.localParticipant.streamBytes({
          topic: GRAPHICS_TOPIC,
          mimeType: 'application/json',
          totalSize: bytes.length,
          destinationIdentities: [peer.identity],
          attributes: { empty: String(snapshot.layers.length === 0) }
        })
      )
      for (let i = 0; i < bytes.length; i += 16 * 1024) {
        if (
          this.#closed ||
          generation !== this.#generation ||
          peer.sid !== this.#session(peer.identity)
        ) {
          await bounded(writer.close())
          return
        }
        await bounded(writer.write(bytes.subarray(i, i + 16 * 1024)))
      }
      if (this.#closed || generation !== this.#generation) {
        await bounded(writer.close())
        return
      }
      await bounded(writer.close())
      // Written whole: the page may commit it even if we were fenced since.
      if (peer.sid === this.#session(peer.identity))
        this.#assets.record(peer.identity, peer.sid, snapshot.publisherSid, snapshot)
      if (
        this.#closed ||
        generation !== this.#generation ||
        peer.sid !== this.#session(peer.identity)
      )
        return
      this.#sent.set(peer.identity, {
        key,
        revision: snapshot.revision,
        at: Date.now(),
        layers: snapshot.layers,
        output: snapshot.output,
        orientation: snapshot.orientation,
        publisherSid: snapshot.publisherSid,
        expiresAt: snapshot.expiresAt
      })
      this.#error = this.#content?.unsupported.length ? this.#content.unsupported.join(' ') : null
    }
  }
  /** A visible page that left is gone, not hidden until its receipt expires. */
  #left = (participant?: { identity: string }): void => {
    if (participant) {
      this.#receipts.delete(participant.identity)
      this.#sent.delete(participant.identity)
      this.#assets.forget(participant.identity)
    }
    this.#refresh()
  }
  #session(identity: string): string {
    return consumerSid(this.room, identity, this.#receipts.get(identity), Date.now())
  }
  close(): void {
    this.#closed = true
    this.#generation++
    clearInterval(this.#timer)
    this.room.off(RoomEvent.DataReceived, this.#receive)
    this.room.off(RoomEvent.Reconnecting, this.#lost)
    this.room.off(RoomEvent.Disconnected, this.#lost)
    this.room.off(RoomEvent.ParticipantDisconnected, this.#left)
    this.#content = null
    this.#preview = null
    this.#receipts.clear()
    this.#sent.clear()
    this.#assets.clear()
  }
}
