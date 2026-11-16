/** Portable native fixture specification and bounded decoded-audio marker reader.
 * 40 ms 3500 Hz sync, twelve 20 ms FSK bits (1500/2500 Hz), then 440 Hz.
 * The first millisecond is a pulse. Second IDs prevent one-second aliasing.
 */
export const PCM_MARKER = Object.freeze({
  rate: 48000,
  syncFrames: 1920,
  bitFrames: 960,
  bits: 12,
  markerFrames: 13440,
  maxSecond: 3599,
  uncertaintyFrames: 480
})
export function fixtureSample(sample) {
  const position = sample % 48000
  if (position < 48) return 0.5
  const hz =
    position < 1920
      ? 3500
      : position < 13440
        ? (Math.floor(sample / 48000) >> (11 - Math.floor((position - 1920) / 960))) & 1
          ? 2500
          : 1500
        : 440
  return Math.sin((2 * Math.PI * hz * sample) / 48000) * (position < 13440 ? 0.4 : 0.1)
}
function energy(samples, start, count, hz) {
  let real = 0,
    imaginary = 0,
    total = 0
  for (let i = 0; i < count; i++) {
    const value = samples[start + i]
    real += value * Math.cos((2 * Math.PI * hz * i) / 48000)
    imaginary += value * Math.sin((2 * Math.PI * hz * i) / 48000)
    total += value * value
  }
  return { tone: ((real * real + imaginary * imaginary) * 2) / count, total }
}
export function decodeMarker(samples) {
  if (samples.length < PCM_MARKER.markerFrames) return null
  const sync = energy(samples, 480, 960, 3500)
  if (sync.total < 0.1 || sync.tone / sync.total < 0.7) return null
  let second = 0
  for (let bit = 0; bit < 12; bit++) {
    const at = 1920 + bit * 960 + 240
    const zero = energy(samples, at, 480, 1500),
      one = energy(samples, at, 480, 2500)
    if (zero.total < 0.1 || Math.max(zero.tone, one.tone) / zero.total < 0.7) return null
    second = second * 2 + Number(one.tone > zero.tone)
  }
  return second <= PCM_MARKER.maxSecond ? second : null
}
export class PcmMarkerDecoder {
  #buffer = new Float32Array(PCM_MARKER.markerFrames)
  #used = 0
  #start = null
  #next = 0
  rejected = 0
  push(samples, firstFrame, found) {
    for (let i = 0; i < samples.length; i++) {
      const frame = firstFrame + i
      if (this.#start === null) {
        if (frame < this.#next || Math.abs(samples[i]) <= 0.25) continue
        this.#start = frame
        this.#used = 0
      }
      this.#buffer[this.#used++] = samples[i]
      if (this.#used === this.#buffer.length) {
        const second = decodeMarker(this.#buffer)
        if (second === null) this.rejected++
        else
          found({
            second,
            audioFrame: this.#start,
            uncertaintyFrames: PCM_MARKER.uncertaintyFrames
          })
        this.#next = this.#start + 24000
        this.#start = null
      }
    }
  }
}
