// Thin-uplink smoke (plan 218 S1): a live stream must hold its frame rate
// when the connection cannot carry every destination at full bitrate.
//
// A streamer's support bundle (0.18.0, 2026-11-03) showed a 1080p30 stream to
// YouTube + X running at ~21 of 30 fps for an hour: the encoder bridge's
// stream queue sat at its 4-frame / 100 ms coalesce limit and FFmpeg's fifo
// muxer logged `FIFO queue full` on one leg. This smoke reproduces that shape
// on this Mac, red first, and measures the four things the plan needs:
//
//   1. the bridge stream drop % (frames coalesced before VideoToolbox),
//   2. `FIFO queue full` per leg, from the metrics journal's FFmpeg log,
//   3. the received FLV's frame gaps (ffprobe of the sink captures),
//   4. the stream queue depth/age the moment pressure first trips.
//
// Three variants, one app launch each:
//
//   stream-only  1080p30 at 6 Mbps to two local RTMP sinks behind ONE
//                token-bucket proxy capping the total at 7 Mbps (H1 / M2).
//   split        the same, plus a 1440p30 8 Mbps local recording (the
//                streamer's shape: two VideoToolbox encoders, one FFmpeg).
//   audio-late   uncapped sinks; the debug-only
//                VIDEORC_SMOKE_AUDIO_FIFO_EXTRA_DELAY_MS=60 makes the session
//                audio bus write every chunk 60 ms later than production, so
//                FFmpeg's scheduler holds the video reads longer (H2).
//
// Local loopback sinks only; it never goes live. The synthetic microphone
// (debug builds only) puts the real session audio bus in the loop, so the
// scheduler's interleave wait is the production one.
//
//   node scripts/smoke-stream-thin-uplink-app.mjs --variant stream-only [--seconds 180]
//       [--cap-kbps 7000] [--measure-only]

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  SETTLE_TAIL_SECONDS,
  countFifoOverflowsByContext,
  receivedStreamCadence,
  streamDropShare,
  thinUplinkVerdict
} from './lib/thin-uplink-gates.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const { values: args } = parseArgs({
  options: {
    variant: {
      type: 'string',
      default: process.env.VIDEORC_SMOKE_THIN_UPLINK_VARIANT ?? 'stream-only'
    },
    seconds: { type: 'string', default: process.env.VIDEORC_SMOKE_THIN_UPLINK_SECONDS ?? '' },
    // Two legs of the noise at the 6 Mbps target need about 8.9 Mbps with
    // AAC; a 7 Mbps uplink is a fifth short, like the streamer's. At the
    // plan's 8 Mbps the shortage is marginal and takes minutes to show
    // (pass --cap-kbps 8000 to see it).
    'cap-kbps': {
      type: 'string',
      default: process.env.VIDEORC_SMOKE_THIN_UPLINK_CAP_KBPS ?? '7000'
    },
    'measure-only': {
      type: 'boolean',
      default: process.env.VIDEORC_SMOKE_THIN_UPLINK_MEASURE_ONLY === '1'
    }
  },
  strict: true
})

const VARIANTS = ['stream-only', 'split', 'audio-late']
const variant = args.variant
if (!VARIANTS.includes(variant)) {
  console.error(`Unknown variant "${variant}"; expected one of ${VARIANTS.join(', ')}.`)
  process.exit(2)
}
if (process.platform !== 'darwin') {
  console.log('Thin-uplink smoke SKIPPED: the VideoToolbox stream bridge is macOS only.')
  process.exit(0)
}

const FPS = 30
const STREAM_BITRATE_KBPS = 6000
// 0 = uncapped. The audio-late variant is uncapped by definition.
const capKbps = variant === 'audio-late' ? 0 : Math.max(0, Number(args['cap-kbps']))
// A capped run must outlast the adaptive bitrate's first steps (plan 218
// S3a learns the cap from the first overflows) plus the settle tail it is
// judged on; an uncapped run only needs a full 30 s delivery window.
const streamSeconds = Math.max(
  20,
  Number(args.seconds || (capKbps > 0 ? 120 + SETTLE_TAIL_SECONDS : 90))
)
const measureOnly = args['measure-only']
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const listenerBindMs = Number(process.env.VIDEORC_SMOKE_LISTENER_BIND_MS ?? 2500)
const basePort = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 13035)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
// `audio.rs`: CAPTION_CONTRACT_TEST_DEVICE_ID is u32::MAX, a 440 Hz tone.
const microphoneId = 'microphone:coreaudio:4294967295'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-thin-uplink-${variant}-${Date.now()}`)
)
const userDataDir = join(outputDirectory, 'user-data')
const reportPath = join(outputDirectory, `thin-uplink-${variant}.json`)
mkdirSync(outputDirectory, { recursive: true })

const targets = [
  { id: 'youtube', platform: 'youtube', label: 'YouTube' },
  { id: 'x', platform: 'x', label: 'X' }
].map((platform, index) => {
  const listenPort = basePort + index
  const proxyPort = capKbps > 0 ? basePort + 100 + index : null
  const streamKey = `thin${index}`
  return {
    ...platform,
    listenPort,
    proxyPort,
    streamKey,
    serverUrl: `rtmp://127.0.0.1:${proxyPort ?? listenPort}/live`,
    url: `rtmp://127.0.0.1:${proxyPort ?? listenPort}/live/${streamKey}`,
    listenUrl: `rtmp://127.0.0.1:${listenPort}/live/${streamKey}`,
    recvPath: join(outputDirectory, `recv-${platform.id}.flv`)
  }
})

let stopping = false
let stopApp = async () => {}
const listeners = []
let proxy = null
const healthEvents = []
const targetSnapshots = []
const diagnosticsSamples = []
let report = { pass: false, variant, capKbps, streamSeconds, measureOnly }

try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_APP_DATA_DIR: join(outputDirectory, 'app-data'),
      VIDEORC_USER_DATA_DIR: userDataDir,
      // Per-leg 5 s samples plus FFmpeg stderr in <userData>/logs/ffmpeg.
      VIDEORC_METRICS_JOURNAL: '1',
      // The plain test pattern encodes at about 1 Mbps, far under the 6 Mbps
      // target, so a thin uplink would never be short. Per-frame noise makes
      // the encoder work, as a busy desktop does, and its grain size sets
      // the floor no target can go under: the default quarter-canvas noise
      // (scaled up into gradients) costs 6.5 Mbps at 1080p30 at the highest
      // quantizer; hard-edged 32 px blocks encode at about 4.3 Mbps under the
      // 6 Mbps target and follow a 3 Mbps target to 2.8 Mbps (the on-box
      // VideoToolbox sweep, 2026-11-05).
      VIDEORC_SYNTHETIC_HARD_CONTENT: '1',
      VIDEORC_SYNTHETIC_HARD_CONTENT_GRAIN: '32',
      ...(variant === 'audio-late' ? { VIDEORC_SMOKE_AUDIO_FIFO_EXTRA_DELAY_MS: '60' } : {})
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => console.log(line)
  })
  stopApp = launch.stop
  const smoke = launch.connections['preview-motion-ready']
  const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message?.event === 'health.event' && message.payload?.code) {
      healthEvents.push({ ...message.payload, receivedAt: Date.now() })
    }
    if (message?.event === 'stream.targets' && Array.isArray(message.payload?.targets)) {
      targetSnapshots.push({ targets: message.payload.targets, receivedAt: Date.now() })
    }
    if (message?.event === 'diagnostics.stats' && message.payload) {
      diagnosticsSamples.push({ ...message.payload, receivedAt: Date.now() })
    }
  })

  try {
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the thin-uplink smoke.')
    }
    const recordingDirectory =
      variant === 'split'
        ? await requestSmokeCommand(
            smoke,
            'authorize-smoke-resource',
            { kind: 'output-directory', path: outputDirectory },
            { timeoutMs }
          )
        : null

    for (const target of targets) listeners.push(spawnListener(target))
    if (capKbps > 0) proxy = await startTokenBucketProxy(targets, capKbps)
    await sleep(listenerBindMs)
    console.log(
      `Variant ${variant}: 1080p${FPS} at ${STREAM_BITRATE_KBPS} kbps to ${targets.length} legs, ` +
        (capKbps > 0 ? `total uplink capped at ${capKbps} kbps` : 'uplink uncapped') +
        (variant === 'split' ? ', recording 1440p30 at 8000 kbps' : '') +
        (variant === 'audio-late' ? ', session audio written 60 ms later' : '') +
        `, ${streamSeconds} s.`
    )

    const startedAt = Date.now()
    const started = await request(
      ws,
      timeoutMs,
      'session.start',
      sessionParams(recordingDirectory?.capabilityId)
    )
    if (started.state !== 'recording' && started.state !== 'streaming') {
      throw new Error(`Expected a running session after start, got ${started.state}.`)
    }
    const sessionId = started.sessionId
    console.log(`Session ${sessionId} running (state ${started.state}).`)

    let trip = null
    const deadline = startedAt + streamSeconds * 1000
    while (Date.now() < deadline) {
      await sleep(2000)
      const status = await request(ws, timeoutMs, 'recording.status')
      if (status.state !== 'recording' && status.state !== 'streaming') {
        throw new Error(
          `Session died ${Math.round((Date.now() - startedAt) / 1000)} s in (state ${status.state}): ${status.message ?? 'no message'}`
        )
      }
      const sample = await request(ws, timeoutMs, 'diagnostics.stats')
      diagnosticsSamples.push({ ...sample, receivedAt: Date.now(), polled: true })
      if (!trip && streamPressureEvents(sample) > 0) {
        trip = {
          elapsedMs: Date.now() - startedAt,
          queueDepth: sample.encoderBridgeStreamQueueDepth ?? sample.encoderBridgeQueueDepth,
          oldestFrameAgeMs:
            sample.encoderBridgeStreamQueueOldestFrameAgeMs ??
            sample.encoderBridgeOutputQueueOldestFrameAgeMs,
          queueHighWaterFrames: sample.encoderBridgeOutputQueueHighWaterFrames,
          oldestFrameAgeHighWaterMs: sample.encoderBridgeOutputQueueOldestFrameAgeHighWaterMs,
          pressureEvents: streamPressureEvents(sample),
          droppedFrames: streamDroppedFrames(sample),
          fifoWriteP95Ms:
            sample.encoderBridgeStreamVideoToolboxFifoWriteP95Ms ??
            sample.encoderBridgeVideoToolboxFifoWriteP95Ms,
          queueAgeP95Ms: sample.encoderBridgeStreamQueueAgeP95Ms,
          lastTrip: sample.encoderBridgeStreamQueueLastTrip,
          depthTrips: sample.encoderBridgeStreamQueueDepthTrips,
          ageTrips: sample.encoderBridgeStreamQueueAgeTrips
        }
        console.log(
          `  pressure tripped at +${(trip.elapsedMs / 1000).toFixed(1)} s: ${JSON.stringify(trip)}`
        )
      }
    }
    const lastSample = await request(ws, timeoutMs, 'diagnostics.stats')
    diagnosticsSamples.push({ ...lastSample, receivedAt: Date.now(), polled: true })
    const stopped = await request(ws, timeoutMs, 'session.stop')
    console.log(`Session stopped (state ${stopped.state}).`)
    await sleep(3000)
    for (const listener of listeners.splice(0)) await stopListener(listener)

    // ---------- Measurements ----------
    const drop = streamDropShare(lastSample)
    const ffmpegLog = readFfmpegLog(userDataDir, sessionId)
    // FFmpeg publishes to the proxy port when the uplink is capped.
    const overflowsByContext = countFifoOverflowsByContext(
      ffmpegLog.text,
      targets.map((target) => ({ id: target.id, port: target.proxyPort ?? target.listenPort }))
    )
    const overflowEvents = healthEvents.filter((event) => event.code === 'stream-leg-overflow')
    const legs = []
    for (const target of targets) {
      const cadence = existsSync(target.recvPath)
        ? await receivedStreamCadence(target.recvPath, { ffprobePath, fps: FPS })
        : null
      const snapshot = targetSnapshots.at(-1)?.targets.find((entry) => entry.targetId === target.id)
      legs.push({
        id: target.id,
        label: target.label,
        receivedBytes: cadence?.bytes ?? 0,
        received: cadence,
        // The log's count when it can be attributed; the backend's snapshot
        // count (S2) otherwise; 0 when neither saw one.
        overflowCount: overflowsByContext.byLeg.get(target.id) ?? snapshot?.uplinkOverflows ?? 0,
        snapshotOverflows: snapshot?.uplinkOverflows ?? null,
        finalState: snapshot?.state ?? null,
        overflowEvents: overflowEvents.filter((event) => event.message.includes(target.label))
          .length
      })
    }
    const unattributedOverflow = overflowsByContext.unattributed
    const delivery = lastSample.streamDelivery ?? null
    const samples = diagnosticsSamples.filter((sample) => sample.sessionId === sessionId)
    // The adaptive bitrate's path and the last overflow, from the 2 s polls
    // (FFmpeg's log carries no clock; the session's overflow count does).
    const timeline = []
    let lastOverflowAtSeconds = null
    let seenOverflows = 0
    let seenBitrate = null
    for (const sample of samples) {
      const at = (sample.receivedAt - startedAt) / 1000
      const state = sample.streamDelivery
      if (!state) continue
      if (state.uplinkOverflows > seenOverflows) {
        seenOverflows = state.uplinkOverflows
        lastOverflowAtSeconds = at
      }
      if (state.bitrateKbps !== seenBitrate) {
        seenBitrate = state.bitrateKbps
        timeline.push({ atSeconds: Math.round(at), bitrateKbps: state.bitrateKbps })
      }
    }
    const bitrateChanges = healthEvents
      .filter((event) =>
        ['stream-bitrate-lowered', 'stream-bitrate-restored', 'stream-bitrate-floor'].includes(
          event.code
        )
      )
      .map((event) => ({ code: event.code, message: event.message, at: event.createdAt }))

    report = {
      ...report,
      sessionId,
      ffmpegLog: ffmpegLog.path,
      streamDrop: drop,
      trip,
      legs,
      fifoOverflowContexts: [...overflowsByContext.byContext.entries()].map(([context, count]) => ({
        context,
        count
      })),
      unattributedOverflow,
      overflowHealthEvents: overflowEvents.map((event) => ({
        message: event.message,
        at: event.createdAt
      })),
      streamDelivery: delivery,
      bitrateTimeline: timeline,
      bitrateChanges,
      lastOverflowAtSeconds,
      finalDiagnostics: pickDiagnostics(lastSample),
      healthCodes: healthEvents.map((event) => event.code),
      sampleCount: samples.length
    }
    const verdict = thinUplinkVerdict({
      variant,
      capped: capKbps > 0,
      dropShare: drop.share,
      legs,
      streamSeconds,
      lastOverflowAtSeconds
    })
    report.verdict = verdict
    report.pass = verdict.pass
    printSummary(report)
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`Report: ${reportPath}`)
    if (!verdict.pass && !measureOnly) {
      throw new Error(`Thin-uplink smoke (${variant}) failed: ${verdict.failures.join('; ')}`)
    }
    if (!verdict.pass) {
      console.log(`MEASURE-ONLY: ${verdict.failures.join('; ')}`)
    }
  } finally {
    ws.close()
  }
} finally {
  stopping = true
  if (proxy) await proxy.close()
  for (const listener of listeners) await stopListener(listener)
  await stopApp()
}

function streamPressureEvents(sample) {
  return (
    sample.encoderBridgeStreamQueueCapacityPressureEvents ??
    sample.encoderBridgeOutputQueueCapacityPressureEvents ??
    0
  )
}

function streamDroppedFrames(sample) {
  return (
    sample.encoderBridgeStreamQueueDroppedFrames ??
    sample.encoderBridgeOutputQueueDroppedFrames ??
    0
  )
}

function pickDiagnostics(sample) {
  const keys = Object.keys(sample).filter(
    (key) =>
      key.startsWith('encoderBridgeStream') ||
      key.startsWith('encoderBridgeOutputQueue') ||
      key.startsWith('encoderBridgeVideoToolbox') ||
      key.startsWith('stream') ||
      key.startsWith('recordingMeasured') ||
      key.startsWith('recordingOutput') ||
      key === 'microphoneSyncOffsetMs' ||
      key === 'encoderBridgeQueueDepth' ||
      key === 'encoderSpeed' ||
      key === 'renderFps' ||
      key === 'targetFps'
  )
  return Object.fromEntries(keys.map((key) => [key, sample[key]]))
}

function printSummary(result) {
  console.log('')
  console.log(`Thin uplink (${result.variant}) measurements`)
  console.log(
    `  bridge stream drops   ${result.streamDrop.dropped} of ${result.streamDrop.total} ` +
      `(${(result.streamDrop.share * 100).toFixed(1)} %)`
  )
  if (result.trip) {
    console.log(
      `  pressure trip         +${(result.trip.elapsedMs / 1000).toFixed(1)} s, queue depth ${result.trip.queueDepth}, ` +
        `oldest ${result.trip.oldestFrameAgeMs ?? 'n/a'} ms, high-water ${result.trip.queueHighWaterFrames} frames / ` +
        `${result.trip.oldestFrameAgeHighWaterMs ?? 'n/a'} ms, FIFO write p95 ${result.trip.fifoWriteP95Ms ?? 'n/a'} ms` +
        (result.trip.lastTrip ? `, tripped on ${result.trip.lastTrip}` : '')
    )
  } else {
    console.log('  pressure trip         never')
  }
  for (const leg of result.legs) {
    const received = leg.received
    console.log(
      `  ${leg.label.padEnd(8)} received ${received?.frames ?? 0} frames in ${received?.durationSeconds?.toFixed(1) ?? '0.0'} s ` +
        `(${received?.fps?.toFixed(1) ?? '0.0'} fps), gaps >1.5 frames: ${received?.gapCount ?? 0}, ` +
        `max gap ${received?.maxGapMs ?? 0} ms; last ${received?.tail?.tailSeconds ?? 0} s: ` +
        `${received?.tail?.fps?.toFixed(1) ?? '0.0'} fps, max gap ${received?.tail?.maxGapMs ?? 0} ms; ` +
        `FIFO queue full x${leg.overflowCount ?? 'unknown'}; ` +
        `overflow events ${leg.overflowEvents}; final ${leg.finalState ?? 'absent'}`
    )
  }
  if (result.unattributedOverflow > 0) {
    console.log(`  unattributed FIFO queue full lines: ${result.unattributedOverflow}`)
  }
  if (result.streamDelivery) {
    console.log(`  stream delivery       ${JSON.stringify(result.streamDelivery)}`)
  }
  if (result.bitrateTimeline?.length > 0) {
    console.log(
      `  stream bitrate        ${result.bitrateTimeline
        .map((step) => `${step.bitrateKbps ?? 'n/a'} kbps @${step.atSeconds}s`)
        .join(' -> ')}` +
        (result.lastOverflowAtSeconds !== null
          ? `; last overflow +${result.lastOverflowAtSeconds.toFixed(0)} s`
          : '; no overflow')
    )
  }
  for (const change of result.bitrateChanges ?? []) {
    console.log(`  ${change.code.padEnd(22)} ${change.message}`)
  }
  console.log(`  health codes          ${[...new Set(result.healthCodes)].join(', ') || 'none'}`)
  console.log('')
}

function readFfmpegLog(userData, sessionId) {
  const directory = join(userData, 'logs', 'ffmpeg')
  if (!existsSync(directory)) return { path: null, text: '' }
  const exact = join(directory, `${sessionId}.log`)
  if (existsSync(exact)) return { path: exact, text: readFileSync(exact, 'utf8') }
  const candidates = readdirSync(directory).filter((name) => name.endsWith('.log'))
  const path = candidates.length === 1 ? join(directory, candidates[0]) : null
  return { path, text: path ? readFileSync(path, 'utf8') : '' }
}

function sessionParams(outputDirectoryCapability) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const split = variant === 'split'
  return {
    sources: { testPattern: true, microphoneId },
    layout: {
      layoutPreset: 'screen-only',
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraCornerRadiusPct: 12,
      cameraAspect: 'source',
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
      recordEnabled: split,
      streamEnabled: true,
      ...(split ? { outputDirectoryCapability } : {}),
      video: split
        ? { preset: 'tutorial-1440p30', width: 2560, height: 1440, fps: FPS, bitrateKbps: 8000 }
        : {
            preset: 'stream-safe-1080p30',
            width: 1920,
            height: 1080,
            fps: FPS,
            bitrateKbps: STREAM_BITRATE_KBPS
          },
      rtmp: { preset: 'custom', serverUrl: targets[0].serverUrl, streamKey: targets[0].streamKey }
    },
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 },
    captions: { enabled: false },
    streaming: {
      enabled: true,
      mode: 'multi',
      targets: targets.map((target) => ({
        id: target.id,
        platform: target.platform,
        label: target.label,
        enabled: true,
        serverUrl: target.serverUrl,
        urlMode: 'server-and-key',
        streamKey: target.streamKey,
        streamKeyPresent: true,
        authMode: 'manual-rtmp',
        createdAt: timestamp,
        updatedAt: timestamp
      })),
      defaultOutputPreset: 'stream-safe-1080p30',
      defaultBitrateKbps: STREAM_BITRATE_KBPS,
      enabledTargetIds: targets.map((target) => target.id)
    }
  }
}

// One token bucket shared by every proxied leg: the loopback twin of a home
// uplink that carries `capKbps` in total. Bytes from the publisher wait for
// tokens before they reach the sink; while they wait the publisher's socket
// is paused, so its kernel send buffer fills and FFmpeg's fifo consumer
// thread blocks on write exactly as it would on a slow modem. The sink's
// replies (RTMP acks) are never throttled.
function startTokenBucketProxy(legs, kbps) {
  const bytesPerMs = (kbps * 1000) / 8 / 1000
  // A quarter second of burst: TCP slow start and the RTMP handshake pass.
  const burstBytes = Math.round(bytesPerMs * 250)
  const bucket = { tokens: burstBytes, lastRefillAt: Date.now() }
  const sockets = new Set()
  const servers = []
  let queue = Promise.resolve()

  const refill = () => {
    const now = Date.now()
    bucket.tokens = Math.min(burstBytes, bucket.tokens + (now - bucket.lastRefillAt) * bytesPerMs)
    bucket.lastRefillAt = now
  }
  // Serialises every chunk through the one bucket, in arrival order.
  const admit = (bytes) =>
    new Promise((resolveAdmit) => {
      queue = queue.then(
        () =>
          new Promise((resolveNext) => {
            const tick = () => {
              if (stopping) {
                resolveAdmit()
                resolveNext()
                return
              }
              refill()
              if (bucket.tokens >= bytes) {
                bucket.tokens -= bytes
                resolveAdmit()
                resolveNext()
                return
              }
              setTimeout(tick, Math.max(1, Math.ceil((bytes - bucket.tokens) / bytesPerMs)))
            }
            tick()
          })
      )
    })

  for (const leg of legs) {
    if (!leg.proxyPort) continue
    const server = net.createServer((client) => {
      const upstream = net.connect(leg.listenPort, '127.0.0.1')
      sockets.add(client)
      sockets.add(upstream)
      client.setNoDelay(true)
      upstream.setNoDelay(true)
      client.on('data', (chunk) => {
        client.pause()
        admit(chunk.length).then(() => {
          if (client.destroyed || upstream.destroyed) return
          upstream.write(chunk, () => {
            if (!client.destroyed) client.resume()
          })
        })
      })
      upstream.pipe(client)
      const cleanup = () => {
        sockets.delete(client)
        sockets.delete(upstream)
        client.destroy()
        upstream.destroy()
      }
      client.on('close', cleanup)
      client.on('error', cleanup)
      upstream.on('close', cleanup)
      upstream.on('error', cleanup)
    })
    servers.push(
      new Promise((resolveServer, rejectServer) => {
        server.once('error', rejectServer)
        server.listen(leg.proxyPort, '127.0.0.1', () => resolveServer(server))
      })
    )
  }
  return Promise.all(servers).then((listening) => ({
    close: () =>
      Promise.all(
        listening.map(
          (server) =>
            new Promise((resolveClose) => {
              for (const socket of sockets) socket.destroy()
              server.close(() => resolveClose())
            })
        )
      )
  }))
}

function spawnListener(target) {
  const proc = spawn(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      target.listenUrl,
      '-c',
      'copy',
      '-f',
      'flv',
      target.recvPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (text) => {
    if (stopping) return
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) console.error(`[listener :${target.listenPort}] ${line}`)
    }
  })
  return proc
}

function stopListener(proc) {
  return new Promise((resolveStop) => {
    if (!proc?.pid || proc.exitCode !== null) {
      resolveStop()
      return
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already gone
      }
      resolveStop()
    }, 4000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
    try {
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolveStop()
    }
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
