// Crash breaker for the Windows hardware Media Foundation encoder (2026-11-01
// field bundle: an Iris Xe laptop on 0.17.4 died with heap corruption in five
// Quick Sync takes in a row and kept selecting the same encoder).
//
// Drives the real debug backend with an isolated profile and a test-pattern
// take on the Media Foundation encoded bridge, and proves:
//   1. a take stopped normally leaves no crash behind (the marker is cleared),
//   2. a backend killed mid-take is counted at the next start (streak 1),
//   3. a second killed take switches the hardware encoder off (streak 2),
//   4. the next take records on the fallback encoder and says why,
//   5. the backend registered the WER helper beside it (fix 2's wiring).
// Needs a GPU whose hardware H.264 MFT passes the probe; SKIPs naming the
// probe failure otherwise. Kills only the backend PID this script spawned.
//
// Build first: cargo build -p videorc-backend --bin videorc-backend -p videorc-wer-helper
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { devAppSpawnOptions } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

if (process.platform !== 'win32') {
  console.log('SKIP: the Media Foundation crash breaker is Windows only.')
  process.exit(0)
}

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120_000)
const recordingMs = Number(process.env.VIDEORC_SMOKE_RECORDING_MS ?? 3_000)
const repoRoot = join(import.meta.dirname, '..')
const backendBinary = join(repoRoot, 'target', 'debug', 'videorc-backend.exe')
const helperDll = join(repoRoot, 'target', 'debug', 'videorc_wer_helper.dll')
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'bin', 'ffmpeg.exe')
const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-mf-crash-breaker-'))
const appDataDir = join(stateRoot, 'app-data')
const recordingsDir = join(stateRoot, 'recordings')
mkdirSync(appDataDir, { recursive: true })
mkdirSync(recordingsDir, { recursive: true })

const MF_SELECTED = /Native Media Foundation encoded bridge selected/
const CRASH_COUNTED =
  /stopped unexpectedly during a session that encoded on the hardware Media Foundation encoder.*consecutive=(\d+)/
const QUARANTINED = /Media Foundation hardware encoder quarantined/
const FALLBACK_FOR_QUARANTINE =
  /fallback after the requested Media Foundation encoded bridge was rejected: .*quarantined/
const WER_HELPER_REGISTERED = /WER helper registered for fail-fast crashes/
const STORE_LOADED = /Media Foundation rejection store loaded/
const EVIDENCE = [
  MF_SELECTED,
  CRASH_COUNTED,
  QUARANTINED,
  FALLBACK_FOR_QUARANTINE,
  WER_HELPER_REGISTERED
]
const evidence = []

class SkipError extends Error {
  constructor(
    message = 'this GPU has no Media Foundation hardware H.264 encoder that passes the probe.'
  ) {
    super(message)
  }
}

let current
try {
  for (const required of [backendBinary, helperDll]) {
    if (!existsSync(required)) {
      throw new Error(
        `${required} is missing; run cargo build -p videorc-backend --bin videorc-backend -p videorc-wer-helper`
      )
    }
  }
  if (!existsSync(ffmpegPath)) {
    throw new Error(
      `${ffmpegPath} is missing; run pnpm ffmpeg:fetch:windows or set VIDEORC_SMOKE_FFMPEG_PATH`
    )
  }

  // 1. A take that ends normally clears its marker, even if the backend is
  //    then killed outright.
  current = await launch('clean take')
  await expectLog(current, WER_HELPER_REGISTERED, 'the WER helper registration')
  await recordTake(current, { stop: true })
  await hardKill(current)
  current = await launch('after clean take')
  // The store (and the marker it settles) loads after READY.
  await expectLog(current, STORE_LOADED, 'the Media Foundation rejection store load')
  assertNoLog(current, CRASH_COUNTED, 'a crash counted after a take that ended normally')

  // 2-3. Two takes killed mid-recording.
  for (const expected of [1, 2]) {
    await recordTake(current, { stop: false })
    await hardKill(current)
    current = await launch(`after killed take ${expected}`)
    const match = await expectLog(current, CRASH_COUNTED, `crashed take ${expected} counted`)
    if (Number(match[1]) !== expected) {
      throw new Error(`Expected streak ${expected}, the backend logged ${match[1]}.`)
    }
  }
  await expectLog(current, QUARANTINED, 'the hardware encoder switched off')

  // 4. The next take records on the fallback and names the quarantine.
  await recordTake(current, { stop: true, expectMediaFoundation: false })
  await expectLog(current, FALLBACK_FOR_QUARANTINE, 'the fallback naming the quarantine')

  console.log(evidence.join('\n'))
  console.log(
    'Media Foundation crash breaker smoke PASS: a normal stop clears the marker, two killed takes ' +
      'switch the hardware encoder off, the next take records on the fallback, and the WER helper is registered.'
  )
} catch (error) {
  if (error instanceof SkipError) {
    console.log(`SKIP: ${error.message}`)
  } else {
    if (current) {
      console.error(`Last backend output (${current.label}):\n${current.log.slice(-40).join('\n')}`)
    }
    throw error
  }
} finally {
  if (current) await hardKill(current).catch(() => {})
  rmSync(stateRoot, { force: true, recursive: true })
}

async function launch(label) {
  const child = spawn(backendBinary, [], {
    ...devAppSpawnOptions({
      env: {
        ...process.env,
        RUST_LOG: 'videorc_backend=info',
        NO_COLOR: '1',
        PATH: [dirname(ffmpegPath), process.env.PATH].join(delimiter),
        VIDEORC_BUNDLED_FFMPEG_PATH: ffmpegPath,
        VIDEORC_APP_VERSION: '0.0.0-mf-crash-breaker-smoke',
        VIDEORC_APP_DATA_DIR: appDataDir,
        VIDEORC_DATABASE_PATH: join(appDataDir, 'videorc.sqlite3'),
        VIDEORC_SECRETS_PATH: join(appDataDir, 'videorc-secrets.json'),
        VIDEORC_RECORDINGS_DIR: recordingsDir,
        VIDEORC_SMOKE_STATE_DIR: stateRoot,
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_DISABLE_BACKEND_REAP: '1',
        VIDEORC_ENABLE_SMOKE_RPC: '1',
        VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'windows-media-foundation-h264-mpegts'
      }
    })
  })
  const run = { label, child, log: [], waiters: new Set() }
  const onText = (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue
      run.log.push(line)
      if (EVIDENCE.some((pattern) => pattern.test(line))) evidence.push(`[${label}] ${line.trim()}`)
      for (const waiter of run.waiters) waiter(line)
    }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', onText)
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: no READY in time.`)), timeoutMs)
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      onText(chunk)
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
  run.ws = await connectBackend(
    { ...ready, token: ready.adminToken, adminToken: undefined },
    timeoutMs
  )
  return run
}

/** Starts a test-pattern take; SKIPs the smoke when the first take could not use the hardware bridge. */
async function recordTake(run, { stop, expectMediaFoundation = true }) {
  const started = await request(run.ws, timeoutMs, 'session.start', takeParams())
  if (!['recording', 'streaming'].includes(started.state)) {
    throw new Error(`${run.label}: expected a running take, got ${started.state}.`)
  }
  const selected = run.log.some((line) => MF_SELECTED.test(line))
  if (expectMediaFoundation && !selected) {
    if (run.label === 'clean take') {
      await request(run.ws, timeoutMs, 'session.stop').catch(() => {})
      const reason = run.log.find((line) =>
        /fallback after the requested Media Foundation/.test(line)
      )
      throw new SkipError(reason ?? 'the take did not select the Media Foundation encoded bridge.')
    }
    throw new Error(`${run.label}: the take did not select the Media Foundation encoded bridge.`)
  }
  if (!expectMediaFoundation && selected) {
    throw new Error(`${run.label}: the quarantined encoder was selected again.`)
  }
  await sleep(recordingMs)
  if (stop) await request(run.ws, timeoutMs, 'session.stop')
}

/** TerminateProcess on the backend this script spawned, and its children. */
async function hardKill(run) {
  run.ws?.close()
  if (run.child.exitCode !== null || run.child.signalCode !== null) return
  const exited = new Promise((resolve) => run.child.once('exit', resolve))
  spawnSync('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { stdio: 'ignore' })
  await exited
}

async function expectLog(run, pattern, what) {
  const seen = run.log.map((line) => line.match(pattern)).find(Boolean)
  if (seen) return seen
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      run.waiters.delete(waiter)
      reject(new Error(`${run.label}: never logged ${what}.`))
    }, timeoutMs)
    const waiter = (line) => {
      const match = line.match(pattern)
      if (!match) return
      clearTimeout(timer)
      run.waiters.delete(waiter)
      resolve(match)
    }
    run.waiters.add(waiter)
  })
}

function assertNoLog(run, pattern, what) {
  const line = run.log.find((candidate) => pattern.test(candidate))
  if (line) throw new Error(`${run.label}: ${what}: ${line}`)
}

function takeParams() {
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
      video: { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
