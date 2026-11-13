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
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'

import { guestPageHtml } from './fake-cloud-guest-page.mjs'
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
 *   `X-Videorc-Signature: v2=<hex HMAC-SHA256(secret, canonical)>`, the
 *   canonical string binding direction, method, path, timestamp and body);
 * - the node's heartbeat and usage posts, signature-checked the same way in
 *   the other direction, with the web's replay guard and its rule that a
 *   heartbeat no newer than the node's newest changes nothing;
 * - show tokens `vcs1.<payload>.<sig>` minted with an Ed25519 key whose public
 *   half the agent holds as `VIDEORC_CLOUD_SHOW_PUBLIC_KEY`.
 *
 * - the lost route (plan 222 D7, L7): `POST /api/cloud/shows/:id/lost`
 *   asks the node's signed `GET /v1/health` once (8 s) and ends the show
 *   `node-unreachable` only when the node does not answer and nothing named
 *   the show in the last 15 s (`LOST_SHOW_SILENCE_MS`); that end is final (a
 *   node that comes back gets the show in `endShows`, never reopened).
 *
 * - talk shows (plan 224, S-G1), when `startFakeCloudWeb` gets a `talk`
 *   block with a local `livekit-server --dev`: `POST /api/cloud/shows` with
 *   `kind: "talk"` mints the host's and the runner's LiveKit tokens
 *   (`mintLiveKitToken`, the web's `roomGrantFor`), an invite slug and the
 *   room's limits, and hands the agent the `room` and `recording` blocks;
 *   `POST …/room/token`, `GET`/`PATCH …/room`, `POST …/invite/rotate`,
 *   `GET …/guests`, the Let in / Decline and the guest actions (remove and
 *   ban through LiveKit's server API); the public guest routes
 *   (`GET /api/guest/:slug`, `POST …/join`, `GET …/join/:requestId`,
 *   `POST …/leave`) with the `vrc_guest` cookie; the node-signed
 *   `POST /api/cloud/recordings`; and the guest page itself at
 *   `/guest/<slug>` (`fake-cloud-guest-page.mjs`) for headless browsers.
 *
 * Every call is recorded for the report as method, path and status only.
 * Bearer tokens, show tokens, ingest keys, SRT passphrases, stream keys and
 * LiveKit tokens never reach a log.
 *
 * What it does NOT mirror of `videorc-web/lib/cloud/*` (the lane 3 fidelity
 * diff of 2026-10-21, re-read 2026-11-08 at web `be159d28`). A smoke that
 * needs one of these needs the real web, or this list shrinks first:
 *
 * - the reaper (`reaper.ts`, every minute): a show silent for 5 minutes ends
 *   `runner-silent` after the same health probe, a show past `expiresAt`
 *   ends `expired`, and a node silent for 30 s is named. Here nothing ages;
 *   only the lost route probes a node. (A `runner-silent` show reported lost
 *   is still finalized `node-unreachable`, as the web does.)
 * - placement (`placement.ts`): one node, taken heard or not; never
 *   `cloud-full` from a heartbeat older than 30 s, never a region.
 * - the hours: `cloud-hours-used-up` with `resetAt` when under 5 minutes are
 *   left or the overage guard trips; `secondsUsed` never moves here
 *   (`setCloud` patches the block by hand).
 * - the cohort (`VIDEORC_CLOUD_USERS`, `VIDEORC_CLOUD_PUBLIC`): the one
 *   account is always in.
 * - the reconcile cron (`meter.ts`) and the live `cloud` block from the meter.
 * - the heartbeat's `capacity {slots, used}` checks and the `cloud_nodes`
 *   upsert; `drain` is always false.
 * - the usage report's ranges (seq 0..2^31-1, seconds >= 0 summing to a day,
 *   `at` required) and its `rejected[]` answer; negatives pass here.
 * - `phaseSinceAt` on an end, the SRT latency env range check, Next's own
 *   404/405 shapes (any unknown path answers 404 `not-found` after the
 *   bearer check).
 */

export const NODE_HEADER_ID = 'x-videorc-node'
export const NODE_HEADER_TIMESTAMP = 'x-videorc-timestamp'
export const NODE_HEADER_SIGNATURE = 'x-videorc-signature'
export const NODE_SIGNATURE_VERSION = 'v2'
export const NODE_SIGNATURE_MAX_SKEW_MS = 300_000
/** The two directions a v2 signature names; each side verifies only one. */
export const NODE_DIRECTION_WEB_TO_NODE = 'web-to-node'
export const NODE_DIRECTION_NODE_TO_WEB = 'node-to-web'
export const NODE_SECRET_BYTES = 32

export const SHOW_TOKEN_VERSION = 'vcs1'
export const SHOW_TOKEN_ROLE_HOST = 'host'

// Plan 224 talk shows: the web's constants (`lib/cloud/livekit.ts`,
// `lib/cloud/talk.ts`).
export const LIVEKIT_PERSON_TOKEN_TTL_SECONDS = 10 * 60
export const LIVEKIT_RUNNER_TOKEN_TTL_SECONDS = 12.5 * 60 * 60
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TALK_LIMITS_MAX = Object.freeze({
  guestsOnStage: 5,
  roomSize: 10,
  recordingRetentionDays: 30
})
const GUEST_ID_PATTERN = /^g_[0-9A-Za-z]{22}$/
const GUEST_REQUEST_ID_PATTERN = /^gr_[0-9A-Za-z]{22}$/
const INVITE_SLUG_PATTERN = /^[0-9A-Za-z]{16}$/
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
/** The web's create rate limit: the 13th show an hour is refused (C-W6). */
export const SHOWS_PER_HOUR = 12
export const SHOW_WINDOW_MS = 60 * 60 * 1000
/** A show the node stops reporting ends at the next heartbeat once this old. */
export const FORGOTTEN_SHOW_GRACE_MS = 30_000
export const AGENT_TIMEOUT_MS = 8_000
// The lost route (plan 222 D7), as `videorc-web/lib/cloud/shows-route.ts` has
// it: a heartbeat or usage report that named the show in the last 15 s means
// the node is alive whatever the web's own probe said. Heartbeats come every
// 10 s, and the desktop reports only after 20 s of feed loss.
export const LOST_SHOW_SILENCE_MS = 15_000
export const RUNNER_SILENT_END_REASON = 'runner-silent'
export const NODE_UNREACHABLE_END_REASON = 'node-unreachable'
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

export function newInviteSlug() {
  return base62(16)
}

export function newGuestId() {
  return `g_${base62(22)}`
}

export function newGuestRequestId() {
  return `gr_${base62(22)}`
}

export function isGuestId(value) {
  return typeof value === 'string' && GUEST_ID_PATTERN.test(value)
}

export function isGuestRequestId(value) {
  return typeof value === 'string' && GUEST_REQUEST_ID_PATTERN.test(value)
}

export function isInviteSlug(value) {
  return typeof value === 'string' && INVITE_SLUG_PATTERN.test(value)
}

export function hostIdentityOf(showId) {
  return `host:${showId}`
}

export function runnerIdentityOf(showId) {
  return `runner:${showId}`
}

/** A guest's sources (the web's `guestPublishSources`): the host's mute is this list. */
export function guestPublishSources(screenShare, microphone = true) {
  return [
    'camera',
    ...(microphone ? ['microphone'] : []),
    ...(screenShare ? ['screen_share', 'screen_share_audio'] : [])
  ]
}

/**
 * The grant each role gets (the web's `roomGrantFor`, plan 224 Wire shape
 * "Ids and tokens"). The runner is not hidden (plan 221 U3): a hidden
 * participant's tracks are invisible, so the host could never subscribe to
 * the return; the runner itself limits the return's subscribers.
 */
export function roomGrantFor({ role, room, screenShare = false, microphone = true }) {
  const base = {
    canPublish: true,
    canSubscribe: true,
    room,
    roomAdmin: false,
    roomCreate: false,
    roomJoin: true,
    roomList: false,
    roomRecord: false
  }
  if (role === 'host') {
    return {
      ...base,
      canPublishData: true,
      canPublishSources: ['camera', 'microphone', 'screen_share', 'screen_share_audio']
    }
  }
  if (role === 'runner') {
    return {
      ...base,
      canPublishData: false,
      canPublishSources: ['camera', 'microphone'],
      hidden: false
    }
  }
  return {
    ...base,
    canPublishData: false,
    canPublishSources: guestPublishSources(screenShare, microphone),
    canUpdateOwnMetadata: false
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

/**
 * A LiveKit access token as `livekit-server-sdk`'s `AccessToken` mints it:
 * an HS256 JWT with `iss` the API key, `sub` the identity, the optional
 * display name and the `video` grant. Pure: the caller passes the clock.
 */
export function mintLiveKitToken({
  apiKey,
  apiSecret,
  identity,
  name,
  grant,
  ttlSeconds,
  nowMs = Date.now()
}) {
  if (!apiKey || !apiSecret || !identity || !grant || !ttlSeconds) {
    throw new Error('A LiveKit token needs the key pair, an identity, a grant and a ttl.')
  }
  const nowSeconds = Math.floor(nowMs / 1000)
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(
    JSON.stringify({
      exp: nowSeconds + Math.floor(ttlSeconds),
      nbf: nowSeconds - 10,
      iss: apiKey,
      sub: identity,
      ...(name ? { name } : {}),
      video: grant
    })
  )
  const signature = base64Url(
    createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest()
  )
  return `${header}.${payload}.${signature}`
}

/** The claims of a LiveKit token, verified against the secret (the tests). */
export function readLiveKitToken(token, apiSecret) {
  const parts = String(token).split('.')
  if (parts.length !== 3) return null
  const expected = createHmac('sha256', apiSecret).update(`${parts[0]}.${parts[1]}`).digest()
  const given = Buffer.from(parts[2], 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * The room block of a talk show's create (the web's `parseTalkRoomOptions`):
 * the return's size, a title and the platform names. Pure.
 */
export function parseTalkRoom(value) {
  if (!isRecord(value)) return { message: 'room must be an object on a talk show.' }
  const returnWidth = integerIn(value.returnWidth, 2, 1920)
  const returnHeight = integerIn(value.returnHeight, 2, 1920)
  if (returnWidth === null || returnHeight === null || returnWidth % 2 || returnHeight % 2) {
    return { message: 'room.returnWidth and room.returnHeight must be even, 2 to 1920.' }
  }
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, 80) : ''
  const platforms = Array.isArray(value.platforms)
    ? value.platforms
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.slice(0, 32))
    : []
  return { returnWidth, returnHeight, title, platforms }
}

/**
 * `POST /api/cloud/recordings` from the node (plan 224 R-G6), node-signed:
 * one finished file under the show's prefix. Pure.
 */
export function parseRecordingReport(value) {
  if (!isRecord(value)) return { message: 'The body must be a JSON object.' }
  if (!isShowId(value.showId)) return { message: 'showId must be a show id.' }
  if (value.orientation !== 'h' && value.orientation !== 'v') {
    return { message: 'orientation must be h or v.' }
  }
  if (value.state !== 'complete' && value.state !== 'failed') {
    return { message: 'state must be complete or failed.' }
  }
  if (!Number.isInteger(value.seconds) || value.seconds < 0) {
    return { message: 'seconds must be a whole number.' }
  }
  if (!Number.isInteger(value.bytes) || value.bytes < 0) {
    return { message: 'bytes must be a whole number.' }
  }
  if (typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt))) {
    return { message: 'startedAt must be an ISO date.' }
  }
  if (typeof value.objectKey !== 'string' || !value.objectKey || value.objectKey.includes('..')) {
    return { message: 'objectKey must be a key.' }
  }
  return {
    showId: value.showId,
    orientation: value.orientation,
    state: value.state,
    seconds: value.seconds,
    bytes: value.bytes,
    startedAt: value.startedAt,
    objectKey: value.objectKey
  }
}

/** The host's guests view (the web's `buildHostGuestsView`): waiting requests and the guests in. Pure. */
export function buildHostGuestsView(requests, nowIso) {
  const waiting = requests.filter((request) => request.state === 'waiting' && !request.hidden)
  const guests = requests.filter((request) => request.state === 'let-in' && request.guestId)
  return {
    cursor: nowIso,
    declinedCount: requests.filter((request) => request.hidden).length,
    guests: guests.map((request) => ({
      guestId: request.guestId,
      name: request.name,
      joinedAt: request.decidedAt ?? request.askedAt,
      muted: request.muted === true,
      screenShareAllowed: request.screenShareAllowed === true
    })),
    requests: waiting.map((request) => ({
      requestId: request.id,
      name: request.name,
      askedAt: request.askedAt,
      device: request.device
    }))
  }
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

/**
 * The v2 canonical string, fields joined by `\n`, the raw body last:
 * `v2`, the direction, the METHOD, the URL path as sent, the timestamp, the
 * body. Pure.
 */
export function nodeCanonicalString({ direction, method, path, timestamp, rawBody }) {
  return [
    NODE_SIGNATURE_VERSION,
    direction,
    String(method).toUpperCase(),
    path,
    timestamp,
    rawBody
  ].join('\n')
}

/** hex HMAC-SHA256(secret, the v2 canonical string). Pure. */
export function nodeSignature(secret, { direction, method, path, timestamp, rawBody }) {
  return createHmac('sha256', secret)
    .update(nodeCanonicalString({ direction, method, path, timestamp, rawBody }), 'utf8')
    .digest('hex')
}

/** The three headers of a node-signed request; the web signs `web-to-node`. Pure. */
export function signNodeRequest({
  direction = NODE_DIRECTION_WEB_TO_NODE,
  method = 'POST',
  nodeId,
  path,
  rawBody,
  secret,
  timestampMs
}) {
  const timestamp = String(Math.floor(timestampMs))
  const signature = nodeSignature(secret, { direction, method, path, timestamp, rawBody })
  return {
    [NODE_HEADER_ID]: nodeId,
    [NODE_HEADER_TIMESTAMP]: timestamp,
    [NODE_HEADER_SIGNATURE]: `${NODE_SIGNATURE_VERSION}=${signature}`
  }
}

function constantTimeEqualHex(expectedHex, providedHex) {
  return timingSafeEqual(
    createHash('sha256').update(expectedHex, 'utf8').digest(),
    createHash('sha256').update(providedHex.toLowerCase(), 'utf8').digest()
  )
}

/**
 * The web's check of a node-signed request: only `node-to-web`, against the
 * method and path it routed. `headers.get(name)` as on a fetch `Headers`;
 * `secretFor(nodeId)` returns the 32 bytes or null. Pure.
 * @returns {{ok:true,nodeId:string,timestampMs:number,signature:string}|{ok:false,code:string}}
 */
export function verifyNodeRequest({
  direction = NODE_DIRECTION_NODE_TO_WEB,
  headers,
  method,
  nowMs,
  path,
  rawBody,
  secretFor
}) {
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
  const expected = nodeSignature(secret, {
    direction,
    method,
    path,
    timestamp,
    rawBody
  })
  if (!constantTimeEqualHex(expected, provided)) {
    return { ok: false, code: 'node-signature-invalid' }
  }
  return { ok: true, nodeId, timestampMs, signature: provided.toLowerCase() }
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
  // The node's encoder takes even sizes only (lane 3 R2).
  if (width % 2 !== 0 || height % 2 !== 0) {
    return `outputs[${index}] width and height must be even`
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
  let room = null
  if (value.kind === 'talk') {
    const parsed = parseTalkRoom(value.room)
    if ('message' in parsed) return { message: parsed.message }
    room = parsed
  }
  return { kind: value.kind, outputs, holdMaxSeconds, client, ...(room ? { room } : {}) }
}

/**
 * The body of `POST /api/cloud/shows/:id/lost` (plan 222 D7): every field
 * optional, the web only logs them. Anything of the wrong shape is one
 * `{ message }`. Pure.
 * @returns {{ok:true, report:{at:string|null, feedFailedSeconds:number|null, controlLost:boolean|null}}|{ok:false, message:string}}
 */
export function parseLostShowReport(value) {
  const body = value === undefined || value === null ? {} : value
  if (!isRecord(body)) return { ok: false, message: 'The body must be a JSON object.' }
  let at = null
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== 'string' || Number.isNaN(Date.parse(body.at))) {
      return { ok: false, message: 'at must be an ISO date.' }
    }
    at = body.at
  }
  let feedFailedSeconds = null
  if (body.feedFailedSeconds !== undefined && body.feedFailedSeconds !== null) {
    if (!Number.isInteger(body.feedFailedSeconds) || body.feedFailedSeconds < 0) {
      return { ok: false, message: 'feedFailedSeconds must be a whole number of seconds.' }
    }
    feedFailedSeconds = body.feedFailedSeconds
  }
  let controlLost = null
  if (body.controlLost !== undefined && body.controlLost !== null) {
    if (typeof body.controlLost !== 'boolean') {
      return { ok: false, message: 'controlLost must be true or false.' }
    }
    controlLost = body.controlLost
  }
  return { ok: true, report: { at, feedFailedSeconds, controlLost } }
}

/**
 * The reaper's and the lost route's silence rule (pure): a show nothing
 * named since `silentBefore` is silent. `lastSeenAt` falls back to
 * `createdAt`, as the web's `COALESCE` does.
 */
export function showSilentSince(show, silentBefore) {
  const heard = show.lastSeenAt ?? show.createdAt
  return heard.getTime() < silentBefore.getTime()
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
      ...signNodeRequest({ method, nodeId, path, rawBody, secret, timestampMs: nowMs })
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

/** A loopback `http://` agent: the only node allowed to hand out `ws://` and `rtmp://`. */
export function isLoopbackHttpAgent(agentUrl) {
  try {
    const url = new URL(agentUrl)
    return (
      url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

/**
 * The node's create answer as the web reads it: the pairs go to the desktop
 * as they are, `srt` blocks included. A malformed `srt` block costs that feed
 * SRT, never the show (it lands in `droppedSrt` by field name). A node reached
 * over TLS must hand out `wss://` and `rtmps://` (lane 5 S5); only a loopback
 * dev agent may hand out plaintext. Null for anything else. Pure.
 */
export function parseAgentCreateResponse(value, { plaintextAllowed = false } = {}) {
  if (!isRecord(value) || !Array.isArray(value.ingest) || value.ingest.length === 0) return null
  const controlPattern = plaintextAllowed ? /^wss?:\/\// : /^wss:\/\//
  const ingestPattern = plaintextAllowed ? /^rtmps?:\/\// : /^rtmps:\/\//
  if (typeof value.controlUrl !== 'string' || !controlPattern.test(value.controlUrl)) return null
  const ingest = []
  const droppedSrt = []
  for (const entry of value.ingest) {
    if (
      !isRecord(entry) ||
      (entry.orientation !== 'horizontal' && entry.orientation !== 'vertical') ||
      typeof entry.serverUrl !== 'string' ||
      !ingestPattern.test(entry.serverUrl) ||
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

/**
 * What the desktop hears when the node did not take a create (lane 3 R2): a
 * full node, a node that could not be reached, or a node that answered but
 * refused the show or answered nonsense, which is a bug or a misconfigured
 * node, not an outage. Still 5xx, so the desktop streams directly. Pure.
 * @param {{status:number|null, json:unknown}} created
 */
export function createFailure(created) {
  if (created.status === 503 && created.json?.error?.code === 'node-full') {
    return {
      status: 503,
      code: 'cloud-full',
      endReason: 'node-full',
      message: 'Videorc Cloud is full right now. Streaming directly from this computer.'
    }
  }
  if (created.status === null) {
    return {
      status: 503,
      code: 'cloud-node-unreachable',
      endReason: 'node-unreachable',
      message: 'Videorc Cloud could not be reached. Streaming directly from this computer.'
    }
  }
  return {
    status: 502,
    code: 'cloud-node-rejected',
    endReason: `node-${created.status}`,
    message: 'Videorc Cloud could not start this show. Streaming directly from this computer.'
  }
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
 * @param {number} [options.agentTimeoutMs] - how long a node-signed call to
 *   the agent may take (the web's 8 s; the unit tests shorten it).
 */
export async function startFakeCloudWeb({
  sessionToken,
  node,
  signingKey,
  userId = 'user_cloud_smoke',
  allowance,
  srtLatencyMs = DEFAULT_SRT_LATENCY_MS,
  agentTimeoutMs = AGENT_TIMEOUT_MS,
  /**
   * Plan 224: talk shows need a LiveKit server (`livekit-server --dev`):
   * `{ livekit: { url, httpUrl, apiKey, apiSecret }, recording?, limits?,
   * guestAssets? }`. `recording` is the target the node gets (`bucket`,
   * `endpoint`, `region`, `credentials`), prefixed per show here.
   * `guestAssets` maps `/guest-assets/<name>` to a file. Without `talk`, a
   * talk create answers 400 as before.
   */
  talk = null
}) {
  if (!sessionToken || !node?.id || !node?.secret || !node?.agentUrl || !signingKey) {
    throw new Error('The fake cloud web needs a session token, a node and a signing key.')
  }
  if (talk && !(talk.livekit?.url && talk.livekit?.apiKey && talk.livekit?.apiSecret)) {
    throw new Error('The talk block needs livekit { url, apiKey, apiSecret }.')
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
    mintedTokens: [],
    /** Node-signed requests refused as a replay, and heartbeats refused as stale. */
    replaysRefused: 0,
    staleHeartbeats: 0,
    /** `VIDEORC_CLOUD_DISABLED`: the rollback switch (`setDisabled`). */
    disabled: false,
    /**
     * Every lost report (plan 222 D7): the show, what the desktop said, what
     * the node's health probe answered and what became of the show.
     */
    lostReports: [],
    /** Plan 224: the rooms by show id (title, platforms, door, limits, invite, the old slugs). */
    rooms: new Map(),
    /** Plan 224: every guest request by id, in the order they came. */
    guestRequests: [],
    /** Plan 224: every LiveKit token minted (host, runner, guest), memory only: the leak scan. */
    livekitTokens: [],
    /** Plan 224: what LiveKit's server API was asked (method and identity, never a token). */
    livekitCalls: [],
    /** Plan 224 R-G6: the node's finished recordings. */
    recordings: [],
    /** Plan 224: the public guest routes' refusals, counted. */
    guestRefusals: 0
  }
  const enabledCloud = allowance ?? cloudAllowanceBlock({ nowMs: Date.now() })
  // While the switch is off the account's block says so, as the web's does.
  const cloudBlock = () => (state.disabled ? { ...enabledCloud, enabled: false } : enabledCloud)
  // The web's per-instance replay guard: one signature, once, for 2 x skew.
  const seenSignatures = new Map()
  let newestHeartbeatMs = 0

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
        secret: node.secret,
        timeoutMs: agentTimeoutMs
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
  // The web's one question to a node outside creates and ends (wire-notes
  // "What the web asks a node"): a signed, empty GET. Any answer at all, the
  // health body or an error envelope with any status, is a sign of life.
  const agentHealth = async () => {
    const started = Date.now()
    try {
      const result = await signedAgentRequest({
        agentUrl: node.agentUrl,
        path: '/v1/health',
        method: 'GET',
        nodeId: node.id,
        secret: node.secret,
        timeoutMs: agentTimeoutMs
      })
      state.agentCalls.push({ path: '/v1/health', status: result.status, ms: Date.now() - started })
      return 'answered'
    } catch (error) {
      state.agentCalls.push({
        path: '/v1/health',
        status: null,
        error: error.message,
        ms: Date.now() - started
      })
      return 'unreachable'
    }
  }

  // --- Plan 224: talk-show helpers -------------------------------------------
  const talkLimits = () => ({ ...TALK_LIMITS_MAX, ...(talk?.limits ?? {}) })
  const mintFor = ({ role, show, name, guestId, screenShare, microphone }) => {
    const identity =
      role === 'host'
        ? hostIdentityOf(show.id)
        : role === 'runner'
          ? runnerIdentityOf(show.id)
          : guestId
    const token = mintLiveKitToken({
      apiKey: talk.livekit.apiKey,
      apiSecret: talk.livekit.apiSecret,
      identity,
      name: role === 'runner' ? undefined : name,
      grant: roomGrantFor({ role, room: show.id, screenShare, microphone }),
      ttlSeconds:
        role === 'runner' ? LIVEKIT_RUNNER_TOKEN_TTL_SECONDS : LIVEKIT_PERSON_TOKEN_TTL_SECONDS
    })
    state.livekitTokens.push(token)
    return token
  }
  const newInvite = (room, now) => {
    if (room.invite) room.oldSlugs.add(room.invite.slug)
    const slug = newInviteSlug()
    room.invite = {
      slug,
      url: `${state.httpOrigin}/guest/${slug}`,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString()
    }
    // The old link's waiting requests expire with it (`docs/cloud.md`).
    for (const request of state.guestRequests) {
      if (request.showId === room.showId && request.slug !== slug && request.state === 'waiting') {
        request.state = 'expired'
      }
    }
    return room.invite
  }
  const roomView = (room) => ({
    room: {
      title: room.title,
      platforms: room.platforms,
      openDoor: room.openDoor,
      limits: room.limits
    },
    ...(room.invite ? { invite: room.invite } : {})
  })
  const roomOf = (slug) => {
    for (const room of state.rooms.values()) {
      if (room.invite?.slug === slug) return { room, dead: false }
      if (room.oldSlugs.has(slug)) return { room, dead: true }
    }
    return null
  }
  const showOfRoom = (room) => state.shows.get(room.showId) ?? null
  const guestsIn = (room) =>
    state.guestRequests.filter(
      (request) => request.showId === room.showId && request.state === 'let-in'
    ).length
  /** LiveKit's server API (Twirp over HTTP) with a server token: moderation and the room's end. */
  const livekitServer = async (method, body) => {
    if (!talk?.livekit?.httpUrl) return { ok: false, status: null }
    const token = mintLiveKitToken({
      apiKey: talk.livekit.apiKey,
      apiSecret: talk.livekit.apiSecret,
      identity: 'videorc-web',
      grant: { roomAdmin: true, roomCreate: true, room: body.room },
      ttlSeconds: 60
    })
    const started = Date.now()
    try {
      const response = await fetch(`${talk.livekit.httpUrl}/twirp/livekit.RoomService/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(agentTimeoutMs)
      })
      state.livekitCalls.push({
        method,
        room: body.room,
        identity: body.identity ?? null,
        status: response.status,
        ms: Date.now() - started
      })
      return { ok: response.ok, status: response.status }
    } catch (error) {
      state.livekitCalls.push({
        method,
        room: body.room,
        identity: body.identity ?? null,
        status: null,
        error: error.message,
        ms: Date.now() - started
      })
      return { ok: false, status: null }
    }
  }
  const closeRoom = async (show) => {
    const room = state.rooms.get(show.id)
    if (!room || room.closedAt) return
    room.closedAt = new Date()
    for (const request of state.guestRequests) {
      if (
        request.showId === show.id &&
        (request.state === 'waiting' || request.state === 'let-in')
      ) {
        request.state = request.state === 'waiting' ? 'expired' : 'ended'
      }
    }
    await livekitServer('DeleteRoom', { room: show.id })
  }
  const guestCookie = (req) => {
    const header = req.headers.cookie ?? ''
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === 'vrc_guest') return decodeURIComponent(rest.join('='))
    }
    return null
  }
  const guestState = (room, dead) => {
    const show = showOfRoom(room)
    if (dead) return 'invalid'
    if (!show || show.endedAt || room.closedAt) return 'ended'
    if (guestsIn(room) >= room.limits.roomSize) return 'full'
    return 'open'
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
      (path === '/api/cloud/nodes/heartbeat' ||
        path === '/api/cloud/usage' ||
        path === '/api/cloud/recordings')
    ) {
      const rawBody = (await readRequestBody(req, 1024 * 1024)).toString('utf8')
      const verification = verifyNodeRequest({
        headers: { get: (name) => req.headers[name] ?? null },
        method: req.method,
        nowMs: now.getTime(),
        path,
        rawBody,
        secretFor: (nodeId) => (nodeId === node.id ? node.secret : null)
      })
      if (!verification.ok) {
        state.signatureFailures += 1
        return fail(401, verification.code, 'The node signature was refused.')
      }
      for (const [signature, expiresAtMs] of seenSignatures) {
        if (expiresAtMs <= now.getTime()) seenSignatures.delete(signature)
      }
      if (seenSignatures.has(verification.signature)) {
        state.replaysRefused += 1
        return fail(401, 'node-request-replayed', 'The node signature was refused.')
      }
      seenSignatures.set(verification.signature, now.getTime() + 2 * NODE_SIGNATURE_MAX_SKEW_MS)
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
        // Only a heartbeat newer than the newest one speaks for the node
        // (lane 5 S2), and it speaks for the moment the node signed it.
        if (verification.timestampMs <= newestHeartbeatMs) {
          state.staleHeartbeats += 1
          return fail(
            409,
            'node-heartbeat-stale',
            'A newer heartbeat from this node was already applied.'
          )
        }
        newestHeartbeatMs = verification.timestampMs
        state.heartbeats += 1
        const heartbeatAt = new Date(Math.min(verification.timestampMs, now.getTime()))
        const outcome = applyHeartbeat(state.shows, reported, {
          nodeId: verification.nodeId,
          now: heartbeatAt
        })
        state.endShowsSent.push(...outcome.endShows)
        return answer(200, { ok: true, endShows: outcome.endShows, drain: false })
      }
      if (path === '/api/cloud/recordings') {
        // Plan 224 R-G6: one finished file. The key must sit under the
        // show's own prefix, as R2's credentials would enforce.
        const parsed = parseRecordingReport(body)
        if ('message' in parsed) return fail(400, 'invalid-recording', parsed.message)
        const show = state.shows.get(parsed.showId)
        if (!show || show.nodeId !== verification.nodeId || show.kind !== 'talk') {
          return fail(404, 'cloud-show-not-found', 'No such talk show on this node.')
        }
        const prefix = `talk/${show.userId}/${show.id}/`
        if (!parsed.objectKey.startsWith(prefix)) {
          return fail(403, 'cloud-recording-outside-prefix', 'The key is outside the show.')
        }
        const id = `rec_${base62(22)}`
        state.recordings.push({ id, nodeId: verification.nodeId, at: now.toISOString(), ...parsed })
        return answer(200, { ok: true, id })
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
        // A report names the show: the node is alive (the silence rule).
        if (!show.endedAt) show.lastSeenAt = now
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

    // --- Plan 224: the guest page and its public routes (no account) ---
    const guestAsset = /^\/guest-assets\/([A-Za-z0-9._-]+)$/.exec(path)
    if (req.method === 'GET' && guestAsset) {
      await drain(req)
      const file = talk?.guestAssets?.[guestAsset[1]]
      if (!file || !existsSync(file)) return fail(404, 'not-found', 'No such asset.')
      state.calls.push({ at: now.toISOString(), method: req.method, path, status: 200 })
      res.writeHead(200, {
        'content-type': guestAsset[1].endsWith('.mjs')
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream',
        'content-length': statSync(file).size,
        'cache-control': 'private, no-store'
      })
      createReadStream(file).pipe(res)
      return
    }
    const guestPage = /^\/guest\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && guestPage) {
      await drain(req)
      const slug = decodeURIComponent(guestPage[1])
      const found = isInviteSlug(slug) ? roomOf(slug) : null
      const html = guestPageHtml({ slug, title: found?.room.title || 'Videorc guest' })
      state.calls.push({ at: now.toISOString(), method: req.method, path, status: 200 })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex'
      })
      res.end(html)
      return
    }
    const guestRoute = /^\/api\/guest\/([^/]+)(?:\/(join|leave)(?:\/([^/]+))?)?$/.exec(path)
    if (guestRoute) {
      const slug = decodeURIComponent(guestRoute[1])
      const action = guestRoute[2] ?? null
      const requestId = guestRoute[3] ? decodeURIComponent(guestRoute[3]) : null
      const guestJson = (status, payload, cookie = null) => {
        state.calls.push({ at: now.toISOString(), method: req.method, path, status })
        const body = JSON.stringify(payload)
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'private, no-store',
          ...(cookie
            ? {
                'set-cookie': `vrc_guest=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax`
              }
            : {})
        })
        res.end(body)
      }
      const refuse = (status, code, message) => {
        state.guestRefusals += 1
        return guestJson(status, { error: { code, message } })
      }
      const found = isInviteSlug(slug) ? roomOf(slug) : null
      if (req.method === 'GET' && action === null) {
        await drain(req)
        if (!found) return guestJson(200, { show: null, state: 'invalid' })
        const live = guestState(found.room, found.dead)
        if (live !== 'open') return guestJson(200, { show: null, state: live })
        return guestJson(200, {
          show: {
            title: found.room.title,
            platforms: found.room.platforms,
            recording: Boolean(talk?.recording)
          },
          state: 'open',
          roomSize: found.room.limits.roomSize
        })
      }
      if (req.method === 'POST' && action === 'join' && requestId === null) {
        let body
        try {
          body = JSON.parse((await readRequestBody(req, 16 * 1024)).toString('utf8'))
        } catch {
          body = undefined
        }
        if (!found || found.dead)
          return refuse(404, 'guest-link-invalid', 'This link is not valid.')
        const live = guestState(found.room, false)
        if (live !== 'open') return refuse(409, `guest-show-${live}`, `This show is ${live}.`)
        const name =
          isRecord(body) && typeof body.name === 'string' ? body.name.trim().slice(0, 40) : ''
        const device = isRecord(body) && body.device === 'phone' ? 'phone' : 'computer'
        if (!name) return refuse(400, 'guest-name-missing', 'Type a name.')
        // One waiting request per browser per show (the cookie); a banned
        // browser never reaches the host again.
        const cookie = guestCookie(req)
        const mine = cookie
          ? state.guestRequests.find(
              (entry) => entry.id === cookie && entry.showId === found.room.showId
            )
          : null
        if (mine?.banned) return refuse(403, 'guest-banned', 'You were removed from this show.')
        if (mine && (mine.state === 'waiting' || mine.state === 'let-in')) {
          return guestJson(200, { requestId: mine.id }, mine.id)
        }
        const record = {
          id: newGuestRequestId(),
          showId: found.room.showId,
          slug,
          name,
          device,
          state: found.room.openDoor ? 'let-in' : 'waiting',
          guestId: found.room.openDoor ? newGuestId() : null,
          askedAt: now.toISOString(),
          decidedAt: found.room.openDoor ? now.toISOString() : null,
          muted: false,
          screenShareAllowed: false,
          banned: false,
          hidden: false
        }
        state.guestRequests.push(record)
        return guestJson(201, { requestId: record.id }, record.id)
      }
      if (req.method === 'GET' && action === 'join' && requestId) {
        await drain(req)
        const cookie = guestCookie(req)
        const asked = isGuestRequestId(requestId)
          ? state.guestRequests.find((entry) => entry.id === requestId)
          : null
        if (!asked || cookie !== asked.id)
          return refuse(404, 'guest-request-not-found', 'No such request.')
        const show = state.shows.get(asked.showId)
        if (!show || show.endedAt) return guestJson(200, { state: 'expired' })
        if (asked.state === 'waiting') return guestJson(200, { state: 'waiting' })
        if (asked.state === 'let-in' && asked.guestId) {
          // A fresh token each time while the guest is still allowed.
          const token = mintFor({
            role: 'guest',
            show,
            name: asked.name,
            guestId: asked.guestId,
            screenShare: asked.screenShareAllowed,
            microphone: !asked.muted
          })
          return guestJson(200, {
            state: 'let-in',
            room: { url: talk.livekit.url, token },
            guestId: asked.guestId,
            hostIdentity: hostIdentityOf(show.id)
          })
        }
        return guestJson(200, { state: asked.state === 'declined' ? 'declined' : 'expired' })
      }
      if (req.method === 'POST' && action === 'leave') {
        let body
        try {
          body = JSON.parse((await readRequestBody(req, 16 * 1024)).toString('utf8'))
        } catch {
          body = undefined
        }
        const cookie = guestCookie(req)
        const guestId = isRecord(body) ? body.guestId : null
        const asked = state.guestRequests.find(
          (entry) => entry.id === cookie && entry.guestId === guestId && entry.state === 'let-in'
        )
        if (!asked) return refuse(404, 'guest-not-found', 'No such guest.')
        const show = state.shows.get(asked.showId)
        const removed = show
          ? await livekitServer('RemoveParticipant', { room: show.id, identity: guestId })
          : { ok: true }
        if (!removed.ok && removed.status !== 404) {
          return refuse(502, 'cloud-rooms-unavailable', 'The room did not answer.')
        }
        asked.state = 'left'
        asked.leftAt = now.toISOString()
        return guestJson(200, { ok: true })
      }
      await drain(req)
      return refuse(404, 'not-found', 'Unknown guest route.')
    }

    // Desktop -> web: the bearer.
    if (req.headers.authorization !== `Bearer ${sessionToken}`) {
      await drain(req)
      return fail(401, 'unauthorized', 'Sign in to use Videorc Cloud.')
    }
    if (req.method === 'GET' && path === '/api/ai/capabilities') {
      await drain(req)
      state.capabilityRequests += 1
      return answer(200, capabilitiesWithCloud({ cloud: cloudBlock() }))
    }
    if (req.method === 'GET' && path === '/api/cloud/allowance') {
      await drain(req)
      return answer(200, cloudBlock())
    }
    // `current` answers with the switch off (lane 3 R1): a relaunched desktop
    // must still learn which show to resume or end. It creates nothing.
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
      if (state.disabled) {
        return fail(
          503,
          'cloud-disabled',
          'Videorc Cloud is off right now. Streaming directly from this computer.'
        )
      }
      // The web's order after the kill switch: the plan. No cloud hours, or
      // a block that says off, is 403 `cloud-not-entitled` (a plan that
      // ended mid-show still finds its open show through `current`).
      const plan = cloudBlock()
      if ((plan.secondsPerMonth ?? 0) <= 0 || !plan.enabled) {
        return fail(403, 'cloud-not-entitled', 'Videorc Cloud comes with Premium and Max.')
      }
      const parsed = parseCreateShowBody(body)
      if (!('kind' in parsed)) return fail(400, 'invalid-cloud-show', parsed.message)
      if (parsed.kind === 'talk' && !talk) {
        return fail(503, 'cloud-rooms-unavailable', 'Talk shows are not available right now.')
      }
      if (parsed.kind === 'talk' && !plan.talkShows) {
        return fail(403, 'cloud-not-entitled', 'Talk shows come with Max.')
      }
      // A test (C6b) costs no hours; the rate limit protects the node instead.
      const isTest = parsed.kind === 'test'
      if (isTest) {
        const limit = evaluateTestShowLimit({
          now,
          recentCreatedAt: [...state.shows.values()]
            .filter((show) => show.userId === userId && isTestShow(show) && !show.nodeRefused)
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
      // The web's create rate limit (lane 5 S8): after the one-open-show
      // check, every show a node took, however it ended; a create the node
      // refused or never answered doesn't count (web 52038614, C-W6). A test
      // keeps its own limit.
      if (!isTest) {
        const limit = evaluateTestShowLimit({
          now,
          recentCreatedAt: [...state.shows.values()]
            .filter((show) => show.userId === userId && !isTestShow(show) && !show.nodeRefused)
            .map((show) => show.createdAt),
          limit: SHOWS_PER_HOUR,
          windowMs: SHOW_WINDOW_MS
        })
        if (!limit.ok) {
          return fail(429, 'cloud-show-limit', "You've started this hour's Videorc Cloud shows.", {
            resetAt: limit.resetAt
          })
        }
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
      // Plan 224: the room, the runner's token and the recording target go
      // to the node with the create; the host's token comes back to the
      // desktop. The room is created on first join (livekit-server --dev).
      let talkRoom = null
      let runnerToken = null
      let recordingTarget = null
      if (parsed.kind === 'talk') {
        talkRoom = {
          showId,
          title: parsed.room.title,
          platforms: parsed.room.platforms,
          openDoor: false,
          limits: talkLimits(),
          returnWidth: parsed.room.returnWidth,
          returnHeight: parsed.room.returnHeight,
          invite: null,
          oldSlugs: new Set(),
          closedAt: null
        }
        newInvite(talkRoom, now)
        state.rooms.set(showId, talkRoom)
        runnerToken = mintFor({ role: 'runner', show })
        if (talk.recording) {
          recordingTarget = {
            bucket: talk.recording.bucket,
            endpoint: talk.recording.endpoint,
            region: talk.recording.region ?? 'auto',
            prefix: `talk/${userId}/${showId}/`,
            credentials: { ...talk.recording.credentials }
          }
        }
      }
      const created = await agent('/v1/shows', {
        showId,
        userId,
        // The node knows no test kind: a test is a solo show with a short cap.
        kind: parsed.kind === 'talk' ? 'talk' : 'solo',
        outputs: parsed.outputs,
        holdMaxSeconds: parsed.holdMaxSeconds,
        maxShowSeconds,
        ingestKey,
        srtPassphrase,
        srtLatencyMs,
        ...(talkRoom
          ? {
              room: {
                url: talk.livekit.url,
                runnerToken,
                name: showId,
                returnWidth: talkRoom.returnWidth,
                returnHeight: talkRoom.returnHeight
              }
            }
          : {}),
        ...(recordingTarget ? { recording: recordingTarget } : {})
      })
      const value =
        created.status === 200
          ? parseAgentCreateResponse(created.json, {
              plaintextAllowed: isLoopbackHttpAgent(node.agentUrl)
            })
          : null
      for (const { orientation, problem } of value?.droppedSrt ?? []) {
        state.droppedSrt.push({ showId, orientation, problem })
      }
      if (!value) {
        const failure = createFailure(created)
        show.status = 'ended'
        show.endedAt = now
        show.endReason = failure.endReason
        show.nodeRefused = true
        return fail(failure.status, failure.code, failure.message)
      }
      show.controlUrl = value.controlUrl
      return answer(201, {
        show: serializeShow(show),
        ingest: value.ingest,
        control: control(show, now),
        allowance: cloudBlock(),
        ...(talkRoom
          ? {
              room: {
                url: talk.livekit.url,
                hostToken: mintFor({ role: 'host', show, name: 'Host' }),
                name: showId
              },
              invite: talkRoom.invite,
              limits: talkRoom.limits
            }
          : {})
      })
    }
    // --- Plan 224: the talk-show routes (bearer) ---
    const talkMatch =
      /^\/api\/cloud\/shows\/([^/]+)\/(room\/token|room|invite\/rotate|guests(?:\/requests\/([^/]+)|\/([^/]+))?)$/.exec(
        path
      )
    if (talkMatch) {
      const showId = decodeURIComponent(talkMatch[1])
      const route = talkMatch[2]
      const show = isShowId(showId) ? state.shows.get(showId) : null
      const room = show ? state.rooms.get(showId) : null
      if (!show || show.userId !== userId || !room) {
        await drain(req)
        return fail(404, 'cloud-show-not-found', 'No such talk show.')
      }
      if (req.method === 'POST' && route === 'room/token') {
        await drain(req)
        if (show.endedAt) return fail(409, 'cloud-show-ended', 'The show is over.')
        return answer(200, {
          hostToken: mintFor({ role: 'host', show, name: 'Host' }),
          url: talk.livekit.url
        })
      }
      if (req.method === 'GET' && route === 'room') {
        await drain(req)
        return answer(200, roomView(room))
      }
      if (req.method === 'PATCH' && route === 'room') {
        let body
        try {
          body = JSON.parse((await readRequestBody(req, 16 * 1024)).toString('utf8'))
        } catch {
          body = undefined
        }
        if (!isRecord(body)) return fail(400, 'invalid-request', 'The body must be a JSON object.')
        if (typeof body.openDoor === 'boolean') room.openDoor = body.openDoor
        if (typeof body.title === 'string') room.title = body.title.trim().slice(0, 80)
        if (Array.isArray(body.platforms)) {
          room.platforms = body.platforms.filter((entry) => typeof entry === 'string')
        }
        return answer(200, roomView(room))
      }
      if (req.method === 'POST' && route === 'invite/rotate') {
        await drain(req)
        return answer(200, { invite: newInvite(room, now) })
      }
      if (req.method === 'GET' && route === 'guests') {
        await drain(req)
        const view = buildHostGuestsView(
          state.guestRequests.filter((request) => request.showId === showId),
          now.toISOString()
        )
        return answer(200, view)
      }
      if (req.method === 'POST' && route.startsWith('guests/requests/')) {
        let body
        try {
          body = JSON.parse((await readRequestBody(req, 16 * 1024)).toString('utf8'))
        } catch {
          body = undefined
        }
        const requestId = decodeURIComponent(talkMatch[3] ?? '')
        const decision = isRecord(body) ? body.decision : null
        if (decision !== 'let-in' && decision !== 'decline') {
          return fail(400, 'invalid-request', 'decision must be let-in or decline.')
        }
        const asked = state.guestRequests.find(
          (entry) => entry.id === requestId && entry.showId === showId
        )
        if (!asked || asked.state !== 'waiting') {
          return fail(404, 'guest-request-not-found', 'No such waiting request.')
        }
        if (decision === 'decline') {
          asked.state = 'declined'
          asked.decidedAt = now.toISOString()
          asked.hidden = true
          return answer(200, { ok: true })
        }
        if (guestsIn(room) >= room.limits.roomSize) {
          return fail(409, 'cloud-room-full', 'The room is full.')
        }
        asked.state = 'let-in'
        asked.guestId = newGuestId()
        asked.decidedAt = now.toISOString()
        return answer(200, { ok: true, guestId: asked.guestId })
      }
      if (req.method === 'POST' && route.startsWith('guests/')) {
        let body
        try {
          body = JSON.parse((await readRequestBody(req, 16 * 1024)).toString('utf8'))
        } catch {
          body = undefined
        }
        const guestId = decodeURIComponent(talkMatch[4] ?? '')
        const action = isRecord(body) ? body.action : null
        const actions = [
          'mute',
          'unmute',
          'remove',
          'ban',
          'rename',
          'allow-screen-share',
          'disallow-screen-share'
        ]
        if (!actions.includes(action)) return fail(400, 'invalid-request', 'Unknown action.')
        const guest = isGuestId(guestId)
          ? state.guestRequests.find(
              (entry) => entry.guestId === guestId && entry.showId === showId
            )
          : null
        if (!guest) return fail(404, 'guest-not-found', 'No such guest.')
        if (action === 'remove' || action === 'ban') {
          const removed = await livekitServer('RemoveParticipant', {
            room: showId,
            identity: guestId
          })
          if (!removed.ok && removed.status !== 404) {
            return fail(502, 'cloud-rooms-unavailable', 'The room did not answer.')
          }
          guest.state = 'removed'
          guest.leftAt = now.toISOString()
          if (action === 'ban') {
            guest.banned = true
            return answer(200, { ok: true, invite: newInvite(room, now) })
          }
          return answer(200, { ok: true })
        }
        if (action === 'mute' || action === 'unmute') {
          guest.muted = action === 'mute'
          return answer(200, { ok: true })
        }
        if (action === 'rename') {
          const name =
            isRecord(body) && typeof body.name === 'string' ? body.name.trim().slice(0, 40) : ''
          if (!name) return fail(400, 'invalid-request', 'A rename needs a name.')
          guest.name = name
          return answer(200, { ok: true })
        }
        guest.screenShareAllowed = action === 'allow-screen-share'
        return answer(200, { ok: true })
      }
      await drain(req)
      return fail(405, 'method-not-allowed', 'Not on this route.')
    }
    if (req.method === 'GET' && path === '/api/cloud/recordings') {
      await drain(req)
      return answer(200, {
        recordings: state.recordings.map((recording) => ({
          id: recording.id,
          showId: recording.showId,
          startedAt: recording.startedAt,
          seconds: recording.seconds,
          bytes: recording.bytes,
          orientation: recording.orientation,
          state: recording.state
        }))
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
      // Plan 224: the room goes with the show (the invite dies, the guests
      // are let go).
      await closeRoom(show)
      return answer(200, { ok: true })
    }
    // Plan 222 D7: the desktop lost its show (control socket gone, feed down
    // 20 s, `current` still live). As `handleLostCloudShow` does: ask the
    // node once, end only on its silence, and make that end final.
    const lostMatch = /^\/api\/cloud\/shows\/([^/]+)\/lost$/.exec(path)
    if (req.method === 'POST' && lostMatch) {
      let body
      try {
        const raw = (await readRequestBody(req, 16 * 1024)).toString('utf8')
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = undefined
      }
      const showId = decodeURIComponent(lostMatch[1])
      const show = isShowId(showId) ? state.shows.get(showId) : null
      if (!show || show.userId !== userId) {
        return fail(404, 'cloud-show-not-found', 'No such cloud show.')
      }
      const parsed = parseLostShowReport(body)
      if (!parsed.ok) return fail(400, 'invalid-request', parsed.message)
      const record = {
        showId,
        at: now.toISOString(),
        ...parsed.report,
        probe: null,
        probeMs: null,
        outcome: null,
        answeredAt: null
      }
      state.lostReports.push(record)
      const done = (outcome) => {
        record.outcome = outcome
        record.answeredAt = new Date().toISOString()
        return answer(200, { show: serializeShow(show) })
      }
      // The reaper's runner-silent end is a guess a heartbeat may reopen; the
      // desktop is about to stream directly, so make the end final.
      if (show.endedAt && show.endReason === RUNNER_SILENT_END_REASON) {
        show.endReason = NODE_UNREACHABLE_END_REASON
        show.endedAt = now
        return done('finalized-runner-silent')
      }
      // Already over: the desktop reads the end and streams directly.
      if (show.endedAt) return done('already-ended')
      const probeStarted = Date.now()
      record.probe = await agentHealth()
      record.probeMs = Date.now() - probeStarted
      if (record.probe === 'answered') return done('kept:node-answered')
      // A heartbeat or usage report that named the show in the last 15 s, or
      // while the web waited on the node, keeps it: the node is alive.
      const decidedAt = new Date()
      if (show.endedAt) return done('already-ended')
      if (!showSilentSince(show, new Date(decidedAt.getTime() - LOST_SHOW_SILENCE_MS))) {
        return done('kept:heard-meanwhile')
      }
      show.status = 'ended'
      show.endedAt = decidedAt
      show.endReason = NODE_UNREACHABLE_END_REASON
      return done('ended')
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
  state.httpOrigin = `http://127.0.0.1:${address.port}`
  return {
    httpOrigin: state.httpOrigin,
    state,
    /** `VIDEORC_CLOUD_DISABLED` on or off, mid-run (the rollback scenario). */
    setDisabled(disabled) {
      state.disabled = Boolean(disabled)
    },
    /** Change the account's `cloud` block, e.g. a plan that ended mid-show. */
    setCloud(patch) {
      Object.assign(enabledCloud, patch)
    },
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
        await closeRoom(show)
        ended.push(show.id)
      }
      return ended
    },
    // --- Plan 224: what the talk-show smoke reads -------------------------
    /** The room's settings and invite, as the web keeps them (no token). */
    roomFor(showId) {
      const room = state.rooms.get(showId)
      if (!room) throw new Error(`The fake web knows no room for ${showId}.`)
      return {
        showId,
        title: room.title,
        platforms: [...room.platforms],
        openDoor: room.openDoor,
        limits: { ...room.limits },
        invite: room.invite ? { ...room.invite } : null,
        oldSlugs: [...room.oldSlugs],
        closedAt: room.closedAt?.toISOString() ?? null
      }
    },
    /** Every guest request of a show, in order (names, states, ids; no cookie). */
    guestRequestsFor(showId) {
      return state.guestRequests
        .filter((request) => request.showId === showId)
        .map(
          ({
            id,
            name,
            device,
            state: requestState,
            guestId,
            askedAt,
            decidedAt,
            leftAt,
            muted,
            banned
          }) => ({
            id,
            name,
            device,
            state: requestState,
            guestId,
            askedAt,
            decidedAt,
            leftAt: leftAt ?? null,
            muted,
            banned
          })
        )
    },
    /** The node's finished recordings (R-G6). */
    recordingsFor(showId) {
      return state.recordings.filter((recording) => recording.showId === showId)
    },
    /** Every LiveKit token minted (host, runner, guest), for the leak scan only. */
    livekitTokens() {
      return [...state.livekitTokens]
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
