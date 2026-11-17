/** S10 acquisition. HEAVY/REAL LOCAL BROWSERS: never imported by pure tests.
 * No managed service endpoint is accepted. This cannot qualify production. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as portServer } from 'node:net'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, appendFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { managedParityGrant } from './fake-cloud-web-managed.mjs'
import { installAlphaIceProxy, startAlphaTcpProxy } from './cloud-alpha-network.mjs'
import { analyzeAlphaAcquisition } from './cloud-alpha-analysis.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const wait = async (fn, label, timeout = 20000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Alpha acquisition readiness timeout: ${label}`)
}
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = portServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  if (!(await Promise.race([exited.then(() => true), sleep(3000).then(() => false)]))) {
    child.kill('SIGKILL')
    await Promise.race([exited, sleep(3000)])
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned SFU did not exit')
  }
}
async function fixtureServer(desktopRoot, webRoot) {
  const desktopRequire = createRequire(join(desktopRoot, 'apps/desktop/package.json'))
  const webRequire = createRequire(join(webRoot, 'package.json'))
  const { build } = createRequire(webRequire.resolve('tsx'))('esbuild')
  const bundle = async (root, entry, experimental) => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
      nodePaths: [join(desktopRoot, 'apps/desktop/node_modules'), join(webRoot, 'node_modules')],
      plugins: experimental
        ? [
            {
              name: 'actual-emitted-alpha-modules',
              setup(b) {
                b.onResolve(
                  {
                    filter:
                      /lib\/cloud\/program\/(alpha-experiment|presentation-views|overlay-rules|wire)$/
                  },
                  (args) => ({
                    path: `/cloud/program/v1/${args.path.split('/').at(-1)}.js`,
                    external: true
                  })
                )
              }
            }
          ]
        : []
    })
    return result.outputFiles[0].contents
  }
  const publisher = await bundle(
    desktopRoot,
    'apps/desktop/src/renderer/src/lib/cloud-alpha-fixture.ts',
    false
  )
  const consumer = await bundle(webRoot, 'tests/browser/cloud-alpha/consumer.ts', true)
  const assets = new Map([
    ['/publisher.js', publisher],
    ['/consumer.js', consumer]
  ])
  for (const name of [
    'alpha-transport',
    'alpha-gpu',
    'alpha-experiment',
    'presentation-views',
    'overlay-rules',
    'wire'
  ])
    assets.set(
      `/cloud/program/v1/${name}.js`,
      await readFile(join(webRoot, 'public/cloud/program/v1', `${name}.js`))
    )
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const asset = assets.get(path)
    if (req.method !== 'GET' || (!asset && !['/publisher', '/consumer'].includes(path))) {
      res.writeHead(404)
      res.end()
      return
    }
    res.setHeader('cache-control', 'no-store')
    res.setHeader(
      'content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; media-src blob:; img-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'"
    )
    res.setHeader('content-type', asset ? 'text/javascript' : 'text/html')
    res.end(
      asset ??
        `<!doctype html><meta charset="utf-8"><title>Disabled S10 local acquisition</title><style>html,body,#stage{margin:0;width:100%;height:100%;overflow:hidden;background:#204060}#stage{position:relative}audio{display:none}</style><div id="stage"></div><script type="module" src="${path}.js"></script>`
    )
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    assets: Object.fromEntries([...assets].map(([name, bytes]) => [name, sha(bytes)])),
    desktopRequire,
    webRequire,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
  }
}
const sourceDigest = async (root, paths) =>
  Object.fromEntries(
    await Promise.all(paths.map(async (p) => [p, sha(await readFile(join(root, p)))]))
  )

export async function runAlphaSpike({
  desktopRoot,
  webRoot,
  seconds = Number(process.env.VIDEORC_ALPHA_SECONDS ?? 1800)
}) {
  assert.ok(
    Number.isInteger(seconds) && seconds >= 30 && seconds <= 1800,
    'Alpha duration must be 30..1800 seconds; short runs never qualify'
  )
  const output = await mkdtemp(
    join(process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? tmpdir(), 'videorc-alpha-')
  )
  const manifest = {
    schema: 1,
    kind: 'acquired-local-sfu-browser',
    runId: randomUUID(),
    status: 'acquiring',
    productionEnabled: false,
    managedQualification: 'not-run',
    seconds,
    cases: [],
    artifacts: [],
    versions: {},
    sources: {}
  }
  const manifestPath = join(output, 'acquisition.json')
  const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  let server,
    sfu,
    browserServer,
    browser,
    aborted = false
  const abort = () => {
    aborted = true
  }
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    // Read-only version calls; never download/install binaries or contact managed endpoints.
    manifest.versions.sfu = execFileSync('livekit-server', ['--version'], {
      encoding: 'utf8',
      timeout: 5000
    }).trim()
    manifest.versions.ffmpeg = execFileSync('ffmpeg', ['-version'], {
      encoding: 'utf8',
      timeout: 5000
    }).split('\n')[0]
    for (const [label, root] of [
      ['desktop', desktopRoot],
      ['web', webRoot]
    ]) {
      manifest.versions[`${label}Revision`] = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()
      assert.equal(
        execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
        '',
        'Use clean installed acquisition checkouts'
      )
    }
    server = await fixtureServer(desktopRoot, webRoot)
    manifest.sources = {
      served: server.assets,
      desktop: await sourceDigest(desktopRoot, [
        'scripts/lib/cloud-parity-alpha.mjs',
        'scripts/lib/cloud-alpha-analysis.mjs',
        'scripts/lib/cloud-alpha-network.mjs',
        'apps/desktop/src/renderer/src/lib/cloud-alpha-fixture.ts',
        'apps/desktop/src/shared/cloud-alpha.ts',
        'apps/desktop/src/shared/cloud-alpha-gpu.ts',
        'apps/desktop/src/renderer/src/lib/room-alpha-experiment.ts'
      ]),
      web: await sourceDigest(webRoot, [
        'tests/browser/cloud-alpha/consumer.ts',
        'lib/cloud/program/alpha-transport.ts',
        'lib/cloud/program/alpha-gpu.ts',
        'lib/cloud/program/alpha-experiment.ts',
        'lib/cloud/livekit.ts'
      ])
    }
    manifest.versions.client = JSON.parse(
      await readFile(join(webRoot, 'node_modules/livekit-client/package.json'), 'utf8')
    ).version
    manifest.versions.desktopClient = JSON.parse(
      await readFile(
        join(desktopRoot, 'apps/desktop/node_modules/livekit-client/package.json'),
        'utf8'
      )
    ).version
    manifest.versions.serverSdk = JSON.parse(
      await readFile(join(webRoot, 'node_modules/livekit-server-sdk/package.json'), 'utf8')
    ).version
    const { AccessToken, RoomServiceClient } = server.webRequire('livekit-server-sdk')
    const { chromium } = createRequire(join(desktopRoot, 'package.json'))('playwright-core')
    const signalPort = await freePort(),
      tcpPort = await freePort(),
      udpPort = await freePort()
    const key = 'alpha-local-fixture',
      secret = randomBytes(32).toString('hex')
    const config = join(output, 'sfu-local.yaml')
    // This config contains a newly generated local-only secret. Delete after child shutdown; never put it in evidence.
    await writeFile(
      config,
      `port: ${signalPort}\nbind_addresses: ["127.0.0.1"]\nkeys:\n  ${key}: ${secret}\nrtc:\n  node_ip: 127.0.0.1\n  tcp_port: ${tcpPort}\n  udp_port: ${udpPort}\n  use_external_ip: false\n  enable_loopback_candidate: true\nlogging:\n  level: error\n`,
      { mode: 0o600 }
    )
    sfu = spawn('livekit-server', ['--config', config], { stdio: 'ignore' })
    let spawnError = false
    sfu.once('error', () => {
      spawnError = true
    })
    const rooms = new RoomServiceClient(`http://127.0.0.1:${signalPort}`, key, secret)
    await wait(async () => {
      if (spawnError || sfu.exitCode !== null) throw new Error('Local SFU failed')
      try {
        await rooms.listRooms()
        return true
      } catch {
        return false
      }
    }, 'local SFU')
    browserServer = await chromium.launchServer({
      executablePath: process.env.CHROME_PATH,
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--enable-precise-memory-info',
        '--mute-audio',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding'
      ]
    })
    browser = await chromium.connect(browserServer.wsEndpoint())
    manifest.versions.browser = browser.version()
    const browserCdp = await browser.newBrowserCDPSession()
    const token = async (show, identity, role) => {
      const t = new AccessToken(key, secret, { identity, ttl: 7200 })
      t.addGrant(managedParityGrant({ role, room: show }))
      return t.toJwt()
    }
    const artifact = async (file, kind, lane, caseName) => {
      const info = await stat(file),
        digest = createHash('sha256')
      for await (const chunk of createReadStream(file)) digest.update(chunk)
      manifest.artifacts.push({
        file: relative(output, file),
        kind,
        lane,
        case: caseName,
        bytes: info.size,
        sha256: digest.digest('hex')
      })
    }
    for (const jitter of [0, 80])
      for (const layer of [false, true]) {
        if (aborted) throw new Error('Acquisition interrupted')
        const name = `${layer ? 'alpha' : 'baseline'}-${jitter ? 'jitter' : 'clean'}`
        const caseDir = join(output, name)
        await mkdir(caseDir)
        const show = `sh_alpha_${randomUUID().replaceAll('-', '')}`,
          epoch = randomUUID()
        const proxy = await startAlphaTcpProxy(tcpPort, jitter)
        const publishers = [],
          receivers = [],
          contexts = []
        const rawFile = join(caseDir, 'samples.jsonl')
        const result = {
          name,
          layer,
          jitterMs: jitter,
          sampleFile: relative(output, rawFile),
          participants: 6,
          screen: true,
          lanes: [],
          grantShape: 'production-roomGrantFor/recorder',
          complete: false
        }
        manifest.cases.push(result)
        await save()
        try {
          await rooms.createRoom({ name: show, emptyTimeout: 120, departureTimeout: 120 })
          const page = async (role, lane) => {
            const size =
              lane?.orientation === 'v'
                ? { width: 720, height: 1280 }
                : { width: 1280, height: 720 }
            const context = await browser.newContext({
              viewport: size,
              ...(role === 'consumer' ? { recordVideo: { dir: caseDir, size } } : {})
            })
            contexts.push(context)
            await context.addInitScript(installAlphaIceProxy, {
              targetPort: tcpPort,
              proxyPort: proxy.port
            })
            const p = await context.newPage()
            await p.goto(`${server.origin}/${role}`)
            await p.waitForFunction(
              (key) => Boolean(window[key]),
              role === 'consumer' ? 'alphaConsumer' : 'alphaPublisher'
            )
            return { p, context }
          }
          for (let index = 0; index < 6; index++) {
            const identity = index === 0 ? `host:${show}` : `guest:${index}`,
              role = index === 0 ? 'host' : 'guest'
            const item = await page('publisher')
            const published = await item.p.evaluate((input) => window.alphaPublisher.start(input), {
              url: `ws://127.0.0.1:${signalPort}`,
              token: await token(show, identity, role),
              host: index === 0,
              show,
              index,
              layer
            })
            assert.equal(
              await item.p.evaluate(() => window.alphaPublisher.probeForbiddenSource()),
              true,
              'Source-restricted grant did not refuse UNKNOWN'
            )
            publishers.push({ ...item, identity, ...published })
          }
          const listed = await rooms.listParticipants(show)
          for (const p of publishers) {
            const actual = listed.find((v) => v.identity === p.identity && v.sid === p.sid)
            assert.ok(actual, 'Publisher identity was not confirmed by SFU')
            assert.equal(
              actual.tracks.length,
              p.publications.length,
              'Unexpected server publication count'
            )
            for (const pub of p.publications) {
              const track = actual.tracks.find((t) => t.sid === pub.sid)
              assert.ok(
                track && track.name === pub.name,
                'Publication SID was not confirmed by SFU'
              )
              const sourceNumber = { camera: 1, microphone: 2, screen_share: 3 }[pub.source]
              assert.equal(
                track.source,
                sourceNumber,
                'Source must match the restricted server grant'
              )
            }
          }
          result.hostSourceCounts = Object.fromEntries(
            ['camera', 'screen_share', 'microphone'].map((source) => [
              source,
              publishers[0].publications.filter((p) => p.source === source).length
            ])
          )
          const addReceiver = async (outputKind, orientation) => {
            const lane = `${outputKind}-${orientation}`,
              identity = `EG_alpha_${outputKind}_${orientation}`
            const item = await page('consumer', { orientation })
            const sid = await item.p.evaluate((input) => window.alphaConsumer.start(input), {
              url: `ws://127.0.0.1:${signalPort}`,
              token: await token(show, identity, 'recorder'),
              show,
              lane: { output: outputKind, orientation }
            })
            assert.equal(
              await item.p.evaluate(() => window.alphaConsumer.probeCannotPublish()),
              true,
              'Recorder grant did not refuse publishing'
            )
            const recorder = await rooms.getParticipant(show, identity)
            assert.equal(recorder.permission?.canPublish, false)
            const alphaPub = publishers[0].publications.find(
              (p) => p.name === `videorc:experimental:packed-alpha:v1:${orientation}:1`
            )
            const sids = publishers.flatMap((p) =>
              p.publications
                .filter(
                  (pub) =>
                    !pub.name.startsWith('videorc:experimental:') || pub.sid === alphaPub?.sid
                )
                .map((pub) => pub.sid)
            )
            const cdp = await item.context.newCDPSession(item.p)
            await cdp.send('Performance.enable')
            const receiver = {
              ...item,
              lane,
              sid,
              cdp,
              alphaPub,
              orientation,
              outputKind,
              sids,
              firstSample: null
            }
            receivers.push(receiver)
            result.lanes.push(lane)
            for (const publisher of publishers)
              await publisher.p.evaluate(
                (permissions) => window.alphaPublisher.permit(permissions),
                receivers.map((r) => ({
                  participantSid: r.sid,
                  trackSids: publisher.publications
                    .filter((pub) => r.sids.includes(pub.sid))
                    .map((pub) => pub.sid)
                }))
              )
            await item.p.evaluate((input) => window.alphaConsumer.subscribe(input), {
              sids,
              alphaTrackSid: alphaPub?.sid ?? null
            })
            await wait(async () => {
              const sample = await item.p.evaluate(() => window.alphaConsumer.sample())
              return (
                sample.videos.length === (layer ? 8 : 7) &&
                sample.videos.every((v) => v.callbacks > 0)
              )
            }, 'all decoded video sources')
            return receiver
          }
          const authorize = async (r) => {
            if (!layer) return
            const authority = {
              experiment: 'local-packed-alpha-v1',
              show,
              hostIdentity: `host:${show}`,
              publisherSid: publishers[0].sid,
              trackSid: r.alphaPub.sid,
              epoch,
              generation: 1,
              output: r.outputKind,
              orientation: r.orientation,
              source: 'camera',
              canPublishSources: ['camera', 'microphone', 'screen_share', 'screen_share_audio']
            }
            const manifest = {
              ...authority,
              version: 1,
              role: 'videorc:experimental:packed-alpha:v1',
              packing: 'rgb-left-alpha-right',
              width: r.orientation === 'h' ? 640 : 360,
              height: r.orientation === 'h' ? 360 : 640,
              fps: 30,
              rect: { x: 0.1, y: 0.6, w: 0.8, h: 0.4 },
              expiresAt: Date.now() + 30000
            }
            assert.equal(
              await r.p.evaluate(
                ({ authority, manifest }) => window.alphaConsumer.authorize(authority, manifest),
                { authority, manifest }
              ),
              true
            )
          }
          await addReceiver('stream', 'h')
          await addReceiver('stream', 'v')
          for (const r of receivers) await authorize(r)
          const startedAt = Date.now()
          result.startedAt = startedAt
          let lastRenew = startedAt,
            lastImage = 0,
            processCpuSeconds = 0
          const processCpu = new Map()
          while (true) {
            if (Date.now() - startedAt > (seconds + 180) * 1000)
              throw new Error('Bounded acquisition deadline exceeded')
            if (aborted) throw new Error('Acquisition interrupted')
            if (receivers.length === 2 && Date.now() - startedAt >= 15000) {
              await addReceiver('recording', 'h')
              for (const r of receivers) await authorize(r)
              await addReceiver('recording', 'v')
              for (const r of receivers) await authorize(r)
            }
            if (Date.now() - lastRenew > 10000) {
              for (const r of receivers) await authorize(r)
              lastRenew = Date.now()
            }
            const processInfo = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo
            for (const p of processInfo) {
              processCpuSeconds += Math.max(0, p.cpuTime - (processCpu.get(p.id) ?? 0))
              processCpu.set(p.id, p.cpuTime)
            }
            const ids = processInfo
              .map((p) => p.id)
              .filter((id) => Number.isSafeInteger(id) && id > 0)
            const rss = execFileSync('ps', ['-o', 'rss=', '-p', ids.join(',')], {
              encoding: 'utf8',
              timeout: 5000
            })
              .trim()
              .split(/\s+/)
              .map(Number)
            const samples = []
            for (const r of receivers) {
              const metrics = Object.fromEntries(
                (await r.cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])
              )
              const sample = await r.p.evaluate(() => window.alphaConsumer.sample())
              r.firstSample ??= sample.at
              samples.push({
                lane: r.lane,
                ...sample,
                metrics: { taskSeconds: metrics.TaskDuration, jsHeapBytes: metrics.JSHeapUsedSize }
              })
            }
            await appendFile(
              rawFile,
              JSON.stringify({
                at: Date.now(),
                samples,
                cpuSeconds: processCpuSeconds,
                rssBytes: rss.reduce((sum, n) => sum + n * 1024, 0),
                proxy: { ...proxy.stats },
                proxyPort: proxy.port,
                publisher: await publishers[0].p.evaluate(() => window.alphaPublisher.sample())
              }) + '\n'
            )
            if (Date.now() - lastImage > 60000) {
              for (const r of receivers) {
                const file = join(caseDir, `${r.lane}-${Date.now()}.png`)
                await r.p.screenshot({ path: file })
                await artifact(file, 'composite-screenshot', r.lane, name)
              }
              lastImage = Date.now()
            }
            if (
              receivers.length === 4 &&
              samples.every(
                (s) => s.at - receivers.find((r) => r.lane === s.lane).firstSample >= seconds * 1000
              )
            )
              break
            await sleep(1000)
          }
          result.permissionsValidated = true
          result.durationMs = Date.now() - startedAt
          result.proxy = { ...proxy.stats }
          result.complete = true
        } finally {
          const closures = await Promise.allSettled([
            ...publishers.map((p) => p.p.evaluate(() => window.alphaPublisher.close())),
            ...receivers.map((r) => r.p.evaluate(() => window.alphaConsumer.close()))
          ])
          const contextClosures = await Promise.allSettled(contexts.map((c) => c.close()))
          try {
            for (const r of receivers) {
              const file = await r.p.video().path()
              await artifact(file, 'browser-video', r.lane, name)
            }
          } finally {
            await proxy.close()
            await rooms.deleteRoom(show)
          }
          if ([...closures, ...contextClosures].some((r) => r.status === 'rejected'))
            result.complete = false
          if (await stat(rawFile).catch(() => null))
            await artifact(rawFile, 'raw-counters', null, name)
          await save()
        }
      }
    manifest.status = 'acquired'
    await save()
    const analysis = await analyzeAlphaAcquisition(output)
    await writeFile(join(output, 'analysis.json'), JSON.stringify(analysis, null, 2) + '\n')
    assert.equal(
      analysis.localGate,
      'passed',
      'Alpha budget failed or evidence incomplete; production stays disabled'
    )
    return { output, report: analysis }
  } catch {
    manifest.status = 'failed'
    manifest.failure = 'Acquisition incomplete or budget failed; no transport approval'
    await save()
    throw new Error(`Alpha acquisition did not qualify; evidence: ${manifestPath}`)
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
    await browser?.close().catch(() => {})
    await browserServer?.close().catch(() => {})
    try {
      await stopChild(sfu)
    } finally {
      await server?.close()
      const { unlink } = await import('node:fs/promises')
      await unlink(join(output, 'sfu-local.yaml')).catch(() => {})
    }
  }
}
