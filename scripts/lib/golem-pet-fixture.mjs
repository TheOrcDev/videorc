// The synthetic pet pack for `smoke:golem-pet` (plan 168 S-C5) and the
// analyzer that reads which cell is on screen from a recorded frame.
//
// Every cell is the same simple silhouette: a flat green body on a
// transparent cell, with a square colour tag in its middle. The tag colour is
// unique per cell and taken from a 4-level RGB grid (85 apart per channel)
// that skips greys, the body green and every colour the synthetic test
// pattern, the comment card and the bubble draw, so a recorded frame names
// its cell even through H.264 and a colour-matrix mismatch. Nothing here is
// page-pet art: the cells are drawn in code.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

export const GOLEM_PET_FIXTURE_NAME = 'Smoke tags'
export const GOLEM_PET_FIXTURE_SHEET = 'mascot.png'
/** Cells are 256 px squares (the pack rules allow 128 to 1024). */
export const GOLEM_PET_FIXTURE_CELL_PX = 256
export const GOLEM_PET_FIXTURE_COLUMNS = 7
/** The body: a flat green no other layer draws. */
export const GOLEM_PET_FIXTURE_BODY_RGB = Object.freeze([0, 200, 90])
/** The body silhouette in normalized cell coordinates (feet near the bottom). */
export const GOLEM_PET_FIXTURE_BODY = Object.freeze({
  left: 0.18,
  top: 0.14,
  right: 0.82,
  bottom: 0.94
})
/** The colour tag: a square this side, centred here, in cell units. */
export const GOLEM_PET_FIXTURE_TAG = Object.freeze({ centerX: 0.5, centerY: 0.54, side: 0.34 })
/** page-pet's 5 x 5 gaze grid. */
export const GOLEM_PET_FIXTURE_GAZE_STEPS = Object.freeze([-1, -0.5, 0, 0.5, 1])
/** The reactions the animator's defaults and rules use (D12 to D14). */
export const GOLEM_PET_FIXTURE_REACTIONS = Object.freeze([
  'wave',
  'proud',
  'surprised',
  'talk-a',
  'talk-b',
  'sleep',
  'blink',
  'excited',
  'wink',
  'laugh'
])
export const GOLEM_PET_FIXTURE_NEUTRAL = 'look-22'
export const GOLEM_PET_FIXTURE_PIVOT = Object.freeze([0.5, 0.9])

const LEVELS = [0, 85, 170, 255]
/** Colours the frame shows besides the pet: the test pattern's pink line,
 * yellow marker and white line, and the smoke's comment card. */
const AVOID_RGB = [
  [220, 92, 180],
  [255, 245, 80],
  [235, 235, 235],
  [255, 82, 45]
]

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** The tag colours, most robust first (the brightest, most saturated). */
export function golemPetFixturePalette() {
  const colours = []
  for (const r of LEVELS) {
    for (const g of LEVELS) {
      for (const b of LEVELS) {
        const colour = [r, g, b]
        if (r === g && g === b) continue
        if (distance(colour, GOLEM_PET_FIXTURE_BODY_RGB) < 100) continue
        if (AVOID_RGB.some((avoid) => distance(colour, avoid) < 90)) continue
        // The test pattern's background ramp (base, base + 18, base + 36).
        let background = Infinity
        for (let base = 44; base <= 176; base += 1) {
          background = Math.min(background, distance(colour, [base, base + 18, base + 36]))
        }
        if (background < 70) continue
        colours.push(colour)
      }
    }
  }
  const strength = ([r, g, b]) => Math.max(r, g, b) * 2 + (Math.max(r, g, b) - Math.min(r, g, b))
  return colours.sort((a, b) => strength(b) - strength(a))
}

/** `look-{col}{row}`: the gaze cell at `[STEPS[col], STEPS[row]]`. */
export function golemPetFixtureGazeId(x, y) {
  const index = (value) => GOLEM_PET_FIXTURE_GAZE_STEPS.indexOf(value)
  return `look-${index(x)}${index(y)}`
}

/** Every frame of the pack, in sheet order, with its tag colour. The cells
 * the smoke reads (the reactions, the neutral cell, the left-looking cells)
 * get the most robust colours. */
export function golemPetFixtureFrames() {
  const gaze = []
  for (const y of GOLEM_PET_FIXTURE_GAZE_STEPS) {
    for (const x of GOLEM_PET_FIXTURE_GAZE_STEPS) {
      gaze.push({ id: golemPetFixtureGazeId(x, y), kind: 'gaze', gaze: [x, y] })
    }
  }
  const reactions = GOLEM_PET_FIXTURE_REACTIONS.map((id) => ({ id, kind: 'reaction' }))
  const priority = (frame) => {
    if (frame.kind === 'reaction') return 0
    if (frame.id === GOLEM_PET_FIXTURE_NEUTRAL) return 1
    if (frame.gaze[0] < 0) return 2
    return 3
  }
  const palette = golemPetFixturePalette()
  const ranked = [...reactions, ...gaze].sort((a, b) => priority(a) - priority(b))
  if (ranked.length > palette.length) {
    throw new Error(`The tag palette has ${palette.length} colours for ${ranked.length} cells.`)
  }
  const tags = new Map(ranked.map((frame, index) => [frame.id, palette[index]]))
  return [...gaze, ...reactions].map((frame, index) => {
    const column = index % GOLEM_PET_FIXTURE_COLUMNS
    const row = Math.floor(index / GOLEM_PET_FIXTURE_COLUMNS)
    const size = GOLEM_PET_FIXTURE_CELL_PX
    return { ...frame, tag: tags.get(frame.id), rect: [column * size, row * size, size, size] }
  })
}

/** page-pet manifest v1 for the frames. */
export function golemPetFixtureManifest(frames = golemPetFixtureFrames()) {
  return {
    version: 1,
    name: GOLEM_PET_FIXTURE_NAME,
    neutral: GOLEM_PET_FIXTURE_NEUTRAL,
    pivot: [...GOLEM_PET_FIXTURE_PIVOT],
    frames: frames.map(({ id, kind, gaze, rect }) => ({
      id,
      kind,
      sheet: GOLEM_PET_FIXTURE_SHEET,
      rect,
      ...(gaze ? { gaze } : {})
    }))
  }
}

/** One cell's RGBA pixels: transparent, the green body, the tag. */
export function golemPetFixtureCellRgba(tag, size = GOLEM_PET_FIXTURE_CELL_PX) {
  const rgba = Buffer.alloc(size * size * 4)
  const body = GOLEM_PET_FIXTURE_BODY
  const half = GOLEM_PET_FIXTURE_TAG.side / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size
      const v = (y + 0.5) / size
      if (u < body.left || u > body.right || v < body.top || v > body.bottom) continue
      const inTag =
        Math.abs(u - GOLEM_PET_FIXTURE_TAG.centerX) <= half &&
        Math.abs(v - GOLEM_PET_FIXTURE_TAG.centerY) <= half
      const colour = inTag ? tag : GOLEM_PET_FIXTURE_BODY_RGB
      const offset = (y * size + x) * 4
      rgba[offset] = colour[0]
      rgba[offset + 1] = colour[1]
      rgba[offset + 2] = colour[2]
      rgba[offset + 3] = 255
    }
  }
  return rgba
}

/** The whole sheet as RGBA: every frame's cell at its rect. */
export function golemPetFixtureSheetRgba(frames = golemPetFixtureFrames()) {
  const size = GOLEM_PET_FIXTURE_CELL_PX
  const width = GOLEM_PET_FIXTURE_COLUMNS * size
  const height = Math.ceil(frames.length / GOLEM_PET_FIXTURE_COLUMNS) * size
  const rgba = Buffer.alloc(width * height * 4)
  for (const frame of frames) {
    const cell = golemPetFixtureCellRgba(frame.tag, size)
    const [left, top] = frame.rect
    for (let row = 0; row < size; row += 1) {
      cell.copy(rgba, ((top + row) * width + left) * 4, row * size * 4, (row + 1) * size * 4)
    }
  }
  return { width, height, rgba }
}

/** Write the pack folder (`manifest.json` and the sheet). The import writes
 * `golem.json` itself (talk frames found, head top measured). */
export function writeGolemPetFixturePack(directory) {
  const frames = golemPetFixtureFrames()
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'manifest.json'),
    `${JSON.stringify(golemPetFixtureManifest(frames), null, 2)}\n`
  )
  const sheet = golemPetFixtureSheetRgba(frames)
  writeFileSync(
    join(directory, GOLEM_PET_FIXTURE_SHEET),
    encodePngRgba(sheet.width, sheet.height, sheet.rgba)
  )
  return frames
}

// --- Reading a recorded frame --------------------------------------------------------

/** The Rust `golem_sprite::golem_box`: the square the cell fills on a canvas,
 * `[x, y, side, side]` in canvas pixels. */
export function golemPetBox(rect, canvasWidth, canvasHeight) {
  const width = Math.max(1, canvasWidth)
  const height = Math.max(1, canvasHeight)
  const side = Math.min(Math.max(1, Math.round(rect.w * width)), width, height)
  const left = clamp(Math.round((rect.x + rect.w / 2) * width - side / 2), 0, width - side)
  const bottomGravity = rect.y + rect.h / 2 >= 0.5
  const top = clamp(
    bottomGravity ? Math.round((rect.y + rect.h) * height) - side : Math.round(rect.y * height),
    0,
    height - side
  )
  return [left, top, side, side]
}

/** The tag colour's cell, or `null` when the colour is no tag (the pet is
 * not drawn there, or something covers it). */
export function classifyGolemPetTag(rgb, frames = golemPetFixtureFrames()) {
  let best = null
  let second = Infinity
  for (const frame of frames) {
    const gap = distance(rgb, frame.tag)
    if (!best || gap < best.gap) {
      if (best) second = best.gap
      best = { frame, gap }
    } else if (gap < second) {
      second = gap
    }
  }
  if (!best || best.gap > 55 || second - best.gap < 15) return null
  return best.frame
}

/** The median colour of a `size` x `size` patch centred at `(x, y)`. */
export function medianPatchRgb(rgb, width, height, x, y, size = 9) {
  const half = Math.floor(size / 2)
  const channels = [[], [], []]
  for (let row = Math.round(y) - half; row <= Math.round(y) + half; row += 1) {
    for (let column = Math.round(x) - half; column <= Math.round(x) + half; column += 1) {
      if (row < 0 || column < 0 || row >= height || column >= width) continue
      const offset = (row * width + column) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        channels[channel].push(rgb[offset + channel])
      }
    }
  }
  return channels.map((values) => {
    values.sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)] ?? 0
  })
}

/** The bounding box `[left, top, right, bottom]` of body-green pixels in a
 * frame (or a crop), or `null` with too few of them. */
export function golemPetBodyBox(rgb, width, height, { minPixels = 400 } = {}) {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  let count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const pixel = [rgb[offset], rgb[offset + 1], rgb[offset + 2]]
      if (distance(pixel, GOLEM_PET_FIXTURE_BODY_RGB) > 60) continue
      count += 1
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  return count >= minPixels ? [left, top, right, bottom] : null
}

/** Read one recorded frame (or a crop at `origin`): which cell the pet shows
 * (from the tag at the untransformed box's tag centre) and where its body is. */
export function readGolemPetFrame(rgb, width, height, { box, origin = [0, 0], frames }) {
  const [boxX, boxY, side] = box
  const tagX = boxX + GOLEM_PET_FIXTURE_TAG.centerX * side - origin[0]
  const tagY = boxY + GOLEM_PET_FIXTURE_TAG.centerY * side - origin[1]
  const colour = medianPatchRgb(rgb, width, height, tagX, tagY)
  const frame = classifyGolemPetTag(colour, frames)
  const body = golemPetBodyBox(rgb, width, height, {
    minPixels: Math.round(side * side * 0.2)
  })
  return { id: frame?.id ?? null, gaze: frame?.gaze ?? null, colour, body }
}

/** Runs of the same cell id over a timeline of `{ t, id }`. */
export function golemPetRuns(timeline) {
  const runs = []
  for (const sample of timeline) {
    const last = runs.at(-1)
    if (last && last.id === sample.id) {
      last.end = sample.t
      last.frames += 1
    } else {
      runs.push({ id: sample.id, start: sample.t, end: sample.t, frames: 1 })
    }
  }
  return runs
}

/** How far the body box strays from a resting box, in pixels: the largest
 * edge offset over the samples. */
export function golemPetBodyTravel(samples, rest) {
  let travel = 0
  for (const sample of samples) {
    if (!sample.body || !rest) continue
    for (let edge = 0; edge < 4; edge += 1) {
      travel = Math.max(travel, Math.abs(sample.body[edge] - rest[edge]))
    }
  }
  return travel
}

/** The per-edge median of body boxes (a resting pose from many frames). */
export function golemPetMedianBox(samples) {
  const boxes = samples.map((sample) => sample.body).filter(Boolean)
  if (boxes.length === 0) return null
  return [0, 1, 2, 3].map((edge) => {
    const values = boxes.map((box) => box[edge]).sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)]
  })
}

/** Whether the talk frames alternate: the talk ids in order (neutral and
 * repeats dropped) go a, b, a, b ... at least `minSteps` long. */
export function golemPetTalkAlternates(timeline, minSteps = 4) {
  const talk = golemPetRuns(timeline)
    .map((run) => run.id)
    .filter((id) => id === 'talk-a' || id === 'talk-b')
  const steps = talk.filter((id, index) => index === 0 || id !== talk[index - 1])
  return steps.length >= minSteps && steps.length === talk.length
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// --- PNG -----------------------------------------------------------------------------

export function encodePngRgba(width, height, rgba) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * stride] = 0
    rgba.copy(raw, row * stride + 1, row * width * 4, (row + 1) * width * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

let crcTable
function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, value) => {
    let checksum = value
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1
    }
    return checksum >>> 0
  })
  let checksum = 0xffffffff
  for (const byte of bytes) {
    checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8)
  }
  return (checksum ^ 0xffffffff) >>> 0
}
