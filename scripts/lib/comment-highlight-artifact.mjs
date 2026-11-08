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
/** The smoke's fake chatter avatar and emote (plan 095): flat colours the
 * synthetic test pattern (grey ramp, white and pink lines, a yellow marker),
 * the monogram (grey on glass) and the two markers above never produce, so
 * their presence inside the card region proves the image reached the card. */
export const COMMENT_HIGHLIGHT_AVATAR_RGB = Object.freeze([30, 90, 255])
export const COMMENT_HIGHLIGHT_EMOTE_RGB = Object.freeze([120, 255, 40])
/** A 60 px avatar on a 1080p card is ~0.5% of the card region once sampled at
 * 640x360; a 48 px emote ~0.3%. A monogram card has 0 of either colour. */
export const COMMENT_HIGHLIGHT_MIN_IMAGE_PIXEL_RATIO = 0.0008

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
 * scanned: a card that ignored the anchor must fail this gate.
 *
 * On a portrait canvas (the vertical simulcast leg) the card is only ~10% of
 * the height and keeps out of the platform UI bands (plan 077): 8% below the
 * top or 22% above the bottom. The vertical span covers exactly that band
 * (top 6%..26%, bottom 20%..40% from the anchored edge) instead of diluting
 * the card in half the frame. */
export function commentHighlightCardRegion(
  anchor = DEFAULT_COMMENT_HIGHLIGHT_ANCHOR,
  { width, height },
  // The avatar sits on the card's NEAR edge (4% margin plus padding), so the
  // image scan (plan 095) runs from the anchored edge itself; the portrait
  // vertical band already clears the platform UI and keeps its start.
  { toEdge = false } = {}
) {
  if (!COMMENT_HIGHLIGHT_ANCHORS.includes(anchor)) {
    throw new Error(`Unknown comment highlight anchor: ${anchor}`)
  }
  const portrait = height > width
  const top = anchor.startsWith('top-')
  const span = (size, fromStart, vertical = false) => {
    const [nearFraction, farFraction] =
      portrait && vertical ? (top ? [0.06, 0.26] : [0.2, 0.4]) : [toEdge ? 0 : 0.08, 0.62]
    const near = Math.round(size * nearFraction)
    const far = Math.round(size * farFraction)
    const start = fromStart ? near : size - far
    const end = fromStart ? far : size - near
    return [Math.max(0, Math.min(size - 1, start)), Math.max(1, Math.min(size, end))]
  }
  const [yStart, yEnd] = span(height, anchor.startsWith('top-'), true)
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
  const imageRegion = commentHighlightCardRegion(anchor, { width, height }, { toEdge: true })
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
    let highlightAvatarPixels = 0
    let highlightEmotePixels = 0

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
        if (
          y >= imageRegion.yStart &&
          y < imageRegion.yEnd &&
          x >= imageRegion.xStart &&
          x < imageRegion.xEnd
        ) {
          if (isHighlightAvatarPixel(red, green, blue)) highlightAvatarPixels += 1
          if (isHighlightEmotePixel(red, green, blue)) highlightEmotePixels += 1
        }
      }
    }

    frames.push({
      index: frame,
      highlightMarkerPixels,
      captionMarkerPixels,
      highlightCardDarkPixels,
      highlightCardTextPixels,
      highlightAvatarPixels,
      highlightEmotePixels,
      highlightAvatarPixelRatio: cardPixels > 0 ? highlightAvatarPixels / cardPixels : 0,
      highlightEmotePixelRatio: cardPixels > 0 ? highlightEmotePixels / cardPixels : 0,
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
    imageRegion,
    sampledFrames,
    topPixels,
    bottomPixels,
    cardPixels,
    frames,
    maxHighlightMarkerPixelRatio: maxFrameRatio(frames, 'highlightMarkerPixelRatio'),
    maxCaptionMarkerPixelRatio: maxFrameRatio(frames, 'captionMarkerPixelRatio'),
    maxHighlightCardDarkPixelRatio: maxFrameRatio(frames, 'highlightCardDarkPixelRatio'),
    maxHighlightCardTextPixelRatio: maxFrameRatio(frames, 'highlightCardTextPixelRatio'),
    maxHighlightAvatarPixelRatio: maxFrameRatio(frames, 'highlightAvatarPixelRatio'),
    maxHighlightEmotePixelRatio: maxFrameRatio(frames, 'highlightEmotePixelRatio')
  }
}

export function evaluateCommentHighlightArtifactMetrics(
  metrics,
  {
    highlightDisposition,
    allowHighlightUnavailable = false,
    // Dual-orientation sessions refuse stream-burned captions, so their
    // artifacts prove the card alone.
    requireCaption = true,
    // Plan 095: the fake chatter's avatar and emote must reach the card.
    requireAvatar = false,
    requireEmote = false,
    minMarkerPixelRatio = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minMarkerPixelRatio,
    minMarkerFrames = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minMarkerFrames,
    minCardDarkPixelRatio = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minCardDarkPixelRatio,
    minCardTextPixelRatio = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.minCardTextPixelRatio,
    minImagePixelRatio = COMMENT_HIGHLIGHT_MIN_IMAGE_PIXEL_RATIO
  } = {}
) {
  const failures = []
  const warnings = []
  const frames = Array.isArray(metrics?.frames) ? metrics.frames : []
  const avatarFrames = frames.filter(
    (frame) => (frame.highlightAvatarPixelRatio ?? 0) >= minImagePixelRatio
  ).length
  const emoteFrames = frames.filter(
    (frame) => (frame.highlightEmotePixelRatio ?? 0) >= minImagePixelRatio
  ).length
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
    if (requireCaption && captionFrames < minMarkerFrames) {
      failures.push(
        `comment-highlight: caption marker appeared in ${captionFrames} frame(s), expected at least ${minMarkerFrames}`
      )
    }
    if (highlightFrames < minMarkerFrames) {
      failures.push(
        `comment-highlight: backend reported live but highlight pixels appeared in ${highlightFrames} frame(s), expected at least ${minMarkerFrames}`
      )
    }
    if (requireCaption && coexistFrames < minMarkerFrames) {
      failures.push(
        `comment-highlight: highlight and caption markers coexisted in ${coexistFrames} frame(s), expected at least ${minMarkerFrames}`
      )
    }
    if (requireAvatar && avatarFrames < minMarkerFrames) {
      failures.push(
        `comment-highlight: the avatar colour appeared in the card in ${avatarFrames} frame(s), expected at least ${minMarkerFrames} (a monogram card has none)`
      )
    }
    if (requireEmote && emoteFrames < minMarkerFrames) {
      failures.push(
        `comment-highlight: the emote colour appeared in the card in ${emoteFrames} frame(s), expected at least ${minMarkerFrames} (an emote drawn as text has none)`
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
      minCardTextPixelRatio,
      minImagePixelRatio
    },
    observations: {
      highlightFrames,
      markerHighlightFrames,
      renderedCardFrames,
      captionFrames,
      coexistFrames,
      avatarFrames,
      emoteFrames
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
    requireCaption = true,
    requireAvatar = false,
    requireEmote = false,
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
    requireCaption,
    requireAvatar,
    requireEmote,
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

// --- Chat on stream (plan 215 G, D5) ------------------------------------------

/** The chat box's thresholds. The box is exactly its rect's width, drawn from
 * the rect's top-left corner, and each row leads with the platform icon after
 * the box's padding (0.7 × the text size, ~2-3.5% of the default rects'
 * widths). The fake chatter is on YouTube, so the icon is YouTube's red mark;
 * it and the emote are ~0.5% of the rect at 640x360. A box the backend
 * centre-cropped (painted wider than the rect it lands on) has lost its left
 * edge: the icon is gone or sits on the rect's edge with no glass before it,
 * so the gate reads the padding, not only what is somewhere in the rect.
 * No mirrored-rect comparison: the portrait rect is 80% of the frame wide,
 * so its mirror overlaps it and the comparison proved nothing there. */
export const CHAT_BOX_ARTIFACT_DEFAULTS = Object.freeze({
  minEmotePixelRatio: COMMENT_HIGHLIGHT_MIN_IMAGE_PIXEL_RATIO,
  minIconPixelRatio: COMMENT_HIGHLIGHT_MIN_IMAGE_PIXEL_RATIO,
  /** The glass before the icon, as a fraction of the rect's width. */
  minLeadingPaddingRatio: 0.01,
  /** How much of that padding (over the icon's rows) is the box's glass. */
  minLeadingGlassRatio: 0.6,
  minFrames: 2
})

/** A normalized overlay rect (`overlayLayout.chat.horizontal` or
 * `.vertical`) as sampled pixels. */
export function chatBoxRegions(rect, { width, height }) {
  const xStart = Math.max(0, Math.min(width - 1, Math.round(rect.x * width)))
  const xEnd = Math.max(xStart + 1, Math.min(width, Math.round((rect.x + rect.w) * width)))
  const yStart = Math.max(0, Math.min(height - 1, Math.round(rect.y * height)))
  const yEnd = Math.max(yStart + 1, Math.min(height, Math.round((rect.y + rect.h) * height)))
  return { box: { xStart, xEnd, yStart, yEnd } }
}

/** Per frame, inside the chat rect: the emote's colour, the leading icon's
 * (YouTube red) and where it starts, and the glass between the rect's left
 * edge and the icon over the icon's rows. `chatDarkPixelRatio` is the glass
 * in the whole rect, an observation only: one message is a short box at the
 * top of a tall rect. */
export function measureChatBoxArtifactRgb(
  rgb,
  {
    width = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleWidth,
    height = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleHeight,
    rect
  }
) {
  const frameBytes = width * height * 3
  const sampledFrames = frameBytes > 0 ? Math.floor((rgb?.length ?? 0) / frameBytes) : 0
  const regions = chatBoxRegions(rect, { width, height })
  const { box } = regions
  const boxPixels = (box.xEnd - box.xStart) * (box.yEnd - box.yStart)
  const boxWidth = box.xEnd - box.xStart
  const frames = []
  for (let frame = 0; frame < sampledFrames; frame += 1) {
    const frameStart = frame * frameBytes
    const at = (x, y) => {
      const offset = frameStart + (y * width + x) * 3
      return [rgb[offset], rgb[offset + 1], rgb[offset + 2]]
    }
    let emote = 0
    let dark = 0
    let icon = 0
    let iconLeft = Infinity
    let iconTop = Infinity
    let iconBottom = -Infinity
    for (let y = box.yStart; y < box.yEnd; y += 1) {
      for (let x = box.xStart; x < box.xEnd; x += 1) {
        const [red, green, blue] = at(x, y)
        if (isHighlightEmotePixel(red, green, blue)) emote += 1
        if (isHighlightCardDarkPixel(red, green, blue)) dark += 1
        if (isChatBoxIconPixel(red, green, blue)) {
          icon += 1
          iconLeft = Math.min(iconLeft, x)
          iconTop = Math.min(iconTop, y)
          iconBottom = Math.max(iconBottom, y)
        }
      }
    }
    // The padding: the columns from the rect's left edge up to the icon, over
    // the icon's rows. No icon, no padding.
    let leadingPaddingPx = 0
    let leadingGlassRatio = 0
    if (icon > 0) {
      leadingPaddingPx = iconLeft - box.xStart
      let glass = 0
      let total = 0
      for (let y = iconTop; y <= iconBottom; y += 1) {
        for (let x = box.xStart; x < iconLeft; x += 1) {
          total += 1
          if (isChatBoxGlassPixel(...at(x, y))) glass += 1
        }
      }
      leadingGlassRatio = total > 0 ? glass / total : 0
    }
    frames.push({
      index: frame,
      chatEmotePixelRatio: emote / boxPixels,
      chatIconPixelRatio: icon / boxPixels,
      chatLeadingPaddingRatio: leadingPaddingPx / boxWidth,
      chatLeadingGlassRatio: leadingGlassRatio,
      chatDarkPixelRatio: dark / boxPixels
    })
  }
  return { sampleWidth: width, sampleHeight: height, rect, regions, sampledFrames, frames }
}

/** The box is on stream, whole: in enough frames the emote and the leading
 * icon show inside the chat rect, and the icon has the box's glass padding
 * before it, so a box cropped at its left edge fails. */
export function evaluateChatBoxArtifactMetrics(
  metrics,
  {
    minEmotePixelRatio = CHAT_BOX_ARTIFACT_DEFAULTS.minEmotePixelRatio,
    minIconPixelRatio = CHAT_BOX_ARTIFACT_DEFAULTS.minIconPixelRatio,
    minLeadingPaddingRatio = CHAT_BOX_ARTIFACT_DEFAULTS.minLeadingPaddingRatio,
    minLeadingGlassRatio = CHAT_BOX_ARTIFACT_DEFAULTS.minLeadingGlassRatio,
    minFrames = CHAT_BOX_ARTIFACT_DEFAULTS.minFrames
  } = {}
) {
  const frames = metrics?.frames ?? []
  const checks = [
    ['emote', (frame) => frame.chatEmotePixelRatio >= minEmotePixelRatio],
    ['icon', (frame) => frame.chatIconPixelRatio >= minIconPixelRatio],
    ['padding', (frame) => frame.chatLeadingPaddingRatio >= minLeadingPaddingRatio],
    ['glass', (frame) => frame.chatLeadingGlassRatio >= minLeadingGlassRatio]
  ]
  const passing = Object.fromEntries(
    checks.map(([name, test]) => [name, frames.filter((frame) => test(frame)).length])
  )
  const boxFrames = frames.filter((frame) => checks.every(([, test]) => test(frame))).length
  const failures = []
  if ((metrics?.sampledFrames ?? 0) === 0) failures.push('chat box: no frames were sampled')
  else if (boxFrames < minFrames) {
    failures.push(
      `chat box: the whole box (emote, the leading icon and the glass padding before it, inside the chat rect) showed in ${boxFrames} frame(s), expected at least ${minFrames} (emote in ${passing.emote}, icon in ${passing.icon}, padding before the icon in ${passing.padding}, glass in that padding in ${passing.glass})`
    )
  }
  return {
    pass: failures.length === 0,
    failures,
    observations: {
      boxFrames,
      emoteFrames: passing.emote,
      iconFrames: passing.icon,
      paddingFrames: passing.padding,
      glassFrames: passing.glass,
      maxChatEmotePixelRatio: maxFrameRatio(frames, 'chatEmotePixelRatio'),
      maxChatIconPixelRatio: maxFrameRatio(frames, 'chatIconPixelRatio'),
      maxChatLeadingPaddingRatio: maxFrameRatio(frames, 'chatLeadingPaddingRatio'),
      maxChatLeadingGlassRatio: maxFrameRatio(frames, 'chatLeadingGlassRatio'),
      maxChatDarkPixelRatio: maxFrameRatio(frames, 'chatDarkPixelRatio')
    }
  }
}

export async function analyzeChatBoxArtifact(
  filePath,
  {
    ffmpegPath = 'ffmpeg',
    rect,
    sampleWidth = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleWidth,
    sampleHeight = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleHeight,
    sampleFps = COMMENT_HIGHLIGHT_ARTIFACT_DEFAULTS.sampleFps
  }
) {
  const rgb = await decodeRgbSamples(filePath, { ffmpegPath, sampleWidth, sampleHeight, sampleFps })
  const metrics = measureChatBoxArtifactRgb(rgb, { width: sampleWidth, height: sampleHeight, rect })
  return { file: filePath, rect, ...evaluateChatBoxArtifactMetrics(metrics) }
}

export function formatCommentHighlightArtifactSummary(report) {
  const observations = report?.observations ?? {}
  const metrics = report?.metrics ?? {}
  return (
    `Comment highlight artifact gate: ${report?.pass ? 'PASS' : 'FAIL'} ` +
    `disposition=${report?.disposition ?? 'unknown'} frames=${metrics.sampledFrames ?? 0} ` +
    `highlight=${observations.highlightFrames ?? 0} (card=${observations.renderedCardFrames ?? 0}, marker=${observations.markerHighlightFrames ?? 0}) ` +
    `captions=${observations.captionFrames ?? 0} ` +
    `coexist=${observations.coexistFrames ?? 0} ` +
    `avatar=${observations.avatarFrames ?? 0} emote=${observations.emoteFrames ?? 0}` +
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

/** A flat image for the smoke's avatar cache: the fake chatter's avatar or
 * emote (plan 095). A square by default; `width` x `height` for a wide emote. */
export function commentHighlightImagePngBase64({ width = 128, height = 128, rgb }) {
  const rgba = Buffer.alloc(width * height * 4)
  drawRgbaRect(rgba, width, height, 0, 0, width, height, [...rgb, 255])
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

function isHighlightAvatarPixel(red, green, blue) {
  return red <= 110 && green >= 40 && green <= 150 && blue >= 200 && blue - green >= 80
}

function isHighlightEmotePixel(red, green, blue) {
  return (
    red >= 60 &&
    red <= 170 &&
    green >= 200 &&
    blue <= 110 &&
    green - red >= 60 &&
    green - blue >= 120
  )
}

function isHighlightCardDarkPixel(red, green, blue) {
  return (
    Math.max(red, green, blue) <= 55 &&
    Math.max(red, green, blue) - Math.min(red, green, blue) <= 18
  )
}

/** YouTube's red mark (the box's leading icon for the fake chatter): not the
 * highlight marker (its green is 82), the test pattern's pink line, or the
 * avatar and emote. */
export function isChatBoxIconPixel(red, green, blue) {
  return red >= 200 && green <= 50 && blue <= 110 && red - green >= 150
}

/** The box's glass (rgba(16, 16, 18, 0.78)) over whatever the picture shows:
 * at most 0.22 × 255 + 12.5 ≈ 69 in any channel before compression. */
export function isChatBoxGlassPixel(red, green, blue) {
  return Math.max(red, green, blue) <= 90
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
