// Windows main-window recovery smoke (plan 082).
//
// A 0.9.124 user saw the main window as a title bar over an empty client
// area. Crashing the renderer of that build reproduced the picture: the window
// stayed empty for ever and nothing was logged. This smoke launches the
// packaged app and proves, against the real window:
//
//   1. a normal launch mounts the UI, and the Mica paint check reports painted;
//   2. a crashed renderer is reloaded and the UI comes back, with log lines;
//   3. software rendering starts on the solid window, never Mica;
//   4. a blank paint verdict drops Mica to solid and the next launch stays solid.
//
// It reads the renderer over CDP and photographs the real desktop as evidence.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { performanceAppSpawnSpec } from './lib/app-launcher.mjs'
import {
  evaluateBlankFallback,
  evaluateCrashRecovery,
  evaluateDefaultLaunch,
  evaluateRememberedFallback,
  evaluateSoftwareRenderingLaunch
} from './lib/main-window-recovery-gates.mjs'

if (process.platform !== 'win32') {
  throw new Error('The main-window recovery smoke must run on Windows.')
}
const spawnSpec = performanceAppSpawnSpec()
if (!spawnSpec) {
  throw new Error('Set VIDEORC_PERF_APP_EXECUTABLE to the packaged Videorc.exe.')
}
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-windows-main-window-recovery-${Date.now()}`)
)
mkdirSync(outputDirectory, { recursive: true })

const MOUNT_DEADLINE_MS = 90_000
const PAINT_CHECK_DEADLINE_MS = 45_000
const RECOVERY_DEADLINE_MS = 45_000
const POLL_MS = 500

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(read, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let last
  for (;;) {
    try {
      last = await read()
      if (last) return last
    } catch {
      // Not ready yet.
    }
    if (Date.now() >= deadline) return null
    await delay(POLL_MS)
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

function screenshot(file) {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
       $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
       $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
       $g = [System.Drawing.Graphics]::FromImage($bmp)
       $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
       $bmp.Save('${file.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    console.warn(`screenshot failed: ${result.stderr?.trim()}`)
  }
}

async function mainTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`)
  const targets = await response.json()
  return targets.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url)) ?? null
}

function openSession(wsUrl) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 1
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    })
    socket.addEventListener('error', () => fail(new Error('CDP socket error')))
    socket.addEventListener('open', () =>
      done({
        send(method, params = {}) {
          const id = nextId++
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((resolveMessage, rejectMessage) => {
            pending.set(id, resolveMessage)
            setTimeout(() => rejectMessage(new Error(`CDP ${method} timed out`)), 10_000)
          })
        },
        close: () => socket.close()
      })
    )
  })
}

/** What the main renderer says it mounted, plus main's runtime info. */
async function readPage(port) {
  const target = await mainTarget(port)
  if (!target) return null
  const session = await openSession(target.webSocketDebuggerUrl)
  try {
    const evaluated = await session.send('Runtime.evaluate', {
      returnByValue: true,
      awaitPromise: true,
      expression: `(async () => ({
        mounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
        runtimeInfo: await window.videorc?.getRuntimeInfo?.().catch(() => null)
      }))()`
    })
    return evaluated.result?.result?.value ?? null
  } finally {
    session.close()
  }
}

async function crashRenderer(port) {
  const target = await mainTarget(port)
  if (!target) return false
  const session = await openSession(target.webSocketDebuggerUrl)
  // Page.crash never answers: the process it would answer from is gone.
  session.send('Page.crash').catch(() => undefined)
  await delay(POLL_MS)
  session.close()
  return true
}

async function launch(name, env, userData) {
  const port = await freePort()
  const dir = join(outputDirectory, name)
  mkdirSync(dir, { recursive: true })
  let output = ''
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: spawnSpec.cwd,
    env: {
      ...process.env,
      ...env,
      VIDEORC_USER_DATA_DIR: userData,
      VIDEORC_REMOTE_DEBUG_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise((done) => child.once('exit', done))
  return {
    dir,
    port,
    log: () => {
      const file = join(userData, 'logs', 'backend.log')
      return existsSync(file) ? readFileSync(file, 'utf8') : ''
    },
    async stop() {
      // Only the process tree this smoke started, with a bounded wait.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
      await Promise.race([exited, delay(15_000)])
      writeFileSync(join(dir, 'app-output.log'), output)
      writeFileSync(join(dir, 'backend.log'), this.log())
    }
  }
}

const mounted = (app) => waitFor(async () => (await readPage(app.port))?.mounted, MOUNT_DEADLINE_MS)
const settledGlass = (app) =>
  waitFor(async () => {
    const glass = (await readPage(app.port))?.runtimeInfo?.windowGlass
    return glass && glass.paintCheck !== 'pending' ? glass : null
  }, PAINT_CHECK_DEADLINE_MS)

const failures = []
const report = { outputDirectory, scenarios: {} }
const record = (name, evidence, scenarioFailures) => {
  report.scenarios[name] = { ...evidence, failures: scenarioFailures }
  for (const failure of scenarioFailures) failures.push(`${name}: ${failure}`)
  console.log(`${scenarioFailures.length === 0 ? 'PASS' : 'FAIL'} ${name}`, evidence)
}

let micaOnThisMachine = false

// 1 + 2: normal launch, then a renderer crash.
{
  const app = await launch('default', {}, join(outputDirectory, 'default-userdata'))
  try {
    const isMounted = Boolean(await mounted(app))
    const glass = (await settledGlass(app)) ?? (await readPage(app.port))?.runtimeInfo?.windowGlass
    const osRelease = (await readPage(app.port))?.runtimeInfo?.osRelease
    micaOnThisMachine = glass?.kind === 'mica'
    screenshot(join(app.dir, 'screen-1-launched.png'))
    record(
      'default-launch',
      { mounted: isMounted, glass, osRelease },
      evaluateDefaultLaunch({ mounted: isMounted, glass, osRelease })
    )

    const crashed = await crashRenderer(app.port)
    const recovered = await waitFor(
      async () =>
        /Reloading the main window/.test(app.log()) && (await readPage(app.port))?.mounted,
      RECOVERY_DEADLINE_MS
    )
    screenshot(join(app.dir, 'screen-2-after-renderer-crash.png'))
    const remounted = Boolean(recovered)
    record(
      'crash-recovery',
      { crashed, remounted },
      evaluateCrashRecovery({ crashed, remounted, log: app.log() })
    )
  } finally {
    await app.stop()
  }
}

// 3: software rendering never gets Mica.
{
  const app = await launch(
    'software-rendering',
    { VIDEORC_DISABLE_GPU: '1' },
    join(outputDirectory, 'software-rendering-userdata')
  )
  try {
    const isMounted = Boolean(await mounted(app))
    const info = (await readPage(app.port))?.runtimeInfo
    screenshot(join(app.dir, 'screen-1-launched.png'))
    const evidence = {
      mounted: isMounted,
      glass: info?.windowGlass,
      osRelease: info?.osRelease,
      softwareRendering: info?.hardwareAccelerationDisabled
    }
    record('software-rendering', evidence, evaluateSoftwareRenderingLaunch(evidence))
  } finally {
    await app.stop()
  }
}

// 4: a blank verdict drops Mica, and the next launch remembers.
if (micaOnThisMachine) {
  const userData = join(outputDirectory, 'blank-fallback-userdata')
  const stateFile = join(userData, 'window-glass-fallback.json')
  const first = await launch(
    'blank-fallback',
    { VIDEORC_SMOKE_FORCE_BLANK_PAINT_CHECK: '1' },
    userData
  )
  try {
    await mounted(first)
    const glass = await settledGlass(first)
    const isMounted = Boolean((await readPage(first.port))?.mounted)
    screenshot(join(first.dir, 'screen-1-after-fallback.png'))
    const evidence = { mounted: isMounted, glass, stateFileExists: existsSync(stateFile) }
    record('blank-fallback', evidence, evaluateBlankFallback({ ...evidence, log: first.log() }))
  } finally {
    await first.stop()
  }

  const second = await launch('remembered-fallback', {}, userData)
  try {
    const isMounted = Boolean(await mounted(second))
    const glass = (await readPage(second.port))?.runtimeInfo?.windowGlass
    screenshot(join(second.dir, 'screen-1-launched.png'))
    const evidence = { mounted: isMounted, glass }
    record('remembered-fallback', evidence, evaluateRememberedFallback(evidence))
  } finally {
    await second.stop()
  }
} else {
  console.log('SKIP blank-fallback: this machine does not get the Mica window.')
  report.scenarios['blank-fallback'] = { skipped: 'no Mica on this machine' }
}

report.failures = failures
writeFileSync(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2))
if (failures.length > 0) {
  console.error(`Main-window recovery smoke failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`Main-window recovery smoke passed. Evidence: ${outputDirectory}`)
