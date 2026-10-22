import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseClock } from './schedule-time.mjs'

// Plan 178 U11. The daily schedule table (D9) lives in the repo at
// config/live-lab/schedule.json, not in the policy: the policy says whether
// the schedule may run at all and in which timezone, the table says what runs
// when. A table that does not validate is a refusal to schedule anything,
// never a partial schedule.

export const SCHEDULE_VERSION = 1
export const DEFAULT_GRACE_MINUTES = 15
export const ACTIONS = Object.freeze(['run', 'update-check', 'report'])

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const DEFAULT_SCHEDULE_PATH = join(REPO_ROOT, 'config', 'live-lab', 'schedule.json')

const SLOT_KEYS = Object.freeze([
  'id',
  'at',
  'action',
  'scenario',
  'build',
  'privacy',
  'params',
  'graceMinutes'
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validGrace(value) {
  return Number.isInteger(value) && value >= 1 && value <= 12 * 60
}

/** Pure. { table, problems }: the frozen table, or null with every problem. */
export function validateScheduleTable(parsed) {
  const problems = []
  if (!isObject(parsed)) return { table: null, problems: ['schedule must be a JSON object'] }
  if (parsed.version !== SCHEDULE_VERSION) {
    problems.push(`version must be ${SCHEDULE_VERSION} (got ${JSON.stringify(parsed.version)})`)
  }
  const grace = parsed.graceMinutes ?? DEFAULT_GRACE_MINUTES
  if (!validGrace(grace)) problems.push('graceMinutes must be a whole number from 1 to 720')
  if (!Array.isArray(parsed.slots) || parsed.slots.length === 0) {
    problems.push('slots must be a non-empty list')
  }
  const slots = []
  const ids = new Set()
  for (const [index, slot] of (Array.isArray(parsed.slots) ? parsed.slots : []).entries()) {
    const where = `slots[${index}]`
    if (!isObject(slot)) {
      problems.push(`${where} must be an object`)
      continue
    }
    for (const key of Object.keys(slot)) {
      if (!SLOT_KEYS.includes(key)) problems.push(`${where} has unknown field "${key}"`)
    }
    if (typeof slot.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slot.id)) {
      problems.push(`${where}.id must be a lowercase slug`)
    } else if (ids.has(slot.id)) {
      problems.push(`${where}.id "${slot.id}" is used twice`)
    } else {
      ids.add(slot.id)
    }
    if (!parseClock(slot.at)) problems.push(`${where}.at must be HH:MM (24 h)`)
    if (!ACTIONS.includes(slot.action)) {
      problems.push(`${where}.action must be one of ${ACTIONS.join(', ')}`)
    }
    if (slot.action === 'run') {
      if (typeof slot.scenario !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slot.scenario)) {
        problems.push(`${where}.scenario must name a scenario`)
      }
    } else if ('scenario' in slot) {
      problems.push(`${where}.scenario only applies to action "run"`)
    }
    if ('build' in slot && !['release', 'candidate'].includes(slot.build)) {
      problems.push(`${where}.build must be release or candidate`)
    }
    if ('privacy' in slot && !['unlisted', 'public'].includes(slot.privacy)) {
      problems.push(`${where}.privacy must be unlisted or public`)
    }
    if ('params' in slot && !isObject(slot.params)) {
      problems.push(`${where}.params must be an object`)
    }
    if ('graceMinutes' in slot && !validGrace(slot.graceMinutes)) {
      problems.push(`${where}.graceMinutes must be a whole number from 1 to 720`)
    }
    slots.push({ ...slot, graceMinutes: slot.graceMinutes ?? grace })
  }
  if (problems.length) return { table: null, problems }
  slots.sort((left, right) => left.at.localeCompare(right.at))
  return {
    table: deepFreeze({
      version: parsed.version,
      graceMinutes: grace,
      slots,
      weeklyReboot: parsed.weeklyReboot ?? null
    }),
    problems: []
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

/** Reads and validates the table. Never throws: problems are returned. */
export async function loadScheduleTable({
  path = DEFAULT_SCHEDULE_PATH,
  read = (file) => readFile(file, 'utf8')
} = {}) {
  let text
  try {
    text = await read(path)
  } catch (error) {
    return { table: null, problems: [`${path} unreadable: ${error.code ?? error.message}`], path }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { table: null, problems: [`${path} is not valid JSON: ${error.message}`], path }
  }
  return { ...validateScheduleTable(parsed), path }
}

export { REPO_ROOT }
