import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { devAppSpawnSpec, smokeAppEnv, stopProcess } from './lib/app-launcher.mjs'
import { runBackendRecordingSmoke } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-dev-smoke-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-dev-smoke-user-data-'))
const vendorWindowsFfmpeg = resolve(
  import.meta.dirname,
  '..',
  'vendor',
  'ffmpeg',
  'windows-x64',
  'bin',
  'ffmpeg.exe'
)
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  // Windows dev boxes rarely have ffmpeg on PATH; prefer the pinned vendor
  // build from `pnpm ffmpeg:fetch:windows` (same one dev mode wires in).
  (process.platform === 'win32' && existsSync(vendorWindowsFfmpeg)
    ? vendorWindowsFfmpeg
    : 'ffmpeg')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)

let appProcess
let stopping = false

try {
  const connection = await launchAndReadConnection()
  await runBackendRecordingSmoke({
    connection,
    ffmpegPath,
    outputDirectory,
    timeoutMs,
    label: 'Dev app'
  })
} finally {
  await stopApp()
}

function launchAndReadConnection() {
  return new Promise((resolveConnection, rejectConnection) => {
    const timer = setTimeout(() => {
      rejectConnection(new Error(`Timed out waiting for dev backend READY after ${timeoutMs}ms.`))
    }, timeoutMs)

    // devAppSpawnSpec handles the Windows pnpm shim (shell: true) — a bare
    // spawn('pnpm', …) fails with ENOENT on win32.
    const spec = devAppSpawnSpec({
      env: smokeAppEnv({
        VIDEORC_USER_DATA_DIR: userDataDir,
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
      })
    })
    appProcess = spawn(spec.command, spec.args, spec.options)

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
        new Error(`Dev app exited before smoke test completed: code=${code} signal=${signal}`)
      )
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

async function stopApp() {
  if (!appProcess?.pid || appProcess.killed) {
    return
  }
  stopping = true
  await stopProcess(appProcess)
}
