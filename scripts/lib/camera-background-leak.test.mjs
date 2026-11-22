import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EXPECT_ROOM_HIDDEN,
  EXPECT_ROOM_VISIBLE,
  classifyPixel,
  createFrameSplitter,
  downscale2,
  judgeOutput,
  loadFixtureSpec,
  scanFrame,
  summarizeScans
} from './camera-background-leak.mjs'

const spec = loadFixtureSpec()
const SHIRT = spec.person.shirt

/** A splitmix-ish bit per cell, like the fixture's (any code will do). */
function cellBit(column, row) {
  let value = (Math.imul(column, 0x45d9f3b) ^ Math.imul(row, 0x119de1f3) ^ 258) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0
  return ((value ^ (value >>> 16)) & 1) === 1
}

/**
 * A fixture-like picture: the code room with `cell`-pixel cells, and the
 * figure as an orange block over the middle third (`figure: false` for none).
 */
function roomFrame(width, height, cell, { figure = true } = {}) {
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = cellBit(Math.floor(x / cell), Math.floor(y / cell))
        ? spec.room.magenta
        : spec.room.cyan
      const inFigure = figure && x > width / 3 && x < (2 * width) / 3 && y > height * 0.3
      rgb.set(inFigure ? SHIRT : colour, (y * width + x) * 3)
    }
  }
  return { width, height, rgb }
}

function solidFrame(width, height, paint) {
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgb.set(paint(x, y), (y * width + x) * 3)
  }
  return { width, height, rgb }
}

/** A separable box blur of radius `r`, what a cheap background blur does. */
function boxBlur(frame, r) {
  const { width, height } = frame
  const pass = (source, horizontal) => {
    const out = new Uint8Array(source.length)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sum = [0, 0, 0]
        let n = 0
        for (let d = -r; d <= r; d += 1) {
          const sx = horizontal ? Math.min(width - 1, Math.max(0, x + d)) : x
          const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + d))
          const i = (sy * width + sx) * 3
          sum[0] += source[i]
          sum[1] += source[i + 1]
          sum[2] += source[i + 2]
          n += 1
        }
        const o = (y * width + x) * 3
        out[o] = sum[0] / n
        out[o + 1] = sum[1] / n
        out[o + 2] = sum[2] / n
      }
    }
    return out
  }
  return { width, height, rgb: pass(pass(frame.rgb, true), false) }
}

/** BT.709 4:2:0 round trip: full-res luma, chroma averaged over 2x2 blocks. */
function chroma420(frame) {
  const { width, height, rgb } = frame
  const ycc = new Float64Array(width * height * 3)
  for (let i = 0, p = 0; i < width * height; i += 1, p += 3) {
    const [r, g, b] = [rgb[p], rgb[p + 1], rgb[p + 2]]
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    ycc[p] = y
    ycc[p + 1] = (b - y) / 1.8556
    ycc[p + 2] = (r - y) / 1.5748
  }
  const out = new Uint8Array(rgb.length)
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const block = [
        [x, y],
        [x + 1, y],
        [x, y + 1],
        [x + 1, y + 1]
      ].filter(([bx, by]) => bx < width && by < height)
      const cb = block.reduce((s, [bx, by]) => s + ycc[(by * width + bx) * 3 + 1], 0) / block.length
      const cr = block.reduce((s, [bx, by]) => s + ycc[(by * width + bx) * 3 + 2], 0) / block.length
      for (const [bx, by] of block) {
        const p = (by * width + bx) * 3
        const luma = ycc[p]
        const r = luma + 1.5748 * cr
        const b = luma + 1.8556 * cb
        const g = (luma - 0.2126 * r - 0.0722 * b) / 0.7152
        out[p] = Math.max(0, Math.min(255, Math.round(r)))
        out[p + 1] = Math.max(0, Math.min(255, Math.round(g)))
        out[p + 2] = Math.max(0, Math.min(255, Math.round(b)))
      }
    }
  }
  return { width, height, rgb: out }
}

describe('camera background leak detector', () => {
  it('classifies saturated magenta and cyan, and nothing in between', () => {
    assert.equal(classifyPixel(255, 0, 255), 1)
    assert.equal(classifyPixel(0, 255, 255), 2)
    assert.equal(classifyPixel(128, 128, 255), 0, 'a blur of the two is lavender, neither')
    assert.equal(classifyPixel(...SHIRT), 0, 'the figure is never pattern')
    assert.equal(classifyPixel(255, 255, 255), 0)
    assert.equal(classifyPixel(0, 0, 0), 0)
  })

  it('finds the room at the smallest and the largest cell sizes outputs show', () => {
    for (const cell of [4, 7, 13, 20, 26]) {
      const scan = scanFrame(roomFrame(640, 360, cell), { spec })
      assert.equal(scan.leak, true, `cell ${cell}px: ${JSON.stringify(scan)}`)
      assert.equal(scan.personSeen, true)
    }
  })

  it('still finds the room after 4:2:0 chroma, as in every H.264 output', () => {
    const scan = scanFrame(chroma420(roomFrame(480, 270, 6)), { spec })
    assert.equal(scan.leak, true, JSON.stringify(scan))
  })

  it('finds a small inset of the room inside a larger, unrelated picture', () => {
    const inset = roomFrame(160, 120, 5, { figure: false })
    const frame = solidFrame(640, 360, (x, y) => [40 + (x % 50), 60, 90 + (y % 30)])
    for (let y = 0; y < inset.height; y += 1) {
      const from = y * inset.width * 3
      frame.rgb.set(inset.rgb.subarray(from, from + inset.width * 3), ((y + 200) * 640 + 440) * 3)
    }
    assert.equal(scanFrame(frame, { spec }).leak, true)
  })

  it('sees no room once the background is blurred over two cells or more', () => {
    for (const [cell, radius] of [
      [6, 12],
      [10, 20],
      [13, 26]
    ]) {
      const scan = scanFrame(boxBlur(roomFrame(320, 180, cell), radius), { spec })
      assert.equal(scan.leak, false, `cell ${cell}, blur ${radius}: ${JSON.stringify(scan)}`)
      assert.equal(scan.patternTiles, 0)
    }
  })

  it('still flags a blur too weak to hide the room (about one cell)', () => {
    // The bar S3's blur must clear: at the fixture's 1080p raster a cell is
    // 20 px, so a blur that keeps cells readable is a room still recognisable.
    const scan = scanFrame(boxBlur(roomFrame(320, 180, 6), 6), { spec })
    assert.equal(scan.leak, true, JSON.stringify(scan))
  })

  it('sees no room in a picture background, flat blocks, gradients or noise', () => {
    const cases = {
      'a picture behind the figure': roomFrame(320, 180, 6, { figure: true }).rgb.map((_, i) =>
        i % 3 === 1 ? 140 : 70
      ),
      'magenta and cyan halves': solidFrame(320, 180, (x) =>
        x < 160 ? [255, 0, 255] : [0, 255, 255]
      ).rgb,
      'a diagonal split': solidFrame(320, 180, (x, y) => (x > y ? [255, 0, 255] : [0, 255, 255]))
        .rgb,
      'big magenta/cyan checks': solidFrame(320, 180, (x, y) =>
        (Math.floor(x / 90) + Math.floor(y / 90)) % 2 ? [255, 0, 255] : [0, 255, 255]
      ).rgb,
      'a purple-to-cyan gradient': solidFrame(320, 180, (x) => [
        255 - (x * 255) / 320,
        (x * 255) / 320,
        255
      ]).rgb,
      'uniform noise': (() => {
        let seed = 7
        return solidFrame(320, 180, () => {
          seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
          return [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255]
        }).rgb
      })()
    }
    for (const [name, rgb] of Object.entries(cases)) {
      const scan = scanFrame({ width: 320, height: 180, rgb }, { spec })
      assert.equal(scan.leak, false, `${name}: ${JSON.stringify(scan)}`)
    }
  })

  it('downscales by averaging 2x2 blocks', () => {
    const frame = solidFrame(4, 2, (x) => (x < 2 ? [255, 0, 255] : [0, 255, 255]))
    const half = downscale2(frame)
    assert.deepEqual([half.width, half.height], [2, 1])
    assert.deepEqual([...half.rgb], [255, 0, 255, 0, 255, 255])
  })

  it('refuses short frame storage', () => {
    assert.throws(
      () => scanFrame({ width: 10, height: 10, rgb: new Uint8Array(10) }, { spec }),
      /short/
    )
  })

  it('summarizes frames with the first leak and the worst frame in seconds', () => {
    const scans = [
      { leak: false, patternTiles: 0, personSeen: true },
      { leak: true, patternTiles: 3, personSeen: true },
      { leak: true, patternTiles: 9, personSeen: false }
    ]
    assert.deepEqual(summarizeScans(scans, { fps: 2 }), {
      frames: 3,
      leakFrames: 2,
      personFrames: 2,
      maxPatternTiles: 9,
      firstLeakSeconds: 0.5,
      worstSeconds: 1
    })
  })

  it('judges the effect Off: the room and the figure must be seen', () => {
    const base = { frames: 10, maxPatternTiles: 40, firstLeakSeconds: 0, worstSeconds: 1 }
    assert.equal(
      judgeOutput({ ...base, leakFrames: 9, personFrames: 10 }, EXPECT_ROOM_VISIBLE).ok,
      true
    )
    const blind = judgeOutput({ ...base, leakFrames: 2, personFrames: 10 }, EXPECT_ROOM_VISIBLE)
    assert.equal(blind.ok, false)
    assert.match(blind.failures[0], /cannot vouch/)
    const noFigure = judgeOutput({ ...base, leakFrames: 10, personFrames: 0 }, EXPECT_ROOM_VISIBLE)
    assert.match(noFigure.failures[0], /not showing the fixture camera/)
  })

  it('judges an effect on: a single pattern frame is a leak', () => {
    const clean = { frames: 10, leakFrames: 0, personFrames: 10, maxPatternTiles: 0 }
    assert.equal(judgeOutput(clean, EXPECT_ROOM_HIDDEN).ok, true)
    const leaked = judgeOutput(
      { ...clean, leakFrames: 1, maxPatternTiles: 2, firstLeakSeconds: 3.5 },
      EXPECT_ROOM_HIDDEN
    )
    assert.equal(leaked.ok, false)
    assert.match(leaked.failures[0], /real room leaked.*1\/10 frames \(first at 3.5 s/)
  })

  it('never passes an output with too few frames, either way', () => {
    const empty = { frames: 1, leakFrames: 0, personFrames: 0, maxPatternTiles: 0 }
    assert.equal(judgeOutput(empty, EXPECT_ROOM_HIDDEN).ok, false)
    assert.equal(judgeOutput(empty, EXPECT_ROOM_VISIBLE).ok, false)
    assert.throws(() => judgeOutput(empty, 'maybe'), /unknown expectation/)
  })

  it('splits raw chunks into whole frames across chunk boundaries', () => {
    const split = createFrameSplitter(4)
    assert.deepEqual(split(Uint8Array.of(1, 2, 3)), [])
    const frames = split(Uint8Array.of(4, 5, 6, 7, 8, 9))
    assert.deepEqual(
      frames.map((frame) => [...frame]),
      [
        [1, 2, 3, 4],
        [5, 6, 7, 8]
      ]
    )
    assert.deepEqual(
      split(Uint8Array.of(10, 11, 12)).map((frame) => [...frame]),
      [[9, 10, 11, 12]]
    )
  })
})
