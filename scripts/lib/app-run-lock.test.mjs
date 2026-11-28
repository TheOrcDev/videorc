import assert from 'node:assert/strict'
import test from 'node:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OWNERLESS_GRACE_MS,
  acquireAppRunLock,
  ancestorPids,
  appRunLockPath,
  formatOwner,
  parseOwner,
  requireAppRunLock
} from './app-run-lock.mjs'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'app-run-lock-test-'))
  return {
    dir,
    lockPath: join(dir, 'videorc-app-run.lock'),
    done: () => rmSync(dir, { recursive: true, force: true })
  }
}
const noSleep = async () => {}

test('the owner line is `<lane> pid <PID> <time>` and parses the sentinel and gallery shapes too', () => {
  const line = formatOwner({
    lane: 'G77uq show-stage',
    pid: 4242,
    time: new Date('2026-11-28T04:38:48.123Z')
  })
  assert.equal(line, 'G77uq show-stage pid 4242 2026-11-28T04:38:48Z\n')
  assert.deepEqual(parseOwner(line), {
    lane: 'G77uq show-stage',
    pid: 4242,
    time: '2026-11-28T04:38:48Z'
  })
  // What the other writers put there today.
  assert.deepEqual(parseOwner('gpui-gallery pid 77\n'), {
    lane: 'gpui-gallery',
    pid: 77,
    time: null
  })
  assert.equal(
    parseOwner('G77uq #2523 measurement before-2523-reverted pid 69054 2026-11-28T04:38:48Z\n').pid,
    69054
  )
  assert.equal(parseOwner('release launch check pid 9\n').lane, 'release launch check')
  assert.equal(parseOwner('no number here\n'), null)
  assert.equal(parseOwner(''), null)
})

test('the lock path is the home directory file unless a test overrides it', () => {
  assert.match(appRunLockPath({}), /videorc-app-run\.lock$/)
  assert.equal(appRunLockPath({ VIDEORC_APP_RUN_LOCK_PATH: '/x/y' }), '/x/y')
})

test('a free lock is taken as a directory with the owner line, and release removes it', async () => {
  const { lockPath, done } = scratch()
  try {
    const lock = await acquireAppRunLock({
      lane: 'lane-a',
      lockPath,
      pid: process.pid + 1,
      ancestors: () => []
    })
    assert.equal(lock.held, 'taken')
    assert.match(
      readFileSync(join(lockPath, 'owner'), 'utf8'),
      new RegExp(`^lane-a pid ${process.pid + 1} `)
    )
    lock.release()
    assert.equal(existsSync(lockPath), false)
    lock.release() // a second release is harmless
  } finally {
    done()
  }
})

test('a lock whose owner is dead is cleared, and the run takes it', async () => {
  const { lockPath, done } = scratch()
  try {
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner'), 'old-lane pid 999999 2026-11-28T00:00:00Z\n')
    const lock = await acquireAppRunLock({
      lane: 'lane-b',
      lockPath,
      pid: 5,
      alive: (pid) => pid !== 999999,
      ancestors: () => []
    })
    assert.equal(lock.held, 'taken')
    assert.match(readFileSync(join(lockPath, 'owner'), 'utf8'), /^lane-b pid 5 /)
    lock.release()
  } finally {
    done()
  }
})

test('a live holder is waited for, then named in the timeout error, and its lock is left alone', async () => {
  const { lockPath, done } = scratch()
  try {
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner'), 'G8egz smoke pid 321 2026-11-28T05:00:00Z\n')
    let clock = 0
    const waits = []
    await assert.rejects(
      acquireAppRunLock({
        lane: 'lane-c',
        lockPath,
        pid: 5,
        timeoutMs: 10_000,
        pollMs: 1_000,
        alive: () => true,
        ancestors: () => [],
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
        onWait: (owner) => waits.push(owner.lane)
      }),
      /held by G8egz smoke \(pid 321, since 2026-11-28T05:00:00Z\); waited 10 s/
    )
    assert.deepEqual(waits, ['G8egz smoke'])
    assert.match(readFileSync(join(lockPath, 'owner'), 'utf8'), /^G8egz smoke pid 321/)
  } finally {
    done()
  }
})

test('the lock is taken once the holder lets go while the run waits', async () => {
  const { lockPath, done } = scratch()
  try {
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner'), 'other pid 321 2026-11-28T05:00:00Z\n')
    let polls = 0
    const lock = await acquireAppRunLock({
      lane: 'lane-d',
      lockPath,
      pid: 5,
      timeoutMs: 60_000,
      alive: () => true,
      ancestors: () => [],
      sleep: async () => {
        polls += 1
        if (polls === 2) rmSync(lockPath, { recursive: true })
      }
    })
    assert.equal(lock.held, 'taken')
    assert.equal(polls, 2)
    lock.release()
  } finally {
    done()
  }
})

test('a lock held by this process, or by a live ancestor (the lane shell), is not waited on', async () => {
  const { lockPath, done } = scratch()
  try {
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner'), 'lane shell pid 100 2026-11-28T05:00:00Z\n')
    const byAncestor = await acquireAppRunLock({
      lane: 'smoke',
      lockPath,
      pid: 5,
      alive: () => true,
      ancestors: () => [50, 100]
    })
    assert.equal(byAncestor.held, 'ancestor')
    byAncestor.release() // not ours: the lock stays
    assert.equal(existsSync(lockPath), true)
    const bySelf = await acquireAppRunLock({
      lane: 'smoke',
      lockPath,
      pid: 100,
      alive: () => true,
      ancestors: () => []
    })
    assert.equal(bySelf.held, 'self')
    assert.equal(existsSync(lockPath), true)
  } finally {
    done()
  }
})

test('a lock directory with no owner line is cleared only after the grace period', async () => {
  const { lockPath, done } = scratch()
  try {
    mkdirSync(lockPath)
    let clock = Date.now()
    await assert.rejects(
      acquireAppRunLock({
        lane: 'lane-e',
        lockPath,
        pid: 5,
        timeoutMs: 1_000,
        pollMs: 500,
        alive: () => true,
        ancestors: () => [],
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        }
      }),
      /held by another run/
    )
    const old = new Date(Date.now() - OWNERLESS_GRACE_MS - 5_000)
    utimesSync(lockPath, old, old)
    const lock = await acquireAppRunLock({
      lane: 'lane-e',
      lockPath,
      pid: 5,
      alive: () => true,
      ancestors: () => []
    })
    assert.equal(lock.held, 'taken')
    lock.release()
  } finally {
    done()
  }
})

test('release leaves a lock another run took after a stale clear', async () => {
  const { lockPath, done } = scratch()
  try {
    const lock = await acquireAppRunLock({ lane: 'lane-f', lockPath, pid: 5, ancestors: () => [] })
    writeFileSync(join(lockPath, 'owner'), 'someone else pid 6 2026-11-28T06:00:00Z\n')
    lock.release()
    assert.match(readFileSync(join(lockPath, 'owner'), 'utf8'), /^someone else/)
  } finally {
    done()
  }
})

test('requireAppRunLock takes the lock when free, refuses a held one, and is switched off for the suites', async () => {
  const { lockPath, done } = scratch()
  try {
    assert.equal(
      (await requireAppRunLock({ env: { VIDEORC_APP_RUN_LOCK: 'off' }, lockPath })).held,
      'off'
    )
    assert.equal(existsSync(lockPath), false)
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner'), 'busy pid 321 2026-11-28T05:00:00Z\n')
    await assert.rejects(
      requireAppRunLock({
        env: {},
        lockPath,
        pid: 5,
        timeoutMs: 0,
        alive: () => true,
        ancestors: () => []
      }),
      /held by busy/
    )
    rmSync(lockPath, { recursive: true })
    const lock = await requireAppRunLock({ env: {}, lockPath, pid: 5, ancestors: () => [] })
    assert.equal(lock.held, 'taken')
    lock.release()
  } finally {
    done()
  }
})

test('the ancestor chain stops at init, a loop, or an unreadable parent', () => {
  const parents = new Map([
    [10, 20],
    [20, 30],
    [30, 1]
  ])
  assert.deepEqual(
    ancestorPids(10, (pid) => parents.get(pid) ?? NaN),
    [20, 30]
  )
  assert.deepEqual(
    ancestorPids(10, () => 10),
    [10]
  )
  assert.deepEqual(
    ancestorPids(10, () => NaN),
    []
  )
})
