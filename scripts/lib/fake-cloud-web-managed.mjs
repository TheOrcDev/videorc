import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  capabilitiesWithCloud,
  cloudAllowanceBlock,
  mintLiveKitToken,
  newShowId,
  newInviteSlug,
  roomGrantFor,
  TALK_LIMITS_MAX,
  parseLostShowReport,
  startFakeCloudWeb
} from './fake-cloud-web.mjs'

// All shared paths, statuses, codes and timers come from the pinned wire.
export const managedWire = JSON.parse(
  readFileSync(new URL('../../protocol-fixtures/cloud-managed-wire.json', import.meta.url))
)
export const managedPath = (name, id) =>
  managedWire.routes[name].path.replace(':id', encodeURIComponent(id ?? ''))
export const managedError = (code) =>
  Object.values(managedWire.errors)
    .flat()
    .find((e) => e.code === code)
const wire = managedWire
const copy = (v) => structuredClone(v)
const instant = () => new Date().toISOString()
const validText = (v, max) =>
  typeof v === 'string' &&
  Buffer.byteLength(v) <= max &&
  !/[\u0000-\u001f\u007f]|:\/\/|[\ud800-\udfff]/u.test(v)
export function managedVersionAllowed(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  return Boolean(m && (Number(m[1]) > 0 || Number(m[2]) >= 26))
}
export function maskManagedUrls(value) {
  if (typeof value === 'string')
    return value.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, '(address withheld)')
  if (Array.isArray(value)) return value.map(maskManagedUrls)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [maskManagedUrls(k), maskManagedUrls(v)])
    )
  return value
}

/** Local managed control plane. No node, account, storage or LiveKit Cloud credentials.
 * Reuses the node fake's allowance, capabilities, ids and LiveKit grants unchanged.
 * TLS is optional for unit tests; app smokes MUST supply it for playlists/segments.
 * Hook state never stores destination URLs: even the request journal is masked.
 */
export async function startFakeCloudWebManaged({
  sessionToken = randomBytes(32).toString('base64url'),
  ingest = [],
  tls,
  livekit,
  waitScale = 1,
  segmentBytes = Buffer.alloc(0),
  refreshRoom,
  probeMedia,
  maxShows = 1,
  managed = true,
  ...nodeOptions
} = {}) {
  // Option wrapper: legacy callers keep the original node fake verbatim.
  if (!managed) return startFakeCloudWeb({ sessionToken, ...nodeOptions })
  const upgrades = []
  const shows = new Map(),
    calls = [],
    recordings = [],
    tokens = []
  const refusals = new Map()
  const failures = new Map(),
    delays = new Map(),
    barriers = new Map(),
    answers = new Map()
  let controlKind = wire.control.kinds[0],
    closed = false,
    httpsOrigin
  const controllers = new Set()
  const allowance = cloudAllowanceBlock({ nowMs: Date.now() })
  const changed = (s) => {
    s.rev += 1
  }
  const endShow = (s, reason = wire.endReasons[0]) => {
    if (s.show.endedAt) return
    if (!wire.endReasons.includes(reason)) throw new Error('Unknown managed end reason')
    s.show.status = 'ended'
    s.show.endedAt = instant()
    s.show.endReason = reason
    s.state = {
      phase: wire.phases.at(-1),
      endReason: reason,
      liveSeconds: s.state.liveSeconds,
      feeds: [],
      legs: []
    }
    s.refs.clear()
    delete s.holdImage
    changed(s)
  }
  const settleTimers = (s) => {
    if (s.show.endedAt) return
    const now = Date.now()
    if (
      s.show.kind === 'test' &&
      s.firstFrameAt &&
      now - s.firstFrameAt >= wire.timers.testShowAfterFirstFrameSeconds * 1000
    )
      endShow(s, wire.endReasons[3])
    else if (now >= Date.parse(s.show.expiresAt))
      endShow(s, s.show.kind === 'test' ? wire.endReasons.at(-1) : wire.endReasons[3])
    else if (
      s.show.kind === 'solo' &&
      !s.firstFrameAt &&
      now - Date.parse(s.show.createdAt) >= wire.timers.noFeedSeconds * 1000
    )
      endShow(s, wire.endReasons[1])
    else if (
      s.state.hold?.active &&
      now - Date.parse(s.state.hold.since) >= s.show.holdMaxSeconds * 1000
    )
      endShow(s, wire.endReasons[2])
    else if (
      s.egressLostAt &&
      now - s.egressLostAt >= wire.timers.egressLostSeconds * 1000 &&
      (!s.lastDesktopSeen || now - s.lastDesktopSeen > wire.state.desktopConnectedSeconds * 1000)
    )
      endShow(s, wire.endReasons[4])
    if (s.show.endedAt) return
    s.state.liveSeconds = s.firstFrameAt ? Math.floor((now - s.firstFrameAt) / 1000) : 0
    if (s.state.hold)
      s.state.hold.remainingSeconds = Math.max(
        0,
        s.show.holdMaxSeconds - Math.floor((now - Date.parse(s.state.hold.since)) / 1000)
      )
    if (s.state.recording?.active)
      s.state.recording.seconds = Math.max(
        0,
        Math.floor((now - Date.parse(s.state.recording.since)) / 1000)
      )
  }
  const tokenFor = (s, identity = `host:${s.show.id}`) => {
    if (!livekit) throw new Error('A local LiveKit room is required')
    const token = mintLiveKitToken({
      apiKey: livekit.apiKey,
      apiSecret: livekit.apiSecret,
      identity,
      name: identity.startsWith('host:') ? 'Host' : 'Listener',
      grant: roomGrantFor({ role: 'host', room: s.show.id }),
      ttlSeconds: 600
    })
    tokens.push(token)
    return token
  }
  const view = (s) => ({
    show: copy(s.show),
    control: copy(
      s.controlOverride ?? {
        kind: s.controlKind,
        url: wire.control.webUrl,
        token: wire.control.webToken
      }
    ),
    ingest: copy(s.ingest)
  })
  async function roomRpc(method, body, deadlineMs = wire.timers.liveKitCallSeconds * 1000) {
    if (!livekit?.httpUrl) return {}
    const token = mintLiveKitToken({
      apiKey: livekit.apiKey,
      apiSecret: livekit.apiSecret,
      identity: 'smoke-web',
      grant: { roomCreate: true, roomList: true, roomAdmin: true, room: body.room ?? body.name },
      ttlSeconds: 60
    })
    tokens.push(token)
    const response = await fetch(`${livekit.httpUrl}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deadlineMs)
    })
    if (!response.ok)
      throw Object.assign(new Error(`Local LiveKit ${method}: ${response.status}`), {
        status: response.status
      })
    return response.json()
  }
  async function refresh(s) {
    if (s.show.kind !== 'talk' || s.show.endedAt) return
    const people = refreshRoom
      ? await refreshRoom(s.show.id)
      : livekit?.httpUrl
        ? ((await roomRpc('ListParticipants', { room: s.show.id })).participants ?? [])
        : null
    if (!people) return
    const participants = people
      .filter((p) => p.identity === `host:${s.show.id}` || /^g_[a-z\d]{22}$/i.test(p.identity))
      .map((p) => ({
        identity: p.identity,
        name: p.name ?? 'Guest',
        role: p.identity.startsWith('host:') ? 'host' : 'guest',
        onStage: s.state.room.stage.onStage.includes(p.identity),
        video: (p.tracks ?? []).some((t) => t.type === 'VIDEO' || t.type === 1),
        audio: (p.tracks ?? []).some((t) => t.type === 'AUDIO' || t.type === 0),
        screen: (p.tracks ?? []).some((t) => t.source === 'SCREEN_SHARE' || t.source === 3),
        muted: false,
        quality: 'good',
        away: false,
        sinceMs: 0
      }))
    participants.sort((a, b) => Number(b.role === 'host') - Number(a.role === 'host'))
    const hostAway = !participants.some((p) => p.role === 'host')
    if (hostAway !== s.state.room.hostAway) {
      s.state.room.hostAway = hostAway
      changed(s)
    }
    if (JSON.stringify(participants) !== JSON.stringify(s.state.room.participants)) {
      s.state.room.participants = participants
      changed(s)
    }
    if (participants.some((p) => p.role === 'host') && s.state.phase === wire.phases[0]) {
      s.state.phase = wire.phases[1]
      s.show.status = s.state.phase
      s.show.startedAt ??= instant()
      changed(s)
    }
  }
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost'),
      path = url.pathname
    const controller = new AbortController()
    controllers.add(controller)
    res.once('close', () => {
      controller.abort()
      controllers.delete(controller)
    })
    let body = {},
      raw = Buffer.alloc(0)
    for await (const chunk of req) {
      raw = Buffer.concat([raw, chunk])
      if (raw.length > 4 * 1024 * 1024) break
    }
    let invalidJson = false
    try {
      if (raw.length) body = JSON.parse(raw)
    } catch {
      invalidJson = true
    }
    const entry = {
      atMs: Date.now(),
      method: req.method,
      path: maskManagedUrls(path),
      query: Object.fromEntries(
        [...url.searchParams].map(([key, value]) => [
          key,
          key === wire.routes.state.query ? value : '(address withheld)'
        ])
      ),
      body: maskManagedUrls(body),
      status: null
    }
    calls.push(entry)
    const send = (status, value, contentType = 'application/json') => {
      entry.status = status
      if (value?.rev !== undefined) entry.rev = value.rev
      entry.answeredAtMs = Date.now()
      if (res.destroyed) return
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'private, no-store' })
      res.end(contentType === 'application/json' ? JSON.stringify(value) : value)
    }
    const fail = (code, extra = {}) => {
      const error = managedError(code)
      if (!error) throw new Error(`Code missing from managed fixture: ${code}`)
      send(error.status, { error: { code: error.code, message: error.code }, ...extra })
    }
    const route =
      Object.entries(wire.routes).find(
        ([, r]) =>
          r.method === req.method && new RegExp(`^${r.path.replace(':id', '[^/]+')}$`).test(path)
      )?.[0] ??
      (path.startsWith('/segments/')
        ? 'segment'
        : path.endsWith('/room/token')
          ? 'roomToken'
          : path.endsWith('/guests')
            ? 'guests'
            : path.endsWith('/room')
              ? 'room'
              : path)
    entry.route = route
    try {
      const delay = delays.get(route)
      if (delay) await sleep(delay, null, { signal: controller.signal })
      const barrier = barriers.get(route)
      if (barrier) {
        barrier.hits++
        await Promise.race([
          barrier.promise,
          new Promise((resolve) =>
            controller.signal.addEventListener('abort', resolve, { once: true })
          )
        ])
      }
      if (closed || controller.signal.aborted) return
      const failure = failures.get(route)
      if (failure?.remaining > 0) {
        failure.remaining--
        return send(failure.status, { error: { code: failure.code, message: failure.code } })
      }
      const queue = answers.get(route)
      if (queue?.length) {
        const next = queue.shift()
        return send(next.status ?? 200, next.body, next.contentType)
      }
      if (route === 'segment') return send(200, segmentBytes, 'video/mp2t')
      if (req.headers.authorization !== `Bearer ${sessionToken}`)
        return fail(wire.errors.common.find((e) => e.status === 401).code)
      if (invalidJson || !body || Array.isArray(body) || typeof body !== 'object')
        return fail(wire.errors.common.find((e) => e.status === 400).code)
      if (path === '/api/auth/get-session')
        return send(200, { user: { name: 'Smoke', email: 'smoke@example.invalid', image: null } })
      if (path === '/api/ai/capabilities' || path === '/api/cloud/allowance') {
        const version = /^Videorc-Desktop\/(.+)$/.exec(req.headers['user-agent'] ?? '')?.[1]
        const cloud = { ...allowance, enabled: managedVersionAllowed(version) }
        return send(200, path.endsWith('capabilities') ? capabilitiesWithCloud({ cloud }) : cloud)
      }
      if (route === 'current') {
        for (const s of shows.values()) settleTimers(s)
        const s = [...shows.values()].find((s) => !s.show.endedAt && s.show.kind !== 'test')
        return send(200, s ? view(s) : { show: null })
      }
      if (route === 'create') {
        if ([...shows.values()].filter((s) => !s.show.endedAt).length >= maxShows)
          return fail(wire.errors.create.find((e) => e.code.endsWith('full')).code)
        if (!managedVersionAllowed(body.client?.version))
          return fail(wire.errors.create.find((e) => e.status === 403).code)
        if (
          !['solo', 'talk', 'test'].includes(body.kind) ||
          !Array.isArray(body.outputs) ||
          !body.outputs.length ||
          body.outputs.length > 2 ||
          body.outputs.some(
            (o) =>
              !['horizontal', 'vertical'].includes(o.orientation) ||
              !Number.isFinite(o.width * o.height) ||
              !(o.fps > 0)
          )
        )
          return fail(wire.errors.common.find((e) => e.status === 400).code)
        if (
          body.kind !== 'talk' &&
          body.outputs.some(
            (o) => o.width * o.height > wire.limits.outputPixels || o.fps > wire.limits.outputFps
          )
        )
          return fail(wire.errors.create.find((e) => e.status === 422).code)
        const id = newShowId(),
          now = instant()
        const s = {
          rev: wire.rev.start,
          controlKind,
          outputs: body.outputs,
          refs: new Map(),
          show: {
            id,
            kind: body.kind,
            status: 'ready',
            nodeId: wire.control.managedNodeId,
            createdAt: now,
            startedAt: null,
            phaseSinceAt: null,
            lastSeenAt: null,
            endedAt: null,
            endReason: null,
            expiresAt: new Date(
              Date.now() +
                (body.kind === 'test'
                  ? wire.timers.testShowExpiresSeconds
                  : wire.limits.showSeconds) *
                  1000
            ).toISOString(),
            holdMaxSeconds: body.holdMaxSeconds ?? 1800
          },
          ingest:
            body.kind === 'talk'
              ? []
              : body.outputs.map((o) => ({
                  ...copy(ingest.find((i) => i.orientation === o.orientation) ?? ingest[0]),
                  orientation: o.orientation
                })),
          state: {
            phase: wire.phases[0],
            liveSeconds: 0,
            feeds:
              body.kind === 'talk'
                ? []
                : body.outputs.map((o) => ({ orientation: o.orientation, connected: false })),
            legs: [],
            destinationsSet: false,
            restarts: 0,
            holdImageSet: false,
            desktopConnected: true
          }
        }
        shows.set(id, s)
        if (body.kind === 'talk') {
          s.state.room = {
            connected: true,
            participants: [],
            layout: 'solo',
            stage: { layout: 'solo', onStage: [`host:${id}`] },
            stageSet: false,
            returnEnabled: false,
            hostAway: true,
            pageJoins: 0
          }
          s.state.recording = { active: false, seconds: 0, bytes: 0, orientations: [] }
          s.invite = {
            slug: newInviteSlug(),
            url: `${httpOrigin}/guest/${newInviteSlug()}`,
            expiresAt: new Date(Date.now() + 86400000).toISOString()
          }
          await roomRpc('CreateRoom', {
            name: id,
            empty_timeout: 600,
            metadata: JSON.stringify({ v: 1, stage: s.state.room.stage })
          })
        }
        return send(201, {
          ...view(s),
          allowance,
          ...(body.kind === 'talk'
            ? {
                room: { url: livekit?.url ?? '', hostToken: livekit ? tokenFor(s) : '', name: id },
                invite: s.invite,
                limits: TALK_LIMITS_MAX
              }
            : {})
        })
      }
      if (route === 'recordings') return send(200, { recordings: copy(recordings) })
      if (route === 'recordingPlaylist') {
        const row = recordings.find((r) => managedPath('recordingPlaylist', r.id) === path)
        if (!row) return fail(wire.errors.recordings.find((e) => e.status === 404).code)
        if (row.format !== wire.recordings.formats.managed)
          return fail(wire.errors.recordings.find((e) => e.status === 409).code)
        if (!httpsOrigin) throw new Error('Managed HLS requires local HTTPS')
        return send(
          200,
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\n${httpsOrigin}/segments/${row.id}.ts?signature=${randomBytes(16).toString('hex')}\n#EXT-X-ENDLIST\n`,
          wire.recordings.playlistContentType
        )
      }
      const s = [...shows.values()].find((s) =>
        path.startsWith(`${managedPath('create')}/${s.show.id}/`)
      )
      if (!s) return fail(wire.errors.common.find((e) => e.status === 404).code)
      if (route === 'end') {
        endShow(s)
        if (s.show.kind === 'talk') await roomRpc('DeleteRoom', { room: s.show.id }).catch(() => {})
        return send(200, { ok: true })
      }
      if (route === 'lost') {
        if (!parseLostShowReport(body).ok) return fail(wire.errors.common[0].code)
        if (!s.show.endedAt) {
          const probe =
            probeMedia ??
            (async () =>
              livekit?.httpUrl
                ? {
                    roomExists:
                      ((await roomRpc('ListRooms', { names: [s.show.id] })).rooms ?? []).length > 0,
                    activeEgress: s.state.legs.length > 0
                  }
                : { roomExists: true })
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const media = await probe(s.show.id)
              if (!media.roomExists && !media.activeEgress) endShow(s, wire.endReasons[5])
              break
            } catch (error) {
              if (error.status) break
              if (attempt === 1) endShow(s, wire.endReasons[5])
            }
          }
        }
        return send(200, { show: copy(s.show) })
      }
      if (route === 'state') {
        settleTimers(s)
        s.lastDesktopSeen = Date.now()
        if (url.searchParams.has('since') && !/^\d+$/.test(url.searchParams.get('since')))
          return fail(wire.errors.common.find((e) => e.status === 400).code)
        await refresh(s)
        const trouble =
          s.state.phase === wire.phases[0] ||
          s.state.hold?.active ||
          s.show.kind === 'test' ||
          Object.values(s.state.program ?? {}).some((v) => v > 0)
        const seconds = trouble
          ? wire.state.waitSeconds.trouble
          : s.state.room?.participants.length > 1
            ? wire.state.waitSeconds.talkWithGuests
            : wire.state.waitSeconds.calm
        const deadline = Date.now() + seconds * 1000 * waitScale
        while (
          !s.show.endedAt &&
          url.searchParams.has('since') &&
          Number(url.searchParams.get('since')) === s.rev &&
          Date.now() < deadline &&
          !closed &&
          !res.destroyed
        ) {
          await sleep(
            Math.max(1, Math.min(wire.state.revCheckIntervalMs * waitScale, deadline - Date.now())),
            null,
            { signal: controller.signal }
          )
        }
        await refresh(s)
        return send(200, { rev: s.rev, state: copy(s.state) })
      }
      if (s.show.endedAt) return fail(wire.errors.common[3].code)
      if (route === 'roomToken') return send(200, { url: livekit?.url, hostToken: tokenFor(s) })
      if (route === 'room')
        return send(200, {
          room: { title: 'Managed smoke', platforms: [], openDoor: false, limits: TALK_LIMITS_MAX },
          invite: s.invite
        })
      if (route === 'guests') return send(200, { guests: [], requests: [] })
      if (route === 'destinations') {
        const ds = body.destinations
        if (
          !Array.isArray(ds) ||
          !ds.length ||
          ds.length > wire.limits.destinationsPerRequest ||
          new Set(ds.map((d) => d.id)).size !== ds.length ||
          (body.replace !== undefined && typeof body.replace !== 'boolean') ||
          ds.some(
            (d) =>
              !d.id ||
              !validText(d.id, wire.limits.destinationIdBytes) ||
              !validText(d.platform, wire.limits.destinationPlatformBytes) ||
              !validText(d.label, wire.limits.destinationLabelBytes) ||
              !s.outputs.some((o) => o.orientation === d.orientation) ||
              typeof d.url !== 'string' ||
              Buffer.byteLength(d.url) > wire.limits.destinationUrlBytes
          )
        )
          return fail(wire.errors.common.find((e) => e.status === 400).code)
        const refused = []
        if (body.replace) s.state.legs = []
        for (const d of ds) {
          const code =
            refusals.get(d.id) ?? destinationProblem(d.url, s.refs.get(d.id), body.replace)
          const leg = {
            id: d.id,
            platform: d.platform,
            label: d.label,
            orientation: d.orientation,
            state: wire.legs.states[1],
            since: instant()
          }
          if (code) {
            refused.push({ id: d.id, code })
            leg.state = wire.legs.states[3]
            leg.error = wire.legs.messages.guard
          } else s.refs.set(d.id, legRef(d.url))
          s.state.legs = s.state.legs.filter((l) => l.id !== d.id).concat(leg)
        }
        if (refused.length !== ds.length) {
          s.state.destinationsSet = true
          delete s.egressLostAt
        }
        changed(s)
        if (refused.length === ds.length)
          return fail(wire.errors.destinations.find((e) => e.status === 422).code, { refused })
        return send(200, { ok: true, rev: s.rev, ...(refused.length ? { refused } : {}) })
      }
      if (route === 'legsEnd') {
        if (s.show.kind !== 'talk') return fail(wire.errors.legsEnd[0].code)
        if (
          !body ||
          Array.isArray(body) ||
          (body.destinations !== undefined &&
            (!Array.isArray(body.destinations) ||
              body.destinations.some((d) => typeof d.id !== 'string' || typeof d.url !== 'string')))
        )
          return fail(wire.errors.common.find((e) => e.status === 400).code)
        s.state.legs = []
        s.state.destinationsSet = true
        changed(s)
        return send(200, { ok: true, rev: s.rev })
      }
      if (route === 'holdImage') {
        if (s.show.kind === 'talk')
          return fail(wire.errors.holdImage.find((e) => e.status === 409).code)
        const png = Buffer.from(typeof body.pngBase64 === 'string' ? body.pngBase64 : '', 'base64')
        if (png.length > wire.limits.holdImageBytes)
          return fail(wire.errors.holdImage.find((e) => e.status === 413).code)
        if (
          png.length < 24 ||
          png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          png.readUInt32BE(16) > wire.limits.holdImageSidePixels ||
          png.readUInt32BE(20) > wire.limits.holdImageSidePixels
        )
          return fail(wire.errors.holdImage.find((e) => e.status === 400).code)
        s.holdImage = png
        s.state.holdImageSet = true
        changed(s)
        return send(200, {
          ok: true,
          version: createHash('sha256').update(png).digest('hex').slice(0, 12)
        })
      }
      if (route === 'stage') {
        if (s.show.kind !== 'talk')
          return fail(wire.errors.stage.find((e) => e.status === 409).code)
        if (
          !['solo', 'side-by-side', 'screen-people', 'spotlight'].includes(body.layout) ||
          !Array.isArray(body.onStage) ||
          body.onStage.length > wire.limits.stageIdentities ||
          body.onStage.some((i) => !i || !validText(i, wire.limits.stageIdentityChars)) ||
          (body.hostShape && !['rounded', 'circle'].includes(body.hostShape))
        )
          return fail(wire.errors.common.find((e) => e.status === 400).code)
        await refresh(s)
        const known = new Set([
          `host:${s.show.id}`,
          ...s.state.room.participants.map((p) => p.identity)
        ])
        if (
          [...body.onStage, body.spotlight, body.screen].filter(Boolean).some((i) => !known.has(i))
        )
          return fail(wire.errors.stage.find((e) => e.status === 422).code)
        await roomRpc('UpdateRoomMetadata', {
          room: s.show.id,
          metadata: JSON.stringify({ v: 1, stage: body })
        })
        Object.assign(s.state.room, { stage: copy(body), layout: body.layout, stageSet: true })
        changed(s)
        return send(200, { ok: true, rev: s.rev })
      }
      if (route === 'recording') {
        if (s.show.kind !== 'talk')
          return fail(wire.errors.recording.find((e) => e.code.endsWith('-solo')).code)
        if (typeof body.on !== 'boolean')
          return fail(wire.errors.common.find((e) => e.status === 400).code)
        const was = s.state.recording.active
        s.state.recording = {
          active: body.on,
          since: instant(),
          seconds: body.on ? 0 : 2,
          bytes: body.on ? 0 : segmentBytes.length,
          orientations: ['horizontal']
        }
        changed(s)
        if (was && !body.on) hooks.addRecording({ showId: s.show.id })
        return send(200, { ok: true, rev: s.rev })
      }
      fail(wire.errors.common.find((e) => e.status === 404).code)
    } catch (error) {
      if (!controller.signal.aborted) {
        entry.problem = maskManagedUrls(String(error.message))
        if (!res.headersSent) fail(wire.errors.common[5].code)
        else res.destroy()
      }
    }
  }
  const rejectUpgrade = (req, socket) => {
    upgrades.push({ method: req.method, path: maskManagedUrls(req.url) })
    socket.destroy()
  }
  const http = createServer(handler)
  http.on('upgrade', rejectUpgrade)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const httpOrigin = `http://127.0.0.1:${http.address().port}`
  let https
  if (tls) {
    https = createHttpsServer(tls, handler)
    https.on('upgrade', rejectUpgrade)
    await new Promise((resolve) => https.listen(0, '127.0.0.1', resolve))
    httpsOrigin = `https://localhost:${https.address().port}`
  }
  const hooks = {
    refuseDestination(id, code) {
      if (code !== null && !wire.destinationRefusals.codes.includes(code))
        throw new Error('Unknown refusal')
      if (code) refusals.set(id, code)
      else refusals.delete(id)
    },
    failNext(
      route,
      n,
      status,
      code = wire.errors.common.find((e) => e.status === status)?.code ?? wire.errors.common[5].code
    ) {
      if (
        !Number.isInteger(n) ||
        n < 1 ||
        !managedError(code) ||
        !Number.isInteger(status) ||
        status < 400 ||
        status > 599
      )
        throw new Error('Failure hook needs a fixture code, HTTP error status and positive count')
      failures.set(route, { remaining: n, status, code })
    },
    delay(route, ms) {
      delays.set(route, ms)
    },
    pause(route) {
      let release
      const promise = new Promise((r) => {
        release = r
      })
      const barrier = {
        promise,
        hits: 0,
        release() {
          barriers.delete(route)
          release()
        }
      }
      barriers.set(route, barrier)
      return barrier
    },
    answerNext(route, body, status = 200, contentType = 'application/json') {
      const q = answers.get(route) ?? []
      q.push({ body: copy(body), status, contentType })
      answers.set(route, q)
    },
    controlKind(kind) {
      controlKind = kind
    },
    legacyControl(id, control) {
      const s = shows.get(id)
      s.controlOverride = copy(control)
      s.show.nodeId = 'local-smoke'
    },
    patch(id, patch) {
      const s = shows.get(id)
      if (!s) throw new Error('Unknown show')
      patch(s.state)
      changed(s)
    },
    end(id, reason) {
      endShow(shows.get(id), reason)
    },
    egressDied(id) {
      shows.get(id).egressLostAt = Date.now()
      hooks.patch(id, (s) => {
        s.destinationsSet = false
        s.restarts++
      })
    },
    resend(id, legId) {
      hooks.patch(id, (s) => {
        s.legs.find((l) => l.id === legId).resend = true
      })
    },
    failLeg(id, legId) {
      hooks.patch(id, (s) => {
        Object.assign(
          s.legs.find((l) => l.id === legId),
          { state: wire.legs.states[3], error: wire.legs.messages.failed }
        )
      })
    },
    pageJoin(id) {
      hooks.patch(id, (s) => {
        s.room.pageJoins++
      })
    },
    stageLost(id) {
      hooks.patch(id, (s) => {
        s.room.stageSet = false
      })
    },
    shown(id, shown) {
      hooks.patch(id, (s) => {
        s.room.shown = copy(shown)
      })
    },
    feed(id, connected) {
      const s = shows.get(id)
      if (!s || s.show.endedAt) return
      if (s.state.feeds.every((f) => f.connected === connected)) return
      s.state.feeds.forEach((f) => {
        f.connected = connected
        if (connected) f.kbps = 4000
      })
      s.state.phase = connected ? wire.phases[1] : wire.phases[2]
      s.show.status = s.state.phase
      if (connected) s.show.startedAt ??= instant()
      if (connected) {
        delete s.state.hold
        s.firstFrameAt ??= Date.now()
      } else
        s.state.hold = {
          active: true,
          since: instant(),
          reason: wire.holdReasons[0],
          remainingSeconds: s.show.holdMaxSeconds
        }
      changed(s)
    },
    addRecording(fields = {}) {
      const id = `rec_${randomBytes(12).toString('hex')}`
      const row = {
        id,
        showId: fields.showId ?? '',
        orientation: 'h',
        state: 'complete',
        seconds: 2,
        bytes: segmentBytes.length,
        startedAt: instant(),
        createdAt: instant(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        format: wire.recordings.formats.managed,
        downloadUrl: '',
        ...fields,
        playlistUrl: `${httpsOrigin ?? httpOrigin}${managedPath('recordingPlaylist', id)}`
      }
      recordings.push(row)
      return copy(row)
    }
  }
  return {
    httpOrigin,
    httpsOrigin,
    upgrades,
    sessionToken,
    hooks,
    calls,
    shows,
    recordings,
    tokens,
    roomRpc,
    tokenFor: (id, identity) => tokenFor(shows.get(id), identity),
    snapshot: (id) => ({ rev: shows.get(id).rev, state: copy(shows.get(id).state) }),
    async close() {
      closed = true
      for (const c of controllers) c.abort()
      for (const b of barriers.values()) b.release()
      await Promise.all(
        [http, https].filter(Boolean).map(
          (s) =>
            new Promise((resolve) => {
              s.close(resolve)
              s.closeAllConnections()
            })
        )
      )
    }
  }
}
function legRef(url) {
  return url.slice(0, 3) + url.slice(-3)
}
export function destinationProblem(url, previous, replace) {
  const codes = wire.destinationRefusals.codes
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return codes[0]
  }
  if (!['rtmp:', 'rtmps:'].includes(parsed.protocol) || !/^rtmps?:\/\//.test(url)) return codes[1]
  if (parsed.username || parsed.password) return codes[2]
  if (parsed.pathname.endsWith('/')) return codes[4]
  const pieces = parsed.pathname.split('/').filter(Boolean)
  if (!pieces.length) return codes[3]
  if (
    pieces.length !== 2 ||
    /[^\x21-\x7e]|%(?![a-f\d]{2})/i.test(url) ||
    parsed.search.includes('/') ||
    parsed.hash
  )
    return codes[0]
  const last = pieces.at(-1),
    query = [...parsed.searchParams.values()].at(-1)
  if (
    last.length < wire.destinationRefusals.minKeyPieceChars ||
    (parsed.search && (!query || query.length < wire.destinationRefusals.minKeyPieceChars))
  )
    return codes[5]
  if (previous && previous !== legRef(url) && !replace) return codes[6]
  return null
}
