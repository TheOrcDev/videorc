// Unit tests for the vertical simulcast leg stream verdict.
// Run: node --test scripts/lib/vertical-leg-geometry.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assessVerticalLegStream } from './vertical-leg-geometry.mjs'

const canvas = { width: 360, height: 640 }
const program = { width: 640, height: 360 }

describe('assessVerticalLegStream', () => {
  it('passes when the vertical destination receives the portrait leg', () => {
    assert.deepEqual(assessVerticalLegStream({ canvas, program, received: canvas }), {
      pass: true,
      failures: []
    })
  })

  it('names the 2026-09-21 incident: the horizontal program on the vertical destination', () => {
    const verdict = assessVerticalLegStream({ canvas, program, received: program })
    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('\n'), /HORIZONTAL program \(640x360\)/)
  })

  it('names a wrong size, a missing stream, and a landscape leg canvas', () => {
    assert.match(
      assessVerticalLegStream({ canvas, program, received: { width: 720, height: 1280 } })
        .failures[0],
      /received 720x1280, expected 360x640/
    )
    assert.match(
      assessVerticalLegStream({ canvas, program, received: null }).failures[0],
      /no decodable video/
    )
    assert.match(
      assessVerticalLegStream({ canvas: program, program, received: program }).failures[0],
      /is not portrait/
    )
  })
})
