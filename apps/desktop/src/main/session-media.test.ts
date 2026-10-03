import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { roleCanInvokeChannel } from '../shared/renderer-security-policy'
import {
  SESSION_MEDIA_GRANT_TTL_MS,
  SessionMediaGrantRegistry,
  decideSessionMediaResponse,
  inspectSessionMediaFile,
  mp4IsFinalized,
  mp4TopLevelBoxTypes,
  newSessionMediaGrantId,
  parseByteRange,
  parseSessionMediaGrantId,
  planSessionMediaResponse,
  serveSessionMediaRequest,
  sessionMediaGrantUrl,
  sessionMediaResponse,
  statSessionMediaFile,
  type ByteReader,
  type SessionMediaFileIdentity
} from './session-media'

// --- Synthetic MP4 boxes ------------------------------------------------------------

function box(
  type: string,
  payload: Buffer = Buffer.alloc(0),
  form: 'normal' | 'large' | 'to-eof' = 'normal'
): Buffer {
  if (form === 'large') {
    const header = Buffer.alloc(16)
    header.writeUInt32BE(1, 0)
    header.write(type, 4, 4, 'latin1')
    header.writeBigUInt64BE(BigInt(16 + payload.length), 8)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(8)
  header.writeUInt32BE(form === 'to-eof' ? 0 : 8 + payload.length, 0)
  header.write(type, 4, 4, 'latin1')
  return Buffer.concat([header, payload])
}

const FINALIZED_MP4 = Buffer.concat([
  box('ftyp', Buffer.from('isommp42')),
  box('moov', Buffer.alloc(40, 7)),
  box('mdat', Buffer.alloc(100, 9))
])
const IN_PROGRESS_MP4 = Buffer.concat([
  box('ftyp', Buffer.from('isommp42')),
  box('mdat', Buffer.alloc(300, 9), 'to-eof')
])
const TRAILING_MOOV_MP4 = Buffer.concat([
  box('ftyp', Buffer.from('isommp42')),
  box('mdat', Buffer.alloc(500, 1), 'large'),
  box('moov', Buffer.alloc(24, 3))
])

const bufferReader =
  (bytes: Buffer): ByteReader =>
  (offset, length) =>
    bytes.subarray(offset, offset + length)

describe('mp4TopLevelBoxTypes', () => {
  it('walks ordinary, 64-bit and to-end-of-file boxes', () => {
    expect(mp4TopLevelBoxTypes(bufferReader(FINALIZED_MP4), FINALIZED_MP4.length)).toEqual([
      'ftyp',
      'moov',
      'mdat'
    ])
    expect(mp4TopLevelBoxTypes(bufferReader(IN_PROGRESS_MP4), IN_PROGRESS_MP4.length)).toEqual([
      'ftyp',
      'mdat'
    ])
    expect(mp4TopLevelBoxTypes(bufferReader(TRAILING_MOOV_MP4), TRAILING_MOOV_MP4.length)).toEqual([
      'ftyp',
      'mdat',
      'moov'
    ])
  })

  it('includes a box that runs past the end of the file and stops there', () => {
    const truncated = FINALIZED_MP4.subarray(0, FINALIZED_MP4.length - 50)
    expect(mp4TopLevelBoxTypes(bufferReader(truncated), truncated.length)).toEqual([
      'ftyp',
      'moov',
      'mdat'
    ])
  })

  it('rejects what is not a box sequence', () => {
    const garbage = Buffer.from([0, 0, 0, 4, 0x01, 0x02, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(mp4TopLevelBoxTypes(bufferReader(garbage), garbage.length)).toBeNull()
    const tinyBox = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('ftyp')])
    expect(mp4TopLevelBoxTypes(bufferReader(tinyBox), tinyBox.length)).toBeNull()
    expect(mp4TopLevelBoxTypes(bufferReader(Buffer.alloc(0)), 0)).toEqual([])
  })

  it('bounds the walk', () => {
    const many = Buffer.concat(Array.from({ length: 80 }, () => box('free')))
    expect(mp4TopLevelBoxTypes(bufferReader(many), many.length, 10)).toHaveLength(10)
  })

  it('calls a file finalized only once moov exists', () => {
    expect(mp4IsFinalized(['ftyp', 'moov', 'mdat'])).toBe(true)
    expect(mp4IsFinalized(['ftyp', 'mdat', 'moov'])).toBe(true)
    expect(mp4IsFinalized(['ftyp', 'mdat'])).toBe(false)
    expect(mp4IsFinalized(null)).toBe(false)
  })
})

// --- File inspection ----------------------------------------------------------------

describe('inspectSessionMediaFile', () => {
  let root: string
  let finalized: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'videorc-session-media-'))
    finalized = join(root, 'Recording.mp4')
    writeFileSync(finalized, FINALIZED_MP4)
    writeFileSync(join(root, 'SHOUTY.MP4'), FINALIZED_MP4)
    writeFileSync(join(root, 'in-progress.mp4'), IN_PROGRESS_MP4)
    writeFileSync(join(root, 'late-index.mp4'), TRAILING_MOOV_MP4)
    writeFileSync(join(root, 'empty.mp4'), Buffer.alloc(0))
    writeFileSync(join(root, 'noise.mp4'), Buffer.from('definitely not an mp4 file at all'))
    writeFileSync(join(root, 'clip.mov'), FINALIZED_MP4)
    writeFileSync(join(root, 'raw.ts'), FINALIZED_MP4)
    mkdirSync(join(root, 'folder.mp4'))
    symlinkSync(finalized, join(root, 'link.mp4'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts a finalized regular .mp4 and reports its canonical identity', () => {
    const result = inspectSessionMediaFile(finalized)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The temp directory chain may pass through symlinks (/var on macOS); the
    // canonical path is what gets served.
    expect(result.file.path).toBe(realpathSync(finalized))
    expect(result.file.size).toBe(FINALIZED_MP4.length)
    expect(result.file.mtimeMs).toBeGreaterThan(0)
    expect(inspectSessionMediaFile(join(root, 'SHOUTY.MP4')).ok).toBe(true)
    expect(inspectSessionMediaFile(join(root, 'late-index.mp4')).ok).toBe(true)
  })

  it('refuses anything that is not an mp4 by extension', () => {
    expect(inspectSessionMediaFile(join(root, 'clip.mov'))).toEqual({
      ok: false,
      error: 'not-mp4'
    })
    expect(inspectSessionMediaFile(join(root, 'raw.ts'))).toEqual({ ok: false, error: 'not-mp4' })
  })

  it('refuses missing files, directories, symlinks, traversal and relative paths', () => {
    const notFound = { ok: false, error: 'not-found' }
    expect(inspectSessionMediaFile(join(root, 'gone.mp4'))).toEqual(notFound)
    expect(inspectSessionMediaFile(join(root, 'folder.mp4'))).toEqual(notFound)
    expect(inspectSessionMediaFile(join(root, 'link.mp4'))).toEqual(notFound)
    expect(inspectSessionMediaFile(`${root}/folder.mp4/../Recording.mp4`)).toEqual(notFound)
    expect(inspectSessionMediaFile('Recording.mp4')).toEqual(notFound)
    expect(inspectSessionMediaFile('')).toEqual(notFound)
    expect(inspectSessionMediaFile(undefined)).toEqual(notFound)
    expect(inspectSessionMediaFile(42)).toEqual(notFound)
  })

  it('calls an unindexed, empty or unreadable mp4 not ready', () => {
    const notReady = { ok: false, error: 'not-ready' }
    expect(inspectSessionMediaFile(join(root, 'in-progress.mp4'))).toEqual(notReady)
    expect(inspectSessionMediaFile(join(root, 'empty.mp4'))).toEqual(notReady)
    expect(inspectSessionMediaFile(join(root, 'noise.mp4'))).toEqual(notReady)
  })

  it('stats a granted file, or answers null once it is gone', () => {
    const identity = statSessionMediaFile(finalized)
    expect(identity).toEqual({ size: FINALIZED_MP4.length, mtimeMs: expect.any(Number) })
    expect(statSessionMediaFile(join(root, 'gone.mp4'))).toBeNull()
    expect(statSessionMediaFile(join(root, 'folder.mp4'))).toBeNull()
  })
})

// --- Grant registry -----------------------------------------------------------------

const FILE: SessionMediaFileIdentity = { path: '/recordings/a.mp4', size: 1_000, mtimeMs: 5 }

function registryWithClock(start = 1_000_000): {
  registry: SessionMediaGrantRegistry
  clock: { now: number }
} {
  const clock = { now: start }
  let counter = 0
  const registry = new SessionMediaGrantRegistry({
    now: () => clock.now,
    newGrantId: () => (++counter).toString(16).padStart(32, '0')
  })
  return { registry, clock }
}

describe('SessionMediaGrantRegistry', () => {
  it('mints 128-bit hex ids with the real generator', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionMediaGrantId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/)
    const registry = new SessionMediaGrantRegistry()
    const issued = registry.issue(1, 'session-1', FILE)
    expect(issued.url).toBe(sessionMediaGrantUrl(issued.grantId))
    expect(issued.url).toMatch(/^videorc-asset:\/\/session-media\/[0-9a-f]{32}$/)
    expect(issued.expiresAt - Date.now()).toBeGreaterThan(SESSION_MEDIA_GRANT_TTL_MS - 1_000)
  })

  it('issues a grant for ten minutes and forgets it once expired', () => {
    const { registry, clock } = registryWithClock()
    const issued = registry.issue(7, 'session-1', FILE)
    expect(issued.expiresAt).toBe(clock.now + SESSION_MEDIA_GRANT_TTL_MS)
    expect(registry.lookup(issued.grantId)).toMatchObject({
      id: issued.grantId,
      ownerId: 7,
      sessionId: 'session-1',
      path: FILE.path,
      size: FILE.size,
      mtimeMs: FILE.mtimeMs
    })
    clock.now = issued.expiresAt - 1
    expect(registry.lookup(issued.grantId)).not.toBeNull()
    clock.now = issued.expiresAt
    expect(registry.lookup(issued.grantId)).toBeNull()
    expect(registry.size).toBe(0)
  })

  it('refuses unknown and malformed ids', () => {
    const { registry } = registryWithClock()
    registry.issue(7, 'session-1', FILE)
    expect(registry.lookup('0'.repeat(32))).toBeNull()
    expect(registry.lookup(undefined)).toBeNull()
    expect(registry.lookup(12)).toBeNull()
    expect(registry.lookup({})).toBeNull()
  })

  it('renews in place while the file is unchanged, so the player keeps its URL', () => {
    const { registry, clock } = registryWithClock()
    const first = registry.issue(7, 'session-1', FILE)
    clock.now += 9 * 60_000
    const renewed = registry.issue(7, 'session-1', { ...FILE })
    expect(renewed.grantId).toBe(first.grantId)
    expect(renewed.url).toBe(first.url)
    expect(renewed.expiresAt).toBe(clock.now + SESSION_MEDIA_GRANT_TTL_MS)
    expect(registry.size).toBe(1)
    clock.now = first.expiresAt + 1
    expect(registry.lookup(first.grantId)).not.toBeNull()
  })

  it('mints a fresh id when the file behind a session was replaced', () => {
    const { registry } = registryWithClock()
    const first = registry.issue(7, 'session-1', FILE)
    const replaced = registry.issue(7, 'session-1', { ...FILE, size: 2_000, mtimeMs: 9 })
    expect(replaced.grantId).not.toBe(first.grantId)
    expect(registry.lookup(first.grantId)).toBeNull()
    expect(registry.lookup(replaced.grantId)?.size).toBe(2_000)
    expect(registry.size).toBe(1)
  })

  it('keeps grants apart by owner and by session', () => {
    const { registry } = registryWithClock()
    const main = registry.issue(7, 'session-1', FILE)
    const other = registry.issue(8, 'session-1', FILE)
    const second = registry.issue(7, 'session-2', { ...FILE, path: '/recordings/b.mp4' })
    expect(new Set([main.grantId, other.grantId, second.grantId]).size).toBe(3)
    expect(registry.size).toBe(3)
  })

  it('revokes every grant of a destroyed window and nothing else', () => {
    const { registry } = registryWithClock()
    const main = registry.issue(7, 'session-1', FILE)
    const mainToo = registry.issue(7, 'session-2', { ...FILE, path: '/recordings/b.mp4' })
    const other = registry.issue(8, 'session-1', FILE)
    expect(registry.revokeOwner(7)).toBe(2)
    expect(registry.lookup(main.grantId)).toBeNull()
    expect(registry.lookup(mainToo.grantId)).toBeNull()
    expect(registry.lookup(other.grantId)).not.toBeNull()
    expect(registry.revokeOwner(99)).toBe(0)
    registry.revoke(other.grantId)
    expect(registry.size).toBe(0)
  })

  it('prunes expired grants whenever it issues', () => {
    const { registry, clock } = registryWithClock()
    registry.issue(7, 'session-1', FILE)
    clock.now += SESSION_MEDIA_GRANT_TTL_MS + 1
    registry.issue(8, 'session-9', FILE)
    expect(registry.size).toBe(1)
  })
})

describe('parseSessionMediaGrantId', () => {
  it('accepts exactly one lowercase 32-hex path segment', () => {
    const id = 'a'.repeat(32)
    expect(parseSessionMediaGrantId(`/${id}`)).toBe(id)
    expect(parseSessionMediaGrantId(id)).toBe(id)
    expect(parseSessionMediaGrantId(`/${id.toUpperCase()}`)).toBeNull()
    expect(parseSessionMediaGrantId(`/${id}/extra`)).toBeNull()
    expect(parseSessionMediaGrantId(`/${id}.mp4`)).toBeNull()
    expect(parseSessionMediaGrantId('/')).toBeNull()
    expect(parseSessionMediaGrantId('/../etc/passwd')).toBeNull()
  })
})

// --- Range math -----------------------------------------------------------------------

describe('parseByteRange', () => {
  const SIZE = 1_000

  it('serves the whole file when there is no usable Range header', () => {
    expect(parseByteRange(null, SIZE)).toEqual({ kind: 'none' })
    expect(parseByteRange(undefined, SIZE)).toEqual({ kind: 'none' })
    expect(parseByteRange('', SIZE)).toEqual({ kind: 'none' })
    expect(parseByteRange('items=0-1', SIZE)).toEqual({ kind: 'none' })
    expect(parseByteRange('bytes=abc', SIZE)).toEqual({ kind: 'none' })
    expect(parseByteRange('bytes=-', SIZE)).toEqual({ kind: 'none' })
    expect(parseByteRange('bytes=5-2', SIZE)).toEqual({ kind: 'none' })
    expect(parseByteRange('bytes=1e3-', SIZE)).toEqual({ kind: 'none' })
    expect(parseByteRange(`bytes=${'9'.repeat(40)}-`, SIZE)).toEqual({ kind: 'none' })
  })

  it('parses open, closed and suffix ranges', () => {
    expect(parseByteRange('bytes=0-', SIZE)).toEqual({
      kind: 'range',
      range: { start: 0, end: 999 }
    })
    expect(parseByteRange('bytes=100-199', SIZE)).toEqual({
      kind: 'range',
      range: { start: 100, end: 199 }
    })
    expect(parseByteRange('bytes=950-', SIZE)).toEqual({
      kind: 'range',
      range: { start: 950, end: 999 }
    })
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({
      kind: 'range',
      range: { start: 900, end: 999 }
    })
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({
      kind: 'range',
      range: { start: 0, end: 999 }
    })
    expect(parseByteRange('Bytes = 0-0', SIZE)).toEqual({
      kind: 'range',
      range: { start: 0, end: 0 }
    })
  })

  it('clamps an end past the file and serves the first of several ranges', () => {
    expect(parseByteRange('bytes=900-5000', SIZE)).toEqual({
      kind: 'range',
      range: { start: 900, end: 999 }
    })
    expect(parseByteRange('bytes=0-1,5-9', SIZE)).toEqual({
      kind: 'range',
      range: { start: 0, end: 1 }
    })
  })

  it('is unsatisfiable past the end, for a zero suffix, and for an empty file', () => {
    expect(parseByteRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=1000-1010', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('planSessionMediaResponse', () => {
  it('answers 200 with the whole length when no Range is given', () => {
    expect(planSessionMediaResponse(null, 1_000)).toEqual({
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'Content-Length': '1000'
      },
      body: { start: 0, end: 999 }
    })
  })

  it('answers 206 with Content-Range and the window length', () => {
    expect(planSessionMediaResponse('bytes=100-199', 1_000)).toMatchObject({
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes 100-199/1000',
        'Content-Length': '100'
      },
      body: { start: 100, end: 199 }
    })
    expect(planSessionMediaResponse('bytes=-1', 1_000)).toMatchObject({
      status: 206,
      headers: { 'Content-Range': 'bytes 999-999/1000', 'Content-Length': '1' },
      body: { start: 999, end: 999 }
    })
  })

  it('answers 416 with the file length and no body', () => {
    expect(planSessionMediaResponse('bytes=5000-', 1_000)).toEqual({
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'Content-Range': 'bytes */1000',
        'Content-Length': '0'
      },
      body: null
    })
  })
})

// --- Decisions and responses --------------------------------------------------------

describe('decideSessionMediaResponse', () => {
  const unchanged = (): { size: number; mtimeMs: number } => ({
    size: FILE.size,
    mtimeMs: FILE.mtimeMs
  })

  it('rejects unknown, expired and malformed grants with 404', () => {
    const { registry, clock } = registryWithClock()
    const issued = registry.issue(7, 'session-1', FILE)
    const request = (grantId: string | null): ReturnType<typeof decideSessionMediaResponse> =>
      decideSessionMediaResponse(
        registry,
        { method: 'GET', grantId, rangeHeader: null },
        unchanged,
        clock.now
      )
    expect(request('f'.repeat(32))).toMatchObject({ kind: 'reject', status: 404 })
    expect(request(null)).toMatchObject({ kind: 'reject', status: 404 })
    expect(request(issued.grantId)).toMatchObject({ kind: 'serve' })
    clock.now = issued.expiresAt
    expect(request(issued.grantId)).toMatchObject({ kind: 'reject', status: 404 })
  })

  it('rejects anything but GET and HEAD', () => {
    const { registry, clock } = registryWithClock()
    const issued = registry.issue(7, 'session-1', FILE)
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(
        decideSessionMediaResponse(
          registry,
          { method, grantId: issued.grantId, rangeHeader: null },
          unchanged,
          clock.now
        )
      ).toMatchObject({ kind: 'reject', status: 405, headers: { Allow: 'GET, HEAD' } })
    }
  })

  it('answers 404 and drops the grant when the file is gone', () => {
    const { registry, clock } = registryWithClock()
    const issued = registry.issue(7, 'session-1', FILE)
    expect(
      decideSessionMediaResponse(
        registry,
        { method: 'GET', grantId: issued.grantId, rangeHeader: 'bytes=0-' },
        () => null,
        clock.now
      )
    ).toMatchObject({ kind: 'reject', status: 404 })
    expect(registry.lookup(issued.grantId)).toBeNull()
  })

  it('answers 409 and drops the grant when the file was replaced', () => {
    const { registry, clock } = registryWithClock()
    const issued = registry.issue(7, 'session-1', FILE)
    for (const changed of [
      { size: FILE.size + 1, mtimeMs: FILE.mtimeMs },
      { size: FILE.size, mtimeMs: FILE.mtimeMs + 0.5 }
    ]) {
      const fresh = registry.issue(7, 'session-1', FILE)
      expect(
        decideSessionMediaResponse(
          registry,
          { method: 'GET', grantId: fresh.grantId, rangeHeader: 'bytes=0-' },
          () => changed,
          clock.now
        )
      ).toMatchObject({ kind: 'reject', status: 409 })
      expect(registry.lookup(fresh.grantId)).toBeNull()
    }
    expect(registry.lookup(issued.grantId)).toBeNull()
  })

  it('serves GET with a body and HEAD without, with the same plan', () => {
    const { registry, clock } = registryWithClock()
    const issued = registry.issue(7, 'session-1', FILE)
    const get = decideSessionMediaResponse(
      registry,
      { method: 'GET', grantId: issued.grantId, rangeHeader: 'bytes=10-19' },
      unchanged,
      clock.now
    )
    const head = decideSessionMediaResponse(
      registry,
      { method: 'head', grantId: issued.grantId, rangeHeader: 'bytes=10-19' },
      unchanged,
      clock.now
    )
    expect(get).toMatchObject({
      kind: 'serve',
      withBody: true,
      plan: { status: 206, body: { start: 10, end: 19 } }
    })
    expect(head).toMatchObject({
      kind: 'serve',
      withBody: false,
      plan: { status: 206, headers: { 'Content-Range': 'bytes 10-19/1000' } }
    })
    expect(
      decideSessionMediaResponse(
        registry,
        { method: 'GET', grantId: issued.grantId, rangeHeader: 'bytes=5000-' },
        unchanged,
        clock.now
      )
    ).toMatchObject({ kind: 'serve', plan: { status: 416 } })
  })
})

describe('sessionMediaResponse', () => {
  const fakeBody = (bytes: number[]): ReadableStream =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes))
        controller.close()
      }
    })

  it('streams the requested window for GET and only headers for HEAD and 416', async () => {
    const { registry, clock } = registryWithClock()
    const issued = registry.issue(7, 'session-1', FILE)
    const grant = registry.lookup(issued.grantId)!
    const opened: Array<{ path: string; start: number; end: number }> = []
    const openBody = (path: string, range: { start: number; end: number }): ReadableStream => {
      opened.push({ path, ...range })
      return fakeBody([1, 2, 3])
    }
    const get = sessionMediaResponse(
      {
        kind: 'serve',
        grant,
        plan: planSessionMediaResponse('bytes=10-12', FILE.size),
        withBody: true
      },
      openBody
    )
    expect(get.status).toBe(206)
    expect(get.headers.get('content-range')).toBe('bytes 10-12/1000')
    expect(get.headers.get('accept-ranges')).toBe('bytes')
    expect(get.headers.get('content-type')).toBe('video/mp4')
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(opened).toEqual([{ path: FILE.path, start: 10, end: 12 }])

    const head = sessionMediaResponse(
      { kind: 'serve', grant, plan: planSessionMediaResponse(null, FILE.size), withBody: false },
      openBody
    )
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('1000')
    expect(head.body).toBeNull()

    const unsatisfiable = sessionMediaResponse(
      {
        kind: 'serve',
        grant,
        plan: planSessionMediaResponse('bytes=9999-', FILE.size),
        withBody: true
      },
      openBody
    )
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */1000')
    expect(unsatisfiable.body).toBeNull()
    expect(opened).toHaveLength(1)
    expect(clock.now).toBeGreaterThan(0)
  })

  it('turns a rejection into its status and message', async () => {
    const response = sessionMediaResponse({
      kind: 'reject',
      status: 409,
      message: 'Recording changed',
      headers: { 'Cache-Control': 'no-store' }
    })
    expect(response.status).toBe(409)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('Recording changed')
  })
})

describe('serveSessionMediaRequest', () => {
  let root: string
  let path: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'videorc-session-media-serve-'))
    path = join(root, 'served.mp4')
    writeFileSync(path, FINALIZED_MP4)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('streams exact byte windows from disk for a live grant', async () => {
    const registry = new SessionMediaGrantRegistry()
    const inspection = inspectSessionMediaFile(path)
    expect(inspection.ok).toBe(true)
    if (!inspection.ok) return
    const issued = registry.issue(1, 'session-1', inspection.file)
    const url = new URL(issued.url)

    const partial = serveSessionMediaRequest(
      registry,
      new Request('http://session-media.invalid/', { headers: { range: 'bytes=4-7' } }),
      url.pathname
    )
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe(`bytes 4-7/${FINALIZED_MP4.length}`)
    expect(partial.headers.get('content-length')).toBe('4')
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(FINALIZED_MP4.subarray(4, 8))

    const whole = serveSessionMediaRequest(
      registry,
      new Request('http://session-media.invalid/'),
      url.pathname
    )
    expect(whole.status).toBe(200)
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(readFileSync(path))

    const tail = serveSessionMediaRequest(
      registry,
      new Request('http://session-media.invalid/', { headers: { range: 'bytes=-8' } }),
      url.pathname
    )
    expect(tail.status).toBe(206)
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(FINALIZED_MP4.subarray(-8))
  })

  it('refuses the grant once the file changes underneath it', async () => {
    const registry = new SessionMediaGrantRegistry()
    const inspection = inspectSessionMediaFile(path)
    if (!inspection.ok) throw new Error('fixture must inspect')
    const issued = registry.issue(1, 'session-1', inspection.file)
    const pathname = new URL(issued.url).pathname
    const later = new Date(Date.now() + 60_000)
    utimesSync(path, later, later)
    const response = serveSessionMediaRequest(
      registry,
      new Request('http://session-media.invalid/', { headers: { range: 'bytes=0-' } }),
      pathname
    )
    expect(response.status).toBe(409)
    expect(registry.lookup(issued.grantId)).toBeNull()
    // A fresh grant for the new identity gets a new id and serves again.
    const again = inspectSessionMediaFile(path)
    if (!again.ok) throw new Error('fixture must inspect')
    const reissued = registry.issue(1, 'session-1', again.file)
    expect(reissued.grantId).not.toBe(issued.grantId)
    const served = serveSessionMediaRequest(
      registry,
      new Request('http://session-media.invalid/'),
      new URL(reissued.url).pathname
    )
    expect(served.status).toBe(200)
    await served.arrayBuffer()
  })

  it('answers 404 for an unknown id and 405 for a write', () => {
    const registry = new SessionMediaGrantRegistry()
    expect(
      serveSessionMediaRequest(
        registry,
        new Request('http://session-media.invalid/'),
        `/${'0'.repeat(32)}`
      ).status
    ).toBe(404)
    expect(
      serveSessionMediaRequest(
        registry,
        new Request('http://session-media.invalid/', { method: 'POST' }),
        `/${'0'.repeat(32)}`
      ).status
    ).toBe(405)
  })
})

describe('grant minting policy', () => {
  it('belongs to the Studio renderer alone', () => {
    expect(roleCanInvokeChannel('main', 'media:grant-session')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'media:grant-session')).toBe(false)
    expect(roleCanInvokeChannel('notes', 'media:grant-session')).toBe(false)
    expect(roleCanInvokeChannel('captions', 'media:grant-session')).toBe(false)
  })
})
