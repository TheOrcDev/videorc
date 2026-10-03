import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import WebSocket from 'ws'

import { startFakeCaptionService } from './fake-caption-service.mjs'

describe('fake caption service', () => {
  it(
    'holds a scripted speech completion behind an explicit response barrier',
    { timeout: 10_000 },
    async () => {
      const token = 'fake-caption-realtime'
      const fake = await startFakeCaptionService({
        smokeSessionToken: 'fake-caption-session',
        smokeRealtimeToken: token,
        autoTranscript: false
      })
      const socket = new WebSocket(`${fake.httpOrigin.replace('http:', 'ws:')}/realtime`, [
        'ai-gateway-realtime.v1',
        `ai-gateway-auth.${token}`
      ])
      const received = []
      let held
      let completed
      let admission
      let completionError
      let socketError
      socket.on('error', (error) => {
        socketError = error
      })
      socket.on('message', (data) => received.push(JSON.parse(data.toString())))
      try {
        await waitFor(() => socket.readyState === WebSocket.OPEN || socketError)
        if (socketError) throw socketError
        // Provider VAD offsets follow appended pcm16 duration, independently of
        // wall-clock delays before a scripted transcript is released.
        for (const bytes of [640, 320]) {
          socket.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: Buffer.alloc(bytes).toString('base64')
            })
          )
        }
        await waitFor(() => fake.state.audioAppends === 2)
        held = fake.holdNextRealtimeFinal()
        held.arrived.then((value) => {
          admission = value
        })
        completed = fake.emitRealtimeFinal('Delayed speech.')
        completed.catch((error) => {
          completionError = error
        })
        await waitFor(() => admission || completionError)
        if (completionError) throw completionError
        assert.equal(admission.text, 'Delayed speech.')
        await waitFor(() => received.some((event) => event.type === 'speech-started'))
        assert.equal(
          received.find((event) => event.type === 'speech-started').raw.audio_start_ms,
          20
        )
        assert.equal(
          received.some((event) => event.type === 'input-transcription-completed'),
          false
        )
        held.release()
        assert.equal(await completed, 1)
        await waitFor(() =>
          received.some((event) => event.type === 'input-transcription-completed')
        )
        assert.equal(received.at(-1).transcript, 'Delayed speech.')
      } finally {
        held?.release()
        if (completed) await Promise.allSettled([completed])
        socket.terminate()
        await fake.close()
      }
    }
  )

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

  it('pushes scripted realtime finals and can skip the canned transcript', async () => {
    const realtimeToken = 'fake-caption-realtime'
    const fake = await startFakeCaptionService({
      smokeSessionToken: 'fake-caption-session',
      smokeRealtimeToken: realtimeToken,
      autoTranscript: false
    })

    try {
      assert.equal(await fake.emitRealtimeFinal('Nobody is listening.'), 0)
      const socket = new WebSocket(`${fake.httpOrigin.replace('http:', 'ws:')}/realtime`, [
        'ai-gateway-realtime.v1',
        `ai-gateway-auth.${realtimeToken}`
      ])
      const received = []
      socket.on('message', (data) => received.push(JSON.parse(data.toString())))
      await new Promise((resolveOpen, rejectOpen) => {
        socket.once('open', resolveOpen)
        socket.once('error', rejectOpen)
      })
      socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }))
      await waitFor(() => fake.state.audioAppends === 1)

      assert.equal(await fake.emitRealtimeFinal('First scripted final.'), 1)
      assert.equal(await fake.emitRealtimeFinal('Second scripted final.'), 1)
      await waitFor(() => received.length === 4)
      socket.close()

      assert.deepEqual(
        received.map((event) => [event.type, event.itemId]),
        [
          ['speech-started', 'scripted-item-2'],
          ['input-transcription-completed', 'scripted-item-2'],
          ['speech-started', 'scripted-item-3'],
          ['input-transcription-completed', 'scripted-item-3']
        ]
      )
      assert.equal(received[1].transcript, 'First scripted final.')
      assert.equal(received[3].transcript, 'Second scripted final.')
      assert.equal(received[0].raw.item_id, 'scripted-item-2')
      assert.ok(received[0].raw.audio_start_ms >= 0)
      assert.deepEqual(
        fake.state.emittedFinals.map((final) => [final.text, final.reached]),
        [
          ['First scripted final.', 1],
          ['Second scripted final.', 1]
        ]
      )
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

  it('blocks only validated authenticated chunks and recovers when the retry fixture clears', async () => {
    const sessionToken = 'fake-caption-session'
    const fake = await startFakeCaptionService({
      smokeSessionToken: sessionToken,
      smokeRealtimeToken: 'fake-caption-realtime',
      chunkText: 'Retry recovered.'
    })
    const wav = pcm16Wav([0, 4_096, -8_192, 16_384])
    try {
      fake.state.chunkFailureCode = 'unauthorized'
      const auth = await postCaptionChunk(fake.httpOrigin, 'wrong-token', wav, {
        expectedStatus: 401
      })
      assert.equal(auth.error.code, 'unauthorized')
      const malformed = await postCaptionChunk(
        fake.httpOrigin,
        sessionToken,
        Buffer.from('invalid'),
        {
          expectedStatus: 400
        }
      )
      assert.equal(malformed.error.code, 'invalid-caption-wav')
      const purpose = await postCaptionChunk(fake.httpOrigin, sessionToken, wav, {
        purpose: 'unknown',
        expectedStatus: 400
      })
      assert.equal(purpose.error.code, 'invalid-caption-purpose')
      assert.equal(fake.state.chunkRequests, 0)
      const blocked = await postCaptionChunk(fake.httpOrigin, sessionToken, wav, {
        expectedStatus: 401
      })
      assert.equal(blocked.error.code, 'unauthorized')
      fake.state.chunkFailureCode = null
      const recovered = await postCaptionChunk(fake.httpOrigin, sessionToken, wav)
      assert.equal(recovered.text, 'Retry recovered.')
      assert.equal(fake.state.chunkRequests, 2)
      assert.deepEqual(fake.state.chunkPurposes, [null, null])
      assert.equal(fake.state.chunkAudio[0].peak, 0.5)
      assert.ok(!('audio' in fake.state.chunkAudio[0]))
    } finally {
      await fake.close()
    }
  })

  it('records the chunk purpose, defaults an absent one to captions, and refuses unknown ones', async () => {
    const sessionToken = 'fake-caption-session'
    const fake = await startFakeCaptionService({
      smokeSessionToken: sessionToken,
      smokeRealtimeToken: 'fake-caption-realtime'
    })
    const wav = pcm16Wav([0, 4_096, -8_192, 16_384])

    try {
      const listen = await postCaptionChunk(fake.httpOrigin, sessionToken, wav, {
        purpose: 'listen'
      })
      await postCaptionChunk(fake.httpOrigin, sessionToken, wav, { purpose: 'captions' })
      await postCaptionChunk(fake.httpOrigin, sessionToken, wav)
      const refused = await postCaptionChunk(fake.httpOrigin, sessionToken, wav, {
        purpose: 'recording',
        expectedStatus: 400
      })

      assert.equal(listen.text, 'Chunk fallback recovered.')
      assert.equal(refused.error.code, 'invalid-caption-purpose')
      assert.equal(fake.state.chunkRequests, 3, 'a refused purpose is not an accepted chunk')
      assert.deepEqual(fake.state.chunkPurposes, ['listen', 'captions', null])
      assert.deepEqual(
        fake.state.chunkAudio.map((audio) => audio.purpose),
        ['listen', 'captions', 'captions']
      )
      assert.equal(fake.state.chunkAudio[0].peak, 0.5, 'the WAV part still parses beside the field')
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

async function postCaptionChunk(origin, token, wav, { purpose, expectedStatus = 200 } = {}) {
  const form = new FormData()
  form.set('sessionClientId', 'fake-service-test')
  // Field order matches the desktop client: text fields, then the audio part.
  if (purpose !== undefined) form.set('purpose', purpose)
  form.set('audio', new Blob([wav], { type: 'audio/wav' }), 'caption.wav')
  const response = await fetch(`${origin}/api/ai/captions/chunks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  })
  assert.equal(response.status, expectedStatus)
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

async function waitFor(probe, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the fake caption service.')
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}
