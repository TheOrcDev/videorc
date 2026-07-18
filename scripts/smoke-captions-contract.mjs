import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devAppSpawnOptions, stopProcess } from './lib/app-launcher.mjs'
import { startFakeCaptionService } from './lib/fake-caption-service.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Maintained caption transport contract gate. This launches the real debug app/backend,
// points its Videorc API client at a local authenticated HTTP service, upgrades the real
// Rust realtime client into a fake Gateway WebSocket, injects deterministic post-controls
// PCM through a debug+env double-gated seam, and proves:
//
//   token mint -> configuration ack -> audio append -> partial/final -> canonical cue
//   repeated provider completions upsert one cue
//   assistant-response event -> immediate transcription-only chunk fallback
//   realtime-unavailable -> chunk upload fallback -> final caption
//   first audio, then producer silence -> truthful blocked/stalled status
//
// No production bearer, provider credential, microphone permission, or external network is
// involved. Release builds do not compile the audio-injection/snapshot RPCs.

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180_000)
const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-captions-contract-'))
const appDataDir = join(stateRoot, 'app-data')
const backendBinaryName = process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend'
const backendBinary = join(process.cwd(), 'target', 'debug', backendBinaryName)
const smokeSessionToken = 'captions-contract-session-token'
const smokeRealtimeToken = 'captions-contract-realtime-token'

mkdirSync(appDataDir, { recursive: true })
const secretsPath = join(appDataDir, 'videorc-secrets.json')
writeFileSync(
  secretsPath,
  JSON.stringify({ 'account:videorc:session': smokeSessionToken }, null, 2)
)
chmodSync(secretsPath, 0o600)

const fake = await startFakeCaptionService({ smokeSessionToken, smokeRealtimeToken })
let backendProcess
let backend

try {
  if (!existsSync(backendBinary)) {
    throw new Error(`target/debug/${backendBinaryName} is missing; build the debug backend first.`)
  }
  backendProcess = spawn(backendBinary, [], {
    ...devAppSpawnOptions({
      env: {
        ...process.env,
        VIDEORC_API_BASE_URL: fake.httpOrigin,
        VIDEORC_CAPTION_CONTRACT_ALLOW_IDLE: '1',
        VIDEORC_CAPTION_CONTRACT_TEST: '1',
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_DISABLE_BACKEND_REAP: '1',
        VIDEORC_ENABLE_SMOKE_RPC: '1',
        VIDEORC_APP_DATA_DIR: appDataDir,
        VIDEORC_DATABASE_PATH: join(appDataDir, 'videorc.sqlite3'),
        VIDEORC_SECRETS_PATH: secretsPath,
        VIDEORC_SMOKE_STATE_DIR: stateRoot
      }
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const ready = await waitForBackendReady(backendProcess, timeoutMs)
  if (typeof ready.adminToken !== 'string' || ready.adminToken.length < 32) {
    throw new Error('Debug backend READY omitted its private smoke admin credential.')
  }
  backend = await connectBackend({ ...ready, token: ready.adminToken, adminToken: undefined }, timeoutMs)
  const observed = collectCaptionEvents(backend)

  await proveRealtimeContract({ backend, observed, fake })
  await proveAssistantResponseFallback({ backend, observed, fake })
  await proveChunkFallback({ backend, observed, fake })

  console.log(
    `Caption contract smoke PASS — realtime partial/final, repeated-completion upsert, ` +
      `assistant-response safety fallback, provider-ready truth, deterministic audio, ` +
      `and chunk fallback passed ` +
      `with post-frame stall detection ` +
      `(realtime appends=${fake.state.audioAppends}, chunk requests=${fake.state.chunkRequests}).`
  )
} finally {
  try {
    if (backend) {
      await request(backend, 5_000, 'captions.stop', {}).catch(() => {})
      backend.close()
    }
  } finally {
    if (backendProcess) {
      await stopProcess(backendProcess).catch(() => {})
    }
    await fake.close()
    rmSync(stateRoot, { force: true, recursive: true })
  }
}

function waitForBackendReady(child, deadlineMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Backend did not print READY in time.')),
      deadlineMs
    )
    let stdout = ''
    let stderr = ''
    const finish = (callback, value) => {
      clearTimeout(timer)
      callback(value)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('READY '))
      if (!line) return
      try {
        finish(resolve, JSON.parse(line.slice('READY '.length)))
      } catch {
        finish(reject, new Error('Backend printed an invalid READY payload.'))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000)
    })
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code, signal) =>
      finish(
        reject,
        new Error(
          `Backend exited before READY (code=${code}, signal=${signal}).${stderr ? `\n${stderr}` : ''}`
        )
      )
    )
  })
}

async function proveRealtimeContract({ backend, observed, fake }) {
  fake.state.realtimeAvailable = true
  const started = await request(backend, timeoutMs, 'captions.start', { language: 'en' })
  if (started.state !== 'starting' || !started.sessionClientId) {
    throw new Error(`Realtime captions did not enter Starting: ${JSON.stringify(started)}`)
  }

  await waitFor(() => fake.state.configurations.length === 1, timeoutMs, 'Gateway configuration')
  const configuration = fake.state.configurations[0]
  if (
    configuration.type !== 'session.update' ||
    configuration.session?.turn_detection?.create_response !== false ||
    !configuration.session?.input_audio_transcription
  ) {
    throw new Error(
      `Realtime configuration did not suppress assistant responses or enable transcription: ` +
        JSON.stringify(configuration)
    )
  }

  const injected = await request(backend, timeoutMs, 'captions.test.inject-audio', {
    durationMs: 900
  })
  if ((injected.framesAccepted ?? 0) < 1) {
    throw new Error(
      `Caption contract audio did not enter the bounded bus: ${JSON.stringify(injected)}`
    )
  }

  await waitFor(
    () =>
      observed.updates.some(
        (update) =>
          update.sessionClientId === started.sessionClientId &&
          update.kind === 'final' &&
          update.text === 'Caption contract passed.'
      ),
    timeoutMs,
    'settled realtime caption'
  )
  const snapshot = await waitForSnapshot(
    backend,
    (candidate) =>
      candidate.status?.state === 'listening' &&
      candidate.status?.transport === 'realtime' &&
      candidate.status?.providerReady === true &&
      candidate.chunkCount === 1 &&
      candidate.canonicalCues?.[0]?.text === 'Caption contract passed.'
  )
  if (snapshot.canonicalCues.length !== 1) {
    throw new Error(`Repeated completions created duplicate cues: ${JSON.stringify(snapshot)}`)
  }
  if (fake.state.audioAppends < 1 || fake.state.emptyAudioAppends > 0) {
    throw new Error(`Realtime client did not append valid PCM: ${JSON.stringify(fake.state)}`)
  }

  await request(backend, timeoutMs, 'captions.stop', {})
}

async function proveAssistantResponseFallback({ backend, observed, fake }) {
  fake.state.realtimeAvailable = true
  fake.state.assistantResponseOnNextAudio = true
  const chunkRequestsBefore = fake.state.chunkRequests
  const started = await request(backend, timeoutMs, 'captions.start', { language: 'en' })
  if (!started.sessionClientId) {
    throw new Error(
      `Assistant-response safety scenario returned no session id: ${JSON.stringify(started)}`
    )
  }

  const trigger = await request(backend, timeoutMs, 'captions.test.inject-audio', {
    durationMs: 900
  })
  if ((trigger.framesAccepted ?? 0) < 1) {
    throw new Error(
      `Assistant-response safety scenario received no trigger PCM: ${JSON.stringify(trigger)}`
    )
  }

  await waitForSnapshot(
    backend,
    (candidate) =>
      candidate.status?.transport === 'chunked' &&
      candidate.status?.reasonCode === 'realtime-fallback'
  )
  if (fake.state.assistantResponses !== 1) {
    throw new Error(`Expected one unsafe assistant response: ${JSON.stringify(fake.state)}`)
  }

  const fallbackAudio = await request(backend, timeoutMs, 'captions.test.inject-audio', {
    durationMs: 5_000
  })
  if ((fallbackAudio.framesAccepted ?? 0) < 1) {
    throw new Error(
      `Assistant-response chunk fallback received no deterministic PCM: ${JSON.stringify(fallbackAudio)}`
    )
  }

  await waitFor(
    () =>
      observed.updates.some(
        (update) =>
          update.sessionClientId === started.sessionClientId &&
          update.kind === 'final' &&
          update.text === 'Chunk fallback recovered.'
      ),
    timeoutMs,
    'assistant-response chunk fallback caption'
  )
  if (fake.state.chunkRequests !== chunkRequestsBefore + 1) {
    throw new Error(
      `Expected one chunk after the unsafe assistant response, got ${fake.state.chunkRequests - chunkRequestsBefore}.`
    )
  }

  await request(backend, timeoutMs, 'captions.stop', {})
}

async function proveChunkFallback({ backend, observed, fake }) {
  fake.state.realtimeAvailable = false
  const chunkRequestsBefore = fake.state.chunkRequests
  const started = await request(backend, timeoutMs, 'captions.start', { language: 'en' })
  if (!started.sessionClientId) {
    throw new Error(`Chunk fallback captions returned no session id: ${JSON.stringify(started)}`)
  }

  const injected = await request(backend, timeoutMs, 'captions.test.inject-audio', {
    durationMs: 5_000
  })
  if ((injected.framesAccepted ?? 0) < 1) {
    throw new Error(`Chunk fallback received no deterministic PCM: ${JSON.stringify(injected)}`)
  }

  await waitFor(
    () =>
      observed.updates.some(
        (update) =>
          update.sessionClientId === started.sessionClientId &&
          update.kind === 'final' &&
          update.text === 'Chunk fallback recovered.'
      ),
    timeoutMs,
    'chunk fallback caption'
  )
  await waitForSnapshot(
    backend,
    (candidate) =>
      candidate.status?.transport === 'chunked' &&
      candidate.status?.providerReady === true &&
      candidate.canonicalCues?.some((cue) => cue.text === 'Chunk fallback recovered.')
  )
  if (fake.state.chunkRequests !== chunkRequestsBefore + 1) {
    throw new Error(
      `Expected exactly one fallback chunk, got ${fake.state.chunkRequests - chunkRequestsBefore}.`
    )
  }

  await waitForSnapshot(
    backend,
    (candidate) =>
      candidate.status?.state === 'blocked' &&
      candidate.status?.transport === 'chunked' &&
      candidate.status?.reasonCode === 'audio-path-stalled'
  )
}

function collectCaptionEvents(ws) {
  const result = { statuses: [], updates: [] }
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.event === 'captions.status') result.statuses.push(message.payload)
    if (message.event === 'captions.update') result.updates.push(message.payload)
  })
  return result
}

async function waitForSnapshot(backend, predicate) {
  const startedAt = Date.now()
  let latest
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await request(backend, timeoutMs, 'captions.test.snapshot', {})
    if (predicate(latest)) return latest
    await sleep(50)
  }
  throw new Error(`Timed out waiting for caption contract snapshot: ${JSON.stringify(latest)}`)
}

function waitFor(predicate, deadlineMs, label) {
  return new Promise((resolveWait, rejectWait) => {
    const startedAt = Date.now()
    const tick = () => {
      if (predicate()) {
        resolveWait()
        return
      }
      if (Date.now() - startedAt > deadlineMs) {
        rejectWait(new Error(`Timed out waiting for ${label}.`))
        return
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
