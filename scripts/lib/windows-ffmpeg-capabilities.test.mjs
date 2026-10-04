import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REQUIRED_WINDOWS_FFMPEG_ENCODERS,
  REQUIRED_WINDOWS_FFMPEG_FILTERS,
  REQUIRED_WINDOWS_FFMPEG_PROTOCOLS,
  assessWindowsFfmpegCapabilities
} from './windows-ffmpeg-capabilities.mjs'

const PROTOCOLS_WITH_TLS = [
  'Supported file protocols:',
  'Input:',
  '  file',
  '  rtmp',
  '  rtmps',
  '  tls',
  'Output:',
  '  file',
  '  rtmp',
  '  rtmps',
  '  tls'
].join('\n')

const ENCODERS_WITH_MF = [
  'Encoders:',
  ' V....D h264_mf              MediaFoundation H.264 encoder (codec h264)',
  ' A....D aac                  AAC (Advanced Audio Coding)',
  ' A....D pcm_s16le            PCM signed 16-bit little-endian'
].join('\n')
const CLEAN_CUT_FILTER_LINES = [
  ' ... trim             V->V       Pick one continuous section from the input, drop the rest.',
  ' ... atrim            A->A       Pick one continuous section from the input, drop the rest.',
  ' ... concat           N->N       Concatenate audio and video streams.',
  ' T.. afade            A->A       Fade in/out input audio.',
  ' ... split            V->N       Pass on the input to N video outputs.',
  ' ... asplit           A->N       Pass on the audio input to N audio outputs.',
  ' ... setpts           V->V       Set PTS for the output video frame.',
  ' ... asetpts          A->A       Set PTS for the output audio frame.',
  ' ... format           V->V       Convert the input video to one of the specified pixel formats.'
]
const FILTERS_WITH_NOISE_CLEANUP = [
  'Filters:',
  ' TS afftdn A->A Denoise audio samples using FFT.',
  ...CLEAN_CUT_FILTER_LINES
].join('\n')

test('a fully capable ffmpeg passes', () => {
  const result = assessWindowsFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
})

test('Quick Sync and the OpenH264 fallback are reported but never required', () => {
  const without = assessWindowsFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(without.ok, true)
  assert.deepEqual(without.optionalMissing, ['encoder:h264_qsv', 'encoder:libopenh264'])

  const withBoth = assessWindowsFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: [
      ENCODERS_WITH_MF,
      ' V..... h264_qsv             H.264 (Intel Quick Sync Video acceleration) (codec h264)',
      ' V..... libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)'
    ].join('\n'),
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(withBoth.ok, true)
  assert.deepEqual(withBoth.optionalMissing, [])
})

test('the Windows bundle requires every filter the Clean cut render uses (plan 119 S13)', () => {
  for (const name of [
    'trim',
    'atrim',
    'concat',
    'afade',
    'split',
    'asplit',
    'setpts',
    'asetpts',
    'format'
  ]) {
    assert.ok(REQUIRED_WINDOWS_FFMPEG_FILTERS.includes(name), name)
  }
  const withoutAfade = assessWindowsFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP.split('\n')
      .filter((line) => !/ afade /.test(line))
      .join('\n')
  })
  assert.equal(withoutAfade.ok, false)
  assert.deepEqual(withoutAfade.missing, ['filter:afade'])
})

test('an ffmpeg without a TLS stack fails on rtmps and tls (the 0.9.23 class)', () => {
  const result = assessWindowsFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS.split('\n')
      .filter((line) => !/rtmps|tls/.test(line))
      .join('\n'),
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['protocol:rtmps', 'protocol:tls'])
})

test('rtmps does not substring-match as rtmp', () => {
  const result = assessWindowsFfmpegCapabilities({
    protocolsOutput: 'Input:\n  rtmps\n  tls',
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['protocol:rtmp'])
})

test('missing required video and MKV audio encoders fail closed', () => {
  const result = assessWindowsFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: 'Encoders:\n A....D aac    AAC',
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['encoder:h264_mf', 'encoder:pcm_s16le'])
})

test('the Windows bundle requires PCM for MKV Noise Cleanup outputs', () => {
  const result = assessWindowsFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF.replace(/\n A\.\.\.\.D pcm_s16le.*$/, ''),
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.deepEqual(result.missing, ['encoder:pcm_s16le'])
})

test('empty output reports the whole required set (fail closed)', () => {
  const result = assessWindowsFfmpegCapabilities({})
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, [
    ...REQUIRED_WINDOWS_FFMPEG_PROTOCOLS.map((name) => `protocol:${name}`),
    ...REQUIRED_WINDOWS_FFMPEG_ENCODERS.map((name) => `encoder:${name}`),
    ...REQUIRED_WINDOWS_FFMPEG_FILTERS.map((name) => `filter:${name}`)
  ])
})

test('the Windows bundle requires the model-free noise cleanup filter', () => {
  const result = assessWindowsFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: [
      'Filters:',
      ' T. loudnorm A->A EBU R128 loudness normalization',
      ...CLEAN_CUT_FILTER_LINES
    ].join('\n')
  })
  assert.deepEqual(result.missing, ['filter:afftdn'])
})
