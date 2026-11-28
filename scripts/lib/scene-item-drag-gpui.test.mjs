import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { dragSteps, stageRectInWindow, uncoveredPoint } from './scene-item-drag-gpui.mjs'

const canvas = { x: 100, y: 50, width: 800, height: 450 }

describe('scene item drag on the GPUI app', () => {
  it('places a canvas-fraction rect in window points', () => {
    assert.deepEqual(stageRectInWindow({ x: 0.5, y: 0.2, width: 0.25, height: 0.1 }, canvas), {
      x: 500,
      y: 140,
      width: 200,
      height: 45
    })
  })

  it('keeps a plain motion and spreads a corner drop over six steps', () => {
    assert.deepEqual(
      dragSteps({ x: 300, y: 200, width: 100, height: 50 }, canvas, { x: 11, y: 7 }),
      {
        x: 11,
        y: 7
      }
    )
    // Top-left: the box's corner lands 2 points inside the canvas's.
    const step = dragSteps({ x: 400, y: 260, width: 100, height: 50 }, canvas, {
      corner: 'top-left'
    })
    assert.equal(400 + step.x * 6, canvas.x + 2)
    assert.equal(260 + step.y * 6, canvas.y + 2)
    // Bottom-right: its far corner lands 2 points inside.
    const far = dragSteps({ x: 400, y: 260, width: 100, height: 50 }, canvas, {
      corner: 'bottom-right'
    })
    assert.equal(400 + 100 + far.x * 6, canvas.x + canvas.width - 2)
    assert.equal(260 + 50 + far.y * 6, canvas.y + canvas.height - 2)
  })
  it('grabs an item where nothing drawn above it covers it', () => {
    const banner = { id: 'banner:b', rect: { x: 0.2, y: 0.7, width: 0.6, height: 0.26 } }
    const highlight = {
      id: 'overlay:highlight',
      rect: { x: 0.02, y: 0.7, width: 0.6, height: 0.26 }
    }
    const point = uncoveredPoint(banner, [banner, highlight])
    assert.ok(point.x > 0.62, `beside the highlight: ${JSON.stringify(point)}`)
    // Something drawn below never matters.
    assert.deepEqual(uncoveredPoint(banner, [highlight, banner]), { x: 0.5, y: 0.83 })
    // The selection's handles take the pointer first: a point is kept
    // clear of its eight spots (here the banner's own right-edge middle).
    const near = uncoveredPoint({ ...banner, rect: { ...banner.rect, width: 0.42 } }, [banner], {
      selected: 'banner:b',
      margin: { x: 0.5, y: 0.5 }
    })
    assert.equal(near, null, 'a margin that wide leaves no point')
    // Fully covered: none.
    assert.equal(
      uncoveredPoint(banner, [banner, { id: 'all', rect: { x: 0, y: 0, width: 1, height: 1 } }]),
      null
    )
  })
})
