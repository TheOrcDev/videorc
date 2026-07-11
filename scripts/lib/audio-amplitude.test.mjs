import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  analyzeMediaAudioAmplitude,
  inspectMultipartPcm16Wav,
  inspectPcm16Wav,
  measurePcm16Le
} from './audio-amplitude.mjs'
import { ffmpegAvailable } from './ffmpeg-available.mjs'

const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'

describe('caption audio amplitude evidence', () => {
  it('measures PCM16 peak and RMS without retaining samples', () => {
    const pcm = pcm16([-32_768, -16_384, 0, 16_384])
    const result = measurePcm16Le(pcm)

    assert.equal(result.sampleCount, 4)
    assert.equal(result.peak, 1)
    assert.ok(Math.abs(result.rms - Math.sqrt(0.375)) < 1e-9)
  })

  it('finds and validates the WAV inside a multipart upload', () => {
    const wav = pcm16Wav([0, 8_192, -8_192, 16_384])
    const multipart = Buffer.concat([
      Buffer.from('--boundary\r\nContent-Disposition: form-data; name="audio"\r\n\r\n'),
      wav,
      Buffer.from('\r\n--boundary--\r\n')
    ])

    const direct = inspectPcm16Wav(wav)
    const uploaded = inspectMultipartPcm16Wav(multipart)
    assert.deepEqual(uploaded, direct)
    assert.equal(uploaded.channels, 1)
    assert.equal(uploaded.sampleRate, 16_000)
    assert.equal(uploaded.bitsPerSample, 16)
    assert.equal(uploaded.peak, 0.5)
  })

  it(
    'decodes amplitude from a finished FFmpeg media artifact',
    { skip: ffmpegAvailable(ffmpegPath) ? false : 'ffmpeg not installed' },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'videorc-caption-audio-amplitude-'))
      const artifact = join(directory, 'tone.wav')
      try {
        const encoded = spawnSync(
          ffmpegPath,
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000:duration=0.25',
            artifact
          ],
          { encoding: 'utf8' }
        )
        assert.equal(encoded.status, 0, encoded.stderr)

        const result = await analyzeMediaAudioAmplitude(artifact, { ffmpegPath })
        assert.ok(result.sampleCount >= 3_900)
        assert.ok(result.peak > 0.1 && result.peak < 0.14, `peak=${result.peak}`)
        assert.ok(result.rms > 0.07 && result.rms < 0.1, `rms=${result.rms}`)
      } finally {
        rmSync(directory, { force: true, recursive: true })
      }
    }
  )
})

function pcm16(samples) {
  const result = Buffer.alloc(samples.length * 2)
  for (const [index, sample] of samples.entries()) result.writeInt16LE(sample, index * 2)
  return result
}

function pcm16Wav(samples) {
  const pcm = pcm16(samples)
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcm.length, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16_000, 24)
  wav.writeUInt32LE(32_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.length, 40)
  pcm.copy(wav, 44)
  return wav
}
