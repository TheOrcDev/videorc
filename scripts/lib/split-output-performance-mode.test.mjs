import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { splitOutputPreviewSurfaceDisabled } from './split-output-performance-mode.mjs'

describe('split-output native-preview policy', () => {
  it('forces native preview on only for the performance path', () => {
    assert.equal(
      splitOutputPreviewSurfaceDisabled({ VIDEORC_PERF_REPORT_PATH: '/tmp/perf.json' }),
      '0'
    )
    assert.equal(splitOutputPreviewSurfaceDisabled({}), '1')
    assert.equal(
      splitOutputPreviewSurfaceDisabled({ VIDEORC_BASELINE_NO_PREVIEW_SURFACE: '0' }),
      '0'
    )
  })
})
