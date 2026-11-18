import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_ASSET_MAX_BYTES,
  BackgroundAssetCache,
  CLOUD_BACKGROUND_PRODUCTION_QUALIFIED,
  LIVE_BACKGROUND_IDS,
  backgroundFit,
  backgroundKey,
  backgroundZoomCrop,
  decodeBackgroundAsset,
  encodeBackgroundAsset,
  hexOf,
  liveBackgroundDim,
  liveBackgroundPhase,
  nextLiveClock,
  parseBackgroundCapability,
  parseSceneBackground,
  type BackgroundAssetHeader
} from './cloud-background'
import { parseCloudScene, parseSceneCapability, sceneContentKey } from './cloud-scene'
import catalog from './live-backgrounds.catalog.generated.json'
import fixture from '../../../../protocol-fixtures/cloud-parity-background.json'

const here = __dirname
const sha = (name: string): string =>
  createHash('sha256')
    .update(readFileSync(join(here, name)))
    .digest('hex')

describe('S14 scene background vectors (mirrored in the web program)', () => {
  it.each(fixture.zoom)('zoom crop $scale/$offsetX/$offsetY like Rust', (one) => {
    const crop = backgroundZoomCrop(one.scale, one.offsetX, one.offsetY)
    for (const side of ['l', 't', 'r', 'b'] as const)
      expect(crop[side]).toBeCloseTo(one.expected[side], 12)
  })
  it('fits like the compositor: only fit contains', () => {
    for (const one of fixture.fit) expect(backgroundFit(one.fit)).toBe(one.expected)
  })
  it('dims like the live runtime (0..0.8)', () => {
    for (const one of fixture.dim) expect(liveBackgroundDim(one.dimPercent)).toBe(one.expected)
  })
  it('keeps one phase clock for every lane', () => {
    for (const one of fixture.phase)
      expect(liveBackgroundPhase(one.clock, one.now)).toBeCloseTo(one.expected, 12)
  })
  it.each(fixture.nextClock)('clock: $name', (one) => {
    expect(nextLiveClock(one.previous, one.next, one.now)).toEqual(one.expected)
  })
  it('a re-based clock never jumps', () => {
    const before = { anchorAt: 1000, anchorPhase: 3, rate: 0.5 }
    const after = nextLiveClock(
      { id: 'silk', clock: before },
      { id: 'silk', rate: 0.25, posterPhase: 3 },
      5000
    )
    expect(liveBackgroundPhase(after, 5000)).toBeCloseTo(liveBackgroundPhase(before, 5000), 12)
  })
  it.each(fixture.valid)('parses and keys $background.kind', (one) => {
    expect(parseSceneBackground(one.background)).toEqual(one.background)
    expect(backgroundKey(parseSceneBackground(one.background))).toBe(one.key)
  })
  it('refuses every invalid background', () => {
    for (const one of fixture.invalid) expect(parseSceneBackground(one)).toBeNull()
  })
  it('parses page capabilities', () => {
    for (const one of fixture.capability.valid) expect(parseBackgroundCapability(one)).toEqual(one)
    for (const one of fixture.capability.invalid) expect(parseBackgroundCapability(one)).toBeNull()
  })
  it('keeps the S12 key of a scene without a background', () => {
    const { scene } = fixture.sceneKey
    expect(sceneContentKey(scene as never)).toBe(fixture.sceneKey.withoutBackground)
    const picture = fixture.valid[0]!.background
    const live = fixture.valid[1]!.background
    expect(sceneContentKey({ ...scene, background: picture } as never)).toBe(
      fixture.sceneKey.withPicture
    )
    expect(sceneContentKey({ ...scene, background: live } as never)).toBe(fixture.sceneKey.withLive)
  })
  it('carries a background inside a scene; an invalid one refuses the scene', () => {
    const { scene } = fixture.sceneKey
    const live = fixture.valid[1]!.background
    expect(parseCloudScene({ ...scene, background: live })?.background).toEqual(live)
    expect(parseCloudScene(scene)).not.toHaveProperty('background')
    expect(parseCloudScene({ ...scene, background: fixture.invalid[0] })).toBeNull()
  })
  it('keeps the background capability inside the scene capability', () => {
    const background = fixture.capability.valid[1]
    expect(
      parseSceneCapability({ version: 1, output: 'stream', orientation: 'h', background })
    ).toEqual({ version: 1, output: 'stream', orientation: 'h', background })
    expect(
      parseSceneCapability({
        version: 1,
        output: 'stream',
        orientation: 'h',
        background: fixture.capability.invalid[0]
      })
    ).toBeNull()
  })
  it('frames an asset message byte for byte', () => {
    const header = fixture.asset.header as BackgroundAssetHeader
    const image = Uint8Array.from(Buffer.from(fixture.asset.imageHex, 'hex'))
    expect(Buffer.from(encodeBackgroundAsset(header, image)).toString('hex')).toBe(
      fixture.asset.messageHex
    )
    const decoded = decodeBackgroundAsset(
      Uint8Array.from(Buffer.from(fixture.asset.messageHex, 'hex')),
      fixture.page
    )
    expect(decoded?.header).toEqual(header)
    expect(Buffer.from(decoded!.image).toString('hex')).toBe(fixture.asset.imageHex)
  })
  it('refuses an asset for another show, sender or size', () => {
    const message = Uint8Array.from(Buffer.from(fixture.asset.messageHex, 'hex'))
    expect(decodeBackgroundAsset(message, { ...fixture.page, show: 'sh_y' })).toBeNull()
    expect(decodeBackgroundAsset(message, { ...fixture.page, publisherSid: 'PA_other' })).toBeNull()
    expect(decodeBackgroundAsset(message.subarray(0, message.length - 1), fixture.page)).toBeNull()
    const header = { ...(fixture.asset.header as BackgroundAssetHeader) }
    expect(() =>
      encodeBackgroundAsset(
        { ...header, size: BACKGROUND_ASSET_MAX_BYTES + 1 },
        new Uint8Array(BACKGROUND_ASSET_MAX_BYTES + 1)
      )
    ).toThrow()
  })
  it('hexes digests', () => {
    expect(hexOf(new Uint8Array([0, 15, 255]))).toBe('000fff')
  })
  it('the runner files the page mirrors are the ones pinned', () => {
    expect(sha('live-backgrounds.render.generated.json')).toBe(fixture.runner.renderJsonSha256)
    expect(sha('live-background-webgl.js')).toBe(fixture.runner.webglJsSha256)
    expect(sha('live-background-clock.js')).toBe(fixture.runner.clockJsSha256)
  })
  it('names every catalogue background', () => {
    expect(catalog.backgrounds.map((entry) => entry.id)).toEqual([...LIVE_BACKGROUND_IDS])
  })
  it('is not production qualified', () => {
    expect(CLOUD_BACKGROUND_PRODUCTION_QUALIFIED).toBe(false)
  })
})

describe('BackgroundAssetCache', () => {
  it('keeps the program picture and the newest; an owner change empties it', () => {
    const released: string[] = []
    const cache = new BackgroundAssetCache<string>((value) => released.push(value))
    cache.owner('PA_a')
    cache.put('1', 'one')
    cache.put('2', 'two')
    cache.put('3', 'three', '1')
    expect(cache.has('1')).toBe(true)
    expect(cache.has('2')).toBe(false)
    expect(cache.get('3')).toBe('three')
    expect(released).toEqual(['two'])
    cache.owner('PA_b')
    expect(cache.size).toBe(0)
    expect(released).toEqual(['two', 'one', 'three'])
  })
})
