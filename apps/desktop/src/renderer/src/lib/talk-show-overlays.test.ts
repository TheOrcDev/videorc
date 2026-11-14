import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import type { CloudRoomOverlayEvent, CloudStatus } from '@/lib/backend'
import { openRoom, talkStatus } from '@/lib/guests-room-fixtures'
import {
  OVERLAY_CLEAR_TOPIC,
  OVERLAY_CLEAR_VERSION,
  OVERLAY_MAX_BYTES,
  OVERLAY_MIME_TYPES,
  OVERLAY_SET_TOPIC,
  OVERLAY_SET_VERSION,
  fetchOverlayImage,
  overlayClearBody,
  overlayFraction,
  overlayImageUrl,
  overlayIsForThisRoom,
  overlaySetAttributes,
  sendOverlay,
  type OverlayImage,
  type OverlayPublisher,
  type OverlaySet
} from '@/lib/talk-show-overlays'
import { MANAGED_NODE_ID } from '@/lib/talk-show-managed'

// Plan 234 T3 (wire contract 6.3): on a managed talk show the host's
// renderer sends overlays to the room as byte streams, and the program page
// drops whatever does not read exactly as the contract says. These hold the
// sender to it: the topics, every attribute as a plain string, the clear's
// JSON body, and nothing at all on a node show.

const wire = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/cloud-managed-wire.json', import.meta.url),
    'utf8'
  )
) as {
  control: { managedNodeId: string }
  overlay: {
    topics: { set: string; clear: string }
    version: string
    clearVersion: number
    ttlMinSeconds: number
    slots: string[]
    orientations: string[]
    setAttributes: string[]
    clearBodyFields: string[]
    mimeTypes: string[]
    maxBytes: number
  }
}

/** The page's own rule for a fraction: digits, at most one point, no sign, no exponent. */
const PAGE_FRACTION = /^\d{1,4}(\.\d{1,12})?$/
const PAGE_WHOLE_SECONDS = /^\d{1,7}$/

const card: OverlaySet = {
  op: 'set',
  showId: 'sh_talk',
  slot: 'card',
  orientation: 'h',
  rect: { x: 0.05, y: 0.7, w: 0.5, h: 0.2 },
  ttlSeconds: 10,
  mimeType: 'image/png',
  imageId: 'image-card'
}
const takeover: OverlaySet = {
  op: 'set',
  showId: 'sh_talk',
  slot: 'takeover',
  orientation: 'v',
  rect: { x: 0, y: 0, w: 1, h: 1 },
  mimeType: 'image/jpeg',
  imageId: 'image-takeover'
}

type Sent = {
  topic: string
  mimeType: string
  totalSize: number
  attributes?: Record<string, string>
  chunks: Uint8Array[]
  closed: boolean
}

function publisher(): { sent: Sent[]; publisher: OverlayPublisher } {
  const sent: Sent[] = []
  return {
    sent,
    publisher: {
      streamBytes: async (options) => {
        const stream: Sent = { ...options, chunks: [], closed: false }
        sent.push(stream)
        return {
          write: async (chunk) => {
            stream.chunks.push(chunk)
          },
          close: async () => {
            stream.closed = true
          }
        }
      }
    }
  }
}

const png = (size = 12): OverlayImage => ({
  bytes: new Uint8Array(size).fill(7),
  mimeType: 'image/png'
})

function managedStatus(overrides: Partial<CloudStatus> = {}): CloudStatus {
  return talkStatus({
    show: { id: 'sh_talk', nodeId: MANAGED_NODE_ID, resumable: false, kind: 'talk' },
    room: openRoom(),
    ...overrides
  })
}

describe('the wire the program page reads (contract 6.3)', () => {
  it('uses the fixture the web pins too', () => {
    expect(OVERLAY_SET_TOPIC).toBe(wire.overlay.topics.set)
    expect(OVERLAY_CLEAR_TOPIC).toBe(wire.overlay.topics.clear)
    // Two version fields of two types: a string attribute, a JSON number.
    expect(OVERLAY_SET_VERSION).toBe(wire.overlay.version)
    expect(OVERLAY_CLEAR_VERSION).toBe(wire.overlay.clearVersion)
    expect(OVERLAY_MAX_BYTES).toBe(wire.overlay.maxBytes)
    expect([...OVERLAY_MIME_TYPES]).toEqual(wire.overlay.mimeTypes)
    expect(MANAGED_NODE_ID).toBe(wire.control.managedNodeId)
  })

  it('writes a fraction in plain decimals from 0 to 1, never with an exponent', () => {
    expect(overlayFraction(0.05)).toBe('0.050000')
    expect(overlayFraction(1)).toBe('1.000000')
    expect(overlayFraction(1 / 3)).toBe('0.333333')
    // JavaScript prints this as `1e-7`, which the page refuses.
    expect(String(0.0000001)).toBe('1e-7')
    expect(overlayFraction(0.0000001)).toBe('0.000000')
    // Out of the canvas, or not a number at all: clamped.
    expect(overlayFraction(1.2)).toBe('1.000000')
    expect(overlayFraction(-0.4)).toBe('0.000000')
    expect(overlayFraction(Number.NaN)).toBe('0.000000')
    expect(overlayFraction(Number.POSITIVE_INFINITY)).toBe('0.000000')
    for (const value of [0, 1e-9, 0.123456789, 0.5, 0.999999999, 1, 7, 1e21]) {
      expect(overlayFraction(value)).toMatch(PAGE_FRACTION)
    }
  })

  it('gives a card its attributes as strings, with a whole ttl of 1 or more', () => {
    const attributes = overlaySetAttributes(card)
    expect(attributes).toEqual({
      v: '1',
      slot: 'card',
      o: 'h',
      x: '0.050000',
      y: '0.700000',
      w: '0.500000',
      h: '0.200000',
      ttl: '10'
    })
    expect(Object.keys(attributes).sort()).toEqual([...wire.overlay.setAttributes].sort())
    for (const value of Object.values(attributes)) expect(typeof value).toBe('string')
    for (const seconds of [0, 0.4, 1, 9.6, 3600]) {
      const ttl = overlaySetAttributes({ ...card, ttlSeconds: seconds }).ttl
      expect(ttl).toMatch(PAGE_WHOLE_SECONDS)
      expect(Number(ttl)).toBeGreaterThanOrEqual(wire.overlay.ttlMinSeconds)
    }
    expect(overlaySetAttributes({ ...card, ttlSeconds: 9.6 }).ttl).toBe('10')
  })

  it('gives an untimed overlay no ttl at all', () => {
    const attributes = overlaySetAttributes(takeover)
    expect('ttl' in attributes).toBe(false)
    expect(attributes).toMatchObject({ v: '1', slot: 'takeover', o: 'v', w: '1.000000' })
    expect(wire.overlay.slots).toContain(attributes.slot)
    expect(wire.overlay.orientations).toContain(attributes.o)
  })

  it('writes the clear as UTF-8 JSON with the number 1 as its version', () => {
    const body = overlayClearBody({
      op: 'clear',
      showId: 'sh_talk',
      slot: 'takeover',
      orientation: 'h'
    })
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as Record<
      string,
      unknown
    >
    expect(parsed).toEqual({ v: 1, slot: 'takeover', o: 'h' })
    expect(Object.keys(parsed).sort()).toEqual([...wire.overlay.clearBodyFields].sort())
    expect(body.byteLength).toBeLessThanOrEqual(256)
  })
})

describe('sending an overlay to the room', () => {
  it('streams the picture on the set topic with its type, size and attributes', async () => {
    const room = publisher()
    const image = vi.fn(async () => png(4096))
    await expect(sendOverlay(card, { publisher: room.publisher, image })).resolves.toBe('sent')
    expect(image).toHaveBeenCalledWith('image-card')
    expect(room.sent).toHaveLength(1)
    const [stream] = room.sent
    expect(stream.topic).toBe('videorc.overlay.set')
    expect(stream.mimeType).toBe('image/png')
    expect(stream.totalSize).toBe(4096)
    expect(stream.attributes).toEqual(overlaySetAttributes(card))
    expect(stream.chunks).toHaveLength(1)
    expect(stream.chunks[0].byteLength).toBe(4096)
    expect(stream.closed).toBe(true)
  })

  it("carries the event's own type for a picture that left as a JPEG", async () => {
    const room = publisher()
    await sendOverlay(takeover, {
      publisher: room.publisher,
      image: async () => ({ bytes: new Uint8Array(8), mimeType: 'application/octet-stream' })
    })
    expect(room.sent[0].mimeType).toBe('image/jpeg')
    expect(room.sent[0].attributes?.ttl).toBeUndefined()
  })

  it('streams a clear on the clear topic, as a body and no attributes', async () => {
    const room = publisher()
    const image = vi.fn(async () => png())
    const clear: CloudRoomOverlayEvent = {
      op: 'clear',
      showId: 'sh_talk',
      slot: 'card',
      orientation: 'v'
    }
    await expect(sendOverlay(clear, { publisher: room.publisher, image })).resolves.toBe('sent')
    expect(image).not.toHaveBeenCalled()
    const [stream] = room.sent
    expect(stream.topic).toBe('videorc.overlay.clear')
    expect(stream.attributes).toBeUndefined()
    expect(JSON.parse(new TextDecoder().decode(stream.chunks[0]))).toEqual({
      v: 1,
      slot: 'card',
      o: 'v'
    })
    expect(stream.totalSize).toBe(stream.chunks[0].byteLength)
    expect(stream.closed).toBe(true)
  })

  it('sends the same hand-off again when the backend repeats it (a program page joined)', async () => {
    // The backend keeps what is up and hands the untimed overlays over again
    // when `room.pageJoins` grows; the sender remembers nothing, so the same
    // event is simply sent again, with the same bytes.
    const room = publisher()
    const image = vi.fn(async () => png(64))
    await sendOverlay(takeover, { publisher: room.publisher, image })
    await sendOverlay(takeover, { publisher: room.publisher, image })
    expect(room.sent).toHaveLength(2)
    expect(room.sent[1].attributes).toEqual(room.sent[0].attributes)
    expect(image).toHaveBeenCalledTimes(2)
  })

  it('sends nothing for an overlay that already came down', async () => {
    const room = publisher()
    await expect(
      sendOverlay(card, { publisher: room.publisher, image: async () => null })
    ).resolves.toBe('gone')
    expect(room.sent).toHaveLength(0)
  })

  it('sends nothing the page would drop: no bytes, over 2 MiB, or not an image it takes', async () => {
    const room = publisher()
    const attempt = (image: OverlayImage, event: OverlaySet = card) =>
      sendOverlay(event, { publisher: room.publisher, image: async () => image })
    await expect(attempt(png(0))).resolves.toBe('refused')
    await expect(attempt(png(OVERLAY_MAX_BYTES + 1))).resolves.toBe('refused')
    await expect(
      attempt(
        { bytes: new Uint8Array(4), mimeType: 'image/gif' },
        { ...card, mimeType: 'image/gif' }
      )
    ).resolves.toBe('refused')
    expect(room.sent).toHaveLength(0)
    await expect(attempt(png(OVERLAY_MAX_BYTES))).resolves.toBe('sent')
  })
})

describe('whose overlays these are', () => {
  it('sends nothing on a node show: its runner takes overlays from the backend', () => {
    const node = talkStatus({
      show: { id: 'sh_talk', nodeId: 'eu-hel-1', resumable: false, kind: 'talk' },
      room: openRoom()
    })
    expect(overlayIsForThisRoom(card, node, 'open')).toBe(false)
    expect(overlayIsForThisRoom(card, null, 'open')).toBe(false)
  })

  it("sends a managed show's overlays while its room is open, and only its own", () => {
    expect(overlayIsForThisRoom(card, managedStatus(), 'open')).toBe(true)
    expect(overlayIsForThisRoom(card, managedStatus(), 'closing')).toBe(false)
    expect(overlayIsForThisRoom(card, managedStatus(), 'closed')).toBe(false)
    expect(overlayIsForThisRoom({ ...card, showId: 'sh_other' }, managedStatus(), 'open')).toBe(
      false
    )
  })

  it("fetches the bytes from the backend's HTTP server with its token", async () => {
    const url = overlayImageUrl({ host: '127.0.0.1', port: 4620, token: 'tok en' }, 'a/b')
    expect(url).toBe('http://127.0.0.1:4620/cloud/overlays/a%2Fb?token=tok+en')
    const found = await fetchOverlayImage(url, async (target) => {
      expect(target).toBe(url)
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png; charset=binary' }
      })
    })
    expect(found?.mimeType).toBe('image/png')
    expect([...(found?.bytes ?? [])]).toEqual([1, 2, 3])
    // An overlay that came down meanwhile is not there any more.
    await expect(
      fetchOverlayImage(url, async () => new Response(null, { status: 404 }))
    ).resolves.toBeNull()
  })
})
