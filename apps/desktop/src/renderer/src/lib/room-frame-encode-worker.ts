/**
 * Plan 249 S13a harness only: the worker side of the camera bridge's encoded
 * frame observer (`RTCRtpScriptTransform`, Chromium's standard WebRTC Encoded
 * Transform). Every `RTCEncodedVideoFrame` is enqueued UNCHANGED; the worker
 * only records what the frame itself reports, as given, plus the worker's
 * epoch time when the transform saw it. Nothing here derives a capture time
 * from an RTP timestamp.
 *
 * The transform runs after the encoder and BEFORE packetization, pacing and
 * send, so these records say "encoder output observed", never "sent".
 */

/** Bounded ring: about 136 s of 30 fps output between two drains. */
export const ENCODE_RING_CAPACITY = 4096

type Primitive = string | number | boolean | null
export type EncodedFrameRecord = {
  /** `getMetadata().rtpTimestamp` when present, else `frame.timestamp`, as provided. */
  rtpTimestamp: number | null
  rtpTimestampSource: 'metadata.rtpTimestamp' | 'frame.timestamp' | null
  /** `RTCEncodedVideoFrame.timestamp` exactly as provided (null when absent). */
  timestamp: number | null
  type: string | null
  byteLength: number | null
  frameId: number | null
  /** Primitive `getMetadata()` fields only, copied as given. */
  metadata: Record<string, Primitive>
  /** Every key `getMetadata()` returned, primitive or not. */
  metadataKeys: string[]
  metadataError: string | null
  /** `performance.timeOrigin + performance.now()` in the worker at transform time. */
  atEpochMs: number
}

/** The shape of an encoded frame this observer reads; nothing is written to it. */
export type EncodedFrameLike = {
  timestamp?: unknown
  type?: unknown
  data?: { byteLength?: unknown } | null
  getMetadata?: () => unknown
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export function recordEncodedFrame(frame: EncodedFrameLike, atEpochMs: number): EncodedFrameRecord {
  const metadata: Record<string, Primitive> = {}
  const metadataKeys: string[] = []
  let metadataError: string | null = null
  try {
    const raw = typeof frame.getMetadata === 'function' ? frame.getMetadata() : null
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        metadataKeys.push(key)
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
        )
          metadata[key] = value
      }
    }
  } catch (error) {
    metadataError = error instanceof Error ? error.message : String(error)
  }
  const timestamp = numberOrNull(frame.timestamp)
  const fromMetadata = numberOrNull(metadata.rtpTimestamp)
  let byteLength: number | null
  try {
    byteLength = numberOrNull(frame.data?.byteLength)
  } catch {
    byteLength = null
  }
  return {
    rtpTimestamp: fromMetadata ?? timestamp,
    rtpTimestampSource:
      fromMetadata !== null
        ? 'metadata.rtpTimestamp'
        : timestamp !== null
          ? 'frame.timestamp'
          : null,
    timestamp,
    type: typeof frame.type === 'string' ? frame.type : null,
    byteLength,
    frameId: numberOrNull(metadata.frameId),
    metadata,
    metadataKeys,
    metadataError,
    atEpochMs
  }
}

export type EncodeRecorder = {
  record: (frame: EncodedFrameLike) => void
  /** Records since the last drain, oldest first; `dropped` is cumulative. */
  drain: () => { records: EncodedFrameRecord[]; dropped: number; recorded: number }
  readonly size: number
}

/** Fixed-capacity ring. When full the OLDEST record is overwritten and counted dropped. */
export function createEncodeRecorder(
  capacity = ENCODE_RING_CAPACITY,
  clock: () => number = () => performance.timeOrigin + performance.now()
): EncodeRecorder {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Ring capacity must be >= 1.')
  const ring: (EncodedFrameRecord | undefined)[] = new Array(capacity)
  let head = 0
  let size = 0
  let dropped = 0
  let recorded = 0
  return {
    record(frame) {
      const record = recordEncodedFrame(frame, clock())
      recorded++
      ring[(head + size) % capacity] = record
      if (size < capacity) size++
      else {
        head = (head + 1) % capacity
        dropped++
      }
    },
    drain() {
      const records: EncodedFrameRecord[] = []
      for (let i = 0; i < size; i++) {
        const index = (head + i) % capacity
        records.push(ring[index]!)
        ring[index] = undefined
      }
      head = 0
      size = 0
      return { records, dropped, recorded }
    },
    get size() {
      return size
    }
  }
}

/**
 * The pass-through transformer. Recording can never block or alter a frame:
 * the SAME frame object is enqueued even if recording throws.
 */
export function encodedPassThrough<T extends EncodedFrameLike>(
  recorder: Pick<EncodeRecorder, 'record'>,
  onRecordError?: (reason: string) => void
): { transform: (frame: T, controller: { enqueue: (frame: T) => void }) => void } {
  return {
    transform(frame, controller) {
      try {
        recorder.record(frame)
      } catch (error) {
        onRecordError?.(error instanceof Error ? error.message : String(error))
      }
      controller.enqueue(frame)
    }
  }
}

export type EncodeWorkerRequest = { type: 'drain'; generation: number }
export type EncodeWorkerReply =
  | {
      type: 'drained'
      generation: number
      /** Generation from the `RTCRtpScriptTransform` options, null before `rtctransform`. */
      transformGeneration: number | null
      records: EncodedFrameRecord[]
      dropped: number
      recorded: number
      workerEpochMs: number
    }
  | { type: 'transform-started'; generation: number | null }
  | { type: 'transform-error'; generation: number | null; reason: string }

type TransformerLike = {
  readable: ReadableStream<EncodedFrameLike>
  writable: WritableStream<EncodedFrameLike>
  options?: { generation?: unknown } | null
}
export type EncodeWorkerScope = {
  postMessage: (message: EncodeWorkerReply) => void
  onmessage: ((event: { data: unknown }) => void) | null
  onrtctransform?: ((event: { transformer: TransformerLike }) => void) | null
}

/** Installs the handlers on a worker scope (exported for unit tests). */
export function installEncodeWorker(
  scope: EncodeWorkerScope,
  recorder: EncodeRecorder = createEncodeRecorder(),
  clock: () => number = () => performance.timeOrigin + performance.now()
): void {
  let transformGeneration: number | null = null
  // A dedicated worker posts to its own owner: worker-scope postMessage has no
  // targetOrigin (that argument belongs to Window.postMessage only).
  const post = (message: EncodeWorkerReply): void =>
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker scope, not a window.
    scope.postMessage(message)
  scope.onrtctransform = ({ transformer }) => {
    const generation = numberOrNull(transformer.options?.generation)
    transformGeneration = generation
    post({ type: 'transform-started', generation })
    const fail = (reason: string): void => post({ type: 'transform-error', generation, reason })
    transformer.readable
      .pipeThrough(new TransformStream(encodedPassThrough(recorder, fail)))
      .pipeTo(transformer.writable)
      .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
  }
  scope.onmessage = ({ data }) => {
    const request = data as Partial<EncodeWorkerRequest> | null
    if (request?.type !== 'drain' || typeof request.generation !== 'number') return
    const { records, dropped, recorded } = recorder.drain()
    post({
      type: 'drained',
      generation: request.generation,
      transformGeneration,
      records,
      dropped,
      recorded,
      workerEpochMs: clock()
    })
  }
}

// Install only inside a dedicated worker; importing this module elsewhere is inert.
const workerScope = globalThis as unknown as {
  WorkerGlobalScope?: abstract new () => unknown
}
if (
  typeof workerScope.WorkerGlobalScope === 'function' &&
  globalThis instanceof workerScope.WorkerGlobalScope
)
  installEncodeWorker(globalThis as unknown as EncodeWorkerScope)
