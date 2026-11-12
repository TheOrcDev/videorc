import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import {
  HTML_OVERLAY_FRAME_HEADER_BYTES,
  HTML_OVERLAY_UPLOAD_RETRY_MS,
  HtmlOverlayFrameUploader,
  encodeHtmlOverlayFrameHeader,
  htmlOverlayIdBytes,
  openHtmlOverlayUpload,
  type HtmlOverlayUploadStream
} from './html-overlay-frames'

const BADGE = '0f9d1c2e-5b7a-4c3d-9e8f-a1b2c3d4e5f6'

interface FrameFixture {
  headerBytes: number
  headers: { id: string; width: number; height: number; sequence: string; hex: string }[]
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/html-overlay-frame.json', import.meta.url),
    'utf8'
  )
) as FrameFixture

describe('the frame record header (plan 232 "Wire")', () => {
  it('matches the fixture the Rust parser reads, byte for byte', () => {
    expect(HTML_OVERLAY_FRAME_HEADER_BYTES).toBe(fixture.headerBytes)
    expect(fixture.headers.length).toBeGreaterThan(0)
    for (const header of fixture.headers) {
      const bytes = encodeHtmlOverlayFrameHeader({
        id: header.id,
        width: header.width,
        height: header.height,
        sequence: BigInt(header.sequence)
      })
      expect(bytes.length).toBe(HTML_OVERLAY_FRAME_HEADER_BYTES)
      expect(bytes.toString('hex'), JSON.stringify(header)).toBe(header.hex)
    }
  })

  it('refuses an id that is not a UUID and a size out of range', () => {
    expect(htmlOverlayIdBytes(BADGE)?.length).toBe(16)
    for (const id of [
      '',
      'badge',
      BADGE.replaceAll('-', ''),
      `${BADGE}0`,
      `${BADGE.slice(0, 35)}g`
    ]) {
      expect(htmlOverlayIdBytes(id), id).toBeNull()
      expect(() =>
        encodeHtmlOverlayFrameHeader({ id, width: 2, height: 2, sequence: 1n })
      ).toThrow()
    }
    for (const [width, height] of [
      [0, 2],
      [2, 0],
      [1.5, 2],
      [2, 2 ** 32]
    ]) {
      expect(() =>
        encodeHtmlOverlayFrameHeader({ id: BADGE, width: width!, height: height!, sequence: 1n })
      ).toThrow()
    }
  })
})

/** An upload that records what it was given and drains only when told to. */
class FakeUpload implements HtmlOverlayUploadStream {
  readonly chunks: Buffer[] = []
  writableNeedDrain = false
  destroyed = false
  private readonly listeners = new Map<string, ((error?: Error) => void)[]>()

  write(chunk: Buffer): boolean {
    this.chunks.push(chunk)
    return !this.writableNeedDrain
  }
  destroy(): void {
    this.destroyed = true
  }
  on(event: 'error' | 'close', listener: (error?: Error) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: 'error' | 'close'): void {
    for (const listener of this.listeners.get(event) ?? []) listener(new Error(event))
  }
}

describe('the frame upload: latest wins', () => {
  const connection = { host: '127.0.0.1', port: 1, token: 'admin' }
  const frame = { id: BADGE, width: 2, height: 1, sequence: 1n }
  const pixels = Buffer.alloc(8, 7)

  function uploader(now: { ms: number } = { ms: 0 }): {
    uploads: FakeUpload[]
    uploader: HtmlOverlayFrameUploader
    connected: { value: boolean }
  } {
    const uploads: FakeUpload[] = []
    const connected = { value: true }
    return {
      uploads,
      connected,
      uploader: new HtmlOverlayFrameUploader(
        () => (connected.value ? connection : null),
        () => {
          const upload = new FakeUpload()
          uploads.push(upload)
          return upload
        },
        () => now.ms
      )
    }
  }

  it('writes a header and then the pixels, without copying them', () => {
    const { uploads, uploader: frames } = uploader()
    expect(frames.send(frame, pixels)).toBe('sent')
    expect(uploads).toHaveLength(1)
    const [header, body] = uploads[0]!.chunks
    expect(header!.toString('hex')).toBe(encodeHtmlOverlayFrameHeader(frame).toString('hex'))
    expect(body).toBe(pixels)
    expect(frames.stats()).toMatchObject({
      framesSent: 1,
      bytesSent: HTML_OVERLAY_FRAME_HEADER_BYTES + pixels.length,
      uploadsOpened: 1
    })
  })

  it('drops a frame while the socket still holds the last one, and never queues it', () => {
    const { uploads, uploader: frames } = uploader()
    frames.send(frame, pixels)
    uploads[0]!.writableNeedDrain = true
    expect(frames.busy).toBe(true)
    expect(frames.send({ ...frame, sequence: 2n }, pixels)).toBe('busy')
    expect(frames.send({ ...frame, sequence: 3n }, pixels)).toBe('busy')
    expect(uploads[0]!.chunks).toHaveLength(2)
    uploads[0]!.writableNeedDrain = false
    expect(frames.busy).toBe(false)
    expect(frames.send({ ...frame, sequence: 4n }, pixels)).toBe('sent')
    expect(uploads[0]!.chunks).toHaveLength(4)
    expect(frames.stats()).toMatchObject({ framesSent: 2, framesDroppedBusy: 2 })
  })

  it('drops frames while there is no backend, and opens no upload', () => {
    const { uploads, uploader: frames, connected } = uploader()
    connected.value = false
    expect(frames.send(frame, pixels)).toBe('offline')
    expect(uploads).toHaveLength(0)
    connected.value = true
    expect(frames.send(frame, pixels)).toBe('sent')
    expect(frames.stats()).toMatchObject({ framesSent: 1, framesDroppedOffline: 1 })
  })

  it('reopens a broken upload, but not on every frame', () => {
    const now = { ms: 1000 }
    const { uploads, uploader: frames } = uploader(now)
    frames.send(frame, pixels)
    uploads[0]!.emit('error')
    expect(uploads[0]!.destroyed).toBe(true)
    // Thirty frames a second must not mean thirty connection attempts.
    expect(frames.send(frame, pixels)).toBe('offline')
    now.ms += HTML_OVERLAY_UPLOAD_RETRY_MS - 1
    expect(frames.send(frame, pixels)).toBe('offline')
    expect(uploads).toHaveLength(1)
    now.ms += 1
    expect(frames.send(frame, pixels)).toBe('sent')
    expect(uploads).toHaveLength(2)
    // A late event from the old upload never retires the new one.
    uploads[0]!.emit('close')
    expect(frames.send(frame, pixels)).toBe('sent')
    expect(uploads).toHaveLength(2)
  })

  it('closes when told, and opens again for the next frame', () => {
    const { uploads, uploader: frames } = uploader()
    frames.send(frame, pixels)
    frames.close()
    expect(uploads[0]!.destroyed).toBe(true)
    expect(frames.send(frame, pixels)).toBe('sent')
    expect(uploads).toHaveLength(2)
  })
})

describe('the upload drains (the reason it is never corked)', () => {
  let server: Server | null = null
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  // On Electron's Node (22) a corked chunked request never emits `drain`:
  // `writableNeedDrain` stays true after one frame and every later frame is
  // dropped as busy. This sends real frames to a real server and expects
  // the uploader to keep sending.
  it('keeps sending frame after frame over a real connection', async () => {
    let received = 0
    server = createServer((request, response) => {
      request.on('data', (chunk: Buffer) => {
        received += chunk.length
      })
      request.on('end', () => {
        response.statusCode = 204
        response.end()
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server!.address() as AddressInfo
    const frames = new HtmlOverlayFrameUploader(() => ({ host: '127.0.0.1', port, token: 't' }))
    // A 384 x 216 frame: far above the socket's high-water mark.
    const pixels = Buffer.alloc(384 * 216 * 4, 9)
    let sent = 0
    for (let sequence = 1n; sequence <= 12n; sequence += 1n) {
      const deadline = Date.now() + 2000
      while (frames.busy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      if (frames.send({ id: BADGE, width: 384, height: 216, sequence }, pixels) === 'sent') {
        sent += 1
      }
    }
    expect(sent).toBe(12)
    const deadline = Date.now() + 2000
    const expected = 12 * (HTML_OVERLAY_FRAME_HEADER_BYTES + pixels.length)
    while (received < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(received).toBe(expected)
    frames.close()
  })
})

describe('the upload on the wire', () => {
  let server: Server | null = null
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  it('is one chunked POST with the admin token, carrying records back to back', async () => {
    const received: Buffer[] = []
    let requestLine = ''
    let chunked = ''
    const closed = new Promise<void>((resolve) => {
      server = createServer((request, response) => {
        requestLine = `${request.method} ${request.url}`
        chunked = String(request.headers['transfer-encoding'])
        request.on('data', (chunk: Buffer) => received.push(chunk))
        request.on('end', () => {
          response.statusCode = 204
          response.end()
          resolve()
        })
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server!.address() as AddressInfo
    const upload = openHtmlOverlayUpload({ host: '127.0.0.1', port, token: 'adm in/+' })
    const first = Buffer.alloc(16, 1)
    const second = Buffer.alloc(8, 2)
    upload.write(encodeHtmlOverlayFrameHeader({ id: BADGE, width: 2, height: 2, sequence: 1n }))
    upload.write(first)
    upload.write(encodeHtmlOverlayFrameHeader({ id: BADGE, width: 2, height: 1, sequence: 2n }))
    upload.write(second)
    upload.end()
    await closed
    expect(requestLine).toBe('POST /html-overlays/frames?token=adm%20in%2F%2B')
    expect(chunked).toBe('chunked')
    const body = Buffer.concat(received)
    expect(body.length).toBe(2 * HTML_OVERLAY_FRAME_HEADER_BYTES + first.length + second.length)
    expect(body.subarray(0, 4).toString('latin1')).toBe('VHOF')
    expect(
      body
        .subarray(HTML_OVERLAY_FRAME_HEADER_BYTES + first.length)
        .subarray(0, 4)
        .toString('latin1')
    ).toBe('VHOF')
  })
})
