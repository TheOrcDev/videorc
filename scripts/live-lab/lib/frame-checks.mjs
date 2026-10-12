import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { decodeMarkers } from './card-markers.mjs'
import { encodePng } from './png.mjs'

// Plan 178 U9 step 3. Frame checks replace the by-eye steps where a machine
// can look: for every feature record with a timestamp (scene applied,
// takeover shown or hidden, comment highlighted, caption expected), frames
// are pulled from the clip that covers that moment at +2 s and +5 s, the U7
// marker regions are decoded (scene id, step counter, fiducials) and a
// reference crop is compared against a baseline frame from just before the
// event (mean absolute luma difference over a coarse grid). Each check is
// pass, fail or needs-eyes; a missing clip is never a failure (clip pulling
// is off unless the owner's policy allows it), it is needs-eyes with no frame.

export const DEFAULT_FRAME_OPTIONS = Object.freeze({
  analysisWidth: 640,
  analysisHeight: 360,
  offsetsSeconds: [2, 5],
  baselineOffsetSeconds: -3,
  overlayDiffMin: 0.08,
  regions: {
    highlight: [0.15, 0.45, 0.7, 0.3],
    caption: [0.1, 0.78, 0.8, 0.18],
    takeover: [0, 0, 1, 1]
  }
})

export const CHECKED_KINDS = Object.freeze(['scene', 'takeover', 'highlight', 'caption'])

/** Pure: ffmpeg args that print one rgb24 frame of `clipPath` at `atSeconds`. */
export function extractFrameArgs({ clipPath, atSeconds, width, height }) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-ss',
    String(Math.max(0, atSeconds)),
    '-i',
    clipPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:${height}`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-'
  ]
}

/** Default runner: spawns ffmpeg and returns its stdout as a Buffer. */
export function spawnFrameRunner(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => (stderr = (stderr + text).slice(-2000)))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr })
    })
  })
}

/**
 * One rgb24 frame, or null when ffmpeg cannot produce it. `runner` is
 * injectable (tests feed synthetic frames from renderMarkerFrame).
 */
export async function extractFrame({
  clipPath,
  atSeconds,
  width,
  height,
  ffmpegPath = 'ffmpeg',
  runner = spawnFrameRunner
}) {
  const result = await runner(ffmpegPath, extractFrameArgs({ clipPath, atSeconds, width, height }))
  const frame = result?.stdout
  if (result?.code !== 0 || !frame || frame.length < width * height * 3) return null
  return new Uint8Array(frame.buffer, frame.byteOffset, width * height * 3)
}

function lumaAt(frame, width, x, y) {
  const offset = (y * width + x) * 3
  return 0.299 * frame[offset] + 0.587 * frame[offset + 1] + 0.114 * frame[offset + 2]
}

/**
 * Pure: a perceptual difference (0..1) of a normalized region between two
 * frames: mean absolute luma difference over a 32x18 grid of block means,
 * divided by 255. Robust to encoder noise, sensitive to an overlay.
 */
export function regionDiff(a, b, width, height, region = [0, 0, 1, 1], grid = [32, 18]) {
  const [rx, ry, rw, rh] = region
  const x0 = Math.floor(rx * width)
  const y0 = Math.floor(ry * height)
  const w = Math.max(1, Math.floor(rw * width))
  const h = Math.max(1, Math.floor(rh * height))
  const [cols, rows] = grid
  let total = 0
  let blocks = 0
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const bx0 = x0 + Math.floor((col * w) / cols)
      const bx1 = x0 + Math.floor(((col + 1) * w) / cols)
      const by0 = y0 + Math.floor((row * h) / rows)
      const by1 = y0 + Math.floor(((row + 1) * h) / rows)
      if (bx1 <= bx0 || by1 <= by0) continue
      let sumA = 0
      let sumB = 0
      let count = 0
      for (let y = by0; y < by1; y += 2) {
        for (let x = bx0; x < bx1; x += 2) {
          sumA += lumaAt(a, width, x, y)
          sumB += lumaAt(b, width, x, y)
          count += 1
        }
      }
      if (count === 0) continue
      total += Math.abs(sumA - sumB) / count
      blocks += 1
    }
  }
  return blocks === 0 ? 0 : total / blocks / 255
}

/** Pure: the clip whose recording window covers `atMs` (+ `offsetSeconds`). */
export function clipCovering(clips, atMs, offsetSeconds = 0) {
  const target = atMs + offsetSeconds * 1000
  for (const clip of clips) {
    const start = Date.parse(clip.recordedAt ?? '')
    if (!Number.isFinite(start)) continue
    const end = start + (clip.seconds ?? 0) * 1000
    if (target >= start && target <= end && clip.clipFile) {
      return { clip, offsetInClipSeconds: (target - start) / 1000 }
    }
  }
  return null
}

function safeDecode(frame, width, height) {
  try {
    return decodeMarkers(frame, width, height)
  } catch {
    return { ok: false, aligned: false, sceneId: null, step: null, errors: ['decode failed'] }
  }
}

/**
 * Pure: judges one feature from its frames.
 * `frames` = [{ offsetSeconds, frame }] (frame may be null), `baseline` an
 * rgb24 frame from before the event or null. Returns
 * { status: 'pass'|'fail'|'needs-eyes', reason, decoded: [...], diffs: [...] }.
 */
export function judgeFeature(feature, frames, baseline, { width, height, options }) {
  const present = frames.filter((entry) => entry.frame)
  if (present.length === 0) {
    return {
      status: 'needs-eyes',
      reason: 'no frame could be read from the clip',
      decoded: [],
      diffs: []
    }
  }
  const decoded = present.map((entry) => ({
    offsetSeconds: entry.offsetSeconds,
    ...safeDecode(entry.frame, width, height)
  }))
  const region = options.regions[feature.kind] ?? [0, 0, 1, 1]
  const diffs = baseline
    ? present.map((entry) => ({
        offsetSeconds: entry.offsetSeconds,
        diff: Math.round(regionDiff(baseline, entry.frame, width, height, region) * 1000) / 1000
      }))
    : []
  const maxDiff = diffs.length ? Math.max(...diffs.map((entry) => entry.diff)) : null
  const changed = maxDiff !== null && maxDiff >= options.overlayDiffMin

  switch (feature.kind) {
    case 'scene': {
      const expected = feature.sceneId
      const readable = decoded.filter((entry) => entry.sceneId !== null)
      if (readable.some((entry) => entry.sceneId === expected)) {
        return { status: 'pass', reason: `scene marker reads ${expected}`, decoded, diffs }
      }
      if (readable.length > 0) {
        return {
          status: 'fail',
          reason: `scene marker reads ${readable.map((entry) => entry.sceneId).join('/')}, expected ${expected}`,
          decoded,
          diffs
        }
      }
      if (maxDiff === null) {
        return {
          status: 'needs-eyes',
          reason: 'markers unreadable and no baseline frame',
          decoded,
          diffs
        }
      }
      return changed
        ? {
            status: 'needs-eyes',
            reason:
              'the picture changed but the markers could not be read (layout with the card scaled)',
            decoded,
            diffs
          }
        : { status: 'fail', reason: 'no change on stream after the scene switch', decoded, diffs }
    }
    case 'takeover': {
      const aligned = decoded.some((entry) => entry.aligned)
      if (feature.shown === false) {
        if (aligned) return { status: 'pass', reason: 'card markers visible again', decoded, diffs }
        return {
          status: 'needs-eyes',
          reason: 'card markers not readable after the takeover ended',
          decoded,
          diffs
        }
      }
      if (!aligned && (changed || maxDiff === null)) {
        return {
          status: 'pass',
          reason: 'card covered (markers gone, picture changed)',
          decoded,
          diffs
        }
      }
      if (aligned && maxDiff !== null && !changed) {
        return {
          status: 'fail',
          reason: 'the takeover is missing from the stream (card still fully visible)',
          decoded,
          diffs
        }
      }
      return { status: 'needs-eyes', reason: 'partial cover or unreadable frame', decoded, diffs }
    }
    case 'highlight':
    case 'caption': {
      if (maxDiff === null) {
        return {
          status: 'needs-eyes',
          reason: 'no baseline frame to compare against',
          decoded,
          diffs
        }
      }
      if (changed)
        return {
          status: 'pass',
          reason: `${feature.kind} region changed (${maxDiff})`,
          decoded,
          diffs
        }
      return {
        status: 'fail',
        reason: `${feature.kind} missing from frames (region diff ${maxDiff} under ${options.overlayDiffMin})`,
        decoded,
        diffs
      }
    }
    default:
      return { status: 'needs-eyes', reason: `no frame rule for ${feature.kind}`, decoded, diffs }
  }
}

/**
 * Runs the frame checks for a run folder's features against its clips.
 * `features` = features.ndjson records; `clips` = clip analysis records
 * ({ recordedAt, seconds, clipFile }). Frames of failed and needs-eyes
 * checks are written as PNG under <runDir>/frames.
 */
export async function runFrameChecks({
  runDir,
  features,
  clips,
  options = DEFAULT_FRAME_OPTIONS,
  extract = extractFrame,
  ffmpegPath = 'ffmpeg',
  runner,
  exists = existsSync,
  write = writeFile
}) {
  const width = options.analysisWidth
  const height = options.analysisHeight
  const results = []
  const checked = features.filter(
    (feature) =>
      CHECKED_KINDS.includes(feature.kind) && Number.isFinite(Date.parse(feature.at ?? ''))
  )
  for (const feature of checked) {
    const atMs = Date.parse(feature.at)
    const usable = clips.filter((clip) => clip.clipFile && exists(clip.clipFile))
    const covering = clipCovering(usable, atMs, options.offsetsSeconds[0])
    if (!covering) {
      results.push({
        id: feature.id,
        kind: feature.kind,
        at: feature.at,
        status: 'needs-eyes',
        reason:
          clips.length === 0
            ? 'no clip (clipPull off or none pulled)'
            : 'no clip covers this moment',
        frames: []
      })
      continue
    }
    const pull = (offsetSeconds) =>
      extract({
        clipPath: covering.clip.clipFile,
        atSeconds: covering.offsetInClipSeconds + offsetSeconds,
        width,
        height,
        ffmpegPath,
        ...(runner ? { runner } : {})
      }).catch(() => null)
    const frames = []
    for (const offsetSeconds of options.offsetsSeconds) {
      frames.push({ offsetSeconds, frame: await pull(offsetSeconds) })
    }
    const baseline =
      covering.offsetInClipSeconds + options.baselineOffsetSeconds >= 0
        ? await pull(options.baselineOffsetSeconds)
        : null
    const judged = judgeFeature(feature, frames, baseline, { width, height, options })
    const written = []
    if (judged.status !== 'pass') {
      await mkdir(join(runDir, 'frames'), { recursive: true }).catch(() => {})
      for (const entry of frames) {
        if (!entry.frame) continue
        const name = `frames/${feature.id}-plus${entry.offsetSeconds}s.png`
        await write(join(runDir, name), encodePng(width, height, entry.frame)).catch(() => {})
        written.push(name)
      }
      if (baseline) {
        const name = `frames/${feature.id}-baseline.png`
        await write(join(runDir, name), encodePng(width, height, baseline)).catch(() => {})
        written.push(name)
      }
    }
    results.push({
      id: feature.id,
      kind: feature.kind,
      at: feature.at,
      status: judged.status,
      reason: judged.reason,
      decoded: judged.decoded.map(({ offsetSeconds, aligned, sceneId, step }) => ({
        offsetSeconds,
        aligned,
        sceneId,
        step
      })),
      diffs: judged.diffs,
      frames: written
    })
  }
  return results
}
