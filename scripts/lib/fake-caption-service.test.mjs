import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import WebSocket from 'ws'

import { startFakeCaptionService } from './fake-caption-service.mjs'

describe('fake caption service', () => {
  it('accepts legacy Bearer and current Gateway subprotocol realtime upgrades', async () => {
    const sessionToken = 'fake-caption-session'
    const realtimeToken = 'fake-caption-realtime'
    const fake = await startFakeCaptionService({
      smokeSessionToken: sessionToken,
      smokeRealtimeToken: realtimeToken
    })

    try {
      const tokenResponse = await fetch(`${fake.httpOrigin}/api/ai/captions/realtime-token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ sessionClientId: 'fake-service-test' })
      })
      assert.equal(tokenResponse.status, 200)
      const minted = await tokenResponse.json()

      const legacy = new WebSocket(minted.url, {
        headers: { authorization: `Bearer ${realtimeToken}` }
      })
      await configureAndClose(legacy)

      const gateway = new WebSocket(minted.url, [
        'ai-gateway-realtime.v1',
        `ai-gateway-auth.${realtimeToken}`
      ])
      await configureAndClose(gateway)

      assert.equal(fake.state.realtimeTokenRequests, 1)
      assert.equal(fake.state.realtimeUpgradeAttempts, 2)
      assert.equal(fake.state.realtimeConnections, 2)
      assert.equal(fake.state.configurations.length, 2)
    } finally {
      await fake.close()
    }
  })

  it('rejects an unauthenticated realtime upgrade without exposing token material', async () => {
    const fake = await startFakeCaptionService({
      smokeSessionToken: 'fake-caption-session',
      smokeRealtimeToken: 'fake-caption-realtime'
    })

    try {
      const socket = new WebSocket(`${fake.httpOrigin.replace('http:', 'ws:')}/realtime`)
      const error = await new Promise((resolveError) => {
        socket.once('error', resolveError)
      })
      assert.match(String(error), /401/)
      assert.equal(fake.state.realtimeUpgradeAttempts, 1)
      assert.equal(fake.state.realtimeConnections, 0)
    } finally {
      await fake.close()
    }
  })

  it('inspects uploaded WAV amplitude and can withhold captions for muted audio', async () => {
    const sessionToken = 'fake-caption-session'
    const fake = await startFakeCaptionService({
      smokeSessionToken: sessionToken,
      smokeRealtimeToken: 'fake-caption-realtime',
      chunkText: 'Audible caption.',
      minSpeechPeak: 0.05
    })

    try {
      const silent = await postCaptionChunk(fake.httpOrigin, sessionToken, pcm16Wav([0, 0, 0, 0]))
      const audible = await postCaptionChunk(
        fake.httpOrigin,
        sessionToken,
        pcm16Wav([0, 4_096, -8_192, 16_384])
      )

      assert.equal(silent.text, '')
      assert.deepEqual(silent.segments, [])
      assert.equal(audible.text, 'Audible caption.')
      assert.equal(fake.state.chunkRequests, 2)
      assert.equal(fake.state.chunkAudio[0].peak, 0)
      assert.equal(fake.state.chunkAudio[1].peak, 0.5)
      assert.equal(fake.state.chunkAudio[1].sampleRate, 16_000)
      assert.equal(fake.state.chunkAudio[1].channels, 1)
      assert.ok(!('audio' in fake.state.chunkAudio[1]), 'fake service must retain metrics only')
    } finally {
      await fake.close()
    }
  })
})

function configureAndClose(socket) {
  return new Promise((resolveConfigured, rejectConfigured) => {
    const timeout = setTimeout(() => {
      socket.terminate()
      rejectConfigured(new Error('Timed out waiting for fake caption configuration ack.'))
    }, 5_000)

    socket.once('error', (error) => {
      clearTimeout(timeout)
      rejectConfigured(error)
    })
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            input_audio_format: 'pcm16',
            input_audio_transcription: { enabled: true },
            turn_detection: {
              type: 'server_vad',
              create_response: false,
              interrupt_response: false
            }
          }
        })
      )
    })
    socket.once('message', (data) => {
      clearTimeout(timeout)
      const message = JSON.parse(data.toString())
      assert.equal(message.type, 'session-updated')
      socket.once('close', resolveConfigured)
      socket.close()
    })
  })
}

async function postCaptionChunk(origin, token, wav) {
  const form = new FormData()
  form.set('sessionClientId', 'fake-service-test')
  form.set('audio', new Blob([wav], { type: 'audio/wav' }), 'caption.wav')
  const response = await fetch(`${origin}/api/ai/captions/chunks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  })
  assert.equal(response.status, 200)
  return response.json()
}

function pcm16Wav(samples) {
  const pcm = Buffer.alloc(samples.length * 2)
  for (const [index, sample] of samples.entries()) pcm.writeInt16LE(sample, index * 2)
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
