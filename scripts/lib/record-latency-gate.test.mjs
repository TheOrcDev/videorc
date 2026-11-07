import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  RECORD_LATENCY_BUDGETS,
  evaluateRecordLatencyBudget,
  nextCycleDelayMs,
  parseTimelineMessage,
  percentileNearestRank,
  readBudgetOverrides,
  recordLatencyRendererReady,
  recordLatencySceneReady,
  recordLatencyTakeDurationMs,
  summarizeRecordCycles,
  timelinePhaseDeltas
} from './record-latency-gate.mjs'
import { evaluateRecordingWallDuration } from './recording-duration-gate.mjs'

describe('record latency take coverage', () => {
  it('rejects a truncated take hidden by a delayed Record acknowledgement', () => {
    const expectedDurationMs = recordLatencyTakeDurationMs({
      recordingAtMs: 1000,
      stopClickAtMs: 6000,
      recordingMs: 4000
    })
    assert.equal(expectedDurationMs, 5000)
    assert.equal(
      evaluateRecordingWallDuration({
        expectedDurationMs,
        actualDurationSeconds: 4.1,
        minRatio: 0.98
      }).length,
      1
    )
    assert.deepEqual(
      evaluateRecordingWallDuration({
        expectedDurationMs,
        actualDurationSeconds: 4.9,
        minRatio: 0.98
      }),
      []
    )
  })

  it('keeps the configured hold as a floor even if the observed interval is shorter', () => {
    assert.equal(
      recordLatencyTakeDurationMs({ recordingAtMs: 0, stopClickAtMs: 3000, recordingMs: 4000 }),
      4000
    )
  })

  it('refuses missing, non-finite or reversed timing evidence', () => {
    const valid = { recordingAtMs: 1000, stopClickAtMs: 5000, recordingMs: 4000 }
    for (const patch of [
      { recordingAtMs: undefined },
      { recordingAtMs: NaN },
      { recordingAtMs: -1 },
      { stopClickAtMs: Infinity },
      { stopClickAtMs: 1000 },
      { stopClickAtMs: 999 },
      { recordingMs: 0 },
      { recordingMs: NaN }
    ]) {
      assert.throws(() => recordLatencyTakeDurationMs({ ...valid, ...patch }), /coverage needs/)
    }
  })
})

describe('record latency scene fixture', () => {
  const pattern = { kind: 'test-pattern', visible: true }

  it('waits for the renderer to confirm the layout instead of starting on a trial backend scene', () => {
    const committed = {
      wsStatus: 'connected',
      layoutPreset: 'screen-only',
      committedLayoutPreset: 'screen-only',
      visualTransactionPending: false,
      layoutSwitchPending: null
    }
    assert.equal(recordLatencyRendererReady(committed), true)
    for (const patch of [
      { wsStatus: 'connecting' },
      { layoutPreset: 'screen-camera' },
      { committedLayoutPreset: 'screen-camera' },
      { visualTransactionPending: true },
      { layoutSwitchPending: 'screen-only' }
    ])
      assert.equal(recordLatencyRendererReady({ ...committed, ...patch }), false)
    assert.equal(recordLatencyRendererReady(null), false)
  })

  it('rejects a restored screen-plus-camera scene even when its test pattern is live', () => {
    assert.equal(
      recordLatencySceneReady({ sources: [pattern, { kind: 'camera', visible: true }] }),
      false
    )
    assert.equal(recordLatencySceneReady({ sources: [pattern] }), true)
  })

  it('requires visible synthetic pixels and excludes any other visible source', () => {
    for (const scene of [
      null,
      {},
      { sources: [] },
      { sources: [{ ...pattern, visible: false }] },
      { sources: [{ kind: 'screen', visible: true }] },
      { sources: [pattern, { kind: 'window', visible: true }] }
    ])
      assert.equal(recordLatencySceneReady(scene), false)
    assert.equal(
      recordLatencySceneReady({ sources: [pattern, { kind: 'camera', visible: false }] }),
      true
    )
  })
})

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
    assert.match(verdict.failures.join('\n'), /cold start click→recording 2600ms exceeds 1000ms/)
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

  it('is calibrated against a real acceptance note before it may enforce', () => {
    // `--enforce` (smoke:record-latency:gate) is only honest while the named
    // calibration document exists: budgets carry headroom over the observed
    // p95 recorded there, so a missing or renamed note means the numbers are
    // no longer traceable.
    assert.equal(typeof RECORD_LATENCY_BUDGETS.calibratedFrom, 'string')
    const calibrationPath = join(process.cwd(), RECORD_LATENCY_BUDGETS.calibratedFrom)
    assert.ok(existsSync(calibrationPath), `${RECORD_LATENCY_BUDGETS.calibratedFrom} must exist`)
    const note = readFileSync(calibrationPath, 'utf8')
    for (const key of [
      'warmStartClickToRecordingP95Ms',
      'coldStartClickToRecordingMs',
      'stopClickToIdleP95Ms',
      'finalizationIdleToFinalizedP95Ms'
    ]) {
      assert.match(
        note,
        new RegExp(key + '[^\\n]*\\b' + RECORD_LATENCY_BUDGETS[key] + '\\b'),
        `${key} = ${RECORD_LATENCY_BUDGETS[key]} must be recorded in the calibration note`
      )
    }
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
