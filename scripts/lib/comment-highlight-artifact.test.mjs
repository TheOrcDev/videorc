import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  CAPTION_MARKER_RGB,
  COMMENT_HIGHLIGHT_MARKER_RGB,
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
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height })
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

  it('fails when both markers exist but never in the same frame', () => {
    const rgb = Buffer.concat([
      markerFrame({ highlight: true }),
      markerFrame({ caption: true }),
      markerFrame({ highlight: true }),
      markerFrame({ caption: true })
    ])
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height })
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
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height })
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

  it('detects a correctly sized 1080p card inside the compositor top margin', () => {
    const sampleWidth = 160
    const sampleHeight = 90
    const frame = Buffer.alloc(sampleWidth * sampleHeight * 3)
    fillRect(frame, sampleWidth, 0, 0, sampleWidth, sampleHeight, [80, 120, 160])
    fillRect(frame, sampleWidth, 48, 6, 112, 25, [16, 16, 18])
    fillRect(frame, sampleWidth, 48, 16, 112, 21, [235, 235, 238])
    fillRect(frame, sampleWidth, 0, 45, sampleWidth, sampleHeight, CAPTION_MARKER_RGB)

    const metrics = measureCommentHighlightArtifactRgb(Buffer.concat([frame, frame]), {
      width: sampleWidth,
      height: sampleHeight
    })
    const verdict = evaluateCommentHighlightArtifactMetrics(metrics, {
      highlightDisposition: 'live'
    })

    assert.equal(verdict.observations.markerHighlightFrames, 0)
    assert.equal(verdict.observations.renderedCardFrames, 2)
    assert.equal(verdict.observations.coexistFrames, 2)
    assert.equal(verdict.pass, true)
  })

  it('accepts explicit legacy unavailability when stream frames were decoded', () => {
    const rgb = Buffer.concat([markerFrame(), markerFrame()])
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height })
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
    const metrics = measureCommentHighlightArtifactRgb(rgb, { width, height })
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

        const report = await analyzeCommentHighlightArtifact(videoPath, {
          ffmpegPath,
          highlightDisposition: 'live'
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
