import assert from 'node:assert/strict'
import test from 'node:test'

import { assessMotionPresentation, parseMotionRateLine } from './linux-motion-window.mjs'

test('motion window rate lines parse to frames per second', () => {
  assert.equal(parseMotionRateLine('motion-window-rate 59'), 59)
  assert.equal(parseMotionRateLine('motion-window-rate 0\r'), 0)
  assert.equal(parseMotionRateLine('motion-window-ready'), null)
  assert.equal(parseMotionRateLine('motion-window-rate -3'), null)
  assert.equal(parseMotionRateLine(undefined), null)
})

const second = (at, fps) => ({ at, fps })

test('a presented motion window passes over the take', () => {
  const samples = [500, 1500, 2500, 3500, 4500, 5500, 6500, 7500].map((at) => second(at, 60))
  const result = assessMotionPresentation(samples, { from: 1000, to: 7000, minFps: 15 })
  assert.equal(result.ok, true)
  // Every second that overlaps the take counts, the edges included.
  assert.deepEqual(result.fps, [60, 60, 60, 60, 60, 60, 60])
})

test('a window the compositor stops presenting fails with the cause', () => {
  // ogre 0.20.3, display off: 6 frames, then none, while the page reported visible.
  const samples = [
    second(500, 6),
    ...[1500, 2500, 3500, 4500, 5500, 6500].map((at) => second(at, 0))
  ]
  const result = assessMotionPresentation(samples, { from: 1000, to: 7000, minFps: 15 })
  assert.equal(result.ok, false)
  assert.match(result.failures[0], /painted 0, 0, 0, 0, 0, 0 frames\/s in 6 of 6 seconds, under 15/)
  assert.match(result.failures[0], /the display is off, its workspace is not shown/)
})

test('one slow second inside the take is enough to fail', () => {
  const samples = [1500, 2500, 3500, 4500].map((at) => second(at, at === 3500 ? 9 : 30))
  const result = assessMotionPresentation(samples, { from: 1000, to: 4000, minFps: 15 })
  assert.equal(result.ok, false)
  assert.match(result.failures[0], /painted 9 frames\/s in 1 of 4 seconds/)
  // Seconds that end before the take or start after it do not count.
  const outside = [second(900, 0), second(3000, 30), second(5100, 0)]
  assert.equal(assessMotionPresentation(outside, { from: 1000, to: 4000, minFps: 15 }).ok, true)
})

test('no paint count inside the take fails rather than passes', () => {
  const result = assessMotionPresentation([second(100, 60)], { from: 1000, to: 7000, minFps: 15 })
  assert.equal(result.ok, false)
  assert.match(result.failures[0], /no motion window paint count overlaps the span \(1 in all\)/)
  assert.equal(assessMotionPresentation(undefined, { from: 0, to: 1, minFps: 15 }).ok, false)
})
