/** Plan 249 S26 `health` acceptance phase. Heavy: never import it from a unit
 * test. It runs inside the real-page baseline (`runBaseline({ health: true })`)
 * once the room is open and its program pages report. The fake web puts the
 * room on air with one fixture leg (no provider, key or broadcast), then each
 * scenario of `cloud-parity-health-contract.mjs` is injected into the state
 * the real desktop backend polls: mic loss, stale beacons, dropped layers,
 * black and frozen frames, silent output and a reconnect. For each, the
 * watchdog alert must name the right layer, no Unknown may read as silence or
 * black, the alert must recover once the fault is gone, and nothing the
 * health surfaces said may carry a credential or a frame. Fake web and local
 * fixtures only: no provider, credential, broadcast or paid call.
 */
import assert from 'node:assert/strict'
import { holdFor, waitFor } from './cloud-managed-smoke.mjs'
import {
  HEALTH_FAKE_LEG,
  HEALTH_SCENARIOS,
  NEVER_ON_AN_UNMEASURED_ROOM,
  alertFor,
  assertNoLeaks,
  falseAlarms,
  healthyState
} from './cloud-parity-health-contract.mjs'

export {
  HEALTH_DESKTOP_TESTS,
  HEALTH_RUST_FILTERS,
  HEALTH_THRESHOLD_ENV,
  HEALTH_WEB_TESTS
} from './cloud-parity-health-contract.mjs'

const SCENARIO_MS = 45000

export async function exerciseHealth({ h, report }) {
  const showId = h.showId
  const alerts = async () => h.rpc('watchdog.alerts.list')
  const said = []
  const keep = (value) => {
    said.push(JSON.stringify(value))
    return value
  }

  // On air with a fixture leg only, every layer healthy to start.
  h.web.hooks.patch(showId, (state) => {
    state.legs = [structuredClone(HEALTH_FAKE_LEG)]
    healthyState(state)
  })
  await waitFor(
    async () => keep(await h.rpc('cloud.status')).room?.live === true,
    'the room reads on air'
  )
  const timeline = []
  for (const scenario of HEALTH_SCENARIOS) {
    const injectedAt = Date.now()
    if (scenario.participants) h.web.hooks.participants(showId, scenario.participants)
    if (scenario.inject) h.web.hooks.patch(showId, (state) => scenario.inject(state))
    let named = null
    if (scenario.alert) {
      named = await waitFor(
        async () => alertFor(keep(await alerts()), scenario.alert),
        `${scenario.id}: ${scenario.alert.check} names ${scenario.alert.targetId ?? 'the output'}`,
        SCENARIO_MS
      )
    } else {
      await waitFor(
        async () => scenario.status(keep(await h.rpc('cloud.status'))),
        `${scenario.id}: the status carries it`,
        SCENARIO_MS
      )
    }
    const openedAfterMs = Date.now() - injectedAt
    // Hold the fault a moment: nothing the scenario forbids may open.
    await holdFor(
      async () => falseAlarms(keep(await alerts()), scenario.forbidden).length === 0,
      `${scenario.id}: no Unknown reads as ${scenario.forbidden.join(' or ')}`,
      4000
    )
    const recoveredAt = Date.now()
    // LiveKit's own list again, and every program layer healthy.
    if (scenario.participants) h.web.hooks.participants(showId, null)
    h.web.hooks.patch(showId, (state) => healthyState(state))
    if (scenario.alert)
      await waitFor(
        async () => !alertFor(keep(await alerts()), scenario.alert),
        `${scenario.id}: the alert recovers`,
        SCENARIO_MS
      )
    timeline.push({
      scenario: scenario.id,
      check: named?.check ?? null,
      layer: named?.targetId ?? null,
      openedAfterMs,
      recoveredAfterMs: Date.now() - recoveredAt
    })
  }
  // The room's microphone is not measured by the watchdog: in all of this
  // (its no-voice threshold shortened for the run) Unknown never alarmed.
  const final = keep(await alerts())
  assert.deepEqual(
    falseAlarms(final, [...NEVER_ON_AN_UNMEASURED_ROOM]),
    [],
    'no-voice or still-there opened on an unmeasured room'
  )
  for (const entry of h.healthEvents?.() ?? []) keep(entry)
  assertNoLeaks(said.join('\n'), h.secrets?.() ?? [])

  // Off air again: the baseline's own end checks expect no legs.
  h.web.hooks.patch(showId, (state) => {
    state.legs = []
  })
  await waitFor(
    async () => (await h.rpc('cloud.status')).room?.live === false,
    'the room reads off air'
  )
  report.health = {
    timeline,
    takeoverMute:
      'unit-tested (watchdog::checks::tests::a_takeover_mute_is_never_a_dead_audio_alarm)',
    guards: 'unit-tested (live-activity, cloud_show room_activity)',
    leakScan: 'passed',
    managed: 'not-run',
    devices: 'not-run',
    productionQualified: false
  }
}
