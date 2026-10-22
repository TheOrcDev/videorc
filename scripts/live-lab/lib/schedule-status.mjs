import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { labDir as defaultLabDir, workDir as defaultWorkDir } from './config.mjs'
import { fetchControlFromUrl, stopFilePath } from './kill-switch.mjs'
import { loadPolicy } from './policy.mjs'
import { DEFAULT_MAX_UNITS_PER_DAY, createQuotaLedger } from './quota-ledger.mjs'
import { processAlive, readRunLock } from './run-lock.mjs'
import { upcomingSlots } from './schedule-plan.mjs'
import { readState } from './schedule-state.mjs'
import { loadScheduleTable } from './schedule-table.mjs'
import { formatLocal } from './schedule-time.mjs'

// Plan 178 U11 step 2. `live:schedule status`: the next slots (today and
// tomorrow, policy timezone), the last 7 run folders with their verdicts,
// today's lab quota, the run lock, and the policy and kill switch state.
// Read-only: it never changes the state file or the lock. Every source is
// optional; a missing one is shown as such, never as a crash.

const RUNS_SHOWN = 7
const FALLBACK_TIMEZONE = 'Europe/Madrid'

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function pickVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return null
  for (const key of ['verdict', 'status', 'result', 'overall']) {
    if (typeof verdict[key] === 'string') return verdict[key]
  }
  if (typeof verdict.pass === 'boolean') return verdict.pass ? 'pass' : 'fail'
  return null
}

function describeBuild(build) {
  if (!build) return null
  if (typeof build === 'string') return build
  return [build.kind ?? build.source, build.version].filter(Boolean).join(' ') || null
}

/** The newest run folders under <work dir>/runs, with manifest and verdict when present. */
export async function recentRuns(workDir, { history = [], limit = RUNS_SHOWN } = {}) {
  const runsDir = join(workDir, 'runs')
  let names = []
  try {
    const entries = await readdir(runsDir, { withFileTypes: true })
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  names.sort().reverse()
  const rows = []
  for (const name of names.slice(0, limit)) {
    const dir = join(runsDir, name)
    const manifest = await readJson(join(dir, 'manifest.json'))
    const verdict = await readJson(join(dir, 'verdict.json'))
    const scheduled = history.findLast?.((row) => row.runDir === dir) ?? null
    rows.push({
      name,
      dir,
      scenario: manifest?.scenario ?? null,
      trigger: manifest?.trigger ?? null,
      build: describeBuild(manifest?.build),
      startedAt: manifest?.startedAt ?? null,
      verdict: pickVerdict(verdict) ?? (scheduled ? `exit: ${scheduled.status}` : null),
      hasVerdictFile: Boolean(verdict)
    })
  }
  return rows
}

export async function gatherStatus({
  now = new Date(),
  env = process.env,
  workDir = defaultWorkDir(env),
  labDir = defaultLabDir(env),
  loadPolicyFn = loadPolicy,
  loadTableFn = loadScheduleTable,
  readStateFn = readState,
  fetchControl = fetchControlFromUrl,
  isAlive = processAlive,
  checkControl = true
} = {}) {
  const loaded = await loadPolicyFn()
  const policy = loaded.policy
  const timeZone = policy?.schedule.timezone ?? FALLBACK_TIMEZONE
  const { table, problems: tableProblems } = await loadTableFn()

  let state = null
  let stateError = null
  try {
    state = await readStateFn(workDir)
  } catch (error) {
    stateError = error.message
  }

  const slots = table ? upcomingSlots({ table, state, now, timeZone }) : []
  const runs = await recentRuns(workDir, { history: state?.history ?? [] })

  let quota = null
  let quotaError = null
  try {
    const cap = policy?.quota.labProjectMaxUnitsPerDay
    quota = createQuotaLedger({
      dir: labDir,
      maxUnitsPerDay: cap > 0 ? cap : DEFAULT_MAX_UNITS_PER_DAY,
      now: () => now
    }).today()
  } catch (error) {
    quotaError = error.message
  }

  let lock = null
  try {
    const held = await readRunLock({ dir: workDir })
    if (held) lock = { ...held, alive: held.corrupt ? null : isAlive(held.pid) }
  } catch (error) {
    lock = { corrupt: true, reason: error.message }
  }

  let control = null
  if (checkControl && policy?.killSwitchUrl) {
    try {
      control = { enabled: (await fetchControl(policy.killSwitchUrl)).enabled, error: null }
    } catch (error) {
      control = { enabled: null, error: error.message }
    }
  }

  return {
    now: now.toISOString(),
    timeZone,
    policy: {
      path: loaded.path ?? null,
      ok: Boolean(policy),
      problems: loaded.problems ?? [],
      enabled: policy?.enabled ?? null,
      scheduleEnabled: policy?.schedule.enabled ?? null
    },
    table: { ok: Boolean(table), problems: tableProblems ?? [] },
    stopFile: await exists(stopFilePath(workDir)),
    control,
    lock,
    slots: slots.map((row) => ({
      date: row.date,
      id: row.slot.id,
      action: row.slot.action,
      scenario: row.slot.scenario ?? null,
      at: row.start.toISOString(),
      local: formatLocal(row.start, timeZone),
      when: row.when,
      status: row.entry?.status ?? null,
      reason: row.entry?.reason ?? null
    })),
    runs,
    quota,
    quotaError,
    lastTick: state?.lastTick ?? null,
    lastBootDoctor: state?.lastBootDoctor ?? null,
    stateError
  }
}

function yesNo(value) {
  if (value === null || value === undefined) return 'unknown'
  return value ? 'yes' : 'no'
}

/** Plain text lines for the terminal. */
export function formatStatus(status) {
  const lines = []
  lines.push(`Live lab schedule (${status.timeZone}), ${status.now}`)
  lines.push('')
  if (status.policy.ok) {
    lines.push(
      `policy        enabled ${yesNo(status.policy.enabled)}, schedule ${yesNo(status.policy.scheduleEnabled)}`
    )
  } else {
    lines.push(`policy        INVALID: ${status.policy.problems[0] ?? 'missing'}`)
  }
  lines.push(`STOP file     ${status.stopFile ? 'PRESENT (runs refused)' : 'absent'}`)
  if (status.control) {
    lines.push(
      `control.json  ${status.control.error ? `unreachable (${status.control.error})` : `enabled ${yesNo(status.control.enabled)}`}`
    )
  }
  if (!status.lock) lines.push('run lock      free')
  else if (status.lock.corrupt) lines.push(`run lock      UNREADABLE (${status.lock.reason})`)
  else {
    lines.push(
      `run lock      ${status.lock.alive ? 'held' : 'stale'} by ${status.lock.runId} (pid ${status.lock.pid}, since ${status.lock.startedAt})`
    )
  }
  if (status.quota) {
    lines.push(
      `quota         ${status.quota.units} of ${status.quota.max} lab units used on Pacific day ${status.quota.day} (${status.quota.remaining} left)`
    )
  } else {
    lines.push(`quota         unreadable (${status.quotaError})`)
  }
  if (status.lastTick) {
    lines.push(
      `last tick     ${status.lastTick.at}: ${status.lastTick.outcome}${status.lastTick.reason ? ` (${status.lastTick.reason})` : ''}`
    )
  } else {
    lines.push('last tick     never')
  }
  if (status.lastBootDoctor) {
    const doctor = status.lastBootDoctor
    lines.push(
      `boot doctor   ${doctor.at}: ${doctor.ok ? 'PASS' : 'FAIL'}${doctor.summary ? ` (${doctor.summary})` : ''}`
    )
  }
  if (status.stateError) lines.push(`state         UNREADABLE (${status.stateError})`)

  lines.push('')
  lines.push('Slots')
  if (!status.table.ok) lines.push(`  schedule table INVALID: ${status.table.problems[0]}`)
  let nextShown = false
  for (const slot of status.slots) {
    const what = slot.scenario ? `${slot.action} ${slot.scenario}` : slot.action
    let outcome = 'scheduled'
    if (slot.status) outcome = `${slot.status}${slot.reason ? ` (${slot.reason})` : ''}`
    else if (slot.when === 'past') outcome = 'not recorded yet'
    else if (slot.when === 'open') outcome = 'due now'
    else if (!nextShown) outcome = 'next'
    if (slot.when !== 'past' && !slot.status) nextShown = true
    lines.push(`  ${slot.local}  ${slot.id.padEnd(13)} ${what.padEnd(18)} ${outcome}`)
  }

  lines.push('')
  lines.push(`Last ${RUNS_SHOWN} runs`)
  if (!status.runs.length) lines.push('  none yet')
  for (const run of status.runs) {
    const label = [run.scenario, run.trigger, run.build].filter(Boolean).join(', ')
    lines.push(`  ${run.name}  ${label ? `${label}  ` : ''}${run.verdict ?? 'no verdict'}`)
  }
  return lines
}
