import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes
} from 'node:crypto'
import { createServer } from 'node:http'

import { capabilitiesDocument } from './fake-transcript-service.mjs'

/**
 * Local, credential-free Videorc Cloud control plane for the cloud smokes
 * (plan 184 C8). It stands where videorc.com stands between the desktop and a
 * real node agent, with the web's real wire shapes copied from
 * `videorc-web/lib/cloud/*`:
 *
 * - desktop routes (bearer): `GET /api/ai/capabilities` with the `plan` and
 *   `cloud` blocks, `POST /api/cloud/shows`, `GET /api/cloud/shows/current`,
 *   `POST /api/cloud/shows/:id/end`, `GET /api/cloud/allowance`;
 * - node-signed calls to the real agent: `POST /v1/shows` and
 *   `POST /v1/shows/:id/end` (`X-Videorc-Node`, `X-Videorc-Timestamp`,
 *   `X-Videorc-Signature: v1=<hex HMAC-SHA256(secret, "<ts>.<body>")>`);
 * - the node's heartbeat and usage posts, signature-checked the same way;
 * - show tokens `vcs1.<payload>.<sig>` minted with an Ed25519 key whose public
 *   half the agent holds as `VIDEORC_CLOUD_SHOW_PUBLIC_KEY`.
 *
 * Every call is recorded for the report as method, path and status only.
 * Bearer tokens, show tokens, ingest keys, SRT passphrases and stream keys
 * never reach a log.
 */

export const NODE_HEADER_ID = 'x-videorc-node'
export const NODE_HEADER_TIMESTAMP = 'x-videorc-timestamp'
export const NODE_HEADER_SIGNATURE = 'x-videorc-signature'
export const NODE_SIGNATURE_VERSION = 'v1'
export const NODE_SIGNATURE_MAX_SKEW_MS = 300_000
export const NODE_SECRET_BYTES = 32

export const SHOW_TOKEN_VERSION = 'vcs1'
export const SHOW_TOKEN_ROLE_HOST = 'host'
/** Any single show ends after 12 hours (plan 184 D18). */
export const MAX_SHOW_SECONDS = 12 * 60 * 60
export const DEFAULT_HOLD_MAX_SECONDS = 30 * 60
export const MIN_HOLD_MAX_SECONDS = 60
export const MAX_HOLD_MAX_SECONDS = 60 * 60
// Test cloud (plan 184 C6b), as `videorc-web/lib/cloud/shows.ts` has it: a
// test show is a solo show to the node, capped at 30 s, expiring 120 s after
// its creation, six an hour per account, never metered and never current.
export const TEST_SHOW_MAX_SECONDS = 30
export const TEST_SHOW_EXPIRES_SECONDS = 120
export const TEST_SHOWS_PER_HOUR = 6
export const TEST_SHOW_WINDOW_MS = 60 * 60 * 1000
/** A show the node stops reporting ends at the next heartbeat once this old. */
export const FORGOTTEN_SHOW_GRACE_MS = 30_000
export const AGENT_TIMEOUT_MS = 8_000
// SRT (plan 184 C1b), as `videorc-web/lib/cloud/shows.ts` has it: every create
// sends the node an SRT passphrase and latency (the node refuses a create
// without the passphrase), and the node's `srt` blocks reach the desktop as
// they are. The latency is VIDEORC_CLOUD_SRT_LATENCY_MS on the web, 1000 ms
// when unset.
export const DEFAULT_SRT_LATENCY_MS = 1000
export const MIN_SRT_LATENCY_MS = 120
export const MAX_SRT_LATENCY_MS = 8000

const SHOW_ID_PATTERN = /^sh_[0-9A-Za-z]{22}$/
const INGEST_KEY_PATTERN = /^[0-9A-Za-z]{32}$/
/** `srt://host:port` and nothing more: no user info, path or query. */
const SRT_URL_PATTERN = /^srt:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})$/
/** SRT takes stream ids of up to 512 characters; printable ASCII, no space. */
const SRT_STREAM_ID_PATTERN = /^[\x21-\x7e]{1,512}$/
/** SRT takes 10 to 79 characters; base62 keeps it clear of FFmpeg's option syntax. */
const SRT_PASSPHRASE_SHAPE = /^[0-9A-Za-z]{10,79}$/
const NODE_ID_PATTERN = /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** An Ed25519 SPKI DER is this fixed prefix followed by the 32 key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const RUNNER_PHASES = new Set(['starting', 'live', 'hold', 'ending', 'ended'])

function base62(length) {
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += BASE62[randomInt(BASE62.length)]
  }
  return out
}

/** `sh_` plus 22 base62 characters (plan 184 Wire shape: Ids). */
export function newShowId() {
  return `sh_${base62(22)}`
}

/** 32 base62 characters: the node's hook accepts 16 to 128 base62 only. */
export function newIngestKey() {
  return base62(32)
}

/** The show's SRT secret (C1b): 32 base62 characters, never stored by the web. */
export function newSrtPassphrase() {
  return base62(32)
}

export function isShowId(value) {
  return typeof value === 'string' && SHOW_ID_PATTERN.test(value)
}

export function isIngestKey(value) {
  return typeof value === 'string' && INGEST_KEY_PATTERN.test(value)
}

export function isNodeId(value) {
  return typeof value === 'string' && NODE_ID_PATTERN.test(value)
}

// --- Node signatures (web <-> node agent, both directions) --------------------

export function newNodeSecret() {
  return randomBytes(NODE_SECRET_BYTES)
}

export function encodeNodeSecret(secret) {
  return Buffer.from(secret).toString('base64url')
}

/** The 32 raw bytes behind a base64url or base64 value, padded or not. */
export function decodeNodeSecret(encoded) {
  const trimmed = String(encoded ?? '').trim()
  if (!/^[A-Za-z0-9_\-+/]+={0,2}$/.test(trimmed)) return null
  const normalized = trimmed.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const bytes = Buffer.from(normalized, 'base64url')
  return bytes.length === NODE_SECRET_BYTES ? bytes : null
}

/** hex HMAC-SHA256(secret, "<timestamp>.<raw body>"). Pure. */
export function nodeSignature(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
}

/** The three headers of a node-signed request. Pure. */
export function signNodeRequest({ nodeId, rawBody, secret, timestampMs }) {
  const timestamp = String(Math.floor(timestampMs))
  return {
    [NODE_HEADER_ID]: nodeId,
    [NODE_HEADER_TIMESTAMP]: timestamp,
    [NODE_HEADER_SIGNATURE]: `${NODE_SIGNATURE_VERSION}=${nodeSignature(secret, timestamp, rawBody)}`
  }
}

function constantTimeEqualHex(expectedHex, providedHex) {
  return timingSafeEqual(
    createHash('sha256').update(expectedHex, 'utf8').digest(),
    createHash('sha256').update(providedHex.toLowerCase(), 'utf8').digest()
  )
}

/**
 * The web's check of a node-signed request. `headers.get(name)` as on a
 * fetch `Headers`; `secretFor(nodeId)` returns the 32 bytes or null. Pure.
 * @returns {{ok:true,nodeId:string,timestampMs:number}|{ok:false,code:string}}
 */
export function verifyNodeRequest({ headers, nowMs, rawBody, secretFor }) {
  const nodeId = headers.get(NODE_HEADER_ID)?.trim()
  const timestamp = headers.get(NODE_HEADER_TIMESTAMP)?.trim()
  const signatureHeader = headers.get(NODE_HEADER_SIGNATURE)?.trim()
  if (!nodeId || !timestamp || !signatureHeader) {
    return { ok: false, code: 'node-signature-missing' }
  }
  if (!isNodeId(nodeId)) return { ok: false, code: 'node-unknown' }
  const secret = secretFor(nodeId)
  if (!secret) return { ok: false, code: 'node-unknown' }
  if (!/^\d{1,16}$/.test(timestamp)) return { ok: false, code: 'node-timestamp-invalid' }
  const timestampMs = Number(timestamp)
  if (Math.abs(timestampMs - nowMs) > NODE_SIGNATURE_MAX_SKEW_MS) {
    return { ok: false, code: 'node-timestamp-stale' }
  }
  const separator = signatureHeader.indexOf('=')
  const version = separator > 0 ? signatureHeader.slice(0, separator) : ''
  const provided = separator > 0 ? signatureHeader.slice(separator + 1) : ''
  if (version !== NODE_SIGNATURE_VERSION || !/^[0-9a-fA-F]{64}$/.test(provided)) {
    return { ok: false, code: 'node-signature-invalid' }
  }
  if (!constantTimeEqualHex(nodeSignature(secret, timestamp, rawBody), provided)) {
    return { ok: false, code: 'node-signature-invalid' }
  }
  return { ok: true, nodeId, timestampMs }
}

// --- Show tokens (the web mints, the desktop carries, the node checks) --------

/** A fresh Ed25519 key pair; the node takes the public half as base64url. */
export function newShowSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKeyBase64Url: showPublicKeyBase64Url(privateKey) }
}

/** `VIDEORC_CLOUD_SHOW_PUBLIC_KEY`: the 32 raw public key bytes, base64url. */
export function showPublicKeyBase64Url(privateKey) {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return Buffer.from(spki.subarray(spki.length - 32)).toString('base64url')
}

function publicKeyObject(publicKey) {
  if (typeof publicKey !== 'string') return publicKey
  return createPublicKey({
    format: 'der',
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64url')]),
    type: 'spki'
  })
}

/** `vcs1.<base64url payload>.<base64url Ed25519 signature of "vcs1.<payload>">`. */
export function mintShowToken({ key, showId, nodeId, userId, nowMs, expiresAtMs }) {
  const payload = {
    v: 1,
    sub: userId,
    show: showId,
    node: nodeId,
    role: SHOW_TOKEN_ROLE_HOST,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(expiresAtMs / 1000)
  }
  const signingInput = `${SHOW_TOKEN_VERSION}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  const signature = signBytes(null, Buffer.from(signingInput, 'utf8'), key)
  return `${signingInput}.${signature.toString('base64url')}`
}

/**
 * The node's check, mirrored: version, signature over the ASCII
 * `vcs1.<payload>`, then `exp`. Null when any of it fails.
 */
export function verifyShowToken({ token, publicKey, nowMs }) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3 || parts[0] !== SHOW_TOKEN_VERSION) return null
  const [version, payloadPart, signaturePart] = parts
  let valid
  try {
    valid = verifyBytes(
      null,
      Buffer.from(`${version}.${payloadPart}`, 'utf8'),
      publicKeyObject(publicKey),
      Buffer.from(signaturePart, 'base64url')
    )
  } catch {
    return null
  }
  if (!valid) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (
    payload?.v !== 1 ||
    typeof payload.exp !== 'number' ||
    payload.exp <= Math.floor(nowMs / 1000) ||
    payload.role !== SHOW_TOKEN_ROLE_HOST
  ) {
    return null
  }
  return payload
}

// --- The web's bodies ---------------------------------------------------------

/** Plan 185's `cloud` block: a Max account with the whole month ahead. */
export function cloudAllowanceBlock({
  nowMs,
  enabled = true,
  secondsPerMonth = 360_000,
  secondsUsed = 0,
  overageSeconds = 0
} = {}) {
  const now = new Date(nowMs ?? Date.now())
  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return {
    enabled,
    secondsPerMonth,
    secondsUsed,
    overageSeconds,
    resetAt: resetAt.toISOString(),
    talkShows: true,
    guestsOnStage: 5,
    roomSize: 10,
    recordingRetentionDays: 30
  }
}

/**
 * `GET /api/ai/capabilities` for a Max account: the Premium document the
 * other smokes serve, plus the `plan` and `cloud` blocks the desktop reads
 * into `cloud_show.rs` (`AiCapabilitiesPlan`, `AiCapabilitiesCloud`).
 */
export function capabilitiesWithCloud({ cloud, plan = { id: 'max', name: 'Max' } }) {
  return {
    ...capabilitiesDocument({ monthlySecondsLimit: 72_000, remaining: 72_000 }),
    plan,
    cloud
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integerIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null
}

function parseOutput(value, index) {
  if (!isRecord(value)) return `outputs[${index}] must be an object`
  if (value.orientation !== 'horizontal' && value.orientation !== 'vertical') {
    return `outputs[${index}].orientation must be horizontal or vertical`
  }
  const width = integerIn(value.width, 16, 3840)
  const height = integerIn(value.height, 16, 3840)
  if (width === null || height === null || Math.min(width, height) > 2160) {
    return `outputs[${index}] width and height must be whole pixels up to 3840x2160`
  }
  const fps = integerIn(value.fps, 1, 60)
  if (fps === null) return `outputs[${index}].fps must be 1 to 60`
  const videoKbps = integerIn(value.videoKbps, 100, 30_000)
  if (videoKbps === null) return `outputs[${index}].videoKbps must be 100 to 30000`
  const audioKbps = integerIn(value.audioKbps, 32, 320)
  if (audioKbps === null) return `outputs[${index}].audioKbps must be 32 to 320`
  return { orientation: value.orientation, width, height, fps, videoKbps, audioKbps }
}

/** A test is never "still live": current and /live leave it out. */
export function isTestShow(show) {
  return show?.kind === 'test'
}

/**
 * The web's rate limit on test shows (`evaluateTestShowLimit`): `recentCreatedAt`
 * are the account's test shows inside the window; at the limit, `resetAt` is
 * when the oldest of the last six ages out. A test exactly one window old no
 * longer counts. Pure.
 * @returns {{ok:true}|{ok:false,resetAt:string}}
 */
export function evaluateTestShowLimit({
  now,
  recentCreatedAt,
  limit = TEST_SHOWS_PER_HOUR,
  windowMs = TEST_SHOW_WINDOW_MS
}) {
  const inWindow = recentCreatedAt
    .filter((at) => at.getTime() > now.getTime() - windowMs)
    .sort((a, b) => a.getTime() - b.getTime())
  if (inWindow.length < limit) return { ok: true }
  const frees = inWindow[inWindow.length - limit]
  return { ok: false, resetAt: new Date(frees.getTime() + windowMs).toISOString() }
}

/**
 * The body of `POST /api/cloud/shows`, as the web parses it. Anything off is
 * one `{ message }`. Pure.
 */
export function parseCreateShowBody(value) {
  if (!isRecord(value)) return { message: 'The body must be a JSON object.' }
  if (value.kind !== 'solo' && value.kind !== 'talk' && value.kind !== 'test') {
    return { message: 'kind must be solo, talk or test.' }
  }
  if (!Array.isArray(value.outputs) || value.outputs.length < 1 || value.outputs.length > 2) {
    return { message: 'outputs must list one or two outputs.' }
  }
  const outputs = []
  for (const [index, entry] of value.outputs.entries()) {
    const output = parseOutput(entry, index)
    if (typeof output === 'string') return { message: `${output}.` }
    if (outputs.some((seen) => seen.orientation === output.orientation)) {
      return { message: 'outputs may have one output per orientation.' }
    }
    outputs.push(output)
  }
  const holdMaxSeconds =
    value.holdMaxSeconds === undefined
      ? DEFAULT_HOLD_MAX_SECONDS
      : integerIn(value.holdMaxSeconds, MIN_HOLD_MAX_SECONDS, MAX_HOLD_MAX_SECONDS)
  if (holdMaxSeconds === null) {
    return { message: `holdMaxSeconds must be ${MIN_HOLD_MAX_SECONDS} to ${MAX_HOLD_MAX_SECONDS}.` }
  }
  let client = null
  if (value.client !== undefined && value.client !== null) {
    if (
      !isRecord(value.client) ||
      typeof value.client.app !== 'string' ||
      typeof value.client.version !== 'string'
    ) {
      return { message: 'client must be { app, version }.' }
    }
    client = { app: value.client.app.slice(0, 40), version: value.client.version.slice(0, 40) }
  }
  return { kind: value.kind, outputs, holdMaxSeconds, client }
}

/** The show as the desktop and the Live page see it (`serializeCloudShow`). */
export function serializeShow(show) {
  return {
    id: show.id,
    status: show.status,
    kind: show.kind,
    nodeId: show.nodeId,
    createdAt: show.createdAt.toISOString(),
    startedAt: show.startedAt?.toISOString() ?? null,
    phaseSinceAt: show.phaseSinceAt?.toISOString() ?? null,
    lastSeenAt: show.lastSeenAt?.toISOString() ?? null,
    endedAt: show.endedAt?.toISOString() ?? null,
    endReason: show.endReason,
    expiresAt: show.expiresAt.toISOString(),
    holdMaxSeconds: show.holdMaxSeconds
  }
}

/**
 * What one heartbeat does to the shows the web knows (pure): the runner
 * phase of a reported show replaces its status, `ended` closes it, a show
 * the web does not know goes into `endShows`, and an open show the node left
 * out ends as `node-forgot` once it is past the grace. Mutates `shows`.
 * @returns {{endShows:string[], ended:string[], forgotten:string[]}}
 */
export function applyHeartbeat(shows, reported, { nodeId, now }) {
  const endShows = []
  const ended = []
  const forgotten = []
  const seen = new Set()
  for (const entry of reported) {
    seen.add(entry.showId)
    const show = shows.get(entry.showId)
    if (!show || show.nodeId !== nodeId || show.endedAt) {
      endShows.push(entry.showId)
      continue
    }
    if (entry.phase === 'ended') {
      show.status = 'ended'
      show.endedAt = now
      show.endReason = 'runner-ended'
      ended.push(show.id)
      continue
    }
    show.lastSeenAt = now
    if (show.status !== entry.phase) {
      show.status = entry.phase
      show.phaseSinceAt = now
    }
    if (!show.startedAt && (entry.startedAt || entry.phase === 'live')) {
      show.startedAt = entry.startedAt ?? now
    }
  }
  for (const show of shows.values()) {
    if (show.nodeId !== nodeId || show.endedAt || seen.has(show.id)) continue
    if (now.getTime() - show.createdAt.getTime() < FORGOTTEN_SHOW_GRACE_MS) continue
    show.status = 'ended'
    show.endedAt = now
    show.endReason = 'node-forgot'
    forgotten.push(show.id)
  }
  return { endShows, ended, forgotten }
}

function parseHeartbeatShows(body) {
  if (!Array.isArray(body.shows)) return null
  const shows = []
  for (const entry of body.shows) {
    if (!isRecord(entry) || !isShowId(entry.showId) || !RUNNER_PHASES.has(entry.phase)) {
      return null
    }
    const startedAt = typeof entry.startedAt === 'string' ? new Date(entry.startedAt) : null
    shows.push({
      showId: entry.showId,
      phase: entry.phase,
      startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null
    })
  }
  return shows
}

// --- The node agent's HTTP API --------------------------------------------------

/**
 * One node-signed request to the real agent. Errors name a status, never a
 * body: the create body carries the ingest key.
 * @returns {Promise<{status:number, json:unknown}>}
 */
export async function signedAgentRequest({
  agentUrl,
  path,
  method = 'POST',
  body,
  nodeId,
  secret,
  timeoutMs = AGENT_TIMEOUT_MS,
  nowMs = Date.now()
}) {
  const rawBody = body === undefined ? '' : JSON.stringify(body)
  const response = await fetch(`${agentUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      ...(rawBody ? { 'content-type': 'application/json' } : {}),
      ...signNodeRequest({ nodeId, rawBody, secret, timestampMs: nowMs })
    },
    body: rawBody || undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, json }
}

/**
 * A feed's `srt` block (C1b) as the web checks it: the block, or the name of
 * the first field that is wrong (never its value; the block carries the
 * passphrase). Pure.
 */
export function parseSrtBlock(value) {
  if (!isRecord(value)) return 'not-an-object'
  const url = typeof value.url === 'string' ? value.url : ''
  const port = Number(SRT_URL_PATTERN.exec(url)?.[1] ?? Number.NaN)
  if (!(port >= 1 && port <= 65_535)) return 'url'
  if (typeof value.streamId !== 'string' || !SRT_STREAM_ID_PATTERN.test(value.streamId)) {
    return 'streamId'
  }
  if (typeof value.passphrase !== 'string' || !SRT_PASSPHRASE_SHAPE.test(value.passphrase)) {
    return 'passphrase'
  }
  if (
    typeof value.latencyMs !== 'number' ||
    !Number.isInteger(value.latencyMs) ||
    value.latencyMs < MIN_SRT_LATENCY_MS ||
    value.latencyMs > MAX_SRT_LATENCY_MS
  ) {
    return 'latencyMs'
  }
  return {
    latencyMs: value.latencyMs,
    passphrase: value.passphrase,
    streamId: value.streamId,
    url
  }
}

/**
 * The node's create answer as the web reads it: the pairs go to the desktop
 * as they are, `srt` blocks included. A malformed `srt` block costs that feed
 * SRT, never the show (it lands in `droppedSrt` by field name). Pure.
 */
export function parseAgentCreateResponse(value) {
  if (!isRecord(value) || !Array.isArray(value.ingest) || value.ingest.length === 0) return null
  if (typeof value.controlUrl !== 'string' || !/^wss?:\/\//.test(value.controlUrl)) return null
  const ingest = []
  const droppedSrt = []
  for (const entry of value.ingest) {
    if (
      !isRecord(entry) ||
      (entry.orientation !== 'horizontal' && entry.orientation !== 'vertical') ||
      typeof entry.serverUrl !== 'string' ||
      !/^rtmps?:\/\//.test(entry.serverUrl) ||
      typeof entry.streamKey !== 'string' ||
      !entry.streamKey
    ) {
      return null
    }
    const pair = {
      orientation: entry.orientation,
      serverUrl: entry.serverUrl,
      streamKey: entry.streamKey
    }
    // `srt` is there only when the node takes SRT; null says the same.
    if (entry.srt !== undefined && entry.srt !== null) {
      const srt = parseSrtBlock(entry.srt)
      if (typeof srt === 'string') {
        droppedSrt.push({ orientation: entry.orientation, problem: srt })
      } else {
        pair.srt = srt
      }
    }
    ingest.push(pair)
  }
  return { controlUrl: value.controlUrl, ingest, droppedSrt }
}

// --- The server -------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.sessionToken - the bearer the desktop presents.
 * @param {{id:string, secret:Buffer, agentUrl:string}} options.node - the one node.
 * @param {import('node:crypto').KeyObject} options.signingKey - mints show tokens.
 * @param {string} [options.userId]
 * @param {object} [options.allowance] - the `cloud` block (cloudAllowanceBlock).
 * @param {number} [options.srtLatencyMs] - SRT's receive window for every show
 *   (the web's VIDEORC_CLOUD_SRT_LATENCY_MS, 1000 ms by default).
 */
export async function startFakeCloudWeb({
  sessionToken,
  node,
  signingKey,
  userId = 'user_cloud_smoke',
  allowance,
  srtLatencyMs = DEFAULT_SRT_LATENCY_MS
}) {
  if (!sessionToken || !node?.id || !node?.secret || !node?.agentUrl || !signingKey) {
    throw new Error('The fake cloud web needs a session token, a node and a signing key.')
  }
  const state = {
    shows: new Map(),
    calls: [],
    heartbeats: 0,
    endShowsSent: [],
    /** `srt` blocks the node sent malformed: show, orientation and field, never a value. */
    droppedSrt: [],
    usageReports: [],
    /** Reports of test shows: accepted so the node stops retrying, never counted. */
    testUsageIgnored: [],
    usageRejected: 0,
    signatureFailures: 0,
    capabilityRequests: 0,
    unknownRoutes: 0,
    agentCalls: [],
    /** Every token minted, in memory only: the smokes' leak scan reads it. */
    mintedTokens: []
  }
  const cloud = allowance ?? cloudAllowanceBlock({ nowMs: Date.now() })

  const openShow = () => [...state.shows.values()].find((show) => !show.endedAt) ?? null
  const control = (show, now) => {
    const token = mintShowToken({
      key: signingKey,
      showId: show.id,
      nodeId: show.nodeId,
      userId: show.userId,
      nowMs: now.getTime(),
      expiresAtMs: show.expiresAt.getTime()
    })
    state.mintedTokens.push(token)
    return { url: show.controlUrl, token }
  }
  const agent = async (path, body) => {
    const started = Date.now()
    // What a create asked the node for, never its ingest key: the smokes
    // check that a test show reaches the node as a solo show with the cap.
    const asked =
      path === '/v1/shows'
        ? { showId: body?.showId, kind: body?.kind, maxShowSeconds: body?.maxShowSeconds }
        : {}
    try {
      const result = await signedAgentRequest({
        agentUrl: node.agentUrl,
        path,
        body,
        nodeId: node.id,
        secret: node.secret
      })
      state.agentCalls.push({ path, ...asked, status: result.status, ms: Date.now() - started })
      return result
    } catch (error) {
      state.agentCalls.push({
        path,
        ...asked,
        status: null,
        error: error.message,
        ms: Date.now() - started
      })
      return { status: null, json: null }
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const now = new Date()
    const answer = (status, payload) => {
      state.calls.push({ at: now.toISOString(), method: req.method, path, status })
      json(res, status, payload)
    }
    const fail = (status, code, message, extra = {}) =>
      answer(status, { error: { code, message }, ...extra })

    // Node agent -> web, node-signed on the raw body.
    if (
      req.method === 'POST' &&
      (path === '/api/cloud/nodes/heartbeat' || path === '/api/cloud/usage')
    ) {
      const rawBody = (await readRequestBody(req, 1024 * 1024)).toString('utf8')
      const verification = verifyNodeRequest({
        headers: { get: (name) => req.headers[name] ?? null },
        nowMs: now.getTime(),
        rawBody,
        secretFor: (nodeId) => (nodeId === node.id ? node.secret : null)
      })
      if (!verification.ok) {
        state.signatureFailures += 1
        return fail(401, verification.code, 'The node signature was refused.')
      }
      let body
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = undefined
      }
      if (!isRecord(body)) {
        return fail(400, 'invalid-node-body', 'The body must be a JSON object.')
      }
      if (body.nodeId !== verification.nodeId) {
        return fail(400, 'node-id-mismatch', "The body's nodeId must be the signing node.")
      }
      if (path === '/api/cloud/nodes/heartbeat') {
        const reported = parseHeartbeatShows(body)
        if (!reported) {
          return fail(400, 'invalid-heartbeat', 'each show needs a showId and a runner phase.')
        }
        state.heartbeats += 1
        const outcome = applyHeartbeat(state.shows, reported, { nodeId: verification.nodeId, now })
        state.endShowsSent.push(...outcome.endShows)
        return answer(200, { ok: true, endShows: outcome.endShows, drain: false })
      }
      const reports = Array.isArray(body.reports) ? body.reports : null
      if (!reports) return fail(400, 'invalid-usage', 'reports must be an array.')
      const accepted = []
      for (const entry of reports) {
        const show =
          isRecord(entry) && isShowId(entry.showId) ? state.shows.get(entry.showId) : null
        if (
          !show ||
          show.nodeId !== verification.nodeId ||
          !Number.isInteger(entry.seq) ||
          !Number.isInteger(entry.liveSeconds) ||
          !Number.isInteger(entry.holdSeconds)
        ) {
          state.usageRejected += 1
          continue
        }
        // A test show's seconds count toward nothing (C6b).
        if (isTestShow(show)) {
          state.testUsageIgnored.push({ showId: entry.showId, seq: entry.seq })
          accepted.push({ showId: entry.showId, seq: entry.seq })
          continue
        }
        // Idempotent on (showId, seq): a duplicate is accepted, counted once.
        if (
          !state.usageReports.some(
            (report) => report.showId === entry.showId && report.seq === entry.seq
          )
        ) {
          state.usageReports.push({
            showId: entry.showId,
            seq: entry.seq,
            liveSeconds: entry.liveSeconds,
            holdSeconds: entry.holdSeconds,
            at: typeof entry.at === 'string' ? entry.at : null
          })
        }
        accepted.push({ showId: entry.showId, seq: entry.seq })
      }
      return answer(200, { ok: true, accepted })
    }

    // Desktop -> web: the bearer.
    if (req.headers.authorization !== `Bearer ${sessionToken}`) {
      await drain(req)
      return fail(401, 'unauthorized', 'Sign in to use Videorc Cloud.')
    }
    if (req.method === 'GET' && path === '/api/ai/capabilities') {
      await drain(req)
      state.capabilityRequests += 1
      return answer(200, capabilitiesWithCloud({ cloud }))
    }
    if (req.method === 'GET' && path === '/api/cloud/allowance') {
      await drain(req)
      return answer(200, cloud)
    }
    if (req.method === 'GET' && path === '/api/cloud/shows/current') {
      await drain(req)
      const open = openShow()
      // A test mid-run is open on the web, but never "still live" to resume.
      if (!open || isTestShow(open)) return answer(200, { show: null })
      return answer(200, { show: serializeShow(open), control: control(open, now) })
    }
    if (req.method === 'POST' && path === '/api/cloud/shows') {
      let body
      try {
        body = JSON.parse((await readRequestBody(req, 64 * 1024)).toString('utf8'))
      } catch {
        body = undefined
      }
      const parsed = parseCreateShowBody(body)
      if (!('kind' in parsed)) return fail(400, 'invalid-cloud-show', parsed.message)
      if (parsed.kind === 'talk') {
        return fail(400, 'invalid-cloud-show', 'Talk shows are not available yet.')
      }
      // A test (C6b) costs no hours; the rate limit protects the node instead.
      const isTest = parsed.kind === 'test'
      if (isTest) {
        const limit = evaluateTestShowLimit({
          now,
          recentCreatedAt: [...state.shows.values()]
            .filter((show) => show.userId === userId && isTestShow(show))
            .map((show) => show.createdAt)
        })
        if (!limit.ok) {
          return fail(429, 'cloud-test-limit', "You've run this hour's Videorc Cloud tests.", {
            resetAt: limit.resetAt
          })
        }
      }
      const open = openShow()
      if (open) {
        return fail(409, 'cloud-show-live', 'You already have a live show through Videorc Cloud.', {
          show: serializeShow(open)
        })
      }
      const showId = newShowId()
      const ingestKey = newIngestKey()
      // One passphrase per show, a test's included: the desktop picks the
      // transport (C1b).
      const srtPassphrase = newSrtPassphrase()
      const maxShowSeconds = isTest ? TEST_SHOW_MAX_SECONDS : MAX_SHOW_SECONDS
      const show = {
        id: showId,
        userId,
        kind: parsed.kind,
        nodeId: node.id,
        status: 'ready',
        createdAt: now,
        startedAt: null,
        phaseSinceAt: null,
        lastSeenAt: null,
        endedAt: null,
        endReason: null,
        expiresAt: new Date(
          now.getTime() +
            (isTest ? TEST_SHOW_EXPIRES_SECONDS : MAX_SHOW_SECONDS + parsed.holdMaxSeconds) * 1000
        ),
        holdMaxSeconds: parsed.holdMaxSeconds,
        maxShowSeconds,
        outputs: parsed.outputs,
        client: parsed.client,
        controlUrl: null,
        // Never serialized or logged; the web proper never stores either.
        ingestKey,
        srtPassphrase
      }
      state.shows.set(showId, show)
      const created = await agent('/v1/shows', {
        showId,
        userId,
        // The node knows no test kind: a test is a solo show with a short cap.
        kind: 'solo',
        outputs: parsed.outputs,
        holdMaxSeconds: parsed.holdMaxSeconds,
        maxShowSeconds,
        ingestKey,
        srtPassphrase,
        srtLatencyMs
      })
      const value = created.status === 200 ? parseAgentCreateResponse(created.json) : null
      for (const { orientation, problem } of value?.droppedSrt ?? []) {
        state.droppedSrt.push({ showId, orientation, problem })
      }
      if (!value) {
        show.status = 'ended'
        show.endedAt = now
        show.endReason =
          created.status === 503 && created.json?.error?.code === 'node-full'
            ? 'node-full'
            : created.status === null
              ? 'node-unreachable'
              : `node-${created.status}`
        return created.status === 503 && created.json?.error?.code === 'node-full'
          ? fail(
              503,
              'cloud-full',
              'Videorc Cloud is full right now. Streaming directly from this computer.'
            )
          : fail(
              503,
              'cloud-node-unreachable',
              'Videorc Cloud could not be reached. Streaming directly from this computer.'
            )
      }
      show.controlUrl = value.controlUrl
      return answer(201, {
        show: serializeShow(show),
        ingest: value.ingest,
        control: control(show, now),
        allowance: cloud
      })
    }
    const endMatch = /^\/api\/cloud\/shows\/([^/]+)\/end$/.exec(path)
    if (req.method === 'POST' && endMatch) {
      await drain(req)
      const showId = decodeURIComponent(endMatch[1])
      const show = isShowId(showId) ? state.shows.get(showId) : null
      if (!show || show.userId !== userId) {
        return fail(404, 'cloud-show-not-found', 'No such cloud show.')
      }
      if (show.endedAt) return answer(200, { ok: true })
      await agent(`/v1/shows/${encodeURIComponent(showId)}/end`, {})
      show.status = 'ended'
      show.endedAt = now
      show.endReason = 'host-ended'
      return answer(200, { ok: true })
    }
    await drain(req)
    state.unknownRoutes += 1
    return fail(404, 'not-found', 'Unknown smoke route.')
  })

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
    /** The show that is open right now, serialized, or null; never a test (C6b). */
    currentShow() {
      const open = openShow()
      return open && !isTestShow(open) ? serializeShow(open) : null
    },
    /** Every show of one kind, serialized, oldest first (the smokes read the test's). */
    showsOfKind(kind) {
      return [...state.shows.values()]
        .filter((show) => show.kind === kind)
        .map((show) => serializeShow(show))
    },
    /** A token for the show, as the web would mint for a second client. */
    tokenFor(showId) {
      const show = state.shows.get(showId)
      if (!show) throw new Error(`The fake web knows no show ${showId}.`)
      return control(show, new Date()).token
    },
    /** The show's ingest key, for a leak scan only. */
    ingestKeyFor(showId) {
      const show = state.shows.get(showId)
      if (!show) throw new Error(`The fake web knows no show ${showId}.`)
      return show.ingestKey
    },
    /** The show's SRT passphrase (C1b), for a leak scan only. */
    srtPassphraseFor(showId) {
      const show = state.shows.get(showId)
      if (!show) throw new Error(`The fake web knows no show ${showId}.`)
      return show.srtPassphrase
    },
    /** The control socket address the agent gave the show. */
    controlUrlFor(showId) {
      const show = state.shows.get(showId)
      if (!show) throw new Error(`The fake web knows no show ${showId}.`)
      return show.controlUrl
    },
    /** Ends every open show on the node (cleanup, never part of a pass). */
    async endOpenShows() {
      const ended = []
      for (const show of state.shows.values()) {
        if (show.endedAt) continue
        await agent(`/v1/shows/${encodeURIComponent(show.id)}/end`, {})
        show.status = 'ended'
        show.endedAt = new Date()
        show.endReason = 'smoke-cleanup'
        ended.push(show.id)
      }
      return ended
    },
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'private, no-store'
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
