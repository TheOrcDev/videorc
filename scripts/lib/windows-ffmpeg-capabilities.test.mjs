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
const FILTERS_WITH_NOISE_CLEANUP = 'Filters:\n TS afftdn A->A Denoise audio samples using FFT.'

test('a fully capable ffmpeg passes', () => {
  const result = assessWindowsFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
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
    filtersOutput: 'Filters:\n T. loudnorm A->A EBU R128 loudness normalization'
  })
  assert.deepEqual(result.missing, ['filter:afftdn'])
})
