import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { workDir as defaultWorkDir } from './config.mjs'
import { loadPolicy } from './policy.mjs'
import { processAlive } from './run-lock.mjs'
import {
  bootDoctor,
  openScheduleLog,
  parseBootTime,
  pruneLogs,
  reportSlot,
  runScenarioSlot,
  updateCheckSlot
} from './schedule-actions.mjs'
import { planTick } from './schedule-plan.mjs'
import {
  acquireTickLock,
  closeAbandoned,
  readState,
  withHistory,
  withSlot,
  writeState
} from './schedule-state.mjs'
import { loadScheduleTable } from './schedule-table.mjs'
import { localDate } from './schedule-time.mjs'

// Plan 178 U11. One launchd tick (every 300 s and once at login). In order:
// take the tick lock, close slots a dead tick left running, read the policy
// (problems, enabled: false or schedule.enabled: false end the tick quietly
// after recording why), read the table, run the post-boot doctor once per
// boot, record windows that closed unrun as missed, then run the due slots
// one after another to completion. A slot whose run lock is held is deferred
// to the next tick; it is never run twice and never run after its window.

const execFileAsync = promisify(execFile)
const MAX_ITEMS_PER_TICK = 6
const DAY_MS = 86_400_000

export async function readBootTime({ exec = execFileAsync } = {}) {
  try {
    const { stdout } = await exec('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 5000 })
    return parseBootTime(stdout)
  } catch {
    return null
  }
}

function defaultActions() {
  return {
    run: runScenarioSlot,
    'update-check': updateCheckSlot,
    report: reportSlot,
    bootDoctor
  }
}

/** The ISO time the last successful report started, or 24 h before `now`. */
export function reportSince(state, slotId, now) {
  const rows = (state.history ?? []).filter(
    (row) => row.slotId === slotId && row.status === 'passed' && row.startedAt
  )
  const last = rows.at(-1)
  return last ? last.startedAt : new Date(now.getTime() - DAY_MS).toISOString()
}

export async function runTick({
  now = () => new Date(),
  env = process.env,
  workDir = defaultWorkDir(env),
  loadPolicyFn = loadPolicy,
  loadTableFn = loadScheduleTable,
  actions = defaultActions(),
  bootTime = readBootTime,
  openLog = openScheduleLog,
  out = (line) => console.log(line),
  isAlive = processAlive,
  processRef = process,
  pid = process.pid,
  maxItems = MAX_ITEMS_PER_TICK
} = {}) {
  const tickLock = await acquireTickLock({ dir: workDir, pid, now: now(), isAlive })
  if (!tickLock.ok) return { exitCode: 0, outcome: 'tick-locked', reason: tickLock.reason }

  let activeChild = null
  let stopping = null
  const onSignal = (signal) => {
    stopping = signal
    if (activeChild) activeChild.kill(signal)
  }
  processRef.on?.('SIGTERM', onSignal)
  processRef.on?.('SIGINT', onSignal)

  let logStream = null
  let logDate = null
  let state = null
  const ran = []
  const missedRecorded = []

  const say = async (timeZone, line) => {
    const stamp = now()
    const date = localDate(stamp, timeZone)
    if (!logStream || logDate !== date) {
      logStream?.end()
      logStream = await openLog(workDir, date)
      logDate = date
      await pruneLogs(workDir, date)
    }
    const text = `[${stamp.toISOString()}] schedule: ${line}`
    logStream.write(`${text}\n`)
    out(text)
  }

  // Non-acting outcomes print only when they change, so a disabled lab does
  // not write 288 identical lines a day.
  const settle = async (outcome, detail = {}) => {
    const previous = state.lastTick?.outcome
    state = { ...state, lastTick: { at: now().toISOString(), outcome, ...detail } }
    await writeState(workDir, state)
    if (previous !== outcome && outcome !== 'idle' && outcome !== 'acted') {
      out(
        `[${now().toISOString()}] schedule: ${outcome}${detail.reason ? ` (${detail.reason})` : ''}`
      )
    }
    return outcome
  }

  try {
    try {
      state = await readState(workDir)
    } catch (error) {
      out(
        `[${now().toISOString()}] schedule: state unreadable, nothing scheduled: ${error.message}`
      )
      return { exitCode: 1, outcome: 'state-unreadable', reason: error.message }
    }
    // Windows that closed before the schedule's first tick were never ours
    // to run; they are not reported as missed.
    const firstTick = !state.since
    if (firstTick) state = { ...state, since: now().toISOString() }
    const abandoned = closeAbandoned(state, now())
    state = abandoned.state
    if (firstTick || abandoned.closed.length) await writeState(workDir, state)

    let loaded = await loadPolicyFn()
    if (!loaded.policy) {
      const reason = loaded.problems?.[0] ?? 'policy missing'
      return {
        exitCode: 0,
        outcome: await settle('policy-invalid', { reason, problems: loaded.problems })
      }
    }
    if (loaded.policy.enabled !== true) {
      return {
        exitCode: 0,
        outcome: await settle('policy-disabled', { reason: 'enabled is false' })
      }
    }
    if (loaded.policy.schedule.enabled !== true) {
      return {
        exitCode: 0,
        outcome: await settle('schedule-disabled', { reason: 'schedule.enabled is false' })
      }
    }
    const timeZone = loaded.policy.schedule.timezone

    const { table, problems: tableProblems } = await loadTableFn()
    if (!table) {
      return {
        exitCode: 1,
        outcome: await settle('table-invalid', {
          reason: tableProblems[0],
          problems: tableProblems
        })
      }
    }

    for (const { date, slotId } of abandoned.closed) {
      await say(timeZone, `${date} ${slotId}: interrupted (its tick ended without an outcome)`)
    }

    const boot = await bootTime()
    if (boot !== null && state.lastBootDoctor?.bootTime !== boot) {
      await say(
        timeZone,
        `boot doctor: running live:doctor after boot ${new Date(boot * 1000).toISOString()}`
      )
      const doctor = await actions.bootDoctor({
        workDir,
        now,
        env,
        logStream,
        onChild: (child) => (activeChild = child)
      })
      state = {
        ...state,
        lastBootDoctor: { bootTime: boot, at: now().toISOString(), ...doctor }
      }
      await writeState(workDir, state)
      await say(
        timeZone,
        `boot doctor: ${doctor.ok ? 'PASS' : 'FAIL'}${doctor.summary ? ` (${doctor.summary})` : ''}`
      )
    }

    for (let item = 0; item < maxItems && !stopping; item += 1) {
      const plan = planTick({ table, state, now: now(), timeZone })
      for (const window of plan.missed) {
        const entry = {
          status: 'missed',
          action: window.slot.action,
          slotAt: window.start.toISOString(),
          recordedAt: now().toISOString(),
          reason: window.reason
        }
        state = withHistory(withSlot(state, window.date, window.slot.id, entry), {
          date: window.date,
          slotId: window.slot.id,
          ...entry
        })
        missedRecorded.push({ date: window.date, slotId: window.slot.id, reason: window.reason })
        await say(timeZone, `${window.date} ${window.slot.id}: missed (${window.reason})`)
      }
      if (plan.missed.length) await writeState(workDir, state)
      const due = plan.due[0]
      if (!due) break

      const { slot, date } = due
      const previous = state.days?.[date]?.[slot.id]
      const startedAt = now().toISOString()
      state = withSlot(state, date, slot.id, {
        status: 'running',
        action: slot.action,
        slotAt: due.start.toISOString(),
        startedAt,
        pid,
        attempts: (previous?.attempts ?? 0) + 1
      })
      await writeState(workDir, state)
      await say(
        timeZone,
        `${date} ${slot.id}: starting ${slot.action}${slot.scenario ? ` ${slot.scenario}` : ''}`
      )

      const common = { env, logStream, onChild: (child) => (activeChild = child), isAlive }
      let outcome
      try {
        if (slot.action === 'run') {
          outcome = await actions.run({ ...common, slot, workDir })
        } else if (slot.action === 'update-check') {
          outcome = await actions['update-check']({ ...common, date, workDir, now, pid })
        } else {
          outcome = await actions.report({ ...common, since: reportSince(state, slot.id, now()) })
        }
      } catch (error) {
        outcome = { status: 'crashed', exitCode: null, reason: error.message }
      }
      activeChild = null

      const entry = {
        ...outcome,
        action: slot.action,
        slotAt: due.start.toISOString(),
        startedAt,
        endedAt: now().toISOString(),
        attempts: (previous?.attempts ?? 0) + 1
      }
      state = withSlot(state, date, slot.id, entry)
      if (outcome.status !== 'deferred-lock') {
        state = withHistory(state, { date, slotId: slot.id, ...entry })
      }
      await writeState(workDir, state)
      ran.push({ date, slotId: slot.id, status: outcome.status, reason: outcome.reason ?? null })
      await say(
        timeZone,
        `${date} ${slot.id}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}${outcome.runDir ? ` run ${outcome.runDir}` : ''}`
      )
      if (outcome.status === 'deferred-lock') break

      // The policy may have changed during a long run.
      loaded = await loadPolicyFn()
      if (
        !loaded.policy ||
        loaded.policy.enabled !== true ||
        loaded.policy.schedule.enabled !== true
      ) {
        await say(timeZone, 'policy changed during the run; no further slots this tick')
        break
      }
    }
    if (stopping) await say(timeZone, `stopping on ${stopping}`)
    const outcome = await settle(ran.length || missedRecorded.length ? 'acted' : 'idle')
    return { exitCode: 0, outcome, ran, missed: missedRecorded }
  } finally {
    processRef.off?.('SIGTERM', onSignal)
    processRef.off?.('SIGINT', onSignal)
    if (logStream) await new Promise((resolve) => logStream.end(resolve))
    await tickLock.release()
  }
}
