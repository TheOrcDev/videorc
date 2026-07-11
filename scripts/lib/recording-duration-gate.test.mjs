import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateRecordingWallDuration } from './recording-duration-gate.mjs'

describe('recording wall-duration gate', () => {
  it('rejects the Windows one-third-duration regression', () => {
    assert.deepEqual(
      evaluateRecordingWallDuration({
        expectedDurationMs: 30_000,
        actualDurationSeconds: 10
      }),
      ['final artifact duration 10.00s was only 33.3% of the requested 30.00s']
    )
  })

  it('accepts normal stop-boundary variance', () => {
    assert.deepEqual(
      evaluateRecordingWallDuration({
        expectedDurationMs: 5_000,
        actualDurationSeconds: 4.65
      }),
      []
    )
  })

  it('fails closed when duration evidence is missing', () => {
    assert.deepEqual(
      evaluateRecordingWallDuration({
        expectedDurationMs: 5_000,
        actualDurationSeconds: null
      }),
      ['final artifact did not report a positive media duration']
    )
  })
})
