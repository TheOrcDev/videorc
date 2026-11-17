import { describe, expect, it } from 'vitest'
import fixture from '../../../../protocol-fixtures/cloud-html-layer.json'
import {
  HTML_LAYER_PRODUCTION_QUALIFIED,
  HTML_LAYER_SHEET,
  htmlLayerAuthorized,
  htmlLayerPixels,
  htmlLayerTrackName,
  isHtmlLayerTrackName,
  parseHtmlLayerManifest
} from './cloud-html-layer'
import { parseGraphicsSource, parseHtmlBannerPlacements } from './cloud-graphics'
import { alphaDimensions, packedSize } from './cloud-alpha'

type Mutation = { name: string; set?: Record<string, unknown>; delete?: string[] }
const page = fixture.page as {
  show: string
  output: 'stream' | 'recording'
  orientation: 'h' | 'v'
  now: number
}
const mutate = (m: Mutation) => {
  const value = structuredClone(fixture.valid) as Record<string, unknown>
  for (const [key, next] of Object.entries(m.set ?? {})) value[key] = next
  for (const key of m.delete ?? []) delete value[key]
  return value
}

describe('Plan 249 S11 HTML layer protocol (shared with web)', () => {
  it('stays unqualified and reuses S10 packing for both sheets', () => {
    expect(HTML_LAYER_PRODUCTION_QUALIFIED).toBe(false)
    for (const o of ['h', 'v'] as const) {
      const { width, height } = HTML_LAYER_SHEET[o]
      expect(alphaDimensions(width, height)).toBe(true)
    }
    expect(packedSize(640, 360)).toEqual({ width: 1288, height: 360 })
  })
  it('parses the shared valid manifest and refuses all 23 mutations, like the web', () => {
    const manifest = parseHtmlLayerManifest(fixture.valid, page)
    expect(manifest?.layers).toHaveLength(2)
    expect(fixture.invalid).toHaveLength(23)
    for (const m of fixture.invalid as Mutation[])
      expect(parseHtmlLayerManifest(mutate(m), page), m.name).toBeNull()
  })
  it('authorizes only from SFU facts; a sheet name is never a camera', () => {
    const m = parseHtmlLayerManifest(fixture.valid, page)!
    const publication = {
      trackSid: m.trackSid,
      trackName: htmlLayerTrackName('h', m.generation),
      source: 'camera'
    }
    expect(htmlLayerAuthorized(m, { hostSid: m.publisherSid, publication })).toBe(true)
    expect(htmlLayerAuthorized(m, { hostSid: 'PA_x', publication })).toBe(false)
    expect(
      htmlLayerAuthorized(m, {
        hostSid: m.publisherSid,
        publication: { ...publication, trackName: 'x' }
      })
    ).toBe(false)
    expect(isHtmlLayerTrackName(htmlLayerTrackName('v', 9))).toBe(true)
    expect(isHtmlLayerTrackName('videorc:v2:host-aux:stereo')).toBe(false)
    expect(
      htmlLayerPixels({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { width: 640, height: 360 })
    ).toEqual({
      x: 320,
      y: 180,
      w: 320,
      h: 180
    })
  })
  it('reads HTML banner placements from the graphics snapshot, bounded and fail-closed', () => {
    const lane = {
      id: 'banner:b1',
      bannerId: 'b1',
      rect: { x: 0.1, y: 0.7, w: 0.3, h: 0.2 },
      opacity: 1,
      fade: { at: 5, from: 0, to: 1 },
      stream: true,
      recording: false
    }
    expect(parseHtmlBannerPlacements({ h: [lane], v: [] })?.h[0]).toEqual(lane)
    expect(parseHtmlBannerPlacements({ h: [{ ...lane, id: 'banner:other' }], v: [] })).toBeNull()
    expect(
      parseHtmlBannerPlacements({ h: Array.from({ length: 5 }, () => lane), v: [] })
    ).toBeNull()
    expect(parseHtmlBannerPlacements({ h: [{ ...lane, bannerId: '../b' }], v: [] })).toBeNull()
    const source = parseGraphicsSource({
      signature: 'a'.repeat(64),
      content: { h: [], v: [], unsupported: [], html: { h: [lane], v: [] } }
    })
    expect(source?.content?.html?.h).toHaveLength(1)
    expect(
      parseGraphicsSource({
        signature: 'a'.repeat(64),
        content: { h: [], v: [], unsupported: [], html: { h: 'x', v: [] } }
      })
    ).toBeNull()
  })
})
