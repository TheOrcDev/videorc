import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bundledFfmpegPath } from './recording-studio-gates.mjs'

// The speech pass of `pnpm smoke:rnnoise` plays a 1 to 5 second, mono, 48 kHz,
// little-endian f32 PCM file through the debug native microphone fixture
// (crates/videorc-backend/src/audio_fixture_pcm.rs). Without one supplied in
// VIDEORC_RNNOISE_TEST_PCM_PATH, the smoke speaks this sentence with macOS
// `say` and converts it with FFmpeg. Each injection replays the file from its
// first sample for 3 s, so the sentence is long enough to keep speaking
// through that window with any voice; the trim keeps it inside 5 s.

export const RNNOISE_FIXTURE_ENV = 'VIDEORC_RNNOISE_TEST_PCM_PATH'
/** Tells the per-pass smoke whether its fixture was synthesized or supplied. */
export const RNNOISE_FIXTURE_SOURCE_ENV = 'VIDEORC_RNNOISE_TEST_PCM_SOURCE'
export const RNNOISE_FIXTURE_SAMPLE_RATE = 48_000
export const RNNOISE_FIXTURE_MIN_SECONDS = 1
export const RNNOISE_FIXTURE_MAX_SECONDS = 5
export const RNNOISE_FIXTURE_TEXT =
  'Videorc is testing noise reduction with a short spoken sentence that keeps going for a few seconds.'

const BYTES_PER_SAMPLE = 4
const MIN_SAMPLES = RNNOISE_FIXTURE_SAMPLE_RATE * RNNOISE_FIXTURE_MIN_SECONDS
const MAX_SAMPLES = RNNOISE_FIXTURE_SAMPLE_RATE * RNNOISE_FIXTURE_MAX_SECONDS
/** The backend's floor for an audible fixture, before it normalizes the peak. */
const MIN_PEAK = 0.001

/**
 * The FFmpeg that converts the fixture: VIDEORC_SMOKE_FFMPEG_PATH (what the
 * smoke decodes with), then the app's staged build in vendor/ffmpeg, then
 * `ffmpeg` on PATH.
 */
export function resolveFixtureFfmpegPath({
  env = process.env,
  bundled = bundledFfmpegPath(),
  exists = existsSync
} = {}) {
  if (env.VIDEORC_SMOKE_FFMPEG_PATH) return env.VIDEORC_SMOKE_FFMPEG_PATH
  return exists(bundled) ? bundled : 'ffmpeg'
}

/** `say -o speech.aiff "<text>"`: the default voice, written to a file. */
export function sayArgs({ outputPath, text = RNNOISE_FIXTURE_TEXT }) {
  if (!outputPath) throw new Error('say needs an output path.')
  if (!text || text.startsWith('-')) throw new Error('say needs plain text to speak.')
  return ['-o', outputPath, text]
}

/** Any audio file to raw 48 kHz mono f32le, the fixture's format before the trim. */
export function ffmpegFixtureArgs({ inputPath, outputPath }) {
  if (!inputPath || !outputPath) throw new Error('FFmpeg needs an input and an output path.')
  return [
    '-v',
    'error',
    '-nostdin',
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    String(RNNOISE_FIXTURE_SAMPLE_RATE),
    '-c:a',
    'pcm_f32le',
    '-f',
    'f32le',
    outputPath
  ]
}

/**
 * Whole samples only, trimmed to 5 s and padded with silence to 1 s. Returns
 * the bytes to write and what was done to them.
 */
export function fitPcmToWindow(bytes, { minSamples = MIN_SAMPLES, maxSamples = MAX_SAMPLES } = {}) {
  if (!Number.isInteger(minSamples) || !Number.isInteger(maxSamples) || minSamples > maxSamples)
    throw new Error('Invalid fixture window.')
  const inputSamples = Math.floor(bytes.length / BYTES_PER_SAMPLE)
  const samples = Math.min(Math.max(inputSamples, minSamples), maxSamples)
  const fitted = Buffer.alloc(samples * BYTES_PER_SAMPLE)
  bytes.copy(fitted, 0, 0, Math.min(inputSamples, samples) * BYTES_PER_SAMPLE)
  return {
    bytes: fitted,
    inputSamples,
    samples,
    trimmedSamples: Math.max(0, inputSamples - samples),
    paddedSamples: Math.max(0, samples - inputSamples)
  }
}

/**
 * The backend's own rules for the fixture, checked before the app launches so
 * a bad file fails in a second, not after a build: 1 to 5 s of whole f32
 * samples, every one finite and within full scale, and some of it audible.
 */
export function validateRnnoisePcm(bytes) {
  if (
    bytes.length < MIN_SAMPLES * BYTES_PER_SAMPLE ||
    bytes.length > MAX_SAMPLES * BYTES_PER_SAMPLE ||
    bytes.length % BYTES_PER_SAMPLE !== 0
  )
    throw new Error('RNNoise test PCM must contain 1 to 5 seconds of mono 48 kHz f32le samples.')
  const samples = bytes.length / BYTES_PER_SAMPLE
  let peak = 0
  let energy = 0
  for (let index = 0; index < samples; index += 1) {
    const value = bytes.readFloatLE(index * BYTES_PER_SAMPLE)
    if (!Number.isFinite(value) || Math.abs(value) > 1)
      throw new Error('RNNoise test PCM samples must be finite and within full scale.')
    peak = Math.max(peak, Math.abs(value))
    energy += value * value
  }
  if (peak < MIN_PEAK) throw new Error('RNNoise test PCM fixture must contain audible samples.')
  return {
    samples,
    seconds: samples / RNNOISE_FIXTURE_SAMPLE_RATE,
    peak,
    rms: Math.sqrt(energy / samples)
  }
}

/** What a report says about the fixture: where it came from and its SHA-256. */
export function fixtureRecord({ source, path, bytes }) {
  if (source !== 'synthesized' && source !== 'supplied')
    throw new Error(`Unknown fixture source: ${source}`)
  return {
    source,
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length
  }
}

/**
 * The speech pass's fixture: the supplied one, checked, or a sentence spoken
 * by `say` and converted by FFmpeg into a temp directory under os.tmpdir().
 * `cleanup()` deletes what it wrote (nothing for a supplied file).
 */
export function prepareSpeechFixture({ env = process.env, log = console.log } = {}) {
  const supplied = env[RNNOISE_FIXTURE_ENV]
  if (supplied) {
    const bytes = readFileSync(supplied)
    const levels = validateRnnoisePcm(bytes)
    log(`RNNoise speech fixture: supplied ${supplied} (${levels.seconds.toFixed(2)} s).`)
    return {
      path: supplied,
      record: { ...fixtureRecord({ source: 'supplied', path: supplied, bytes }), levels },
      cleanup: () => {}
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'videorc-rnnoise-fixture-'))
  const cleanup = () => rmSync(directory, { recursive: true, force: true })
  try {
    const speech = join(directory, 'speech.aiff')
    const converted = join(directory, 'speech-48k.f32le')
    const path = join(directory, 'speech.f32le')
    const ffmpeg = resolveFixtureFfmpegPath({ env })
    runTool('say', sayArgs({ outputPath: speech }), 'macOS `say` could not speak the fixture')
    runTool(
      ffmpeg,
      ffmpegFixtureArgs({ inputPath: speech, outputPath: converted }),
      `FFmpeg (${ffmpeg}) could not convert the fixture`
    )
    const fitted = fitPcmToWindow(readFileSync(converted))
    const levels = validateRnnoisePcm(fitted.bytes)
    writeFileSync(path, fitted.bytes)
    log(
      `RNNoise speech fixture: synthesized with say and ${ffmpeg} (${levels.seconds.toFixed(2)} s, ` +
        `${fitted.trimmedSamples} samples trimmed, ${fitted.paddedSamples} padded).`
    )
    return {
      path,
      record: {
        ...fixtureRecord({ source: 'synthesized', path, bytes: fitted.bytes }),
        text: RNNOISE_FIXTURE_TEXT,
        ffmpeg,
        inputSamples: fitted.inputSamples,
        trimmedSamples: fitted.trimmedSamples,
        paddedSamples: fitted.paddedSamples,
        levels
      },
      cleanup
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

function runTool(command, args, failure) {
  try {
    execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 })
  } catch (error) {
    const reason =
      error?.code === 'ENOENT'
        ? `${command} is not installed`
        : String(error?.stderr ?? '').trim() || (error?.message ?? String(error))
    throw new Error(`${failure}: ${reason}.`)
  }
}

/**
 * One pass's environment. The tone pass drops any fixture so the backend plays
 * its 440 Hz tone; the speech pass names the fixture and its source. Each pass
 * keeps its evidence in its own directory.
 */
export function rnnoisePassEnv(baseEnv, { pass, outputDirectory, fixturePath, fixtureSource }) {
  const env = { ...baseEnv, VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory }
  delete env[RNNOISE_FIXTURE_ENV]
  delete env[RNNOISE_FIXTURE_SOURCE_ENV]
  if (pass === 'tone') return env
  if (pass !== 'speech') throw new Error(`Unknown RNNoise smoke pass: ${pass}`)
  if (!fixturePath) throw new Error('The speech pass needs a fixture.')
  return { ...env, [RNNOISE_FIXTURE_ENV]: fixturePath, [RNNOISE_FIXTURE_SOURCE_ENV]: fixtureSource }
}
