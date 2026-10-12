import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  acquireRunLock,
  processAlive,
  readRunLock,
  releaseRunLock,
  runLockPath
} from './run-lock.mjs'

const NOW = new Date('2026-10-12T04:30:00.000Z')

async function freshDir() {
  return mkdtemp(join(tmpdir(), 'live-lab-lock-'))
}

test('acquire writes pid, run id and start time; a second acquire is refused while the pid lives', async () => {
  const dir = await freshDir()
  const first = await acquireRunLock({
    dir,
    runId: '2026-10-12-churn',
    now: NOW,
    pid: 4242,
    isAlive: () => true
  })
  assert.equal(first.ok, true)
  assert.equal(first.clearedStale, null)
  assert.equal(first.lock.path, runLockPath(dir))
  const onDisk = JSON.parse(await readFile(runLockPath(dir), 'utf8'))
  assert.deepEqual(onDisk, { pid: 4242, runId: '2026-10-12-churn', startedAt: NOW.toISOString() })

  const second = await acquireRunLock({
    dir,
    runId: 'on-demand-1',
    now: NOW,
    pid: 4343,
    isAlive: () => true
  })
  assert.equal(second.ok, false)
  assert.match(
    second.reason,
    /run lock held by 2026-10-12-churn \(pid 4242, since 2026-10-12T04:30:00.000Z\)/
  )
  assert.equal(second.holder.runId, '2026-10-12-churn')
})

test('a stale lock (dead pid) is cleared, reported and replaced', async () => {
  const dir = await freshDir()
  await writeFile(
    runLockPath(dir),
    JSON.stringify({ pid: 99999, runId: 'crashed-run', startedAt: '2026-10-11T06:00:00.000Z' })
  )
  const result = await acquireRunLock({
    dir,
    runId: 'next-run',
    now: NOW,
    pid: 10,
    isAlive: (pid) => pid !== 99999
  })
  assert.equal(result.ok, true)
  assert.equal(result.clearedStale.runId, 'crashed-run')
  assert.equal(result.clearedStale.pid, 99999)
  assert.equal((await readRunLock({ dir })).runId, 'next-run')
})

test('an unreadable lock is never cleared: the run is refused with a reason', async () => {
  const dir = await freshDir()
  await writeFile(runLockPath(dir), '{"pid": 1, "runId":')
  const result = await acquireRunLock({
    dir,
    runId: 'next-run',
    now: NOW,
    pid: 10,
    isAlive: () => false
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /unreadable \(not valid JSON\); remove it by hand/)
  assert.equal(await readFile(runLockPath(dir), 'utf8'), '{"pid": 1, "runId":')

  await writeFile(runLockPath(dir), JSON.stringify({ runId: 'no-pid' }))
  const noPid = await acquireRunLock({
    dir,
    runId: 'next-run',
    now: NOW,
    pid: 10,
    isAlive: () => false
  })
  assert.equal(noPid.ok, false)
  assert.match(noPid.reason, /missing pid, runId or startedAt/)
  assert.equal((await readRunLock({ dir })).corrupt, true)
})

test('release frees only our own lock', async () => {
  const dir = await freshDir()
  assert.deepEqual(await releaseRunLock({ dir, runId: 'nothing' }), {
    released: false,
    reason: 'no lock'
  })
  await acquireRunLock({ dir, runId: 'mine', now: NOW, pid: 7, isAlive: () => true })
  const other = await releaseRunLock({ dir, runId: 'theirs', pid: 7 })
  assert.equal(other.released, false)
  assert.match(other.reason, /belongs to mine \(pid 7\), not theirs/)
  const wrongPid = await releaseRunLock({ dir, runId: 'mine', pid: 8 })
  assert.equal(wrongPid.released, false)
  assert.deepEqual(await releaseRunLock({ dir, runId: 'mine', pid: 7 }), {
    released: true,
    reason: null
  })
  assert.equal(await readRunLock({ dir }), null)
})

test('readRunLock is null without a lock and acquire needs a run id', async () => {
  const dir = await freshDir()
  assert.equal(await readRunLock({ dir }), null)
  const missing = await acquireRunLock({ dir, runId: '', now: NOW })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /runId missing/)
})

test('processAlive: our own pid lives, EPERM counts as alive, ESRCH and bad pids do not', () => {
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(0), false)
  assert.equal(processAlive(-1), false)
  assert.equal(processAlive('12'), false)
  const eperm = () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  }
  const esrch = () => {
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
  }
  assert.equal(processAlive(1, eperm), true)
  assert.equal(processAlive(1, esrch), false)
})
