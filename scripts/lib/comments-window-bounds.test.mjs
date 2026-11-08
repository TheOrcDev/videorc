// Run: node --test scripts/lib/comments-window-bounds.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  commentsWindowContentWidth,
  commentsWindowFrameWidthFor
} from './comments-window-bounds.mjs'

test('macOS: client and frame are the same width, so the request is unchanged', () => {
  const state = {
    bounds: { x: 0, y: 0, width: 420, height: 640 },
    contentBounds: { x: 0, y: 28, width: 420, height: 612 }
  }
  assert.equal(commentsWindowFrameWidthFor(1280, state), 1280)
  assert.equal(commentsWindowContentWidth(state), 420)
})

test('Windows: the resize border is added so the client lands at the width (#1081)', () => {
  const state = {
    bounds: { x: 0, y: 0, width: 1280, height: 640 },
    contentBounds: { x: 7, y: 31, width: 1266, height: 602 }
  }
  assert.equal(commentsWindowFrameWidthFor(1280, state), 1294)
  assert.equal(commentsWindowContentWidth(state), 1266)
})

test('a state without content bounds falls back to the outer width', () => {
  const state = { bounds: { x: 0, y: 0, width: 640, height: 640 } }
  assert.equal(commentsWindowFrameWidthFor(800, state), 800)
  assert.equal(commentsWindowContentWidth(state), 640)
  assert.equal(commentsWindowFrameWidthFor(800, null), 800)
  assert.equal(commentsWindowContentWidth(null), undefined)
})
