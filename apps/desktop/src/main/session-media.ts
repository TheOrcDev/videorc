import { randomBytes } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'

import type { SessionMediaGrantRefusal } from '../shared/backend'

/**
 * Session media grants (plan 119, S11, decision 13).
 *
 * The in-app player plays a finalized recording through the scoped
 * `videorc-asset://session-media/<grantId>` host. A grant is minted by the
 * main renderer alone (`media:grant-session`, MAIN_ONLY), names exactly one
 * regular `.mp4` file by its canonical path, and dies after ten minutes
 * unless the player renews it, or when its window goes away. The protocol
 * host never sees a path from the renderer: it only resolves a grant id, so
 * the Comments window (which shares the scheme in its CSP) can reach nothing
 * without a 128-bit id it was never given.
 *
 * Serving is Range-aware (206 / 416) because a 2-hour recording must seek
 * instantly, and it re-checks the file's identity (size and mtime) on every
 * request so a file replaced under a live grant answers 409 instead of
 * mixing bytes from two renders.
 *
 * Everything here is pure or thinly wraps `node:fs`, so it is unit-tested
 * without Electron. `main/index.ts` owns the registry instance, the IPC
 * handler and the one branch in the protocol handler.
 */

export const SESSION_MEDIA_SCHEME = 'videorc-asset'
export const SESSION_MEDIA_HOST = 'session-media'
export const SESSION_MEDIA_CONTENT_TYPE = 'video/mp4'
export const SESSION_MEDIA_GRANT_TTL_MS = 10 * 60_000
/** 128 bits of entropy per grant id, as 32 lowercase hex characters. */
export const SESSION_MEDIA_GRANT_ID_BYTES = 16
/** Top-level MP4 boxes read while looking for `moov`; real files have under ten. */
const MAX_TOP_LEVEL_BOXES = 64
const MP4_BOX_HEADER_BYTES = 16

const GRANT_ID_PATTERN = /^[0-9a-f]{32}$/

export type SessionMediaFileIdentity = {
  /** The canonical (realpath) file path main will stream from. */
  path: string
  size: number
  mtimeMs: number
}

export type SessionMediaGrant = SessionMediaFileIdentity & {
  id: string
  sessionId: string
  /** The webContents id that minted the grant; its destruction revokes it. */
  ownerId: number
  expiresAt: number
}

export type SessionMediaInspection =
  | { ok: true; file: SessionMediaFileIdentity }
  | { ok: false; error: SessionMediaGrantRefusal }

export type SessionMediaIssuedGrant = { grantId: string; url: string; expiresAt: number }

export function newSessionMediaGrantId(): string {
  return randomBytes(SESSION_MEDIA_GRANT_ID_BYTES).toString('hex')
}

export function sessionMediaGrantUrl(grantId: string): string {
  return `${SESSION_MEDIA_SCHEME}://${SESSION_MEDIA_HOST}/${grantId}`
}

/** The grant id named by a `session-media` request path, or null for anything else. */
export function parseSessionMediaGrantId(pathname: string): string | null {
  const candidate = pathname.replace(/^\/+/, '')
  return GRANT_ID_PATTERN.test(candidate) ? candidate : null
}

// --- File inspection -----------------------------------------------------------

/** Reads up to `length` bytes at `offset`; a short buffer means EOF. */
export type ByteReader = (offset: number, length: number) => Buffer

/**
 * Walks the top-level ISO BMFF boxes of a file and returns their types in
 * order, or null when the structure is not a box sequence at all. A declared
 * box that runs past the end of the file (an in-progress `mdat`) is included
 * and ends the walk. Only headers are read, so a multi-gigabyte `mdat` costs
 * one 16-byte read.
 */
export function mp4TopLevelBoxTypes(
  read: ByteReader,
  size: number,
  maxBoxes = MAX_TOP_LEVEL_BOXES
): string[] | null {
  const types: string[] = []
  let offset = 0
  while (offset + 8 <= size && types.length < maxBoxes) {
    const header = read(offset, MP4_BOX_HEADER_BYTES)
    if (header.length < 8) return null
    const size32 = header.readUInt32BE(0)
    const type = header.toString('latin1', 4, 8)
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null
    let boxLength: number
    if (size32 === 1) {
      if (header.length < 16) return null
      const largeSize = header.readBigUInt64BE(8)
      if (largeSize < 16n || largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null
      boxLength = Number(largeSize)
    } else if (size32 === 0) {
      // "Extends to the end of the file": how a recorder leaves its last mdat.
      boxLength = size - offset
    } else if (size32 < 8) {
      return null
    } else {
      boxLength = size32
    }
    types.push(type)
    if (offset + boxLength > size) break
    offset += boxLength
  }
  return types
}

/** A playable MP4 has its `moov` (the index) written; a recording in progress has not. */
export function mp4IsFinalized(boxTypes: readonly string[] | null): boolean {
  return boxTypes !== null && boxTypes.includes('moov')
}

function readFileBoxTypes(path: string, size: number): string[] | null {
  const fd = openSync(path, 'r')
  try {
    return mp4TopLevelBoxTypes((offset, length) => {
      const buffer = Buffer.alloc(length)
      const read = readSync(fd, buffer, 0, length, offset)
      return read === length ? buffer : buffer.subarray(0, read)
    }, size)
  } finally {
    closeSync(fd)
  }
}

/**
 * Accepts only an existing regular `.mp4` file (case-insensitive) that is
 * finalized, reached without a symlink in its final component, and returns
 * its canonical identity. Every refusal is typed for the player's copy.
 */
export function inspectSessionMediaFile(rawPath: unknown): SessionMediaInspection {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || !isAbsolute(rawPath)) {
    return { ok: false, error: 'not-found' }
  }
  if (rawPath.split(/[\\/]/).includes('..')) {
    return { ok: false, error: 'not-found' }
  }
  if (extname(rawPath).toLowerCase() !== '.mp4') {
    return { ok: false, error: 'not-mp4' }
  }
  let canonical: string
  let size: number
  let mtimeMs: number
  try {
    // The directory chain may legitimately pass through symlinks (/var on
    // macOS); the file itself may not, or a grant could be pointed elsewhere
    // after it was minted.
    if (lstatSync(rawPath).isSymbolicLink()) {
      return { ok: false, error: 'not-found' }
    }
    canonical = realpathSync(rawPath)
    const stats = statSync(canonical)
    if (!stats.isFile()) {
      return { ok: false, error: 'not-found' }
    }
    size = stats.size
    mtimeMs = stats.mtimeMs
  } catch {
    return { ok: false, error: 'not-found' }
  }
  if (extname(canonical).toLowerCase() !== '.mp4') {
    return { ok: false, error: 'not-mp4' }
  }
  if (size === 0) {
    return { ok: false, error: 'not-ready' }
  }
  try {
    if (!mp4IsFinalized(readFileBoxTypes(canonical, size))) {
      return { ok: false, error: 'not-ready' }
    }
  } catch {
    return { ok: false, error: 'not-ready' }
  }
  return { ok: true, file: { path: canonical, size, mtimeMs } }
}

/** The current identity of a granted file, or null when it is gone. */
export function statSessionMediaFile(path: string): { size: number; mtimeMs: number } | null {
  try {
    const stats = statSync(path)
    return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null
  } catch {
    return null
  }
}

// --- Grant registry ------------------------------------------------------------

export type SessionMediaGrantRegistryOptions = {
  ttlMs?: number
  now?: () => number
  newGrantId?: () => string
}

export class SessionMediaGrantRegistry {
  readonly #grants = new Map<string, SessionMediaGrant>()
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #newGrantId: () => string

  constructor(options: SessionMediaGrantRegistryOptions = {}) {
    this.#ttlMs = Math.max(1, options.ttlMs ?? SESSION_MEDIA_GRANT_TTL_MS)
    this.#now = options.now ?? Date.now
    this.#newGrantId = options.newGrantId ?? newSessionMediaGrantId
  }

  /**
   * Mints a grant, or renews the owner's existing grant for the same session
   * when the file is unchanged (the player keeps its URL, so playback is not
   * interrupted). A replaced file gets a fresh id and the old URL dies.
   */
  issue(
    ownerId: number,
    sessionId: string,
    file: SessionMediaFileIdentity
  ): SessionMediaIssuedGrant {
    const now = this.#now()
    this.prune(now)
    const expiresAt = now + this.#ttlMs
    for (const existing of this.#grants.values()) {
      if (existing.ownerId !== ownerId || existing.sessionId !== sessionId) continue
      if (
        existing.path === file.path &&
        existing.size === file.size &&
        existing.mtimeMs === file.mtimeMs
      ) {
        existing.expiresAt = expiresAt
        return { grantId: existing.id, url: sessionMediaGrantUrl(existing.id), expiresAt }
      }
      this.#grants.delete(existing.id)
      break
    }
    const id = this.#newGrantId()
    if (!GRANT_ID_PATTERN.test(id) || this.#grants.has(id)) {
      throw new Error('Session media grant id generator produced an unusable id.')
    }
    this.#grants.set(id, { id, ownerId, sessionId, ...file, expiresAt })
    return { grantId: id, url: sessionMediaGrantUrl(id), expiresAt }
  }

  lookup(grantId: unknown, nowMs = this.#now()): Readonly<SessionMediaGrant> | null {
    if (typeof grantId !== 'string') return null
    const grant = this.#grants.get(grantId)
    if (!grant) return null
    if (grant.expiresAt <= nowMs) {
      this.#grants.delete(grantId)
      return null
    }
    return grant
  }

  revoke(grantId: string): void {
    this.#grants.delete(grantId)
  }

  /** Drops every grant a window minted; returns how many. */
  revokeOwner(ownerId: number): number {
    let removed = 0
    for (const [id, grant] of this.#grants) {
      if (grant.ownerId === ownerId) {
        this.#grants.delete(id)
        removed += 1
      }
    }
    return removed
  }

  prune(nowMs = this.#now()): void {
    for (const [id, grant] of this.#grants) {
      if (grant.expiresAt <= nowMs) this.#grants.delete(id)
    }
  }

  get size(): number {
    return this.#grants.size
  }
}

// --- Range parsing and response planning ------------------------------------------

/** Inclusive byte offsets, as HTTP ranges are. */
export type ByteRange = { start: number; end: number }

export type ByteRangeParse =
  | { kind: 'none' }
  | { kind: 'range'; range: ByteRange }
  | { kind: 'unsatisfiable' }

/**
 * Parses one `Range: bytes=` header against a file of `size` bytes (RFC 7233):
 * `a-b`, `a-` and the suffix form `-n`. A multi-range request yields its first
 * range only. A malformed header or another unit is ignored (the whole file is
 * served with 200), while a range that starts past the end is unsatisfiable.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRangeParse {
  if (typeof header !== 'string') return { kind: 'none' }
  const match = /^\s*bytes\s*=\s*(.+?)\s*$/i.exec(header)
  if (!match) return { kind: 'none' }
  const first = match[1].split(',')[0].trim()
  const spec = /^(\d*)\s*-\s*(\d*)$/.exec(first)
  if (!spec) return { kind: 'none' }
  const [, startText, endText] = spec
  if (startText === '' && endText === '') return { kind: 'none' }
  if (!Number.isSafeInteger(size) || size <= 0) return { kind: 'unsatisfiable' }
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix === 0) return { kind: 'unsatisfiable' }
    return { kind: 'range', range: { start: Math.max(0, size - suffix), end: size - 1 } }
  }
  const start = Number(startText)
  if (!Number.isSafeInteger(start)) return { kind: 'none' }
  if (start >= size) return { kind: 'unsatisfiable' }
  if (endText === '') return { kind: 'range', range: { start, end: size - 1 } }
  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'none' }
  return { kind: 'range', range: { start, end: Math.min(end, size - 1) } }
}

export type SessionMediaResponsePlan =
  | { status: 200 | 206; headers: Record<string, string>; body: ByteRange | null }
  | { status: 416; headers: Record<string, string>; body: null }

/** Status, headers and the byte window to stream for a request against `size` bytes. */
export function planSessionMediaResponse(
  rangeHeader: string | null | undefined,
  size: number
): SessionMediaResponsePlan {
  const base: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': SESSION_MEDIA_CONTENT_TYPE,
    // Grants are private and short-lived; nothing about them belongs in a disk cache.
    'Cache-Control': 'no-store'
  }
  const parsed = parseByteRange(rangeHeader, size)
  if (parsed.kind === 'unsatisfiable') {
    return {
      status: 416,
      headers: { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
      body: null
    }
  }
  if (parsed.kind === 'none') {
    return {
      status: 200,
      headers: { ...base, 'Content-Length': String(size) },
      body: size > 0 ? { start: 0, end: size - 1 } : null
    }
  }
  const { start, end } = parsed.range
  return {
    status: 206,
    headers: {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1)
    },
    body: parsed.range
  }
}

// --- Request decision and response ------------------------------------------------

export type SessionMediaRequest = {
  method: string
  grantId: string | null
  rangeHeader: string | null
}

export type SessionMediaFileStat = (path: string) => { size: number; mtimeMs: number } | null

export type SessionMediaDecision =
  | { kind: 'reject'; status: 404 | 405 | 409; message: string; headers: Record<string, string> }
  | {
      kind: 'serve'
      grant: Readonly<SessionMediaGrant>
      plan: SessionMediaResponsePlan
      /** False for HEAD: the same headers, no bytes. */
      withBody: boolean
    }

/**
 * Decides one request against the registry: 405 for anything but GET/HEAD,
 * 404 for an unknown, expired or vanished grant, 409 when the file behind a
 * grant was replaced (the grant is revoked so the player re-grants), and
 * otherwise the Range plan for the current size.
 */
export function decideSessionMediaResponse(
  registry: SessionMediaGrantRegistry,
  request: SessionMediaRequest,
  statFile: SessionMediaFileStat,
  nowMs: number
): SessionMediaDecision {
  const method = request.method.toUpperCase()
  const rejection = (
    status: 404 | 405 | 409,
    message: string,
    headers: Record<string, string> = {}
  ): SessionMediaDecision => ({
    kind: 'reject',
    status,
    message,
    headers: { 'Cache-Control': 'no-store', ...headers }
  })
  if (method !== 'GET' && method !== 'HEAD') {
    return rejection(405, 'Method not allowed', { Allow: 'GET, HEAD' })
  }
  const grant = registry.lookup(request.grantId, nowMs)
  if (!grant) {
    return rejection(404, 'Not found')
  }
  const current = statFile(grant.path)
  if (!current) {
    registry.revoke(grant.id)
    return rejection(404, 'Not found')
  }
  if (current.size !== grant.size || current.mtimeMs !== grant.mtimeMs) {
    registry.revoke(grant.id)
    return rejection(409, 'Recording changed')
  }
  return {
    kind: 'serve',
    grant,
    plan: planSessionMediaResponse(request.rangeHeader, grant.size),
    withBody: method === 'GET'
  }
}

export type SessionMediaBodyOpener = (path: string, range: ByteRange) => ReadableStream

/** Streams exactly the inclusive byte window from disk as a web stream. */
export function openSessionMediaBody(path: string, range: ByteRange): ReadableStream {
  return Readable.toWeb(
    createReadStream(path, { start: range.start, end: range.end })
  ) as ReadableStream
}

/** Builds the protocol `Response` for a decision; `openBody` is injectable for tests. */
export function sessionMediaResponse(
  decision: SessionMediaDecision,
  openBody: SessionMediaBodyOpener = openSessionMediaBody
): Response {
  if (decision.kind === 'reject') {
    return new Response(decision.message, { status: decision.status, headers: decision.headers })
  }
  const { plan, withBody, grant } = decision
  const body = withBody && plan.body ? openBody(grant.path, plan.body) : null
  return new Response(body, { status: plan.status, headers: plan.headers })
}

/** The one call `main/index.ts` makes from the `videorc-asset` handler. */
export function serveSessionMediaRequest(
  registry: SessionMediaGrantRegistry,
  request: Request,
  pathname: string,
  nowMs = Date.now()
): Response {
  const decision = decideSessionMediaResponse(
    registry,
    {
      method: request.method,
      grantId: parseSessionMediaGrantId(pathname),
      rangeHeader: request.headers.get('range')
    },
    statSessionMediaFile,
    nowMs
  )
  return sessionMediaResponse(decision)
}
