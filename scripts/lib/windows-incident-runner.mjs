import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  openSync,
  readSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { arch, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createIncidentReadyParser,
  incidentAudioPath,
  incidentAudioEnvironment,
  incidentSessionEvidence,
  incidentAdapterInventory,
  executeIncidentAttempt,
  incidentProcessGroups,
  incidentSessionParams,
  parseWindowsIncidentArgs,
  validateIncidentAudibleInterior
} from './windows-incident-matrix.mjs'
import {
  assertWindowsStreamSelectionEnvironmentIsRunnerOwned,
  redactWindowsStreamSecrets
} from './windows-stream-performance.mjs'

import { probeIncidentPacketTail } from './windows-incident-packet-tail.mjs'

const rpcDeadlineMs = 45000
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const reason = (error) =>
  String(error?.message ?? error).replace(
    /\b(?:https?|wss?):\/\/[^\s"'<>]+/giu,
    '[redacted-service-url]'
  )

function save(path, value, secrets = []) {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(redactWindowsStreamSecrets(value, secrets), null, 2))
  renameSync(temporary, path)
}

export async function runWindowsIncident(argv) {
  const options = parseWindowsIncidentArgs(argv)
  if (options.list) {
    console.log('Windows incident diagnostics (not protected performance qualification)')
    for (const scenario of options.scenarios)
      console.log(
        `${scenario.id}: ${scenario.width}x${scenario.height}@30 6000kbps; ${scenario.receivers} owned receiver(s); record=${scenario.recordEnabled}; 3 repetitions; preview=${scenario.preview}`
      )
    console.log(`${options.scenarios.length} cases, ${options.scenarios.length * 3} attempts`)
    return 0
  }
  const output = resolve(options.output ?? join(tmpdir(), `videorc-windows-incident-${Date.now()}`))
  if (existsSync(output) && readdirSync(output).length)
    throw new Error('Incident output directory must be empty; previous evidence is immutable')
  mkdirSync(output, { recursive: true })
  const aggregate = {
    schemaVersion: 1,
    kind: 'videorc.windows-startup-incident',
    scope:
      'diagnostic-backend-synthetic-motion; not installed-candidate qualification or provider acceptance',
    platform: process.platform,
    osRelease: release(),
    architecture: arch(),
    generatedAt: new Date().toISOString(),
    appIdentity: { state: 'not-used', reason: 'Standalone backend; no Electron app involved' },
    backendIdentity: null,
    ffmpegIdentity: null,
    scenarios: options.scenarios,
    groups: [],
    runs: [],
    verdict: 'INCOMPLETE'
  }
  const reportPath = join(output, 'incident-report.json')
  save(reportPath, aggregate)
  if (process.platform !== 'win32') {
    aggregate.verdict = 'BLOCKED'
    aggregate.reason =
      'Windows is required; macOS results cannot replace the DirectShow/Windows evidence.'
    save(reportPath, aggregate)
    console.error(aggregate.reason)
    return 2
  }
  const backendPath = resolve(
    options.backend ??
      join(process.env.CARGO_TARGET_DIR ?? 'target', 'debug', 'videorc-backend.exe')
  )
  const ffmpegPath = resolve(
    process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'vendor/ffmpeg/windows-x64/bin/ffmpeg.exe'
  )
  const ffprobePath = resolve(
    process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? join(dirname(ffmpegPath), 'ffprobe.exe')
  )
  try {
    assertWindowsStreamSelectionEnvironmentIsRunnerOwned(process.env)
    if (process.env.VIDEORC_INCIDENT_WORKER_OPEN_FAILURE)
      throw new Error('Worker failure injection is runner-owned')
    for (const path of [backendPath, ffmpegPath, ffprobePath])
      if (!existsSync(path)) throw new Blocked(`Required executable missing: ${path}`)
    const capabilities = spawnSync(backendPath, ['--windows-incident-capabilities'], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 16000,
      windowsHide: true
    })
    if (capabilities.status !== 0)
      throw new Blocked('Backend does not support incident diagnostics')
    let capability
    try {
      capability = JSON.parse(capabilities.stdout)
    } catch {
      throw new Blocked('Backend diagnostic capability reply unavailable')
    }
    if (capability.debugBuild !== true)
      throw new Blocked(
        'Incident harness requires a debug backend; release binaries ignore worker failure injection'
      )
    if (
      options.scenarios.some((scenario) => scenario.audio === 'ffmpeg-control') &&
      capability.ffmpegToneControl !== true
    )
      throw new Blocked('Backend does not support the independently gated FFmpeg tone control')
    aggregate.backendCapabilities = capability
    const version = spawnSync(ffmpegPath, ['-version'], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 64000,
      windowsHide: true
    })
    if (version.status !== 0) throw new Error('FFmpeg version probe failed')
    const adapters = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterCompatibility,VideoProcessor | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 32000 }
    )
    aggregate.adapters = incidentAdapterInventory(adapters)
    aggregate.backendIdentity = {
      sha256: hash(backendPath),
      sourceCommit: null,
      sourceCommitProvenance: 'unknown; never inferred from wrapper checkout',
      executable: 'explicitly spawned diagnostic backend'
    }
    aggregate.ffmpegIdentity = {
      sha256: hash(ffmpegPath),
      ffprobeSha256: hash(ffprobePath),
      version: version.stdout.split(/\r?\n/)[0]
    }
    save(reportPath, aggregate)
    const [{ devAppSpawnOptions, stopProcess }, { connectBackend, request }, { analyzeRecording }] =
      await Promise.all([
        import('./app-launcher.mjs'),
        import('../smoke-recording-session.mjs'),
        import('./recording-analyzer.mjs')
      ])
    const runtime = { devAppSpawnOptions, stopProcess, connectBackend, request, analyzeRecording }
    for (const scenario of options.scenarios) {
      const caseRoot = join(output, scenario.id)
      mkdirSync(caseRoot, { recursive: true })
      for (const repetitions of incidentProcessGroups(scenario)) {
        const group = {
          id: randomUUID(),
          scenario: scenario.id,
          repetitions,
          backendPid: null,
          cleanup: null
        }
        aggregate.groups.push(group)
        let backend
        let unsafeReceiver = false
        try {
          backend = await launchBackend({
            runtime,
            backendPath,
            ffmpegPath,
            ffprobePath,
            root: caseRoot,
            injectFailure: scenario.audio === 'direct-fallback',
            audio: scenario.audio
          })
          group.backendPid = backend.child.pid
          group.backendVersion = backend.health.version
          if (['worker', 'direct-fallback'].includes(scenario.audio)) {
            if (!options.microphone)
              throw new Blocked(
                'A real microphone must be selected with --microphone; sine is not worker/fallback evidence'
              )
            const devices = await request(backend.ws, rpcDeadlineMs, 'devices.list', { ffmpegPath })
            if (
              !devices.devices?.some(
                (device) =>
                  device.id === options.microphone &&
                  device.kind === 'microphone' &&
                  device.status === 'available'
              )
            )
              throw new Blocked('Selected microphone is unavailable')
            const worker = join(dirname(ffmpegPath), 'ffmpeg-capture.exe')
            if (!existsSync(worker))
              throw new Blocked(
                'A sibling capture-worker binary is required for worker/fallback cases'
              )
            group.captureWorkerIdentity = {
              sha256: hash(worker),
              provenance:
                'present sibling binary; worker protocol is exercised only when the worker path actually opens',
              injectionBypassesWorkerOpen: scenario.audio === 'direct-fallback'
            }
          }
          for (const repetition of repetitions) {
            const runDirectory = join(caseRoot, `run-${repetition}`)
            mkdirSync(runDirectory, { recursive: true })
            const run = await runAttempt({
              runtime,
              backend,
              scenario,
              repetition,
              runDirectory,
              ffmpegPath,
              ffprobePath,
              microphone: options.microphone
            })
            Object.assign(run, {
              scenario: scenario.id,
              repetition,
              backendInstanceId: group.id,
              backendPid: group.backendPid
            })
            aggregate.runs.push(run)
            save(join(runDirectory, 'report.json'), run)
            save(reportPath, aggregate)
            console.log(
              `${scenario.id} #${repetition}: ${run.verdict.pass ? 'PASS' : 'FAIL'} ${run.verdict.failures.join('; ')}`
            )
            unsafeReceiver = run.unsafeCleanup === true || run.cleanup.receiversReaped !== true
            if (!run.cleanup.sessionIdle || unsafeReceiver)
              throw new Error('Unsafe cleanup; retiring this backend before any retry')
          }
        } catch (error) {
          if (error instanceof UnsafeCleanup) unsafeReceiver = true
          for (const repetition of repetitions) {
            if (
              !aggregate.runs.some(
                (run) => run.scenario === scenario.id && run.repetition === repetition
              )
            )
              aggregate.runs.push({
                scenario: scenario.id,
                repetition,
                backendInstanceId: group.id,
                backendPid: group.backendPid,
                state: error instanceof Blocked ? 'BLOCKED' : 'FAILED',
                reason: reason(error),
                verdict: { pass: false, failures: [reason(error)] }
              })
          }
        } finally {
          if (backend) {
            backend.ws.close()
            try {
              group.cleanup = await stopProcess(backend.child)
            } catch (error) {
              group.cleanup = { state: 'leaked', reason: reason(error) }
            }
          } else group.cleanup = { state: 'not-started' }
          save(reportPath, aggregate)
        }
        if (unsafeReceiver)
          throw new Error('Owned receiver cleanup failed; refusing additional processes')
        if (group.cleanup.state === 'leaked')
          throw new Error('Owned backend cleanup failed; refusing additional processes')
      }
    }
    aggregate.verdict = incidentAggregateVerdict(aggregate.runs, options.scenarios.length * 3)
  } catch (error) {
    aggregate.verdict = error instanceof Blocked ? 'BLOCKED' : 'FAIL'
    aggregate.reason = reason(error)
  }
  save(reportPath, aggregate)
  console.log(`Incident diagnostics ${aggregate.verdict}: ${reportPath}`)
  return aggregate.verdict === 'PASS' ? 0 : aggregate.verdict === 'BLOCKED' ? 2 : 1
}

class Blocked extends Error {}
class UnsafeCleanup extends Error {
  unsafeCleanup = true
}

export function incidentAggregateVerdict(runs, expected) {
  if (runs.some((run) => !run.verdict.pass && run.state !== 'BLOCKED')) return 'FAIL'
  if (runs.length !== expected || runs.some((run) => run.state === 'BLOCKED')) return 'BLOCKED'
  return 'PASS'
}

export function incidentBackendEnvironment({
  inherited,
  ffmpegPath,
  ffprobePath,
  root,
  injectFailure,
  audio
}) {
  return {
    ...inherited,
    ...incidentAudioEnvironment(audio),
    VIDEORC_BUNDLED_FFMPEG_PATH: ffmpegPath,
    VIDEORC_BUNDLED_FFPROBE_PATH: ffprobePath,
    VIDEORC_DATABASE_PATH: join(root, 'videorc.sqlite3'),
    VIDEORC_RECORDINGS_DIR: join(root, 'recordings'),
    VIDEORC_SECRETS_PATH: join(root, 'secrets.json'),
    VIDEORC_ENABLE_SMOKE_RPC: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1',
    VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'raw-yuv420p',
    VIDEORC_WINDOWS_D3D11_MEDIA: '0',
    VIDEORC_INCIDENT_WORKER_OPEN_FAILURE: injectFailure ? '1' : '0'
  }
}

async function launchBackend({
  runtime,
  backendPath,
  ffmpegPath,
  ffprobePath,
  root,
  injectFailure,
  audio
}) {
  const env = incidentBackendEnvironment({
    inherited: process.env,
    ffmpegPath,
    ffprobePath,
    root,
    injectFailure,
    audio
  })
  const child = spawn(backendPath, [], {
    ...runtime.devAppSpawnOptions({ env }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  const bootstrapSecrets = []
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16000)
  })
  try {
    const ready = await new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => finish(rejectReady, new Error('Backend READY deadline exceeded')),
        30000
      )
      const finish = (callback, result) => {
        clearTimeout(timeout)
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
        callback(result)
      }
      const onError = (error) => finish(rejectReady, error)
      const onExit = () => finish(rejectReady, new Error('Backend exited before READY'))
      const onData = createIncidentReadyParser(
        (value) => {
          bootstrapSecrets.push(value.token, value.adminToken)
          finish(resolveReady, value)
        },
        (error) => finish(rejectReady, error)
      )
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })
    child.stdout.resume()
    if (!ready.adminToken)
      throw new Blocked('Diagnostic backend private admin bootstrap unavailable')
    const ws = await runtime.connectBackend({ ...ready, token: ready.adminToken }, rpcDeadlineMs)
    const health = await runtime.request(ws, rpcDeadlineMs, 'health.ping', { ffmpegPath })
    if (!health.ffmpeg?.available) {
      ws.close()
      throw new Error('Selected FFmpeg failed backend health')
    }
    return {
      child,
      ws,
      health,
      stderr: () => redactWindowsStreamSecrets(stderr, [ready.token, ready.adminToken])
    }
  } catch (error) {
    const message = redactWindowsStreamSecrets(reason(error), bootstrapSecrets)
    try {
      await runtime.stopProcess(child)
    } catch (cleanupError) {
      throw new UnsafeCleanup(
        `${message}; owned backend cleanup failed: ${redactWindowsStreamSecrets(reason(cleanupError), bootstrapSecrets)}`
      )
    }
    throw error instanceof Blocked ? new Blocked(message) : new Error(message)
  }
}

async function runAttempt({
  runtime,
  backend,
  scenario,
  runDirectory,
  ffmpegPath,
  ffprobePath,
  microphone
}) {
  const receivers = []
  const secrets = []
  const events = []
  let eventOverflow = false
  let sessionId = null
  let session = null
  let firstPcm = null
  const begin = performance.now()
  const onMessage = (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (!message.event) return
    if (message.event === 'recording.status' && message.payload?.state === 'starting')
      sessionId = message.payload.sessionId
    if (message.payload?.sessionId && sessionId && message.payload.sessionId !== sessionId) return
    if (
      sessionId &&
      message.payload?.sessionId === sessionId &&
      message.event === 'diagnostics.stats' &&
      message.payload?.micCapturedFrames > 0 &&
      !firstPcm
    )
      firstPcm = {
        observedAtMs: performance.now() - begin,
        frames: message.payload.micCapturedFrames,
        provenance:
          'backend captured PCM counter; observation timestamp, not exact first-sample time'
      }
    if (events.length >= 1024 || JSON.stringify(message).length > 32000) {
      eventOverflow = true
      return
    }
    events.push({ atMs: performance.now() - begin, event: message.event, payload: message.payload })
  }
  backend.ws.addEventListener('message', onMessage)
  const rpc = (method, params = {}) => runtime.request(backend.ws, rpcDeadlineMs, method, params)
  let idle = false
  try {
    const run = await executeIncidentAttempt(scenario, {
      start: async () => {
        for (let index = 0; index < scenario.receivers; index++) {
          const receiver = await createReceiver(
            runtime,
            ffmpegPath,
            join(runDirectory, `receiver-${index + 1}.flv`)
          )
          receivers.push(receiver)
          secrets.push(receiver.streamKey, receiver.url)
        }
        const params = incidentSessionParams(
          scenario,
          receivers,
          ['controlled', 'ffmpeg-control'].includes(scenario.audio) ? null : microphone
        )
        params.output.ffmpegPath = ffmpegPath
        params.output.outputDirectory = join(runDirectory, 'recordings')
        const started = await rpc('session.start', params)
        sessionId ??= started.sessionId
        return started
      },
      measure: async () => {
        await delay(scenario.durationMs)
      },
      stop: async () => {
        const status = await rpc('recording.status')
        if (['starting', 'recording', 'streaming', 'stopping'].includes(status.state))
          await rpc('session.stop')
        const deadline = performance.now() + 15000
        while (performance.now() < deadline) {
          const current = await rpc('recording.status')
          if (current.state === 'idle' || current.state === 'failed') {
            idle = true
            break
          }
          await delay(100)
        }
        return { sessionIdle: idle }
      },
      collect: async () => {
        const deadline = performance.now() + 30000
        let sessionPage = { items: [] }
        let logPage = { entries: [] }
        do {
          sessionPage = await rpc('sessions.list', { limit: 100 })
          session = sessionPage.items?.find((item) => item.id === sessionId) ?? null
          if (sessionId) logPage = await rpc('sessions.logs.list', { sessionId, limit: 500 })
          if (
            session?.endedAt &&
            (!scenario.recordEnabled || session.mp4Path || session.status === 'failed')
          )
            break
          if (!sessionId) break
          await delay(100)
        } while (performance.now() < deadline)
        const bundle = await rpc('diagnostics.supportBundle.export', {
          ffmpegPath,
          outputDirectory: runDirectory
        })
        const retained = incidentSessionEvidence(
          sessionPage,
          logPage,
          readBoundedSupportBundle(bundle.path),
          sessionId
        )
        session = retained.session
        const logs = retained.logs
        const diagnostic = session?.finalDiagnostics
        const log = (code) => logs.find((item) => item.code === code)?.message ?? null
        const fallbackReason = log('microphone-capture-worker-fallback')
        const observedAudio = incidentAudioPath(
          fallbackReason,
          firstPcm,
          scenario.audio,
          Boolean(log('incident-ffmpeg-tone-enabled'))
        )

        return {
          sessionId,
          finalDiagnostics: diagnostic ?? null,
          sessionStatus: session?.status ?? null,
          ffmpegStartup: log('ffmpeg-startup-evidence'),
          ffmpegTail: log('ffmpeg-stderr-tail'),
          startTimeline: diagnostic?.recordingStartTimeline ?? log('recording-start-timeline'),
          stopTimeline: diagnostic?.recordingStopTimeline ?? log('recording-stop-timeline'),
          bridgeFrames: diagnostic?.encoderBridgeRawVideoCopiedFrames ?? null,
          bridgeBytes: { state: 'unknown', reason: 'Raw bridge byte counter is not exported' },
          effectiveEncoder:
            diagnostic?.encodeBackend === 'software-open-h264'
              ? 'libopenh264'
              : (diagnostic?.encodeBackend ?? null),
          effectiveOutput: diagnostic?.encoderBridgeEffectiveVideoOutput ?? null,
          firstPcm: firstPcm ?? {
            state: 'unknown',
            reason:
              'No session PCM counter was observed; direct DirectShow input PCM is not exported'
          },
          audioPath: observedAudio,
          audioInputProvenance:
            scenario.audio === 'controlled'
              ? 'Portable debug native PCM fixture: continuous 440 Hz tone; coreaudio-prefixed fixture ID does not mean physical CoreAudio capture'
              : scenario.audio === 'ffmpeg-control'
                ? 'Independent 880 Hz tone on its own paced PCM FIFO; native PCM capture bus bypassed, no physical microphone selected'
                : 'Selected physical Windows microphone',
          fallbackReason,
          milestones: events,
          logs,
          eventOverflow,
          backendStderr: backend.stderr(),
          supportBundle: bundle.path,
          inputOpenedAtMs: null,
          encoderInitializedAtMs: null,
          outputOpenedAtMs: null,
          receiverFirstMedia: receivers.map((receiver, index) => ({
            role: `receiver-${index + 1}`,
            elapsedSinceReceiverSpawnMs: receiver.firstMediaAtMs,
            provenance: 'positive receiver media clock observed; not exact output-open time'
          })),
          requestedProfile: {
            width: scenario.width,
            height: scenario.height,
            fps: scenario.fps,
            bitrateKbps: scenario.bitrateKbps
          },
          requestedEncoder: 'libopenh264',
          requestedOutput: 'raw-yuv420p'
        }
      },
      reap: () => reapIncidentReceivers(receivers, runtime.stopProcess),
      analyze: async () => {
        const paths = [
          ...(session?.mp4Path ? [{ role: 'recording', path: session.mp4Path }] : []),
          ...receivers.map((receiver, index) => ({
            role: `receiver-${index + 1}`,
            path: receiver.path
          }))
        ]
        const reports = []
        for (const artifact of paths) {
          try {
            const analysis = await runtime.analyzeRecording(artifact.path, {
              ffmpegPath,
              ffprobePath,
              intendedFps: scenario.fps,
              expectAudio: true,
              gates: { requireNoDigitalZeroRuns: true, maxTailMismatchMs: 100 }
            })
            const audibleInterior = validateIncidentAudibleInterior(scenario, analysis)
            analysis.incidentAudibleInterior = audibleInterior
            const packetTail = probeIncidentPacketTail(artifact.path, ffprobePath)
            analysis.incidentPacketTail = packetTail
            if (!packetTail.pass) {
              analysis.verdict.pass = false
              analysis.verdict.failures.push(packetTail.reason)
            }
            if (!audibleInterior.pass) {
              analysis.verdict.pass = false
              analysis.verdict.failures.push(audibleInterior.reason)
            }
            save(join(runDirectory, `${artifact.role}.analysis.json`), analysis, secrets)
            reports.push({
              ...artifact,
              sha256: hash(artifact.path),
              verdict: analysis.verdict.pass ? 'PASS' : 'FAIL',
              width: analysis.probe.video?.width,
              height: analysis.probe.video?.height,
              hasAudio: analysis.probe.audio?.length > 0,
              metrics: analysis.metrics,
              packetTail,
              failures: analysis.verdict.failures,
              avSyncMethod: 'encoded stream timestamp skew; perceptual source offset not measured'
            })
          } catch (error) {
            reports.push({ ...artifact, verdict: 'FAIL', reason: reason(error) })
          }
        }
        return reports
      }
    })
    if (run.unsafeCleanup) run.cleanup.receiversReaped = false
    if (eventOverflow) {
      run.verdict.pass = false
      run.verdict.failures.push('Diagnostic event limit exceeded; evidence incomplete')
    }
    return redactWindowsStreamSecrets(run, secrets)
  } finally {
    backend.ws.removeEventListener('message', onMessage)
  }
}

async function createReceiver(runtime, ffmpegPath, path) {
  const port = await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => (error ? rejectPort(error) : resolvePort(port)))
    })
  })
  const streamKey = randomBytes(24).toString('base64url')
  const serverUrl = `rtmp://127.0.0.1:${port}/live`
  const url = `${serverUrl}/${streamKey}`
  const child = spawn(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-progress',
      'pipe:2',
      '-listen',
      '1',
      '-i',
      url,
      '-map',
      '0',
      '-c',
      'copy',
      '-f',
      'flv',
      path
    ],
    {
      ...runtime.devAppSpawnOptions({ env: process.env }),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    }
  )
  let spawnFailure = null
  child.on('error', (error) => {
    spawnFailure = error
  })
  const receiver = { child, path, port, streamKey, serverUrl, url, firstMediaAtMs: null }
  const spawned = performance.now()
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16000)
    if (receiver.firstMediaAtMs === null && /out_time_us=[1-9][0-9]*/.test(stderr))
      receiver.firstMediaAtMs = performance.now() - spawned
  })
  receiver.stderr = () => redactWindowsStreamSecrets(stderr, [streamKey, url])
  try {
    await waitIncidentSpawn(child, 10000)
    const deadline = performance.now() + 10000
    while (performance.now() < deadline) {
      if (spawnFailure) throw spawnFailure
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Owned RTMP receiver exited before listening')
      const inspected = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      )
      if (inspected.status === 0 && inspected.stdout.trim() === String(child.pid)) return receiver
      await delay(50)
    }
    throw new Error('Could not prove loopback receiver listener belongs to the spawned PID')
  } catch (error) {
    try {
      await runtime.stopProcess(child)
    } catch (cleanupError) {
      throw new UnsafeCleanup(
        `Receiver startup failed: ${reason(error)}; owned cleanup failed: ${reason(cleanupError)}`
      )
    }
    throw error
  }
}

function waitExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off('exit', exited)
      resolveExit(false)
    }, timeoutMs)
    const exited = () => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once('exit', exited)
  })
}

export function waitIncidentSpawn(child, timeoutMs) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const finish = (error) => {
      clearTimeout(timer)
      child.off('spawn', spawned)
      child.off('error', failed)
      error ? rejectSpawn(error) : resolveSpawn()
    }
    const spawned = () => finish()
    const failed = (error) => finish(error)
    const timer = setTimeout(
      () => finish(new Error('Owned child spawn deadline exceeded')),
      timeoutMs
    )
    child.once('spawn', spawned)
    child.once('error', failed)
  })
}

export async function reapIncidentReceivers(receivers, stopProcess, waitForExit = waitExit) {
  const receiverResults = await Promise.all(
    receivers.map(async (receiver, index) => {
      let cleanup
      try {
        const exited = await waitForExit(receiver.child, 10000)
        cleanup = exited
          ? { state: 'exited', childExited: true, exitCode: receiver.child.exitCode }
          : await stopProcess(receiver.child)
      } catch (error) {
        cleanup = { state: 'leaked', childExited: false, reason: reason(error) }
      }
      return { role: `receiver-${index + 1}`, cleanup, stderr: receiver.stderr() }
    })
  )
  return {
    receiversReaped: receiverResults.every((item) => item.cleanup.childExited === true),
    receiverResults
  }
}

function readBoundedSupportBundle(path) {
  const maximum = 16 * 1024 * 1024
  const descriptor = openSync(path, 'r')
  const buffer = Buffer.alloc(maximum + 1)
  let length = 0
  try {
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
  } finally {
    closeSync(descriptor)
  }
  if (length > maximum) throw new Error('Support bundle exceeds incident evidence byte limit')
  return JSON.parse(buffer.subarray(0, length).toString('utf8'))
}
