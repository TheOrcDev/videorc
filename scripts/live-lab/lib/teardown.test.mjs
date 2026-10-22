import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFakeClock } from './harness-test-fakes.mjs'
import { createEventBus, createWaitFor } from './step-engine.mjs'
import {
  assertCleanLedgers,
  collectArtifacts,
  endStream,
  redactLaunchOutput,
  teardown
} from './teardown.mjs'

function remote({ bus, clock, live = true, accept = true }) {
  let state = { sessionState: live ? 'streaming' : 'idle', sessionActive: live }
  const intents = []
  return {
    intents,
    state: () => state,
    async intent(kind) {
      intents.push(kind)
      if (!accept) return { accepted: false, message: 'busy' }
      clock.setTimeout(() => {
        state = { sessionState: 'idle', sessionActive: false }
        bus.emit('remote.state', state)
      }, 1500)
      return { accepted: true, ok: true }
    }
  }
}

test('endStream stops a live session and waits for idle; it is a no-op when idle', async () => {
  const bus = createEventBus()
  const clock = createFakeClock()
  const live = remote({ bus, clock })
  const done = endStream({ remote: live, waitFor: createWaitFor({ bus, clock }) })
  await clock.advance(1500)
  assert.equal(await done, 'stopped')
  assert.deepEqual(live.intents, ['streamStop'])
  assert.equal(
    await endStream({
      remote: remote({ bus, clock, live: false }),
      waitFor: createWaitFor({ bus, clock })
    }),
    'not live'
  )
  assert.match(await endStream({ remote: null }), /no remote connection/)
  await assert.rejects(
    endStream({
      remote: remote({ bus, clock, accept: false }),
      waitFor: createWaitFor({ bus, clock })
    }),
    /not accepted: busy/
  )
})

test('teardown runs every part in order even after a failure and reports clean only when all passed', async () => {
  const bus = createEventBus()
  const clock = createFakeClock()
  const order = []
  const helper = (label, state = 'terminated') => ({
    label,
    stop: async () => (order.push(`stop-${label}`), { state })
  })
  const promise = teardown({
    remote: remote({ bus, clock }),
    waitFor: createWaitFor({ bus, clock }),
    observer: { stop: () => order.push('observer') },
    quitApp: async () => {
      order.push('quit')
      throw new Error('app did not quit')
    },
    ledgerPaths: ['/ledger.json'],
    rootPid: 4321,
    assertClean: async ({ ledgerPaths, rootPid }) => {
      order.push(`ledger:${ledgerPaths.length}:${rootPid}`)
      return { clean: true }
    },
    helpers: [helper('card-browser'), null, helper('rtmp-sink'), helper('caffeinate')],
    collect: async () => (order.push('collect'), { logs: [] }),
    closeCard: async () => order.push('close-card'),
    clock
  })
  await clock.advance(1500)
  const result = await promise
  assert.deepEqual(order, [
    'observer',
    'quit',
    'ledger:1:4321',
    'stop-card-browser',
    'stop-rtmp-sink',
    'stop-caffeinate',
    'collect',
    'close-card'
  ])
  assert.equal(result.clean, false)
  assert.equal(result.steps.find((step) => step.name === 'quit-app').detail, 'app did not quit')
  assert.equal(result.steps[0].name, 'end-stream')
  assert.equal(result.streamEndedMs, 1500)
})

test('assertCleanLedgers reaps only live PIDs recorded in the ledgers', async () => {
  const signalled = []
  await assert.rejects(
    assertCleanLedgers({
      ledgerPaths: ['/l.json'],
      rootPid: 1,
      waitClean: async () => {
        throw new Error('Timed out waiting for clean process state.\nledger records: 2')
      },
      census: async () => ({
        aliveRecords: [{ pid: 901, label: 'ffmpeg' }],
        records: [{ pid: 901 }, { pid: 902 }]
      }),
      waitNoLive: async () => ({}),
      prune: async () => [{ removed: [{ pid: 902 }] }],
      signal: (pid, name) => signalled.push([pid, name])
    }),
    /1 live owned PID\(s\) reaped, 1 dead record\(s\) pruned/
  )
  assert.deepEqual(signalled, [[901, 'SIGTERM']])
  const clean = await assertCleanLedgers({ ledgerPaths: ['/l.json'], waitClean: async () => ({}) })
  assert.deepEqual(clean, { clean: true, reaped: [], pruned: 0 })
})

test('artifacts: only new crash reports of our processes, Crashpad dumps, logs, and redacted launch output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videorc-teardown-'))
  const runDir = join(root, 'run')
  const userDataDir = join(root, 'user-data')
  const reports = join(root, 'DiagnosticReports')
  const launchStateDir = join(root, 'launch')
  for (const dir of [
    runDir,
    join(userDataDir, 'Crashpad', 'completed'),
    join(userDataDir, 'logs', 'ffmpeg'),
    reports,
    launchStateDir
  ]) {
    await mkdir(dir, { recursive: true })
  }
  const startedAtMs = Date.now() - 1000
  await writeFile(join(reports, 'videorc-backend-2026-10-12-100000.ips'), 'crash')
  await writeFile(join(reports, 'Safari-2026-10-12-100000.ips'), 'not ours')
  await writeFile(join(reports, 'Videorc-2026-10-01-old.ips'), 'old')
  await utimes(
    join(reports, 'Videorc-2026-10-01-old.ips'),
    new Date(startedAtMs - 86_400_000),
    new Date(startedAtMs - 86_400_000)
  )
  await writeFile(join(userDataDir, 'Crashpad', 'completed', 'abc.dmp'), 'dump')
  await writeFile(join(userDataDir, 'backend-crashes.json'), '[]')
  await writeFile(join(userDataDir, 'logs', 'backend.log'), 'log')
  await writeFile(join(userDataDir, 'logs', 'ffmpeg', 'session-1.log'), 'ffmpeg')
  await writeFile(
    join(launchStateDir, 'launch-services-1.stdout.log'),
    '[smoke] backend-ready {"host":"127.0.0.1","port":1,"token":"local-bearer"}\n'
  )
  const collected = await collectArtifacts({
    runDir,
    userDataDir,
    launchStateDir,
    startedAtMs,
    diagnosticReportsDir: reports
  })
  assert.deepEqual(collected.crashReports, ['videorc-backend-2026-10-12-100000.ips'])
  assert.deepEqual(collected.crashpad, ['abc.dmp'])
  assert.equal(collected.backendCrashes, true)
  assert.deepEqual(collected.logs.sort(), ['app-stdout.log', 'backend.log', 'ffmpeg-session-1.log'])
  const stdout = await readFile(join(runDir, 'logs', 'app-stdout.log'), 'utf8')
  assert.ok(!stdout.includes('local-bearer'))
  assert.deepEqual((await readdir(join(runDir, 'crash'))).sort(), [
    'backend-crashes.json',
    'crashpad-abc.dmp',
    'videorc-backend-2026-10-12-100000.ips'
  ])
  assert.equal(
    redactLaunchOutput('{"capability":"x","token":"y"}'),
    '{"capability":"[redacted]","token":"[redacted]"}'
  )
})
