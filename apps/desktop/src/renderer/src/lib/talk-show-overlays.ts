import type {
  BackendConnection,
  CloudRoomOverlayEvent,
  CloudRoomPhase,
  CloudStatus
} from '@/lib/backend'
import { isManagedShow } from '@/lib/talk-show-managed'

// Overlays on a managed talk show (plan 234 T3, wire contract 6.3). On a
// node show the backend sends a comment card or a takeover to the runner.
// A managed show has no runner: its program page takes overlays as byte
// streams, only from `host:<showId>`, and only this renderer holds the
// host's room connection. So the backend hands each one over
// (`cloud.room.overlay`, the bytes by id from its HTTP server) and this
// module sends it.
//
// Nothing is remembered here. The backend keeps what is up and hands the
// untimed overlays over again when a program page joins the room or this
// connection comes back, so every hand-off is simply sent.
//
// Pure of `livekit-client` and of React, so every rule is a unit test.

export const OVERLAY_SET_TOPIC = 'videorc.overlay.set'
export const OVERLAY_CLEAR_TOPIC = 'videorc.overlay.clear'
/** On a byte stream every attribute is a string, so `v` is the string "1". */
export const OVERLAY_SET_VERSION = '1'
/** The clear body is JSON, and its `v` is the number 1. */
export const OVERLAY_CLEAR_VERSION = 1
/** The page drops an image over 2 MiB. */
export const OVERLAY_MAX_BYTES = 2 * 1024 * 1024
export const OVERLAY_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
/** The clear body's own type; the page reads the bytes, not the type. */
const OVERLAY_CLEAR_MIME_TYPE = 'application/json'

// 2 MiB takes 64 s at 256 kbit/s. Allow 90 s for the upload,
// with 5 s per 16 KiB write/open/close, and 10 s for the local image fetch.
export const OVERLAY_FETCH_TIMEOUT_MS = 10_000
export const OVERLAY_WRITE_TIMEOUT_MS = 5_000
export const OVERLAY_UPLOAD_TIMEOUT_MS = 90_000
const OVERLAY_CHUNK_BYTES = 16 * 1024

async function overlayDeadline<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  ms: number
): Promise<T> {
  if (signal.aborted) throw new Error('Overlay dropped')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new Error('Overlay dropped'))
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new Error('Overlay timed out')), ms)
      work().then(resolve, reject)
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

export type OverlaySet = Extract<CloudRoomOverlayEvent, { op: 'set' }>
export type OverlayClear = Extract<CloudRoomOverlayEvent, { op: 'clear' }>

export type OverlayImage = { bytes: Uint8Array; mimeType: string }

/** What `localParticipant.streamBytes` is to this module. */
export interface OverlayPublisher {
  streamBytes(options: {
    topic: string
    mimeType: string
    totalSize: number
    attributes?: Record<string, string>
  }): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }>
}

/**
 * A fraction of the canvas as the page reads it: plain decimals from 0 to 1.
 * The page refuses an exponent, and JavaScript prints a very small number
 * with one (`1e-7`), so the number is clamped and printed with six places.
 */
export function overlayFraction(value: number): string {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  return clamped.toFixed(6)
}

/** The byte stream's attributes: `v`, `slot`, `o`, the rect, and `ttl` only when timed. */
export function overlaySetAttributes(event: OverlaySet): Record<string, string> {
  const attributes: Record<string, string> = {
    v: OVERLAY_SET_VERSION,
    slot: event.slot,
    o: event.orientation,
    x: overlayFraction(event.rect.x),
    y: overlayFraction(event.rect.y),
    w: overlayFraction(event.rect.w),
    h: overlayFraction(event.rect.h)
  }
  if (event.ttlSeconds !== undefined) {
    // A whole number of 1 or more.
    attributes.ttl = String(Math.max(1, Math.round(event.ttlSeconds)))
  }
  return attributes
}

/** The clear's body: UTF-8 JSON `{ "v": 1, "slot", "o" }`. */
export function overlayClearBody(event: OverlayClear): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({ v: OVERLAY_CLEAR_VERSION, slot: event.slot, o: event.orientation })
  )
}

/** Where the backend serves an overlay's bytes, with its own token. */
export function overlayImageUrl(
  connection: Pick<BackendConnection, 'host' | 'port' | 'token'>,
  imageId: string
): string {
  const params = new URLSearchParams({ token: connection.token })
  return `http://${connection.host}:${connection.port}/cloud/overlays/${encodeURIComponent(imageId)}?${params}`
}

/** The bytes of an overlay that is still up; null once it came down. */
export async function fetchOverlayImage(
  url: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  signal?: AbortSignal
): Promise<OverlayImage | null> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  try {
    return await overlayDeadline(
      async () => {
        const response = await fetcher(url, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) return null
        const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
        return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType }
      },
      controller.signal,
      OVERLAY_FETCH_TIMEOUT_MS
    )
  } finally {
    controller.abort()
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Whether a hand-off is this room's to send: the room is open, the show is
 * the one the event names, and it is a managed show. A node show's overlays
 * go to its runner from the backend, and nothing is ever sent from here.
 */
export function overlayIsForThisRoom(
  event: CloudRoomOverlayEvent,
  status: CloudStatus | null,
  roomPhase: CloudRoomPhase
): boolean {
  return (
    roomPhase === 'open' &&
    isManagedShow(status) &&
    status?.show?.id !== undefined &&
    status.show.id === event.showId
  )
}

export type OverlaySendResult =
  /** The byte stream went to the room. */
  | 'sent'
  /** The overlay came down before its bytes were fetched: nothing to send. */
  | 'gone'
  /** The page would drop it (no bytes, over 2 MiB, or not an image it takes). */
  | 'refused'

/** One hand-off. Cancellation stops further writes and withholds the
 * trailer of an incomplete set; LiveKit's public writer has no abort API. */
export async function sendOverlay(
  event: CloudRoomOverlayEvent,
  deps: {
    publisher: OverlayPublisher
    image: (imageId: string, signal?: AbortSignal) => Promise<OverlayImage | null>
    signal?: AbortSignal
  }
): Promise<OverlaySendResult> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  deps.signal?.addEventListener('abort', abort, { once: true })
  if (deps.signal?.aborted) controller.abort()
  const timer = setTimeout(abort, OVERLAY_UPLOAD_TIMEOUT_MS)
  const signal = controller.signal
  const bounded = <T>(work: () => Promise<T>) =>
    overlayDeadline(work, signal, OVERLAY_WRITE_TIMEOUT_MS)
  try {
    if (event.op === 'clear') {
      const body = overlayClearBody(event)
      const writer = await bounded(() =>
        deps.publisher.streamBytes({
          topic: OVERLAY_CLEAR_TOPIC,
          mimeType: OVERLAY_CLEAR_MIME_TYPE,
          totalSize: body.byteLength
        })
      )
      await bounded(() => writer.write(body))
      await bounded(() => writer.close())
      return 'sent'
    }
    const image = await overlayDeadline(
      () => deps.image(event.imageId, signal),
      signal,
      OVERLAY_FETCH_TIMEOUT_MS
    )
    if (!image) return 'gone'
    const mimeType =
      OVERLAY_MIME_TYPES.find((type) => type === event.mimeType) ??
      OVERLAY_MIME_TYPES.find((type) => type === image.mimeType)
    const size = image.bytes.byteLength
    if (!mimeType || size === 0 || size > OVERLAY_MAX_BYTES) return 'refused'
    const writer = await bounded(() =>
      deps.publisher.streamBytes({
        topic: OVERLAY_SET_TOPIC,
        mimeType,
        totalSize: size,
        attributes: overlaySetAttributes(event)
      })
    )
    for (let offset = 0; offset < size; offset += OVERLAY_CHUNK_BYTES) {
      await bounded(() => writer.write(image.bytes.subarray(offset, offset + OVERLAY_CHUNK_BYTES)))
    }
    await bounded(() => writer.close())
    return 'sent'
  } finally {
    clearTimeout(timer)
    controller.abort()
    deps.signal?.removeEventListener('abort', abort)
  }
}
