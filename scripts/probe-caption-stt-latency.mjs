#!/usr/bin/env node
// Latency probe for Vercel AI Gateway *streaming* transcription (WebSocket).
// Speaks the raw envelope from @ai-sdk/provider-utils (transcription-stream.start
// TEXT frame, BINARY PCM frames, transcription-stream.audio-done TEXT frame) so it
// mirrors exactly what the Rust backend would have to send.
//
// Usage:
//   AI_GATEWAY_API_KEY=... pnpm probe:caption-stt [model] [pcmPath] [rate] [--mint]
//
// Defaults: model=openai/gpt-realtime-whisper, pcm=./sample-24k.pcm, rate=24000.
// Make a clip with `say -o clip.aiff "..."` then `ffmpeg -i clip.aiff -ac 1 -ar 16000 -f s16le clip-16k.pcm`.
// Plan 175 S1 owns this probe; it never runs in CI and prints no secrets.
// For spacexai/grok-stt use sample-16k.pcm 16000. --mint first mints a single-use
// client secret (routeKind: transcription) and connects with that instead of the key,
// which is the production shape (desktop never holds the long-lived key).
//
// Audio is paced in real time (20 ms frames) to imitate a microphone, so the
// printed numbers are what a streamer would see:
//   first-partial  = wall time from the first audio byte to the first text
//   tail           = wall time from the LAST audio byte to the final transcript
//   per-event lag  = audio seconds already sent minus seconds since start (≈ 0),
//                    plus the event's own delay, printed as `+x.xxs behind mic`

import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
const model = args[0] ?? 'openai/gpt-realtime-whisper'
const pcmPath = args[1] ?? './sample-24k.pcm'
const rate = Number(args[2] ?? 24000)
const base =
  process.env.AI_GATEWAY_BASE_URL?.replace(/\/v1\/?$/, '') ?? 'https://ai-gateway.vercel.sh'
const apiKey = process.env.AI_GATEWAY_API_KEY
if (!apiKey) {
  console.error('AI_GATEWAY_API_KEY is required (never commit it).')
  process.exit(2)
}

const providerOptionsFor = (id) => {
  if (id.startsWith('openai/')) return { openai: { language: 'en', streaming: { delay: 'low' } } }
  if (id.startsWith('spacexai/') || id.startsWith('xai/'))
    return { xai: { language: 'en', streaming: { interimResults: true, endpointing: 300 } } }
  return {}
}

let bearer = apiKey
if (flags.has('--mint')) {
  const res = await fetch(`${base}/v1/realtime/client-secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, routeKind: 'transcription', expiresIn: 60 })
  })
  if (!res.ok) {
    console.error('mint failed', res.status, await res.text())
    process.exit(1)
  }
  const secret = await res.json()
  bearer = secret.token
  console.log(`minted client secret (expiresAt=${secret.expiresAt ?? 'n/a'})`)
}

const pcm = new Uint8Array(await readFile(pcmPath))
const bytesPerSecond = rate * 2 // s16le mono
const frameMs = 20
const frameBytes = (bytesPerSecond * frameMs) / 1000
const totalSeconds = pcm.length / bytesPerSecond

const url = new URL(`${base.replace(/^http/, 'ws')}/v4/ai/transcription-model`)
url.searchParams.set('ai-model-id', model)
const protocols = ['ai-gateway-transcription.v1', `ai-gateway-auth.${bearer}`]

console.log(`model=${model} rate=${rate} audio=${totalSeconds.toFixed(2)}s url=${url}`)
const ws = new WebSocket(url, protocols)
ws.binaryType = 'arraybuffer'

let t0 = 0
let sentBytes = 0
let lastAudioAt = 0
let firstTextAt = 0
const now = () => performance.now()
const since = (t) => ((now() - t) / 1000).toFixed(2)
const audioSentSeconds = () => sentBytes / bytesPerSecond

const done = new Promise((resolve, reject) => {
  ws.addEventListener('error', (e) => reject(new Error(`socket error: ${e.message ?? e}`)))
  ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    let part
    try {
      part = JSON.parse(event.data)
    } catch {
      return
    }
    const t = now()
    const behind = (audioSentSeconds() - (t - t0) / 1000).toFixed(2)
    switch (part.type) {
      case 'stream-start':
        console.log(`[${since(t0)}s] stream-start warnings=${JSON.stringify(part.warnings)}`)
        break
      case 'transcript-delta':
      case 'transcript-partial':
      case 'transcript-final': {
        if (!firstTextAt) {
          firstTextAt = t
          console.log(`>>> first text after ${since(t0)}s of audio`)
        }
        const text = part.type === 'transcript-delta' ? part.delta : part.text
        console.log(
          `[${since(t0)}s audio-sent=${audioSentSeconds().toFixed(2)}s] ${part.type}: ${JSON.stringify(text)}`
        )
        if (part.type === 'transcript-final' && lastAudioAt)
          console.log(`    final arrived ${since(lastAudioAt)}s after the last audio byte`)
        break
      }
      case 'finish':
        console.log(
          `[${since(t0)}s] finish duration=${part.durationInSeconds ?? 'n/a'} usage=${JSON.stringify(part.usage ?? null)} ` +
            `providerMetadata=${JSON.stringify(part.providerMetadata ?? null)}`
        )
        console.log(`    finish arrived ${since(lastAudioAt)}s after the last audio byte`)
        console.log(`FINAL TEXT: ${part.text}`)
        break
      case 'error':
        console.log(`[${since(t0)}s] error ${JSON.stringify(part.error)}`)
        break
      default:
        console.log(`[${since(t0)}s] ${part.type} ${event.data.slice(0, 200)}`)
    }
  })
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
console.log(`connected, negotiated subprotocol=${ws.protocol || '(none)'}`)

ws.send(
  JSON.stringify({
    type: 'transcription-stream.start',
    inputAudioFormat: { type: 'audio/pcm', rate },
    providerOptions: providerOptionsFor(model)
  })
)

t0 = now()
for (let offset = 0; offset < pcm.length; offset += frameBytes) {
  const target = t0 + (offset / bytesPerSecond) * 1000
  const wait = target - now()
  if (wait > 0) await sleep(wait)
  ws.send(pcm.subarray(offset, offset + frameBytes))
  sentBytes = Math.min(offset + frameBytes, pcm.length)
}
lastAudioAt = now()
console.log(`[${since(t0)}s] all audio sent (${totalSeconds.toFixed(2)}s); sending audio-done`)
ws.send(JSON.stringify({ type: 'transcription-stream.audio-done' }))

const closeTimer = setTimeout(() => {
  console.log('no finish within 15 s after audio-done; closing')
  ws.close()
}, 15_000)
const result = await done
clearTimeout(closeTimer)
console.log(`closed code=${result.code} reason=${JSON.stringify(result.reason)}`)
