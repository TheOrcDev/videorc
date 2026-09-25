import { createServer } from 'node:http'

/**
 * Local, credential-free stand-in for videorc-web's `POST /api/ai/cohost/tick`
 * used by `pnpm smoke:cohost-fake`. It implements the Live Co-host wire contract
 * deterministically (no model), serving both v1 and v2 keyed off the request's
 * `promptVersion` like the real server (v2 = v1 plus the optional `rules`): every message groups into a question by its
 * normalized text, existing open-question ids echoed by the desktop are kept,
 * new questions mint `q_<n>` ids, a marker token flags a message, and the smoke
 * can queue scripted failures (429 + Retry-After, 403 premium-required, 503
 * cohost-disabled, ...) for the next tick. Every request body is recorded.
 *
 * Asker identity: the backend's fake live-chat connector cannot script author
 * names (every `Fake chat message #0` carries the same author), so askers are
 * keyed on author + destination (`<author>@<targetId>`, parsed from the app
 * message id `<session>:<platform>:<target>:<providerId>`). One fake destination
 * per repeated message therefore yields one asker per destination.
 */

export const COHOST_PROMPT_VERSION = 2
export const COHOST_PROMPT_VERSIONS = Object.freeze([1, 2])
export const COHOST_RULES_MAX = 10
export const COHOST_RULE_MAX_CHARS = 120
export const COHOST_TICK_PATH = '/api/ai/cohost/tick'
/**
 * Plan 060 S3: the spotlight lane. Served on the SAME origin as the tick, so
 * the backend's `VIDEORC_API_BASE_URL` override (dev builds only) points both
 * lanes at this fake; no second env var exists.
 */
export const COHOST_SPOTLIGHT_PATH = '/api/ai/cohost/spotlight'
export const COHOST_SPOTLIGHT_MAX_BODY_BYTES = 32 * 1024
export const COHOST_SPOTLIGHT_CANDIDATES_CAP = 20
export const COHOST_SPOTLIGHT_TRANSCRIPT_MAX_CHARS = 800
export const COHOST_TICK_MESSAGE_CAP = 60
export const COHOST_TICK_OPEN_QUESTIONS_CAP = 40

export const COHOST_TICK_REQUEST_KEYS = Object.freeze([
  'clientVersion',
  'consentToProcessChat',
  'droppedMessages',
  'messages',
  'notes',
  'openQuestions',
  'promptVersion',
  'sessionClientId',
  'streamTitle',
  'tickSeq',
  'tone'
])

export const COHOST_TICK_MESSAGE_KEYS = Object.freeze([
  'at',
  'author',
  'id',
  'platform',
  'roles',
  'text'
])

const TONES = new Set(['friendly', 'short', 'professional'])
const PLATFORMS = new Set(['twitch', 'youtube', 'x'])

export function normalizeQuestionText(text) {
  return String(text ?? '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .replace(/[?!.]+$/u, '')
}

export function askerLabel(message) {
  const segments = String(message.id ?? '').split(':')
  const target = segments.length >= 4 ? segments[segments.length - 2] : 'unknown'
  return `${message.author}@${target}`
}

export function messageHasMarker(text, marker) {
  if (!marker) return false
  return String(text ?? '')
    .split(/\s+/u)
    .some((token) => token === marker)
}

/**
 * Validate a tick request body against the wire contract. Returns an error
 * envelope `{ status, code, message }` or null when the body is acceptable.
 */
export function validateCohostTickRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalid('Request body must be a JSON object.')
  }
  if (body.consentToProcessChat !== true) {
    return {
      status: 400,
      code: 'consent-required',
      message: 'Chat processing consent is required.'
    }
  }
  if (!COHOST_PROMPT_VERSIONS.includes(body.promptVersion)) {
    return {
      status: 400,
      code: 'prompt-version-unsupported',
      message: `promptVersion ${String(body.promptVersion)} is not supported.`
    }
  }
  // v2 adds the optional `rules`; a v1 body must not carry it.
  const keys = Object.keys(body)
    .filter((key) => !(key === 'rules' && body.promptVersion >= 2))
    .sort()
  if (body.rules !== undefined && body.promptVersion >= 2) {
    const rulesOk =
      Array.isArray(body.rules) &&
      body.rules.length <= COHOST_RULES_MAX &&
      body.rules.every(
        (rule) =>
          typeof rule === 'string' &&
          rule === rule.trim() &&
          rule.length >= 1 &&
          rule.length <= COHOST_RULE_MAX_CHARS
      )
    if (!rulesOk) {
      return invalid(
        `rules must be at most ${COHOST_RULES_MAX} trimmed strings of 1-${COHOST_RULE_MAX_CHARS} characters.`
      )
    }
  }
  const unexpected = keys.filter((key) => !COHOST_TICK_REQUEST_KEYS.includes(key))
  const missing = COHOST_TICK_REQUEST_KEYS.filter((key) => !(key in body))
  if (unexpected.length > 0 || missing.length > 0) {
    return invalid(
      `Request keys do not match the contract (missing: ${missing.join(',') || '-'}; unexpected: ${unexpected.join(',') || '-'}).`
    )
  }
  if (typeof body.clientVersion !== 'string' || !body.clientVersion) {
    return invalid('clientVersion must be a non-empty string.')
  }
  if (typeof body.sessionClientId !== 'string' || !body.sessionClientId) {
    return invalid('sessionClientId must be a non-empty string.')
  }
  if (!Number.isInteger(body.tickSeq) || body.tickSeq < 1) {
    return invalid('tickSeq must be a positive integer.')
  }
  if (!TONES.has(body.tone)) {
    return invalid(`tone ${String(body.tone)} is not in the contract enum.`)
  }
  if (typeof body.notes !== 'string' || body.notes.length > 4000) {
    return invalid('notes must be a string of at most 4000 characters.')
  }
  if (body.streamTitle !== null && typeof body.streamTitle !== 'string') {
    return invalid('streamTitle must be a string or null.')
  }
  if (!Number.isInteger(body.droppedMessages) || body.droppedMessages < 0) {
    return invalid('droppedMessages must be a non-negative integer.')
  }
  if (
    !Array.isArray(body.openQuestions) ||
    body.openQuestions.length > COHOST_TICK_OPEN_QUESTIONS_CAP
  ) {
    return invalid(`openQuestions must be an array of at most ${COHOST_TICK_OPEN_QUESTIONS_CAP}.`)
  }
  for (const question of body.openQuestions) {
    if (
      !question ||
      typeof question.id !== 'string' ||
      typeof question.text !== 'string' ||
      !Number.isInteger(question.count) ||
      question.count < 1
    ) {
      return invalid('openQuestions entries must carry id, text, and a positive count.')
    }
  }
  if (!Array.isArray(body.messages) || body.messages.length > COHOST_TICK_MESSAGE_CAP) {
    return invalid(`messages must be an array of at most ${COHOST_TICK_MESSAGE_CAP}.`)
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      return invalid('messages entries must be objects.')
    }
    const messageKeys = Object.keys(message).filter(
      (key) => !COHOST_TICK_MESSAGE_KEYS.includes(key)
    )
    if (messageKeys.length > 0) {
      return invalid(`message carries unexpected keys: ${messageKeys.join(',')}.`)
    }
    if (typeof message.id !== 'string' || !message.id) {
      return invalid('message.id must be a non-empty string.')
    }
    if (!PLATFORMS.has(message.platform)) {
      return invalid(`message.platform ${String(message.platform)} is not a chat platform.`)
    }
    if (typeof message.author !== 'string') {
      return invalid('message.author must be a string.')
    }
    if (typeof message.text !== 'string' || message.text.length > 500) {
      return invalid('message.text must be a string of at most 500 characters.')
    }
    if (typeof message.at !== 'string' || Number.isNaN(Date.parse(message.at))) {
      return invalid('message.at must be an ISO-8601 timestamp.')
    }
    if (
      message.roles !== undefined &&
      (!Array.isArray(message.roles) || message.roles.some((role) => typeof role !== 'string'))
    ) {
      return invalid('message.roles must be an array of strings when present.')
    }
  }
  return null
}

function invalid(message) {
  return { status: 400, code: 'invalid-request', message }
}

export const COHOST_SPOTLIGHT_REQUEST_KEYS = Object.freeze([
  'candidates',
  'clientVersion',
  'consentToProcessChat',
  'seq',
  'sessionClientId',
  'transcript'
])

const SPOTLIGHT_CANDIDATE_KEYS = new Set([
  'at',
  'author',
  'id',
  'questionId',
  'questionText',
  'roles',
  'text'
])

/**
 * Validate a spotlight request body the way `cohost-spotlight.ts` does
 * (zod, trimmed lengths, unique ids). Returns an error envelope or null.
 */
export function validateCohostSpotlightRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalid('Request body must be a JSON object.')
  }
  if (body.consentToProcessChat !== true) {
    return {
      status: 400,
      code: 'consent-required',
      message: 'Chat processing consent is required.'
    }
  }
  const keys = Object.keys(body).sort()
  const unexpected = keys.filter((key) => !COHOST_SPOTLIGHT_REQUEST_KEYS.includes(key))
  const missing = COHOST_SPOTLIGHT_REQUEST_KEYS.filter((key) => !(key in body))
  if (unexpected.length > 0 || missing.length > 0) {
    return invalid(
      `Spotlight keys do not match the contract (missing: ${missing.join(',') || '-'}; unexpected: ${unexpected.join(',') || '-'}).`
    )
  }
  const trimmedLength = (value) => (typeof value === 'string' ? value.trim().length : -1)
  if (trimmedLength(body.clientVersion) < 1 || body.clientVersion.length > 64) {
    return invalid('clientVersion must be a string of 1-64 characters.')
  }
  if (trimmedLength(body.sessionClientId) < 1 || body.sessionClientId.length > 128) {
    return invalid('sessionClientId must be a string of 1-128 characters.')
  }
  if (
    trimmedLength(body.transcript) < 1 ||
    body.transcript.trim().length > COHOST_SPOTLIGHT_TRANSCRIPT_MAX_CHARS
  ) {
    return invalid(
      `transcript must be a string of 1-${COHOST_SPOTLIGHT_TRANSCRIPT_MAX_CHARS} characters.`
    )
  }
  if (!Number.isInteger(body.seq) || body.seq < 0) {
    return invalid('seq must be a non-negative integer.')
  }
  if (
    !Array.isArray(body.candidates) ||
    body.candidates.length < 1 ||
    body.candidates.length > COHOST_SPOTLIGHT_CANDIDATES_CAP
  ) {
    return invalid(`candidates must be an array of 1-${COHOST_SPOTLIGHT_CANDIDATES_CAP}.`)
  }
  const ids = new Set()
  for (const candidate of body.candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return invalid('candidates entries must be objects.')
    }
    const extra = Object.keys(candidate).filter((key) => !SPOTLIGHT_CANDIDATE_KEYS.has(key))
    if (extra.length > 0) {
      return invalid(`candidate carries unexpected keys: ${extra.join(',')}.`)
    }
    if (trimmedLength(candidate.id) < 1 || candidate.id.length > 200) {
      return invalid('candidate.id must be a string of 1-200 characters.')
    }
    if (ids.has(candidate.id)) {
      return invalid('candidate ids must be unique.')
    }
    ids.add(candidate.id)
    if (trimmedLength(candidate.text) < 1 || candidate.text.trim().length > 500) {
      return invalid('candidate.text must be a string of 1-500 characters.')
    }
    if (trimmedLength(candidate.author) < 1 || candidate.author.trim().length > 120) {
      return invalid('candidate.author must be a string of 1-120 characters.')
    }
    if (typeof candidate.at !== 'string' || Number.isNaN(Date.parse(candidate.at))) {
      return invalid('candidate.at must be an ISO-8601 timestamp.')
    }
    if (
      candidate.roles !== undefined &&
      (!Array.isArray(candidate.roles) ||
        candidate.roles.length > 8 ||
        candidate.roles.some(
          (role) => typeof role !== 'string' || role.trim().length < 1 || role.length > 32
        ))
    ) {
      return invalid('candidate.roles must be at most 8 strings of 1-32 characters.')
    }
    if (
      candidate.questionId !== undefined &&
      (trimmedLength(candidate.questionId) < 1 || candidate.questionId.length > 80)
    ) {
      return invalid('candidate.questionId must be a string of 1-80 characters.')
    }
    if (
      candidate.questionText !== undefined &&
      (trimmedLength(candidate.questionText) < 1 || candidate.questionText.trim().length > 500)
    ) {
      return invalid('candidate.questionText must be a string of 1-500 characters.')
    }
  }
  return null
}

/**
 * Deterministic spotlight planner (pure). `matches` scripts the answer:
 * `[{ whenTranscriptIncludes, messageId, about, questionId?, answered? }]`.
 * A rule fires when the transcript contains its substring (case-insensitive)
 * AND the message is among the candidates; `questionId`/`answered` are only
 * echoed for a candidate that carried that `questionId`. Unscripted
 * candidates get `about: 0` (and `answered: 0` when they have a question),
 * like a judge that saw nothing — the desktop must treat both the same.
 */
export function planCohostSpotlight(body, matches = []) {
  const transcript = String(body.transcript ?? '').toLocaleLowerCase('en-US')
  const scripted = new Map()
  for (const rule of matches) {
    if (!rule || typeof rule.whenTranscriptIncludes !== 'string' || !rule.messageId) continue
    if (!transcript.includes(rule.whenTranscriptIncludes.toLocaleLowerCase('en-US'))) continue
    scripted.set(rule.messageId, rule)
  }
  const out = []
  for (const candidate of body.candidates ?? []) {
    const rule = scripted.get(candidate.id)
    const match = { messageId: candidate.id, about: clampUnit(rule?.about ?? 0) }
    if (candidate.questionId) {
      match.questionId = candidate.questionId
      match.answered =
        rule && rule.questionId === candidate.questionId ? clampUnit(rule.answered ?? 0) : 0
    }
    out.push(match)
  }
  return {
    seq: body.seq ?? 0,
    matches: out,
    usage: {
      inputTokens: (body.candidates?.length ?? 0) * 20,
      outputTokens: out.length,
      model: 'smoke/fake-cohost-spotlight'
    }
  }
}

function clampUnit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

/**
 * Deterministic tick planner (pure). `memory` carries the per-question asker
 * and platform unions across ticks because the request's `openQuestions` only
 * echo id/text/count; `mintId` supplies new `q_<n>` ids.
 */
export function planCohostTick(body, { mintId, flagMarker = null, memory = new Map() } = {}) {
  const openByKey = new Map()
  for (const open of body.openQuestions ?? []) {
    openByKey.set(normalizeQuestionText(open.text), open)
  }
  const groups = new Map()
  for (const message of body.messages ?? []) {
    const key = normalizeQuestionText(message.text)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(message)
  }

  const questions = []
  const seenKeys = new Set()
  const emit = (key, id, text) => {
    const batch = groups.get(key) ?? []
    const remembered = memory.get(id) ?? { askers: [], platforms: [] }
    const askers = [...remembered.askers]
    const platforms = [...remembered.platforms]
    for (const message of batch) {
      const asker = askerLabel(message)
      if (!askers.includes(asker)) askers.push(asker)
      if (!platforms.includes(message.platform)) platforms.push(message.platform)
    }
    memory.set(id, { askers, platforms })
    questions.push({
      id,
      text,
      messageIds: batch.map((message) => message.id),
      askers,
      platforms,
      priority: askers.length >= 3 ? 'high' : 'normal',
      suggestedReply: `Re: ${text}`.slice(0, 200),
      fromNotes: false
    })
    seenKeys.add(key)
  }

  for (const open of body.openQuestions ?? []) {
    const key = normalizeQuestionText(open.text)
    if (seenKeys.has(key)) continue
    emit(key, open.id, open.text)
  }
  for (const [key, batch] of groups) {
    if (seenKeys.has(key)) continue
    emit(key, mintId(), batch[0].text)
  }

  const flags = (body.messages ?? [])
    .filter((message) => messageHasMarker(message.text, flagMarker))
    .map((message) => ({
      messageId: message.id,
      kind: 'spam',
      severity: 'medium',
      reason: `Contains the smoke marker ${flagMarker}.`
    }))

  const messageCount = body.messages?.length ?? 0
  return {
    promptVersion: body.promptVersion ?? COHOST_PROMPT_VERSION,
    questions,
    resolved: [],
    flags,
    mood: messageCount >= 5 ? 'hype' : 'calm',
    usage: { inputTokens: messageCount * 10, outputTokens: 5, model: 'smoke/fake-cohost' }
  }
}

/**
 * Start the fake service. `queueFailure` scripts the NEXT tick's outcome; a
 * queued failure still records the request. Supported shapes:
 *   { status: 429, code: 'quota-exhausted', retryAfterSeconds }
 *   { status: 403, code: 'premium-required' }
 *   { status: 503, code: 'cohost-disabled' | 'ai-gateway-not-configured' }
 *   { status: 502, code: 'ai-gateway-error' }
 *   { status: 401, code: 'unauthorized' }
 *
 * The spotlight route (plan 060 S3) is scripted by `spotlightMatches` (see
 * `planCohostSpotlight`; replace at runtime with `setSpotlightMatches`),
 * records every request in `state.spotlightRequests` (separate from the tick
 * records, so tick assertions never see them), and takes its own queued
 * failures via `queueSpotlightFailure` (same shapes plus
 * `{ status: 503, code: 'spotlight-disabled' | 'judge-unconfigured' }`,
 * `{ status: 504, code: 'judge-timeout' }` and `{ status: 404 }`).
 */
export async function startFakeCohostService({
  smokeSessionToken,
  flagMarker = null,
  spotlightMatches = []
}) {
  if (typeof smokeSessionToken !== 'string' || smokeSessionToken.length < 8) {
    throw new Error('startFakeCohostService requires a smoke-only session token.')
  }
  const state = {
    requests: [],
    spotlightRequests: [],
    spotlightMatches: [...spotlightMatches],
    unauthorized: 0,
    unknownRoutes: 0,
    queuedFailures: [],
    queuedSpotlightFailures: [],
    nextQuestionNumber: 1,
    memory: new Map()
  }
  const mintId = () => `q_${state.nextQuestionNumber++}`

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === COHOST_SPOTLIGHT_PATH) {
      return serveSpotlight(req, res)
    }
    if (req.method !== 'POST' || req.url !== COHOST_TICK_PATH) {
      await drain(req)
      state.unknownRoutes += 1
      return json(res, 404, { error: { code: 'not-found', message: 'Unknown smoke route.' } })
    }
    if (req.headers.authorization !== `Bearer ${smokeSessionToken}`) {
      await drain(req)
      state.unauthorized += 1
      return json(res, 401, { error: { code: 'unauthorized', message: 'Smoke auth failed.' } })
    }
    let body
    try {
      body = JSON.parse(await readRequestBody(req))
    } catch (error) {
      return json(res, 400, {
        error: { code: 'invalid-request', message: `Body is not JSON: ${error.message}` }
      })
    }
    const record = { at: Date.now(), body, status: 200, code: null }
    state.requests.push(record)

    const failure = validateCohostTickRequest(body)
    if (failure) {
      record.status = failure.status
      record.code = failure.code
      return json(res, failure.status, {
        error: { code: failure.code, message: failure.message }
      })
    }
    const queued = state.queuedFailures.shift()
    if (queued) {
      record.status = queued.status
      record.code = queued.code
      const headers = {}
      if (Number.isFinite(queued.retryAfterSeconds)) {
        headers['retry-after'] = String(queued.retryAfterSeconds)
      }
      return json(
        res,
        queued.status,
        { error: { code: queued.code, message: queued.message ?? `Scripted ${queued.code}.` } },
        headers
      )
    }
    return json(res, 200, planCohostTick(body, { mintId, flagMarker, memory: state.memory }))
  })

  async function serveSpotlight(req, res) {
    if (req.headers.authorization !== `Bearer ${smokeSessionToken}`) {
      await drain(req)
      state.unauthorized += 1
      return json(res, 401, { error: { code: 'unauthorized', message: 'Smoke auth failed.' } })
    }
    // Like the real route: the byte budget is checked on the body before
    // anything is parsed.
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > COHOST_SPOTLIGHT_MAX_BODY_BYTES) {
      await drain(req)
      const record = { at: Date.now(), body: null, bytes: declared, status: 400, code: 'invalid-request' }
      state.spotlightRequests.push(record)
      return json(res, 400, {
        error: { code: 'invalid-request', message: 'A JSON request body of at most 32 KB is required.' }
      })
    }
    let raw
    let body
    try {
      raw = await readRequestBody(req)
      body = JSON.parse(raw)
    } catch (error) {
      return json(res, 400, {
        error: { code: 'invalid-request', message: `Body is not JSON: ${error.message}` }
      })
    }
    const record = {
      at: Date.now(),
      body,
      bytes: Buffer.byteLength(raw),
      status: 200,
      code: null
    }
    state.spotlightRequests.push(record)
    if (record.bytes > COHOST_SPOTLIGHT_MAX_BODY_BYTES) {
      record.status = 400
      record.code = 'invalid-request'
      return json(res, 400, {
        error: { code: 'invalid-request', message: 'A JSON request body of at most 32 KB is required.' }
      })
    }
    const failure = validateCohostSpotlightRequest(body)
    if (failure) {
      record.status = failure.status
      record.code = failure.code
      return json(res, failure.status, {
        error: { code: failure.code, message: failure.message }
      })
    }
    const queued = state.queuedSpotlightFailures.shift()
    if (queued) {
      record.status = queued.status
      record.code = queued.code ?? null
      const headers = {}
      if (Number.isFinite(queued.retryAfterSeconds)) {
        headers['retry-after'] = String(queued.retryAfterSeconds)
      }
      if (queued.status === 404 && !queued.code) {
        return json(res, 404, { error: { code: 'not-found', message: 'No spotlight route.' } }, headers)
      }
      return json(
        res,
        queued.status,
        { error: { code: queued.code, message: queued.message ?? `Scripted ${queued.code}.` } },
        headers
      )
    }
    return json(res, 200, planCohostSpotlight(body, state.spotlightMatches))
  }

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  const httpOrigin = `http://127.0.0.1:${address.port}`

  return {
    httpOrigin,
    state,
    queueFailure(failure) {
      if (!failure || !Number.isInteger(failure.status) || typeof failure.code !== 'string') {
        throw new Error('queueFailure requires { status, code }.')
      }
      state.queuedFailures.push(failure)
    },
    queueSpotlightFailure(failure) {
      if (
        !failure ||
        !Number.isInteger(failure.status) ||
        (failure.status !== 404 && typeof failure.code !== 'string')
      ) {
        throw new Error('queueSpotlightFailure requires { status, code } (code optional for 404).')
      }
      state.queuedSpotlightFailures.push(failure)
    },
    setSpotlightMatches(matches) {
      if (!Array.isArray(matches)) {
        throw new Error('setSpotlightMatches requires an array of rules.')
      }
      state.spotlightMatches = [...matches]
    },
    close() {
      return new Promise((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
    }
  }
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers
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

function readRequestBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        rejectBody(new Error('Request body exceeded the smoke limit.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}
