import assert from 'node:assert/strict'
import test from 'node:test'

import { nodeWords, previewConverged } from './gpui-studio-smoke.mjs'

test('a button reads the words of its text nodes, not hidden ones', () => {
  const record = {
    role: 'button',
    children: [
      { role: 'label', value: 'Record' },
      { role: 'label', value: 'Space', visible: false }
    ]
  }
  assert.equal(nodeWords(record), 'Record')
  assert.equal(nodeWords(null), '')
})

test('the preview converges once the committed scene is drawn and frames advance', () => {
  const first = { sceneRevision: 3, frameSceneRevision: 2, framesRendered: 10 }
  assert.equal(previewConverged(first, first), false)
  assert.equal(
    previewConverged(first, { sceneRevision: 3, frameSceneRevision: 3, framesRendered: 10 }),
    false,
    'no new frame yet'
  )
  assert.equal(
    previewConverged(first, { sceneRevision: 3, frameSceneRevision: 3, framesRendered: 12 }),
    true
  )
  assert.equal(previewConverged(first, { sceneRevision: null }), false)
})
