// Tests for the startup-resolution analyzer.
//
// Run: node --test scripts/lib/startup-resolution-analyzer.test.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  DEFAULT_STARTUP_GATES,
  analyzeStartupResolution,
  evaluateStartupGates,
  normalizeStartupFrames,
  parseBlackframe,
  parseCropdetect,
  renderStartupMarkdownReport,
  startupReportBaseName,
  summarizeDimensionRuns,
} from './startup-resolution-analyzer.mjs'
import { ffmpegAvailable } from './ffmpeg-available.mjs'

const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'

describe('startupReportBaseName', () => {
  it('extracts a report stem from an absolute Windows path on every host', () => {
    assert.equal(
      startupReportBaseName(
        String.raw`D:\a\_temp\videorc-windows-preview-recording-smoke\videorc-session-20260711-230120.mp4`
      ),
      'videorc-session-20260711-230120'
    )
  })
})

describe('parseBlackframe', () => {
  it('parses frame number, pblack and timestamp', () => {
    const stderr = '[Parsed_blackframe_0 @ 0x1] frame:7 pblack:99 pts:3584 t:0.233333 type:P last_keyframe:0'
    assert.deepEqual(parseBlackframe(stderr), [{ frame: 7, pblack: 99, time: 0.233333 }])
  })
})

describe('parseCropdetect', () => {
  it('parses cropdetect output', () => {
    const stderr = '[Parsed_cropdetect_0 @ 0x1] x1:0 x2:319 y1:30 y2:209 w:320 h:180 x:0 y:30 pts:0 t:0.000000 crop=320:180:0:30'
    assert.deepEqual(parseCropdetect(stderr), [{ width: 320, height: 180, x: 0, y: 30 }])
  })
})

describe('normalizeStartupFrames', () => {
  it('normalizes ffprobe frame JSON and applies fallback dimensions', () => {
    const frames = normalizeStartupFrames(
      {
        frames: [
          { best_effort_timestamp_time: '0.000000', width: 1920, height: 1080, pict_type: 'I' },
          { best_effort_timestamp_time: '0.033333', pict_type: 'P' },
        ],
      },
      { width: 1920, height: 1080 }
    )

    assert.deepEqual(frames, [
      { index: 0, time: 0, width: 1920, height: 1080, pictType: 'I' },
      { index: 1, time: 0.033333, width: 1920, height: 1080, pictType: 'P' },
    ])
  })
})

describe('summarizeDimensionRuns', () => {
  it('groups contiguous startup frames by decoded dimensions', () => {
    const runs = summarizeDimensionRuns([
      { index: 0, time: 0, width: 1920, height: 1080 },
      { index: 1, time: 0.033333, width: 1920, height: 1080 },
      { index: 2, time: 0.066667, width: 640, height: 360 },
      { index: 3, time: 0.1, width: 1920, height: 1080 },
    ])

    assert.deepEqual(runs, [
      {
        startIndex: 0,
        endIndex: 1,
        startTime: 0,
        endTime: 0.033333,
        width: 1920,
        height: 1080,
        count: 2,
      },
      {
        startIndex: 2,
        endIndex: 2,
        startTime: 0.066667,
        endTime: 0.066667,
        width: 640,
        height: 360,
        count: 1,
      },
      {
        startIndex: 3,
        endIndex: 3,
        startTime: 0.1,
        endTime: 0.1,
        width: 1920,
        height: 1080,
        count: 1,
      },
    ])
  })
})

describe('evaluateStartupGates', () => {
  const clean = {
    hasVideo: true,
    expectedWidth: 1920,
    expectedHeight: 1080,
    metadataWidth: 1920,
    metadataHeight: 1080,
    expectedStartupFrames: 60,
    startupFrameCount: 60,
    dimensionMismatchCount: 0,
    maxRepeatedFrameRun: 1,
    previewSizedFrameCount: 0,
    blackFrameCount: 0,
    letterboxCandidateCount: 0,
    syntheticEvidence: 0,
  }

  it('passes a clean startup metrics set', () => {
    const verdict = evaluateStartupGates(clean)
    assert.equal(verdict.pass, true)
    assert.deepEqual(verdict.failures, [])
  })

  it('fails wrong metadata dimensions', () => {
    const verdict = evaluateStartupGates({ ...clean, metadataWidth: 640 })
    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join(' '), /metadata width 640/)
  })

  it('fails excessive exact repeats in the startup window', () => {
    const verdict = evaluateStartupGates({ ...clean, maxRepeatedFrameRun: 12 })
    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join(' '), /startup repeated-frame burst/)
  })

  it('warns on exact repeats when visible motion is not required', () => {
    const verdict = evaluateStartupGates(
      { ...clean, maxRepeatedFrameRun: 12 },
      { ...DEFAULT_STARTUP_GATES, requireMotion: false }
    )
    assert.equal(verdict.pass, true)
    assert.deepEqual(verdict.failures, [])
    assert.match(verdict.warnings.join(' '), /motion not required/)
  })

  it('warns when synthetic evidence is not available from diagnostics', () => {
    const verdict = evaluateStartupGates({ ...clean, syntheticEvidence: null })
    assert.equal(verdict.pass, true)
    assert.match(verdict.warnings.join(' '), /synthetic-frame detection/)
  })
})

function generate(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpegPath, ['-y', '-loglevel', 'error', ...args])
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => {
      stderr += text
    })
    child.on('error', rejectRun)
    child.on('close', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(stderr.trim()))))
  })
}

describe('analyzeStartupResolution (integration)', { skip: ffmpegAvailable(ffmpegPath) ? false : 'ffmpeg not installed' }, () => {
  let dir
  let clean
  let staticFile
  let previewSized

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vrc-startup-analyzer-'))
    clean = join(dir, 'clean.mp4')
    staticFile = join(dir, 'static.mp4')
    previewSized = join(dir, 'preview-sized.mp4')

    await generate([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
      '-t', '3', '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      clean,
    ])
    await generate([
      '-f', 'lavfi', '-i', 'color=c=blue:size=320x240:rate=30',
      '-t', '3', '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      staticFile,
    ])
    await generate([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-t', '3', '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      previewSized,
    ])
  })

  after(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('passes a clean moving startup at the expected resolution', async () => {
    const report = await analyzeStartupResolution(clean, {
      ffmpegPath,
      ffprobePath,
      expectedWidth: 320,
      expectedHeight: 240,
      intendedFps: 30,
      syntheticEvidence: 0,
    })
    assert.equal(report.verdict.pass, true, `unexpected failures: ${report.verdict.failures.join('; ')}`)
    assert.equal(report.metrics.startupFrameCount, 60)
    assert.equal(report.metrics.hashCount, 60)
    assert.equal(report.metrics.startupFrameManifest.length, 60)
    assert.deepEqual(report.metrics.startupFrameManifest[0], report.metrics.firstStartupFrame)
    assert.deepEqual(report.metrics.dimensionRuns, [
      {
        startIndex: 0,
        endIndex: 59,
        startTime: 0,
        endTime: 1.966667,
        width: 320,
        height: 240,
        count: 60,
      },
    ])
    assert.equal(report.metrics.firstStartupFrame.width, 320)
    assert.equal(report.metrics.firstStartupFrame.height, 240)
    assert.equal(typeof report.metrics.firstStartupFrame.hash, 'string')
    const markdown = renderStartupMarkdownReport(report)
    assert.match(markdown, /## Startup frame manifest/)
    assert.match(markdown, /\| Frame \| Time \| Size \| Type \| Hash \|/)
    assert.match(markdown, /\| 59 \| 1\.967s \| 320x240 \|/)
  })

  it('fails a startup with excessive exact repeated frames', async () => {
    const report = await analyzeStartupResolution(staticFile, {
      ffmpegPath,
      ffprobePath,
      expectedWidth: 320,
      expectedHeight: 240,
      intendedFps: 30,
      syntheticEvidence: 0,
    })
    assert.equal(report.verdict.pass, false)
    assert.ok(report.metrics.maxRepeatedFrameRun > 2, `run ${report.metrics.maxRepeatedFrameRun}`)
    assert.match(report.verdict.failures.join(' '), /startup repeated-frame burst/)
  })

  it('fails when preview-sized output appears where 1080p was expected', async () => {
    const report = await analyzeStartupResolution(previewSized, {
      ffmpegPath,
      ffprobePath,
      expectedWidth: 1920,
      expectedHeight: 1080,
      intendedFps: 30,
      previewWidth: 640,
      previewHeight: 360,
      syntheticEvidence: 0,
    })
    assert.equal(report.verdict.pass, false)
    assert.equal(report.metrics.previewSizedFrameCount, 60)
    assert.equal(report.metrics.previewSizedFrameSamples.length, 10)
    assert.match(report.verdict.failures.join(' '), /metadata width 640/)
    assert.match(report.verdict.failures.join(' '), /preview size 640x360/)
  })
})
