import assert from 'node:assert/strict'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-screens-smoke-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ??
  mkdtempSync(join(tmpdir(), 'videorc-screens-smoke-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)

mkdirSync(outputDirectory, { recursive: true })

let stopApp = async () => {}
const listeners = []

try {
  const redPath = join(outputDirectory, 'screen-red.png')
  const greenPath = join(outputDirectory, 'screen-green.png')
  createSolidPng('red', redPath)
  createSolidPng('lime', greenPath)

  const launch = await launchDevApp({
    env: {
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
  const ws = await connectBackend(connection, timeoutMs)
  const statuses = []
  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data)
      if (message?.event === 'recording.status') {
        statuses.push(message.payload)
      }
    } catch {
      // Ignore unrelated smoke output.
    }
  })

  try {
    const recordingDirectory = await authorizeSmokeResource(
      smoke,
      outputDirectory,
      'output-directory'
    )
    const corruptPath = join(outputDirectory, 'corrupt.png')
    writeFileSync(corruptPath, 'not an image')
    const modes = process.env.VIDEORC_SCREENS_SMOKE_MODE
      ? [process.env.VIDEORC_SCREENS_SMOKE_MODE]
      : ['recording', 'streaming', 'both']
    for (const mode of modes) {
      assert(['recording', 'streaming', 'both'].includes(mode), 'unknown screens smoke mode')
      statuses.length = 0
      await request(ws, timeoutMs, 'screens.clear')
      for (const old of await request(ws, timeoutMs, 'screens.list')) {
        await request(ws, timeoutMs, 'screens.delete', { screenId: old.id })
      }
      const targets =
        mode === 'recording'
          ? []
          : (process.platform === 'linux' ? [false] : [false, true]).map((vertical, i) => {
              const port = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 12935) + i
              return {
                id: `screen-${i}`,
                platform: 'custom',
                label: `Takeover ${i}`,
                enabled: true,
                serverUrl: `rtmp://127.0.0.1:${port}/live`,
                streamKey: 'takeover',
                urlMode: 'server-and-key',
                streamKeyPresent: true,
                authMode: 'manual-rtmp',
                outputOrientation: vertical ? 'vertical' : 'horizontal',
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
                port,
                recvPath: join(outputDirectory, `${mode}-${i}.flv`)
              }
            })
      const receivers = []
      for (const target of targets) {
        const receiver = startReceiver(target)
        receivers.push(receiver)
        listeners.push(receiver)
        await waitForOwnedTcpListener({
          child: receiver.child,
          port: target.port,
          timeoutMs: 8000,
          diagnostics: () => receiver.log
        })
      }
      const params = sessionParams(recordingDirectory.capabilityId)
      params.output.recordEnabled = mode !== 'streaming'
      params.output.streamEnabled = mode !== 'recording'
      if (targets.length) {
        params.output.video = {
          preset: 'tutorial-1080p30',
          width: 1920,
          height: 1080,
          fps: 30,
          bitrateKbps: 6000
        }
        params.output.rtmp = {
          preset: 'custom',
          serverUrl: targets[0].serverUrl,
          streamKey: targets[0].streamKey
        }
        params.streaming = {
          enabled: true,
          mode: 'multi',
          targets: targets.map(({ port, recvPath, ...target }) => target),
          enabledTargetIds: targets.map((t) => t.id),
          defaultOutputPreset: 'tutorial-1080p30',
          defaultBitrateKbps: 6000
        }
        if (targets.some((target) => target.outputOrientation === 'vertical'))
          params.simulcast = {
            layout: {
              ...params.layout,
              layoutPreset: 'vertical-camera-bottom',
              verticalScreenFraming: 'fit'
            },
            video: { preset: 'custom', width: 360, height: 640, fps: 30, bitrateKbps: 2000 }
          }
      }
      const started = await request(ws, timeoutMs, 'session.start', params)
      const sessionId = started.sessionId
      assert(
        sessionId && ['recording', 'streaming'].includes(started.state),
        'session must run before importing'
      )
      await sleep(1200) // Deliberate artifact coverage, not a readiness handshake.
      const redScreen = await importFromAssets(redPath)
      assert.equal(
        await request(ws, timeoutMs, 'screens.active'),
        null,
        'first import must not activate'
      )
      await assertSameRunningSession(ws, sessionId)
      await request(ws, timeoutMs, 'screens.activate', { screenId: redScreen.id })
      await sleep(1200)
      const before = await request(ws, timeoutMs, 'compositor.status')
      const greenScreen = await importFromAssets(greenPath)
      assert.equal(
        (await request(ws, timeoutMs, 'screens.active'))?.id,
        redScreen.id,
        'import must preserve on-air takeover'
      )
      await assertSameRunningSession(ws, sessionId)
      const after = await request(ws, timeoutMs, 'compositor.status')
      assert(
        after.framesRendered > before.framesRendered,
        `Compositor stalled during ${mode} import`
      )
      const listBeforeFailure = await request(ws, timeoutMs, 'screens.list')
      await requestSmokeCommand(
        smoke,
        'import-takeover-image',
        { path: corruptPath },
        { timeoutMs }
      )
      assert.deepEqual(
        await request(ws, timeoutMs, 'screens.list'),
        listBeforeFailure,
        'failed import cannot publish a row'
      )
      assert.equal(
        (await request(ws, timeoutMs, 'screens.active'))?.id,
        redScreen.id,
        'failed import cannot clear on-air image'
      )
      await sleep(1200)
      await request(ws, timeoutMs, 'screens.activate', { screenId: greenScreen.id })
      await sleep(1200)
      await request(ws, timeoutMs, 'screens.clear')
      await assertSameRunningSession(ws, sessionId)
      await sleep(1200)
      const stopped = await request(ws, timeoutMs, 'session.stop')
      const paths = []
      if (mode !== 'streaming')
        paths.push(await resolveFinalRecordingPath({ started, stopped, timeoutMs: 120_000 }))
      for (const receiver of receivers) {
        await waitForExit(receiver, 15000)
        paths.push(receiver.path)
      }
      for (const path of paths) {
        verifyOutput(path, statuses, sessionId)
        const quality = await analyzeRecording(path, {
          ffmpegPath,
          ffprobePath: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe',
          intendedFps: 30,
          expectAudio: true,
          gates: { requireMotion: false }
        })
        assert(quality.verdict.pass, `${path}: ${quality.verdict.failures.join('; ')}`)
      }
      console.log(`Live takeover import PASS: ${mode}`)
    }
    async function importFromAssets(path) {
      const oldIds = new Set((await request(ws, timeoutMs, 'screens.list')).map((s) => s.id))
      const rendered = await requestSmokeCommand(
        smoke,
        'import-takeover-image',
        { path },
        { timeoutMs }
      )
      const added = (await request(ws, timeoutMs, 'screens.list')).filter((s) => !oldIds.has(s.id))
      assert.equal(added.length, 1, 'renderer import must publish exactly one takeover')
      assert(rendered.ids.includes(added[0].id), 'new takeover must render in Assets')
      return added[0]
    }
  } finally {
    await request(ws, timeoutMs, 'session.stop').catch(() => {})
    ws.close()
  }
} finally {
  for (const receiver of listeners) await stopReceiver(receiver)
  await stopApp()
}

function createSolidPng(color, outputPath) {
  const result = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=640x360`,
      '-frames:v',
      '1',
      outputPath
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(`Could not create ${color} Screen image: ${result.stderr || result.stdout}`)
  }
}

function sampleRgb(outputPath, seconds) {
  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      seconds.toFixed(2),
      '-i',
      outputPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1,format=rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { encoding: null }
  )
  if (result.status !== 0 || result.stdout.length < 3) {
    throw new Error(
      `Could not sample output frame at ${seconds}s: ${result.stderr?.toString() ?? ''}`
    )
  }
  return [result.stdout[0], result.stdout[1], result.stdout[2]]
}

function sampleTimeline(outputPath) {
  const samples = []
  const probe = spawnSync(
    process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outputPath],
    { encoding: 'utf8' }
  )
  const duration = Number(probe.stdout.trim())
  assert(probe.status === 0 && duration > 0, 'artifact duration must be readable')
  for (let seconds = 0.5; seconds < duration - 0.15; seconds += 0.25) {
    try {
      samples.push({ seconds, rgb: sampleRgb(outputPath, seconds) })
    } catch {
      break
    }
  }
  return samples
}

function isRed(rgb) {
  return rgb[0] > 180 && rgb[1] < 80 && rgb[2] < 80
}

function isGreen(rgb) {
  return rgb[1] > 180 && rgb[0] < 80 && rgb[2] < 80
}

function verifyOutput(outputPath, statuses, sessionId) {
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error(`Screens smoke output was not created: ${outputPath ?? 'missing path'}`)
  }
  const size = statSync(outputPath).size
  if (size <= 0) {
    throw new Error(`Screens smoke output is empty: ${outputPath}`)
  }

  const uniqueSessionIds = new Set(statuses.map((status) => status.sessionId).filter(Boolean))
  if (uniqueSessionIds.size !== 1 || !uniqueSessionIds.has(sessionId)) {
    throw new Error(
      `Screen switching appears to have restarted the session: ${[...uniqueSessionIds].join(', ')}`
    )
  }

  const samples = sampleTimeline(outputPath)
  const red = samples.find((sample) => isRed(sample.rgb))
  const green = red
    ? samples.find((sample) => sample.seconds > red.seconds && isGreen(sample.rgb))
    : null
  const normal = green
    ? samples.find(
        (sample) => sample.seconds > green.seconds && !isRed(sample.rgb) && !isGreen(sample.rgb)
      )
    : null
  if (!red || !green || !normal) {
    const rendered = samples
      .map((sample) => `${sample.seconds.toFixed(2)}s=rgb(${sample.rgb.join(',')})`)
      .join(', ')
    throw new Error(`Expected red -> green -> Normal Screen sequence, got ${rendered}`)
  }

  console.log(
    `Screens smoke OK - switched red -> green -> Normal in one session (${outputPath}, ${size} bytes).`
  )
}

async function assertSameRunningSession(ws, sessionId) {
  const status = await request(ws, timeoutMs, 'recording.status')
  if (status.sessionId !== sessionId || !['recording', 'streaming'].includes(status.state)) {
    throw new Error(
      `Expected same running session ${sessionId}, got ${status.sessionId}/${status.state}`
    )
  }
}

function sessionParams(outputDirectoryCapability) {
  return {
    sources: { testPattern: true },
    layout: {
      layoutPreset: 'screen-only',
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
      streamEnabled: false,
      outputDirectoryCapability,
      video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  }
}

function authorizeSmokeResource(smoke, path, kind) {
  return requestSmokeCommand(smoke, 'authorize-smoke-resource', { path, kind }, { timeoutMs })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function startReceiver(target) {
  const child = spawn(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      `${target.serverUrl}/${target.streamKey}`,
      '-c',
      'copy',
      '-f',
      'flv',
      target.recvPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const receiver = { child, path: target.recvPath, log: '', exited: null }
  receiver.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', (error) => resolve({ error }))
  })
  child.stderr.on('data', (text) => {
    receiver.log = (receiver.log + text).slice(-8000)
  })
  return receiver
}
async function waitForExit(receiver, ms) {
  let timer
  try {
    const result = await Promise.race([
      receiver.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Receiver did not finish: ${receiver.log}`)), ms)
      })
    ])
    if (result.error) throw result.error
  } finally {
    clearTimeout(timer)
  }
}
async function stopReceiver(receiver) {
  if (receiver.child.exitCode !== null || receiver.child.signalCode !== null) return
  receiver.child.kill('SIGTERM')
  try {
    await waitForExit(receiver, 2000)
  } catch {
    receiver.child.kill('SIGKILL')
    await waitForExit(receiver, 2000)
  }
}
