import assert from 'node:assert/strict'
import test from 'node:test'
import { stopFirstRunApp } from './first-run-smoke-stop.mjs'

function fixture() {
  const events = []
  const connection = { owned: true }
  const ledgerPaths = ['/isolated/global.json', '/isolated/workspace.json']
  const launched = {
    process: { pid: 1234, exitCode: null, signalCode: null },
    connections: { 'preview-motion-ready': connection },
    stop: async () => {
      events.push('fallback')
      launched.process.exitCode = 0
      return { state: 'terminated' }
    }
  }
  const dependencies = {
    requestQuit: async (actual, command, params, options) => {
      assert.equal(actual, connection)
      assert.equal(command, 'app-quit')
      assert.deepEqual(params, {})
      assert.deepEqual(options, { timeoutMs: 1000 })
      events.push('quit')
      return { quitting: true }
    },
    waitNoLive: async (options) => {
      assert.deepEqual(options, { ledgerPaths, pgid: 1234, timeoutMs: 10000 })
      events.push('retired')
      launched.process.exitCode = 0
    },
    waitClean: async (options) => {
      assert.deepEqual(options, { ledgerPaths, pgid: 1234, timeoutMs: 1000 })
      events.push('clean')
      return { records: [], processGroupRows: [] }
    }
  }
  return { events, launched, ledgerPaths, dependencies }
}

test('first-run quit retires the app before verifying its ledger, without group signals', async () => {
  const f = fixture()
  const result = await stopFirstRunApp(f.launched, f.ledgerPaths, f.dependencies)
  assert.equal(result.pass, true)
  assert.equal(result.stopResult, null)
  assert.deepEqual(f.events, ['quit', 'retired', 'clean'])
})

test('a refused or unavailable quit is cleaned up but cannot become a passing teardown', async () => {
  for (const requestQuit of [
    async () => ({ quitting: false }),
    async () => {
      throw new Error('Command connection closed')
    }
  ]) {
    const f = fixture()
    const result = await stopFirstRunApp(f.launched, f.ledgerPaths, {
      ...f.dependencies,
      requestQuit
    })
    assert.equal(result.pass, false)
    assert.equal(result.clean, true)
    assert.ok(result.gracefulQuitError)
    assert.deepEqual(f.events, ['fallback', 'clean'])
  }
})

test('acknowledged quit still fails if an owned process survives its deadline', async () => {
  const f = fixture()
  const result = await stopFirstRunApp(f.launched, f.ledgerPaths, {
    ...f.dependencies,
    waitNoLive: async () => {
      throw new Error('Owned backend is still live')
    }
  })
  assert.equal(result.pass, false)
  assert.match(result.gracefulQuitError, /still live/)
  assert.deepEqual(f.events, ['quit', 'fallback', 'clean'])
})

test('failed fallback and a remaining ledger are retained together', async () => {
  const f = fixture()
  f.launched.stop = async () => {
    throw new Error('Owned cleanup failed')
  }
  const result = await stopFirstRunApp(f.launched, f.ledgerPaths, {
    ...f.dependencies,
    requestQuit: async () => {
      throw new Error('Quit timed out')
    },
    waitClean: async () => {
      throw new Error('Ledger remains occupied')
    }
  })
  assert.equal(result.pass, false)
  assert.match(result.error, /Owned cleanup failed; Ledger remains occupied/)
  assert.match(result.gracefulQuitError, /Quit timed out/)
})

test('dead processes alone do not excuse stale ownership or a failed controller exit', async () => {
  for (const failure of ['ledger', 'exit', 'signal']) {
    const f = fixture()
    const result = await stopFirstRunApp(f.launched, f.ledgerPaths, {
      ...f.dependencies,
      waitClean: async () => {
        if (failure === 'exit') f.launched.process.exitCode = 1
        if (failure === 'signal') f.launched.process.signalCode = 'SIGTRAP'
        return { records: failure === 'ledger' ? [{ pid: 1234 }] : [], processGroupRows: [] }
      }
    })
    assert.equal(result.pass, false, failure)
    assert.equal(result.stopResult, null)
  }
})
