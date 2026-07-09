import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REPAIR_ENCODER_ARGS,
  REPAIR_ENCODER_PREFERENCE,
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
  ' A....D aac                  AAC (Advanced Audio Coding)'
].join('\n')

const ENCODERS_FULL_GPL = [
  'Encoders:',
  ' ------',
  ' V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
  ' V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)',
  ' A....D aac                  AAC (Advanced Audio Coding)'
].join('\n')

const PROTOCOLS_WITH_TLS = ['Input:', '  file', '  rtmp', '  rtmps', '  tls'].join('\n')

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
    encodersOutput: ENCODERS_LGPL_MACOS
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
})

test('a bundle without videotoolbox or TLS fails closed with named gaps', () => {
  const result = assessMacosFfmpegCapabilities({
    protocolsOutput: 'Input:\n  file\n  rtmp',
    encodersOutput: 'Encoders:\n A....D aac  AAC'
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, [
    'protocol:rtmps',
    'protocol:tls',
    'encoder:h264_videotoolbox'
  ])
})
