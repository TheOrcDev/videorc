import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import {
  CAPABILITY_TOPIC,
  capabilityCurrent,
  parseConsumerCapability,
  type CapabilityReceipt,
  CAPABILITY_RECEIPT_MAX_BYTES
} from './room-media-v2'
import {
  AVATAR_TOPIC,
  AVATAR_LEASE_MS,
  AVATAR_MAX_BYTES,
  parseAvatarSnapshot,
  type AvatarLayer,
  type AvatarSnapshot
} from '../../../shared/cloud-avatar'

export type AvatarContent = {
  h: AvatarLayer[]
  v: AvatarLayer[]
  stream: boolean
  recording: boolean
  /**
   * Plan 249 S5: the same picture with the avatar as an atlas layer, sent
   * only to consumers advertising `graphics.animation: 1`; every other
   * consumer keeps the static layers above.
   */
  animated?: { h: AvatarLayer[]; v: AvatarLayer[] }
}
/**
 * Plan 249 S5: whether the worn avatar animates on cloud outputs, with the
 * streamer's reason when it does not everywhere. Absent for a still avatar.
 */
export type RoomAvatarAnimation = {
  state: 'animated' | 'still'
  reason: string | null
}
export type RoomAvatarStatus = {
  enabled: boolean
  state: 'off' | 'preview' | 'waiting' | 'applied' | 'failed'
  reason: string | null
  revision: number
  preview: AvatarSnapshot | null
  observed: Record<
    string,
    { revision: number; output: 'stream' | 'recording'; orientation: 'h' | 'v' }
  >
  /**
   * Plan 249 S6 (D4): the host's per-room opt-in to show the stream's public
   * layers to guest pages, how many guest pages can draw them now, and how
   * many confirmed the latest revision they were sent. Guests never decide
   * the egress `state`.
   */
  guests: { enabled: boolean; capable: number; applied: number }
  productionQualified: false
  animation?: RoomAvatarAnimation
}
/** Plan 249 S24: one output view a program page applied, exactly as sent to it. */
export type AcceptedAvatarView = {
  output: 'stream' | 'recording'
  orientation: 'h' | 'v'
  publisherSid: string
  revision: number
  layers: AvatarLayer[]
}
/** Independently enabled by the existing avatar output switches. Never infers
 * graphic support from S3's auxiliary version. Guests get pixels only after the
 * host opts in (`guests`), only on the guest lane, and only what the stream
 * shows in landscape. */
export class RoomAvatarPublisher {
  #content: AvatarContent | null = null
  #receipts = new Map<string, CapabilityReceipt>()
  /** Per peer: the exact sanitized envelope it was sent (S24 keeps it as sent). */
  #sent = new Map<
    string,
    {
      key: string
      revision: number
      at: number
      layers: AvatarLayer[]
      output: 'stream' | 'recording'
      orientation: 'h' | 'v'
      publisherSid: string
      expiresAt: number
    }
  >()
  /**
   * Plan 249 S24: the highest revision reported as accepted per output view
   * (`output/orientation/publisherSid`). Several program pages may share a
   * view; a late acknowledgement of an older revision never replaces it.
   */
  #accepted = new Map<string, number>()
  #revision = 0
  #generation = 0
  #busy = false
  #closed = false
  #preview: AvatarSnapshot | null = null
  #timer: ReturnType<typeof setInterval> | undefined
  #error: string | null = null
  #lastStatus = ''
  #guests = false
  /** Guest pages that were sent layers, so they are sent one clear. */
  #guestShown = new Set<string>()
  constructor(
    private room: Room,
    private changed: (status: RoomAvatarStatus) => void,
    /** Plan 249 S24: called once per view a program page applied. */
    private accepted?: (view: AcceptedAvatarView) => void
  ) {
    room.on(RoomEvent.DataReceived, this.#receive)
    room.on(RoomEvent.Reconnecting, this.#lost)
    room.on(RoomEvent.Disconnected, this.#lost)
    room.on(RoomEvent.ParticipantDisconnected, this.#refresh)
  }
  set(content: AvatarContent | null): void {
    this.#content = content
    clearInterval(this.#timer)
    this.#timer = content ? setInterval(this.#refresh, 1000) : undefined
    this.#generation++
    this.#sent.clear()
    this.#error = null
    this.#makePreview()
    // Hide is a tiny independent snapshot; it never waits behind an asset
    // writer. The older upload is fenced before its next chunk/trailer.
    if (!content && this.#busy && this.room.state === ConnectionState.Connected) {
      const generation = this.#generation
      void this.#send(generation)
        .catch(() => {
          if (generation === this.#generation) this.#error = 'Avatar clear unconfirmed.'
        })
        .finally(() => this.#report())
    }
    this.#refresh()
  }
  /** The host's guest opt-in. Off sends each guest that saw layers a clear. */
  guests(enabled: boolean): void {
    if (this.#guests === enabled) return
    this.#guests = enabled
    this.#refresh()
  }
  fail(): void {
    this.set(null)
    this.#error = 'Avatar assets unavailable. Nothing was published.'
    this.#report()
  }
  #makePreview(): void {
    const sid = this.room.localParticipant.sid
    const content = this.#content
    this.#preview =
      content && sid
        ? this.#snapshot(
            content.stream ? 'stream' : 'recording',
            'h',
            // Plan 249 S5: the Program preview draws what an animating output draws.
            content.stream || content.recording ? (content.animated?.h ?? content.h) : []
          )
        : null
  }
  #snapshot(
    output: 'stream' | 'recording',
    orientation: 'h' | 'v',
    layers: AvatarLayer[]
  ): AvatarSnapshot {
    const now = Date.now()
    return {
      version: 1,
      show: this.room.name,
      publisherSid: this.room.localParticipant.sid,
      revision: ++this.#revision,
      output,
      orientation,
      expiresAt: now + AVATAR_LEASE_MS - 1000,
      layers: layers
        .filter((l) => l.expiresAt === null || l.expiresAt > now)
        .map((l) => ({
          ...l,
          expiresAt:
            l.expiresAt === null ? null : Math.min(l.expiresAt, now + AVATAR_LEASE_MS - 1000)
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
        !consumerRole(parsed.identity) ||
        !parsed.graphics ||
        !Number.isSafeInteger(raw.at) ||
        !capabilityCurrent(
          { ...parsed, at: raw.at },
          this.room.remoteParticipants.get(parsed.identity)?.sid ?? '',
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
    this.#preview = null
    this.#report()
  }
  #report(): void {
    if (this.#closed) return
    const observed: RoomAvatarStatus['observed'] = {}
    const peers = [...this.room.remoteParticipants.values()].filter((p) =>
      p.identity.startsWith('EG_')
    )
    let capable = 0
    let wanted = 0
    for (const peer of peers) {
      const receipt = this.#receipts.get(peer.identity)
      if (!capabilityCurrent(receipt, peer.sid, Date.now()) || !receipt?.graphics) continue
      capable++
      const visible =
        !!this.#content?.[receipt.graphics.output] &&
        this.#content[receipt.graphics.orientation].some((layer) => layer.kind === 'avatar')
      this.#noteAccepted(peer.identity, receipt.graphics)
      if (!visible) continue
      wanted++
      const ack = receipt.graphics.applied
      const sent = this.#sent.get(peer.identity)
      if (ack?.publisherSid === this.room.localParticipant.sid && ack.revision === sent?.revision)
        observed[peer.identity] = {
          revision: ack.revision,
          output: receipt.graphics.output,
          orientation: receipt.graphics.orientation
        }
    }
    const guests: RoomAvatarStatus['guests'] = { enabled: this.#guests, capable: 0, applied: 0 }
    for (const peer of this.room.remoteParticipants.values()) {
      const receipt = this.#receipts.get(peer.identity)
      if (
        !peer.identity.startsWith('g_') ||
        !capabilityCurrent(receipt, peer.sid, Date.now()) ||
        !receipt?.graphics
      )
        continue
      guests.capable++
      const ack = receipt.graphics.applied
      const sent = this.#sent.get(peer.identity)
      if (
        this.#guestShown.has(peer.identity) &&
        ack?.publisherSid === this.room.localParticipant.sid &&
        ack.revision === sent?.revision
      )
        guests.applied++
    }
    const enabled = !!this.#content && (this.#content.stream || this.#content.recording)
    const connected = this.room.state === ConnectionState.Connected
    const state: RoomAvatarStatus['state'] = this.#error
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
              ? 'Avatar output unconfirmed: reload older program consumers.'
              : 'Avatar sent; waiting for each output to apply it.'
            : null)
    const status: RoomAvatarStatus = {
      enabled: !!this.#content,
      state,
      reason,
      revision: this.#revision,
      preview: this.#preview,
      observed,
      guests,
      productionQualified: false
    }
    const key = JSON.stringify(status)
    if (key !== this.#lastStatus) {
      this.#lastStatus = key
      this.changed(status)
    }
  }
  /**
   * Plan 249 S24: a page applied exactly what was sent to it, a clear too
   * (an empty view, Hide, an output switched off): report that view once,
   * with the envelope it got, for the cloud to keep or to forget. Runs
   * before any visibility check, so a clear always reaches the cloud. Only
   * the applied acknowledgement counts, never an upload or the preview.
   */
  #noteAccepted(
    identity: string,
    graphics: {
      output: 'stream' | 'recording'
      orientation: 'h' | 'v'
      applied?: { publisherSid: string; revision: number }
    }
  ): void {
    const ack = graphics.applied
    const localSid = this.room.localParticipant.sid
    if (!this.accepted || !ack || ack.publisherSid !== localSid) return
    // What this page got: S5 sends the atlas variant only to animation pages.
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
    for (const identity of this.#receipts.keys())
      if (!this.room.remoteParticipants.has(identity)) {
        this.#receipts.delete(identity)
        this.#sent.delete(identity)
      }
    for (const identity of this.#guestShown)
      if (!this.room.remoteParticipants.has(identity)) this.#guestShown.delete(identity)
    this.#report()
    if (this.#busy || this.room.state !== ConnectionState.Connected) return
    this.#busy = true
    const generation = this.#generation
    void this.#send(generation)
      .catch(() => {
        if (generation === this.#generation)
          this.#error = 'Avatar delivery failed; output is unconfirmed.'
      })
      .finally(() => {
        this.#busy = false
        this.#report()
      })
  }
  async #send(generation: number): Promise<void> {
    if (!this.#preview || this.#preview.expiresAt - Date.now() < 15_000) this.#makePreview()
    for (const peer of this.room.remoteParticipants.values()) {
      if (this.#closed || generation !== this.#generation) return
      const receipt = this.#receipts.get(peer.identity)
      const role = consumerRole(peer.identity)
      if (!role || !capabilityCurrent(receipt, peer.sid, Date.now()) || !receipt?.graphics) continue
      const { output, orientation } = receipt.graphics
      const content = this.#content
      const variant =
        receipt.graphics.animation === 1 && content?.animated ? content.animated : content
      // A guest sees the stream's landscape layers, and only while the host
      // shows them to guests; a recording-only avatar never reaches a guest.
      // Guests get no motion stream (egress only), so they draw the still set.
      const layers =
        role === 'guest'
          ? this.#guests && content?.stream
            ? content.h
            : []
          : content?.[output] && variant
            ? variant[orientation]
            : []
      if (role === 'guest' && !layers.length && !this.#guestShown.has(peer.identity)) continue
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
      if (!parseAvatarSnapshot(snapshot, { ...snapshot, now: Date.now() }))
        throw new Error('Invalid avatar snapshot')
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
      if (bytes.length > AVATAR_MAX_BYTES) throw new Error('Avatar snapshot too large')
      const timeout = AbortSignal.timeout(8000)
      const bounded = <T>(job: Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          const abort = () => reject(new Error('Avatar upload timed out'))
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
          topic: AVATAR_TOPIC,
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
          peer.sid !== this.room.remoteParticipants.get(peer.identity)?.sid
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
      if (
        this.#closed ||
        generation !== this.#generation ||
        peer.sid !== this.room.remoteParticipants.get(peer.identity)?.sid
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
      if (role === 'guest') {
        if (snapshot.layers.length) this.#guestShown.add(peer.identity)
        else this.#guestShown.delete(peer.identity)
      }
      this.#error = null
    }
  }
  /**
   * Plan 249 S5: the EG consumers the motion topic may go to now: a current
   * receipt that advertises animation, for an output this content shows,
   * with an atlas variant to draw. Nobody else is sent motion.
   */
  motionTargets(): string[] {
    return this.motionCoverage().animated
  }
  /** Plan 249 S5: who animates the atlas, and how many outputs that show the
   * avatar can only draw it still (a page from before animation). */
  motionCoverage(): { animated: string[]; still: number } {
    const content = this.#content
    const coverage: { animated: string[]; still: number } = { animated: [], still: 0 }
    if (this.#closed || !content?.animated || this.room.state !== ConnectionState.Connected)
      return coverage
    for (const peer of this.room.remoteParticipants.values()) {
      const receipt = this.#receipts.get(peer.identity)
      if (
        !peer.identity.startsWith('EG_') ||
        !capabilityCurrent(receipt, peer.sid, Date.now()) ||
        !receipt?.graphics ||
        !content[receipt.graphics.output]
      )
        continue
      if (receipt.graphics.animation === 1) coverage.animated.push(peer.identity)
      else coverage.still += 1
    }
    return coverage
  }
  close(): void {
    this.#closed = true
    this.#generation++
    clearInterval(this.#timer)
    this.room.off(RoomEvent.DataReceived, this.#receive)
    this.room.off(RoomEvent.Reconnecting, this.#lost)
    this.room.off(RoomEvent.Disconnected, this.#lost)
    this.room.off(RoomEvent.ParticipantDisconnected, this.#refresh)
    this.#content = null
    this.#preview = null
    this.#receipts.clear()
    this.#sent.clear()
    this.#guestShown.clear()
  }
}

/** Who may receive graphics: a program egress, or a guest page (S6, D4). */
function consumerRole(identity: string): 'egress' | 'guest' | null {
  return identity.startsWith('EG_') ? 'egress' : identity.startsWith('g_') ? 'guest' : null
}
