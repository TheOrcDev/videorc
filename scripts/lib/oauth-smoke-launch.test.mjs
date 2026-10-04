import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const scripts = ['smoke-oauth-app.mjs', 'smoke-oauth-guards-app.mjs']
let invocation = 0

function bounded(promise) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = realSetTimeout(
      () => reject(new Error('OAuth fixture boundary did not complete.')),
      5000
    )
  })
  return Promise.race([promise, deadline]).finally(() => realClearTimeout(timer))
}

async function observeCaller(t, script, scenario) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'videorc-oauth-launch-test-'))
  const environmentKeys = [
    'VIDEORC_SMOKE_STATE_DIR',
    'VIDEORC_SMOKE_TIMEOUT_MS',
    'VIDEORC_SMOKE_SKIP_PREBUILD',
    'VIDEORC_SMOKE_PREBUILD_TIMEOUT_MS',
    'VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR'
  ]
  const environment = new Map(environmentKeys.map((key) => [key, process.env[key]]))
  const ownedDirectories = new Set([fixtureRoot])
  const trace = []
  const timers = []
  const signals = []
  const spawned = Promise.withResolvers()
  const stopped = Promise.withResolvers()
  const outputDelivered = Promise.withResolvers()
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = child.stderr.setEncoding = () => {}
  child.pid = 1_879_000_023 // Synthetic only; no signal is sent to the operating system.
  child.exitCode = null
  child.signalCode = null
  child.killed = scenario === 'killed-live'
  let alive = true
  let settled = false
  let backendConnections = 0
  let outcome
  let beforeRelease

  const stop = (signal) => {
    signals.push(signal)
    child.killed = true
    stopped.resolve()
    return true
  }
  child.kill = stop
  const release = () => {
    if (!alive) return
    alive = false
    child.exitCode = 0
    child.signalCode = 'SIGTERM'
    child.stdout.emit('end')
    child.stderr.emit('end')
    child.emit('exit', 0, 'SIGTERM')
    child.emit('close', 0, 'SIGTERM')
  }
  const captureEnvironment = (env) => {
    for (const key of ['VIDEORC_APP_DATA_DIR', 'VIDEORC_USER_DATA_DIR']) {
      const directory = resolve(env[key])
      const withinFixture = relative(fixtureRoot, directory)
      const generatedByCaller =
        resolve(tmpdir()) === resolve(directory, '..') &&
        /^(videorc-smoke-app-data-|videorc-smoke-user-data-)/.test(basename(directory))
      assert.ok(
        (!isAbsolute(withinFixture) &&
          withinFixture !== '..' &&
          !withinFixture.startsWith('../') &&
          !withinFixture.startsWith('..\\')) ||
          generatedByCaller,
        'Refusing an unowned fixture directory.'
      )
      ownedDirectories.add(directory)
    }
  }

  try {
    for (const key of environmentKeys) delete process.env[key]
    process.env.VIDEORC_SMOKE_STATE_DIR = fixtureRoot
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
    const controlledSetTimeout = globalThis.setTimeout
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      timers.push({ delay, at: Date.now() })
      return controlledSetTimeout(callback, delay, ...args)
    })
    t.mock.method(console, 'log', () => {})
    t.mock.method(
      globalThis,
      'WebSocket',
      class extends EventTarget {
        constructor() {
          super()
          backendConnections += 1
          // The actual connectBackend listener clears its original operation
          // timer. No OAuth response or assertion is replaced by this fixture.
          queueMicrotask(() => this.dispatchEvent(new Event('error')))
        }
        close() {}
      }
    )
    t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
      captureEnvironment(options.env)
      trace.push({ owner: 'preparation', command, args, timeoutMs: options.timeout })
      if (scenario === 'prebuild-failure') {
        return { status: 101, stdout: '', stderr: 'fixture build refused' }
      }
      // Controlled elapsed preparation exceeds the unchanged app budget but
      // not the existing preparation budget. This is not a wall-clock sleep.
      t.mock.timers.tick(90_001)
      return { status: 0, stdout: '', stderr: '' }
    })
    t.mock.method(childProcess, 'spawn', (command, args, options) => {
      captureEnvironment(options.env)
      trace.push({ owner: 'app', command, args, at: Date.now() })
      spawned.resolve()
      queueMicrotask(() => {
        if (scenario === 'no-ready') {
          outputDelivered.resolve()
          return
        }
        const marker =
          '[smoke] backend-ready {"host":"127.0.0.1","port":43210,"token":"fixture-only"}\n'
        if (scenario === 'split-ready') {
          child.stdout.emit('data', marker.slice(0, 12))
          // The first data callback has completed before the second starts.
          queueMicrotask(() => {
            child.stdout.emit('data', marker.slice(12))
            outputDelivered.resolve()
          })
        } else {
          child.stdout.emit('data', marker)
          outputDelivered.resolve()
        }
      })
      return child
    })
    t.mock.method(process, 'kill', (pid, signal = 0) => {
      assert.ok(
        pid === child.pid || pid === -child.pid,
        'Only the exact synthetic owner may be signaled.'
      )
      if (signal !== 0) return stop(signal)
      if (alive) return true
      throw Object.assign(new Error('Synthetic owner exited.'), { code: 'ESRCH' })
    })
    t.mock.method(childProcess, 'execFileSync', (command, args) => {
      assert.equal(command, 'taskkill')
      assert.deepEqual(args, ['/PID', String(child.pid), '/T', '/F'])
      stop('SIGTERM')
      return ''
    })
    syncBuiltinESMExports()

    const url = new URL(`../${script}?oauth-launch-contract=${++invocation}`, import.meta.url)
    outcome = import(url.href).then(
      () => {
        settled = true
        return {}
      },
      (error) => {
        settled = true
        return { error }
      }
    )
    await bounded(Promise.race([spawned.promise, outcome]))
    if (trace.some((row) => row.owner === 'app')) {
      await bounded(outputDelivered.promise)
      if (scenario === 'split-ready' || scenario === 'no-ready') {
        t.mock.timers.tick(90_000)
      }
      await bounded(Promise.race([stopped.promise, outcome]))
      beforeRelease = { settled, alive, backendConnections, signalCount: signals.length }
      release()
    }
    const result = await bounded(outcome)
    return { trace, timers, signals, backendConnections, beforeRelease, error: result.error }
  } finally {
    try {
      release()
      if (outcome) await bounded(outcome)
    } finally {
      t.mock.restoreAll()
      t.mock.timers.reset()
      syncBuiltinESMExports()
      for (const [key, value] of environment) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      for (const directory of ownedDirectories)
        await rm(directory, { recursive: true, force: true })
    }
  }
}

for (const script of scripts) {
  test(`${script} completes bounded preparation before starting its original app clock`, async (t) => {
    const result = await observeCaller(t, script, 'preparation')
    assert.deepEqual(
      result.trace.map((row) => row.owner),
      ['preparation', 'app']
    )
    assert.deepEqual(result.trace[0].args, ['build', '-p', 'videorc-backend'])
    assert.equal(result.trace[0].timeoutMs, 20 * 60 * 1000)
    assert.equal(result.timers[0].delay, 90_000)
    assert.equal(result.timers[0].at, result.trace[1].at)
    assert.equal(result.backendConnections, 1)
    assert.match(result.error?.message ?? '', /Could not connect/)
  })

  test(`${script} admits READY split across actual data callbacks`, async (t) => {
    const result = await observeCaller(t, script, 'split-ready')
    assert.equal(result.backendConnections, 1)
    assert.match(result.error?.message ?? '', /Could not connect/)
  })

  test(`${script} awaits its killed-but-not-exited owner`, async (t) => {
    const result = await observeCaller(t, script, 'killed-live')
    assert.deepEqual(result.beforeRelease, {
      settled: false,
      alive: true,
      backendConnections: 1,
      signalCount: 1
    })
    assert.match(result.error?.message ?? '', /Could not connect/)
  })

  test(`${script} retains its original startup deadline and awaited normal teardown`, async (t) => {
    const result = await observeCaller(t, script, 'no-ready')
    assert.equal(result.timers[0].delay, 90_000)
    assert.equal(result.backendConnections, 0)
    assert.equal(result.beforeRelease.settled, false)
    assert.equal(result.beforeRelease.signalCount, 1)
    assert.match(result.error?.message ?? '', /after 90000ms/)
  })

  test(`${script} admits an unsplit marker and awaits normal operation-failure teardown`, async (t) => {
    const result = await observeCaller(t, script, 'unsplit-ready')
    assert.equal(result.backendConnections, 1)
    assert.equal(result.beforeRelease.settled, false)
    assert.equal(result.beforeRelease.signalCount, 1)
    assert.match(result.error?.message ?? '', /Could not connect/)
  })

  test(`${script} refuses a failed prebuild without spawning an app`, async (t) => {
    const result = await observeCaller(t, script, 'prebuild-failure')
    assert.deepEqual(
      result.trace.map((row) => row.owner),
      ['preparation']
    )
    assert.equal(result.backendConnections, 0)
    assert.equal(result.signals.length, 0)
    assert.match(result.error?.message ?? '', /Backend prebuild failed/)
  })
}
