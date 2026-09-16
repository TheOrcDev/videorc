import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  RECORD_LATENCY_BUDGETS,
  evaluateRecordLatencyBudget,
  nextCycleDelayMs,
  parseTimelineMessage,
  percentileNearestRank,
  readBudgetOverrides,
  summarizeRecordCycles,
  timelinePhaseDeltas
} from './record-latency-gate.mjs'

describe('record latency percentiles', () => {
  it('handles single and two-sample inputs with nearest-rank semantics', () => {
    assert.equal(percentileNearestRank([420], 0.95), 420)
    assert.equal(percentileNearestRank([100, 900], 0.5), 100)
    assert.equal(percentileNearestRank([100, 900], 0.95), 900)
    assert.equal(percentileNearestRank([], 0.95), null)
  })

  it('ignores non-finite samples', () => {
    assert.equal(percentileNearestRank([NaN, 50, undefined, 70], 0.5), 50)
  })
})

describe('record cycle summary', () => {
  it('splits cold and warm cycles and summarizes each metric', () => {
    const summary = summarizeRecordCycles([
      { cold: true, clickToRecordingMs: 1800, stopClickToIdleMs: 900 },
      { cold: false, clickToRecordingMs: 300, stopClickToIdleMs: 200 },
      { cold: false, clickToRecordingMs: 340, stopClickToIdleMs: 260 }
    ])
    assert.equal(summary.cold.clickToRecordingMs.n, 1)
    assert.equal(summary.cold.clickToRecordingMs.max, 1800)
    assert.equal(summary.warm.clickToRecordingMs.n, 2)
    assert.equal(summary.warm.clickToRecordingMs.p95, 340)
    assert.equal(summary.warm.stopClickToIdleMs.p50, 200)
    assert.equal(summary.warm.clickToAckMs.n, 0)
  })
})

describe('record latency budget', () => {
  const budgets = { ...RECORD_LATENCY_BUDGETS }

  it('passes when every measured metric is inside its budget', () => {
    const summary = summarizeRecordCycles([
      { cold: true, clickToRecordingMs: 900, stopClickToIdleMs: 150, idleToFinalizedMs: 1200 },
      { cold: false, clickToRecordingMs: 250, stopClickToIdleMs: 180, idleToFinalizedMs: 900 }
    ])
    assert.deepEqual(evaluateRecordLatencyBudget(summary, budgets), { pass: true, failures: [] })
  })

  it('names every budget that is exceeded', () => {
    const summary = summarizeRecordCycles([
      { cold: true, clickToRecordingMs: 2600, stopClickToIdleMs: 4200, idleToFinalizedMs: 100 },
      { cold: false, clickToRecordingMs: 1900, stopClickToIdleMs: 3900, idleToFinalizedMs: 9000 }
    ])
    const verdict = evaluateRecordLatencyBudget(summary, budgets)
    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('\n'), /warm start click→recording p95 1900ms exceeds 350ms/)
    assert.match(verdict.failures.join('\n'), /cold start click→recording 2600ms exceeds 1200ms/)
    assert.match(verdict.failures.join('\n'), /stop click→idle p95 4200ms exceeds 300ms/)
    assert.match(
      verdict.failures.join('\n'),
      /finalization idle→finalized p95 9000ms exceeds 5000ms/
    )
  })

  it('fails closed when no warm start or stop samples exist', () => {
    const verdict = evaluateRecordLatencyBudget(summarizeRecordCycles([]), budgets)
    assert.equal(verdict.pass, false)
    assert.deepEqual(verdict.failures, [
      'no warm start samples were measured',
      'no stop samples were measured'
    ])
  })

  it('reads positive env overrides and rejects garbage', () => {
    const overridden = readBudgetOverrides(
      { VIDEORC_RECORD_LATENCY_STOP_P95_MS: '450' },
      RECORD_LATENCY_BUDGETS
    )
    assert.equal(overridden.stopClickToIdleP95Ms, 450)
    assert.equal(overridden.warmStartClickToRecordingP95Ms, 350)
    assert.throws(
      () => readBudgetOverrides({ VIDEORC_RECORD_LATENCY_COLD_START_MS: 'soon' }),
      /positive number/
    )
  })

  it('stays report-only until a calibration document is named', () => {
    assert.equal(RECORD_LATENCY_BUDGETS.calibratedFrom, null)
  })
})

describe('record latency cycle pacing', () => {
  it('never sends the next record-family intent inside the debounce window', () => {
    assert.ok(nextCycleDelayMs({ idleGapMs: 0 }) > 150)
    assert.equal(nextCycleDelayMs({ idleGapMs: 1500 }), 1500)
  })
})

describe('timeline parsing', () => {
  it('round-trips key=value marks with ms suffixes, deltas, booleans and strings', () => {
    const parsed = parseTimelineMessage(
      'total=412ms cold=true clickToOrigin=18ms admission=0 device-resolve=+12 outcome=running'
    )
    assert.deepEqual(parsed, {
      total: 412,
      cold: true,
      clickToOrigin: 18,
      admission: 0,
      'device-resolve': 12,
      outcome: 'running'
    })
    assert.deepEqual(parseTimelineMessage(undefined), {})
  })

  it('turns ordered marks into per-phase deltas', () => {
    assert.deepEqual(
      timelinePhaseDeltas([
        { phase: 'admission', atMs: 3 },
        { phase: 'mic-warm', atMs: 380 },
        { phase: 'running', atMs: 1200 }
      ]),
      [
        { phase: 'admission', deltaMs: 3 },
        { phase: 'mic-warm', deltaMs: 377 },
        { phase: 'running', deltaMs: 820 }
      ]
    )
  })
})

describe('record latency smoke wiring', () => {
  it('is exposed as a package script', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    assert.equal(
      packageJson.scripts['smoke:record-latency'],
      'node scripts/smoke-record-latency-app.mjs'
    )
  })
})
