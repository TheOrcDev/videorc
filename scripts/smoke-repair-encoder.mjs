// Smoke: the BUNDLED ffmpeg must be able to run a real transcode-style repair.
//
// The post-recording quality gate re-encodes VFR/dropped-frame recordings. It
// once hardcoded GPL libx264 (absent from every LGPL bundle), so shipped
// builds failed with "Unrecognized option 'crf'" while dev PATH ffmpeg hid the
// bug. This smoke deliberately never touches PATH ffmpeg: it probes the
// bundled binary for the backend's repair encoder, then runs the exact
// CFR-transcode command shape build_repair_args (repair.rs) emits on a small
// generated fixture and verifies the output with the bundled ffprobe.
//
// Override the binary under test with VIDEORC_SMOKE_FFMPEG (e.g. to point at
// an extracted packaged app's Resources).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REPAIR_ENCODER_PREFERENCE,
  parseEncoderNames,
  repairEncoderArgs,
  selectRepairEncoder
} from './lib/repair-encoder-capabilities.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`smoke-repair-encoder: ${message}`)
  process.exit(1)
}

const bundle = {
  win32: { dir: 'windows-x64', provision: 'pnpm ffmpeg:fetch:windows' },
  linux: { dir: 'linux-x64', provision: 'pnpm ffmpeg:fetch:linux' }
}[process.platform] ?? { dir: 'current', provision: 'pnpm ffmpeg:build:macos' }
const bundledDir = join(repoRoot, 'vendor', 'ffmpeg', bundle.dir, 'bin')
const exe = process.platform === 'win32' ? '.exe' : ''
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG ?? join(bundledDir, `ffmpeg${exe}`)
const ffprobePath = join(dirname(ffmpegPath), `ffprobe${exe}`)

if (!existsSync(ffmpegPath)) {
  fail(`bundled ffmpeg not found at ${ffmpegPath} — provision it with: ${bundle.provision}`)
}
if (!existsSync(ffprobePath)) {
  fail(`bundled ffprobe not found next to ffmpeg at ${ffprobePath}`)
}

const run = (binary, args) =>
  execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// 1) The backend's encoder probe must find a usable repair encoder.
const encoders = parseEncoderNames(run(ffmpegPath, ['-hide_banner', '-encoders']))
const encoder = selectRepairEncoder(encoders)
if (!encoder) {
  fail(
    `this ffmpeg has NO usable H.264 repair encoder (checked ${REPAIR_ENCODER_PREFERENCE.join(', ')}) ` +
      '— transcode repairs would be dead in this bundle'
  )
}
console.log(`smoke-repair-encoder: bundled ffmpeg repair encoder = ${encoder}`)

// 2) Run the exact repair command shape on a generated low-fps fixture.
const workDir = mkdtempSync(join(tmpdir(), 'videorc-repair-smoke-'))
const fixture = join(workDir, 'fixture.mp4')
const repaired = join(workDir, 'repaired.mp4')
try {
  run(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=15',
    ...repairEncoderArgs(encoder),
    '-pix_fmt',
    'yuv420p',
    fixture
  ])

  // Mirrors build_repair_args for VideoRepair::CfrTranscode (no audio stream).
  try {
    run(ffmpegPath, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      '-i',
      fixture,
      '-vf',
      'fps=30',
      ...repairEncoderArgs(encoder),
      '-pix_fmt',
      'yuv420p',
      repaired
    ])
  } catch (error) {
    fail(
      `the repair transcode FAILED with encoder ${encoder} — the exact class of bug ` +
        `this smoke exists to catch: ${error.stderr ?? error.message}`
    )
  }

  const probe = JSON.parse(
    run(ffprobePath, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-count_frames',
      '-show_entries',
      'stream=codec_name,avg_frame_rate,nb_read_frames',
      '-of',
      'json',
      repaired
    ])
  )
  const stream = probe.streams?.[0]
  if (stream?.codec_name !== 'h264') {
    fail(`repaired output is not h264 (got ${stream?.codec_name ?? 'no video stream'})`)
  }
  const [num, den] = (stream.avg_frame_rate ?? '0/1').split('/').map(Number)
  const fps = den > 0 ? num / den : 0
  if (Math.abs(fps - 30) > 1) {
    fail(`repaired output is not ~30 fps (got ${fps.toFixed(2)})`)
  }
  // 2 s at 30 fps: an encoder that skips frames (OpenH264 without
  // -allow_skip_frames 0) would undo the repair.
  const frames = Number(stream.nb_read_frames)
  if (!(Math.abs(frames - 60) <= 1)) {
    fail(`repaired output has ${stream.nb_read_frames} frames, expected 60`)
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

console.log(
  `smoke-repair-encoder: PASS — bundled ffmpeg repaired a 15fps fixture to 30fps h264 via ${encoder}.`
)
