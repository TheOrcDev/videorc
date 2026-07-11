import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceStatus } from './backend'
import { rendererCompositorUpdateWasAccepted } from './native-preview-present-ownership'

describe('rendererCompositorUpdateWasAccepted', () => {
  it('suppresses metrics for a renderer present rejected during main-pump takeover', () => {
    expect(
      rendererCompositorUpdateWasAccepted({
        compositorUpdateAccepted: false
      } as PreviewSurfaceStatus)
    ).toBe(false)
  })

  it('keeps older backend statuses compatible when no acknowledgement is present', () => {
    expect(rendererCompositorUpdateWasAccepted({} as PreviewSurfaceStatus)).toBe(true)
  })
})
