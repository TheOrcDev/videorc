import { describe, expect, it, vi } from 'vitest'
import type { EffectiveSceneBackground } from './backend'
import { createRoomBackgrounds, pictureSize } from './room-background'
import { liveBackgroundPhase } from '../../../shared/cloud-background'

const base: EffectiveSceneBackground = {
  assetId: 'beach',
  managedAssetPath: 'videorc-asset://background/beach.webp',
  fit: 'fill',
  scale: 150,
  offsetX: 40,
  offsetY: -20,
  blurPx: 0,
  dimPercent: 30,
  saturationPercent: 100,
  vignettePercent: 0,
  visibilityPercent: 20
}
const make = () => {
  let now = 1_800_000_000_000
  const encodePicture = vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/webp' as const,
    width: 2560,
    height: 1440
  }))
  const backgrounds = createRoomBackgrounds({
    clockSpec: (id, look) =>
      id === 'silk' && look === 'satin' ? { rate: 0.5, posterPhase: 3 } : null,
    encodePicture,
    digest: async () => new Uint8Array(32).fill(0xab).buffer,
    now: () => now
  })
  return { backgrounds, encodePicture, advance: (ms: number) => (now += ms), now: () => now }
}

describe('S14 room background preparation', () => {
  it('a picture is encoded once, named by its hash, with the native zoom crop and fit', async () => {
    const h = make()
    const first = await h.backgrounds.prepare(base)
    const again = await h.backgrounds.prepare(base)
    expect(h.encodePicture).toHaveBeenCalledTimes(1)
    expect(first.background).toEqual({
      kind: 'picture',
      hash: 'ab'.repeat(32),
      mime: 'image/webp',
      width: 2560,
      height: 1440,
      fit: 'cover',
      crop: expect.objectContaining({ l: expect.any(Number) })
    })
    expect(first.asset?.hash).toBe('ab'.repeat(32))
    expect(again.background).toEqual(first.background)
    expect((await h.backgrounds.prepare({ ...base, fit: 'fit' })).background).toMatchObject({
      fit: 'contain'
    })
  })
  it('a live background carries its look, Dim and one clock that never jumps', async () => {
    const h = make()
    const live = {
      ...base,
      live: { id: 'silk' as const, look: 'satin', motion: 'normal' as const }
    }
    const first = await h.backgrounds.prepare(live)
    expect(first.asset).toBeUndefined()
    expect(first.background).toMatchObject({ kind: 'live', id: 'silk', look: 'satin', dim: 0.3 })
    if (first.background.kind !== 'live') throw new Error('live')
    expect(first.background.clock).toEqual({ anchorAt: h.now(), anchorPhase: 3, rate: 0.5 })
    h.advance(4000)
    const calm = await h.backgrounds.prepare({ ...live, live: { ...live.live, motion: 'calm' } })
    if (calm.background.kind !== 'live') throw new Error('live')
    expect(calm.background.clock.rate).toBe(0.25)
    expect(liveBackgroundPhase(calm.background.clock, h.now())).toBeCloseTo(
      liveBackgroundPhase(first.background.clock, h.now()),
      12
    )
  })
  it('an unknown look is refused, not drawn as another', async () => {
    const h = make()
    await expect(
      h.backgrounds.prepare({ ...base, live: { id: 'silk', look: 'nope', motion: 'normal' } })
    ).rejects.toThrow(/look/)
  })
  it('draws pictures down to the sent size, keeping the aspect', () => {
    expect(pictureSize(5120, 2880)).toEqual({ width: 2560, height: 1440 })
    expect(pictureSize(1000, 4000)).toEqual({ width: 640, height: 2560 })
    expect(pictureSize(800, 600)).toEqual({ width: 800, height: 600 })
  })
})
