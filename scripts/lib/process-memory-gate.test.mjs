import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateProcessMemoryGate,
  formatProcessMemorySummary,
  requiredProcessMemoryTrendThresholdFailures,
  summarizeProcessMemory
} from './process-memory-gate.mjs'

test('requiredProcessMemoryTrendThresholdFailures rejects a gate without owned and per-role trend limits', () => {
  assert.deepEqual(requiredProcessMemoryTrendThresholdFailures({}), [
    'owned process RSS slope threshold was missing or invalid',
    'owned process RSS second-half slope threshold was missing or invalid',
    'owned process RSS plateau growth threshold was missing or invalid',
    'backend RSS slope threshold was missing or invalid',
    'backend RSS second-half slope threshold was missing or invalid',
    'backend RSS plateau growth threshold was missing or invalid',
    'electron-main RSS slope threshold was missing or invalid',
    'electron-main RSS second-half slope threshold was missing or invalid',
    'electron-main RSS plateau growth threshold was missing or invalid',
    'electron-renderer RSS slope threshold was missing or invalid',
    'electron-renderer RSS second-half slope threshold was missing or invalid',
    'electron-renderer RSS plateau growth threshold was missing or invalid'
  ])
})

test('requiredProcessMemoryTrendThresholdFailures accepts reviewed owned and required-role trend limits', () => {
  const perRole = {
    backend: 0,
    'electron-main': 1,
    'electron-renderer': 2
  }
  assert.deepEqual(
    requiredProcessMemoryTrendThresholdFailures({
      maxOwnedSlopeMbPerMinute: 0,
      maxOwnedSecondHalfSlopeMbPerMinute: 1,
      maxOwnedPlateauGrowthMb: 2,
      maxRoleSlopeMbPerMinute: perRole,
      maxRoleSecondHalfSlopeMbPerMinute: perRole,
      maxRolePlateauGrowthMb: perRole
    }),
    []
  )
})

test('summarizeProcessMemory tracks peak process tree, owned RSS, and role totals', () => {
  const summary = summarizeProcessMemory([
    census({
      sampledAtMs: 0,
      alive: [10],
      rows: [row(10, 'backend', 20_000), row(11, 'electron-main', 100_000)]
    }),
    census({
      sampledAtMs: 60_000,
      alive: [10, 12],
      rows: [
        row(10, 'backend', 30_000),
        row(12, 'native-preview-helper', 40_000),
        row(13, 'electron-main', 120_000)
      ]
    })
  ])

  assert.equal(summary.samples, 2)
  assert.equal(summary.maxTotalRssKb, 190_000)
  assert.equal(summary.maxOwnedRssKb, 70_000)
  assert.equal(summary.roles.backend.maxCount, 1)
  assert.equal(summary.roles.backend.minMeasuredCount, 1)
  assert.equal(summary.roles.backend.maxRssKb, 30_000)
  assert.equal(summary.roles.backend.slopeRssKbPerMinute, 10_000)
  assert.equal(summary.roles['native-preview-helper'].maxCount, 1)
  assert.equal(summary.roles['native-preview-helper'].maxRssKb, 40_000)
  assert.equal(summary.roles['native-preview-helper'].slopeRssKbPerMinute, 40_000)
})

test('evaluateProcessMemoryGate reports breached total, owned, and role thresholds', () => {
  const failures = evaluateProcessMemoryGate(
    {
      maxTotalRssKb: 5 * 1024,
      maxOwnedRssKb: 3 * 1024,
      roles: {
        backend: { maxCount: 1, maxRssKb: 2 * 1024 }
      }
    },
    {
      maxTotalRssMb: 4,
      maxOwnedRssMb: 2,
      maxRoleRssMb: { backend: 1 }
    }
  )

  assert.deepEqual(failures, [
    'total process tree RSS 5MB exceeded 4MB',
    'owned process RSS 3MB exceeded 2MB',
    'backend RSS 2MB exceeded 1MB'
  ])
})

test('formatProcessMemorySummary emits a stable role report', () => {
  const report = formatProcessMemorySummary({
    samples: 1,
    maxTotalRssKb: 2048,
    maxOwnedRssKb: 1024,
    ownedRss: {
      slopePerMinute: 0,
      secondHalfSlopePerMinute: 0,
      plateauGrowth: 0
    },
    roles: {
      backend: {
        maxCount: 1,
        maxRssKb: 1024,
        slopeRssKbPerMinute: 0,
        secondHalfSlopeRssKbPerMinute: 0,
        plateauGrowthRssKb: 0
      },
      tooling: {
        maxCount: 2,
        maxRssKb: 2048,
        slopeRssKbPerMinute: 0,
        secondHalfSlopeRssKbPerMinute: 0,
        plateauGrowthRssKb: 0
      }
    }
  })

  assert.match(report, /samples: 1/)
  assert.match(report, /max total process tree RSS: 2MB/)
  assert.match(report, /owned RSS slope: 0\.00MB\/min/)
  assert.match(report, /backend: max_count=1 max_rss=1MB slope=0\.00MB\/min/)
})

test('evaluateProcessMemoryGate rejects non-plateauing role growth and excess process counts', () => {
  const failures = evaluateProcessMemoryGate(
    {
      samples: 12,
      maxTotalRssKb: 400 * 1024,
      maxOwnedRssKb: 200 * 1024,
      totalRss: { slopePerMinute: 2 * 1024 },
      ownedRss: {
        slopePerMinute: 3 * 1024,
        secondHalfSlopePerMinute: 4 * 1024,
        plateauGrowth: 30 * 1024
      },
      roles: {
        'electron-renderer': {
          maxCount: 3,
          maxRssKb: 150 * 1024,
          slopeRssKbPerMinute: 6 * 1024,
          secondHalfSlopeRssKbPerMinute: 7 * 1024,
          plateauGrowthRssKb: 25 * 1024
        }
      }
    },
    {
      minSamples: 10,
      maxOwnedSlopeMbPerMinute: 2,
      maxOwnedSecondHalfSlopeMbPerMinute: 2,
      maxOwnedPlateauGrowthMb: 20,
      maxRoleCount: { 'electron-renderer': 2 },
      maxRoleSlopeMbPerMinute: { 'electron-renderer': 5 },
      maxRoleSecondHalfSlopeMbPerMinute: { 'electron-renderer': 5 },
      maxRolePlateauGrowthMb: { 'electron-renderer': 20 }
    }
  )

  assert.deepEqual(failures, [
    'owned process RSS slope 3.00MB/min exceeded 2MB/min',
    'owned process RSS second-half slope 4.00MB/min exceeded 2MB/min',
    'owned process RSS plateau growth 30.00MB exceeded 20MB',
    'electron-renderer process count 3 exceeded 2',
    'electron-renderer RSS slope 6.00MB/min exceeded 5MB/min',
    'electron-renderer RSS second-half slope 7.00MB/min exceeded 5MB/min',
    'electron-renderer RSS plateau growth 25.00MB exceeded 20MB'
  ])
})

test('evaluateProcessMemoryGate rejects short samples and missing required live roles', () => {
  const failures = evaluateProcessMemoryGate(
    {
      samples: 1,
      maxTotalRssKb: 0,
      maxOwnedRssKb: 0,
      totalRss: { durationMs: 0 },
      ownedRss: {},
      roles: {}
    },
    {
      minSamples: 3,
      minDurationMs: 2000,
      minRoleCount: { backend: 1, 'electron-main': 1 }
    }
  )

  assert.deepEqual(failures, [
    'backend minimum process count 0 was below 1',
    'electron-main minimum process count 0 was below 1',
    'memory sample count 1 was below 3',
    'memory measurement duration 0ms was below 2000ms'
  ])
})

function census({ sampledAtMs, alive, rows }) {
  return {
    sampledAtMs,
    aliveRecords: alive.map((pid) => ({ pid })),
    processRows: rows
  }
}

function row(pid, role, rssKb) {
  return { pid, role, rssKb }
}
