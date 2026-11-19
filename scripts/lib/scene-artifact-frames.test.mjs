import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeSceneFrames } from './scene-artifact-frames.mjs'
import { ffmpegAvailable } from './ffmpeg-available.mjs'

const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const available = ffmpegAvailable(ffmpegPath) && ffmpegAvailable(ffprobePath)
const fixtureEncoder =
  available &&
  /\bffv1\b/.test(spawnSync(ffmpegPath, ['-encoders'], { encoding: 'utf8' }).stdout ?? '')

test(
  'a timestamp gap does not duplicate pixels or shift the next scene cut',
  {
    skip: !available
      ? 'ffmpeg/ffprobe not installed'
      : !fixtureEncoder
        ? 'ffmpeg lacks the FFV1 fixture encoder'
        : false
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'scene-vfr-'))
    try {
      const file = join(dir, 'gap.mkv')
      // Ten red frames, a one-second timestamp gap, then ten blue frames.
      execFileSync(ffmpegPath, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=red:s=64x36:r=10:d=1',
        '-f',
        'lavfi',
        '-i',
        'color=blue:s=64x36:r=10:d=1',
        '-filter_complex',
        '[0:v][1:v]concat=n=2:v=1:a=0,setpts=PTS+gte(N\\,10)/TB[v]',
        '-map',
        '[v]',
        '-fps_mode',
        'vfr',
        '-c:v',
        'ffv1',
        '-threads',
        '1',
        file
      ])
      const decoded = decodeSceneFrames(file, { width: 64, height: 36, ffmpegPath, ffprobePath })
      assert.equal(decoded.features.length, 20)
      assert.deepEqual(
        decoded.features.map((frame) => frame.centre),
        [...Array(10).fill('red'), ...Array(10).fill('blue')]
      )
      assert.equal(decoded.ptsMs[10], 2000)
      assert.equal(decoded.ptsMs[9], 900)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
