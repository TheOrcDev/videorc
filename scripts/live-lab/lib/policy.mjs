import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'

import { LAB_USER, formatMode } from './config.mjs'
import { LINUX, LINUX_LAB_ETC, labPlatform } from './platform.mjs'

// Plan 178 U4. The owner's policy file is the standing authorization for
// every unattended run. The harness (and any agent logged in as the lab user)
// can read it and never write it: a policy the current user could change is
// refused, not warned about. Every answer here fails closed: a missing field,
// an unknown field, a missing piece of state or an odd value is a refusal
// with a reason string the report can print.

export const POLICY_VERSION = 1
export const DEFAULT_POLICY_PATH = '/Library/Application Support/VideorcLab/policy.json'
// Plan 179: the Linux lab's policy, root:root 0644 in a root-owned 0755 dir.
export const LINUX_POLICY_PATH = `${LINUX_LAB_ETC}/policy.json`
export const CONTROL_UNREACHABLE_LIMIT_MS = 5 * 60 * 1000

export const TRIGGERS = Object.freeze(['schedule', 'on-demand', 'manual'])
export const BUILDS = Object.freeze(['release', 'candidate'])
export const PRIVACIES = Object.freeze(['unlisted', 'public', 'private'])

const TOP_LEVEL_KEYS = Object.freeze([
  'version',
  'enabled',
  'channelHandle',
  'visibility',
  'titlePrefix',
  'onDemand',
  'schedule',
  'quota',
  'faults',
  'camera',
  'killSwitchUrl'
])

// Optional in v1, false when absent. YouTube's Terms do not expressly permit
// recording our own live output with yt-dlp, so clip pulling (U8) stays off
// until the owner turns it on here.
// `triage` (plan 178 U12) lets the headless Claude triage run after a publish;
// off until the owner turns it on, like clipPull.
// `labUser` (plan 179) names the account that runs the lab; the schedule
// installs only for it. Default the dedicated `videorc-lab` account.
const OPTIONAL_KEYS = Object.freeze({ clipPull: false, triage: false, labUser: LAB_USER })

// VIDEORC_LIVE_LAB_POLICY exists for the unit tests and for a doctor run on
// a machine that is not the lab machine. A run never honours a policy that
// the harness itself could have written, whatever its path: loadPolicy's
// ownership check applies to the override too.
export function policyPath(env = process.env, platform = process.platform) {
  const override = env.VIDEORC_LIVE_LAB_POLICY?.trim()
  if (override) return override
  return labPlatform(platform) === LINUX ? LINUX_POLICY_PATH : DEFAULT_POLICY_PATH
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0
}

function validTimezone(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

function validateKillSwitchUrl(value, problems) {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push('killSwitchUrl must be an https URL')
    return
  }
  if (/[<>]/.test(value)) {
    problems.push('killSwitchUrl still has a placeholder (edit the example before installing it)')
    return
  }
  let url
  try {
    url = new URL(value)
  } catch {
    problems.push('killSwitchUrl is not a valid URL')
    return
  }
  if (url.protocol !== 'https:') problems.push('killSwitchUrl must use https')
  if (url.username || url.password) problems.push('killSwitchUrl must not embed credentials')
}

// Pure schema check. Returns the policy (frozen) when it is valid, else the
// list of problems. Unknown keys are problems: a typo in a limit must never
// silently fall back to "no limit".
export function validatePolicy(parsed) {
  const problems = []
  if (!isObject(parsed)) {
    return { policy: null, problems: ['policy must be a JSON object'] }
  }
  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.includes(key) && !(key in OPTIONAL_KEYS)) {
      problems.push(`unknown field "${key}"`)
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in parsed)) problems.push(`missing field "${key}"`)
  }
  // A missing field is reported once, above; a present field is type-checked.
  const has = (key) => key in parsed
  if (has('version') && parsed.version !== POLICY_VERSION) {
    problems.push(`version must be ${POLICY_VERSION} (got ${JSON.stringify(parsed.version)})`)
  }
  if (has('enabled') && typeof parsed.enabled !== 'boolean') {
    problems.push('enabled must be true or false')
  }
  if (
    has('channelHandle') &&
    (typeof parsed.channelHandle !== 'string' || !/^@[\w.-]{3,}$/.test(parsed.channelHandle))
  ) {
    problems.push('channelHandle must be a handle like @VideorcApp')
  }
  if (
    has('titlePrefix') &&
    (typeof parsed.titlePrefix !== 'string' || parsed.titlePrefix.trim().length < 4)
  ) {
    problems.push('titlePrefix must be a short phrase such as "Automated test"')
  }

  const visibility = parsed.visibility
  if (has('visibility') && !isObject(visibility)) {
    problems.push('visibility must be an object { default, allowPublic }')
  } else if (has('visibility')) {
    if (!PRIVACIES.includes(visibility.default)) {
      problems.push(`visibility.default must be one of ${PRIVACIES.join(', ')}`)
    }
    if (typeof visibility.allowPublic !== 'boolean') {
      problems.push('visibility.allowPublic must be true or false')
    }
    if (visibility.default === 'public' && visibility.allowPublic !== true) {
      problems.push('visibility.default is public but allowPublic is not true')
    }
  }

  const onDemand = parsed.onDemand
  if (has('onDemand') && !isObject(onDemand)) {
    problems.push('onDemand must be an object { maxRunMinutes, maxRunsPerDay, allowedBuilds }')
  } else if (has('onDemand')) {
    if (!Number.isInteger(onDemand.maxRunMinutes) || onDemand.maxRunMinutes < 1) {
      problems.push('onDemand.maxRunMinutes must be a positive whole number')
    }
    if (!isCount(onDemand.maxRunsPerDay)) {
      problems.push('onDemand.maxRunsPerDay must be a whole number (0 or more)')
    }
    if (
      !Array.isArray(onDemand.allowedBuilds) ||
      onDemand.allowedBuilds.some((build) => !BUILDS.includes(build))
    ) {
      problems.push(`onDemand.allowedBuilds must list only ${BUILDS.join(' and ')}`)
    }
  }

  const schedule = parsed.schedule
  if (has('schedule') && !isObject(schedule)) {
    problems.push('schedule must be an object { enabled, timezone }')
  } else if (has('schedule')) {
    if (typeof schedule.enabled !== 'boolean')
      problems.push('schedule.enabled must be true or false')
    if (!validTimezone(schedule.timezone)) {
      problems.push('schedule.timezone must be an IANA zone such as Europe/Madrid')
    }
  }

  const quota = parsed.quota
  if (has('quota') && !isObject(quota)) {
    problems.push(
      'quota must be an object { labProjectMaxUnitsPerDay, bundledClientMaxUnitsPerDay }'
    )
  } else if (has('quota')) {
    if (!isCount(quota.labProjectMaxUnitsPerDay)) {
      problems.push('quota.labProjectMaxUnitsPerDay must be a whole number (0 or more)')
    }
    if (!isCount(quota.bundledClientMaxUnitsPerDay)) {
      problems.push('quota.bundledClientMaxUnitsPerDay must be a whole number (0 or more)')
    }
  }

  const faults = parsed.faults
  if (has('faults') && !isObject(faults)) {
    problems.push('faults must be an object { network, process }')
  } else if (has('faults')) {
    if (typeof faults.network !== 'boolean') problems.push('faults.network must be true or false')
    if (typeof faults.process !== 'boolean') problems.push('faults.process must be true or false')
  }

  if (has('camera') && parsed.camera !== false) {
    problems.push('camera must be false (an unattended camera is never allowed)')
  }
  if (has('clipPull') && typeof parsed.clipPull !== 'boolean') {
    problems.push('clipPull must be true or false')
  }
  if (has('triage') && typeof parsed.triage !== 'boolean') {
    problems.push('triage must be true or false')
  }
  if (
    has('labUser') &&
    (typeof parsed.labUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(parsed.labUser))
  ) {
    problems.push('labUser must be a login name such as videorc-lab')
  }
  if (has('killSwitchUrl')) validateKillSwitchUrl(parsed.killSwitchUrl, problems)

  if (problems.length) return { policy: null, problems }
  return { policy: deepFreeze({ ...OPTIONAL_KEYS, ...parsed }), problems: [] }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

// Pure ownership and mode check over injected stat results. `fileStat` and
// `dirStat` are { uid, mode, isFile } / { uid, mode } (a subset of fs.Stats);
// `fileWritable` / `dirWritable` are the fs.access(W_OK) answers, which also
// catch ACLs that a mode alone would miss. The current user must not own the
// file or its directory, nothing in the chain may be group- or
// other-writable, and access() must say no.
export function inspectPolicyAccess({ path, fileStat, dirStat, uid, fileWritable, dirWritable }) {
  const problems = []
  const dir = dirname(path)
  if (!fileStat) {
    problems.push(`${path} is missing`)
  } else {
    if (fileStat.isFile === false) problems.push(`${path} is not a regular file`)
    if (fileStat.uid === uid) {
      problems.push(`${path} is owned by the current user (uid ${uid}); it must be the owner's`)
    }
    if ((fileStat.mode & 0o022) !== 0) {
      problems.push(
        `${path} is ${formatMode(fileStat.mode & 0o777)}; it must not be group- or other-writable (0644)`
      )
    }
    if (fileWritable === true) problems.push(`${path} is writable by the current user`)
  }
  if (!dirStat) {
    problems.push(`${dir} is missing`)
  } else {
    if (dirStat.uid === uid) {
      problems.push(`${dir} is owned by the current user (uid ${uid}); it must be the owner's`)
    }
    if ((dirStat.mode & 0o022) !== 0) {
      problems.push(
        `${dir} is ${formatMode(dirStat.mode & 0o777)}; it must not be group- or other-writable (0755)`
      )
    }
    if (dirWritable === true) problems.push(`${dir} is writable by the current user`)
  }
  return problems
}

async function statOrNull(fn, path) {
  try {
    const entry = await fn(path)
    return { uid: entry.uid, mode: entry.mode, isFile: entry.isFile() }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

async function writable(fn, path) {
  try {
    await fn(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

// Reads, validates and checks ownership. Never throws for a bad policy: the
// caller gets { policy: null, problems } and must refuse. `uid`, `stat`,
// `access` and `read` are injectable for tests.
export async function loadPolicy({
  path = policyPath(),
  uid = process.getuid?.() ?? -1,
  stat: statFn = stat,
  access: accessFn = access,
  read = (file) => readFile(file, 'utf8')
} = {}) {
  const fileStat = await statOrNull(statFn, path)
  const dirStat = await statOrNull(statFn, dirname(path))
  const problems = inspectPolicyAccess({
    path,
    fileStat,
    dirStat,
    uid,
    fileWritable: fileStat ? await writable(accessFn, path) : false,
    dirWritable: dirStat ? await writable(accessFn, dirname(path)) : false
  })
  if (!fileStat) {
    return { policy: null, problems, path }
  }
  let parsed
  try {
    parsed = JSON.parse(await read(path))
  } catch (error) {
    return {
      policy: null,
      problems: [...problems, `${path} is not valid JSON: ${error.message}`],
      path
    }
  }
  const validated = validatePolicy(parsed)
  const all = [...problems, ...validated.problems]
  return all.length
    ? { policy: null, problems: all, path }
    : { policy: validated.policy, problems: [], path }
}

function refuse(reason) {
  return { ok: false, reason }
}

function missing(name) {
  return refuse(`state.${name} is missing; the harness must measure it before asking`)
}

function describeLock(lockHeld) {
  if (isObject(lockHeld)) {
    const who = [lockHeld.runId, lockHeld.pid ? `pid ${lockHeld.pid}` : null].filter(Boolean)
    return who.length ? ` (${who.join(', ')})` : ''
  }
  return ''
}

// May this run start? `request` describes the run, `state` what the harness
// measured right now. Every field is required. The order matters only for
// which reason is reported first; any single failing condition refuses.
//
// Counting rules: `state.runsToday` is the number of on-demand and manual runs
// started today (scheduled runs are bounded by the schedule itself and do not
// count). `request.estimatedQuotaUnits` is charged to the lab project, or to
// the bundled (shared) client when `request.usesBundledClient` is true.
export function canStart(policy, request, state) {
  if (!policy) return refuse('policy missing or invalid')
  if (!isObject(request)) return refuse('request missing')
  if (!isObject(state)) return refuse('state missing')
  if (policy.enabled !== true) return refuse('policy disabled (enabled is false)')

  if (typeof state.stopFilePresent !== 'boolean') return missing('stopFilePresent')
  if (state.stopFilePresent) return refuse('STOP file present')
  if (state.controlEnabled !== true && state.controlEnabled !== false) {
    return refuse('control.json unreachable or unreadable')
  }
  if (state.controlEnabled === false) return refuse('control.json says enabled: false')
  if (state.lockHeld !== false && state.lockHeld !== true && !isObject(state.lockHeld)) {
    return missing('lockHeld')
  }
  if (state.lockHeld) return refuse(`run lock held${describeLock(state.lockHeld)}`)

  if (!TRIGGERS.includes(request.trigger)) {
    return refuse(`unknown trigger ${JSON.stringify(request.trigger)}`)
  }
  if (request.trigger === 'schedule' && policy.schedule.enabled !== true) {
    return refuse('schedule disabled (schedule.enabled is false)')
  }
  if (typeof request.scenario !== 'string' || request.scenario.trim() === '') {
    return refuse('scenario missing')
  }
  if (!BUILDS.includes(request.build)) {
    return refuse(`unknown build ${JSON.stringify(request.build)}`)
  }
  if (!policy.onDemand.allowedBuilds.includes(request.build)) {
    return refuse(
      `build ${request.build} not allowed (allowedBuilds: ${policy.onDemand.allowedBuilds.join(', ') || 'none'})`
    )
  }
  const privacy = request.privacy ?? policy.visibility.default
  if (!PRIVACIES.includes(privacy)) return refuse(`unknown privacy ${JSON.stringify(privacy)}`)
  if (privacy === 'public' && policy.visibility.allowPublic !== true) {
    return refuse('public not allowed (visibility.allowPublic is false)')
  }
  if (!Number.isFinite(request.plannedMinutes) || request.plannedMinutes <= 0) {
    return refuse('plannedMinutes must be a positive number')
  }
  const limited = request.trigger !== 'schedule'
  if (limited && request.plannedMinutes > policy.onDemand.maxRunMinutes) {
    return refuse(
      `planned ${request.plannedMinutes} min over onDemand.maxRunMinutes ${policy.onDemand.maxRunMinutes}`
    )
  }
  if (limited) {
    if (!isCount(state.runsToday)) return missing('runsToday')
    if (state.runsToday >= policy.onDemand.maxRunsPerDay) {
      return refuse(
        `daily run count reached (${state.runsToday} of ${policy.onDemand.maxRunsPerDay})`
      )
    }
  }
  if (!Number.isFinite(request.estimatedQuotaUnits) || request.estimatedQuotaUnits < 0) {
    return refuse('estimatedQuotaUnits must be a number (0 or more)')
  }
  if (typeof request.usesBundledClient !== 'boolean') {
    return refuse('usesBundledClient must be true or false')
  }
  if (!isCount(state.quotaUnitsToday)) return missing('quotaUnitsToday')
  if (!isCount(state.bundledUnitsToday)) return missing('bundledUnitsToday')
  if (request.usesBundledClient) {
    const cap = policy.quota.bundledClientMaxUnitsPerDay
    if (cap === 0)
      return refuse('bundled client not allowed (quota.bundledClientMaxUnitsPerDay is 0)')
    if (state.bundledUnitsToday + request.estimatedQuotaUnits > cap) {
      return refuse(
        `over bundled quota (${state.bundledUnitsToday} used + ${request.estimatedQuotaUnits} > ${cap})`
      )
    }
  } else if (
    state.quotaUnitsToday + request.estimatedQuotaUnits >
    policy.quota.labProjectMaxUnitsPerDay
  ) {
    return refuse(
      `over lab quota (${state.quotaUnitsToday} used + ${request.estimatedQuotaUnits} > ${policy.quota.labProjectMaxUnitsPerDay})`
    )
  }
  return { ok: true, reason: null, privacy }
}

function stop(reason) {
  return { stop: true, reason }
}

// Must a running stream end now? `runState` is what the kill switch keeps
// while live: policy health, the STOP file, control.json, timing, quota,
// Studio and signals. Any one condition stops; the harness ends the stream
// within 60 s and tears down. Unknown or missing state is treated as unsafe.
export function mustStop(policy, runState) {
  if (!isObject(runState)) return stop('run state missing')
  const policyProblems = runState.policyProblems ?? []
  if (!policy || policyProblems.length) {
    return stop(`policy invalid: ${policyProblems[0] ?? 'missing'}`)
  }
  if (policy.enabled !== true) return stop('policy disabled (enabled is false)')
  if (runState.interrupted) return stop('interrupted (signal)')
  if (runState.stopFilePresent !== false) {
    return stop(runState.stopFilePresent ? 'STOP file present' : 'STOP file state unknown')
  }
  if (runState.studioEnded) return stop('ended from YouTube Studio (incident, no restart)')
  if (runState.controlEnabled === false) return stop('control.json says enabled: false')
  const unreachable = runState.controlUnreachableForMs
  if (runState.controlEnabled !== true) {
    if (!Number.isFinite(unreachable)) return stop('control.json state unknown')
    if (unreachable >= CONTROL_UNREACHABLE_LIMIT_MS) {
      return stop(`control.json unreachable for ${Math.round(unreachable / 60000)} min`)
    }
  } else if (Number.isFinite(unreachable) && unreachable >= CONTROL_UNREACHABLE_LIMIT_MS) {
    return stop(`control.json unreachable for ${Math.round(unreachable / 60000)} min`)
  }

  if (!TRIGGERS.includes(runState.trigger)) {
    return stop(`unknown trigger ${JSON.stringify(runState.trigger)}`)
  }
  if (runState.trigger === 'schedule' && policy.schedule.enabled !== true) {
    return stop('schedule disabled (schedule.enabled is false)')
  }
  if (!policy.onDemand.allowedBuilds.includes(runState.build)) {
    return stop(`build ${JSON.stringify(runState.build)} not allowed`)
  }
  if (runState.privacy === 'public' && policy.visibility.allowPublic !== true) {
    return stop('public not allowed (visibility.allowPublic is false)')
  }
  if (!PRIVACIES.includes(runState.privacy)) {
    return stop(`unknown privacy ${JSON.stringify(runState.privacy)}`)
  }

  if (!Number.isFinite(runState.elapsedMinutes) || runState.elapsedMinutes < 0) {
    return stop('elapsed time unknown')
  }
  if (!Number.isFinite(runState.plannedMinutes) || runState.plannedMinutes <= 0) {
    return stop('planned minutes unknown')
  }
  const limit =
    runState.trigger === 'schedule'
      ? runState.plannedMinutes
      : Math.min(runState.plannedMinutes, policy.onDemand.maxRunMinutes)
  if (runState.elapsedMinutes > limit) {
    return stop(`over time (${Math.floor(runState.elapsedMinutes)} min of ${limit} allowed)`)
  }

  if (!isCount(runState.quotaUnitsToday) || !isCount(runState.bundledUnitsToday)) {
    return stop('quota state unknown')
  }
  if (runState.quotaUnitsToday > policy.quota.labProjectMaxUnitsPerDay) {
    return stop(
      `over lab quota (${runState.quotaUnitsToday} > ${policy.quota.labProjectMaxUnitsPerDay})`
    )
  }
  if (runState.bundledUnitsToday > policy.quota.bundledClientMaxUnitsPerDay) {
    return stop(
      `over bundled quota (${runState.bundledUnitsToday} > ${policy.quota.bundledClientMaxUnitsPerDay})`
    )
  }
  return { stop: false, reason: null }
}

// The reports repo behind a raw.githubusercontent.com kill switch URL, so the
// doctor can check gh access to the same repo the kill switch reads.
export function reportsRepoFromKillSwitchUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.hostname !== 'raw.githubusercontent.com') return null
  const [owner, repo, ref, ...rest] = url.pathname.split('/').filter(Boolean)
  if (!owner || !repo || !ref || rest.length === 0) return null
  return { owner, repo, ref, path: rest.join('/'), name: `${owner}/${repo}` }
}
