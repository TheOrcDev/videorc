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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { assertSmokeCommandConnection } from './smoke-command-client.mjs'

export const repoRoot = resolve(import.meta.dirname, '..', '..')

const MARKER_PREFIX = '[smoke] '

/**
 * Resolve the explicit packaged executable used by performance scenarios.
 * The returned shape can be passed directly to `launchDevApp({ spawnSpec })`.
 */
export function performanceAppSpawnSpec(env = process.env) {
  const executable = smokeEnvValue(env, 'VIDEORC_PERF_APP_EXECUTABLE')
  if (!executable) return undefined
  const command = resolve(executable)
  return { command, args: [], cwd: dirname(command) }
}

export function resolveSmokeAppDirs({ env = {}, statePrefix = 'videorc-smoke' } = {}) {
  const stateDir =
    explicitSmokeEnvValue(env, 'VIDEORC_SMOKE_STATE_DIR') ??
    explicitSmokeEnvValue(env, 'VIDEORC_SMOKE_OUTPUT_DIR')
  const appDataDir =
    explicitSmokeEnvValue(env, 'VIDEORC_APP_DATA_DIR') ??
    (stateDir
      ? join(resolve(stateDir), 'app-data')
      : mkdtempSync(join(tmpdir(), `${statePrefix}-app-data-`)))
  const userDataDir =
    explicitSmokeEnvValue(env, 'VIDEORC_USER_DATA_DIR') ??
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
  const explicitStateDir = explicitSmokeEnvValue(env, 'VIDEORC_SMOKE_STATE_DIR')
  const explicitOutputDir = explicitSmokeEnvValue(env, 'VIDEORC_SMOKE_OUTPUT_DIR')
  const isolationRoots = Array.from(
    new Set(
      [explicitStateDir, explicitOutputDir, appDataDir, userDataDir]
        .filter(Boolean)
        .map((path) => resolve(path))
    )
  )
  const result = {
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
    VIDEORC_DATABASE_PATH: isolatedSmokePath(
      env,
      'VIDEORC_DATABASE_PATH',
      join(appDataDir, 'videorc.sqlite3'),
      isolationRoots
    ),
    VIDEORC_SECRETS_PATH: isolatedSmokePath(
      env,
      'VIDEORC_SECRETS_PATH',
      join(appDataDir, 'videorc-secrets.json'),
      isolationRoots
    ),
    VIDEORC_RECORDINGS_DIR: isolatedSmokePath(
      env,
      'VIDEORC_RECORDINGS_DIR',
      join(appDataDir, 'recordings'),
      isolationRoots
    )
  }
  // Ambient smoke roots are just as unsafe as ambient state-file overrides:
  // a parent shell must not silently redirect a new harness into an older run.
  if (!explicitStateDir) delete result.VIDEORC_SMOKE_STATE_DIR
  if (!explicitOutputDir) delete result.VIDEORC_SMOKE_OUTPUT_DIR
  return result
}

function isolatedSmokePath(env, name, fallback, roots) {
  const explicitPath = explicitSmokeEnvValue(env, name)
  if (!explicitPath) return resolve(fallback)
  const candidate = resolve(explicitPath)
  if (!isPathInsideAnyRoot(candidate, roots)) {
    throw new Error(`${name} must be inside this smoke run's isolated state directories.`)
  }
  return candidate
}

function isPathInsideAnyRoot(candidate, roots) {
  if (!isAbsolute(candidate)) return false
  return roots.some((root) => {
    const relativePath = relative(resolve(root), candidate)
    return (
      relativePath.length > 0 &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath)
    )
  })
}

function explicitSmokeEnvValue(env, name) {
  const value = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined
  return typeof value === 'string' && value.trim() ? value : undefined
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
 * @param {string} [options.packagedSmokeCommandCapability] - caller-held capability for a
 *   packaged app marker, which intentionally never prints its bearer secret.
 * @param {(line:string)=>void} [options.onLine] - called for every stdout/stderr line.
 * @returns {Promise<{connections:Record<string,object>, process:import('node:child_process').ChildProcess, stop:()=>Promise<void>}>}
 */
export function launchDevApp({
  env = {},
  timeoutMs = 120000,
  requiredMarkers = ['backend-ready'],
  onLine,
  packagedSmokeCommandCapability,
  spawnSpec: requestedSpawnSpec
} = {}) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const connections = {}
    let settled = false
    let stopping = false
    let timer = null
    const recentOutput = []
    const childEnv = smokeAppEnv(env)
    const spawnSpec = requestedSpawnSpec
      ? appSpawnSpec({ ...requestedSpawnSpec, env: childEnv })
      : devAppSpawnSpec({ env: childEnv })

    const child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options)

    const stop = () => stopProcess(child, () => (stopping = true))
    const launchError = (message) => new Error(devAppFailureMessage(message, recentOutput))
    const rejectAfterStop = async (message) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)

      let cleanupFailure = null
      try {
        await stop()
      } catch (error) {
        cleanupFailure = error?.message ?? String(error)
      }

      rejectLaunch(
        launchError(
          cleanupFailure
            ? `${message}\n\nFailed to stop launched process group: ${cleanupFailure}`
            : message
        )
      )
    }

    timer = setTimeout(() => {
      void rejectAfterStop(
        `Timed out waiting for [${requiredMarkers.join(', ')}] after ${timeoutMs}ms.`
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
        let connection
        try {
          connection = JSON.parse(rest.slice(spaceIdx + 1))
        } catch {
          // A non-JSON tail for a known marker: ignore and keep waiting.
          continue
        }
        if (marker === 'preview-motion-ready') {
          if (packagedSmokeCommandCapability && connection?.capability === undefined) {
            connection = { ...connection, capability: packagedSmokeCommandCapability }
          }
          try {
            assertSmokeCommandConnection(connection)
          } catch (error) {
            void rejectAfterStop(
              `Invalid [smoke] preview-motion-ready marker: ${error?.message ?? error}`
            )
            return
          }
        }
        connections[marker] = connection
        settleIfReady()
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', handle)
    child.stderr.on('data', handle)
    child.on('error', (error) => {
      void rejectAfterStop(error.message)
    })
    child.on('exit', (code, signal) => {
      void rejectAfterStop(
        `Dev app exited before handshake completed: code=${code} signal=${signal}`
      )
    })
  })
}

export function devAppSpawnSpec({ env, platform = process.platform } = {}) {
  if (platform === 'win32') {
    return {
      command: env?.ComSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm --filter @videorc/desktop dev'],
      options: devAppSpawnOptions({ env, platform })
    }
  }
  return {
    command: 'pnpm',
    args: ['--filter', '@videorc/desktop', 'dev'],
    options: devAppSpawnOptions({ env, platform })
  }
}

export function appSpawnSpec({
  command,
  args = [],
  cwd = repoRoot,
  env,
  platform = process.platform
} = {}) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('Custom app launch requires a command.')
  }
  return {
    command,
    args,
    options: {
      ...devAppSpawnOptions({ env, platform }),
      cwd
    }
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
    // Windows dev launches use an explicit cmd.exe command string in
    // devAppSpawnSpec. shell:true with a separate argv array makes Node
    // reconstruct paths containing spaces unsafely.
    shell: false
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
