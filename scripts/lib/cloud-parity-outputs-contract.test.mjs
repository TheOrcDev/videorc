import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  assertOutputPixels,
  assessOutputProbe,
  fakeManagedOutputProblem,
  fakeManagedOutputProfile,
  outputsConfig
} from './cloud-parity-outputs-contract.mjs'

const fixture = JSON.parse(
  readFileSync(new URL('../../protocol-fixtures/cloud-parity-outputs.json', import.meta.url))
)

test('the fake web admits and profiles exactly as the desktop and web do', () => {
  for (const one of fixture.admission) {
    assert.equal(fakeManagedOutputProblem(one.outputs), one.problem, one.name)
    if (!one.problem) assert.deepEqual(fakeManagedOutputProfile(one.outputs), one.profile, one.name)
  }
})

const probe = (patch = {}, audio = {}) => ({
  format: { duration: '5.0' },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      profile: 'High',
      width: 1920,
      height: 1080,
      avg_frame_rate: '60/1',
      nb_read_frames: '300',
      duration: '5.0',
      bit_rate: '5800000',
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      color_range: 'tv',
      ...patch
    },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, ...audio }
  ]
})

test('a finished artifact passes only with the 1080p H.264/AAC profile, BT.709 tags and its bitrate', () => {
  assert.equal(assessOutputProbe(probe(), 'h', 4).passed, true)
  const vertical = assessOutputProbe(probe({ width: 1080, height: 1920 }), 'v', 4)
  assert.equal(vertical.passed, true)
  for (const [name, broken, orientation] of [
    ['a 720p file', probe({ width: 1280, height: 720 }), 'h'],
    ['a horizontal file on the vertical lane', probe(), 'v'],
    ['30 fps', probe({ avg_frame_rate: '30/1', nb_read_frames: '150' }), 'h'],
    ['untagged colour', probe({ color_space: 'unknown' }), 'h'],
    ['full range', probe({ color_range: 'pc' }), 'h'],
    ['Main profile', probe({ profile: 'Main' }), 'h'],
    ['twice the bitrate envelope', probe({ bit_rate: '15000000' }), 'h'],
    ['no AAC', probe({}, { codec_name: 'opus' }), 'h']
  ])
    assert.equal(assessOutputProbe(broken, orientation, 4).passed, false, name)
})

test('placement is judged in decoded pixels, present or absent', () => {
  const pixels = (rgb, n) => Buffer.from(Array.from({ length: n }, () => rgb).flat())
  assert.ok(assertOutputPixels(pixels([0, 255, 255], 64), { expected: [0, 255, 255] }) > 0.9)
  assert.throws(() => assertOutputPixels(pixels([10, 10, 10], 64), { expected: [0, 255, 255] }))
  assert.ok(
    assertOutputPixels(pixels([10, 10, 10], 64), { expected: [0, 255, 255], absent: true }) < 0.05
  )
  assert.throws(() =>
    assertOutputPixels(pixels([0, 255, 255], 64), { expected: [0, 255, 255], absent: true })
  )
})

test('the acquisition window is bounded', () => {
  assert.equal(outputsConfig({}).seconds, 4)
  assert.throws(() => outputsConfig({ VIDEORC_OUTPUTS_SECONDS: '60' }))
})
