import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  MIN_CELL_PIXELS,
  analyzeCompositedRecording,
  assessRecording,
  consumeRgbFrames,
  readRecordedFrame,
  recordingLayout
} from './cloud-parity-camera-bridge-recording.mjs'
import { blendPixel } from './cloud-parity-camera-bridge-contract.mjs'

const shared = await import('../../apps/desktop/src/shared/room-frame.ts')
const ground = [30, 60, 90]
const geometry = {
  content: { x: 20, y: 10, w: 640, h: 360 },
  logical: { w: 640, h: 360 },
  mirrored: false,
  tile: null
}
/** A composited rgb24 frame: the camera's logical pixels over `ground`. */
function frame(sequence, { width = 700, height = 400 } = {}) {
  const rgb = Buffer.alloc(width * height * 3)
  const stamp = shared.frameStampBits(sequence)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const lx = x - geometry.content.x,
        ly = y - geometry.content.y
      let color = ground
      if (lx >= 0 && ly >= 0 && lx < 640 && ly < 360) {
        const [r, g, b, a] = shared.fixturePixel(lx, ly, sequence, stamp)
        color = blendPixel([r, g, b], a, ground)
      }
      rgb.set(color, (y * width + x) * 3)
    }
  return rgb
}

test('a composited frame yields its stamp and blended patches at the measured geometry', () => {
  const layout = recordingLayout(geometry, 1)
  assert.equal(layout.readable, true)
  const read = readRecordedFrame(frame(1234), 700, layout)
  assert.equal(read.sequence, 1234)
  const result = assessRecording([read], ground)
  assert.equal(result.failureCount, 0)
  // One frame cannot cover the 30-minute span: never a pass.
  assert.equal(result.status, 'failed')
  assert.equal(assessRecording([read], null).status, 'unavailable')
})

test('small cameras are unreadable, not guessed', () => {
  const small = { ...geometry, content: { ...geometry.content, w: MIN_CELL_PIXELS * 32 - 1 } }
  assert.equal(recordingLayout(small, 1).readable, false)
})

test('continuity counts gaps and backwards sequences, duplicates are expected', () => {
  const layout = recordingLayout(geometry, 1)
  const frames = [1, 1, 2, 4, 3].map((s) => readRecordedFrame(frame(s), 700, layout))
  const result = assessRecording(frames, ground)
  // Runs of one sequence: duplicated screencast frames count once.
  assert.equal(result.uniqueSequences, 4)
  assert.equal(result.backwards, 1)
  assert.ok(result.missingSequences >= 1)
  assert.equal(result.status, 'failed')
})

test('the frame reader keeps one buffer and refuses truncation or excess frames', async () => {
  const seen = []
  const count = await consumeRgbFrames(
    Readable.from([Buffer.alloc(5, 1), Buffer.alloc(7, 2)]),
    6,
    (f) => seen.push(Buffer.from(f))
  )
  assert.equal(count, 2)
  assert.deepEqual([...seen[1]], [2, 2, 2, 2, 2, 2])
  await assert.rejects(
    consumeRgbFrames(Readable.from([Buffer.alloc(7)]), 6, () => {}),
    /Truncated/
  )
  await assert.rejects(
    consumeRgbFrames(Readable.from([Buffer.alloc(12)]), 6, () => {}, 1),
    /frame bound/
  )
})

test('a managed recording needs explicit authorization and is never fetched', async () => {
  const result = await analyzeCompositedRecording({
    file: '/nonexistent/managed.mp4',
    geometry,
    scale: 1,
    ground,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    managed: true,
    authorized: false
  })
  assert.equal(result.status, 'unavailable')
})
