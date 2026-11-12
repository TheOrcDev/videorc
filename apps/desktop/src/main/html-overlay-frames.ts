// HTML overlays (plan 231 "Transport"): the frames main sends the backend.
//
// One long-lived chunked HTTP upload on loopback
// (`POST /html-overlays/frames?token=<admin>`). Its body is frame records: a
// 40-byte header, then width × height × 4 bytes of premultiplied BGRA exactly
// as Chromium painted them. The backend turns them into straight alpha.
//
// Latest wins: a frame is never queued behind one the socket still holds.
// The header is pinned against the Rust parser by
// `protocol-fixtures/html-overlay-frame.json`.

import { request as httpRequest, type ClientRequest } from 'node:http'

export const HTML_OVERLAY_FRAME_HEADER_BYTES = 40
const FRAME_MAGIC = Buffer.from('VHOF', 'latin1')
const FRAME_VERSION = 1

export interface HtmlOverlayFrameHeader {
  /** The banner's id, a hyphenated UUID. */
  id: string
  width: number
  height: number
  sequence: bigint
}

/** The 16 bytes of a hyphenated UUID, or `null` when it is not one. */
export function htmlOverlayIdBytes(id: string): Buffer | null {
  const hex = id.replaceAll('-', '')
  return /^[0-9a-f]{32}$/i.test(hex) && id.length === 36 ? Buffer.from(hex, 'hex') : null
}

/**
 * One frame record's header: magic `VHOF`, version 1, flags 0, reserved 0,
 * the id (16 bytes), width and height (u32 LE), sequence (u64 LE).
 */
export function encodeHtmlOverlayFrameHeader(header: HtmlOverlayFrameHeader): Buffer {
  const id = htmlOverlayIdBytes(header.id)
  if (!id) throw new Error('HTML overlay frame id is not a UUID.')
  if (
    !Number.isInteger(header.width) ||
    !Number.isInteger(header.height) ||
    header.width < 1 ||
    header.height < 1 ||
    header.width > 0xffff_ffff ||
    header.height > 0xffff_ffff
  ) {
    throw new Error('HTML overlay frame size is out of range.')
  }
  const bytes = Buffer.alloc(HTML_OVERLAY_FRAME_HEADER_BYTES)
  FRAME_MAGIC.copy(bytes, 0)
  bytes.writeUInt8(FRAME_VERSION, 4)
  id.copy(bytes, 8)
  bytes.writeUInt32LE(header.width, 24)
  bytes.writeUInt32LE(header.height, 28)
  bytes.writeBigUInt64LE(BigInt.asUintN(64, header.sequence), 32)
  return bytes
}

/** What the uploader needs of an upload: `http.ClientRequest` in the app, a
 * fake in the tests. */
export interface HtmlOverlayUploadStream {
  write: (chunk: Buffer) => boolean
  readonly writableNeedDrain: boolean
  readonly destroyed: boolean
  destroy: () => void
  on: (event: 'error' | 'close', listener: (error?: Error) => void) => unknown
}

export interface HtmlOverlayUploadConnection {
  host: string
  port: number
  /** The admin token: only main may put pixels on the picture. */
  token: string
}

export type HtmlOverlaySendOutcome =
  | 'sent'
  /** The upload still holds the previous frame. */
  | 'busy'
  /** No backend connection, or the upload is being reopened. */
  | 'offline'

export interface HtmlOverlayUploadStats {
  framesSent: number
  framesDroppedBusy: number
  framesDroppedOffline: number
  bytesSent: number
  uploadsOpened: number
}

/** How long a failed upload waits before the next frame may reopen it. */
export const HTML_OVERLAY_UPLOAD_RETRY_MS = 500

export function openHtmlOverlayUpload(connection: HtmlOverlayUploadConnection): ClientRequest {
  const upload = httpRequest({
    host: connection.host,
    port: connection.port,
    method: 'POST',
    path: `/html-overlays/frames?token=${encodeURIComponent(connection.token)}`,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Transfer-Encoding': 'chunked'
    },
    // One socket for the upload's whole life, never pooled or reused.
    agent: false
  })
  upload.setNoDelay(true)
  // The backend answers only when the upload ends; an early answer (401,
  // 400) ends it from that side and surfaces here as `close`.
  upload.on('response', (response) => response.resume())
  return upload
}

/**
 * Writes frames down one upload, reopening it when it breaks. It never
 * buffers more than the frame being written: `send` answers `busy` while the
 * socket has not drained, and the caller drops that frame.
 */
export class HtmlOverlayFrameUploader {
  private upload: HtmlOverlayUploadStream | null = null
  private retryAtMs = 0
  private readonly counters: HtmlOverlayUploadStats = {
    framesSent: 0,
    framesDroppedBusy: 0,
    framesDroppedOffline: 0,
    bytesSent: 0,
    uploadsOpened: 0
  }

  constructor(
    private readonly getConnection: () => HtmlOverlayUploadConnection | null,
    private readonly open: (
      connection: HtmlOverlayUploadConnection
    ) => HtmlOverlayUploadStream = openHtmlOverlayUpload,
    private readonly now: () => number = Date.now
  ) {}

  /** Whether a frame sent now would be dropped as `busy`. */
  get busy(): boolean {
    return this.upload !== null && !this.upload.destroyed && this.upload.writableNeedDrain
  }

  send(header: HtmlOverlayFrameHeader, pixels: Buffer): HtmlOverlaySendOutcome {
    const upload = this.ensureUpload()
    if (!upload) {
      this.counters.framesDroppedOffline += 1
      return 'offline'
    }
    if (upload.writableNeedDrain) {
      this.counters.framesDroppedBusy += 1
      return 'busy'
    }
    const headerBytes = encodeHtmlOverlayFrameHeader(header)
    // Two plain writes, never corked: on Electron's Node (22) a corked
    // chunked request never emits `drain`, so `writableNeedDrain` would stay
    // true after the first frame and every later one would be dropped.
    upload.write(headerBytes)
    upload.write(pixels)
    this.counters.framesSent += 1
    this.counters.bytesSent += headerBytes.length + pixels.length
    return 'sent'
  }

  /** End the upload (the backend went away, or no overlay shows). */
  close(): void {
    const upload = this.upload
    this.upload = null
    if (upload && !upload.destroyed) upload.destroy()
  }

  stats(): HtmlOverlayUploadStats {
    return { ...this.counters }
  }

  private ensureUpload(): HtmlOverlayUploadStream | null {
    if (this.upload && !this.upload.destroyed) return this.upload
    this.upload = null
    if (this.now() < this.retryAtMs) return null
    const connection = this.getConnection()
    if (!connection) return null
    let upload: HtmlOverlayUploadStream
    try {
      upload = this.open(connection)
    } catch {
      this.retryAtMs = this.now() + HTML_OVERLAY_UPLOAD_RETRY_MS
      return null
    }
    this.counters.uploadsOpened += 1
    const retire = (): void => {
      if (this.upload !== upload) return
      this.upload = null
      this.retryAtMs = this.now() + HTML_OVERLAY_UPLOAD_RETRY_MS
      if (!upload.destroyed) upload.destroy()
    }
    upload.on('error', retire)
    upload.on('close', retire)
    this.upload = upload
    return upload
  }
}
