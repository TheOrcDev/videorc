import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  analyzeCaptionsLiveArtifact,
  evaluateCaptionsAbsentArtifactMetrics,
  evaluateCaptionsLiveArtifactMetrics,
  measureCaptionsLiveArtifactRgb
} from './captions-live-artifact.mjs'
import { ffmpegAvailable } from './ffmpeg-available.mjs'

const width = 64
const height = 36
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'

describe('captions live artifact gate', () => {
  it('requires baseline frames followed by a sustained dark plate with bright glyphs', () => {
    const rgb = Buffer.concat([
      frame(),
      frame(),
      frame({ caption: true }),
      frame({ caption: true }),
      frame({ caption: true })
    ])
    const metrics = measureCaptionsLiveArtifactRgb(rgb, smallOptions())
    const verdict = evaluateCaptionsLiveArtifactMetrics(metrics, {
      minCaptionFrames: 3,
      minBaselineFramesBeforeCaption: 2,
      minConsecutiveCaptionFrames: 2
    })

    assert.equal(verdict.pass, true, verdict.failures.join('\n'))
    assert.equal(verdict.observations.baselineFramesBeforeCaption, 2)
    assert.equal(verdict.observations.captionFrames, 3)
    assert.equal(verdict.observations.longestCaptionRun, 3)
  })

  it('rejects a dark source without bright renderer glyphs', () => {
    const rgb = Buffer.concat([
      frame(),
      frame(),
      frame({ darkPlateOnly: true }),
      frame({ darkPlateOnly: true }),
      frame({ darkPlateOnly: true })
    ])
    const metrics = measureCaptionsLiveArtifactRgb(rgb, smallOptions())
    const verdict = evaluateCaptionsLiveArtifactMetrics(metrics, {
      minCaptionFrames: 2,
      minBaselineFramesBeforeCaption: 2
    })

    assert.equal(verdict.pass, false)
    assert.equal(verdict.observations.captionFrames, 0)
    assert.match(verdict.failures.join('\n'), /High Contrast caption pixels appeared in 0/)
  })

  it('rejects a caption-shaped source that exists from frame zero', () => {
    const rgb = Buffer.concat([
      frame({ caption: true }),
      frame({ caption: true }),
      frame({ caption: true })
    ])
    const metrics = measureCaptionsLiveArtifactRgb(rgb, smallOptions())
    const verdict = evaluateCaptionsLiveArtifactMetrics(metrics, {
      minCaptionFrames: 2,
      minBaselineFramesBeforeCaption: 2
    })

    assert.equal(verdict.pass, false)
    assert.equal(verdict.observations.baselineFramesBeforeCaption, 0)
    assert.match(verdict.failures.join('\n'), /baseline frame/)
  })

  it('proves a source recording stayed clean across the sampled timeline', () => {
    const metrics = measureCaptionsLiveArtifactRgb(
      Buffer.concat(Array.from({ length: 6 }, () => frame())),
      smallOptions()
    )
    const verdict = evaluateCaptionsAbsentArtifactMetrics(metrics, { minSampledFrames: 5 })

    assert.equal(verdict.pass, true, verdict.failures.join('\n'))
    assert.equal(verdict.observations.captionFrames, 0)
    assert.equal(verdict.observations.baselineFrames, 6)
  })

  it('rejects a supposedly clean original when any caption frame is decoded', () => {
    const metrics = measureCaptionsLiveArtifactRgb(
      Buffer.concat([frame(), frame({ caption: true }), frame()]),
      smallOptions()
    )
    const verdict = evaluateCaptionsAbsentArtifactMetrics(metrics)

    assert.equal(verdict.pass, false)
    assert.equal(verdict.observations.captionFrames, 1)
    assert.match(verdict.failures.join('\n'), /expected at most 0/)
  })

  it(
    'detects the plate and glyphs after real YUV420 video encoding',
    { skip: ffmpegAvailable(ffmpegPath) ? false : 'ffmpeg not installed' },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'videorc-captions-live-artifact-'))
      const videoPath = join(directory, 'captions-live.mp4')
      try {
        const raw = Buffer.concat([
          ...Array.from({ length: 4 }, () => frame({ width: 320, height: 180 })),
          ...Array.from({ length: 11 }, () => frame({ caption: true, width: 320, height: 180 }))
        ])
        const encoded = spawnSync(
          ffmpegPath,
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'rawvideo',
            '-pixel_format',
            'rgb24',
            '-video_size',
            '320x180',
            '-framerate',
            '5',
            '-i',
            'pipe:0',
            '-c:v',
            'mpeg4',
            '-q:v',
            '5',
            '-pix_fmt',
            'yuv420p',
            videoPath
          ],
          { input: raw, encoding: 'buffer', timeout: 30_000 }
        )
        assert.equal(encoded.status, 0, encoded.stderr?.toString())

        const report = await analyzeCaptionsLiveArtifact(videoPath, {
          ffmpegPath,
          sampleWidth: 320,
          sampleHeight: 180,
          sampleFps: 5
        })
        assert.equal(report.pass, true, report.failures.join('\n'))
        assert.ok(report.observations.captionFrames >= 3)
        assert.ok(report.observations.baselineFramesBeforeCaption >= 2)
      } finally {
        rmSync(directory, { force: true, recursive: true })
      }
    }
  )
})

function smallOptions() {
  return {
    width,
    height,
    minPlateRowFraction: 0.05,
    minPlateWidthFraction: 0.3,
    minPlateDarkRatio: 0.3,
    minPlateBrightRatio: 0.002
  }
}

function frame({
  caption = false,
  darkPlateOnly = false,
  width: w = width,
  height: h = height
} = {}) {
  const rgb = Buffer.alloc(w * h * 3)
  fillRect(rgb, w, h, 0, 0, w, h, [78, 102, 126])
  if (caption || darkPlateOnly) {
    const plateWidth = Math.round(w * 0.72)
    const plateHeight = Math.max(4, Math.round(h * 0.16))
    const left = Math.round((w - plateWidth) / 2)
    const top = Math.round(h * 0.73)
    fillRect(rgb, w, h, left, top, plateWidth, plateHeight, [5, 5, 6])
    if (caption) {
      const glyphHeight = Math.max(1, Math.round(plateHeight * 0.3))
      const glyphTop = top + Math.max(1, Math.floor((plateHeight - glyphHeight) / 2))
      for (let x = left + 4; x < left + plateWidth - 4; x += Math.max(4, Math.round(w * 0.07))) {
        fillRect(
          rgb,
          w,
          h,
          x,
          glyphTop,
          Math.max(2, Math.round(w * 0.025)),
          glyphHeight,
          [250, 250, 252]
        )
      }
    }
  }
  return rgb
}

function fillRect(rgb, width, height, x, y, rectWidth, rectHeight, color) {
  const left = Math.max(0, Math.round(x))
  const top = Math.max(0, Math.round(y))
  const right = Math.min(width, Math.round(x + rectWidth))
  const bottom = Math.min(height, Math.round(y + rectHeight))
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const offset = (row * width + column) * 3
      rgb[offset] = color[0]
      rgb[offset + 1] = color[1]
      rgb[offset + 2] = color[2]
    }
  }
}
