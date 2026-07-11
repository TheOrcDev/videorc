import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import {
  assertPackagedSmokePlatform,
  bundledFfmpegPathForPackagedApp,
  defaultPackagedAppExecutable
} from './lib/packaged-smoke-paths.mjs'
import { smokeAppEnv, stopProcess } from './lib/app-launcher.mjs'
import { runBackendRecordingSmoke } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
assertPackagedSmokePlatform()
// Prefer a CLI flag over `VAR=1 node …` so the script works under Windows cmd
// (pnpm runs package scripts through cmd.exe, which does not understand Unix env
// prefixes). Env still works on POSIX shells and when gates inject it via spawn.
if (process.argv.includes('--require-bundled-ffmpeg')) {
  process.env.VIDEORC_SMOKE_REQUIRE_BUNDLED_FFMPEG = '1'
}
const appExecutable = process.env.VIDEORC_PACKAGED_APP_EXECUTABLE
  ? resolve(repoRoot, process.env.VIDEORC_PACKAGED_APP_EXECUTABLE)
  : defaultPackagedAppExecutable({ repoRoot })
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-packaged-smoke-${Date.now()}`)
)
const bundledFfmpegPath = bundledFfmpegPathForPackagedApp({ appExecutable })
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  (existsSync(bundledFfmpegPath) ? bundledFfmpegPath : 'ffmpeg')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 45000)
const recordingMs = Number(process.env.VIDEORC_SMOKE_RECORDING_MS ?? 2000)
const launchAttempts = Number(process.env.VIDEORC_PACKAGED_SMOKE_LAUNCH_ATTEMPTS ?? 2)

if (!existsSync(appExecutable)) {
  throw new Error(`Packaged app executable not found: ${appExecutable}`)
}

let appProcess

try {
  const connection = await launchAndReadConnectionWithRetry()
  await runBackendRecordingSmoke({
    connection,
    ffmpegPath,
    outputDirectory,
    timeoutMs,
    recordingMs,
    label: 'Packaged app',
    onHealth: async () => {
      if (
        process.env.VIDEORC_SMOKE_REQUIRE_BUNDLED_FFMPEG === '1' &&
        ffmpegPath !== bundledFfmpegPath
      ) {
        throw new Error(
          `Expected bundled FFmpeg at ${bundledFfmpegPath}, but smoke is using ${ffmpegPath}.`
        )
      }
    }
  })
} finally {
  await stopApp()
}

async function launchAndReadConnectionWithRetry() {
  let lastError = null
  const attempts = Math.max(1, Math.floor(launchAttempts))
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await launchAndReadConnection()
    } catch (error) {
      lastError = error
      await stopApp()
      appProcess = null
      if (attempt >= attempts) {
        throw error
      }
      console.warn(
        `Packaged app smoke launch attempt ${attempt}/${attempts} failed before backend READY: ${error.message}`
      )
      await sleep(1000)
    }
  }
  throw lastError ?? new Error('Packaged app smoke failed before launch.')
}

function launchAndReadConnection() {
  return new Promise((resolveConnection, rejectConnection) => {
    const timer = setTimeout(() => {
      rejectConnection(
        new Error(`Timed out waiting for packaged backend READY after ${timeoutMs}ms.`)
      )
    }, timeoutMs)

    appProcess = spawn(appExecutable, [], {
      env: smokeAppEnv({
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
      }),
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
      rejectConnection(
        new Error(`Packaged app exited before smoke test completed: code=${code} signal=${signal}`)
      )
    })
  })
}

function handleAppOutput(text, resolveConnection, timer) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) {
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

async function stopApp() {
  if (!appProcess || appProcess.killed) {
    appProcess = null
    return
  }
  await stopProcess(appProcess)
  appProcess = null
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
