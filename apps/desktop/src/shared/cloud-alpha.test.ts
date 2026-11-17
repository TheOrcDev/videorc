import { describe, expect, it } from 'vitest'
import {
  ALPHA_EXPERIMENT,
  ALPHA_PRODUCTION_ENABLED,
  ALPHA_ROLE,
  blendPixel,
  packedSize,
  packedUv,
  parseAlphaManifest,
  stampBits,
  stampLatency,
  type AlphaAuthority
} from './cloud-alpha'

describe('disabled packed alpha transport', () => {
  const authority: AlphaAuthority = {
    experiment: ALPHA_EXPERIMENT,
    show: 'sh_fixture',
    hostIdentity: 'host:sh_fixture',
    publisherSid: 'PA_host',
    trackSid: 'TR_alpha',
    epoch: 'epoch1',
    generation: 1,
    source: 'camera',
    canPublishSources: ['camera'],
    output: 'stream',
    orientation: 'h'
  }
  const value = {
    ...authority,
    version: 1,
    role: ALPHA_ROLE,
    packing: 'rgb-left-alpha-right',
    width: 640,
    height: 360,
    fps: 30,
    expiresAt: 30000,
    rect: { x: 0.1, y: 0.7, w: 0.8, h: 0.2 }
  }
  it('never enables production and fences ownership and lanes', () => {
    expect(ALPHA_PRODUCTION_ENABLED).toBe(false)
    expect(parseAlphaManifest(value, authority, 1000)).not.toBeNull()
    for (const change of [
      { trackSid: 'TR_other' },
      { publisherSid: 'PA_old' },
      { epoch: 'old' },
      { generation: 2 },
      { output: 'recording' },
      { orientation: 'v' },
      { expiresAt: 1000 }
    ])
      expect(parseAlphaManifest({ ...value, ...change }, authority, 1000)).toBeNull()
    expect(parseAlphaManifest(value, { ...authority, hostIdentity: 'guest:1' }, 1000)).toBeNull()
    expect(parseAlphaManifest(value, { ...authority, canPublishSources: [] }, 1000)).toBeNull()
  })
  it('bounds both plane textures and samples away from chroma edges', () => {
    expect(packedSize(640, 360)).toEqual({ width: 1288, height: 360 })
    expect(packedSize(360, 640)).toEqual({ width: 728, height: 640 })
    expect(() => packedSize(640, 640)).toThrow()
    expect(packedUv(0, 0, 640, 360, true).u).toBeGreaterThan(648 / 1288)
  })
  it('keeps transparent/half/solid pixels and checked latency semantics', () => {
    expect(blendPixel([0, 255, 0], 128, [32, 64, 96])).toEqual([16, 160, 48])
    expect(blendPixel([255, 0, 255], 0, [32, 64, 96])).toEqual([32, 64, 96])
    const pixels = stampBits(123456).map((v) => (v ? 245 : 10))
    expect(stampLatency(pixels, 123556)).toBe(100)
    pixels[24] = pixels[24] === 245 ? 10 : 245
    expect(stampLatency(pixels, 123556)).toBeNull()
  })
})
