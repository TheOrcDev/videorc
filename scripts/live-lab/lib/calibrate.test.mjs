import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MIN_DAYS,
  MIN_SAMPLES,
  calibrate,
  formatCalibration,
  proposeLimit,
  quantile,
  usableVerdict
} from './calibrate.mjs'
import { activeThresholdsPath, DEFAULT_THRESHOLDS_PATH, loadThresholds } from './verdict.mjs'

function verdictOn(day, signals, overrides = {}) {
  return {
    schema: 1,
    thresholdsMode: 'report',
    outcome: 'pass',
    startedAt: `${day}T06:00:00.000Z`,
    endedAt: `${day}T08:00:00.000Z`,
    signals,
    ...overrides
  }
}

function days(count, start = Date.UTC(2026, 9, 1)) {
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10)
  )
}

const V1 = {
  version: 1,
  mode: 'report',
  leak: { mbPerHourByRole: { 'electron-renderer': 30 } },
  encoderSpeed: { min: 0.97 },
  startLatency: { maxMs: 10000 },
  chat: { maxArrivalMs: 10000 }
}

test('quantile is nearest-rank and ignores non-numbers', () => {
  assert.equal(quantile([5, 1, 4, 2, 3], 0.95), 5)
  assert.equal(quantile([5, 1, 4, 2, 3], 0.05), 1)
  assert.equal(quantile([1, Number.NaN, 2], 0.5), 1)
  assert.equal(quantile([], 0.5), null)
})

test('upper bounds take p95 x ratio with an absolute floor; lower bounds p5', () => {
  const upper = { bound: 'upper', ratio: 1.5, floor: 5 }
  assert.equal(proposeLimit(upper, [2, 2, 2, 2]).limit, 7)
  assert.equal(proposeLimit(upper, [20, 20, 20]).limit, 30)
  const lower = { bound: 'lower', ratio: 0.98, floor: 0.01, max: 1 }
  assert.equal(proposeLimit(lower, [1.02, 1.01, 1.0]).limit, 0.98)
})

test('only finished report-only runs count', () => {
  assert.equal(usableVerdict(verdictOn('2026-10-01', [])), true)
  assert.equal(usableVerdict(verdictOn('2026-10-01', [], { outcome: 'warn' })), true)
  for (const outcome of ['fail', 'crashed', 'stopped']) {
    assert.equal(usableVerdict(verdictOn('2026-10-01', [], { outcome })), false)
  }
  assert.equal(usableVerdict(verdictOn('2026-10-01', [], { thresholdsMode: 'gate' })), false)
})

test(`nothing is proposed before ${MIN_DAYS} days of usable runs`, () => {
  const verdicts = days(MIN_DAYS - 1).map((day) =>
    verdictOn(day, [{ id: 'leak:electron-renderer', status: 'pass', value: 4 }])
  )
  // Failed runs on extra days do not count towards the minimum.
  verdicts.push(verdictOn('2026-11-30', [], { outcome: 'fail' }))
  const result = calibrate(verdicts, V1)
  assert.equal(result.ok, false)
  assert.match(result.reason, new RegExp(`${MIN_DAYS - 1} day\\(s\\).*need ${MIN_DAYS}`))
  assert.match(formatCalibration(result), /Nothing proposed/)
})

test('a full window proposes gate thresholds and keeps thin signals at v1', () => {
  const verdicts = days(MIN_DAYS).map((day, index) =>
    verdictOn(day, [
      { id: 'leak:electron-renderer', status: 'pass', value: 2 + (index % 3) },
      { id: 'stream:encoder-speed', status: 'pass', value: 1 - (index % 2) * 0.01 },
      { id: 'stream:start-latency', status: 'pass', value: 4000 + index * 100 },
      { id: 'handles:fds', status: 'skipped', value: null },
      ...(index < MIN_SAMPLES - 1 ? [{ id: 'chat:latency', status: 'pass', value: 3000 }] : [])
    ])
  )
  const result = calibrate(verdicts, V1, { now: new Date('2026-10-20T00:00:00Z') })
  assert.equal(result.ok, true)
  assert.equal(result.thresholds.version, 2)
  assert.equal(result.thresholds.mode, 'gate')
  assert.equal(result.thresholds.calibration.days, MIN_DAYS)
  assert.equal(result.thresholds.leak.mbPerHourByRole['electron-renderer'], 9)
  assert.equal(result.thresholds.encoderSpeed.min, 0.97)
  assert.equal(result.thresholds.startLatency.maxMs, 6625)
  // Fewer than MIN_SAMPLES chat samples: v1 kept, flagged.
  assert.equal(result.thresholds.chat.maxArrivalMs, 10000)
  const chat = result.changes.find((change) => change.key === 'chat.maxArrivalMs')
  assert.equal(chat.insufficient, true)
  // The input object is not mutated.
  assert.equal(V1.mode, 'report')
  assert.equal(V1.leak.mbPerHourByRole['electron-renderer'], 30)
  const table = formatCalibration(result)
  assert.match(table, /\| `leak\.mbPerHourByRole\.electron-renderer` \| 30 \| 9 \|/)
  assert.match(table, /kept: under 10 samples/)
})

test('a looser proposal is flagged for the owner', () => {
  const verdicts = days(MIN_DAYS).map((day) =>
    verdictOn(day, [{ id: 'leak:electron-renderer', status: 'warn', value: 40 }])
  )
  const result = calibrate(verdicts, V1)
  const change = result.changes.find((entry) => entry.key.endsWith('electron-renderer'))
  assert.equal(change.looser, true)
  assert.match(formatCalibration(result), /looser than v1/)
})

test('verdicts use the calibrated v2 once it exists, v1 until then', async () => {
  assert.equal(activeThresholdsPath({ exists: () => false }), DEFAULT_THRESHOLDS_PATH)
  assert.match(activeThresholdsPath({ exists: () => true }), /thresholds\.v2\.json$/)
  const v1 = await loadThresholds(DEFAULT_THRESHOLDS_PATH)
  assert.equal(v1.version, 1)
  assert.equal(v1.mode, 'report')
})
