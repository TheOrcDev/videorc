import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSceneSwitchPixels } from './scene-switch-pixels.mjs'

const options = { width: 64, height: 36, label: 'switch' }
const frameSize = (64 * 36 * 3) / 2
test('accepts small encoding error but rejects even one bad transition frame', () => {
  const expected = Buffer.alloc(frameSize * 30, 16)
  const decoded = Buffer.alloc(expected.length, 17)
  assert.equal(assertSceneSwitchPixels(expected, decoded, options).frames, 30)
  decoded.fill(120, frameSize * 17, frameSize * 18)
  assert.throws(() => assertSceneSwitchPixels(expected, decoded, options), /frame 17/)
})
test('detects missing frames and wrong-source colors', () => {
  const expected = Buffer.alloc(frameSize * 2, 16)
  expected.fill(170, frameSize)
  assert.throws(
    () => assertSceneSwitchPixels(expected, expected.subarray(frameSize), options),
    /missing or extra/
  )
  assert.throws(
    () => assertSceneSwitchPixels(expected, Buffer.alloc(expected.length, 16), options),
    /frame 1/
  )
})
