import assert from 'node:assert/strict'
import { readParityJson } from './cloud-parity-contract.mjs'

export const MEDIA = readParityJson('media')

/** Small deterministic WAV fixtures, generated into the run directory, not git. */
export function toneWav(hz, seconds = MEDIA.durationSeconds) {
  assert.ok(Number.isFinite(hz) && hz > 0 && hz < MEDIA.sampleRate / 2)
  assert.ok(seconds > 0 && seconds <= 30)
  const n = Math.round(seconds * MEDIA.sampleRate),
    data = Buffer.alloc(44 + n * 2)
  data.write('RIFF')
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(MEDIA.sampleRate, 24)
  data.writeUInt32LE(MEDIA.sampleRate * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++)
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * hz * i) / MEDIA.sampleRate) * MEDIA.tonePeak * 32767),
      44 + 2 * i
    )
  return data
}

/** Solid camera identity plus moving white clock marker. Chromium loops this Y4M. */
export function cameraY4m(rgb, video = MEDIA.video) {
  const { width: w, height: h, fps } = video
  assert.ok(Number.isInteger(w) && w > 32 && w <= 1920 && w % 2 === 0)
  assert.ok(Number.isInteger(h) && h >= 24 && h <= 1080 && h % 2 === 0)
  assert.ok(Number.isInteger(fps) && fps > 0 && fps <= 60)
  const clamp = (v) => Math.max(16, Math.min(240, Math.round(v)))
  const [r, g, b] = rgb
  const y = clamp(16 + 0.257 * r + 0.504 * g + 0.098 * b)
  const u = clamp(128 - 0.148 * r - 0.291 * g + 0.439 * b)
  const v = clamp(128 + 0.439 * r - 0.368 * g - 0.071 * b)
  const frames = [Buffer.from(`YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`)]
  for (let frame = 0; frame < fps * 2; frame++) {
    const pixels = Buffer.concat([
      Buffer.alloc(w * h, y),
      Buffer.alloc((w * h) / 4, u),
      Buffer.alloc((w * h) / 4, v)
    ])
    const x = 8 + ((frame * 4) % (w - 32))
    for (let row = 8; row < 24; row++) pixels.fill(235, row * w + x, row * w + x + 16)
    frames.push(Buffer.from('FRAME\n'), pixels)
  }
  return Buffer.concat(frames)
}

/** One-second coherent windows avoid treating other fixture tones as this stem. */
export function toneDbfs(samples, hz, sampleRate = MEDIA.sampleRate) {
  assert.ok(samples.length >= sampleRate, 'Need at least one second of decoded audio')
  let energy = 0,
    windows = 0
  for (let offset = 0; offset + sampleRate <= samples.length; offset += sampleRate) {
    let re = 0,
      im = 0
    for (let i = 0; i < sampleRate; i++) {
      const phase = (2 * Math.PI * hz * i) / sampleRate
      re += samples[offset + i] * Math.cos(phase)
      im += samples[offset + i] * Math.sin(phase)
    }
    energy += (2 * (re * re + im * im)) / (sampleRate * sampleRate)
    windows++
  }
  return 10 * Math.log10(Math.max(1e-20, energy / windows))
}

export function colorFraction(rgb24, color, tolerance = MEDIA.analysis.colorTolerance) {
  assert.ok(rgb24.length > 0 && rgb24.length % 3 === 0)
  let count = 0
  for (let i = 0; i < rgb24.length; i += 3) {
    if (color.every((value, c) => Math.abs(rgb24[i + c] - value) <= tolerance)) count++
  }
  return count / (rgb24.length / 3)
}

export function audioMeasurements(samples) {
  return Object.fromEntries(
    Object.entries(MEDIA.tones).map(([name, hz]) => [name, toneDbfs(samples, hz)])
  )
}
