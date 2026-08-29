import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  appSpawnSpec,
  createLineBuffer,
  devAppFailureMessage,
  devAppSpawnOptions,
  devAppSpawnSpec,
  launchDevApp,
  macosAppBundlePath,
  macosLaunchServicesAppSpawnSpec,
  performanceAppSpawnSpec,
  readMacosLaunchServicesAppOwnership,
  resolveMacosLaunchServicesAppPid,
  resolveSmokeAppDirs,
  smokeAppEnv,
  stopProcess,
  terminateMacosLaunchServicesOwnedProcess,
  windowsAcceptanceProfileDir
} from './app-launcher.mjs'
import {
  countTransientFifoPauseMarkers,
  TRANSIENT_FIFO_PAUSE_FIRED_MARKER
} from './transient-fifo-pressure-gates.mjs'

const SMOKE_ENV_KEYS = [
  'VIDEORC_APP_DATA_DIR',
  'VIDEORC_DATABASE_PATH',
  'VIDEORC_RECORDINGS_DIR',
  'VIDEORC_SECRETS_PATH',
  'VIDEORC_USER_DATA_DIR',
  'VIDEORC_SMOKE_STATE_DIR',
  'VIDEORC_SMOKE_OUTPUT_DIR',
  'VIDEORC_WINDOWS_ACCEPTANCE_DIR',
  'VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR',
  'VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED',
  'VIDEORC_DISABLE_BACKEND_REAP',
  'VIDEORC_SMOKE_PRINT_BACKEND_READY',
  'VIDEORC_SMOKE_APP_OWNERSHIP_PATH',
  'VIDEORC_SMOKE_APP_OWNERSHIP_TOKEN'
]

test('macOS real-source launch uses the exact app bundle through LaunchServices', () => {
  const executable = '/private/tmp/Videorc.app/Contents/MacOS/Videorc'
  const appOwnership = {
    path: '/private/tmp/launch.app-ownership.json',
    token: 'o'.repeat(43)
  }
  const spec = macosLaunchServicesAppSpawnSpec({
    command: executable,
    env: {
      HOME: '/Users/probe',
      PATH: '/usr/bin:/bin',
      VIDEORC_APP_DATA_DIR: '/private/tmp/state/app-data',
      VIDEORC_PACKAGED_SMOKE_TEST: '1',
      VIDEORC_SMOKE_COMMAND_CAPABILITY: 'capability'
    },
    requestedEnv: {
      VIDEORC_PACKAGED_SMOKE_TEST: '1',
      VIDEORC_SMOKE_COMMAND_CAPABILITY: 'capability'
    },
    outputPaths: {
      stdout: '/private/tmp/launch.stdout.log',
      stderr: '/private/tmp/launch.stderr.log'
    },
    appOwnership,
    platform: 'darwin'
  })

  assert.equal(macosAppBundlePath(executable), '/private/tmp/Videorc.app')
  assert.equal(spec.command, '/usr/bin/open')
  assert.deepEqual(spec.args.slice(0, 8), [
    '-n',
    '-W',
    '-a',
    '/private/tmp/Videorc.app',
    '-o',
    '/private/tmp/launch.stdout.log',
    '--stderr',
    '/private/tmp/launch.stderr.log'
  ])
  assert.ok(spec.args.includes('VIDEORC_APP_DATA_DIR=/private/tmp/state/app-data'))
  assert.ok(spec.args.includes('VIDEORC_PACKAGED_SMOKE_TEST=1'))
  assert.ok(spec.args.includes('VIDEORC_SMOKE_COMMAND_CAPABILITY=capability'))
  assert.ok(spec.args.includes(`VIDEORC_SMOKE_APP_OWNERSHIP_PATH=${appOwnership.path}`))
  assert.ok(spec.args.includes(`VIDEORC_SMOKE_APP_OWNERSHIP_TOKEN=${appOwnership.token}`))
  assert.equal(
    spec.args.some((arg) => arg.startsWith('HOME=')),
    false
  )
  assert.deepEqual(spec.options.env, { HOME: '/Users/probe', PATH: '/usr/bin:/bin' })
  assert.deepEqual(spec.handshakeOutputPaths, [
    '/private/tmp/launch.stdout.log',
    '/private/tmp/launch.stderr.log'
  ])
  assert.deepEqual(spec.appOwnership, {
    ...appOwnership,
    expectedExecutablePath: executable,
    expectedBundlePath: '/private/tmp/Videorc.app'
  })
})

test('macOS LaunchServices cleanup resolves authenticated ownership without a requested marker', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'videorc-launch-ownership-test-'))
  const path = resolve(root, 'app-ownership.json')
  const token = 't'.repeat(43)
  const unresolvedBundlePath = resolve(root, 'Videorc.app')
  const unresolvedExecutablePath = resolve(unresolvedBundlePath, 'Contents/MacOS/Videorc')
  mkdirSync(resolve(unresolvedBundlePath, 'Contents/MacOS'), { recursive: true })
  writeFileSync(unresolvedExecutablePath, '')
  const bundlePath = realpathSync(unresolvedBundlePath)
  const executablePath = realpathSync(unresolvedExecutablePath)
  const processIdentity = {
    startTime: 'Sat Aug 29 02:34:55 2026',
    executablePath,
    bundlePath
  }
  const publication = {
    schemaVersion: 1,
    appPid: 4242,
    executablePath: processIdentity.executablePath,
    bundlePath: processIdentity.bundlePath,
    token
  }
  writeFileSync(path, JSON.stringify(publication), { mode: 0o600 })
  const appOwnership = {
    path,
    token,
    expectedExecutablePath: processIdentity.executablePath,
    expectedBundlePath: processIdentity.bundlePath
  }

  assert.deepEqual(readMacosLaunchServicesAppOwnership(appOwnership), publication)
  assert.equal(
    await resolveMacosLaunchServicesAppPid({
      appOwnership,
      previewMarker: undefined,
      controller: fakeChild(31337),
      identityProbe: () => processIdentity
    }),
    4242
  )
  assert.deepEqual(appOwnership.processIdentity, processIdentity)
  assert.throws(
    () => readMacosLaunchServicesAppOwnership({ path, token: 'x'.repeat(43) }),
    /authentication token did not match/
  )
})

test('macOS LaunchServices cleanup signals only a matching captured process identity', async () => {
  const identity = launchServicesProcessIdentity()
  const signals = []
  const probes = [identity, null]

  const result = await terminateMacosLaunchServicesOwnedProcess({
    pid: 4242,
    processIdentity: identity,
    identityProbe: () => probes.shift(),
    signalProcess: (pid, signal) => signals.push({ pid, signal })
  })

  assert.deepEqual(result, { pid: 4242, state: 'terminated', signaled: true })
  assert.deepEqual(signals, [{ pid: 4242, signal: 'SIGTERM' }])
  assert.equal(probes.length, 0)
})

test('macOS LaunchServices cleanup treats a reused PID as exited without signaling it', async () => {
  const identity = launchServicesProcessIdentity()
  const signals = []

  const result = await terminateMacosLaunchServicesOwnedProcess({
    pid: 4242,
    processIdentity: identity,
    identityProbe: () => ({
      startTime: 'Sat Aug 29 02:35:01 2026',
      executablePath: '/usr/bin/unrelated',
      bundlePath: null
    }),
    signalProcess: (pid, signal) => signals.push({ pid, signal })
  })

  assert.deepEqual(result, { pid: 4242, state: 'already-exited', signaled: false })
  assert.deepEqual(signals, [])
})

test('macOS LaunchServices cleanup stops waiting when identity changes after SIGTERM', async () => {
  const identity = launchServicesProcessIdentity()
  const replacement = {
    ...identity,
    executablePath: '/Applications/Unrelated.app/Contents/MacOS/Unrelated',
    bundlePath: '/Applications/Unrelated.app'
  }
  const probes = [identity, identity, replacement]
  const signals = []
  let now = 0

  const result = await terminateMacosLaunchServicesOwnedProcess({
    pid: 4242,
    processIdentity: identity,
    identityProbe: () => probes.shift(),
    signalProcess: (pid, signal) => signals.push({ pid, signal }),
    sleep: async () => {
      now += 1
    },
    now: () => now,
    timeoutMs: 10
  })

  assert.deepEqual(result, { pid: 4242, state: 'terminated', signaled: true })
  assert.deepEqual(signals, [{ pid: 4242, signal: 'SIGTERM' }])
  assert.equal(probes.length, 0)
})

test('macOS LaunchServices cleanup fails closed when identity cannot be probed', async () => {
  const signals = []

  await assert.rejects(
    terminateMacosLaunchServicesOwnedProcess({
      pid: 4242,
      processIdentity: launchServicesProcessIdentity(),
      identityProbe: () => {
        throw new Error('process inspection denied')
      },
      signalProcess: (pid, signal) => signals.push({ pid, signal })
    }),
    /process inspection denied/
  )
  assert.deepEqual(signals, [])
})

test('macOS LaunchServices launch rejects a direct non-bundle executable', () => {
  assert.throws(
    () =>
      macosLaunchServicesAppSpawnSpec({
        command: '/usr/local/bin/Videorc',
        platform: 'darwin'
      }),
    /inside a \.app bundle/
  )
})

test('resolveSmokeAppDirs derives isolated dirs from an explicit smoke state dir', () => {
  withCleanSmokeEnv(() => {
    const stateDir = '/tmp/videorc-smoke-state'
    assert.deepEqual(resolveSmokeAppDirs({ env: { VIDEORC_SMOKE_STATE_DIR: stateDir } }), {
      appDataDir: resolve(stateDir, 'app-data'),
      userDataDir: resolve(stateDir, 'user-data')
    })
  })
})

test('smokeAppEnv enables ledger reaping by default for isolated smoke launches', () => {
  withCleanSmokeEnv(() => {
    const stateDir = '/tmp/videorc-smoke-state'
    const env = smokeAppEnv({ VIDEORC_SMOKE_STATE_DIR: stateDir })

    assert.equal(env.VIDEORC_DISABLE_BACKEND_REAP, '0')
    assert.equal(env.VIDEORC_SMOKE_PRINT_BACKEND_READY, '1')
    assert.equal(env.VIDEORC_APP_DATA_DIR, resolve(stateDir, 'app-data'))
    assert.equal(env.VIDEORC_USER_DATA_DIR, resolve(stateDir, 'user-data'))
  })
})

test('smokeAppEnv reuses the smoke output dir as the default isolated state dir', () => {
  withCleanSmokeEnv(() => {
    const outputDir = '/tmp/videorc-smoke-output'
    const env = smokeAppEnv({ VIDEORC_SMOKE_OUTPUT_DIR: outputDir })

    assert.equal(env.VIDEORC_APP_DATA_DIR, resolve(outputDir, 'app-data'))
    assert.equal(env.VIDEORC_USER_DATA_DIR, resolve(outputDir, 'user-data'))
  })
})

test('smokeAppEnv never inherits state paths from the parent shell', () => {
  withCleanSmokeEnv(() => {
    process.env.VIDEORC_APP_DATA_DIR = '/real/profile/app-data'
    process.env.VIDEORC_USER_DATA_DIR = '/real/profile/user-data'
    process.env.VIDEORC_DATABASE_PATH = '/real/profile/videorc.sqlite3'
    process.env.VIDEORC_SECRETS_PATH = '/real/profile/videorc-secrets.json'
    process.env.VIDEORC_RECORDINGS_DIR = '/real/profile/recordings'
    process.env.VIDEORC_SMOKE_OUTPUT_DIR = '/old/smoke-output'
    process.env.VIDEORC_SMOKE_APP_OWNERSHIP_PATH = '/old/app-ownership.json'
    process.env.VIDEORC_SMOKE_APP_OWNERSHIP_TOKEN = 'old-ownership-token'

    const stateDir = '/tmp/videorc-current-smoke'
    const env = smokeAppEnv({ VIDEORC_SMOKE_STATE_DIR: stateDir })

    assert.equal(env.VIDEORC_APP_DATA_DIR, resolve(stateDir, 'app-data'))
    assert.equal(env.VIDEORC_USER_DATA_DIR, resolve(stateDir, 'user-data'))
    assert.equal(env.VIDEORC_DATABASE_PATH, resolve(stateDir, 'app-data/videorc.sqlite3'))
    assert.equal(env.VIDEORC_SECRETS_PATH, resolve(stateDir, 'app-data/videorc-secrets.json'))
    assert.equal(env.VIDEORC_RECORDINGS_DIR, resolve(stateDir, 'app-data/recordings'))
    assert.equal(env.VIDEORC_SMOKE_OUTPUT_DIR, undefined)
    assert.equal(env.VIDEORC_SMOKE_APP_OWNERSHIP_PATH, undefined)
    assert.equal(env.VIDEORC_SMOKE_APP_OWNERSHIP_TOKEN, undefined)
  })
})

test('smokeAppEnv accepts explicit state paths only inside the current smoke roots', () => {
  withCleanSmokeEnv(() => {
    const stateDir = '/tmp/videorc-current-smoke'
    const env = smokeAppEnv({
      VIDEORC_SMOKE_STATE_DIR: stateDir,
      VIDEORC_DATABASE_PATH: resolve(stateDir, 'custom/db.sqlite3'),
      VIDEORC_SECRETS_PATH: resolve(stateDir, 'custom/secrets.json'),
      VIDEORC_RECORDINGS_DIR: resolve(stateDir, 'custom/recordings')
    })

    assert.equal(env.VIDEORC_DATABASE_PATH, resolve(stateDir, 'custom/db.sqlite3'))
    assert.equal(env.VIDEORC_SECRETS_PATH, resolve(stateDir, 'custom/secrets.json'))
    assert.equal(env.VIDEORC_RECORDINGS_DIR, resolve(stateDir, 'custom/recordings'))

    assert.throws(
      () =>
        smokeAppEnv({
          VIDEORC_SMOKE_STATE_DIR: stateDir,
          VIDEORC_DATABASE_PATH: '/real/profile/videorc.sqlite3'
        }),
      /VIDEORC_DATABASE_PATH must be inside/
    )
    assert.throws(
      () =>
        smokeAppEnv({
          VIDEORC_SMOKE_STATE_DIR: stateDir,
          VIDEORC_SECRETS_PATH: '/real/profile/videorc-secrets.json'
        }),
      /VIDEORC_SECRETS_PATH must be inside/
    )
    assert.throws(
      () =>
        smokeAppEnv({
          VIDEORC_SMOKE_STATE_DIR: stateDir,
          VIDEORC_RECORDINGS_DIR: '/real/profile/recordings'
        }),
      /VIDEORC_RECORDINGS_DIR must be inside/
    )
  })
})

test('smokeAppEnv preserves explicit app dirs and reaper policy', () => {
  withCleanSmokeEnv(() => {
    process.env.VIDEORC_DISABLE_BACKEND_REAP = '1'
    const env = smokeAppEnv({
      VIDEORC_APP_DATA_DIR: '/custom/app-data',
      VIDEORC_USER_DATA_DIR: '/custom/user-data',
      VIDEORC_DISABLE_BACKEND_REAP: '0',
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '0'
    })

    assert.equal(env.VIDEORC_APP_DATA_DIR, '/custom/app-data')
    assert.equal(env.VIDEORC_USER_DATA_DIR, '/custom/user-data')
    assert.equal(env.VIDEORC_DISABLE_BACKEND_REAP, '0')
    assert.equal(env.VIDEORC_SMOKE_PRINT_BACKEND_READY, '0')
  })
})

test('acceptance launches preserve one owned profile outside evidence only for installed Windows', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'videorc-acceptance-profile-test-'))
  const profileDir = resolve(root, 'profile')
  const evidenceDir = resolve(root, 'evidence')
  mkdirSync(profileDir)
  mkdirSync(evidenceDir)
  const env = {
    VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED: '1',
    VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR: profileDir,
    VIDEORC_WINDOWS_ACCEPTANCE_DIR: evidenceDir,
    VIDEORC_SMOKE_OUTPUT_DIR: resolve(evidenceDir, 'run')
  }
  const ownerProbe = () => ({
    current: 'WORKGROUP\\videorc-user',
    owner: 'workgroup\\VIDEORC-USER'
  })

  assert.equal(
    windowsAcceptanceProfileDir({ env, platform: 'win32', ownerProbe }),
    realpathSync(profileDir)
  )
  assert.deepEqual(resolveSmokeAppDirs({ env, platform: 'win32', ownerProbe }), {
    appDataDir: resolve(realpathSync(profileDir), 'app-data'),
    userDataDir: resolve(realpathSync(profileDir), 'user-data')
  })

  const launchedEnv = smokeAppEnv(env, { platform: 'win32', ownerProbe })
  const canonicalProfileDir = realpathSync(profileDir)
  assert.equal(launchedEnv.VIDEORC_APP_DATA_DIR, resolve(canonicalProfileDir, 'app-data'))
  assert.equal(launchedEnv.VIDEORC_USER_DATA_DIR, resolve(canonicalProfileDir, 'user-data'))
  assert.equal(
    launchedEnv.VIDEORC_DATABASE_PATH,
    resolve(canonicalProfileDir, 'app-data/videorc.sqlite3')
  )
  assert.equal(
    launchedEnv.VIDEORC_SECRETS_PATH,
    resolve(canonicalProfileDir, 'app-data/videorc-secrets.json')
  )
  assert.equal(
    launchedEnv.VIDEORC_RECORDINGS_DIR,
    resolve(canonicalProfileDir, 'app-data/recordings')
  )
})

test('acceptance profile validation rejects unsafe activation, location, and ownership', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'videorc-acceptance-profile-reject-'))
  const evidenceDir = resolve(root, 'evidence')
  const nestedProfileDir = resolve(evidenceDir, 'profile')
  const safeProfileDir = resolve(root, 'profile')
  mkdirSync(evidenceDir)
  mkdirSync(nestedProfileDir)
  mkdirSync(safeProfileDir)
  const owned = () => ({ current: 'DOMAIN\\user', owner: 'DOMAIN\\user' })
  const baseEnv = {
    VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED: '1',
    VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR: safeProfileDir,
    VIDEORC_WINDOWS_ACCEPTANCE_DIR: evidenceDir
  }

  assert.throws(
    () =>
      windowsAcceptanceProfileDir({
        env: { ...baseEnv, VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED: '0' },
        platform: 'win32',
        ownerProbe: owned
      }),
    /acceptance-only/
  )
  assert.throws(
    () =>
      windowsAcceptanceProfileDir({
        env: baseEnv,
        platform: 'darwin',
        ownerProbe: owned
      }),
    /only on Windows/
  )
  assert.throws(
    () =>
      windowsAcceptanceProfileDir({
        env: { ...baseEnv, VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR: 'relative-profile' },
        platform: 'win32',
        ownerProbe: owned
      }),
    /must be absolute/
  )
  assert.throws(
    () =>
      windowsAcceptanceProfileDir({
        env: {
          ...baseEnv,
          VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR: nestedProfileDir
        },
        platform: 'win32',
        ownerProbe: owned
      }),
    /outside the acceptance evidence/
  )
  assert.throws(
    () =>
      windowsAcceptanceProfileDir({
        env: baseEnv,
        platform: 'win32',
        ownerProbe: () => ({ current: 'DOMAIN\\user', owner: 'DOMAIN\\other' })
      }),
    /owned by the current Windows user/
  )
})

test('dev app launch uses explicit cmd.exe without shell argv reconstruction on Windows', () => {
  const windowsSpec = devAppSpawnSpec({
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  })

  assert.equal(windowsSpec.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(windowsSpec.args, ['/d', '/s', '/c', 'pnpm --filter @videorc/desktop dev'])
  assert.equal(windowsSpec.options.shell, false)
  assert.equal(devAppSpawnOptions({ platform: 'darwin' }).shell, false)
  assert.equal(devAppSpawnOptions({ platform: 'linux' }).shell, false)
  // detached is POSIX-only: on Windows it silently drops the piped output the
  // marker handshake depends on, and there is no process group to signal.
  assert.equal(windowsSpec.options.detached, false)
  assert.equal(devAppSpawnOptions({ platform: 'darwin' }).detached, true)
  assert.equal(devAppSpawnOptions({ platform: 'linux' }).detached, true)
})

test('custom app launch preserves isolated env and targets a packaged executable', () => {
  const spec = appSpawnSpec({
    command: '/Applications/Videorc.app/Contents/MacOS/Videorc',
    cwd: '/Applications/Videorc.app/Contents/MacOS',
    env: { VIDEORC_USER_DATA_DIR: '/tmp/videorc-user-data' },
    platform: 'darwin'
  })

  assert.equal(spec.command, '/Applications/Videorc.app/Contents/MacOS/Videorc')
  assert.deepEqual(spec.args, [])
  assert.equal(spec.options.cwd, '/Applications/Videorc.app/Contents/MacOS')
  assert.equal(spec.options.env.VIDEORC_USER_DATA_DIR, '/tmp/videorc-user-data')
  assert.equal(spec.options.detached, true)
})

test('performance launch uses the exact packaged executable when configured', () => {
  const executable = resolve('/tmp/Videorc.app/Contents/MacOS/Videorc')
  assert.deepEqual(
    performanceAppSpawnSpec({
      VIDEORC_PERF_APP_EXECUTABLE: '/tmp/Videorc.app/Contents/MacOS/Videorc'
    }),
    {
      command: executable,
      args: [],
      cwd: resolve('/tmp/Videorc.app/Contents/MacOS')
    }
  )
  assert.equal(performanceAppSpawnSpec({}), undefined)
})

test('dev app launch failures include the latest child output', () => {
  const message = devAppFailureMessage('Dev app exited before handshake completed', [
    '',
    'vite failed to bind port 5173',
    'electron-vite exited with code 1'
  ])

  assert.match(message, /Dev app exited before handshake completed/)
  assert.match(message, /Last dev app output:/)
  assert.match(message, /vite failed to bind port 5173/)
  assert.match(message, /electron-vite exited with code 1/)
  assert.equal(devAppFailureMessage('plain failure', []), 'plain failure')
})

test('line buffering preserves a FIFO hook marker split across stdout chunks', () => {
  const stdoutLines = []
  const stderrLines = []
  const stdout = createLineBuffer((line) => stdoutLines.push(line))
  const stderr = createLineBuffer((line) => stderrLines.push(line))

  const splitAt = Math.floor(TRANSIENT_FIFO_PAUSE_FIRED_MARKER.length / 2)
  stdout.write(`WARN ${TRANSIENT_FIFO_PAUSE_FIRED_MARKER.slice(0, splitAt)}`)
  stderr.write('independent stderr fragment')
  stdout.write(`${TRANSIENT_FIFO_PAUSE_FIRED_MARKER.slice(splitAt)}\r`)
  stdout.write('\nnext stdout line\n')
  stderr.flush()

  assert.deepEqual(stdoutLines, [`WARN ${TRANSIENT_FIFO_PAUSE_FIRED_MARKER}`, 'next stdout line'])
  assert.deepEqual(stderrLines, ['independent stderr fragment'])
  assert.equal(
    stdoutLines.reduce((count, line) => count + countTransientFifoPauseMarkers(line), 0),
    1
  )
})

test(
  'launchDevApp finishes exact process-group cleanup before rejecting a marker timeout',
  { skip: process.platform === 'win32' },
  async () => {
    const descendantScript = `
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150))
      setInterval(() => {}, 1_000)
    `
    const fixtureScript = `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })
      console.log('launcher-fixture-pid=' + process.pid)
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150))
      setInterval(() => {}, 1_000)
    `
    let fixturePid = null

    try {
      let launchError = null
      await assert.rejects(
        launchDevApp({
          timeoutMs: 1_000,
          requiredMarkers: ['never-ready'],
          spawnSpec: {
            command: process.execPath,
            args: ['-e', fixtureScript],
            cwd: process.cwd()
          }
        }),
        (error) => {
          launchError = error
          return /Timed out waiting for \[never-ready\]/.test(error.message)
        }
      )

      const match = /launcher-fixture-pid=(\d+)/.exec(launchError?.message ?? '')
      assert.ok(match, `expected fixture pid in launcher diagnostics: ${launchError?.message}`)
      fixturePid = Number(match[1])
      assert.equal(exactProcessGroupExists(fixturePid), false)
    } finally {
      if (fixturePid && exactProcessGroupExists(fixturePid)) {
        process.kill(-fixturePid, 'SIGKILL')
      }
    }
  }
)

test(
  'launchDevApp rejects a smoke command marker without a capability',
  { skip: process.platform === 'win32' },
  async () => {
    const fixtureScript = `
      console.log('[smoke] preview-motion-ready ' + JSON.stringify({ host: '127.0.0.1', port: 43210 }))
      setInterval(() => {}, 1_000)
    `

    await assert.rejects(
      launchDevApp({
        timeoutMs: 2_000,
        requiredMarkers: ['preview-motion-ready'],
        spawnSpec: {
          command: process.execPath,
          args: ['-e', fixtureScript],
          cwd: process.cwd()
        }
      }),
      /Invalid \[smoke\] preview-motion-ready marker:.*per-run capability/
    )
  }
)

test(
  'launchDevApp attaches a caller-held packaged capability before marker validation',
  { skip: process.platform === 'win32' },
  async () => {
    const capability = 'x'.repeat(43)
    const fixtureScript = `
      console.log('[smoke] preview-motion-ready ' + JSON.stringify({ host: '127.0.0.1', port: 43210 }))
      setInterval(() => {}, 1_000)
    `
    const launched = await launchDevApp({
      timeoutMs: 2_000,
      requiredMarkers: ['preview-motion-ready'],
      packagedSmokeCommandCapability: capability,
      spawnSpec: {
        command: process.execPath,
        args: ['-e', fixtureScript],
        cwd: process.cwd()
      }
    })

    try {
      assert.deepEqual(launched.connections['preview-motion-ready'], {
        host: '127.0.0.1',
        port: 43210,
        capability
      })
    } finally {
      await launched.stop()
    }
  }
)

test('stopProcess reports a graceful process-group stop', async () => {
  const child = fakeChild(123)
  const signals = []

  const result = await stopProcess(child, {
    signalProcessGroup: (_pid, _child, signal) => signals.push(signal),
    waitForChildExit: async () => {
      child.exitCode = 0
    },
    waitForProcessGroupExit: async () => {
      throw new Error('group wait should not be needed')
    },
    processGroupExists: () => false
  })

  assert.equal(result.state, 'terminated')
  assert.equal(result.childExited, true)
  assert.equal(result.processGroupExited, true)
  assert.equal(result.escalated, false)
  assert.equal(result.forced, false)
  assert.deepEqual(signals, ['SIGTERM'])
})

test('stopProcess skips signaling when the child and process group already exited', async () => {
  const child = fakeChild(234)
  child.exitCode = 0

  const result = await stopProcess(child, {
    beforeStop: () => {
      throw new Error('beforeStop should not run for an exited tree')
    },
    signalProcessGroup: () => {
      throw new Error('an exited tree must not be signaled')
    },
    waitForChildExit: async () => {
      throw new Error('an exited child must not be awaited')
    },
    waitForProcessGroupExit: async () => {
      throw new Error('an exited group must not be awaited')
    },
    processGroupExists: () => false
  })

  assert.deepEqual(result, {
    pid: 234,
    state: 'skipped',
    childExited: true,
    processGroupExited: true,
    escalated: false,
    forced: false,
    signals: []
  })
})

test('stopProcess records injected Windows taskkill semantics as forced', async () => {
  for (const forcedSignalResult of [true, { forced: true }]) {
    const child = fakeChild(345)
    const signals = []

    const result = await stopProcess(child, {
      signalProcessGroup: (_pid, _child, signal) => {
        signals.push(signal)
        return forcedSignalResult
      },
      waitForChildExit: async () => {
        child.signalCode = 'SIGTERM'
      },
      waitForProcessGroupExit: async () => {
        throw new Error('group wait should not be needed')
      },
      processGroupExists: () => false
    })

    assert.equal(result.state, 'force-terminated')
    assert.equal(result.childExited, true)
    assert.equal(result.processGroupExited, true)
    assert.equal(result.escalated, false)
    assert.equal(result.forced, true)
    assert.deepEqual(signals, ['SIGTERM'])
  }
})

test('stopProcess escalates to SIGKILL when the process group survives SIGTERM', async () => {
  const child = fakeChild(456)
  const signals = []
  let groupAlive = true
  let killSent = false

  const result = await stopProcess(child, {
    signalProcessGroup: (_pid, _child, signal) => {
      signals.push(signal)
      killSent = killSent || signal === 'SIGKILL'
    },
    waitForChildExit: async () => {
      if (killSent) {
        child.signalCode = 'SIGKILL'
      }
    },
    waitForProcessGroupExit: async () => {
      if (killSent) {
        groupAlive = false
      }
    },
    processGroupExists: () => groupAlive
  })

  assert.equal(result.state, 'killed')
  assert.equal(result.childExited, true)
  assert.equal(result.processGroupExited, true)
  assert.equal(result.escalated, true)
  assert.equal(result.forced, false)
  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM', 'SIGKILL'])
})

test('stopProcess reports leaked children when SIGKILL cannot finish teardown', async () => {
  const child = fakeChild(789)

  const result = await stopProcess(child, {
    throwOnLeak: false,
    signalProcessGroup: () => {},
    waitForChildExit: async () => {},
    waitForProcessGroupExit: async () => {},
    processGroupExists: () => true
  })

  assert.equal(result.state, 'leaked')
  assert.equal(result.childExited, false)
  assert.equal(result.processGroupExited, false)
  assert.equal(result.escalated, true)
  assert.equal(result.forced, false)

  await assert.rejects(
    stopProcess(fakeChild(790), {
      signalProcessGroup: () => {},
      waitForChildExit: async () => {},
      waitForProcessGroupExit: async () => {},
      processGroupExists: () => true
    }),
    /did not exit after SIGTERM -> SIGTERM -> SIGKILL/
  )
})

function fakeChild(pid) {
  return { pid, exitCode: null, signalCode: null }
}

function launchServicesProcessIdentity() {
  return {
    startTime: 'Sat Aug 29 02:34:55 2026',
    executablePath: '/private/tmp/Videorc.app/Contents/MacOS/Videorc',
    bundlePath: '/private/tmp/Videorc.app'
  }
}

function exactProcessGroupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function withCleanSmokeEnv(callback) {
  const previous = new Map(SMOKE_ENV_KEYS.map((key) => [key, process.env[key]]))
  try {
    for (const key of SMOKE_ENV_KEYS) {
      delete process.env[key]
    }
    callback()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
