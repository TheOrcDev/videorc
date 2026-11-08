import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BREAKING_KINDS,
  UI_SWEEP_SIZES,
  breakingFindings,
  layoutCheckSource,
  parseSizes
} from './ui-layout-check.mjs'

test('the sweep starts at the main window minimum (plan 213 C1)', () => {
  assert.deepEqual(UI_SWEEP_SIZES[0], { width: 960, height: 660 })
  assert.deepEqual(
    UI_SWEEP_SIZES.map(({ width, height }) => `${width}x${height}`),
    ['960x660', '1100x720', '1280x800']
  )
})

test('sizes parse as WIDTHxHEIGHT and refuse anything else', () => {
  assert.deepEqual(parseSizes('960x660, 1280x800'), [
    { width: 960, height: 660 },
    { width: 1280, height: 800 }
  ])
  assert.throws(() => parseSizes('960'), /WIDTHxHEIGHT/)
  assert.throws(() => parseSizes('960x660,big'), /WIDTHxHEIGHT/)
})

test('truncated text is reported but never breaks the sweep', () => {
  assert.equal(BREAKING_KINDS.includes('truncated'), false)
  const findings = [
    { kind: 'truncated', what: 'span' },
    { kind: 'clipped', what: 'button' }
  ]
  assert.deepEqual(breakingFindings(findings), [{ kind: 'clipped', what: 'button' }])
})

test('the renderer check is a function body that compiles', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.doesNotThrow(() => new AsyncFunction(layoutCheckSource))
})
