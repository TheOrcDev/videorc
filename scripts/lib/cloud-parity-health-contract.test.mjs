import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  HEALTH_SCENARIOS,
  HEALTH_THRESHOLD_ENV,
  NEVER_ON_AN_UNMEASURED_ROOM,
  alertFor,
  assertNoLeaks,
  falseAlarms,
  healthyState,
  scanForLeaks
} from './cloud-parity-health-contract.mjs'

// Plan 249 S26: the health case's pure part. The heavy runner is authored,
// not run here.

const host = {
  identity: 'host:sh_0123456789abcdefghijkl',
  name: 'Host',
  role: 'host',
  onStage: true,
  video: true,
  audio: true,
  muted: false,
  screen: false,
  quality: 'good',
  sinceMs: 1000,
  away: false
}
const fresh = () => {
  const state = { room: { participants: [structuredClone(host)] } }
  healthyState(state)
  return state
}

test('the scenarios cover every injection the done-when names', () => {
  assert.deepEqual(
    HEALTH_SCENARIOS.map((scenario) => scenario.id),
    ['mic-loss', 'stale-beacon', 'dropped-layers', 'black', 'frozen', 'silent-output', 'reconnect']
  )
  for (const scenario of HEALTH_SCENARIOS)
    assert.ok(scenario.alert || scenario.status, `${scenario.id} names what it proves`)
})

test('every scenario is a pure state transform that names its layer', () => {
  for (const scenario of HEALTH_SCENARIOS) {
    const state = fresh()
    scenario.inject?.(state)
    if (scenario.participants)
      state.room.participants = scenario.participants(state.room.participants)
    assert.doesNotThrow(() => JSON.stringify(state), scenario.id)
    if (scenario.alert?.check === 'contribution-missing') assert.ok(scenario.alert.targetId)
  }
  const stale = fresh()
  HEALTH_SCENARIOS.find((s) => s.id === 'stale-beacon').inject(stale)
  assert.equal(stale.program, undefined, 'a stale page has no counters to read as silence')
  assert.equal(stale.outputHealth[0].audio, 'unknown')
  const micLoss = HEALTH_SCENARIOS.find((s) => s.id === 'mic-loss')
  assert.equal(micLoss.participants([host])[0].audio, false)
  const reconnect = HEALTH_SCENARIOS.find((s) => s.id === 'reconnect')
  const without = reconnect.participants([host])
  assert.equal(
    without.some((p) => p.role === 'host'),
    false
  )
  assert.ok(without.length > 0, 'absence is a fact, not an empty list')
})

test('alertFor names the layer; falseAlarms catches Unknown read as silence', () => {
  const view = {
    alerts: [
      { check: 'contribution-missing', targetId: 'host-microphone' },
      { check: 'program-silent' }
    ]
  }
  assert.ok(alertFor(view, { check: 'contribution-missing', targetId: 'host-microphone' }))
  assert.equal(
    alertFor(view, { check: 'contribution-missing', targetId: 'host-camera' }),
    undefined
  )
  assert.equal(falseAlarms(view, ['program-silent', 'no-voice']).length, 1)
  assert.deepEqual(NEVER_ON_AN_UNMEASURED_ROOM, ['no-voice', 'still-there'])
})

test('the leak scan finds credentials and frames, and passes the health words', () => {
  assert.deepEqual(
    scanForLeaks('{"url":"wss://x.livekit.cloud?access_token=abc"}').sort(),
    ['a credential query parameter', 'a room address'].sort()
  )
  assert.deepEqual(scanForLeaks('vcs1.eyJ2IjoxfQ.sig'), ['a Videorc page or show token'])
  assert.deepEqual(scanForLeaks('"src":"data:image/png;base64,AAAA"'), ['an inline frame or image'])
  assert.deepEqual(scanForLeaks('hello SECRETVALUE', ['SECRETVALUE']), ['a known secret'])
  const fixture = readFileSync(
    new URL('../../protocol-fixtures/cloud-parity-health.json', import.meta.url),
    'utf8'
  )
  assertNoLeaks(fixture, [], 'the shared health vectors')
  assert.throws(() => assertNoLeaks('rtmp://a/b'), /a stream address/)
})

test('the thresholds are dev overrides of real check ids', () => {
  for (const name of Object.keys(HEALTH_THRESHOLD_ENV))
    assert.match(name, /^VIDEORC_WATCHDOG_[A-Z_]+_AFTER_MS$/)
  assert.ok(HEALTH_THRESHOLD_ENV.VIDEORC_WATCHDOG_PROGRAM_UNREPORTED_AFTER_MS)
  assert.ok(HEALTH_THRESHOLD_ENV.VIDEORC_WATCHDOG_CONTRIBUTION_MISSING_AFTER_MS)
})
