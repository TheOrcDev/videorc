import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertFrostPixels,
  assertNoSecretPixels,
  assertPrivacyDrain,
  hasSecretMarker
} from './cloud-parity-privacy-contract.mjs'
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
test('a raw text stroke is secret; the frosted pink band of a hidden screen is not', () => {
  const grey = new Uint8Array(4096)
  for (let i = 0; i < grey.length; i += 4) grey.set([128, 128, 128, 255], i)
  assert.equal(hasSecretMarker(grey), false)
  assertNoSecretPixels(grey, 'grey')
  // Plan 210 D8: the frost of magenta text on grey is a soft pink band.
  const frosted = grey.slice()
  for (let i = 0; i < 64 * 4; i += 4) frosted.set([176, 82, 176, 255], i)
  assert.equal(hasSecretMarker(frosted), false)
  assertNoSecretPixels(frosted, 'frosted')
  const raw = grey.slice()
  raw.set([250, 6, 250, 255], 400)
  assert.equal(hasSecretMarker(raw), true)
  assert.throws(() => assertNoSecretPixels(raw, 'raw'))
})
