import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchDevApp, stopProcess } from './app-launcher.mjs'
import { startRtmpTap } from './rtmp-tap.mjs'
import {
  holdCardStats,
  evaluateHoldOnReceiver,
  parsePtsTimes,
  sortedGapStats
} from './cloud-solo-gates.mjs'
import { requestSmokeCommand } from './smoke-command-client.mjs'
import { connectBackend, request } from '../smoke-recording-session.mjs'
import {
  startFakeCloudWebManaged,
  managedWire as wire,
  maskManagedUrls
} from './fake-cloud-web-managed.mjs'

// Kept together: the download fix lane can change this single contract binding.
export const MANAGED_DOWNLOAD = Object.freeze({
  start: 'cloud.recordings.download',
  event: 'cloud.recordings.download',
  cancel: 'cloud.recordings.cancelDownload'
})
export const OUTPUT = Object.freeze({
  orientation: 'horizontal',
  width: 1280,
  height: 720,
  fps: 30,
  videoKbps: 4000
})
export const waitFor = async (fn, label, ms = 30000) => {
  const deadline = Date.now() + ms
  do {
    const value = await fn()
    if (value) return value
    await sleep(100)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
export async function holdFor(fn, label, ms = 2000) {
  const until = Date.now() + ms
  do {
    assert.ok(await fn(), label)
    await sleep(100)
  } while (Date.now() < until)
}
export function runMedia(command, args) {
  const r = spawnSync(command, args, {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30000
  })
  if (r.status !== 0)
    throw new Error(
      maskManagedUrls(`${basename(command)} failed: ${String(r.stderr ?? r.error).slice(-1500)}`)
    )
  return r.stdout
}
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** No build is performed here. The orchestrator must supply a built backend/app.
 * Uses the maintained launcher, RPC and command clients, RTMP tap and receiver gates.
 * A loopback media stand-in observes decoded feed frames; it does not claim to
 * establish LiveKit egress behaviour (the D18 Docker stack is a separate gate).
 */
export async function managedHarness(kind, pass = 1) {
  const root = mkdtempSync(
    join(process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? tmpdir(), `videorc-managed-${kind}-${pass}-`)
  )
  const appData = join(root, 'profile'),
    userData = join(root, 'electron'),
    mediaDir = join(root, 'media')
  for (const dir of [appData, userData, mediaDir]) mkdirSync(dir, { recursive: true })
  const ffmpeg = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
  const ffprobe = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
  const children = [],
    events = [],
    logs = [],
    sockets = new Set(),
    cleanups = []
  const sessionToken = randomBytes(32).toString('base64url')
  const cert = join(root, 'local-cert.pem'),
    key = join(root, 'local-key.pem')
  runMedia('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ])
  const startChild = (name, cmd, args, options = {}) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options })
    children.push(child)
    child.on('error', (e) => logs.push(`${name}: ${maskManagedUrls(e.message)}`))
    child.stderr?.on('data', (b) => logs.push(maskManagedUrls(`${name}: ${b}`)))
    return child
  }
  const ports = {
    rtmps: await freePort(),
    rtmp: await freePort(),
    rtsp: await freePort(),
    api: await freePort(),
    proxy: await freePort(),
    livekit: await freePort(),
    rtc: await freePort()
  }
  let closing
  let web,
    app,
    backend,
    smoke,
    tap,
    timer,
    decode,
    segmentBytes = Buffer.alloc(0),
    activeShow
  const feedKey = randomBytes(16).toString('hex')
  const feed = {
    orientation: 'horizontal',
    serverUrl: `rtmps://localhost:${ports.proxy}/live`,
    streamKey: feedKey
  }
  const livekit =
    kind === 'talk'
      ? {
          url: `ws://127.0.0.1:${ports.livekit}`,
          httpUrl: `http://127.0.0.1:${ports.livekit}`,
          apiKey: randomBytes(12).toString('hex'),
          apiSecret: randomBytes(32).toString('hex')
        }
      : undefined
  const env = {
    VIDEORC_APP_VERSION: process.env.VIDEORC_APP_VERSION ?? '0.26.0',
    VIDEORC_CLOUD_FEED_CA_FILE: cert,
    VIDEORC_SMOKE_SKIP_PREBUILD: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_OUTPUT_DIR: root,
    VIDEORC_SMOKE_STATE_DIR: root,
    VIDEORC_APP_DATA_DIR: appData,
    VIDEORC_USER_DATA_DIR: userData,
    VIDEORC_RECORDINGS_DIR: join(root, 'downloads'),
    TMPDIR: join(root, 'download-temp')
  }
  mkdirSync(env.TMPDIR)
  mkdirSync(env.VIDEORC_RECORDINGS_DIR)
  // Runtime-only synthetic sign-in. Never read or import the owner's credentials.
  writeFileSync(
    join(appData, 'videorc-secrets.json'),
    JSON.stringify({ 'account:videorc:session': sessionToken }),
    { mode: 0o600 }
  )
  const h = {
    root,
    appData,
    ffmpeg,
    ffprobe,
    ports,
    events,
    logs,
    env,
    feed,
    livekit,
    get web() {
      return web
    },
    get backend() {
      return backend
    },
    get smoke() {
      return smoke
    },
    async backendConnection() {
      return connectBackend(app.connections['backend-ready'], 10000)
    },
    get showId() {
      return activeShow
    },
    set showId(id) {
      activeShow = id
    },
    feedFrames: [],
    directConnections: [],
    async rpc(method, params = {}, ms = 45000, connection = backend) {
      return request(connection, ms, method, params)
    },
    async status(predicate, label, ms) {
      return waitFor(
        async () => {
          const s = await h.rpc('cloud.status')
          return predicate(s) && s
        },
        label,
        ms
      )
    },
    async eval(code, params = {}) {
      const r = await requestSmokeCommand(
        smoke,
        'eval-js',
        { ...params, code },
        { timeoutMs: 15000 }
      )
      return r?.result ?? r
    },
    async command(command, params = {}) {
      return requestSmokeCommand(smoke, command, params, { timeoutMs: 15000 })
    },
    calls(route, after = 0) {
      return web.calls.filter((c) => c.route === route && c.atMs >= after)
    },
    async launch() {
      app = await launchDevApp({
        requiredMarkers: ['backend-ready', 'preview-motion-ready'],
        timeoutMs: 180000,
        env,
        skipPrebuild: true,
        onLine: (l) => logs.push(l)
      })
      backend = await connectBackend(app.connections['backend-ready'], 30000)
      smoke = app.connections['preview-motion-ready']
      backend.addEventListener('message', (e) => {
        try {
          const m = JSON.parse(e.data)
          if (m.event) events.push({ ...m, atMs: Date.now() })
        } catch {}
      })
      await h.status((s) => s.entitled && s.settings?.enabled, 'managed entitlement')
    },
    async kill() {
      backend?.close()
      const pid = app?.process?.pid
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch (e) {
          if (e.code !== 'ESRCH') throw e
        }
      }
      await app?.stop()
      app = null
    },
    async cut() {
      await tap.close()
      tap = null
    },
    async forward() {
      tap = await startRtmpTap({ listenPort: ports.proxy, targetPort: ports.rtmps })
    },
    async assertNoControlSocket() {
      // Exact owned backend PID only; no process-name scans. The room WebSocket
      // is expected for talk; a media/runner control connection is not.
      const pid = app.connections['backend-ready'].pid
      assert.ok(pid, 'backend-ready must publish its owned PID for the socket audit')
      const r = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:ESTABLISHED'], {
        encoding: 'utf8'
      })
      assert.ok(r.status === 0 || r.status === 1, 'lsof must inspect the owned backend')
      const peers = (r.stdout ?? '').split('\n').filter((l) => l.includes('->'))
      assert.ok(
        peers.every((l) => /->(127\.0\.0\.1|\[::1\]|localhost):/.test(l)),
        'managed backend opened a remote socket'
      )
      assert.equal(h.calls('create').at(-1)?.status, 201)
      assert.deepEqual(web.upgrades, [], 'managed control must never upgrade to a socket')
      assert.deepEqual(web.shows.get(activeShow).controlKind, wire.control.kinds[0])
      // The fake supplies no socket endpoint or show token; inspect transport
      // diagnostics too when the fix lane exposes one. Room WS is renderer-owned.
      assert.equal(
        logs.some((l) => /connecting.*runner.*socket|cloud control socket connected/i.test(l)),
        false
      )
    },
    async destinations(n = 2) {
      const targets = []
      for (let i = 0; i < n; i++) {
        const port = await freePort(),
          streamKey = randomBytes(16).toString('hex')
        const server = createServer((socket) => {
          sockets.add(socket)
          h.directConnections.push({ atMs: Date.now(), id: `local-${i}` })
          socket.on('error', () => {})
          socket.on('close', () => sockets.delete(socket))
        })
        await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
        cleanups.push(() => new Promise((resolve) => server.close(resolve)))
        targets.push({
          id: `local-${i}`,
          platform: 'custom',
          label: `Local ${i + 1}`,
          enabled: true,
          serverUrl: `rtmp://127.0.0.1:${port}/live`,
          urlMode: 'server-and-key',
          streamKey,
          streamKeyPresent: true,
          authMode: 'manual-rtmp',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      }
      h.targets = targets
      return targets
    },
    streaming(targets = h.targets) {
      return {
        enabled: true,
        mode: 'multi',
        targets,
        enabledTargetIds: targets.map((t) => t.id),
        defaultOutputPreset: 'tutorial-720p30',
        defaultBitrateKbps: 4000
      }
    },
    async sessionParams(targets = h.targets) {
      const auth = await h.command('authorize-smoke-resource', {
        kind: 'output-directory',
        path: root
      })
      return {
        sources: { testPattern: true },
        layout: {
          layoutPreset: 'screen-camera',
          cameraTransformMode: 'preset',
          cameraTransform: null,
          cameraCorner: 'bottom-right',
          cameraSize: 'medium',
          cameraShape: 'rectangle',
          cameraMargin: 32,
          cameraFit: 'fill',
          cameraMirror: false,
          cameraZoom: 100,
          cameraOffsetX: 0,
          cameraOffsetY: 0,
          sideBySideSplit: '70-30',
          sideBySideCameraSide: 'right'
        },
        output: {
          recordEnabled: true,
          streamEnabled: true,
          outputDirectoryCapability: auth.capabilityId,
          video: {
            preset: 'tutorial-720p30',
            width: 1280,
            height: 720,
            fps: 30,
            bitrateKbps: 4000
          },
          rtmp: {
            preset: 'custom',
            serverUrl: targets[0].serverUrl,
            streamKey: targets[0].streamKey
          }
        },
        streaming: h.streaming(targets)
      }
    },
    assertNoDirect(after = 0) {
      assert.equal(
        h.directConnections.filter((c) => c.atMs >= after).length,
        0,
        'cloud and direct must never publish together'
      )
    },
    scanLeaks() {
      const secrets = [feedKey, ...(h.targets ?? []).map((t) => t.streamKey), ...web.tokens]
      const texts = [
        logs.join('\n'),
        JSON.stringify(events),
        JSON.stringify(web.calls),
        ...readTree(appData).map((p) => readFileSync(p).toString('latin1')),
        ...readTree(userData).map((p) => readFileSync(p).toString('latin1'))
      ]
      for (const secret of secrets)
        assert.equal(
          texts.some((t) => t.includes(secret)),
          false,
          'a runtime media credential leaked'
        )
    },
    async close() {
      if (closing) return closing
      closing = (async () => {
        clearInterval(timer)
        backend?.close()
        // Every cleanup gets a turn, even when the app stop itself fails.
        const results = await Promise.allSettled([
          app?.stop(),
          tap?.close(),
          web?.close(),
          ...children.map((child) => stopProcess(child)),
          ...[...sockets].map((socket) => {
            socket.destroy()
            return Promise.resolve()
          }),
          ...cleanups.map((fn) => fn())
        ])
        app = null
        const secrets = [
          feedKey,
          sessionToken,
          ...(h.targets ?? []).map((t) => t.streamKey),
          ...(web?.tokens ?? []),
          ...(livekit ? [livekit.apiKey, livekit.apiSecret] : [])
        ]
        let report = JSON.stringify(
          {
            calls: web?.calls,
            events: maskManagedUrls(events),
            logs: maskManagedUrls(logs),
            feedFrames: h.feedFrames.map(({ atMs, card }) => ({ atMs, card })),
            cleanup: results.map((r) => r.status)
          },
          null,
          2
        )
        for (const secret of secrets)
          if (secret) report = report.replaceAll(secret, '(credential withheld)')
        writeFileSync(join(root, 'managed-report.json'), report)
        const failures = results.filter((r) => r.status === 'rejected')
        if (failures.length)
          throw new AggregateError(
            failures.map((r) => r.reason),
            'Owned smoke process cleanup failed'
          )
      })()
      return closing
    }
  }

  try {
    if (kind === 'talk') {
      startChild('livekit', process.env.VIDEORC_SMOKE_LIVEKIT_PATH ?? 'livekit-server', [
        '--dev',
        '--bind',
        '127.0.0.1',
        '--config-body',
        `port: ${ports.livekit}\nkeys:\n  ${livekit.apiKey}: ${livekit.apiSecret}\nrtc:\n  tcp_port: ${ports.rtc}\n  use_external_ip: false\nroom:\n  auto_create: true\n  empty_timeout: 600`
      ])
      await waitFor(async () => {
        try {
          return (await fetch(`${livekit.httpUrl}/`, { signal: AbortSignal.timeout(1000) })).ok
        } catch {
          return false
        }
      }, 'local LiveKit ready')
      const y4m = join(mediaDir, 'host.y4m'),
        wav = join(mediaDir, 'host.wav'),
        ts = join(mediaDir, 'segment.ts')
      runMedia(ffmpeg, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=1280x720:r=30',
        '-t',
        '2',
        '-pix_fmt',
        'yuv420p',
        y4m
      ])
      runMedia(ffmpeg, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '4',
        '-ac',
        '1',
        wav
      ])
      runMedia(ffmpeg, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-f',
        'mpegts',
        ts
      ])
      segmentBytes = readFileSync(ts)
      env.VIDEORC_SMOKE_FAKE_MEDIA_VIDEO = y4m
      env.VIDEORC_SMOKE_FAKE_MEDIA_AUDIO = wav
    } else {
      // MediaMTX is the maintained solo smoke's local TLS RTMP receiver. No
      // runner checkout or remote platform is involved in this transport test.
      const config = join(root, 'mediamtx.yml')
      writeFileSync(
        config,
        `logLevel: warn\nrtmp: yes\nrtmpAddress: 127.0.0.1:${ports.rtmp}\nrtmpEncryption: optional\nrtmpsAddress: 127.0.0.1:${ports.rtmps}\nrtmpServerCert: ${cert}\nrtmpServerKey: ${key}\nrtsp: yes\nrtspAddress: 127.0.0.1:${ports.rtsp}\nrtspTransports: [tcp]\nhls: no\nwebrtc: no\nsrt: no\napi: yes\napiAddress: 127.0.0.1:${ports.api}\npaths:\n  all_others:\n`
      )
      startChild('mediamtx', process.env.VIDEORC_SMOKE_MEDIAMTX_PATH ?? 'mediamtx', [config])
      await waitFor(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`)).ok
        } catch {
          return false
        }
      }, 'local TLS receiver ready')
      await h.forward()
    }
    web = await startFakeCloudWebManaged({
      sessionToken,
      ingest: [feed],
      tls: { cert: readFileSync(cert), key: readFileSync(key) },
      livekit,
      segmentBytes
    })
    env.VIDEORC_API_BASE_URL = web.httpOrigin
    let decoding = false
    timer = setInterval(async () => {
      if (!web || kind === 'talk' || decoding) return
      const s = [...web.shows.values()].find((s) => !s.show.endedAt && s.ingest.length)
      if (!s) return
      const last = h.feedFrames.at(-1)
      if (last && Date.now() - last.atMs > 1500) web.hooks.feed(s.show.id, false)
      if (!decode || decode.exitCode !== null) {
        decoding = true
        try {
          const paths = await (
            await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`, {
              signal: AbortSignal.timeout(1000)
            })
          ).json()
          if (!paths.items?.some((p) => p.ready)) return
          decode = startChild('feed-decode', ffmpeg, [
            '-nostdin',
            '-loglevel',
            'error',
            '-rtsp_transport',
            'tcp',
            '-i',
            `rtsp://127.0.0.1:${ports.rtsp}/live/${feedKey}`,
            '-an',
            '-vf',
            'scale=160:90',
            '-pix_fmt',
            'rgb24',
            '-f',
            'rawvideo',
            'pipe:1'
          ])
          let pending = Buffer.alloc(0)
          decode.stdout.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk])
            while (pending.length >= 160 * 90 * 3) {
              const frame = Buffer.from(pending.subarray(0, 160 * 90 * 3))
              pending = pending.subarray(160 * 90 * 3)
              h.feedFrames.push({ atMs: Date.now(), card: holdCardStats(frame, 160, 90), frame })
              web.hooks.feed(s.show.id, true)
            }
          })
        } finally {
          decoding = false
        }
      }
    }, 100)
    return h
  } catch (error) {
    await h.close()
    throw error
  }
}
export function readTree(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((name) => {
    const p = join(root, name)
    return statSync(p).isDirectory() ? readTree(p) : [p]
  })
}
export function playable(h, path) {
  const probe = JSON.parse(
    runMedia(h.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])
  )
  assert.ok(probe.streams.some((s) => s.codec_type === 'video'))
  assert.ok(probe.streams.some((s) => s.codec_type === 'audio'))
  assert.ok(Number(probe.format.duration) > 0.5)
  const pts = runMedia(h.ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=p=0',
    path
  ]).toString()
  assert.ok(sortedGapStats(parsePtsTimes(pts)).maxGapSeconds < 2)
  return probe
}
// Export the maintained hold gate for the full-stack extension; a feed sink by
// itself cannot prove that LiveKit's program page renders the hold card.
export { evaluateHoldOnReceiver }
