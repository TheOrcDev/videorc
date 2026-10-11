import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runLockPath } from './run-lock.mjs'
import {
  SCENARIO_PARAMS_ENV,
  classifyRunExit,
  parseBootTime,
  parseInstallRecord,
  parseRunOutput,
  pruneLogs,
  reportSlot,
  runScenarioSlot,
  scheduleLogPath,
  updateCheckSlot
} from './schedule-actions.mjs'
import { STATE_FILE, TICK_LOCK_FILE, readState, writeState } from './schedule-state.mjs'
import { validateScheduleTable } from './schedule-table.mjs'
import { reportSince, runTick } from './schedule-tick.mjs'

const MADRID = 'Europe/Madrid'
const POLICY = Object.freeze({
  enabled: true,
  schedule: Object.freeze({ enabled: true, timezone: MADRID })
})
const TABLE = validateScheduleTable({
  version: 1,
  graceMinutes: 15,
  slots: [
    { id: 'update-check', at: '04:00', action: 'update-check' },
    { id: 'churn', at: '04:30', action: 'run', scenario: 'churn' },
    {
      id: 'marathon',
      at: '06:00',
      action: 'run',
      scenario: 'marathon',
      params: { marathonHours: 4 }
    },
    { id: 'idle', at: '11:00', action: 'run', scenario: 'idle' },
    { id: 'report', at: '13:30', action: 'report', graceMinutes: 360 }
  ]
}).table

async function freshDir() {
  return mkdtemp(join(tmpdir(), 'live-lab-schedule-'))
}

function clock(iso) {
  let current = new Date(iso).getTime()
  return {
    now: () => new Date(current),
    set: (next) => {
      current = new Date(next).getTime()
    }
  }
}

// A schedule started at 02:00 Madrid on the test day: today's windows count,
// yesterday's are before its first tick.
async function seed(dir, extra = {}) {
  await writeState(dir, {
    version: 1,
    since: '2026-10-12T00:00:00.000Z',
    days: {},
    history: [],
    lastBootDoctor: null,
    lastTick: null,
    ...extra
  })
}

function fakeActions(script = {}) {
  const calls = []
  const make = (name) => async (args) => {
    calls.push({ name, args })
    const next = script[name]
    if (typeof next === 'function') return next(args)
    return next ?? { status: 'passed', exitCode: 0 }
  }
  return {
    calls,
    actions: {
      run: make('run'),
      'update-check': make('update-check'),
      report: make('report'),
      bootDoctor: make('bootDoctor')
    }
  }
}

function tickWith(dir, overrides = {}) {
  const lines = []
  return {
    lines,
    run: () =>
      runTick({
        workDir: dir,
        loadPolicyFn: async () => ({ policy: POLICY, problems: [] }),
        loadTableFn: async () => ({ table: TABLE, problems: [] }),
        bootTime: async () => null,
        out: (line) => lines.push(line),
        processRef: new EventEmitter(),
        isAlive: () => false,
        ...overrides
      })
  }
}

test('policy problems, enabled false and schedule.enabled false end the tick quietly with a record', async () => {
  for (const [loaded, outcome] of [
    [{ policy: null, problems: ['policy.json is missing'] }, 'policy-invalid'],
    [{ policy: { ...POLICY, enabled: false }, problems: [] }, 'policy-disabled'],
    [
      { policy: { ...POLICY, schedule: { enabled: false, timezone: MADRID } }, problems: [] },
      'schedule-disabled'
    ]
  ]) {
    const dir = await freshDir()
    await seed(dir)
    const { calls, actions } = fakeActions()
    const time = clock('2026-10-12T02:31:00Z')
    const tick = tickWith(dir, { loadPolicyFn: async () => loaded, actions, now: time.now })
    const first = await tick.run()
    assert.equal(first.exitCode, 0)
    assert.equal(first.outcome, outcome)
    assert.deepEqual(calls, [])
    const state = await readState(dir)
    assert.equal(state.lastTick.outcome, outcome)
    assert.equal(tick.lines.length, 1, 'the change is printed once')
    time.set('2026-10-12T02:36:00Z')
    await tick.run()
    assert.equal(tick.lines.length, 1, 'an unchanged outcome stays quiet')
  }
})

test('a due run slot runs once, is recorded, logged and not run again on the next tick', async () => {
  const dir = await freshDir()
  await seed(dir, { days: { '2026-10-12': { 'update-check': { status: 'passed' } } } })
  const { calls, actions } = fakeActions({
    run: { status: 'passed', exitCode: 0, runDir: '/lab/runs/2026-10-12-churn-a1' }
  })
  const time = clock('2026-10-12T02:31:00Z') // 04:31 CEST
  const tick = tickWith(dir, { actions, now: time.now })
  const result = await tick.run()
  assert.equal(result.outcome, 'acted')
  assert.deepEqual(result.ran, [
    { date: '2026-10-12', slotId: 'churn', status: 'passed', reason: null }
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.slot.scenario, 'churn')

  const state = await readState(dir)
  const entry = state.days['2026-10-12'].churn
  assert.equal(entry.status, 'passed')
  assert.equal(entry.runDir, '/lab/runs/2026-10-12-churn-a1')
  assert.equal(entry.slotAt, '2026-10-12T02:30:00.000Z')
  assert.equal(state.history.at(-1).slotId, 'churn')
  assert.equal((await stat(join(dir, STATE_FILE))).mode & 0o777, 0o600)

  const log = await readFile(scheduleLogPath(dir, '2026-10-12'), 'utf8')
  assert.match(log, /2026-10-12 churn: starting run churn/)
  assert.match(log, /2026-10-12 churn: passed run \/lab\/runs\/2026-10-12-churn-a1/)

  time.set('2026-10-12T02:36:00Z')
  const again = await tick.run()
  assert.equal(again.outcome, 'idle')
  assert.equal(calls.length, 1, 'state persisted: no second run the same day')
})

test('a held run lock defers the slot to the next tick inside the window, then it is missed', async () => {
  const dir = await freshDir()
  await seed(dir, { days: { '2026-10-12': { 'update-check': { status: 'passed' } } } })
  const { calls, actions } = fakeActions({
    run: { status: 'deferred-lock', exitCode: null, reason: 'run lock held (od-7, pid 99)' }
  })
  const time = clock('2026-10-12T02:31:00Z')
  const tick = tickWith(dir, { actions, now: time.now })
  await tick.run()
  let state = await readState(dir)
  assert.equal(state.days['2026-10-12'].churn.status, 'deferred-lock')
  assert.equal(state.days['2026-10-12'].churn.attempts, 1)
  assert.equal(state.history.length, 0, 'a deferral is not an outcome')

  time.set('2026-10-12T02:36:00Z')
  await tick.run()
  assert.equal(calls.length, 2, 'retried on the next tick')
  state = await readState(dir)
  assert.equal(state.days['2026-10-12'].churn.attempts, 2)

  time.set('2026-10-12T02:46:00Z')
  const closed = await tick.run()
  assert.equal(calls.length, 2, 'never run after its window')
  assert.deepEqual(
    closed.missed.map((row) => row.slotId),
    ['churn']
  )
  state = await readState(dir)
  assert.equal(state.days['2026-10-12'].churn.status, 'missed')
  assert.match(state.days['2026-10-12'].churn.reason, /run lock was held/)
})

test('missed slots are recorded once and never piled up', async () => {
  const dir = await freshDir()
  await seed(dir)
  const { calls, actions } = fakeActions()
  const time = clock('2026-10-12T04:20:00Z') // 06:20 CEST, every morning window closed
  const tick = tickWith(dir, { actions, now: time.now })
  const result = await tick.run()
  assert.deepEqual(calls, [])
  const today = result.missed.filter((row) => row.date === '2026-10-12').map((row) => row.slotId)
  assert.deepEqual(today, ['update-check', 'churn', 'marathon'])
  time.set('2026-10-12T04:25:00Z')
  const again = await tick.run()
  assert.deepEqual(again.missed, [])
  assert.equal(again.outcome, 'idle')
})

test('the first tick ever does not report the windows before it as missed', async () => {
  const dir = await freshDir()
  const { actions } = fakeActions()
  const tick = tickWith(dir, { actions, now: () => new Date('2026-10-12T04:20:00Z') })
  const result = await tick.run()
  assert.deepEqual(result.missed, [])
  assert.equal((await readState(dir)).since, '2026-10-12T04:20:00.000Z')
})

test('after a slot finishes the tick runs the next one that became due, and misses one it overran', async () => {
  const dir = await freshDir()
  await seed(dir, { days: { '2026-10-12': { 'update-check': { status: 'passed' } } } })
  const time = clock('2026-10-12T02:31:00Z')
  const { calls, actions } = fakeActions({
    run: ({ slot }) => {
      if (slot.id === 'churn') time.set('2026-10-12T04:05:00Z') // churn ends 06:05 CEST
      if (slot.id === 'marathon') time.set('2026-10-12T09:20:00Z') // ends 11:20, idle closed at 11:15
      return { status: 'passed', exitCode: 0 }
    }
  })
  const result = await tickWith(dir, { actions, now: time.now }).run()
  assert.deepEqual(
    calls.map((call) => call.args.slot.id),
    ['churn', 'marathon']
  )
  assert.deepEqual(
    result.missed.map((row) => row.slotId),
    ['idle']
  )
})

test('a slot left running by a dead tick becomes interrupted, not rerun', async () => {
  const dir = await freshDir()
  await seed(dir, {
    days: {
      '2026-10-12': {
        'update-check': { status: 'passed' },
        churn: { status: 'running', startedAt: '2026-10-12T02:30:10.000Z', pid: 4242 }
      }
    }
  })
  const { calls, actions } = fakeActions()
  await tickWith(dir, { actions, now: () => new Date('2026-10-12T02:40:00Z') }).run()
  assert.deepEqual(calls, [])
  const state = await readState(dir)
  assert.equal(state.days['2026-10-12'].churn.status, 'interrupted')
  assert.equal(state.history.at(-1).status, 'interrupted')
})

test('a second tick while one runs does nothing', async () => {
  const dir = await freshDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, TICK_LOCK_FILE), JSON.stringify({ pid: 777, startedAt: 'x' }))
  const { calls, actions } = fakeActions()
  const result = await tickWith(dir, {
    actions,
    isAlive: (pid) => pid === 777,
    now: () => new Date('2026-10-12T02:31:00Z')
  }).run()
  assert.equal(result.outcome, 'tick-locked')
  assert.deepEqual(calls, [])
})

test('the boot doctor runs once per boot', async () => {
  const dir = await freshDir()
  await seed(dir)
  const { calls, actions } = fakeActions({
    bootDoctor: {
      ok: false,
      exitCode: 1,
      file: '/lab/doctor/boot.txt',
      summary: 'Lab NOT ready: 20 pass, 0 warn, 1 fail, 3 skip.'
    }
  })
  const time = clock('2026-10-12T00:00:00Z')
  const tick = tickWith(dir, { actions, now: time.now, bootTime: async () => 1_760_000_000 })
  await tick.run()
  time.set('2026-10-12T00:05:00Z')
  await tick.run()
  assert.equal(calls.filter((call) => call.name === 'bootDoctor').length, 1)
  const state = await readState(dir)
  assert.equal(state.lastBootDoctor.bootTime, 1_760_000_000)
  assert.equal(state.lastBootDoctor.ok, false)
})

test('SIGTERM during a slot is forwarded to the child and ends the tick', async () => {
  const dir = await freshDir()
  await seed(dir, { days: { '2026-10-12': { 'update-check': { status: 'passed' } } } })
  const processRef = new EventEmitter()
  const killed = []
  const time = clock('2026-10-12T02:31:00Z')
  const { calls, actions } = fakeActions({
    run: ({ onChild }) => {
      onChild({ kill: (signal) => killed.push(signal) })
      processRef.emit('SIGTERM', 'SIGTERM')
      time.set('2026-10-12T04:01:00Z') // marathon would now be due
      return { status: 'stopped', exitCode: 3, reason: 'stopped by a kill switch' }
    }
  })
  await tickWith(dir, { actions, now: time.now, processRef }).run()
  assert.deepEqual(killed, ['SIGTERM'])
  assert.equal(calls.length, 1, 'no further slot after a signal')
  assert.equal(processRef.listenerCount('SIGTERM'), 0)
})

test('the report slot asks publish for everything since the last good report', async () => {
  const dir = await freshDir()
  await seed(dir, {
    history: [{ slotId: 'report', status: 'passed', startedAt: '2026-10-11T11:30:05.000Z' }]
  })
  const { calls, actions } = fakeActions()
  await tickWith(dir, { actions, now: () => new Date('2026-10-12T11:31:00Z') }).run()
  const report = calls.find((call) => call.name === 'report')
  assert.equal(report.args.since, '2026-10-11T11:30:05.000Z')
  assert.equal(
    reportSince({ history: [] }, 'report', new Date('2026-10-12T11:31:00Z')),
    '2026-10-11T11:31:00.000Z'
  )
})

test('classifyRunExit maps the run.mjs exit contract', () => {
  const out = 'step 1\nRUN_DIR=/lab/runs/a\n'
  assert.deepEqual(classifyRunExit({ code: 0, stdout: out, stderr: '' }), {
    exitCode: 0,
    runDir: '/lab/runs/a',
    status: 'passed'
  })
  assert.equal(classifyRunExit({ code: 1, stdout: out, stderr: '' }).status, 'failed')
  assert.equal(classifyRunExit({ code: 3, stdout: out, stderr: '' }).status, 'stopped')
  const refused = classifyRunExit({
    code: 2,
    stdout: 'REFUSED (STOP file present)\nRUN_DIR=/x\n',
    stderr: ''
  })
  assert.equal(refused.status, 'refused')
  assert.equal(refused.reason, 'STOP file present')
  const locked = classifyRunExit({
    code: 2,
    stdout: '',
    stderr: 'REFUSED (run lock held by od-1 (pid 7, since 2026-10-12T02:00:00Z))'
  })
  assert.equal(locked.status, 'deferred-lock')
  assert.equal(
    classifyRunExit({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' }).reason,
    'killed by SIGKILL'
  )
  assert.equal(classifyRunExit({ code: 9, stdout: '', stderr: '' }).status, 'crashed')
  assert.deepEqual(parseRunOutput('RUN_DIR=/a\nRUN_DIR=/b\n'), { runDir: '/b', refusal: null })
})

test('runScenarioSlot passes the run CLI contract and params by environment', async () => {
  const dir = await freshDir()
  const runScript = join(dir, 'run.mjs')
  await writeFile(runScript, '')
  const seen = []
  const run = async (call) => {
    seen.push(call)
    return { code: 0, signal: null, stdout: 'RUN_DIR=/lab/runs/m\n', stderr: '' }
  }
  const slot = TABLE.slots.find((entry) => entry.id === 'marathon')
  const outcome = await runScenarioSlot({
    slot,
    workDir: dir,
    run,
    runScript,
    env: { PATH: '/bin' },
    isAlive: () => false
  })
  assert.equal(outcome.status, 'passed')
  assert.deepEqual(seen[0].args, ['--scenario', 'marathon', '--trigger', 'schedule'])
  assert.equal(seen[0].env[SCENARIO_PARAMS_ENV], '{"marathonHours":4}')

  const withBuild = await runScenarioSlot({
    slot: { id: 'x', scenario: 'churn', build: 'candidate', privacy: 'unlisted' },
    workDir: dir,
    run,
    runScript,
    env: { [SCENARIO_PARAMS_ENV]: 'stale' },
    isAlive: () => false
  })
  assert.deepEqual(withBuild.args, [
    '--scenario',
    'churn',
    '--trigger',
    'schedule',
    '--build',
    'candidate',
    '--privacy',
    'unlisted'
  ])
  assert.equal(seen[1].env[SCENARIO_PARAMS_ENV], undefined)

  await writeFile(
    runLockPath(dir),
    JSON.stringify({ pid: 55, runId: 'od-3', startedAt: '2026-10-12T02:00:00Z' })
  )
  const deferred = await runScenarioSlot({
    slot,
    workDir: dir,
    run,
    runScript,
    isAlive: () => true
  })
  assert.equal(deferred.status, 'deferred-lock')
  assert.match(deferred.reason, /od-3, pid 55/)
  assert.equal(seen.length, 2, 'never spawned while the lock is held')

  const missing = await runScenarioSlot({
    slot,
    workDir: await freshDir(),
    run,
    runScript: join(dir, 'nope.mjs'),
    isAlive: () => false
  })
  assert.equal(missing.status, 'skipped')
})

test('updateCheckSlot holds the run lock, records the version, honours STOP and a held lock', async () => {
  const dir = await freshDir()
  let lockDuring = null
  const run = async (call) => {
    lockDuring = JSON.parse(await readFile(runLockPath(dir), 'utf8'))
    assert.deepEqual(call.args, ['--build', 'release', '--json'])
    return {
      code: 0,
      signal: null,
      stdout:
        'Reading the release feed...\nInstalled 0.9.142.\n{\n  "version": "0.9.142",\n  "previous": { "version": "0.9.141" }\n}\n',
      stderr: ''
    }
  }
  const outcome = await updateCheckSlot({
    date: '2026-10-12',
    workDir: dir,
    run,
    pid: 4321,
    isAlive: () => true
  })
  assert.equal(outcome.status, 'passed')
  assert.deepEqual(outcome.detail, { version: '0.9.142', previousVersion: '0.9.141' })
  assert.equal(lockDuring.runId, 'schedule-update-check-2026-10-12')
  await assert.rejects(readFile(runLockPath(dir)), { code: 'ENOENT' })

  const refusedRun = async () => ({
    code: 2,
    signal: null,
    stdout: '',
    stderr: 'live:install REFUSED (TEAM_MISMATCH): wrong team\n'
  })
  const refused = await updateCheckSlot({
    date: '2026-10-12',
    workDir: dir,
    run: refusedRun,
    pid: 4321,
    isAlive: () => true
  })
  assert.equal(refused.status, 'refused')
  assert.equal(refused.reason, 'TEAM_MISMATCH: wrong team')

  await writeFile(
    runLockPath(dir),
    JSON.stringify({ pid: 66, runId: 'od-9', startedAt: '2026-10-12T01:00:00Z' })
  )
  const deferred = await updateCheckSlot({
    date: '2026-10-12',
    workDir: dir,
    run,
    pid: 4321,
    isAlive: (pid) => pid === 66
  })
  assert.equal(deferred.status, 'deferred-lock')

  const stopDir = await freshDir()
  await writeFile(join(stopDir, 'STOP'), '')
  const stopped = await updateCheckSlot({
    date: '2026-10-12',
    workDir: stopDir,
    run,
    isAlive: () => false
  })
  assert.deepEqual(stopped, { status: 'refused', exitCode: null, reason: 'STOP file present' })
})

test('reportSlot skips when publish is not installed and passes --since when it is', async () => {
  const dir = await freshDir()
  const skipped = await reportSlot({
    since: '2026-10-11T11:30:00Z',
    publishScript: join(dir, 'publish.mjs')
  })
  assert.deepEqual(skipped, { status: 'skipped', exitCode: null, reason: 'publish not installed' })
  await writeFile(join(dir, 'publish.mjs'), '')
  const seen = []
  const outcome = await reportSlot({
    since: '2026-10-11T11:30:00Z',
    publishScript: join(dir, 'publish.mjs'),
    run: async (call) => {
      seen.push(call.args)
      return { code: 0, signal: null, stdout: '', stderr: '' }
    }
  })
  assert.equal(outcome.status, 'passed')
  assert.deepEqual(seen[0], ['--since', '2026-10-11T11:30:00Z'])
})

test('small parsers: boot time, install record, log pruning', async () => {
  assert.equal(
    parseBootTime('{ sec = 1760000000, usec = 12345 } Mon Oct 12 03:31:00 2026\n'),
    1_760_000_000
  )
  assert.equal(parseBootTime('garbage'), null)
  assert.equal(parseInstallRecord('no json here'), null)
  const dir = await freshDir()
  await mkdir(join(dir, 'logs'))
  await writeFile(join(dir, 'logs', 'schedule-2026-08-01.log'), '')
  await writeFile(join(dir, 'logs', 'schedule-2026-10-01.log'), '')
  await writeFile(join(dir, 'logs', 'schedule.log'), '')
  assert.deepEqual(await pruneLogs(dir, '2026-10-12'), ['schedule-2026-08-01.log'])
})

test('a corrupt state file stops the schedule loudly', async () => {
  const dir = await freshDir()
  await writeFile(join(dir, STATE_FILE), '{')
  const { calls, actions } = fakeActions()
  const tick = tickWith(dir, { actions, now: () => new Date('2026-10-12T02:31:00Z') })
  const result = await tick.run()
  assert.equal(result.exitCode, 1)
  assert.equal(result.outcome, 'state-unreadable')
  assert.deepEqual(calls, [])
  assert.match(tick.lines[0], /state unreadable/)
})
