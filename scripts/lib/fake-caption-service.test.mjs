import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import WebSocket from 'ws'

import { ORCLE_COMMAND_FINALS, startFakeCaptionService } from './fake-caption-service.mjs'

const SESSION_TOKEN = 'fake-caption-session'
const REALTIME_TOKEN = 'fake-caption-realtime'

describe('fake caption service', () => {
  it(
    'holds a scripted speech completion behind an explicit response barrier',
    { timeout: 10_000 },
    async () => {
      const fake = await startFakeCaptionService({
        smokeSessionToken: SESSION_TOKEN,
        smokeRealtimeToken: REALTIME_TOKEN,
        autoTranscript: false
      })
      const socket = new WebSocket(gatewayUrl(fake), gatewayProtocols(REALTIME_TOKEN))
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
        socket.send(JSON.stringify(startFrame()))
        await waitFor(() => received.some((part) => part.type === 'stream-start'))
        // Utterance starts follow the binary PCM duration (16 kHz s16le: 640
        // bytes = 20 ms), independently of wall-clock delays before a
        // scripted transcript is released.
        for (const bytes of [640, 320]) socket.send(Buffer.alloc(bytes))
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
        await waitFor(() => received.some((part) => part.type === 'transcript-partial'))
        const opening = received.find((part) => part.type === 'transcript-partial')
        assert.equal(opening.startSecond, 0.02)
        assert.equal(opening.text, '')
        assert.equal(
          received.some((part) => part.type === 'transcript-final'),
          false
        )
        held.release()
        assert.equal(await completed, 1)
        await waitFor(() => received.some((part) => part.type === 'transcript-final'))
        assert.equal(received.at(-1).text, 'Delayed speech.')
        assert.equal(received.at(-1).id, opening.id)
      } finally {
        held?.release()
        if (completed) await Promise.allSettled([completed])
        socket.terminate()
        await fake.close()
      }
    }
  )

  it('streams opt-in partial progress while keeping held scripted finals authoritative', async () => {
    const fake = await startFakeCaptionService({
      smokeSessionToken: SESSION_TOKEN,
      smokeRealtimeToken: REALTIME_TOKEN,
      autoTranscript: false
    })
    const sockets = []
    let held
    let completed
    const observations = {}
    try {
      fake.state.realtimePartialProgress = true
      const first = await openProgressSocket(fake)
      sockets.push(first.socket)
      await appendProgressFrame(first.socket)
      observations.first = [...first.received]

      held = fake.holdNextRealtimeFinal()
      completed = fake.emitRealtimeFinal('The held scripted utterance is exact.')
      completed.catch(() => {})
      await boundedFixture(held.arrived, 'scripted speech admission')
      await appendProgressFrame(first.socket)
      observations.held = [...first.received]
      observations.heldFinals = fake.state.emittedFinals.length

      fake.state.realtimePartialProgress = false
      await appendProgressFrame(first.socket)
      observations.disabled = [...first.received]
      held.release()
      observations.reached = await boundedFixture(completed, 'scripted final release')
      await progressSocketBarrier(first.socket)
      observations.released = [...first.received]
      await closeProgressSocket(first.socket)
      observations.closedReached = await fake.emitRealtimeFinal(
        'No closed socket may receive this.'
      )

      fake.state.realtimePartialProgress = true
      const second = await openProgressSocket(fake)
      sockets.push(second.socket)
      await appendProgressFrame(second.socket)
      observations.second = [...second.received]
      observations.audioAppends = fake.state.audioAppends
      observations.emittedFinals = [...fake.state.emittedFinals]
    } finally {
      held?.release()
      const outcomes = await Promise.allSettled([
        ...(completed
          ? [boundedFixture(Promise.allSettled([completed]), 'owned final cleanup')]
          : []),
        ...sockets.map((socket) => closeProgressSocket(socket)),
        boundedFixture(fake.close(), 'owned fake cleanup')
      ])
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((outcome) => outcome.reason),
          'Owned progress fixture cleanup failed after every owner was attempted.'
        )
      }
    }

    // Progress partials carry text; a scripted utterance opens with an empty one.
    const partials = (rows) =>
      rows.filter((part) => part.type === 'transcript-partial' && part.text !== '')
    const finals = (rows) => rows.filter((part) => part.type === 'transcript-final')
    assert.equal(
      partials(observations.first).length,
      1,
      'accepted PCM must produce an opt-in partial'
    )
    const progressStart = partials(observations.first)[0]
    assert.equal(progressStart.startSecond, 0)
    assert.equal(partials(observations.held).length, 2)
    assert.ok(partials(observations.held).every((part) => part.id === progressStart.id))
    assert.equal(finals(observations.held).length, 0, 'progress must not complete held speech')
    assert.equal(observations.heldFinals, 0)
    assert.equal(
      partials(observations.disabled).length,
      2,
      'disabled progress must stop at its owner'
    )
    assert.equal(observations.reached, 1)
    assert.equal(finals(observations.released).length, 1)
    assert.equal(finals(observations.released)[0].text, 'The held scripted utterance is exact.')
    assert.equal(
      observations.emittedFinals.length,
      1,
      'partials never mint canonical scripted finals'
    )
    assert.equal(observations.closedReached, 0)
    assert.equal(partials(observations.second).length, 1)
    assert.equal(partials(observations.second)[0].startSecond, 0)
    assert.equal(finals(observations.second).length, 0)
    assert.equal(observations.audioAppends, 4)
  })

  it('keeps partial progress disabled for an ordinary scripted-only socket', async () => {
    const fake = await startFakeCaptionService({
      smokeSessionToken: SESSION_TOKEN,
      smokeRealtimeToken: REALTIME_TOKEN,
      autoTranscript: false
    })
    let socket
    let received
    try {
      const owner = await openProgressSocket(fake)
      socket = owner.socket
      await appendProgressFrame(socket)
      received = [...owner.received]
    } finally {
      const outcomes = await Promise.allSettled([
        ...(socket ? [closeProgressSocket(socket)] : []),
        boundedFixture(fake.close(), 'ordinary fake cleanup')
      ])
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((outcome) => outcome.reason),
          'Ordinary progress fixture cleanup failed after every owner was attempted.'
        )
      }
    }
    assert.deepEqual(
      received.map((part) => part.type),
      ['stream-start']
    )
    assert.equal(fake.state.audioAppends, 1)
    assert.equal(fake.state.emittedFinals.length, 0)
  })

  it('mints leased transcription tokens and refuses desktops without the dialect', async () => {
    const fake = await startFakeCaptionService({
      smokeSessionToken: SESSION_TOKEN,
      smokeRealtimeToken: REALTIME_TOKEN
    })

    try {
      const legacy = await mint(fake, { sessionClientId: 'fake-service-test' })
      assert.equal(legacy.status, 503)
      assert.equal((await legacy.json()).error.code, 'captions-realtime-unavailable')

      const response = await mint(fake, {
        sessionClientId: 'fake-service-test',
        transport: 'transcription',
        language: 'en'
      })
      assert.equal(response.status, 200)
      const minted = await response.json()
      assert.equal(minted.transport, 'transcription')
      assert.equal(minted.leaseSeconds, 600)
      assert.match(minted.leaseId, /^smoke-lease-/)
      assert.deepEqual(minted.inputAudioFormat, { type: 'audio/pcm', rate: 16_000 })
      assert.deepEqual(minted.subprotocols, gatewayProtocols(REALTIME_TOKEN))
      assert.match(minted.url, /\/v4\/ai\/transcription-model\?ai-model-id=/)
      assert.deepEqual(fake.state.mintBodies.at(-1), {
        transport: 'transcription',
        language: 'en',
        hasSessionClientId: true
      })

      fake.state.realtimeDialect = 'voice'
      const voice = await (await mint(fake, { sessionClientId: 'fake-service-test' })).json()
      assert.equal(voice.transport, undefined)
      assert.match(voice.url, /\/realtime-model/)

      const gateway = new WebSocket(minted.url, minted.subprotocols)
      const finish = await startAndFinish(gateway)
      assert.equal(finish.type, 'finish')
      assert.equal(finish.durationInSeconds, 0.02)

      assert.equal(fake.state.realtimeTokenRequests, 3)
      assert.equal(fake.state.leases.length, 1)
      assert.equal(fake.state.realtimeConnections, 1)
      assert.equal(fake.state.configurations.length, 1)
      assert.equal(fake.state.audioDoneFrames, 1)
    } finally {
      await fake.close()
    }
  })

  it('closes a socket whose first frame is not the stream start', async () => {
    const fake = await startFakeCaptionService({
      smokeSessionToken: SESSION_TOKEN,
      smokeRealtimeToken: REALTIME_TOKEN
    })
    try {
      const socket = new WebSocket(gatewayUrl(fake), gatewayProtocols(REALTIME_TOKEN))
      await new Promise((resolveOpen, rejectOpen) => {
        socket.once('open', resolveOpen)
        socket.once('error', rejectOpen)
      })
      const closed = new Promise((resolveClose) =>
        socket.once('close', (code) => resolveClose(code))
      )
      socket.send(JSON.stringify({ type: 'session.update', session: {} }))
      assert.equal(await boundedFixture(closed, 'policy close'), 1008)
      assert.equal(fake.state.invalidStarts, 1)
      assert.equal(fake.state.configurations.length, 0)
    } finally {
      await fake.close()
    }
  })

  it('settles leases by id, clamps them, and keeps the retired body refused', async () => {
    const fake = await startFakeCaptionService({
      smokeSessionToken: SESSION_TOKEN,
      smokeRealtimeToken: REALTIME_TOKEN
    })
    try {
      const minted = await (
        await mint(fake, { sessionClientId: 'fake-service-test', transport: 'transcription' })
      ).json()
      const legacy = await settle(fake, { sessionClientId: 'fake-service-test', seconds: 9 })
      assert.equal(legacy.status, 503)
      assert.equal((await legacy.json()).error.code, 'captions-realtime-metering-unavailable')
      const unknown = await settle(fake, { leaseId: 'nope', durationSeconds: 3 })
      assert.equal(unknown.status, 404)
      const settled = await (
        await settle(fake, { leaseId: minted.leaseId, durationSeconds: 12.2 })
      ).json()
      assert.deepEqual(settled, {
        leaseId: minted.leaseId,
        refundedSeconds: 587,
        settledSeconds: 13
      })
      const clamped = await (
        await settle(fake, { leaseId: minted.leaseId, durationSeconds: 9_999 })
      ).json()
      assert.equal(clamped.settledSeconds, 600)
      assert.equal(fake.state.settlements.length, 2)
      assert.equal(fake.state.legacyUsageReports, 1)
    } finally {
      await fake.close()
    }
  })

  it('rejects an unauthenticated streaming upgrade without exposing token material', async () => {
    const fake = await startFakeCaptionService({
      smokeSessionToken: SESSION_TOKEN,
      smokeRealtimeToken: REALTIME_TOKEN
    })

    try {
      for (const [url, protocols] of [
        [gatewayUrl(fake), undefined],
        [`${fake.httpOrigin.replace('http:', 'ws:')}/realtime`, gatewayProtocols(REALTIME_TOKEN)],
        [gatewayUrl(fake), ['ai-gateway-realtime.v1', `ai-gateway-auth.${REALTIME_TOKEN}`]]
      ]) {
        const socket = new WebSocket(url, protocols)
        const error = await new Promise((resolveError) => {
          socket.once('error', resolveError)
        })
        assert.match(String(error), /401/)
        assert.doesNotMatch(String(error), new RegExp(REALTIME_TOKEN))
      }
      assert.equal(fake.state.realtimeUpgradeAttempts, 3)
      assert.equal(fake.state.realtimeConnections, 0)
    } finally {
      await fake.close()
    }
  })

  it('pushes scripted realtime finals and can skip the canned transcript', async () => {
    const fake = await startFakeCaptionService({
      smokeSessionToken: SESSION_TOKEN,
      smokeRealtimeToken: REALTIME_TOKEN,
      autoTranscript: false
    })

    try {
      assert.equal(await fake.emitRealtimeFinal('Nobody is listening.'), 0)
      const socket = new WebSocket(gatewayUrl(fake), gatewayProtocols(REALTIME_TOKEN))
      const received = []
      socket.on('message', (data) => received.push(JSON.parse(data.toString())))
      await new Promise((resolveOpen, rejectOpen) => {
        socket.once('open', resolveOpen)
        socket.once('error', rejectOpen)
      })
      socket.send(JSON.stringify(startFrame()))
      socket.send(Buffer.alloc(4))
      await waitFor(() => fake.state.audioAppends === 1)
      const parts = () => received.filter((part) => part.type !== 'stream-start')

      assert.equal(await fake.emitRealtimeFinal('First scripted final.'), 1)
      assert.equal(await fake.emitRealtimeFinal('Second scripted final.'), 1)
      await waitFor(() => parts().length === 4)
      // Plan 140 S9: one spoken command split across two finals, in order.
      const split = ORCLE_COMMAND_FINALS.highlightByNameSplit
      assert.deepEqual(await fake.emitRealtimeFinals(split, { gapMs: 5 }), [1, 1])
      await waitFor(() => parts().length === 8)
      assert.deepEqual(
        parts()
          .filter((part) => part.type === 'transcript-final')
          .slice(2)
          .map((part) => part.text),
        ['Orcle, highlight the comment', 'from coders X.']
      )
      socket.close()

      const first = parts().slice(0, 4)
      assert.deepEqual(
        first.map((part) => [part.type, part.id]),
        [
          ['transcript-partial', 'scripted-item-2'],
          ['transcript-final', 'scripted-item-2'],
          ['transcript-partial', 'scripted-item-3'],
          ['transcript-final', 'scripted-item-3']
        ]
      )
      assert.equal(first[1].text, 'First scripted final.')
      assert.equal(first[3].text, 'Second scripted final.')
      assert.equal(first[0].text, '')
      assert.ok(first[0].startSecond >= 0)
      assert.deepEqual(
        fake.state.emittedFinals.map((final) => [final.text, final.reached]),
        [
          ['First scripted final.', 1],
          ['Second scripted final.', 1],
          ['Orcle, highlight the comment', 1],
          ['from coders X.', 1]
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

async function boundedFixture(promise, label) {
  let deadline
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000)
      })
    ])
  } finally {
    clearTimeout(deadline)
  }
}

function gatewayUrl(fake) {
  return `${fake.httpOrigin.replace('http:', 'ws:')}/v4/ai/transcription-model?ai-model-id=smoke`
}

function gatewayProtocols(token) {
  return ['ai-gateway-transcription.v1', `ai-gateway-auth.${token}`]
}

function startFrame(rate = 16_000) {
  return { type: 'transcription-stream.start', inputAudioFormat: { type: 'audio/pcm', rate } }
}

function mint(fake, body) {
  return fetch(`${fake.httpOrigin}/api/ai/captions/realtime-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SESSION_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function settle(fake, body) {
  return fetch(`${fake.httpOrigin}/api/ai/captions/usage`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SESSION_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function openProgressSocket(fake) {
  const socket = new WebSocket(gatewayUrl(fake), gatewayProtocols(REALTIME_TOKEN))
  const received = []
  socket.on('message', (data) => received.push(JSON.parse(data.toString())))
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  try {
    await boundedFixture(opened, 'owned socket readiness')
    socket.send(JSON.stringify(startFrame()))
    await progressSocketBarrier(socket)
    return { socket, received }
  } catch (error) {
    await closeProgressSocket(socket, true)
    throw error
  }
}

async function progressSocketBarrier(socket) {
  // The pong follows the server's synchronous handling of preceding config/PCM.
  const pong = new Promise((resolve, reject) => {
    socket.once('pong', resolve)
    socket.once('error', reject)
  })
  socket.ping()
  await boundedFixture(pong, 'owned socket response barrier')
}

async function appendProgressFrame(socket) {
  socket.send(Buffer.alloc(640, 1))
  await progressSocketBarrier(socket)
}

async function closeProgressSocket(socket, force = false) {
  if (socket.readyState === WebSocket.CLOSED) return
  const closed = new Promise((resolve) => socket.once('close', resolve))
  try {
    if (force) socket.terminate()
    else socket.close()
    // A graceful reply proves the server observed Close before an emit probe.
    await boundedFixture(closed, 'owned socket close handshake')
  } catch (error) {
    socket.terminate()
    try {
      await boundedFixture(closed, 'forced owned socket cleanup')
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Owned socket close and cleanup failed.')
    }
    throw error
  }
}

/** Start a stream, send 20 ms of PCM, end it, and return the `finish` part. */
function startAndFinish(socket) {
  return new Promise((resolveFinish, rejectFinish) => {
    const timeout = setTimeout(() => {
      socket.terminate()
      rejectFinish(new Error('Timed out waiting for the fake stream to finish.'))
    }, 5_000)
    let finish
    socket.once('error', (error) => {
      clearTimeout(timeout)
      rejectFinish(error)
    })
    socket.once('open', () => socket.send(JSON.stringify(startFrame())))
    socket.on('message', (data) => {
      const part = JSON.parse(data.toString())
      if (part.type === 'stream-start') {
        socket.send(Buffer.alloc(640))
        socket.send(JSON.stringify({ type: 'transcription-stream.audio-done' }))
      }
      if (part.type === 'finish') finish = part
    })
    socket.once('close', (code) => {
      clearTimeout(timeout)
      if (code !== 1000 || !finish) {
        rejectFinish(new Error(`The fake stream closed ${code} without a finish part.`))
        return
      }
      resolveFinish(finish)
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
