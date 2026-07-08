import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'

import {
  devAppFailureMessage,
  devAppSpawnOptions,
  devAppSpawnSpec,
  resolveSmokeAppDirs,
  smokeAppEnv,
  stopProcess
} from './app-launcher.mjs'

const SMOKE_ENV_KEYS = [
  'VIDEORC_APP_DATA_DIR',
  'VIDEORC_USER_DATA_DIR',
  'VIDEORC_SMOKE_STATE_DIR',
  'VIDEORC_SMOKE_OUTPUT_DIR',
  'VIDEORC_DISABLE_BACKEND_REAP',
  'VIDEORC_SMOKE_PRINT_BACKEND_READY'
]

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

test('dev app launch targets the desktop package and uses a shell on Windows', () => {
  const windowsSpec = devAppSpawnSpec({ platform: 'win32' })

  assert.equal(windowsSpec.command, 'pnpm')
  assert.deepEqual(windowsSpec.args, ['--filter', '@videorc/desktop', 'dev'])
  assert.equal(windowsSpec.options.shell, true)
  assert.equal(devAppSpawnOptions({ platform: 'darwin' }).shell, false)
  assert.equal(devAppSpawnOptions({ platform: 'linux' }).shell, false)
  // detached is POSIX-only: on Windows it silently drops the piped output the
  // marker handshake depends on, and there is no process group to signal.
  assert.equal(windowsSpec.options.detached, false)
  assert.equal(devAppSpawnOptions({ platform: 'darwin' }).detached, true)
  assert.equal(devAppSpawnOptions({ platform: 'linux' }).detached, true)
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
  assert.deepEqual(signals, ['SIGTERM'])
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
