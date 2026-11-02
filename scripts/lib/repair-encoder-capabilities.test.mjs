import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REPAIR_ENCODER_ARGS,
  REPAIR_ENCODER_PREFERENCE,
  REQUIRED_MACOS_FFMPEG_FILTERS,
  assessMacosFfmpegCapabilities,
  parseEncoderNames,
  selectRepairEncoder
} from './repair-encoder-capabilities.mjs'

const ENCODERS_LGPL_MACOS = [
  'Encoders:',
  ' V..... = Video',
  ' A..... = Audio',
  ' ------',
  ' V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)',
  ' V....D hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)',
  ' A....D aac                  AAC (Advanced Audio Coding)',
  ' A....D pcm_s16le            PCM signed 16-bit little-endian'
].join('\n')

const ENCODERS_FULL_GPL = [
  'Encoders:',
  ' ------',
  ' V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
  ' V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)',
  ' A....D aac                  AAC (Advanced Audio Coding)',
  ' A....D pcm_s16le            PCM signed 16-bit little-endian'
].join('\n')

const PROTOCOLS_WITH_TLS = ['Input:', '  file', '  rtmp', '  rtmps', '  tls'].join('\n')
const RENDER_FILTER_LINES = [
  ' TS. geq              V->V       Apply generic equation to each pixel.',
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
const CAMERA_LOOK_FILTER_LINES = [
  ' ... scale            V->V       Scale the input video size and/or convert the image format.',
  ' TS. lutyuv           V->V       Compute and apply a lookup table to the YUV input video.'
]
const FILTERS_WITH_NOISE_CLEANUP = [
  'Filters:',
  ' TS afftdn A->A Denoise audio samples using FFT.',
  ...RENDER_FILTER_LINES,
  ...CAMERA_LOOK_FILTER_LINES
].join('\n')

test('parses encoder names out of -encoders output', () => {
  const names = parseEncoderNames(ENCODERS_LGPL_MACOS)
  assert.ok(names.includes('h264_videotoolbox'))
  assert.ok(names.includes('aac'))
  assert.ok(!names.includes('Encoders:'))
  assert.ok(!names.includes('='))
})

test('prefers libx264, then the platform hardware encoders', () => {
  assert.equal(selectRepairEncoder(parseEncoderNames(ENCODERS_FULL_GPL)), 'libx264')
  assert.equal(selectRepairEncoder(parseEncoderNames(ENCODERS_LGPL_MACOS)), 'h264_videotoolbox')
  assert.equal(selectRepairEncoder(['aac', 'h264_mf']), 'h264_mf')
  assert.equal(selectRepairEncoder(['aac']), null)
})

test('every preferred encoder has a matching quality-args recipe', () => {
  for (const name of REPAIR_ENCODER_PREFERENCE) {
    const args = REPAIR_ENCODER_ARGS[name]
    assert.ok(Array.isArray(args) && args.length > 0, `missing args for ${name}`)
    assert.equal(args[0], '-c:v')
    assert.equal(args[1], name)
  }
})

test('-crf stays exclusive to libx264 (the toast-noise regression)', () => {
  for (const [name, args] of Object.entries(REPAIR_ENCODER_ARGS)) {
    if (name !== 'libx264') {
      assert.ok(!args.includes('-crf'), `-crf leaked into ${name} args`)
    }
  }
})

test('an LGPL macOS bundle with videotoolbox and TLS passes', () => {
  const result = assessMacosFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_LGPL_MACOS,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
})

test('a bundle without videotoolbox or TLS fails closed with named gaps', () => {
  const result = assessMacosFfmpegCapabilities({
    protocolsOutput: 'Input:\n  file\n  rtmp',
    encodersOutput: 'Encoders:\n A....D aac  AAC',
    filtersOutput: ''
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, [
    'protocol:rtmps',
    'protocol:tls',
    'encoder:h264_videotoolbox',
    'encoder:pcm_s16le',
    ...REQUIRED_MACOS_FFMPEG_FILTERS.map((name) => `filter:${name}`)
  ])
})

test('the macOS bundle requires every filter the Clean cut render uses (plan 119 S13)', () => {
  assert.deepEqual(REQUIRED_MACOS_FFMPEG_FILTERS, [
    'afftdn',
    'geq',
    'trim',
    'atrim',
    'concat',
    'afade',
    'split',
    'asplit',
    'setpts',
    'asetpts',
    'format',
    'scale',
    'lutyuv'
  ])
  for (const name of REQUIRED_MACOS_FFMPEG_FILTERS) {
    const missingFilter = assessMacosFfmpegCapabilities({
      protocolsOutput: PROTOCOLS_WITH_TLS,
      encodersOutput: ENCODERS_LGPL_MACOS,
      filtersOutput: FILTERS_WITH_NOISE_CLEANUP.split('\n')
        .filter((line) => !line.split(/\s+/).includes(name))
        .join('\n')
    })
    assert.deepEqual(missingFilter.missing, [`filter:${name}`])
  }
})

test('the macOS bundle requires PCM for MKV Noise Cleanup outputs', () => {
  const result = assessMacosFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_LGPL_MACOS.replace(/\n A\.\.\.\.D pcm_s16le.*$/, ''),
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.deepEqual(result.missing, ['encoder:pcm_s16le'])
})

test('the macOS bundle requires every filter the legacy camera look chain uses (plan 213 I)', () => {
  const withoutLutyuv = assessMacosFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_LGPL_MACOS,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP.split('\n')
      .filter((line) => !/ lutyuv /.test(line))
      .join('\n')
  })
  assert.deepEqual(withoutLutyuv.missing, ['filter:lutyuv'])
  // The 0.18.0 bundle: every LGPL filter the chain needs, plus no `eq`. A
  // policy that still needed `eq` would reject the very bundle that ships.
  assert.ok(!REQUIRED_MACOS_FFMPEG_FILTERS.includes('eq'))
  assert.ok(!/ eq /.test(FILTERS_WITH_NOISE_CLEANUP))
  const lgplBundle = assessMacosFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_LGPL_MACOS,
    filtersOutput: FILTERS_WITH_NOISE_CLEANUP
  })
  assert.deepEqual(lgplBundle, { ok: true, missing: [] })
})

test('the macOS bundle requires the model-free noise cleanup filter', () => {
  assert.ok(REQUIRED_MACOS_FFMPEG_FILTERS.includes('afftdn'))
  const result = assessMacosFfmpegCapabilities({
    protocolsOutput: PROTOCOLS_WITH_TLS,
    encodersOutput: ENCODERS_LGPL_MACOS,
    filtersOutput: [
      'Filters:',
      ' T. loudnorm A->A EBU R128 loudness normalization',
      ...RENDER_FILTER_LINES,
      ...CAMERA_LOOK_FILTER_LINES
    ].join('\n')
  })
  assert.deepEqual(result.missing, ['filter:afftdn'])
})
