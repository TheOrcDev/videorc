import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REQUIRED_WINDOWS_FFMPEG_BITSTREAM_FILTERS,
  REQUIRED_WINDOWS_FFMPEG_DEMUXERS,
  REQUIRED_WINDOWS_FFMPEG_ENCODERS,
  REQUIRED_WINDOWS_FFMPEG_FILTERS,
  REQUIRED_WINDOWS_FFMPEG_MUXERS,
  REQUIRED_WINDOWS_FFMPEG_PROTOCOLS,
  assessWindowsFfmpegCapabilities
} from './windows-ffmpeg-capabilities.mjs'

const MUXERS_WITH_SEGMENT = [
  'File formats:',
  ' D. = Demuxing supported',
  ' .E = Muxing supported',
  ' --',
  '  E  mp4             MP4 (MPEG-4 Part 14)',
  '  E  mpegts          MPEG-TS (MPEG-2 Transport Stream)',
  '  E  segment         segment',
  '  E  stream_segment,ssegment streaming segment muxer'
].join('\n')
const DEMUXERS_WITH_CONCAT = [
  'File formats:',
  ' D   concat          Virtual concatenation script',
  ' D   mpegts          MPEG-TS (MPEG-2 Transport Stream)'
].join('\n')
const BSFS_WITH_ADTSTOASC = ['Bitstream filters:', 'aac_adtstoasc', 'h264_mp4toannexb'].join('\n')
const RING = {
  muxersOutput: MUXERS_WITH_SEGMENT,
  demuxersOutput: DEMUXERS_WITH_CONCAT,
  bitstreamFiltersOutput: BSFS_WITH_ADTSTOASC
}

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
    ...RING,
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
})

test('Quick Sync and the OpenH264 fallback are reported but never required', () => {
  const without = assessWindowsFfmpegCapabilities({
    ...RING,
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(without.ok, true)
  assert.deepEqual(without.optionalMissing, ['encoder:h264_qsv', 'encoder:libopenh264'])

  const withBoth = assessWindowsFfmpegCapabilities({
    ...RING,
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
    ...RING,
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
    ...RING,
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
    ...RING,
    protocolsOutput: 'Input:\n  rtmps\n  tls',
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['protocol:rtmp'])
})

test('missing required video and MKV audio encoders fail closed', () => {
  const result = assessWindowsFfmpegCapabilities({
    ...RING,
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: 'Encoders:\n A....D aac    AAC',
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['encoder:h264_mf', 'encoder:pcm_s16le'])
})

test('the Windows bundle requires PCM for MKV Noise Cleanup outputs', () => {
  const result = assessWindowsFfmpegCapabilities({
    ...RING,
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
    ...REQUIRED_WINDOWS_FFMPEG_FILTERS.map((name) => `filter:${name}`),
    ...REQUIRED_WINDOWS_FFMPEG_MUXERS.map((name) => `muxer:${name}`),
    ...REQUIRED_WINDOWS_FFMPEG_DEMUXERS.map((name) => `demuxer:${name}`),
    ...REQUIRED_WINDOWS_FFMPEG_BITSTREAM_FILTERS.map((name) => `bsf:${name}`)
  ])
})

test('the replay buffer needs the segment ring, the concat demuxer and aac_adtstoasc (plan 181)', () => {
  assert.deepEqual(REQUIRED_WINDOWS_FFMPEG_MUXERS, ['segment', 'mpegts', 'mp4'])
  assert.deepEqual(REQUIRED_WINDOWS_FFMPEG_DEMUXERS, ['concat', 'mpegts'])
  assert.deepEqual(REQUIRED_WINDOWS_FFMPEG_BITSTREAM_FILTERS, ['aac_adtstoasc'])
  const capable = assessWindowsFfmpegCapabilities({
    ...RING,
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP,
    muxersOutput: MUXERS_WITH_SEGMENT,
    demuxersOutput: DEMUXERS_WITH_CONCAT,
    bitstreamFiltersOutput: BSFS_WITH_ADTSTOASC
  })
  assert.equal(capable.ok, true, capable.missing.join(', '))
  const withoutRing = assessWindowsFfmpegCapabilities({
    ...RING,
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP,
    muxersOutput: MUXERS_WITH_SEGMENT.split('\n')
      .filter((line) => !/ segment /.test(line))
      .join('\n'),
    demuxersOutput: DEMUXERS_WITH_CONCAT.split('\n')
      .filter((line) => !/ concat /.test(line))
      .join('\n'),
    bitstreamFiltersOutput: 'Bitstream filters:\nh264_mp4toannexb'
  })
  assert.deepEqual(withoutRing.missing, ['muxer:segment', 'demuxer:concat', 'bsf:aac_adtstoasc'])
  // `stream_segment,ssegment` must not pass for `segment`, nor `mpegtsraw` for `mpegts`.
  const lookalikes = assessWindowsFfmpegCapabilities({
    ...RING,
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_WITH_MF,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP,
    muxersOutput: '  E  stream_segment,ssegment streaming segment muxer\n  E  mp4             MP4',
    demuxersOutput:
      ' D   mpegtsraw       raw MPEG-TS\n D   concat          Virtual concatenation script',
    bitstreamFiltersOutput: BSFS_WITH_ADTSTOASC
  })
  assert.deepEqual(lookalikes.missing, ['muxer:segment', 'muxer:mpegts', 'demuxer:mpegts'])
})

test('the Windows bundle requires the model-free noise cleanup filter', () => {
  const result = assessWindowsFfmpegCapabilities({
    ...RING,
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
