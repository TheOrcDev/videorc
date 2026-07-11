import { spawn } from 'node:child_process'

export const CAPTIONS_LIVE_ARTIFACT_DEFAULTS = Object.freeze({
  sampleWidth: 640,
  sampleHeight: 360,
  sampleFps: 6,
  roiTopFraction: 0.54,
  roiBottomFraction: 0.98,
  centralInsetFraction: 0.03,
  darkChannelMax: 38,
  darkChromaMax: 22,
  brightChannelMin: 185,
  brightChromaMax: 62,
  minDarkRowFraction: 0.24,
  minPlateRowFraction: 0.035,
  minPlateWidthFraction: 0.3,
  minPlateDarkRatio: 0.32,
  minPlateBrightRatio: 0.002,
  minCaptionFrames: 3,
  minBaselineFramesBeforeCaption: 2,
  minConsecutiveCaptionFrames: 2
})

/**
 * Measure the actual High Contrast caption style in decoded stream frames.
 *
 * The synthetic source never renders near-black broad horizontal rows (its
 * base channels start at 44). The High Contrast renderer does: an opaque
 * #050506 plate, with bright glyphs cut through it. Requiring both a broad,
 * sustained plate and bright pixels inside its decoded bounds is materially
 * harder to fool than a single-color marker. Requiring baseline frames before
 * the first match proves that the viewer-facing pixels arrived after the
 * caption transport update instead of merely existing in the source.
 */
export function measureCaptionsLiveArtifactRgb(
  rgb,
  {
    width = CAPTIONS_LIVE_ARTIFACT_DEFAULTS.sampleWidth,
    height = CAPTIONS_LIVE_ARTIFACT_DEFAULTS.sampleHeight,
    ...thresholds
  } = {}
) {
  const options = { ...CAPTIONS_LIVE_ARTIFACT_DEFAULTS, ...thresholds }
  const frameBytes = width * height * 3
  const sampledFrames = frameBytes > 0 ? Math.floor((rgb?.length ?? 0) / frameBytes) : 0
  const roiTop = clampInteger(Math.floor(height * options.roiTopFraction), 0, height - 1)
  const roiBottom = clampInteger(Math.ceil(height * options.roiBottomFraction), roiTop + 1, height)
  const left = clampInteger(Math.floor(width * options.centralInsetFraction), 0, width - 1)
  const right = clampInteger(Math.ceil(width * (1 - options.centralInsetFraction)), left + 1, width)
  const centralWidth = right - left
  const minDarkPixelsPerRow = Math.max(1, Math.ceil(centralWidth * options.minDarkRowFraction))
  const minPlateRows = Math.max(2, Math.ceil(height * options.minPlateRowFraction))
  const frames = []

  for (let frameIndex = 0; frameIndex < sampledFrames; frameIndex += 1) {
    const frameStart = frameIndex * frameBytes
    const qualifyingRows = []
    const darkPixelsByRow = new Map()

    for (let y = roiTop; y < roiBottom; y += 1) {
      const rowStart = frameStart + y * width * 3
      const darkXs = []
      for (let x = left; x < right; x += 1) {
        const offset = rowStart + x * 3
        if (isDarkNeutralPixel(rgb[offset], rgb[offset + 1], rgb[offset + 2], options)) {
          darkXs.push(x)
        }
      }
      if (darkXs.length >= minDarkPixelsPerRow) {
        qualifyingRows.push(y)
        darkPixelsByRow.set(y, darkXs)
      }
    }

    const rowRuns = consecutiveRuns(qualifyingRows)
    const bestRun = rowRuns.reduce((best, run) => (run.length > best.length ? run : best), [])
    let plate = null
    if (bestRun.length >= minPlateRows) {
      let plateLeft = right
      let plateRight = left
      for (const y of bestRun) {
        const row = darkPixelsByRow.get(y) ?? []
        if (row.length === 0) continue
        plateLeft = Math.min(plateLeft, row[0])
        plateRight = Math.max(plateRight, row.at(-1))
      }
      plateRight = Math.min(right, plateRight + 1)
      const plateTop = bestRun[0]
      const plateBottom = bestRun.at(-1) + 1
      const plateWidth = Math.max(0, plateRight - plateLeft)
      const plateHeight = Math.max(0, plateBottom - plateTop)
      const platePixels = plateWidth * plateHeight
      let darkPixels = 0
      let brightPixels = 0

      for (let y = plateTop; y < plateBottom; y += 1) {
        const rowStart = frameStart + y * width * 3
        for (let x = plateLeft; x < plateRight; x += 1) {
          const offset = rowStart + x * 3
          const red = rgb[offset]
          const green = rgb[offset + 1]
          const blue = rgb[offset + 2]
          if (isDarkNeutralPixel(red, green, blue, options)) darkPixels += 1
          if (isBrightNeutralPixel(red, green, blue, options)) brightPixels += 1
        }
      }

      plate = {
        left: plateLeft,
        top: plateTop,
        width: plateWidth,
        height: plateHeight,
        rowCount: bestRun.length,
        widthFraction: width > 0 ? plateWidth / width : 0,
        darkPixelRatio: platePixels > 0 ? darkPixels / platePixels : 0,
        brightPixelRatio: platePixels > 0 ? brightPixels / platePixels : 0
      }
    }

    const captionPresent = Boolean(
      plate &&
      plate.widthFraction >= options.minPlateWidthFraction &&
      plate.darkPixelRatio >= options.minPlateDarkRatio &&
      plate.brightPixelRatio >= options.minPlateBrightRatio
    )
    frames.push({ index: frameIndex, captionPresent, plate })
  }

  return {
    sampleWidth: width,
    sampleHeight: height,
    sampledFrames,
    roi: { left, top: roiTop, width: right - left, height: roiBottom - roiTop },
    frames
  }
}

export function evaluateCaptionsLiveArtifactMetrics(metrics, thresholds = {}) {
  const options = { ...CAPTIONS_LIVE_ARTIFACT_DEFAULTS, ...thresholds }
  const frames = Array.isArray(metrics?.frames) ? metrics.frames : []
  const captionIndexes = frames.filter((frame) => frame.captionPresent).map((frame) => frame.index)
  const firstCaptionFrame = captionIndexes[0] ?? null
  const baselineFramesBeforeCaption =
    firstCaptionFrame === null
      ? frames.filter((frame) => !frame.captionPresent).length
      : frames.filter((frame) => frame.index < firstCaptionFrame && !frame.captionPresent).length
  const longestCaptionRun = Math.max(0, ...consecutiveRuns(captionIndexes).map((run) => run.length))
  const failures = []

  if ((metrics?.sampledFrames ?? 0) <= 0) {
    failures.push('captions-live: no decoded stream frames were sampled')
  }
  if (baselineFramesBeforeCaption < options.minBaselineFramesBeforeCaption) {
    failures.push(
      `captions-live: only ${baselineFramesBeforeCaption} baseline frame(s) preceded the caption, expected at least ${options.minBaselineFramesBeforeCaption}`
    )
  }
  if (captionIndexes.length < options.minCaptionFrames) {
    failures.push(
      `captions-live: High Contrast caption pixels appeared in ${captionIndexes.length} frame(s), expected at least ${options.minCaptionFrames}`
    )
  }
  if (longestCaptionRun < options.minConsecutiveCaptionFrames) {
    failures.push(
      `captions-live: longest caption run was ${longestCaptionRun} frame(s), expected at least ${options.minConsecutiveCaptionFrames}`
    )
  }

  return {
    pass: failures.length === 0,
    failures,
    observations: {
      baselineFramesBeforeCaption,
      captionFrames: captionIndexes.length,
      firstCaptionFrame,
      longestCaptionRun,
      maxPlateWidthFraction: maxPlateMetric(frames, 'widthFraction'),
      maxPlateDarkPixelRatio: maxPlateMetric(frames, 'darkPixelRatio'),
      maxPlateBrightPixelRatio: maxPlateMetric(frames, 'brightPixelRatio')
    },
    thresholds: {
      minCaptionFrames: options.minCaptionFrames,
      minBaselineFramesBeforeCaption: options.minBaselineFramesBeforeCaption,
      minConsecutiveCaptionFrames: options.minConsecutiveCaptionFrames,
      minPlateWidthFraction: options.minPlateWidthFraction,
      minPlateDarkRatio: options.minPlateDarkRatio,
      minPlateBrightRatio: options.minPlateBrightRatio
    },
    metrics
  }
}

export async function analyzeCaptionsLiveArtifact(
  filePath,
  {
    ffmpegPath = 'ffmpeg',
    sampleWidth = CAPTIONS_LIVE_ARTIFACT_DEFAULTS.sampleWidth,
    sampleHeight = CAPTIONS_LIVE_ARTIFACT_DEFAULTS.sampleHeight,
    sampleFps = CAPTIONS_LIVE_ARTIFACT_DEFAULTS.sampleFps,
    ...thresholds
  } = {}
) {
  const rgb = await decodeRgbSamples(filePath, {
    ffmpegPath,
    sampleWidth,
    sampleHeight,
    sampleFps
  })
  const metrics = measureCaptionsLiveArtifactRgb(rgb, {
    width: sampleWidth,
    height: sampleHeight,
    ...thresholds
  })
  return {
    file: filePath,
    ...evaluateCaptionsLiveArtifactMetrics(metrics, thresholds)
  }
}

export function evaluateCaptionsAbsentArtifactMetrics(
  metrics,
  { minSampledFrames = 3, maxCaptionFrames = 0 } = {}
) {
  const frames = Array.isArray(metrics?.frames) ? metrics.frames : []
  const captionFrames = frames.filter((frame) => frame.captionPresent).length
  const failures = []
  if ((metrics?.sampledFrames ?? 0) < minSampledFrames) {
    failures.push(
      `captions-clean: sampled ${metrics?.sampledFrames ?? 0} frame(s), expected at least ${minSampledFrames}`
    )
  }
  if (captionFrames > maxCaptionFrames) {
    failures.push(
      `captions-clean: High Contrast caption pixels appeared in ${captionFrames} frame(s), expected at most ${maxCaptionFrames}`
    )
  }
  return {
    pass: failures.length === 0,
    failures,
    observations: {
      captionFrames,
      baselineFrames: frames.length - captionFrames,
      maxPlateWidthFraction: maxPlateMetric(frames, 'widthFraction'),
      maxPlateDarkPixelRatio: maxPlateMetric(frames, 'darkPixelRatio'),
      maxPlateBrightPixelRatio: maxPlateMetric(frames, 'brightPixelRatio')
    },
    thresholds: { minSampledFrames, maxCaptionFrames },
    metrics
  }
}

export async function analyzeCaptionsAbsentArtifact(
  filePath,
  {
    ffmpegPath = 'ffmpeg',
    sampleWidth = CAPTIONS_LIVE_ARTIFACT_DEFAULTS.sampleWidth,
    sampleHeight = CAPTIONS_LIVE_ARTIFACT_DEFAULTS.sampleHeight,
    sampleFps = CAPTIONS_LIVE_ARTIFACT_DEFAULTS.sampleFps,
    minSampledFrames = 3,
    maxCaptionFrames = 0,
    ...thresholds
  } = {}
) {
  const rgb = await decodeRgbSamples(filePath, {
    ffmpegPath,
    sampleWidth,
    sampleHeight,
    sampleFps
  })
  const metrics = measureCaptionsLiveArtifactRgb(rgb, {
    width: sampleWidth,
    height: sampleHeight,
    ...thresholds
  })
  return {
    file: filePath,
    ...evaluateCaptionsAbsentArtifactMetrics(metrics, { minSampledFrames, maxCaptionFrames })
  }
}

export function formatCaptionsLiveArtifactSummary(report) {
  const observations = report?.observations ?? {}
  return (
    `Captions live artifact gate: ${report?.pass ? 'PASS' : 'FAIL'} ` +
    `frames=${report?.metrics?.sampledFrames ?? 0} ` +
    `baseline=${observations.baselineFramesBeforeCaption ?? 0} ` +
    `captions=${observations.captionFrames ?? 0} ` +
    `run=${observations.longestCaptionRun ?? 0} ` +
    `plate=${formatRatio(observations.maxPlateWidthFraction)}/` +
    `${formatRatio(observations.maxPlateDarkPixelRatio)}/` +
    `${formatRatio(observations.maxPlateBrightPixelRatio)}`
  )
}

function isDarkNeutralPixel(red, green, blue, options) {
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  return max <= options.darkChannelMax && max - min <= options.darkChromaMax
}

function isBrightNeutralPixel(red, green, blue, options) {
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  return min >= options.brightChannelMin && max - min <= options.brightChromaMax
}

function consecutiveRuns(indexes) {
  const runs = []
  for (const index of indexes) {
    const current = runs.at(-1)
    if (current && current.at(-1) + 1 === index) {
      current.push(index)
    } else {
      runs.push([index])
    }
  }
  return runs
}

function maxPlateMetric(frames, key) {
  return frames.reduce((max, frame) => Math.max(max, frame.plate?.[key] ?? 0), 0)
}

function clampInteger(value, min, max) {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function formatRatio(value) {
  return typeof value === 'number' ? value.toFixed(3) : '0.000'
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
          `captions-live artifact ffmpeg sample failed: code=${code} signal=${signal} ${stderr.join('').trim()}`
        )
      )
    })
  })
}
