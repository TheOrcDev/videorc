import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  ffmpegFixtureArgs,
  fitPcmToWindow,
  fixtureRecord,
  RNNOISE_FIXTURE_ENV,
  RNNOISE_FIXTURE_SOURCE_ENV,
  RNNOISE_FIXTURE_TEXT,
  resolveFixtureFfmpegPath,
  rnnoisePassEnv,
  sayArgs,
  validateRnnoisePcm
} from './rnnoise-speech-fixture.mjs'

const pcm = (samples, value = 0.25) => {
  const bytes = Buffer.alloc(samples * 4)
  for (let index = 0; index < samples; index += 1) bytes.writeFloatLE(value, index * 4)
  return bytes
}

test('speaks the sentence into a file with say', () => {
  assert.deepEqual(sayArgs({ outputPath: '/tmp/x/speech.aiff' }), [
    '-o',
    '/tmp/x/speech.aiff',
    RNNOISE_FIXTURE_TEXT
  ])
  assert.throws(() => sayArgs({}), /output path/)
  assert.throws(() => sayArgs({ outputPath: '/tmp/a.aiff', text: '-v' }), /plain text/)
})

test('converts to raw 48 kHz mono f32le, overwriting and never reading stdin', () => {
  const args = ffmpegFixtureArgs({ inputPath: '/tmp/in.aiff', outputPath: '/tmp/out.f32le' })
  assert.equal(args.at(-1), '/tmp/out.f32le')
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/in.aiff')
  for (const [flag, value] of [
    ['-ac', '1'],
    ['-ar', '48000'],
    ['-c:a', 'pcm_f32le'],
    ['-f', 'f32le'],
    ['-map', '0:a:0']
  ])
    assert.equal(args[args.indexOf(flag) + 1], value, flag)
  assert.ok(args.includes('-nostdin') && args.includes('-y'))
  assert.throws(() => ffmpegFixtureArgs({ inputPath: '/tmp/in.aiff' }), /input and an output/)
})

test('finds FFmpeg the way the smokes do: the env, the staged build, then PATH', () => {
  const bundled = '/repo/vendor/ffmpeg/current/bin/ffmpeg'
  assert.equal(
    resolveFixtureFfmpegPath({
      env: { VIDEORC_SMOKE_FFMPEG_PATH: '/opt/ffmpeg' },
      bundled,
      exists: () => true
    }),
    '/opt/ffmpeg'
  )
  assert.equal(resolveFixtureFfmpegPath({ env: {}, bundled, exists: () => true }), bundled)
  assert.equal(resolveFixtureFfmpegPath({ env: {}, bundled, exists: () => false }), 'ffmpeg')
})

test('trims to 5 s, pads to 1 s with silence, and drops a partial sample', () => {
  const long = fitPcmToWindow(pcm(48_000 * 6))
  assert.equal(long.samples, 240_000)
  assert.equal(long.bytes.length, 240_000 * 4)
  assert.equal(long.trimmedSamples, 48_000)
  assert.equal(long.paddedSamples, 0)

  const short = fitPcmToWindow(pcm(12_000))
  assert.equal(short.samples, 48_000)
  assert.equal(short.paddedSamples, 36_000)
  assert.equal(short.bytes.readFloatLE(11_999 * 4), 0.25)
  assert.equal(short.bytes.readFloatLE(12_000 * 4), 0)

  const fits = fitPcmToWindow(Buffer.concat([pcm(96_000), Buffer.alloc(3)]))
  assert.equal(fits.inputSamples, 96_000)
  assert.equal(fits.samples, 96_000)
  assert.equal(fits.trimmedSamples + fits.paddedSamples, 0)
  assert.equal(validateRnnoisePcm(fits.bytes).seconds, 2)

  assert.throws(() => fitPcmToWindow(pcm(1), { minSamples: 10, maxSamples: 5 }), /window/)
})

test("accepts what the backend accepts and rejects what it refuses, with the backend's words", () => {
  const levels = validateRnnoisePcm(pcm(48_000, -0.5))
  assert.deepEqual(levels, { samples: 48_000, seconds: 1, peak: 0.5, rms: 0.5 })
  assert.equal(validateRnnoisePcm(pcm(240_000)).seconds, 5)
  for (const bytes of [
    Buffer.alloc(0),
    pcm(47_999),
    pcm(240_001),
    Buffer.concat([pcm(48_000), Buffer.alloc(1)])
  ])
    assert.throws(() => validateRnnoisePcm(bytes), /1 to 5 seconds of mono 48 kHz f32le/)
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.001])
    assert.throws(() => validateRnnoisePcm(pcm(48_000, value)), /finite and within full scale/)
  assert.throws(() => validateRnnoisePcm(pcm(48_000, 0)), /audible samples/)
})

test('records where the fixture came from and its SHA-256', () => {
  const bytes = pcm(48_000)
  assert.deepEqual(fixtureRecord({ source: 'synthesized', path: '/tmp/speech.f32le', bytes }), {
    source: 'synthesized',
    path: '/tmp/speech.f32le',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: 192_000
  })
  assert.equal(fixtureRecord({ source: 'supplied', path: '/a', bytes }).source, 'supplied')
  assert.throws(() => fixtureRecord({ source: 'guessed', path: '/a', bytes }), /Unknown/)
})

test('the tone pass never inherits a fixture; the speech pass names it and its source', () => {
  const base = {
    PATH: '/usr/bin',
    VIDEORC_SMOKE_OUTPUT_DIR: '/evidence',
    [RNNOISE_FIXTURE_ENV]: '/mine.f32le',
    [RNNOISE_FIXTURE_SOURCE_ENV]: 'supplied'
  }
  const tone = rnnoisePassEnv(base, { pass: 'tone', outputDirectory: '/evidence/tone' })
  assert.equal(tone.PATH, '/usr/bin')
  assert.equal(tone.VIDEORC_SMOKE_OUTPUT_DIR, '/evidence/tone')
  assert.equal(RNNOISE_FIXTURE_ENV in tone, false)
  assert.equal(RNNOISE_FIXTURE_SOURCE_ENV in tone, false)

  const speech = rnnoisePassEnv(base, {
    pass: 'speech',
    outputDirectory: '/evidence/speech',
    fixturePath: '/tmp/speech.f32le',
    fixtureSource: 'synthesized'
  })
  assert.equal(speech.VIDEORC_SMOKE_OUTPUT_DIR, '/evidence/speech')
  assert.equal(speech[RNNOISE_FIXTURE_ENV], '/tmp/speech.f32le')
  assert.equal(speech[RNNOISE_FIXTURE_SOURCE_ENV], 'synthesized')
  // The caller's environment is left as it was.
  assert.equal(base[RNNOISE_FIXTURE_ENV], '/mine.f32le')

  assert.throws(() => rnnoisePassEnv(base, { pass: 'speech', outputDirectory: '/e' }), /fixture/)
  assert.throws(() => rnnoisePassEnv(base, { pass: 'other', outputDirectory: '/e' }), /Unknown/)
})
