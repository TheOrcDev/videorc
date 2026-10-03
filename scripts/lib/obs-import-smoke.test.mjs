import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { isObsSmokeEntry, runObsImportSmoke } from '../smoke-obs-import.mjs'

const fixtureKey = 'fixture-not-a-real-key'
const capability = 'a'.repeat(43)
const discovery = { available: true, currentCollection: 'Fixture Collection' }
const setup = { canvasWidth: 3840, fps: 24, scenes: [{}, {}], service: { hasKey: true } }

test('OBS smoke recognizes canonical, relative, and aliased CLI entry paths without launching', async () => {
  const scriptPath = fileURLToPath(new URL('../smoke-obs-import.mjs', import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), 'videorc-obs-entry-'))
  try {
    const alias = join(directory, 'scripts-alias')
    symlinkSync(dirname(scriptPath), alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(isObsSmokeEntry(scriptPath), true)
    assert.equal(isObsSmokeEntry(relative(process.cwd(), scriptPath)), true)
    assert.equal(isObsSmokeEntry(join(alias, 'smoke-obs-import.mjs')), true)
    assert.equal(isObsSmokeEntry(fileURLToPath(import.meta.url)), false)
    assert.equal(isObsSmokeEntry(join(directory, 'missing.mjs')), false)
    assert.equal(isObsSmokeEntry(undefined), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const scenarios = [
  { name: 'success', calls: 3 },
  { name: 'discovery failure', calls: 1, error: /obsDiscover failed/, fail: 'discovery' },
  {
    name: 'malformed response',
    calls: 1,
    error: /obsDiscover returned malformed response/,
    fail: 'json'
  },
  { name: 'malformed setup', calls: 2, error: /unexpected obsRead canvas/, fail: 'shape' },
  { name: 'setup key leak', calls: 2, error: /obsRead leaked a stream key/, fail: 'leak' },
  { name: 'wrong apply-time key', calls: 3, error: /obsReadStreamKey did not return/, fail: 'key' },
  { name: 'setup timeout', calls: 2, error: /obsRead timed out/, fail: 'timeout' },
  { name: 'setup transport reset', calls: 2, error: /obsRead transport failed/, fail: 'reset' }
]

for (const scenario of scenarios) {
  test(
    `OBS smoke awaits its launched owner exactly once on ${scenario.name}`,
    { timeout: 5_000 },
    async () => {
      const requests = []
      const server = createServer((request, response) => {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', (chunk) => {
          body += chunk
        })
        request.on('end', () => {
          const command = JSON.parse(body)
          requests.push({ command, headers: request.headers })
          const code = command.params.code
          if (scenario.fail === 'discovery' && code.includes('obsDiscover')) {
            response.writeHead(500)
            response.end(JSON.stringify({ error: `Private diagnostic: ${fixtureKey}` }))
            return
          }
          if (scenario.fail === 'json') {
            response.end(`Malformed private response ${fixtureKey}`)
            return
          }
          const isSetup = code.includes('obsRead(')
          if (isSetup && scenario.fail === 'timeout') return
          if (isSetup && scenario.fail === 'reset') {
            request.socket.destroy()
            return
          }
          const result = code.includes('obsDiscover')
            ? discovery
            : code.includes('obsReadStreamKey')
              ? scenario.fail === 'key'
                ? 'wrong-private-key'
                : fixtureKey
              : scenario.fail === 'shape'
                ? { privateData: fixtureKey }
                : scenario.fail === 'leak'
                  ? { ...setup, privateKey: fixtureKey }
                  : setup
          response.end(JSON.stringify({ ok: true, result }))
        })
      })
      server.listen(0, '127.0.0.1')
      await withDeadline(once(server, 'listening'))
      const messages = []
      let runDirectory
      let obsRoot
      let stopCalls = 0
      let settled = false
      let ownerAlive = true
      const stopEntered = Promise.withResolvers()
      const releaseStop = Promise.withResolvers()
      const run = runObsImportSmoke({
        launchApp: async ({ env, requiredMarkers }) => {
          obsRoot = env.VIDEORC_OBS_ROOT
          runDirectory = env.VIDEORC_SMOKE_STATE_DIR
          assert.deepEqual(requiredMarkers, ['backend-ready', 'preview-motion-ready'])
          assert.equal(dirname(obsRoot), runDirectory)
          assert.equal(env.VIDEORC_SMOKE_OUTPUT_DIR, runDirectory)
          // Preserve the real recording-folder fixture rather than bypassing storage.
          assert.equal(
            readFileSync(join(obsRoot, 'basic/profiles/Fixture Profile/basic.ini'), 'utf8'),
            readFileSync(
              new URL('../../apps/desktop/src/main/obs-fixtures/basic.ini', import.meta.url),
              'utf8'
            )
          )
          return {
            connections: {
              'preview-motion-ready': { host: '127.0.0.1', port: server.address().port, capability }
            },
            process: { pid: 123 },
            stop: async () => {
              stopCalls += 1
              stopEntered.resolve()
              await releaseStop.promise
              ownerAlive = false
            }
          }
        },
        operationTimeoutMs: 1000,
        evidenceDirectory: null,
        log: (message) => messages.push(message)
      })
      // Observe rejection immediately, including while teardown is blocked.
      const outcome = run.then(
        () => {
          settled = true
          return {}
        },
        (error) => {
          settled = true
          return { error }
        }
      )
      try {
        await withDeadline(Promise.race([stopEntered.promise, outcome]))
        assert.equal(stopCalls, 1)
        assert.equal(settled, false)
        assert.equal(ownerAlive, true)
        assert.equal(existsSync(obsRoot), true)
        releaseStop.resolve()
        const result = await withDeadline(outcome)
        assert.equal(stopCalls, 1)
        assert.equal(ownerAlive, false)
        assert.equal(requests.length, scenario.calls)
        assert.equal(
          requests.every(({ headers }) => headers.connection === 'close'),
          true
        )
        assert.equal(
          requests.every(({ headers }) => headers.authorization === `Bearer ${capability}`),
          true
        )
        if (scenario.error) {
          assert.equal(scenario.error.test(result.error?.message), true)
          assert.equal(existsSync(obsRoot), true)
          assert.equal(
            messages.some((message) => message.startsWith('OBS import smoke OK')),
            false
          )
        } else {
          assert.equal(result.error, undefined)
          assert.equal(existsSync(runDirectory), false)
          assert.equal(
            messages.some((message) => message.startsWith('OBS import smoke OK')),
            true
          )
          assert.equal(
            messages.indexOf('[obs-import] owned teardown complete') <
              messages.indexOf('[obs-import] fixture/profile cleanup complete'),
            true
          )
        }
        assert.equal(String(result.error).includes(fixtureKey), false)
        assert.equal(
          messages.some((message) => message.includes(fixtureKey)),
          false
        )
        assert.equal(
          messages.some((message) => message.includes(capability)),
          false
        )
        assert.equal(messages.includes('[obs-import] obsDiscover start'), true)
        if (scenario.calls > 1) assert.equal(messages.includes('[obs-import] obsRead start'), true)
        if (scenario.calls > 2)
          assert.equal(messages.includes('[obs-import] obsReadStreamKey start'), true)
      } finally {
        releaseStop.resolve()
        try {
          await withDeadline(outcome)
        } finally {
          server.closeAllConnections()
          await withDeadline(new Promise((resolve) => server.close(resolve)))
          // This is a mocked owner; its successful stop was observed before deleting data.
          if (!ownerAlive && runDirectory) await rm(runDirectory, { recursive: true, force: true })
        }
      }
    }
  )
}

for (const failOperation of [false, true]) {
  test(`OBS smoke preserves fixture/profile data when owned teardown fails (operation failure: ${failOperation})`, async () => {
    let runDirectory
    let stopCalls = 0
    const messages = []
    let failure
    try {
      await runObsImportSmoke({
        launchApp: async ({ env }) => {
          runDirectory = env.VIDEORC_SMOKE_STATE_DIR
          return {
            connections: { 'preview-motion-ready': {} },
            process: { pid: 123 },
            stop: async () => {
              stopCalls += 1
              throw new Error(`Private teardown: ${fixtureKey}`)
            }
          }
        },
        requestCommand: async (_connection, _command, { code }) => {
          if (failOperation) throw new Error(`Private IPC: ${fixtureKey}`)
          return code.includes('obsDiscover')
            ? discovery
            : code.includes('obsReadStreamKey')
              ? fixtureKey
              : setup
        },
        evidenceDirectory: null,
        log: (message) => messages.push(message)
      })
    } catch (error) {
      failure = error
    }
    try {
      assert.equal(stopCalls, 1)
      assert.equal(failure instanceof AggregateError, true)
      assert.equal(failure.errors.length, failOperation ? 2 : 1)
      assert.equal(
        failure.errors.at(-1).message,
        'OBS import smoke: owned teardown failed; fixture/profile retained.'
      )
      if (failOperation)
        assert.equal(failure.errors[0].message, 'OBS import smoke: obsDiscover failed.')
      assert.equal(existsSync(join(runDirectory, 'obs-root')), true)
      assert.equal(messages.includes('[obs-import] fixture/profile cleanup complete'), false)
      assert.equal(
        messages.some((message) => message.includes(fixtureKey)),
        false
      )
      assert.equal(
        messages.some((message) => message.startsWith('OBS import smoke OK')),
        false
      )
    } finally {
      // No process was launched: only this test's fake ownership/data is removed.
      if (runDirectory) await rm(runDirectory, { recursive: true, force: true })
    }
  })
}

test('OBS smoke preserves launch-failure evidence without assuming ownership of a missing handle', async () => {
  let runDirectory
  let launchCalls = 0
  let failure
  const messages = []
  try {
    await runObsImportSmoke({
      launchApp: async ({ env }) => {
        runDirectory = env.VIDEORC_SMOKE_STATE_DIR
        launchCalls += 1
        throw new Error(`Private launch failure: ${fixtureKey}`)
      },
      evidenceDirectory: null,
      log: (message) => messages.push(message)
    })
  } catch (error) {
    failure = error
  }
  try {
    assert.equal(launchCalls, 1)
    assert.equal(failure.message, 'OBS import smoke: launch failed.')
    assert.equal(existsSync(join(runDirectory, 'obs-root')), true)
    assert.equal(messages.includes('[obs-import] owned teardown start'), false)
    assert.equal(
      messages.some((message) => message.includes(fixtureKey)),
      false
    )
  } finally {
    // The fake launcher never started a child.
    if (runDirectory) await rm(runDirectory, { recursive: true, force: true })
  }
})

function withDeadline(promise, timeoutMs = 2_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Harness test deadline exceeded.')), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}
