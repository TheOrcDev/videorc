import assert from 'node:assert/strict'
import test from 'node:test'

import { fixtureH264EncoderArgsFor } from './ffmpeg-available.mjs'

const line = (name) => ` V....D ${name}              ${name} H.264 / AVC / MPEG-4 AVC (codec h264)`

test('fixtures use libx264 when this ffmpeg has it', () => {
  const output = ['Encoders:', line('libopenh264'), line('libx264')].join('\n')
  assert.deepEqual(fixtureH264EncoderArgsFor(output), ['-c:v', 'libx264', '-preset', 'ultrafast'])
})

test('the vendored LGPL Linux ffmpeg (OpenH264, no libx264) still builds fixtures', () => {
  const output = ['Encoders:', line('libopenh264'), line('h264_vaapi')].join('\n')
  assert.deepEqual(fixtureH264EncoderArgsFor(output), ['-c:v', 'libopenh264', '-b:v', '4M'])
})

test('no known H.264 encoder means no fixture args', () => {
  assert.equal(fixtureH264EncoderArgsFor(['Encoders:', line('h264_vaapi')].join('\n')), null)
  assert.equal(fixtureH264EncoderArgsFor(''), null)
})
