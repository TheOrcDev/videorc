import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EVENT,
  NETWORK_LOSS_MS,
  NETWORK_THROTTLE_MS,
  NO_DATA_INCIDENT,
  PAUSE_LONG_MS,
  PAUSE_SHORT_MS,
  buildFaultsScenario,
  evaluateNetworkFaultEvents,
  evaluateObserverIncidents,
  evaluatePauseEvents
} from './faults-scenario.mjs'

// The U6 step engine's defineScenario, stubbed: it only has to hand the
// definition back so the steps can be driven here.
const defineScenario = (definition) => ({ ...definition, defined: true })

const T0 = 1_700_000_000_000
const ev = (code, offsetMs) => ({ code, at: T0 + offsetMs })

test('network loss: reconnecting then resumed passes; order and failures matter', () => {
  const ok = evaluateNetworkFaultEvents(
    [ev('other', -5_000), ev(EVENT.reconnecting, 3_000), ev(EVENT.resumed, 34_000)],
    { kind: 'loss', startedAt: T0 }
  )
  assert.deepEqual(ok, {
    ok: true,
    missing: [],
    unexpected: [],
    sequence: [EVENT.reconnecting, EVENT.resumed]
  })
  // A resumed from before the fault does not count for this fault.
  const stale = evaluateNetworkFaultEvents(
    [ev(EVENT.resumed, -1_000), ev(EVENT.reconnecting, 3_000)],
    { kind: 'loss', startedAt: T0 }
  )
  assert.deepEqual(stale.missing, [`${EVENT.resumed} after ${EVENT.reconnecting}`])
  assert.deepEqual(
    evaluateNetworkFaultEvents([ev(EVENT.resumed, 1)], { kind: 'loss', startedAt: T0 }).missing,
    [EVENT.reconnecting]
  )
  const failed = evaluateNetworkFaultEvents(
    [ev(EVENT.reconnecting, 1), ev(EVENT.targetFailed, 2), ev(EVENT.resumed, 3)],
    { kind: 'loss', startedAt: T0 }
  )
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.unexpected, [EVENT.targetFailed])
  // The unattributed reconnect notice also closes the pair.
  assert.equal(
    evaluateNetworkFaultEvents([ev(EVENT.reconnecting, 1), ev(EVENT.reconnected, 2)], {
      kind: 'loss',
      startedAt: T0
    }).ok,
    true
  )
})

test('network throttle: a reconnect pair or an output stall pair passes', () => {
  assert.equal(
    evaluateNetworkFaultEvents([ev(EVENT.stalled, 2_500), ev(EVENT.outputResumed, 31_000)], {
      kind: 'throttle',
      startedAt: T0
    }).ok,
    true
  )
  assert.equal(
    evaluateNetworkFaultEvents([ev(EVENT.reconnecting, 2_500), ev(EVENT.resumed, 31_000)], {
      kind: 'throttle',
      startedAt: T0
    }).ok,
    true
  )
  assert.deepEqual(evaluateNetworkFaultEvents([], { kind: 'throttle', startedAt: T0 }).missing, [
    `${EVENT.reconnecting} or ${EVENT.stalled}`
  ])
  assert.deepEqual(
    evaluateNetworkFaultEvents([ev(EVENT.stalled, 1)], { kind: 'throttle', startedAt: T0 }).missing,
    [`${EVENT.outputResumed} after ${EVENT.stalled}`]
  )
  assert.deepEqual(
    evaluateNetworkFaultEvents([ev(EVENT.outputFailed, 1)], { kind: 'throttle', startedAt: T0 })
      .unexpected,
    [EVENT.outputFailed]
  )
})

test('pause: 0.5 s must stay silent, 6 s must report stalled then resumed', () => {
  assert.equal(evaluatePauseEvents([], { ms: PAUSE_SHORT_MS, startedAt: T0 }).ok, true)
  const noisy = evaluatePauseEvents([ev(EVENT.stalled, 100)], { ms: PAUSE_SHORT_MS, startedAt: T0 })
  assert.deepEqual(noisy.unexpected, [EVENT.stalled])
  assert.equal(
    evaluatePauseEvents([ev(EVENT.stalled, 2_100), ev(EVENT.outputResumed, 6_200)], {
      ms: PAUSE_LONG_MS,
      startedAt: T0
    }).ok,
    true
  )
  assert.deepEqual(evaluatePauseEvents([], { ms: PAUSE_LONG_MS, startedAt: T0 }).missing, [
    EVENT.stalled
  ])
  assert.deepEqual(
    evaluatePauseEvents([ev(EVENT.stalled, 2_100)], { ms: PAUSE_LONG_MS, startedAt: T0 }).missing,
    [`${EVENT.outputResumed} after ${EVENT.stalled}`]
  )
  assert.deepEqual(
    evaluatePauseEvents([ev(EVENT.stalled, 1), ev(EVENT.outputFailed, 2)], {
      ms: PAUSE_LONG_MS,
      startedAt: T0
    }).unexpected,
    [EVENT.outputFailed]
  )
})

test('observer: a noData incident inside the fault window is a P0', () => {
  const inside = { type: NO_DATA_INCIDENT, at: new Date(T0 + 10_000).toISOString() }
  const before = { type: NO_DATA_INCIDENT, at: new Date(T0 - 10_000).toISOString() }
  const other = { type: 'youtube-health:bad', at: new Date(T0 + 10_000).toISOString() }
  assert.deepEqual(
    evaluateObserverIncidents([before, other], { startedAt: T0, endedAt: T0 + 60_000 }),
    { ok: true, noData: [] }
  )
  assert.deepEqual(evaluateObserverIncidents([inside], { startedAt: T0, endedAt: T0 + 60_000 }), {
    ok: false,
    noData: [inside]
  })
})

function harness({ policy, events = [], incidents = [], pids = [300] }) {
  const calls = { apply: [], remove: 0, pause: [], waits: [] }
  let clock = T0
  const ctx = {
    policy,
    ledger: { ledgerPaths: ['/x/global.json'] },
    log: () => {},
    healthEvents: () => events,
    observe: { incidents: () => incidents },
    waitFor: async (predicate, { deadlineMs, label }) => {
      calls.waits.push(label)
      clock += deadlineMs
      if (!predicate()) throw new Error(`waitFor ${label} timed out`)
    }
  }
  const scenario = buildFaultsScenario({
    defineScenario,
    now: () => clock,
    applyNetFault: async (request) => {
      calls.apply.push(request.kind)
      if (request.kind === 'throttle' && policy.explode) throw new Error('pf exploded')
      return { kind: request.kind, deadlineAt: clock + request.durationMs, watchdogPid: 4242 }
    },
    removeNetFaults: async () => {
      calls.remove += 1
    },
    ownedFfmpegPids: async () => pids,
    pauseOwnedProcess: async ({ pid, ms, ledger }) => {
      calls.pause.push({ pid, ms, ledger })
      return { pid, ms, continued: true }
    }
  })
  const step = (id) => scenario.steps.find((entry) => entry.id === id)
  return { scenario, ctx, calls, step }
}

const POLICY_ON = { faults: { network: true, process: true } }

test('scenario shape: four steps, in the plan 166 S9 order, with expectations', () => {
  const { scenario } = harness({ policy: POLICY_ON })
  assert.equal(scenario.defined, true)
  assert.equal(scenario.name, 'faults')
  assert.equal(scenario.usesBundledClient, false)
  assert.deepEqual(
    scenario.steps.map((step) => step.id),
    ['network-loss-30s', 'network-throttle-1mbps-30s', 'ffmpeg-pause-500ms', 'ffmpeg-pause-6s']
  )
  for (const step of scenario.steps) {
    assert.equal(typeof step.run, 'function')
    assert.ok(step.deadlineMs > 0)
    assert.match(step.expect, /no failure code/)
  }
  assert.ok(scenario.steps[0].deadlineMs > NETWORK_LOSS_MS)
  assert.ok(scenario.steps[1].deadlineMs > NETWORK_THROTTLE_MS)
})

test('policy off: each step skips with a recorded reason and touches nothing', async () => {
  const { ctx, calls, step } = harness({ policy: { faults: { network: false, process: false } } })
  assert.deepEqual(await step('network-loss-30s').run(ctx), {
    skipped: true,
    reason: 'policy faults.network is false'
  })
  assert.deepEqual(await step('ffmpeg-pause-6s').run(ctx), {
    skipped: true,
    reason: 'policy faults.process is false'
  })
  assert.deepEqual(calls, { apply: [], remove: 0, pause: [], waits: [] })
  const none = harness({ policy: null })
  assert.deepEqual(await none.step('network-loss-30s').run(none.ctx), {
    skipped: true,
    reason: 'policy unavailable'
  })
})

test('network loss step: fault, remove in finally, then the event sequence', async () => {
  const events = [ev(EVENT.reconnecting, 2_000), ev(EVENT.resumed, 33_000)]
  const { ctx, calls, step } = harness({ policy: POLICY_ON, events })
  const result = await step('network-loss-30s').run(ctx)
  assert.deepEqual(calls.apply, ['loss'])
  assert.equal(calls.remove, 1)
  assert.equal(result.kind, 'loss')
  assert.equal(result.watchdogPid, 4242)
  assert.deepEqual(result.verdict.sequence, [EVENT.reconnecting, EVENT.resumed])
  assert.deepEqual(calls.waits, ['network-loss-30s: fault window', 'network-loss-30s: stream back'])
})

test('network step: removeNetFaults runs even when applyNetFault throws', async () => {
  const { ctx, calls, step } = harness({ policy: { ...POLICY_ON, explode: true } })
  await assert.rejects(step('network-throttle-1mbps-30s').run(ctx), /pf exploded/)
  assert.equal(calls.remove, 1)
})

test('network step fails on a missing event or a noData incident', async () => {
  const silent = harness({ policy: POLICY_ON, events: [] })
  await assert.rejects(
    silent.step('network-loss-30s').run(silent.ctx),
    /waitFor network-loss-30s: stream back timed out/
  )
  assert.equal(silent.calls.remove, 1)

  const noData = harness({
    policy: POLICY_ON,
    events: [ev(EVENT.reconnecting, 2_000), ev(EVENT.resumed, 33_000)],
    incidents: [{ type: NO_DATA_INCIDENT, at: new Date(T0 + 20_000).toISOString() }]
  })
  await assert.rejects(
    noData.step('network-loss-30s').run(noData.ctx),
    (error) => error.code === 'FAULT_EXPECTATION' && /P0/.test(error.message)
  )
})

test('pause steps: pick the first owned ffmpeg, pass the ledger, judge the events', async () => {
  const quiet = harness({ policy: POLICY_ON, events: [], pids: [300, 301] })
  const short = await quiet.step('ffmpeg-pause-500ms').run(quiet.ctx)
  assert.deepEqual(quiet.calls.pause, [{ pid: 300, ms: PAUSE_SHORT_MS, ledger: quiet.ctx.ledger }])
  assert.equal(short.verdict.ok, true)

  const loud = harness({
    policy: POLICY_ON,
    events: [ev(EVENT.stalled, 2_100), ev(EVENT.outputResumed, 6_300)]
  })
  const long = await loud.step('ffmpeg-pause-6s').run(loud.ctx)
  assert.equal(long.ms, PAUSE_LONG_MS)
  assert.deepEqual(long.verdict.sequence, [EVENT.stalled, EVENT.outputResumed])

  const unreported = harness({ policy: POLICY_ON, events: [] })
  await assert.rejects(
    unreported.step('ffmpeg-pause-6s').run(unreported.ctx),
    (error) => error.code === 'FAULT_EXPECTATION' && error.verdict.missing[0] === EVENT.stalled
  )
  const noFfmpeg = harness({ policy: POLICY_ON, pids: [] })
  await assert.rejects(noFfmpeg.step('ffmpeg-pause-500ms').run(noFfmpeg.ctx), /no owned ffmpeg/)
  const noLedger = harness({ policy: POLICY_ON })
  noLedger.ctx.ledger = null
  assert.deepEqual(await noLedger.step('ffmpeg-pause-500ms').run(noLedger.ctx), {
    skipped: true,
    reason: 'no owned-process ledger in the run context'
  })
})
