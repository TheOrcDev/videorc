import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

import { inspectMultipartPcm16Wav } from './audio-amplitude.mjs'

/**
 * Local, credential-free caption service used by maintained app smokes.
 * It mirrors the authenticated Videorc HTTP routes plus the legacy Gateway
 * realtime dialect without ever touching production or logging transcript,
 * bearer, or client-token material.
 */
export async function startFakeCaptionService({
  smokeSessionToken,
  smokeRealtimeToken,
  finalText = 'Caption contract passed.',
  provisionalFinalText = 'Caption contract',
  chunkText = 'Chunk fallback recovered.',
  itemId = 'caption-contract-item',
  minSpeechPeak = null
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
    chunkRequests: 0,
    chunkAudio: [],
    usageReports: 0
  }
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
      let audio
      try {
        audio = inspectMultipartPcm16Wav(await readRequestBody(req))
      } catch (error) {
        return json(res, 400, {
          error: { code: 'invalid-caption-wav', message: error.message }
        })
      }
      state.chunkRequests += 1
      state.chunkAudio.push(audio)
      const hasSpeech = !Number.isFinite(minSpeechPeak) || audio.peak >= Math.max(0, minSpeechPeak)
      const text = hasSpeech ? chunkText : ''
      return json(res, 200, {
        chunkSeconds: 3,
        latencyMs: 5,
        model: 'smoke/chunk-transcription',
        monthlySecondsLimit: 3_600,
        remainingSeconds: 3_597,
        segments: text ? [{ text, startSecond: 0, endSecond: 3 }] : [],
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

  realtime.on('connection', (ws) => {
    state.realtimeConnections += 1
    let transcriptSent = false
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
      if (transcriptSent) return
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
    close: async () => {
      for (const client of realtime.clients) client.terminate()
      realtime.close()
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  }
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
