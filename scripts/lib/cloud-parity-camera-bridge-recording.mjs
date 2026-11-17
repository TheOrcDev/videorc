/** Plan 249 S13a: finalized composited recordings.
 *
 * Reads the camera role out of a FINAL composited program recording (the local
 * Playwright screencast, or a managed egress recording an operator downloaded
 * under explicit authorization) at a measured geometry: per decoded frame the
 * frame-sequence stamp and the S10 patches over the program ground. Pure
 * helpers plus a thin FFmpeg reader; nothing here contacts a service.
 * Evidence label: `composited-recording`.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import {
  ALPHA_PATCH_PROBES,
  PATCH_ROW,
  STAMP_ROW,
  ROOM_FRAME,
  decodeFrameStamp,
  luma,
  blendPixel,
  CAMERA_BRIDGE_BUDGETS
} from './cloud-parity-camera-bridge-contract.mjs'

/** Below this many recorded pixels per stamp cell the stamp is not readable. */
export const MIN_CELL_PIXELS = 4

/** Where logical camera points land in the recording, from a measured geometry
 * (`cameraFrameGeometry` in page coordinates) and the recording's scale. */
export function recordingLayout(geometry, scale) {
  const lw = geometry.logical.w,
    lh = geometry.logical.h
  const point = (x, y) => ({
    x: Math.floor(
      (geometry.content.x +
        (geometry.mirrored ? 1 - (x + 0.5) / lw : (x + 0.5) / lw) * geometry.content.w) *
        scale
    ),
    y: Math.floor((geometry.content.y + ((y + 0.5) / lh) * geometry.content.h) * scale)
  })
  const cellPixels = (geometry.content.w * scale) / 32
  return {
    readable: cellPixels >= MIN_CELL_PIXELS,
    cellPixels,
    stamp: Array.from({ length: 32 }, (_, i) =>
      point(((i + 0.5) * ROOM_FRAME.width) / 32, STAMP_ROW)
    ),
    patches: ALPHA_PATCH_PROBES.map((p) => ({ ...p, at: point(p.x, PATCH_ROW) }))
  }
}

/** One RGB frame; a cropped/off-frame probe is unavailable, never stamp zero. */
export function readRecordedFrame(rgb, width, layout) {
  assert.ok(Number.isInteger(width) && width > 0 && rgb.length % (width * 3) === 0)
  const height = rgb.length / (width * 3)
  const at = ({ x, y }) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height)
      return null
    const i = (y * width + x) * 3
    return [rgb[i], rgb[i + 1], rgb[i + 2]]
  }
  return {
    sequence: decodeFrameStamp(
      layout.stamp.map((p) => {
        const c = at(p)
        return c ? luma(c) : NaN
      })
    ),
    patches: layout.patches.map((p) => ({ x: p.x, rgb: at(p.at) }))
  }
}

/** Bounded accumulator: duplicated screencast frames are expected. Missing
 * stamps, backwards sequences, gaps and absent ground all affect acceptance.
 * Sequence span is source time, NOT container PTS or an A/V sync measurement. */
export function recordingAccumulator(ground, budgets = CAMERA_BRIDGE_BUDGETS) {
  let frames = 0,
    stamped = 0,
    uniqueSequences = 0,
    missingSequences = 0,
    backwards = 0,
    failureCount = 0,
    first = null,
    previous = null,
    last = null
  const failures = []
  const fail = (message) => {
    failureCount++
    if (failures.length < 50) failures.push(message)
  }
  return {
    add(frame) {
      frames++
      if (frame.sequence === null) return
      stamped++
      first ??= frame.sequence
      if (previous !== null && frame.sequence < previous) backwards++
      if (previous !== frame.sequence) {
        uniqueSequences++
        if (previous !== null) missingSequences += Math.max(0, frame.sequence - previous - 1)
      }
      previous = last = frame.sequence
      for (const probe of ALPHA_PATCH_PROBES) {
        const patch = frame.patches.find((p) => p.x === probe.x)
        const [r, g, b, a] = probe.rgba
        const expected = a === 255 ? [r, g, b] : ground ? blendPixel([r, g, b], a, ground) : null
        if (
          !expected ||
          !patch?.rgb ||
          !patch.rgb.every(
            (v, i) => Number.isFinite(v) && Math.abs(v - expected[i]) <= budgets.compositeTolerance
          )
        )
          fail(`seq ${frame.sequence} patch ${probe.x}: ${patch?.rgb} vs ${expected}`)
      }
    },
    result() {
      const stampedFraction = frames ? stamped / frames : 0
      const sequenceSpanSeconds = first === null ? 0 : (last - first) / ROOM_FRAME.fps
      const sequenceCoverage = uniqueSequences / Math.max(1, uniqueSequences + missingSequences)
      const sufficient =
        stampedFraction >= 0.95 && sequenceSpanSeconds >= budgets.minimumSpanSeconds
      return {
        status:
          !frames || !stamped || !ground
            ? 'unavailable'
            : failureCount ||
                backwards ||
                !sufficient ||
                sequenceCoverage < budgets.minimumDecodedFrameRatio
              ? 'failed'
              : 'passed',
        frames,
        stamped,
        stampedFraction,
        uniqueSequences,
        missingSequences,
        backwards,
        sequenceSpanSeconds,
        sequenceCoverage,
        failures,
        failureCount,
        timing:
          'Decoded ordinal and source sequence only; container per-frame PTS and A/V synchronization unavailable'
      }
    }
  }
}
export function assessRecording(frames, ground, budgets = CAMERA_BRIDGE_BUDGETS) {
  const accumulator = recordingAccumulator(ground, budgets)
  for (const frame of frames) accumulator.add(frame)
  return accumulator.result()
}

/** Consume arbitrary pipe chunks with ONE frame buffer, no whole-video array.
 * Exceeding the explicit frame limit fails rather than accepting a prefix. */
export async function consumeRgbFrames(stream, frameBytes, onFrame, maxFrames = 120_000) {
  assert.ok(Number.isSafeInteger(frameBytes) && frameBytes > 0 && frameBytes <= 4096 * 2160 * 3)
  assert.ok(Number.isSafeInteger(maxFrames) && maxFrames > 0 && maxFrames <= 120_000)
  const frame = Buffer.allocUnsafe(frameBytes)
  let filled = 0,
    count = 0
  for await (const chunk of stream) {
    for (let offset = 0; offset < chunk.length; ) {
      const size = Math.min(frameBytes - filled, chunk.length - offset)
      chunk.copy(frame, filled, offset, offset + size)
      filled += size
      offset += size
      if (filled === frameBytes) {
        assert.ok(++count <= maxFrames, 'Recording exceeds explicit frame bound')
        await onFrame(frame)
        filled = 0
      }
    }
  }
  assert.equal(filled, 0, 'Truncated decoded RGB frame')
  assert.ok(count > 0, 'Recording decoded no frames')
  return count
}

/** FFmpeg owns one process; bounded stderr, deadline, and kill/reap on failure.
 * No frame-rate conversion: duplicated/dropped decode frames remain visible. */
export async function readRecording({
  ffmpeg,
  ffprobe,
  file,
  onFrame,
  maxFrames = 120_000,
  deadlineMs = 600_000
}) {
  const probe = await promisify(execFile)(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,duration,r_frame_rate:format=duration',
      '-of',
      'json',
      file
    ],
    { timeout: 30_000, maxBuffer: 64 * 1024 }
  )
  const metadata = JSON.parse(probe.stdout)
  const { width, height } = metadata.streams[0]
  assert.ok(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)
  const child = spawn(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = '',
    timedOut = false
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65536)
  })
  // Attach both immediately: spawn errors must not become unhandled rejections.
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }))
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, deadlineMs)
  try {
    await consumeRgbFrames(
      child.stdout,
      width * height * 3,
      (rgb) => onFrame(rgb, width),
      maxFrames
    )
    const result = await closed
    assert.ok(!timedOut, 'Recording decode deadline exceeded')
    if (result.error) throw result.error
    assert.equal(result.code, 0, `FFmpeg decode failed: ${stderr}`)
    return { width, height, metadata }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
}

/** Only finalized local files; never downloads managed media. A fixed measured
 * geometry is mandatory for the entire analyzed interval. */
export async function analyzeCompositedRecording({
  file,
  geometry,
  scale,
  ground,
  ffmpeg,
  ffprobe,
  managed = false,
  authorized = false,
  budgets = CAMERA_BRIDGE_BUDGETS
}) {
  if (managed && !authorized)
    return {
      status: 'unavailable',
      reason: 'Managed recording analysis requires explicit authorization'
    }
  const layout = recordingLayout(geometry, scale)
  if (!layout.readable)
    return {
      status: 'unavailable',
      reason: `Camera stamp cells are ${layout.cellPixels.toFixed(1)} px (< ${MIN_CELL_PIXELS})`
    }
  const accumulator = recordingAccumulator(ground, budgets)
  const recording = await readRecording({
    ffmpeg,
    ffprobe,
    file,
    onFrame: (rgb, width) => accumulator.add(readRecordedFrame(rgb, width, layout))
  })
  return {
    label: managed ? 'composited-managed-recording' : 'composited-recording',
    file,
    geometry,
    recording,
    ...accumulator.result()
  }
}
export const readGeometryFile = (file) => JSON.parse(readFileSync(file, 'utf8'))
