import { ConnectionState, LocalAudioTrack, RoomEvent, Track, type Room } from 'livekit-client'
import {
  AUX_TRACK_NAME,
  CAPABILITY_TOPIC,
  capabilityCurrent,
  parseConsumerCapability,
  type CapabilityReceipt
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
  #timer: ReturnType<typeof setInterval> | null = null
  get enabled(): boolean {
    return soundboard.getSnapshot().roomAux?.enabled === true
  }
  constructor(
    private room: Room,
    enabled = false
  ) {
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
    room.on(RoomEvent.DataReceived, this.#receive)
    room.on(RoomEvent.ParticipantConnected, this.refresh)
    room.on(RoomEvent.ParticipantDisconnected, this.refresh)
    room.on(RoomEvent.LocalTrackPublished, this.refresh)
    room.on(RoomEvent.LocalTrackUnpublished, this.refresh)
    room.on(RoomEvent.Reconnecting, this.#lost)
    room.on(RoomEvent.Disconnected, this.#lost)
    room.on(RoomEvent.Reconnected, this.refresh)
    this.refresh()
  }
  #receive = (bytes: Uint8Array, participant?: unknown, _kind?: unknown, topic?: string): void => {
    if (participant || topic !== CAPABILITY_TOPIC || bytes.length > 1024) return
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
        this.room.remoteParticipants.get(capability.identity)?.sid !== capability.participantSid
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
  #lost = (): void => {
    this.#receipts.clear()
    this.#stop()
    this.refresh()
  }
  #permissions(): void {
    const now = Date.now()
    const base = [...this.room.localParticipant.trackPublications.values()]
      .filter((p) => p.trackName !== AUX_TRACK_NAME)
      .map((p) => p.trackSid)
    // SID scope prevents a replacement/old page inheriting another session's consent.
    this.room.localParticipant.setTrackSubscriptionPermissions(
      false,
      [...this.room.remoteParticipants.values()].map((p) => ({
        participantSid: p.sid,
        allowAll: false,
        allowedTrackSids: [
          ...base,
          ...(this.#sid && capabilityCurrent(this.#receipts.get(p.identity), p.sid, now)
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
    this.#sink?.close()
    this.#sink = null
    if (track)
      this.#retiring = this.#retiring.then(() =>
        this.room.localParticipant.unpublishTrack(track, true).catch(() => {})
      )
  }
  refresh = (): void => {
    if (this.#closed) return
    const snapshot = soundboard.getSnapshot()
    const enabled = snapshot.roomAux?.enabled === true
    if (enabled && this.#timer === null) this.#timer = setInterval(this.refresh, 1000)
    if (!enabled) {
      this.#error = null
      if (this.#timer !== null) clearInterval(this.#timer)
      this.#timer = null
    }
    const consumers = [...this.room.remoteParticipants.values()]
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
      enabled,
      state: !enabled ? 'off' : reason ? 'blocked' : this.#sid ? 'published' : 'queued',
      reason: reason ?? this.#sink?.problem() ?? null,
      queuedVoices: this.#sink?.queued() ?? [],
      trackSid: this.#sid,
      observed,
      productionQualified: false
    }
    soundboard.setRoomAux(status)
  }
  async #start(epoch: number): Promise<void> {
    try {
      await this.#retiring
      if (this.#closed || epoch !== this.#epoch) return
      const sink = createRoomAuxSink(soundboard.getSnapshot())
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
    if (this.#timer !== null) clearInterval(this.#timer)
    this.room.off(RoomEvent.DataReceived, this.#receive)
    this.room.off(RoomEvent.ParticipantConnected, this.refresh)
    this.room.off(RoomEvent.ParticipantDisconnected, this.refresh)
    this.room.off(RoomEvent.LocalTrackPublished, this.refresh)
    this.room.off(RoomEvent.LocalTrackUnpublished, this.refresh)
    this.room.off(RoomEvent.Reconnecting, this.#lost)
    this.room.off(RoomEvent.Disconnected, this.#lost)
    this.room.off(RoomEvent.Reconnected, this.refresh)
    this.#stop()
    soundboard.setRoomAux(undefined)
  }
}
