import { roomAudioRouting } from './room-audio-routing'
import { AUDIO_ROUTING_TOPIC } from '../../../shared/program-audio-routing'
import { isHtmlLayerTrackName } from '../../../shared/cloud-html-layer'
import { ConnectionState, LocalAudioTrack, RoomEvent, Track, type Room } from 'livekit-client'
import {
  AUX_TRACK_NAME,
  CAPABILITY_TOPIC,
  capabilityCurrent,
  consumerSid,
  parseConsumerCapability,
  roomConsumers,
  type CapabilityReceipt,
  CAPABILITY_RECEIPT_MAX_BYTES
} from './room-media-v2'
import { createRoomAuxSink } from './room-aux-sink'
import { soundboard, type RoomAuxStatus } from './soundboard-store'

export function auxiliaryBlockedReason(
  enabled: boolean,
  connected: boolean,
  consumers: readonly { identity: string; sid: string }[],
  receipts: ReadonlyMap<string, CapabilityReceipt>,
  now: number
): string | null {
  if (!enabled)
    return 'Room sounds are off. Enable for this room to try the unqualified audio path.'
  if (!connected) return 'Waiting for the room connection.'
  if (!consumers.length) return 'Waiting for a capable program or guest consumer.'
  if (consumers.some((p) => !capabilityCurrent(receipts.get(p.identity), p.sid, now)))
    return 'Room sounds paused: every active program and guest must support media v2. Reload or rejoin older pages.'
  return null
}

/** One sink and publication per room. Unknown/new sessions never receive aux. */
export class RoomAuxPublisher {
  #receipts = new Map<string, CapabilityReceipt>()
  #track: LocalAudioTrack | null = null
  #sink: ReturnType<typeof createRoomAuxSink> | null = null
  #sid: string | null = null
  #epoch = 0
  #retiring: Promise<unknown> = Promise.resolve()
  #busy = false
  #closed = false
  #error: string | null = null
  #off: () => void
  #routingOff: () => void
  #routingSequence = 0
  #routingBusy = false
  #routingLastSent = 0
  #timer: ReturnType<typeof setInterval> | null = null
  get enabled(): boolean {
    return soundboard.getSnapshot().roomAux?.enabled === true
  }
  constructor(
    private room: Room,
    enabled = false
  ) {
    roomAudioRouting.disarmSystem()
    soundboard.setRoomAux({
      enabled,
      state: 'off',
      reason: null,
      queuedVoices: [],
      trackSid: null,
      observed: {},
      productionQualified: false
    })
    this.#off = soundboard.subscribe(() => this.refresh())
    this.#routingOff = roomAudioRouting.subscribe(this.refresh)
    room.on(RoomEvent.DataReceived, this.#receive)
    room.on(RoomEvent.ParticipantConnected, this.refresh)
    room.on(RoomEvent.ParticipantDisconnected, this.#left)
    room.on(RoomEvent.LocalTrackPublished, this.refresh)
    room.on(RoomEvent.LocalTrackUnpublished, this.refresh)
    room.on(RoomEvent.Reconnecting, this.#lost)
    room.on(RoomEvent.Disconnected, this.#lost)
    room.on(RoomEvent.Reconnected, this.refresh)
    this.refresh()
  }
  #receive = (bytes: Uint8Array, participant?: unknown, _kind?: unknown, topic?: string): void => {
    if (participant || topic !== CAPABILITY_TOPIC || bytes.length > CAPABILITY_RECEIPT_MAX_BYTES)
      return
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes))
      const capability = parseConsumerCapability(value)
      const now = Date.now()
      if (
        !capability ||
        typeof value.at !== 'number' ||
        !Number.isFinite(value.at) ||
        value.at > now + 1000 ||
        now - value.at >= 25_000 ||
        consumerSid(this.room, capability.identity, { ...capability, at: value.at }, now) !==
          capability.participantSid
      )
        return
      const old = this.#receipts.get(capability.identity)
      if (old && old.at >= value.at) return
      this.#receipts.set(capability.identity, { ...capability, at: value.at })
      this.refresh()
    } catch {
      /* No confirmation from malformed or participant-originated data. */
    }
  }
  /** A visible page that left is gone, not hidden until its receipt expires. */
  #left = (participant?: { identity: string }): void => {
    if (participant) this.#receipts.delete(participant.identity)
    this.refresh()
  }
  #lost = (): void => {
    roomAudioRouting.disarmSystem()
    this.#receipts.clear()
    this.#stop()
    this.refresh()
  }
  #permissions(): void {
    const now = Date.now()
    const local = [...this.room.localParticipant.trackPublications.values()]
    const base = local
      .filter((p) => p.trackName !== AUX_TRACK_NAME && !isHtmlLayerTrackName(p.trackName))
      .map((p) => p.trackSid)
    const legacySilenced = (identity: string): boolean =>
      identity.startsWith('EG_') &&
      roomAudioRouting.getSnapshot().takeover &&
      (!capabilityCurrent(
        this.#receipts.get(identity),
        consumerSid(this.room, identity, this.#receipts.get(identity), now),
        now
      ) ||
        this.#receipts.get(identity)?.audioRouting !== 1)
    const speechSids = new Set(
      [...this.room.localParticipant.trackPublications.values()]
        .filter((p) => p.kind === Track.Kind.Audio)
        .map((p) => p.trackSid)
    )
    // Plan 249 S11: an HTML layer sheet is for egress (program) pages only.
    const sheets = local.filter((p) => isHtmlLayerTrackName(p.trackName)).map((p) => p.trackSid)
    // SID scope prevents a replacement/old page inheriting another session's consent.
    this.room.localParticipant.setTrackSubscriptionPermissions(
      false,
      roomConsumers(this.room, this.#receipts, now).map((p) => ({
        participantSid: p.sid,
        allowAll: false,
        allowedTrackSids: [
          ...base.filter((sid) => !legacySilenced(p.identity) || !speechSids.has(sid)),
          ...(p.identity.startsWith('EG_') ? sheets : []),
          ...(this.#sid &&
          !legacySilenced(p.identity) &&
          capabilityCurrent(this.#receipts.get(p.identity), p.sid, now)
            ? [this.#sid]
            : [])
        ]
      }))
    )
  }
  #stop(): void {
    ++this.#epoch
    const track = this.#track
    this.#track = null
    this.#sid = null
    track?.stop()
    const sink = this.#sink
    // Close synchronously fences capture before pending connect/grant work.
    const closing = sink?.close()
    if (closing) this.#retiring = Promise.all([this.#retiring, closing]).then(() => {})
    this.#sink = null
    if (track)
      this.#retiring = this.#retiring.then(() =>
        this.room.localParticipant.unpublishTrack(track, true).catch(() => {})
      )
    void this.#retiring.catch(() => {})
  }
  refresh = (): void => {
    if (this.#closed) return
    const snapshot = soundboard.getSnapshot()
    const enabled =
      snapshot.roomAux?.enabled === true || roomAudioRouting.getSnapshot().system.enabled
    // The 1 s pulse runs only while something needs it: a source to publish,
    // or a routing-capable program page whose 3 s lease must be renewed.
    const pulse = enabled || this.#routingTargets(Date.now()).length > 0
    if (pulse && this.#timer === null) this.#timer = setInterval(this.refresh, 1000)
    if (!pulse && this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    if (!enabled) {
      this.#error = null
    }
    const consumers = roomConsumers(this.room, this.#receipts, Date.now())
    // A legacy runner is intentionally incompatible, too.
    const reason =
      this.#error ??
      auxiliaryBlockedReason(
        enabled,
        this.room.state === ConnectionState.Connected,
        consumers,
        this.#receipts,
        Date.now()
      )
    if (reason && (this.#track || this.#sink || this.#busy)) this.#stop()
    this.#permissions()
    this.#sendRouting()
    if (!reason && !this.#track && !this.#busy) {
      this.#busy = true
      const epoch = ++this.#epoch
      void this.#start(epoch).finally(() => {
        this.#busy = false
        this.refresh()
      })
    }
    if (!reason && this.#sid) this.#sink?.update(snapshot)
    const observed: Record<string, number> = {}
    for (const p of consumers) {
      const receipt = this.#receipts.get(p.identity)
      const a = receipt?.auxiliary
      if (
        a &&
        a.trackSid === this.#sid &&
        capabilityCurrent(receipt, p.sid, Date.now()) &&
        a.observedAt <= Date.now() + 1000 &&
        Date.now() - a.observedAt < 5000
      )
        observed[p.identity] = a.observedAt
    }
    const status: RoomAuxStatus = {
      enabled: snapshot.roomAux?.enabled === true,
      state: !enabled ? 'off' : reason ? 'blocked' : this.#sid ? 'published' : 'queued',
      reason: reason ?? this.#sink?.problem() ?? null,
      queuedVoices: this.#sink?.queued() ?? [],
      trackSid: this.#sid,
      observed,
      productionQualified: false
    }
    soundboard.setRoomAux(status)
  }
  /** Program pages that negotiated deliberate routing and are current now. */
  #routingTargets(now: number): string[] {
    return roomConsumers(this.room, this.#receipts, now)
      .filter(
        (p) =>
          p.identity.startsWith('EG_') &&
          capabilityCurrent(this.#receipts.get(p.identity), p.sid, now) &&
          this.#receipts.get(p.identity)?.audioRouting === 1
      )
      .map((p) => p.identity)
  }
  #sendRouting(): void {
    if (this.#routingBusy || this.room.state !== ConnectionState.Connected) return
    const now = Date.now()
    if (now - this.#routingLastSent < 250) return
    const targets = this.#routingTargets(now)
    if (!targets.length) return
    this.#routingLastSent = now
    this.#routingBusy = true
    const packet = {
      v: 1,
      show: this.room.name,
      publisherSid: this.room.localParticipant.sid,
      sequence: ++this.#routingSequence,
      sentAt: now,
      ...roomAudioRouting.getSnapshot().program
    }
    void this.room.localParticipant
      .publishData(new TextEncoder().encode(JSON.stringify(packet)), {
        reliable: true,
        topic: AUDIO_ROUTING_TOPIC,
        destinationIdentities: targets
      })
      .catch(() => {})
      .finally(() => {
        this.#routingBusy = false
      })
  }
  async #start(epoch: number): Promise<void> {
    try {
      await this.#retiring
      if (this.#closed || epoch !== this.#epoch) return
      const sink = createRoomAuxSink(soundboard.getSnapshot(), this.room.name)
      this.#sink = sink
      const track = new LocalAudioTrack(sink.track, undefined, true)
      this.#track = track
      const publication = await this.room.localParticipant.publishTrack(track, {
        name: AUX_TRACK_NAME,
        source: Track.Source.ScreenShareAudio,
        forceStereo: true,
        dtx: false,
        red: true,
        audioPreset: { maxBitrate: 128_000 }
      })
      if (this.#closed || epoch !== this.#epoch) {
        track.stop()
        sink.close()
        await this.room.localParticipant.unpublishTrack(track, true).catch(() => {})
        return
      }
      this.#sid = publication.trackSid
      this.#permissions()
    } catch {
      if (epoch === this.#epoch) {
        this.#error = 'Room sounds could not publish. Turn room sounds off and on to retry.'
        this.#stop()
      }
    }
  }
  close(): void {
    this.#closed = true
    this.#off()
    this.#routingOff()
    roomAudioRouting.disarmSystem()
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    this.room.off(RoomEvent.DataReceived, this.#receive)
    this.room.off(RoomEvent.ParticipantConnected, this.refresh)
    this.room.off(RoomEvent.ParticipantDisconnected, this.#left)
    this.room.off(RoomEvent.LocalTrackPublished, this.refresh)
    this.room.off(RoomEvent.LocalTrackUnpublished, this.refresh)
    this.room.off(RoomEvent.Reconnecting, this.#lost)
    this.room.off(RoomEvent.Disconnected, this.#lost)
    this.room.off(RoomEvent.Reconnected, this.refresh)
    this.#stop()
    soundboard.setRoomAux(undefined)
  }
}
