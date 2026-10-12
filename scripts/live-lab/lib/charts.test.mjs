import assert from 'node:assert/strict'
import test from 'node:test'

import { decodePng } from '../../lib/image-stats.mjs'
import { createCanvas, renderLineChart, renderTimeline, textWidth } from './charts.mjs'
import { encodePng } from './png.mjs'

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
}

test('encodePng round-trips through the repo PNG decoder (rgb and rgba)', () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30])
  const decoded = decodePng(encodePng(2, 2, rgb))
  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.deepEqual(pixelAt(decoded, 0, 0), [255, 0, 0])
  assert.deepEqual(pixelAt(decoded, 1, 1), [10, 20, 30])
  const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255])
  const decodedRgba = decodePng(encodePng(2, 1, rgba, { channels: 4 }))
  assert.deepEqual(pixelAt(decodedRgba, 1, 0), [4, 5, 6])
  assert.throws(() => encodePng(2, 2, new Uint8Array(3)), /need 12/)
})

test('the canvas draws rects, lines and glyphs', () => {
  const canvas = createCanvas(40, 20, '#000000')
  canvas.fillRect(2, 2, 3, 3, '#ff0000')
  canvas.line(0, 10, 39, 10, '#00ff00')
  const advance = canvas.text(10, 12, 'A1', '#ffffff')
  assert.equal(advance, textWidth('A1'))
  const image = decodePng(canvas.toPng())
  assert.deepEqual(pixelAt(image, 3, 3), [255, 0, 0])
  assert.deepEqual(pixelAt(image, 20, 10), [0, 255, 0])
  // Top row of 'A' is 01110: the middle column lights up.
  assert.deepEqual(pixelAt(image, 12, 12), [255, 255, 255])
  assert.deepEqual(pixelAt(image, 10, 12), [0, 0, 0])
})

test('renderLineChart draws a series and reports empty data', () => {
  const chart = renderLineChart({
    title: 'rss backend',
    unit: 'MB',
    series: [
      {
        name: 'backend',
        points: Array.from({ length: 30 }, (_, i) => ({ atMs: i * 10_000, value: 300 + i }))
      }
    ],
    threshold: 320
  })
  assert.equal(chart.empty, false)
  const image = decodePng(chart.png)
  assert.equal(image.width, 960)
  assert.equal(image.height, 320)
  const empty = renderLineChart({ title: 'nothing', series: [{ name: 'x', points: [] }] })
  assert.equal(empty.empty, true)
  assert.equal(decodePng(empty.png).width, 960)
})

test('renderTimeline fills bands until the next sample', () => {
  const chart = renderTimeline({
    title: 'youtube health',
    bands: [
      { atMs: 0, state: 'good' },
      { atMs: 120_000, state: 'noData' }
    ],
    colors: { good: '#16a34a', noData: '#dc2626' },
    endMs: 240_000
  })
  assert.equal(chart.empty, false)
  const image = decodePng(chart.png)
  // First quarter is good (green), last quarter noData (red).
  assert.deepEqual(pixelAt(image, 100, 60), [22, 163, 74])
  assert.deepEqual(pixelAt(image, 900, 60), [220, 38, 38])
})
