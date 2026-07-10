import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  collectProcessEndurance,
  compactProcessMemorySample,
  evaluateOwnedTeardown,
  evaluateProcessEnduranceEvidence,
  parseProcessGroupCpu,
  performanceEnduranceMetrics,
  summarizeProcessCpu
} from './process-endurance.mjs'

describe('process endurance evidence', () => {
  it('collects a warm-up-separated RSS/CPU series and comparable resource checkpoints', async () => {
    let nowMs = 0
    let censusSequence = 0
    const evidence = await collectProcessEndurance({
      ledgerPaths: ['/tmp/owned.json'],
      pgid: 700,
      warmupMs: 100,
      measurementMs: 200,
      intervalMs: 100,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms
      },
      collectCensus: async () => fakeCensus(++censusSequence),
      collectCpu: async () => ({
        backend: 10,
        'electron-main': 5,
        'electron-renderer': 7
      }),
      collectResources: async (census) => resourceCheckpoint(census.processRows)
    })

    assert.equal(evidence.timing.measurementStartedAtMs, 100)
    assert.equal(evidence.timing.measuredDurationMs, 200)
    assert.equal(evidence.memory.samples.length, 3)
    assert.equal(evidence.memory.summary.samples, 3)
    assert.equal(evidence.cpu.samples.length, 3)
    assert.equal(evidence.cpu.summary.byRole.backend.averagePercent, 10)
    assert.equal(evidence.resourceCheckpoints.comparison.processContinuity.comparable, true)
    assert.deepEqual(
      evaluateProcessEnduranceEvidence(evidence, {
        minimumSamples: 3,
        minimumDurationMs: 200
      }),
      []
    )
  })

  it('summarizes compact RSS and per-role CPU time series', () => {
    const census = {
      sampledAtMs: 1_000,
      aliveRecords: [{ pid: 2 }],
      deadRecords: [],
      processRows: [
        { pid: 1, rssKb: 100 },
        { pid: 2, rssKb: 200 }
      ],
      processGroupRows: [{ pid: 1 }, { pid: 2 }],
      summary: { backend: { count: 1, rssKb: 200 } }
    }
    assert.deepEqual(compactProcessMemorySample(census), {
      sampledAtMs: 1_000,
      totalRssKb: 300,
      ownedRssKb: 200,
      aliveOwnedProcessCount: 1,
      deadOwnedProcessCount: 0,
      processGroupCount: 2,
      byRole: { backend: { count: 1, rssKb: 200 } }
    })

    const cpu = summarizeProcessCpu([
      { sampledAtMs: 1, byRole: { backend: 10, 'electron-main': 5 } },
      { sampledAtMs: 2, byRole: { backend: 20, 'electron-main': 15 } }
    ])
    assert.deepEqual(cpu, {
      samples: 2,
      byRole: {
        backend: { samples: 2, averagePercent: 15, maxPercent: 20 },
        'electron-main': { samples: 2, averagePercent: 10, maxPercent: 15 }
      }
    })
  })

  it('classifies CPU rows only from the exact app process group', () => {
    const parsed = parseProcessGroupCpu(
      `
      10 700 12.5 1024 /repo/videorc-backend /repo/videorc-backend
      11 700 5.5 2048 /Applications/Videorc.app/Contents/MacOS/Videorc /Applications/Videorc.app/Contents/MacOS/Videorc
      12 999 99.0 2048 /repo/videorc-backend /repo/videorc-backend
    `,
      700
    )
    assert.deepEqual(parsed, { backend: 12.5, 'electron-main': 5.5 })
  })

  it('fails closed when memory, CPU, resource checkpoints, or teardown are incomplete', () => {
    const evidence = completeEvidence()
    assert.deepEqual(evaluateProcessEnduranceEvidence(evidence), [])
    assert.deepEqual(evaluateOwnedTeardown(cleanTeardown()), [])

    const incomplete = structuredClone(evidence)
    incomplete.memory.samples = []
    incomplete.cpu.summary.byRole.backend.samples = 1
    incomplete.resourceCheckpoints.comparison.metrics.openFileCount.comparable = false
    incomplete.resourceCheckpoints.comparison.metrics.openFileCount.reasons = ['PID changed']
    assert.deepEqual(evaluateProcessEnduranceEvidence(incomplete), [
      'process-memory samples were incomplete (2 summarized, 0 raw; expected at least 2)',
      'per-role CPU series did not continuously cover required role backend',
      'openFileCount checkpoints were not comparable: PID changed'
    ])

    assert.deepEqual(
      evaluateOwnedTeardown({
        clean: false,
        error: 'timeout',
        finalCensus: { records: [{ pid: 10 }], processGroupRows: [{ pid: 10 }] }
      }),
      [
        'app-owned process teardown was not clean',
        'app-owned process ledger was not empty after teardown',
        'app process group was not empty after teardown',
        'app-owned teardown failed: timeout'
      ]
    )
  })

  it('publishes one calibration-compatible detailed metric shape for every scenario', () => {
    const evidence = completeEvidence()
    const metrics = performanceEnduranceMetrics({
      evidence,
      teardown: cleanTeardown(),
      pipeline: { transport: 'native-surface', backing: 'cametal-layer' }
    })
    assert.equal(metrics.teardownClean, true)
    assert.equal(metrics.memory, evidence.memory.summary)
    assert.equal(metrics.memorySamples, evidence.memory.samples)
    assert.equal(metrics.cpuAveragePercentByRole.backend, 10)
    assert.equal(metrics.resourceCheckpoints, evidence.resourceCheckpoints)
    assert.equal(metrics.processEndurance, evidence)
    assert.deepEqual(metrics.thresholds, {})
  })
})

function completeEvidence() {
  const roles = Object.fromEntries(
    ['backend', 'electron-main', 'electron-renderer'].map((role) => [role, { minMeasuredCount: 1 }])
  )
  const cpuRoles = Object.fromEntries(
    ['backend', 'electron-main', 'electron-renderer'].map((role) => [
      role,
      { samples: 2, averagePercent: 10, maxPercent: 20 }
    ])
  )
  return {
    memory: {
      samples: [{}, {}],
      summary: {
        samples: 2,
        totalRss: { samples: 2, durationMs: 1_000 },
        ownedRss: { samples: 2 },
        roles
      }
    },
    cpu: { samples: [{}, {}], summary: { samples: 2, byRole: cpuRoles } },
    resourceCheckpoints: {
      comparison: {
        processContinuity: { comparable: true },
        metrics: {
          physicalFootprintBytes: { comparable: true, reasons: [] },
          openFileCount: { comparable: true, reasons: [] }
        }
      }
    }
  }
}

function cleanTeardown() {
  return {
    clean: true,
    error: null,
    finalCensus: { records: [], processGroupRows: [] }
  }
}

function fakeCensus(sequence) {
  const processRows = [
    { pid: 10, pgid: 700, rssKb: 100 + sequence, role: 'backend' },
    { pid: 11, pgid: 700, rssKb: 200 + sequence, role: 'electron-main' },
    { pid: 12, pgid: 700, rssKb: 300 + sequence, role: 'electron-renderer' }
  ]
  return {
    aliveRecords: [{ pid: 10 }],
    deadRecords: [],
    processRows,
    processGroupRows: processRows,
    summary: {
      backend: { count: 1, rssKb: 100 + sequence },
      'electron-main': { count: 1, rssKb: 200 + sequence },
      'electron-renderer': { count: 1, rssKb: 300 + sequence }
    }
  }
}

function resourceCheckpoint(rows) {
  const resourceRows = rows.map((row) => ({
    pid: row.pid,
    role: row.role,
    physicalFootprintBytes: row.pid * 1_000,
    openFileCount: row.pid
  }))
  return {
    rows: resourceRows,
    coverage: {
      physicalFootprintBytes: { complete: true },
      openFileCount: { complete: true }
    },
    totals: {
      physicalFootprintBytes: resourceRows.reduce(
        (total, row) => total + row.physicalFootprintBytes,
        0
      ),
      openFileCount: resourceRows.reduce((total, row) => total + row.openFileCount, 0)
    }
  }
}
