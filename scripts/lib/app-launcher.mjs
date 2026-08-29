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
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import { assertSmokeCommandConnection } from './smoke-command-client.mjs'

export const repoRoot = resolve(import.meta.dirname, '..', '..')

const MARKER_PREFIX = '[smoke] '
const LAUNCH_SERVICES_COMPUTED_ENV_NAMES = [
  'VIDEORC_APP_DATA_DIR',
  'VIDEORC_DATABASE_PATH',
  'VIDEORC_DISABLE_BACKEND_REAP',
  'VIDEORC_RECORDINGS_DIR',
  'VIDEORC_SECRETS_PATH',
  'VIDEORC_SMOKE_PRINT_BACKEND_READY',
  'VIDEORC_SMOKE_APP_OWNERSHIP_PATH',
  'VIDEORC_SMOKE_APP_OWNERSHIP_TOKEN',
  'VIDEORC_USER_DATA_DIR'
]

const LAUNCH_SERVICES_OWNERSHIP_WAIT_MS = 30_000

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

/**
 * Turns arbitrary text-stream chunks into complete lines. stdout and stderr
 * need separate instances: a trailing fragment from one stream must never be
 * joined to the next chunk delivered by the other.
 */
export function createLineBuffer(onLine) {
  let remainder = ''

  const emit = (line) => {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }

  return {
    write(text) {
      const lines = `${remainder}${text}`.split('\n')
      remainder = lines.pop() ?? ''
      for (const line of lines) emit(line)
    },
    flush() {
      if (!remainder) return
      const line = remainder
      remainder = ''
      emit(line)
    }
  }
}

export function windowsAcceptanceProfileDir({
  env = {},
  platform = process.platform,
  ownerProbe = windowsPathOwnerProbe
} = {}) {
  const configured = explicitSmokeEnvValue(env, 'VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR')
  if (!configured) return undefined

  if (env.VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED !== '1') {
    throw new Error(
      'VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR is acceptance-only and requires VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED=1.'
    )
  }
  if (platform !== 'win32') {
    throw new Error('VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR is supported only on Windows.')
  }
  if (!isAbsolute(configured)) {
    throw new Error('VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR must be absolute.')
  }

  const profileDir = realpathSync(resolve(configured))
  if (!statSync(profileDir).isDirectory()) {
    throw new Error('VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR must name an existing directory.')
  }

  const evidenceValue =
    explicitSmokeEnvValue(env, 'VIDEORC_WINDOWS_ACCEPTANCE_DIR') ??
    explicitSmokeEnvValue(env, 'VIDEORC_SMOKE_OUTPUT_DIR')
  if (!evidenceValue || !isAbsolute(evidenceValue)) {
    throw new Error(
      'A preserved acceptance profile requires an absolute VIDEORC_WINDOWS_ACCEPTANCE_DIR or VIDEORC_SMOKE_OUTPUT_DIR.'
    )
  }
  const evidenceDir = realpathSync(resolve(evidenceValue))
  if (pathsOverlap(profileDir, evidenceDir)) {
    throw new Error(
      'VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR must be outside the acceptance evidence directory.'
    )
  }

  const ownership = ownerProbe(profileDir)
  const current = ownership?.current?.trim().toLocaleLowerCase('en-US')
  const owner = ownership?.owner?.trim().toLocaleLowerCase('en-US')
  if (!current || !owner || current !== owner) {
    throw new Error(
      'VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR must be owned by the current Windows user.'
    )
  }
  return profileDir
}

export function resolveSmokeAppDirs({
  env = {},
  statePrefix = 'videorc-smoke',
  platform = process.platform,
  ownerProbe
} = {}) {
  const acceptanceProfileDir = windowsAcceptanceProfileDir({ env, platform, ownerProbe })
  const stateDir =
    explicitSmokeEnvValue(env, 'VIDEORC_SMOKE_STATE_DIR') ??
    explicitSmokeEnvValue(env, 'VIDEORC_SMOKE_OUTPUT_DIR')
  const appDataDir =
    acceptanceProfileDir === undefined
      ? (explicitSmokeEnvValue(env, 'VIDEORC_APP_DATA_DIR') ??
        (stateDir
          ? join(resolve(stateDir), 'app-data')
          : mkdtempSync(join(tmpdir(), `${statePrefix}-app-data-`))))
      : join(acceptanceProfileDir, 'app-data')
  const userDataDir =
    acceptanceProfileDir === undefined
      ? (explicitSmokeEnvValue(env, 'VIDEORC_USER_DATA_DIR') ??
        (stateDir
          ? join(resolve(stateDir), 'user-data')
          : mkdtempSync(join(tmpdir(), `${statePrefix}-user-data-`))))
      : join(acceptanceProfileDir, 'user-data')
  return { appDataDir, userDataDir }
}

export function smokeAppEnv(env = {}, options = {}) {
  const acceptanceProfileDir = windowsAcceptanceProfileDir({
    env,
    platform: options.platform,
    ownerProbe: options.ownerProbe
  })
  const { appDataDir, userDataDir } = resolveSmokeAppDirs({
    env,
    statePrefix: options.statePrefix,
    platform: options.platform,
    ownerProbe: options.ownerProbe
  })
  const explicitStateDir = explicitSmokeEnvValue(env, 'VIDEORC_SMOKE_STATE_DIR')
  const explicitOutputDir = explicitSmokeEnvValue(env, 'VIDEORC_SMOKE_OUTPUT_DIR')
  const isolationRoots = acceptanceProfileDir
    ? [acceptanceProfileDir]
    : Array.from(
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
  // These are generated per LaunchServices invocation below. Never inherit a
  // stale ownership endpoint into a direct/dev launch.
  delete result.VIDEORC_SMOKE_APP_OWNERSHIP_PATH
  delete result.VIDEORC_SMOKE_APP_OWNERSHIP_TOKEN
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

function pathsOverlap(left, right) {
  const leftPath = resolve(left)
  const rightPath = resolve(right)
  if (leftPath === rightPath) return true
  return isPathInsideOrEqual(leftPath, rightPath) || isPathInsideOrEqual(rightPath, leftPath)
}

function isPathInsideOrEqual(candidate, root) {
  const relativePath = relative(resolve(root), resolve(candidate))
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  )
}

function windowsPathOwnerProbe(path) {
  const literalPath = path.replaceAll("'", "''")
  const script =
    `$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name;` +
    `$owner=(Get-Acl -LiteralPath '${literalPath}').Owner;` +
    `[Console]::Out.Write($current + [Environment]::NewLine + $owner)`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  )
  const [current, owner] = output.trim().split(/\r?\n/, 2)
  return { current, owner }
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
 * @param {boolean} [options.launchViaMacosLaunchServices] - launch the exact packaged app
 *   bundle through `open`, preserving its macOS TCC identity.
 * @param {(line:string)=>void} [options.onLine] - called for every stdout/stderr line.
 * @returns {Promise<{connections:Record<string,object>, process:import('node:child_process').ChildProcess, stop:()=>Promise<void>}>}
 */
export function launchDevApp({
  env = {},
  timeoutMs = 120000,
  requiredMarkers = ['backend-ready'],
  onLine,
  packagedSmokeCommandCapability,
  launchViaMacosLaunchServices = false,
  spawnSpec: requestedSpawnSpec
} = {}) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const connections = {}
    let settled = false
    let stopping = false
    let timer = null
    let launchPollTimer = null
    const recentOutput = []
    const childEnv = smokeAppEnv(env)
    const spawnSpec = launchViaMacosLaunchServices
      ? macosLaunchServicesAppSpawnSpec({
          ...requestedSpawnSpec,
          env: childEnv,
          requestedEnv: env
        })
      : requestedSpawnSpec
        ? appSpawnSpec({ ...requestedSpawnSpec, env: childEnv })
        : devAppSpawnSpec({ env: childEnv })

    for (const outputPath of spawnSpec.handshakeOutputPaths ?? []) {
      mkdirSync(dirname(outputPath), { recursive: true })
      const output = openSync(outputPath, 'wx', 0o600)
      closeSync(output)
    }
    if (spawnSpec.appOwnership) {
      mkdirSync(dirname(spawnSpec.appOwnership.path), { recursive: true })
    }

    const child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options)

    const stop = async () => {
      stopping = true
      if (launchPollTimer) clearInterval(launchPollTimer)
      return launchViaMacosLaunchServices
        ? stopMacosLaunchServicesApp(child, connections, spawnSpec.appOwnership)
        : stopProcess(child)
    }
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

    const handleLine = (line) => {
      if (!line.trim()) return
      rememberRecentOutput(recentOutput, line)
      if (onLine && !stopping) onLine(line)
      const idx = line.indexOf(MARKER_PREFIX)
      if (idx === -1) return
      const rest = line.slice(idx + MARKER_PREFIX.length)
      const spaceIdx = rest.indexOf(' ')
      if (spaceIdx === -1) return
      const marker = rest.slice(0, spaceIdx)
      if (!requiredMarkers.includes(marker)) return
      let connection
      try {
        connection = JSON.parse(rest.slice(spaceIdx + 1))
      } catch {
        // A non-JSON tail for a known marker: ignore and keep waiting.
        return
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

    const stdoutLines = createLineBuffer(handleLine)
    const stderrLines = createLineBuffer(handleLine)
    const launchOutputReaders = (spawnSpec.handshakeOutputPaths ?? []).map((path) => ({
      path,
      position: 0,
      lines: createLineBuffer(handleLine)
    }))
    const pollLaunchOutput = () => {
      try {
        captureMacosLaunchServicesAppOwnership(spawnSpec.appOwnership)
        for (const reader of launchOutputReaders) readLaunchOutput(reader)
      } catch (error) {
        if (!stopping) {
          void rejectAfterStop(
            `Could not read LaunchServices launch evidence: ${error?.message ?? String(error)}`
          )
        }
      }
    }
    if (launchOutputReaders.length > 0 || spawnSpec.appOwnership) {
      pollLaunchOutput()
      launchPollTimer = setInterval(pollLaunchOutput, 50)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => stdoutLines.write(text))
    child.stderr.on('data', (text) => stderrLines.write(text))
    child.stdout.on('end', () => stdoutLines.flush())
    child.stderr.on('end', () => stderrLines.flush())
    child.on('error', (error) => {
      void rejectAfterStop(error.message)
    })
    // `close` follows both `exit` and stdio shutdown. Waiting for it keeps the
    // final output chunks in order before flushing a possible unterminated line.
    child.on('close', (code, signal) => {
      pollLaunchOutput()
      for (const reader of launchOutputReaders) reader.lines.flush()
      if (launchPollTimer) clearInterval(launchPollTimer)
      stdoutLines.flush()
      stderrLines.flush()
      void rejectAfterStop(
        `Dev app exited before handshake completed: code=${code} signal=${signal}`
      )
    })
  })
}

/** Build the exact LaunchServices invocation used by real-source macOS soaks.
 * `-W` keeps a controller process alive, while stdout/stderr redirection keeps
 * the existing authenticated smoke handshakes observable without direct-spawn
 * TCC identity loss. Only explicit smoke values and launcher-computed isolation
 * paths cross the `open --env` boundary. */
export function macosLaunchServicesAppSpawnSpec({
  command,
  env = {},
  requestedEnv = {},
  outputPaths,
  appOwnership,
  platform = process.platform
} = {}) {
  if (platform !== 'darwin') {
    throw new Error('LaunchServices app launch is supported only on macOS.')
  }
  const bundlePath = macosAppBundlePath(command)
  const executablePath = posix.resolve(command)
  const launchOutputPaths = outputPaths ?? launchServicesOutputPaths(env)
  const configuredAppOwnership = appOwnership ?? launchServicesAppOwnership(env)
  validateMacosLaunchServicesAppOwnership(configuredAppOwnership)
  const launchAppOwnership = {
    path: configuredAppOwnership.path,
    token: configuredAppOwnership.token,
    expectedExecutablePath: executablePath,
    expectedBundlePath: bundlePath
  }
  const launchEnv = {
    ...env,
    VIDEORC_SMOKE_APP_OWNERSHIP_PATH: launchAppOwnership.path,
    VIDEORC_SMOKE_APP_OWNERSHIP_TOKEN: launchAppOwnership.token
  }
  const environmentNames = new Set([
    ...Object.keys(requestedEnv),
    ...LAUNCH_SERVICES_COMPUTED_ENV_NAMES
  ])
  const args = [
    '-n',
    '-W',
    '-a',
    bundlePath,
    '-o',
    launchOutputPaths.stdout,
    '--stderr',
    launchOutputPaths.stderr
  ]
  for (const name of [...environmentNames].sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid LaunchServices environment name: ${name}`)
    }
    const value = launchEnv[name]
    if (value === undefined) continue
    const text = String(value)
    if (text.includes('\0')) {
      throw new Error(`LaunchServices environment ${name} contains a null byte.`)
    }
    args.push('--env', `${name}=${text}`)
  }
  return {
    command: '/usr/bin/open',
    args,
    options: {
      ...devAppSpawnOptions({ env: launchServicesControllerEnv(env), platform }),
      cwd: posix.dirname(bundlePath)
    },
    handshakeOutputPaths: [launchOutputPaths.stdout, launchOutputPaths.stderr],
    appOwnership: launchAppOwnership
  }
}

function launchServicesOutputPaths(env) {
  const root = resolve(env.VIDEORC_SMOKE_STATE_DIR ?? env.VIDEORC_APP_DATA_DIR ?? tmpdir())
  const id = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
  return {
    stdout: join(root, `launch-services-${id}.stdout.log`),
    stderr: join(root, `launch-services-${id}.stderr.log`)
  }
}

function launchServicesAppOwnership(env) {
  const root = resolve(env.VIDEORC_SMOKE_STATE_DIR ?? env.VIDEORC_APP_DATA_DIR ?? tmpdir())
  const id = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
  return {
    path: join(root, `launch-services-${id}.app-ownership.json`),
    token: randomBytes(32).toString('base64url')
  }
}

export function macosAppBundlePath(executable) {
  if (typeof executable !== 'string' || !executable.trim()) {
    throw new Error('LaunchServices app launch requires a packaged executable path.')
  }
  // LaunchServices always consumes Darwin/POSIX paths. Parse that wire format
  // explicitly so its validation remains testable on non-macOS CI hosts.
  const normalized = posix.resolve(executable)
  const marker = '.app'
  const markerIndex = normalized.toLocaleLowerCase('en-US').indexOf(`${marker}/`)
  if (
    markerIndex === -1 ||
    !normalized.slice(markerIndex + marker.length + 1).startsWith('Contents/')
  ) {
    throw new Error('LaunchServices app launch requires an executable inside a .app bundle.')
  }
  return normalized.slice(0, markerIndex + marker.length)
}

function launchServicesControllerEnv(env) {
  return Object.fromEntries(
    ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMPDIR']
      .filter((name) => typeof env[name] === 'string')
      .map((name) => [name, env[name]])
  )
}

async function stopMacosLaunchServicesApp(child, connections, appOwnership) {
  let appStopFailure = null
  try {
    const appPid = await resolveMacosLaunchServicesAppPid({
      appOwnership,
      previewMarker: connections['preview-motion-ready'],
      controller: child
    })
    if (appPid) {
      if (!appOwnership?.processIdentity) {
        throw new Error(
          `LaunchServices-owned app pid ${appPid} has no captured Darwin process identity; refusing to signal it.`
        )
      }
      await terminateMacosLaunchServicesOwnedProcess({
        pid: appPid,
        processIdentity: appOwnership.processIdentity
      })
    }
  } catch (error) {
    appStopFailure = error
  }

  let controllerResult
  try {
    controllerResult = await stopProcess(child)
  } catch (error) {
    if (appStopFailure) {
      throw new Error(
        `${appStopFailure?.message ?? appStopFailure}; LaunchServices controller cleanup also failed: ${error?.message ?? error}`
      )
    }
    throw error
  }
  if (appStopFailure) throw appStopFailure
  return controllerResult
}

export async function resolveMacosLaunchServicesAppPid({
  appOwnership,
  previewMarker,
  controller,
  identityProbe = probeDarwinProcessIdentity,
  canonicalPath = canonicalExistingPath
}) {
  if (appOwnership) {
    captureMacosLaunchServicesAppOwnership(appOwnership, identityProbe, canonicalPath)
    if (appOwnership.appPid) return appOwnership.appPid
  }
  const markerPid = previewMarker?.appPid
  if (!appOwnership && Number.isSafeInteger(markerPid) && markerPid > 1) return markerPid
  if (!appOwnership) return null

  const deadline = Date.now() + LAUNCH_SERVICES_OWNERSHIP_WAIT_MS
  while (Date.now() < deadline && !isChildExited(controller)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    captureMacosLaunchServicesAppOwnership(appOwnership, identityProbe, canonicalPath)
    if (appOwnership.appPid) return appOwnership.appPid
  }
  captureMacosLaunchServicesAppOwnership(appOwnership, identityProbe, canonicalPath)
  if (appOwnership.appPid) return appOwnership.appPid
  if (!isChildExited(controller)) {
    throw new Error(
      `LaunchServices app ownership was not published within ${LAUNCH_SERVICES_OWNERSHIP_WAIT_MS}ms; refusing to claim exact app cleanup.`
    )
  }
  return null
}

function captureMacosLaunchServicesAppOwnership(
  appOwnership,
  identityProbe = probeDarwinProcessIdentity,
  canonicalPath = canonicalExistingPath
) {
  if (!appOwnership) return
  if (appOwnership.appPid || appOwnership.processIdentity) {
    if (appOwnership.appPid && appOwnership.processIdentity) return
    throw new Error('LaunchServices app ownership cached an incomplete Darwin process identity.')
  }
  const publication = readMacosLaunchServicesAppOwnership(appOwnership)
  if (!publication) return

  const publishedPaths = canonicalLaunchServicesPublicationPaths(
    publication,
    appOwnership,
    canonicalPath
  )
  const processIdentity = inspectOwnedDarwinProcessIdentity(publication.appPid, identityProbe)
  if (!processIdentity) {
    throw new Error(
      `LaunchServices-owned app pid ${publication.appPid} exited before its Darwin process identity could be captured.`
    )
  }
  if (
    processIdentity.executablePath !== publishedPaths.executablePath ||
    processIdentity.bundlePath !== publishedPaths.bundlePath
  ) {
    throw new Error(
      `LaunchServices-owned app pid ${publication.appPid} did not match its published executable and bundle identity.`
    )
  }

  // Assign only after the authenticated publication and the OS observation
  // agree, so no caller can ever see a signalable PID without its birth/path
  // identity captured alongside it.
  appOwnership.appPid = publication.appPid
  appOwnership.processIdentity = processIdentity
}

function validateMacosLaunchServicesAppOwnership(appOwnership) {
  if (!appOwnership || typeof appOwnership.path !== 'string' || !isAbsolute(appOwnership.path)) {
    throw new Error('LaunchServices app ownership path must be absolute.')
  }
  if (typeof appOwnership.token !== 'string' || appOwnership.token.length < 32) {
    throw new Error('LaunchServices app ownership token must contain at least 32 characters.')
  }
}

export function readMacosLaunchServicesAppOwnership(
  appOwnership,
  { platform = process.platform } = {}
) {
  validateMacosLaunchServicesAppOwnership(appOwnership)
  if (!existsSync(appOwnership.path)) return null
  const metadata = lstatSync(appOwnership.path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('LaunchServices app ownership path is not a regular file.')
  }
  // Windows does not expose POSIX owner/group/other permission semantics.
  // Production LaunchServices runs on Darwin, where this remains fail-closed.
  if (platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('LaunchServices app ownership file must not be accessible by other users.')
  }
  let payload
  try {
    payload = JSON.parse(readFileSync(appOwnership.path, 'utf8'))
  } catch {
    // `writeFileSync(..., { flag: 'wx' })` makes the name visible immediately
    // before its tiny payload is complete. Treat that sub-millisecond state as
    // pending and retry; an invalid/stale file makes the smoke app fail its
    // exclusive publish and the `open -W` controller exit.
    return null
  }
  if (payload?.token !== appOwnership.token) {
    throw new Error('LaunchServices app ownership authentication token did not match.')
  }
  if (payload?.schemaVersion !== 1) {
    throw new Error('LaunchServices app ownership file used an unsupported schema version.')
  }
  if (!Number.isSafeInteger(payload?.appPid) || payload.appPid <= 1) {
    throw new Error('LaunchServices app ownership file did not contain a valid app PID.')
  }
  if (typeof payload.executablePath !== 'string' || !isAbsolute(payload.executablePath)) {
    throw new Error(
      'LaunchServices app ownership file did not contain an absolute executable path.'
    )
  }
  if (typeof payload.bundlePath !== 'string' || !isAbsolute(payload.bundlePath)) {
    throw new Error('LaunchServices app ownership file did not contain an absolute bundle path.')
  }
  return payload
}

function canonicalLaunchServicesPublicationPaths(
  publication,
  appOwnership,
  canonicalPath = canonicalExistingPath
) {
  const executablePath = canonicalPath(
    publication.executablePath,
    'published LaunchServices executable'
  )
  const bundlePath = canonicalPath(publication.bundlePath, 'published LaunchServices app bundle')
  const executableBundlePath = canonicalPath(
    macosAppBundlePath(executablePath),
    'bundle derived from the published LaunchServices executable'
  )
  if (bundlePath !== executableBundlePath) {
    throw new Error(
      'LaunchServices app ownership executable was not inside its published app bundle.'
    )
  }

  if (appOwnership.expectedExecutablePath) {
    const expectedExecutablePath = canonicalPath(
      appOwnership.expectedExecutablePath,
      'expected LaunchServices executable'
    )
    if (executablePath !== expectedExecutablePath) {
      throw new Error('LaunchServices app ownership executable did not match the launched app.')
    }
  }
  if (appOwnership.expectedBundlePath) {
    const expectedBundlePath = canonicalPath(
      appOwnership.expectedBundlePath,
      'expected LaunchServices app bundle'
    )
    if (bundlePath !== expectedBundlePath) {
      throw new Error('LaunchServices app ownership bundle did not match the launched app.')
    }
  }
  return { executablePath, bundlePath }
}

function canonicalExistingPath(path, label) {
  try {
    return realpathSync(path)
  } catch (error) {
    throw new Error(`${label} could not be resolved: ${error?.message ?? String(error)}`)
  }
}

/** Capture the Darwin identity fields that survive ordinary liveness checks.
 * PID alone is intentionally insufficient: macOS can recycle it after the app
 * exits, so every later signal/wait decision also compares birth time and the
 * exact executable/bundle path. */
export function probeDarwinProcessIdentity(
  pid,
  { execFile = execFileSync, platform = process.platform, processIsAlive = exactPidIsAlive } = {}
) {
  if (platform !== 'darwin') {
    throw new Error('Darwin process identity can be captured only on macOS.')
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error('Darwin process identity requires a valid PID.')
  }

  let output
  try {
    output = execFile(
      '/bin/ps',
      ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'comm='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' }
      }
    )
  } catch (error) {
    if (!processIsAlive(pid)) return null
    throw new Error(
      `Could not inspect Darwin process identity for pid ${pid}: ${error?.message ?? String(error)}`
    )
  }

  const match = String(output)
    .trim()
    .match(/^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)
  if (!match || Number(match[1]) !== pid) {
    if (!processIsAlive(pid)) return null
    throw new Error(`Darwin process identity output for pid ${pid} was incomplete.`)
  }

  const executablePath = canonicalExistingPath(match[3], `Darwin executable for pid ${pid}`)
  const observedBundlePath = macosAppBundlePathOrNull(executablePath)
  const bundlePath = observedBundlePath
    ? canonicalExistingPath(observedBundlePath, `Darwin app bundle for pid ${pid}`)
    : null
  return {
    startTime: match[2].replace(/\s+/g, ' '),
    executablePath,
    bundlePath
  }
}

function readLaunchOutput(reader) {
  if (!existsSync(reader.path)) return
  const size = statSync(reader.path).size
  if (size < reader.position) reader.position = 0
  if (size === reader.position) return
  const file = openSync(reader.path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - reader.position))
    while (reader.position < size) {
      const length = Math.min(chunk.length, size - reader.position)
      const bytesRead = readSync(file, chunk, 0, length, reader.position)
      if (bytesRead <= 0) break
      reader.position += bytesRead
      reader.lines.write(chunk.toString('utf8', 0, bytesRead))
    }
  } finally {
    closeSync(file)
  }
}

export async function terminateMacosLaunchServicesOwnedProcess({
  pid,
  processIdentity,
  identityProbe = probeDarwinProcessIdentity,
  signalProcess = (ownedPid, signal) => process.kill(ownedPid, signal),
  timeoutMs = 60_000,
  now = Date.now,
  sleep = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs))
}) {
  validateDarwinProcessIdentity(processIdentity, pid, { requireBundle: true })

  // This is the last operation before SIGTERM. A plain kill(pid, 0) would
  // happily accept a different process after PID reuse; only the full captured
  // identity authorizes a signal.
  const currentIdentity = inspectOwnedDarwinProcessIdentity(pid, identityProbe)
  if (!sameDarwinProcessIdentity(processIdentity, currentIdentity)) {
    return { pid, state: 'already-exited', signaled: false }
  }

  try {
    signalProcess(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return { pid, state: 'already-exited', signaled: false }
    }
    throw error
  }

  if (
    !(await waitForExactDarwinProcessExit(pid, processIdentity, timeoutMs, {
      identityProbe,
      now,
      sleep
    }))
  ) {
    throw new Error(
      `LaunchServices-owned app pid ${pid} did not finish its graceful shutdown; the controller remains attached.`
    )
  }
  return { pid, state: 'terminated', signaled: true }
}

async function waitForExactDarwinProcessExit(
  pid,
  processIdentity,
  timeoutMs,
  { identityProbe, now, sleep }
) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    const currentIdentity = inspectOwnedDarwinProcessIdentity(pid, identityProbe)
    if (!sameDarwinProcessIdentity(processIdentity, currentIdentity)) return true
    await sleep(50)
  }
  const currentIdentity = inspectOwnedDarwinProcessIdentity(pid, identityProbe)
  return !sameDarwinProcessIdentity(processIdentity, currentIdentity)
}

function inspectOwnedDarwinProcessIdentity(pid, identityProbe) {
  const identity = identityProbe(pid)
  if (identity === null) return null
  validateDarwinProcessIdentity(identity, pid)
  return identity
}

function validateDarwinProcessIdentity(identity, pid, { requireBundle = false } = {}) {
  if (!identity || typeof identity !== 'object') {
    throw new Error(`Darwin process identity for pid ${pid} could not be captured.`)
  }
  if (typeof identity.startTime !== 'string' || !identity.startTime.trim()) {
    throw new Error(`Darwin process identity for pid ${pid} did not contain a start time.`)
  }
  if (typeof identity.executablePath !== 'string' || !posix.isAbsolute(identity.executablePath)) {
    throw new Error(`Darwin process identity for pid ${pid} did not contain an executable path.`)
  }
  if (
    (requireBundle && identity.bundlePath === null) ||
    (identity.bundlePath !== null &&
      (typeof identity.bundlePath !== 'string' || !posix.isAbsolute(identity.bundlePath)))
  ) {
    throw new Error(`Darwin process identity for pid ${pid} did not contain an app bundle path.`)
  }
  if (
    identity.bundlePath !== null &&
    macosAppBundlePath(identity.executablePath) !== posix.resolve(identity.bundlePath)
  ) {
    throw new Error(`Darwin process identity for pid ${pid} had inconsistent executable paths.`)
  }
}

function macosAppBundlePathOrNull(executablePath) {
  try {
    return macosAppBundlePath(executablePath)
  } catch {
    return null
  }
}

function sameDarwinProcessIdentity(expected, current) {
  return (
    current !== null &&
    current.startTime === expected.startTime &&
    current.executablePath === expected.executablePath &&
    current.bundlePath === expected.bundlePath
  )
}

function exactPidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
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
      forced: false,
      signals: []
    }
  }

  const result = {
    pid,
    state: 'stopping',
    childExited: isChildExited(child),
    processGroupExited: !options.processGroupExists(pid),
    escalated: false,
    forced: false,
    signals: []
  }

  if (result.childExited && result.processGroupExited) {
    result.state = 'skipped'
    return result
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
      ? result.forced
        ? 'force-terminated'
        : result.escalated
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
  const signalResult = signalProcessGroup(pid, child, signal)
  if (signalResult === true || signalResult?.forced === true) {
    result.forced = true
  }
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
      return { forced: true }
    } catch {
      try {
        child?.kill(sig)
      } catch {
        // Nothing left to signal.
      }
    }
    return { forced: false }
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
  return { forced: false }
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
