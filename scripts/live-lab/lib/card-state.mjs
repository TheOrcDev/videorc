// Plan 178 U7 (plan 166 S6 step 4). The test card's content allowlist. The
// card is public: it is the picture the lab streams to YouTube. Everything
// that reaches it passes through here first: known fields only, each with a
// strict shape, and every string screened for anything that looks like a
// key, token, email, stream URL or home-dir path. Unknown or suspicious input
// is dropped, never shown.

export const MEMORY_ROLES = Object.freeze(['backend', 'main', 'renderer', 'gpu', 'ffmpeg'])
export const SESSION_STATES = Object.freeze(['idle', 'live', 'recording', 'both'])
export const HISTORY_LIMIT = 120 // 10 min at the journal's 5 s cadence
export const HEALTH_EVENT_LIMIT = 5
export const MAX_SCENE_ID = 15

const PATTERNS = Object.freeze({
  runId: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  scenario: /^[a-z0-9][a-z0-9-]{0,47}$/,
  appVersion: /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,24})?$/,
  stepName: /^[A-Za-z0-9][A-Za-z0-9 ._:#()+,'-]{0,63}$/,
  code: /^[a-z0-9][a-z0-9._:-]{0,63}$/i
})

// Shapes of things that must never appear on the card. Kept deliberately
// broad: a false positive hides one label, a false negative leaks a secret.
export const SENSITIVE_PATTERNS = Object.freeze([
  { name: 'email', pattern: /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i },
  {
    name: 'home path',
    pattern: /(?:\/Users\/|\/home\/|\/var\/root\b|\/private\/var\/|~\/|[A-Za-z]:\\Users\\)/
  },
  { name: 'stream url', pattern: /\b(?:rtmps?|srt|rtsp):\/\//i },
  {
    name: 'token prefix',
    pattern:
      /(?:\bya29\.|\b1\/\/0|\bghp_|\bgho_|\bghs_|\bgithub_pat_|\bsk-|\bAIza|\bxox[abprs]-|\bBearer\s|\beyJ[A-Za-z0-9_-]{8,})/
  },
  { name: 'stream key', pattern: /\b[a-z0-9]{4}(?:-[a-z0-9]{4}){3,}\b/i },
  { name: 'opaque secret', pattern: /[A-Za-z0-9+/=]{20,}/ },
  {
    name: 'secret word',
    pattern: /\b(?:secret|password|passwd|token|apikey|api_key|stream_?key)\b/i
  }
])

export function looksSensitive(text) {
  if (typeof text !== 'string') return false
  return SENSITIVE_PATTERNS.some(({ pattern }) => pattern.test(text))
}

function cleanString(value, pattern) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!pattern.test(trimmed) || looksSensitive(trimmed)) return null
  return trimmed
}

function cleanNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null
}

function cleanTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Run facts for the header. Anything that fails its shape becomes null. */
export function sanitizeRunInfo(runInfo = {}) {
  return {
    runId: cleanString(runInfo?.runId, PATTERNS.runId),
    scenario: cleanString(runInfo?.scenario, PATTERNS.scenario),
    appVersion: cleanString(runInfo?.appVersion, PATTERNS.appVersion),
    startedAt: cleanTime(runInfo?.startedAt)
  }
}

/** `setStep(3)` or `setStep({ index, total, name, sceneId })`. */
export function sanitizeStep(step) {
  const input = typeof step === 'number' ? { index: step } : (step ?? {})
  const index = Number.isInteger(input.index) && input.index >= 0 ? input.index : 0
  const total = Number.isInteger(input.total) && input.total > 0 ? input.total : null
  const sceneId =
    Number.isInteger(input.sceneId) && input.sceneId >= 0 && input.sceneId <= MAX_SCENE_ID
      ? input.sceneId
      : 0
  return { index, total, name: cleanString(input.name, PATTERNS.stepName), sceneId }
}

const SNAPSHOT_FIELDS = Object.freeze([
  'ts',
  'appVersion',
  'state',
  'memoryMb',
  'bitrateKbps',
  'droppedFrames',
  'encoderSpeed',
  'healthEventCodes',
  'openIncidents'
])

/**
 * One metrics snapshot for the card. Returns the cleaned snapshot plus the
 * names of fields that were dropped (unknown or malformed), never values.
 */
export function sanitizeSnapshot(input, now = Date.now()) {
  const dropped = []
  const snapshot = { ts: now }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { snapshot, dropped: ['(not an object)'] }
  }
  for (const key of Object.keys(input)) {
    if (!SNAPSHOT_FIELDS.includes(key))
      dropped.push(/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) ? key : '(unknown field)')
  }
  const ts = cleanTime(input.ts)
  if (ts !== null) snapshot.ts = ts
  else if (input.ts !== undefined) dropped.push('ts')

  const keep = (key, value) => {
    if (value === null || value === undefined) {
      if (input[key] !== undefined) dropped.push(key)
      return
    }
    snapshot[key] = value
  }
  keep(
    'appVersion',
    input.appVersion === undefined ? undefined : cleanString(input.appVersion, PATTERNS.appVersion)
  )
  keep(
    'state',
    SESSION_STATES.includes(input.state)
      ? input.state
      : input.state === undefined
        ? undefined
        : null
  )
  keep(
    'bitrateKbps',
    input.bitrateKbps === undefined ? undefined : cleanNumber(input.bitrateKbps, { max: 1e6 })
  )
  keep(
    'droppedFrames',
    input.droppedFrames === undefined ? undefined : cleanNumber(input.droppedFrames)
  )
  keep(
    'encoderSpeed',
    input.encoderSpeed === undefined ? undefined : cleanNumber(input.encoderSpeed, { max: 100 })
  )
  keep(
    'openIncidents',
    input.openIncidents === undefined ? undefined : cleanNumber(input.openIncidents, { max: 9999 })
  )

  if (input.memoryMb !== undefined) {
    const memory = {}
    if (input.memoryMb && typeof input.memoryMb === 'object' && !Array.isArray(input.memoryMb)) {
      for (const [role, value] of Object.entries(input.memoryMb)) {
        const mb = MEMORY_ROLES.includes(role) ? cleanNumber(value, { max: 1e6 }) : null
        if (mb === null)
          dropped.push(`memoryMb.${MEMORY_ROLES.includes(role) ? role : '(unknown role)'}`)
        else memory[role] = mb
      }
    } else {
      dropped.push('memoryMb')
    }
    if (Object.keys(memory).length) snapshot.memoryMb = memory
  }

  if (input.healthEventCodes !== undefined) {
    const codes = Array.isArray(input.healthEventCodes) ? input.healthEventCodes : []
    if (!Array.isArray(input.healthEventCodes)) dropped.push('healthEventCodes')
    const clean = []
    for (const code of codes.slice(0, 20)) {
      const value = cleanString(code, PATTERNS.code)
      if (value === null) dropped.push('healthEventCodes[]')
      else clean.push(value)
    }
    if (clean.length) snapshot.healthEventCodes = clean
  }
  return { snapshot, dropped }
}

/**
 * Maps one metrics-journal line (plan 166 S1 schema v1) to a card snapshot.
 * Per-role memory beyond the backend comes from the census (U6), which the
 * harness merges in as `memoryMb`.
 */
export function snapshotFromJournalLine(line) {
  if (!line || typeof line !== 'object') return {}
  const legs = Array.isArray(line.legs) ? line.legs : []
  const sum = (key) =>
    legs.reduce((total, leg) => (Number.isFinite(leg?.[key]) ? total + leg[key] : total), 0)
  const speeds = legs.map((leg) => leg?.speed).filter(Number.isFinite)
  const snapshot = {
    ts: line.ts,
    appVersion: line.appVersion,
    state: line.state
  }
  if (Number.isFinite(line.backendRssBytes)) {
    snapshot.memoryMb = { backend: Math.round(line.backendRssBytes / 1048576) }
  }
  if (legs.length) {
    snapshot.bitrateKbps = sum('bitrateKbps')
    snapshot.droppedFrames = sum('droppedFrames')
  }
  if (speeds.length) snapshot.encoderSpeed = Math.min(...speeds)
  if (Array.isArray(line.healthEventCodes)) snapshot.healthEventCodes = line.healthEventCodes
  for (const key of Object.keys(snapshot)) if (snapshot[key] === undefined) delete snapshot[key]
  return snapshot
}

export function createCardState(runInfo) {
  return {
    run: sanitizeRunInfo(runInfo),
    step: sanitizeStep(0),
    history: [],
    healthEvents: [],
    openIncidents: 0,
    state: null
  }
}

export function applySnapshot(state, snapshot) {
  const point = { ts: snapshot.ts }
  for (const key of ['bitrateKbps', 'droppedFrames', 'encoderSpeed']) {
    if (snapshot[key] !== undefined) point[key] = snapshot[key]
  }
  if (snapshot.memoryMb) point.memoryMb = { ...snapshot.memoryMb }
  const history = [...state.history, point].slice(-HISTORY_LIMIT)
  const healthEvents = [
    ...state.healthEvents,
    ...(snapshot.healthEventCodes ?? []).map((code) => ({ code, ts: snapshot.ts }))
  ].slice(-HEALTH_EVENT_LIMIT)
  return {
    ...state,
    run: snapshot.appVersion ? { ...state.run, appVersion: snapshot.appVersion } : state.run,
    history,
    healthEvents,
    openIncidents: snapshot.openIncidents ?? state.openIncidents,
    state: snapshot.state ?? state.state
  }
}

export function applyStep(state, step) {
  return { ...state, step: sanitizeStep(step) }
}

/** Every string in a card state, for the redaction screen. */
export function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      collectStrings(item, out)
    }
  }
  return out
}
