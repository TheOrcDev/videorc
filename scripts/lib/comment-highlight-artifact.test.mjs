import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  CAPTION_MARKER_RGB,
  COMMENT_HIGHLIGHT_ANCHORS,
  COMMENT_HIGHLIGHT_AVATAR_RGB,
  COMMENT_HIGHLIGHT_EMOTE_RGB,
  COMMENT_HIGHLIGHT_MARKER_RGB,
  commentHighlightImagePngBase64,
  commentHighlightCardRegion,
  countCommentHighlightAnchoredFrames,
  mirrorCommentHighlightAnchor,
  captionStimulusPngBase64,
  analyzeCommentHighlightArtifact,
  classifyCommentHighlightResult,
  commentHighlightStimulusPngBase64,
  evaluateCommentHighlightArtifactMetrics,
  measureCommentHighlightArtifactRgb
} from './comment-highlight-artifact.mjs'
import { ffmpegAvailable } from './ffmpeg-available.mjs'

const width = 8
const height = 8
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'

describe('comment highlight artifact gate', () => {
  it('passes only when highlight and caption markers coexist in stream frames', () => {
    const rgb = Buffer.concat([
      markerFrame({ highlight: true, caption: true }),
      markerFrame({ highlight: true, caption: true })
    ])
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height, anchor: 'top-left' })
    const verdict = evaluateCommentHighlightArtifactMetrics(metrics, {
      highlightDisposition: 'live',
      minMarkerPixelRatio: 0.1,
      minMarkerFrames: 2
    })

    assert.equal(metrics.sampledFrames, 2)
    assert.equal(verdict.observations.highlightFrames, 2)
    assert.equal(verdict.observations.captionFrames, 2)
    assert.equal(verdict.observations.coexistFrames, 2)
    assert.equal(verdict.pass, true)
  })

  it('proves the card alone when captions are not required (dual-orientation legs)', () => {
    const rgb = Buffer.concat([markerFrame({ highlight: true }), markerFrame({ highlight: true })])
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height, anchor: 'top-left' })
    const cardOnly = evaluateCommentHighlightArtifactMetrics(metrics, {
      highlightDisposition: 'live',
      requireCaption: false,
      minMarkerPixelRatio: 0.1,
      minMarkerFrames: 2
    })
    assert.equal(cardOnly.pass, true, cardOnly.failures.join('\n'))

    // Still a failure when the backend said live and no card was drawn — the
    // exact 2026-09-28 incident shape.
    const empty = measureCommentHighlightArtifactRgb(
      Buffer.concat([markerFrame({}), markerFrame({})]),
      { width, height, anchor: 'top-left' }
    )
    const missing = evaluateCommentHighlightArtifactMetrics(empty, {
      highlightDisposition: 'live',
      requireCaption: false,
      minMarkerPixelRatio: 0.1,
      minMarkerFrames: 2
    })
    assert.equal(missing.pass, false)
    assert.match(missing.failures.join('\n'), /highlight pixels appeared in 0 frame/)
  })

  it('fails when both markers exist but never in the same frame', () => {
    const rgb = Buffer.concat([
      markerFrame({ highlight: true }),
      markerFrame({ caption: true }),
      markerFrame({ highlight: true }),
      markerFrame({ caption: true })
    ])
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height, anchor: 'top-left' })
    const verdict = evaluateCommentHighlightArtifactMetrics(metrics, {
      highlightDisposition: 'live',
      minMarkerPixelRatio: 0.1,
      minMarkerFrames: 2
    })

    assert.equal(verdict.observations.highlightFrames, 2)
    assert.equal(verdict.observations.captionFrames, 2)
    assert.equal(verdict.observations.coexistFrames, 0)
    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('\n'), /coexisted in 0 frame/)
  })

  it('accepts the real dark-glass card shape produced by the detached UI', () => {
    const rgb = Buffer.concat([renderedCardFrame(), renderedCardFrame()])
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height, anchor: 'top-left' })
    const verdict = evaluateCommentHighlightArtifactMetrics(metrics, {
      highlightDisposition: 'live',
      minMarkerPixelRatio: 0.1,
      minMarkerFrames: 2,
      minCardDarkPixelRatio: 0.55,
      minCardTextPixelRatio: 0.1
    })

    assert.equal(verdict.observations.markerHighlightFrames, 0)
    assert.equal(verdict.observations.renderedCardFrames, 2)
    assert.equal(verdict.observations.captionFrames, 2)
    assert.equal(verdict.observations.coexistFrames, 2)
    assert.equal(verdict.pass, true)
  })

  for (const anchor of COMMENT_HIGHLIGHT_ANCHORS) {
    it(`detects a correctly sized 1080p card anchored ${anchor}`, () => {
      const frame = cornerCardFrame(anchor)
      const metrics = measureCommentHighlightArtifactRgb(Buffer.concat([frame, frame]), {
        width: CORNER_SAMPLE_WIDTH,
        height: CORNER_SAMPLE_HEIGHT,
        anchor
      })
      const verdict = evaluateCommentHighlightArtifactMetrics(metrics, {
        highlightDisposition: 'live'
      })

      assert.equal(metrics.anchor, anchor)
      assert.equal(verdict.observations.markerHighlightFrames, 0)
      assert.equal(verdict.observations.renderedCardFrames, 2)
      assert.equal(verdict.observations.coexistFrames, 2)
      assert.equal(verdict.pass, true)
    })
  }

  it('fails when the card is composited in a different corner than the one picked', () => {
    const frame = cornerCardFrame('top-left')
    for (const anchor of ['top-right', 'bottom-left', 'bottom-right']) {
      const metrics = measureCommentHighlightArtifactRgb(Buffer.concat([frame, frame]), {
        width: CORNER_SAMPLE_WIDTH,
        height: CORNER_SAMPLE_HEIGHT,
        anchor
      })
      const verdict = evaluateCommentHighlightArtifactMetrics(metrics, {
        highlightDisposition: 'live'
      })
      assert.equal(verdict.observations.renderedCardFrames, 0, anchor)
      assert.equal(verdict.pass, false, anchor)
    }
  })

  it('tells a corner card from a centred caption bar by left/right dark asymmetry', () => {
    const measure = (frame, anchor) =>
      measureCommentHighlightArtifactRgb(Buffer.concat([frame, frame]), {
        width: CORNER_SAMPLE_WIDTH,
        height: CORNER_SAMPLE_HEIGHT,
        anchor
      })
    for (const anchor of COMMENT_HIGHLIGHT_ANCHORS) {
      const mirror = mirrorCommentHighlightAnchor(anchor)
      assert.equal(mirrorCommentHighlightAnchor(mirror), anchor)
      const card = cornerCardFrame(anchor)
      assert.equal(
        countCommentHighlightAnchoredFrames(measure(card, anchor), measure(card, mirror)),
        2,
        anchor
      )
      // Judged against the wrong side, the same frames never count.
      assert.equal(
        countCommentHighlightAnchoredFrames(measure(card, mirror), measure(card, anchor)),
        0,
        anchor
      )
    }
    // A centred dark caption bar with no card leans toward neither corner.
    const captionOnly = Buffer.alloc(CORNER_SAMPLE_WIDTH * CORNER_SAMPLE_HEIGHT * 3)
    fillRect(
      captionOnly,
      CORNER_SAMPLE_WIDTH,
      0,
      0,
      CORNER_SAMPLE_WIDTH,
      CORNER_SAMPLE_HEIGHT,
      [80, 120, 160]
    )
    fillRect(captionOnly, CORNER_SAMPLE_WIDTH, 10, 72, 150, 82, [16, 16, 18])
    assert.equal(
      countCommentHighlightAnchoredFrames(
        measure(captionOnly, 'bottom-right'),
        measure(captionOnly, 'bottom-left')
      ),
      0
    )
  })

  it('maps every anchor to its own corner region and rejects unknown anchors', () => {
    const size = { width: 100, height: 100 }
    assert.deepEqual(commentHighlightCardRegion('top-left', size), {
      xStart: 8,
      xEnd: 62,
      yStart: 8,
      yEnd: 62,
      top: true
    })
    assert.deepEqual(commentHighlightCardRegion('bottom-right', size), {
      xStart: 38,
      xEnd: 92,
      yStart: 38,
      yEnd: 92,
      top: false
    })
    assert.throws(() => commentHighlightCardRegion('top', size), /Unknown comment highlight anchor/)
  })

  it('scans the portrait safe-area band where a vertical-leg card sits', () => {
    const portrait = { width: 100, height: 200 }
    // Horizontal span is unchanged. Vertically the card keeps out of the
    // platform UI bands (plan 077): bottom 20%..40%, top 6%..26% of the height
    // from the anchored edge.
    assert.deepEqual(commentHighlightCardRegion('bottom-left', portrait), {
      xStart: 8,
      xEnd: 62,
      yStart: 120,
      yEnd: 160,
      top: false
    })
    assert.deepEqual(commentHighlightCardRegion('top-right', portrait), {
      xStart: 38,
      xEnd: 92,
      yStart: 12,
      yEnd: 52,
      top: true
    })
  })

  it('accepts explicit legacy unavailability when stream frames were decoded', () => {
    const rgb = Buffer.concat([markerFrame(), markerFrame()])
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height, anchor: 'top-left' })
    const verdict = evaluateCommentHighlightArtifactMetrics(metrics, {
      highlightDisposition: 'highlight-unavailable',
      allowHighlightUnavailable: true,
      minMarkerPixelRatio: 0.1,
      minMarkerFrames: 2
    })

    assert.equal(verdict.pass, true)
    assert.equal(verdict.disposition, 'highlight-unavailable')
    assert.equal(verdict.observations.highlightFrames, 0)
    assert.equal(verdict.observations.captionFrames, 0)
  })

  it('rejects highlight-unavailable on a modern output path', () => {
    const rgb = Buffer.concat([markerFrame({ caption: true }), markerFrame({ caption: true })])
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height, anchor: 'top-left' })
    const verdict = evaluateCommentHighlightArtifactMetrics(metrics, {
      highlightDisposition: 'highlight-unavailable',
      allowHighlightUnavailable: false,
      minMarkerPixelRatio: 0.1,
      minMarkerFrames: 2
    })

    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('\n'), /allowed only for the legacy path/)
  })

  it('requires a backend-authoritative terminal result', () => {
    assert.equal(classifyCommentHighlightResult({ phase: 'live' }), 'live')
    assert.equal(
      classifyCommentHighlightResult({ phase: 'failed', code: 'highlight-unavailable' }),
      'highlight-unavailable'
    )
    assert.equal(
      classifyCommentHighlightResult({ phase: 'failed', reason: 'highlight-unavailable' }),
      'highlight-unavailable'
    )
    assert.equal(classifyCommentHighlightResult({ active: true }), 'unknown')
  })

  it('proves the avatar and the emote reached the card only by their colours (plan 095)', () => {
    // A monogram card: dark glass and text, none of either image colour.
    const monogram = Buffer.concat([
      markerFrame({ highlight: true }),
      markerFrame({ highlight: true })
    ])
    const monogramMetrics = measureCommentHighlightArtifactRgb(monogram, {
      width,
      height,
      anchor: 'top-left'
    })
    const monogramVerdict = evaluateCommentHighlightArtifactMetrics(monogramMetrics, {
      highlightDisposition: 'live',
      requireCaption: false,
      requireAvatar: true,
      requireEmote: true,
      minMarkerPixelRatio: 0.1,
      minMarkerFrames: 2
    })
    assert.equal(monogramVerdict.pass, false)
    assert.match(
      monogramVerdict.failures.join('\n'),
      /avatar colour appeared in the card in 0 frame/
    )
    assert.match(
      monogramVerdict.failures.join('\n'),
      /emote colour appeared in the card in 0 frame/
    )

    // A card with one avatar pixel and one emote pixel on the anchored edge,
    // where the avatar sits (outside the 8%-inset card region).
    const imaged = () => {
      const rgb = markerFrame({ highlight: true })
      const region = commentHighlightCardRegion('top-left', { width, height }, { toEdge: true })
      assert.equal(region.xStart, 0)
      assert.equal(region.yStart, 0)
      const paint = (column, color) => {
        const offset = (region.yStart * width + region.xStart + column) * 3
        rgb[offset] = color[0]
        rgb[offset + 1] = color[1]
        rgb[offset + 2] = color[2]
      }
      paint(0, COMMENT_HIGHLIGHT_AVATAR_RGB)
      paint(1, COMMENT_HIGHLIGHT_EMOTE_RGB)
      return rgb
    }
    const imagedMetrics = measureCommentHighlightArtifactRgb(Buffer.concat([imaged(), imaged()]), {
      width,
      height,
      anchor: 'top-left'
    })
    const imagedVerdict = evaluateCommentHighlightArtifactMetrics(imagedMetrics, {
      highlightDisposition: 'live',
      requireCaption: false,
      requireAvatar: true,
      requireEmote: true,
      minMarkerPixelRatio: 0.1,
      minMarkerFrames: 2
    })
    assert.equal(imagedVerdict.pass, true, imagedVerdict.failures.join('\n'))
    assert.equal(imagedVerdict.observations.avatarFrames, 2)
    assert.equal(imagedVerdict.observations.emoteFrames, 2)

    // Neither classifier fires on the other markers, the test pattern's pink
    // line or yellow marker, white text, or the monogram grey.
    const unrelated = Buffer.alloc(width * height * 3)
    const distractors = [
      COMMENT_HIGHLIGHT_MARKER_RGB,
      CAPTION_MARKER_RGB,
      [220, 92, 180],
      [255, 245, 80],
      [235, 235, 235],
      [58, 58, 60],
      [0, 0, 191],
      [0, 191, 0]
    ]
    distractors.forEach((color, index) => fillRows(unrelated, index, index + 1, color))
    const unrelatedMetrics = measureCommentHighlightArtifactRgb(unrelated, {
      width,
      height,
      anchor: 'top-left'
    })
    assert.equal(unrelatedMetrics.maxHighlightAvatarPixelRatio, 0)
    assert.equal(unrelatedMetrics.maxHighlightEmotePixelRatio, 0)
  })

  it('builds a flat PNG for the smoke avatar cache', () => {
    const png = Buffer.from(
      commentHighlightImagePngBase64({ rgb: COMMENT_HIGHLIGHT_AVATAR_RGB }),
      'base64'
    )
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    assert.equal(png.readUInt32BE(16), 128)
    assert.equal(png.readUInt32BE(20), 128)
  })

  it('builds deterministic valid PNG marker stimuli', () => {
    const highlight = Buffer.from(commentHighlightStimulusPngBase64(), 'base64')
    const captions = Buffer.from(captionStimulusPngBase64(), 'base64')
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    assert.deepEqual(highlight.subarray(0, 8), pngSignature)
    assert.deepEqual(captions.subarray(0, 8), pngSignature)
    assert.notDeepEqual(highlight, captions)
  })

  it(
    'detects both markers after real YUV420 video encoding',
    { skip: ffmpegAvailable(ffmpegPath) ? false : 'ffmpeg not installed' },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'videorc-comment-highlight-artifact-'))
      const highlightPath = join(directory, 'highlight.png')
      const captionPath = join(directory, 'caption.png')
      const videoPath = join(directory, 'coexist.mp4')
      const backgroundPath = join(directory, 'background.mp4')
      try {
        writeFileSync(
          highlightPath,
          Buffer.from(commentHighlightStimulusPngBase64({ width: 640, height: 74 }), 'base64')
        )
        writeFileSync(
          captionPath,
          Buffer.from(captionStimulusPngBase64({ width: 640, height: 47 }), 'base64')
        )
        const encoded = spawnSync(
          ffmpegPath,
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=640x360:rate=30',
            '-loop',
            '1',
            '-i',
            highlightPath,
            '-loop',
            '1',
            '-i',
            captionPath,
            '-filter_complex',
            '[0:v][1:v]overlay=0:14[v1];[v1][2:v]overlay=0:H-h-14[v]',
            '-map',
            '[v]',
            '-t',
            '1.5',
            '-c:v',
            'mpeg4',
            '-q:v',
            '5',
            '-pix_fmt',
            'yuv420p',
            videoPath
          ],
          { encoding: 'utf8', timeout: 30000 }
        )
        assert.equal(encoded.status, 0, encoded.stderr)

        // The stimulus is overlaid at the top of the frame.
        const report = await analyzeCommentHighlightArtifact(videoPath, {
          ffmpegPath,
          highlightDisposition: 'live',
          anchor: 'top-left'
        })
        assert.equal(report.pass, true, report.failures.join('\n'))
        assert.ok(report.observations.coexistFrames >= 2)

        const backgroundEncoded = spawnSync(
          ffmpegPath,
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=640x360:rate=30',
            '-t',
            '1.5',
            '-c:v',
            'mpeg4',
            '-q:v',
            '5',
            '-pix_fmt',
            'yuv420p',
            backgroundPath
          ],
          { encoding: 'utf8', timeout: 30000 }
        )
        assert.equal(backgroundEncoded.status, 0, backgroundEncoded.stderr)
        const background = await analyzeCommentHighlightArtifact(backgroundPath, {
          ffmpegPath,
          highlightDisposition: 'live'
        })
        assert.equal(background.pass, false)
        assert.equal(background.observations.coexistFrames, 0)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})

const CORNER_SAMPLE_WIDTH = 160
const CORNER_SAMPLE_HEIGHT = 90

/** A 1080p-proportioned card (64×19 sample px with a text band) sitting at the
 * compositor's corner inset, over a frame whose bottom half carries captions. */
function cornerCardFrame(anchor) {
  const frame = Buffer.alloc(CORNER_SAMPLE_WIDTH * CORNER_SAMPLE_HEIGHT * 3)
  fillRect(
    frame,
    CORNER_SAMPLE_WIDTH,
    0,
    0,
    CORNER_SAMPLE_WIDTH,
    CORNER_SAMPLE_HEIGHT,
    [80, 120, 160]
  )
  fillRect(
    frame,
    CORNER_SAMPLE_WIDTH,
    0,
    45,
    CORNER_SAMPLE_WIDTH,
    CORNER_SAMPLE_HEIGHT,
    CAPTION_MARKER_RGB
  )
  const left = anchor.endsWith('-left') ? 5 : CORNER_SAMPLE_WIDTH - 5 - 64
  const top = anchor.startsWith('top-') ? 6 : CORNER_SAMPLE_HEIGHT - 6 - 19
  fillRect(frame, CORNER_SAMPLE_WIDTH, left, top, left + 64, top + 19, [16, 16, 18])
  fillRect(frame, CORNER_SAMPLE_WIDTH, left, top + 10, left + 64, top + 15, [235, 235, 238])
  return frame
}

function markerFrame({ highlight = false, caption = false } = {}) {
  const rgb = Buffer.alloc(width * height * 3, 24)
  if (highlight) {
    fillRows(rgb, 0, height / 2, COMMENT_HIGHLIGHT_MARKER_RGB)
  }
  if (caption) {
    fillRows(rgb, height / 2, height, CAPTION_MARKER_RGB)
  }
  return rgb
}

function renderedCardFrame() {
  const rgb = Buffer.alloc(width * height * 3)
  fillRows(rgb, 0, height, [80, 120, 160])
  fillRows(rgb, 1, 4, [16, 16, 18])
  for (let column = 0; column < width / 2; column += 1) {
    const offset = (2 * width + column) * 3
    rgb[offset] = 235
    rgb[offset + 1] = 235
    rgb[offset + 2] = 238
  }
  fillRows(rgb, height / 2, height, CAPTION_MARKER_RGB)
  return rgb
}

function fillRows(rgb, startRow, endRow, color) {
  for (let row = startRow; row < endRow; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * 3
      rgb[offset] = color[0]
      rgb[offset + 1] = color[1]
      rgb[offset + 2] = color[2]
    }
  }
}

function fillRect(rgb, frameWidth, startColumn, startRow, endColumn, endRow, color) {
  for (let row = startRow; row < endRow; row += 1) {
    for (let column = startColumn; column < endColumn; column += 1) {
      const offset = (row * frameWidth + column) * 3
      rgb[offset] = color[0]
      rgb[offset + 1] = color[1]
      rgb[offset + 2] = color[2]
    }
  }
}
