import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, RoomEvent, Track, type Room } from 'livekit-client'
import {
  htmlLayerFade,
  htmlLayerFrameUrl,
  htmlLaneLayers,
  RoomHtmlLayerPublisher,
  type HtmlLayerSurface,
  type RoomHtmlLayerStatus
} from './room-html-layer-publisher'
import { CAPABILITY_TOPIC } from './room-media-v2'
import { HTML_LAYER_TOPIC, htmlLayerTrackName } from '../../../shared/cloud-html-layer'
import type { HtmlBannerPlacement } from '../../../shared/cloud-graphics'

const placement = (id: string, over: Partial<HtmlBannerPlacement> = {}): HtmlBannerPlacement => ({
  id: `banner:${id}`,
  bannerId: id,
  rect: { x: 0.1, y: 0.6, w: 0.4, h: 0.3 },
  opacity: 1,
  fade: null,
  stream: true,
  recording: true,
  ...over
})

function harness(epoch: { value: number | null } = { value: 3 }) {
  const sent: { identity: string; manifest: Record<string, unknown> }[] = []
  let sids = 0
  const published: { name: string; source: unknown; trackSid: string; track: unknown }[] = []
  const unpublished: unknown[] = []
  const room = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    name: 'sh_html',
    localParticipant: {
      sid: 'PA_host',
      publishTrack: vi.fn(async (track: unknown, options: { name: string; source: unknown }) => {
        const publication = {
          trackSid: `TR_s${++sids}`,
          track,
          name: options.name,
          source: options.source
        }
        published.push(publication)
        return publication
      }),
      unpublishTrack: vi.fn(async (track: unknown) => {
        unpublished.push(track)
      }),
      streamBytes: vi.fn(async (options: { destinationIdentities: string[]; topic: string }) => ({
        write: async (bytes: Uint8Array) => {
          if (options.topic === HTML_LAYER_TOPIC)
            sent.push({
              identity: options.destinationIdentities[0]!,
              manifest: JSON.parse(new TextDecoder().decode(bytes))
            })
        },
        close: async () => {}
      }))
    },
    remoteParticipants: new Map([
      ['EG_stream', { identity: 'EG_stream', sid: 'PA_stream' }],
      ['EG_record', { identity: 'EG_record', sid: 'PA_record' }],
      ['EG_v', { identity: 'EG_v', sid: 'PA_v' }],
      ['g_guest', { identity: 'g_guest', sid: 'PA_guest' }]
    ])
  })
  const surfaces: { closed: boolean; drawn: unknown[][] }[] = []
  const wants: boolean[] = []
  const statuses: RoomHtmlLayerStatus[] = []
  const fetched: string[] = []
  const publisher = new RoomHtmlLayerPublisher(room as unknown as Room, {
    frameUrl: (id, after) => `frame:${id}:${after?.sequence ?? 0}`,
    want: async (want) => {
      wants.push(want)
    },
    controllerEpoch: () => epoch.value,
    changed: (status) => statuses.push(status),
    fetch: async (url) => {
      fetched.push(url)
      return new Response(new Uint8Array(8), {
        status: 200,
        headers: {
          'x-videorc-frame-generation': 'g',
          'x-videorc-frame-sequence': '1',
          'content-length': '8'
        }
      })
    },
    decode: async () => ({ close: () => {}, width: 10, height: 10 }) as unknown as ImageBitmap,
    surface: () => {
      const surface = { closed: false, drawn: [] as unknown[][] }
      surfaces.push(surface)
      const result: HtmlLayerSurface = {
        context: {
          clearRect() {},
          drawImage: (...args: unknown[]) => surface.drawn.push(args),
          globalAlpha: 1
        } as unknown as CanvasRenderingContext2D,
        pack: () => true,
        track: { kind: 'video', requestFrame() {} } as unknown as HtmlLayerSurface['track'],
        close: () => {
          surface.closed = true
        }
      }
      return result
    }
  })
  const receipt = (identity: string, html: unknown, participant?: unknown) =>
    room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(
        JSON.stringify({
          v: 2,
          identity,
          participantSid: room.remoteParticipants.get(identity)?.sid ?? 'PA_none',
          at: Date.now(),
          ...(html ? { html } : {})
        })
      ),
      participant,
      undefined,
      CAPABILITY_TOPIC
    )
  return {
    room,
    publisher,
    sent,
    published,
    unpublished,
    surfaces,
    wants,
    statuses,
    receipt,
    fetched
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

describe('Plan 249 S11 room HTML layer publisher (gated)', () => {
  it('publishes nothing without an html receipt; guests and participant-sent receipts never ask', async () => {
    const h = harness()
    h.publisher.setPlacements({ h: [placement('a')], v: [] })
    h.receipt('EG_stream', undefined)
    h.receipt('g_guest', { version: 1, output: 'stream', orientation: 'h' })
    h.receipt(
      'EG_stream',
      { version: 1, output: 'stream', orientation: 'h' },
      { identity: 'EG_stream' }
    )
    await settle()
    expect(h.published).toHaveLength(0)
    expect(h.wants).not.toContain(true)
    await h.publisher.close()
  })

  it('a relayed receipt gets one CAMERA sheet named for its role, the room targets, and a manifest with the S24 epoch', async () => {
    const h = harness()
    h.publisher.setPlacements({ h: [placement('a'), placement('rec', { stream: false })], v: [] })
    h.receipt('EG_stream', { version: 1, output: 'stream', orientation: 'h' })
    await settle()
    expect(h.published).toHaveLength(1)
    expect(h.published[0]!.name).toBe(htmlLayerTrackName('h', 1))
    expect(h.published[0]!.source).toBe(Track.Source.Camera)
    expect(h.wants).toEqual([true])
    const m = h.sent.at(-1)!
    expect(m.identity).toBe('EG_stream')
    expect(m.manifest).toMatchObject({
      role: 'videorc:html-layer:v1',
      show: 'sh_html',
      publisherSid: 'PA_host',
      trackSid: 'TR_s1',
      generation: 1,
      controllerEpoch: 3,
      output: 'stream',
      orientation: 'h',
      width: 640,
      height: 360,
      fps: 15
    })
    // A recording-only banner never reaches a stream lane's sheet.
    expect((m.manifest.layers as { id: string }[]).map((l) => l.id)).toEqual(['banner:a'])
    await h.publisher.close()
    expect(h.unpublished).toHaveLength(1)
    expect(h.surfaces[0]!.closed).toBe(true)
    expect(h.wants.at(-1)).toBe(false)
  })

  it('lanes with the same layers share a sheet; more than two sheets refuse the extra lanes', async () => {
    const h = harness()
    h.publisher.setPlacements({
      h: [placement('a'), placement('rec', { stream: false })],
      v: [placement('a')]
    })
    h.receipt('EG_stream', { version: 1, output: 'stream', orientation: 'h' })
    h.receipt('EG_record', { version: 1, output: 'recording', orientation: 'h' })
    h.receipt('EG_v', { version: 1, output: 'stream', orientation: 'v' })
    await settle()
    expect(h.published).toHaveLength(2)
    expect(h.statuses.at(-1)?.refused).toBe(1)
    expect(h.statuses.at(-1)?.productionQualified).toBe(false)
    await h.publisher.close()
  })

  it('no controller epoch (another device, or devices held) unpublishes everything', async () => {
    const epoch = { value: 2 as number | null }
    const h = harness(epoch)
    h.publisher.setPlacements({ h: [placement('a')], v: [] })
    h.receipt('EG_stream', { version: 1, output: 'stream', orientation: 'h' })
    await settle()
    expect(h.published).toHaveLength(1)
    epoch.value = null
    h.publisher.setPlacements({ h: [placement('a')], v: [] })
    await settle()
    expect(h.unpublished).toHaveLength(1)
    expect(h.wants.at(-1)).toBe(false)
    await h.publisher.close()
  })

  it('Hide (the banner fades out) unpublishes the sheet; a room loss forgets every receipt', async () => {
    const h = harness()
    h.publisher.setPlacements({ h: [placement('a')], v: [] })
    h.receipt('EG_stream', { version: 1, output: 'stream', orientation: 'h' })
    await settle()
    h.publisher.setPlacements({
      h: [placement('a', { fade: { at: Date.now() - 1000, from: 1, to: 0 } })],
      v: []
    })
    await settle()
    expect(h.unpublished).toHaveLength(1)
    h.publisher.setPlacements({ h: [placement('a')], v: [] })
    await settle()
    expect(h.published).toHaveLength(2)
    h.room.emit(RoomEvent.Reconnecting)
    await settle()
    expect(h.unpublished).toHaveLength(2)
    await h.publisher.close()
  })

  it('reads each banner frame with one request in flight and draws it into its rect at its opacity', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.publisher.setPlacements({ h: [placement('a', { opacity: 0.5 })], v: [] })
    h.receipt('EG_stream', { version: 1, output: 'stream', orientation: 'h' })
    await vi.advanceTimersByTimeAsync(10)
    expect(h.published).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.fetched[0]).toBe('frame:a:0')
    expect(
      h.fetched.some((u) => u === 'frame:a:1'),
      'the next read asks after the last frame'
    ).toBe(true)
    const drawn = h.surfaces[0]!.drawn.at(-1)!
    expect(drawn.slice(1)).toEqual([64, 216, 256, 108])
    await h.publisher.close()
  })

  it('pure helpers: fade, lane layers and the token-gated frame URL', () => {
    expect(htmlLayerFade(null, 0)).toBe(1)
    expect(htmlLayerFade({ at: 0, from: 1, to: 0 }, 200)).toBe(0)
    expect(htmlLayerFade({ at: 0, from: 0, to: 1 }, 100)).toBeCloseTo(0.875)
    expect(
      htmlLaneLayers(
        { h: [placement('a'), placement('b', { opacity: 0 })], v: [] },
        { output: 'stream', orientation: 'h' },
        0
      ).map((l) => l.bannerId)
    ).toEqual(['a'])
    expect(
      htmlLayerFrameUrl({ host: '127.0.0.1', port: 9, token: 't' }, 'b1', {
        generation: 'b1',
        sequence: 4
      })
    ).toBe(
      'http://127.0.0.1:9/preview/html-overlay/latest.bmp?token=t&id=b1&afterGeneration=b1&afterSequence=4'
    )
  })
})
