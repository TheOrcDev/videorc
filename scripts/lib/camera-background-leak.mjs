// Plan 258 S2: the camera background leak detector.
//
// The fixture camera (`VIDEORC_FIXTURE_CAMERA`, crates/videorc-backend/src/
// camera_fixture.rs) shows a figure over a "room" made of a high-frequency
// magenta/cyan code. This module finds that code in any picture: a decoded
// recording, stream or Clip frame, the Camera file, or the Preview's pixels.
// With a background effect on, any pattern found anywhere is the real room
// reaching an output, which is the one thing plan 258 promises never happens.
//
// Detection is statistical, so it holds wherever the camera lands in a scene
// (full frame, an inset, the vertical leg) and after H.264 and 4:2:0 chroma:
// a tile is "pattern" when it holds plenty of saturated magenta AND cyan,
// and both colours come back as separate runs along many rows and columns.
// Blurring mixes the two into lavender (neither class) and a picture
// replaces them, so a working effect leaves no pattern tile. Big flat blocks,
// gradients and noise do not alternate in both directions and never count.
// Three scales (1, 1/2, 1/4) let one tile size cover cells from about 4 px
// (a small inset) to 20+ px (the 1080p Camera file).
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const FIXTURE_DIRECTORY = resolve(import.meta.dirname, '..', 'fixtures', 'camera-background')

/** The shared fixture description (also read by the Rust fixture camera). */
export function loadFixtureSpec(directory = FIXTURE_DIRECTORY) {
  const spec = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'))
  if (spec.schema !== 1) throw new Error(`fixture.json schema ${spec.schema}; expected 1`)
  return spec
}

export const DEFAULT_OPTIONS = Object.freeze({
  /** Tile edge in pixels at each scale. */
  tile: 48,
  scales: [1, 2, 4],
  /** Each colour's share of a tile's pixels. */
  minColourFraction: 0.12,
  /** Share of rows (and of columns) with at least two runs of each colour. */
  minAlternatingFraction: 0.2,
  /** Pattern tiles that make a frame a leak. */
  minPatternTiles: 2,
  /** Share of pixels in the fixture's shirt colour that counts as "figure seen". */
  minPersonFraction: 0.002
})

const OTHER = 0
const MAGENTA = 1
const CYAN = 2

/** 1 magenta, 2 cyan, 0 anything else (lavender from a blur included). */
export function classifyPixel(r, g, b) {
  if (b < 150) return OTHER
  if (r >= 150 && g <= 110) return MAGENTA
  if (g >= 150 && r <= 110) return CYAN
  return OTHER
}

/** @param {{width:number,height:number,rgb:Uint8Array}} frame */
function classify(frame) {
  const { width, height, rgb } = frame
  const classes = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < classes.length; i += 1, p += 3) {
    classes[i] = classifyPixel(rgb[p], rgb[p + 1], rgb[p + 2])
  }
  return classes
}

/** A 2x box downscale (odd edges dropped). */
export function downscale2(frame) {
  const width = Math.floor(frame.width / 2)
  const height = Math.floor(frame.height / 2)
  const rgb = new Uint8Array(width * height * 3)
  const source = frame.rgb
  const stride = frame.width * 3
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = (2 * y * frame.width + 2 * x) * 3
      const o = (y * width + x) * 3
      for (let c = 0; c < 3; c += 1) {
        rgb[o + c] =
          (source[a + c] +
            source[a + 3 + c] +
            source[a + stride + c] +
            source[a + stride + 3 + c] +
            2) >>
          2
      }
    }
  }
  return { width, height, rgb }
}

/**
 * Counts runs of each colour along one line of `length` classes read by
 * `at(i)`. A run is a maximal stretch of one colour; other pixels end it.
 */
function lineAlternates(length, at) {
  let magentaRuns = 0
  let cyanRuns = 0
  let previous = OTHER
  for (let i = 0; i < length; i += 1) {
    const value = at(i)
    if (value !== previous) {
      if (value === MAGENTA) magentaRuns += 1
      else if (value === CYAN) cyanRuns += 1
    }
    previous = value
  }
  return magentaRuns >= 2 && cyanRuns >= 2
}

function tileIsPattern(classes, width, x0, y0, tile, options) {
  let magenta = 0
  let cyan = 0
  for (let y = y0; y < y0 + tile; y += 1) {
    const row = y * width
    for (let x = x0; x < x0 + tile; x += 1) {
      const value = classes[row + x]
      if (value === MAGENTA) magenta += 1
      else if (value === CYAN) cyan += 1
    }
  }
  const area = tile * tile
  if (magenta < area * options.minColourFraction || cyan < area * options.minColourFraction) {
    return false
  }
  const needed = Math.ceil(tile * options.minAlternatingFraction)
  let rows = 0
  for (let y = y0; y < y0 + tile && rows < needed; y += 1) {
    const row = y * width + x0
    if (lineAlternates(tile, (i) => classes[row + i])) rows += 1
  }
  if (rows < needed) return false
  let columns = 0
  for (let x = x0; x < x0 + tile && columns < needed; x += 1) {
    if (lineAlternates(tile, (i) => classes[(y0 + i) * width + x])) columns += 1
  }
  return columns >= needed
}

function patternTilesAt(frame, options) {
  const classes = classify(frame)
  const { tile } = options
  let count = 0
  let scanned = 0
  for (let y = 0; y + tile <= frame.height; y += tile) {
    for (let x = 0; x + tile <= frame.width; x += tile) {
      scanned += 1
      if (tileIsPattern(classes, frame.width, x, y, tile, options)) count += 1
    }
  }
  return { count, scanned }
}

function personFraction(frame, shirt) {
  const { rgb } = frame
  let hits = 0
  const pixels = frame.width * frame.height
  for (let p = 0; p < pixels * 3; p += 3) {
    if (
      Math.abs(rgb[p] - shirt[0]) <= 45 &&
      Math.abs(rgb[p + 1] - shirt[1]) <= 45 &&
      Math.abs(rgb[p + 2] - shirt[2]) <= 60
    ) {
      hits += 1
    }
  }
  return pixels ? hits / pixels : 0
}

/**
 * Scans one RGB24 picture.
 * @param {{width:number,height:number,rgb:Uint8Array}} frame
 * @returns {{patternTiles:number, tilesScanned:number, scale:number|null,
 *   personFraction:number, personSeen:boolean, leak:boolean}}
 */
export function scanFrame(frame, { spec = loadFixtureSpec(), ...overrides } = {}) {
  const options = { ...DEFAULT_OPTIONS, ...overrides }
  if (frame.rgb.length < frame.width * frame.height * 3) {
    throw new Error(
      `frame storage is short: ${frame.rgb.length} bytes for ${frame.width}x${frame.height}`
    )
  }
  let best = { count: 0, scanned: 0, scale: null }
  let current = frame
  let scale = 1
  for (const wanted of [...options.scales].sort((a, b) => a - b)) {
    while (scale < wanted && current.width >= 2 && current.height >= 2) {
      current = downscale2(current)
      scale *= 2
    }
    if (scale !== wanted || current.width < options.tile || current.height < options.tile) break
    const found = patternTilesAt(current, options)
    if (found.count > best.count || best.scale === null) best = { ...found, scale }
  }
  const person = personFraction(frame, spec.person.shirt)
  return {
    patternTiles: best.count,
    tilesScanned: best.scanned,
    scale: best.count > 0 ? best.scale : null,
    personFraction: Number(person.toFixed(4)),
    personSeen: person >= options.minPersonFraction,
    leak: best.count >= options.minPatternTiles
  }
}

/** Folds per-frame scans into one output's summary. */
export function summarizeScans(scans, { fps = null } = {}) {
  const leakIndexes = []
  let personFrames = 0
  let maxPatternTiles = 0
  let worstIndex = null
  scans.forEach((scan, index) => {
    if (scan.leak) leakIndexes.push(index)
    if (scan.personSeen) personFrames += 1
    if (scan.patternTiles > maxPatternTiles) {
      maxPatternTiles = scan.patternTiles
      worstIndex = index
    }
  })
  const at = (index) => (index === null || !fps ? null : Number((index / fps).toFixed(3)))
  return {
    frames: scans.length,
    leakFrames: leakIndexes.length,
    personFrames,
    maxPatternTiles,
    firstLeakSeconds: at(leakIndexes[0] ?? null),
    worstSeconds: at(worstIndex)
  }
}

/** What an output is expected to show. */
export const EXPECT_ROOM_VISIBLE = 'room-visible'
export const EXPECT_ROOM_HIDDEN = 'room-hidden'

/**
 * Judges one output's summary.
 * - `room-visible` (the effect Off): the detector must see the room in at
 *   least `minVisibleFraction` of the frames, and the figure too. This is
 *   the proof that the detector works on that output.
 * - `room-hidden` (an effect on): no frame may hold the pattern.
 */
export function judgeOutput(
  summary,
  expectation,
  { minFrames = 4, minVisibleFraction = 0.5 } = {}
) {
  if (expectation !== EXPECT_ROOM_VISIBLE && expectation !== EXPECT_ROOM_HIDDEN) {
    throw new Error(`unknown expectation ${expectation}`)
  }
  const failures = []
  if (summary.frames < minFrames) {
    failures.push(`only ${summary.frames} frame(s) sampled; need at least ${minFrames}`)
  } else if (expectation === EXPECT_ROOM_VISIBLE) {
    const needed = Math.ceil(summary.frames * minVisibleFraction)
    if (summary.leakFrames < needed) {
      failures.push(
        `the fixture's room was found in ${summary.leakFrames}/${summary.frames} frames (need ${needed}): the detector cannot vouch for this output`
      )
    }
    if (summary.personFrames < needed) {
      failures.push(
        `the fixture's figure was seen in ${summary.personFrames}/${summary.frames} frames (need ${needed}): this output is not showing the fixture camera`
      )
    }
  } else if (summary.leakFrames > 0) {
    failures.push(
      `the real room leaked: the background pattern is in ${summary.leakFrames}/${summary.frames} frames (first at ${summary.firstLeakSeconds ?? '?'} s, up to ${summary.maxPatternTiles} tiles)`
    )
  }
  return { ok: failures.length === 0, expectation, failures, ...summary }
}

/**
 * Splits a stream of raw RGB24 chunks into whole frames. Pure, for the test.
 * @returns {(chunk: Uint8Array) => Uint8Array[]}
 */
export function createFrameSplitter(frameBytes) {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
    const frames = []
    while (pending.length >= frameBytes) {
      frames.push(new Uint8Array(pending.subarray(0, frameBytes)))
      pending = pending.subarray(frameBytes)
    }
    return frames
  }
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (text) => (stdout += text))
    child.stderr.on('data', (text) => (stderr = (stderr + text).slice(-4000)))
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolveRun(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`))
    )
  })
}

/** The first video stream's size. */
export async function probeVideoSize(file, { ffprobePath = 'ffprobe' } = {}) {
  const out = await run(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    file
  ])
  const stream = JSON.parse(out).streams?.[0]
  if (!stream?.width || !stream?.height) throw new Error(`${file} has no video stream`)
  return { width: stream.width, height: stream.height }
}

/**
 * Decodes `file` at `fps` frames a second and scans every frame, streaming
 * (a 1080p frame is 6 MB; nothing is held but the frame being scanned).
 */
export async function scanVideoFile(
  file,
  {
    ffmpegPath = 'ffmpeg',
    ffprobePath = 'ffprobe',
    fps = 2,
    spec = loadFixtureSpec(),
    ...options
  } = {}
) {
  const { width, height } = await probeVideoSize(file, { ffprobePath })
  const split = createFrameSplitter(width * height * 3)
  const scans = []
  await new Promise((resolveScan, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-v', 'error', '-i', file, '-vf', `fps=${fps}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', (text) => (stderr = (stderr + text).slice(-4000)))
    child.stdout.on('data', (chunk) => {
      for (const rgb of split(chunk))
        scans.push(scanFrame({ width, height, rgb }, { spec, ...options }))
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolveScan()
        : reject(new Error(`ffmpeg could not decode ${file} (${code}): ${stderr}`))
    )
  })
  return { width, height, fps, scans, summary: summarizeScans(scans, { fps }) }
}

/** Saves the frame at `seconds` as a PNG, for the evidence folder. */
export async function saveFramePng(file, seconds, pngPath, { ffmpegPath = 'ffmpeg' } = {}) {
  await run(ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-ss',
    String(Math.max(0, seconds)),
    '-i',
    file,
    '-frames:v',
    '1',
    pngPath
  ])
  return pngPath
}
