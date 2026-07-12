import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// End-to-end proof of the multi-platform `tee` fan-out. Stands up one local
// FFmpeg RTMP listener per destination, drives a real record + simulcast
// session, and asserts bytes arrive at *every* healthy target while the local
// recording still finalizes.
// No Docker or external services: the listeners are plain `ffmpeg -listen 1`.

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-multistream-smoke-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ??
  mkdtempSync(join(tmpdir(), 'videorc-multistream-smoke-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const premiumMaxDestinations = Math.max(1, Number(process.env.VIDEORC_SMOKE_MAX_DESTINATIONS ?? 3))
const targetCount = Math.min(
  4,
  premiumMaxDestinations,
  Math.max(1, Number(process.env.VIDEORC_SMOKE_TARGETS ?? Math.min(2, premiumMaxDestinations)))
)
const basePort = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 11935)
const streamMs = Number(process.env.VIDEORC_SMOKE_STREAM_MS ?? 5000)
const listenerBindMs = Number(process.env.VIDEORC_SMOKE_LISTENER_BIND_MS ?? 2500)

const PLATFORMS = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'twitch', label: 'Twitch' },
  { id: 'x', label: 'X / Twitter' },
  { id: 'custom', label: 'Custom RTMP' }
]

const targets = Array.from({ length: targetCount }, (_, index) => {
  const port = basePort + index
  const platform = PLATFORMS[index % PLATFORMS.length]
  const streamKey = `smoke${index}`
  return {
    id: platform.id,
    platform: platform.id,
    label: platform.label,
    port,
    streamKey,
    serverUrl: `rtmp://127.0.0.1:${port}/live`,
    listenUrl: `rtmp://127.0.0.1:${port}/live/${streamKey}`,
    recvPath: join(outputDirectory, `recv-${port}.flv`)
  }
})

// A deliberately-broken destination (valid-looking credentials, but nothing
// listening on its port) proves the failure-handling guarantee: onfail=ignore drops
// the dead leg, the backend attributes the drop to this target and emits a
// stream.targets snapshot (M5), and every healthy leg keeps streaming.
const includeBadTarget =
  process.env.VIDEORC_SMOKE_NO_BAD_TARGET !== '1' &&
  targetCount < PLATFORMS.length &&
  targetCount < premiumMaxDestinations
const badTarget = includeBadTarget
  ? (() => {
      const platform = PLATFORMS[targetCount]
      const port = basePort + targetCount
      return {
        id: platform.id,
        platform: platform.id,
        label: `${platform.label} (offline)`,
        port,
        streamKey: 'smoke-offline',
        serverUrl: `rtmp://127.0.0.1:${port}/live`,
        listenUrl: null,
        recvPath: null
      }
    })()
  : null
const allTargets = badTarget ? [...targets, badTarget] : targets

mkdirSync(outputDirectory, { recursive: true })

let stopping = false
let stopApp = async () => {}
const listeners = []

try {
  // 1. Launch the dev app + backend first so the RTMP listeners only idle briefly
  //    before the publisher connects (a long idle can trip FFmpeg's accept timeout).
  const launch = await launchDevApp({
    env: {
      // Dev builds resolve to Developer entitlements (multistream enabled);
      // VIDEORC_PREMIUM_FEATURES is downgrade-only and unlocks nothing.
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => console.log(line)
  })
  stopApp = launch.stop
  const connection = launch.connections['backend-ready']
  const smoke = launch.connections['preview-motion-ready']

  // 2. Stand up one local RTMP listener per target.
  for (const target of targets) {
    listeners.push(spawnListener(target))
  }
  console.log(
    `Started ${targets.length} local RTMP listener(s): ${targets
      .map((t) => `${t.label} → :${t.port}`)
      .join(', ')}`
  )
  await sleep(listenerBindMs) // give the listeners time to bind their ports

  // 3. Drive a real record+stream session to every local target at once.
  const ws = await connectBackend(connection, timeoutMs)
  // Collect the per-target runtime snapshots the backend pushes (M5) so we can assert
  // the offline destination is reported failed while the healthy ones stay live.
  const targetSnapshots = []
  const diagnosticSamples = []
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message?.event === 'stream.targets' && Array.isArray(message.payload?.targets)) {
      targetSnapshots.push(message.payload.targets)
    }
    if (message?.event === 'diagnostics.stats') {
      diagnosticSamples.push(message.payload)
    }
  })
  try {
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the multistream smoke.')
    }
    console.log(`Multistream smoke using FFmpeg: ${ffmpegPath}`)

    const recordingDirectory = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { kind: 'output-directory', path: outputDirectory },
      { timeoutMs }
    )
    const started = await request(
      ws,
      timeoutMs,
      'session.start',
      multistreamParams(recordingDirectory.capabilityId)
    )
    if (started.state !== 'recording') {
      throw new Error(`Expected recording state after start, got ${started.state}.`)
    }
    console.log(
      `Record+stream session started; fanning one encode out to ${allTargets.length} target(s)` +
        `${badTarget ? ` (1 deliberately offline)` : ''}.`
    )
    console.log(`  stream targets: ${started.streamUrl ?? 'n/a'}`)

    await sleep(streamMs)

    const stopped = await request(ws, timeoutMs, 'session.stop')
    await sleep(2000) // let listeners flush + finalize their FLV after the publisher disconnects

    await verifyResults(
      stopped.outputPath ?? started.outputPath,
      targetSnapshots,
      diagnosticSamples
    )
  } finally {
    ws.close()
  }
} finally {
  stopping = true
  for (const listener of listeners) {
    await stopListener(listener)
  }
  await stopApp()
}

async function verifyResults(outputPath, targetSnapshots, diagnosticSamples) {
  const failures = []
  for (const target of targets) {
    const size = existsSync(target.recvPath) ? statSync(target.recvPath).size : 0
    if (size > 0) {
      console.log(`  ✓ ${target.label} (:${target.port}) received ${size} bytes`)
      // Plan 023 L3: the STREAM leg's artifact passes the same PTS/pacing
      // gates as the recording — a platform receiving wallclock-stamped or
      // bursty video must fail here, not in a viewer's VOD. A/V skew stays
      // exempt for the same reason as the recording (untrimmed sine harness
      // audio); real-audio sync is the device baseline's job.
      const streamQuality = await analyzeRecording(target.recvPath, {
        ffmpegPath,
        ffprobePath: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe',
        intendedFps: 30,
        expectAudio: false,
        gates: {
          requireMotion: false,
          avSyncTargetMs: Number.POSITIVE_INFINITY,
          avSyncHardFailMs: Number.POSITIVE_INFINITY,
          // The aux 1080p companion renders well below target fps in DEBUG
          // builds (software scale on a loaded machine) — throughput is the
          // release-build device baseline's gate. What must hold HERE is
          // timestamp sanity: no duplicate stamps, monotonic PTS, no audio
          // gaps — the wallclock pathology can never reach a platform again.
          frameCountTolerance: Number.POSITIVE_INFINITY,
          maxDurationStretchRatio: Number.POSITIVE_INFINITY
        }
      })
      if (streamQuality.verdict.pass) {
        console.log(`  ✓ ${target.label} stream artifact quality gates pass`)
      } else {
        for (const failure of streamQuality.verdict.failures) {
          console.log(`  ✗ ${target.label} stream quality: ${failure}`)
        }
        failures.push(
          `${target.label} stream artifact failed quality gates: ${streamQuality.verdict.failures.join('; ')}`
        )
      }
    } else {
      console.log(`  ✗ ${target.label} (:${target.port}) received no bytes`)
      failures.push(`${target.label} received no bytes`)
    }
  }

  const recordingSize = outputPath && existsSync(outputPath) ? statSync(outputPath).size : 0
  if (recordingSize > 0) {
    console.log(`  ✓ Local recording finalized: ${outputPath} (${recordingSize} bytes)`)
    // Plan 023 L0: a record+stream artifact must pass the QUALITY gates, not
    // just exist — the split-output wallclock path shipped 9fps duplicate-PTS
    // recordings behind this smoke's bytes>0 check.
    const quality = await analyzeRecording(outputPath, {
      ffmpegPath,
      ffprobePath: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe',
      intendedFps: 30,
      expectAudio: false,
      // The smoke's sine test-tone starts with ffmpeg while video starts at
      // compositor-ready — REAL sessions epoch-trim audio to the first video
      // frame (owner incident file: starts within 5ms), so A/V skew against
      // untrimmed harness audio is meaningless here. Per-leg sync with real
      // audio is the split baseline's job (plan 023 L3). PTS/pacing/count
      // gates stay armed — they are what catches the wallclock pathology.
      gates: {
        requireMotion: false,
        avSyncTargetMs: Number.POSITIVE_INFINITY,
        avSyncHardFailMs: Number.POSITIVE_INFINITY
      }
    })
    if (quality.verdict.pass) {
      console.log('  ✓ Local recording quality gates pass (pacing, PTS, duration)')
    } else {
      for (const failure of quality.verdict.failures) {
        console.log(`  ✗ recording quality: ${failure}`)
      }
      failures.push(`Local recording failed quality gates: ${quality.verdict.failures.join('; ')}`)
    }
  } else {
    console.log(`  ✗ Local recording missing/empty: ${outputPath ?? 'no path'}`)
    failures.push('Local recording did not finalize')
  }

  const duplicateSamples = diagnosticSamples.filter(
    (sample) =>
      Array.isArray(sample?.duplicateCaptureSources) && sample.duplicateCaptureSources.length > 0
  )
  if (duplicateSamples.length > 0) {
    console.log(`  ✗ duplicate capture appeared in ${duplicateSamples.length} diagnostic sample(s)`)
    failures.push('record+stream bridge reported duplicate capture diagnostics')
  } else {
    console.log('  ✓ Record+stream bridge reported no duplicate capture diagnostics')
  }

  // M5 failure-handling: the offline leg must be reported failed while the healthy
  // legs report live in the latest per-target snapshot.
  if (badTarget) {
    const latest = targetSnapshots.at(-1)
    if (!latest) {
      console.log('  ✗ no stream.targets snapshot was emitted')
      failures.push('no stream.targets snapshot emitted')
    } else {
      const badRuntime = latest.find((entry) => entry.targetId === badTarget.id)
      if (badRuntime?.state === 'failed') {
        console.log(
          `  ✓ ${badTarget.label} reported "failed" — dead leg dropped, others kept streaming`
        )
      } else {
        console.log(
          `  ✗ ${badTarget.label} should report failed, got ${badRuntime?.state ?? 'absent'}`
        )
        failures.push(`offline target not reported failed (${badRuntime?.state ?? 'absent'})`)
      }
      for (const good of targets) {
        const runtime = latest.find((entry) => entry.targetId === good.id)
        if (runtime?.state !== 'live') {
          console.log(
            `  ✗ ${good.label} should be live in snapshot, got ${runtime?.state ?? 'absent'}`
          )
          failures.push(`${good.label} not live in snapshot`)
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Multistream smoke failed: ${failures.join('; ')}`)
  }

  console.log(
    `Multistream smoke OK — one record+stream encode fanned out to all ${targets.length} healthy RTMP target(s),` +
      `${badTarget ? ' the offline leg was isolated,' : ''} and the local recording finalized.`
  )
}

function multistreamParams(outputDirectoryCapability) {
  const timestamp = '2026-01-01T00:00:00.000Z'
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
      video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
      // Legacy single-RTMP bridge fields. Ignored when `streaming` is present, but
      // kept valid so the fallback path never chokes on empty credentials.
      rtmp: { preset: 'custom', serverUrl: targets[0].serverUrl, streamKey: targets[0].streamKey }
    },
    streaming: {
      enabled: true,
      mode: allTargets.length > 1 ? 'multi' : 'single',
      targets: allTargets.map((target) => ({
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
      defaultOutputPreset: 'tutorial-1080p30',
      defaultBitrateKbps: 6000,
      enabledTargetIds: allTargets.map((target) => target.id)
    }
  }
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
    if (stopping) {
      return
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        console.error(`[listener :${target.port}] ${line}`)
      }
    }
  })
  return proc
}

function stopListener(proc) {
  return new Promise((resolveStop) => {
    if (!proc?.pid || proc.killed) {
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
    }, 2000)
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
