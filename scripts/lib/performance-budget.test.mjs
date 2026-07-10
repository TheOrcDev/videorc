import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  activePerformanceBudgetProbeConfig,
  activePerformanceBudgetRequest,
  ActivePerformanceBudgetError,
  CROSS_MACHINE_NATIVE_CADENCE,
  evaluateActivePerformanceBudget,
  loadActivePerformanceBudget,
  validateActivePerformanceBudgetDocument
} from './performance-budget.mjs'

describe('active performance budget request', () => {
  it('requires an explicit path when the release sentinel or profile requests a budget', () => {
    assert.equal(activePerformanceBudgetRequest({}), null)
    assert.throws(
      () => activePerformanceBudgetRequest({ VIDEORC_PERF_REQUIRE_ACTIVE_BUDGET: '1' }),
      /ACTIVE_BUDGET_PATH is required/
    )
    assert.throws(
      () => activePerformanceBudgetRequest({ VIDEORC_PERF_ACTIVE_BUDGET_PROFILE: 'mac16' }),
      /PROFILE requires.*PATH/
    )
    assert.deepEqual(
      activePerformanceBudgetRequest({
        VIDEORC_PERF_ACTIVE_BUDGET_PATH: '/tmp/budget.json',
        VIDEORC_PERF_ACTIVE_BUDGET_PROFILE: 'mac16'
      }),
      { path: '/tmp/budget.json', profileId: 'mac16' }
    )
  })
})

describe('active performance budget loading', () => {
  it('selects one profile matching scenario, machine, build, and optional OS scope', async () => {
    const document = budgetDocument()
    document.profiles.push({
      ...profile(),
      id: 'other-machine',
      scope: { ...profile().scope, machineModel: 'Mac99,9' }
    })
    const loaded = await load(document, { context: runContext() })

    assert.equal(loaded.profile.id, 'mac16-packaged-detached')
    assert.equal(loaded.probeConfig.memory.maxOwnedRssMb, 512)
    assert.equal(loaded.probeConfig.cadence.minPresentFps, 58)
  })

  it('matches an explicit hardware class without accepting a different machine implicitly', async () => {
    const document = budgetDocument()
    delete document.profiles[0].scope.machineModel
    document.profiles[0].scope.hardwareClass = 'github-hosted-macos-15-arm64-standard'
    const loaded = await load(document, {
      context: {
        ...runContext(),
        machineModel: 'VirtualMac2,1',
        hardwareClass: 'github-hosted-macos-15-arm64-standard'
      }
    })

    assert.equal(loaded.profile.id, 'mac16-packaged-detached')
    await assert.rejects(
      load(document, { context: { ...runContext(), machineModel: 'VirtualMac2,1' } }),
      /hardwareClass=missing/
    )
  })

  it('fails closed for an unknown, mismatched, or ambiguous requested profile', async () => {
    await assert.rejects(
      load(budgetDocument(), { profileId: 'missing', context: runContext() }),
      /did not contain profile missing/
    )
    await assert.rejects(
      load(budgetDocument(), {
        profileId: 'mac16-packaged-detached',
        context: { ...runContext(), buildMode: 'development' }
      }),
      /buildMode development != packaged/
    )
    const ambiguous = budgetDocument()
    ambiguous.profiles.push({ ...profile(), id: 'duplicate-scope' })
    await assert.rejects(load(ambiguous, { context: runContext() }), /multiple matching profiles/)
  })

  it('rejects incomplete schema-aligned threshold and approval data', () => {
    const document = budgetDocument()
    delete document.profiles[0].thresholds.memoryMiB.maximumOwnedSecondHalfSlopePerMinute
    document.profiles[0].approval.reviewedBy = ''
    const failures = validateActivePerformanceBudgetDocument(document)

    assert.ok(failures.some((failure) => /maximumOwnedSecondHalfSlopePerMinute/.test(failure)))
    assert.ok(failures.some((failure) => /approval was missing/.test(failure)))
  })

  it('rejects wildcard/ambiguous hardware bindings and profiles that weaken the product floor', () => {
    const ambiguous = budgetDocument()
    ambiguous.profiles[0].scope.hardwareClass = 'hosted-*'
    ambiguous.profiles[0].thresholds.cadence.minimumPresentFps = 57
    ambiguous.profiles[0].thresholds.cadence.maximumIntervalP95Ms = 31
    const failures = validateActivePerformanceBudgetDocument(ambiguous)

    assert.ok(
      failures.some((failure) => /exactly one of machineModel or hardwareClass/.test(failure))
    )
    assert.ok(failures.some((failure) => /minimumPresentFps weakened/.test(failure)))
    assert.ok(failures.some((failure) => /maximumIntervalP95Ms weakened/.test(failure)))
  })
})

describe('active performance budget evaluation', () => {
  it('loads the separately versioned cross-machine cadence invariant', () => {
    assert.deepEqual(CROSS_MACHINE_NATIVE_CADENCE, {
      schemaVersion: 1,
      kind: 'videorc.cross-machine-native-cadence-invariant',
      minimumPresentFps: 58,
      maximumIntervalP95Ms: 30
    })
  })
  it('maps every active threshold to the perf-idle gate configuration', () => {
    assert.deepEqual(activePerformanceBudgetProbeConfig(profile()), {
      cadence: { minPresentFps: 58, maxIntervalP95Ms: 30 },
      pipeline: { maxStatusFetchesPerSecond: 5, maxWireKibPerSecond: 80 },
      memory: {
        maxTotalRssMb: 1024,
        maxOwnedRssMb: 512,
        maxOwnedSlopeMbPerMinute: 4,
        maxOwnedSecondHalfSlopeMbPerMinute: 3,
        maxOwnedPlateauGrowthMb: 24,
        maxRoleRssMb: { backend: 128, 'electron-main': 256, 'electron-renderer': 384 },
        maxRoleSlopeMbPerMinute: {
          backend: 2,
          'electron-main': 2,
          'electron-renderer': 3
        },
        maxRoleSecondHalfSlopeMbPerMinute: {
          backend: 1,
          'electron-main': 1,
          'electron-renderer': 2
        },
        maxRolePlateauGrowthMb: {
          backend: 8,
          'electron-main': 12,
          'electron-renderer': 16
        }
      },
      resources: { maxPhysicalFootprintGrowthMb: 32, maxOpenFileGrowth: 8 }
    })
  })

  it('passes complete metrics inside the selected profile', () => {
    assert.deepEqual(evaluateActivePerformanceBudget({ profile: profile(), metrics: metrics() }), {
      config: activePerformanceBudgetProbeConfig(profile()),
      metricFailures: [],
      thresholdFailures: []
    })
  })

  it('fails closed when an explicitly budgeted metric is missing or not comparable', () => {
    const actual = metrics()
    delete actual.memory.ownedRss.secondHalfSlopePerMinute
    delete actual.memory.roles['electron-renderer'].plateauGrowthRssKb
    actual.resourceCheckpoints.comparison.metrics.physicalFootprintBytes.comparable = false
    const result = evaluateActivePerformanceBudget({ profile: profile(), metrics: actual })

    assert.ok(
      result.metricFailures.some((failure) => /second-half slope metric was missing/.test(failure))
    )
    assert.ok(
      result.metricFailures.some((failure) => /electron-renderer RSS plateau growth/.test(failure))
    )
    assert.ok(
      result.metricFailures.some((failure) =>
        /physical footprint growth.*not comparable/.test(failure)
      )
    )
  })

  it('reports cadence, memory, role, pipeline, and resource threshold breaches', () => {
    const actual = metrics()
    actual.pipeline.presentFps = 40
    actual.pipeline.wireKibPerSecond = 100
    actual.memory.maxOwnedRssKb = 600 * 1024
    actual.memory.roles.backend.slopeRssKbPerMinute = 4 * 1024
    actual.resourceCheckpoints.comparison.metrics.openFileCount.delta = 12
    const result = evaluateActivePerformanceBudget({ profile: profile(), metrics: actual })

    assert.ok(result.thresholdFailures.some((failure) => /present FPS.*below/.test(failure)))
    assert.ok(
      result.thresholdFailures.some((failure) => /WebSocket wire rate.*exceeded/.test(failure))
    )
    assert.ok(
      result.thresholdFailures.some((failure) => /owned process RSS.*exceeded/.test(failure))
    )
    assert.ok(
      result.thresholdFailures.some((failure) => /backend RSS slope.*exceeded/.test(failure))
    )
    assert.ok(
      result.thresholdFailures.some((failure) => /open-file growth.*exceeded/.test(failure))
    )
  })
})

function load(document, options) {
  return loadActivePerformanceBudget({
    path: '/tmp/active-budget.json',
    read: async () => JSON.stringify(document),
    ...options
  })
}

function budgetDocument() {
  return {
    schemaVersion: 1,
    kind: 'videorc.performance-budget-set',
    status: 'active',
    profiles: [profile()]
  }
}

function profile() {
  return {
    id: 'mac16-packaged-detached',
    scope: {
      scenario: 'detached-native-preview',
      machineModel: 'Mac16,1',
      buildMode: 'packaged',
      operatingSystem: { platform: 'darwin', arch: 'arm64' }
    },
    evidence: {
      calibrationId: 'a'.repeat(24),
      commit: 'b'.repeat(40),
      executableSha256: 'c'.repeat(64),
      runCount: 3
    },
    thresholds: {
      cadence: { minimumPresentFps: 58, maximumIntervalP95Ms: 30 },
      pipeline: { maximumStatusFetchesPerSecond: 5, maximumWireKibPerSecond: 80 },
      memoryMiB: {
        maximumTotalRss: 1024,
        maximumOwnedRss: 512,
        maximumOwnedSlopePerMinute: 4,
        maximumOwnedSecondHalfSlopePerMinute: 3,
        maximumOwnedPlateauGrowth: 24
      },
      resources: { maximumPhysicalFootprintGrowthMiB: 32, maximumOpenFileGrowth: 8 },
      perRoleMemoryMiB: {
        backend: roleThresholds(128, 2, 1, 8),
        'electron-main': roleThresholds(256, 2, 1, 12),
        'electron-renderer': roleThresholds(384, 3, 2, 16)
      }
    },
    approval: {
      reviewedBy: 'Performance owner',
      reviewedAt: '2026-07-10T12:00:00.000Z',
      rationale: 'Test fixture values exercise loader mapping only.'
    }
  }
}

function roleThresholds(rss, slope, secondHalfSlope, plateau) {
  return {
    maximumRss: rss,
    maximumSlopePerMinute: slope,
    maximumSecondHalfSlopePerMinute: secondHalfSlope,
    maximumPlateauGrowth: plateau
  }
}

function runContext() {
  return {
    scenario: 'detached-native-preview',
    machineModel: 'Mac16,1',
    buildMode: 'packaged',
    operatingSystem: { platform: 'darwin', arch: 'arm64', macosVersion: '26.5.1' }
  }
}

function metrics() {
  return {
    pipeline: {
      presentFps: 59,
      framesPerSecond: 58.5,
      intervalP95Ms: 20,
      statusHttpFetchesPerSecond: 1,
      wireKibPerSecond: 64
    },
    memory: {
      maxTotalRssKb: 800 * 1024,
      maxOwnedRssKb: 400 * 1024,
      ownedRss: {
        slopePerMinute: 2 * 1024,
        secondHalfSlopePerMinute: 1 * 1024,
        plateauGrowth: 12 * 1024
      },
      roles: {
        backend: roleMetrics(100, 1, 0.5, 4),
        'electron-main': roleMetrics(200, 1, 0.5, 6),
        'electron-renderer': roleMetrics(300, 2, 1, 8)
      }
    },
    resourceCheckpoints: {
      comparison: {
        metrics: {
          physicalFootprintBytes: { comparable: true, delta: 16 * 1024 * 1024 },
          openFileCount: { comparable: true, delta: 4 }
        }
      }
    }
  }
}

function roleMetrics(rss, slope, secondHalfSlope, plateau) {
  return {
    maxRssKb: rss * 1024,
    slopeRssKbPerMinute: slope * 1024,
    secondHalfSlopeRssKbPerMinute: secondHalfSlope * 1024,
    plateauGrowthRssKb: plateau * 1024
  }
}

assert.ok(ActivePerformanceBudgetError)
