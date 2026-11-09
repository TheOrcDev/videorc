import { spawn, spawnSync } from 'node:child_process'
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
import { homedir, tmpdir } from 'node:os'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { join, resolve } from 'node:path'

import { launchDevApp, prebuildDevBackend, repoRoot, smokeAppEnv } from './lib/app-launcher.mjs'
import { parsePtsTimes } from './lib/cloud-solo-gates.mjs'
import {
  evaluateCloudTalkShowReport,
  evaluateTilePlan,
  evaluateTones,
  latestStageTiles,
  lumaOfHex,
  packetGapStats,
  pcm16ToFloats,
  tonesDbBelowLoudest
} from './lib/cloud-talk-show-gates.mjs'
import {
  cloudAllowanceBlock,
  encodeNodeSecret,
  newNodeSecret,
  newShowSigningKey,
  startFakeCloudWeb
} from './lib/fake-cloud-web.mjs'
import { evaluateTapAfterLegsEnd, startRtmpTap } from './lib/rtmp-tap.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Plan 224 S-G1: a talk show end to end on this Mac, nothing live anywhere.
//
//   dev app (the host, fake camera + mic) --livekit-client--> livekit-server --dev
//   2 headless Chrome guests (a colour and a tone each) --------^      |
//   fake web (rooms, invites, the door, let-in, LiveKit tokens) --node-signed--> node agent
//   the runner (the real one, videorc-cloud) joins the room, composes the stage,
//   pushes to 2 local RTMP receivers behind taps, records to a fake S3
//
// What the smoke proves, numbered as the report lists them:
//   1. Open the room: the fake web creates a talk show, the runner joins the
//      room, the renderer joins as the host with Chromium's fake devices.
//   2. Two guests ask from the invite link; the desktop sees both requests;
//      Let in both; both publish; the runner lists three people.
//   3. Go Live hands two destinations to the runner; both legs live; both
//      receivers take bytes; Record starts the cloud recording.
//   4. Each layout composes to the receiver: Solo (the host alone), Bring on
//      one (side by side, two tiles), Bring on both (three), Spotlight, Send
//      one backstage (two again), each proven by pixel probes at the tile
//      centres of the runner's own tile plan; the host's tile and tone stay
//      in the program after Bring on.
//   5. Each on-stage tone is in the mix and a backstage tone is not (run
//      inside 4, per layout).
//   6. A guest never hears the program: the guest page subscribes to nobody
//      but the host and the stage, and a guest who asks for the runner's
//      return is refused by the server.
//   7. End livestream (`legs.end`): both legs end cleanly (FCUnpublish and
//      deleteStream on the taps, closed by the publisher within 3.5 s), the
//      room stays with its people, and Go Live again puts fresh legs up.
//   8. The cloud recording stops, lands as a multipart upload in the fake
//      S3, passes ffprobe (h264 + aac, duration near the reported seconds,
//      continuous pts) and reaches the fake web as the node's report.
//   9. Remove a guest: their page reads removed, the runner drops them.
//  10. New link: the old slug is invalid.
//  11. Kill the host (SIGKILL): the runner reports the host away, the
//      receivers keep their connections; relaunch and Resume brings the
//      host back into the room.
//  12. Close the room: the show ends on the web, the runner exits.
//  13. A leak scan over the renderer events, the app logs, the node logs
//      and the fake web's records for LiveKit tokens, show tokens, ingest
//      keys and the recording credentials.
//
// Needs: the private `videorc-cloud` checkout (VIDEORC_CLOUD_DIR, default
// the sibling of this repo), `livekit-server`, `ffmpeg`, `ffprobe`,
// `mediamtx`, `python3` (the runner harness's fake S3) and Google Chrome or
// Playwright's headless shell (VIDEORC_SMOKE_CHROME to name one). Never run
// two at once: LiveKit's RTC ports are fixed per run.

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 480_000)
const phaseMs = Number(process.env.VIDEORC_CLOUD_TALK_PHASE_MS ?? 7_000)
const skipDeath = process.env.VIDEORC_CLOUD_TALK_SKIP_DEATH === '1'
const listenerBindMs = Number(process.env.VIDEORC_SMOKE_LISTENER_BIND_MS ?? 1_500)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const mediamtxPath = process.env.VIDEORC_SMOKE_MEDIAMTX_PATH ?? 'mediamtx'
const livekitPath = process.env.VIDEORC_SMOKE_LIVEKIT_PATH ?? 'livekit-server'
const pythonPath = process.env.VIDEORC_SMOKE_PYTHON_PATH ?? 'python3'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-cloud-talk-show-${Date.now()}`)
)
const stateRoot = join(outputDirectory, 'app-state')
const appDataDir = join(stateRoot, 'app-data')
const userDataDir = join(stateRoot, 'user-data')
const nodeRoot = join(outputDirectory, 'node')
const mediaDir = join(outputDirectory, 'media')
const reportPath = join(outputDirectory, 'cloud-talk-show-report.json')
const sessionToken = `cloud-talk-session-${Math.random().toString(36).slice(2)}`
const nodeId = 'local-1'
const userId = 'user_cloud_smoke'
const cloudDir = resolve(process.env.VIDEORC_CLOUD_DIR ?? join(repoRoot, '..', 'videorc-cloud'))
const livekitKeys = { apiKey: 'devkey', apiSecret: `smoke-${Math.random().toString(36).slice(2)}` }

// The people: a flat colour and a tone each (bursts: Chromium's noise
// suppression on the host's mic would swallow a steady tone). The guests'
// tones sit far from the host's and off its harmonics: the host's mic runs
// Chromium's echo canceller with the backstage guests the host hears as its
// reference, and with a file for a mic (no acoustic echo to cancel) it leaks
// a little of that reference near the host's own tone into the host's track.
// A guest at 523 Hz read -19 to -27 dB in Solo (run 3, 2026-11-09) though the
// runner never subscribes to a backstage guest (`room.rs` wanted_sources);
// one at 659 Hz never rose above -43 dB.
const PEOPLE = {
  host: { name: 'Host', color: '40C0FF', tone: 440 },
  ada: { name: 'Ada', color: 'C02020', tone: 1100 },
  bo: { name: 'Bo', color: 'F0F060', tone: 1500 }
}
const CONTROL_TONE = 2200
const PROBE_WIDTH = 320
const PROBE_HEIGHT = 180
const PROBE_FRAME_BYTES = (PROBE_WIDTH * PROBE_HEIGHT * 3) / 2
const OUTPUT = { orientation: 'horizontal', width: 1280, height: 720, fps: 30, videoKbps: 4000 }

mkdirSync(outputDirectory, { recursive: true })
mkdirSync(appDataDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(nodeRoot, { recursive: true })
mkdirSync(mediaDir, { recursive: true })

const startedAtMs = Date.now()
const children = []
const appLines = []
const eventTexts = []
const receivers = []
const taps = []
const browsers = []
const report = {
  startedAt: new Date(startedAtMs).toISOString(),
  outputDirectory,
  scenarios: [],
  desktop: { launches: [] },
  room: {},
  guests: {},
  goLive: {},
  layouts: [],
  hostOnAfterBringOn: {},
  return: {},
  legsEnd: {},
  recording: {},
  moderation: {},
  invite: {},
  hostAway: {},
  resume: {},
  close: {},
  receivers: [],
  measured: {},
  leaks: [],
  problems: []
}
let web = null
let launched = null
let backend = null
let collected = null
let watcher = null
let showId = null
let agent = null
let fakeS3 = null
let s3Dir = null
let s3Credentials = null
let livekit = null
let runnerLogPath = null
let exitCode = 1

process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(130))
})

try {
  // 1. The runner checkout, its binaries, the harness's fake S3, Chrome.
  const binaries = resolveCloudBinaries()
  const fakeS3Script = join(cloudDir, 'spikes', 's0a-rooms', 'fake-s3.py')
  if (!existsSync(fakeS3Script)) {
    throw new Error(`The runner harness's fake S3 was not found at ${fakeS3Script}.`)
  }
  const chrome = resolveChrome()
  const livekitClientEsm = resolveLivekitClientEsm()
  log(`runner checkout ${cloudDir}; Chrome ${chrome}`)
  await prebuildBackendOrThrow(process.env)

  // 2. Ports: every listener per run, but LiveKit's RTC ports are fixed.
  const ports = {
    rtmp: await freePort(),
    rtmps: await freePort(),
    rtsp: await freePort(),
    api: await freePort(),
    agent: await freePort(),
    srt: await freeUdpPort(),
    livekit: await freePort(),
    livekitTcp: await freePort(),
    s3: await freePort(),
    tapPorts: [await freePort(), await freePort()],
    recvPorts: [await freePort(), await freePort()]
  }
  const runnerPorts = await freePortRange(4)
  log(
    `ports: agent ${ports.agent}, livekit ${ports.livekit} (rtc tcp ${ports.livekitTcp}), taps ${ports.tapPorts.join(' and ')} ahead of receivers ${ports.recvPorts.join(' and ')}, fake s3 ${ports.s3}`
  )

  // 3. The fake media: a y4m per person and a wav of tone bursts.
  const media = {}
  for (const [key, person] of Object.entries(PEOPLE)) {
    const size = key === 'host' ? '1280x720' : '640x360'
    const y4m = join(mediaDir, `${key}.y4m`)
    const wav = join(mediaDir, `${key}.wav`)
    runChecked(
      ffmpegPath,
      [
        '-y',
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x${person.color}:s=${size}:r=30`,
        '-t',
        '2',
        '-pix_fmt',
        'yuv420p',
        y4m
      ],
      `${key}'s fake camera file`
    )
    runChecked(
      ffmpegPath,
      [
        '-y',
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=if(lt(mod(t\\,0.5)\\,0.25)\\,0.5*sin(2*PI*${person.tone}*t)\\,0):s=48000:d=4`,
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wav
      ],
      `${key}'s fake microphone file`
    )
    media[key] = { y4m, wav, luma: lumaOfHex(person.color) }
  }

  // 4. LiveKit, loopback only, with this run's key pair.
  livekit = startChild('livekit-server', livekitPath, [
    '--dev',
    '--bind',
    '127.0.0.1',
    '--config-body',
    [
      `port: ${ports.livekit}`,
      `keys:`,
      `  ${livekitKeys.apiKey}: ${livekitKeys.apiSecret}`,
      `rtc:`,
      `  tcp_port: ${ports.livekitTcp}`,
      `  port_range_start: ${runnerPorts.at(-1) + 1}`,
      `  port_range_end: ${runnerPorts.at(-1) + 200}`,
      `  use_external_ip: false`,
      `room:`,
      `  auto_create: true`,
      `  empty_timeout: 600`,
      `logging:`,
      `  level: info`
    ].join('\n')
  ])
  await waitFor(() => portOpen(ports.livekit), 20_000, 'livekit-server to listen')
  const livekitUrl = `ws://127.0.0.1:${ports.livekit}`

  // 5. The fake S3 (the runner harness's, SigV4 checked) under the user's prefix.
  s3Dir = join(nodeRoot, 's3')
  mkdirSync(s3Dir, { recursive: true })
  s3Credentials = {
    accessKeyId: `AKSMOKE${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    secretAccessKey: `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
    sessionToken: `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  }
  fakeS3 = startChild('fake-s3', pythonPath, [
    '-I',
    fakeS3Script,
    '--port',
    String(ports.s3),
    '--dir',
    s3Dir,
    '--access-key',
    s3Credentials.accessKeyId,
    '--secret',
    s3Credentials.secretAccessKey,
    '--token',
    s3Credentials.sessionToken,
    '--prefix',
    `talk/${userId}/`
  ])
  await waitFor(() => portOpen(ports.s3), 15_000, 'the fake S3 to listen')

  // 6. Keys, the RTMPS cert, the fake web with rooms, then the node agent.
  const nodeSecret = newNodeSecret()
  const signing = newShowSigningKey()
  const certDir = join(nodeRoot, 'certs')
  runChecked('bash', [join(cloudDir, 'dev', 'gen-certs.sh'), certDir], 'the RTMPS certificate')
  const agentUrl = `http://127.0.0.1:${ports.agent}`
  web = await startFakeCloudWeb({
    sessionToken,
    userId,
    node: { id: nodeId, secret: nodeSecret, agentUrl },
    signingKey: signing.privateKey,
    allowance: cloudAllowanceBlock({ nowMs: Date.now() }),
    talk: {
      livekit: {
        url: livekitUrl,
        httpUrl: `http://127.0.0.1:${ports.livekit}`,
        apiKey: livekitKeys.apiKey,
        apiSecret: livekitKeys.apiSecret
      },
      recording: {
        bucket: 'videorc-cloud-recordings',
        endpoint: `http://127.0.0.1:${ports.s3}`,
        region: 'auto',
        credentials: s3Credentials
      },
      guestAssets: { 'livekit-client.esm.mjs': livekitClientEsm }
    }
  })
  const agentStateDir = join(nodeRoot, 'agent')
  mkdirSync(agentStateDir, { recursive: true })
  agent = startChild('node-agent', binaries.agent, [], {
    env: {
      ...process.env,
      VIDEORC_NODE_ID: nodeId,
      VIDEORC_NODE_SECRET: encodeNodeSecret(nodeSecret),
      VIDEORC_CLOUD_SHOW_PUBLIC_KEY: signing.publicKeyBase64Url,
      VIDEORC_NODE_LISTEN: `127.0.0.1:${ports.agent}`,
      VIDEORC_NODE_PUBLIC_HOST: 'localhost',
      VIDEORC_NODE_INGEST_SCHEME: 'rtmps',
      VIDEORC_NODE_RTMPS_PORT: String(ports.rtmps),
      VIDEORC_NODE_RTMP_PORT: String(ports.rtmp),
      VIDEORC_NODE_SRT_PORT: String(ports.srt),
      VIDEORC_NODE_STATE_DIR: agentStateDir,
      VIDEORC_RUNNER_BIN: binaries.runner,
      VIDEORC_NODE_FFMPEG: ffmpegPath,
      VIDEORC_NODE_ENCODER: process.env.VIDEORC_CLOUD_TALK_ENCODER ?? 'libx264',
      VIDEORC_MEDIAMTX_RTSP: `rtsp://127.0.0.1:${ports.rtsp}`,
      VIDEORC_MEDIAMTX_API: `http://127.0.0.1:${ports.api}`,
      VIDEORC_NODE_PORT_RANGE: `${runnerPorts[0]}-${runnerPorts.at(-1)}`,
      VIDEORC_WEB_BASE_URL: web.httpOrigin,
      VIDEORC_NODE_LOG: process.env.VIDEORC_NODE_LOG ?? 'info',
      VIDEORC_RUNNER_LOG: process.env.VIDEORC_RUNNER_LOG ?? 'info'
    }
  })
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
  const mediamtxConfig = join(nodeRoot, 'mediamtx.yml')
  writeFileSync(
    mediamtxConfig,
    mediamtxConfigFromTemplate(readFileSync(join(cloudDir, 'dev', 'mediamtx.yml.tpl'), 'utf8'), {
      certDir,
      hook: `${agentUrl}/v1/mediamtx/auth`,
      ports
    })
  )
  startChild('mediamtx', mediamtxPath, [mediamtxConfig])
  await waitFor(() => portOpen(ports.rtsp), 15_000, 'the MediaMTX RTSP listener')

  // 7. Two fake platforms behind taps: each leg publishes to a tap, the tap
  //    forwards to a one-shot FFmpeg receiver that records the FLV and pipes
  //    a 320x180 luma probe of every 4th frame back here.
  for (const index of [0, 1]) {
    const tap = await startRtmpTap({
      listenPort: ports.tapPorts[index],
      targetPort: ports.recvPorts[index]
    })
    taps.push(tap)
    const name = `receiver-${index + 1}`
    const streamKey = `talk-${index + 1}-${Math.random().toString(36).slice(2, 14)}`
    const target = {
      id: ['talk-a', 'talk-b'][index],
      label: ['Fake platform A', 'Fake platform B'][index],
      name,
      index,
      streamKey,
      serverUrl: `rtmp://127.0.0.1:${ports.tapPorts[index]}/live`,
      listenUrl: `rtmp://127.0.0.1:${ports.recvPorts[index]}/live`,
      recvPath: join(outputDirectory, `${name}.flv`),
      generation: 0,
      firstBytesAtMs: null,
      exitedAtMs: null,
      probe: null,
      probeFrames: 0
    }
    spawnReceiver(target)
    receivers.push(target)
  }
  await sleep(listenerBindMs)
  const growthTimer = setInterval(() => {
    for (const receiver of receivers) {
      if (receiver.firstBytesAtMs !== null) continue
      if (fileSize(receiver.recvPath) > 1024) receiver.firstBytesAtMs = Date.now()
    }
  }, 50)

  // 8. The signed-in desktop: the fake web, the fake camera and mic.
  const secretsPath = join(appDataDir, 'videorc-secrets.json')
  writeFileSync(secretsPath, JSON.stringify({ 'account:videorc:session': sessionToken }, null, 2))
  chmodSync(secretsPath, 0o600)
  const appEnv = {
    VIDEORC_API_BASE_URL: web.httpOrigin,
    VIDEORC_CLOUD_FEED_CA_FILE: join(certDir, 'server.crt'),
    VIDEORC_DISABLE_AUTO_PREVIEW: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_STATE_DIR: outputDirectory,
    VIDEORC_APP_DATA_DIR: appDataDir,
    VIDEORC_USER_DATA_DIR: userDataDir,
    VIDEORC_SMOKE_FAKE_MEDIA_VIDEO: media.host.y4m,
    VIDEORC_SMOKE_FAKE_MEDIA_AUDIO: media.host.wav
  }
  let launch = await launchApp(appEnv, 1)
  launched = launch.launched
  backend = launch.backend
  collected = launch.collected
  await waitForCloudStatus(
    backend,
    (status) => status.entitled === true && status.settings?.enabled === true,
    30_000,
    'the cloud entitlement from the fake capabilities'
  )
  const health = await request(backend, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the talk-show smoke.')
  }

  // --- 1. Open the room -------------------------------------------------------
  await scenario(
    1,
    'Open the room: the runner joins, the host joins with fake devices',
    async () => {
      const openAtMs = Date.now()
      const opened = await request(backend, timeoutMs, 'cloud.room.open', {
        outputs: [OUTPUT],
        title: 'Smoke talk',
        platforms: []
      })
      if (opened.room?.phase !== 'open' || !opened.show?.id) {
        throw new Error(`cloud.room.open did not open a room: ${JSON.stringify(opened.room)}`)
      }
      showId = opened.show.id
      report.room.opened = true
      report.room.showId = showId
      report.room.inviteUrl = opened.room.inviteUrl
      report.room.stageOnOpen = opened.room.stage
      if (!opened.room.stage?.onStage?.includes(`host:${showId}`)) {
        throw new Error(
          `the room opened without the host on its stage: ${JSON.stringify(opened.room.stage)}`
        )
      }
      runnerLogPath = join(agentStateDir, 'runners', `${showId}.log`)
      watcher = startShowWatcher({ url: web.controlUrlFor(showId), token: web.tokenFor(showId) })
      await waitFor(() => watcher.states.length > 0, 20_000, 'the watcher welcome')
      await waitForCloudStatus(
        backend,
        (status) => status.room?.client === 'connected',
        40_000,
        'the renderer to join the room'
      )
      const hostIn = await waitFor(
        () => {
          const host = latestRoom(watcher)?.participants?.find(
            (p) => p.identity === `host:${showId}`
          )
          return host?.video && host?.audio ? host : null
        },
        40_000,
        "the runner to see the host's camera and microphone",
        250,
        () => JSON.stringify(latestRoom(watcher))
      )
      report.room.hostJoined = true
      report.room.hostParticipant = hostIn
      report.measured.roomOpenToHostSeenSeconds = secondsBetween(openAtMs, Date.now())
      const status = await request(backend, 10_000, 'cloud.status', {})
      report.room.localProblem = status.room?.message ?? null
      log(
        `room ${showId} open; host seen by the runner ${report.measured.roomOpenToHostSeenSeconds} s after open; invite ${opened.room.inviteUrl}`
      )
    }
  )

  // --- 2. Two guests ---------------------------------------------------------
  const guests = {}
  await scenario(2, 'Two guests ask from the link, Let in both, both publish', async () => {
    const invite = web.roomFor(showId).invite
    for (const key of ['ada', 'bo']) {
      const { browser, page } = await openGuest(chrome, media[key], {
        url: `${invite.url}?name=${PEOPLE[key].name}${key === 'ada' ? '&tryReturn=1' : ''}`,
        label: key
      })
      guests[key] = { browser, page, key }
    }
    const asked = await waitFor(
      async () => {
        const states = await Promise.all(Object.values(guests).map((guest) => guestState(guest)))
        return states.every((state) => state.phase === 'waiting' && state.requestId) ? states : null
      },
      30_000,
      'both guests to ask to join',
      500,
      () => JSON.stringify(Object.values(guests).map((guest) => guest.lastState))
    )
    for (const [index, key] of ['ada', 'bo'].entries())
      guests[key].requestId = asked[index].requestId
    // The desktop learns the requests from its guests poll (one event each).
    const requestEvents = await waitFor(
      () => (collected.roomRequests.length >= 2 ? collected.roomRequests : null),
      30_000,
      'the cloud.room.requests events for both guests'
    )
    report.guests.requestEvents = requestEvents.map((event) => event.name)
    const letInAtMs = {}
    for (const key of ['ada', 'bo']) {
      letInAtMs[key] = Date.now()
      const decided = await request(backend, timeoutMs, 'cloud.guest.decide', {
        requestId: guests[key].requestId,
        decision: 'let-in'
      })
      if (decided.room?.requests?.some((r) => r.requestId === guests[key].requestId)) {
        throw new Error(`the request of ${key} is still listed after Let in`)
      }
    }
    for (const key of ['ada', 'bo']) {
      await waitFor(
        async () => ((await guestState(guests[key])).phase === 'published' ? true : null),
        40_000,
        `${key} to join and publish`,
        500,
        () => JSON.stringify(guests[key].lastState)
      )
      guests[key].guestId = guests[key].lastState.guestId
      report.measured[`letInToPublished_${key}_seconds`] = secondsBetween(
        letInAtMs[key],
        Date.now()
      )
    }
    report.guests.letIn = 2
    await waitFor(
      () => {
        const room = latestRoom(watcher)
        const people = (room?.participants ?? []).filter((p) => !p.identity.startsWith('runner:'))
        return people.length === 3 && people.every((p) => p.video && p.audio) ? true : null
      },
      40_000,
      'the runner to list the host and both guests with camera and mic',
      250,
      () => JSON.stringify(latestRoom(watcher))
    )
    await waitForCloudStatus(
      backend,
      (status) => (status.room?.guests?.length ?? 0) === 2,
      30_000,
      'the desktop to list both guests'
    )
    report.guests.inRoom = 2
    report.guests.ids = { ada: guests.ada.guestId, bo: guests.bo.guestId }
    log(
      `both guests in (let in → published: ada ${report.measured.letInToPublished_ada_seconds} s, bo ${report.measured.letInToPublished_bo_seconds} s)`
    )
  })
  const hostIdentity = `host:${showId}`
  const identityOf = { host: hostIdentity, ada: guests.ada.guestId, bo: guests.bo.guestId }
  const lumaOf = Object.fromEntries(
    Object.entries(identityOf).map(([key, identity]) => [identity, media[key].luma])
  )
  const tonesByKey = {
    host: PEOPLE.host.tone,
    ada: PEOPLE.ada.tone,
    bo: PEOPLE.bo.tone,
    control: CONTROL_TONE
  }

  // --- 3. Go Live and Record ---------------------------------------------------
  await scenario(
    3,
    'Go Live hands two destinations over; both legs live; Record starts',
    async () => {
      const goLiveAtMs = Date.now()
      const live = await request(backend, timeoutMs, 'cloud.show.goLive', {
        streaming: streamingSettings()
      })
      if (!live.room?.live)
        throw new Error(`Go Live did not put the room on air: ${JSON.stringify(live.room)}`)
      report.goLive.liveSince = live.room.liveSince ?? null
      await waitFor(
        () => {
          const legs = latestWatcher(watcher)?.legs ?? []
          return legs.length === 2 && legs.every((leg) => leg.state === 'live') ? true : null
        },
        40_000,
        "the runner's two legs to go live",
        250,
        () => JSON.stringify(latestWatcher(watcher)?.legs)
      )
      report.goLive.legsLive = true
      await waitFor(
        () => (receivers.every((receiver) => receiver.firstBytesAtMs !== null) ? true : null),
        20_000,
        'both receivers to take bytes'
      )
      report.goLive.receiversTakingBytes = true
      report.measured.goLiveToReceiversSeconds = secondsBetween(goLiveAtMs, Date.now())
      await waitForCloudStatus(
        backend,
        (status) => status.legs?.length === 2 && status.legs.every((leg) => leg.state === 'live'),
        20_000,
        "the desktop's leg rows to read live"
      )
      const recording = await request(backend, timeoutMs, 'cloud.recording.start').catch(
        (error) => ({
          error: String(error?.message ?? error)
        })
      )
      if (recording.error) {
        report.recording.gap = `recording.start refused: ${recording.error}`
        log(`[recording] ${report.recording.gap}`)
      } else {
        const active = await waitForCloudStatus(
          backend,
          (status) => status.recording?.active === true,
          20_000,
          'the cloud recording to start'
        )
        report.recording.started = true
        report.recording.since = active.recording.since ?? null
      }
      log(
        `on air: legs live, receivers taking bytes ${report.measured.goLiveToReceiversSeconds} s after Go Live; recording ${report.recording.started ? 'on' : 'off'}`
      )
    }
  )

  // --- 4 and 5. The layouts, with pixel probes and the tones ------------------------
  const phases = [
    { layout: 'solo', stage: null, onStage: ['host'], label: 'Solo: the host alone' },
    {
      layout: 'side-by-side',
      stage: { layout: 'side-by-side', onStage: [identityOf.host, identityOf.ada] },
      onStage: ['host', 'ada'],
      label: 'Bring on Ada: side by side'
    },
    {
      layout: 'side-by-side',
      stage: { layout: 'side-by-side', onStage: [identityOf.host, identityOf.ada, identityOf.bo] },
      onStage: ['host', 'ada', 'bo'],
      label: 'Bring on Bo: three side by side'
    },
    {
      layout: 'spotlight',
      stage: {
        layout: 'spotlight',
        onStage: [identityOf.host, identityOf.ada, identityOf.bo],
        spotlight: identityOf.ada
      },
      onStage: ['host', 'ada', 'bo'],
      label: 'Spotlight on Ada'
    },
    {
      // Send backstage: Bo's tile and tone leave the program, the host stays.
      layout: 'side-by-side',
      stage: { layout: 'side-by-side', onStage: [identityOf.host, identityOf.ada] },
      onStage: ['host', 'ada'],
      label: 'Send Bo backstage: side by side again'
    }
  ]
  const lastPhase = phases.at(-1)
  await scenario(
    4,
    'Every layout composes to the receiver (tile probes) with the on-stage tones in the mix',
    async () => {
      for (const [index, phase] of phases.entries()) {
        const setAtMs = Date.now()
        if (phase.stage) {
          const status = await request(backend, timeoutMs, 'cloud.stage.set', phase.stage)
          if (JSON.stringify(status.room?.stage?.onStage) !== JSON.stringify(phase.stage.onStage)) {
            throw new Error(`the stage did not take: ${JSON.stringify(status.room?.stage)}`)
          }
        }
        const expected = Object.fromEntries(
          phase.onStage.map((key) => [identityOf[key], media[key].luma])
        )
        // The runner logs its tile plan on every layout change; the receiver's
        // frame matches it once the 300 ms crossfade is over.
        const plan = await waitFor(
          () => {
            const latest = latestStageTiles(readText(runnerLogPath), { layout: phase.layout })
            if (!latest) return null
            const identities = latest.tiles
              .filter((t) => t.kind === 'person')
              .map((t) => t.identity)
              .sort()
            return JSON.stringify(identities) === JSON.stringify(Object.keys(expected).sort())
              ? latest
              : null
          },
          20_000,
          `the runner's tile plan for ${phase.label}`,
          250,
          () => String(latestStageTiles(readText(runnerLogPath))?.tiles?.map((t) => t.identity))
        )
        const first = await waitFor(
          () => {
            const frame = receivers[0].probe
            if (!frame || frame.atMs < setAtMs + 300) return null
            const verdict = evaluateTilePlan({
              frame,
              canvas: plan.canvas,
              tiles: plan.tiles,
              expected
            })
            return verdict.ok ? { verdict, atMs: frame.atMs } : null
          },
          15_000,
          `the receiver to show ${phase.label}`,
          250,
          () => {
            const frame = receivers[0].probe
            return frame
              ? JSON.stringify(
                  evaluateTilePlan({ frame, canvas: plan.canvas, tiles: plan.tiles, expected })
                    .probes
                )
              : 'no frame yet'
          }
        )
        const settleMs = Math.max(0, phaseMs - (Date.now() - setAtMs))
        await sleep(settleMs)
        // The frame again after the settle, and the mix over the last second.
        const settled = evaluateTilePlan({
          frame: receivers[0].probe,
          canvas: plan.canvas,
          tiles: plan.tiles,
          expected
        })
        const db = await tonesInReceiver(receivers[0].recvPath, tonesByKey)
        const absent = [
          'control',
          ...['host', 'ada', 'bo'].filter((key) => !phase.onStage.includes(key))
        ]
        const tones = evaluateTones(db, { present: phase.onStage, absent })
        const entry = {
          layout: phase.layout,
          label: phase.label,
          onStage: phase.onStage,
          canvas: plan.canvas,
          tiles: {
            ok: settled.ok,
            probes: settled.probes,
            detail: settled.ok ? null : JSON.stringify(settled.probes)
          },
          tones: { ok: tones.ok, db, problems: tones.problems },
          stageToReceiverSeconds: secondsBetween(setAtMs, first.atMs),
          receiver2: receivers[1].probe
            ? evaluateTilePlan({
                frame: receivers[1].probe,
                canvas: plan.canvas,
                tiles: plan.tiles,
                expected
              }).ok
            : null
        }
        report.layouts.push(entry)
        log(
          `[layout ${index + 1}/${phases.length}] ${phase.label}: tiles ${settled.ok ? 'OK' : 'WRONG'} (${settled.probes.map((p) => `${p.identity.slice(0, 10)}=${p.measured}/${p.expected ?? '-'}`).join(' ')}), on the receiver ${entry.stageToReceiverSeconds} s after stage.set; tones ${tones.ok ? 'OK' : tones.problems.join('; ')} ${JSON.stringify(db)}`
        )
        if (index === 1) {
          // H2: the first Bring on names the host too, so the host's tile and
          // tone stay in the program.
          const hostProbe = settled.probes.find((probe) => probe.identity === identityOf.host)
          report.hostOnAfterBringOn = {
            tile: hostProbe?.ok === true,
            tone: db.host !== undefined && db.host >= -12,
            hostTileLuma: hostProbe?.measured ?? null,
            hostToneDb: db.host ?? null
          }
        }
        if (!settled.ok || !tones.ok) {
          throw new Error(
            `${phase.label}: tiles ${settled.ok ? 'ok' : 'wrong'}, tones ${tones.ok ? 'ok' : tones.problems.join('; ')}`
          )
        }
      }
    }
  )

  // --- 6. A guest never hears the program --------------------------------------
  await scenario(
    6,
    'A guest never hears the program: no runner track reaches a guest; the ask is refused',
    async () => {
      await sleep(3_000)
      const ada = await guestState(guests.ada)
      const bo = await guestState(guests.bo)
      report.return = {
        adaSawRunnerPublications: ada.runnerPublications.length,
        adaAskedForReturn: ada.runnerSubscribeAttempts,
        adaRunnerTracks: ada.runnerTracksReceived,
        adaPermissionChanges: ada.permissionChanges,
        adaSubscribed: ada.subscribed,
        boSubscribed: bo.subscribed,
        boAskedForRunner: bo.subscribeAsked.filter((key) => key.startsWith('runner:')).length,
        boRunnerTracks: bo.runnerTracksReceived,
        guestRefused:
          ada.runnerPublications.length >= 1 &&
          ada.runnerSubscribeAttempts >= 1 &&
          ada.runnerTracksReceived === 0,
        guestHeardProgram:
          ada.runnerTracksReceived > 0 ||
          bo.runnerTracksReceived > 0 ||
          [...ada.subscribed, ...bo.subscribed].some((key) => key.startsWith('runner:'))
      }
      log(
        `[return] Ada saw ${ada.runnerPublications.length} runner publications, asked ${ada.runnerSubscribeAttempts} times, got ${ada.runnerTracksReceived} tracks (${JSON.stringify(ada.permissionChanges)}); Bo asked ${report.return.boAskedForRunner} times; subscribed ada=${JSON.stringify(ada.subscribed)} bo=${JSON.stringify(bo.subscribed)}`
      )
      if (!report.return.guestRefused)
        throw new Error(
          'the guest that asked for the return was not refused (or never saw the runner)'
        )
      if (report.return.guestHeardProgram) throw new Error('a guest received a runner track')
      if (!ada.subscribed.some((key) => key.startsWith(hostIdentity)))
        throw new Error('Ada never subscribed to the host')
    }
  )

  // --- 7. End livestream keeps the room; Go Live again ---------------------------
  await scenario(
    7,
    'End livestream ends both legs cleanly, the room stays, Go Live again works',
    async () => {
      const sentAtMs = Date.now()
      const ended = await request(backend, timeoutMs, 'cloud.show.legs.end')
      report.legsEnd.acked = true
      report.legsEnd.ackSeconds = secondsBetween(sentAtMs, Date.now())
      if (ended.room?.live !== false)
        throw new Error(
          `the desktop still reads on air after legs.end: ${JSON.stringify(ended.room)}`
        )
      report.legsEnd.desktopPhaseAfter = ended.phase
      await waitFor(
        () => (receivers.every((receiver) => receiver.exitedAtMs !== null) ? true : null),
        10_000,
        'both receivers to see the end of the stream'
      )
      report.legsEnd.taps = taps.map((tap, index) => ({
        receiver: receivers[index].name,
        ...evaluateTapAfterLegsEnd(tap.events, { sentAtMs })
      }))
      const between = await waitFor(
        () => {
          const state = latestWatcher(watcher)
          return state && state.legs.length === 0 ? state : null
        },
        10_000,
        'the runner to list no legs'
      )
      const people = (between.room?.participants ?? []).filter(
        (p) => !p.identity.startsWith('runner:')
      )
      report.legsEnd.roomStayed = between.room?.connected === true && people.length === 3
      report.legsEnd.phaseBetween = between.phase
      report.legsEnd.recordingKept = between.recording?.active === true
      report.legsEnd.participantsBetween = people.length
      log(
        `[legs.end] acked in ${report.legsEnd.ackSeconds} s; taps ${report.legsEnd.taps.map((tap) => `${tap.receiver}: ${tap.ok ? 'clean' : tap.problems.join('; ')} (${tap.ended?.closeAfterMs ?? '?'} ms)`).join(' | ')}; runner phase ${between.phase}, ${people.length} people, recording ${report.legsEnd.recordingKept ? 'still on' : 'off'}`
      )
      if (!report.legsEnd.roomStayed)
        throw new Error(`the room did not stay: ${JSON.stringify(between.room)}`)
      for (const tap of report.legsEnd.taps) {
        if (!tap.ok) throw new Error(`${tap.receiver}: ${tap.problems.join('; ')}`)
      }
      // Go Live again: fresh receivers on the same ports, fresh destinations.
      for (const receiver of receivers) {
        receiver.firstBytesAtMs = null
        receiver.exitedAtMs = null
        receiver.generation += 1
        receiver.recvPath = join(outputDirectory, `${receiver.name}-again.flv`)
        spawnReceiver(receiver)
      }
      await sleep(listenerBindMs)
      const againAtMs = Date.now()
      const again = await request(backend, timeoutMs, 'cloud.show.goLive', {
        streaming: streamingSettings()
      })
      if (!again.room?.live) throw new Error('Go Live again did not put the room on air')
      report.legsEnd.liveSinceAgain = again.room.liveSince ?? null
      await waitFor(
        () => {
          const legs = latestWatcher(watcher)?.legs ?? []
          return legs.length === 2 && legs.every((leg) => leg.state === 'live') ? true : null
        },
        40_000,
        'the legs to be live again'
      )
      await waitFor(
        () => (receivers.every((receiver) => receiver.firstBytesAtMs !== null) ? true : null),
        20_000,
        'the fresh receivers to take bytes'
      )
      report.legsEnd.liveAgain = true
      report.legsEnd.liveAgainSeconds = secondsBetween(againAtMs, Date.now())
      report.legsEnd.destinationsSetIntents = destinationsSetIntentTimes(agent.logPath).length
      report.legsEnd.tapsBack = taps.map(
        (tap) => evaluateTapAfterLegsEnd(tap.events, { sentAtMs }).backConnected
      )
      // The program after Go Live again still shows the last stage.
      const plan = latestStageTiles(readText(runnerLogPath), { layout: lastPhase.layout })
      const expected = Object.fromEntries(
        lastPhase.onStage.map((key) => [identityOf[key], media[key].luma])
      )
      await waitFor(
        () => {
          const frame = receivers[0].probe
          return frame &&
            frame.atMs > againAtMs &&
            evaluateTilePlan({ frame, canvas: plan.canvas, tiles: plan.tiles, expected }).ok
            ? true
            : null
        },
        20_000,
        'the stage on the fresh receiver'
      )
      log(
        `[legs.end] live again ${report.legsEnd.liveAgainSeconds} s after Go Live; destinations.set intents so far ${report.legsEnd.destinationsSetIntents}; liveSince ${report.goLive.liveSince} → ${report.legsEnd.liveSinceAgain}`
      )
      if (
        report.legsEnd.liveSinceAgain &&
        report.goLive.liveSince &&
        report.legsEnd.liveSinceAgain <= report.goLive.liveSince
      ) {
        throw new Error('the second Go Live did not start a fresh on-air clock')
      }
    }
  )

  // --- 8. The cloud recording ---------------------------------------------------
  await scenario(
    8,
    'The cloud recording stops, uploads to the fake S3 and passes ffprobe',
    async () => {
      if (!report.recording.started) {
        log(`[recording] skipped: ${report.recording.gap}`)
        return
      }
      await sleep(2_000)
      const before = await request(backend, 10_000, 'cloud.status', {})
      const stopAtMs = Date.now()
      await request(backend, timeoutMs, 'cloud.recording.stop')
      await waitForCloudStatus(
        backend,
        (status) => status.recording?.active === false,
        20_000,
        'the recording to stop'
      )
      report.recording.reportedSeconds = before.recording?.seconds ?? null
      report.recording.reportedBytes = before.recording?.bytes ?? null
      const file = await waitFor(
        () => {
          const files = readdirSync(s3Dir).filter(
            (name) => name.endsWith('.mp4') && !name.includes('.part')
          )
          return files.length ? join(s3Dir, files[0]) : null
        },
        60_000,
        'the completed multipart upload in the fake S3',
        500,
        () => `s3 dir: ${readdirSync(s3Dir).join(', ')}`
      )
      const probe = await probeMedia(file)
      const pts = parsePtsTimes(
        await runCommand(ffprobePath, [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'packet=pts_time',
          '-of',
          'csv=p=0',
          file
        ])
      )
      const gaps = packetGapStats(pts)
      const nodeReport = await waitFor(
        () => web.recordingsFor(showId).find((entry) => entry.state === 'complete') ?? null,
        30_000,
        "the node's recording report on the fake web"
      )
      const s3Log = readText(fakeS3.logPath)
      report.recording = {
        ...report.recording,
        file,
        bytes: fileSize(file),
        probe,
        packets: gaps.packets,
        maxGapSeconds: gaps.maxGapSeconds,
        parts: (s3Log.match(/ PART /g) ?? []).length,
        denied: (s3Log.match(/ DENY /g) ?? []).length,
        nodeReport: {
          seconds: nodeReport.seconds,
          bytes: nodeReport.bytes,
          objectKey: nodeReport.objectKey,
          state: nodeReport.state
        },
        stopToFileSeconds: secondsBetween(stopAtMs, Date.now()),
        ffprobeOk:
          probe.video.codec === 'h264' &&
          probe.audio.codec === 'aac' &&
          probe.durationSeconds > 5 &&
          Math.abs(probe.durationSeconds - nodeReport.seconds) <= 2.5 &&
          gaps.maxGapSeconds <= 0.5 &&
          (s3Log.match(/ DENY /g) ?? []).length === 0
      }
      log(
        `[recording] ${report.recording.ffprobeOk ? 'OK' : 'WRONG'}: ${probe.video.codec} ${probe.video.width}x${probe.video.height} + ${probe.audio.codec}, ${probe.durationSeconds.toFixed(1)} s (node reported ${nodeReport.seconds} s, ${nodeReport.bytes} bytes), ${gaps.packets} packets, max gap ${gaps.maxGapSeconds} s, ${report.recording.parts} parts, ${report.recording.denied} denied`
      )
      if (!report.recording.ffprobeOk)
        throw new Error(
          `the recording failed ffprobe: ${JSON.stringify(report.recording.probe)} gaps ${JSON.stringify(gaps)}`
        )
    }
  )

  // --- 9 and 10. Remove a guest; New link -------------------------------------------
  await scenario(9, 'Remove Bo: his page reads removed, the runner drops him', async () => {
    const removeAtMs = Date.now()
    const status = await request(backend, timeoutMs, 'cloud.guest.act', {
      guestId: guests.bo.guestId,
      action: 'remove'
    })
    if ((status.room?.guests ?? []).some((guest) => guest.guestId === guests.bo.guestId)) {
      throw new Error('Bo is still listed after Remove')
    }
    if (status.room?.stage?.onStage?.includes(guests.bo.guestId))
      throw new Error('Bo is still on the stage after Remove')
    await waitFor(
      async () => ((await guestState(guests.bo)).removed ? true : null),
      15_000,
      "Bo's page to read removed",
      500,
      () => JSON.stringify(guests.bo.lastState?.disconnected)
    )
    await waitFor(
      () => {
        const people = (latestRoom(watcher)?.participants ?? []).filter(
          (p) => !p.identity.startsWith('runner:')
        )
        return people.length === 2 ? true : null
      },
      15_000,
      'the runner to list two people'
    )
    report.moderation = {
      removedGuestSawIt: true,
      removeToRemovedSeconds: secondsBetween(removeAtMs, Date.now()),
      disconnect: guests.bo.lastState?.disconnected ?? null,
      webState:
        web.guestRequestsFor(showId).find((entry) => entry.guestId === guests.bo.guestId)?.state ??
        null
    }
    log(
      `[moderation] Bo removed in ${report.moderation.removeToRemovedSeconds} s (${JSON.stringify(report.moderation.disconnect)})`
    )
  })
  await scenario(10, 'New link: the old slug is invalid', async () => {
    const before = web.roomFor(showId).invite.slug
    const rotated = await request(backend, timeoutMs, 'cloud.room.invite.rotate')
    const after = web.roomFor(showId).invite.slug
    if (after === before || !rotated.room?.inviteUrl?.includes(after))
      throw new Error('the invite did not rotate')
    const old = await (await fetch(`${web.httpOrigin}/api/guest/${before}`)).json()
    const fresh = await (await fetch(`${web.httpOrigin}/api/guest/${after}`)).json()
    report.invite = {
      oldSlugInvalid: old.state === 'invalid',
      newSlugOpen: fresh.state === 'open',
      inviteUrl: rotated.room.inviteUrl
    }
    log(`[invite] old slug reads ${old.state}, new slug reads ${fresh.state}`)
    if (!report.invite.oldSlugInvalid) throw new Error(`the old slug reads ${old.state}`)
  })

  // --- 11. The host dies; relaunch and Resume ---------------------------------------
  if (skipDeath) {
    report.hostAway = { seen: true, receiversKept: true, skipped: true }
    report.resume = { hostBack: true, skipped: true }
    log('[host away] skipped (VIDEORC_CLOUD_TALK_SKIP_DEATH=1)')
  } else {
    await scenario(
      11,
      'Kill the host: the runner reports host away, the receivers keep going; relaunch and Resume brings the host back',
      async () => {
        const killAtMs = Date.now()
        await killAppHard(launched)
        backend = null
        log('[host away] the dev app got SIGKILL (the whole process group)')
        const away = await waitFor(
          () => (latestRoom(watcher)?.hostAway === true ? latestWatcher(watcher) : null),
          15_000,
          'the runner to report the host away',
          250,
          () => JSON.stringify(latestRoom(watcher))
        )
        report.hostAway.seen = true
        report.hostAway.afterSeconds = secondsBetween(killAtMs, away.atMs)
        await sleep(6_000)
        report.hostAway.receiversKept = receivers.every((receiver) => receiver.exitedAtMs === null)
        report.hostAway.adaStillConnected = (await guestState(guests.ada)).connected
        report.hostAway.plateLuma = receivers[0].probe
          ? (() => {
              const plan = latestStageTiles(readText(runnerLogPath))
              const tile = plan?.tiles.find((t) => t.identity === hostIdentity)
              return tile
                ? evaluateTilePlan({
                    frame: receivers[0].probe,
                    canvas: plan.canvas,
                    tiles: [tile],
                    expected: {}
                  }).probes[0].measured
                : null
            })()
          : null
        // The host's tile shows the runner's away plate, not the host's
        // last camera frame (plan 224 S-G1, "Back in a moment").
        report.hostAway.hostLuma = media.host.luma
        report.hostAway.plateShown =
          report.hostAway.plateLuma !== null &&
          Math.abs(report.hostAway.plateLuma - media.host.luma) > 18
        log(
          `[host away] reported ${report.hostAway.afterSeconds} s after the kill; receivers kept ${report.hostAway.receiversKept}; Ada still connected ${report.hostAway.adaStillConnected}; host tile luma now ${report.hostAway.plateLuma} (the host's camera ${media.host.luma}: plate ${report.hostAway.plateShown ? 'shown' : 'NOT shown'})`
        )
        if (!report.hostAway.receiversKept)
          throw new Error('a receiver lost its connection while the host was away')
        const relaunchAtMs = Date.now()
        launch = await launchApp(appEnv, 2)
        launched = launch.launched
        backend = launch.backend
        collected = launch.collected
        const resumable = await waitForCloudStatus(
          backend,
          (status) => status.show?.id === showId && status.show.resumable === true,
          45_000,
          'the relaunched desktop to find the talk show resumable'
        )
        report.resume.relaunchToResumableSeconds = secondsBetween(relaunchAtMs, Date.now())
        report.resume.phaseAtRelaunch = resumable.phase
        const resumeAtMs = Date.now()
        const resumed = await request(backend, timeoutMs, 'cloud.room.resume')
        if (resumed.room?.phase !== 'open')
          throw new Error(`Resume did not reopen the room: ${JSON.stringify(resumed.room)}`)
        report.resume.liveAfterResume = resumed.room.live
        await waitForCloudStatus(
          backend,
          (status) => status.room?.client === 'connected',
          40_000,
          'the renderer to rejoin the room'
        )
        const back = await waitFor(
          () => {
            const room = latestRoom(watcher)
            const host = room?.participants?.find((p) => p.identity === hostIdentity)
            return host?.video && host?.audio && room?.hostAway === false ? room : null
          },
          40_000,
          'the runner to see the host back',
          250,
          () => JSON.stringify(latestRoom(watcher))
        )
        report.resume.hostBack = true
        report.resume.resumeToHostBackSeconds = secondsBetween(resumeAtMs, Date.now())
        report.resume.peopleAfter = back.participants.filter(
          (p) => !p.identity.startsWith('runner:')
        ).length
        report.resume.desktopConnected = (
          await request(backend, 10_000, 'cloud.status', {})
        ).connected
        log(
          `[resume] resumable ${report.resume.relaunchToResumableSeconds} s after relaunch; host back ${report.resume.resumeToHostBackSeconds} s after Resume; desktop control socket connected ${report.resume.desktopConnected}`
        )
      }
    )
  }

  // --- 12. Close the room ---------------------------------------------------------
  await scenario(
    12,
    'Close the room: the show ends on the web, the runner exits, the guest page sees the end',
    async () => {
      const closeAtMs = Date.now()
      const closed = await request(backend, timeoutMs, 'cloud.room.close')
      if (closed.room) throw new Error('the room is still in the status after Close')
      const show = web.state.shows.get(showId)
      report.close.showEnded = Boolean(show?.endedAt)
      report.close.endReason = show?.endReason ?? null
      const runnerPid = readRunnerPid(agentStateDir, showId)
      await waitFor(
        () =>
          !runnerPid || !pidAlive(runnerPid) || registryShowEnded(agentStateDir, showId)
            ? true
            : null,
        20_000,
        'the runner to exit'
      )
      await waitFor(
        () => (receivers.every((receiver) => receiver.exitedAtMs !== null) ? true : null),
        15_000,
        "the receivers' connections to close"
      )
      const ada = await waitFor(
        async () => {
          const state = await guestState(guests.ada)
          return state.connected ? null : state
        },
        20_000,
        "Ada's page to see the room end"
      )
      report.close.adaPhase = ada.phase
      report.close.closeSeconds = secondsBetween(closeAtMs, Date.now())
      log(
        `[close] show ended on the web (${report.close.endReason}); runner gone; Ada reads ${ada.phase}; ${report.close.closeSeconds} s`
      )
    }
  )

  // --- 13. Artifacts and the leak scan ------------------------------------------------
  clearInterval(growthTimer)
  for (const receiver of receivers) {
    for (const path of [
      join(outputDirectory, `${receiver.name}.flv`),
      join(outputDirectory, `${receiver.name}-again.flv`)
    ]) {
      if (!existsSync(path)) continue
      const pts = parsePtsTimes(
        await runCommand(ffprobePath, [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'packet=pts_time',
          '-of',
          'csv=p=0',
          path
        ]).catch(() => '')
      )
      const gaps = packetGapStats(pts)
      report.receivers.push({
        name: `${receiver.name}${path.endsWith('-again.flv') ? ' (again)' : ''}`,
        path,
        bytes: fileSize(path),
        packets: gaps.packets,
        maxGapSeconds: gaps.packets > 1 ? gaps.maxGapSeconds : null
      })
    }
  }
  await scenario(
    13,
    'No secret leaks: LiveKit tokens, show tokens, ingest keys and the recording credentials',
    async () => {
      const guestEvents = []
      for (const guest of Object.values(guests)) {
        const state = guest.lastState
        if (state) guestEvents.push(JSON.stringify(state.events))
      }
      const texts = [
        ...eventTexts,
        ...appLines,
        readText(agent.logPath),
        readText(runnerLogPath),
        JSON.stringify(web.state.calls),
        JSON.stringify(web.state.agentCalls),
        JSON.stringify(web.state.livekitCalls),
        ...guestEvents
      ]
      report.leaks = findSecretLeaks(secretsToScan(), texts)
      if (report.leaks.length) throw new Error(`leaked: ${report.leaks.join(', ')}`)
    }
  )

  const verdict = evaluateCloudTalkShowReport(report)
  report.problems = verdict.problems
  report.ok = verdict.ok
  report.finishedAt = new Date().toISOString()
  report.totalSeconds = secondsBetween(startedAtMs, Date.now())
  report.web = summarizeWeb(web.state)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  log(`report ${reportPath}`)
  log(
    `scenarios: ${report.scenarios.map((entry) => `${entry.number} ${entry.ok ? 'PASS' : 'FAIL'}`).join(', ')}`
  )
  if (!verdict.ok) {
    log(`FAIL: ${verdict.problems.join('; ')}`)
  } else {
    log(`PASS in ${report.totalSeconds} s`)
    exitCode = 0
  }
} catch (error) {
  report.failure = String(error?.stack ?? error)
  report.finishedAt = new Date().toISOString()
  try {
    report.web = web ? summarizeWeb(web.state) : null
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
  } catch {
    // The report is evidence, never a gate.
  }
  log(`FAIL: ${error?.message ?? error}`)
  if (error?.stack) console.error(error.stack)
} finally {
  await cleanup()
  process.exit(exitCode)
}

// --- Scenarios ----------------------------------------------------------------------

async function scenario(number, label, run) {
  const startedAt = Date.now()
  log(`--- ${number}. ${label}`)
  try {
    await run()
    report.scenarios.push({
      number,
      label,
      ok: true,
      seconds: secondsBetween(startedAt, Date.now())
    })
  } catch (error) {
    report.scenarios.push({
      number,
      label,
      ok: false,
      seconds: secondsBetween(startedAt, Date.now()),
      error: String(error?.message ?? error)
    })
    throw error
  }
}

// --- The desktop --------------------------------------------------------------------

async function launchApp(env, attempt) {
  const logPath = join(outputDirectory, `app-${attempt}.log`)
  const logFd = openSync(logPath, 'a')
  const onLine = (line) => {
    appLines.push(line)
    try {
      writeFileSync(logFd, `${line}\n`)
    } catch {
      // The log is evidence, never a gate.
    }
  }
  await prebuildBackendOrThrow(smokeAppEnv(env), onLine)
  const launchedApp = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env,
    skipPrebuild: true,
    onLine
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

async function prebuildBackendOrThrow(env, onLine = log) {
  const failure = await prebuildDevBackend({ env, onLine })
  if (failure) throw new Error(failure)
}

function collectEvents(ws) {
  const result = { cloudStates: [], roomRequests: [], raw: [] }
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
    } else if (message.event === 'cloud.room.requests') {
      result.roomRequests.push({ atMs, ...message.payload })
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
    () =>
      JSON.stringify({
        phase: latest?.phase,
        room: latest?.room && {
          phase: latest.room.phase,
          client: latest.room.client,
          live: latest.room.live,
          guests: latest.room.guests?.length
        },
        legs: latest?.legs,
        recording: latest?.recording
      })
  )
  return latest
}

/** The Go Live dialog's settings: two custom RTMP targets, one per tap. */
function streamingSettings() {
  const timestamp = '2026-11-09T00:00:00.000Z'
  return {
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
    defaultBitrateKbps: OUTPUT.videoKbps,
    enabledTargetIds: receivers.map((receiver) => receiver.id)
  }
}

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

// --- The watcher: the smoke's own control client -----------------------------------

function startShowWatcher({ url, token }) {
  const watch = { states: [], ws: null, timer: null }
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
    if (message.t !== 'welcome' && message.t !== 'state') return
    const state = message.state ?? {}
    watch.states.push({
      atMs: Date.now(),
      phase: state.phase,
      endReason: state.endReason ?? null,
      liveSeconds: state.liveSeconds ?? null,
      legs: Array.isArray(state.legs)
        ? state.legs.map((leg) => ({ id: leg.id, state: leg.state }))
        : [],
      room: state.room
        ? {
            connected: state.room.connected === true,
            hostAway: state.room.hostAway === true,
            stageSet: state.room.stageSet === true,
            returnEnabled: state.room.returnEnabled === true,
            layout: state.room.layout ?? null,
            participants: (state.room.participants ?? []).map((p) => ({
              identity: p.identity,
              onStage: p.onStage === true,
              video: p.video === true,
              audio: p.audio === true,
              away: p.away === true
            }))
          }
        : null,
      recording: state.recording
        ? {
            active: state.recording.active === true,
            seconds: state.recording.seconds ?? 0,
            bytes: state.recording.bytes ?? 0,
            problem: state.recording.problem ?? null
          }
        : null
    })
    if (watch.states.length > 4000) watch.states.splice(0, 1000)
  })
  ws.addEventListener('close', () => {
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

function latestWatcher(watch) {
  return watch?.states.at(-1) ?? null
}

function latestRoom(watch) {
  return latestWatcher(watch)?.room ?? null
}

// --- The guests: headless Chrome through playwright-core -----------------------------

async function openGuest(chrome, files, { url, label }) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${files.y4m}`,
      `--use-file-for-fake-audio-capture=${files.wav}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding'
    ]
  })
  browsers.push({ label, browser })
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const page = await context.newPage()
  const consoleLog = []
  page.on('console', (message) => consoleLog.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => consoleLog.push(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
  return { browser, page, consoleLog }
}

async function guestState(guest) {
  const state = await guest.page.evaluate(() => JSON.parse(JSON.stringify(window.__guest ?? null)))
  if (!state) throw new Error(`${guest.key}'s page has no guest state`)
  guest.lastState = state
  return state
}

function resolveChrome() {
  const named = process.env.VIDEORC_SMOKE_CHROME?.trim()
  const candidates = [
    named,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ].filter(Boolean)
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()) {
      for (const inner of readdirSync(join(cache, entry))) {
        candidates.push(join(cache, entry, inner, 'chrome-headless-shell'))
      }
    }
  }
  const found = candidates.find((candidate) => candidate && existsSync(candidate))
  if (!found) {
    throw new Error(
      `No Chrome for the guests: set VIDEORC_SMOKE_CHROME or install Google Chrome. Tried ${candidates.join(', ')}.`
    )
  }
  return found
}

function resolveLivekitClientEsm() {
  // `livekit-client`'s exports map hides its package.json from `require.resolve`,
  // so the bundle is found by path: the desktop's copy first, then the root's.
  const candidates = [
    join(
      repoRoot,
      'apps',
      'desktop',
      'node_modules',
      'livekit-client',
      'dist',
      'livekit-client.esm.mjs'
    ),
    join(repoRoot, 'node_modules', 'livekit-client', 'dist', 'livekit-client.esm.mjs')
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(
      `livekit-client's ESM bundle was not found (tried ${candidates.join(', ')}); the guest page needs it.`
    )
  }
  return found
}

// --- The receivers and their probes ----------------------------------------------------

function spawnReceiver(target) {
  rmSync(target.recvPath, { force: true })
  const logPath = join(nodeRoot, `${target.name}-${target.generation}.log`)
  const fd = openSync(logPath, 'a')
  const child = spawn(
    ffmpegPath,
    [
      '-y',
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-loglevel',
      'level+info',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-listen',
      '1',
      '-i',
      `${target.listenUrl}/${target.streamKey}`,
      '-map',
      '0',
      '-c',
      'copy',
      '-f',
      'flv',
      target.recvPath,
      '-map',
      '0:v',
      '-vf',
      `fps=4,scale=${PROBE_WIDTH}:${PROBE_HEIGHT}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      'pipe:1'
    ],
    { stdio: ['ignore', 'pipe', fd] }
  )
  const entry = { name: target.name, process: child, logPath, pid: child.pid }
  children.push(entry)
  target.child = entry
  let pending = Buffer.alloc(0)
  child.stdout.on('data', (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= PROBE_FRAME_BYTES) {
      const frame = pending.subarray(0, PROBE_FRAME_BYTES)
      pending = pending.subarray(PROBE_FRAME_BYTES)
      target.probeFrames += 1
      target.probe = {
        atMs: Date.now(),
        y: Buffer.from(frame.subarray(0, PROBE_WIDTH * PROBE_HEIGHT)),
        width: PROBE_WIDTH,
        height: PROBE_HEIGHT
      }
    }
  })
  child.once('exit', () => {
    target.exitedAtMs = Date.now()
  })
}

/** The tones in the last second of a growing FLV, in dB below the loudest. */
async function tonesInReceiver(path, tones) {
  const last = await runCommand(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=p=0',
    path
  ])
  const times = parsePtsTimes(last)
  const end = times.at(-1) ?? 0
  const start = Math.max(0, end - 2.2)
  const pcm = await runCommandBinary(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    start.toFixed(3),
    '-t',
    '1.5',
    '-i',
    path,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    's16le',
    'pipe:1'
  ])
  return tonesDbBelowLoudest(pcm16ToFloats(pcm), 48000, tones)
}

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

// --- The node ----------------------------------------------------------------------------

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
    const result = spawnSync(
      'cargo',
      ['build', '--release', '-p', 'videorc-runner', '-p', 'videorc-node-agent'],
      {
        cwd: cloudDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 20 * 60 * 1000
      }
    )
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
      entry.name.endsWith('.png') ||
      entry.name === 'Cargo.toml'
    ) {
      newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  return newest
}

function mediamtxConfigFromTemplate(template, { certDir, hook, ports }) {
  const replacements = [
    [/^authHTTPAddress: .*$/m, `authHTTPAddress: ${hook}`],
    [/^apiAddress: .*$/m, `apiAddress: 127.0.0.1:${ports.api}`],
    [/^rtspAddress: .*$/m, `rtspAddress: 127.0.0.1:${ports.rtsp}`],
    [/^rtmpAddress: .*$/m, `rtmpAddress: 127.0.0.1:${ports.rtmp}`],
    [/^rtmpsAddress: .*$/m, `rtmpsAddress: 127.0.0.1:${ports.rtmps}`],
    [/^srtAddress: .*$/m, `srtAddress: 127.0.0.1:${ports.srt}`]
  ]
  let config = template.replaceAll('@CERT_DIR@', certDir).replaceAll('@HOOK@', hook)
  for (const [pattern, line] of replacements) {
    if (!pattern.test(config))
      throw new Error(
        `dev/mediamtx.yml.tpl has no line matching ${pattern}; the smoke's config writer needs an update.`
      )
    config = config.replace(pattern, line)
  }
  return config
}

/**
 * When the runner applied a `destinations.set` (its `intent ok` line,
 * forwarded by the agent), as wall-clock ms from the agent's own timestamp.
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

// --- Secrets ------------------------------------------------------------------------------

function secretsToScan() {
  return [
    ...receivers.map((receiver) => ({
      label: `platform key ${receiver.index + 1}`,
      value: receiver.streamKey
    })),
    ...(web ? [...web.state.shows.values()] : []).map((show) => ({
      label: 'the ingest key',
      value: show.ingestKey
    })),
    ...(web ? [...web.state.shows.values()] : []).map((show) => ({
      label: 'an SRT passphrase',
      value: show.srtPassphrase
    })),
    ...(web?.state.mintedTokens ?? []).map((value) => ({ label: 'a show token', value })),
    ...(web?.livekitTokens() ?? []).map((value) => ({ label: 'a LiveKit token', value })),
    { label: 'the LiveKit API secret', value: livekitKeys.apiSecret },
    ...(s3Credentials
      ? [
          { label: "the recording's secret key", value: s3Credentials.secretAccessKey },
          { label: "the recording's session token", value: s3Credentials.sessionToken }
        ]
      : [])
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
    signatureFailures: state.signatureFailures,
    unknownRoutes: state.unknownRoutes,
    agentCalls: state.agentCalls,
    livekitCalls: state.livekitCalls,
    guestRefusals: state.guestRefusals,
    recordings: state.recordings,
    guestRequests: showId ? web.guestRequestsFor(showId) : [],
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

// --- Processes and cleanup ----------------------------------------------------------------

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
  for (const { browser } of browsers) {
    await browser.close().catch(() => {})
  }
  try {
    backend?.close()
  } catch {
    // Nothing to close.
  }
  try {
    watcher?.close()
  } catch {
    // Already closed.
  }
  if (web) {
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
  for (const tap of taps) await tap.close().catch(() => {})
  if (web) await web.close().catch(() => {})
}

// --- Small helpers --------------------------------------------------------------------------

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

async function freeUdpPort() {
  const { createSocket } = await import('node:dgram')
  return new Promise((resolvePort, rejectPort) => {
    const socket = createSocket('udp4')
    socket.once('error', rejectPort)
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(() => resolvePort(port))
    })
  })
}

async function freePortRange(count) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = 30_000 + Math.floor(Math.random() * 20_000)
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

function readText(path) {
  try {
    return path && existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
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
  return Math.round(((toMs - fromMs) / 1000) * 1000) / 1000
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
  console.log(`[cloud-talk-show +${((Date.now() - startedAtMs) / 1000).toFixed(1)}s] ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
