import { applyNetFault as defaultApplyNetFault, removeNetFaults } from './net-fault.mjs'
import { ownedFfmpegPids, pauseOwnedProcess as defaultPauseOwnedProcess } from './proc-fault.mjs'

// Plan 178 U13 (plan 166 S9): the `faults` scenario's steps and the pure
// expectation checks behind them. The scenario file
// (scripts/live-lab/scenarios/faults.mjs) is one line over buildFaultsScenario
// with the U6 step engine's defineScenario; tests inject a stub.
//
// Health event codes are the backend's own (crates/videorc-backend/src/
// recording.rs and encoder_bridge.rs); the observer incident is plan 178 U8's.

export const NETWORK_LOSS_MS = 30_000
export const NETWORK_THROTTLE_MS = 30_000
export const PAUSE_SHORT_MS = 500
export const PAUSE_LONG_MS = 6_000
// encoder_bridge.rs STREAM_OUTPUT_STALL_NOTICE_THRESHOLD: a stall shorter
// than this is never reported; longer must be.
export const STALL_NOTICE_MS = 2_000
// How long after a fault ends the stream has to be back before the step fails.
export const RECOVERY_DEADLINE_MS = 90_000

export const EVENT = Object.freeze({
  reconnecting: 'stream-target-reconnecting',
  resumed: 'stream-target-resumed',
  reconnected: 'stream-target-reconnected',
  notReceiving: 'stream-target-not-receiving',
  stalled: 'stream-output-stalled',
  outputResumed: 'stream-output-resumed',
  targetFailed: 'stream-target-failed',
  outputFailed: 'stream-output-failed'
})
export const FAILURE_EVENTS = Object.freeze([EVENT.targetFailed, EVENT.outputFailed])
export const NO_DATA_INCIDENT = 'stream:noData-while-live'

function since(events, startedAt) {
  return (events ?? [])
    .filter((event) => Number.isFinite(event?.at) && event.at >= startedAt)
    .sort((a, b) => a.at - b.at)
}

function firstAfter(events, code, afterMs) {
  return events.find((event) => event.code === code && event.at > afterMs) ?? null
}

// Pure. `events` are { code, at } health events (at = epoch ms); only those
// at or after `startedAt` count. Loss: the leg must say reconnecting, then
// resumed (or the unattributed reconnected), in that order. Throttle: the
// backend may report it as a reconnect or as an output stall; either pair in
// order passes. Both: no failure code, ever.
export function evaluateNetworkFaultEvents(events, { kind, startedAt }) {
  const seen = since(events, startedAt)
  const unexpected = seen.filter((event) => FAILURE_EVENTS.includes(event.code)).map((e) => e.code)
  const missing = []
  const reconnecting = seen.find((event) => event.code === EVENT.reconnecting) ?? null
  const resumed = reconnecting
    ? (firstAfter(seen, EVENT.resumed, reconnecting.at) ??
      firstAfter(seen, EVENT.reconnected, reconnecting.at))
    : null
  const stalled = seen.find((event) => event.code === EVENT.stalled) ?? null
  const outputResumed = stalled ? firstAfter(seen, EVENT.outputResumed, stalled.at) : null
  if (kind === 'loss') {
    if (!reconnecting) missing.push(EVENT.reconnecting)
    else if (!resumed) missing.push(`${EVENT.resumed} after ${EVENT.reconnecting}`)
  } else {
    const reconnectPair = Boolean(reconnecting && resumed)
    const stallPair = Boolean(stalled && outputResumed)
    if (!reconnectPair && !stallPair) {
      if (!reconnecting && !stalled) {
        missing.push(`${EVENT.reconnecting} or ${EVENT.stalled}`)
      } else if (reconnecting && !resumed) {
        missing.push(`${EVENT.resumed} after ${EVENT.reconnecting}`)
      } else if (stalled && !outputResumed) {
        missing.push(`${EVENT.outputResumed} after ${EVENT.stalled}`)
      }
    }
  }
  return {
    ok: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
    sequence: seen.map((event) => event.code)
  }
}

// Pure. A pause under the stall notice must leave no stall report; one over
// it must produce stalled then resumed. Never a failure code.
export function evaluatePauseEvents(events, { ms, startedAt }) {
  const seen = since(events, startedAt)
  const unexpected = seen.filter((event) => FAILURE_EVENTS.includes(event.code)).map((e) => e.code)
  const missing = []
  const stalled = seen.find((event) => event.code === EVENT.stalled) ?? null
  if (ms < STALL_NOTICE_MS) {
    if (stalled) unexpected.push(EVENT.stalled)
  } else if (!stalled) {
    missing.push(EVENT.stalled)
  } else if (!firstAfter(seen, EVENT.outputResumed, stalled.at)) {
    missing.push(`${EVENT.outputResumed} after ${EVENT.stalled}`)
  }
  return {
    ok: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
    sequence: seen.map((event) => event.code)
  }
}

// Pure. Observer incidents ({ type, at }) in the fault window: a P0
// stream:noData-while-live means the app said On air over a dead leg.
export function evaluateObserverIncidents(incidents, { startedAt, endedAt }) {
  const noData = (incidents ?? []).filter(
    (incident) =>
      incident?.type === NO_DATA_INCIDENT &&
      Number.isFinite(Date.parse(incident.at ?? '')) &&
      Date.parse(incident.at) >= startedAt &&
      Date.parse(incident.at) <= endedAt
  )
  return { ok: noData.length === 0, noData }
}

function stepFailure(id, verdict) {
  const error = new Error(
    `${id}: expected events missing [${verdict.missing.join(', ')}], unexpected [${verdict.unexpected.join(', ')}]; saw [${verdict.sequence.join(' > ')}]`
  )
  error.code = 'FAULT_EXPECTATION'
  error.verdict = verdict
  return error
}

function skipped(ctx, id, reason) {
  ctx.log(`${id}: skipped (${reason})`)
  return { skipped: true, reason }
}

// What the steps need from the U6 run context, each overridable:
//   policy(ctx)        the loaded policy (ctx.policy)
//   healthEvents(ctx)  [{ code, at }] from the app's health event feed
//   incidents(ctx)     the observer's incidents so far (ctx.observe.incidents())
//   ledger(ctx)        { ledgerPaths } for process-census (ctx.ledger)
function defaultDeps() {
  return {
    policy: (ctx) => ctx.policy ?? null,
    healthEvents: (ctx) => {
      if (typeof ctx.healthEvents !== 'function') {
        throw new Error('faults: the run context has no healthEvents() (U6 must provide it)')
      }
      return ctx.healthEvents()
    },
    incidents: (ctx) =>
      typeof ctx.observe?.incidents === 'function' ? ctx.observe.incidents() : [],
    ledger: (ctx) => ctx.ledger ?? null,
    applyNetFault: defaultApplyNetFault,
    removeNetFaults,
    pauseOwnedProcess: defaultPauseOwnedProcess,
    ownedFfmpegPids,
    now: Date.now
  }
}

export function buildFaultsScenario({ defineScenario, ...overrides }) {
  if (typeof defineScenario !== 'function') {
    throw new Error('buildFaultsScenario needs the step engine defineScenario')
  }
  const deps = { ...defaultDeps(), ...overrides }

  async function networkStep(ctx, id, { kind, durationMs }) {
    const policy = deps.policy(ctx)
    if (!policy) return skipped(ctx, id, 'policy unavailable')
    if (policy.faults?.network !== true) return skipped(ctx, id, 'policy faults.network is false')
    const startedAt = deps.now()
    let handle = null
    try {
      handle = await deps.applyNetFault({ kind, durationMs, log: ctx.log })
      await ctx.waitFor(() => deps.now() >= handle.deadlineAt, {
        deadlineMs: durationMs + 10_000,
        label: `${id}: fault window`
      })
    } finally {
      await deps.removeNetFaults({ log: ctx.log })
    }
    const endedAt = deps.now()
    await ctx.waitFor(
      () => evaluateNetworkFaultEvents(deps.healthEvents(ctx), { kind, startedAt }).ok,
      { deadlineMs: RECOVERY_DEADLINE_MS, label: `${id}: stream back` }
    )
    const verdict = evaluateNetworkFaultEvents(deps.healthEvents(ctx), { kind, startedAt })
    if (!verdict.ok) throw stepFailure(id, verdict)
    const observer = evaluateObserverIncidents(deps.incidents(ctx), { startedAt, endedAt })
    if (!observer.ok) {
      const error = new Error(`${id}: ${NO_DATA_INCIDENT} raised during the fault (P0)`)
      error.code = 'FAULT_EXPECTATION'
      error.incidents = observer.noData
      throw error
    }
    return { kind, durationMs, startedAt, endedAt, watchdogPid: handle?.watchdogPid, verdict }
  }

  async function pauseStep(ctx, id, ms) {
    const policy = deps.policy(ctx)
    if (!policy) return skipped(ctx, id, 'policy unavailable')
    if (policy.faults?.process !== true) return skipped(ctx, id, 'policy faults.process is false')
    const ledger = deps.ledger(ctx)
    if (!ledger) return skipped(ctx, id, 'no owned-process ledger in the run context')
    const pids = await deps.ownedFfmpegPids(ledger)
    if (pids.length === 0) throw new Error(`${id}: no owned ffmpeg process to pause`)
    const startedAt = deps.now()
    const paused = await deps.pauseOwnedProcess({ pid: pids[0], ms, ledger, log: ctx.log })
    await ctx
      .waitFor(() => evaluatePauseEvents(deps.healthEvents(ctx), { ms, startedAt }).ok, {
        deadlineMs: ms < STALL_NOTICE_MS ? 5_000 : RECOVERY_DEADLINE_MS,
        label: `${id}: ${ms < STALL_NOTICE_MS ? 'stays silent' : 'stall reported and over'}`
      })
      .catch(() => {})
    const verdict = evaluatePauseEvents(deps.healthEvents(ctx), { ms, startedAt })
    if (!verdict.ok) throw stepFailure(id, verdict)
    return { ...paused, verdict }
  }

  return defineScenario({
    name: 'faults',
    plannedMinutes: 10,
    estimatedQuotaUnits: 40,
    usesBundledClient: false,
    steps: [
      {
        id: 'network-loss-30s',
        deadlineMs: NETWORK_LOSS_MS + RECOVERY_DEADLINE_MS + 30_000,
        expect: `${EVENT.reconnecting} then ${EVENT.resumed}; no ${NO_DATA_INCIDENT}; no failure code`,
        run: (ctx) =>
          networkStep(ctx, 'network-loss-30s', { kind: 'loss', durationMs: NETWORK_LOSS_MS })
      },
      {
        id: 'network-throttle-1mbps-30s',
        deadlineMs: NETWORK_THROTTLE_MS + RECOVERY_DEADLINE_MS + 30_000,
        expect: `${EVENT.reconnecting}/${EVENT.resumed} or ${EVENT.stalled}/${EVENT.outputResumed}; no ${NO_DATA_INCIDENT}; no failure code`,
        run: (ctx) =>
          networkStep(ctx, 'network-throttle-1mbps-30s', {
            kind: 'throttle',
            durationMs: NETWORK_THROTTLE_MS
          })
      },
      {
        id: 'ffmpeg-pause-500ms',
        deadlineMs: 30_000,
        expect: `no ${EVENT.stalled} (under the ${STALL_NOTICE_MS} ms notice); no failure code`,
        run: (ctx) => pauseStep(ctx, 'ffmpeg-pause-500ms', PAUSE_SHORT_MS)
      },
      {
        id: 'ffmpeg-pause-6s',
        deadlineMs: RECOVERY_DEADLINE_MS + 30_000,
        expect: `${EVENT.stalled} then ${EVENT.outputResumed} (plans 087/161); no failure code`,
        run: (ctx) => pauseStep(ctx, 'ffmpeg-pause-6s', PAUSE_LONG_MS)
      }
    ]
  })
}
