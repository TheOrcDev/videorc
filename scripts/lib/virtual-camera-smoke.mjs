// Pure logic for smoke:virtual-camera (plan 214 F1): what a packaged Videorc
// must show through Videorc Camera when another app reads it with the
// platform's FFmpeg, and how every step reads as PASS, FAIL or SKIP. Data in,
// verdict out, so `virtual-camera-smoke.test.mjs` holds each rule to its word
// without a camera. The red-first case (today's base, where nothing pushes
// frames) is one of those tests.
//
// The marker. Four banners sit in the program's left background ring (the
// bundled background shows there, D11 keeps the camera 16:9). Banner 0 is a
// finder that stays shown; banners 1 to 3 carry a 3-bit Gray code the smoke
// advances once a second through `banners.show` / `banners.hide`, so each
// step toggles exactly one banner and a frame is never between two codes.
// Every banner is a 2x2 checker (white top-left and bottom-right, black
// elsewhere): a cell reads "on" when its diagonals differ by
// CELL_ON_CONTRAST, whatever is drawn under it, and "off" below
// CELL_OFF_CONTRAST. The 200 ms banner fade lands between the two and reads
// as unknown, never as the wrong bit. Banners draw above Hide screen's frost,
// so the code keeps running while the screen is hidden.
//
// Frames are rgb24 at 480x270. The frost is judged on a crop of the stage
// (the capture source, inset off the stage border) that comes out at about
// the 320x180 smart-scenes-gate.mjs calibrated its sharpness bounds on.

import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

import { frameFeatures, meanAbsoluteDifference, regionMean } from './scene-window-switch-frames.mjs'
import { hideSpanVerdict, sharpFraction } from './smart-scenes-gate.mjs'

const identifiers = JSON.parse(
  readFileSync(
    new URL('../../apps/desktop/camera-extension/identifiers.json', import.meta.url),
    'utf8'
  )
)

/**
 * Videorc Camera as each platform names it. The Windows and Linux constants
 * mirror `crates/videorc-backend/src/virtual_camera.rs`; the test reads that
 * file so the two cannot drift.
 */
export const VIRTUAL_CAMERA = Object.freeze({
  name: identifiers.cameraName,
  macosDeviceUuid: identifiers.deviceUuid,
  windowsSourceClsid: '{B629EEBB-4B8E-4CAB-A549-EB17570B1382}',
  windowsNameSuffix: ' Windows Virtual Camera',
  linuxCardLabel: 'Videorc Camera',
  linuxVideoNr: 42,
  width: identifiers.format.width,
  height: identifiers.format.height,
  fps: identifiers.format.fps,
  staleAfterSeconds: identifiers.staleAfterSeconds
})

/** F1's numbers. Each assertion in the summary names the one it used. */
export const VIRTUAL_CAMERA_SMOKE_BUDGET = Object.freeze({
  /** F1: 30 ± 1 fps over the read and across Record and Stop. */
  fps: VIRTUAL_CAMERA.fps,
  fpsTolerance: 1,
  /** The judged read, from the first program frame (B4: "reads 30 fps for 10 s"). */
  judgedReadMs: 10_000,
  /** A read shorter than this share of the judged window is itself a failure. */
  judgedCoverageMin: 0.9,
  /** Reader opens the camera to the first program frame (D13 wakes the compositor for a viewer). */
  wakeMs: 5000,
  /** `virtualCamera.set {on:true}` to `ready` or `streaming`. */
  readyTimeoutMs: 20_000,
  /** How far a listing or the off still may lag the switch (staleAfterSeconds plus a poll). */
  presenceSettleMs: 3000,
  /** How long each off-state read lasts. */
  offReadMs: 2500,
  /** F1: the camera's marker matches the recording's within this drift. */
  maxDriftMs: 2000,
  /** The drift search runs wider so a larger drift is named, not aliased. */
  driftSearchMs: 4000,
  agreementMin: 0.95,
  /** The overlap must show the code advance this many times (a still shows one value). */
  distinctCodesMin: 4,
  /** Frames this close to a code change are not judged (banner fade, frame quantisation). */
  transitionGuardMs: 250,
  /** A camera frame stands for a recording frame within this distance. */
  matchToleranceMs: 50,
  /**
   * The background ring's colour, camera against recording (largest channel
   * delta, median). Loose on purpose: the camera reaches FFmpeg as untagged
   * 4:2:2 or full-range 4:2:0 while the recording is tagged BT.709 video
   * range, and the matrix and range guesses alone move a mean by 10 to 20.
   */
  ringColorMaxDelta: 40,
  /** Plan 214 F1: the CPU fit stays under this on Windows and Linux; macOS is zero-copy. */
  convertMsMax: 4,
  /** Cadence windows around Record and Stop: from before the request to after the answer. */
  transitionLeadMs: 500,
  transitionTailMs: 1000
})

/** When each action lands, relative to the step before it (wall ms). */
export const VIRTUAL_CAMERA_SMOKE_SCHEDULE = Object.freeze({
  recordAfterProgramMs: 1500,
  hideAfterRecordingMs: 2000,
  showAfterHideMs: 2000,
  stopAfterShowMs: 2500,
  tailAfterStopMs: 1500
})

/** Every assertion the smoke makes, with its rule, for the summary and the report. */
export const VIRTUAL_CAMERA_SMOKE_ASSERTIONS = Object.freeze([
  {
    id: 'presence',
    rule: 'Windows and Linux list the camera only while the switch is on; macOS lists it always and shows the off still (no marker) while off and the program while on (D12).'
  },
  {
    id: 'cadence',
    rule: 'The read-back runs at 30 ± 1 fps over the judged 10 s.'
  },
  {
    id: 'content',
    rule: "The read-back's code matches the recording's frame by frame (≥ 95% agreement) at a drift of at most 2 s, the code advances at least 4 times, and the bundled background ring matches."
  },
  {
    id: 'hide-screen',
    rule: 'The frost shows within 1 s of screen.hide and stays until Show; the live picture returns within 1 s of screen.show.'
  },
  {
    id: 'no-self-listing',
    rule: 'devices.list never includes Videorc Camera (off, on and after off).'
  },
  {
    id: 'record-stop',
    rule: 'Record and Stop during the read keep the camera at 30 ± 1 fps, and the recording passes the analyzer.'
  },
  {
    id: 'counters',
    rule: 'framePipeline.virtualCameraPushed rises over the read; virtualCameraConvertMsMax stays under 4 ms on Windows and Linux and is 0 on macOS (zero-copy).'
  }
])

// ---------------------------------------------------------------------------
// The marker: geometry, the Gray code and the banner images

/** The scene background's ring: stage margin per side = visibilityPercent / 200. */
export const SCENE_BACKGROUND_VISIBILITY_PERCENT = 30
export const STAGE_MARGIN = SCENE_BACKGROUND_VISIBILITY_PERCENT / 200

const CANVAS_ASPECT = 16 / 9
const CELL_WIDTH = 0.09
/** Square in pixels on a 16:9 canvas, so a square banner fills its rect exactly. */
const CELL_HEIGHT = CELL_WIDTH * CANVAS_ASPECT

/** Canvas fractions of the four banners, all inside the left ring. */
export const MARKER_CELLS = Object.freeze(
  [
    { role: 'finder', bit: null, x: 0.03, y: 0.08 },
    { role: 'bit', bit: 0, x: 0.03, y: 0.3 },
    { role: 'bit', bit: 1, x: 0.03, y: 0.52 },
    { role: 'bit', bit: 2, x: 0.03, y: 0.74 }
  ].map((cell) => Object.freeze({ ...cell, w: CELL_WIDTH, h: CELL_HEIGHT }))
)

export const CODE_BITS = 3
export const CODE_PERIOD = 1 << CODE_BITS

/** Gray code of step `n`, wrapped to the period. */
export function grayCode(n) {
  const step = ((n % CODE_PERIOD) + CODE_PERIOD) % CODE_PERIOD
  return step ^ (step >> 1)
}

/** The step a Gray value stands for (0 to CODE_PERIOD - 1). */
export function grayDecode(gray) {
  let step = gray
  for (let shift = gray >> 1; shift; shift >>= 1) step ^= shift
  return step
}

/** What moving from step n - 1 to step n does: which bit banner toggles, and to what. */
export function codeStep(n) {
  const before = grayCode(n - 1)
  const after = grayCode(n)
  const changed = before ^ after
  return { bit: Math.log2(changed), shown: (after & changed) !== 0, gray: after }
}

/** Which bit banners show for step n. */
export function codeBitsShown(n) {
  const gray = grayCode(n)
  return Array.from({ length: CODE_BITS }, (_, bit) => ((gray >> bit) & 1) === 1)
}

export const CODE_BANNER_SIZE = 128

/**
 * One banner's pixels: the 2x2 checker. `tag` nudges one pixel so the four
 * imports are four distinct files.
 */
export function codeBannerRgb(tag = 0, size = CODE_BANNER_SIZE) {
  const data = new Uint8Array(size * size * 3)
  const half = size / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const white = x < half === y < half
      data.fill(white ? 255 : 0, (y * size + x) * 3, (y * size + x) * 3 + 3)
    }
  }
  data[0] = 255 - (tag & 0x3f)
  return { width: size, height: size, data }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** An 8-bit RGB PNG (no filter), for the banners and the evidence stills. */
export function encodePngRgb({ width, height, data }) {
  const stride = width * 3
  if (data.length < stride * height) throw new Error(`PNG data is shorter than ${width}x${height}.`)
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** `banners.update` params for one marker banner. */
export function markerBannerUpdate(id, cell) {
  return {
    id,
    horizontal: { x: cell.x, y: cell.y, w: cell.w, h: cell.h },
    showOnStream: true,
    showInRecording: true,
    opacity: 1
  }
}

/** The scene background: the bundled image, drawn plain, ringed around the stage. */
export function smokeSceneBackground(bundled) {
  return {
    assetId: bundled.id,
    managedAssetPath: bundled.managedAssetPath,
    fit: 'fill',
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    blurPx: 0,
    dimPercent: 0,
    saturationPercent: 100,
    vignettePercent: 0,
    visibilityPercent: SCENE_BACKGROUND_VISIBILITY_PERCENT
  }
}

// ---------------------------------------------------------------------------
// Frame analysis

export const ANALYSIS_WIDTH = 480
export const ANALYSIS_HEIGHT = 270
export const CELL_ON_CONTRAST = 100
export const CELL_OFF_CONTRAST = 50
/** The right ring, clear of the banners and the stage. */
export const RING_REGION = Object.freeze({ x0: 0.87, x1: 0.98, y0: 0.1, y1: 0.9 })

function meanLuma(frame, width, x0, x1, y0, y1) {
  let sum = 0
  let count = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 3
      sum += 0.2126 * frame[offset] + 0.7152 * frame[offset + 1] + 0.0722 * frame[offset + 2]
      count += 1
    }
  }
  return count ? sum / count : 0
}

/**
 * Signed diagonal contrast of one cell: the mean luma of its white quadrants
 * minus its black ones, each sampled on its inner half.
 */
export function cellContrast(frame, width, height, cell) {
  const left = cell.x * width
  const top = cell.y * height
  const halfWidth = (cell.w * width) / 2
  const halfHeight = (cell.h * height) / 2
  const quadrant = (column, row) => {
    const x0 = Math.max(0, Math.round(left + (column + 0.25) * halfWidth))
    const x1 = Math.min(width, Math.max(x0 + 1, Math.round(left + (column + 0.75) * halfWidth)))
    const y0 = Math.max(0, Math.round(top + (row + 0.25) * halfHeight))
    const y1 = Math.min(height, Math.max(y0 + 1, Math.round(top + (row + 0.75) * halfHeight)))
    return meanLuma(frame, width, x0, x1, y0, y1)
  }
  return (quadrant(0, 0) + quadrant(1, 1)) / 2 - (quadrant(1, 0) + quadrant(0, 1)) / 2
}

/** 1 (banner shown), 0 (hidden) or null (fading, or something else there). */
export function cellState(contrast) {
  if (contrast >= CELL_ON_CONTRAST) return 1
  if (contrast <= CELL_OFF_CONTRAST) return 0
  return null
}

/** The marker in one frame: the finder, and the code step when every bit reads. */
export function decodeMarker(frame, width = ANALYSIS_WIDTH, height = ANALYSIS_HEIGHT) {
  const contrasts = MARKER_CELLS.map((cell) => cellContrast(frame, width, height, cell))
  const states = contrasts.map(cellState)
  const finder = states[0] === 1
  const bits = states.slice(1)
  const code =
    finder && bits.every((bit) => bit !== null)
      ? grayDecode(bits.reduce((gray, bit, index) => gray | (bit << index), 0))
      : null
  return { finder, code, contrasts: contrasts.map((value) => Math.round(value)) }
}

/** The stage, inset so its sharp border with the (unfrosted) ring stays out. */
export function frostCropRegion(stageMargin = STAGE_MARGIN, inset = 0.03) {
  const start = stageMargin + (1 - 2 * stageMargin) * inset
  return Object.freeze({ x0: start, x1: 1 - start, y0: start, y1: 1 - start })
}

/** Copies one region of an rgb24 frame. */
export function cropRgb(frame, width, height, region) {
  const x0 = Math.max(0, Math.round(region.x0 * width))
  const x1 = Math.min(width, Math.round(region.x1 * width))
  const y0 = Math.max(0, Math.round(region.y0 * height))
  const y1 = Math.min(height, Math.round(region.y1 * height))
  const cropWidth = Math.max(0, x1 - x0)
  const cropHeight = Math.max(0, y1 - y0)
  const data = new Uint8Array(cropWidth * cropHeight * 3)
  for (let y = 0; y < cropHeight; y += 1) {
    const from = ((y0 + y) * width + x0) * 3
    data.set(frame.subarray(from, from + cropWidth * 3), y * cropWidth * 3)
  }
  return { data, width: cropWidth, height: cropHeight }
}

/**
 * Everything the verdicts read from one frame: the marker, the stage's
 * sharpness and motion (Hide screen), the ring's colour (the bundled
 * background) and how far the whole frame moved since the previous one.
 */
export function analyzeFrame(
  frame,
  previous,
  { width = ANALYSIS_WIDTH, height = ANALYSIS_HEIGHT, stageMargin = STAGE_MARGIN } = {}
) {
  const marker = decodeMarker(frame, width, height)
  const region = frostCropRegion(stageMargin)
  const crop = cropRgb(frame, width, height, region)
  const previousCrop = previous ? cropRgb(previous, width, height, region) : null
  const stage = frameFeatures(crop.data, previousCrop?.data ?? null, {
    width: crop.width,
    height: crop.height
  })
  return {
    finder: marker.finder,
    code: marker.code,
    contrasts: marker.contrasts,
    sharp: Number(sharpFraction(crop.data, crop.width, crop.height).toFixed(5)),
    repeated: stage.repeated,
    motionDiff: stage.diff,
    ringRgb: regionMean(frame, width, height, RING_REGION).map((value) => Math.round(value)),
    stillDiff: previous ? Number(meanAbsoluteDifference(frame, previous).toFixed(3)) : null
  }
}

/** A marker summary of many analyzed frames. */
export function markerSummary(features) {
  const markerFrames = features.filter((feature) => feature.finder).length
  const codes = new Set(features.filter((feature) => feature.code != null).map((f) => f.code))
  return { frames: features.length, markerFrames, distinctCodes: codes.size }
}

// ---------------------------------------------------------------------------
// Time

/** One `showinfo` line: the frame number and its pts in ms (null when absent). */
export function parseShowinfoLine(line) {
  const match = /\bn:\s*(\d+)\s+pts:\s*(\S+)\s+pts_time:\s*(\S+)/.exec(String(line))
  if (!match) return null
  const seconds = Number(match[3])
  return { n: Number(match[1]), ptsMs: Number.isFinite(seconds) ? seconds * 1000 : null }
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** `wall = pts + offset`: the median of each frame's arrival minus its pts. */
export function wallOffsetMs(ptsMs, arrivalMs) {
  const deltas = []
  for (let index = 0; index < Math.min(ptsMs.length, arrivalMs.length); index += 1) {
    if (Number.isFinite(ptsMs[index]) && Number.isFinite(arrivalMs[index])) {
      deltas.push(arrivalMs[index] - ptsMs[index])
    }
  }
  return median(deltas)
}

/** Whether pts can carry the cadence: finite and strictly increasing. */
export function ptsUsable(ptsMs) {
  if (ptsMs.length < 2) return false
  for (let index = 0; index < ptsMs.length; index += 1) {
    if (!Number.isFinite(ptsMs[index])) return false
    if (index > 0 && ptsMs[index] <= ptsMs[index - 1]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Cadence

const round = (value, digits = 2) =>
  Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null

/** Frames, span, fps and the longest gap of the timestamps inside [fromMs, toMs). */
export function cadenceStats(timesMs, { fromMs = -Infinity, toMs = Infinity } = {}) {
  const inside = timesMs
    .filter((time) => Number.isFinite(time) && time >= fromMs && time < toMs)
    .sort((a, b) => a - b)
  if (inside.length < 2) {
    return { frames: inside.length, spanMs: 0, fps: null, maxGapMs: null }
  }
  let maxGapMs = 0
  for (let index = 1; index < inside.length; index += 1) {
    maxGapMs = Math.max(maxGapMs, inside[index] - inside[index - 1])
  }
  const spanMs = inside.at(-1) - inside[0]
  return {
    frames: inside.length,
    spanMs: Math.round(spanMs),
    fps: round(((inside.length - 1) * 1000) / spanMs),
    maxGapMs: Math.round(maxGapMs)
  }
}

export function fpsWithin(fps, budget = VIRTUAL_CAMERA_SMOKE_BUDGET) {
  return Number.isFinite(fps) && Math.abs(fps - budget.fps) <= budget.fpsTolerance
}

/**
 * The read-back's cadence over the judged window and inside each named
 * window (Record, Stop), all on one wall clock.
 *
 * @param {object} input
 * @param {number[]} input.timesMs each camera frame's wall time
 * @param {{fromMs:number,toMs:number}} input.judged
 * @param {Array<{label:string,fromMs:number,toMs:number}>} [input.windows]
 */
export function cadenceVerdict({
  timesMs,
  judged,
  windows = [],
  budget = VIRTUAL_CAMERA_SMOKE_BUDGET
}) {
  const failures = []
  const overall = cadenceStats(timesMs, judged)
  const wantedMs = judged.toMs - judged.fromMs
  const range = `${budget.fps} ± ${budget.fpsTolerance} fps`
  if (overall.frames < 2) {
    failures.push(`no frames from Videorc Camera inside the judged ${round(wantedMs / 1000, 1)} s`)
  } else {
    if (overall.spanMs < wantedMs * budget.judgedCoverageMin) {
      failures.push(
        `the read covered ${round(overall.spanMs / 1000, 1)} s of the judged ${round(wantedMs / 1000, 1)} s`
      )
    }
    if (!fpsWithin(overall.fps, budget)) {
      failures.push(`the camera ran at ${overall.fps} fps over the read, outside ${range}`)
    }
  }
  const windowStats = windows.map((window) => {
    const stats = cadenceStats(timesMs, window)
    const ok = fpsWithin(stats.fps, budget)
    if (!ok) {
      failures.push(
        `${window.label}: the camera ran at ${stats.fps ?? 'no'} fps (${stats.frames} frame(s) in ${round((window.toMs - window.fromMs) / 1000, 1)} s, longest gap ${stats.maxGapMs ?? 'n/a'} ms), outside ${range}`
      )
    }
    return { label: window.label, ok, ...stats }
  })
  return { ok: failures.length === 0, overall, windows: windowStats, failures }
}

// ---------------------------------------------------------------------------
// Content: the camera against the recording

function nearestByTime(sorted, timeMs) {
  let low = 0
  let high = sorted.length - 1
  if (high < 0) return null
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle].tMs < timeMs) low = middle + 1
    else high = middle
  }
  const candidates = [sorted[low], sorted[low - 1]].filter(Boolean)
  return candidates.reduce((best, entry) =>
    Math.abs(entry.tMs - timeMs) < Math.abs(best.tMs - timeMs) ? entry : best
  )
}

/**
 * Frame-by-frame match of the two code tracks. Finds the offset (camera time
 * = recording time + offset) with the best agreement inside the search
 * window, then holds it to the drift and agreement bounds. The transition
 * guard leaves a plateau of equally good offsets about twice the guard wide;
 * the drift is its centre (the run nearest zero when the code aliases).
 *
 * @param {object} input
 * @param {Array<{tMs:number, code:number|null, ringRgb?:number[]}>} input.camera
 * @param {Array<{tMs:number, code:number|null, ringRgb?:number[]}>} input.recording
 */
export function matchCodeTracks({ camera, recording, budget = VIRTUAL_CAMERA_SMOKE_BUDGET }) {
  const cameraTrack = camera
    .filter((frame) => Number.isFinite(frame.tMs))
    .sort((a, b) => a.tMs - b.tMs)
  const recordingTrack = recording
    .filter((frame) => Number.isFinite(frame.tMs) && frame.code != null)
    .sort((a, b) => a.tMs - b.tMs)
  // The track's ends count as changes: the code may turn just past either one.
  const changes = recordingTrack.length ? [recordingTrack[0].tMs, recordingTrack.at(-1).tMs] : []
  for (let index = 1; index < recordingTrack.length; index += 1) {
    if (recordingTrack[index].code !== recordingTrack[index - 1].code) {
      changes.push((recordingTrack[index].tMs + recordingTrack[index - 1].tMs) / 2)
    }
  }
  const judgedFrames = recordingTrack.filter(
    (frame) => !changes.some((change) => Math.abs(change - frame.tMs) <= budget.transitionGuardMs)
  )
  const pairsAt = (offsetMs) => {
    const pairs = []
    for (const frame of judgedFrames) {
      const target = frame.tMs + offsetMs
      const match = nearestByTime(cameraTrack, target)
      if (!match || match.code == null || Math.abs(match.tMs - target) > budget.matchToleranceMs) {
        continue
      }
      pairs.push({ recording: frame, camera: match })
    }
    return pairs
  }
  const stepMs = 1000 / budget.fps
  const scored = []
  const steps = Math.round(budget.driftSearchMs / stepMs)
  for (let step = -steps; step <= steps; step += 1) {
    const pairs = pairsAt(step * stepMs)
    const agreed = pairs.filter((pair) => pair.camera.code === pair.recording.code).length
    scored.push({ step, agreement: pairs.length ? agreed / pairs.length : 0, judged: pairs.length })
  }
  const topAgreement = Math.max(0, ...scored.map((entry) => entry.agreement))
  const runs = []
  for (const entry of scored) {
    if (entry.judged === 0 || topAgreement - entry.agreement > 1e-9) continue
    const run = runs.at(-1)
    if (run && entry.step === run.at(-1).step + 1) run.push(entry)
    else runs.push([entry])
  }
  const centres = runs.map((run) => Math.round((run[0].step + run.at(-1).step) / 2))
  const centre = centres.sort((a, b) => Math.abs(a) - Math.abs(b))[0]
  let best = null
  if (centre != null) {
    const offsetMs = centre * stepMs
    const pairs = pairsAt(offsetMs)
    const agreed = pairs.filter((pair) => pair.camera.code === pair.recording.code).length
    best = {
      offsetMs,
      agreement: pairs.length ? agreed / pairs.length : 0,
      judged: pairs.length,
      agreed,
      pairs
    }
  }

  const failures = []
  const distinctCodes = new Set(judgedFrames.map((frame) => frame.code)).size
  if (recordingTrack.length === 0) {
    failures.push("the recording carries no readable marker, so the camera can't be matched to it")
  } else if (!best || best.judged === 0) {
    failures.push('no camera frame lines up with the recording inside the drift search')
  } else {
    if (best.judged < judgedFrames.length * 0.5) {
      failures.push(
        `only ${best.judged} of ${judgedFrames.length} recording frames have a camera frame to compare`
      )
    }
    if (best.agreement < budget.agreementMin) {
      failures.push(
        `the camera's marker agrees with the recording on ${round(best.agreement * 100, 1)}% of ${best.judged} frames (needs ${budget.agreementMin * 100}%)`
      )
    }
    if (Math.abs(best.offsetMs) > budget.maxDriftMs) {
      failures.push(
        `the camera is ${Math.round(best.offsetMs)} ms off the recording, more than ${budget.maxDriftMs} ms of drift`
      )
    }
    if (distinctCodes < budget.distinctCodesMin) {
      failures.push(
        `the overlap shows ${distinctCodes} code value(s); the code must advance at least ${budget.distinctCodesMin} times`
      )
    }
  }
  const ringDeltas = (best?.pairs ?? [])
    .filter((pair) => pair.camera.ringRgb && pair.recording.ringRgb)
    .map((pair) =>
      Math.max(
        ...pair.camera.ringRgb.map((value, index) =>
          Math.abs(value - pair.recording.ringRgb[index])
        )
      )
    )
  const ringColorDelta = median(ringDeltas)
  if (ringColorDelta != null && ringColorDelta > budget.ringColorMaxDelta) {
    failures.push(
      `the background ring differs from the recording's by ${ringColorDelta} per channel (median; allowed ${budget.ringColorMaxDelta}): the camera is not showing the bundled image`
    )
  }
  return {
    ok: failures.length === 0,
    offsetMs: best ? Math.round(best.offsetMs) : null,
    agreement: best ? round(best.agreement, 4) : null,
    judged: best?.judged ?? 0,
    agreed: best?.agreed ?? 0,
    recordingFrames: recordingTrack.length,
    distinctCodes,
    ringColorDelta,
    failures
  }
}

// ---------------------------------------------------------------------------
// Hide screen

/**
 * The smart-scenes hide/show verdict on the camera's stage crop. Without the
 * fixture window (Windows and Linux read the display), a still desktop is
 * not a failure after Show, so `requireMotion: false` drops that one rule.
 */
export function cameraHideVerdict({ requireMotion = true, ...input }) {
  const verdict = hideSpanVerdict(input)
  if (!requireMotion) {
    verdict.failures = verdict.failures.filter(
      (failure) => failure !== 'the picture after Show never moved'
    )
    verdict.motionRequired = false
    verdict.ok = verdict.failures.length === 0
  }
  return verdict
}

// ---------------------------------------------------------------------------
// Presence, listings and the reader

const PLATFORM_LABELS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

/** How the platform's FFmpeg names Videorc Camera. */
export function cameraDeviceName(platform) {
  if (platform === 'win32') return `${VIRTUAL_CAMERA.name}${VIRTUAL_CAMERA.windowsNameSuffix}`
  if (platform === 'linux') return `/dev/video${VIRTUAL_CAMERA.linuxVideoNr}`
  return VIRTUAL_CAMERA.name
}

/**
 * The reader: the platform's FFmpeg input for Videorc Camera, and the
 * listing that says whether it exists. Windows reads with the app's main
 * FFmpeg: the bundled `ffmpeg-capture.exe` is an audio-only worker (dshow
 * with no video decoder, scaler or video muxer) and cannot decode a frame.
 */
export function cameraReaderPlan(platform) {
  const { width, height, fps } = VIRTUAL_CAMERA
  const size = `${width}x${height}`
  const device = cameraDeviceName(platform)
  if (platform === 'darwin') {
    return {
      format: 'avfoundation',
      device,
      inputArgs: [
        '-f',
        'avfoundation',
        '-framerate',
        String(fps),
        '-video_size',
        size,
        '-i',
        device
      ],
      listArgs: ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']
    }
  }
  if (platform === 'win32') {
    return {
      format: 'dshow',
      device,
      inputArgs: [
        '-f',
        'dshow',
        '-rtbufsize',
        '256M',
        '-video_size',
        size,
        '-framerate',
        String(fps),
        '-i',
        `video=${device}`
      ],
      listArgs: ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']
    }
  }
  if (platform === 'linux') {
    return {
      format: 'v4l2',
      device,
      inputArgs: ['-f', 'v4l2', '-framerate', String(fps), '-video_size', size, '-i', device],
      listArgs: ['-hide_banner', '-f', 'v4l2', '-list_formats', 'all', '-i', device]
    }
  }
  throw new Error(`smoke:virtual-camera supports macOS, Windows and Linux, not ${platform}.`)
}

/** The decode half of a read: every frame as 480x270 rgb24 on stdout, its pts on stderr. */
export function readerOutputArgs({ width = ANALYSIS_WIDTH, height = ANALYSIS_HEIGHT } = {}) {
  return [
    '-an',
    '-vf',
    `showinfo,scale=${width}:${height}:flags=area,format=rgb24`,
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1'
  ]
}

const LOG_PREFIX = /^\[[^\]]+\]\s*/

/** Video device names from `-f avfoundation -list_devices true`. */
export function parseAvfoundationVideoDevices(text) {
  const names = []
  let inVideo = false
  for (const line of String(text).split(/\r?\n/)) {
    const body = line.replace(LOG_PREFIX, '')
    if (/AVFoundation video devices:/i.test(body)) {
      inVideo = true
      continue
    }
    if (/AVFoundation audio devices:/i.test(body)) {
      inVideo = false
      continue
    }
    const entry = /^\[(\d+)\]\s+(.+?)\s*$/.exec(body)
    if (inVideo && entry) names.push(entry[2])
  }
  return names
}

/** Video device names from `-list_devices true -f dshow` (FFmpeg 5+ and the older header form). */
export function parseDshowVideoDevices(text) {
  const names = []
  let legacySection = null
  for (const line of String(text).split(/\r?\n/)) {
    const body = line.replace(LOG_PREFIX, '').trim()
    if (/^DirectShow video devices/i.test(body)) {
      legacySection = 'video'
      continue
    }
    if (/^DirectShow audio devices/i.test(body)) {
      legacySection = 'audio'
      continue
    }
    if (/^Alternative name/i.test(body)) continue
    const tagged = /^"(.+)"\s+\((video|audio|none)\)$/.exec(body)
    if (tagged) {
      if (tagged[2] === 'video') names.push(tagged[1])
      continue
    }
    const legacy = /^"(.+)"$/.exec(body)
    if (legacy && legacySection === 'video') names.push(legacy[1])
  }
  return names
}

/** Whether `-f v4l2 -list_formats all` found a capture device with formats. */
export function parseV4l2Listing(text) {
  const formats = String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(LOG_PREFIX, ''))
    .filter((line) => /^(Raw|Compressed)\s*:/.test(line.trim()))
  return { listed: formats.length > 0, formats }
}

/** `{ listed, count, names }` for Videorc Camera from one listing's output. */
export function cameraListing(platform, text) {
  const device = cameraDeviceName(platform)
  if (platform === 'linux') {
    const { listed, formats } = parseV4l2Listing(text)
    return { listed, count: listed ? 1 : 0, names: listed ? [device] : [], formats }
  }
  const names =
    platform === 'win32' ? parseDshowVideoDevices(text) : parseAvfoundationVideoDevices(text)
  const count = names.filter((name) => name === device).length
  return { listed: count > 0, count, names }
}

/** What the camera must show in a phase: `still`, `absent` or `program` (D12). */
export function presenceExpectation(platform, phase) {
  if (phase === 'on') return 'program'
  return platform === 'darwin' ? 'still' : 'absent'
}

/**
 * One phase of the presence rule. `read` is the marker summary of the frames
 * judged in that phase (macOS reads its off still; the others only list).
 */
export function presenceVerdict({ platform, phase, listing, read = null }) {
  const device = cameraDeviceName(platform)
  const label = PLATFORM_LABELS[platform] ?? platform
  const failures = []
  if (listing.count > 1) {
    failures.push(
      `${listing.count} cameras are named exactly "${device}", so no reader can tell which is Videorc's; remove the other one (the P0a spike lives in /Applications/Videorc Camera Spike.app)`
    )
  }
  const expectation = presenceExpectation(platform, phase)
  if (expectation === 'absent' && listing.listed) {
    failures.push(
      `"${device}" is listed while the switch is off; on ${label} it exists only while the switch is on (D12)`
    )
  }
  if (expectation === 'still') {
    if (!listing.listed) {
      failures.push(
        `"${device}" isn't listed while the switch is off; once installed, the extension keeps it in every app's list (D12)`
      )
    } else if (!read || read.frames === 0) {
      failures.push(
        `"${device}" gave no frames while the switch is off; the extension draws the off still (D12)`
      )
    } else if (read.markerFrames > 0) {
      failures.push(
        `the program shows while the switch is off (${read.markerFrames} of ${read.frames} frames carry the marker)`
      )
    }
  }
  if (expectation === 'program' && !listing.listed) {
    failures.push(`"${device}" isn't listed while the switch is on`)
  }
  return { ok: failures.length === 0, phase, expectation, listed: listing.listed, failures }
}

// ---------------------------------------------------------------------------
// Classification: SKIP, FAIL or go on

function statusDetail(status) {
  return status?.message ? ` (${status.message})` : ''
}

/**
 * What `virtualCamera.set {on:true}` left the camera in, once the wait for
 * `ready` or `streaming` ended. `listed` is whether the platform's reader
 * lists Videorc Camera at that moment.
 *
 * - proceed: ready or streaming, the read decides.
 * - skip: this computer can't run the camera yet, and the reason says which
 *   state and what to do. Never silent.
 * - fail: Videorc claims a state it can't back.
 *
 * `unavailable` skips only while no app can pick the camera. When the
 * platform lists it anyway (an approved extension, or a same-name spike)
 * the read goes on and must fail: an app that picks it gets no program.
 * That is today's base on a Mac with the extension installed.
 */
export function classifyCameraStart({
  status,
  listed,
  waitedMs = null,
  platform = process.platform
}) {
  if (!status || typeof status !== 'object' || typeof status.state !== 'string') {
    return {
      action: 'fail',
      reason: `virtualCamera.set answered no status: ${JSON.stringify(status)}`
    }
  }
  const detail = statusDetail(status)
  const approvalHint =
    platform === 'darwin'
      ? 'approve it in System Settings > General > Login Items & Extensions > Camera Extensions, then run again'
      : 'finish what the Output page asks (a restart, or the setup), then run again'
  if (status.platformStep === 'unsupported') {
    return {
      action: 'skip',
      reason: `Videorc Camera is unsupported here: state ${status.state}, platformStep unsupported${detail}`
    }
  }
  switch (status.state) {
    case 'ready':
    case 'streaming':
      return { action: 'proceed', expectProgram: true }
    case 'needs-approval':
      return {
        action: 'skip',
        reason: `Videorc Camera needs approval (state needs-approval${status.platformStep ? `, platformStep ${status.platformStep}` : ''})${detail}: ${approvalHint}`
      }
    case 'needs-setup':
      return {
        action: 'skip',
        reason: `Videorc Camera needs its one-time setup (state needs-setup${status.platformStep ? `, platformStep ${status.platformStep}` : ''})${detail}`
      }
    case 'unavailable':
      if (listed) {
        return {
          action: 'proceed',
          expectProgram: false,
          note: `the backend says unavailable${detail}, but the platform lists Videorc Camera`
        }
      }
      return {
        action: 'skip',
        reason: `Videorc Camera is unavailable and no app lists it (state unavailable, available ${status.available})${detail}`
      }
    case 'installing':
      return {
        action: 'fail',
        reason: `Videorc Camera was still installing${waitedMs != null ? ` after ${Math.round(waitedMs / 1000)} s` : ''}${detail}`
      }
    case 'off':
      return { action: 'fail', reason: 'virtualCamera.set {on:true} left the camera off' }
    default:
      return {
        action: 'fail',
        reason: `Videorc Camera is in an unknown state "${status.state}"${detail}`
      }
  }
}

/** A camera grant the reader's own process lacks, from FFmpeg's stderr, or null. */
export function cameraAccessDenied(platform, stderr, { terminal = 'the terminal' } = {}) {
  const text = String(stderr ?? '')
  if (platform === 'darwin') {
    if (
      /not authori[sz]ed|-11852|Cannot use Videorc Camera|AVErrorApplicationIsNotAuthorized/i.test(
        text
      )
    ) {
      return `the reader has no camera access: allow ${terminal} (the app running the smoke, not Videorc) in System Settings > Privacy & Security > Camera`
    }
    return null
  }
  if (platform === 'win32') {
    if (/access is denied|0x80070005|E_ACCESSDENIED/i.test(text)) {
      return 'the reader has no camera access: turn on Settings > Privacy & security > Camera > Let desktop apps access your camera'
    }
    return null
  }
  if (platform === 'linux' && /Permission denied/i.test(text)) {
    return `${cameraDeviceName('linux')} isn't readable by this user: add it to the video group`
  }
  return null
}

/**
 * What the on read showed. `start` is classifyCameraStart's answer.
 *
 * - "no frames from Videorc Camera": the reader got nothing.
 * - "still instead of program": frames, but none carries the marker.
 * - "frozen program": the marker is there, but the code never advances.
 * - A program while the backend says unavailable is a failure too: the
 *   status would be lying.
 */
export function classifyCameraRead({
  summary,
  start = { expectProgram: true },
  accessDenied = null,
  readerError = null
}) {
  if (accessDenied) return { kind: 'skip', reason: accessDenied }
  const note = start.note ? `; ${start.note}` : ''
  if (!summary || summary.frames === 0) {
    return {
      kind: 'fail',
      reason: `no frames from Videorc Camera${readerError ? `: ${readerError}` : ''}${note}`
    }
  }
  if (summary.markerFrames === 0) {
    return {
      kind: 'fail',
      reason: `still instead of program: ${summary.frames} frame(s) from Videorc Camera and none carries the program's marker${note}`
    }
  }
  if (summary.distinctCodes < 2) {
    return {
      kind: 'fail',
      reason: `frozen program: Videorc Camera shows the marker but its code never advances (${summary.markerFrames} marker frame(s))${note}`
    }
  }
  if (start.expectProgram === false) {
    return {
      kind: 'fail',
      reason: `the program flows through Videorc Camera while the backend reports it unavailable${note}`
    }
  }
  return { kind: 'program' }
}

// ---------------------------------------------------------------------------
// Counters and the backend's own camera list

/** framePipeline over the read: pushes rise; the CPU fit stays in budget. */
export function counterVerdict({ platform, before, after, budget = VIRTUAL_CAMERA_SMOKE_BUDGET }) {
  const failures = []
  const pushedBefore = before?.virtualCameraPushed ?? 0
  const pushedAfter = after?.virtualCameraPushed ?? 0
  const pushed = pushedAfter - pushedBefore
  if (!(pushed > 0)) {
    failures.push(
      `framePipeline.virtualCameraPushed did not rise over the read (${pushedBefore} then ${pushedAfter})`
    )
  }
  const convertMsMax = after?.virtualCameraConvertMsMax ?? 0
  if (platform === 'darwin') {
    if (convertMsMax > 0) {
      failures.push(
        `virtualCameraConvertMsMax is ${convertMsMax} ms on macOS; the Metal path hands the IOSurface over with no CPU fit (zero-copy)`
      )
    }
  } else if (!(convertMsMax < budget.convertMsMax)) {
    failures.push(
      `virtualCameraConvertMsMax is ${convertMsMax} ms, not under ${budget.convertMsMax} ms`
    )
  }
  return {
    ok: failures.length === 0,
    pushed,
    repeated: (after?.virtualCameraRepeated ?? 0) - (before?.virtualCameraRepeated ?? 0),
    convertMsMax,
    failures
  }
}

/** Whether a device from `devices.list` is Videorc Camera itself (the A5 filters). */
export function isVideorcCameraDevice(device) {
  const name = String(device?.name ?? '').trim()
  const id = String(device?.id ?? '').toLowerCase()
  return (
    name === VIRTUAL_CAMERA.name ||
    name.startsWith(VIRTUAL_CAMERA.name) ||
    id.includes(VIRTUAL_CAMERA.macosDeviceUuid.toLowerCase()) ||
    id.includes(VIRTUAL_CAMERA.windowsSourceClsid.toLowerCase()) ||
    id.endsWith(`/dev/video${VIRTUAL_CAMERA.linuxVideoNr}`)
  )
}

/** The cameras in a `devices.list` answer that are Videorc Camera (must be none). */
export function selfListedCameras(deviceList) {
  return (deviceList?.devices ?? []).filter(
    (device) => device?.kind === 'camera' && isVideorcCameraDevice(device)
  )
}

// ---------------------------------------------------------------------------
// The run's verdict

/**
 * PASS, FAIL or SKIP for the whole run. A SKIP must say why (never silent);
 * a failure before the assertions (`fatal`) fails the run with its reason.
 *
 * @param {object} input
 * @param {string|null} [input.skip]
 * @param {string|null} [input.fatal]
 * @param {Record<string,{ok:boolean,failures:string[]}>} [input.assertions]
 */
export function smokeVerdict({ skip = null, fatal = null, assertions = {} } = {}) {
  if (skip != null) {
    if (!String(skip).trim()) throw new Error('A SKIP must name its reason.')
    return { result: 'SKIP', reason: String(skip), failures: [] }
  }
  const failures = []
  if (fatal) failures.push(String(fatal))
  for (const { id } of VIRTUAL_CAMERA_SMOKE_ASSERTIONS) {
    const assertion = assertions[id]
    if (!assertion && !fatal) failures.push(`${id}: not judged`)
    else if (assertion && !assertion.ok) {
      for (const failure of assertion.failures) failures.push(`${id}: ${failure}`)
    }
  }
  return { result: failures.length ? 'FAIL' : 'PASS', reason: failures[0] ?? null, failures }
}
