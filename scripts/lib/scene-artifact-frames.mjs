import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { frostFeaturesFromRawFrames } from './smart-scenes-gate.mjs'

/** Decode exactly one sample per encoded frame, including variable-rate takes. */
export function decodeSceneFrames(
  file,
  { ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', width = 320, height = 180 } = {}
) {
  const probe = JSON.parse(
    execFileSync(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time:stream=width,height',
        '-of',
        'json',
        file
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
  )
  const ptsMs = (probe.frames ?? []).map((frame) => Number(frame.best_effort_timestamp_time) * 1000)
  assert.ok(
    ptsMs.length > 0 && ptsMs.every(Number.isFinite),
    'every encoded frame needs a timestamp'
  )
  const raw = execFileSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      `scale=${width}:${height}:flags=area`,
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { maxBuffer: 2 * 1024 * 1024 * 1024 }
  )
  const features = frostFeaturesFromRawFrames(raw, { width, height })
  assert.equal(
    features.length,
    ptsMs.length,
    'decoded frames and encoded timestamps must align one to one'
  )
  return { features, ptsMs, width: probe.streams[0].width, height: probe.streams[0].height }
}
