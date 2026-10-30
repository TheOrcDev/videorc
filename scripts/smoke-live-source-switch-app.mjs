import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchDevApp } from './lib/app-launcher.mjs'
import { startLinuxPulseFixtures } from './lib/linux-pulse-fixture.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import {
  decodeSourcePcm,
  evaluatePacketDts,
  evaluateSourceIdentity,
  measureSourceWindow,
  readSourcePackets,
  resolveSourceOutputAudioTiming,
  sourceSampleWindowStart
} from './lib/live-source-switch-gates.mjs'
import { probeMedia } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Phase S3 encoded-output gate. Synthetic sources enter through real native
// producer ownership, preparation, bus cutover, controls, FFmpeg and muxer.
// Physical-device, visual-source, A/V timing and endurance acceptance remain separate.
const pulseFixtures = process.argv.includes('--linux-pulse')
if (pulseFixtures && process.platform !== 'linux')
  throw new Error('The Pulse worker source-switch gate requires Linux.')
const mode = process.env.VIDEORC_SOURCE_SWITCH_MODE
if (!mode) {
  for (const nextMode of ['record', 'stream', 'combined']) {
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            VIDEORC_SOURCE_SWITCH_MODE: nextMode,
            ...(process.env.VIDEORC_SMOKE_OUTPUT_DIR
              ? { VIDEORC_SMOKE_OUTPUT_DIR: join(process.env.VIDEORC_SMOKE_OUTPUT_DIR, nextMode) }
              : {})
          }
        }
      )
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`${nextMode} source-switch gate failed (${code}).`))
      )
    })
  }
  process.exit(0)
}
assert.ok(['record', 'stream', 'combined'].includes(mode))
const recordEnabled = mode !== 'stream'
const streamEnabled = mode !== 'record'
const timeoutMs = 180000
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-live-sources-${Date.now()}`)
)
const reportPath = join(outputDirectory, 'live-source-switch-evidence.json')
let fixtureA = 'microphone:coreaudio:4294967295'
let fixtureB = 'microphone:coreaudio:4294967294'
let fixtures
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
mkdirSync(outputDirectory, { recursive: true })
let launched
let backend
let active = false
let receiver
const events = { recording: [], health: [], sources: [] }
const switches = []
let lostInput
let automaticRecovery
let outputAudioTiming
let report = {
  pass: false,
  scope: `${pulseFixtures ? 'linux-pulse-worker' : 'native'}-microphone-${mode}`,
  completePlanAcceptance: false
}

try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_APP_DATA_DIR: join(outputDirectory, 'app-data'),
      VIDEORC_USER_DATA_DIR: join(outputDirectory, 'user-data')
    }
  })
  if (pulseFixtures) {
    fixtures = await startLinuxPulseFixtures({ ffmpegPath })
    fixtureA = fixtures.sources[0].deviceId
    fixtureB = fixtures.sources[1].deviceId
  }
  backend = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  backend.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.event === 'recording.status')
      events.recording.push({ ...message.payload, receivedAt: Date.now() })
    if (message.event === 'health.event')
      events.health.push({ ...message.payload, receivedAt: Date.now() })
    if (message.event === 'session.sources.changed') events.sources.push(message.payload)
  })
  const smoke = launched.connections['preview-motion-ready']
  const authorization = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs }
  )
  if (streamEnabled) receiver = await startReceiver(join(outputDirectory, 'received.flv'))
  const started = await request(backend, timeoutMs, 'session.start', {
    sources: { testPattern: true, microphoneId: null },
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
      recordEnabled,
      streamEnabled,
      rtmp: {
        preset: 'custom',
        serverUrl: receiver?.serverUrl ?? '',
        streamKey: receiver?.streamKey ?? ''
      },
      outputDirectoryCapability: authorization.capabilityId,
      // Linux shares one encode for a combined session. Match the explicit
      // stream preset instead of accidentally testing unsupported split sizes.
      video: {
        preset: streamEnabled ? 'tutorial-1080p30' : 'custom',
        width: streamEnabled ? 1920 : 640,
        height: streamEnabled ? 1080 : 360,
        fps: 30,
        bitrateKbps: 2000
      }
    },
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 },
    captions: { enabled: false },
    ...(receiver
      ? {
          streaming: {
            enabled: true,
            mode: 'single',
            targets: [
              {
                id: 'custom',
                platform: 'custom',
                label: 'Local RTMP',
                enabled: true,
                serverUrl: receiver.serverUrl,
                urlMode: 'server-and-key',
                streamKey: receiver.streamKey,
                streamKeyPresent: true,
                authMode: 'manual-rtmp',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              }
            ],
            defaultOutputPreset: 'tutorial-1080p30',
            defaultBitrateKbps: 2000,
            enabledTargetIds: ['custom']
          }
        }
      : {})
  })
  assert.ok(['recording', 'streaming'].includes(started.state))
  assert.ok(started.sessionId && (!recordEnabled || started.outputPath))
  active = true
  const sessionId = started.sessionId
  let snapshot = await request(backend, timeoutMs, 'session.sources.get', { sessionId })
  const outputProcessId = snapshot.outputProcessId
  assert.ok(
    Number.isInteger(outputProcessId) && outputProcessId > 0,
    'Actual encoder process identity is required.'
  )
  assert.equal(snapshot.confirmed.microphoneId, null)
  await delay(900) // An intentional encoded silence measurement interval.

  for (const [index, deviceId] of [fixtureA, fixtureB, null, fixtureA, null].entries()) {
    const requestId = `encoded-switch-${index}`
    const params = {
      sessionId,
      requestId,
      expectedSourceRevision: snapshot.sourceRevision,
      kind: 'microphone',
      deviceId
    }
    const before = await request(backend, timeoutMs, 'recording.status', {})
    snapshot = await request(backend, timeoutMs, 'session.source.switch', params)
    assert.equal(
      snapshot.lastOperation?.stage,
      'applied',
      snapshot.lastOperation?.reason ?? 'Source was not applied.'
    )
    assert.equal(snapshot.confirmed.microphoneId, deviceId)
    assert.equal(
      snapshot.outputProcessId,
      outputProcessId,
      'A source change restarted the encoder.'
    )
    assert.equal(snapshot.audio?.lastCommit?.requestId, requestId)
    const duplicate = await request(backend, timeoutMs, 'session.source.switch', params)
    assert.equal(
      duplicate.sourceRevision,
      snapshot.sourceRevision,
      'A duplicate opened/committed another input.'
    )
    assert.equal(duplicate.outputProcessId, outputProcessId)
    assert.deepEqual(duplicate.audio?.lastCommit, snapshot.audio.lastCommit)
    assert.equal(duplicate.lastOperation?.requestId, requestId)
    const after = await request(backend, timeoutMs, 'recording.status', {})
    assert.equal(after.sessionId, sessionId)
    assert.equal(after.state, started.state)
    assert.equal(after.outputPath, before.outputPath)
    switches.push({
      requestId,
      deviceId,
      receipt: snapshot.audio.lastCommit,
      expectedFrequency: deviceId === fixtureA ? 440 : deviceId === fixtureB ? 880 : null
    })
    await delay(1000) // A complete post-cutover codec identity window.
    if (index === 0) {
      const evidence = await requestSmokeCommand(
        smoke,
        'backend-debug-rpc',
        {
          method: pulseFixtures ? 'audio.test.output-timing' : 'audio.test.disconnect',
          params: { sessionId, outputProcessId },
          timeoutMs
        },
        { timeoutMs }
      )
      if (pulseFixtures) await fixtures.sources[0].disconnect()
      else assert.equal(evidence.disconnected, true)
      outputAudioTiming = evidence.outputAudioTiming
      // Refuse absent/ambiguous evidence while the exact session is still
      // owned, before artifact measurements can report a false result.
      if (recordEnabled)
        resolveSourceOutputAudioTiming(outputAudioTiming, {
          sessionId,
          outputProcessId,
          role: 'local'
        })
      if (streamEnabled)
        resolveSourceOutputAudioTiming(outputAudioTiming, {
          sessionId,
          outputProcessId,
          role: 'stream'
        })
      const deadline = Date.now() + 3000
      do {
        snapshot = await request(backend, timeoutMs, 'session.sources.get', { sessionId })
        if (
          snapshot.health.some(
            (source) => source.kind === 'microphone' && source.health === 'unavailable'
          )
        )
          break
        await delay(20)
      } while (Date.now() < deadline)
      assert.ok(
        snapshot.health.some(
          (source) => source.kind === 'microphone' && source.health === 'unavailable'
        ),
        'Producer loss was not reported.'
      )
      assert.equal(
        snapshot.confirmed.microphoneId,
        fixtureA,
        'Loss must not silently select another device.'
      )
      lostInput = { sample: snapshot.audio.sampleCursor, generation: snapshot.audio.generation }
      if (pulseFixtures) {
        // Linux automatically tries to reopen a stopped worker. Keep the
        // source physically absent until that owned transaction finishes;
        // reconnecting it here raced the following user switch. Observe the
        // terminal receipt rather than sleeping through or retrying Busy.
        const lostSnapshot = snapshot
        const recoveryDeadline = Date.now() + 5000
        do {
          snapshot = await request(backend, timeoutMs, 'session.sources.get', { sessionId })
          if (
            !snapshot.pending &&
            snapshot.lastOperation?.requestId.startsWith('microphone-reopen-')
          )
            break
          await delay(20)
        } while (Date.now() < recoveryDeadline)
        assert.equal(snapshot.pending, null, 'Automatic microphone recovery did not settle.')
        assert.ok(
          snapshot.lastOperation?.requestId.startsWith('microphone-reopen-'),
          'Linux did not attempt to recover the stopped microphone worker.'
        )
        assert.equal(snapshot.lastOperation.stage, 'failed')
        assert.equal(snapshot.lastOperation.previousSource, 'unavailable')
        assert.equal(snapshot.sessionId, sessionId)
        assert.equal(snapshot.outputProcessId, outputProcessId)
        assert.equal(snapshot.sourceRevision, lostSnapshot.sourceRevision)
        assert.equal(snapshot.confirmed.microphoneId, fixtureA)
        assert.ok(
          snapshot.health.some(
            (source) => source.kind === 'microphone' && source.health === 'unavailable'
          ),
          'An absent microphone must remain unavailable after automatic recovery.'
        )
        automaticRecovery = snapshot.lastOperation
      }
      const failed = await request(backend, timeoutMs, 'session.source.switch', {
        sessionId,
        requestId: 'missing-after-loss',
        expectedSourceRevision: snapshot.sourceRevision,
        kind: 'microphone',
        deviceId: pulseFixtures
          ? `microphone:linux-pulse:${Buffer.from(`${fixtures.sources[0].source}_missing`).toString('hex')}`
          : 'microphone:coreaudio:4294967293'
      })
      assert.equal(failed.lastOperation.stage, 'failed')
      assert.equal(failed.lastOperation.previousSource, 'unavailable')
      assert.equal(failed.confirmed.microphoneId, fixtureA)
      assert.equal(failed.sourceRevision, snapshot.sourceRevision)
      await delay(1000) // Decode a silence window before successful replacement B.
      if (pulseFixtures) await fixtures.sources[0].reconnect()
    }
  }
  const stopRequestedAt = Date.now()
  const stopped = await request(backend, timeoutMs, 'session.stop', {})
  active = false
  const localFile = recordEnabled
    ? await resolveFinalRecordingPath({
        started,
        stopped,
        recordingStatusEvents: events.recording,
        healthEvents: events.health,
        stopRequestedAt,
        timeoutMs
      })
    : null
  assert.ok(!recordEnabled || localFile, 'Recording finalization did not produce a playable file.')
  const transport = await receiver?.stop()
  if (transport) {
    assert.equal(transport.connections, 1, 'The stream reconnected during source replacement.')
    assert.ok(!transport.error, transport.error)
  }
  const artifacts = []
  const failures = []
  for (const [leg, file] of [
    ['local', localFile],
    ['received', receiver?.file]
  ]) {
    if (!file) continue
    const [probe, pcm, packets] = await Promise.all([
      probeMedia(file, { ffprobePath }),
      decodeSourcePcm(file, { ffmpegPath }),
      readSourcePackets(file, { ffprobePath })
    ])
    assert.ok(
      probe.video && probe.audio.length === 1,
      'Each output must retain exactly one audio stream.'
    )
    assert.equal(probe.audio[0].sampleRate, 48000)
    assert.equal(probe.audio[0].channels, 2)
    failures.push(...evaluatePacketDts(packets).map((failure) => `${leg}: ${failure}`))
    const audioTiming = resolveSourceOutputAudioTiming(outputAudioTiming, {
      sessionId,
      outputProcessId,
      role: leg === 'local' ? 'local' : 'stream'
    })
    const audioOffsetSeconds = audioTiming.filterShiftMs / 1000
    const measurements = switches.map((operation) => {
      // AAC transform ringing has a separate exclusion window. The raw bus
      // regression proves the precise <=10ms ramp and excludes candidate preroll.
      const startSeconds = sourceSampleWindowStart(operation.receipt.cutoverSample, audioTiming)
      const measurement = measureSourceWindow(pcm, { startSeconds })
      const windowFailures = evaluateSourceIdentity(measurement, operation.expectedFrequency)
      failures.push(...windowFailures.map((failure) => `${leg}/${operation.requestId}: ${failure}`))
      return { ...operation, measurement, failures: windowFailures }
    })
    const initialSilence = measureSourceWindow(pcm, { startSeconds: 0.1 })
    failures.push(
      ...evaluateSourceIdentity(initialSilence, null).map((failure) => `${leg}: ${failure}`)
    )
    const lostSilence = measureSourceWindow(pcm, {
      startSeconds: sourceSampleWindowStart(lostInput.sample, audioTiming)
    })
    failures.push(
      ...evaluateSourceIdentity(lostSilence, null).map(
        (failure) => `${leg}/source-loss: ${failure}`
      )
    )
    artifacts.push({
      leg,
      file,
      probe,
      audioOffsetSeconds,
      audioTiming,
      measurements,
      initialSilence,
      lostSilence
    })
  }
  report = {
    ...report,
    pass: failures.length === 0,
    sessionId,
    outputProcessId,
    outputAudioTiming,
    transport,
    artifacts,
    lostInput,
    automaticRecovery,
    failures,
    events
  }
  assert.deepEqual(failures, [])
  console.log(
    `Live source switch ${mode} gate PASS${pulseFixtures ? ' (Linux Pulse workers)' : ''}: two decoded microphone identities, None, duplicate fencing, one encoder and monotonic DTS. Evidence: ${reportPath}`
  )
} catch (error) {
  report = {
    ...report,
    error: error instanceof Error ? error.message : String(error),
    events,
    switches,
    lostInput,
    automaticRecovery
  }
  throw error
} finally {
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  if (backend) {
    if (active) await request(backend, timeoutMs, 'session.stop', {}).catch(() => {})
    backend.close()
  }
  try {
    await receiver?.stop()
  } finally {
    try {
      await launched?.stop()
    } finally {
      await fixtures?.stop()
    }
  }
}

async function startReceiver(file) {
  // The proxy owns the public listening socket before session.start and counts
  // actual transport connections. It also backpressures until FFmpeg accepts.
  const reservation = createServer()
  await new Promise((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const sinkPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const child = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-y',
      '-listen',
      '1',
      '-f',
      'flv',
      '-i',
      `rtmp://127.0.0.1:${sinkPort}/live/source-switch`,
      '-c',
      'copy',
      '-f',
      'flv',
      file
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let stderr = ''
  let spawnError
  child.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-8192)
  })
  child.once('error', (error) => {
    spawnError = error
  })
  const closed = new Promise((resolve) => child.once('close', resolve))
  const sockets = new Set()
  let connections = 0
  let proxyFailure
  const proxy = createServer((incoming) => {
    connections += 1
    sockets.add(incoming)
    incoming.on('close', () => sockets.delete(incoming))
    incoming.on('error', () => {})
    incoming.pause()
    const deadline = Date.now() + 5000
    function connectSink() {
      if (incoming.destroyed) return
      const outgoing = createConnection({ host: '127.0.0.1', port: sinkPort })
      sockets.add(outgoing)
      outgoing.on('close', () => sockets.delete(outgoing))
      outgoing.once('connect', () => {
        outgoing.removeAllListeners('error')
        outgoing.on('error', (error) => {
          proxyFailure = error.message
          incoming.destroy()
        })
        incoming.pipe(outgoing).pipe(incoming)
        incoming.resume()
      })
      outgoing.once('error', (error) => {
        outgoing.destroy()
        if (Date.now() < deadline && child.exitCode === null && !spawnError)
          setTimeout(connectSink, 10)
        else {
          proxyFailure = spawnError?.message ?? error.message
          incoming.destroy()
        }
      })
    }
    connectSink()
  })
  await new Promise((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', resolve)
  })
  let finished = false
  return {
    serverUrl: `rtmp://127.0.0.1:${proxy.address().port}/live`,
    streamKey: 'source-switch',
    file,
    async stop() {
      if (!finished) {
        finished = true
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
        await closed
        clearTimeout(deadline)
        for (const socket of sockets) socket.destroy()
        await new Promise((resolve) => proxy.close(resolve))
      }
      return { connections, pid: child.pid, error: spawnError?.message ?? proxyFailure, stderr }
    }
  }
}
