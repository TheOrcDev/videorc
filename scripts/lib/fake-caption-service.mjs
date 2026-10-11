import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

import { inspectMultipartPcm16Wav } from './audio-amplitude.mjs'

/**
 * Local, credential-free caption service used by maintained app smokes.
 * It mirrors the authenticated Videorc HTTP routes plus the Gateway's
 * streaming-transcription WebSocket envelope (plan 175) without ever touching
 * production or logging transcript, bearer, or client-token material.
 *
 * Streaming contract it enforces, like the web and the Gateway:
 * - the mint body must say `transport: "transcription"` (older desktops get
 *   503 `captions-realtime-unavailable`); each mint reserves a lease;
 * - the socket path is `/v4/ai/transcription-model` with the
 *   `ai-gateway-transcription.v1` + `ai-gateway-auth.<token>` subprotocols;
 * - the first frame is a `transcription-stream.start` TEXT frame, audio rides
 *   BINARY frames, `transcription-stream.audio-done` ends it with a `finish`
 *   part carrying the consumed duration and a 1000 close;
 * - `/api/ai/captions/usage` settles a lease by id.
 * `realtimeDialect = 'voice'` mints the retired voice-model token shape (no
 * `transport`) so a smoke can prove the desktop falls back to chunks.
 *
 * Chunk uploads carry an optional multipart `purpose` (plan 068 D5):
 * `captions` (the default when absent, like an older desktop) or `listen`
 * (Buddy's listen intent, metered apart on the real service). Anything else
 * is refused with 400 like the web route. `state.chunkPurposes` records what
 * each accepted upload sent (`null` when the field was absent) and every
 * `state.chunkAudio` entry carries the effective purpose.
 */
export async function startFakeCaptionService({
  smokeSessionToken,
  smokeRealtimeToken,
  finalText = 'Caption contract passed.',
  provisionalFinalText = 'Caption contract',
  chunkText = 'Chunk fallback recovered.',
  itemId = 'caption-contract-item',
  minSpeechPeak = null,
  // false: the first audio frame no longer triggers the canned transcript;
  // finals come only from `emitRealtimeFinal` (the co-host spotlight smoke).
  autoTranscript = true
}) {
  const state = {
    realtimeAvailable: true,
    realtimeFailureCode: 'captions-realtime-unavailable',
    realtimeDialect: 'transcription',
    inputRate: 16_000,
    leaseSeconds: 600,
    // `transcription-stream.start` frames, one per socket.
    configurations: [],
    mintBodies: [],
    leases: [],
    settlements: [],
    legacyUsageReports: 0,
    realtimeTokenRequests: 0,
    realtimeUpgradeAttempts: 0,
    realtimeConnections: 0,
    invalidStarts: 0,
    // Binary audio frames (the name predates the envelope).
    audioAppends: 0,
    emptyAudioAppends: 0,
    audioBytes: 0,
    audioDoneFrames: 0,
    finishParts: 0,
    assistantResponseOnNextAudio: false,
    assistantResponses: 0,
    realtimePartialProgress: false,
    chunkRequests: 0,
    chunkFinals: [],
    chunkFailureCode: null,
    chunkAudio: [],
    chunkPurposes: [],
    usageReports: 0,
    commandRequests: 0,
    emittedFinals: []
  }
  let scriptedItemSeq = 0
  let leaseSeq = 0
  const finalHolds = []
  const activeFinalHolds = new Set()
  const gatewayProtocol = 'ai-gateway-transcription.v1'
  const gatewayAuthProtocol = `ai-gateway-auth.${smokeRealtimeToken}`
  const realtime = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has(gatewayProtocol) && protocols.has(gatewayAuthProtocol)
        ? gatewayProtocol
        : false
    }
  })
  let websocketUrl = ''
  const server = createServer(async (req, res) => {
    // Count the fake service route separately from the dev smoke-command listener.
    if (req.method === 'POST' && req.url === '/api/ai/cohost/' + 'command')
      state.commandRequests += 1
    if (req.headers.authorization !== `Bearer ${smokeSessionToken}`) {
      await drain(req)
      return json(res, 401, { error: { code: 'unauthorized', message: 'Smoke auth failed.' } })
    }
    if (req.method === 'POST' && req.url === '/api/ai/captions/realtime-token') {
      const body = await readJsonBody(req)
      state.realtimeTokenRequests += 1
      state.mintBodies.push({
        transport: body?.transport ?? null,
        language: body?.language ?? null,
        hasSessionClientId: typeof body?.sessionClientId === 'string'
      })
      if (!state.realtimeAvailable) {
        return json(res, 503, {
          error: {
            code: state.realtimeFailureCode,
            message: 'Realtime is deliberately unavailable in the fallback scenario.'
          }
        })
      }
      if (state.realtimeDialect === 'voice') {
        return json(res, 200, {
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          model: 'smoke/voice-realtime',
          quotaEnforced: false,
          token: smokeRealtimeToken,
          url: websocketUrl.replace('/transcription-model', '/realtime-model')
        })
      }
      if (body?.transport !== 'transcription') {
        return json(res, 503, {
          error: {
            code: 'captions-realtime-unavailable',
            message: 'This desktop does not speak the streaming transcription dialect.'
          }
        })
      }
      const leaseId = `smoke-lease-${++leaseSeq}`
      state.leases.push({ leaseId, leaseSeconds: state.leaseSeconds, at: Date.now() })
      return json(res, 200, {
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        inputAudioFormat: { type: 'audio/pcm', rate: state.inputRate },
        leaseId,
        leaseSeconds: state.leaseSeconds,
        model: 'smoke/streaming-transcription',
        providerOptions: {
          smoke: { streaming: { interimResults: true } },
          gateway: { tags: ['feature:captions', 'env:smoke'] }
        },
        quotaEnforced: true,
        remainingSeconds: 3_000,
        subprotocols: [gatewayProtocol, gatewayAuthProtocol],
        token: smokeRealtimeToken,
        transport: 'transcription',
        url: websocketUrl
      })
    }
    if (req.method === 'POST' && req.url === '/api/ai/captions/chunks') {
      let body
      let audio
      try {
        body = await readRequestBody(req)
        audio = inspectMultipartPcm16Wav(body)
      } catch (error) {
        return json(res, 400, {
          error: { code: 'invalid-caption-wav', message: error.message }
        })
      }
      const purpose = readMultipartTextField(body, req.headers['content-type'], 'purpose')
      if (purpose !== null && !CHUNK_PURPOSES.has(purpose)) {
        return json(res, 400, {
          error: { code: 'invalid-caption-purpose', message: 'Unknown caption chunk purpose.' }
        })
      }
      state.chunkRequests += 1
      state.chunkPurposes.push(purpose)
      state.chunkAudio.push({ ...audio, purpose: purpose ?? 'captions' })
      // Controlled terminal retry after a validated, authenticated upload.
      // Retain the same reduced request evidence as successful chunks.
      if (state.chunkFailureCode) {
        return json(res, state.chunkFailureCode === 'unauthorized' ? 401 : 503, {
          error: {
            code: state.chunkFailureCode,
            message: 'Chunk transcription is deliberately blocked in the retry scenario.'
          }
        })
      }
      const hasSpeech = !Number.isFinite(minSpeechPeak) || audio.peak >= Math.max(0, minSpeechPeak)
      const scripted = state.chunkFinals.shift()
      const text = hasSpeech ? (scripted?.text ?? chunkText) : ''
      if (scripted?.delayMs > 0)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, scripted.delayMs))
      return json(res, 200, {
        chunkSeconds: 3,
        latencyMs: 5,
        model: 'smoke/chunk-transcription',
        monthlySecondsLimit: 3_600,
        remainingSeconds: 3_597,
        segments: text ? (scripted?.segments ?? [{ text, startSecond: 0, endSecond: 3 }]) : [],
        text
      })
    }
    if (req.method === 'POST' && req.url === '/api/ai/captions/usage') {
      const body = await readJsonBody(req)
      state.usageReports += 1
      if (typeof body?.leaseId !== 'string') {
        state.legacyUsageReports += 1
        return json(res, 503, {
          error: {
            code: 'captions-realtime-metering-unavailable',
            message:
              'Realtime captions are unavailable until server-side usage metering is enabled.'
          }
        })
      }
      const lease = state.leases.find((candidate) => candidate.leaseId === body.leaseId)
      if (!lease) {
        return json(res, 404, {
          error: { code: 'captions-lease-not-found', message: 'Unknown caption lease.' }
        })
      }
      const settledSeconds = Math.min(
        Math.ceil(Math.max(Number(body.durationSeconds) || 0, 0)),
        lease.leaseSeconds
      )
      state.settlements.push({ leaseId: body.leaseId, durationSeconds: body.durationSeconds })
      return json(res, 200, {
        leaseId: body.leaseId,
        refundedSeconds: lease.leaseSeconds - settledSeconds,
        settledSeconds
      })
    }
    await drain(req)
    return json(res, 404, { error: { code: 'not-found', message: 'Unknown smoke route.' } })
  })

  server.on('upgrade', (req, socket, head) => {
    state.realtimeUpgradeAttempts += 1
    const protocols = new Set(
      String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((protocol) => protocol.trim())
        .filter(Boolean)
    )
    const path = String(req.url ?? '').split('?')[0]
    if (
      path !== '/v4/ai/transcription-model' ||
      !protocols.has(gatewayProtocol) ||
      !protocols.has(gatewayAuthProtocol)
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    realtime.handleUpgrade(req, socket, head, (ws) => realtime.emit('connection', ws, req))
  })

  const audioTimeline = new WeakMap()
  realtime.on('connection', (ws) => {
    state.realtimeConnections += 1
    const timeline = { sentMs: 0, lastStartMs: 0, rate: state.inputRate, started: false }
    audioTimeline.set(ws, timeline)
    let transcriptSent = false
    let progressStarted = false
    const progressItemId = `${itemId}-progress`
    const send = (part) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(part))
    }
    ws.on('message', (data, isBinary) => {
      if (!timeline.started) {
        let start = null
        if (!isBinary) {
          try {
            start = JSON.parse(data.toString())
          } catch {
            start = null
          }
        }
        if (start?.type !== 'transcription-stream.start' || !start.inputAudioFormat?.type) {
          state.invalidStarts += 1
          ws.close(1008, 'first frame must be transcription-stream.start')
          return
        }
        timeline.started = true
        timeline.rate = Number(start.inputAudioFormat.rate) || state.inputRate
        state.configurations.push(start)
        send({ type: 'stream-start', warnings: [] })
        return
      }
      if (!isBinary) {
        let message
        try {
          message = JSON.parse(data.toString())
        } catch {
          return
        }
        if (message.type === 'transcription-stream.audio-done') {
          state.audioDoneFrames += 1
          state.finishParts += 1
          send({
            type: 'finish',
            text: '',
            segments: [],
            durationInSeconds: Math.round(timeline.sentMs) / 1000
          })
          ws.close(1000)
        }
        return
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data)
      state.audioAppends += 1
      state.audioBytes += bytes.length
      if (bytes.length === 0) state.emptyAudioAppends += 1
      timeline.lastStartMs = timeline.sentMs
      timeline.sentMs += (bytes.length / (timeline.rate * 2)) * 1000
      if (state.assistantResponseOnNextAudio) {
        state.assistantResponseOnNextAudio = false
        state.assistantResponses += 1
        send({ type: 'response-created', id: 'unsafe-assistant-response' })
        return
      }
      // Scripted speech fixtures keep their provider productive while PCM
      // continues between exact finals. Partials never finalize extra words.
      if (state.realtimePartialProgress && bytes.length > 0) {
        if (!progressStarted) progressStarted = true
        send({
          type: 'transcript-partial',
          id: progressItemId,
          text: 'Fixture speech is still in progress.',
          startSecond: timeline.lastStartMs / 1000
        })
      }
      if (transcriptSent || !autoTranscript) return
      transcriptSent = true
      send({ type: 'transcript-partial', id: itemId, text: provisionalFinalText, startSecond: 0 })
      // Two finals for one item: the backend must upsert one canonical cue.
      setTimeout(
        () =>
          send({
            type: 'transcript-final',
            id: itemId,
            text: provisionalFinalText,
            startSecond: 0,
            endSecond: timeline.sentMs / 1000
          }),
        25
      )
      setTimeout(
        () =>
          send({
            type: 'transcript-final',
            id: itemId,
            text: finalText,
            startSecond: 0,
            endSecond: timeline.sentMs / 1000
          }),
        75
      )
    })
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const httpOrigin = `http://127.0.0.1:${port}`
  websocketUrl = `ws://127.0.0.1:${port}/v4/ai/transcription-model?ai-model-id=smoke%2Fstreaming-transcription`

  return {
    state,
    httpOrigin,
    holdNextRealtimeFinal() {
      let acknowledge
      let release
      const arrived = new Promise((resolve) => {
        acknowledge = resolve
      })
      const released = new Promise((resolve) => {
        release = resolve
      })
      const hold = { acknowledge, released, release }
      finalHolds.push(hold)
      activeFinalHolds.add(hold)
      return { arrived, release }
    },
    /**
     * Push one scripted utterance to every open streaming client: an empty
     * partial that opens a fresh item at the latest audio (the envelope's
     * speech start), then its final transcript (the backend's final).
     * Resolves with the number of clients reached, after the final was
     * written.
     */
    emitRealtimeFinal: async (text) => {
      const scriptedItemId = `scripted-item-${++scriptedItemSeq}`
      let reached = 0
      for (const client of realtime.clients) {
        if (client.readyState !== 1 || !audioTimeline.get(client)?.started) continue
        const audioStartMs = audioTimeline.get(client)?.lastStartMs ?? 0
        client.send(
          JSON.stringify({
            type: 'transcript-partial',
            id: scriptedItemId,
            text: '',
            startSecond: audioStartMs / 1000
          })
        )
        reached += 1
      }
      if (reached === 0) return 0
      const hold = finalHolds.shift()
      if (hold) {
        hold.acknowledge({ itemId: scriptedItemId, text, reached })
        await hold.released
        activeFinalHolds.delete(hold)
      } else {
        await new Promise((resolveGap) => setTimeout(resolveGap, 25))
      }
      for (const client of realtime.clients) {
        if (client.readyState !== 1 || !audioTimeline.get(client)?.started) continue
        client.send(
          JSON.stringify({
            type: 'transcript-final',
            id: scriptedItemId,
            text,
            startSecond: (audioTimeline.get(client)?.lastStartMs ?? 0) / 1000
          })
        )
      }
      state.emittedFinals.push({ itemId: scriptedItemId, text, at: Date.now(), reached })
      return reached
    },
    /**
     * Push several scripted utterances in order, `gapMs` apart: one spoken
     * sentence the speech model cut into finals (plan 140 S9: a voice command
     * split across two chunks still completes). Resolves with the clients
     * each final reached.
     */
    async emitRealtimeFinals(texts, { gapMs = 600 } = {}) {
      const reached = []
      for (const [index, text] of texts.entries()) {
        if (index > 0) await new Promise((resolveGap) => setTimeout(resolveGap, gapMs))
        reached.push(await this.emitRealtimeFinal(text))
      }
      return reached
    },
    close: async () => {
      for (const hold of activeFinalHolds) hold.release()
      for (const client of realtime.clients) client.terminate()
      realtime.close()
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  }
}

const CHUNK_PURPOSES = new Set(['captions', 'listen'])

/**
 * Plan 140 S9: Buddy voice commands as a speech model delivers them. The
 * first is one command cut into two finals; the wake word starts the first.
 */
export const BUDDY_COMMAND_FINALS = Object.freeze({
  highlightByNameSplit: Object.freeze(['Buddy, highlight the comment', 'from coders X.']),
  clear: Object.freeze(['Buddy, clear the highlight.']),
  removeThisOne: Object.freeze(['This one is toxic. Remove it from our chat.']),
  confirm: Object.freeze(['Yes.']),
  cancel: Object.freeze(['No.']),
  highlightThisOne: Object.freeze(['Buddy, put this one up.']),
  namedMarker: Object.freeze(['Buddy, make a marker here for Shadcn New Library.']),
  negatedMarker: Object.freeze(["Buddy, don't make a marker for this topic."])
})

/**
 * The value of one plain (non-file) multipart/form-data field, or null when
 * the body has no such field. Binary-safe: parts are located on the raw
 * bytes, so the WAV part never goes through a string conversion.
 */
function readMultipartTextField(body, contentType, fieldName) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ''))
  if (!match) return null
  const delimiter = Buffer.from(`--${match[1] ?? match[2]}`)
  let cursor = body.indexOf(delimiter)
  while (cursor >= 0) {
    const partStart = cursor + delimiter.length
    const next = body.indexOf(delimiter, partStart)
    if (next < 0) return null
    const part = body.subarray(partStart, next)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('latin1')
      const disposition = /^content-disposition:(.*)$/im.exec(headers)?.[1] ?? ''
      const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1]
      if (name === fieldName && !/;\s*filename=/i.test(disposition)) {
        const value = part.subarray(headerEnd + 4)
        const trimmed =
          value.subarray(-2).toString('latin1') === '\r\n' ? value.subarray(0, -2) : value
        return trimmed.toString('utf8')
      }
    }
    cursor = next
  }
  return null
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json'
  })
  res.end(body)
}

function drain(req) {
  return new Promise((resolveDrain) => {
    req.on('data', () => {})
    req.on('end', resolveDrain)
    req.on('error', resolveDrain)
  })
}

async function readJsonBody(req) {
  try {
    const body = await readRequestBody(req, 64 * 1024)
    return body.length ? JSON.parse(body.toString('utf8')) : null
  } catch {
    return null
  }
}

async function readRequestBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > maxBytes) throw new Error('Caption upload exceeded the fake service limit.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
