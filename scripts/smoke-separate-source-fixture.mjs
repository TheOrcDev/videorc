#!/usr/bin/env node
// Separate source recordings fixture smoke (plan 157).
//
// No camera device is needed: the backend fixture test renders a
// camera-in-screen scene through the production publisher with the ISO legs
// armed and dumps every frame of the Combined, Screen and Camera legs (CPU and
// Metal on macOS). This smoke encodes each leg into a real file beside the
// others, with the audio track its role promises (sine tones at distinct
// frequencies stand in for mic and system audio), then proves:
//
//   - the take gate passes (role files present, canvas, audio pairing, drift),
//   - every decoded frame of every file matches the compositor reference
//     (the Screen file has no camera inset; the Camera file is camera-only),
//   - each file passes the honest recording analyzer,
//   - a deliberately swapped audio pairing is rejected by the take gate.
//
// Device acceptance with a real camera still happens through the packaged app
// (`pnpm smoke:separate-source-take -- <combined-file>`).

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { assertSceneSwitchPixels } from './lib/scene-switch-pixels.mjs'
import {
  ROLE_AUDIO_TITLES,
  TAKE_ROLES,
  evaluateTake,
  summarizeRoleProbe,
  takeSiblingPaths
} from './lib/separate-source-take-gates.mjs'

const root = resolve(import.meta.dirname, '..')
const directory = mkdtempSync(join(tmpdir(), 'videorc-separate-source-fixture-'))
const ffmpeg = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobe = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const WIDTH = 64
const HEIGHT = 36
const FPS = 30
const FRAMES = 90
const DURATION_SECONDS = FRAMES / FPS
// Distinct stand-ins so a swapped pairing is audible as well as mis-titled.
const ROLE_TONE_HZ = { combined: 440, screen: 660, camera: 880 }

console.log(`Separate source fixture evidence: ${directory}`)
await run(
  'cargo',
  [
    'test',
    '-p',
    'videorc-backend',
    '--bin',
    'videorc-backend',
    'compositor::scene_switch_tests::source_iso_artifact_fixture',
    '--',
    '--exact',
    '--nocapture'
  ],
  { ...process.env, VIDEORC_SOURCE_ISO_ARTIFACT_DIR: directory }
)

for (const mode of process.platform === 'darwin' ? ['cpu', 'metal'] : ['cpu']) {
  const paths = takeSiblingPaths(join(directory, `${mode}-take.mp4`))
  for (const role of TAKE_ROLES) {
    const reference = join(directory, `${mode}-${role}.yuv`)
    await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pixel_format',
      'yuv420p',
      '-video_size',
      `${WIDTH}x${HEIGHT}`,
      '-framerate',
      String(FPS),
      '-color_range',
      'tv',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-i',
      reference,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${ROLE_TONE_HZ[role]}:sample_rate=48000:duration=${DURATION_SECONDS}`,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-ac',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '12',
      '-pix_fmt',
      'yuv420p',
      '-color_range',
      'tv',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-c:a',
      'aac',
      // Both tags, exactly as source_iso.rs writes them: `title` for MKV
      // players, `handler_name` so the MP4 export keeps the role.
      '-metadata:s:a:0',
      `title=${ROLE_AUDIO_TITLES[role]}`,
      '-metadata:s:a:0',
      `handler_name=${ROLE_AUDIO_TITLES[role]}`,
      '-shortest',
      paths[role]
    ])
  }

  // 1. The take gate on the real files.
  const summaries = {}
  for (const role of TAKE_ROLES) {
    summaries[role] = summarizeRoleProbe(probeRaw(paths[role]))
  }
  const take = evaluateTake(summaries, { video: { width: WIDTH, height: HEIGHT, fps: FPS } })
  if (!take.pass) throw new Error(`${mode}: take gate failed: ${take.failures.join('; ')}`)
  console.log(`${mode}: take gate PASS (${TAKE_ROLES.length} roles)`)

  // 2. Every decoded frame matches the compositor reference per role.
  for (const role of TAKE_ROLES) {
    const decoded = spawnSync(
      ffmpeg,
      [
        '-v',
        'error',
        '-i',
        paths[role],
        '-map',
        '0:v:0',
        '-pix_fmt',
        'yuv420p',
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        'pipe:1'
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    )
    if (decoded.status !== 0) {
      throw new Error(decoded.stderr?.toString() ?? String(decoded.error))
    }
    const pixels = assertSceneSwitchPixels(
      readFileSync(join(directory, `${mode}-${role}.yuv`)),
      decoded.stdout,
      { width: WIDTH, height: HEIGHT, label: paths[role] }
    )
    // 3. Honest final-file analysis per role.
    const quality = await analyzeRecording(paths[role], {
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      intendedFps: FPS,
      expectAudio: true,
      // The fixture holds static sources; the frame comparison above proves
      // the content identity, so freezes are not a defect here.
      gates: { requireMotion: false }
    })
    writeReports(quality)
    if (!quality.verdict.pass) {
      throw new Error(`${paths[role]}: ${quality.verdict.failures.join('; ')}`)
    }
    console.log(
      `${paths[role]}: PASS ${pixels.frames} frames, worst mean error ${pixels.worstMean.toFixed(2)}`
    )
  }

  // 4. A swapped mic/system pairing must be rejected by name.
  const swapped = join(directory, `${mode}-swap.tmp`)
  renameSync(paths.screen, swapped)
  renameSync(paths.camera, paths.screen)
  renameSync(swapped, paths.camera)
  const swappedSummaries = {}
  for (const role of TAKE_ROLES) {
    swappedSummaries[role] = summarizeRoleProbe(probeRaw(paths[role]))
  }
  const swappedTake = evaluateTake(swappedSummaries, {
    video: { width: WIDTH, height: HEIGHT, fps: FPS }
  })
  if (
    swappedTake.pass ||
    !swappedTake.failures.some((line) => /screen file carries the camera audio track/.test(line))
  ) {
    throw new Error(
      `${mode}: swapped audio pairing was not rejected: ${swappedTake.failures.join('; ') || 'pass'}`
    )
  }
  // Restore the files for the evidence directory.
  renameSync(paths.screen, swapped)
  renameSync(paths.camera, paths.screen)
  renameSync(swapped, paths.camera)
  console.log(`${mode}: swapped pairing rejected (${swappedTake.failures.length} failures)`)
}
console.log('separate-source-fixture: PASS')

function probeRaw(filePath) {
  const result = spawnSync(ffprobe, [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    filePath
  ])
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${result.stderr?.toString()}`)
  }
  return JSON.parse(result.stdout.toString())
}

function run(command, args, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
    let forceKill
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2000)
      forceKill.unref()
    }, 600000)
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(forceKill)
      rejectRun(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(forceKill)
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} exited ${code ?? signal}`))
    })
  })
}
