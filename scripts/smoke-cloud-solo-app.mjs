import { spawn, spawnSync } from 'node:child_process'
import { createSocket as createUdpSocket } from 'node:dgram'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'

import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import {
  classifyFeedHandshake,
  dropTimings,
  evaluateCloudSoloReport,
  estimateReceiverClockOffset,
  evaluateHoldOnReceiver,
  HOLD_CARD_SETTLE_SECONDS,
  holdCardStats,
  parsePtsTimes,
  sortedGapStats,
  TEST_SHOW_CAP_SECONDS
} from './lib/cloud-solo-gates.mjs'
import {
  cloudAllowanceBlock,
  encodeNodeSecret,
  newNodeSecret,
  newShowSigningKey,
  startFakeCloudWeb
} from './lib/fake-cloud-web.mjs'
import { runFreezedetect } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Plan 184 C8: the first time the real desktop app, the node agent and the
// runner run together. Everything is local and nothing goes live anywhere:
//
//   dev app --RTMPS--> [feed proxy] --> MediaMTX --RTSP--> runner --RTMP--> 2 receivers
//      |                                   ^ auth hook        ^ supervised by
//      +--bearer--> fake web --node-signed--> node agent -----+
//      +--ws control socket (through the agent) --> runner
//
// The fake web (scripts/lib/fake-cloud-web.mjs) stands where videorc.com
// stands: it serves the capabilities with the `cloud` block, creates the show
// on the real agent with node-signed calls, mints the show token and takes
// the node's heartbeats and usage. The runner and agent binaries come from
// the private videorc-cloud checkout (VIDEORC_CLOUD_DIR, default: the
// sibling `videorc-cloud` of this repo).
//
// What the smoke proves, against the real pipeline:
//   1. Go Live through the cloud: the desktop's platform legs become one
//      RTMPS feed to the runner, the runner pushes to both receivers, and
//      the runner's per-platform leg states reach the desktop's leg model.
//   2. The feed cut: the feed proxy drops the desktop's RTMPS connection
//      and refuses new ones. The runner holds (Be right back) within D12's
//      budget, the receivers keep their connections with no packet gap over
//      2 s, the desktop's feed leg reconnects by itself when the proxy
//      forwards again, and the content comes back.
//   3. The computer dies: SIGKILL to the whole dev-app process group. The
//      runner holds for nobody; a relaunch with the same state finds the
//      show resumable (C5), Resume (`cloud.show.resume`, C5b) binds a new
//      session to that show, the node hands the ingest back (`ingest.get`),
//      the runner keeps its legs (no `destinations.set` after the click),
//      and the content comes back on the same receiver connections.
//   4. Stop ends the show on the web and the node, the runner exits and the
//      receivers' connections close; the local recording finalizes.
//   5. ffprobe and ffmpeg check every receiver file: streams, duration, the
//      largest packet gap, the hold card during each drop and motion after
//      each resume.
//   6. The feed checks the node's certificate (C1c). The node announces
//      itself as `localhost` (a DNS name, so the name is checked too), the
//      desktop trusts the run's self-signed cert through the dev-only
//      VIDEORC_CLOUD_FEED_CA_FILE, and three direct FFmpeg publishes prove
//      the check: the right roots pass the handshake, a wrong CA fails it,
//      and a certificate for another name fails it.
//   7. Test cloud (C6b), before Go Live: `cloud.selftest.run` pushes 10 s of
//      synthetic video to the same runner with no platforms, and must pass
//      on this machine's loopback: live within 20 s, the upload at least
//      85% of the stream quality's bitrate. The fake web sees a `kind:
//      "test"` create (a solo show capped at 30 s to the node) and its end,
//      the runner applies no destinations.set, `GET /api/cloud/shows/current`
//      stays empty while the test runs, the desktop's own show stays off,
//      the receivers get nothing, and the node's usage report for the test
//      is accepted and never metered. VIDEORC_CLOUD_SOLO_SHOTS_DIR=<dir> also
//      captures the Livestream page's Test row idle, running, with the
//      result and after a test the network blocked, each in dark and in
//      light (the by-eye check).
//   8. A test show nobody ends (the desktop died mid-test) ends on the
//      runner `max-show` 30 s after its first feed frame, and the web closes
//      it from the node's heartbeat.
//
// Why a proxy and not a killed process: the plan says "kill the stream
// encoder", but on macOS the stream legs are fifo outputs of the one FFmpeg
// process that also writes the local recording, so killing it ends the
// session rather than the feed. A MediaMTX kick is undone by the fifo's own
// 2 s retry before the runner's 1.5 s hold settles. Cutting the TCP path is
// the acceptance test's "pull the network", and it leaves the desktop's own
// reconnect to prove itself.

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 480_000)
const warmMs = Number(process.env.VIDEORC_CLOUD_SOLO_WARM_MS ?? 10_000)
const feedCutMs = Number(process.env.VIDEORC_CLOUD_SOLO_DROP_MS ?? 12_000)
const afterResumeMs = Number(process.env.VIDEORC_CLOUD_SOLO_AFTER_RESUME_MS ?? 8_000)
const deadMs = Number(process.env.VIDEORC_CLOUD_SOLO_DEAD_MS ?? 6_000)
const skipDeath = process.env.VIDEORC_CLOUD_SOLO_SKIP_DEATH === '1'
const listenerBindMs = Number(process.env.VIDEORC_SMOKE_LISTENER_BIND_MS ?? 1_500)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const mediamtxPath = process.env.VIDEORC_SMOKE_MEDIAMTX_PATH ?? 'mediamtx'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-cloud-solo-${Date.now()}`)
)
const stateRoot = join(outputDirectory, 'app-state')
const appDataDir = join(stateRoot, 'app-data')
const userDataDir = join(stateRoot, 'user-data')
const nodeRoot = join(outputDirectory, 'node')
const reportPath = join(outputDirectory, 'cloud-solo-report.json')
const sessionToken = `cloud-solo-session-${Math.random().toString(36).slice(2)}`
const nodeId = 'local-1'
// Platform keys with a marker the leak scan looks for in logs and events.
const receiverKeys = ['solo-a', 'solo-b'].map(
  (name) => `${name}-SECRET-${Math.random().toString(36).slice(2, 10)}`
)
const cloudDir = resolve(process.env.VIDEORC_CLOUD_DIR ?? join(repoRoot, '..', 'videorc-cloud'))
const shotsDir = process.env.VIDEORC_CLOUD_SOLO_SHOTS_DIR
  ? resolve(process.env.VIDEORC_CLOUD_SOLO_SHOTS_DIR)
  : null

mkdirSync(appDataDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(nodeRoot, { recursive: true })

const startedAtMs = Date.now()
const children = []
const report = {
  pass: false,
  startedAt: new Date(startedAtMs).toISOString(),
  outputDirectory,
  cloudDir,
  drops: [],
  receivers: [],
  desktop: { launches: [] },
  web: null,
  node: null,
  stop: null,
  platformRowsLive: null,
  tls: null,
  cloudTest: null,
  testCap: null,
  secretLeaks: []
}
let web = null
let proxy = null
let watcher = null
let launched = null
let backend = null
let collected = null
let sessionActive = false
let showId = null
/** Each show's ingest key as the run learns it: `{ label, value }`. */
const ingestSecrets = []
const appLines = []
/** Every renderer event of every launch: the leak scan reads them all. */
const eventTexts = []
const receivers = []

try {
  // 1. The runner checkout and its binaries.
  const binaries = resolveCloudBinaries()
  log(`runner checkout ${cloudDir} (agent ${binaries.agent})`)

  // 2. Ports: every listener is per run, so a running OBS or MediaMTX cannot collide.
  const ports = {
    rtmp: await freePort(),
    rtmps: await freePort(),
    rtsp: await freePort(),
    api: await freePort(),
    agent: await freePort(),
    proxy: await freePort(),
    // MediaMTX's SRT listener (C1b; UDP). The node takes SRT by default and
    // hands its address to the desktop; this desktop still feeds RTMPS.
    srt: await freeUdpPort(),
    receivers: [await freePort(), await freePort()]
  }
  const runnerPorts = await freePortRange(4)
  log(
    `ports: agent ${ports.agent}, rtmps ${ports.rtmps} behind proxy ${ports.proxy}, receivers ${ports.receivers.join(' and ')}`
  )

  // 3. Keys in the encodings the web and the node use, and the RTMPS cert.
  const nodeSecret = newNodeSecret()
  const signing = newShowSigningKey()
  const certDir = join(nodeRoot, 'certs')
  runChecked('bash', [join(cloudDir, 'dev', 'gen-certs.sh'), certDir], 'the RTMPS certificate')

  // 4. The fake web, then the node agent reporting to it.
  const agentUrl = `http://127.0.0.1:${ports.agent}`
  web = await startFakeCloudWeb({
    sessionToken,
    node: { id: nodeId, secret: nodeSecret, agentUrl },
    signingKey: signing.privateKey,
    allowance: cloudAllowanceBlock({ nowMs: Date.now() })
  })
  const agentStateDir = join(nodeRoot, 'agent')
  mkdirSync(agentStateDir, { recursive: true })
  const agent = startChild('node-agent', binaries.agent, [], {
    env: {
      ...process.env,
      VIDEORC_NODE_ID: nodeId,
      VIDEORC_NODE_SECRET: encodeNodeSecret(nodeSecret),
      VIDEORC_CLOUD_SHOW_PUBLIC_KEY: signing.publicKeyBase64Url,
      VIDEORC_NODE_LISTEN: `127.0.0.1:${ports.agent}`,
      // A DNS name, not an IP: FFmpeg binds the certificate's name only for
      // one (C1c), and the dev cert's SAN names localhost.
      VIDEORC_NODE_PUBLIC_HOST: 'localhost',
      VIDEORC_NODE_INGEST_SCHEME: 'rtmps',
      // The desktop publishes through the feed proxy; MediaMTX listens behind it.
      VIDEORC_NODE_RTMPS_PORT: String(ports.proxy),
      VIDEORC_NODE_RTMP_PORT: String(ports.rtmp),
      VIDEORC_NODE_SRT_PORT: String(ports.srt),
      VIDEORC_NODE_STATE_DIR: agentStateDir,
      VIDEORC_RUNNER_BIN: binaries.runner,
      VIDEORC_NODE_FFMPEG: ffmpegPath,
      VIDEORC_NODE_ENCODER: process.env.VIDEORC_CLOUD_SOLO_ENCODER ?? 'libx264',
      VIDEORC_MEDIAMTX_RTSP: `rtsp://127.0.0.1:${ports.rtsp}`,
      VIDEORC_MEDIAMTX_API: `http://127.0.0.1:${ports.api}`,
      VIDEORC_NODE_PORT_RANGE: `${runnerPorts[0]}-${runnerPorts.at(-1)}`,
      VIDEORC_WEB_BASE_URL: web.httpOrigin,
      VIDEORC_NODE_LOG: process.env.VIDEORC_NODE_LOG ?? 'info',
      VIDEORC_RUNNER_LOG: process.env.VIDEORC_RUNNER_LOG ?? 'info'
    }
  })
  // Listening is enough here: the fake web's node-signed create is the
  // first real call, and a refused signature shows up in its agent calls.
  await waitFor(
    async () => {
      if (agent.process.exitCode !== null) {
        throw new Error(
          `The node agent exited early (${agent.process.exitCode}); see ${agent.logPath}`
        )
      }
      return portOpen(ports.agent)
    },
    20_000,
    'the node agent to listen'
  )

  // 5. MediaMTX, authorised through the agent's hook.
  const mediamtxConfig = join(nodeRoot, 'mediamtx.yml')
  writeFileSync(
    mediamtxConfig,
    mediamtxConfigFromTemplate(readFileSync(join(cloudDir, 'dev', 'mediamtx.yml.tpl'), 'utf8'), {
      certDir,
      hook: `${agentUrl}/v1/mediamtx/auth`,
      ports
    })
  )
  const mediamtx = startChild('mediamtx', mediamtxPath, [mediamtxConfig])
  await waitFor(() => portOpen(ports.rtmps), 15_000, 'the MediaMTX RTMPS listener')
  await waitFor(() => portOpen(ports.rtsp), 15_000, 'the MediaMTX RTSP listener')

  // 6. Two fake platforms: one-shot RTMP servers recording what they get.
  for (const [index, port] of ports.receivers.entries()) {
    const name = `receiver-${index + 1}`
    const recvPath = join(outputDirectory, `${name}.flv`)
    // A reused VIDEORC_SMOKE_OUTPUT_DIR keeps an older run's file until the
    // receiver opens its output, which would read as bytes from the start.
    rmSync(recvPath, { force: true })
    const streamKey = receiverKeys[index]
    const target = {
      id: ['solo-a', 'solo-b'][index],
      label: ['Fake platform A', 'Fake platform B'][index],
      name,
      port,
      streamKey,
      serverUrl: `rtmp://127.0.0.1:${port}/live`,
      recvPath,
      firstBytesAtMs: null,
      exitedAtMs: null
    }
    target.child = startChild(
      name,
      ffmpegPath,
      [
        '-y',
        '-nostdin',
        '-hide_banner',
        // Evidence when a receiver never sees the publisher's EOF: the
        // connection lines live at info; the per-second stats stay out.
        '-nostats',
        '-loglevel',
        'level+info',
        '-listen',
        '1',
        '-i',
        `${target.serverUrl}/${streamKey}`,
        '-c',
        'copy',
        '-f',
        'flv',
        recvPath
      ],
      { logName: `${name}.log` }
    )
    target.child.process.once('exit', () => {
      target.exitedAtMs = Date.now()
    })
    receivers.push(target)
  }
  await sleep(listenerBindMs)
  for (const receiver of receivers) {
    if (receiver.child.process.exitCode !== null) {
      throw new Error(
        `${receiver.name} exited before the show started; see ${receiver.child.logPath}`
      )
    }
  }
  const growthTimer = setInterval(() => {
    for (const receiver of receivers) {
      if (receiver.firstBytesAtMs !== null) continue
      if (fileSize(receiver.recvPath) > 1024) receiver.firstBytesAtMs = Date.now()
    }
  }, 50)

  // 7. The feed proxy between the desktop and MediaMTX's RTMPS port.
  proxy = await startFeedProxy({ listenPort: ports.proxy, targetPort: ports.rtmps })

  // 7b. The feed's certificate check (C1c), with FFmpeg itself and the same
  //     fifo output shape the app uses: against MediaMTX behind the proxy
  //     with the right roots (the handshake passes; MediaMTX then refuses
  //     the probe's path, which is not what is measured), with a CA that
  //     did not sign the cert, and against a cert for another name.
  const serverCert = join(certDir, 'server.crt')
  report.tls = await feedCertificateChecks({
    certDir,
    rightCa: serverCert,
    url: `rtmps://localhost:${ports.proxy}/live/sh_probe-h?key=not-a-key`
  })
  log(
    `[tls] right roots: ${report.tls.rightRoots.outcome}; wrong CA: ${report.tls.wrongCa.outcome}; other name: ${report.tls.otherName.outcome}`
  )

  // 8. The signed-in desktop, pointed at the fake web.
  const secretsPath = join(appDataDir, 'videorc-secrets.json')
  writeFileSync(secretsPath, JSON.stringify({ 'account:videorc:session': sessionToken }, null, 2))
  chmodSync(secretsPath, 0o600)
  const appEnv = {
    VIDEORC_API_BASE_URL: web.httpOrigin,
    // Dev builds trust this one extra CA for the cloud feed (C1c): the
    // run's self-signed MediaMTX cert, so the check stays on.
    VIDEORC_CLOUD_FEED_CA_FILE: serverCert,
    VIDEORC_DISABLE_AUTO_PREVIEW: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_STATE_DIR: outputDirectory,
    VIDEORC_APP_DATA_DIR: appDataDir,
    VIDEORC_USER_DATA_DIR: userDataDir,
    // The screenshots drive the renderer over CDP (the theme flip and the
    // compositor capture, as scripts/ui-theme-screens.mjs does).
    ...(shotsDir ? { VIDEORC_REMOTE_DEBUG_PORT: '0' } : {})
  }
  let launch = await launchApp(appEnv, 1)
  launched = launch.launched
  backend = launch.backend
  collected = launch.collected
  const smoke = launch.smoke

  const entitledStatus = await waitForCloudStatus(
    backend,
    (status) => status.entitled === true && status.settings?.enabled === true,
    30_000,
    'the cloud entitlement from the fake capabilities'
  )
  log(`desktop entitled (plan ${entitledStatus.plan ?? 'none'}, phase ${entitledStatus.phase})`)
  // The by-eye captures reload the renderer once (onboarding), so before
  // anything else is set up through it.
  const shots = shotsDir ? await prepareCloudSectionShots(smoke) : null
  const health = await request(backend, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the cloud solo smoke.')
  }
  let authorization = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs }
  )

  // 8b. Test cloud (C6b): 10 s of synthetic video at the stream quality to
  //     the runner, with no platforms, before anything goes live. The test
  //     runs the app's own FFmpeg, as the Test button does (this smoke leaves
  //     smoke RPCs off, so no caller may name another), with the same
  //     certificate check as the feed. The by-eye captures take the row idle,
  //     while the push runs and with the result.
  if (shots) await shots.capture('idle')
  const testRequestedAtMs = Date.now()
  const testStarted = await request(backend, timeoutMs, 'cloud.selftest.run', {
    outputs: [{ orientation: 'horizontal', width: 1280, height: 720, fps: 30, videoKbps: 4000 }]
  })
  if (testStarted.test?.phase !== 'creating' || testStarted.show) {
    throw new Error(`cloud.selftest.run did not start a test: ${JSON.stringify(testStarted.test)}`)
  }
  let currentDuringTest = undefined
  let runningShots = null
  const testDone = await waitForCloudStatus(
    backend,
    (status) => {
      if (status.test?.phase === 'pushing') {
        // While the push runs the web's current must stay empty: a crashed
        // test must never become a Resume notice.
        if (currentDuringTest === undefined) {
          currentDuringTest = 'pending'
          void fetch(`${web.httpOrigin}/api/cloud/shows/current`, {
            headers: { authorization: `Bearer ${sessionToken}` }
          })
            .then((response) => response.json())
            .then((body) => {
              currentDuringTest = body?.show ?? null
            })
            .catch((error) => {
              currentDuringTest = { error: String(error?.message ?? error) }
            })
        }
        // The row while the push runs, captured beside the polling.
        if (shots && !runningShots) runningShots = shots.capture('running')
      }
      return status.test?.phase === 'done'
    },
    90_000,
    'the cloud test to finish'
  )
  const testTotalMs = Date.now() - testRequestedAtMs
  const testResult = testDone.test?.result ?? null
  const testShow = web.showsOfKind('test').at(-1) ?? null
  if (!testShow) throw new Error('The fake web never saw a test show.')
  ingestSecrets.push({ label: "the test show's ingest key", value: web.ingestKeyFor(testShow.id) })
  if (runningShots) await runningShots
  if (shots) await shots.capture('result')
  await waitFor(() => currentDuringTest !== 'pending' || null, 10_000, 'the current probe').catch(
    () => {}
  )
  const testAsked = web.state.agentCalls.find(
    (call) => call.path === '/v1/shows' && call.showId === testShow.id
  )
  // The node reports the test's seconds once the show ends; the web accepts
  // the report and counts nothing.
  const usageIgnored = await waitFor(
    () =>
      web.state.testUsageIgnored.filter((report) => report.showId === testShow.id).length || null,
    30_000,
    "the node's usage report for the test show"
  ).catch(() => 0)
  report.cloudTest = {
    requestedAt: new Date(testRequestedAtMs).toISOString(),
    showId: testShow.id,
    totalMs: testTotalMs,
    ok: testResult?.ok ?? false,
    reason: testResult?.reason ?? null,
    message: testResult?.message ?? null,
    timeToLiveMs: testResult?.timeToLiveMs ?? null,
    uploads: testResult?.uploads ?? [],
    webCreateStatus:
      web.state.calls.find(
        (call) =>
          call.method === 'POST' &&
          call.path === '/api/cloud/shows' &&
          Date.parse(call.at) >= testRequestedAtMs - 1000
      )?.status ?? null,
    webEndStatus:
      web.state.calls.find(
        (call) => call.method === 'POST' && call.path === `/api/cloud/shows/${testShow.id}/end`
      )?.status ?? null,
    agentCreateStatus: testAsked?.status ?? null,
    agentKind: testAsked?.kind ?? null,
    agentMaxShowSeconds: testAsked?.maxShowSeconds ?? null,
    agentEndStatus:
      web.state.agentCalls.find((call) => call.path === `/v1/shows/${testShow.id}/end`)?.status ??
      null,
    currentDuringTest:
      currentDuringTest === 'pending' ? { error: 'not probed' } : currentDuringTest,
    destinationsSet: destinationsSetIntentTimes(agent.logPath).filter(
      (atMs) => atMs >= testRequestedAtMs - 1000
    ).length,
    receiversUntouched: receivers.every(
      (receiver) => receiver.firstBytesAtMs === null && fileSize(receiver.recvPath) <= 1024
    ),
    usageIgnored: usageIgnored || 0,
    usageMetered: web.state.usageReports.filter((entry) => entry.showId === testShow.id).length,
    showEndedOnWeb: web.showsOfKind('test').at(-1)?.endedAt !== null,
    desktopShowStayedOff: !collected.cloudStates.some(
      (entry) => entry.atMs >= testRequestedAtMs && entry.status?.show
    )
  }
  if (shots) report.cloudTest.shots = shots.files
  log(
    `[test] ${report.cloudTest.ok ? 'PASS' : `FAIL (${report.cloudTest.reason})`}: live in ${report.cloudTest.timeToLiveMs ?? '?'} ms, upload ${report.cloudTest.uploads[0]?.measuredKbps ?? '?'} of ${report.cloudTest.uploads[0]?.targetKbps ?? '?'} kbps (plus 160 kbps audio), whole test ${testTotalMs} ms; the node was asked for a ${report.cloudTest.agentKind} show capped at ${report.cloudTest.agentMaxShowSeconds} s; current during the test: ${JSON.stringify(report.cloudTest.currentDuringTest)}; usage ignored ${report.cloudTest.usageIgnored}, metered ${report.cloudTest.usageMetered}; destinations.set ${report.cloudTest.destinationsSet}`
  )

  // 8c. The node's cap on a test show (C6b): a test whose desktop died
  //     mid-test is never ended by anyone. The smoke creates one as the
  //     desktop would, feeds it with its own FFmpeg and walks away; the
  //     runner must end it `max-show` at the web's 30 s cap after its first
  //     feed frame, and the web must close it from the node's heartbeat.
  report.testCap = await testShowCapCheck({ caFile: serverCert })
  log(
    `[cap] the unended test show ended ${report.testCap.endReason ?? 'never'} ${report.testCap.liveToEndSeconds ?? '?'} s after it went live; the web closed it: ${report.testCap.webClosed} (${report.testCap.webEndReason ?? 'open'})`
  )

  // 8d. By eye only: a failed test reads as the row's error. The feed proxy
  //     refuses the push (a network that blocks streaming), so the runner
  //     never sees the feed; the proxy forwards again before Go Live.
  if (shots) {
    proxy.cut()
    try {
      await request(backend, timeoutMs, 'cloud.selftest.run', {
        outputs: [{ orientation: 'horizontal', width: 1280, height: 720, fps: 30, videoKbps: 4000 }]
      })
      const failedTest = await waitForCloudStatus(
        backend,
        (status) => status.test?.phase === 'done',
        60_000,
        'the failing test to finish'
      )
      log(`[shots] the blocked test ended ${failedTest.test?.result?.reason ?? 'with no reason'}`)
      await shots.capture('failed')
    } finally {
      proxy.forward()
    }
  }

  // 9. Go Live: record plus two destinations; the cloud switch is on by default.
  const goLiveAtMs = Date.now()
  const started = await request(
    backend,
    timeoutMs,
    'session.start',
    sessionParams(authorization.capabilityId)
  )
  if (started.state !== 'recording') {
    throw new Error(`Expected recording state after Go Live, got ${JSON.stringify(started)}`)
  }
  sessionActive = true
  const firstSessionId = started.sessionId
  log(`session ${firstSessionId} started; stream legs: ${started.streamUrl ?? 'n/a'}`)
  // The node announces itself as localhost (C1c); older runs said 127.0.0.1.
  if (!/videorc-cloud|rtmps:\/\/(localhost|127\.0\.0\.1):/.test(String(started.streamUrl ?? ''))) {
    throw new Error(`The session did not stream through the cloud feed: ${started.streamUrl}`)
  }
  // Go Live's own create: the test shows came before it (one clock).
  const createCall = web.state.calls.find(
    (call) =>
      call.method === 'POST' &&
      call.path === '/api/cloud/shows' &&
      Date.parse(call.at) >= goLiveAtMs
  )
  if (createCall?.status !== 201) {
    throw new Error(
      `The fake web did not see a show create (calls: ${JSON.stringify(web.state.calls)})`
    )
  }
  const show = web.currentShow()
  showId = show.id
  ingestSecrets.push({ label: 'the ingest key', value: web.ingestKeyFor(showId) })
  const liveStatus = await waitForCloudStatus(
    backend,
    (status) => status.phase === 'live' && status.show?.id === showId,
    40_000,
    'the cloud show to go live'
  )
  const cloudLiveAtMs = Date.now()
  log(
    `cloud show ${showId} live ${((cloudLiveAtMs - goLiveAtMs) / 1000).toFixed(1)} s after Go Live (node ${liveStatus.show.nodeId})`
  )

  // The smoke's own view of the runner: a second control client through the
  // agent, like a phone would be. It survives the desktop's death below.
  const controlUrl = web.controlUrlFor(showId)
  watcher = startShowWatcher({ url: controlUrl, token: web.tokenFor(showId) })
  await waitFor(() => watcher.states.length > 0, 20_000, 'the watcher welcome')

  await waitFor(
    () => platformRowsLive(latestTargets(collected), receivers),
    30_000,
    "the runner's platform legs to reach the desktop as live"
  )
  report.platformRowsLive = true
  await waitFor(
    () => receivers.every((receiver) => receiver.firstBytesAtMs !== null),
    20_000,
    'both receivers to take bytes'
  )
  const runnerPid = await waitFor(
    () => readRunnerPid(agentStateDir, showId),
    10_000,
    'the runner pid in the registry'
  )
  report.node = { agentStateDir, runnerPid, controlUrl }
  log(`both receivers taking bytes; streaming ${warmMs} ms before the feed cut`)
  await sleep(warmMs)
  assertReceiversConnected(receivers, 'before the feed cut')

  // 10. Drop 1: the feed cut.
  const cutAtMs = Date.now()
  proxy.cut()
  log('[drop 1] feed cut: the proxy dropped the RTMPS connection and refuses new ones')
  await waitFor(
    () => firstPhase(watcher.states, cutAtMs, 'hold') !== null,
    15_000,
    'the runner to hold'
  )
  const holdSeen = firstPhase(watcher.states, cutAtMs, 'hold')
  log(`[drop 1] runner holds ${((holdSeen - cutAtMs) / 1000).toFixed(2)} s after the cut`)
  await waitFor(() => latestCloudPhase(collected) === 'hold', 15_000, 'the desktop to show Hold')
  await sleep(Math.max(0, feedCutMs - (Date.now() - cutAtMs)))
  assertReceiversConnected(receivers, 'during the feed cut')
  const restoreAtMs = Date.now()
  proxy.forward()
  log('[drop 1] network back: the proxy forwards again')
  await waitFor(
    () => firstPhase(watcher.states, restoreAtMs, 'live') !== null,
    45_000,
    'the runner to go live again'
  )
  await waitFor(
    () => latestCloudPhase(collected) === 'live',
    20_000,
    'the desktop to show Live again'
  )
  const feedLegState = latestTargets(collected)?.find(
    (entry) => entry.targetId === 'videorc-cloud-horizontal'
  )
  const drop1 = {
    kind: 'feed-cut',
    cutMs: cutAtMs,
    ...dropTimings(watcher.states, { cutMs: cutAtMs, restoreMs: restoreAtMs }),
    // The fifo retries every 2 s, the runner needs a steady second: a slow
    // network return still fits in a few seconds.
    maxResumeSeconds: 20,
    desktopSawHold: collected.cloudStates.some(
      (entry) => entry.atMs >= cutAtMs && entry.phase === 'hold'
    ),
    desktopSawLive: collected.cloudStates.some(
      (entry) => entry.atMs >= restoreAtMs && entry.phase === 'live'
    ),
    desktopTimeToHoldSeconds: secondsBetween(
      cutAtMs,
      firstCloudPhaseAt(collected, cutAtMs, 'hold')
    ),
    desktopTimeToLiveSeconds: secondsBetween(
      restoreAtMs,
      firstCloudPhaseAt(collected, restoreAtMs, 'live')
    ),
    feedLegReconnecting: collected.health.some(
      (event) => event.atMs >= cutAtMs && event.code === 'stream-target-reconnecting'
    ),
    feedLegResumed: collected.health.some(
      (event) => event.atMs >= restoreAtMs && event.code === 'stream-target-resumed'
    ),
    feedLegStateAfter: feedLegState?.state ?? null,
    proxy: { ...proxy.stats }
  }
  report.drops.push(drop1)
  log(
    `[drop 1] hold ${drop1.timeToHoldSeconds} s, back live ${drop1.timeToResumeSeconds} s after the network came back (desktop: hold ${drop1.desktopTimeToHoldSeconds} s, live ${drop1.desktopTimeToLiveSeconds} s)`
  )
  await sleep(afterResumeMs)
  assertReceiversConnected(receivers, 'after the feed cut resume')

  // 11. Drop 2: the computer dies. SIGKILL to the dev app's whole process
  //     group (the one the launcher created), so nothing says goodbye.
  if (!skipDeath) {
    const killAtMs = Date.now()
    await killAppHard(launched)
    launched = null
    backend = null
    sessionActive = false
    log('[drop 2] the computer died: the app, its backend and its FFmpeg children are gone')
    await waitFor(
      () => firstPhase(watcher.states, killAtMs, 'hold') !== null,
      15_000,
      'the runner to hold for nobody'
    )
    const holdAt2 = firstPhase(watcher.states, killAtMs, 'hold')
    log(`[drop 2] runner holds ${((holdAt2 - killAtMs) / 1000).toFixed(2)} s after the death`)
    await sleep(deadMs)
    assertReceiversConnected(receivers, 'while the computer was dead')

    const relaunchAtMs = Date.now()
    launch = await launchApp(appEnv, 2)
    launched = launch.launched
    backend = launch.backend
    collected = launch.collected
    const resumable = await waitForCloudStatus(
      backend,
      (status) => status.show?.id === showId && status.show.resumable === true,
      45_000,
      'the relaunched desktop to find the show resumable'
    )
    const resumableAtMs = Date.now()
    log(
      `[drop 2] relaunched desktop sees the show as resumable ${((resumableAtMs - relaunchAtMs) / 1000).toFixed(1)} s after launch (phase ${resumable.phase}, hold ${resumable.hold?.remainingSeconds ?? '?'} s left)`
    )
    authorization = await requestSmokeCommand(
      launch.smoke,
      'authorize-smoke-resource',
      { kind: 'output-directory', path: outputDirectory },
      { timeoutMs }
    )
    const resumeRequestedAtMs = Date.now()
    const resumed = await request(
      backend,
      timeoutMs,
      'cloud.show.resume',
      sessionParams(authorization.capabilityId)
    )
    if (resumed.state !== 'recording') {
      throw new Error(`Resume did not start a session: ${JSON.stringify(resumed)}`)
    }
    sessionActive = true
    log(`[drop 2] Resume started session ${resumed.sessionId}; feed: ${resumed.streamUrl ?? 'n/a'}`)
    await waitFor(
      () => firstPhase(watcher.states, resumeRequestedAtMs, 'live') !== null,
      45_000,
      'the runner to go live after the resume'
    )
    const afterResume = await waitForCloudStatus(
      backend,
      (status) =>
        status.phase === 'live' && status.show?.id === showId && status.show.resumable === false,
      20_000,
      'the desktop to show Live on the resumed show'
    )
    // Since Go Live: the test shows came before it and are not this show's.
    const createCalls = web.state.calls.filter(
      (call) =>
        call.method === 'POST' &&
        call.path === '/api/cloud/shows' &&
        Date.parse(call.at) >= goLiveAtMs
    )
    const drop2 = {
      kind: 'computer-died',
      cutMs: killAtMs,
      ...dropTimings(watcher.states, { cutMs: killAtMs, restoreMs: resumeRequestedAtMs }),
      relaunchToResumableSeconds: secondsBetween(relaunchAtMs, resumableAtMs),
      deadSeconds: secondsBetween(killAtMs, resumeRequestedAtMs),
      maxResumeSeconds: 30,
      // The relaunched desktop learns the hold at launch, before this
      // harness is connected: the polled status is what the banner shows.
      desktopSawHold:
        resumable.phase === 'hold' ||
        collected.cloudStates.some(
          (entry) => entry.atMs < resumeRequestedAtMs && entry.phase === 'hold'
        ),
      desktopSawLive: collected.cloudStates.some(
        (entry) => entry.atMs >= resumeRequestedAtMs && entry.phase === 'live'
      ),
      resumedSessionId: resumed.sessionId,
      sameShow: afterResume.show.id === showId,
      showsCreated: createCalls.length,
      // The node hands the ingest back only to the show's owner; the agent
      // logs the intent name (never the key) when it answers.
      ingestGetAnswered: agentLogAnsweredIngestGet(agent.logPath),
      // C5b: Resume keeps the runner's legs. The runner logs every intent it
      // applies (the agent forwards its lines): destinations.set ran once,
      // at Go Live, and never after the Resume click.
      destinationsSetAfterResume: destinationsSetIntentTimes(agent.logPath).filter(
        (atMs) => atMs >= resumeRequestedAtMs
      ).length,
      legsKept: receivers.every((receiver) => receiver.child.process.exitCode === null)
    }
    report.drops.push(drop2)
    log(
      `[drop 2] hold ${drop2.timeToHoldSeconds} s after the death, back live ${drop2.timeToResumeSeconds} s after Resume; shows created on the web: ${drop2.showsCreated}; destinations.set after the Resume: ${drop2.destinationsSetAfterResume}`
    )
    await sleep(afterResumeMs)
    assertReceiversConnected(receivers, 'after the resume')
  }

  // 12. Stop: the show ends on the web and the node, the runner exits and
  //     the receivers' connections close.
  const stopRequestedAtMs = Date.now()
  const stopped = await request(backend, timeoutMs, 'session.stop', {})
  const stopMs = Date.now() - stopRequestedAtMs
  sessionActive = false
  log(`Stop returned in ${stopMs} ms (${stopped.state})`)
  const webEndCalled = await waitFor(
    () =>
      web.state.calls.some(
        (call) =>
          call.method === 'POST' &&
          call.path === `/api/cloud/shows/${showId}/end` &&
          call.status === 200
      ) || null,
    10_000,
    'the web end call'
  ).catch(() => false)
  const showEndedOnNode = await waitFor(
    () => registryShowEnded(agentStateDir, showId) || null,
    20_000,
    'the node registry to list the show as ended'
  ).catch(() => false)
  const runnerExited = await waitFor(
    () => !pidAlive(runnerPid) || null,
    20_000,
    'the runner to exit'
  ).catch(() => false)
  const receiversExited = await waitFor(
    () => receivers.every((receiver) => receiver.child.process.exitCode !== null) || null,
    30_000,
    "the receivers' connections to close"
  ).catch(() => false)
  clearInterval(growthTimer)
  const finalRecording = await waitForFinalRecording(
    stopped.outputPath ?? resumeOutputPath(collected)
  )
  const recordingProbe =
    fileSize(finalRecording) > 0 ? await probeMedia(finalRecording).catch(() => null) : null
  report.stop = {
    requestedAt: new Date(stopRequestedAtMs).toISOString(),
    stopMs,
    webEndCalled: webEndCalled === true,
    showEndedOnNode: showEndedOnNode === true,
    runnerExited: runnerExited === true,
    receiversExited: receiversExited === true,
    recordingPath: finalRecording,
    recording: recordingProbe,
    recordingFinalized:
      recordingProbe?.video?.codec === 'h264' && recordingProbe.durationSeconds >= 3,
    // The session the death cut short leaves its MKV as it was: evidence,
    // not a gate.
    deadSessionRecording: firstSessionRecording(outputDirectory, firstSessionId),
    watcherSawEnded:
      watcher.states.some((state) => state.phase === 'ended') || watcher.closedAtMs !== null,
    endReasonSeen: watcher.states.find((state) => state.phase === 'ended')?.endReason ?? null
  }
  log(
    `after Stop: web end ${report.stop.webEndCalled}, node ended ${report.stop.showEndedOnNode}, runner exited ${report.stop.runnerExited}, receivers closed ${report.stop.receiversExited}, recording ${report.stop.recordingPath ?? 'none'}`
  )

  // 13. The artifacts.
  const endMs = Date.now()
  for (const receiver of receivers) {
    const probe = await probeMedia(receiver.recvPath)
    const gaps = sortedGapStats(
      parsePtsTimes(
        await runCommand(ffprobePath, [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'packet=pts_time',
          '-of',
          'csv=p=0',
          receiver.recvPath
        ])
      )
    )
    const freezes = await runFreezedetect(receiver.recvPath, {
      ffmpegPath,
      noiseDb: -60,
      minFreezeMs: 1000
    })
    // The file's clock is the runner's output clock, a second or two ahead
    // of the wall clock at which the file first grew; the first hold's card
    // edge anchors it.
    const anchor = estimateReceiverClockOffset({
      freezes,
      fileStartMs: receiver.firstBytesAtMs,
      holdMs: report.drops[0]?.holdMs ?? null
    })
    const fileZeroMs = receiver.firstBytesAtMs - (anchor?.offsetSeconds ?? 0) * 1000
    const holds = []
    for (const [index, drop] of report.drops.entries()) {
      const nextCutMs = report.drops[index + 1]?.cutMs ?? endMs
      const verdict = evaluateHoldOnReceiver({
        freezes,
        fileStartMs: fileZeroMs,
        holdMs: drop.holdMs,
        liveMs: drop.liveMs,
        endMs,
        untilMs: nextCutMs
      })
      let card = null
      if (drop.holdMs !== null && drop.liveMs !== null) {
        const windowStart = (drop.holdMs - fileZeroMs) / 1000 + HOLD_CARD_SETTLE_SECONDS
        const windowEnd = (drop.liveMs - fileZeroMs) / 1000
        const sampleAt = windowStart + Math.max(0.5, (windowEnd - windowStart) / 2)
        card = {
          sampleAtSeconds: Math.round(sampleAt * 1000) / 1000,
          ...(await sampleFrameStats(receiver.recvPath, sampleAt))
        }
      }
      holds.push({ kind: drop.kind, ...verdict, card })
    }
    const expectedSeconds = (stopRequestedAtMs - receiver.firstBytesAtMs) / 1000
    report.receivers.push({
      name: receiver.name,
      file: receiver.recvPath,
      bytes: fileSize(receiver.recvPath),
      firstBytesAt: receiver.firstBytesAtMs
        ? new Date(receiver.firstBytesAtMs).toISOString()
        : null,
      exitedAt: receiver.exitedAtMs ? new Date(receiver.exitedAtMs).toISOString() : null,
      stayedConnected: receiver.exitedAtMs === null || receiver.exitedAtMs >= stopRequestedAtMs,
      exitedAfterStop: receiver.exitedAtMs !== null,
      ...probe,
      minDurationSeconds: Math.round(expectedSeconds * 0.8 * 10) / 10,
      gaps,
      clockAnchor: anchor,
      freezes: freezes.map((freeze) => ({
        start: round3(freeze.start),
        duration: round3(freeze.duration)
      })),
      holds
    })
  }
  report.desktop.health = collected.health.map((event) => ({
    at: new Date(event.atMs).toISOString(),
    code: event.code,
    message: event.message
  }))
  report.desktop.cloudPhases = collected.cloudStates.map((entry) => ({
    at: new Date(entry.atMs).toISOString(),
    phase: entry.phase
  }))
  report.web = summarizeWeb(web.state)
  report.watcher = {
    states: watcher.states.length,
    phases: watcher.states
      .map((state) => ({
        at: new Date(state.atMs).toISOString(),
        phase: state.phase,
        feedUp: state.feedUp,
        legs: state.legs
      }))
      .filter((entry, index, all) => index === 0 || entry.phase !== all[index - 1].phase),
    closeCode: watcher.closeCode
  }
  report.secretLeaks = findSecretLeaks(secretsToScan(), [
    ...appLines,
    ...eventTexts,
    JSON.stringify(web.state.calls),
    JSON.stringify(web.state.agentCalls)
  ])
  const failures = evaluateCloudSoloReport(report)
  report.failures = failures
  report.pass = failures.length === 0
  report.finishedAt = new Date().toISOString()
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  if (failures.length > 0) {
    throw new Error(
      `Cloud solo smoke failed:\n  - ${failures.join('\n  - ')}\nReport: ${reportPath}`
    )
  }
  const drop2 = report.drops[1]
  const upload = report.cloudTest?.uploads?.[0]
  console.log(
    `Cloud solo smoke PASS: the cloud test went live in ${report.cloudTest?.timeToLiveMs ?? '?'} ms with the upload at ${upload?.measuredKbps ?? '?'} of ${upload?.targetKbps ?? '?'} kbps (plus 160 kbps audio); ` +
      `an unended test show ended ${report.testCap?.endReason ?? '?'} ${report.testCap?.liveToEndSeconds ?? '?'} s after it went live; ` +
      `feed cut held in ${report.drops[0].timeToHoldSeconds} s and came back ${report.drops[0].timeToResumeSeconds} s after the network; ` +
      (drop2
        ? `the dead computer's show held in ${drop2.timeToHoldSeconds} s and resumed ${drop2.timeToResumeSeconds} s after Resume; `
        : 'the computer-dies drop was skipped; ') +
      `largest receiver gap ${Math.max(...report.receivers.map((receiver) => receiver.gaps.maxGapSeconds))} s. Report: ${reportPath}`
  )
} catch (error) {
  report.pass = false
  report.error = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null
  }
  report.web = web ? summarizeWeb(web.state) : null
  report.watcher = watcher
    ? {
        states: watcher.states.length,
        last: watcher.states.at(-1) ?? null,
        closeCode: watcher.closeCode
      }
    : null
  report.desktop.cloudPhases =
    collected?.cloudStates.map((entry) => ({
      at: new Date(entry.atMs).toISOString(),
      phase: entry.phase
    })) ?? []
  report.desktop.health = collected?.health ?? []
  report.secretLeaks = findSecretLeaks(secretsToScan(), [...appLines, ...eventTexts])
  report.artifacts = artifactInventory(outputDirectory)
  report.finishedAt = new Date().toISOString()
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  throw new Error(
    `${error instanceof Error ? error.message : String(error)} Full failure evidence: ${reportPath}`,
    { cause: error }
  )
} finally {
  await cleanup()
}

// --- The desktop ----------------------------------------------------------------

async function launchApp(env, attempt) {
  const logPath = join(outputDirectory, `app-${attempt}.log`)
  const logFd = openSync(logPath, 'a')
  const launchedApp = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env,
    onLine: (line) => {
      appLines.push(line)
      try {
        writeFileSync(logFd, `${line}\n`)
      } catch {
        // The log is evidence, never a gate.
      }
    }
  })
  const ws = await connectBackend(launchedApp.connections['backend-ready'], timeoutMs)
  const events = collectEvents(ws)
  report.desktop.launches.push({ attempt, at: new Date().toISOString(), log: logPath })
  log(`dev app launch ${attempt} ready`)
  return {
    launched: launchedApp,
    backend: ws,
    collected: events,
    smoke: launchedApp.connections['preview-motion-ready']
  }
}

function collectEvents(ws) {
  const result = { cloudStates: [], targets: [], health: [], recording: [], raw: [] }
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (!message?.event) return
    const atMs = Date.now()
    result.raw.push(String(event.data))
    eventTexts.push(String(event.data))
    if (message.event === 'cloud.state') {
      result.cloudStates.push({ atMs, phase: message.payload?.phase, status: message.payload })
    } else if (message.event === 'stream.targets' && Array.isArray(message.payload?.targets)) {
      result.targets.push({ atMs, targets: message.payload.targets })
    } else if (message.event === 'health.event') {
      result.health.push({
        atMs,
        code: message.payload?.code,
        message: message.payload?.message,
        sessionId: message.payload?.sessionId
      })
    } else if (message.event === 'recording.status') {
      result.recording.push({ atMs, ...message.payload })
    }
  })
  return result
}

async function waitForCloudStatus(ws, predicate, budgetMs, label) {
  let latest = null
  await waitFor(
    async () => {
      latest = await request(ws, 10_000, 'cloud.status', {})
      return predicate(latest)
    },
    budgetMs,
    label,
    250,
    () => `Last cloud.status: ${JSON.stringify(latest)}`
  )
  return latest
}

function latestCloudPhase(events) {
  return events.cloudStates.at(-1)?.phase ?? null
}

function firstCloudPhaseAt(events, afterMs, phase) {
  return (
    events.cloudStates.find((entry) => entry.atMs >= afterMs && entry.phase === phase)?.atMs ?? null
  )
}

function latestTargets(events) {
  return events.targets.at(-1)?.targets ?? null
}

function platformRowsLive(targets, platformTargets) {
  if (!targets) return false
  return platformTargets.every((platform) =>
    targets.some((entry) => entry.targetId === platform.id && entry.state === 'live')
  )
}

function resumeOutputPath(events) {
  return events?.recording.findLast((status) => status.outputPath)?.outputPath ?? null
}

function sessionParams(outputDirectoryCapability) {
  const timestamp = '2026-10-17T00:00:00.000Z'
  // One 720p30 encode for the recording and the feed: the stream profile
  // matches the recording, so no second encoder is needed in a debug build.
  const video = { preset: 'tutorial-720p30', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 }
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
      outputDirectoryCapability,
      video,
      // Legacy single-RTMP fields, ignored while `streaming` is present.
      rtmp: {
        preset: 'custom',
        serverUrl: receivers[0].serverUrl,
        streamKey: receivers[0].streamKey
      }
    },
    streaming: {
      enabled: true,
      mode: 'multi',
      targets: receivers.map((receiver) => ({
        id: receiver.id,
        platform: 'custom',
        label: receiver.label,
        enabled: true,
        serverUrl: receiver.serverUrl,
        urlMode: 'server-and-key',
        streamKey: receiver.streamKey,
        streamKeyPresent: true,
        authMode: 'manual-rtmp',
        createdAt: timestamp,
        updatedAt: timestamp
      })),
      defaultOutputPreset: 'tutorial-720p30',
      defaultBitrateKbps: 4000,
      enabledTargetIds: receivers.map((receiver) => receiver.id)
    }
  }
}

/** SIGKILL to the dev app's process group: the one the launcher created. */
async function killAppHard(app) {
  const pid = app?.process?.pid
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  await waitFor(() => !processGroupExists(pid) || null, 10_000, 'the dead app to be gone').catch(
    () => {}
  )
  await app.stop().catch(() => {})
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// --- The watcher: the smoke's own control client ------------------------------

function startShowWatcher({ url, token }) {
  const watch = { states: [], acks: [], closedAtMs: null, closeCode: null, ws: null, timer: null }
  const ws = new WebSocket(url)
  watch.ws = ws
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'hello', token, client: { app: 'smoke-watcher', version: '1' } }))
    watch.timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }))
    }, 5_000)
  })
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.t === 'welcome' || message.t === 'state') {
      const state = message.state ?? {}
      watch.states.push({
        atMs: Date.now(),
        phase: state.phase,
        endReason: state.endReason ?? null,
        feedUp: Array.isArray(state.feeds) && state.feeds.some((feed) => feed.connected),
        legs: Array.isArray(state.legs)
          ? state.legs.map((leg) => `${leg.id}:${leg.state}`).join(',')
          : '',
        holdRemaining: state.hold?.remainingSeconds ?? null
      })
    } else if (message.t === 'ack') {
      watch.acks.push({ id: message.id, ok: message.ok })
    }
  })
  ws.addEventListener('close', (event) => {
    watch.closedAtMs = Date.now()
    watch.closeCode = event.code
    if (watch.timer) clearInterval(watch.timer)
  })
  ws.addEventListener('error', () => {})
  watch.close = () => {
    if (watch.timer) clearInterval(watch.timer)
    try {
      ws.close()
    } catch {
      // Already closed.
    }
  }
  return watch
}

function firstPhase(states, afterMs, phase) {
  return states.find((state) => state.atMs >= afterMs && state.phase === phase)?.atMs ?? null
}

// --- The test show's cap (C6b) -----------------------------------------------------

/**
 * A test show nobody ends: created through the fake web the way the desktop
 * creates one, fed by the smoke's own FFmpeg with the feed's certificate
 * check, then left alone, as when the desktop dies mid-test. The runner must
 * end it `max-show` at the web's cap after its first feed frame (no
 * `show.end` ever comes), and the web must close it from the node's next
 * heartbeat. A second control client watches the runner's phases; the
 * publisher is this run's own child, stopped through its own handle.
 */
async function testShowCapCheck({ caFile }) {
  const response = await fetch(`${web.httpOrigin}/api/cloud/shows`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'test',
      outputs: [
        {
          orientation: 'horizontal',
          width: 640,
          height: 360,
          fps: 30,
          videoKbps: 800,
          audioKbps: 64
        }
      ],
      holdMaxSeconds: 1800,
      client: { app: 'smoke', version: '1' }
    })
  })
  const created = await response.json()
  if (response.status !== 201) {
    throw new Error(
      `The fake web refused the capped test show: ${response.status} ${JSON.stringify(created?.error ?? null)}`
    )
  }
  const id = created.show.id
  ingestSecrets.push({ label: "the capped test show's ingest key", value: web.ingestKeyFor(id) })
  const asked = web.state.agentCalls.find((call) => call.path === '/v1/shows' && call.showId === id)
  const capWatcher = startShowWatcher({ url: created.control.url, token: created.control.token })
  const ingest = created.ingest[0]
  const publisher = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-loglevel',
      'error',
      '-re',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30',
      '-re',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      // Longer than the cap: only the runner may end this show.
      '-t',
      String(TEST_SHOW_CAP_SECONDS + 30),
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      '800k',
      '-g',
      '60',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-tls_verify',
      '1',
      '-ca_file',
      caFile,
      '-f',
      'flv',
      `${ingest.serverUrl}/${ingest.streamKey}`
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  )
  try {
    const liveAtMs = await waitFor(
      () => firstPhase(capWatcher.states, 0, 'live'),
      30_000,
      'the capped test show to go live'
    ).catch(() => null)
    const endedAtMs = await waitFor(
      () =>
        capWatcher.states.find((state) => state.phase === 'ending' || state.phase === 'ended')
          ?.atMs ?? null,
      (TEST_SHOW_CAP_SECONDS + 20) * 1000,
      'the runner to end the capped test show'
    ).catch(() => null)
    const webClosed = await waitFor(
      () => web.showsOfKind('test').find((entry) => entry.id === id)?.endedAt != null || null,
      25_000,
      'the web to close the capped test show'
    ).catch(() => false)
    return {
      showId: id,
      agentKind: asked?.kind ?? null,
      agentMaxShowSeconds: asked?.maxShowSeconds ?? null,
      liveAt: liveAtMs ? new Date(liveAtMs).toISOString() : null,
      endedAt: endedAtMs ? new Date(endedAtMs).toISOString() : null,
      liveToEndSeconds: secondsBetween(liveAtMs, endedAtMs),
      endReason: capWatcher.states.find((state) => state.endReason)?.endReason ?? null,
      webClosed: webClosed === true,
      webEndReason: web.showsOfKind('test').find((entry) => entry.id === id)?.endReason ?? null,
      publisherStillPushing: publisher.exitCode === null
    }
  } finally {
    capWatcher.close()
    if (publisher.exitCode === null) {
      publisher.kill('SIGTERM')
      await waitForExit(publisher, 3_000)
      if (publisher.exitCode === null) publisher.kill('SIGKILL')
    }
  }
}

// --- The node side ---------------------------------------------------------------

function resolveCloudBinaries() {
  if (
    !existsSync(join(cloudDir, 'Cargo.toml')) ||
    !existsSync(join(cloudDir, 'crates', 'runner'))
  ) {
    throw new Error(
      `The videorc-cloud checkout was not found at ${cloudDir}. Clone TheOrcDev/videorc-cloud next to this repo or set VIDEORC_CLOUD_DIR; the smoke never skips.`
    )
  }
  const release = join(cloudDir, 'target', 'release')
  const binaries = {
    runner: join(release, 'videorc-runner'),
    agent: join(release, 'videorc-node-agent')
  }
  const newestSource = newestMtime(join(cloudDir, 'crates'))
  const stale = [binaries.runner, binaries.agent].some(
    (path) => !existsSync(path) || statSync(path).mtimeMs < newestSource
  )
  if (stale || process.env.VIDEORC_CLOUD_BUILD === '1') {
    log('building the runner and node agent (cargo build --release in the videorc-cloud checkout)')
    const result = spawnSync('cargo', ['build', '--release'], {
      cwd: cloudDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 20 * 60 * 1000
    })
    if (result.status !== 0) {
      throw new Error(
        `cargo build --release failed in ${cloudDir}:\n${String(result.stderr).split('\n').slice(-20).join('\n')}`
      )
    }
  }
  for (const path of Object.values(binaries)) {
    if (!existsSync(path)) throw new Error(`Missing runner binary ${path}.`)
  }
  return binaries
}

function newestMtime(directory) {
  let newest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'target') continue
      newest = Math.max(newest, newestMtime(path))
    } else if (
      entry.name.endsWith('.rs') ||
      // The runner embeds its default hold card's PNGs (include_bytes!).
      entry.name.endsWith('.png') ||
      entry.name === 'Cargo.toml'
    ) {
      newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  return newest
}

/**
 * The harness template (dev/mediamtx.yml.tpl) with this run's cert dir, hook
 * and ports. Every address is loopback; a missing key is a template drift.
 */
function mediamtxConfigFromTemplate(template, { certDir, hook, ports }) {
  const replacements = [
    [/^authHTTPAddress: .*$/m, `authHTTPAddress: ${hook}`],
    [/^apiAddress: .*$/m, `apiAddress: 127.0.0.1:${ports.api}`],
    [/^rtspAddress: .*$/m, `rtspAddress: 127.0.0.1:${ports.rtsp}`],
    [/^rtmpAddress: .*$/m, `rtmpAddress: 127.0.0.1:${ports.rtmp}`],
    [/^rtmpsAddress: .*$/m, `rtmpsAddress: 127.0.0.1:${ports.rtmps}`],
    // The template's SRT listener is :8890 on every interface (C1b).
    [/^srtAddress: .*$/m, `srtAddress: 127.0.0.1:${ports.srt}`]
  ]
  let config = template.replaceAll('@CERT_DIR@', certDir).replaceAll('@HOOK@', hook)
  for (const [pattern, line] of replacements) {
    if (!pattern.test(config)) {
      throw new Error(
        `dev/mediamtx.yml.tpl has no line matching ${pattern}; the smoke's config writer needs an update.`
      )
    }
    config = config.replace(pattern, line)
  }
  return config
}

/** The agent logs `intent="ingest.get"` with "intent ok (with result)" when the runner hands the ingest back. */
function agentLogAnsweredIngestGet(logPath) {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .some(
        (line) => line.includes('intent="ingest.get"') && line.includes('intent ok (with result)')
      )
  } catch {
    return false
  }
}

/**
 * When the runner applied a `destinations.set` (its `intent ok` line, forwarded
 * by the agent), as wall-clock ms from the agent's own timestamp at the start
 * of the line. The runner's timestamp inside the line is ignored.
 */
function destinationsSetIntentTimes(logPath) {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('intent="destinations.set"') && line.includes('intent ok'))
      .map((line) => {
        const stamp = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z/)
        if (!stamp) return Number.NaN
        return Date.parse(`${stamp[1]}.${(stamp[2] ?? '0').slice(0, 3).padEnd(3, '0')}Z`)
      })
      .filter((atMs) => Number.isFinite(atMs))
  } catch {
    return []
  }
}

/** The MKV the killed session left behind, if any. */
function firstSessionRecording(directory, sessionId) {
  if (!sessionId) return null
  try {
    const name = readdirSync(directory).find(
      (entry) => entry.includes(sessionId) && /\.(mkv|mp4)$/i.test(entry)
    )
    return name ? { path: join(directory, name), bytes: fileSize(join(directory, name)) } : null
  } catch {
    return null
  }
}

function readRegistry(agentStateDir) {
  try {
    return JSON.parse(readFileSync(join(agentStateDir, 'agent-shows.json'), 'utf8'))
  } catch {
    return null
  }
}

function readRunnerPid(agentStateDir, id) {
  const record = readRegistry(agentStateDir)?.shows?.find((show) => show.request?.showId === id)
  const pid = Number(record?.runnerPid)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function registryShowEnded(agentStateDir, id) {
  const registry = readRegistry(agentStateDir)
  if (!registry) return false
  const record = registry.shows?.find((show) => show.request?.showId === id)
  // Once the web has heard the end the agent drops the record entirely.
  return !record || record.ended === true
}

// --- The feed proxy ----------------------------------------------------------------

function startFeedProxy({ listenPort, targetPort }) {
  const state = { mode: 'forward' }
  const pairs = new Set()
  const stats = { connections: 0, refused: 0, cuts: 0 }
  const server = createNetServer((client) => {
    if (state.mode === 'cut') {
      stats.refused += 1
      client.destroy()
      return
    }
    stats.connections += 1
    const upstream = netConnect({ host: '127.0.0.1', port: targetPort })
    const pair = { client, upstream }
    pairs.add(pair)
    const drop = () => {
      pairs.delete(pair)
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', drop)
    upstream.on('close', drop)
    client.pipe(upstream)
    upstream.pipe(client)
  })
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(listenPort, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen({
        stats,
        cut() {
          state.mode = 'cut'
          stats.cuts += 1
          for (const pair of [...pairs]) {
            pairs.delete(pair)
            pair.client.destroy()
            pair.upstream.destroy()
          }
        },
        forward() {
          state.mode = 'forward'
        },
        close() {
          for (const pair of [...pairs]) {
            pair.client.destroy()
            pair.upstream.destroy()
          }
          return new Promise((resolveClose) => server.close(() => resolveClose()))
        }
      })
    })
  })
}

// --- Artifacts -----------------------------------------------------------------------

async function probeMedia(filePath) {
  const payload = await runCommand(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,channels,sample_rate',
    '-of',
    'json',
    filePath
  ])
  const parsed = JSON.parse(payload)
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
  return {
    video: {
      codec: video?.codec_name ?? null,
      width: Number(video?.width ?? 0),
      height: Number(video?.height ?? 0),
      averageFrameRate: video?.avg_frame_rate ?? null
    },
    audio: {
      codec: audio?.codec_name ?? null,
      channels: Number(audio?.channels ?? 0),
      sampleRate: Number(audio?.sample_rate ?? 0)
    },
    durationSeconds: Number(parsed.format?.duration ?? 0)
  }
}

/** One decoded frame at `seconds`, scaled to 320x180 rgb24, as hold-card stats. */
async function sampleFrameStats(filePath, seconds) {
  const width = 320
  const height = 180
  const rgb = await runCommandBinary(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    seconds.toFixed(3),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:${height}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-'
  ])
  return holdCardStats(rgb, width, height)
}

// Since instant stop the published artifact is the MP4 a background job
// exports after the terminal status; the MKV is final only if no export
// replaces it before the deadline.
async function waitForFinalRecording(reportedPath) {
  if (!reportedPath) return null
  const mp4 = reportedPath.replace(/\.mkv$/i, '.mp4')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (fileSize(mp4) > 0) return mp4
    await sleep(500)
  }
  return fileSize(reportedPath) > 0 ? reportedPath : mp4
}

/**
 * Every secret the run has seen so far, labelled: the platform keys, each
 * show's ingest key (the tests' too), every show's SRT passphrase (C1b: the
 * desktop gets it in the create answer and in `ingest.get`'s ack even while
 * it feeds RTMPS) and every token the web minted.
 */
function secretsToScan() {
  return [
    ...receiverKeys.map((value, index) => ({ label: `platform key ${index + 1}`, value })),
    ...ingestSecrets,
    ...(web ? [...web.state.shows.values()] : []).map((show) => ({
      label: 'an SRT passphrase',
      value: show.srtPassphrase
    })),
    ...(web?.state.mintedTokens ?? []).map((value) => ({ label: 'a show token', value }))
  ]
}

function findSecretLeaks(secrets, texts) {
  const leaks = []
  for (const { label, value } of secrets) {
    if (!value || value.length < 8) continue
    if (texts.some((text) => typeof text === 'string' && text.includes(value))) {
      if (!leaks.includes(label)) leaks.push(label)
    }
  }
  return leaks
}

function summarizeWeb(state) {
  return {
    calls: state.calls,
    heartbeats: state.heartbeats,
    usageReports: state.usageReports,
    testUsageIgnored: state.testUsageIgnored,
    usageRejected: state.usageRejected,
    signatureFailures: state.signatureFailures,
    capabilityRequests: state.capabilityRequests,
    unknownRoutes: state.unknownRoutes,
    endShowsSent: state.endShowsSent,
    droppedSrt: state.droppedSrt,
    agentCalls: state.agentCalls,
    shows: [...state.shows.values()].map((show) => ({
      id: show.id,
      kind: show.kind,
      status: show.status,
      endReason: show.endReason,
      createdAt: show.createdAt.toISOString(),
      endedAt: show.endedAt?.toISOString() ?? null
    }))
  }
}

// --- The by-eye check (C6b) ------------------------------------------------------

/**
 * The Livestream page's Videorc Cloud section with the Test row, through CDP
 * like scripts/ui-theme-screens.mjs, the capture the compositor's own. A
 * fresh profile opens onboarding, so it is marked done and the renderer
 * reloads once, here, before the test. Each `capture(stage)` takes the row
 * in dark and in light: the sidebar's theme toggle flips it live (no
 * reload, so the running state stays on screen), and the app goes back to
 * dark after each.
 */
async function prepareCloudSectionShots(smoke) {
  mkdirSync(shotsDir, { recursive: true })
  const devtools = await waitFor(
    () =>
      appLines
        .map((line) => /DevTools listening on (ws:\/\/\S+)/.exec(line)?.[1])
        .findLast(Boolean),
    10_000,
    'the DevTools url in the app log (VIDEORC_REMOTE_DEBUG_PORT)'
  )
  const { host } = new URL(devtools.replace('ws://', 'http://'))
  await cdpEvaluate(
    host,
    `localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1'); location.reload(); 'ok'`
  )
  await waitFor(
    async () =>
      (await cdpEvaluate(
        host,
        `document.readyState === 'complete' && Boolean(document.querySelector('[aria-label="Toggle color theme"]'))`
      ).catch(() => false)) || null,
    30_000,
    'the renderer back after the onboarding reload'
  )
  await requestSmokeCommand(
    smoke,
    'open-tab',
    { tab: 'streaming', waitFor: '[data-testid="cloud-test"]' },
    { timeoutMs: 30_000 }
  )
  const files = {}
  const theme = () =>
    cdpEvaluate(host, `document.documentElement.classList.contains('dark') ? 'dark' : 'light'`)
  const setTheme = async (wanted) => {
    if ((await theme()) === wanted) return
    await cdpEvaluate(
      host,
      `document.querySelector('[aria-label="Toggle color theme"]').click(); 'ok'`
    )
    await waitFor(async () => (await theme()) === wanted || null, 5_000, `the ${wanted} theme`)
    await sleep(250)
  }
  return {
    files,
    async capture(stage) {
      for (const wanted of ['dark', 'light']) {
        await setTheme(wanted)
        await cdpEvaluate(
          host,
          `document.querySelector('[data-testid="cloud-test"]').scrollIntoView({ block: 'center' }); 'ok'`
        )
        await sleep(200)
        const shot = await cdpCall(host, 'Page.captureScreenshot', { format: 'png' })
        const file = join(shotsDir, `cloud-test-${stage}-${wanted}.png`)
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
        files[`${stage}-${wanted}`] = file
        const line = await cdpEvaluate(
          host,
          `document.querySelector('[data-testid="cloud-test"]').innerText`
        )
        log(`[shots] ${stage} ${wanted}: ${file} (${JSON.stringify(line)})`)
      }
      await setTheme('dark')
    }
  }
}

async function cdpCall(host, method, params) {
  const targets = await (await fetch(`http://${host}/json/list`)).json()
  const mainTarget = targets.find(
    (target) => target.type === 'page' && /^https?:\/\/localhost/.test(target.url ?? '')
  )
  if (!mainTarget) throw new Error('Main window CDP target not found.')
  return new Promise((resolveCall, rejectCall) => {
    const ws = new WebSocket(mainTarget.webSocketDebuggerUrl)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      ws.close()
      if (message.error) rejectCall(new Error(message.error.message))
      else resolveCall(message.result)
    })
    ws.addEventListener('error', () => rejectCall(new Error('CDP connect failed')))
  })
}

async function cdpEvaluate(host, expression) {
  const result = await cdpCall(host, 'Runtime.evaluate', { expression, returnByValue: true })
  return result?.result?.value
}

function artifactInventory(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        path: join(directory, entry.name),
        bytes: statSync(join(directory, entry.name)).size
      }))
  } catch {
    return []
  }
}

// --- Processes and cleanup --------------------------------------------------------------

function startChild(name, command, args, { env, logName } = {}) {
  const logPath = join(nodeRoot, logName ?? `${name}.log`)
  const fd = openSync(logPath, 'a')
  const child = spawn(command, args, { env: env ?? process.env, stdio: ['ignore', fd, fd] })
  const entry = { name, process: child, logPath, pid: child.pid }
  child.once('error', (error) => {
    log(`${name} could not start: ${error.message}`)
  })
  children.push(entry)
  return entry
}

async function stopChild(entry) {
  const child = entry.process
  if (!child?.pid || child.exitCode !== null) return
  child.kill('SIGTERM')
  await waitForExit(child, 4_000)
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await waitForExit(child, 2_000)
  }
}

function waitForExit(child, ms) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveWait()
    })
  })
}

async function cleanup() {
  try {
    if (backend && sessionActive) {
      await request(backend, 15_000, 'session.stop', {}).catch(() => null)
    }
    backend?.close()
  } catch {
    // Nothing to stop.
  }
  try {
    watcher?.close()
  } catch {
    // Already closed.
  }
  if (web) {
    // A show still open on the node is ended through the node's own API, so
    // its runner exits cleanly; only then is a leftover runner pid signalled.
    const ended = await web.endOpenShows().catch(() => [])
    if (ended.length > 0) log(`cleanup ended ${ended.length} open show(s) on the node`)
    const agentStateDir = join(nodeRoot, 'agent')
    const runnerPids = (readRegistry(agentStateDir)?.shows ?? [])
      .map((show) => Number(show.runnerPid))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    await waitFor(
      () => runnerPids.every((pid) => !pidAlive(pid)) || null,
      8_000,
      'runners to exit'
    ).catch(() => {})
    for (const pid of runnerPids.filter(pidAlive)) {
      // A recorded runner pid from this run's own registry, never a scan.
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }
  if (launched) await launched.stop().catch(() => {})
  for (const entry of [...children].reverse()) {
    await stopChild(entry)
  }
  if (proxy) await proxy.close().catch(() => {})
  if (web) await web.close().catch(() => {})
}

// --- Small helpers -------------------------------------------------------------------------

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

/** A free loopback UDP port (MediaMTX's SRT listener). */
function freeUdpPort() {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createUdpSocket('udp4')
    socket.once('error', rejectPort)
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(() => resolvePort(port))
    })
  })
}

// --- The feed's certificate check (C1c) ----------------------------------------------

/**
 * Three direct FFmpeg publishes with the app's fifo output shape and the
 * app's TLS options (`tls_verify=1:ca_file=…` as the fifo's format_opts):
 * - `rightRoots`: the run's cert as the roots, against MediaMTX behind the
 *   proxy. The TLS handshake passes; MediaMTX then refuses the probe's path
 *   (the agent adds only live shows' feed paths), which is not what is
 *   measured.
 * - `wrongCa`: a CA that did not sign MediaMTX's cert: the handshake fails.
 * - `otherName`: a tiny TLS server with a cert for `other.test`, trusted as
 *   its own CA, reached as `localhost`: the chain is fine and the name is
 *   not, so the handshake fails. That is the host-name check.
 * Each is one `recovery` attempt of about a second.
 */
async function feedCertificateChecks({ certDir, rightCa, url }) {
  const wrongCa = join(certDir, 'wrong-ca.crt')
  runChecked(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '2',
      '-keyout',
      join(certDir, 'wrong-ca.key'),
      '-out',
      wrongCa,
      '-subj',
      '/CN=not the node/O=Videorc cloud solo smoke'
    ],
    'a CA that did not sign the node'
  )
  const otherCert = join(certDir, 'other-name.crt')
  const otherKey = join(certDir, 'other-name.key')
  runChecked(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '2',
      '-keyout',
      otherKey,
      '-out',
      otherCert,
      '-subj',
      '/CN=other.test/O=Videorc cloud solo smoke',
      '-addext',
      'subjectAltName=DNS:other.test'
    ],
    'a certificate for another name'
  )
  const otherPort = await freePort()
  const other = await startTlsEcho({ cert: otherCert, key: otherKey, port: otherPort })
  try {
    return {
      rightRoots: await ffmpegFeedHandshake(url, rightCa),
      wrongCa: await ffmpegFeedHandshake(url, wrongCa),
      otherName: await ffmpegFeedHandshake(
        `rtmps://localhost:${otherPort}/live/sh_probe-h?key=not-a-key`,
        otherCert
      )
    }
  } finally {
    await other.close()
  }
}

/** A TLS server that completes handshakes and speaks nothing. */
function startTlsEcho({ cert, key, port }) {
  const server = createTlsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (socket) => {
    socket.on('error', () => {})
    socket.on('data', () => socket.end())
  })
  server.on('tlsClientError', () => {})
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen({
        close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
      })
    })
  })
}

/**
 * One FFmpeg publish of a second of silence to `url` through the fifo muxer
 * with the app's TLS options, one recovery attempt, at debug level so the
 * RTMP lines prove the TLS handshake passed (classifyFeedHandshake):
 * `handshake-passed`, `certificate-rejected` (chain or name) or `unknown`,
 * with the first error line.
 */
async function ffmpegFeedHandshake(url, caFile) {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'level+debug',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-t',
    '1',
    '-map',
    '0:a',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-f',
    'fifo',
    '-fifo_format',
    'flv',
    '-queue_size',
    '64',
    '-drop_pkts_on_overflow',
    '1',
    '-attempt_recovery',
    '1',
    '-recover_any_error',
    '1',
    '-max_recovery_attempts',
    '1',
    '-recovery_wait_time',
    '1',
    '-format_opts',
    `tls_verify=1:ca_file=${caFile}`,
    url
  ]
  const lines = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const stderr = []
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectRun)
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolveRun(Buffer.concat(stderr).toString('utf8').split('\n'))
    })
  })
  const firstError = lines.find((line) => line.includes('[error]'))
  return {
    url: url.replace(/\/[^/]*$/, '/••••'),
    caFile,
    outcome: classifyFeedHandshake(lines),
    firstError: firstError?.trim() ?? null
  }
}

/** `count` consecutive free loopback ports for the agent's runner range. */
async function freePortRange(count) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = 30_000 + Math.floor(Math.random() * 25_000)
    const ports = Array.from({ length: count }, (_, index) => base + index)
    const checks = await Promise.all(ports.map((port) => portFree(port)))
    if (checks.every(Boolean)) return ports
  }
  throw new Error('Could not find a free port range for the runner control sockets.')
}

function portFree(port) {
  return new Promise((resolveFree) => {
    const server = createNetServer()
    server.once('error', () => resolveFree(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolveFree(true)))
  })
}

function portOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    const done = (open) => {
      socket.destroy()
      resolveOpen(open)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1_000, () => done(false))
  })
}

function runChecked(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(
      `Could not prepare ${label}: ${command} exited ${result.status}: ${result.stderr}`
    )
  }
}

function runCommand(command, args) {
  return runCommandBinary(command, args).then((buffer) => buffer.toString('utf8'))
}

function runCommandBinary(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectRun)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun(Buffer.concat(stdout))
        return
      }
      rejectRun(
        new Error(
          `${command} failed: code=${code} signal=${signal} ${Buffer.concat(stderr).toString('utf8').trim()}`
        )
      )
    })
  })
}

function assertReceiversConnected(targets, when) {
  for (const receiver of targets) {
    if (receiver.child.process.exitCode !== null) {
      throw new Error(
        `${receiver.name} lost its connection ${when} (ffmpeg exited ${receiver.child.process.exitCode}); see ${receiver.child.logPath}`
      )
    }
  }
}

function fileSize(path) {
  try {
    return path && existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

function secondsBetween(fromMs, toMs) {
  if (fromMs === null || toMs === null || fromMs === undefined || toMs === undefined) return null
  return round3((toMs - fromMs) / 1000)
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

async function waitFor(predicate, budgetMs, label, intervalMs = 100, describe = null) {
  const deadline = Date.now() + budgetMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await sleep(intervalMs)
  }
  last = await predicate()
  if (last) return last
  const detail = describe ? ` ${describe()}` : ''
  throw new Error(
    `Timed out after ${budgetMs} ms waiting for ${typeof label === 'string' ? label : 'a condition'}.${detail}`
  )
}

function log(message) {
  console.log(`[cloud-solo +${((Date.now() - startedAtMs) / 1000).toFixed(1)}s] ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
