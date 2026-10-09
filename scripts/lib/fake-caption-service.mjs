import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

import { inspectMultipartPcm16Wav } from './audio-amplitude.mjs'

/**
 * Local, credential-free caption service used by maintained app smokes.
 * It mirrors the authenticated Videorc HTTP routes plus the legacy Gateway
 * realtime dialect without ever touching production or logging transcript,
 * bearer, or client-token material.
 *
 * Chunk uploads carry an optional multipart `purpose` (plan 068 D5):
 * `captions` (the default when absent, like an older desktop) or `listen`
 * (Golem's listen intent, metered apart on the real service). Anything else
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
  // false: the first audio append no longer triggers the canned transcript;
  // finals come only from `emitRealtimeFinal` (the co-host spotlight smoke).
  autoTranscript = true
}) {
  const state = {
    realtimeAvailable: true,
    realtimeFailureCode: 'captions-realtime-unavailable',
    configurations: [],
    realtimeTokenRequests: 0,
    realtimeUpgradeAttempts: 0,
    realtimeConnections: 0,
    audioAppends: 0,
    emptyAudioAppends: 0,
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
  const finalHolds = []
  const activeFinalHolds = new Set()
  const gatewayProtocol = 'ai-gateway-realtime.v1'
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
      await drain(req)
      state.realtimeTokenRequests += 1
      if (!state.realtimeAvailable) {
        return json(res, 503, {
          error: {
            code: state.realtimeFailureCode,
            message: 'Realtime is deliberately unavailable in the fallback scenario.'
          }
        })
      }
      return json(res, 200, {
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        model: 'smoke/realtime-transcription',
        quotaEnforced: false,
        token: smokeRealtimeToken,
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
      await drain(req)
      state.usageReports += 1
      return json(res, 200, { ok: true })
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
    if (
      req.url !== '/realtime' ||
      (req.headers.authorization !== `Bearer ${smokeRealtimeToken}` &&
        (!protocols.has(gatewayProtocol) || !protocols.has(gatewayAuthProtocol)))
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
    audioTimeline.set(ws, { sentMs: 0, lastStartMs: 0 })
    let transcriptSent = false
    let progressStarted = false
    const progressItemId = `${itemId}-progress`
    ws.on('message', (data) => {
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      if (message.type === 'session.update') {
        state.configurations.push(message)
        ws.send(JSON.stringify({ type: 'session-updated' }))
        return
      }
      if (message.type !== 'input_audio_buffer.append') return
      state.audioAppends += 1
      const timeline = audioTimeline.get(ws)
      timeline.lastStartMs = timeline.sentMs
      timeline.sentMs +=
        Buffer.from(typeof message.audio === 'string' ? message.audio : '', 'base64').length / 32
      if (typeof message.audio !== 'string' || message.audio.length === 0) {
        state.emptyAudioAppends += 1
      }
      if (state.assistantResponseOnNextAudio) {
        state.assistantResponseOnNextAudio = false
        state.assistantResponses += 1
        ws.send(
          JSON.stringify({
            type: 'response-created',
            rawType: 'response.created',
            raw: { response: { id: 'unsafe-assistant-response' } }
          })
        )
        return
      }
      // Scripted speech fixtures keep their provider productive while PCM
      // continues between exact finals. Partials never finalize extra words.
      if (
        state.realtimePartialProgress &&
        typeof message.audio === 'string' &&
        Buffer.from(message.audio, 'base64').length > 0
      ) {
        if (!progressStarted) {
          progressStarted = true
          ws.send(
            JSON.stringify({
              type: 'speech-started',
              itemId: progressItemId,
              raw: { audio_start_ms: timeline.lastStartMs, item_id: progressItemId }
            })
          )
        }
        ws.send(
          JSON.stringify({
            type: 'custom',
            rawType: 'conversation.item.input_audio_transcription.updated',
            raw: { item_id: progressItemId, transcript: 'Fixture speech is still in progress.' }
          })
        )
      }
      if (transcriptSent || !autoTranscript) return
      transcriptSent = true
      ws.send(
        JSON.stringify({
          type: 'speech-started',
          itemId,
          raw: { audio_start_ms: 0, item_id: itemId }
        })
      )
      ws.send(
        JSON.stringify({
          type: 'custom',
          rawType: 'conversation.item.input_audio_transcription.updated',
          raw: { item_id: itemId, transcript: provisionalFinalText }
        })
      )
      setTimeout(() => {
        if (ws.readyState !== 1) return
        ws.send(
          JSON.stringify({
            type: 'input-transcription-completed',
            itemId,
            transcript: provisionalFinalText
          })
        )
      }, 25)
      setTimeout(() => {
        if (ws.readyState !== 1) return
        ws.send(
          JSON.stringify({
            type: 'input-transcription-completed',
            itemId,
            transcript: finalText
          })
        )
      }, 75)
    })
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const httpOrigin = `http://127.0.0.1:${port}`
  websocketUrl = `ws://127.0.0.1:${port}/realtime`

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
     * Push one scripted utterance to every open realtime client: speech
     * started for a fresh item, then its completed transcription (the
     * backend's final). Resolves with the number of clients reached, after
     * the completion frame was written.
     */
    emitRealtimeFinal: async (text) => {
      const scriptedItemId = `scripted-item-${++scriptedItemSeq}`
      let reached = 0
      for (const client of realtime.clients) {
        if (client.readyState !== 1) continue
        const audioStartMs = audioTimeline.get(client)?.lastStartMs ?? 0
        client.send(
          JSON.stringify({
            type: 'speech-started',
            itemId: scriptedItemId,
            raw: { audio_start_ms: audioStartMs, item_id: scriptedItemId }
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
        if (client.readyState !== 1) continue
        client.send(
          JSON.stringify({
            type: 'input-transcription-completed',
            itemId: scriptedItemId,
            transcript: text
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
 * Plan 140 S9: Golem voice commands as a speech model delivers them. The
 * first is one command cut into two finals; the wake word starts the first.
 */
export const BUDDY_COMMAND_FINALS = Object.freeze({
  highlightByNameSplit: Object.freeze(['Golem, highlight the comment', 'from coders X.']),
  clear: Object.freeze(['Golem, clear the highlight.']),
  removeThisOne: Object.freeze(['This one is toxic. Remove it from our chat.']),
  confirm: Object.freeze(['Yes.']),
  cancel: Object.freeze(['No.']),
  highlightThisOne: Object.freeze(['Golem, put this one up.']),
  namedMarker: Object.freeze(['Golem, make a marker here for Shadcn New Library.']),
  negatedMarker: Object.freeze(["Golem, don't make a marker for this topic."])
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
