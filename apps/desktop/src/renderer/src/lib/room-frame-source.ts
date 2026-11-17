import { registerRoomFrameResources } from './room-frame-test-state'
import {
  ROOM_FRAME,
  isRoomFrame,
  nativeCaptureUs,
  parseRoomFrameReply,
  roomFrameCommand,
  type RoomFrameCommand,
  type RoomFrameOpened,
  type RoomFrameRelease,
  type RoomFrameReply
} from '../../../shared/room-frame'

/**
 * Plan 249 S13a: native camera-role frames into browser encoding.
 *
 * Each leased native frame becomes one `VideoFrame` whose timestamp is the
 * native `ptsUs`, written into a `MediaStreamTrackGenerator`. There is no
 * canvas/captureStream fallback (it would discard the native timestamp) and
 * no raw camera fallback: an unsupported runtime refuses explicitly.
 *
 * Ownership: one request in flight, at most one lease held (released by the
 * next pull), at most one VideoFrame open. A renderer encode/GPU failure asks
 * native for a surface reset (revoking every lease) and continues with the
 * new epoch; repeated failures stop the source. Cancellation, close and
 * replacement retire the generation; a replacement opens a NEW generation.
 */
export type RoomFrameApi = (command: RoomFrameCommand) => Promise<RoomFrameReply>
export type RoomFrameSource = {
  track: MediaStreamTrack
  generation: number
  opened: RoomFrameOpened
  close: () => Promise<void>
  resetSurface: () => Promise<void>
}

type VideoFrameLike = { close: () => void }
type VideoFrameCtor = new (
  data: BufferSource,
  init: {
    format: 'RGBX'
    codedWidth: number
    codedHeight: number
    timestamp: number
    duration: number
  }
) => VideoFrameLike
type WriterLike = {
  write: (frame: VideoFrameLike) => Promise<void>
  close: () => Promise<void>
  releaseLock?: () => void
}
type GeneratorLike = MediaStreamTrack & { writable: { getWriter: () => WriterLike } }
type GeneratorCtor = new (init: { kind: 'video' }) => GeneratorLike
export type RoomFrameRuntime = {
  Generator?: GeneratorCtor
  VideoFrame?: VideoFrameCtor
  now?: () => number
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}

const MAX_CONSECUTIVE_FAILURES = 3
let lastGeneration = 0

function runtimeOf(runtime: RoomFrameRuntime) {
  const g = globalThis as unknown as {
    MediaStreamTrackGenerator?: GeneratorCtor
    VideoFrame?: VideoFrameCtor
  }
  return {
    Generator: runtime.Generator ?? g.MediaStreamTrackGenerator,
    VideoFrame: runtime.VideoFrame ?? g.VideoFrame,
    now: runtime.now ?? (() => performance.now()),
    schedule: runtime.schedule ?? ((callback, ms) => setTimeout(callback, ms)),
    cancel: runtime.cancel ?? ((timer) => clearTimeout(timer))
  }
}

/** Explicit test factory only. Normal joins keep the browser camera. */
export async function createRoomFrameTestSource(
  api: RoomFrameApi,
  signal: AbortSignal,
  observe?: (value: unknown) => void,
  onFailure?: (reason: string) => void,
  runtime: RoomFrameRuntime = {}
): Promise<RoomFrameSource> {
  if (signal.aborted) throw new Error('Frame source cancelled.')
  const rt = runtimeOf(runtime)
  if (!rt.Generator || !rt.VideoFrame)
    throw new Error(
      'Camera bridge unsupported: this runtime has no timestamp-preserving frame generator.'
    )
  const Generator = rt.Generator
  const VideoFrameImpl = rt.VideoFrame
  const generation = (lastGeneration = Math.max(Date.now(), lastGeneration + 1))
  let serial = 0
  const nextSerial = (): number => {
    serial = serial >= 0xffff_fffe ? 1 : serial + 1
    return serial
  }
  let inFlight: Promise<RoomFrameReply> | null = null
  const request = (
    action: RoomFrameCommand['action'],
    release?: RoomFrameRelease
  ): Promise<RoomFrameReply> => {
    if (inFlight) return Promise.reject(new Error('Frame request already outstanding.'))
    const current = api(roomFrameCommand(action, generation, nextSerial(), release))
      .then((reply) => parseRoomFrameReply(reply, generation))
      .finally(() => {
        if (inFlight === current) inFlight = null
        releaseIfClosed()
      })
    inFlight = current
    return current
  }

  let closed = false
  let closing: Promise<void> | null = null
  let closeSettled = false
  let closeError: string | null = null
  let generator: GeneratorLike | null = null
  let writer: WriterLike | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let held: RoomFrameRelease | null = null
  let framesOpen = 0
  let surfaceEpoch = 0
  let failures = 0
  let resetting: Promise<void> | null = null
  const counters = { written: 0, idle: 0, stalled: 0, resets: 0, encodeFailures: 0 }

  const readResources = (): Record<string, unknown> => ({
    generators: generator && generator.readyState !== 'ended' ? 1 : 0,
    tracks: generator && generator.readyState !== 'ended' ? 1 : 0,
    timers: timer === undefined ? 0 : 1,
    ipcRequests: inFlight ? 1 : 0,
    leasesHeld: held ? 1 : 0,
    framesOpen,
    surfaceEpoch,
    ...counters,
    closeError
  })
  const resetSurface = async (): Promise<void> => {
    if (closed) return
    if (resetting) return resetting
    resetting = (async () => {
      // Wait for the current pull so the one-credit transport is never doubled.
      await inFlight?.catch(() => null)
      if (closed) return
      const reply = await request('reset')
      if (!reply || !('revokedLeases' in reply)) throw new Error('Frame reset unacknowledged.')
      surfaceEpoch = reply.surfaceEpoch
      counters.resets++
      // Every lease of the old epoch is revoked natively; a late release is stale.
      held = null
      observe?.({ ...reply, phase: 'surface-reset', generation, productionQualified: false })
    })().finally(() => {
      resetting = null
    })
    return resetting
  }
  const unregister = registerRoomFrameResources(generation, readResources, { resetSurface })
  function releaseIfClosed(): void {
    if (!closed || !closeSettled || closeError) return
    const remaining = readResources()
    if (
      ['generators', 'tracks', 'timers', 'ipcRequests', 'leasesHeld', 'framesOpen'].every(
        (key) => remaining[key] === 0
      )
    )
      unregister()
  }

  const close = (): Promise<void> => {
    if (closed) return closing ?? Promise.resolve()
    closed = true
    signal.removeEventListener('abort', abort)
    if (timer !== undefined) rt.cancel(timer)
    timer = undefined
    held = null
    generator?.stop()
    const closingWriter = writer?.close().catch(() => {})
    writer = null
    closing = Promise.all([
      closingWriter,
      (async () => {
        await inFlight?.catch(() => null)
        // Only a generation native acknowledged opening has a source to close.
        if (surfaceEpoch !== 0) await request('close')
      })()
    ])
      .then(() => {
        closeSettled = true
        observe?.({ phase: 'closed', generation, remaining: readResources() })
        releaseIfClosed()
      })
      .catch(() => {
        closeError = 'Frame close acknowledgement unavailable.'
      })
    return closing
  }
  const abort = (): void => {
    void close()
  }
  signal.addEventListener('abort', abort, { once: true })
  const fail = (reason: string): void => {
    if (closed) return
    onFailure?.(reason)
    void close()
  }

  const tick = async (): Promise<void> => {
    timer = undefined
    if (closed || resetting) {
      if (!closed) timer = rt.schedule(() => void tick(), 5)
      return
    }
    const release = held ?? undefined
    held = null
    const pullRequestedAtMs = rt.now()
    let reply: RoomFrameReply
    try {
      reply = await request('pull', release)
    } catch {
      fail('Native camera frame source stopped; publication is unqualified.')
      return
    }
    if (closed) return
    const pullReceivedAtMs = rt.now()
    if (!isRoomFrame(reply)) {
      if (reply && 'reason' in reply) {
        if (reply.reason === 'lease-stalled') counters.stalled++
        else counters.idle++
      }
      timer = rt.schedule(() => void tick(), 5)
      return
    }
    const { header, pixels } = reply
    if (header.surfaceEpoch !== surfaceEpoch) {
      // A frame from an older surface epoch is never encoded.
      timer = rt.schedule(() => void tick(), 0)
      return
    }
    let frame: VideoFrameLike | null = null
    try {
      frame = new VideoFrameImpl(pixels, {
        format: 'RGBX',
        codedWidth: header.width,
        codedHeight: header.height,
        timestamp: header.ptsUs,
        duration: Math.round(1_000_000 / ROOM_FRAME.fps)
      })
      framesOpen++
      await writer!.write(frame)
      counters.written++
      failures = 0
      held = { sequence: header.sequence, surfaceEpoch: header.surfaceEpoch }
      observe?.({
        phase: 'native-frame',
        generation,
        sequence: header.sequence,
        ptsUs: header.ptsUs,
        observedAtUs: header.observedAtUs,
        originUs: header.originUs,
        incarnation: header.incarnation,
        nativeCaptureUs: nativeCaptureUs(header),
        surfaceEpoch: header.surfaceEpoch,
        droppedFrames: header.droppedFrames,
        leaseStalls: header.leaseStalls,
        pullRequestedAtMs,
        pullReceivedAtMs,
        writtenAtMs: rt.now(),
        productionQualified: false
      })
    } catch {
      counters.encodeFailures++
      failures++
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        fail('Camera bridge encoding failed repeatedly; publication stopped.')
        return
      }
      try {
        await resetSurface()
      } catch {
        fail('Camera bridge surface reset failed; publication stopped.')
        return
      }
    } finally {
      if (frame) {
        frame.close()
        framesOpen--
      }
    }
    if (!closed) timer = rt.schedule(() => void tick(), 0)
  }

  try {
    const openRequestedAtMs = rt.now()
    const opened = await request('open')
    const openAcknowledgedAtMs = rt.now()
    if (!opened || !('incarnation' in opened)) throw new Error('Frame open unacknowledged.')
    surfaceEpoch = opened.surfaceEpoch
    if (closed || signal.aborted) throw new Error('Frame source cancelled.')
    generator = new Generator({ kind: 'video' })
    writer = generator.writable.getWriter()
    generator.contentHint = 'motion'
    observe?.({
      ...opened,
      phase: 'opened',
      generation,
      openRequestedAtMs,
      openAcknowledgedAtMs,
      productionQualified: false
    })
    timer = rt.schedule(() => void tick(), 0)
    return { track: generator, generation, opened, close, resetSurface }
  } catch (error) {
    await close()
    throw error
  }
}
