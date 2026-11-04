import { spawn } from 'node:child_process'

export const NOTES_OVERLAY_ARTIFACT_DEFAULTS = Object.freeze({
  sampleWidth: 320,
  sampleHeight: 180,
  sampleFps: 2,
  maxMarkerPixelRatio: 0.002
})

export function measureNotesOverlayMarkerPixelsFromRgb(
  rgb,
  {
    width = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleWidth,
    height = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleHeight
  } = {}
) {
  const frameBytes = width * height * 3
  const sampledFrames = Math.floor(rgb.length / frameBytes)
  let maxMarkerPixels = 0
  let totalMarkerPixels = 0

  for (let frame = 0; frame < sampledFrames; frame += 1) {
    const start = frame * frameBytes
    let markerPixels = 0
    for (let offset = start; offset < start + frameBytes; offset += 3) {
      const red = rgb[offset]
      const green = rgb[offset + 1]
      const blue = rgb[offset + 2]
      if (isNotesOverlayMarkerPixel(red, green, blue)) {
        markerPixels += 1
      }
    }
    maxMarkerPixels = Math.max(maxMarkerPixels, markerPixels)
    totalMarkerPixels += markerPixels
  }

  const framePixels = width * height
  return {
    sampleWidth: width,
    sampleHeight: height,
    sampledFrames,
    framePixels,
    maxMarkerPixels,
    totalMarkerPixels,
    maxMarkerPixelRatio: framePixels > 0 ? maxMarkerPixels / framePixels : 0,
    meanMarkerPixelRatio:
      sampledFrames > 0 && framePixels > 0 ? totalMarkerPixels / (sampledFrames * framePixels) : 0
  }
}

export function evaluateNotesOverlayArtifactMetrics(
  metrics,
  { maxMarkerPixelRatio = NOTES_OVERLAY_ARTIFACT_DEFAULTS.maxMarkerPixelRatio } = {}
) {
  const failures = []
  if ((metrics.sampledFrames ?? 0) <= 0) {
    failures.push('notes-window: no decoded video frames were sampled')
  }
  if ((metrics.maxMarkerPixelRatio ?? 0) > maxMarkerPixelRatio) {
    failures.push(
      `notes-window: red smoke marker leaked into final artifact ` +
        `(max ${(metrics.maxMarkerPixelRatio * 100).toFixed(3)}%, threshold ${(maxMarkerPixelRatio * 100).toFixed(3)}%)`
    )
  }

  return {
    pass: failures.length === 0,
    failures,
    warnings: [],
    thresholds: { maxMarkerPixelRatio },
    metrics
  }
}

export async function analyzeNotesOverlayArtifact(
  filePath,
  {
    ffmpegPath = 'ffmpeg',
    sampleWidth = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleWidth,
    sampleHeight = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleHeight,
    sampleFps = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleFps,
    maxMarkerPixelRatio = NOTES_OVERLAY_ARTIFACT_DEFAULTS.maxMarkerPixelRatio
  } = {}
) {
  const rgb = await decodeRgbSamples(filePath, { ffmpegPath, sampleWidth, sampleHeight, sampleFps })
  const metrics = measureNotesOverlayMarkerPixelsFromRgb(rgb, {
    width: sampleWidth,
    height: sampleHeight
  })
  return {
    file: filePath,
    ...evaluateNotesOverlayArtifactMetrics(metrics, { maxMarkerPixelRatio })
  }
}

/**
 * Per-frame marker coverage, in sample order (plan 215 C5). The same red
 * rule as the whole-file measure, kept per frame so a gate can judge spans
 * of the recording apart: before, during and after a switch flipped.
 */
export function measureOverlayMarkerFramesFromRgb(
  rgb,
  {
    width = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleWidth,
    height = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleHeight
  } = {}
) {
  const frameBytes = width * height * 3
  const framePixels = width * height
  const sampledFrames = Math.floor(rgb.length / frameBytes)
  const ratios = []
  for (let frame = 0; frame < sampledFrames; frame += 1) {
    const start = frame * frameBytes
    let markerPixels = 0
    for (let offset = start; offset < start + frameBytes; offset += 3) {
      if (isNotesOverlayMarkerPixel(rgb[offset], rgb[offset + 1], rgb[offset + 2])) {
        markerPixels += 1
      }
    }
    ratios.push(framePixels > 0 ? markerPixels / framePixels : 0)
  }
  return ratios
}

/**
 * Judges spans of a recording by their marker coverage (plan 215 C5: the
 * Stream Manager invisibility smoke). Each phase names a span in
 * milliseconds of the file and what it expects: `absent` holds every frame
 * at or under `maxMarkerPixelRatio`; `present` needs at least one frame at
 * or over `minPresentMarkerPixelRatio`, which proves the gate can see the
 * window at all. A phase with no sampled frame fails: it proves nothing.
 */
export function evaluateOverlayArtifactPhases(
  frameRatios,
  {
    sampleFps = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleFps,
    phases = [],
    maxMarkerPixelRatio = NOTES_OVERLAY_ARTIFACT_DEFAULTS.maxMarkerPixelRatio,
    minPresentMarkerPixelRatio = 0.02,
    window = 'stream-manager'
  } = {}
) {
  const failures = []
  const frameMs = 1000 / sampleFps
  const results = phases.map((phase) => {
    const frames = frameRatios
      .map((ratio, index) => ({ ratio, atMs: index * frameMs }))
      .filter((frame) => frame.atMs >= phase.fromMs && frame.atMs < phase.toMs)
    const maxMarkerPixelRatio_ = frames.length ? Math.max(...frames.map((f) => f.ratio)) : null
    const minMarkerPixelRatio = frames.length ? Math.min(...frames.map((f) => f.ratio)) : null
    const result = {
      name: phase.name,
      expect: phase.expect,
      fromMs: phase.fromMs,
      toMs: phase.toMs,
      sampledFrames: frames.length,
      maxMarkerPixelRatio: maxMarkerPixelRatio_,
      minMarkerPixelRatio
    }
    if (frames.length === 0) {
      failures.push(
        `${window}: phase "${phase.name}" (${phase.fromMs}-${phase.toMs} ms) sampled no decoded frames`
      )
      return result
    }
    if (phase.expect === 'absent' && maxMarkerPixelRatio_ > maxMarkerPixelRatio) {
      failures.push(
        `${window}: phase "${phase.name}" leaked the red smoke marker into the final artifact ` +
          `(max ${(maxMarkerPixelRatio_ * 100).toFixed(3)}%, threshold ${(maxMarkerPixelRatio * 100).toFixed(3)}%)`
      )
    }
    if (phase.expect === 'present' && maxMarkerPixelRatio_ < minPresentMarkerPixelRatio) {
      failures.push(
        `${window}: phase "${phase.name}" never showed the red smoke marker, so the gate cannot see the window ` +
          `(max ${(maxMarkerPixelRatio_ * 100).toFixed(3)}%, needs ${(minPresentMarkerPixelRatio * 100).toFixed(3)}%)`
      )
    }
    return result
  })
  if (frameRatios.length === 0) {
    failures.push(`${window}: no decoded video frames were sampled`)
  }
  return {
    pass: failures.length === 0,
    failures,
    warnings: [],
    thresholds: { maxMarkerPixelRatio, minPresentMarkerPixelRatio },
    metrics: {
      sampledFrames: frameRatios.length,
      sampleFps,
      maxMarkerPixelRatio: frameRatios.length ? Math.max(...frameRatios) : 0,
      phases: results
    }
  }
}

export async function analyzeOverlayArtifactPhases(
  filePath,
  {
    ffmpegPath = 'ffmpeg',
    sampleWidth = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleWidth,
    sampleHeight = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleHeight,
    sampleFps = NOTES_OVERLAY_ARTIFACT_DEFAULTS.sampleFps,
    ...options
  } = {}
) {
  const rgb = await decodeRgbSamples(filePath, { ffmpegPath, sampleWidth, sampleHeight, sampleFps })
  const frameRatios = measureOverlayMarkerFramesFromRgb(rgb, {
    width: sampleWidth,
    height: sampleHeight
  })
  return {
    file: filePath,
    ...evaluateOverlayArtifactPhases(frameRatios, { sampleFps, ...options })
  }
}

export function formatOverlayArtifactPhasesSummary(verdict, label = 'Stream Manager') {
  if (!verdict) {
    return `${label} artifact gate: not requested`
  }
  const phases = (verdict.metrics?.phases ?? [])
    .map(
      (phase) =>
        `${phase.name}=${formatRatio(phase.maxMarkerPixelRatio)} (${phase.expect}, ${phase.sampledFrames} frames)`
    )
    .join(' ')
  return (
    `${label} artifact gate: ${verdict.pass ? 'PASS' : 'FAIL'} ` +
    `frames=${verdict.metrics?.sampledFrames ?? 0} ${phases}`
  )
}

export function appendNotesOverlayFailures(verdict, notesOverlay) {
  if (!notesOverlay) {
    return verdict
  }
  const failures = notesOverlay.pass ? [] : notesOverlay.failures
  if (failures.length === 0) {
    return verdict
  }
  return {
    ...verdict,
    pass: false,
    failures: [...(verdict.failures ?? []), ...failures]
  }
}

export function formatNotesOverlayArtifactSummary(notesOverlay) {
  if (!notesOverlay) {
    return 'Notes overlay artifact gate: not requested'
  }
  const metrics = notesOverlay.metrics ?? {}
  return (
    `Notes overlay artifact gate: ${notesOverlay.pass ? 'PASS' : 'FAIL'} ` +
    `frames=${metrics.sampledFrames ?? 0} maxMarker=${formatRatio(metrics.maxMarkerPixelRatio)} ` +
    `meanMarker=${formatRatio(metrics.meanMarkerPixelRatio)}`
  )
}

function isNotesOverlayMarkerPixel(red, green, blue) {
  return red >= 220 && green <= 80 && blue <= 80 && red - Math.max(green, blue) >= 160
}

function decodeRgbSamples(filePath, { ffmpegPath, sampleWidth, sampleHeight, sampleFps }) {
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-an',
    '-vf',
    `fps=${sampleFps},scale=${sampleWidth}:${sampleHeight}:flags=area,format=rgb24`,
    '-f',
    'rawvideo',
    'pipe:1'
  ]

  return new Promise((resolveDecode, rejectDecode) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectDecode)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveDecode(Buffer.concat(stdout))
        return
      }
      rejectDecode(
        new Error(
          `notes-window artifact ffmpeg sample failed: code=${code} signal=${signal} ${stderr.join('').trim()}`
        )
      )
    })
  })
}

function formatRatio(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(3)}%`
    : 'n/a'
}
