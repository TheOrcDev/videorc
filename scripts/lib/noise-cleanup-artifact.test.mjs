import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { ffmpegAvailable } from './ffmpeg-available.mjs'
import {
  NOISE_CLEANUP_CANDIDATES,
  NOISE_CLEANUP_FILTER,
  noiseCleanupArgs,
  parseMeanVolume,
  parseStreamHash,
  runNoiseCleanupArtifactSmoke,
  signalToNoiseRatioDb
} from './noise-cleanup-artifact.mjs'

const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'

describe('noise cleanup artifact helpers', () => {
  it('locks the conservative model-free speech-v1 filter and safe command shape', () => {
    assert.equal(NOISE_CLEANUP_FILTER, 'afftdn=nr=18:nf=-34:tn=1')
    const backendSource = readFileSync(
      new URL('../../crates/videorc-backend/src/noise_cleanup.rs', import.meta.url),
      'utf8'
    )
    assert.match(backendSource, /SPEECH_V1_FILTER: &str = "afftdn=nr=18:nf=-34:tn=1"/)
    const args = noiseCleanupArgs('/recordings/source.mp4', '/recordings/clean.mp4')
    assert.ok(args.includes('-nostdin'))
    assert.ok(args.includes('-n'))
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0'])
    assert.ok(args.includes('-map_metadata'))
    assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'copy'])
    assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'aac'])
    assert.ok(args.includes('-progress'))
    const mkvArgs = noiseCleanupArgs('/recordings/source.mkv', '/recordings/clean.mkv')
    assert.deepEqual(mkvArgs.slice(mkvArgs.indexOf('-c:a'), mkvArgs.indexOf('-c:a') + 2), [
      '-c:a',
      'pcm_s16le'
    ])
    assert.ok(!mkvArgs.includes('192k'))
  })

  it('parses objective noise and stream-copy evidence', () => {
    assert.equal(parseMeanVolume('mean_volume: -42.9 dB'), -42.9)
    assert.equal(parseStreamHash(`SHA256=${'a'.repeat(64)}\n`), 'a'.repeat(64))
    assert.throws(() => parseMeanVolume('no measurement'), /mean_volume/)
    assert.throws(() => parseStreamHash('no hash'), /SHA256/)
    assert.equal(
      signalToNoiseRatioDb(new Float32Array([1, -1]), new Float32Array([1, -1])),
      Infinity
    )
    assert.ok(signalToNoiseRatioDb(new Float32Array([1, -1]), new Float32Array([1.1, -0.9])) > 19)
  })
})

describe(
  'speech-v1 artifact smoke',
  { skip: ffmpegAvailable(ffmpegPath) ? false : 'ffmpeg not installed' },
  () => {
    let outputDir
    let results

    before(async () => {
      outputDir = mkdtempSync(join(tmpdir(), 'videorc-noise-cleanup-'))
      results = await Promise.all(
        ['mp4', 'mkv'].map((container) =>
          runNoiseCleanupArtifactSmoke({
            ffmpegPath,
            ffprobePath,
            sourcePath: join(outputDir, `source.${container}`),
            outputPath: join(outputDir, `source-noise-cleaned.${container}`)
          })
        )
      )
    })

    after(() => {
      if (outputDir && existsSync(outputDir)) {
        rmSync(outputDir, { recursive: true, force: true })
      }
    })

    it('reduces stationary noise without damaging the voice band', () => {
      for (const result of results) {
        assert.ok(result.noiseReductionDb >= 3, JSON.stringify(result))
        assert.ok(result.snrImprovementDb >= 2, JSON.stringify(result))
        assert.ok(result.voiceLevelDeltaDb <= 1, JSON.stringify(result))
      }
    })

    it('keeps the original untouched and stream-copies video with A/V duration parity', () => {
      for (const result of results) {
        assert.equal(result.sourceFileUnchanged, true)
        assert.equal(result.videoStreamCopied, true)
        assert.ok(result.durationDeltaMs <= 50, JSON.stringify(result))
      }
    })

    it('locks speech-v1 after comparing conservative, selected, and stronger candidates', async () => {
      const sourcePath = join(outputDir, 'candidate-source.mkv')
      const candidates = []
      for (const candidate of NOISE_CLEANUP_CANDIDATES) {
        candidates.push({
          ...candidate,
          result: await runNoiseCleanupArtifactSmoke({
            ffmpegPath,
            ffprobePath,
            sourcePath,
            outputPath: join(outputDir, `candidate-${candidate.name}.mkv`),
            filter: candidate.filter
          })
        })
        rmSync(sourcePath, { force: true })
      }
      const selected = candidates.find((candidate) => candidate.name === 'speech-v1')
      assert.ok(selected)
      assert.ok(selected.result.snrImprovementDb >= 2, JSON.stringify(candidates))
      assert.ok(selected.result.voiceLevelDeltaDb <= 1, JSON.stringify(candidates))
      assert.ok(
        selected.result.noiseReductionDb > candidates[0].result.noiseReductionDb,
        JSON.stringify(candidates)
      )
      assert.ok(
        selected.result.voiceLevelDeltaDb <= candidates[2].result.voiceLevelDeltaDb,
        JSON.stringify(candidates)
      )
    })
  }
)
