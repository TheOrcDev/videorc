// Windows System audio start (plan 069 S8). Every session that turned
// System audio on killed the backend with heap corruption (0xC0000374) the
// moment the process-loopback activation returned: the activation
// PROPVARIANT's Drop freed the stack blob it borrowed (2026-11-01 field
// dumps, thread `system-audio-wasapi`). No smoke started Windows System audio
// before, so it shipped in #478 and surfaced only when 0.17.4 put a field
// microphone on the session bus.
//
// Drives a backend with an isolated profile through a test-pattern take with
// System audio on, a few times, and requires each time that the backend is
// still alive after the hold, that capture started, and that System audio
// joined the session mix. Kills only the backend PID it spawned.
//
//   VIDEORC_SMOKE_BACKEND   backend exe (default target/debug/videorc-backend.exe;
//                           point it at target/release or a packaged
//                           resources\videorc-backend.exe)
//   VIDEORC_SMOKE_FFMPEG_PATH  FFmpeg (default vendor/ffmpeg/windows-x64/bin)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { devAppSpawnOptions } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

if (process.platform !== 'win32') {
  console.log('SKIP: Windows System audio start is Windows only.')
  process.exit(0)
}

const STATUS_HEAP_CORRUPTION = 0xc0000374
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 60_000)
const holdMs = Number(process.env.VIDEORC_SMOKE_RECORDING_MS ?? 8_000)
const rounds = Number(process.env.VIDEORC_SMOKE_ROUNDS ?? 3)
const repoRoot = join(import.meta.dirname, '..')
const backendBinary =
  process.env.VIDEORC_SMOKE_BACKEND ?? join(repoRoot, 'target', 'debug', 'videorc-backend.exe')
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'bin', 'ffmpeg.exe')

const CAPTURE_STARTED = /System audio capture started/
const JOINED_MIX = /System audio joined the session mix/
const UNAVAILABLE = /System audio (?:is unavailable|could not start|failed)[^\n]*/i

for (const [path, remedy] of [
  [backendBinary, 'build the backend or set VIDEORC_SMOKE_BACKEND'],
  [ffmpegPath, 'run pnpm ffmpeg:fetch:windows or set VIDEORC_SMOKE_FFMPEG_PATH']
]) {
  if (!existsSync(path)) throw new Error(`${path} is missing; ${remedy}.`)
}

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-system-audio-start-'))
let run
try {
  for (let round = 1; round <= rounds; round += 1) {
    run = await launch(`round ${round}`)
    await request(run.ws, timeoutMs, 'session.start', takeParams())
    await waitWhileAlive(run, holdMs)
    if (run.exitCode !== null) {
      const code = run.exitCode >>> 0
      throw new Error(
        `${run.label}: the backend died with System audio on (exit 0x${code.toString(16).toUpperCase()}` +
          `${code === STATUS_HEAP_CORRUPTION ? ', heap corruption' : ''}).`
      )
    }
    const unavailable = run.log.find((line) => UNAVAILABLE.test(line))
    if (!run.log.some((line) => CAPTURE_STARTED.test(line))) {
      throw new Error(
        `${run.label}: System audio capture never started${unavailable ? `: ${unavailable}` : ''}.`
      )
    }
    if (!run.log.some((line) => JOINED_MIX.test(line))) {
      throw new Error(`${run.label}: System audio never joined the session mix.`)
    }
    await request(run.ws, timeoutMs, 'session.stop')
    await hardKill(run)
    console.log(`${run.label}: alive after ${holdMs} ms, capture started, joined the mix`)
  }
  console.log(
    `Windows System audio start smoke PASS: ${rounds} takes with System audio on, backend alive, ` +
      'capture started and joined the mix each time.'
  )
} catch (error) {
  if (run) console.error(`Last backend output (${run.label}):\n${run.log.slice(-30).join('\n')}`)
  throw error
} finally {
  if (run) await hardKill(run).catch(() => {})
  rmSync(stateRoot, { force: true, recursive: true })
}

async function launch(label) {
  const appDataDir = join(stateRoot, label.replace(/\s+/g, '-'))
  const recordingsDir = join(appDataDir, 'recordings')
  mkdirSync(recordingsDir, { recursive: true })
  const child = spawn(backendBinary, [], {
    ...devAppSpawnOptions({
      env: {
        ...process.env,
        RUST_LOG: 'videorc_backend=info',
        NO_COLOR: '1',
        PATH: [dirname(ffmpegPath), process.env.PATH].join(delimiter),
        VIDEORC_BUNDLED_FFMPEG_PATH: ffmpegPath,
        VIDEORC_APP_DATA_DIR: appDataDir,
        VIDEORC_DATABASE_PATH: join(appDataDir, 'videorc.sqlite3'),
        VIDEORC_SECRETS_PATH: join(appDataDir, 'videorc-secrets.json'),
        VIDEORC_RECORDINGS_DIR: recordingsDir,
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_DISABLE_BACKEND_REAP: '1',
        // The exclusion root, as Electron main is in the app: this script.
        VIDEORC_ELECTRON_MAIN_PID: String(process.pid),
        // Software encoding keeps the take independent of the GPU encoder.
        VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'raw'
      }
    })
  })
  const current = { label, child, log: [], exitCode: null }
  child.once('exit', (code) => {
    current.exitCode = code ?? -1
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    current.log.push(...chunk.split(/\r?\n/).filter((line) => line.trim()))
  })
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: no READY in time.`)), timeoutMs)
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('READY '))
      if (!line) return
      clearTimeout(timer)
      resolve(JSON.parse(line.slice('READY '.length)))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${label}: backend exited (${code}) before READY.`))
    })
  })
  current.ws = await connectBackend(
    { ...ready, token: ready.adminToken, adminToken: undefined },
    timeoutMs
  )
  return current
}

async function waitWhileAlive(current, ms) {
  const deadline = Date.now() + ms
  while (current.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** TerminateProcess on the backend this script spawned, and its children. */
async function hardKill(current) {
  current.ws?.close()
  if (current.exitCode !== null) return
  const exited = new Promise((resolve) => current.child.once('exit', resolve))
  spawnSync('taskkill', ['/PID', String(current.child.pid), '/T', '/F'], { stdio: 'ignore' })
  await exited
}

function takeParams() {
  return {
    sources: { testPattern: true },
    audio: { systemAudioEnabled: true },
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
      video: { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  }
}
