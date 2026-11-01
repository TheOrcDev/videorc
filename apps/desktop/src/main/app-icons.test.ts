import { describe, expect, it, vi } from 'vitest'
import { APP_ICON_PIXELS, createAppIconHandler } from './app-icons'

const bytes = new Uint8Array([104, 101, 108, 108, 111])
const png = 'data:image/png;base64,aGVsbG8='
describe('app icons', () => {
  it('renders native icons once across concurrent calls and caches misses', async () => {
    const pngForBundleId = vi.fn((id: string) => (id === 'test.app' ? bytes : null))
    const handler = createAppIconHandler({ platform: 'darwin', pngForBundleId })
    expect(
      await Promise.all([handler(['test.app', 'unknown.app']), handler(['test.app'])])
    ).toEqual([{ 'test.app': png }, { 'test.app': png }])
    await handler(['unknown.app'])
    expect(pngForBundleId).toHaveBeenCalledTimes(2)
    expect(pngForBundleId).toHaveBeenCalledWith('test.app', APP_ICON_PIXELS)
    expect(APP_ICON_PIXELS).toBeGreaterThanOrEqual(16)
    expect(APP_ICON_PIXELS).toBeLessThanOrEqual(256)
  })
  it('ignores invalid ids, handles failures, and caps each call at 64', async () => {
    const pngForBundleId = vi.fn(() => {
      throw new Error('missing')
    })
    const handler = createAppIconHandler({ platform: 'darwin', pngForBundleId })
    expect(await handler(null)).toEqual({})
    expect(await handler([null, 3, {}, '../file', '', 'single'])).toEqual({})
    expect(await handler(Array.from({ length: 80 }, (_, i) => `test.app${i}`))).toEqual({})
    expect(pngForBundleId).toHaveBeenCalledTimes(64)
  })
  it('yields no icon, and never throws, when the binding is missing, undefined or empty', async () => {
    const missingBinding: { appIconPngForBundleId?: (id: string, pixels: number) => Uint8Array } =
      {}
    const handler = createAppIconHandler({
      platform: 'darwin',
      pngForBundleId: (id, pixels) => missingBinding.appIconPngForBundleId?.(id, pixels)
    })
    expect(await handler(['test.app'])).toEqual({})
    const empty = createAppIconHandler({
      platform: 'darwin',
      pngForBundleId: () => new Uint8Array(0)
    })
    expect(await empty(['test.app'])).toEqual({})
  })
  it('returns nothing on other platforms', async () => {
    const pngForBundleId = vi.fn()
    expect(await createAppIconHandler({ platform: 'linux', pngForBundleId })(['test.app'])).toEqual(
      {}
    )
    expect(pngForBundleId).not.toHaveBeenCalled()
  })
})
