// Real-user launch smoke: boot the app EXACTLY like a user does — real capture
// config, real sources, NO synthetic preview scene — open the detached preview,
// and hold it to the first-frame contract:
//
//   within the budget, transport=native-surface + backing=cametal-layer,
//   compositor sceneRevision == frameSceneRevision, a Metal IOSurface target
//   present, and frames advancing on both compositor and surface.
//
// Every other preview smoke launches with VIDEORC_SMOKE_PREVIEW_MOTION=1, which
// swaps the whole capture config for a synthetic test pattern — so they can stay
// green while a real launch is broken (2026-07-01 report: stuck "Waiting for
// preview" + test-pattern bars from launch in dev). This smoke exists to fail in
// that situation. On failure it dumps the full chain state and a branch hint
// (A: compositor never renders the committed scene; B: no Metal target;
// C: helper/native present path dead; D: synthetic scene leak).
//
// Functional contract only — no fps floors here (local hosts miss strict perf
// floors under load; perf stays in the dedicated measurement gates).
//
// Run: pnpm smoke:preview-real-launch

import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { devAppSpawnSpec, smokeAppEnv, stopProcess } from './lib/app-launcher.mjs'
import { assertSmokeCommandConnection } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
// First-frame contract budget. Generous vs the product target so a slow cold
// dev boot does not flake the gate; the contract is "converges at all".
const contractMs = Number(process.env.VIDEORC_PREVIEW_LAUNCH_CONTRACT_MS ?? 20000)
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-preview-real-launch-${Date.now()}`)
)

let appProcess = null
let stopping = false

try {
  const { backend, smoke } = await launchAndReadConnections()
  await runRealLaunchContract(backend, smoke)
} finally {
  await stopApp()
}

async function runRealLaunchContract(connection, smoke) {
  assertSmokeCommandConnection(smoke)
  const ws = await connectBackend(connection, timeoutMs)
  try {
    // Profile-pollution guard: an "isolated" smoke whose backend still uses the
    // REAL user profile pollutes real sessions/settings/secrets (2026-07-01: dev
    // profile ended up with smoke test-pattern sessions — the user's preview
    // showed the smoke's bars). The backend must live inside the smoke dir.
    const health = await request(ws, timeoutMs, 'health.ping')
    if (health.databasePath !== 'managed-app-data') {
      throw new Error(
        `preview-real-launch: FAIL — renderer health leaked its database path (${String(health.databasePath)}).`
      )
    }
    const stateIsolation = await smokeCommand(smoke, 'inspect-backend-state-isolation')
    if (stateIsolation.isolated !== true) {
      throw new Error(
        `preview-real-launch: FAIL — backend state is not isolated: ${JSON.stringify(stateIsolation)}`
      )
    }

    await smokeCommand(smoke, 'open-tab', {
      tab: 'studio',
      waitFor: '[data-videorc-preview-card]'
    })
    const runtime = await smokeCommand(smoke, 'inspect-native-preview-runtime')
    console.log(`real-launch runtime: ${JSON.stringify(runtime)}`)
    await smokeCommand(smoke, 'preview-window-open')

    const startedAt = Date.now()
    const deadline = startedAt + contractMs
    let last = { surface: null, compositor: null, mainSurface: null }
    let baseline = { compositorFrames: -1, surfaceFrames: -1 }

    while (Date.now() < deadline) {
      const [surface, compositor, mainSurface] = await Promise.all([
        request(ws, timeoutMs, 'preview.surface.status'),
        request(ws, timeoutMs, 'compositor.status'),
        smokeCommand(smoke, 'native-preview-surface-status')
      ])
      last = { surface, compositor, mainSurface }
      if (baseline.compositorFrames < 0) {
        baseline = {
          compositorFrames: compositor.framesRendered ?? 0,
          surfaceFrames: surface.framesRendered ?? 0
        }
      }

      if (contractMet(last, baseline)) {
        const elapsedMs = Date.now() - startedAt
        const diagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
        assertDiagnosticsAgree(diagnostics)
        console.log(
          `real-launch contract PASS in ${elapsedMs}ms: transport=${last.surface.transport} backing=${last.surface.backing} sceneRevision=${last.compositor.sceneRevision} frameSceneRevision=${last.compositor.frameSceneRevision} metalTarget=${last.compositor.metalTargetIosurfaceId ?? 'absent'}`
        )
        console.log('preview-real-launch: PASS')
        return
      }
      await sleep(250)
    }

    await failWithChainDump(ws, smoke, last, baseline)
  } finally {
    ws.close()
  }
}

function contractMet(last, baseline) {
  const { surface, compositor, mainSurface } = last
  if (!surface || !compositor || !mainSurface) {
    return false
  }
  return (
    surface.state === 'live' &&
    surface.transport === 'native-surface' &&
    surface.backing === 'cametal-layer' &&
    mainSurface.transport === 'native-surface' &&
    mainSurface.backing === 'cametal-layer' &&
    compositor.sceneRevision != null &&
    compositor.sceneRevision === compositor.frameSceneRevision &&
    Boolean(compositor.metalTargetIosurfaceId) &&
    (compositor.framesRendered ?? 0) > baseline.compositorFrames &&
    (surface.framesRendered ?? 0) > baseline.surfaceFrames
  )
}

function assertDiagnosticsAgree(diagnostics) {
  if (diagnostics.previewTransport !== 'native-surface') {
    throw new Error(
      `Diagnostics disagree after contract: previewTransport=${diagnostics.previewTransport}, expected native-surface.`
    )
  }
  if (diagnostics.previewSurfaceBacking !== 'cametal-layer') {
    throw new Error(
      `Diagnostics disagree after contract: previewSurfaceBacking=${diagnostics.previewSurfaceBacking}, expected cametal-layer.`
    )
  }
}

async function failWithChainDump(ws, smoke, last, baseline) {
  const diagnostics = await request(ws, timeoutMs, 'diagnostics.stats').catch((error) => ({
    unavailable: String(error?.message ?? error)
  }))
  const badges = await smokeCommand(smoke, 'inspect-preview-stage-badges').catch((error) => ({
    unavailable: String(error?.message ?? error)
  }))

  const chain = {
    surfaceStatus: last.surface,
    mainSurfaceStatus: last.mainSurface,
    compositorStatus: last.compositor,
    baseline,
    stageBadges: badges,
    diagnostics: pickDiagnostics(diagnostics)
  }
  console.error(`real-launch chain state:\n${JSON.stringify(chain, null, 2)}`)
  console.error(`real-launch branch hint: ${branchHint(last)}`)
  throw new Error(
    `preview-real-launch: FAIL — first-frame contract not met within ${contractMs}ms (${branchHint(last)})`
  )
}

// The Phase 0 decision tree from the Native Preview Definitive Fix Plan.
function branchHint(last) {
  const compositor = last.compositor ?? {}
  const surface = last.surface ?? {}
  if (surface.sourcePixelsPresent === false || compositor.testPattern === true) {
    return 'D: synthetic/test-pattern scene is active — check smoke env leak'
  }
  if (
    compositor.sceneRevision != null &&
    compositor.frameSceneRevision != null &&
    compositor.sceneRevision !== compositor.frameSceneRevision
  ) {
    return `A: compositor never rendered the committed scene (sceneRevision=${compositor.sceneRevision}, frameSceneRevision=${compositor.frameSceneRevision})`
  }
  if (!compositor.metalTargetIosurfaceId) {
    return 'B: compositor status carries no Metal IOSurface target (idle/CPU path)'
  }
  if (surface.transport !== 'native-surface') {
    return `C: compositor has a presentable frame but native present path is stuck (transport=${surface.transport ?? 'unknown'}, state=${surface.state ?? 'unknown'})`
  }
  return 'unclassified: contract raced (frames not advancing?) — inspect chain state'
}

function pickDiagnostics(diagnostics) {
  if (!diagnostics || diagnostics.unavailable) {
    return diagnostics
  }
  const picked = {}
  for (const key of Object.keys(diagnostics)) {
    if (/^(preview|nativePreview)/.test(key)) {
      picked[key] = diagnostics[key]
    }
  }
  return picked
}

function launchAndReadConnections() {
  return new Promise((resolveConnections, rejectConnections) => {
    const timer = setTimeout(() => {
      rejectConnections(new Error(`Timed out waiting for smoke connections after ${timeoutMs}ms.`))
    }, timeoutMs)
    const connections = { backend: null, smoke: null }

    const spawnSpec = devAppSpawnSpec({
      env: smokeAppEnv({
        VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
        VIDEORC_USER_DATA_DIR: join(outputDirectory, 'user-data'),
        VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
        // The whole point: the smoke command server WITHOUT the synthetic
        // preview scene. The app must run its real capture config.
        VIDEORC_SMOKE_COMMAND_SERVER: '1',
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
      })
    })
    appProcess = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options)

    const maybeResolve = () => {
      if (connections.backend && connections.smoke) {
        clearTimeout(timer)
        resolveConnections(connections)
      }
    }

    const handleOutput = (text) => {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && !stopping) {
          console.log(line)
        }
        const backendMarker = '[smoke] backend-ready '
        const backendIndex = line.indexOf(backendMarker)
        if (backendIndex !== -1) {
          connections.backend = JSON.parse(line.slice(backendIndex + backendMarker.length))
          maybeResolve()
          continue
        }
        const smokeMarker = '[smoke] preview-motion-ready '
        const smokeIndex = line.indexOf(smokeMarker)
        if (smokeIndex !== -1) {
          connections.smoke = JSON.parse(line.slice(smokeIndex + smokeMarker.length))
          maybeResolve()
        }
      }
    }

    appProcess.stdout.setEncoding('utf8')
    appProcess.stderr.setEncoding('utf8')
    appProcess.stdout.on('data', handleOutput)
    appProcess.stderr.on('data', handleOutput)
    appProcess.on('error', (error) => {
      clearTimeout(timer)
      rejectConnections(error)
    })
    appProcess.on('exit', (code, signal) => {
      clearTimeout(timer)
      rejectConnections(
        new Error(`Real-launch app exited before smoke completed: code=${code} signal=${signal}`)
      )
    })
  })
}

async function smokeCommand(smoke, command, params = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      return await sendSmokeCommand(smoke, command, params)
    } catch (error) {
      lastError = error
      const message = String(error?.message ?? error)
      if (
        !message.includes('Main window is not ready') &&
        !message.includes('Could not find tab ')
      ) {
        throw error
      }
      await sleep(150)
    }
  }
  throw lastError ?? new Error(`${command} smoke command timed out.`)
}

function sendSmokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolveCommand, rejectCommand) => {
    const commandRequest = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${smoke.capability}`
        }
      },
      (response) => {
        let payload = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          payload += chunk
        })
        response.on('end', () => {
          try {
            const parsed = payload ? JSON.parse(payload) : {}
            if ((response.statusCode ?? 500) >= 400 || parsed?.error) {
              rejectCommand(new Error(parsed?.error ?? `HTTP ${response.statusCode}`))
              return
            }
            resolveCommand(parsed?.result ?? parsed)
          } catch (error) {
            rejectCommand(error)
          }
        })
      }
    )
    commandRequest.on('error', rejectCommand)
    commandRequest.write(body)
    commandRequest.end()
  })
}

async function stopApp() {
  if (!appProcess?.pid || appProcess.killed) {
    appProcess = null
    return
  }
  stopping = true
  await stopProcess(appProcess)
  appProcess = null
  stopping = false
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
