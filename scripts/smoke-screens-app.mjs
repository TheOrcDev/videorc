import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
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

  let redScreen
  let greenScreen
  try {
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for Screens smoke.')
    }
    console.log(`Screens smoke using FFmpeg: ${ffmpegPath}`)

    const redSource = await authorizeSmokeResource(smoke, redPath, 'input-file')
    const greenSource = await authorizeSmokeResource(smoke, greenPath, 'input-file')
    const recordingDirectory = await authorizeSmokeResource(
      smoke,
      outputDirectory,
      'output-directory'
    )

    await request(ws, timeoutMs, 'screens.clear')
    redScreen = await request(ws, timeoutMs, 'screens.importImage', {
      sourceCapability: redSource.capabilityId
    })
    greenScreen = await request(ws, timeoutMs, 'screens.importImage', {
      sourceCapability: greenSource.capabilityId
    })

    await request(ws, timeoutMs, 'screens.activate', { screenId: redScreen.id })
    const started = await request(
      ws,
      timeoutMs,
      'session.start',
      sessionParams(recordingDirectory.capabilityId)
    )
    if (!['recording', 'streaming'].includes(started.state)) {
      throw new Error(`Expected recording state after start, got ${started.state}.`)
    }
    const sessionId = started.sessionId

    await sleep(1200)
    await request(ws, timeoutMs, 'screens.activate', { screenId: greenScreen.id })
    await assertSameRunningSession(ws, sessionId)

    await sleep(1200)
    await request(ws, timeoutMs, 'screens.clear')
    await assertSameRunningSession(ws, sessionId)

    await sleep(1200)
    const stopped = await request(ws, timeoutMs, 'session.stop')
    const outputPath = stopped.outputPath ?? started.outputPath
    verifyOutput(outputPath, statuses, sessionId)
  } finally {
    if (redScreen?.id) {
      await request(ws, timeoutMs, 'screens.delete', { screenId: redScreen.id }).catch(() => {})
    }
    if (greenScreen?.id) {
      await request(ws, timeoutMs, 'screens.delete', { screenId: greenScreen.id }).catch(() => {})
    }
    await request(ws, timeoutMs, 'screens.clear').catch(() => {})
    ws.close()
  }
} finally {
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
  for (let seconds = 0.5; seconds <= 6; seconds += 0.25) {
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
