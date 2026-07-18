import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  collectProcessEndurance,
  collectWindowsProcessTreeTelemetry,
  compactProcessMemorySample,
  createProcessTreeCpuSampler,
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
      resourceCheckpointSettleMs: 0,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms
      },
      collectCensus: async () => {
        censusSequence += 1
        if (censusSequence === 3 || censusSequence === 4) nowMs += 30
        return fakeCensus(censusSequence)
      },
      collectCpu: async () => ({
        backend: 10,
        'electron-main': 5,
        'electron-renderer': 7
      }),
      collectResources: async (census) => resourceCheckpoint(census.processRows)
    })

    assert.equal(evidence.timing.measurementStartedAtMs, 100)
    assert.equal(evidence.timing.measuredDurationMs, 200)
    assert.equal(evidence.memory.samples.length, 2)
    assert.equal(evidence.memory.summary.samples, 2)
    assert.deepEqual(
      evidence.memory.samples.map(({ sampledAtMs, scheduledAtMs }) => ({
        sampledAtMs,
        scheduledAtMs
      })),
      [
        { sampledAtMs: 130, scheduledAtMs: 100 },
        { sampledAtMs: 230, scheduledAtMs: 200 }
      ]
    )
    assert.equal(evidence.cpu.samples.length, 2)
    assert.equal(evidence.cpu.summary.byRole.backend.averagePercent, 10)
    assert.equal(evidence.cpu.summary.byRole.backend.p95Percent, 10)
    assert.deepEqual(evidence.sampling, {
      expectedSamples: 2,
      collectedSamples: 2,
      skippedDeadlineCount: 0,
      maxSampleGapMs: 100,
      measurementElapsedMs: 200,
      observations: [
        { sampleIndex: 0, scheduledAtMs: 100, observedAtMs: 130 },
        { sampleIndex: 1, scheduledAtMs: 200, observedAtMs: 230 }
      ]
    })
    assert.equal(evidence.resourceCheckpoints.comparison.processContinuity.comparable, true)
    assert.deepEqual(
      evaluateProcessEnduranceEvidence(evidence, {
        minimumSamples: 2,
        minimumDurationMs: 100
      }),
      []
    )
  })

  it('skips host-sleep deadlines, retains actual observations, and fails the stall evidence', async () => {
    let nowMs = 0
    let censusSequence = 0
    const evidence = await collectProcessEndurance({
      ledgerPaths: ['/tmp/owned.json'],
      pgid: 700,
      warmupMs: 0,
      measurementMs: 4_000,
      intervalMs: 500,
      resourceCheckpointSettleMs: 0,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms
      },
      collectCensus: async () => {
        censusSequence += 1
        if (censusSequence === 3) nowMs += 1_800
        else if (censusSequence >= 4 && censusSequence <= 8) nowMs += 100
        return fakeCensus(censusSequence)
      },
      collectCpu: async () => ({
        backend: 10,
        'electron-main': 5,
        'electron-renderer': 7
      }),
      collectResources: async (census) => resourceCheckpoint(census.processRows)
    })

    assert.deepEqual(
      evidence.sampling.observations.map((sample) => sample.sampleIndex),
      [0, 3, 4, 5, 6, 7]
    )
    assert.deepEqual(evidence.memory.samples[0], {
      sampledAtMs: 1_800,
      scheduledAtMs: 0,
      totalRssKb: 609,
      ownedRssKb: 103,
      aliveOwnedProcessCount: 1,
      deadOwnedProcessCount: 0,
      processGroupCount: 3,
      byRole: {
        backend: { count: 1, rssKb: 103 },
        'electron-main': { count: 1, rssKb: 203 },
        'electron-renderer': { count: 1, rssKb: 303 }
      }
    })
    assert.equal(evidence.sampling.skippedDeadlineCount, 2)
    assert.equal(evidence.sampling.maxSampleGapMs, 1_800)
    assert.deepEqual(evaluateProcessEnduranceEvidence(evidence), [
      'performance sampling skipped 2 wall-clock deadlines; host sleep or a severe scheduling stall contaminated the run',
      'performance sampling observation span 1800ms was below 3000ms',
      'performance sampling max gap 1800ms indicated host sleep or a scheduling stall'
    ])
  })

  it('summarizes compact RSS and per-role CPU time series', () => {
    const census = {
      sampledAtMs: 1_000,
      scheduledAtMs: 900,
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
      scheduledAtMs: 900,
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
        backend: { samples: 2, averagePercent: 15, p95Percent: 20, maxPercent: 20 },
        'electron-main': { samples: 2, averagePercent: 10, p95Percent: 15, maxPercent: 15 }
      }
    })
  })

  it('uses a nearest-rank p95 that exposes sustained CPU spikes', () => {
    const samples = Array.from({ length: 20 }, (_, index) => ({
      sampledAtMs: index * 1_000,
      byRole: { backend: index < 18 ? 10 : index === 18 ? 70 : 90 }
    }))

    assert.deepEqual(summarizeProcessCpu(samples).byRole.backend, {
      samples: 20,
      averagePercent: 17,
      p95Percent: 70,
      maxPercent: 90
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

  it('samples Windows CPU from the packaged app tree instead of a POSIX process group', async () => {
    let nowMs = 1_000
    const tables = [
      windowsProcessTable({
        mainCpuTimeMs: 1_000,
        backendCpuTimeMs: 2_000,
        rendererCpuTimeMs: 500
      }),
      windowsProcessTable({ mainCpuTimeMs: 1_100, backendCpuTimeMs: 2_300, rendererCpuTimeMs: 650 })
    ]
    const sampleCpu = createProcessTreeCpuSampler({
      rootPid: 100,
      platform: 'win32',
      now: () => nowMs,
      readProcessTable: async () => tables.shift() ?? []
    })

    assert.deepEqual(await sampleCpu(), {})
    nowMs += 1_000
    assert.deepEqual(await sampleCpu(), {
      backend: 30,
      'electron-main': 10,
      'electron-renderer': 15
    })
  })

  it('collects Windows CPU and RSS evidence with a root-PID tree', async () => {
    let nowMs = 0
    let sample = 0
    const evidence = await collectWindowsProcessTreeTelemetry({
      rootPid: 100,
      warmupMs: 100,
      measurementMs: 200,
      intervalMs: 100,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms
      },
      collectCensus: async ({ rootPid }) => {
        assert.equal(rootPid, 100)
        sample += 1
        return fakeCensus(sample)
      },
      collectCpu: async () => ({
        backend: 20,
        'electron-main': 10,
        'electron-renderer': 5
      })
    })

    assert.equal(evidence.timing.measurementStartedAtMs, 100)
    assert.equal(evidence.timing.measuredDurationMs, 200)
    assert.equal(evidence.memory.samples.length, 2)
    assert.deepEqual(evidence.cpu.summary.byRole.backend, {
      samples: 2,
      averagePercent: 20,
      p95Percent: 20,
      maxPercent: 20
    })
    assert.deepEqual(evidence.sampling.observations, [
      { sampleIndex: 0, scheduledAtMs: 100, observedAtMs: 100 },
      { sampleIndex: 1, scheduledAtMs: 200, observedAtMs: 200 }
    ])
  })

  it('fails closed when memory, CPU, resource checkpoints, or teardown are incomplete', () => {
    const evidence = completeEvidence()
    assert.deepEqual(evaluateProcessEnduranceEvidence(evidence), [])
    assert.deepEqual(evaluateOwnedTeardown(cleanTeardown()), [])

    assert.deepEqual(
      evaluateOwnedTeardown({
        ...cleanTeardown(),
        gracefulQuitRequested: true,
        gracefulQuitError: 'app quit timed out',
        stopResult: { state: 'killed', escalated: true }
      }),
      [
        'app-owned graceful quit failed: app quit timed out',
        'app-owned teardown required forced process termination'
      ]
    )
    assert.deepEqual(
      evaluateOwnedTeardown({
        ...cleanTeardown(),
        gracefulQuitRequested: true,
        stopResult: { state: 'terminated', escalated: false }
      }),
      ['app-owned teardown required forced process termination']
    )

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
    assert.equal(metrics.sampling, evidence.sampling)
    assert.equal(metrics.cpuAveragePercentByRole.backend, 10)
    assert.equal(metrics.cpuP95PercentByRole.backend, 20)
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
      { samples: 2, averagePercent: 10, p95Percent: 20, maxPercent: 20 }
    ])
  )
  return {
    timing: {
      requestedMeasurementMs: 2_000,
      intervalMs: 1_000
    },
    sampling: {
      expectedSamples: 2,
      collectedSamples: 2,
      skippedDeadlineCount: 0,
      maxSampleGapMs: 1_000,
      measurementElapsedMs: 2_000,
      observations: [
        { sampleIndex: 0, scheduledAtMs: 0, observedAtMs: 100 },
        { sampleIndex: 1, scheduledAtMs: 1_000, observedAtMs: 1_100 }
      ]
    },
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

function windowsProcessTable({ mainCpuTimeMs, backendCpuTimeMs, rendererCpuTimeMs }) {
  return [
    { pid: 100, ppid: 1, command: 'C:\\Videorc.exe', args: '', cpuTimeMs: mainCpuTimeMs },
    {
      pid: 101,
      ppid: 100,
      command: 'C:\\Videorc.exe',
      args: '--type=renderer',
      cpuTimeMs: rendererCpuTimeMs
    },
    {
      pid: 102,
      ppid: 100,
      command: 'C:\\videorc-backend.exe',
      args: '',
      cpuTimeMs: backendCpuTimeMs
    },
    { pid: 200, ppid: 1, command: 'C:\\unrelated.exe', args: '', cpuTimeMs: 99_999 }
  ]
}
