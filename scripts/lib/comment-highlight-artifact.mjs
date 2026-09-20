import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'

export const COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS = Object.freeze({
  sampleWidth: 640,
  sampleHeight: 360,
  sampleFps: 5,
  minMarkerPixelRatio: 0.025,
  minMarkerFrames: 2,
  minCardDarkPixelRatio: 0.1,
  minCardTextPixelRatio: 0.04,
  // A 1080p card is ~6-8% of its corner region; a centred caption bar is 0.
  minAnchorDarkAsymmetry: 0.03
})

export const COMMENT_HIGHLIGHT_MARKER_RGB = Object.freeze([255, 82, 45])
export const CAPTION_MARKER_RGB = Object.freeze([45, 231, 170])

export function classifyCommentHighlightResult(result) {
  if (result?.phase === 'live') return 'live'
  const code =
    result?.code ??
    result?.error?.code ??
    result?.reasonCode ??
    (result?.reason === 'highlight-unavailable' ? result.reason : undefined)
  if (code === 'highlight-unavailable') return 'highlight-unavailable'
  return 'unknown'
}

export const COMMENT_HIGHLIGHT_ANCHORS = Object.freeze([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
])
export const DEFAULT_COMMENT_HIGHLIGHT_ANCHOR = 'bottom-left'

/** The sampled-frame rectangle the highlight card must land in for `anchor`.
 * The compositor insets corner overlays by a 4% safe margin and the raster
 * adds transparent shadow padding before the glass plate, so the scan starts
 * 8% in from the anchored edges and runs to 62% of each axis (a card is at
 * most 60% of the canvas wide). The far side of the frame is deliberately NOT
 * scanned: a card that ignored the anchor must fail this gate. */
export function commentHighlightCardRegion(
  anchor = DEFAULT_COMMENT_HIGHLIGHT_ANCHOR,
  { width, height }
) {
  if (!COMMENT_HIGHLIGHT_ANCHORS.includes(anchor)) {
    throw new Error(`Unknown comment highlight anchor: ${anchor}`)
  }
  const span = (size, fromStart) => {
    const near = Math.round(size * 0.08)
    const far = Math.round(size * 0.62)
    const start = fromStart ? near : size - far
    const end = fromStart ? far : size - near
    return [Math.max(0, Math.min(size - 1, start)), Math.max(1, Math.min(size, end))]
  }
  const [yStart, yEnd] = span(height, anchor.startsWith('top-'))
  const [xStart, xEnd] = span(width, anchor.endsWith('-left'))
  return { xStart, xEnd, yStart, yEnd, top: anchor.startsWith('top-') }
}

/** The same corner on the other side of the frame. */
export function mirrorCommentHighlightAnchor(anchor) {
  return anchor.endsWith('-left')
    ? anchor.replace('-left', '-right')
    : anchor.replace('-right', '-left')
}

/** Frames whose dark-glass pixels lean toward the picked corner. The caption
 * bar is dark glass too and shares the bottom edge with bottom anchors, so
 * "dark pixels in the corner" alone cannot tell a card from a caption bar. A
 * caption is centred and adds the same dark area to both sides; only the card
 * tips the balance, which is what proves it sits in THIS corner. */
export function countCommentHighlightAnchoredFrames(
  metrics,
  mirroredMetrics,
  minDarkAsymmetry = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minAnchorDarkAsymmetry
) {
  const mirrored = new Map((mirroredMetrics?.frames ?? []).map((frame) => [frame.index, frame]))
  return (metrics?.frames ?? []).filter((frame) => {
    const other = mirrored.get(frame.index)
    return (
      other &&
      (frame.highlightCardDarkPixelRatio ?? 0) - (other.highlightCardDarkPixelRatio ?? 0) >=
        minDarkAsymmetry
    )
  }).length
}

export function measureCommentHighlightArtifactRgb(
  rgb,
  {
    width = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleWidth,
    height = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleHeight,
    anchor = DEFAULT_COMMENT_HIGHLIGHT_ANCHOR
  } = {}
) {
  const frameBytes = width * height * 3
  const sampledFrames = frameBytes > 0 ? Math.floor((rgb?.length ?? 0) / frameBytes) : 0
  const topEnd = Math.max(1, Math.floor(height / 2))
  const bottomStart = Math.min(height - 1, topEnd)
  const topPixels = width * topEnd
  const bottomPixels = width * (height - bottomStart)
  const region = commentHighlightCardRegion(anchor, { width, height })
  const cardPixels = (region.xEnd - region.xStart) * (region.yEnd - region.yStart)
  // The deterministic highlight marker is judged in the anchor's vertical half.
  const highlightMarkerPixelsTotal = region.top ? topPixels : bottomPixels
  const frames = []

  for (let frame = 0; frame < sampledFrames; frame += 1) {
    const frameStart = frame * frameBytes
    let highlightMarkerPixels = 0
    let captionMarkerPixels = 0
    let highlightCardDarkPixels = 0
    let highlightCardTextPixels = 0

    for (let y = 0; y < height; y += 1) {
      const rowStart = frameStart + y * width * 3
      for (let x = 0; x < width; x += 1) {
        const offset = rowStart + x * 3
        const red = rgb[offset]
        const green = rgb[offset + 1]
        const blue = rgb[offset + 2]
        if (
          (region.top ? y < topEnd : y >= bottomStart) &&
          isHighlightMarkerPixel(red, green, blue)
        ) {
          highlightMarkerPixels += 1
        }
        if (y >= bottomStart && isCaptionMarkerPixel(red, green, blue)) {
          captionMarkerPixels += 1
        }
        if (y >= region.yStart && y < region.yEnd && x >= region.xStart && x < region.xEnd) {
          if (isHighlightCardDarkPixel(red, green, blue)) highlightCardDarkPixels += 1
          if (isHighlightCardTextPixel(red, green, blue)) highlightCardTextPixels += 1
        }
      }
    }

    frames.push({
      index: frame,
      highlightMarkerPixels,
      captionMarkerPixels,
      highlightCardDarkPixels,
      highlightCardTextPixels,
      highlightMarkerPixelRatio:
        highlightMarkerPixelsTotal > 0 ? highlightMarkerPixels / highlightMarkerPixelsTotal : 0,
      captionMarkerPixelRatio: bottomPixels > 0 ? captionMarkerPixels / bottomPixels : 0,
      highlightCardDarkPixelRatio: cardPixels > 0 ? highlightCardDarkPixels / cardPixels : 0,
      highlightCardTextPixelRatio: cardPixels > 0 ? highlightCardTextPixels / cardPixels : 0
    })
  }

  return {
    sampleWidth: width,
    sampleHeight: height,
    anchor,
    cardRegion: region,
    sampledFrames,
    topPixels,
    bottomPixels,
    cardPixels,
    frames,
    maxHighlightMarkerPixelRatio: maxFrameRatio(frames, 'highlightMarkerPixelRatio'),
    maxCaptionMarkerPixelRatio: maxFrameRatio(frames, 'captionMarkerPixelRatio'),
    maxHighlightCardDarkPixelRatio: maxFrameRatio(frames, 'highlightCardDarkPixelRatio'),
    maxHighlightCardTextPixelRatio: maxFrameRatio(frames, 'highlightCardTextPixelRatio')
  }
}

export function evaluateCommentHighlightArtifactMetrics(
  metrics,
  {
    highlightDisposition,
    allowHighlightUnavailable = false,
    minMarkerPixelRatio = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minMarkerPixelRatio,
    minMarkerFrames = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minMarkerFrames,
    minCardDarkPixelRatio = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minCardDarkPixelRatio,
    minCardTextPixelRatio = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minCardTextPixelRatio
  } = {}
) {
  const failures = []
  const warnings = []
  const frames = Array.isArray(metrics?.frames) ? metrics.frames : []
  const markerHighlightFrames = frames.filter(
    (frame) => (frame.highlightMarkerPixelRatio ?? 0) >= minMarkerPixelRatio
  ).length
  const renderedCardFrames = frames.filter(
    (frame) =>
      (frame.highlightCardDarkPixelRatio ?? 0) >= minCardDarkPixelRatio &&
      (frame.highlightCardTextPixelRatio ?? 0) >= minCardTextPixelRatio
  ).length
  const highlightFrameIndexes = new Set(
    frames
      .filter(
        (frame) =>
          (frame.highlightMarkerPixelRatio ?? 0) >= minMarkerPixelRatio ||
          ((frame.highlightCardDarkPixelRatio ?? 0) >= minCardDarkPixelRatio &&
            (frame.highlightCardTextPixelRatio ?? 0) >= minCardTextPixelRatio)
      )
      .map((frame) => frame.index)
  )
  const highlightFrames = highlightFrameIndexes.size
  const captionFrames = frames.filter(
    (frame) => (frame.captionMarkerPixelRatio ?? 0) >= minMarkerPixelRatio
  ).length
  const coexistFrames = frames.filter(
    (frame) =>
      highlightFrameIndexes.has(frame.index) &&
      (frame.captionMarkerPixelRatio ?? 0) >= minMarkerPixelRatio
  ).length

  if ((metrics?.sampledFrames ?? 0) <= 0) {
    failures.push('comment-highlight: no decoded stream frames were sampled')
  }
  if (highlightDisposition === 'live') {
    if (captionFrames < minMarkerFrames) {
      failures.push(
        `comment-highlight: caption marker appeared in ${captionFrames} frame(s), expected at least ${minMarkerFrames}`
      )
    }
    if (highlightFrames < minMarkerFrames) {
      failures.push(
        `comment-highlight: backend reported live but highlight pixels appeared in ${highlightFrames} frame(s), expected at least ${minMarkerFrames}`
      )
    }
    if (coexistFrames < minMarkerFrames) {
      failures.push(
        `comment-highlight: highlight and caption markers coexisted in ${coexistFrames} frame(s), expected at least ${minMarkerFrames}`
      )
    }
  } else if (highlightDisposition === 'highlight-unavailable') {
    if (!allowHighlightUnavailable) {
      failures.push('comment-highlight: highlight-unavailable is allowed only for the legacy path')
    } else {
      warnings.push('legacy output explicitly reported highlight-unavailable')
    }
  } else {
    failures.push(
      'comment-highlight: backend did not report live or explicit highlight-unavailable'
    )
  }

  return {
    pass: failures.length === 0,
    disposition: highlightDisposition ?? 'unknown',
    failures,
    warnings,
    thresholds: {
      minMarkerPixelRatio,
      minMarkerFrames,
      minCardDarkPixelRatio,
      minCardTextPixelRatio
    },
    observations: {
      highlightFrames,
      markerHighlightFrames,
      renderedCardFrames,
      captionFrames,
      coexistFrames
    },
    metrics
  }
}

export async function analyzeCommentHighlightArtifact(
  filePath,
  {
    ffmpegPath = 'ffmpeg',
    highlightDisposition,
    allowHighlightUnavailable = false,
    sampleWidth = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleWidth,
    sampleHeight = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleHeight,
    sampleFps = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleFps,
    anchor = DEFAULT_COMMENT_HIGHLIGHT_ANCHOR,
    minMarkerPixelRatio = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minMarkerPixelRatio,
    minMarkerFrames = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minMarkerFrames,
    minCardDarkPixelRatio = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minCardDarkPixelRatio,
    minCardTextPixelRatio = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minCardTextPixelRatio
  } = {}
) {
  const rgb = await decodeRgbSamples(filePath, {
    ffmpegPath,
    sampleWidth,
    sampleHeight,
    sampleFps
  })
  const metrics = measureCommentHighlightArtifactRgb(rgb, {
    width: sampleWidth,
    height: sampleHeight,
    anchor
  })
  const verdict = evaluateCommentHighlightArtifactMetrics(metrics, {
    highlightDisposition,
    allowHighlightUnavailable,
    minMarkerPixelRatio,
    minMarkerFrames,
    minCardDarkPixelRatio,
    minCardTextPixelRatio
  })
  // Corner proof: only meaningful when a card was actually rendered.
  const anchoredFrames = countCommentHighlightAnchoredFrames(
    metrics,
    measureCommentHighlightArtifactRgb(rgb, {
      width: sampleWidth,
      height: sampleHeight,
      anchor: mirrorCommentHighlightAnchor(anchor)
    })
  )
  const failures = [...verdict.failures]
  if (highlightDisposition === 'live' && anchoredFrames < minMarkerFrames) {
    failures.push(
      `comment-highlight: the card leaned toward the ${anchor} corner in ${anchoredFrames} frame(s), expected at least ${minMarkerFrames}`
    )
  }
  return {
    file: filePath,
    ...verdict,
    anchor,
    failures,
    pass: failures.length === 0,
    observations: { ...verdict.observations, anchoredFrames }
  }
}

export function formatCommentHighlightArtifactSummary(report) {
  const observations = report?.observations ?? {}
  const metrics = report?.metrics ?? {}
  return (
    `Comment highlight artifact gate: ${report?.pass ? 'PASS' : 'FAIL'} ` +
    `disposition=${report?.disposition ?? 'unknown'} frames=${metrics.sampledFrames ?? 0} ` +
    `highlight=${observations.highlightFrames ?? 0} (card=${observations.renderedCardFrames ?? 0}, marker=${observations.markerHighlightFrames ?? 0}) ` +
    `captions=${observations.captionFrames ?? 0} ` +
    `coexist=${observations.coexistFrames ?? 0}` +
    (report?.anchor ? ` anchor=${report.anchor} anchored=${observations.anchoredFrames ?? 0}` : '')
  )
}

export function commentHighlightStimulusPngBase64({ width = 1920, height = 220 } = {}) {
  const rgba = Buffer.alloc(width * height * 4)
  drawRgbaRect(
    rgba,
    width,
    height,
    width * 0.06,
    height * 0.08,
    width * 0.88,
    height * 0.84,
    [8, 12, 22, 235]
  )
  drawRgbaRect(rgba, width, height, width * 0.11, height * 0.3, width * 0.25, height * 0.38, [
    ...COMMENT_HIGHLIGHT_MARKER_RGB,
    255
  ])
  drawRgbaRect(
    rgba,
    width,
    height,
    width * 0.41,
    height * 0.25,
    width * 0.39,
    height * 0.16,
    [248, 250, 252, 245]
  )
  drawRgbaRect(
    rgba,
    width,
    height,
    width * 0.41,
    height * 0.53,
    width * 0.46,
    height * 0.13,
    [210, 216, 226, 240]
  )
  return encodeRgbaPngBase64(width, height, rgba)
}

export function captionStimulusPngBase64({ width = 1920, height = 140 } = {}) {
  const rgba = Buffer.alloc(width * height * 4)
  drawRgbaRect(
    rgba,
    width,
    height,
    width * 0.06,
    height * 0.12,
    width * 0.88,
    height * 0.76,
    [8, 12, 22, 235]
  )
  drawRgbaRect(rgba, width, height, width * 0.14, height * 0.34, width * 0.42, height * 0.32, [
    ...CAPTION_MARKER_RGB,
    255
  ])
  drawRgbaRect(
    rgba,
    width,
    height,
    width * 0.61,
    height * 0.34,
    width * 0.22,
    height * 0.32,
    [248, 250, 252, 245]
  )
  return encodeRgbaPngBase64(width, height, rgba)
}

function isHighlightMarkerPixel(red, green, blue) {
  return (
    red >= 190 &&
    green >= 25 &&
    green <= 155 &&
    blue <= 120 &&
    red - green >= 65 &&
    red - blue >= 90
  )
}

function isCaptionMarkerPixel(red, green, blue) {
  return (
    red <= 125 &&
    green >= 170 &&
    blue >= 95 &&
    blue <= 225 &&
    green - red >= 70 &&
    green - blue >= 20
  )
}

function isHighlightCardDarkPixel(red, green, blue) {
  return (
    Math.max(red, green, blue) <= 55 &&
    Math.max(red, green, blue) - Math.min(red, green, blue) <= 18
  )
}

function isHighlightCardTextPixel(red, green, blue) {
  return (
    Math.min(red, green, blue) >= 170 &&
    Math.max(red, green, blue) - Math.min(red, green, blue) <= 40
  )
}

function maxFrameRatio(frames, key) {
  return frames.reduce((max, frame) => Math.max(max, frame[key] ?? 0), 0)
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
          `comment-highlight artifact ffmpeg sample failed: code=${code} signal=${signal} ${stderr.join('').trim()}`
        )
      )
    })
  })
}

function drawRgbaRect(rgba, canvasWidth, canvasHeight, x, y, width, height, color) {
  const left = Math.max(0, Math.min(canvasWidth, Math.round(x)))
  const top = Math.max(0, Math.min(canvasHeight, Math.round(y)))
  const right = Math.max(left, Math.min(canvasWidth, Math.round(x + width)))
  const bottom = Math.max(top, Math.min(canvasHeight, Math.round(y + height)))
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const offset = (row * canvasWidth + column) * 4
      rgba[offset] = color[0]
      rgba[offset + 1] = color[1]
      rgba[offset + 2] = color[2]
      rgba[offset + 3] = color[3]
    }
  }
}

function encodeRgbaPngBase64(width, height, rgba) {
  const bytesPerRow = width * 4
  const stride = bytesPerRow + 1
  const raw = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * stride] = 0
    rgba.copy(raw, row * stride + 1, row * bytesPerRow, (row + 1) * bytesPerRow)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]).toString('base64')
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

let crc32Table
function crc32(bytes) {
  if (!crc32Table) {
    crc32Table = Array.from({ length: 256 }, (_, value) => {
      let checksum = value
      for (let bit = 0; bit < 8; bit += 1) {
        checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1
      }
      return checksum >>> 0
    })
  }
  let checksum = 0xffffffff
  for (const byte of bytes) {
    checksum = crc32Table[(checksum ^ byte) & 0xff] ^ (checksum >>> 8)
  }
  return (checksum ^ 0xffffffff) >>> 0
}
