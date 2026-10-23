#!/usr/bin/env node
// Soundboard fixture smoke (plan 189 S8).
//
// No camera or microphone is needed. One backend fixture test runs first:
//
//   - `session_audio::mix_tests::soundboard_artifact_fixture` runs the real
//     audio bus with a silent microphone and the plan 157 taps armed, presses
//     a 1 kHz fixture sound one second in through the production
//     `SoundboardHandle` (the press instant is the moment it arrived, as the
//     `sounds.play` RPC does), and dumps the PCM each muxer reads: the bus
//     FIFO for Combined and the microphone tap for the Camera ISO file, plus
//     `sound-press.json` with where the press was.
//
// This smoke encodes both through the production audio codec (AAC in MP4),
// decodes them back as a player would, and proves:
//
//   - the Combined file carries the tone, starting within one chunk plus
//     5 ms of where the press was,
//   - at its amplitude, with no clipping anywhere in the file,
//   - the Microphone file carries no tone at all,
//   - and every probe and decode succeeded (an analyzer failure is a failure).
//
// The dev-app smoke (`pnpm smoke:soundboard`) covers the RPC path and System
// audio; this one is the bus arithmetic and the tap wiring on their own.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { toneAmplitude } from './lib/separate-source-take-gates.mjs'

const root = resolve(import.meta.dirname, '..')
const directory = mkdtempSync(join(tmpdir(), 'videorc-soundboard-fixture-'))
const ffmpeg = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobe = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const SAMPLE_RATE = 48000
const CHUNK_FRAMES = 480
// The plan's STOP condition: more than one chunk plus 5 ms from the press.
const PLACEMENT_TOLERANCE_FRAMES = CHUNK_FRAMES + SAMPLE_RATE / 200
// AAC is not bit exact: a tenth of the amplitude either way is a codec, not
// a placement or a gain bug.
const AMPLITUDE_TOLERANCE = 0.1
const CLIPPING_CEILING = 0.99
const ROLES = ['combined', 'microphone']

console.log(`Soundboard fixture evidence: ${directory}`)
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
    'session_audio::mix_tests::soundboard_artifact_fixture',
    '--nocapture'
  ],
  { ...process.env, VIDEORC_SOUNDBOARD_ARTIFACT_DIR: directory }
)
for (const role of ROLES) {
  if (!existsSync(audioPcm(role))) {
    throw new Error(`the backend fixture did not dump ${audioPcm(role)}`)
  }
}
const press = JSON.parse(readFileSync(join(directory, 'sound-press.json'), 'utf8'))
if (press.sampleRate !== SAMPLE_RATE) {
  throw new Error(`the fixture ran at ${press.sampleRate} Hz, expected ${SAMPLE_RATE}`)
}
console.log(
  `press at sample ${press.expectedSample} (placed ${press.placedSample}), ` +
    `${press.toneHz} Hz at ${press.amplitude} for ${press.toneFrames} frames`
)

// 1. Encode each role's PCM the way the recording muxer does.
const encoded = {}
for (const role of ROLES) {
  encoded[role] = join(directory, `${role}.m4a`)
  await encode(audioPcm(role), encoded[role])
  const probe = probeAudio(encoded[role])
  if (!(probe.duration > 2.5)) {
    throw new Error(`${encoded[role]}: probed duration ${probe.duration}s, expected about 3 s`)
  }
  if (probe.sampleRate !== SAMPLE_RATE || probe.channels !== 2) {
    throw new Error(
      `${encoded[role]}: ${probe.sampleRate} Hz × ${probe.channels} ch, expected 48 kHz stereo`
    )
  }
}

// 2. The Combined file: the tone starts where the press was.
const combined = decode(encoded.combined)
const onset = toneOnset(combined, press.amplitude)
if (onset === null) {
  throw new Error('no tone in the Combined file')
}
const offset = onset - press.expectedSample
if (Math.abs(offset) > PLACEMENT_TOLERANCE_FRAMES) {
  throw new Error(
    `the tone starts at frame ${onset}, ${offset} frames (${((offset * 1000) / SAMPLE_RATE).toFixed(1)} ms) ` +
      `from the press at ${press.expectedSample}; the budget is ${PLACEMENT_TOLERANCE_FRAMES} frames`
  )
}
console.log(
  `combined: tone onset at frame ${onset}, ${offset >= 0 ? '+' : ''}${offset} frames from the press`
)

// 3. At its amplitude, and clean.
const steadyStart = press.placedSample + CHUNK_FRAMES
const steadyEnd = press.placedSample + press.toneFrames - CHUNK_FRAMES
const steady = combined.subarray(steadyStart * 2, steadyEnd * 2)
for (const channel of [0, 1]) {
  const amplitude = toneAmplitude(steady, { frequency: press.toneHz, channel })
  if (Math.abs(amplitude - press.amplitude) > AMPLITUDE_TOLERANCE * press.amplitude) {
    throw new Error(
      `combined channel ${channel}: tone amplitude ${amplitude.toFixed(4)}, expected ${press.amplitude}`
    )
  }
}
const peak = peakOf(combined)
if (peak >= CLIPPING_CEILING) {
  throw new Error(`combined: peak ${peak.toFixed(4)} reaches the clipping ceiling`)
}
console.log(`combined: tone amplitude ok, peak ${peak.toFixed(4)}`)

// 4. The Microphone file never carries the sound.
const microphone = decode(encoded.microphone)
const leaked = toneAmplitude(microphone, { frequency: press.toneHz })
if (leaked > 0.005) {
  throw new Error(`the Microphone file carries the tone at ${leaked.toFixed(4)}`)
}
const microphonePeak = peakOf(microphone)
if (microphonePeak > 0.005) {
  throw new Error(`the Microphone file is not silent (peak ${microphonePeak.toFixed(4)})`)
}
console.log(`microphone: silent (tone ${leaked.toFixed(5)}, peak ${microphonePeak.toFixed(5)})`)
console.log('soundboard-fixture: PASS')

function audioPcm(role) {
  return join(directory, `audio-${role}.f32le`)
}

/** Encodes the bus PCM (f32le stereo 48 kHz) as AAC in MP4. */
function encode(input, output) {
  return run(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'f32le',
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    '2',
    '-i',
    input,
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    output
  ])
}

/** Decodes a file back to f32le stereo 48 kHz samples. */
function decode(filePath) {
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
      String(SAMPLE_RATE),
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
  return new Float32Array(new Uint8Array(decoded.stdout).buffer)
}

function probeAudio(filePath) {
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
  const probe = JSON.parse(result.stdout.toString())
  const stream = (probe.streams ?? []).find((entry) => entry.codec_type === 'audio')
  if (!stream) {
    throw new Error(`${filePath}: no audio stream`)
  }
  return {
    duration: Number(probe.format?.duration ?? stream.duration ?? 0),
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels)
  }
}

/**
 * The first frame from which a 1 ms window holds the tone at half its
 * amplitude: past any codec pre-echo, at the tone's own rise.
 */
function toneOnset(samples, amplitude) {
  const window = SAMPLE_RATE / 1000
  const threshold = amplitude * 0.5
  const frames = Math.floor(samples.length / 2)
  for (let frame = 0; frame + window <= frames; frame += 1) {
    let peak = 0
    for (let offset = 0; offset < window; offset += 1) {
      peak = Math.max(peak, Math.abs(samples[(frame + offset) * 2]))
    }
    if (peak >= threshold) return frame
  }
  return null
}

function peakOf(samples) {
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  return peak
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
