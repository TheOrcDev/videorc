// Plan 253: latency you can see. The contract is
// docs/cloud/253-latency-contract.md; the cases are
// protocol-fixtures/room-latency.json, which videorc-web copies byte for
// byte and holds its own copy of this module to (lib/cloud/program/room-latency.ts).
//
// Pure: no LiveKit import, no clock, no DOM. Three parts:
//
//   1. The `net` block a guest page, a program page and the host each make
//      from their own WebRTC stats (`readNetStats`, `netBlock`).
//   2. Its validation (`parseNetBlock`) and the relay's envelope
//      (`parseLatencyRelay`).
//   3. The model: blocks in, numbers out (`roomLatency`).
//
// D1: every number here is a duration on one machine's own clock. Nothing
// subtracts one machine's wall clock from another's.

/** The room data topic the web relays a `net` block to the host on. */
export const LATENCY_TOPIC = 'videorc.latency.v1'
export const NET_BLOCK_VERSION = 1
/** One sample per sender per 10 s, and no faster (D9). */
export const LATENCY_SAMPLE_MS = 10_000
/**
 * The web relays a sender's block only this long after its last relayed one:
 * one per sample. It is the sample period less a second, because two
 * requests sent 10 s apart can arrive a little closer than that.
 */
export const LATENCY_RELAY_MIN_INTERVAL_MS = 9_000
/** A block is current this long after it arrived; then its numbers go away. */
export const LATENCY_TTL_MS = 25_000
/** Capture, one 20 ms Opus frame, packetizing. No stat exists for it. */
export const SEND_AUDIO_MS = 40
/** Forwarding inside one LiveKit region. */
export const SFU_MS = 5
/** The program page's draw: two frames at 60 fps (its double rAF). */
export const PAGE_DRAW_MS = 33
/** Every duration in a block is whole milliseconds, 0 to this. */
export const NET_MAX_MS = 60_000
export const NET_MIN_WINDOW_MS = 1_000
export const NET_MAX_SENDERS = 8
export const NET_IDENTITY_MAX_CHARS = 128
/** The largest relayed message the host reads. */
export const LATENCY_RELAY_MAX_BYTES = 4096
/** A program page's room identity (LiveKit's egress participant). */
export const PROGRAM_PAGE_IDENTITY_PREFIX = 'EG_'

export type NetSender = {
  identity: string
  /** The audio jitter buffer's mean delay over the window. */
  audioMs?: number
  /** First packet received to decoded, the mean over the window. */
  videoMs?: number
}

/** What one participant measured over one window. Durations only (D1). */
export type NetBlock = {
  v: typeof NET_BLOCK_VERSION
  windowMs: number
  /** Round trip to its LiveKit edge. */
  rttMs?: number
  /** Audio playout after the jitter buffer. Chromium only. */
  playoutMs?: number
  /** A part is missing, so a figure built on this block is a floor. */
  partial?: boolean
  send?: { videoMs?: number }
  from?: NetSender[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= NET_MAX_MS
}

/**
 * A `net` block as the contract allows it, or null. Unknown keys are left
 * out, never kept; one known key with a bad value refuses the whole block.
 * The result is rebuilt field by field: what is relayed or computed on is
 * never the sender's own object.
 */
export function parseNetBlock(value: unknown): NetBlock | null {
  if (!isRecord(value) || value.v !== NET_BLOCK_VERSION) return null
  const { windowMs, rttMs, playoutMs, partial, send, from } = value
  if (!isMs(windowMs) || windowMs < NET_MIN_WINDOW_MS) return null
  if (rttMs !== undefined && !isMs(rttMs)) return null
  if (playoutMs !== undefined && !isMs(playoutMs)) return null
  if (partial !== undefined && typeof partial !== 'boolean') return null
  let sendVideoMs: number | undefined
  if (send !== undefined) {
    if (!isRecord(send)) return null
    if (send.videoMs !== undefined && !isMs(send.videoMs)) return null
    sendVideoMs = send.videoMs as number | undefined
  }
  let senders: NetSender[] | undefined
  if (from !== undefined) {
    if (!Array.isArray(from) || from.length > NET_MAX_SENDERS) return null
    senders = []
    const seen = new Set<string>()
    for (const item of from) {
      if (!isRecord(item)) return null
      const { identity, audioMs, videoMs } = item
      if (
        typeof identity !== 'string' ||
        identity.length === 0 ||
        identity.length > NET_IDENTITY_MAX_CHARS ||
        seen.has(identity) ||
        (audioMs !== undefined && !isMs(audioMs)) ||
        (videoMs !== undefined && !isMs(videoMs))
      )
        return null
      seen.add(identity)
      senders.push({
        identity,
        ...(audioMs === undefined ? {} : { audioMs: audioMs as number }),
        ...(videoMs === undefined ? {} : { videoMs: videoMs as number })
      })
    }
  }
  return {
    v: NET_BLOCK_VERSION,
    windowMs,
    ...(rttMs === undefined ? {} : { rttMs }),
    ...(playoutMs === undefined ? {} : { playoutMs }),
    ...(partial === undefined ? {} : { partial }),
    ...(sendVideoMs === undefined ? {} : { send: { videoMs: sendVideoMs } }),
    ...(senders === undefined ? {} : { from: senders })
  }
}

/** What the web sends the host: a checked block, who it is from, and when. */
export type LatencyRelay = {
  v: 1
  /** From the guest's session or the page's token, never from a body. */
  identity: string
  /** The web's receive time. For the record only: never subtracted (D1). */
  at: number
  net: NetBlock
}

export function parseLatencyRelay(value: unknown): LatencyRelay | null {
  if (!isRecord(value) || value.v !== 1) return null
  const { identity, at } = value
  if (
    typeof identity !== 'string' ||
    identity.length === 0 ||
    identity.length > NET_IDENTITY_MAX_CHARS ||
    typeof at !== 'number' ||
    !Number.isFinite(at) ||
    at < 0
  )
    return null
  const net = parseNetBlock(value.net)
  return net ? { v: 1, identity, at, net } : null
}

// --- The sampler's arithmetic ------------------------------------------------

/** One entry of an `RTCStatsReport`, as `report.forEach` hands it over. */
export type StatsEntry = Record<string, unknown>

/** One track's stats report, and whose track it is. */
export type NetStatsSource =
  /** A remote camera or microphone track's receiver report. */
  | { direction: 'in'; identity: string; kind: 'audio' | 'video'; entries: StatsEntry[] }
  /** This participant's own published camera or microphone sender report. */
  | { direction: 'out'; kind: 'audio' | 'video'; entries: StatsEntry[] }

type Ratio = { total: number; count: number }

/** Session totals at one moment. Only two of them make a number. */
export type NetReading = {
  /** Seconds. The one stat that is already "now", not a total. */
  rtt?: number
  playout?: Ratio
  encode?: Ratio
  packetSend?: Ratio
  framesPerSecond?: number
  from: Record<string, { audio?: Ratio; video?: Ratio }>
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function ratio(total: unknown, count: unknown): Ratio | undefined {
  const t = finite(total)
  const c = finite(count)
  return t === undefined || c === undefined ? undefined : { total: t, count: c }
}

function add(a: Ratio | undefined, b: Ratio | undefined): Ratio | undefined {
  if (!a) return b
  if (!b) return a
  return { total: a.total + b.total, count: a.count + b.count }
}

/**
 * The selected candidate pair's round trip, in seconds. It reads
 * `transport` and `candidate-pair` entries only: never `local-candidate` or
 * `remote-candidate`, which hold addresses (D12).
 */
function selectedPairRtt(entries: StatsEntry[]): number | undefined {
  let selectedId: unknown
  for (const entry of entries)
    if (entry.type === 'transport' && typeof entry.selectedCandidatePairId === 'string')
      selectedId = entry.selectedCandidatePairId
  let nominated: number | undefined
  for (const entry of entries) {
    if (entry.type !== 'candidate-pair') continue
    const rtt = finite(entry.currentRoundTripTime)
    if (rtt === undefined) continue
    if (selectedId !== undefined && entry.id === selectedId) return rtt
    if (entry.nominated === true && entry.state === 'succeeded') nominated ??= rtt
  }
  return nominated
}

/**
 * Session totals from the stats reports of one moment. `sources` are the
 * camera and microphone tracks only (a shared screen is not conversation).
 * At most NET_MAX_SENDERS senders are kept, in the order given: put the one
 * that matters first.
 */
export function readNetStats(sources: NetStatsSource[]): NetReading {
  // Each is set only once known: an absent key, never `undefined` (the
  // web's copy compiles under exactOptionalPropertyTypes).
  const reading: NetReading = { from: {} }
  let rtt: number | undefined
  let fallbackRtt: number | undefined
  let playout: Ratio | undefined
  let encode: Ratio | undefined
  let packetSend: Ratio | undefined
  let framesPerSecond: number | undefined
  for (const source of sources) {
    rtt ??= selectedPairRtt(source.entries)
    for (const entry of source.entries) {
      if (source.direction === 'out') {
        if (entry.type === 'remote-inbound-rtp') fallbackRtt ??= finite(entry.roundTripTime)
        if (entry.type !== 'outbound-rtp' || source.kind !== 'video') continue
        // Simulcast: one entry per layer. The mean is over all of them.
        encode = add(encode, ratio(entry.totalEncodeTime, entry.framesEncoded))
        packetSend = add(packetSend, ratio(entry.totalPacketSendDelay, entry.packetsSent))
        const fps = finite(entry.framesPerSecond)
        if (fps !== undefined && fps > 0) framesPerSecond = Math.max(framesPerSecond ?? 0, fps)
        continue
      }
      if (entry.type === 'media-playout') {
        playout ??= ratio(entry.totalPlayoutDelay, entry.totalSamplesCount)
        continue
      }
      if (entry.type !== 'inbound-rtp') continue
      const known = reading.from[source.identity]
      if (!known && Object.keys(reading.from).length >= NET_MAX_SENDERS) continue
      const sender = known ?? (reading.from[source.identity] = {})
      if (source.kind === 'audio') {
        const audio = add(
          sender.audio,
          ratio(entry.jitterBufferDelay, entry.jitterBufferEmittedCount)
        )
        if (audio) sender.audio = audio
      } else {
        const video = add(sender.video, ratio(entry.totalProcessingDelay, entry.framesDecoded))
        if (video) sender.video = video
      }
    }
  }
  rtt ??= fallbackRtt
  if (rtt !== undefined) reading.rtt = rtt
  if (playout) reading.playout = playout
  if (encode) reading.encode = encode
  if (packetSend) reading.packetSend = packetSend
  if (framesPerSecond !== undefined) reading.framesPerSecond = framesPerSecond
  return reading
}

function clampMs(ms: number): number {
  return Math.min(NET_MAX_MS, Math.max(0, Math.round(ms)))
}

/** The mean over the window in ms: Δtotal / Δcount. Never a session mean. */
function meanOf(before: Ratio | undefined, after: Ratio | undefined): number | undefined {
  if (!before || !after) return undefined
  const count = after.count - before.count
  const total = after.total - before.total
  if (!(count > 0) || total < 0) return undefined
  return (total / count) * 1000
}

function meanMs(before: Ratio | undefined, after: Ratio | undefined): number | undefined {
  const mean = meanOf(before, after)
  return mean === undefined ? undefined : clampMs(mean)
}

/**
 * The block for one window, from the readings at its two ends. Null when
 * there is no earlier reading (one reading alone holds only session totals),
 * and when the window is under a second or over a minute (a page that slept
 * did not measure that minute).
 */
export function netBlock(
  before: NetReading | null,
  after: NetReading,
  windowMs: number
): NetBlock | null {
  if (
    !before ||
    !Number.isFinite(windowMs) ||
    windowMs < NET_MIN_WINDOW_MS ||
    windowMs > NET_MAX_MS
  )
    return null
  const playoutMs = meanMs(before.playout, after.playout)
  // Rounded once, as a sum: three rounded parts could be 1 ms off.
  const encodeMs = meanOf(before.encode, after.encode)
  const packetSendMs = meanOf(before.packetSend, after.packetSend)
  const from: NetSender[] = []
  let hears = false
  for (const [identity, now] of Object.entries(after.from)) {
    const then = before.from[identity]
    const audioMs = meanMs(then?.audio, now.audio)
    const videoMs = meanMs(then?.video, now.video)
    if (audioMs === undefined && videoMs === undefined) continue
    if (audioMs !== undefined) hears = true
    from.push({
      identity,
      ...(audioMs === undefined ? {} : { audioMs }),
      ...(videoMs === undefined ? {} : { videoMs })
    })
  }
  // Encode, the pacer's queue, and half a frame of waiting for the next one.
  const sendVideoMs =
    encodeMs === undefined
      ? undefined
      : clampMs(encodeMs + (packetSendMs ?? 0) + 500 / (after.framesPerSecond ?? 30))
  return {
    v: NET_BLOCK_VERSION,
    windowMs: clampMs(windowMs),
    ...(after.rtt === undefined ? {} : { rttMs: clampMs(after.rtt * 1000) }),
    ...(playoutMs === undefined ? {} : { playoutMs }),
    // Sound was received and its playout is unknown: a floor, said so.
    partial: hears && playoutMs === undefined,
    ...(sendVideoMs === undefined ? {} : { send: { videoMs: sendVideoMs } }),
    ...(from.length > 0 ? { from } : {})
  }
}

/** What the sampler needs of a LiveKit track: its sender's or receiver's stats. */
export type NetStatsTrack = {
  getRTCStatsReport?: () => Promise<
    { forEach(visit: (entry: StatsEntry) => void): void } | undefined
  >
}

/** A camera or microphone track to sample: a remote one by its sender, or this participant's own. */
export type NetTrack =
  | { direction: 'in'; identity: string; kind: 'audio' | 'video'; track: NetStatsTrack }
  | { direction: 'out'; kind: 'audio' | 'video'; track: NetStatsTrack }

/**
 * One participant's sampler: call `sample` once per LATENCY_SAMPLE_MS with
 * the tracks of that moment, and send what it returns. It keeps the last
 * reading, so every block is a delta over the time between two calls.
 * `now` is a monotonic clock in ms (`performance.now()`), never a wall clock.
 */
export class NetSampler {
  readonly #now: () => number
  #last: { reading: NetReading; at: number } | null = null

  constructor(now: () => number) {
    this.#now = now
  }

  /** Forget the last reading: the connection was replaced, its counters restart. */
  reset(): void {
    this.#last = null
  }

  /** Null for the first call, after `reset`, and when the window is unusable. */
  async sample(tracks: NetTrack[]): Promise<NetBlock | null> {
    const at = this.#now()
    const sources: NetStatsSource[] = []
    await Promise.all(
      tracks.map(async (item, index) => {
        const entries: StatsEntry[] = []
        try {
          const report = await item.track.getRTCStatsReport?.()
          report?.forEach((entry) => entries.push(entry))
        } catch {
          // A track that went away mid-sample gives no part.
        }
        const { track: _track, ...source } = item
        sources[index] = { ...source, entries }
      })
    )
    const reading = readNetStats(sources)
    const last = this.#last
    this.#last = { reading, at }
    return netBlock(last?.reading ?? null, reading, at - (last?.at ?? at))
  }
}

// --- The model: blocks in, numbers out ----------------------------------------

/** A block and when its holder got it, on the holder's own clock. */
export type HeldNetBlock = { identity: string; block: NetBlock; atMs: number }

export type PathDelay = { ms: number; partial: boolean }

/** N1 for one guest. `ms` is the row's number: the worse direction. */
export type ConversationDelay = {
  ms: number
  /** A part or a direction is missing: the number is a floor. */
  partial: boolean
  /** Host's mouth to the guest's ear. Null: not measurable now. */
  toGuestMs: number | null
  /** Guest's mouth to the host's ear. */
  fromGuestMs: number | null
  /** Camera to decoded picture, for the record. Never on the row. */
  video?: { toGuestMs?: number; fromGuestMs?: number }
}

/** N2. `ms` is the picture: the host's camera to the page having drawn it. */
export type ProgramDelay = {
  ms: number
  /** The host's microphone to the page's mix, for the record. */
  audioMs: number | null
}

export type RoomLatency = {
  /** The host's own round trip to the room. */
  hostRttMs?: number
  people: Record<string, ConversationDelay>
  program?: ProgramDelay
}

export function isProgramPageIdentity(identity: string): boolean {
  return identity.startsWith(PROGRAM_PAGE_IDENTITY_PREFIX)
}

/** Current for LATENCY_TTL_MS after it arrived, and never from the future. */
export function latencyFresh(atMs: number, nowMs: number): boolean {
  return nowMs >= atMs && nowMs - atMs <= LATENCY_TTL_MS
}

function senderOf(block: NetBlock, identity: string): NetSender | undefined {
  return block.from?.find((sender) => sender.identity === identity)
}

/**
 * D2, sound: `send + rtt(S)/2 + sfu + rtt(R)/2 + buffer(R, S) + playout(R)`.
 * Null without both round trips and the receiver's buffer for this sender.
 */
export function audioPathDelay(
  sender: NetBlock,
  senderIdentity: string,
  receiver: NetBlock
): PathDelay | null {
  const buffer = senderOf(receiver, senderIdentity)?.audioMs
  if (sender.rttMs === undefined || receiver.rttMs === undefined || buffer === undefined)
    return null
  return {
    ms: Math.round(
      SEND_AUDIO_MS +
        sender.rttMs / 2 +
        SFU_MS +
        receiver.rttMs / 2 +
        buffer +
        (receiver.playoutMs ?? 0)
    ),
    partial: receiver.playoutMs === undefined || receiver.partial === true
  }
}

/** D2, picture: the sender's measured send time, and no playout part. */
export function videoPathDelay(
  sender: NetBlock,
  senderIdentity: string,
  receiver: NetBlock
): number | null {
  const buffer = senderOf(receiver, senderIdentity)?.videoMs
  const send = sender.send?.videoMs
  if (
    sender.rttMs === undefined ||
    receiver.rttMs === undefined ||
    buffer === undefined ||
    send === undefined
  )
    return null
  return Math.round(send + sender.rttMs / 2 + SFU_MS + receiver.rttMs / 2 + buffer)
}

export function conversationDelay(
  host: { identity: string; block: NetBlock },
  guest: { identity: string; block: NetBlock }
): ConversationDelay | null {
  const toGuest = audioPathDelay(host.block, host.identity, guest.block)
  const fromGuest = audioPathDelay(guest.block, guest.identity, host.block)
  if (!toGuest && !fromGuest) return null
  const videoTo = videoPathDelay(host.block, host.identity, guest.block)
  const videoFrom = videoPathDelay(guest.block, guest.identity, host.block)
  return {
    ms: Math.max(toGuest?.ms ?? 0, fromGuest?.ms ?? 0),
    partial: !toGuest || !fromGuest || toGuest.partial || fromGuest.partial,
    toGuestMs: toGuest?.ms ?? null,
    fromGuestMs: fromGuest?.ms ?? null,
    ...(videoTo === null && videoFrom === null
      ? {}
      : {
          video: {
            ...(videoTo === null ? {} : { toGuestMs: videoTo }),
            ...(videoFrom === null ? {} : { fromGuestMs: videoFrom })
          }
        })
  }
}

/** Null without the picture's path: the chip is about the picture. */
export function programDelay(
  host: { identity: string; block: NetBlock },
  page: NetBlock
): ProgramDelay | null {
  const video = videoPathDelay(host.block, host.identity, page)
  if (video === null) return null
  const audio = audioPathDelay(host.block, host.identity, page)
  return { ms: video + PAGE_DRAW_MS, audioMs: audio?.ms ?? null }
}

/**
 * Everything the host knows now. A stale block gives no number, and without
 * the host's own fresh block there are none at all. With several program
 * pages the slowest one is the program's.
 */
export function roomLatency(input: {
  nowMs: number
  host: HeldNetBlock | null
  reports: HeldNetBlock[]
}): RoomLatency {
  const { nowMs, host } = input
  const latency: RoomLatency = { people: {} }
  if (!host || !latencyFresh(host.atMs, nowMs)) return latency
  if (host.block.rttMs !== undefined) latency.hostRttMs = host.block.rttMs
  for (const report of input.reports) {
    if (report.identity === host.identity || !latencyFresh(report.atMs, nowMs)) continue
    if (isProgramPageIdentity(report.identity)) {
      const program = programDelay(host, report.block)
      if (program && (!latency.program || program.ms > latency.program.ms))
        latency.program = program
      continue
    }
    const delay = conversationDelay(host, report)
    if (delay) latency.people[report.identity] = delay
  }
  return latency
}
