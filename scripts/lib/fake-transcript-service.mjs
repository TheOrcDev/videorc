import { createServer } from 'node:http'

import { inspectPcm16Wav } from './audio-amplitude.mjs'

/**
 * Local, credential-free Clean cut service for maintained app smokes (plan
 * 119 S12a; the S16 smoke drives the real app against it). It mirrors
 * docs/clean-cut-contract.md: the verbatim chunk route (part A), the
 * capabilities block (part B) and the `post-recording-clean-cut` analysis job
 * (part C), with deterministic answers from a scripted word list. Nothing is
 * logged: bearer tokens, audio and transcript text never leave the process.
 *
 * Options:
 * - `smokeSessionToken`: the bearer every route requires.
 * - `words`: `[{ text, startMs, endMs, filler?, confidence? }]` in recording
 *   time. A chunk upload answers with the words whose midpoint falls inside
 *   the chunk, re-based to the chunk start; the lexicon tags fillers too.
 *   `setWords(words)` replaces them later: the S16 smoke measures the speech
 *   in the finished recording, lays its script over it, and only then starts
 *   Clean cut, so the words line up with the audio exactly.
 * - `retakeMarkers`: lowercase phrases; a sentence containing one makes the
 *   sentence before it a `retake` drop (confidence 0.9). Default: "let me say
 *   that again", "one more time", "let me try that again".
 * - `drops`: extra `[{ fromIndex, toIndex, kind, confidence, reason }]` by
 *   segment index, for scripted suggestions.
 * - `keeps`: condensed `[{ fromIndex, toIndex, title }]` by segment index.
 *   Default keeps the first and last segment.
 * - `monthlySecondsLimit`, `remainingSeconds`: the metered allowance.
 * - `cohostCommandEnabled`: `features.cohostCommandEnabled` (plan 140 S8,
 *   contract part E). Default false: Buddy's cloud command parser stays off.
 *   `state.cohostCommandEnabled` changes the next capability read.
 *
 * Knobs on `state`: `chunkFailureCode` answers every chunk upload with that
 * code (status from the contract); `jobFailureCode` fails job creation.
 */

export const CLEAN_CUT_WORKFLOW_KIND = 'post-recording-clean-cut'
export const MAX_CHUNK_SECONDS = 120
export const MAX_CHUNK_BYTES = 4_000_000
export const FILLER_LEXICON = new Set(['um', 'uh', 'uhm', 'umm', 'erm', 'er', 'ah', 'hmm', 'mm'])
const DEFAULT_RETAKE_MARKERS = ['let me say that again', 'one more time', 'let me try that again']
const CHUNK_ERROR_STATUS = {
  unauthorized: 401,
  'invalid-transcript-chunk': 400,
  'premium-required': 403,
  'ai-access-blocked': 403,
  'clean-cut-disabled': 503,
  'clean-cut-provider-unconfigured': 503,
  'clean-cut-monthly-quota-exhausted': 429,
  'clean-cut-provider-error': 502
}
const JOB_ERROR_STATUS = {
  unauthorized: 401,
  'invalid-ai-job': 400,
  'ai-disabled': 503,
  'ai-user-disabled': 403,
  'cloud-ai-premium-required': 403,
  'ai-daily-quota-exhausted': 429,
  'ai-monthly-quota-exhausted': 429,
  'clean-cut-disabled': 503,
  'clean-cut-daily-quota-exhausted': 429
}

/** Lowercase, punctuation stripped (the contract's filler rule). Pure. */
export function normalizeWord(text) {
  return String(text ?? '')
    .trim()
    .replace(/[^\p{L}\p{N}']/gu, '')
    .toLowerCase()
}

export function isFiller(text) {
  const normalized = normalizeWord(text)
  return normalized.length > 0 && FILLER_LEXICON.has(normalized)
}

/**
 * The scripted words a chunk hears: those whose midpoint lies inside
 * `[chunkStartMs, chunkEndMs)`, re-based to the chunk start. Pure.
 */
export function wordsForChunk(words, chunkStartMs, chunkEndMs) {
  const out = []
  for (const word of words ?? []) {
    const startMs = Number(word.startMs)
    const endMs = Math.max(startMs, Number(word.endMs))
    const midpoint = startMs + (endMs - startMs) / 2
    if (!(midpoint >= chunkStartMs && midpoint < chunkEndMs)) continue
    const entry = {
      text: String(word.text),
      startMs: Math.max(0, Math.round(startMs - chunkStartMs)),
      endMs: Math.max(0, Math.round(endMs - chunkStartMs))
    }
    if (Number.isFinite(word.confidence)) entry.confidence = word.confidence
    if (word.filler === true || isFiller(word.text)) entry.filler = true
    out.push(entry)
  }
  return out
}

/**
 * Deterministic drops for the analysis job: a segment holding a retake
 * marker drops the segment before it. Pure.
 */
export function scriptedDrops(
  segments,
  { retakeMarkers = DEFAULT_RETAKE_MARKERS, drops = [] } = {}
) {
  const out = []
  segments.forEach((segment, index) => {
    const text = String(segment.text ?? '').toLowerCase()
    if (index > 0 && retakeMarkers.some((marker) => text.includes(marker))) {
      out.push({
        fromId: segments[index - 1].id,
        toId: segments[index - 1].id,
        kind: 'retake',
        confidence: 0.9,
        reason: 'Restarted the sentence; the later take is kept.'
      })
    }
  })
  for (const drop of drops) {
    const from = segments[drop.fromIndex]
    const to = segments[drop.toIndex ?? drop.fromIndex]
    if (!from || !to) continue
    out.push({
      fromId: from.id,
      toId: to.id,
      kind: drop.kind ?? 'retake',
      confidence: Number.isFinite(drop.confidence) ? drop.confidence : 0.75,
      reason: drop.reason ?? 'Scripted drop.'
    })
  }
  return out
}

/** Condensed keeps by index; default: the first and the last segment. Pure. */
export function scriptedKeeps(segments, keeps) {
  if (segments.length === 0) return []
  const picks =
    keeps && keeps.length > 0
      ? keeps
      : [
          { fromIndex: 0, toIndex: 0, title: 'Intro' },
          { fromIndex: segments.length - 1, toIndex: segments.length - 1, title: 'Close' }
        ]
  const out = []
  for (const keep of picks) {
    const from = segments[keep.fromIndex]
    const to = segments[keep.toIndex ?? keep.fromIndex]
    if (!from || !to) continue
    out.push({ fromId: from.id, toId: to.id, title: keep.title ?? 'Kept' })
  }
  return out
}

/** The `cleanCut` capability block (contract part B). Pure. */
export function cleanCutCapabilities({ monthlySecondsLimit, remainingSeconds, available = true }) {
  return {
    supported: true,
    available,
    reasonCode: available ? null : 'quota-exhausted',
    maxChunkSeconds: MAX_CHUNK_SECONDS,
    maxChunkBytes: MAX_CHUNK_BYTES,
    monthlySecondsLimit,
    remainingSeconds,
    modes: ['clean', 'condensed'],
    workflowKind: CLEAN_CUT_WORKFLOW_KIND
  }
}

/** Multipart form fields and files from one request body. Pure. */
export function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType ?? ''))
  const boundary = match?.[1] ?? match?.[2]
  if (!boundary) throw new Error('Multipart upload has no boundary.')
  const delimiter = Buffer.from(`--${boundary.trim()}`)
  const fields = new Map()
  const files = new Map()
  let cursor = body.indexOf(delimiter)
  while (cursor >= 0) {
    const partStart = cursor + delimiter.length
    if (body.subarray(partStart, partStart + 2).toString('ascii') === '--') break
    const headerEnd = body.indexOf('\r\n\r\n', partStart)
    if (headerEnd < 0) break
    const next = body.indexOf(delimiter, headerEnd)
    if (next < 0) break
    const headers = body.subarray(partStart, headerEnd).toString('utf8')
    const content = body.subarray(headerEnd + 4, next - 2)
    const name = /name="([^"]*)"/i.exec(headers)?.[1]
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1]
    if (name !== undefined) {
      if (filename !== undefined) files.set(name, { filename, content })
      else fields.set(name, content.toString('utf8'))
    }
    cursor = next
  }
  return { fields, files }
}

export async function startFakeTranscriptService({
  smokeSessionToken,
  words = [],
  retakeMarkers = DEFAULT_RETAKE_MARKERS,
  drops = [],
  keeps = null,
  language = 'en',
  monthlySecondsLimit = 72_000,
  remainingSeconds = null,
  // Plan 140 S9: `features.cohostCommandEnabled` in the capabilities block.
  // Off by default, so Buddy's cloud command parser stays off in every smoke
  // that does not opt in (`state.cohostCommandEnabled` flips it later).
  cohostCommandEnabled = false
}) {
  const state = {
    cohostCommandEnabled: cohostCommandEnabled === true,
    chunkRequests: 0,
    chunks: [],
    usedSeconds: 0,
    chunkFailureCode: null,
    jobFailureCode: null,
    jobCreates: 0,
    jobPolls: 0,
    jobs: new Map(),
    capabilityRequests: 0,
    unknownRoutes: 0
  }
  let remaining = Number.isFinite(remainingSeconds) ? remainingSeconds : monthlySecondsLimit
  let jobSeq = 0
  let scriptedWords = Array.isArray(words) ? words : []

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers.authorization !== `Bearer ${smokeSessionToken}`) {
      await drain(req)
      return json(res, 401, { error: { code: 'unauthorized', message: 'Smoke auth failed.' } })
    }
    if (req.method === 'GET' && url.pathname === '/api/ai/capabilities') {
      await drain(req)
      state.capabilityRequests += 1
      return json(
        res,
        200,
        capabilitiesDocument({
          monthlySecondsLimit,
          remaining,
          cohostCommandEnabled: state.cohostCommandEnabled
        })
      )
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/transcripts/chunks') {
      const body = await readRequestBody(req, MAX_CHUNK_BYTES + 64 * 1024)
      let parsed
      let audio
      try {
        parsed = parseMultipart(body, req.headers['content-type'])
        const file = parsed.files.get('audio')
        if (!file) throw new Error('The audio field is missing.')
        if (file.content.length > MAX_CHUNK_BYTES) throw new Error('The audio is too big.')
        audio = inspectPcm16Wav(file.content)
        if (audio.channels !== 1 || audio.sampleRate !== 16_000) {
          throw new Error('The audio must be mono 16 kHz.')
        }
      } catch (error) {
        return json(res, 400, {
          error: { code: 'invalid-transcript-chunk', message: error.message }
        })
      }
      const sessionClientId = parsed.fields.get('sessionClientId') ?? ''
      const chunkIndex = Number(parsed.fields.get('chunkIndex'))
      const chunkStartMs = Number(parsed.fields.get('chunkStartMs'))
      const chunkSeconds = audio.sampleCount / audio.sampleRate
      if (
        !/^[A-Za-z0-9._:-]{1,120}$/.test(sessionClientId) ||
        !Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        !Number.isInteger(chunkStartMs) ||
        chunkStartMs < 0 ||
        chunkSeconds > MAX_CHUNK_SECONDS
      ) {
        return json(res, 400, {
          error: { code: 'invalid-transcript-chunk', message: 'The chunk fields are invalid.' }
        })
      }
      state.chunkRequests += 1
      state.chunks.push({
        chunkIndex,
        chunkStartMs,
        chunkSeconds,
        sessionClientId,
        language: parsed.fields.get('language') ?? null,
        peak: audio.peak
      })
      if (state.chunkFailureCode) {
        return json(res, CHUNK_ERROR_STATUS[state.chunkFailureCode] ?? 503, {
          error: {
            code: state.chunkFailureCode,
            message: 'Chunk transcription is deliberately blocked in this scenario.'
          }
        })
      }
      if (remaining - chunkSeconds < 0) {
        return json(res, 429, {
          error: {
            code: 'clean-cut-monthly-quota-exhausted',
            message: 'The monthly Clean cut allowance is used up.'
          }
        })
      }
      remaining = Math.max(0, remaining - chunkSeconds)
      state.usedSeconds += chunkSeconds
      const chunkWords = wordsForChunk(
        scriptedWords,
        chunkStartMs,
        chunkStartMs + chunkSeconds * 1000
      )
      return json(res, 200, {
        chunkIndex,
        chunkSeconds: Math.round(chunkSeconds * 100) / 100,
        language,
        text: chunkWords.map((word) => word.text).join(' '),
        words: chunkWords,
        remainingSeconds: Math.floor(remaining),
        monthlySecondsLimit
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/jobs') {
      let body
      try {
        body = JSON.parse((await readRequestBody(req, 32 * 1024 * 1024)).toString('utf8'))
      } catch {
        return json(res, 400, { error: { code: 'invalid-ai-job', message: 'Body is not JSON.' } })
      }
      state.jobCreates += 1
      const invalid = validateJobBody(body)
      if (invalid) {
        return json(res, 400, { error: { code: 'invalid-ai-job', message: invalid } })
      }
      if (state.jobFailureCode) {
        return json(res, JOB_ERROR_STATUS[state.jobFailureCode] ?? 503, {
          error: {
            code: state.jobFailureCode,
            message: 'Job creation is deliberately blocked in this scenario.'
          }
        })
      }
      const existing = [...state.jobs.values()].find(
        (job) => job.clientRequestId === body.clientRequestId
      )
      if (existing) {
        return json(res, 200, { idempotent: true, job: serializeJob(existing) })
      }
      jobSeq += 1
      const job = {
        id: `fake-clean-cut-job-${jobSeq}`,
        clientRequestId: body.clientRequestId,
        sessionClientId: body.sessionClientId,
        createdAt: new Date().toISOString(),
        status: 'queued',
        polls: 0,
        input: body.inputJson,
        windowsTotal: Math.max(1, Math.ceil(Number(body.inputJson.durationMs) / (12 * 60_000)))
      }
      state.jobs.set(job.id, job)
      return json(res, 200, { idempotent: false, job: serializeJob(job) })
    }
    const jobMatch = /^\/api\/ai\/jobs\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && jobMatch) {
      await drain(req)
      const job = state.jobs.get(decodeURIComponent(jobMatch[1]))
      if (!job) {
        return json(res, 404, { error: { code: 'not-found', message: 'Unknown job.' } })
      }
      state.jobPolls += 1
      job.polls += 1
      advanceJob(job)
      return json(res, 200, { job: serializeJob(job) })
    }
    await drain(req)
    state.unknownRoutes += 1
    return json(res, 404, { error: { code: 'not-found', message: 'Unknown smoke route.' } })
  })

  function advanceJob(job) {
    if (job.status === 'completed') return
    if (job.polls === 1) {
      job.status = 'running'
      job.completedWindows = Math.ceil(job.windowsTotal / 2)
      return
    }
    if (job.polls === 2 && job.windowsTotal > 1) {
      // The server ran out of its invocation budget: back to queued, progress kept.
      job.status = 'queued'
      return
    }
    const segments = job.input.segments
    const result = {
      mode: job.input.mode,
      drops: scriptedDrops(segments, { retakeMarkers, drops }),
      windows: { total: job.windowsTotal, completed: job.windowsTotal }
    }
    if (job.input.mode === 'condensed') {
      result.keeps = scriptedKeeps(segments, keeps)
      result.beats = result.keeps.map((keep, index) => ({
        fromId: keep.fromId,
        toId: keep.toId,
        title: keep.title,
        importance: 0.9,
        hook: index === 0,
        close: index === result.keeps.length - 1
      }))
    }
    job.status = 'completed'
    job.completedAt = new Date().toISOString()
    job.result = result
    // Terminal: the server keeps the count, not the texts (contract part C).
    job.input = {
      ...job.input,
      segments: undefined,
      segmentCount: segments.length,
      mustKeep: undefined,
      mustKeepCount: (job.input.mustKeep ?? []).length
    }
  }

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  return {
    httpOrigin: `http://127.0.0.1:${address.port}`,
    state,
    get remainingSeconds() {
      return remaining
    },
    /** Replace the scripted words every later chunk upload hears. */
    setWords(nextWords) {
      scriptedWords = Array.isArray(nextWords) ? nextWords : []
    },
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
  }
}

function validateJobBody(body) {
  if (!body || typeof body !== 'object') return 'Body must be an object.'
  if (body.workflowKind !== CLEAN_CUT_WORKFLOW_KIND) return 'workflowKind is not clean cut.'
  if (typeof body.sessionClientId !== 'string' || body.sessionClientId.length === 0) {
    return 'sessionClientId is required.'
  }
  if (typeof body.clientRequestId !== 'string' || !body.clientRequestId.startsWith('cleancut:')) {
    return 'clientRequestId must start with cleancut:.'
  }
  const consent = body.consentToUploadAudio
  if (consent !== true && !['true', '1', 'yes', 'on'].includes(String(consent).toLowerCase())) {
    return 'consentToUploadAudio is required.'
  }
  const input = body.inputJson
  if (!input || typeof input !== 'object') return 'inputJson is required.'
  if (!['clean', 'condensed'].includes(input.mode)) return 'inputJson.mode is invalid.'
  if (!Number.isInteger(input.durationMs) || input.durationMs <= 0) {
    return 'inputJson.durationMs is invalid.'
  }
  if (!Array.isArray(input.segments) || input.segments.length === 0) {
    return 'inputJson.segments must be a non-empty array.'
  }
  if (input.segments.length > 25_000) return 'inputJson.segments has too many entries.'
  const ids = new Set()
  for (const [index, segment] of input.segments.entries()) {
    if (!segment || typeof segment.id !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(segment.id)) {
      return `segments[${index}].id is invalid.`
    }
    if (ids.has(segment.id)) return `segments[${index}].id is a duplicate.`
    ids.add(segment.id)
    if (
      typeof segment.text !== 'string' ||
      segment.text.length === 0 ||
      segment.text.length > 2000
    ) {
      return `segments[${index}].text is invalid.`
    }
    if (!Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs)) {
      return `segments[${index}] times are invalid.`
    }
  }
  if (input.mode === 'condensed') {
    const target = input.targetDurationSeconds
    if (!Number.isInteger(target) || target < 120 || target > 3600) {
      return 'inputJson.targetDurationSeconds is out of range.'
    }
  }
  return null
}

function serializeJob(job) {
  const artifacts = {
    creatorIntelligence: null,
    publishPack: null,
    socialPosts: null,
    transcript: null,
    transcriptionMetadata: null
  }
  if (job.status === 'completed') {
    artifacts.cleanCut = job.result
  } else if (job.completedWindows) {
    artifacts.cleanCutProgress = {
      windows: { total: job.windowsTotal, completed: job.completedWindows }
    }
  }
  return {
    id: job.id,
    clientRequestId: job.clientRequestId,
    sessionClientId: job.sessionClientId,
    workflowKind: CLEAN_CUT_WORKFLOW_KIND,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.status === 'queued' ? null : job.createdAt,
    completedAt: job.completedAt ?? null,
    errorCode: null,
    errorMessage: null,
    provider: 'smoke',
    model: 'smoke/clean-cut',
    fallbackModels: [],
    runAttempts: job.polls,
    inputTokens: null,
    outputTokens: null,
    costEstimateCents: null,
    outputJson: job.result ? { cleanCut: job.result } : {},
    artifacts
  }
}

export function capabilitiesDocument({
  monthlySecondsLimit,
  remaining,
  cohostCommandEnabled = false
}) {
  const now = new Date().toISOString()
  return {
    entitlement: {
      checkedAt: now,
      cloudAi: true,
      expiresAt: now,
      isPremium: true,
      subscriptionStatus: 'active',
      tier: 'premium'
    },
    features: {
      cleanCutEnabled: true,
      cloudAiEnabled: true,
      cohostCommandEnabled: cohostCommandEnabled === true,
      gatewayConfigured: true,
      modelTestingEnabled: false,
      multipartAudioJobsEnabled: true,
      objectBackedJobsEnabled: false,
      transcriptJobsEnabled: true,
      uploadTicketsEnabled: false
    },
    cleanCut: cleanCutCapabilities({
      monthlySecondsLimit,
      remainingSeconds: Math.floor(remaining),
      available: remaining > 0
    }),
    generatedAt: now,
    limits: {
      dailyCommandCalls: 300,
      dailyJobs: 20,
      maxAudioBytes: 13_107_200,
      maxAudioMegabytes: 12.5,
      maxOutputTokens: 1900,
      maxTranscriptCharacters: 120_000,
      monthlyJobs: 500
    },
    models: {
      allowedTextModelCount: 1,
      allowedTextModelsConfigured: true,
      defaultTextModel: 'smoke/clean-cut',
      fallbackTextModels: []
    },
    objectStorage: {
      deleteConfigured: false,
      downloadConfigured: false,
      provider: null,
      providerError: null,
      proofConfigured: false,
      proofTtlMs: null,
      uploadConfigured: false
    },
    readiness: {
      access: { cloudAiEntitled: true, globallyDisabled: false },
      gateway: { configError: null, configured: true },
      objectStorage: {
        deleteConfigError: null,
        downloadConfigError: null,
        proofConfigError: null,
        providerError: null,
        uploadConfigError: null
      },
      transcription: { configError: null, configured: true }
    },
    transcription: {
      configured: true,
      configError: null,
      maxAudioBytes: 13_107_200,
      maxAudioMegabytes: 12.5,
      requestTimeoutMs: 65_000
    },
    workflow: {
      inputModes: [{ enabled: true, kind: 'transcript' }],
      kind: 'post-recording-publish-pack',
      outputs: ['summary']
    }
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function drain(req) {
  return new Promise((resolveDrain) => {
    req.on('data', () => {})
    req.on('end', resolveDrain)
    req.on('error', resolveDrain)
    req.resume()
  })
}

async function readRequestBody(req, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
