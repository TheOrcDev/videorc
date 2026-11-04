import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROFILE_REMOVAL_TIMEOUT_MS,
  profileOwnedPids,
  removeProfileDir
} from './profile-dir-removal.mjs'

function fakeClock() {
  let current = 0
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms
    },
    get elapsed() {
      return current
    }
  }
}

function codeError(code) {
  return Object.assign(new Error(`${code}: resource busy or locked`), { code })
}

test('retries EBUSY until the removal succeeds, without a warning', async () => {
  const clock = fakeClock()
  const warnings = []
  let calls = 0
  const result = await removeProfileDir('/tmp/profile', {
    rm: async () => {
      calls += 1
      if (calls <= 2) throw codeError('EBUSY')
    },
    ownedPids: () => [],
    now: clock.now,
    sleep: clock.sleep,
    warn: (line) => warnings.push(line)
  })
  assert.equal(result.removed, true)
  assert.equal(result.attempts, 3)
  assert.equal(calls, 3)
  assert.deepEqual(warnings, [])
})

test('a directory that never frees warns and returns within the budget instead of throwing', async () => {
  const clock = fakeClock()
  const warnings = []
  let calls = 0
  const result = await removeProfileDir('/tmp/profile', {
    label: 'remote-control smoke',
    rm: () => {
      calls += 1
      throw codeError('EPERM')
    },
    ownedPids: () => [],
    now: clock.now,
    sleep: clock.sleep,
    warn: (line) => warnings.push(line)
  })
  assert.equal(result.removed, false)
  assert.equal(result.error.code, 'EPERM')
  assert.ok(calls > 2, `expected several attempts, got ${calls}`)
  assert.ok(clock.elapsed <= PROFILE_REMOVAL_TIMEOUT_MS, `slept ${clock.elapsed} ms`)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^remote-control smoke: warning: could not remove .*\/tmp\/profile/)
  assert.match(warnings[0], /EPERM/)
})

test('an error that is not a held handle warns at once', async () => {
  const warnings = []
  let calls = 0
  const result = await removeProfileDir('/tmp/profile', {
    rm: () => {
      calls += 1
      throw codeError('EINVAL')
    },
    ownedPids: () => [],
    sleep: async () => assert.fail('must not retry'),
    warn: (line) => warnings.push(line)
  })
  assert.equal(result.removed, false)
  assert.equal(calls, 1)
  assert.equal(warnings.length, 1)
})

test('waits for owned processes to be reaped before removing', async () => {
  const clock = fakeClock()
  const alive = new Set([4242, 4343])
  const order = []
  const result = await removeProfileDir('/tmp/profile', {
    pids: [4343],
    ownedPids: () => [4242],
    isAlive: (pid) => {
      if (clock.elapsed >= 300) alive.delete(pid)
      return alive.has(pid)
    },
    rm: () => {
      order.push(`rm at ${clock.elapsed}`)
      assert.equal(alive.size, 0, 'removal ran while an owned process was alive')
    },
    now: clock.now,
    sleep: clock.sleep,
    warn: () => assert.fail('no warning expected')
  })
  assert.equal(result.removed, true)
  assert.deepEqual(result.livePids, [])
  assert.deepEqual(order, ['rm at 300'])
})

test('a process that never exits is named in a warning and the removal still runs', async () => {
  const clock = fakeClock()
  const warnings = []
  let removed = false
  const result = await removeProfileDir('/tmp/profile', {
    pids: [4242],
    ownedPids: () => [],
    isAlive: () => true,
    rm: () => {
      removed = true
    },
    reapTimeoutMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
    warn: (line) => warnings.push(line)
  })
  assert.equal(result.removed, true)
  assert.equal(removed, true)
  assert.deepEqual(result.livePids, [4242])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /4242 still alive/)
})

test('reads owned pids from the profile ledger and removes the real directory', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'videorc-profile-removal-'))
  mkdirSync(join(profile, 'owned-processes'))
  writeFileSync(
    join(profile, 'owned-processes', 'abc.json'),
    JSON.stringify([{ pid: 9999991, label: 'backend', startedAt: '2026-11-04T00:00:00Z' }])
  )
  writeFileSync(join(profile, 'owned-processes', 'notes.txt'), 'not a ledger')
  assert.deepEqual(profileOwnedPids(profile), [9999991])
  assert.deepEqual(profileOwnedPids(join(profile, 'missing')), [])

  const checked = []
  const result = await removeProfileDir(profile, {
    isAlive: (pid) => {
      checked.push(pid)
      return false
    },
    warn: () => assert.fail('no warning expected')
  })
  assert.deepEqual(checked, [9999991])
  assert.equal(result.removed, true)
  assert.equal(existsSync(profile), false)
})
