import { describe, expect, it, vi } from 'vitest'
import { createAppIconHandler } from './app-icons'

const png = 'data:image/png;base64,aGVsbG8='
describe('app icons', () => {
  it('resolves native icons once across concurrent calls and caches misses', async () => {
    const pathForBundleId = vi.fn((id: string) =>
      id === 'test.app' ? '/Applications/Test.app' : null
    )
    const pngForPath = vi.fn(async () => png)
    const handler = createAppIconHandler({ platform: 'darwin', pathForBundleId, pngForPath })
    expect(
      await Promise.all([handler(['test.app', 'unknown.app']), handler(['test.app'])])
    ).toEqual([{ 'test.app': png }, { 'test.app': png }])
    await handler(['unknown.app'])
    expect(pathForBundleId).toHaveBeenCalledTimes(2)
    expect(pngForPath).toHaveBeenCalledWith('/Applications/Test.app')
    expect(pngForPath).toHaveBeenCalledTimes(1)
  })
  it('ignores invalid ids, handles failures, and caps each call at 64', async () => {
    const pathForBundleId = vi.fn(() => {
      throw new Error('missing')
    })
    const handler = createAppIconHandler({
      platform: 'darwin',
      pathForBundleId,
      pngForPath: async () => png
    })
    expect(await handler(null)).toEqual({})
    expect(await handler([null, 3, {}, '../file', '', 'single'])).toEqual({})
    expect(await handler(Array.from({ length: 80 }, (_, i) => `test.app${i}`))).toEqual({})
    expect(pathForBundleId).toHaveBeenCalledTimes(64)
  })
  it('returns nothing on other platforms', async () => {
    const pathForBundleId = vi.fn()
    expect(
      await createAppIconHandler({
        platform: 'linux',
        pathForBundleId,
        pngForPath: async () => png
      })(['test.app'])
    ).toEqual({})
    expect(pathForBundleId).not.toHaveBeenCalled()
  })
})
