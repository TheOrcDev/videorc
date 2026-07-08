// Shared dev-app launcher for harnesses that need a real backend connection.
//
// Spawns `pnpm --filter @videorc/desktop dev`, parses the `[smoke] <marker> {json}`
// handshake lines the main process prints, and resolves once every required marker has
// been seen. Factored out of the per-smoke launch boilerplate so the real-source
// baseline harness (and future honest-gate harnesses) reuse one battle-tested
// launch/teardown path.
//
// Harnesses default to isolated app/user data and ledger reaping. Product launches
// still use the normal app data path unless a smoke explicitly opts into this helper.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const repoRoot = resolve(import.meta.dirname, '..', '..')

const MARKER_PREFIX = '[smoke] '

export function resolveSmokeAppDirs({ env = {}, statePrefix = 'videorc-smoke' } = {}) {
  const stateDir =
    smokeEnvValue(env, 'VIDEORC_SMOKE_STATE_DIR') ?? smokeEnvValue(env, 'VIDEORC_SMOKE_OUTPUT_DIR')
  const appDataDir =
    smokeEnvValue(env, 'VIDEORC_APP_DATA_DIR') ??
    (stateDir
      ? join(resolve(stateDir), 'app-data')
      : mkdtempSync(join(tmpdir(), `${statePrefix}-app-data-`)))
  const userDataDir =
    smokeEnvValue(env, 'VIDEORC_USER_DATA_DIR') ??
    (stateDir
      ? join(resolve(stateDir), 'user-data')
      : mkdtempSync(join(tmpdir(), `${statePrefix}-user-data-`)))
  return { appDataDir, userDataDir }
}

export function smokeAppEnv(env = {}, options = {}) {
  const { appDataDir, userDataDir } = resolveSmokeAppDirs({
    env,
    statePrefix: options.statePrefix
  })
  return {
    ...process.env,
    ...env,
    VIDEORC_SMOKE_PRINT_BACKEND_READY:
      smokeEnvValue(env, 'VIDEORC_SMOKE_PRINT_BACKEND_READY') ?? '1',
    VIDEORC_DISABLE_BACKEND_REAP: smokeEnvValue(env, 'VIDEORC_DISABLE_BACKEND_REAP') ?? '0',
    VIDEORC_APP_DATA_DIR: appDataDir,
    VIDEORC_USER_DATA_DIR: userDataDir,
    // Isolating Electron userData is NOT enough: the backend resolves its own
    // state (sqlite + secrets) to ~/Library/Application Support/Videorc unless
    // these envs override it. Without them every "isolated" smoke backend reads
    // and writes the REAL user profile — 2026-07-01 this filled the user's DB
    // with smoke test-pattern sessions and their preview showed the smoke's
    // bars. Full isolation or none.
    VIDEORC_DATABASE_PATH:
      smokeEnvValue(env, 'VIDEORC_DATABASE_PATH') ?? join(appDataDir, 'videorc.sqlite3'),
    VIDEORC_SECRETS_PATH:
      smokeEnvValue(env, 'VIDEORC_SECRETS_PATH') ?? join(appDataDir, 'videorc-secrets.json')
  }
}

function smokeEnvValue(env, name) {
  const value = env[name] ?? process.env[name]
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Launch the dev app and resolve with the parsed handshake connections.
 *
 * @param {object} options
 * @param {Record<string,string>} [options.env] - extra env vars for the child.
 * @param {number} [options.timeoutMs]
 * @param {string[]} [options.requiredMarkers] - marker names to wait for (without the
 *   `[smoke] ` prefix), e.g. ['backend-ready'].
 * @param {(line:string)=>void} [options.onLine] - called for every stdout/stderr line.
 * @returns {Promise<{connections:Record<string,object>, process:import('node:child_process').ChildProcess, stop:()=>Promise<void>}>}
 */
export function launchDevApp({
  env = {},
  timeoutMs = 120000,
  requiredMarkers = ['backend-ready'],
  onLine
} = {}) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const connections = {}
    let settled = false
    let stopping = false
    const recentOutput = []
    const childEnv = smokeAppEnv(env)
    const spawnSpec = devAppSpawnSpec({ env: childEnv })

    const child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options)

    const stop = () => stopProcess(child, () => (stopping = true))
    const launchError = (message) => new Error(devAppFailureMessage(message, recentOutput))

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void stop()
      rejectLaunch(
        launchError(`Timed out waiting for [${requiredMarkers.join(', ')}] after ${timeoutMs}ms.`)
      )
    }, timeoutMs)

    const settleIfReady = () => {
      if (settled) return
      if (requiredMarkers.every((marker) => connections[marker])) {
        settled = true
        clearTimeout(timer)
        resolveLaunch({ connections, process: child, stop })
      }
    }

    const handle = (text) => {
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        rememberRecentOutput(recentOutput, line)
        if (onLine && !stopping) onLine(line)
        const idx = line.indexOf(MARKER_PREFIX)
        if (idx === -1) continue
        const rest = line.slice(idx + MARKER_PREFIX.length)
        const spaceIdx = rest.indexOf(' ')
        if (spaceIdx === -1) continue
        const marker = rest.slice(0, spaceIdx)
        if (!requiredMarkers.includes(marker)) continue
        try {
          connections[marker] = JSON.parse(rest.slice(spaceIdx + 1))
          settleIfReady()
        } catch {
          // A non-JSON tail for a known marker: ignore and keep waiting.
        }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', handle)
    child.stderr.on('data', handle)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectLaunch(launchError(error.message))
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectLaunch(
        launchError(`Dev app exited before handshake completed: code=${code} signal=${signal}`)
      )
    })
  })
}

export function devAppSpawnSpec({ env, platform = process.platform } = {}) {
  return {
    command: 'pnpm',
    args: ['--filter', '@videorc/desktop', 'dev'],
    options: devAppSpawnOptions({ env, platform })
  }
}

export function devAppSpawnOptions({ env, platform = process.platform } = {}) {
  return {
    cwd: repoRoot,
    // POSIX only: detached puts the app in its own process group so stopProcess
    // can signal the whole tree. On Windows, detached + shell silently routes
    // the child's stdout/stderr away from our pipes (observed 2026-07-08: zero
    // captured output, handshake markers never seen), and group signalling
    // doesn't exist anyway — stopProcess uses taskkill /T there instead.
    detached: platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: platform === 'win32'
  }
}

export function devAppFailureMessage(message, recentOutput = []) {
  const output = recentOutput.filter((line) => line.trim())
  if (output.length === 0) {
    return message
  }
  return `${message}\n\nLast dev app output:\n${output.join('\n')}`
}

function rememberRecentOutput(output, line, limit = 40) {
  output.push(line)
  if (output.length > limit) {
    output.splice(0, output.length - limit)
  }
}

/** SIGTERM the process tree, escalating to SIGKILL after bounded grace periods. */
export async function stopProcess(child, beforeStopOrOptions, maybeOptions) {
  const options = normalizeStopProcessOptions(beforeStopOrOptions, maybeOptions)
  const pid = child?.pid
  if (!pid) {
    return {
      pid: null,
      state: 'skipped',
      childExited: true,
      processGroupExited: true,
      escalated: false,
      signals: []
    }
  }

  const result = {
    pid,
    state: 'stopping',
    childExited: isChildExited(child),
    processGroupExited: !options.processGroupExists(pid),
    escalated: false,
    signals: []
  }

  options.beforeStop?.()
  sendStopSignal({
    child,
    pid,
    signal: 'SIGTERM',
    result,
    signalProcessGroup: options.signalProcessGroup
  })
  await options.waitForChildExit(child, options.childExitTimeoutMs)

  await finishGracefulStop({ child, pid, result, options })
  await finishForcedStop({ child, pid, result, options })

  result.childExited = isChildExited(child)
  result.processGroupExited = !options.processGroupExists(pid)
  result.state =
    result.childExited && result.processGroupExited
      ? result.escalated
        ? 'killed'
        : 'terminated'
      : 'leaked'

  if (result.state === 'leaked' && options.throwOnLeak) {
    throw new Error(
      `Process ${pid} did not exit after ${result.signals.join(' -> ')}; childExited=${result.childExited} processGroupExited=${result.processGroupExited}`
    )
  }

  return result
}

function normalizeStopProcessOptions(beforeStopOrOptions, maybeOptions) {
  const options =
    typeof beforeStopOrOptions === 'function'
      ? { ...maybeOptions, beforeStop: beforeStopOrOptions }
      : { ...(beforeStopOrOptions ?? {}) }
  return {
    beforeStop: options.beforeStop,
    childExitTimeoutMs: options.childExitTimeoutMs ?? 5000,
    terminateGraceMs: options.terminateGraceMs ?? 500,
    killGraceMs: options.killGraceMs ?? 1000,
    throwOnLeak: options.throwOnLeak ?? true,
    signalProcessGroup: options.signalProcessGroup ?? signalProcessGroup,
    waitForChildExit: options.waitForChildExit ?? waitForChildExit,
    waitForProcessGroupExit: options.waitForProcessGroupExit ?? waitForProcessGroupExit,
    processGroupExists: options.processGroupExists ?? processGroupExists
  }
}

async function finishGracefulStop({ child, pid, result, options }) {
  result.childExited = isChildExited(child)
  result.processGroupExited = !options.processGroupExists(pid)
  if (result.childExited && result.processGroupExited) {
    return
  }

  sendStopSignal({
    child,
    pid,
    signal: 'SIGTERM',
    result,
    signalProcessGroup: options.signalProcessGroup
  })
  await options.waitForChildExit(child, options.terminateGraceMs)
  if (options.processGroupExists(pid)) {
    await options.waitForProcessGroupExit(pid, options.terminateGraceMs, options.processGroupExists)
  }
}

async function finishForcedStop({ child, pid, result, options }) {
  result.childExited = isChildExited(child)
  result.processGroupExited = !options.processGroupExists(pid)
  if (result.childExited && result.processGroupExited) {
    return
  }

  result.escalated = true
  sendStopSignal({
    child,
    pid,
    signal: 'SIGKILL',
    result,
    signalProcessGroup: options.signalProcessGroup
  })
  await options.waitForChildExit(child, options.killGraceMs)
  if (options.processGroupExists(pid)) {
    await options.waitForProcessGroupExit(pid, options.killGraceMs, options.processGroupExists)
  }
}

function sendStopSignal({ child, pid, signal, result, signalProcessGroup }) {
  result.signals.push(signal)
  signalProcessGroup(pid, child, signal)
}

function isChildExited(child) {
  return child.exitCode != null || child.signalCode != null
}

function signalProcessGroup(pid, child, sig) {
  if (process.platform === 'win32') {
    // No POSIX process groups on Windows: taskkill /T walks the child tree
    // (shell -> pnpm -> electron -> cargo -> backend). Always force with /F —
    // without it taskkill only posts WM_CLOSE, which console processes ignore;
    // the shell root then exits on its own and a later forced pass has no tree
    // left to walk, orphaning electron/cargo/backend (observed 2026-07-08).
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      try {
        child?.kill(sig)
      } catch {
        // Nothing left to signal.
      }
    }
    return
  }
  try {
    process.kill(-pid, sig)
  } catch {
    try {
      child?.kill(sig)
    } catch {
      // Nothing left to signal.
    }
  }
}

function waitForChildExit(child, timeoutMs) {
  if (isChildExited(child)) return Promise.resolve()
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveWait()
    })
  })
}

function waitForProcessGroupExit(pid, timeoutMs, processGroupExistsFn = processGroupExists) {
  const startedAt = Date.now()
  return new Promise((resolveWait) => {
    const poll = () => {
      if (!processGroupExistsFn(pid) || Date.now() - startedAt >= timeoutMs) {
        resolveWait()
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
}

function processGroupExists(pid) {
  // Windows has no process groups; the spawned shell pid stands in for the
  // tree (taskkill /T above removes it together with its descendants).
  const target = process.platform === 'win32' ? pid : -pid
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}
