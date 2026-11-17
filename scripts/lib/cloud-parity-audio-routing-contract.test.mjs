import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveSystemClock,
  audioRoutingConfig,
  assertAudioRoutes,
  routingTable,
  assertSystemReleased
} from './cloud-parity-audio-routing-contract.mjs'
const measured = (routes) =>
  Object.entries(routes).map(([name, stems]) => ({
    name,
    settledTones: Object.fromEntries(
      Object.entries(stems).map(([stem, yes]) => [stem, yes ? -22 : -100])
    )
  }))
test('Bounded acquisition duration and repetitions reject runaway inputs', () => {
  assert.equal(audioRoutingConfig({}).cycles, 3)
  for (const env of [
    { VIDEORC_PARITY_AUDIO_SECONDS: 0 },
    { VIDEORC_PARITY_AUDIO_CYCLES: 100 },
    { VIDEORC_PARITY_AUDIO_DEADLINE_MS: 'NaN' }
  ])
    assert.throws(() => audioRoutingConfig(env))
})
test('Routing table separates conversation from program and rejects self screen return', () => {
  const routes = routingTable({ takeover: true, screenOwner: 'guest1' })
  assert.equal(routes.program.host, false)
  assert.equal(routes.guest2.host, true)
  assert.equal(routes.guest1.screen, false)
  assert.equal(routes.guest2.screen, true)
  assert.equal(routes.program.soundboard, true)
  assertAudioRoutes(measured(routes), routes)
  const leak = measured(routes)
  leak[1].settledTones.screen = -20
  assert.throws(() => assertAudioRoutes(leak, routes), /unintended return/)
})
test('Missing waveform, duplicate-copy gain and fabricated cleanup cannot pass', () => {
  const routes = routingTable(),
    reference = measured(routes)
  const gainRoutes = routingTable()
  gainRoutes.program.system = 0
  const duplicate = measured(routes)
  duplicate[0].settledTones.system = -16
  assert.throws(() => assertAudioRoutes(duplicate, gainRoutes, reference), /gain\/copy/)
  assert.throws(() => assertAudioRoutes([], routes), /Every intended/)
  assert.throws(() => assertSystemReleased({}, { resources: [] }), /not released/)
  assert.throws(
    () =>
      assertSystemReleased(
        { nativeSources: 1, sockets: 0, ipcRequests: 0, timers: 0 },
        { resources: [] }
      ),
    /not released/
  )
})
test('Owned player teardown is bounded, escalates only its handle and refuses missing reap', async () => {
  const { stopOwnedRoutingPlayer } = await import('./cloud-parity-audio-routing-contract.mjs')
  const signals = []
  const child = { exitCode: null, signalCode: null, kill: (signal) => signals.push(signal) }
  let attempts = 0
  await stopOwnedRoutingPlayer(child, Promise.resolve(), async () => ++attempts === 2)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  await assert.rejects(
    stopOwnedRoutingPlayer(child, Promise.resolve(), async () => false),
    /cleanup unconfirmed/
  )
  signals.length = 0
  await stopOwnedRoutingPlayer({ ...child, exitCode: 0 }, Promise.resolve())
  assert.deepEqual(signals, [])
})

test('System clock: one incarnation, fixed origin per generation, null never zero', () => {
  const frame = (generation, sequence, originUs, extra = {}) => ({
    phase: 'native-frame',
    generation,
    sequence,
    firstSampleUs: sequence * 10000,
    observedAtUs: sequence * 10000 + 5000,
    originUs,
    incarnation: originUs === null ? null : 7,
    timeline: 'capture',
    ...extra
  })
  const raw = (...events) => ({ observations: { events, lost: 0 } })
  const snapshot = raw(frame(1, 0, 1000), frame(1, 1, 1000), frame(2, 0, 9000))
  // The same frame seen in two raw snapshots is counted once.
  const clock = deriveSystemClock([snapshot, snapshot])
  assert.equal(clock.commonClockOrigin, 'available')
  assert.equal(clock.incarnation, 7)
  assert.deepEqual(
    clock.generations.map((g) => [g.generation, g.frames, g.firstNativeCaptureUs]),
    [
      [1, 2, 1000],
      [2, 1, 9000]
    ]
  )
  assert.equal(clock.clockQualification, 'unavailable')
  assert.equal(deriveSystemClock([raw(frame(1, 0, null))]).commonClockOrigin, 'unavailable')
  for (const bad of [
    [frame(1, 0, 1000), frame(1, 1, 2000)],
    [frame(1, 0, 1000), frame(2, 0, 3000, { incarnation: 8 })],
    [frame(1, 0, 9000), frame(2, 0, 1000)],
    [frame(1, 0, 0, { incarnation: 7 })],
    [frame(1, 0, 1000, { incarnation: null })],
    [frame(1, 0, 1000, { timeline: 'processed' })],
    [frame(1, 0, Number.MAX_SAFE_INTEGER)]
  ])
    assert.throws(() => deriveSystemClock([raw(...bad)]))
})
