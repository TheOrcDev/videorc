import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_PAUSE_MS,
  inspectOwnedFfmpeg,
  ownedFfmpegPids,
  pauseOwnedProcess
} from './proc-fault.mjs'

// A ledger with one backend record (pid 100) whose tree holds an ffmpeg
// (300, via helper 200), plus an unrelated ffmpeg (900) nobody owns, a
// recorded native helper (150) and a ledger pid that is dead (160).
const LEDGER = JSON.stringify([
  { pid: 100, label: 'backend', startedAt: '2026-10-12T10:00:00.000Z' },
  { pid: 150, label: 'native-preview-helper', startedAt: '2026-10-12T10:00:00.000Z' },
  { pid: 160, label: 'backend', startedAt: '2026-10-12T09:00:00.000Z' }
])
const TABLE = [
  { pid: 1, ppid: 0, pgid: 1, rssKb: 1, command: 'launchd', args: '' },
  { pid: 100, ppid: 1, pgid: 100, rssKb: 1, command: 'videorc-backend', args: 'videorc-backend' },
  { pid: 150, ppid: 100, pgid: 100, rssKb: 1, command: 'native_preview_host_helper', args: '' },
  { pid: 200, ppid: 100, pgid: 100, rssKb: 1, command: 'sh', args: 'sh -c encode-wrapper' },
  {
    pid: 300,
    ppid: 200,
    pgid: 100,
    rssKb: 1,
    command: 'ffmpeg',
    args: 'ffmpeg -f rawvideo -i pipe:0'
  },
  { pid: 900, ppid: 1, pgid: 900, rssKb: 1, command: 'ffmpeg', args: 'ffmpeg -i other.mp4' }
]

function ledger(overrides = {}) {
  return {
    ledgerPaths: ['/x/global.json'],
    readFile: () => LEDGER,
    readProcessTable: async () => TABLE,
    ...overrides
  }
}

function spy() {
  const calls = []
  return {
    calls,
    kill: (pid, signal) => {
      calls.push({ pid, signal })
    }
  }
}

test('inspectOwnedFfmpeg: owned descendant passes; stranger, non-ffmpeg and dead refuse', () => {
  const owned = { records: JSON.parse(LEDGER), processTable: TABLE }
  assert.deepEqual(inspectOwnedFfmpeg(300, owned), {
    ok: true,
    reason: null,
    row: TABLE[4],
    ownerPid: 100
  })
  assert.match(inspectOwnedFfmpeg(900, owned).reason, /not in the owned-process ledger/)
  assert.match(inspectOwnedFfmpeg(150, owned).reason, /is native-preview-helper, not ffmpeg/)
  assert.match(inspectOwnedFfmpeg(100, owned).reason, /is backend, not ffmpeg/)
  assert.match(inspectOwnedFfmpeg(160, owned).reason, /not running/)
  assert.match(inspectOwnedFfmpeg(0, owned).reason, /not valid/)
  assert.match(inspectOwnedFfmpeg('300', owned).reason, /not valid/)
})

test('ownedFfmpegPids lists only ffmpeg under ledger records', async () => {
  assert.deepEqual(await ownedFfmpegPids(ledger()), [300])
  assert.deepEqual(await ownedFfmpegPids(ledger({ readFile: () => '[]' })), [])
  await assert.rejects(ownedFfmpegPids({ ledgerPaths: [] }), /no owned-process ledger paths/)
})

test('pauseOwnedProcess refuses before any signal: too long, not owned, not ffmpeg', async () => {
  const { calls, kill } = spy()
  const base = {
    ledger: ledger(),
    kill,
    wait: async () => {},
    setTimer: () => 0,
    clearTimer: () => {}
  }
  await assert.rejects(
    pauseOwnedProcess({ ...base, pid: 300, ms: MAX_PAUSE_MS + 1 }),
    (error) => error.code === 'PROC_FAULT_REFUSED' && /ms must be 1\.\.10000/.test(error.message)
  )
  await assert.rejects(
    pauseOwnedProcess({ ...base, pid: 300, ms: 0 }),
    /PROC_FAULT_REFUSED|ms must/
  )
  await assert.rejects(
    pauseOwnedProcess({ ...base, pid: 900, ms: 500 }),
    (error) =>
      error.code === 'PROC_FAULT_REFUSED' && /not in the owned-process ledger/.test(error.message)
  )
  await assert.rejects(
    pauseOwnedProcess({ ...base, pid: 100, ms: 500 }),
    (error) => error.code === 'PROC_FAULT_REFUSED' && /is backend, not ffmpeg/.test(error.message)
  )
  await assert.rejects(pauseOwnedProcess({ ...base, pid: 160, ms: 500 }), /not running/)
  assert.deepEqual(calls, [])
})

test('pauseOwnedProcess: SIGSTOP, wait, SIGCONT; the backup timer is cleared', async () => {
  const { calls, kill } = spy()
  let clock = 5_000
  const timers = []
  const result = await pauseOwnedProcess({
    pid: 300,
    ms: 500,
    ledger: ledger(),
    kill,
    now: () => clock,
    wait: async (ms) => {
      clock += ms
    },
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      handle.cleared = true
    }
  })
  assert.deepEqual(calls, [
    { pid: 300, signal: 'SIGSTOP' },
    { pid: 300, signal: 'SIGCONT' }
  ])
  assert.deepEqual(result, {
    pid: 300,
    ownerPid: 100,
    ms: 500,
    stoppedAt: 5_000,
    continuedAt: 5_500,
    pausedMs: 500,
    continued: true
  })
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, MAX_PAUSE_MS)
  assert.ok(timers[0].cleared)
})

test('pauseOwnedProcess sends SIGCONT even when the wait throws, then rethrows', async () => {
  const { calls, kill } = spy()
  await assert.rejects(
    pauseOwnedProcess({
      pid: 300,
      ms: 6_000,
      ledger: ledger(),
      kill,
      wait: async () => {
        throw new Error('deadline hit')
      },
      setTimer: () => 0,
      clearTimer: () => {}
    }),
    /deadline hit/
  )
  assert.deepEqual(calls, [
    { pid: 300, signal: 'SIGSTOP' },
    { pid: 300, signal: 'SIGCONT' }
  ])
})

test('pauseOwnedProcess: the backup timer resumes a wait that never ends, once', async () => {
  const { calls, kill } = spy()
  let fire = null
  let release = null
  const run = pauseOwnedProcess({
    pid: 300,
    ms: 6_000,
    ledger: ledger(),
    kill,
    wait: () =>
      new Promise((resolve) => {
        release = resolve
      }),
    setTimer: (fn) => {
      fire = fn
      return 1
    },
    clearTimer: () => {}
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [{ pid: 300, signal: 'SIGSTOP' }])
  fire()
  assert.deepEqual(calls, [
    { pid: 300, signal: 'SIGSTOP' },
    { pid: 300, signal: 'SIGCONT' }
  ])
  release()
  const result = await run
  assert.equal(calls.length, 2, 'finally does not send a second SIGCONT')
  assert.equal(result.continued, true)
})

test('pauseOwnedProcess reports a SIGCONT that found no process', async () => {
  const logs = []
  const result = await pauseOwnedProcess({
    pid: 300,
    ms: 500,
    ledger: ledger(),
    kill: (pid, signal) => {
      if (signal === 'SIGCONT') {
        const error = new Error('gone')
        error.code = 'ESRCH'
        throw error
      }
    },
    wait: async () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    log: (line) => logs.push(line)
  })
  assert.equal(result.continued, false)
  assert.ok(logs.some((line) => /SIGCONT 300 ESRCH/.test(line)))
})
