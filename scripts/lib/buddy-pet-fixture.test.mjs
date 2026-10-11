import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  BUDDY_PET_FIXTURE_BODY_RGB,
  BUDDY_PET_FIXTURE_CELL_PX,
  BUDDY_PET_FIXTURE_NEUTRAL,
  BUDDY_PET_FIXTURE_REACTIONS,
  BUDDY_PET_FIXTURE_SHEET,
  classifyBuddyPetTag,
  buddyPetBodyTravel,
  buddyPetBox,
  buddyPetFixtureCellRgba,
  buddyPetFixtureFrames,
  buddyPetFixtureManifest,
  buddyPetFixturePalette,
  buddyPetMedianBox,
  buddyPetRuns,
  buddyPetTalkAlternates,
  readBuddyPetFrame,
  writeBuddyPetFixturePack
} from './buddy-pet-fixture.mjs'
import { decodePng } from './image-stats.mjs'

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** A canvas with the test pattern's dark background and one cell of the pack
 * drawn into `box` (nearest scaling), shifted by `offset`, with `noise` added
 * to every channel. */
function canvasWithCell({ width, height, box, tag, offset = [0, 0], noise = 0 }) {
  const rgb = Buffer.alloc(width * height * 3)
  for (let index = 0; index < width * height; index += 1) {
    rgb[index * 3] = 60
    rgb[index * 3 + 1] = 78
    rgb[index * 3 + 2] = 96
  }
  const size = BUDDY_PET_FIXTURE_CELL_PX
  const cell = buddyPetFixtureCellRgba(tag, size)
  const [left, top, side] = box
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const source = (Math.floor((y / side) * size) * size + Math.floor((x / side) * size)) * 4
      if (cell[source + 3] === 0) continue
      const cx = left + x + offset[0]
      const cy = top + y + offset[1]
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue
      for (let channel = 0; channel < 3; channel += 1) {
        const value = cell[source + channel] + noise
        rgb[(cy * width + cx) * 3 + channel] = Math.max(0, Math.min(255, value))
      }
    }
  }
  return rgb
}

describe('buddy pet smoke fixture', () => {
  it('has a unique, well separated tag per cell, apart from the body', () => {
    const frames = buddyPetFixtureFrames()
    assert.equal(frames.filter((frame) => frame.kind === 'gaze').length, 25)
    assert.deepEqual(
      frames.filter((frame) => frame.kind === 'reaction').map((frame) => frame.id),
      [...BUDDY_PET_FIXTURE_REACTIONS]
    )
    assert.equal(new Set(frames.map((frame) => frame.id)).size, frames.length)
    assert.ok(buddyPetFixturePalette().length >= frames.length)
    for (const [index, frame] of frames.entries()) {
      assert.ok(distance(frame.tag, BUDDY_PET_FIXTURE_BODY_RGB) >= 100, frame.id)
      for (const other of frames.slice(index + 1)) {
        assert.ok(distance(frame.tag, other.tag) >= 85, `${frame.id} vs ${other.id}`)
      }
    }
    const neutral = frames.find((frame) => frame.id === BUDDY_PET_FIXTURE_NEUTRAL)
    assert.deepEqual(neutral.gaze, [0, 0])
  })

  it('writes a page-pet v1 pack whose sheet carries every tag', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-pet-fixture-'))
    try {
      const frames = writeBuddyPetFixturePack(directory)
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
      assert.deepEqual(manifest, buddyPetFixtureManifest(frames))
      assert.equal(manifest.version, 1)
      assert.equal(manifest.neutral, BUDDY_PET_FIXTURE_NEUTRAL)
      const sheet = decodePng(readFileSync(join(directory, BUDDY_PET_FIXTURE_SHEET)))
      for (const frame of manifest.frames) {
        const [x, y, w, h] = frame.rect
        assert.equal(w, h)
        assert.ok(x + w <= sheet.width && y + h <= sheet.height, frame.id)
        const pixel = (u, v) => {
          const offset = ((y + Math.floor(v * h)) * sheet.width + x + Math.floor(u * w)) * 4
          return [...sheet.data.subarray(offset, offset + 4)]
        }
        const tag = frames.find((candidate) => candidate.id === frame.id).tag
        assert.deepEqual(pixel(0.5, 0.54), [...tag, 255], frame.id)
        assert.deepEqual(pixel(0.5, 0.2), [...BUDDY_PET_FIXTURE_BODY_RGB, 255], frame.id)
        // Transparent around the body (the pack rules refuse opaque cells).
        assert.equal(pixel(0.02, 0.02)[3], 0, frame.id)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('places the box like the backend', () => {
    // Bottom half: rests on the rect's bottom edge, centred on it.
    assert.deepEqual(
      buddyPetBox({ x: 0.74, y: 0.4, w: 0.2, h: 0.55 }, 1280, 720),
      [947, 428, 256, 256]
    )
    // Top half: hangs from the top edge; kept inside the canvas.
    assert.deepEqual(
      buddyPetBox({ x: 0.9, y: 0.05, w: 0.2, h: 0.3 }, 1000, 500),
      [800, 25, 200, 200]
    )
  })

  it('reads the cell, its gaze and the body box from a frame', () => {
    const frames = buddyPetFixtureFrames()
    const box = [400, 120, 192, 192]
    const left = frames.find((frame) => frame.gaze?.[0] === -1 && frame.gaze[1] === 0)
    const rgb = canvasWithCell({ width: 640, height: 360, box, tag: left.tag, noise: 20 })
    const read = readBuddyPetFrame(rgb, 640, 360, { box, frames })
    assert.equal(read.id, left.id)
    assert.deepEqual(read.gaze, [-1, 0])
    // The body spans 0.18..0.82 x 0.14..0.94 of the box.
    const [l, t, r, b] = read.body
    assert.ok(Math.abs(l - (400 + 0.18 * 192)) <= 2, `${read.body}`)
    assert.ok(Math.abs(t - (120 + 0.14 * 192)) <= 2, `${read.body}`)
    assert.ok(Math.abs(r - (400 + 0.82 * 192)) <= 2, `${read.body}`)
    assert.ok(Math.abs(b - (120 + 0.94 * 192)) <= 2, `${read.body}`)
    // A moved body moves its box; the tag still reads at the box centre.
    const wave = frames.find((frame) => frame.id === 'wave')
    const moved = canvasWithCell({ width: 640, height: 360, box, tag: wave.tag, offset: [6, -9] })
    const shifted = readBuddyPetFrame(moved, 640, 360, { box, frames })
    assert.equal(shifted.id, 'wave')
    assert.equal(buddyPetBodyTravel([shifted], read.body), 9)
    // No pet: no cell, no body.
    const empty = canvasWithCell({ width: 640, height: 360, box: [0, 0, 0, 0], tag: wave.tag })
    const nothing = readBuddyPetFrame(empty, 640, 360, { box, frames })
    assert.equal(nothing.id, null)
    assert.equal(nothing.body, null)
  })

  it('names a colour only when one tag is clearly nearest', () => {
    const frames = buddyPetFixtureFrames()
    for (const frame of frames) {
      const shifted = frame.tag.map((value) => Math.max(0, Math.min(255, value + 25)))
      assert.equal(classifyBuddyPetTag(shifted, frames)?.id, frame.id)
    }
    assert.equal(classifyBuddyPetTag([128, 128, 128], frames), null)
    assert.equal(classifyBuddyPetTag([...BUDDY_PET_FIXTURE_BODY_RGB], frames), null)
  })

  it('summarizes a timeline into runs, the resting box and the talk rhythm', () => {
    const timeline = ['look-22', 'talk-a', 'talk-a', 'talk-b', 'look-22', 'talk-a', 'talk-b'].map(
      (id, index) => ({ t: index / 10, id, body: [10, 10, 50, 90] })
    )
    assert.deepEqual(
      buddyPetRuns(timeline).map((run) => [run.id, run.frames]),
      [
        ['look-22', 1],
        ['talk-a', 2],
        ['talk-b', 1],
        ['look-22', 1],
        ['talk-a', 1],
        ['talk-b', 1]
      ]
    )
    assert.ok(buddyPetTalkAlternates(timeline, 4))
    assert.ok(!buddyPetTalkAlternates(timeline, 5))
    const stutter = ['talk-a', 'look-22', 'talk-a', 'talk-b'].map((id, t) => ({ t, id }))
    assert.ok(!buddyPetTalkAlternates(stutter, 2))
    assert.deepEqual(
      buddyPetMedianBox([
        { body: [10, 10, 50, 90] },
        { body: [12, 8, 52, 90] },
        { body: [10, 10, 50, 91] },
        { body: null }
      ]),
      [10, 10, 50, 90]
    )
  })
})
