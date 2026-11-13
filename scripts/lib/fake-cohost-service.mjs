import { createServer } from 'node:http'

import { capabilitiesDocument } from './fake-transcript-service.mjs'

/**
 * Local, credential-free stand-in for videorc-web's `POST /api/ai/cohost/tick`
 * used by `pnpm smoke:cohost-fake`. It implements the Live Co-host wire contract
 * deterministically (no model), serving v1, v2 and v3 keyed off the request's
 * `promptVersion` like the real server (v2 = v1 plus the optional `rules`; v3,
 * plan 068 D7, adds the optional `transcript`, `summary`, `openPromises` and
 * per-message `firstMessage`, and answers with `summary`, `topic`, `promises`,
 * `fulfilledPromiseIds`, `recap` and per-question `onTopic`): every message
 * groups into a question by its normalized text, existing open-question ids echoed by the desktop are kept,
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

export const COHOST_PROMPT_VERSION = 3
export const COHOST_PROMPT_VERSIONS = Object.freeze([1, 2, 3, 4, 5])
/** v3 request keys, all optional; a v1/v2 body must not carry them. */
export const COHOST_TICK_V3_REQUEST_KEYS = Object.freeze(['openPromises', 'summary', 'transcript'])
/** v4 request keys (plan 164): the persona and the banter intent, optional. */
export const COHOST_TICK_V4_REQUEST_KEYS = Object.freeze(['intent', 'persona'])
/** v5 request keys (plan 225 D10): the people behind the batch, optional;
 * a message may carry `arrival`. A v4 body must not carry either. */
export const COHOST_TICK_V5_REQUEST_KEYS = Object.freeze(['viewers'])
export const COHOST_TICK_VIEWERS_CAP = 10
export const COHOST_TICK_VIEWER_MEMORIES_CAP = 3
/** Plan 225 D10: the memory pass after a stream, on the same origin. */
export const COHOST_MEMORY_PATH = '/api/ai/cohost/memory'
export const COHOST_MEMORY_PROMPT_VERSION = 1
export const COHOST_MEMORY_PEOPLE_CAP = 15
export const COHOST_MEMORY_MESSAGES_CAP = 20
export const COHOST_MEMORY_MESSAGE_MAX_CHARS = 200
export const COHOST_MEMORY_TEXT_MAX_CHARS = 100
export const COHOST_MEMORY_SUMMARY_MAX_CHARS = 280
/** The memory route takes a message from these only: a YouTube message is a 400. */
const MEMORY_MESSAGE_PLATFORMS = new Set(['twitch', 'x', 'kick'])
export const COHOST_TICK_TRANSCRIPT_MAX_CHARS = 1500
export const COHOST_TICK_SUMMARY_MAX_CHARS = 600
export const COHOST_TICK_OPEN_PROMISES_CAP = 20
export const COHOST_TICK_PROMISE_MAX_CHARS = 160
export const COHOST_TICK_TOPIC_MAX_CHARS = 60
export const COHOST_TICK_RECAP_MAX_CHARS = 140
/** A transcript containing this mints a promise with a viewers trigger. */
export const COHOST_PROMISE_PHRASE = 'i promise'
/** A message containing this earns a recap. */
export const COHOST_RECAP_PHRASE = 'what did i miss'
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
  'firstMessage',
  'id',
  'platform',
  'roles',
  'text'
])

const TONES = new Set(['friendly', 'short', 'professional'])
// Kick is a valid chat platform in every version (plan 068).
const PLATFORMS = new Set(['twitch', 'youtube', 'x', 'kick'])

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
  // v2 adds the optional `rules`; a v1 body must not carry it. v3 adds the
  // optional transcript, summary and openPromises; a v1/v2 body must not.
  const v3 = body.promptVersion >= 3
  const v4 = body.promptVersion >= 4
  const v5 = body.promptVersion >= 5
  const keys = Object.keys(body)
    .filter((key) => !(key === 'rules' && body.promptVersion >= 2))
    .filter((key) => !(v3 && COHOST_TICK_V3_REQUEST_KEYS.includes(key)))
    .filter((key) => !(v4 && COHOST_TICK_V4_REQUEST_KEYS.includes(key)))
    .filter((key) => !(v5 && COHOST_TICK_V5_REQUEST_KEYS.includes(key)))
    .sort()
  if (v3) {
    const v3Failure = validateV3RequestExtras(body)
    if (v3Failure) return v3Failure
  }
  if (v4) {
    const v4Failure = validateV4RequestExtras(body)
    if (v4Failure) return v4Failure
  }
  if (v5) {
    const v5Failure = validateV5RequestExtras(body)
    if (v5Failure) return v5Failure
  }
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
      (key) => !COHOST_TICK_MESSAGE_KEYS.includes(key) && !(v5 && key === 'arrival')
    )
    if (messageKeys.length > 0) {
      return invalid(`message carries unexpected keys: ${messageKeys.join(',')}.`)
    }
    if (message.firstMessage !== undefined) {
      if (!v3) return invalid('message.firstMessage is a v3 field.')
      if (typeof message.firstMessage !== 'boolean') {
        return invalid('message.firstMessage must be a boolean when present.')
      }
    }
    if (message.arrival !== undefined) {
      const arrivalFailure = validateArrival(message.arrival, 'message.arrival')
      if (arrivalFailure) return arrivalFailure
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

/** Plan 164: the persona (null or a named character) and the banter intent. */
function validateV4RequestExtras(body) {
  if (body.persona !== undefined && body.persona !== null) {
    const personaFailure = validatePersona(body.persona)
    if (personaFailure) return personaFailure
  }
  if (body.intent !== undefined && body.intent !== 'tick' && body.intent !== 'banter') {
    return invalid(`intent ${String(body.intent)} is not tick or banter.`)
  }
  return null
}

function validatePersona(persona) {
  if (!persona || typeof persona !== 'object' || Array.isArray(persona)) {
    return invalid('persona must be an object or null.')
  }
  const keys = Object.keys(persona).sort()
  if (JSON.stringify(keys) !== JSON.stringify(['name', 'personality'])) {
    return invalid(`persona carries unexpected keys: ${keys.join(',')}.`)
  }
  if (
    typeof persona.name !== 'string' ||
    persona.name !== persona.name.trim() ||
    persona.name.length < 1 ||
    persona.name.length > 24
  ) {
    return invalid('persona.name must be a trimmed string of 1-24 characters.')
  }
  if (typeof persona.personality !== 'string' || persona.personality.length > 1200) {
    return invalid('persona.personality must be a string of at most 1200 characters.')
  }
  return null
}

/** Plan 225 D10: `arrival` on a message or a greet item: regular, streams, awayDays?. */
function validateArrival(arrival, where) {
  if (!arrival || typeof arrival !== 'object' || Array.isArray(arrival)) {
    return invalid(`${where} must be an object when present.`)
  }
  const keys = Object.keys(arrival).filter(
    (key) => !['regular', 'streams', 'awayDays'].includes(key)
  )
  if (keys.length > 0) return invalid(`${where} carries unexpected keys: ${keys.join(',')}.`)
  if (typeof arrival.regular !== 'boolean') return invalid(`${where}.regular must be a boolean.`)
  if (!Number.isInteger(arrival.streams) || arrival.streams < 0) {
    return invalid(`${where}.streams must be a non-negative integer.`)
  }
  if (
    arrival.awayDays !== undefined &&
    (!Number.isInteger(arrival.awayDays) || arrival.awayDays < 0)
  ) {
    return invalid(`${where}.awayDays must be a non-negative integer when present.`)
  }
  return null
}

/** Plan 225 D10: the people behind the batch, at most 10, read-only context. */
function validateV5RequestExtras(body) {
  if (body.viewers === undefined) return null
  if (!Array.isArray(body.viewers) || body.viewers.length > COHOST_TICK_VIEWERS_CAP) {
    return invalid(`viewers must be an array of at most ${COHOST_TICK_VIEWERS_CAP}.`)
  }
  for (const viewer of body.viewers) {
    if (!viewer || typeof viewer !== 'object') return invalid('viewers entries must be objects.')
    const keys = Object.keys(viewer).filter(
      (key) => !['name', 'platform', 'regular', 'streams', 'memories', 'note'].includes(key)
    )
    if (keys.length > 0) return invalid(`viewer carries unexpected keys: ${keys.join(',')}.`)
    if (typeof viewer.name !== 'string' || !viewer.name || viewer.name.length > 160) {
      return invalid('viewer.name must be a string of 1-160 characters.')
    }
    if (!PLATFORMS.has(viewer.platform)) {
      return invalid(`viewer.platform ${String(viewer.platform)} is not a chat platform.`)
    }
    if (typeof viewer.regular !== 'boolean') return invalid('viewer.regular must be a boolean.')
    if (!Number.isInteger(viewer.streams) || viewer.streams < 0) {
      return invalid('viewer.streams must be a non-negative integer.')
    }
    if (
      !Array.isArray(viewer.memories) ||
      viewer.memories.length > COHOST_TICK_VIEWER_MEMORIES_CAP ||
      viewer.memories.some(
        (memory) =>
          typeof memory !== 'string' || !memory || memory.length > COHOST_MEMORY_TEXT_MAX_CHARS
      )
    ) {
      return invalid(
        `viewer.memories must be at most ${COHOST_TICK_VIEWER_MEMORIES_CAP} strings of 1-${COHOST_MEMORY_TEXT_MAX_CHARS} characters.`
      )
    }
    if (
      viewer.note !== undefined &&
      (typeof viewer.note !== 'string' || viewer.note.length > 300)
    ) {
      return invalid('viewer.note must be a string of at most 300 characters when present.')
    }
  }
  return null
}

/**
 * Plan 225 D10: the memory pass's request against the route's strict zod
 * shape. A YouTube message is refused (never dropped): the desktop must
 * never send one. Returns an error envelope or null.
 */
export function validateCohostMemoryRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalid('Request body must be a JSON object.')
  }
  if (body.consentToProcessChat !== true) {
    return {
      status: 403,
      code: 'consent-required',
      message: 'Chat processing consent is required.'
    }
  }
  if (body.promptVersion !== COHOST_MEMORY_PROMPT_VERSION) {
    return {
      status: 400,
      code: 'prompt-version-unsupported',
      message: `promptVersion ${String(body.promptVersion)} is not supported.`
    }
  }
  const keys = Object.keys(body).sort()
  const expected = [
    'clientVersion',
    'consentToProcessChat',
    'counts',
    'people',
    'persona',
    'promptVersion',
    'sessionClientId',
    'streamTitle'
  ]
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    return invalid(`Memory request keys do not match the contract: ${keys.join(',')}.`)
  }
  if (typeof body.clientVersion !== 'string' || !body.clientVersion) {
    return invalid('clientVersion must be a non-empty string.')
  }
  if (typeof body.sessionClientId !== 'string' || !body.sessionClientId) {
    return invalid('sessionClientId must be a non-empty string.')
  }
  if (body.persona !== null) {
    const personaFailure = validatePersona(body.persona)
    if (personaFailure) return personaFailure
  }
  if (
    body.streamTitle !== null &&
    (typeof body.streamTitle !== 'string' || body.streamTitle.length > 300)
  ) {
    return invalid('streamTitle must be a string of at most 300 characters or null.')
  }
  const counts = body.counts
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    return invalid('counts must be an object.')
  }
  const countKeys = Object.keys(counts).sort()
  if (
    JSON.stringify(countKeys) !==
    JSON.stringify(['comebacks', 'firstTimers', 'firstTimersStayed', 'regularsBack'])
  ) {
    return invalid(`counts carries unexpected keys: ${countKeys.join(',')}.`)
  }
  for (const key of countKeys) {
    if (!Number.isInteger(counts[key]) || counts[key] < 0) {
      return invalid(`counts.${key} must be a non-negative integer.`)
    }
  }
  if (
    !Array.isArray(body.people) ||
    body.people.length < 1 ||
    body.people.length > COHOST_MEMORY_PEOPLE_CAP
  ) {
    return invalid(`people must be an array of 1-${COHOST_MEMORY_PEOPLE_CAP}.`)
  }
  const refs = new Set()
  for (const person of body.people) {
    if (!person || typeof person !== 'object') return invalid('people entries must be objects.')
    const personKeys = Object.keys(person).filter(
      (key) =>
        ![
          'ref',
          'name',
          'platforms',
          'regular',
          'streams',
          'messages',
          'memories',
          'note'
        ].includes(key)
    )
    if (personKeys.length > 0)
      return invalid(`person carries unexpected keys: ${personKeys.join(',')}.`)
    if (
      typeof person.ref !== 'string' ||
      !person.ref ||
      person.ref.length > 80 ||
      refs.has(person.ref)
    ) {
      return invalid('person.ref must be a unique string of 1-80 characters.')
    }
    refs.add(person.ref)
    if (typeof person.name !== 'string' || person.name.length > 120) {
      return invalid('person.name must be a string of at most 120 characters.')
    }
    if (
      !Array.isArray(person.platforms) ||
      person.platforms.length < 1 ||
      person.platforms.length > 4 ||
      person.platforms.some((platform) => !PLATFORMS.has(platform))
    ) {
      return invalid('person.platforms must be 1-4 chat platforms.')
    }
    if (typeof person.regular !== 'boolean') return invalid('person.regular must be a boolean.')
    if (!Number.isInteger(person.streams) || person.streams < 0) {
      return invalid('person.streams must be a non-negative integer.')
    }
    if (
      !Array.isArray(person.messages) ||
      person.messages.length < 1 ||
      person.messages.length > COHOST_MEMORY_MESSAGES_CAP
    ) {
      return invalid(`person.messages must be 1-${COHOST_MEMORY_MESSAGES_CAP} messages.`)
    }
    for (const message of person.messages) {
      if (!message || typeof message !== 'object')
        return invalid('messages entries must be objects.')
      const messageKeys = Object.keys(message).sort()
      if (JSON.stringify(messageKeys) !== JSON.stringify(['at', 'platform', 'text'])) {
        return invalid(`message carries unexpected keys: ${messageKeys.join(',')}.`)
      }
      if (typeof message.at !== 'string' || Number.isNaN(Date.parse(message.at))) {
        return invalid('message.at must be an ISO-8601 timestamp.')
      }
      if (!MEMORY_MESSAGE_PLATFORMS.has(message.platform)) {
        return invalid(
          `message.platform ${String(message.platform)} is not twitch, x or kick: a YouTube message is never accepted.`
        )
      }
      if (
        typeof message.text !== 'string' ||
        message.text.length < 1 ||
        message.text.length > COHOST_MEMORY_MESSAGE_MAX_CHARS
      ) {
        return invalid(`message.text must be 1-${COHOST_MEMORY_MESSAGE_MAX_CHARS} characters.`)
      }
    }
    if (person.memories !== undefined) {
      if (!Array.isArray(person.memories) || person.memories.length > 8) {
        return invalid('person.memories must be at most 8 when present.')
      }
      const ids = new Set()
      for (const memory of person.memories) {
        if (
          !memory ||
          typeof memory.id !== 'string' ||
          !memory.id ||
          memory.id.length > 80 ||
          ids.has(memory.id) ||
          typeof memory.text !== 'string' ||
          !memory.text ||
          memory.text.length > COHOST_MEMORY_TEXT_MAX_CHARS
        ) {
          return invalid(
            'person.memories entries must carry a unique id and 1-100 characters of text.'
          )
        }
        ids.add(memory.id)
      }
    }
    if (
      person.note !== undefined &&
      (typeof person.note !== 'string' || person.note.length > 300)
    ) {
      return invalid('person.note must be a string of at most 300 characters when present.')
    }
  }
  return null
}

/**
 * Deterministic memory pass (pure): every person learns one memory, "Said:"
 * plus their newest message, on that message's platform; the summary reads
 * the counts back. Nothing is updated or removed.
 */
export function planCohostMemory(body) {
  const people = body.people.map((person) => {
    const newest = person.messages[person.messages.length - 1]
    return {
      ref: person.ref,
      add: [
        {
          text: `Said: ${newest.text}`.slice(0, COHOST_MEMORY_TEXT_MAX_CHARS),
          platform: newest.platform
        }
      ],
      update: [],
      remove: []
    }
  })
  const { regularsBack, firstTimers, firstTimersStayed, comebacks } = body.counts
  const summary =
    `${regularsBack} regulars came back and ${firstTimers} first-timers chatted, ` +
    `${firstTimersStayed} of them staying a while. ${comebacks} came back after a break.`
  return {
    people,
    summary: summary.slice(0, COHOST_MEMORY_SUMMARY_MAX_CHARS),
    model: 'smoke/fake-cohost',
    usage: { inputTokens: body.people.length * 20, outputTokens: 10, model: 'smoke/fake-cohost' }
  }
}

/** The v3 extras the way `cohost.ts` checks them: the transcript is only
 * truncated (never rejected), the summary and promises are capped hard. */
function validateV3RequestExtras(body) {
  if (body.transcript !== undefined && typeof body.transcript !== 'string') {
    return invalid('transcript must be a string when present.')
  }
  if (
    body.summary !== undefined &&
    (typeof body.summary !== 'string' || body.summary.length > COHOST_TICK_SUMMARY_MAX_CHARS)
  ) {
    return invalid(`summary must be a string of at most ${COHOST_TICK_SUMMARY_MAX_CHARS}.`)
  }
  if (body.openPromises !== undefined) {
    if (
      !Array.isArray(body.openPromises) ||
      body.openPromises.length > COHOST_TICK_OPEN_PROMISES_CAP
    ) {
      return invalid(`openPromises must be an array of at most ${COHOST_TICK_OPEN_PROMISES_CAP}.`)
    }
    for (const promise of body.openPromises) {
      if (
        !promise ||
        typeof promise.id !== 'string' ||
        !promise.id ||
        typeof promise.text !== 'string' ||
        promise.text.length < 1 ||
        promise.text.length > COHOST_TICK_PROMISE_MAX_CHARS
      ) {
        return invalid(
          `openPromises entries must carry id and a text of 1-${COHOST_TICK_PROMISE_MAX_CHARS} characters.`
        )
      }
    }
  }
  return null
}

const TOPIC_STOP_WORDS = new Set([
  'the',
  'and',
  'that',
  'this',
  'with',
  'have',
  'from',
  'just',
  'like',
  'what',
  'your',
  'about',
  'will',
  'promise'
])

function contentWords(text) {
  return String(text ?? '')
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 4 && !TOPIC_STOP_WORDS.has(word))
}

/**
 * Deterministic v3 speech planner (pure, plan 068 D7): the rolling summary
 * appends the newest transcript (capped from the front), the topic is the
 * first content words of the transcript, `i promise ...` mints a promise
 * (no id) with a 100-viewer trigger while echoed open promises keep their
 * ids, `promise kept` fulfils every open promise, a message asking "what did
 * I miss" earns a recap from the summary, and a question is on topic when it
 * shares a content word with the transcript.
 */
export function planCohostSpeech(body, questions) {
  const transcript = String(body.transcript ?? '').trim()
  const previous = String(body.summary ?? '').trim()
  let summary = [previous, transcript].filter(Boolean).join(' ')
  if (summary.length > COHOST_TICK_SUMMARY_MAX_CHARS) {
    summary = summary.slice(summary.length - COHOST_TICK_SUMMARY_MAX_CHARS)
  }
  const transcriptWords = contentWords(transcript)
  const topic = transcript
    ? transcriptWords.slice(0, 3).join(' ').slice(0, COHOST_TICK_TOPIC_MAX_CHARS)
    : ''
  const lower = transcript.toLocaleLowerCase('en-US')
  const promises = (body.openPromises ?? []).map((open) => ({
    id: open.id,
    text: open.text,
    trigger: { kind: 'viewers', value: 100 }
  }))
  const fulfilledPromiseIds = lower.includes('promise kept')
    ? promises.map((promise) => promise.id)
    : []
  const kept = promises.filter((promise) => !fulfilledPromiseIds.includes(promise.id))
  const promiseAt = lower.indexOf(COHOST_PROMISE_PHRASE)
  if (promiseAt >= 0) {
    const text = transcript
      .slice(promiseAt + COHOST_PROMISE_PHRASE.length)
      .split(/[.!?]/u)[0]
      .trim()
      .slice(0, COHOST_TICK_PROMISE_MAX_CHARS)
    if (text && !kept.some((promise) => promise.text === text)) {
      kept.push({ text, trigger: { kind: 'viewers', value: 100 } })
    }
  }
  const asked = (body.messages ?? []).some((message) =>
    String(message.text ?? '')
      .toLocaleLowerCase('en-US')
      .includes(COHOST_RECAP_PHRASE)
  )
  const recap = asked && summary ? `So far: ${summary}`.slice(0, COHOST_TICK_RECAP_MAX_CHARS) : null
  const transcriptSet = new Set(transcriptWords)
  const onTopic = new Map(
    questions.map((question) => [
      question.id,
      contentWords(question.text).some((word) => transcriptSet.has(word))
    ])
  )
  return { summary, topic, promises: kept, fulfilledPromiseIds, recap, onTopic }
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
 * Scripted wire-v2 `highlights` for one tick (pure, plan 060 S5). With a rule
 * `{ score = 0.9, type = 'insight', byMarker = {} }` EVERY message of the
 * batch is suggested, and a message carrying the flag marker is ranked first
 * at 0.99: the fake deliberately suggests what it also flags, so the smoke
 * proves the desktop never puts a flagged message on stream whatever the
 * server ranked. `byMarker` maps a text token (`'#1'`) to that message's
 * score, so a smoke can make the rows a rule must skip OUTRANK the row it
 * should pick; a flagged message keeps 0.99 whatever the map says. The
 * remaining messages follow in batch order from `score`, 0.01 apart. The
 * result is sorted by score, highest first (stable). `null` means no
 * `highlights` key.
 */
// --- Buddy's planner (plan 209 S17, contract part F) --------------------------

export const BUDDY_ACT_PATH = '/api/ai/buddy/act'
export const AI_CAPABILITIES_PATH = '/api/ai/capabilities'
export const BUDDY_ACT_MAX_BODY_BYTES = 128 * 1024
export const BUDDY_ACT_REQUEST_KEYS = Object.freeze([
  'clientVersion',
  'comments',
  'consentToProcessChat',
  'names',
  'sentence',
  'seq',
  'sessionClientId',
  'state',
  'tools'
])
export const BUDDY_ACT_NAME_KINDS = Object.freeze([
  'banners',
  'destinations',
  'scenes',
  'sounds',
  'takeovers'
])
const BUDDY_ACT_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/
const BUDDY_ACT_COMMENT_KEYS = Object.freeze(['id', 'platform', 'viewerName', 'viewerText'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max
}

/**
 * The route's zod schema as the desktop must meet it (contract part F),
 * strict at every level. Returns `{ status, code, message }` for the first
 * violation, or null. Consent is checked first, like the route.
 */
export function validateBuddyActRequest(body) {
  const invalid = (message) => ({ status: 400, code: 'invalid-request', message })
  if (!isPlainObject(body)) return invalid('The body must be a JSON object.')
  if (body.consentToProcessChat !== true) {
    return { status: 403, code: 'consent-required', message: 'Cloud AI consent is required.' }
  }
  const unknown = Object.keys(body).filter((key) => !BUDDY_ACT_REQUEST_KEYS.includes(key))
  if (unknown.length) return invalid(`Unknown keys: ${unknown.join(', ')}.`)
  if (!boundedText(body.clientVersion, 1, 64)) return invalid('clientVersion is 1-64 characters.')
  if (!boundedText(body.sessionClientId, 1, 128)) {
    return invalid('sessionClientId is 1-128 characters.')
  }
  if (!Number.isInteger(body.seq) || body.seq < 0) return invalid('seq is a whole number.')
  if (!boundedText(body.sentence, 1, 500)) return invalid('sentence is 1-500 characters.')
  if (!Array.isArray(body.tools) || body.tools.length < 1 || body.tools.length > 45) {
    return invalid('tools holds 1-45 entries.')
  }
  const toolNames = new Set()
  for (const tool of body.tools) {
    if (!isPlainObject(tool)) return invalid('A tool is an object.')
    const extra = Object.keys(tool).filter(
      (key) => !['name', 'description', 'inputSchema'].includes(key)
    )
    if (extra.length) return invalid(`Unknown tool keys: ${extra.join(', ')}.`)
    if (typeof tool.name !== 'string' || !BUDDY_ACT_TOOL_NAME.test(tool.name)) {
      return invalid('Tool names are snake_case.')
    }
    if (toolNames.has(tool.name)) return invalid('Tool names are unique.')
    toolNames.add(tool.name)
    if (!boundedText(tool.description, 1, 400)) return invalid('A description is 1-400 characters.')
    if (!isPlainObject(tool.inputSchema) || JSON.stringify(tool.inputSchema).length > 4096) {
      return invalid('An inputSchema is an object of at most 4096 characters.')
    }
  }
  if (!isPlainObject(body.names)) return invalid('names is an object.')
  const nameKeys = Object.keys(body.names).sort()
  if (JSON.stringify(nameKeys) !== JSON.stringify([...BUDDY_ACT_NAME_KINDS])) {
    return invalid(`names has exactly ${BUDDY_ACT_NAME_KINDS.join(', ')}.`)
  }
  for (const kind of BUDDY_ACT_NAME_KINDS) {
    const list = body.names[kind]
    if (
      !Array.isArray(list) ||
      list.length > 60 ||
      !list.every((name) => boundedText(name, 1, 80))
    ) {
      return invalid(`names.${kind} is at most 60 names of 1-80 characters.`)
    }
  }
  if (!isPlainObject(body.state) || Object.keys(body.state).length > 24) {
    return invalid('state is a flat object of at most 24 keys.')
  }
  for (const [key, value] of Object.entries(body.state)) {
    const ok =
      key.length >= 1 &&
      key.length <= 40 &&
      (value === null ||
        typeof value === 'boolean' ||
        typeof value === 'number' ||
        (typeof value === 'string' && value.length <= 120) ||
        (Array.isArray(value) &&
          value.length <= 20 &&
          value.every((item) => typeof item === 'string' && item.length <= 80)))
    if (!ok) return invalid(`state.${key} is not a flat value.`)
  }
  if (body.comments !== undefined) {
    if (!Array.isArray(body.comments) || body.comments.length > 20) {
      return invalid('comments holds at most 20 entries.')
    }
    const ids = new Set()
    for (const comment of body.comments) {
      if (!isPlainObject(comment)) return invalid('A comment is an object.')
      const keys = Object.keys(comment).sort()
      if (JSON.stringify(keys) !== JSON.stringify([...BUDDY_ACT_COMMENT_KEYS])) {
        return invalid(`A comment has exactly ${BUDDY_ACT_COMMENT_KEYS.join(', ')}.`)
      }
      if (!boundedText(comment.id, 1, 200) || ids.has(comment.id)) {
        return invalid('Comment ids are unique, 1-200 characters.')
      }
      ids.add(comment.id)
      if (!PLATFORMS.has(comment.platform)) return invalid('A comment platform is unknown.')
      if (!boundedText(comment.viewerName, 1, 120) || !boundedText(comment.viewerText, 1, 500)) {
        return invalid('viewerName is 1-120 and viewerText 1-500 characters.')
      }
    }
  }
  return null
}

/** The name in `names[kind]` the sentence mentions (case-insensitive), or null. */
function mentionedName(sentence, names) {
  const said = sentence.toLowerCase()
  return (
    [...names]
      .sort((a, b) => b.length - a.length)
      .find((name) => said.includes(name.toLowerCase())) ?? null
  )
}

/**
 * A deterministic stand-in for the model: "switch to / go to <scene>" and
 * "play <sound>", in the sentence's order, with the names the request sent
 * (the desktop maps names to ids), as the real planner is told to. Anything
 * else is `unknown`. Never `stop` or `go_live` with comments (part F).
 */
export function planBuddyAct(body) {
  const sentence = String(body?.sentence ?? '')
  const lower = sentence.toLowerCase()
  const tools = new Set((body?.tools ?? []).map((tool) => tool.name))
  const calls = []
  const said = []
  const scene = /\b(switch|go|change)\b/.test(lower)
    ? mentionedName(sentence, body?.names?.scenes ?? [])
    : null
  if (scene && tools.has('switch_scene')) {
    calls.push({
      at: lower.indexOf(scene.toLowerCase()),
      tool: 'switch_scene',
      args: { sceneId: scene }
    })
    said.push(`switching to ${scene}`)
  }
  const sound = /\bplay\b/.test(lower) ? mentionedName(sentence, body?.names?.sounds ?? []) : null
  if (sound && tools.has('play_sound')) {
    calls.push({
      at: lower.indexOf(sound.toLowerCase()),
      tool: 'play_sound',
      args: { soundId: sound }
    })
    said.push(`playing ${sound}`)
  }
  const ending = /\b(end|stop)\b.*\b(stream|recording|livestream)\b/.test(lower)
  if (ending && tools.has('stop') && !body?.comments?.length) {
    calls.push({ at: lower.search(/\b(end|stop)\b/), tool: 'stop', args: {} })
    said.push('stopping')
  }
  if (!calls.length) return { calls: [], line: "Buddy didn't catch that.", unknown: true }
  calls.sort((a, b) => a.at - b.at)
  const line = `${said.join(' and ')}.`
  return {
    calls: calls.slice(0, 3).map(({ tool, args }) => ({ tool, args })),
    line: line[0].toUpperCase() + line.slice(1)
  }
}

export function planTickHighlights(messages, rule, flagMarker = null) {
  if (!rule) return null
  const baseScore = clampUnit(rule.score ?? 0.9)
  const type = typeof rule.type === 'string' ? rule.type : 'insight'
  const byMarker = Object.entries(rule.byMarker ?? {})
  const flagged = []
  const scripted = []
  const clean = []
  for (const message of messages ?? []) {
    if (messageHasMarker(message.text, flagMarker)) {
      flagged.push(message)
      continue
    }
    const entry = byMarker.find(([marker]) => messageHasMarker(message.text, marker))
    if (entry) scripted.push({ message, score: clampUnit(entry[1]) })
    else clean.push(message)
  }
  return [
    ...flagged.map((message) => ({ messageId: message.id, score: 0.99, type })),
    ...scripted.map(({ message, score }) => ({ messageId: message.id, score, type })),
    ...clean.map((message, index) => ({
      messageId: message.id,
      score: clampUnit(baseScore - index * 0.01),
      type
    }))
  ].sort((a, b) => b.score - a.score)
}

/**
 * Deterministic tick planner (pure). `memory` carries the per-question asker
 * and platform unions across ticks because the request's `openQuestions` only
 * echo id/text/count; `mintId` supplies new `q_<n>` ids. `highlights` scripts
 * the v2 `highlights` array (see `planTickHighlights`); absent by default.
 */
export function planCohostTick(
  body,
  { mintId, flagMarker = null, memory = new Map(), highlights = null } = {}
) {
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
  const response = {
    promptVersion: body.promptVersion ?? COHOST_PROMPT_VERSION,
    questions,
    resolved: [],
    flags,
    mood: messageCount >= 5 ? 'hype' : 'calm',
    usage: { inputTokens: messageCount * 10, outputTokens: 5, model: 'smoke/fake-cohost' }
  }
  const scriptedHighlights = planTickHighlights(body.messages, highlights, flagMarker)
  if (scriptedHighlights) response.highlights = scriptedHighlights
  if ((body.promptVersion ?? 0) >= 3) {
    const speech = planCohostSpeech(body, questions)
    for (const question of questions) {
      question.onTopic = speech.onTopic.get(question.id) === true
    }
    response.summary = speech.summary
    response.topic = speech.topic
    response.promises = speech.promises
    response.fulfilledPromiseIds = speech.fulfilledPromiseIds
    if (speech.recap) response.recap = speech.recap
  }
  return response
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
 *
 * `tickHighlights` (plan 060 S5; replace at runtime with `setTickHighlights`)
 * scripts the tick's v2 `highlights` (see `planTickHighlights`); every
 * successful tick record then carries the suggested ids as `highlightIds`
 * (highest score first) and their scores as `highlightScores` (id -> score).
 */
export async function startFakeCohostService({
  smokeSessionToken,
  flagMarker = null,
  spotlightMatches = [],
  tickHighlights = null,
  // Plan 209 S21: `buddy.act` in the capabilities this fake serves (null:
  // no `buddy` block, as an older server).
  buddyAct = null,
  voiceGreetings = false
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
    tickHighlights,
    nextQuestionNumber: 1,
    memory: new Map(),
    // Plan 209 S21: Buddy's planner.
    buddyAct: buddyAct === null ? null : buddyAct === true,
    buddyActOptIn: buddyAct !== null,
    actRequests: [],
    queuedActAnswers: [],
    capabilityRequests: 0,
    // Plan 225 D10: the memory pass, and the `cohost` block the capabilities
    // route serves once a smoke sets it (null: the route stays unknown).
    memoryRequests: [],
    queuedMemoryFailures: [],
    capabilities: null,
    greetRequests: [],
    greetFailure: false
  }
  const mintId = () => `q_${state.nextQuestionNumber++}`
  const responseHolds = { tick: [], spotlight: [] }
  const activeHolds = new Set()

  function holdNextResponse(lane) {
    let acknowledge
    let release
    const arrived = new Promise((resolve) => {
      acknowledge = resolve
    })
    const released = new Promise((resolve) => {
      release = resolve
    })
    const hold = { acknowledge, released, release }
    responseHolds[lane].push(hold)
    activeHolds.add(hold)
    return { arrived, release }
  }

  async function waitForRelease(lane, record) {
    const hold = responseHolds[lane].shift()
    if (!hold) return
    hold.acknowledge(record)
    await hold.released
    activeHolds.delete(hold)
  }

  // Plan 225 D10: `POST /api/ai/cohost/memory`, recorded like a tick.
  async function serveMemory(req, res) {
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
    state.memoryRequests.push(record)
    const failure = validateCohostMemoryRequest(body)
    if (failure) {
      record.status = failure.status
      record.code = failure.code
      return json(res, failure.status, { error: { code: failure.code, message: failure.message } })
    }
    const queued = state.queuedMemoryFailures.shift()
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
    return json(res, 200, planCohostMemory(body))
  }

  const server = createServer(async (req, res) => {
    if (voiceGreetings && req.method === 'POST' && req.url === '/api/ai/cohost/greet') {
      if (req.headers.authorization !== `Bearer ${smokeSessionToken}`) {
        await drain(req)
        return json(res, 401, { error: { code: 'unauthorized', message: 'Smoke auth failed.' } })
      }
      const body = JSON.parse(await readRequestBody(req))
      state.greetRequests.push(body)
      if (state.greetFailure) {
        return json(res, 503, {
          error: { code: 'ai-service-unavailable', message: 'Local greet failure.' }
        })
      }
      return json(res, 200, {
        model: 'local-greet-fake',
        lines: body.items.map((item) => ({
          id: item.id,
          text: `Hi ${item.names.join(', ')}! A rock-solid welcome from ${body.persona?.name ?? 'Buddy'}!`,
          mood: 'amused'
        }))
      })
    }
    if (req.method === 'POST' && req.url === COHOST_SPOTLIGHT_PATH) {
      return serveSpotlight(req, res)
    }
    if (req.method === 'POST' && req.url === COHOST_MEMORY_PATH) {
      return serveMemory(req, res)
    }
    if (req.method === 'POST' && req.url === BUDDY_ACT_PATH) {
      return serveBuddyAct(req, res)
    }
    // Only when a smoke opted in (`buddyAct`): every other smoke keeps its
    // own capabilities fake, and this route stays unknown for them.
    if (
      (state.buddyActOptIn || state.capabilities) &&
      req.method === 'GET' &&
      req.url?.split('?')[0] === AI_CAPABILITIES_PATH
    ) {
      await drain(req)
      if (req.headers.authorization !== `Bearer ${smokeSessionToken}`) {
        state.unauthorized += 1
        return json(res, 401, { error: { code: 'unauthorized', message: 'Smoke auth failed.' } })
      }
      state.capabilityRequests += 1
      const document = capabilitiesDocument({ monthlySecondsLimit: 72_000, remaining: 72_000 })
      if (state.buddyAct !== null) document.buddy = { act: state.buddyAct ? 1 : 0 }
      if (voiceGreetings) document.cohost = { greet: 1 }
      // Plan 225 D10: the tick version and the memory route the web speaks.
      if (state.capabilities)
        document.cohost = { ...(document.cohost ?? {}), ...state.capabilities }
      return json(res, 200, document)
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
    const planned = planCohostTick(body, {
      mintId,
      flagMarker,
      memory: state.memory,
      highlights: state.tickHighlights
    })
    if (planned.highlights) {
      record.highlightIds = planned.highlights.map((highlight) => highlight.messageId)
      record.highlightScores = Object.fromEntries(
        planned.highlights.map((highlight) => [highlight.messageId, highlight.score])
      )
    }
    await waitForRelease('tick', record)
    return json(res, 200, planned)
  })

  // Contract part F: the gates in the route's order, then a scripted answer
  // (`queueActAnswer`) or the deterministic planner. Every body is recorded.
  async function serveBuddyAct(req, res) {
    if (req.headers.authorization !== `Bearer ${smokeSessionToken}`) {
      await drain(req)
      state.unauthorized += 1
      return json(res, 401, { error: { code: 'unauthorized', message: 'Smoke auth failed.' } })
    }
    let raw
    let body
    try {
      raw = await readRequestBody(req, BUDDY_ACT_MAX_BODY_BYTES * 2)
      body = JSON.parse(raw)
    } catch (error) {
      return json(res, 400, {
        error: { code: 'invalid-request', message: `Body is not JSON: ${error.message}` }
      })
    }
    const record = { at: Date.now(), body, bytes: Buffer.byteLength(raw), status: 200, code: null }
    state.actRequests.push(record)
    if (record.bytes > BUDDY_ACT_MAX_BODY_BYTES) {
      record.status = 400
      record.code = 'invalid-request'
      return json(res, 400, {
        error: { code: 'invalid-request', message: 'A JSON body of at most 128 KB is required.' }
      })
    }
    const failure = validateBuddyActRequest(body)
    if (failure) {
      record.status = failure.status
      record.code = failure.code
      return json(res, failure.status, { error: { code: failure.code, message: failure.message } })
    }
    const queued = state.queuedActAnswers.shift()
    if (queued?.status) {
      record.status = queued.status
      record.code = queued.code
      return json(res, queued.status, {
        error: { code: queued.code, message: queued.message ?? `Scripted ${queued.code}.` }
      })
    }
    const answer = queued?.answer ?? planBuddyAct(body)
    record.answer = answer
    return json(res, 200, answer)
  }

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
      const record = {
        at: Date.now(),
        body: null,
        bytes: declared,
        status: 400,
        code: 'invalid-request'
      }
      state.spotlightRequests.push(record)
      return json(res, 400, {
        error: {
          code: 'invalid-request',
          message: 'A JSON request body of at most 32 KB is required.'
        }
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
        error: {
          code: 'invalid-request',
          message: 'A JSON request body of at most 32 KB is required.'
        }
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
        return json(
          res,
          404,
          { error: { code: 'not-found', message: 'No spotlight route.' } },
          headers
        )
      }
      return json(
        res,
        queued.status,
        { error: { code: queued.code, message: queued.message ?? `Scripted ${queued.code}.` } },
        headers
      )
    }
    const planned = planCohostSpotlight(body, state.spotlightMatches)
    await waitForRelease('spotlight', record)
    return json(res, 200, planned)
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
    holdNextTickResponse() {
      return holdNextResponse('tick')
    },
    holdNextSpotlightResponse() {
      return holdNextResponse('spotlight')
    },
    queueFailure(failure) {
      if (!failure || !Number.isInteger(failure.status) || typeof failure.code !== 'string') {
        throw new Error('queueFailure requires { status, code }.')
      }
      state.queuedFailures.push(failure)
    },
    // Plan 225 D10: the `cohost` block `GET /api/ai/capabilities` serves from
    // now on (`{ tick: 5, memory: 1 }`), or null to make the route unknown again.
    setCapabilities(cohost) {
      state.capabilities = cohost && typeof cohost === 'object' ? { ...cohost } : null
    },
    queueMemoryFailure(failure) {
      if (!failure || !Number.isInteger(failure.status) || typeof failure.code !== 'string') {
        throw new Error('queueMemoryFailure requires { status, code }.')
      }
      state.queuedMemoryFailures.push(failure)
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
    setTickHighlights(rule) {
      if (rule !== null && (typeof rule !== 'object' || Array.isArray(rule))) {
        throw new Error('setTickHighlights requires a rule object or null.')
      }
      if (
        rule?.byMarker !== undefined &&
        (typeof rule.byMarker !== 'object' ||
          rule.byMarker === null ||
          Array.isArray(rule.byMarker) ||
          !Object.values(rule.byMarker).every(Number.isFinite))
      ) {
        throw new Error('setTickHighlights byMarker must map markers to finite scores.')
      }
      state.tickHighlights = rule
    },
    /**
     * Plan 209 S21: the next planner answer, as given (a compromised or
     * confused planner may name any tool), or a failure `{ status, code }`.
     */
    queueActAnswer(next) {
      if (next?.answer && Array.isArray(next.answer.calls)) {
        state.queuedActAnswers.push({ answer: next.answer })
      } else if (Number.isInteger(next?.status) && typeof next.code === 'string') {
        state.queuedActAnswers.push(next)
      } else {
        throw new Error('queueActAnswer requires { answer: { calls, line } } or { status, code }.')
      }
    },
    setBuddyAct(enabled) {
      state.buddyAct = enabled === null ? null : enabled === true
    },
    setSpotlightMatches(matches) {
      if (!Array.isArray(matches)) {
        throw new Error('setSpotlightMatches requires an array of rules.')
      }
      state.spotlightMatches = [...matches]
    },
    close() {
      for (const hold of activeHolds) hold.release()
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
