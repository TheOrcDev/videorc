import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEDIA,
  toneWav,
  cameraY4m,
  toneDbfs,
  colorFraction,
  audioMeasurements
} from './cloud-parity-media.mjs'

test('tone fixture encodes correct mono PCM duration, amplitude and independent stems', () => {
  const wav = toneWav(440, 1)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(24), 48000)
  assert.equal(wav.readUInt32LE(40), 96000)
  const samples = Float32Array.from(
    { length: 48000 },
    (_, i) => wav.readInt16LE(44 + i * 2) / 32768
  )
  assert.ok(
    Math.abs(toneDbfs(samples, 440) - 20 * Math.log10(MEDIA.tonePeak / Math.sqrt(2))) < 0.02
  )
  assert.ok(toneDbfs(samples, 1000) < -90)
  assert.throws(() => toneWav(24000), /assertion|false|true/i)
  assert.throws(() => toneWav(440, 100))
})
test('separate stem analysis detects mixed signals and absence, not just total RMS', () => {
  const samples = Float32Array.from(
    { length: 48000 },
    (_, i) =>
      0.1 * Math.sin((2 * Math.PI * 440 * i) / 48000) +
      0.2 * Math.sin((2 * Math.PI * 1000 * i) / 48000)
  )
  const tones = audioMeasurements(samples)
  assert.ok(tones.host > -24 && tones.host < -22)
  assert.ok(tones.soundboard > -18 && tones.soundboard < -16)
  assert.ok(tones.guest1 < -90 && tones.system < -90)
  assert.throws(() => toneDbfs(new Float32Array(100), 440), /one second/)
})
test('camera fixture is bounded, repeatable, and changes its frame clock marker', () => {
  const video = cameraY4m(MEDIA.colors.host)
  assert.deepEqual(video, cameraY4m(MEDIA.colors.host))
  const headerLength = video.indexOf('\n') + 1,
    bytes = 320 * 180 * 1.5,
    frame = 6 + bytes
  assert.equal(video.length, headerLength + frame * 60)
  assert.equal(video.toString('ascii', headerLength, headerLength + 6), 'FRAME\n')
  assert.notDeepEqual(
    video.subarray(headerLength + 6, headerLength + frame),
    video.subarray(headerLength + frame + 6, headerLength + frame * 2)
  )
})
test('codec tolerance finds intended marker and rejects unrelated pixels/empty artifacts', () => {
  assert.equal(colorFraction(Buffer.from([201, 41, 41, 1, 2, 3]), MEDIA.colors.host), 0.5)
  assert.equal(colorFraction(Buffer.from([40, 80, 200]), MEDIA.colors.host), 0)
  assert.throws(() => colorFraction(Buffer.alloc(0), MEDIA.colors.host))
  assert.throws(() => colorFraction(Buffer.alloc(2), MEDIA.colors.host))
})
