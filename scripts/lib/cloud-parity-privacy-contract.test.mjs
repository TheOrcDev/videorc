import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertFrostPixels, assertPrivacyDrain } from './cloud-parity-privacy-contract.mjs'
test('privacy gate rejects raw pixels, missing samples and excessive old-frame drain', () => {
  const pixels = new Uint8Array(4096)
  for (let i = 0; i < pixels.length; i += 4) pixels.set([128, 128, 128, 255], i)
  assertFrostPixels(pixels, 'fixture')
  pixels[0] = 255
  assert.throws(() => assertFrostPixels(pixels, 'secret'))
  assert.throws(() => assertFrostPixels([], 'missing'))
  assertPrivacyDrain({ blockedAt: 1000, appliedAt: 1400, lastRawAt: 1300 })
  assert.throws(() => assertPrivacyDrain({ blockedAt: 1000, appliedAt: 1700, lastRawAt: 1600 }))
  assert.throws(() => assertPrivacyDrain({ blockedAt: 1000, appliedAt: 1100, lastRawAt: 1200 }))
})
