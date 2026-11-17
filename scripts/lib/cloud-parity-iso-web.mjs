/** Plan 249 S22 `iso` web side: the REAL durable web ISO runtime behind the
 * fake managed web. Heavy/live helpers; importing this module launches nothing.
 *
 * Bundled from a clean web checkout (never edited, never deployed):
 * `lib/cloud/iso/{http,runtime,state,admission,manifest,orchestrator,roles,
 * track-egress,consent,guest-route}.ts` plus the web's own in-memory media
 * store twin (`tests/fixtures/cloud-managed-kit.ts`), `recordingIdFor`,
 * `takePrefix`, `recordingBranchEndpoint`, `presignS3Url` and the guest
 * consent copy. Fixture-only pieces, each named:
 * - a qualified `IsoQualificationEvidence` injected as a dependency (never
 *   from the environment; `managedRunId` says it is a local fixture),
 * - fixture recording-space credentials (mint/revoke recorded in memory),
 * - a loopback HTTPS storage server that stands in for the show's branch
 *   endpoint and checks the real presigned GET signature,
 * - the local track-egress stand-in (a hidden `EG_` MediaRecorder page),
 *   because `livekit-server --dev` has no Egress service.
 */
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const base62 = (n) => Array.from({ length: n }, () => BASE62[randomInt(62)]).join('')
const lower = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(36)]).join('')

/** The fixture's account: the session the desktop's bearer stands for. */
export const ISO_OWNER = 'iso-fixture-owner'

async function bundle(webRoot, contents, platform = 'node') {
  const webRequire = createRequire(join(webRoot, 'package.json'))
  const { build } = createRequire(webRequire.resolve('tsx'))('esbuild')
  const out = await build({
    stdin: { contents, loader: 'ts', resolveDir: webRoot },
    absWorkingDir: webRoot,
    bundle: true,
    write: false,
    format: platform === 'node' ? 'cjs' : 'iife',
    ...(platform === 'node' ? { packages: 'external' } : { globalName: 'LivekitClient' }),
    platform,
    alias: { '@': webRoot },
    logLevel: 'silent'
  })
  const code = out.outputFiles[0].text
  if (platform !== 'node') return code
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(webRequire, module, module.exports)
  return module.exports
}

/** Loads the real web ISO modules and the desktop TS import model. Launches nothing. */
export async function loadIsoModules(webRoot, desktopRoot) {
  const web = await bundle(
    webRoot,
    `export { handleIsoHttp, handleIsoFile } from './lib/cloud/iso/http';
     export { readIsoState } from './lib/cloud/iso/state';
     export { memoryIsoReservations } from './lib/cloud/iso/reservations';
     export { parseIsoManifest } from './lib/cloud/iso/manifest';
     export { toIsoPublications } from './lib/cloud/iso/track-egress';
     export { handleGuestIsoConsent, handleGuestIsoRead } from './lib/cloud/iso/guest-route';
     export { ISO_CONSENT_COPY } from './components/guest/iso-consent-copy';
     export { newGuestRateLimiter } from './lib/cloud/talk-route';
     export { hashGuestCookie } from './lib/cloud/talk';
     export { recordingIdFor, takePrefix } from './lib/cloud/recording-keys';
     export { recordingBranchEndpoint } from './lib/cloud/recording-spaces';
     export { presignS3Url } from './lib/s3-sigv4';
     export { createMemoryCloudShowMediaStore } from './tests/fixtures/cloud-managed-kit';`
  )
  const desktop = await bundle(
    webRoot,
    `export * from ${JSON.stringify(join(desktopRoot, 'apps/desktop/src/shared/cloud-source-iso.ts'))};`
  )
  const livekitClient = await bundle(webRoot, `export * from 'livekit-client';`, 'browser')
  const { RoomServiceClient } = createRequire(join(webRoot, 'package.json'))('livekit-server-sdk')
  return { web, desktop, livekitClient, RoomServiceClient }
}

/** Runs in the hidden recorder page: the local stand-in for raw track egress. */
export function recorderScript() {
  const { Room } = window.LivekitClient
  window.__rec = {
    async connect({ url, token }) {
      this.room = new Room({ adaptiveStream: false, dynacast: false })
      await this.room.connect(url, token, { autoSubscribe: false })
      this.active = new Map()
    },
    publication(trackSid) {
      for (const p of this.room.remoteParticipants.values())
        for (const pub of p.trackPublications.values()) if (pub.trackSid === trackSid) return pub
      return null
    },
    async start(egressId, trackSid, readinessMs) {
      const until = Date.now() + readinessMs
      let pub
      while (!(pub = this.publication(trackSid))) {
        if (Date.now() > until) throw new Error('publication not visible')
        await new Promise((r) => setTimeout(r, 50))
      }
      pub.setSubscribed(true)
      while (!pub.track) {
        if (Date.now() > until) throw new Error('subscription timed out')
        await new Promise((r) => setTimeout(r, 50))
      }
      const video = pub.kind === 'video'
      const recorder = new MediaRecorder(new MediaStream([pub.track.mediaStreamTrack]), {
        mimeType: video ? 'video/webm;codecs=vp8' : 'audio/webm;codecs=opus'
      })
      let chain = Promise.resolve()
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        chain = chain.then(async () => {
          const bytes = new Uint8Array(await event.data.arrayBuffer())
          let text = ''
          for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          await window.isoChunk(egressId, btoa(text))
        })
      }
      const item = { recorder, pub, done: () => chain, stoppedAt: null }
      // A track that ends (its publication left) stops the recorder by itself:
      // that moment, not the later stop call, is the file's end.
      recorder.addEventListener('stop', () => {
        item.stoppedAt ??= Date.now()
      })
      const startedAt = await new Promise((resolve) => {
        recorder.onstart = () => resolve(Date.now())
        recorder.start(500)
      })
      this.active.set(egressId, item)
      return startedAt
    },
    async stop(egressId) {
      const item = this.active.get(egressId)
      if (!item) return null
      this.active.delete(egressId)
      if (item.recorder.state !== 'inactive') {
        await new Promise((resolve) => {
          item.recorder.addEventListener('stop', resolve, { once: true })
          item.recorder.stop()
        })
      }
      await item.done()
      try {
        item.pub.setSubscribed(false)
      } catch {
        // The publication already left the room.
      }
      return item.stoppedAt ?? Date.now()
    },
    async close() {
      for (const id of [...this.active.keys()]) await this.stop(id)
      await this.room?.disconnect()
      return true
    }
  }
}

/** A loopback page origin for the recorder: the bundled browser LiveKit client only. */
export async function startRecorderOrigin(livekitClient) {
  const server = createHttpServer((req, res) => {
    if (req.url === '/livekit-client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
      return res.end(livekitClient)
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>Videorc ISO recorder</title><script src="/livekit-client.js"></script>'
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
  }
}

/**
 * The fake web's ISO state: one in-memory media row per show (the web's own
 * twin), the show/plan/session views the real handlers read, fixture
 * credentials, the injected qualification, the loopback storage server and
 * the track-egress stand-in. `routes` answers the fake web's `iso` hook.
 */
export async function createIsoWebFixture({ modules, h, storageRoot, tls, config, evidence }) {
  const { web, RoomServiceClient } = modules
  const mediaStore = web.createMemoryCloudShowMediaStore({
    showEnded: (id) => Boolean(h.web.shows.get(id)?.show.endedAt)
  })
  const recordings = {
    projectId: 'iso-local-fixture',
    parentBranchId: 'br-iso-parent-fixture',
    accessKeyId: `isoread${base62(12)}`,
    bucket: 'iso-local-fixture',
    endpoint: 'https://br-iso-parent-fixture.storage.c-1.us-east-1.aws.neon.tech/',
    region: 'us-east-1',
    secretAccessKey: base62(40)
  }
  const qualification = {
    managedRunId: `local-fixture-not-managed-${randomUUID()}`,
    measuredAt: new Date().toISOString(),
    microsPerTrackEgressMinute: 1_000,
    concurrentExports: 100
  }
  evidence.qualification = {
    injectedBy: 'harness-dependency',
    fromEnvironment: false,
    managedRunId: qualification.managedRunId,
    note: 'Fixture evidence so the real handlers admit the run; never production qualification.'
  }
  const minted = new Map()
  const revoked = new Set()
  const secrets = [recordings.secretAccessKey]
  const takeIds = new Map()
  const consentAnswers = {}
  let egress = null

  const showRecord = (id) => {
    const s = h.web.shows.get(id)
    if (!s) return null
    return {
      id,
      userId: ISO_OWNER,
      kind: s.show.kind,
      media: 'livekit',
      endedAt: s.show.endedAt ? new Date(s.show.endedAt) : null,
      expiresAt: new Date(s.show.expiresAt)
    }
  }
  const store = { shows: { findById: async (id) => showRecord(id) } }
  const ensureRow = async (showId) => {
    if (!(await mediaStore.media.find(showId)))
      await mediaStore.media.insert({ showId, now: new Date(), h: {}, v: {}, state: {} })
  }
  /** The media row carries the program take the fake web is recording, as the web's does. */
  const syncProgramTake = async (showId) => {
    await ensureRow(showId)
    const recording = h.web.snapshot(showId).state.recording
    const since = recording?.active ? recording.since : null
    if (since && !takeIds.has(since)) takeIds.set(since, `tk_${base62(12)}`)
    const takeId = since ? takeIds.get(since) : null
    await mediaStore.media.mutate({
      showId,
      now: new Date(),
      apply: (current) =>
        current.h.recordTakeId === (takeId ?? undefined)
          ? { change: null, result: null }
          : {
              change: {
                h: takeId
                  ? { ...current.h, recordTakeId: takeId, recordSince: since }
                  : (({ recordTakeId: _t, recordSince: _s, ...rest }) => rest)(current.h)
              },
              result: null
            }
    })
    return takeId ? { takeId, since, originAtMs: Date.parse(since) } : null
  }
  const reservations = web.memoryIsoReservations()
  const runtime = () => ({
    reservations,
    api: egress,
    permit: { environment: 'managed', qualification },
    credentials: {
      config: recordings,
      mint: async ({ expiresAt }) => {
        const pair = {
          accessKeyId: `isowrite${base62(12)}`,
          secretAccessKey: base62(40),
          expiresAt,
          branchId: `br-iso-take-${lower(8)}`
        }
        minted.set(pair.accessKeyId, pair)
        secrets.push(pair.secretAccessKey)
        return pair
      }
    },
    revoke: async ({ tokenId }) => {
      revoked.add(tokenId)
    }
  })
  const httpDeps = (userId = ISO_OWNER) => ({
    session: { user: { id: userId } },
    store,
    mediaStore,
    getPlanRow: async () => ({ plan: 'max' }),
    runtime,
    recordingsConfig: () => recordings
  })
  const isoState = async (showId) => {
    const row = await mediaStore.media.find(showId)
    const read = web.readIsoState(row?.state.iso)
    return read.ok ? read.state : null
  }

  // --- Loopback storage: the branch endpoint's stand-in --------------------
  const storageFile = (branchId, key) => join(storageRoot, branchId, recordings.bucket, key)
  let currentBranch = null
  const serveStorage = (req, res) => {
    const refuse = (status) => {
      res.writeHead(status)
      res.end()
    }
    try {
      const url = new URL(req.url, 'https://localhost')
      const parts = url.pathname.split('/').slice(1)
      if (req.method !== 'GET' || parts[0] !== recordings.bucket || !currentBranch)
        return refuse(404)
      const key = parts.slice(1).map(decodeURIComponent).join('/')
      const stamp = url.searchParams.get('X-Amz-Date') ?? ''
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
      if (!m) return refuse(403)
      const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
      const expires = Number(url.searchParams.get('X-Amz-Expires'))
      if (!(expires > 0) || Date.now() > date.getTime() + expires * 1000) return refuse(403)
      // The real signer, against the real branch endpoint the web signed for.
      const expected = new URL(
        web.presignS3Url({
          config: {
            accessKeyId: recordings.accessKeyId,
            bucket: recordings.bucket,
            endpointUrl: web.recordingBranchEndpoint(recordings, currentBranch),
            forcePathStyle: true,
            region: recordings.region,
            secretAccessKey: recordings.secretAccessKey,
            sessionToken: null
          },
          date,
          expiresSeconds: expires,
          method: 'GET',
          objectKey: key
        })
      )
      if (expected.pathname !== url.pathname || expected.search !== url.search) return refuse(403)
      const file = storageFile(currentBranch, key)
      let size
      try {
        size = statSync(file).size
      } catch {
        return refuse(404)
      }
      evidence.storageReads = (evidence.storageReads ?? 0) + 1
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size })
      res.end(readFileSync(file))
    } catch {
      refuse(500)
    }
  }
  const storage = createHttpsServer(tls, serveStorage)
  let storageOrigin = null
  /** Listens on loopback; the acquisition calls it once, before any ISO file route. */
  const startStorage = async () => {
    storage.listen(0, '127.0.0.1')
    await once(storage, 'listening')
    storageOrigin = `https://localhost:${storage.address().port}`
    return storageOrigin
  }

  // --- The fake web's ISO routes -----------------------------------------------
  const routes = async ({ method, url, raw }) => {
    const showId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
    if (h.web.shows.has(showId)) await syncProgramTake(showId)
    const request = new Request(new URL(url.pathname + url.search, h.web.httpOrigin), {
      method,
      ...(method === 'POST' ? { body: raw, headers: { 'content-type': 'application/json' } } : {})
    })
    const file = url.pathname.endsWith('/iso/file')
    const response = file
      ? await web.handleIsoFile(request, showId, httpDeps())
      : await web.handleIsoHttp(request, showId, httpDeps())
    const body = await response.json()
    if (file && response.status === 200) {
      // The signed URL names the show's branch endpoint; this loopback server
      // stands in for it (no DNS for *.neon.tech here). Path and signature stay.
      const signed = new URL(body.url)
      const state = await isoState(showId)
      currentBranch = state?.storageBranchId ?? null
      assert.equal(
        signed.origin,
        web.recordingBranchEndpoint(recordings, currentBranch),
        'ISO file URL must name the branch endpoint'
      )
      assert.ok(storageOrigin, 'Start the loopback storage before serving ISO files')
      body.url = `${storageOrigin}${signed.pathname}${signed.search}`
    }
    return { status: response.status, body }
  }
  /** The same handlers, called directly for another account (no fake-web bearer). */
  const direct = async (path, userId) => {
    const url = new URL(path, h.web.httpOrigin)
    const showId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
    const request = new Request(url)
    const response = url.pathname.endsWith('/iso/file')
      ? await web.handleIsoFile(request, showId, httpDeps(userId))
      : await web.handleIsoHttp(request, showId, httpDeps(userId))
    return { status: response.status }
  }

  // --- Guest consent through the real handler (Playwright route bridge) -----
  const ipLimiter = web.newGuestRateLimiter(600)
  const slugLimiter = web.newGuestRateLimiter(600)
  const guestCookies = new Map()
  const guestDeps = (showId) => ({
    ipLimiter,
    slugLimiter,
    tablesReady: async () => null,
    mediaStore,
    store,
    talkStore: {
      invites: {
        findBySlug: async (slug) => (guestCookies.has(slug) ? { showId } : null)
      },
      requests: {
        listByShow: async (id) =>
          id !== showId
            ? []
            : [...guestCookies.values()].map((g) => ({
                showId,
                cookieHash: web.hashGuestCookie(g.cookie),
                state: 'let-in',
                banned: false,
                guestId: g.identity
              }))
      }
    }
  })
  /** A let-in guest's HttpOnly cookie, as the real join sets it. */
  const admitGuest = (slug, identity) => {
    const cookie = base62(32)
    guestCookies.set(slug, { cookie, identity })
    secrets.push(cookie)
    return cookie
  }
  const consentRoute = (showId) => async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const slug = decodeURIComponent(url.pathname.split('/')[3] ?? '')
    const headers = await request.allHeaders()
    const forwarded = {}
    for (const name of ['cookie', 'origin', 'sec-fetch-site', 'content-type'])
      if (headers[name]) forwarded[name] = headers[name]
    // An intercepted request may not expose its Cookie header: then read the
    // same browser context's jar for this URL (what the browser would send).
    let cookieFrom = forwarded.cookie ? 'request' : 'none'
    if (!forwarded.cookie) {
      const jar = await request.frame().page().context().cookies(url.href)
      if (jar.length) {
        forwarded.cookie = jar.map((c) => `${c.name}=${c.value}`).join('; ')
        cookieFrom = 'browser-context-jar'
      }
    }
    const body = request.method() === 'POST' ? (request.postData() ?? '') : undefined
    const real = new Request(url, {
      method: request.method(),
      headers: forwarded,
      ...(body === undefined ? {} : { body })
    })
    await ensureRow(showId)
    const response =
      request.method() === 'POST'
        ? await web.handleGuestIsoConsent(real, slug, guestDeps(showId))
        : await web.handleGuestIsoRead(real, slug, guestDeps(showId))
    const text = await response.text()
    if (request.method() === 'POST') {
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {}
      consentAnswers[slug] = {
        status: response.status,
        cookieFrom,
        consented: parsed?.consented ?? null,
        sentConsent: (() => {
          try {
            return JSON.parse(body).consent
          } catch {
            return null
          }
        })()
      }
    }
    await route.fulfill({
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: text
    })
  }

  // --- Track egress stand-in ----------------------------------------------------
  /** The current `IsoTrackEgressApi`, over a hidden `EG_` recorder page. */
  const attachRecorder = ({ recorder, failSource, sourceKeyOf, readinessMs }) => {
    const rooms = new RoomServiceClient(h.livekit.httpUrl, h.livekit.apiKey, h.livekit.apiSecret)
    const egresses = new Map()
    const files = new Map()
    let lastPublications = []
    const view = (item) => ({
      egressId: item.egressId,
      trackSid: item.trackSid,
      filepath: item.key.replace(/\.webm$/, ''),
      status: item.status,
      startedAtMs: item.startedAtMs,
      endedAtMs: item.endedAtMs,
      file:
        item.status === 'complete' || item.status === 'failed'
          ? {
              key: item.key,
              bytes: item.bytes,
              startedAtMs: item.startedAtMs,
              endedAtMs: item.endedAtMs
            }
          : null
    })
    const refused = () => Object.assign(new Error('fixture start refusal'), { code: 'refused' })
    egress = {
      provider: 'local-fixture',
      async listPublications(room) {
        lastPublications = (await rooms.listParticipants(room)).flatMap(web.toIsoPublications)
        return lastPublications
      },
      async startTrackEgress({ trackSid, filepath, storage: target }) {
        const publication = lastPublications.find((p) => p.trackSid === trackSid)
        if (publication && sourceKeyOf(publication) === failSource) throw refused()
        const pair = minted.get(target.accessKey)
        // Only a pair the runtime minted, unrevoked, for its own branch endpoint.
        if (
          !pair ||
          revoked.has(target.accessKey) ||
          target.secret !== pair.secretAccessKey ||
          target.bucket !== recordings.bucket ||
          target.endpoint !== web.recordingBranchEndpoint(recordings, pair.branchId)
        )
          throw refused()
        const egressId = `EG_${base62(12)}`
        const key = `${filepath}.webm`
        const file = storageFile(pair.branchId, key)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, '')
        files.set(egressId, file)
        const item = {
          egressId,
          trackSid,
          key,
          status: 'starting',
          bytes: 0,
          startedAtMs: null,
          endedAtMs: null
        }
        egresses.set(egressId, item)
        item.startedAtMs = await recorder.evaluate(
          ([id, sid, ms]) => window.__rec.start(id, sid, ms),
          [egressId, trackSid, readinessMs]
        )
        item.status = 'active'
        return view(item)
      },
      async stopEgress(egressId) {
        const item = egresses.get(egressId)
        if (!item) return null
        if (item.status === 'active') {
          item.endedAtMs = await recorder.evaluate((id) => window.__rec.stop(id), egressId)
          item.status = item.bytes > 0 ? 'complete' : 'failed'
        }
        return view(item)
      },
      async listEgress() {
        return [...egresses.values()].map(view)
      },
      async countActiveExports() {
        return [...egresses.values()].filter((e) => e.status === 'active').length
      }
    }
    const chunk = (egressId, b64) => {
      const item = egresses.get(egressId)
      if (!item || item.status !== 'active') return
      const bytes = Buffer.from(b64, 'base64')
      item.bytes += bytes.length
      if (item.bytes > config.maximumArtifactBytes) {
        item.status = 'failed'
        return
      }
      appendFileSync(files.get(egressId), bytes)
    }
    return {
      chunk,
      summary: () => ({
        started: egresses.size,
        activeAtEnd: [...egresses.values()].filter((e) => e.status === 'active').length,
        refusedStarts: 'fixture-refusal for the failSource only'
      }),
      storagePath: (objectKey) => {
        for (const pair of minted.values()) {
          const file = storageFile(pair.branchId, objectKey)
          try {
            statSync(file)
            return file
          } catch {}
        }
        return null
      }
    }
  }

  return {
    mediaStore,
    recordings,
    get storageOrigin() {
      return storageOrigin
    },
    startStorage,
    /** The storage request handler itself (signature check, then the object). */
    serveStorage,
    secrets,
    consentAnswers,
    routes,
    direct,
    isoState,
    syncProgramTake,
    admitGuest,
    consentRoute,
    attachRecorder,
    keys: () => ({ minted: minted.size, revoked: revoked.size }),
    programRecordingId: (takeId) =>
      web.recordingIdFor(
        `${web.takePrefix({ orientation: 'h', showId: h.showId, takeId, userId: ISO_OWNER })}index.m3u8`
      ),
    close: () =>
      storage.listening
        ? new Promise((resolve) => {
            storage.close(resolve)
            storage.closeAllConnections()
          })
        : Promise.resolve()
  }
}

export async function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
