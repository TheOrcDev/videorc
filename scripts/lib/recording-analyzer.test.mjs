// Self-test for the honest final-file analyzer.
//
// Two layers:
//   1. Unit tests over the pure parsers/evaluators — fast, deterministic, no ffmpeg.
//   2. Integration tests that generate synthetic fixtures with KNOWN ground-truth
//      defects and assert the analyzer catches the bad ones and passes the clean one.
//      This is the honest TDD bar: the analyzer must fail known-bad and pass known-good.
//
// Run: node --test scripts/lib/recording-analyzer.test.mjs
//
// Empirically verified fixture behaviour (ffmpeg 8.1.1):
//   - midfreeze: 1s moving + 0.5s still + 1s moving -> freezedetect 0.5s freeze,
//     framemd5 max identical run 7 (fails freeze AND repeated-frame gates).
//   - silence: sine with a 0.4s muted window -> silencedetect 0.4s (warning, not fail).
//   - clean: moving testsrc2 + sine, CFR 30, 3s -> no freeze, max run 1, 90 frames (PASS).
//   - audio PTS gaps: NOT testable via a real file — the AAC encoder + mp4 muxer fill
//     dropped-sample gaps with continuous timestamps, so capture-side gaps are masked in
//     the final artifact. Covered here by a unit test over audioPtsGaps() instead.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  duplicatePtsStats,
  DEFAULT_GATES,
  analyzeRecording,
  audioPtsGaps,
  avSkewComponents,
  avSkewMs,
  evaluateGates,
  maxConsecutiveRun,
  maxKeyframeInterval,
  normalizeProbe,
  pacingStats,
  requiredH264Level,
  parseCsvFloatColumn,
  parseFramemd5,
  parseFreezedetect,
  parseSilencedetect,
  renderMarkdownReport
} from './recording-analyzer.mjs'
import { ffmpegAvailable } from './ffmpeg-available.mjs'

const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'

// ---------------------------------------------------------------------------
// Unit tests — pure parsers/evaluators
// ---------------------------------------------------------------------------

describe('parseFreezedetect', () => {
  it('pairs freeze_start with the following freeze_duration', () => {
    const stderr = [
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 1',
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_duration: 0.5',
      '[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_end: 1.5'
    ].join('\n')
    assert.deepEqual(parseFreezedetect(stderr), [{ start: 1, duration: 0.5 }])
  })

  it('returns empty when there is no freeze', () => {
    assert.deepEqual(parseFreezedetect('frame= 90 fps=30\n'), [])
  })
})

describe('parseSilencedetect', () => {
  it('parses the "silence_end | silence_duration" combined line', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 1.002896',
      '[silencedetect @ 0x1] silence_end: 1.408 | silence_duration: 0.405104'
    ].join('\n')
    const segments = parseSilencedetect(stderr)
    assert.equal(segments.length, 1)
    assert.equal(segments[0].start, 1.002896)
    assert.equal(segments[0].end, 1.408)
    assert.ok(Math.abs(segments[0].duration - 0.405104) < 1e-6)
  })
})

describe('parseFramemd5', () => {
  it('extracts the trailing hash from each data line, skipping comments', () => {
    const stdout = [
      '#format: frame checksums',
      '#stream#, dts, pts, duration, size, hash',
      '0, 0, 0, 1, 27648, aaa',
      '0, 1, 1, 1, 27648, aaa',
      '0, 2, 2, 1, 27648, bbb'
    ].join('\n')
    assert.deepEqual(parseFramemd5(stdout), ['aaa', 'aaa', 'bbb'])
  })
})

describe('maxConsecutiveRun', () => {
  it('finds the longest identical run and bursts over threshold', () => {
    const { maxRun, bursts } = maxConsecutiveRun(['a', 'a', 'a', 'b', 'c', 'c'], 2)
    assert.equal(maxRun, 3)
    assert.deepEqual(bursts, [{ startIndex: 0, run: 3 }])
  })

  it('reports no burst when every frame is unique', () => {
    const { maxRun, bursts } = maxConsecutiveRun(['a', 'b', 'c'], 2)
    assert.equal(maxRun, 1)
    assert.deepEqual(bursts, [])
  })

  it('handles the empty case', () => {
    assert.deepEqual(maxConsecutiveRun([], 2), { maxRun: 0, bursts: [] })
  })
})

describe('parseCsvFloatColumn', () => {
  it('parses a single float column and skips N/A', () => {
    assert.deepEqual(parseCsvFloatColumn('0.0\n0.033\nN/A\n0.066\n'), [0.0, 0.033, 0.066])
  })
})

// Plan 023: the owner's split-output recording had 353 frames on identical
// stamps in ~7-frame bursts separated by 0.73s gaps — the wallclock-stamped
// Annex-B path. This metric is the sharp regression signal.
describe('duplicatePtsStats', () => {
  it('reports zero for healthy monotonically spaced stamps', () => {
    const pts = Array.from({ length: 90 }, (_, i) => i / 30)
    assert.deepEqual(duplicatePtsStats(pts), { duplicateCount: 0, maxDuplicateRun: 1 })
  })

  it('counts burst-stamped frames like the owner incident file', () => {
    const pts = []
    let t = 0
    for (let burst = 0; burst < 10; burst += 1) {
      for (let i = 0; i < 7; i += 1) pts.push(t) // 7 frames, one stamp
      t += 0.73
    }
    const stats = duplicatePtsStats(pts)
    assert.equal(stats.duplicateCount, 60)
    assert.equal(stats.maxDuplicateRun, 7)
  })

  it('tolerates sub-millisecond jitter as duplicates but not real intervals', () => {
    const stats = duplicatePtsStats([0, 0.0005, 0.034, 0.067])
    assert.equal(stats.duplicateCount, 1)
    assert.equal(stats.maxDuplicateRun, 2)
  })
})

describe('pacingStats', () => {
  it('computes mean interval, max gap and observed fps for CFR input', () => {
    const pts = [0, 1 / 30, 2 / 30, 3 / 30, 4 / 30]
    const stats = pacingStats(pts)
    assert.equal(stats.count, 5)
    assert.ok(Math.abs(stats.meanIntervalMs - 1000 / 30) < 1e-6)
    assert.ok(stats.jitterMs < 1e-6)
    assert.ok(Math.abs(stats.observedFps - 30) < 1e-3)
  })

  it('surfaces a large inter-frame gap', () => {
    const stats = pacingStats([0, 0.033, 0.5, 0.533])
    assert.ok(stats.maxGapMs > 400)
  })
})

describe('audioPtsGaps', () => {
  it('detects a packet PTS gap beyond the previous packet duration', () => {
    const packets = [
      { ptsTime: 0.0, durationTime: 0.021 },
      { ptsTime: 0.021, durationTime: 0.021 },
      { ptsTime: 0.3, durationTime: 0.021 }, // ~258ms jump after a 21ms packet
      { ptsTime: 0.321, durationTime: 0.021 }
    ]
    const { maxGapMs, gaps } = audioPtsGaps(packets)
    assert.equal(gaps.length, 1)
    assert.ok(maxGapMs > 250)
  })

  it('reports no gap for continuous audio', () => {
    const packets = Array.from({ length: 10 }, (_, i) => ({
      ptsTime: i * 0.021,
      durationTime: 0.021
    }))
    assert.deepEqual(audioPtsGaps(packets).gaps, [])
  })
})

describe('avSkewMs', () => {
  it('reports the start-time offset', () => {
    const probe = {
      video: { startTime: 0.0, duration: 3 },
      audio: [{ startTime: 0.12, duration: 3 }]
    }
    assert.ok(Math.abs(avSkewMs(probe) - 120) < 1e-6)
  })

  it('does not classify an audio-only muxer tail as content skew', () => {
    const probe = { video: { duration: 3.0 }, audio: [{ duration: 3.2 }] }
    assert.equal(avSkewMs(probe), 0)
  })

  it('catches a constant audio delay (equal start_times, shorter audio)', () => {
    // The real-recording case: both streams start at 0 but audio is 391ms shorter.
    const probe = {
      video: { startTime: 0, duration: 14.3 },
      audio: [{ startTime: 0, duration: 13.909 }]
    }
    assert.ok(Math.abs(avSkewMs(probe) - 391) < 0.5, `got ${avSkewMs(probe)}`)
  })
})

describe('normalizeProbe', () => {
  it('normalizes ffprobe json into a compact probe', () => {
    const json = JSON.stringify({
      format: { duration: '3.0', tags: { encoder: 'Lavf' } },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30/1',
          r_frame_rate: '30/1',
          nb_frames: '90',
          duration: '3.0',
          start_time: '0.0',
          pix_fmt: 'yuv420p'
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          channels: 2,
          sample_rate: '48000',
          duration: '3.0',
          start_time: '0.0'
        }
      ]
    })
    const probe = normalizeProbe(json)
    assert.equal(probe.video.codec, 'h264')
    assert.equal(probe.video.avgFps, 30)
    assert.equal(probe.video.nbFrames, 90)
    assert.equal(probe.audio.length, 1)
    assert.equal(probe.audio[0].sampleRate, 48000)
  })
})

describe('evaluateGates', () => {
  const clean = {
    hasVideo: true,
    hasAudio: true,
    expectAudio: true,
    longestFreezeMs: 0,
    freezeCount: 0,
    maxRepeatedFrameRun: 1,
    repeatedBurstCount: 0,
    expectedFrames: 90,
    observedFrames: 90,
    maxAudioGapMs: 0,
    longestSilenceMs: 0,
    silenceCount: 0,
    avSkewMs: 10,
    durationSeconds: 3,
    frameDerivedDurationSeconds: 3,
    durationStretchRatio: 1,
    // The recording colorimetry law (Q1): a clean artifact is TAGGED BT.709
    // video-range; untagged now warns (or fails under requireColorTags).
    colorSpace: 'bt709',
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    colorRange: 'tv'
  }

  it('passes a clean metrics set', () => {
    const v = evaluateGates(clean)
    assert.equal(v.pass, true)
    assert.deepEqual(v.failures, [])
  })

  it('fails a freeze over 100ms', () => {
    const v = evaluateGates({ ...clean, longestFreezeMs: 250, freezeCount: 1 })
    assert.equal(v.pass, false)
    assert.match(v.failures[0], /freeze segment 250ms/)
  })

  it('warns on freeze segments when visible motion is not required', () => {
    const v = evaluateGates(
      { ...clean, longestFreezeMs: 250, freezeCount: 1 },
      { ...DEFAULT_GATES, requireMotion: false }
    )
    assert.equal(v.pass, true)
    assert.deepEqual(v.failures, [])
    assert.match(v.warnings[0], /motion not required/)
  })

  it('fails a repeated-frame burst over 2', () => {
    const v = evaluateGates({ ...clean, maxRepeatedFrameRun: 7, repeatedBurstCount: 1 })
    assert.equal(v.pass, false)
    assert.match(v.failures[0], /repeated-frame burst of 7/)
  })

  it('gates on corroborated freezes when corroboration metrics are present', () => {
    const v = evaluateGates({
      ...clean,
      longestFreezeMs: 900,
      freezeCount: 3,
      corroboratedFreezeCount: 1,
      longestCorroboratedFreezeMs: 400,
      similarityOnlyFreezeCount: 2,
      longestSimilarityOnlyFreezeMs: 900
    })
    assert.equal(v.pass, false)
    assert.match(v.failures[0], /freeze segment 400ms .*exact-repeat corroborated/)
  })

  it('passes with warnings when every freeze is similarity-only (still subject)', () => {
    // The 2026-07 incident shape: a technically perfect 23.976p file, 465
    // freezedetect hits, zero exact frame repeats.
    const v = evaluateGates({
      ...clean,
      longestFreezeMs: 2085,
      freezeCount: 465,
      corroboratedFreezeCount: 0,
      longestCorroboratedFreezeMs: 0,
      similarityOnlyFreezeCount: 465,
      longestSimilarityOnlyFreezeMs: 2085
    })
    assert.equal(v.pass, true)
    assert.match(v.warnings[0], /similarity-only .* not a pipeline freeze/)
  })

  it('keeps the raw freezedetect gate when freezeRequireCorroboration is false', () => {
    const v = evaluateGates(
      {
        ...clean,
        longestFreezeMs: 2085,
        freezeCount: 465,
        corroboratedFreezeCount: 0,
        longestCorroboratedFreezeMs: 0,
        similarityOnlyFreezeCount: 465,
        longestSimilarityOnlyFreezeMs: 2085
      },
      { ...DEFAULT_GATES, freezeRequireCorroboration: false }
    )
    assert.equal(v.pass, false)
    assert.match(v.failures[0], /freeze segment 2085ms/)
  })

  it('fails a container cadence mismatch with an actionable message', () => {
    const v = evaluateGates({
      ...clean,
      cadenceFps: 24000 / 1001,
      cadenceLabel: '23.976p (NTSC film)',
      cadenceIntendedFps: 30,
      cadenceMismatchPct: 20.1
    })
    assert.equal(v.pass, false)
    assert.ok(
      v.failures.some((f) => /container cadence 23\.976fps/.test(f) && /camera HDMI/.test(f)),
      `failures: ${v.failures.join('; ')}`
    )
  })

  it('warns on repeated-frame bursts when visible motion is not required', () => {
    const v = evaluateGates(
      { ...clean, maxRepeatedFrameRun: 7, repeatedBurstCount: 1 },
      { ...DEFAULT_GATES, requireMotion: false }
    )
    assert.equal(v.pass, true)
    assert.deepEqual(v.failures, [])
    assert.match(v.warnings.join(' '), /motion not required/)
  })

  it('fails dropped-frame evidence beyond tolerance', () => {
    const v = evaluateGates({ ...clean, observedFrames: 70, expectedFrames: 90 })
    assert.equal(v.pass, false)
    assert.match(v.failures[0], /frame count 70 vs expected ~90/)
  })

  it('fails timestamp stretch when container duration outruns decoded frames', () => {
    const observedFrames = 205
    const frameDerivedDurationSeconds = observedFrames / 30
    const v = evaluateGates({
      ...clean,
      observedFrames,
      expectedFrames: 1166,
      durationSeconds: 38.8,
      frameDerivedDurationSeconds,
      durationStretchRatio: 38.8 / frameDerivedDurationSeconds
    })
    assert.equal(v.pass, false)
    assert.ok(v.failures.some((failure) => /timestamp\/duration stretch/.test(failure)))
  })

  it('hard-fails A/V skew over 150ms but only warns between 100 and 150', () => {
    assert.equal(evaluateGates({ ...clean, avSkewMs: 200 }).pass, false)
    const warn = evaluateGates({ ...clean, avSkewMs: 120 })
    assert.equal(warn.pass, true)
    assert.equal(warn.warnings.length, 1)
  })

  it('fails a real audio PTS gap over 20ms', () => {
    const v = evaluateGates({ ...clean, maxAudioGapMs: 80, audioGapCount: 1 })
    assert.equal(v.pass, false)
    assert.match(v.failures[0], /audio PTS gap 80ms/)
  })

  it('warns (does not fail) on a silence segment', () => {
    const v = evaluateGates({ ...clean, longestSilenceMs: 400, silenceCount: 1 })
    assert.equal(v.pass, true)
    assert.equal(v.warnings.length, 1)
  })

  it('warns on missing color tags by default and fails under requireColorTags', () => {
    const untagged = { ...clean, colorSpace: null, colorPrimaries: null, colorTransfer: null, colorRange: null }
    const soft = evaluateGates(untagged)
    assert.equal(soft.pass, true)
    assert.ok(soft.warnings.some((warning) => /colorimetry not tagged/.test(warning)))
    const hard = evaluateGates(untagged, { ...DEFAULT_GATES, requireColorTags: true })
    assert.equal(hard.pass, false)
    assert.ok(hard.failures.some((failure) => /colorimetry not tagged/.test(failure)))
  })

  it('flags an under-spec H.264 level (the audit-shipped 1080p60@L4.0 defect)', () => {
    const underLeveled = {
      ...clean,
      width: 1920,
      height: 1080,
      intendedFps: 60,
      level: 40
    }
    const soft = evaluateGates(underLeveled)
    assert.equal(soft.pass, true)
    assert.ok(soft.warnings.some((warning) => /level 4\.0 below spec minimum 4\.2/.test(warning)))
    const hard = evaluateGates(underLeveled, { ...DEFAULT_GATES, requireValidLevel: true })
    assert.equal(hard.pass, false)
  })

  it('fails an unbounded A/V stop tail only when the gate is armed', () => {
    const tailed = { ...clean, tailMismatchMs: 273 }
    assert.equal(evaluateGates(tailed).pass, true)
    const gated = evaluateGates(tailed, { ...DEFAULT_GATES, maxTailMismatchMs: 100 })
    assert.equal(gated.pass, false)
    assert.ok(gated.failures.some((failure) => /tail mismatch 273ms/.test(failure)))
  })

  it('fails a broken keyframe cadence when the gate is armed', () => {
    const sparse = { ...clean, keyframeCount: 2, maxKeyframeIntervalSeconds: 5.2 }
    assert.equal(evaluateGates(sparse).pass, true)
    const gated = evaluateGates(sparse, { ...DEFAULT_GATES, keyframeMaxIntervalSeconds: 2.5 })
    assert.equal(gated.pass, false)
  })

  it('requiredH264Level matches the shipping recording matrix', () => {
    // Mirrors crates/videorc-backend/src/h264_profile.rs test vectors.
    assert.equal(requiredH264Level(1920, 1080, 30), 40)
    assert.equal(requiredH264Level(1920, 1080, 60), 42)
    assert.equal(requiredH264Level(2560, 1440, 60), 51)
    assert.equal(requiredH264Level(3840, 2160, 30), 51)
    assert.equal(requiredH264Level(3840, 2160, 60), 52)
    assert.equal(requiredH264Level(3840, 2160, 120), null)
  })

  it('avSkewComponents separates start skew from stop-tail mismatch', () => {
    const { startSkewMs, tailMismatchMs } = avSkewComponents({
      video: { startTime: 0, duration: 6.516 },
      audio: [{ startTime: 0, duration: 6.336 }]
    })
    assert.equal(startSkewMs, 0)
    assert.ok(Math.abs(tailMismatchMs - 180) < 0.001)
  })

  it('maxKeyframeInterval reports the widest gap', () => {
    assert.equal(maxKeyframeInterval([0, 2, 4.5, 6]), 2.5)
    assert.equal(maxKeyframeInterval([0]), null)
  })

  it('fails when audio is expected but missing', () => {
    const v = evaluateGates({ ...clean, hasAudio: false, expectAudio: true })
    assert.equal(v.pass, false)
    assert.match(v.failures.join(' '), /audio expected/)
  })
})

describe('renderMarkdownReport', () => {
  it('prints raw finding locations for repeated bursts and freezes', () => {
    const markdown = renderMarkdownReport({
      file: '/tmp/example.mp4',
      analyzedAtIso: '2026-06-06T00:00:00.000Z',
      verdict: { pass: false, failures: ['repeated-frame burst'], warnings: [] },
      metrics: {
        codec: 'h264',
        width: 1920,
        height: 1080,
        pixFmt: 'yuv420p',
        encoderTag: 'test',
        fileBytes: 1024,
        durationSeconds: 15,
        intendedFps: 30,
        avgFps: 30,
        nominalFps: 30,
        observedFps: 30,
        observedFrames: 450,
        expectedFrames: 450,
        frameDerivedDurationSeconds: 15,
        durationStretchRatio: 1,
        meanIntervalMs: 33.3,
        maxFrameGapMs: 34,
        frameJitterMs: 0.5,
        longestFreezeMs: 100,
        freezeCount: 1,
        maxRepeatedFrameRun: 3,
        repeatedBurstCount: 1,
        hasAudio: true,
        maxAudioGapMs: 0,
        audioGapCount: 0,
        longestSilenceMs: 0,
        silenceCount: 0,
        avSkewMs: 8
      },
      findings: {
        freezes: [{ start: 14, duration: 0.1 }],
        repeatedBursts: [{ startIndex: 420, run: 3 }],
        audioGaps: [],
        silences: []
      }
    })

    assert.match(markdown, /## Findings/)
    assert.match(markdown, /Freeze segments: 14\.000s for 100\.0ms/)
    assert.match(markdown, /Repeated-frame bursts: frame 420 \(about 14\.000s\), run 3/)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — real fixtures with known defects
// ---------------------------------------------------------------------------

function generate(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpegPath, ['-y', '-loglevel', 'error', ...args])
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (t) => {
      stderr += t
    })
    child.on('error', rejectRun)
    child.on('close', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(stderr.trim()))))
  })
}

describe(
  'analyzeRecording (integration)',
  { skip: ffmpegAvailable(ffmpegPath) ? false : 'ffmpeg not installed' },
  () => {
    let dir
    let clean
    let midfreeze
    let silence
    let screenonly

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'vrc-analyzer-'))
      clean = join(dir, 'clean.mp4')
      midfreeze = join(dir, 'midfreeze.mp4')
      silence = join(dir, 'silence.mp4')
      screenonly = join(dir, 'screenonly.mp4')

      await generate([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '3',
        '-fps_mode',
        'cfr',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        clean
      ])
      await generate([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:size=320x240:rate=30',
        '-filter_complex',
        '[0:v]split=2[m1][m2];[m1]trim=0:1,setpts=PTS-STARTPTS[a];[1:v]trim=0:0.5,setpts=PTS-STARTPTS[b];[m2]trim=1:2,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0,fps=30[v]',
        '-map',
        '[v]',
        '-fps_mode',
        'cfr',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        midfreeze
      ])
      await generate([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '3',
        '-af',
        "volume=enable='between(t,1,1.4)':volume=0",
        '-fps_mode',
        'cfr',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        silence
      ])
      await generate([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30',
        '-t',
        '3',
        '-fps_mode',
        'cfr',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        screenonly
      ])
    })

    after(() => {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    })

    it('PASSES a clean CFR recording', async () => {
      const report = await analyzeRecording(clean, { ffmpegPath, ffprobePath, intendedFps: 30 })
      assert.equal(
        report.verdict.pass,
        true,
        `unexpected failures: ${report.verdict.failures.join('; ')}`
      )
      assert.equal(report.metrics.maxRepeatedFrameRun, 1)
      assert.equal(report.metrics.freezeCount, 0)
    })

    it('FAILS a recording with a mid-stream freeze (freeze + repeated-frame gates)', async () => {
      const report = await analyzeRecording(midfreeze, { ffmpegPath, ffprobePath, intendedFps: 30 })
      assert.equal(report.verdict.pass, false)
      assert.ok(report.metrics.longestFreezeMs > 100, `freeze ${report.metrics.longestFreezeMs}ms`)
      assert.ok(report.metrics.maxRepeatedFrameRun > 2, `run ${report.metrics.maxRepeatedFrameRun}`)
      assert.ok(report.verdict.failures.some((f) => /freeze segment/.test(f)))
      assert.ok(report.verdict.failures.some((f) => /repeated-frame burst/.test(f)))
    })

    it('PASSES video but WARNS on an audible silence segment', async () => {
      const report = await analyzeRecording(silence, { ffmpegPath, ffprobePath, intendedFps: 30 })
      assert.equal(
        report.verdict.pass,
        true,
        `unexpected failures: ${report.verdict.failures.join('; ')}`
      )
      assert.ok(
        report.metrics.longestSilenceMs > 100,
        `silence ${report.metrics.longestSilenceMs}ms`
      )
      assert.ok(report.verdict.warnings.some((w) => /silence segment/.test(w)))
    })

    it('PASSES a screen-only recording when audio is not expected', async () => {
      const report = await analyzeRecording(screenonly, {
        ffmpegPath,
        ffprobePath,
        intendedFps: 30,
        expectAudio: false
      })
      assert.equal(
        report.verdict.pass,
        true,
        `unexpected failures: ${report.verdict.failures.join('; ')}`
      )
      assert.equal(report.metrics.hasAudio, false)
    })

    it('FAILS a screen-only recording when audio IS expected', async () => {
      const report = await analyzeRecording(screenonly, {
        ffmpegPath,
        ffprobePath,
        intendedFps: 30,
        expectAudio: true
      })
      assert.equal(report.verdict.pass, false)
      assert.ok(report.verdict.failures.some((f) => /audio expected/.test(f)))
    })
  }
)
