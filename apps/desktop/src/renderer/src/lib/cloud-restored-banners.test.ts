import { describe, expect, it } from 'vitest'
import { restoredGraphicsContent } from './cloud-presentation-restore'
import { withRestoredBanners } from './cloud-restored-banners'
import type { GraphicsContent } from '../../../shared/cloud-graphics'

const rect = { x: 0.05, y: 0.05, w: 0.3, h: 0.1 }
const asset = (hash: string) => ({ hash, width: 320, height: 90, png: 'iVBORw0KGgo=' })
const banner = (id: string, opacity = 0.8) => ({
  id,
  kind: 'banner',
  rect,
  opacity,
  asset: asset(id.padEnd(64, 'a'))
})

describe('restored banners after a takeover (plan 249 S24 with S9)', () => {
  it('puts back kept banners per output, at rest, under the controller output flags', () => {
    const content = restoredGraphicsContent({
      outputs: { banners: { stream: true, recording: false } },
      views: [
        {
          topic: 'static',
          output: 'stream',
          orientation: 'h',
          layers: [banner('banner:a')],
          cleared: [{ id: 'chat', kind: 'chat', reason: 'desktop-live-source' }]
        },
        {
          topic: 'static',
          output: 'recording',
          orientation: 'h',
          layers: [banner('banner:a'), banner('banner:b')]
        },
        { topic: 'avatar', output: 'stream', orientation: 'h', layers: [banner('x')] }
      ]
    })
    // Recording banners are off on this controller: only the stream's come back.
    expect(content?.h.map((l) => [l.id, l.stream, l.recording, l.fade, l.expiresAt])).toEqual([
      ['banner:a', true, false, null, null]
    ])
    expect(content?.h[0]?.opacity).toBe(0.8)
    expect(content?.v).toEqual([])
  })
  it('keeps at most four, and nothing without its pixels', () => {
    const many = Array.from({ length: 6 }, (_, i) => banner(`banner:${i}`))
    const content = restoredGraphicsContent({
      views: [{ topic: 'static', output: 'stream', orientation: 'v', layers: many }]
    })
    expect(content?.v).toHaveLength(4)
    const { png: _png, ...noPixels } = asset('b'.repeat(64))
    expect(
      restoredGraphicsContent({
        views: [
          {
            topic: 'static',
            output: 'stream',
            orientation: 'h',
            layers: [{ ...banner('banner:z'), asset: noPixels }]
          }
        ]
      })
    ).toBeNull()
  })
  it('fills only an orientation where this computer shows no banner; its own always win', () => {
    const restored = restoredGraphicsContent({
      views: [
        { topic: 'static', output: 'stream', orientation: 'h', layers: [banner('banner:kept')] },
        { topic: 'static', output: 'stream', orientation: 'v', layers: [banner('banner:kept')] }
      ]
    })
    const own = (id: string) =>
      ({
        ...banner(id),
        kind: 'banner',
        asset: { ...asset(id.padEnd(64, 'c')) },
        fade: null,
        expiresAt: null,
        stream: true,
        recording: true
      }) as GraphicsContent['h'][number]
    const chat = { ...own('chat'), kind: 'chat' } as GraphicsContent['h'][number]
    const merged = withRestoredBanners(
      { h: [own('banner:mine')], v: [chat], unsupported: [] },
      restored
    )
    expect(merged.h.map((l) => l.id)).toEqual(['banner:mine'])
    expect(merged.v.map((l) => l.id)).toEqual(['banner:kept', 'chat'])
    const local: GraphicsContent = { h: [], v: [], unsupported: ['x'] }
    expect(withRestoredBanners(local, null)).toBe(local)
  })
})
