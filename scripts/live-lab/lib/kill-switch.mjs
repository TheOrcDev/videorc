import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { CONTROL_UNREACHABLE_LIMIT_MS, mustStop, reportsRepoFromKillSwitchUrl } from './policy.mjs'

// Plan 178 U4. Everything that ends a live run from outside the scenario:
// the STOP file, control.json in the reports repo, a stream ended from
// YouTube Studio (reported by the observer, U8), Ctrl-C / SIGTERM, and the
// policy itself going bad mid-run. Each one calls onStop(reason) once; the
// harness ends the stream and tears down within 60 s. The clock, the control
// fetch, the file check and the policy reload are injectable so every path
// is unit-tested without a network.

export const STOP_FILE = 'STOP'
export const CONTROL_FETCH_INTERVAL_MS = 60 * 1000
export { CONTROL_UNREACHABLE_LIMIT_MS }

const execFileAsync = promisify(execFile)

export function stopFilePath(dir) {
  return join(dir, STOP_FILE)
}

// control.json is exactly { "enabled": true | false }. Anything else is
// unreadable, which counts as unreachable (and stops after 5 minutes).
export function parseControl(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('control.json is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.enabled !== 'boolean') {
    throw new Error('control.json must be { "enabled": true | false }')
  }
  return { enabled: parsed.enabled }
}

// Fetches control.json. A raw.githubusercontent.com URL is read through
// `gh api` (the reports repo is private while streams are Unlisted, D7);
// any other https URL is fetched directly. Returns { enabled } or throws.
export async function fetchControlFromUrl(url, { exec = execFileAsync, fetchFn = fetch } = {}) {
  const repo = reportsRepoFromKillSwitchUrl(url)
  if (repo) {
    const { stdout } = await exec(
      'gh',
      [
        'api',
        `repos/${repo.owner}/${repo.repo}/contents/${repo.path}?ref=${encodeURIComponent(repo.ref)}`,
        '-H',
        'Accept: application/vnd.github.raw+json'
      ],
      { timeout: 20_000 }
    )
    return parseControl(stdout)
  }
  const response = await fetchFn(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`control.json fetch failed: HTTP ${response.status}`)
  return parseControl(await response.text())
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// `run` describes the live run: { trigger, build, privacy, plannedMinutes,
// startedAt (ms) }. `policy` is the loaded policy; `reloadPolicy` (optional,
// async () => { policy, problems }) is called at the control cadence so a
// policy that is deleted, loosened or made writable mid-run also stops it.
// `quota` (optional, () => { quotaUnitsToday, bundledUnitsToday }) feeds the
// quota stop; without it the units are taken as 0.
export function createKillSwitch({
  policy,
  stopFilePath: stopPath,
  fetchControl,
  now = () => Date.now(),
  onStop,
  run,
  reloadPolicy = null,
  quota = null,
  exists = fileExists,
  controlIntervalMs = CONTROL_FETCH_INTERVAL_MS
}) {
  if (typeof stopPath !== 'string' || stopPath === '') throw new Error('stopFilePath is required')
  if (typeof fetchControl !== 'function') throw new Error('fetchControl is required')
  if (typeof onStop !== 'function') throw new Error('onStop is required')
  if (!run || !Number.isFinite(run.startedAt)) throw new Error('run.startedAt (ms) is required')

  let currentPolicy = policy ?? null
  let policyProblems = policy ? [] : ['policy missing or invalid']
  let controlEnabled = null
  let controlLastOkAt = null
  let controlLastFetchAt = null
  let controlLastError = null
  let studioEnded = false
  let interrupted = false
  let stopped = null
  let detachSignals = null

  async function refreshControl(at, force) {
    if (!force && controlLastFetchAt !== null && at - controlLastFetchAt < controlIntervalMs) return
    controlLastFetchAt = at
    try {
      const result = await fetchControl()
      if (!result || typeof result.enabled !== 'boolean') {
        throw new Error('fetchControl must return { enabled: boolean }')
      }
      controlEnabled = result.enabled
      controlLastOkAt = at
      controlLastError = null
    } catch (error) {
      controlEnabled = null
      controlLastError = error.message
    }
    if (reloadPolicy) {
      try {
        const loaded = await reloadPolicy()
        currentPolicy = loaded.policy ?? null
        policyProblems = loaded.problems ?? (loaded.policy ? [] : ['policy missing or invalid'])
      } catch (error) {
        currentPolicy = null
        policyProblems = [`policy reload failed: ${error.message}`]
      }
    }
  }

  function runState(at) {
    const sinceOk = controlLastOkAt ?? run.startedAt
    const units = quota ? quota() : { quotaUnitsToday: 0, bundledUnitsToday: 0 }
    return {
      policyProblems,
      interrupted,
      stopFilePresent: null,
      studioEnded,
      controlEnabled,
      controlUnreachableForMs: controlEnabled === true ? 0 : Math.max(0, at - sinceOk),
      trigger: run.trigger,
      build: run.build,
      privacy: run.privacy,
      plannedMinutes: run.plannedMinutes,
      elapsedMinutes: (at - run.startedAt) / 60000,
      quotaUnitsToday: units.quotaUnitsToday,
      bundledUnitsToday: units.bundledUnitsToday,
      controlLastError
    }
  }

  async function fire(reason, at) {
    if (stopped) return stopped
    stopped = { reason, at: new Date(at).toISOString() }
    await onStop(reason)
    return stopped
  }

  // Call before every scenario step and at least every 60 s while live.
  // Returns { stop, reason }. onStop runs once, on the first stop.
  async function check({ force = false } = {}) {
    if (stopped) return { stop: true, reason: stopped.reason }
    const at = now()
    await refreshControl(at, force)
    const state = runState(at)
    state.stopFilePresent = await exists(stopPath)
    const verdict = mustStop(currentPolicy, state)
    if (verdict.stop) await fire(verdict.reason, at)
    return verdict
  }

  // The observer (U8) calls this when YouTube reports the broadcast ended
  // without the harness asking. It is an incident; nothing restarts.
  function notifyStudioEnded() {
    studioEnded = true
    return check({ force: false })
  }

  function notifyInterrupt(signal = 'SIGINT') {
    if (!interrupted) interrupted = signal
    return check({ force: false })
  }

  // SIGINT / SIGTERM end the stream through the same path as every other
  // switch. The handler is removed by detach() or after the first stop.
  function attachSignals(target = process) {
    if (detachSignals) return detachSignals
    const handler = (signal) => {
      notifyInterrupt(signal).catch(() => {})
    }
    target.on('SIGINT', handler)
    target.on('SIGTERM', handler)
    detachSignals = () => {
      target.off('SIGINT', handler)
      target.off('SIGTERM', handler)
      detachSignals = null
    }
    return detachSignals
  }

  function snapshot() {
    return {
      stopped,
      controlEnabled,
      controlLastOkAt,
      controlLastError,
      studioEnded,
      interrupted,
      policyProblems: [...policyProblems]
    }
  }

  return { check, notifyStudioEnded, notifyInterrupt, attachSignals, snapshot }
}
