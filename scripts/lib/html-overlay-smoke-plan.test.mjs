import assert from 'node:assert/strict'
import { test } from 'node:test'

import { htmlOverlaySmokeStreamOrientations } from './html-overlay-smoke-plan.mjs'

test('the HTML overlay smoke runs on every platform (plan 232 S11)', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const orientations = htmlOverlaySmokeStreamOrientations(platform)
    // Every platform streams the horizontal leg first.
    assert.equal(orientations[0], 'horizontal', platform)
  }
})

test('macOS and Windows also stream the vertical (auxiliary) leg; Linux has none', () => {
  assert.deepEqual(htmlOverlaySmokeStreamOrientations('darwin'), ['horizontal', 'vertical'])
  assert.deepEqual(htmlOverlaySmokeStreamOrientations('win32'), ['horizontal', 'vertical'])
  assert.deepEqual(htmlOverlaySmokeStreamOrientations('linux'), ['horizontal'])
})
