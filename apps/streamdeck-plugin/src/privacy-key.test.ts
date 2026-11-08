import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privacyKeyTitle, privacyKeyIntent } from './privacy-key.js'
test('the privacy key titles follow confirmed state and a press toggles', () => {
  assert.equal(privacyKeyTitle(false), 'Hide screen')
  assert.equal(privacyKeyTitle(true), 'Screen hidden')
  assert.deepEqual(privacyKeyIntent(), { kind: 'screenHideToggle' })
})
