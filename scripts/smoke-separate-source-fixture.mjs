#!/usr/bin/env node
// Separate source recordings fixture smoke (plan 157).
//
// No camera or microphone is needed. Two backend fixture tests run first:
//
//   - `compositor::scene_switch_tests::source_iso_artifact_fixture` renders a
//     camera-in-screen scene through the production publisher with the ISO
//     legs armed and dumps every frame of the Combined, Screen and Camera
//     legs (CPU and Metal on macOS);
//   - `session_audio::mix_tests::source_iso_audio_artifact_fixture` runs the
//     real audio bus with a 440 Hz microphone and a 1 kHz system source
//     through the production tap wiring and dumps the PCM each muxer reads
//     (the bus FIFO for Combined, the role taps for Screen and Camera).
//
// This smoke encodes each leg into a real file beside the others, with the
// routed PCM of its role, then proves:
//
//   - the take gate passes (role files present, canvas, audio titles, drift),
//   - each file's decoded audio carries its role's source and nothing else
//     (Screen = system tone, Camera = microphone tone, Combined = both),
//   - every decoded frame of every file matches the compositor reference
//     (the Screen file has no camera inset; the Camera file is camera-only),
//   - each file passes the honest recording analyzer,
//   - a swapped title pairing is rejected by the take gate, and swapped
//     samples under the right titles are rejected by the audio source gate.
//
// Device acceptance with a real camera still happens through the packaged app
// (`pnpm smoke:separate-source-take -- <combined-file>`).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { assertSceneSwitchPixels } from './lib/scene-switch-pixels.mjs'
import {
  ROLE_AUDIO_TITLES,
  TAKE_ROLES,
  evaluateRoleAudioSources,
  evaluateTake,
  summarizeRoleProbe,
  takeSiblingPaths,
  toneAmplitude
} from './lib/separate-source-take-gates.mjs'

const root = resolve(import.meta.dirname, '..')
const directory = mkdtempSync(join(tmpdir(), 'videorc-separate-source-fixture-'))
const ffmpeg = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobe = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const WIDTH = 64
const HEIGHT = 36
const FPS = 30
// Mirrors `source_iso_audio_artifact_fixture` in `session_audio.rs`.
const MICROPHONE_HZ = 440
const SYSTEM_HZ = 1000
const EXPECTED_LEVELS = { microphone: 0.5, system: 0.3 }
// The fixture's steady second (bus frames 48000..96000): whole cycles of
// both tones, past the system attach ramp.
const ANALYSIS_FRAMES = { start: 48000, end: 96000 }
const canvas = { width: WIDTH, height: HEIGHT, fps: FPS }

console.log(`Separate source fixture evidence: ${directory}`)
await run(
  'cargo',
  [
    'test',
    '-p',
    'videorc-backend',
    '--bin',
    'videorc-backend',
    '--',
    '--exact',
    'compositor::scene_switch_tests::source_iso_artifact_fixture',
    'session_audio::mix_tests::source_iso_audio_artifact_fixture',
    '--nocapture'
  ],
  { ...process.env, VIDEORC_SOURCE_ISO_ARTIFACT_DIR: directory }
)
for (const role of TAKE_ROLES) {
  if (!existsSync(audioPcm(role))) {
    throw new Error(`the backend audio fixture did not dump ${audioPcm(role)}`)
  }
}

for (const mode of process.platform === 'darwin' ? ['cpu', 'metal'] : ['cpu']) {
  const paths = takeSiblingPaths(join(directory, `${mode}-take.mp4`))
  for (const role of TAKE_ROLES) {
    await encodeRole(mode, role, role, paths[role])
  }

  // 1. The take gate on the real files.
  const take = evaluateTake(probeTake(paths), { video: canvas })
  if (!take.pass) throw new Error(`${mode}: take gate failed: ${take.failures.join('; ')}`)
  console.log(`${mode}: take gate PASS (${TAKE_ROLES.length} roles)`)

  // 2. Each file's samples carry its role's source, whatever its title says.
  const levels = Object.fromEntries(TAKE_ROLES.map((role) => [role, sourceLevels(paths[role])]))
  const sources = evaluateRoleAudioSources(levels, EXPECTED_LEVELS)
  if (!sources.pass) {
    throw new Error(`${mode}: audio source gate failed: ${sources.failures.join('; ')}`)
  }
  console.log(`${mode}: audio source gate PASS ${describeLevels(levels)}`)

  // 3. Every decoded frame matches the compositor reference per role.
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
    // 4. Honest final-file analysis per role.
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

  // 5. A swapped title pairing must be rejected by name.
  const swapped = join(directory, `${mode}-swap.tmp`)
  renameSync(paths.screen, swapped)
  renameSync(paths.camera, paths.screen)
  renameSync(swapped, paths.camera)
  const swappedTake = evaluateTake(probeTake(paths), { video: canvas })
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
  console.log(`${mode}: swapped title pairing rejected (${swappedTake.failures.length} failures)`)

  // 6. Swapped samples under the RIGHT titles: the take gate cannot see it,
  // the audio source gate must.
  const misrouted = {
    screen: join(directory, `${mode}-misrouted-screen.mp4`),
    camera: join(directory, `${mode}-misrouted-camera.mp4`)
  }
  await encodeRole(mode, 'screen', 'camera', misrouted.screen)
  await encodeRole(mode, 'camera', 'screen', misrouted.camera)
  const isoRoles = ['screen', 'camera']
  const misroutedTake = evaluateTake(probeTake(misrouted), { roles: isoRoles, video: canvas })
  if (!misroutedTake.pass) {
    throw new Error(
      `${mode}: the misrouted fixture should pass the title gate: ${misroutedTake.failures.join('; ')}`
    )
  }
  const misroutedSources = evaluateRoleAudioSources(
    Object.fromEntries(isoRoles.map((role) => [role, sourceLevels(misrouted[role])])),
    EXPECTED_LEVELS,
    { roles: isoRoles }
  )
  if (
    misroutedSources.pass ||
    !misroutedSources.failures.some((line) =>
      /screen file carries the camera audio samples/.test(line)
    )
  ) {
    throw new Error(
      `${mode}: swapped samples were not rejected: ${misroutedSources.failures.join('; ') || 'pass'}`
    )
  }
  console.log(
    `${mode}: swapped samples rejected under the right titles (${misroutedSources.failures.length} failures)`
  )
}
console.log('separate-source-fixture: PASS')

function audioPcm(role) {
  return join(directory, `audio-${role}.f32le`)
}

/** Encodes `videoRole`'s frames with `audioRole`'s routed PCM, titled for `videoRole`. */
function encodeRole(mode, videoRole, audioRole, output) {
  return run(ffmpeg, [
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
    join(directory, `${mode}-${videoRole}.yuv`),
    // The PCM the role's muxer read, in the muxer's input format.
    '-f',
    'f32le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-i',
    audioPcm(audioRole),
    '-map',
    '0:v',
    '-map',
    '1:a',
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
    `title=${ROLE_AUDIO_TITLES[videoRole]}`,
    '-metadata:s:a:0',
    `handler_name=${ROLE_AUDIO_TITLES[videoRole]}`,
    '-shortest',
    output
  ])
}

/** Tone levels of the microphone and system fixture sources in one file. */
function sourceLevels(filePath) {
  const decoded = spawnSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      filePath,
      '-map',
      '0:a:0',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1'
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  if (decoded.status !== 0) {
    throw new Error(`audio decode failed for ${filePath}: ${decoded.stderr?.toString()}`)
  }
  // Copy into a fresh buffer: Float32Array needs a 4-byte aligned offset.
  const samples = new Float32Array(new Uint8Array(decoded.stdout).buffer)
  const window = samples.subarray(ANALYSIS_FRAMES.start * 2, ANALYSIS_FRAMES.end * 2)
  if (window.length < (ANALYSIS_FRAMES.end - ANALYSIS_FRAMES.start) * 2) {
    throw new Error(`${filePath}: decoded only ${samples.length / 2} audio frames`)
  }
  return {
    microphone: toneAmplitude(window, { frequency: MICROPHONE_HZ }),
    system: toneAmplitude(window, { frequency: SYSTEM_HZ })
  }
}

function describeLevels(levels) {
  return Object.entries(levels)
    .map(
      ([role, level]) =>
        `${role} mic ${level.microphone.toFixed(3)} / system ${level.system.toFixed(3)}`
    )
    .join(', ')
}

function probeTake(paths) {
  return Object.fromEntries(
    Object.entries(paths).map(([role, filePath]) => [role, summarizeRoleProbe(probeRaw(filePath))])
  )
}

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
