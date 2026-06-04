import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const warmupMs = Number(process.env.VIDEORC_PREVIEW_WARMUP_MS ?? 2500)
const sampleMs = Number(process.env.VIDEORC_PREVIEW_SAMPLE_MS ?? 5000)
const pollMs = Number(process.env.VIDEORC_PREVIEW_POLL_MS ?? 100)
const minSuccessfulPollRatio = Number(process.env.VIDEORC_PREVIEW_MIN_SUCCESS_RATIO ?? 0.7)
const maxFrameAgeMs = Number(process.env.VIDEORC_PREVIEW_MAX_FRAME_AGE_MS ?? 500)
const maxCadenceMs = Number(process.env.VIDEORC_PREVIEW_MAX_CADENCE_MS ?? 300)
const minTargetFps = Number(process.env.VIDEORC_PREVIEW_MIN_TARGET_FPS ?? 10)
const expectedTransport = process.env.VIDEORC_PREVIEW_EXPECT_TRANSPORT ?? 'latest-jpeg-polling'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-preview-performance-${Date.now()}`)
)

let appProcess
let stopping = false

try {
  const connection = await launchAndReadConnection()
  await runPreviewSmoke(connection)
} finally {
  await stopApp()
}

async function runPreviewSmoke(connection) {
  const ws = await connectBackend(connection, timeoutMs)
  const diagnostics = []
  try {
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.event === 'diagnostics.stats') {
          diagnostics.push({ ...message.payload, receivedAt: Date.now() })
        }
      } catch {
        // Ignore non-JSON noise from the socket.
      }
    })

    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for preview smoke.')
    }
    console.log(`Preview performance smoke using FFmpeg: ${ffmpegPath}`)

    await request(ws, timeoutMs, 'preview.live.start', previewParams())
    const liveStatus = await waitForLivePreview(ws)
    assertPreviewStatus(liveStatus)

    await sleep(warmupMs)
    const polls = await pollPreviewFrames(connection, sampleMs)
    const finalDiagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
    assertPollsHealthy(polls)
    assertDiagnosticsHealthy(finalDiagnostics, diagnostics)

    console.log(
      `Preview performance OK: ${liveStatus.transport} ${liveStatus.width}x${liveStatus.height} @ ${liveStatus.targetFps}fps, ${polls.successes}/${polls.attempts} frame polls, age ${format(finalDiagnostics.previewFrameAgeMs)}ms, cadence ${format(finalDiagnostics.previewLatencyMs)}ms`
    )
  } finally {
    try {
      await request(ws, 5000, 'preview.live.stop')
    } catch {
      // The app shutdown path also stops preview; this is best-effort cleanup.
    }
    ws.close()
  }
}

async function waitForLivePreview(ws) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  while (Date.now() < deadline) {
    lastStatus = await request(ws, timeoutMs, 'preview.live.status')
    if (lastStatus.state === 'live') {
      return lastStatus
    }
    await sleep(250)
  }
  throw new Error(`Live preview did not become live. Last status: ${JSON.stringify(lastStatus)}`)
}

function assertPreviewStatus(status) {
  if (status.transport !== expectedTransport) {
    throw new Error(`Expected preview transport ${expectedTransport}, got ${status.transport}.`)
  }
  if ((status.targetFps ?? 0) < minTargetFps) {
    throw new Error(`Expected preview target FPS >= ${minTargetFps}, got ${status.targetFps ?? 'missing'}.`)
  }
  if (!status.width || !status.height) {
    throw new Error(`Preview status did not advertise dimensions: ${JSON.stringify(status)}`)
  }
}

function assertPollsHealthy(polls) {
  const minSuccesses = Math.ceil(polls.attempts * minSuccessfulPollRatio)
  if (polls.successes < minSuccesses) {
    throw new Error(`Preview frame polling only succeeded ${polls.successes}/${polls.attempts}; expected at least ${minSuccesses}.`)
  }
}

function assertDiagnosticsHealthy(finalDiagnostics, samples) {
  if (finalDiagnostics.previewTransport !== expectedTransport) {
    throw new Error(`Expected diagnostic preview transport ${expectedTransport}, got ${finalDiagnostics.previewTransport}.`)
  }
  if ((finalDiagnostics.previewTargetFps ?? 0) < minTargetFps) {
    throw new Error(
      `Expected diagnostic preview target FPS >= ${minTargetFps}, got ${finalDiagnostics.previewTargetFps ?? 'missing'}.`
    )
  }
  if ((finalDiagnostics.previewDroppedFrames ?? 0) > 0) {
    throw new Error(`Preview reported ${finalDiagnostics.previewDroppedFrames} dropped frame(s).`)
  }
  if (typeof finalDiagnostics.previewFrameAgeMs !== 'number') {
    throw new Error('Preview diagnostics did not report frame age.')
  }
  if (finalDiagnostics.previewFrameAgeMs > maxFrameAgeMs) {
    throw new Error(`Preview frame age ${finalDiagnostics.previewFrameAgeMs}ms exceeded ${maxFrameAgeMs}ms.`)
  }
  if (typeof finalDiagnostics.previewLatencyMs !== 'number') {
    throw new Error('Preview diagnostics did not report frame cadence.')
  }
  if (finalDiagnostics.previewLatencyMs > maxCadenceMs) {
    throw new Error(`Preview cadence ${finalDiagnostics.previewLatencyMs}ms exceeded ${maxCadenceMs}ms.`)
  }

  const steadySamples = samples.filter((sample) => typeof sample.previewFrameAgeMs === 'number')
  if (!steadySamples.length) {
    throw new Error('Preview smoke did not receive preview diagnostics over the socket.')
  }
}

async function pollPreviewFrames(connection, durationMs) {
  const deadline = Date.now() + durationMs
  let attempts = 0
  let successes = 0
  while (Date.now() < deadline) {
    attempts += 1
    const url = `http://${connection.host}:${connection.port}/preview/live.jpg?token=${encodeURIComponent(connection.token)}&t=${Date.now()}`
    try {
      const response = await fetch(url)
      if (response.ok) {
        const bytes = await response.arrayBuffer()
        if (bytes.byteLength > 0) {
          successes += 1
        }
      }
    } catch {
      // Count failed fetches through the success ratio assertion.
    }
    await sleep(pollMs)
  }
  return { attempts, successes }
}

function previewParams() {
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
    ffmpegPath,
    video: {
      preset: 'custom',
      width: 1280,
      height: 720,
      fps: 60,
      bitrateKbps: 4000
    }
  }
}

function launchAndReadConnection() {
  return new Promise((resolveConnection, rejectConnection) => {
    const timer = setTimeout(() => {
      rejectConnection(new Error(`Timed out waiting for dev backend READY after ${timeoutMs}ms.`))
    }, timeoutMs)

    appProcess = spawn('pnpm', ['dev'], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        VIDEORC_NATIVE_PREVIEW_SURFACE: '0',
        VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    appProcess.stdout.setEncoding('utf8')
    appProcess.stderr.setEncoding('utf8')
    appProcess.stdout.on('data', (text) => handleAppOutput(text, resolveConnection, timer))
    appProcess.stderr.on('data', (text) => handleAppOutput(text, resolveConnection, timer))
    appProcess.on('error', (error) => {
      clearTimeout(timer)
      rejectConnection(error)
    })
    appProcess.on('exit', (code, signal) => {
      clearTimeout(timer)
      rejectConnection(new Error(`Dev app exited before preview smoke completed: code=${code} signal=${signal}`))
    })
  })
}

function handleAppOutput(text, resolveConnection, timer) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() && !stopping) {
      console.log(line)
    }

    const marker = '[smoke] backend-ready '
    const index = line.indexOf(marker)
    if (index === -1) {
      continue
    }

    clearTimeout(timer)
    resolveConnection(JSON.parse(line.slice(index + marker.length)))
  }
}

function stopApp() {
  return new Promise((resolveStop) => {
    if (!appProcess?.pid || appProcess.killed) {
      resolveStop()
      return
    }

    const timer = setTimeout(() => {
      killApp('SIGKILL')
      resolveStop()
    }, 5000)

    stopping = true
    appProcess.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
    killApp('SIGTERM')
  })
}

function killApp(signal) {
  if (!appProcess?.pid) {
    return
  }

  try {
    process.kill(-appProcess.pid, signal)
  } catch {
    appProcess.kill(signal)
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function format(value) {
  return typeof value === 'number' ? value.toFixed(0) : 'n/a'
}
