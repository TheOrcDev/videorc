import { describe, expect, it } from 'vitest'

import {
  managedImageDecodeScript,
  normalizeManagedImageDecodeResult
} from './managed-asset-renderer-probe'

describe('managed asset renderer probe', () => {
  it('builds a bounded Image decode probe for the exact managed URL', () => {
    const script = managedImageDecodeScript('videorc-asset://background/code-demo.webp', 99_000)

    expect(script).toContain('new Image()')
    expect(script).toContain('image.naturalWidth')
    expect(script).toContain('image.naturalHeight')
    expect(script).toContain('30000')
    expect(script).toContain('videorc-asset://background/code-demo.webp')
  })

  it('accepts only positive dimensions decoded from the expected URL', () => {
    const url = 'videorc-asset://background/code-demo.webp'
    expect(
      normalizeManagedImageDecodeResult({ url, naturalWidth: 1672, naturalHeight: 941 }, url)
    ).toEqual({ url, naturalWidth: 1672, naturalHeight: 941 })
    expect(() =>
      normalizeManagedImageDecodeResult(
        { url: 'videorc-asset://background/other.webp', naturalWidth: 1, naturalHeight: 1 },
        url
      )
    ).toThrow(/expected asset dimensions/)
    expect(() =>
      normalizeManagedImageDecodeResult({ url, naturalWidth: 0, naturalHeight: 941 }, url)
    ).toThrow(/expected asset dimensions/)
  })
})
