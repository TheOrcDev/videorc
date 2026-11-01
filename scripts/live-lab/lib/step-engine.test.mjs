import assert from 'node:assert/strict'
import test from 'node:test'

import { createFakeClock } from './harness-test-fakes.mjs'
import {
  DeadlineError,
  StoppedError,
  createEventBus,
  createWaitFor,
  defineScenario,
  parseScenarioParams,
  resolveScenario,
  runScenarioSteps
} from './step-engine.mjs'

function scenario(steps, overrides = {}) {
  return defineScenario({
    name: 'unit',
    plannedMinutes: 5,
    estimatedQuotaUnits: 0,
    usesBundledClient: false,
    destination: 'local-sink',
    steps,
    ...overrides
  })
}

test('defineScenario validates the format and freezes it', () => {
  const ok = scenario([{ id: 'one', deadlineMs: 1000, run: () => 1 }])
  assert.equal(ok.usesLabYoutubeClient, false)
  assert.deepEqual(ok.orientations, ['horizontal'])
  assert.equal(ok.steps[0].onFail, 'abort')
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.steps[0]))

  const bad = [
    [{ name: 'Bad Name' }, /name/],
    [{ plannedMinutes: 0 }, /plannedMinutes/],
    [{ estimatedQuotaUnits: -1 }, /estimatedQuotaUnits/],
    [{ usesBundledClient: undefined }, /usesBundledClient/],
    [{ destination: 'twitch' }, /destination/],
    [{ steps: [{ id: 'a', deadlineMs: 5, run() {}, expect: 3 }] }, /expect/],
    [{ orientations: ['diagonal'] }, /orientations/],
    [{ usesLabYoutubeClient: true }, /local-sink scenario never uses the YouTube client/],
    [{ estimatedQuotaUnits: 50 }, /local-sink scenario spends no quota/],
    [{ steps: [] }, /steps must be non-empty/],
    [{ steps: [{ id: 'a', deadlineMs: 0, run() {} }] }, /deadlineMs/],
    [
      {
        steps: [
          { id: 'a', deadlineMs: 5, run() {} },
          { id: 'a', deadlineMs: 5, run() {} }
        ]
      },
      /twice/
    ],
    [{ steps: [{ id: 'a', deadlineMs: 5 }] }, /run\(ctx\)/],
    [{ steps: [{ id: 'a', deadlineMs: 5, run() {}, onFail: 'retry' }] }, /onFail/]
  ]
  for (const [overrides, pattern] of bad) {
    assert.throws(
      () => scenario([{ id: 'one', deadlineMs: 1000, run: () => 1 }], overrides),
      pattern
    )
  }
  // A YouTube scenario may use the lab client and spend quota.
  const live = scenario([{ id: 'one', deadlineMs: 1000, run: () => 1 }], {
    destination: 'youtube',
    usesLabYoutubeClient: true,
    estimatedQuotaUnits: 300
  })
  assert.equal(live.usesLabYoutubeClient, true)
})

test('waitFor resolves on a bus event and rejects at the deadline', async () => {
  const clock = createFakeClock()
  const bus = createEventBus()
  const waitFor = createWaitFor({ bus, clock })
  const live = waitFor(
    (type, payload) => type === 'remote.state' && payload.sessionState === 'streaming' && payload,
    {
      deadlineMs: 10_000,
      label: 'live'
    }
  )
  bus.emit('remote.state', { sessionState: 'starting' })
  bus.emit('remote.state', { sessionState: 'streaming' })
  assert.deepEqual(await live, { sessionState: 'streaming' })
  assert.equal(bus.listenerCount(), 0, 'the listener is removed once resolved')

  const never = waitFor(() => false, { deadlineMs: 5_000, label: 'never' })
  await clock.advance(4_999)
  let settled = false
  never.catch(() => {}).finally(() => (settled = true))
  await clock.flush()
  assert.equal(settled, false)
  await clock.advance(1)
  await assert.rejects(
    never,
    (error) =>
      error instanceof DeadlineError && /never did not happen within 5 s/.test(error.message)
  )
  assert.equal(clock.pending(), 0)
})

test('waitFor evaluates the predicate immediately and rejects on abort', async () => {
  const clock = createFakeClock()
  const bus = createEventBus()
  bus.emit('remote.state', { sessionState: 'idle' })
  const controller = new AbortController()
  const waitFor = createWaitFor({ bus, clock, signal: controller.signal })
  assert.equal(
    await waitFor(() => bus.last('remote.state')?.sessionState === 'idle', { deadlineMs: 1 }),
    true
  )
  const pending = waitFor(() => false, { deadlineMs: 60_000 })
  controller.abort(new StoppedError('STOP file present'))
  await assert.rejects(
    pending,
    (error) => error instanceof StoppedError && error.reason === 'STOP file present'
  )
})

test('steps run in order and record pass, fail and skipped results', async () => {
  const clock = createFakeClock()
  const bus = createEventBus()
  const order = []
  const run = await runScenarioSteps({
    scenario: scenario([
      { id: 'one', deadlineMs: 1000, run: () => (order.push('one'), { ok: 1 }) },
      {
        id: 'two',
        deadlineMs: 1000,
        run: () => (order.push('two'), 3),
        expect: (value) => value === 4 || `got ${value}`
      },
      { id: 'three', deadlineMs: 1000, run: () => order.push('three') }
    ]),
    ctx: {},
    bus,
    clock
  })
  assert.deepEqual(order, ['one', 'two'])
  assert.deepEqual(
    run.results.map(({ id, status, reason }) => ({ id, status, reason })),
    [
      { id: 'one', status: 'pass', reason: undefined },
      { id: 'two', status: 'fail', reason: 'got 3' },
      { id: 'three', status: 'skipped', reason: 'after failure of two' }
    ]
  )
  assert.deepEqual(run.results[0].evidence, { ok: 1 })
  assert.equal(run.failed, true)
  assert.equal(run.stopped, null)
})

test('onFail continue keeps going; a thrown error is a fail', async () => {
  const run = await runScenarioSteps({
    scenario: scenario([
      {
        id: 'one',
        deadlineMs: 1000,
        onFail: 'continue',
        run: () => {
          throw new Error('boom')
        }
      },
      { id: 'two', deadlineMs: 1000, run: () => 'fine' }
    ]),
    ctx: {},
    bus: createEventBus(),
    clock: createFakeClock()
  })
  assert.deepEqual(
    run.results.map((entry) => entry.status),
    ['fail', 'pass']
  )
  assert.equal(run.results[0].reason, 'boom')
})

test('a step that never finishes times out at its deadline and its waits are cancelled', async () => {
  const clock = createFakeClock()
  const bus = createEventBus()
  let waitError = null
  const promise = runScenarioSteps({
    scenario: scenario([
      {
        id: 'hang',
        deadlineMs: 30_000,
        run: (ctx) =>
          ctx
            .waitFor(() => false, { deadlineMs: 120_000, label: 'never' })
            .catch((error) => {
              waitError = error
              throw error
            })
      },
      { id: 'after', deadlineMs: 1000, run: () => 1 }
    ]),
    ctx: {},
    bus,
    clock
  })
  await clock.advance(30_000)
  const run = await promise
  assert.equal(run.results[0].status, 'timeout')
  assert.match(run.results[0].reason, /step hang did not happen within 30 s/)
  assert.equal(run.results[0].durationMs, 30_000)
  assert.equal(run.results[1].status, 'skipped')
  assert.ok(waitError instanceof StoppedError, 'the wait inside the step was aborted')
  assert.equal(bus.listenerCount(), 0)
})

test('the default wait deadline is what is left of the step deadline', async () => {
  const clock = createFakeClock()
  const bus = createEventBus()
  const promise = runScenarioSteps({
    scenario: scenario([
      { id: 'w', deadlineMs: 10_000, run: (ctx) => ctx.waitFor(() => false, { label: 'idle' }) }
    ]),
    ctx: {},
    bus,
    clock
  })
  await clock.advance(10_000)
  const run = await promise
  assert.equal(run.results[0].status, 'timeout')
})

test('the kill switch is checked before every step and a stop skips the rest', async () => {
  const clock = createFakeClock()
  let checks = 0
  const run = await runScenarioSteps({
    scenario: scenario([
      { id: 'one', deadlineMs: 1000, run: () => 1 },
      { id: 'two', deadlineMs: 1000, run: () => 2 },
      { id: 'three', deadlineMs: 1000, run: () => 3 }
    ]),
    ctx: {},
    bus: createEventBus(),
    clock,
    check: async () =>
      ++checks === 2 ? { stop: true, reason: 'control.json says enabled: false' } : { stop: false }
  })
  assert.equal(checks, 2)
  assert.deepEqual(
    run.results.map((entry) => entry.status),
    ['pass', 'skipped', 'skipped']
  )
  assert.equal(run.stopped, 'control.json says enabled: false')
  assert.equal(run.failed, false)
})

test('an abort mid-step stops the step at once', async () => {
  const clock = createFakeClock()
  const controller = new AbortController()
  const promise = runScenarioSteps({
    scenario: scenario([
      {
        id: 'live',
        deadlineMs: 600_000,
        run: (ctx) => ctx.waitFor(() => false, { deadlineMs: 600_000 })
      },
      { id: 'next', deadlineMs: 1000, run: () => 1 }
    ]),
    ctx: {},
    bus: createEventBus(),
    clock,
    signal: controller.signal
  })
  await clock.advance(1000)
  controller.abort(new StoppedError('STOP file present'))
  const run = await promise
  assert.deepEqual(
    run.results.map((entry) => entry.status),
    ['stopped', 'skipped']
  )
  assert.equal(run.stopped, 'STOP file present')
  assert.equal(run.results[0].durationMs, 1000)
})

test('destination defaults to youtube; a string expect is a description only', async () => {
  const defined = defineScenario({
    name: 'faults-like',
    plannedMinutes: 10,
    estimatedQuotaUnits: 40,
    usesBundledClient: false,
    steps: [
      {
        id: 'one',
        deadlineMs: 1000,
        expect: 'reconnecting then resumed',
        run: () => ({ ok: true })
      }
    ]
  })
  assert.equal(defined.destination, 'youtube')
  const run = await runScenarioSteps({
    scenario: defined,
    ctx: {},
    bus: createEventBus(),
    clock: createFakeClock()
  })
  assert.equal(run.results[0].status, 'pass')
})

test('a step returning { skipped: true, reason } is recorded as skipped and the run goes on', async () => {
  const run = await runScenarioSteps({
    scenario: scenario([
      {
        id: 'gated',
        deadlineMs: 1000,
        expect: () => 'never checked',
        run: () => ({ skipped: true, reason: 'policy faults.network is false' })
      },
      { id: 'next', deadlineMs: 1000, run: () => 1 }
    ]),
    ctx: {},
    bus: createEventBus(),
    clock: createFakeClock()
  })
  assert.deepEqual(
    run.results.map(({ status, reason }) => ({ status, reason })),
    [
      { status: 'skipped', reason: 'policy faults.network is false' },
      { status: 'pass', reason: undefined }
    ]
  )
  assert.equal(run.failed, false)
})

test('resolveScenario sizes plannedMinutes from params; parseScenarioParams is strict', () => {
  const defined = scenario([{ id: 'one', deadlineMs: 1000, run: () => 1 }], {
    destination: 'youtube',
    plannedMinutes: (params) => (params.marathonHours ?? 1) * 60
  })
  assert.equal(resolveScenario(defined, { marathonHours: 4 }).plannedMinutes, 240)
  assert.throws(
    () => resolveScenario(defined, { marathonHours: 0 }),
    /plannedMinutes resolved to 0/
  )
  assert.deepEqual(parseScenarioParams(undefined), {})
  assert.deepEqual(parseScenarioParams('{"marathonHours":4}'), { marathonHours: 4 })
  assert.throws(() => parseScenarioParams('{bad'), /not valid JSON/)
  assert.throws(() => parseScenarioParams('[]'), /JSON object/)
})
