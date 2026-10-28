// Unit tests for the scene window-switch probe helpers (plan 210 S0).
//
// Run: node --test scripts/lib/scene-window-switch-frames.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  anchorFromFlash,
  classifyRgb,
  featuresFromRawFrames,
  largestShare,
  parseBackendLogLine,
  percentiles,
  sceneSwitchVerdict,
  splitSwitchGap
} from './scene-window-switch-frames.mjs'

const WIDTH = 16
const HEIGHT = 9
const COLORS = {
  red: [217, 26, 26],
  blue: [26, 51, 230],
  black: [0, 0, 0],
  white: [255, 255, 255],
  grey: [128, 128, 128]
}

// `noise` changes one pixel inside the motion strip (bottom-left);
// `noiseOutside` changes one pixel outside it (top-left).
// `border` paints the top-left corner (a shrunk window leaves canvas there).
function solidFrame(rgb, { inset = null, border = null, noise = 0, noiseOutside = 0 } = {}) {
  const frame = Buffer.alloc(WIDTH * HEIGHT * 3)
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3
      const inInset = inset && x >= Math.floor(0.82 * WIDTH) && y >= Math.floor(0.72 * HEIGHT)
      const inBorder = border && x < Math.ceil(0.1 * WIDTH) && y < Math.ceil(0.14 * HEIGHT)
      const color = inInset ? inset : inBorder ? border : rgb
      frame[offset] = color[0]
      frame[offset + 1] = color[1]
      frame[offset + 2] = color[2]
    }
  }
  if (noise) {
    const offset = (HEIGHT - 1) * WIDTH * 3
    frame[offset + 1] = (frame[offset + 1] + noise) % 256
  }
  if (noiseOutside) frame[1] = (frame[1] + noiseOutside) % 256
  return frame
}

function sequence(frames) {
  return Buffer.concat(frames)
}

describe('classifyRgb', () => {
  it('names the fixture colours, black and white', () => {
    assert.equal(classifyRgb(COLORS.red), 'red')
    assert.equal(classifyRgb(COLORS.blue), 'blue')
    assert.equal(classifyRgb(COLORS.black), 'black')
    assert.equal(classifyRgb(COLORS.white), 'white')
    assert.equal(classifyRgb(COLORS.grey), 'other')
  })

  it('keeps a darker letter over the fill in the same class', () => {
    // 22% black over red, as the fixture draws its marker letter.
    assert.equal(classifyRgb([170, 20, 20]), 'red')
    assert.equal(classifyRgb([20, 40, 180]), 'blue')
  })
})

describe('featuresFromRawFrames', () => {
  it('classifies the centre, detects an inset and repeated frames', () => {
    const buffer = sequence([
      solidFrame(COLORS.red),
      solidFrame(COLORS.red),
      solidFrame(COLORS.red, { noise: 15 }),
      solidFrame(COLORS.red, { noise: 15, noiseOutside: 200 }),
      solidFrame(COLORS.red, { noise: 75 }),
      solidFrame(COLORS.blue, { inset: COLORS.grey })
    ])
    const features = featuresFromRawFrames(buffer, { width: WIDTH, height: HEIGHT })
    assert.equal(features.length, 6)
    assert.equal(features[0].centre, 'red')
    assert.equal(features[0].repeated, false, 'first frame has nothing to repeat')
    assert.equal(features[1].repeated, true)
    assert.equal(features[2].repeated, true, 'encoder-sized noise in the strip is a repeat')
    assert.equal(features[3].repeated, true, 'motion outside the strip does not count')
    assert.equal(features[4].repeated, false, 'the moving block changes the strip')
    assert.equal(features[0].layoutMark, false)
    assert.equal(features[5].centre, 'blue')
    assert.equal(features[5].layoutMark, true)
    assert.equal(features[5].repeated, false)
    const bordered = featuresFromRawFrames(solidFrame(COLORS.blue, { border: COLORS.black }), {
      width: WIDTH,
      height: HEIGHT
    })
    assert.equal(bordered[0].centre, 'blue')
    assert.equal(bordered[0].layoutMark, true, 'a shrunk window shows canvas top-left')
  })
})

describe('anchorFromFlash', () => {
  it('anchors on the first white frame after the flash', () => {
    const features = featuresFromRawFrames(
      sequence([solidFrame(COLORS.red), solidFrame(COLORS.white), solidFrame(COLORS.red)]),
      { width: WIDTH, height: HEIGHT }
    )
    const anchor = anchorFromFlash(features, [0, 33, 66], 10_033)
    assert.deepEqual(anchor, { offsetMs: 10_000, frameIndex: 1 })
    assert.equal(anchorFromFlash(features, [0, 33, 66], 10_033, { afterPtsMs: 40 }), null)
  })
})

describe('sceneSwitchVerdict', () => {
  const ptsMs = Array.from({ length: 12 }, (_, index) => index * 100)

  it('measures the cut, frozen, black and other frames before it', () => {
    const features = featuresFromRawFrames(
      sequence([
        solidFrame(COLORS.red), // 0 before request
        solidFrame(COLORS.red), // 100 request lands here
        solidFrame(COLORS.red), // 200 frozen
        solidFrame(COLORS.red, { noiseOutside: 90 }), // 300 frozen (strip unchanged)
        solidFrame(COLORS.black), // 400 black
        solidFrame(COLORS.grey), // 500 other
        solidFrame(COLORS.blue), // 600 cut
        solidFrame(COLORS.blue), // 700
        solidFrame(COLORS.black), // 800 after-cut black
        solidFrame(COLORS.blue) // 900
      ]),
      { width: WIDTH, height: HEIGHT }
    )
    const verdict = sceneSwitchVerdict({
      features,
      ptsMs,
      offsetMs: 1_000,
      requestedAtMs: 1_100,
      untilMs: 2_000,
      fromColor: 'red',
      toColor: 'blue'
    })
    assert.equal(verdict.cutSeen, true)
    assert.equal(verdict.firstNewFrameIndex, 6)
    assert.equal(verdict.latencyMs, 500)
    assert.equal(verdict.framesBeforeCut, 5)
    assert.equal(verdict.oldWindowFrames, 3)
    assert.equal(verdict.frozenFrames, 3)
    assert.equal(verdict.blackFrames, 1)
    assert.equal(verdict.otherFrames, 1)
    assert.equal(verdict.afterCutBlackFrames, 1)
    assert.equal(verdict.afterCutFrames, 4)
    assert.equal(verdict.wrongLayoutFrames, 0, 'layout not checked without inset flags')
  })

  it('counts new-window frames drawn under the old layout', () => {
    const features = featuresFromRawFrames(
      sequence([
        solidFrame(COLORS.red), // 0 request
        solidFrame(COLORS.blue), // 100 cut, but still no inset: wrong layout
        solidFrame(COLORS.blue), // 200 wrong layout
        solidFrame(COLORS.blue, { inset: COLORS.grey }) // 300 right
      ]),
      { width: WIDTH, height: HEIGHT }
    )
    const verdict = sceneSwitchVerdict({
      features,
      ptsMs,
      offsetMs: 0,
      requestedAtMs: 0,
      fromColor: 'red',
      toColor: 'blue',
      fromLayoutMark: false,
      toLayoutMark: true
    })
    assert.equal(verdict.latencyMs, 100)
    assert.equal(verdict.wrongLayoutFrames, 2)
  })

  it('reports no cut when the new window never appears', () => {
    const features = featuresFromRawFrames(
      sequence([solidFrame(COLORS.red), solidFrame(COLORS.red)]),
      { width: WIDTH, height: HEIGHT }
    )
    const verdict = sceneSwitchVerdict({
      features,
      ptsMs,
      offsetMs: 0,
      requestedAtMs: 0,
      fromColor: 'red',
      toColor: 'blue'
    })
    assert.equal(verdict.cutSeen, false)
    assert.equal(verdict.latencyMs, null)
    assert.equal(verdict.oldWindowFrames, 2)
  })
})

describe('percentiles', () => {
  it('returns p50, p95 and max over finite values', () => {
    assert.deepEqual(percentiles([5, 1, null, 3, 2, 4]), { n: 5, p50: 3, p95: 5, max: 5 })
    assert.deepEqual(percentiles([]), { n: 0, p50: null, p95: null, max: null })
    const twenty = Array.from({ length: 20 }, (_, index) => index + 1)
    assert.equal(percentiles(twenty).p95, 19)
  })
})

describe('splitSwitchGap', () => {
  const t0 = Date.parse('2026-10-28T20:00:00.000Z')
  const line = (offsetMs, text) =>
    parseBackendLogLine(
      `[backend:info] ${new Date(t0 + offsetMs).toISOString()}  INFO videorc_backend::preview_screen: ${text}`
    )

  it('parses relayed tracing lines and ignores the rest', () => {
    assert.equal(line(0, 'x').atMs, t0)
    assert.equal(parseBackendLogLine('[smoke] backend-ready {"port":1}'), null)
  })

  it('splits request → begin → stop → shareable → first frame → program', () => {
    const logLines = [
      line(-500, '[capture-generation] source=window generation=3 reason=start config=aa'),
      line(40, '[capture-generation] source=window generation=4 reason=restart config=bb'),
      line(160, '[capture-generation] source=screen generation=3 reason=restart stop_join_ms=118'),
      line(420, '[videorc-capture-sizing] kind=Window native=1280x800 requested=1280x800')
    ]
    const split = splitSwitchGap({
      requestedAtMs: t0,
      logLines,
      firstCapturedFrameAtMs: t0 + 520,
      firstProgramFrameAtMs: t0 + 580
    })
    assert.equal(split.preflightMs, 40)
    assert.equal(split.stopMs, 118)
    assert.equal(split.shareableMs, 260)
    assert.equal(split.startToFirstFrameMs, 100)
    assert.equal(split.commitMs, 60)
    assert.equal(split.totalMs, 580)
  })

  it('names the largest share', () => {
    const share = largestShare([
      { preflightMs: 40, stopMs: 118, shareableMs: 260, startToFirstFrameMs: 100, commitMs: 60 },
      { preflightMs: 50, stopMs: 100, shareableMs: 300, startToFirstFrameMs: 90, commitMs: 50 }
    ])
    assert.equal(share.largest, 'shareableMs')
    assert.ok(share.shares.shareableMs > 0.4)
  })
})
