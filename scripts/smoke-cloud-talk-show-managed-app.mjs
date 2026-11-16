/** Plan 234 T4: managed room/control, real local LiveKit overlay delivery,
 * stage projection and independently managed HLS download jobs.
 * Run: pnpm smoke:cloud-talk-show-managed
 * Requires an already built dev backend (never builds), livekit-server --dev,
 * Chrome (VIDEORC_SMOKE_CHROME), openssl, ffmpeg/ffprobe. Env:
 * VIDEORC_SMOKE_OUTPUT_DIR; VIDEORC_SMOKE_{FFMPEG,FFPROBE,LIVEKIT}_PATH. The
 * fake web takes this build's own version as web-control ready. The feed's
 * VIDEORC_CLOUD_FEED_CA_FILE also carries this run's test root to the dev
 * build's recording downloader (segments over HTTPS; the playlist goes
 * through the API base). Required checks fail explicitly when a hook is absent.
 * Cannot prove real LiveKit egress, webhooks, Neon, or program-page pixels/audio.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  managedHarness,
  MANAGED_DOWNLOAD as DOWNLOAD,
  OUTPUT,
  waitFor,
  holdFor,
  readTree,
  playable,
  runMedia
} from './lib/cloud-managed-smoke.mjs'
import {
  managedRoomListener,
  checkOverlay,
  hostReconnect,
  hostRoomDrop,
  nodeTalkSentinel
} from './lib/cloud-managed-room.mjs'
import { managedWire as w } from './lib/fake-cloud-web-managed.mjs'

// The backend's private download folder (cloud_control_web.rs), made in the
// app's TMPDIR. No such folder, playlist or segment outlives its job.
const DOWNLOAD_TEMP_PREFIX = 'videorc-cloud-download-'
const downloadTemps = (h) =>
  readdirSync(h.env.TMPDIR).filter((name) => name.startsWith(DOWNLOAD_TEMP_PREFIX))
const noDownloadTemps = (h) =>
  waitFor(
    () =>
      downloadTemps(h).length === 0 &&
      readTree(h.env.TMPDIR).every((p) => !p.endsWith('.m3u8') && !p.endsWith('.ts')),
    'download temporary folder removed'
  )
const h = await managedHarness('talk')
const blockers = [],
  completed = []
let listener, node
const step = async (name, fn) => {
  await fn()
  completed.push(name)
  console.log(`[managed talk] ${name}`)
}
// Missing product interfaces are recorded without hiding independent checks;
// the final assertion refuses to mark this smoke green with missing coverage.
const required = async (name, fn) => {
  try {
    await step(name, fn)
  } catch (e) {
    blockers.push(`${name}: ${e.message}`)
    console.error(`[managed talk blocked] ${name}: ${e.message}`)
  }
}
try {
  await h.destinations(2)
  await h.launch()
  let stage, host
  await step(
    'open with empty ingest, no runner socket, refreshed host token and a real room',
    async () => {
      const opened = await h.rpc('cloud.room.open', {
        outputs: [OUTPUT],
        title: 'Managed smoke',
        platforms: []
      })
      h.showId = opened.show.id
      host = `host:${h.showId}`
      assert.deepEqual(h.web.shows.get(h.showId).ingest, [])
      await h.status((s) => s.room?.client === 'connected', 'host joins local room', 60000)
      await h.assertNoControlSocket()
      assert.equal(h.web.snapshot(h.showId).state.feeds.length, 0)
      h.assertNoDirect()
      listener = await managedRoomListener(h)
    }
  )
  const guests = [`g_${randomBytes(11).toString('hex')}`, `g_${randomBytes(11).toString('hex')}`]
  await step('real guests publish camera/tone; recorder is never counted as a person', async () => {
    await listener.joinPeer(guests[0], true, { tone: 659, color: '#c02020' })
    await listener.joinPeer(guests[1], true, { tone: 1100, color: '#f0f060' })
    const s = await h.status((s) => s.room?.participants?.length === 3, 'host and two guests')
    assert.ok(s.room.participants.every((p) => !p.identity.startsWith('EG_')))
    const strip = await h.eval(
      'return [...document.querySelectorAll("[data-testid=show-stage-strip-row]")].map(e => e.dataset.stageIdentity)'
    )
    assert.equal(
      strip.some((id) => id.startsWith('EG_')),
      false
    )
  })
  await step('layout stage requests and a real guest screen-share reach the room', async () => {
    const layouts = [
      { layout: 'solo', onStage: [host] },
      { layout: 'side-by-side', onStage: [host, guests[0]] },
      { layout: 'side-by-side', onStage: [host, ...guests] },
      { layout: 'spotlight', onStage: [host, ...guests], spotlight: guests[0] },
      { layout: 'side-by-side', onStage: [host, guests[1]] }
    ]
    for (const value of layouts) {
      await h.rpc('cloud.stage.set', value)
      assert.deepEqual(h.web.snapshot(h.showId).state.room.stage, value)
    }
    await listener.screen(guests[1], true)
    await h.status(
      (s) => s.room?.participants.some((p) => p.identity === guests[1] && p.screen),
      'guest screen published'
    )
    const share = { layout: 'screen-people', onStage: [host, ...guests], screen: guests[1] }
    await h.rpc('cloud.stage.set', share)
    assert.equal(h.web.snapshot(h.showId).state.room.stage.screen, guests[1])
    await listener.screen(guests[1], false)
  })
  await step('stage set, stageSet false resends, invalid-stage surfaces', async () => {
    stage = { layout: 'side-by-side', onStage: [host, ...guests], hostShape: 'rounded' }
    await h.rpc('cloud.stage.set', stage)
    assert.equal(h.web.snapshot(h.showId).state.room.stageSet, true)
    const at = Date.now()
    h.web.hooks.stageLost(h.showId)
    await waitFor(() => h.calls('stage', at).some((c) => c.status === 200), 'stage resent')
    assert.deepEqual(h.calls('stage', at).at(-1).body, stage)
    h.web.hooks.failNext('stage', 1, w.errors.stage[1].status, w.errors.stage[1].code)
    await assert.rejects(
      h.rpc('cloud.stage.set', { ...stage, layout: 'spotlight', spotlight: guests[0] }),
      /invalid-stage/
    )
  })
  await step(
    'Go Live, independent Record and End livestream carries URLs and keeps room/recording',
    async () => {
      await h.rpc('cloud.show.goLive', { streaming: h.streaming() })
      await h.rpc('cloud.recording.start')
      const at = Date.now()
      await h.rpc('cloud.show.legs.end')
      const sent = h.calls('legsEnd', at)[0]
      assert.deepEqual(
        sent.body.destinations.map((d) => d.id).sort(),
        h.targets.map((t) => t.id).sort()
      )
      assert.ok(sent.body.destinations.every((d) => d.url === '(address withheld)'))
      const state = h.web.snapshot(h.showId).state
      assert.deepEqual(state.legs, [])
      assert.ok(state.room.connected)
      assert.ok(state.recording.active)
      await h.rpc('cloud.recording.stop')
      h.assertNoDirect()
    }
  )
  await step(
    'destination retry held between attempts cannot restart after End livestream',
    async () => {
      await h.rpc('cloud.show.goLive', { streaming: h.streaming() })
      const at = Date.now()
      h.web.hooks.failNext('destinations', 1, 503)
      h.web.hooks.egressDied(h.showId)
      await waitFor(
        () => h.calls('destinations', at).some((c) => c.status === 503),
        'first recovery failure'
      )
      // Pause only AFTER the failed response. The retry can now be in flight,
      // but cannot apply retained URLs until after End has completed.
      const barrier = h.web.hooks.pause('destinations')
      try {
        await h.rpc('cloud.show.legs.end', {}, 15000)
        const endedAt = h.calls('legsEnd', at).at(-1).answeredAtMs
        barrier.release()
        await holdFor(
          () => h.web.snapshot(h.showId).state.legs.length === 0,
          'late recovery restarted the livestream',
          4000
        )
        assert.equal(h.calls('destinations', endedAt).filter((c) => c.status === 200).length, 0)
        assert.ok(h.web.snapshot(h.showId).state.room.connected)
      } finally {
        barrier.release()
      }
    }
  )
  await step('Record on/off and every specified refusal reach the caller', async () => {
    for (const on of [true, false]) {
      for (const error of w.errors.recording) {
        h.web.hooks.failNext('recording', error.status >= 500 ? 2 : 1, error.status, error.code)
        await assert.rejects(
          h.rpc(on ? 'cloud.recording.start' : 'cloud.recording.stop'),
          // The desktop's words for each refusal (cloud_control_web.rs
          // recording_problem, and the shared CloudApiError for cloud-full).
          new RegExp(
            error === w.errors.recording[0]
              ? 'talk shows'
              : error === w.errors.recording[1]
                ? 'no-target'
                : error === w.errors.recording[2]
                  ? 'end the livestream first'
                  : error.code === 'cloud-full'
                    ? 'Videorc Cloud is full right now'
                    : error.code
          )
        )
      }
      await h.rpc(on ? 'cloud.recording.start' : 'cloud.recording.stop')
      assert.equal(h.web.snapshot(h.showId).state.recording.active, on)
    }
  })
  await required(
    'actual overlay byte streams, exact attributes, TTL, page join/reconnect and stalled set clear',
    async () => {
      // The existing Rust overlay types describe these smoke RPCs, but main at
      // the pinned base does not dispatch them. An unknown-method answer names
      // the required hook explicitly; never substitute a renderer-only mock.
      const png = runMedia(h.ffmpeg, [
        '-f',
        'lavfi',
        '-i',
        'color=red:s=64x64',
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        'pipe:1'
      ]).toString('base64')
      const overlay = (slot, image = png, ttlSeconds) =>
        h.rpc('cloud.overlay.set', {
          slot,
          orientation: 'h',
          pngBase64: image,
          rect: { x: 0, y: 0, w: 1, h: 1 },
          ...(ttlSeconds ? { ttlSeconds } : {})
        })
      const count = async (slot) =>
        (await listener.records()).filter(
          (r) => r.topic === w.overlay.topics.set && r.attributes.slot === slot
        ).length
      // The renderer's own account of each send, for a failure to name: its
      // warnings and every overlay image fetch with its answer.
      await h.eval(
        'window.__managedOverlayLog=[]; const warn=console.warn.bind(console); console.warn=(...a)=>{window.__managedOverlayLog.push("warn: "+a.map(String).join(" ").slice(0,300)); warn(...a)}; const f=window.fetch.bind(window); window.fetch=async (url,...rest)=>{ if(!String(url).includes("/cloud/overlays/")) return f(url,...rest); try { const r=await f(url,...rest); window.__managedOverlayLog.push("fetch "+r.status); return r } catch(e) { window.__managedOverlayLog.push("fetch failed: "+String(e&&e.message||e).slice(0,200)); throw e } }; return true'
      )
      await overlay('card', png, 2)
      await overlay('takeover')
      try {
        await waitFor(
          async () => (await count('card')) === 1 && (await count('takeover')) === 1,
          'initial overlays'
        )
      } catch (error) {
        const seen = await h.eval('return window.__managedOverlayLog')
        throw new Error(
          `${error.message}; the listener holds ${(await listener.records()).length} streams; the renderer saw: ${JSON.stringify(seen)}`
        )
      }
      for (const record of await listener.records())
        if (record.topic === w.overlay.topics.set)
          checkOverlay(record, {
            slot: record.attributes.slot,
            ttl: record.attributes.slot === 'card' ? 2 : undefined,
            sender: host
          })
      // Both a normal program page and rec=1 use the joined-page counter.
      for (let i = 0; i < 2; i++) {
        const before = await count('takeover')
        h.web.hooks.pageJoin(h.showId)
        await waitFor(async () => (await count('takeover')) > before, 'page-join takeover replay')
        assert.equal(await count('card'), 1)
      }
      // The host's room connection drops and comes back in the same app:
      // the untimed takeover arrives again, the timed card does not, and no
      // destination is sent. (A relaunch is the Resume step's: overlays set
      // through this smoke's RPC live only in the backend that set them.)
      const before = await count('takeover'),
        puts = h.calls('destinations').length
      await hostRoomDrop(h)
      await waitFor(async () => (await count('takeover')) > before, 'reconnect takeover replay')
      assert.equal(await count('card'), 1)
      assert.equal(h.calls('destinations').length, puts)
      // Random pixels do not compress: a PNG well over the 2 MiB limit.
      const noise = join(h.root, 'overlay-noise.rgb')
      writeFileSync(noise, randomBytes(1200 * 1000 * 3))
      const large = runMedia(h.ffmpeg, [
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-s',
        '1200x1000',
        '-i',
        noise,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        'pipe:1'
      ])
      assert.ok(large.length > w.overlay.maxBytes)
      const largeAt = Date.now()
      await overlay('takeover', large.toString('base64'))
      const jpeg = await waitFor(
        async () =>
          (await listener.records()).find((r) => r.atMs >= largeAt && r.mimeType === 'image/jpeg'),
        'oversize image JPEG'
      )
      assert.ok(jpeg.length <= w.overlay.maxBytes)
      assert.deepEqual(jpeg.head, [255, 216, 255])
      await h.eval(
        'window.__managedOriginalFetch=window.fetch; window.__managedPending=[]; window.fetch=(url,...args)=>String(url).includes("/cloud/overlays/") ? new Promise((resolve,reject)=>window.__managedPending.push(()=>window.__managedOriginalFetch(url,...args).then(resolve,reject))) : window.__managedOriginalFetch(url,...args); return true'
      )
      try {
        await overlay('takeover')
        await waitFor(
          () => h.eval('return window.__managedPending.length > 0'),
          'stalled overlay fetch'
        )
        const at = Date.now()
        await h.rpc('cloud.overlay.clear', { slot: 'takeover', orientation: 'h' })
        const clear = await waitFor(
          async () =>
            (await listener.records()).find(
              (r) => r.atMs >= at && r.topic === w.overlay.topics.clear
            ),
          'clear bypasses stalled set',
          5000
        )
        assert.deepEqual(JSON.parse(clear.body), {
          v: w.overlay.clearVersion,
          slot: 'takeover',
          o: 'h'
        })
        assert.equal(clear.sender, host)
      } finally {
        await h.eval(
          'window.fetch=window.__managedOriginalFetch; for(const release of window.__managedPending) release(); return true'
        )
      }
    }
  )
  await step(
    'Program monitor follows shorter shown and drops departed guest; return stays unavailable',
    async () => {
      await h.rpc('cloud.recording.start')
      await h.rpc('cloud.stage.set', stage)
      h.web.hooks.shown(h.showId, { layout: 'solo', onStage: [host] })
      await listener.leave(guests[0])
      let lastView = null
      try {
        await waitFor(async () => {
          const view = await h.eval(
            'const p=document.querySelector("[data-testid=show-stage-program]"); return {tab:document.querySelector("[data-videorc-active-tab]")?.dataset.videorcActiveTab ?? null,source:p?.dataset.programSource,tiles:[...(p?.querySelectorAll("[data-stage-identity]")??[])].map(e=>e.dataset.stageIdentity),speaker:[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="Listen to the program")}'
          )
          lastView = view
          return (
            view.source === 'stage' &&
            view.tiles.length === 1 &&
            view.tiles[0] === host &&
            !view.speaker
          )
        }, 'Program draws only shown host')
      } catch (error) {
        const room = (await h.rpc('cloud.status')).room
        throw new Error(
          `${error.message}; last view ${JSON.stringify(lastView).replaceAll(h.showId, '<show>')}; room shown ${JSON.stringify(room?.shown ?? null).replaceAll(h.showId, '<show>')}, stage ${JSON.stringify(room?.stage ?? null).replaceAll(h.showId, '<show>')}`
        )
      }
      await assert.rejects(
        h.rpc('cloud.return.set', { open: true }),
        new RegExp(w.return.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      )
    }
  )
  await step(
    'phone host go leaves the desktop seated until DUPLICATE_IDENTITY, then Continue here takes it back',
    async () => {
      // The preceding Program check deliberately removed this guest. Restore
      // both publishers before testing that moving the host preserves them.
      await listener.joinPeer(guests[0], true, { tone: 659, color: '#c02020' })
      await h.status(
        (s) => guests.every((id) => s.room?.participants.some((p) => p.identity === id)),
        'both guests present before host continuation'
      )
      await h.rpc('cloud.show.goLive', { streaming: h.streaming() })
      await h.status((s) => s.room?.client === 'connected', 'desktop host before continuation')
      const before = structuredClone(h.web.snapshot(h.showId).state.room.stage)
      const phone = h.newDevice()
      const at = Date.now()
      const go = await h.webRequest('on-air', { device: phone, source: 'host', step: 'go' })
      assert.equal(go.status, 200)
      assert.ok(go.body.room?.identity === host)
      // Announcing host/go is not a successful host join. In particular a
      // failed phone join must not remove the desktop's camera and guests.
      await holdFor(
        async () => {
          const status = await h.rpc('cloud.status')
          return status.room?.client === 'connected' && !status.stoppedBy
        },
        'onAir alone removed the desktop host',
        4000
      )
      h.assertNoPlatformEnd(at)
      const joinedAt = Date.now()
      await listener.joinHost(go.body.room)
      await h.status(
        (s) => s.stoppedBy === 'taken-over' && s.show?.resumable && !s.room,
        'confirmed duplicate host releases desktop seat',
        10000
      )
      assert.ok(
        h.events.some(
          (e) =>
            e.atMs >= joinedAt && e.event === 'cloud.state' && e.payload.stoppedBy === 'taken-over'
        ),
        'takeover requires the real second host join'
      )
      // The backend socket and the renderer's lazy notice module settle
      // independently. Require the exact toast after the renderer commits it.
      await waitFor(
        () =>
          h.eval(
            `return document.body.textContent.includes('Your show continues on Smoke phone.')`
          ),
        'host takeover toast',
        3000
      )
      await h.captureUi('taken-over', '[data-sonner-toast]', 'Your show continues on Smoke phone.')
      await holdFor(
        () => {
          const room = h.web.snapshot(h.showId).state.room
          return (
            guests.every((id) => room.participants.some((p) => p.identity === id)) &&
            !h.web.shows.get(h.showId).show.endedAt
          )
        },
        'guests or room ended during host move',
        3000
      )
      assert.deepEqual(h.web.snapshot(h.showId).state.room.stage, before)
      await h.continueUi()
      await h.status(
        (s) => s.room?.client === 'connected' && s.onAir?.thisDevice,
        'desktop continues as host',
        60000
      )
      await waitFor(
        () => listener.hostWasReplaced(),
        'browser host displaced by desktop duplicate identity'
      )
      assert.deepEqual(h.web.snapshot(h.showId).state.room.stage, before)
      assert.ok(h.calls('onAir', at).some((c) => c.body.source === 'host' && c.body.step === 'go'))
      h.assertNoPlatformEnd(at)
      await listener.leave(host)
      h.scanLeaks()
    }
  )
  await step(
    'relaunch Resume sends no stage and no destinations; 401 then sign-in regains room controls',
    async () => {
      // stageSet stays true once a PUT stage succeeded, so the desktop never
      // sends it again (wire contract, state.room); nor the destinations.
      const puts = h.calls('destinations').length,
        stageCount = h.calls('stage').length
      await hostReconnect(h)
      await holdFor(
        () => h.calls('stage').length === stageCount && h.calls('destinations').length === puts,
        'Resume sent the stage or the destinations again',
        4000
      )
      const at = Date.now()
      h.web.hooks.failNext('state', 1, 401)
      h.web.hooks.patch(h.showId, (s) => {
        s.liveSeconds++
      })
      await waitFor(() => h.calls('state', at).some((c) => c.status === 401), '401', 45000)
      const polls = h.calls('state').length
      await holdFor(() => h.calls('state').length === polls, '401 still polling', 2500)
      await h.refreshSignIn()
      await h.status((s) => s.connected && s.room?.phase === 'open', 'control regained')
      await h.rpc('cloud.stage.set', { layout: 'solo', onStage: [host] })
      await h.rpc('cloud.recording.start')
      await h.rpc('cloud.recording.stop')
      await h.rpc('cloud.show.legs.end')
    }
  )
  await required(
    'HLS download jobs: playable, responsive controls, retry, failure, collision, concurrent isolation and cancel',
    async () => {
      const row = h.web.hooks.addRecording({ showId: h.showId })
      await waitFor(
        async () => (await h.rpc('cloud.recordings.list')).recordings.some((r) => r.id === row.id),
        'recording list catches up'
      )
      // The smoke's socket is the renderer role: a raw folder is refused, and
      // the folder goes as the single-use capability main issues, as the
      // Library passes Output's folder.
      await assert.rejects(
        h.rpc(DOWNLOAD.start, { id: row.id, outputDirectory: h.env.VIDEORC_RECORDINGS_DIR }, 5000),
        /raw outputDirectory is not accepted/
      )
      const folder = async () =>
        (
          await h.command('authorize-smoke-resource', {
            kind: 'output-directory',
            path: h.env.VIDEORC_RECORDINGS_DIR
          })
        ).capabilityId
      const start = async (id = row.id, connection) => {
        const at = Date.now(),
          result = await h.rpc(
            DOWNLOAD.start,
            { id, outputDirectoryCapability: await folder() },
            5000,
            connection
          )
        assert.ok(
          typeof result.jobId === 'string',
          `${DOWNLOAD.start} must return {jobId} promptly`
        )
        return { id: result.jobId, at }
      }
      const terminal = (job) =>
        waitFor(
          () =>
            h.events.find(
              (e) =>
                e.event === DOWNLOAD.event &&
                e.payload.jobId === job.id &&
                ['done', 'failed', 'cancelled'].includes(e.payload.state ?? e.payload.phase)
            ),
          'download terminal event',
          90000
        )
      const noTemps = () => noDownloadTemps(h)
      const success = async (job) => {
        const done = await terminal(job)
        assert.equal(done.payload.state ?? done.payload.phase, 'done')
        assert.ok(done.payload.path)
        assert.ok(
          h.events.some(
            (e) =>
              e.event === DOWNLOAD.event &&
              e.payload.jobId === job.id &&
              (e.payload.progress !== undefined ||
                !['done', 'failed', 'cancelled'].includes(e.payload.state ?? e.payload.phase))
          ),
          'download reports progress'
        )
        playable(h, done.payload.path)
        return done.payload.path
      }
      // HTTPS for BOTH the playlist and segment is deliberate. The base desktop
      // cannot trust this API root; failure here is a real required blocker.
      h.web.hooks.failNext('recordingPlaylist', 1, 503)
      const first = await start(),
        firstPath = await success(first)
      await noTemps()
      assert.equal(h.calls('recordingPlaylist', first.at).filter((c) => c.status === 503).length, 1)
      const secondPath = await success(await start())
      assert.ok(secondPath.includes(' (2)'))
      assert.notEqual(firstPath, secondPath)
      const barrier = h.web.hooks.pause('segment')
      let slow
      try {
        slow = await start()
        await waitFor(() => barrier.hits, 'segment held')
        // The temporary check looks where the job works: its folder is there now.
        assert.equal(downloadTemps(h).length, 1, 'a held download has its private folder')
        const at = Date.now()
        await h.rpc('cloud.stage.set', { layout: 'solo', onStage: [host] }, 5000)
        await h.rpc('cloud.recording.start', {}, 5000)
        await h.rpc('cloud.recording.stop', {}, 5000)
        await h.rpc('cloud.show.legs.end', {}, 5000)
        assert.ok(Date.now() - at < 10000, 'download blocked room control lane')
      } finally {
        barrier.release()
      }
      await success(slow)
      await noTemps()
      h.web.hooks.failNext('segment', 3, 503)
      const failed = await terminal(await start())
      assert.equal(failed.payload.state ?? failed.payload.phase, 'failed')
      await noTemps()
      assert.equal(
        JSON.stringify(failed).includes('https://'),
        false,
        'failed job leaked a segment address'
      )
      // Two authenticated clients hit the same basename concurrently: two
      // recordings that started in the same minute (one recording is one job,
      // so a second start of the same row only names the running job). Fail
      // the first segment of one (the downloader tries a segment three times),
      // while preserving the other's completed file.
      const twin = h.web.hooks.addRecording({ showId: h.showId, startedAt: row.startedAt })
      await waitFor(
        async () => (await h.rpc('cloud.recordings.list')).recordings.some((r) => r.id === twin.id),
        'twin recording listed'
      )
      const connection = await h.backendConnection()
      try {
        h.web.hooks.failNext('segment', 1, 503)
        const jobs = await Promise.all([start(), start(twin.id, connection)])
        const results = await Promise.all(jobs.map(terminal))
        const good = results.find((e) => (e.payload.state ?? e.payload.phase) === 'done')
        assert.ok(good, 'at least one colliding download must succeed')
        playable(h, good.payload.path)
        assert.ok(existsSync(firstPath))
        assert.ok(existsSync(secondPath))
        assert.equal(
          new Set(results.filter((e) => e.payload.path).map((e) => e.payload.path)).size,
          results.filter((e) => e.payload.path).length
        )
      } finally {
        connection.close()
      }
      await noTemps()
      const cancelBarrier = h.web.hooks.pause('segment')
      try {
        const job = await start()
        await waitFor(() => cancelBarrier.hits, 'cancel download held')
        await h.rpc(DOWNLOAD.cancel, { jobId: job.id }, 5000)
        const cancelled = await terminal(job)
        assert.equal(cancelled.payload.state ?? cancelled.payload.phase, 'cancelled')
      } finally {
        cancelBarrier.release()
      }
      await noTemps()
      // A node recording is a job that fails at once with the account-page words.
      const nodeRow = h.web.hooks.addRecording({ format: w.recordings.formats.node })
      const nodeJob = await terminal(await start(nodeRow.id))
      assert.equal(nodeJob.payload.state, 'failed')
      assert.match(nodeJob.payload.error ?? '', /videorc\.com/)
      h.scanLeaks()
    }
  )
  await required(
    'Library Cloud recordings: the row after Stop, Download progress then Saved, a failure, Cancel, a node row offers the account page',
    async () => {
      const section = '[data-testid=library-cloud-recordings]'
      const rowSelector = (id) => `[data-testid=library-cloud-recording][data-recording-id="${id}"]`
      const rowText = (id) =>
        h.eval(
          `return document.querySelector(${JSON.stringify(rowSelector(id))})?.textContent ?? null`
        )
      const buttons = (id) =>
        h.eval(
          `return [...(document.querySelector(${JSON.stringify(rowSelector(id))})?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim())`
        )
      const click = (selector, label) =>
        h.eval(
          `const b = [...(document.querySelector(${JSON.stringify(selector)})?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled); if (!b) return false; b.click(); return true`
        )
      const rowSays = (id, pattern, label, ms = 30000) =>
        waitFor(async () => pattern.test((await rowText(id)) ?? ''), label, ms)
      const doneEvent = (recordingId, state) =>
        h.events.find(
          (e) =>
            e.event === DOWNLOAD.event &&
            e.payload.recordingId === recordingId &&
            e.payload.state === state
        )
      const listed = async (id) => {
        assert.ok(await click(section, 'Refresh'), 'the section has Refresh')
        await waitFor(async () => (await rowText(id)) !== null, 'row listed after Refresh')
      }
      await h.command('open-tab', { tab: 'library', waitFor: section })

      // The take's row: listed by the section's own poll after Stop, here 12 s
      // after Stop (the web still finishing the playlist), inside 2 minutes.
      const known = new Set(h.web.recordings.map((r) => r.id))
      h.web.hooks.delayNextRecordingRow(12000)
      await h.rpc('cloud.recording.start')
      await h.status((s) => s.recording?.active, 'cloud recording on')
      await sleep(2000)
      await h.rpc('cloud.recording.stop')
      const stoppedAt = Date.now()
      await h.status((s) => !s.recording?.active, 'cloud recording off')
      const take = await waitFor(
        () => h.web.recordings.find((r) => !known.has(r.id)),
        'the take row on the web',
        30000
      )
      await waitFor(
        async () => (await rowText(take.id)) !== null,
        'Library lists the take after Stop',
        120000 - (Date.now() - stoppedAt)
      )
      console.log(
        `[managed talk] Library row ${((Date.now() - stoppedAt) / 1000).toFixed(1)} s after Stop`
      )
      const offered = await buttons(take.id)
      assert.ok(
        offered.includes('Download'),
        `the take's row offers ${JSON.stringify(offered)}: ${await rowText(take.id)}`
      )

      // Download: progress while the segment is held, then Saved and Show in Finder.
      const held = h.web.hooks.pause('segment')
      try {
        assert.ok(await click(rowSelector(take.id), 'Download'))
        await rowSays(take.id, /Downloading/, 'row shows Downloading')
        assert.ok(
          await h.eval(
            `return !!document.querySelector(${JSON.stringify(rowSelector(take.id))})?.querySelector('[role=progressbar]')`
          ),
          'the row shows a progress bar'
        )
        assert.ok((await buttons(take.id)).includes('Cancel'))
      } finally {
        held.release()
      }
      await rowSays(take.id, /Saved/, 'row shows Saved', 60000)
      assert.ok((await buttons(take.id)).some((b) => /^Show in /.test(b)))
      playable(h, doneEvent(take.id, 'done').payload.path)

      // A failed download says so and offers Try again.
      const broken = h.web.hooks.addRecording({ showId: h.showId })
      await listed(broken.id)
      h.web.hooks.failNext('segment', 3, 503)
      assert.ok(await click(rowSelector(broken.id), 'Download'))
      await rowSays(broken.id, /Couldn.t download/, 'row shows the failure', 60000)
      assert.ok((await buttons(broken.id)).includes('Try again'))
      await noDownloadTemps(h)

      // Cancel takes the row back to Download.
      const spare = h.web.hooks.addRecording({ showId: h.showId })
      await listed(spare.id)
      const hold = h.web.hooks.pause('segment')
      try {
        assert.ok(await click(rowSelector(spare.id), 'Download'))
        await rowSays(spare.id, /Downloading/, 'spare row downloading')
        assert.ok(await click(rowSelector(spare.id), 'Cancel'))
        await waitFor(
          async () =>
            !/Downloading/.test((await rowText(spare.id)) ?? '') &&
            (await buttons(spare.id)).includes('Download'),
          'Cancel takes the row back to Download'
        )
        await waitFor(() => doneEvent(spare.id, 'cancelled'), 'cancelled event')
      } finally {
        hold.release()
      }
      await noDownloadTemps(h)

      // A node recording opens the account page; nothing downloads here.
      const node = h.web.hooks.addRecording({ format: w.recordings.formats.node })
      await listed(node.id)
      const labels = await buttons(node.id)
      assert.ok(labels.includes('Open videorc.com'))
      assert.equal(labels.includes('Download'), false)
      // The click itself is not made here: window.videorc is frozen by the
      // context bridge, so its opener cannot be watched, and a click would
      // open a real browser on this Mac. library-cloud-recordings.test.ts
      // pins it ('opens the account page on videorc.com for a node
      // recording': openOAuthUrl with .../account).
      console.log(
        '[managed talk] node row: Open videorc.com offered, no Download; the click is pinned by library-cloud-recordings.test.ts'
      )
      await h.command('open-tab', { tab: 'studio' })
    }
  )
  await required('untrusted segment TLS is refused by the bundled remux', async () => {
    // The web uses the trusted test root. A separate HTTPS listener has another
    // root and is deliberately NOT added to the feed CA file.
    const other = await import('./lib/cloud-managed-untrusted.mjs')
    await other.assertUntrustedManagedSegment(h, DOWNLOAD)
  })
  await required('node talk shows emit no managed overlay hand-off', async () => {
    await h.kill()
    node = await nodeTalkSentinel(h)
    await h.launch()
    await h.status((s) => s.show?.id === h.showId, 'the relaunched app holds the show', 45000)
    await h.rpc('cloud.room.resume')
    const at = Date.now()
    const png = runMedia(h.ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'color=red:s=32x32',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1'
    ]).toString('base64')
    await h.rpc('cloud.overlay.set', {
      slot: 'takeover',
      orientation: 'h',
      pngBase64: png,
      rect: { x: 0, y: 0, w: 1, h: 1 }
    })
    await holdFor(
      () => !h.events.some((e) => e.atMs >= at && e.event === 'cloud.room.overlay'),
      'node emitted managed overlay',
      2000
    )
  })
  await h.rpc('cloud.room.close')
  h.scanLeaks()
  assert.deepEqual(blockers, [], `Required checks blocked: ${blockers.join('; ')}`)
  console.log(`Managed talk complete: ${completed.length} checks`)
} finally {
  await listener?.close()
  await node?.close()
  await h.close()
}
