// Plan 178 U6 (plan 176 L2). The scenario step engine every live-lab run
// goes through. U9 writes the real scenarios in this format; U13 adds fault
// steps to it.
//
// A scenario is the default export of scripts/live-lab/scenarios/<name>.mjs,
// passed through defineScenario():
//
//   export default defineScenario({
//     name: 'dry',                       // [a-z0-9-], same as the file name
//     plannedMinutes: 5,                 // or (params) => number; policy limit and over-time stop
//     estimatedQuotaUnits: 0,            // or (params) => number; lab project units this run may spend
//     usesBundledClient: false,          // true only for U15's release suite
//     usesLabYoutubeClient: false,       // optional: pass the lab OAuth client (U14)
//     destination: 'local-sink',         // 'local-sink' (loopback RTMP) or 'youtube' (default)
//     orientations: ['horizontal'],      // optional: stream key slots to seed
//     steps: [
//       {
//         id: 'go-live',                 // unique, [a-z0-9-]
//         title: 'Go live',              // optional, shown on the test card
//         deadlineMs: 90_000,            // hard deadline for run() (and its waits)
//         sceneId: 0,                    // optional card scene glyph (0-15)
//         onFail: 'abort',               // 'abort' (default) skips later steps; 'continue'
//         async run(ctx) { ... return evidence },
//         expect(evidence, ctx) { return true | 'why it failed' }   // optional check, or
//         expect: 'what the step expects',                          // a description only
//       }
//
//   run() may return { skipped: true, reason } (a policy-gated fault, say):
//   the step is recorded as skipped, not failed, and the run goes on.
//     ]
//   })
//
// The ctx a step receives:
//   ctx.run          { runId, scenario, trigger, build, privacy, titlePrefix, startedAt }
//   ctx.params       scenario params from VIDEORC_LIVE_LAB_SCENARIO_PARAMS (JSON object, {} when unset)
//   ctx.remote       remote control (intents, remote.state), see session.mjs
//   ctx.ui           CDP driver for the real Go Live dialog, see ui-driver.mjs
//   ctx.observe      app observer (journal, health events, census, incidents()), see app-observer.mjs
//   ctx.card         the test card server (push, setStep)
//   ctx.killSwitch   the U4 kill switch (check, notifyStudioEnded, snapshot)
//   ctx.observer     optional YouTube observer hook (U8/U9), null in U6
//   ctx.policy       the loaded policy (read-only, frozen)
//   ctx.healthEvents() [{ code, at (epoch ms), level, source }] from the backend
//                    health.event feed and journal health lines, deduplicated
//   ctx.ledger       { ledgerPaths } the app's owned-process ledgers (process-census)
//   ctx.sink         the local RTMP sink when destination is 'local-sink', else null
//   ctx.runDir       the run folder (evidence lands here)
//   ctx.log(msg)     one line to run.log and stdout (never put a secret in it)
//   ctx.ownedPids()  { app, backend, browser, caffeinate, sink, ledger: [] }
//   ctx.events       the event bus (remote.state, remote.ack, ui, journal, health, census)
//   ctx.signal       AbortSignal: aborted on a kill-switch stop or the step deadline
//   ctx.waitFor(predicate, { deadlineMs, label })
//       Event-based wait: evaluates predicate now and again on every bus event,
//       resolves with its first truthy value, rejects with DeadlineError at the
//       deadline (default: what is left of the step deadline) or StoppedError
//       when the run stops. There are no fixed sleeps (AGENTS.md).
//
// Each step's result is recorded: pass, fail, timeout, stopped or skipped,
// with start/end times and a small JSON copy of what run() returned.

export const STEP_STATUSES = Object.freeze(['pass', 'fail', 'timeout', 'stopped', 'skipped'])
export const DESTINATIONS = Object.freeze(['local-sink', 'youtube'])
export const ORIENTATIONS = Object.freeze(['horizontal', 'vertical'])
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const MAX_EVIDENCE_CHARS = 2000

export class DeadlineError extends Error {
  constructor(label, deadlineMs) {
    super(`${label} did not happen within ${Math.round(deadlineMs / 1000)} s`)
    this.name = 'DeadlineError'
    this.code = 'DEADLINE'
  }
}

export class StoppedError extends Error {
  constructor(reason) {
    super(`stopped: ${reason}`)
    this.name = 'StoppedError'
    this.code = 'STOPPED'
    this.reason = reason
  }
}

export const systemClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle)
})

// A tiny synchronous event bus. Listeners get (type, payload); the last
// payload of each type is kept so a wait can start after the event fired.
export function createEventBus() {
  const listeners = new Set()
  const lastByType = new Map()
  return {
    emit(type, payload) {
      lastByType.set(type, payload)
      for (const listener of [...listeners]) {
        try {
          listener(type, payload)
        } catch {
          // A broken listener never stops the others.
        }
      }
    },
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    last(type) {
      return lastByType.get(type)
    },
    listenerCount: () => listeners.size
  }
}

function reasonOf(signal) {
  const reason = signal?.reason
  if (reason instanceof StoppedError) return reason.reason
  if (reason instanceof Error) return reason.message
  return typeof reason === 'string' ? reason : 'aborted'
}

/**
 * Builds a waitFor bound to one bus, clock and abort signal.
 * `defaultDeadlineMs` (number or () => number) applies when a call gives none.
 */
export function createWaitFor({ bus, clock = systemClock, signal, defaultDeadlineMs = 30_000 }) {
  return function waitFor(predicate, { deadlineMs, label = 'condition' } = {}) {
    const fallback =
      typeof defaultDeadlineMs === 'function' ? defaultDeadlineMs() : defaultDeadlineMs
    const limit = Number.isFinite(deadlineMs) ? deadlineMs : fallback
    return new Promise((resolveWait, rejectWait) => {
      let done = false
      let timer = null
      let off = null
      const finish = (fn, value) => {
        if (done) return
        done = true
        if (timer !== null) clock.clearTimeout(timer)
        off?.()
        signal?.removeEventListener?.('abort', onAbort)
        fn(value)
      }
      const evaluate = (type, payload) => {
        if (done) return
        let value
        try {
          value = predicate(type, payload)
        } catch (error) {
          finish(rejectWait, error)
          return
        }
        if (value && typeof value.then === 'function') {
          value.then(
            (resolved) => resolved && finish(resolveWait, resolved),
            (error) => finish(rejectWait, error)
          )
          return
        }
        if (value) finish(resolveWait, value)
      }
      const onAbort = () => finish(rejectWait, new StoppedError(reasonOf(signal)))
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      timer = clock.setTimeout(
        () => finish(rejectWait, new DeadlineError(label, limit)),
        Math.max(0, limit)
      )
      off = bus.on(evaluate)
      evaluate(null, null)
    })
  }
}

function assertField(condition, message) {
  if (!condition) throw new Error(`Invalid scenario: ${message}`)
}

/** Validates and freezes a scenario. Throws with the first problem. */
export function defineScenario(scenario) {
  assertField(scenario && typeof scenario === 'object', 'must be an object')
  assertField(ID.test(scenario.name ?? ''), 'name must be lowercase letters, digits and dashes')
  assertField(
    typeof scenario.plannedMinutes === 'function' ||
      (Number.isFinite(scenario.plannedMinutes) && scenario.plannedMinutes > 0),
    'plannedMinutes must be a positive number or a function of params'
  )
  assertField(
    typeof scenario.estimatedQuotaUnits === 'function' ||
      (Number.isInteger(scenario.estimatedQuotaUnits) && scenario.estimatedQuotaUnits >= 0),
    'estimatedQuotaUnits must be a whole number (0 or more) or a function of params'
  )
  assertField(typeof scenario.usesBundledClient === 'boolean', 'usesBundledClient is required')
  const usesLabYoutubeClient = scenario.usesLabYoutubeClient ?? false
  assertField(typeof usesLabYoutubeClient === 'boolean', 'usesLabYoutubeClient must be boolean')
  const destination = scenario.destination ?? 'youtube'
  assertField(
    DESTINATIONS.includes(destination),
    `destination must be one of ${DESTINATIONS.join(', ')}`
  )
  const orientations = scenario.orientations ?? ['horizontal']
  assertField(
    Array.isArray(orientations) &&
      orientations.length > 0 &&
      orientations.every((value) => ORIENTATIONS.includes(value)),
    'orientations must list horizontal and/or vertical'
  )
  if (destination === 'local-sink') {
    assertField(!usesLabYoutubeClient, 'a local-sink scenario never uses the YouTube client')
    assertField(
      typeof scenario.estimatedQuotaUnits === 'function' || scenario.estimatedQuotaUnits === 0,
      'a local-sink scenario spends no quota'
    )
    assertField(!scenario.usesBundledClient, 'a local-sink scenario never uses the bundled client')
  }
  assertField(Array.isArray(scenario.steps) && scenario.steps.length > 0, 'steps must be non-empty')
  const seen = new Set()
  const steps = scenario.steps.map((step, index) => {
    assertField(step && typeof step === 'object', `step ${index} must be an object`)
    assertField(
      ID.test(step.id ?? ''),
      `step ${index} id must be lowercase letters, digits, dashes`
    )
    assertField(!seen.has(step.id), `step id "${step.id}" is used twice`)
    seen.add(step.id)
    assertField(typeof step.run === 'function', `step "${step.id}" needs run(ctx)`)
    assertField(
      Number.isFinite(step.deadlineMs) && step.deadlineMs > 0,
      `step "${step.id}" needs a positive deadlineMs`
    )
    assertField(
      step.expect === undefined ||
        typeof step.expect === 'function' ||
        typeof step.expect === 'string',
      `step "${step.id}" expect must be a function (a check) or a string (what the step expects)`
    )
    const onFail = step.onFail ?? 'abort'
    assertField(
      ['abort', 'continue'].includes(onFail),
      `step "${step.id}" onFail is abort|continue`
    )
    return Object.freeze({ ...step, onFail })
  })
  return Object.freeze({
    ...scenario,
    destination,
    usesLabYoutubeClient,
    orientations: Object.freeze([...orientations]),
    steps: Object.freeze(steps)
  })
}

/**
 * The scenario for one run's params (VIDEORC_LIVE_LAB_SCENARIO_PARAMS):
 * plannedMinutes / estimatedQuotaUnits given as functions of params are
 * resolved to numbers and checked again. Throws on a bad result.
 */
export function resolveScenario(scenario, params = {}) {
  const plannedMinutes =
    typeof scenario.plannedMinutes === 'function'
      ? scenario.plannedMinutes(params)
      : scenario.plannedMinutes
  const estimatedQuotaUnits =
    typeof scenario.estimatedQuotaUnits === 'function'
      ? scenario.estimatedQuotaUnits(params)
      : scenario.estimatedQuotaUnits
  assertField(
    Number.isFinite(plannedMinutes) && plannedMinutes > 0,
    `plannedMinutes resolved to ${plannedMinutes}`
  )
  assertField(
    Number.isInteger(estimatedQuotaUnits) && estimatedQuotaUnits >= 0,
    `estimatedQuotaUnits resolved to ${estimatedQuotaUnits}`
  )
  assertField(
    scenario.destination !== 'local-sink' || estimatedQuotaUnits === 0,
    'a local-sink scenario spends no quota'
  )
  return Object.freeze({ ...scenario, plannedMinutes, estimatedQuotaUnits })
}

/** Parses VIDEORC_LIVE_LAB_SCENARIO_PARAMS: absent is {}, anything but a JSON object throws. */
export function parseScenarioParams(text) {
  if (text === undefined || text === null || String(text).trim() === '') return Object.freeze({})
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('scenario params are not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('scenario params must be a JSON object')
  }
  return Object.freeze(parsed)
}

function evidenceOf(value) {
  if (value === undefined) return undefined
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return undefined
    return text.length <= MAX_EVIDENCE_CHARS ? JSON.parse(text) : { truncated: text.slice(0, 200) }
  } catch {
    return { unserializable: true }
  }
}

function expectationVerdict(step, value, ctx) {
  if (typeof step.expect !== 'function') return null
  let verdict
  try {
    verdict = step.expect(value, ctx)
  } catch (error) {
    return error.message
  }
  if (verdict === true) return null
  if (typeof verdict === 'string' && verdict.trim()) return verdict
  return 'expectation not met'
}

/**
 * Runs the steps in order. `check()` is the kill switch: it runs before every
 * step and its stop ends the run (remaining steps skipped). `signal` aborts
 * the run at any moment (the kill switch's onStop aborts it). Returns
 * { results, stopped: reason | null, failed: boolean }. Never throws for a
 * step failure; teardown is the caller's job, in finally.
 */
export async function runScenarioSteps({
  scenario,
  ctx,
  bus,
  check = async () => ({ stop: false }),
  clock = systemClock,
  signal,
  onStepStart = () => {},
  onStepEnd = () => {}
}) {
  const results = []
  let stopped = null
  let failedAt = null
  const iso = (ms) => new Date(ms).toISOString()

  for (const [index, step] of scenario.steps.entries()) {
    if (stopped || failedAt) {
      results.push({
        id: step.id,
        status: 'skipped',
        reason: stopped ? `run stopped: ${stopped}` : `after failure of ${failedAt}`
      })
      continue
    }
    if (signal?.aborted) {
      stopped = reasonOf(signal)
      results.push({ id: step.id, status: 'skipped', reason: `run stopped: ${stopped}` })
      continue
    }
    let verdict
    try {
      verdict = await check()
    } catch (error) {
      verdict = { stop: true, reason: `kill switch check failed: ${error.message}` }
    }
    if (verdict?.stop) {
      stopped = verdict.reason ?? 'kill switch'
      results.push({ id: step.id, status: 'skipped', reason: `run stopped: ${stopped}` })
      continue
    }

    const startedAt = clock.now()
    const deadlineAt = startedAt + step.deadlineMs
    const stepController = new AbortController()
    const forwardAbort = () => stepController.abort(signal.reason)
    signal?.addEventListener?.('abort', forwardAbort, { once: true })
    const stepCtx = {
      ...ctx,
      signal: stepController.signal,
      waitFor: createWaitFor({
        bus,
        clock,
        signal: stepController.signal,
        defaultDeadlineMs: () => Math.max(0, deadlineAt - clock.now())
      })
    }
    onStepStart({ index, total: scenario.steps.length, step })

    let timer = null
    const deadline = new Promise((_, rejectDeadline) => {
      timer = clock.setTimeout(() => {
        const error = new DeadlineError(`step ${step.id}`, step.deadlineMs)
        stepController.abort(error)
        rejectDeadline(error)
      }, step.deadlineMs)
    })
    const stop = new Promise((_, rejectStop) => {
      const onAbort = () => rejectStop(new StoppedError(reasonOf(stepController.signal)))
      if (stepController.signal.aborted) onAbort()
      else stepController.signal.addEventListener('abort', onAbort, { once: true })
    })
    deadline.catch(() => {})
    stop.catch(() => {})

    let result
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => step.run(stepCtx)),
        deadline,
        stop
      ])
      const problem = value?.skipped === true ? null : expectationVerdict(step, value, stepCtx)
      result =
        value?.skipped === true
          ? {
              id: step.id,
              status: 'skipped',
              reason: String(value.reason ?? 'skipped by the step')
            }
          : problem
            ? { id: step.id, status: 'fail', reason: problem, evidence: evidenceOf(value) }
            : { id: step.id, status: 'pass', evidence: evidenceOf(value) }
    } catch (error) {
      if (signal?.aborted) {
        stopped = reasonOf(signal)
        result = { id: step.id, status: 'stopped', reason: stopped }
      } else if (error instanceof DeadlineError || error?.code === 'DEADLINE') {
        result = { id: step.id, status: 'timeout', reason: error.message }
      } else if (error instanceof StoppedError) {
        result = { id: step.id, status: 'timeout', reason: error.message }
      } else {
        result = { id: step.id, status: 'fail', reason: error?.message ?? String(error) }
      }
    } finally {
      clock.clearTimeout(timer)
      signal?.removeEventListener?.('abort', forwardAbort)
      if (!stepController.signal.aborted) stepController.abort(new StoppedError('step finished'))
    }
    const endedAt = clock.now()
    result = {
      ...result,
      startedAt: iso(startedAt),
      endedAt: iso(endedAt),
      durationMs: endedAt - startedAt
    }
    results.push(result)
    onStepEnd({ index, total: scenario.steps.length, step, result })
    if ((result.status === 'fail' || result.status === 'timeout') && step.onFail === 'abort') {
      failedAt = step.id
    }
  }
  const failed = results.some((entry) => entry.status === 'fail' || entry.status === 'timeout')
  return { results, stopped, failed }
}
