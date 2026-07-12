import { existsSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import {
  assertPackagedSmokePlatform,
  bundledFfmpegPathForPackagedApp,
  defaultPackagedAppExecutable
} from './lib/packaged-smoke-paths.mjs'
import { smokeAppEnv, stopProcess } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
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
mkdirSync(outputDirectory, { recursive: true })

let appProcess

try {
  const { backend, smoke } = await launchAndReadConnectionsWithRetry()
  const bundledAsset = await requestSmokeCommand(
    smoke,
    'inspect-packaged-bundled-background',
    {},
    { timeoutMs }
  )
  if (
    typeof bundledAsset?.id !== 'string' ||
    typeof bundledAsset?.fileName !== 'string' ||
    typeof bundledAsset?.managedAssetPath !== 'string' ||
    typeof bundledAsset?.assetUrl !== 'string' ||
    !bundledAsset.assetUrl.startsWith('videorc-asset://background/') ||
    !Number.isSafeInteger(bundledAsset?.decodedWidth) ||
    bundledAsset.decodedWidth < 1 ||
    !Number.isSafeInteger(bundledAsset?.decodedHeight) ||
    bundledAsset.decodedHeight < 1
  ) {
    throw new Error('Packaged app did not expose a registered bundled background asset.')
  }
  const bundledSourcePath = join(
    repoRoot,
    'apps/desktop/src/renderer/src/assets/backgrounds',
    bundledAsset.fileName
  )
  console.log(
    `Packaged renderer decoded ${bundledAsset.assetUrl} at ${bundledAsset.decodedWidth}x${bundledAsset.decodedHeight}.`
  )
  await runBackendRecordingSmoke({
    connection: backend,
    ffmpegPath,
    outputDirectory,
    timeoutMs,
    recordingMs,
    label: 'Packaged app',
    bundledBackground: {
      assetId: bundledAsset.id,
      managedAssetPath: bundledAsset.managedAssetPath,
      sourcePath: bundledSourcePath,
      label: `Bundled ${bundledAsset.name ?? bundledAsset.id} background`
    },
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

async function launchAndReadConnectionsWithRetry() {
  let lastError = null
  const attempts = Math.max(1, Math.floor(launchAttempts))
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await launchAndReadConnections()
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

function launchAndReadConnections() {
  return new Promise((resolveConnections, rejectConnections) => {
    const timer = setTimeout(() => {
      rejectConnections(
        new Error(`Timed out waiting for packaged backend and smoke READY after ${timeoutMs}ms.`)
      )
    }, timeoutMs)

    const smokeCapability = randomBytes(32).toString('base64url')
    const connections = { backend: null, smoke: null }
    const maybeResolve = () => {
      if (connections.backend && connections.smoke) {
        clearTimeout(timer)
        resolveConnections(connections)
      }
    }

    appProcess = spawn(appExecutable, [], {
      env: smokeAppEnv({
        VIDEORC_USER_DATA_DIR: join(outputDirectory, 'user-data'),
        VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
        VIDEORC_SMOKE_COMMAND_SERVER: '1',
        VIDEORC_PACKAGED_SMOKE_TEST: '1',
        VIDEORC_SMOKE_COMMAND_CAPABILITY: smokeCapability
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })

    appProcess.stdout.setEncoding('utf8')
    appProcess.stderr.setEncoding('utf8')
    appProcess.stdout.on('data', (text) =>
      handleAppOutput(text, connections, maybeResolve, smokeCapability)
    )
    appProcess.stderr.on('data', (text) =>
      handleAppOutput(text, connections, maybeResolve, smokeCapability)
    )
    appProcess.on('error', (error) => {
      clearTimeout(timer)
      rejectConnections(error)
    })
    appProcess.on('exit', (code, signal) => {
      clearTimeout(timer)
      rejectConnections(
        new Error(`Packaged app exited before smoke test completed: code=${code} signal=${signal}`)
      )
    })
  })
}

function handleAppOutput(text, connections, maybeResolve, smokeCapability) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) {
      console.log(line)
    }

    const backendMarker = '[smoke] backend-ready '
    const backendIndex = line.indexOf(backendMarker)
    if (backendIndex !== -1) {
      connections.backend = JSON.parse(line.slice(backendIndex + backendMarker.length))
      maybeResolve()
    }
    const smokeMarker = '[smoke] preview-motion-ready '
    const smokeIndex = line.indexOf(smokeMarker)
    if (smokeIndex !== -1) {
      connections.smoke = {
        ...JSON.parse(line.slice(smokeIndex + smokeMarker.length)),
        capability: smokeCapability
      }
      maybeResolve()
    }
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
