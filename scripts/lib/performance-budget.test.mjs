import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  activePerformanceBudgetProbeConfig,
  activePerformanceBudgetRequest,
  ActivePerformanceBudgetError,
  CROSS_MACHINE_NATIVE_CADENCE,
  evaluateActivePerformanceBudget,
  loadActivePerformanceBudget,
  preflightActivePerformanceBudget,
  preflightActivePerformanceBudgetArtifact,
  readActivePerformanceBudget,
  selectActivePerformanceBudget,
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
  it('rejects missing, malformed, and schema-invalid budgets during the read phase', async () => {
    await assert.rejects(
      readActivePerformanceBudget({
        path: '/tmp/missing-budget.json',
        read: async () => {
          throw new Error('ENOENT')
        }
      }),
      /could not read active budget.*ENOENT/
    )
    await assert.rejects(
      readActivePerformanceBudget({
        path: '/tmp/malformed-budget.json',
        read: async () => '{'
      }),
      /could not read active budget.*JSON/
    )
    const invalid = budgetDocument()
    delete invalid.profiles[0].approval
    await assert.rejects(
      readActivePerformanceBudget({
        path: '/tmp/invalid-budget.json',
        read: async () => JSON.stringify(invalid)
      }),
      /approval was missing or invalid/
    )
  })

  it('selects only after surface context exists and rejects a scale mismatch', async () => {
    const budget = await readActivePerformanceBudget({
      path: '/tmp/active-budget.json',
      read: async () => JSON.stringify(budgetDocument())
    })

    assert.equal(budget.path, '/tmp/active-budget.json')
    assert.equal(budget.document.profiles.length, 1)
    const selected = selectActivePerformanceBudget({ budget, context: runContext() })
    assert.equal(selected.profile.id, 'mac16-packaged-detached')
    assert.equal(selected.probeConfig.memory.maxOwnedRssMb, 512)
    assert.throws(
      () =>
        selectActivePerformanceBudget({
          budget,
          context: { ...runContext(), displayScaleFactor: 1 }
        }),
      /did not contain a matching profile.*displayScaleFactor=1/
    )
  })

  it('rejects a missing explicit profile and every non-scale static scope mismatch', async () => {
    const budget = await readBudgetDocument(budgetDocument())
    assert.throws(
      () =>
        preflightActivePerformanceBudget({
          budget,
          profileId: 'missing-profile',
          context: staticRunContext()
        }),
      /did not contain profile missing-profile/
    )

    for (const [context, expected] of [
      [{ ...staticRunContext(), scenario: 'record-4k' }, /scenario record-4k != detached/],
      [{ ...staticRunContext(), machineModel: 'Mac99,9' }, /machineModel Mac99,9 != Mac16,1/],
      [{ ...staticRunContext(), buildMode: 'development' }, /buildMode development != packaged/],
      [{ ...staticRunContext(), appVersion: '0.9.46' }, /appVersion 0.9.46 != 0.9.45/],
      [
        { ...staticRunContext(), profileClass: 'short-sentinel' },
        /profileClass short-sentinel != endurance/
      ],
      [
        {
          ...staticRunContext(),
          timing: { ...staticRunContext().timing, measurementMs: 120_000 }
        },
        /timing.measurementMs 120000 != 600000/
      ],
      [
        { ...staticRunContext(), packagePayloadSha256: 'e'.repeat(64) },
        /packagePayloadSha256 e+ != d+/
      ],
      [
        {
          ...staticRunContext(),
          operatingSystem: { ...staticRunContext().operatingSystem, arch: 'x64' }
        },
        /operatingSystem.arch x64 != arm64/
      ]
    ]) {
      assert.throws(
        () =>
          preflightActivePerformanceBudget({
            budget,
            profileId: 'mac16-packaged-detached',
            context
          }),
        expected
      )
    }

    assert.doesNotThrow(() =>
      preflightActivePerformanceBudget({
        budget,
        profileId: 'mac16-packaged-detached',
        context: {
          ...staticRunContext(),
          commit: 'f'.repeat(40),
          executableSha256: '0'.repeat(64)
        }
      })
    )

    const hardwareDocument = budgetDocument()
    delete hardwareDocument.profiles[0].scope.machineModel
    hardwareDocument.profiles[0].scope.hardwareClass = 'hosted-arm64'
    const hardwareBudget = await readBudgetDocument(hardwareDocument)
    assert.throws(
      () =>
        preflightActivePerformanceBudget({
          budget: hardwareBudget,
          profileId: 'mac16-packaged-detached',
          context: { ...staticRunContext(), hardwareClass: 'other-host' }
        }),
      /hardwareClass other-host != hosted-arm64/
    )
  })

  it('rejects zero automatic static matches before launch', async () => {
    const budget = await readBudgetDocument(budgetDocument())

    assert.throws(
      () =>
        preflightActivePerformanceBudget({
          budget,
          context: { ...staticRunContext(), machineModel: 'Mac99,9' }
        }),
      /did not contain a statically matching profile.*machine=Mac99,9/
    )
  })

  it('preflights a named packaged artifact without treating provenance HEAD as runtime scope', async () => {
    const budget = await readBudgetDocument(budgetDocument())
    const context = {
      ...staticRunContext(),
      commit: 'f'.repeat(40),
      executableSha256: '0'.repeat(64),
      machineModel: 'different-build-host',
      hardwareClass: 'different-build-class',
      operatingSystem: { platform: 'darwin', arch: 'x64', macosVersion: '99.0' }
    }

    assert.deepEqual(
      preflightActivePerformanceBudgetArtifact({
        budget,
        profileId: 'mac16-packaged-detached',
        context
      }).candidateProfileIds,
      ['mac16-packaged-detached']
    )
    assert.throws(
      () => preflightActivePerformanceBudgetArtifact({ budget, context }),
      /requires an explicit active budget profile id/
    )
    assert.throws(
      () =>
        preflightActivePerformanceBudgetArtifact({
          budget,
          profileId: 'mac16-packaged-detached',
          context: { ...context, packagePayloadSha256: 'e'.repeat(64) }
        }),
      /packagePayloadSha256 e+ != d+/
    )
  })

  it('retains automatic candidates only when otherwise-identical scopes differ by display scale', async () => {
    const document = budgetDocument()
    document.profiles.push({
      ...profile(),
      id: 'mac16-packaged-detached-1x',
      scope: { ...profile().scope, displayScaleFactor: 1 }
    })
    const budget = await readBudgetDocument(document)
    const preflight = preflightActivePerformanceBudget({ budget, context: staticRunContext() })

    assert.deepEqual(preflight.candidateProfileIds, [
      'mac16-packaged-detached',
      'mac16-packaged-detached-1x'
    ])
    assert.equal(
      selectActivePerformanceBudget({
        budget,
        context: { ...staticRunContext(), displayScaleFactor: 1 }
      }).profile.id,
      'mac16-packaged-detached-1x'
    )

    const ambiguousDocument = budgetDocument()
    ambiguousDocument.profiles.push({ ...profile(), id: 'duplicate-static-and-scale' })
    const ambiguousBudget = await readBudgetDocument(ambiguousDocument)
    assert.throws(
      () =>
        preflightActivePerformanceBudget({
          budget: ambiguousBudget,
          context: staticRunContext()
        }),
      /multiple static profiles did not differ only by displayScaleFactor/
    )
  })

  it('selects one profile matching scenario, machine, build, display scale, and optional OS scope', async () => {
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

  it('fails closed when the display scale is missing or differs from the profile', async () => {
    await assert.rejects(
      load(budgetDocument(), { context: { ...runContext(), displayScaleFactor: 1 } }),
      /did not contain a matching profile.*displayScaleFactor=1/
    )
    await assert.rejects(
      load(budgetDocument(), {
        profileId: 'mac16-packaged-detached',
        context: { ...runContext(), displayScaleFactor: 1 }
      }),
      /displayScaleFactor 1 != 2/
    )
    const contextWithoutScale = runContext()
    delete contextWithoutScale.displayScaleFactor
    await assert.rejects(
      load(budgetDocument(), {
        profileId: 'mac16-packaged-detached',
        context: contextWithoutScale
      }),
      /displayScaleFactor missing != 2/
    )
  })

  it('rejects incomplete schema-aligned threshold and approval data', () => {
    const document = budgetDocument()
    delete document.profiles[0].thresholds.memoryMiB.maximumOwnedSecondHalfSlopePerMinute
    document.profiles[0].approval.reviewedBy = ''
    const failures = validateActivePerformanceBudgetDocument(document)

    assert.ok(failures.some((failure) => /maximumOwnedSecondHalfSlopePerMinute/.test(failure)))
    assert.ok(failures.some((failure) => /approval was missing/.test(failure)))
  })

  it('requires immutable three-run evidence references', () => {
    const document = budgetDocument()
    delete document.profiles[0].evidence.calibrationSha256
    document.profiles[0].evidence.runNonces[2] = document.profiles[0].evidence.runNonces[1]
    document.profiles[0].evidence.reportPaths[0] = ''

    const failures = validateActivePerformanceBudgetDocument(document)
    assert.ok(failures.some((failure) => /calibrationSha256 was invalid/.test(failure)))
    assert.ok(failures.some((failure) => /runNonces.*unique/.test(failure)))
    assert.ok(failures.some((failure) => /reportPaths.*invalid/.test(failure)))
  })

  it('requires a positive display scale in both runtime and JSON schema validation', () => {
    const document = budgetDocument()
    document.profiles[0].scope.displayScaleFactor = 0

    assert.ok(
      validateActivePerformanceBudgetDocument(document).some((failure) =>
        /scope displayScaleFactor was missing or invalid/.test(failure)
      )
    )

    const schema = JSON.parse(
      readFileSync(
        new URL('../../config/performance-budgets/v1/active-budget.schema.json', import.meta.url),
        'utf8'
      )
    )
    assert.ok(schema.$defs.scope.required.includes('displayScaleFactor'))
    assert.equal(schema.$defs.scope.properties.displayScaleFactor.exclusiveMinimum, 0)
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

  it('keeps short-sentinel and endurance windows non-overlapping', () => {
    const short = budgetDocument()
    short.profiles[0].scope.profileClass = 'short-sentinel'
    assert.ok(
      validateActivePerformanceBudgetDocument(short).some((failure) =>
        /short-sentinel profile overlapped/.test(failure)
      )
    )

    const endurance = budgetDocument()
    endurance.profiles[0].scope.timing.measurementMs = 120_000
    assert.ok(
      validateActivePerformanceBudgetDocument(endurance).some((failure) =>
        /endurance profile measurement was shorter/.test(failure)
      )
    )
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
      resources: { maxPhysicalFootprintGrowthMb: 32, maxOpenFileGrowth: 8 },
      cpu: {
        maxAveragePercentByRole: {
          backend: 45,
          'electron-main': 30,
          'electron-renderer': 55
        },
        maxP95PercentByRole: {
          backend: 75,
          'electron-main': 50,
          'electron-renderer': 85
        }
      },
      teardown: { requireClean: true }
    })
  })

  it('passes complete metrics inside the selected profile', () => {
    assert.deepEqual(evaluateActivePerformanceBudget({ profile: profile(), metrics: metrics() }), {
      config: activePerformanceBudgetProbeConfig(profile()),
      metricFailures: [],
      thresholdFailures: []
    })
  })

  it('evaluates recording and lifecycle resources without inventing preview-only wire metrics', () => {
    const recording = metrics()
    delete recording.pipeline.statusHttpFetchesPerSecond
    delete recording.pipeline.wireKibPerSecond
    assert.deepEqual(
      evaluateActivePerformanceBudget({
        profile: profile(),
        metrics: recording,
        metricContract: 'recording'
      }).metricFailures,
      []
    )

    const lifecycle = metrics()
    delete lifecycle.pipeline
    assert.deepEqual(
      evaluateActivePerformanceBudget({
        profile: profile(),
        metrics: lifecycle,
        metricContract: 'lifecycle'
      }).metricFailures,
      []
    )
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
    actual.cpuAveragePercentByRole.backend = 50
    actual.cpuP95PercentByRole['electron-renderer'] = 90
    actual.teardownClean = false
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
    assert.ok(
      result.thresholdFailures.some((failure) => /backend average CPU.*exceeded/.test(failure))
    )
    assert.ok(
      result.thresholdFailures.some((failure) =>
        /electron-renderer p95 CPU.*exceeded/.test(failure)
      )
    )
    assert.ok(result.thresholdFailures.some((failure) => /teardown was not clean/.test(failure)))
  })

  it('fails synthetic monotonic growth and CPU regressions even below gross RSS ceilings', () => {
    const actual = metrics()
    actual.memory.ownedRss.slopePerMinute = 8 * 1024
    actual.memory.ownedRss.secondHalfSlopePerMinute = 7 * 1024
    actual.memory.ownedRss.plateauGrowth = 40 * 1024
    actual.memory.roles.backend.slopeRssKbPerMinute = 5 * 1024
    actual.memory.roles.backend.secondHalfSlopeRssKbPerMinute = 4 * 1024
    actual.memory.roles.backend.plateauGrowthRssKb = 20 * 1024
    actual.cpuAveragePercentByRole.backend = 60
    actual.cpuP95PercentByRole.backend = 90

    const result = evaluateActivePerformanceBudget({ profile: profile(), metrics: actual })
    for (const expected of [
      /owned process RSS slope.*exceeded/,
      /owned process RSS second-half slope.*exceeded/,
      /owned process RSS plateau growth.*exceeded/,
      /backend RSS slope.*exceeded/,
      /backend RSS second-half slope.*exceeded/,
      /backend RSS plateau growth.*exceeded/,
      /backend average CPU.*exceeded/,
      /backend p95 CPU.*exceeded/
    ]) {
      assert.ok(
        result.thresholdFailures.some((failure) => expected.test(failure)),
        String(expected)
      )
    }
  })
})

function load(document, options) {
  return loadActivePerformanceBudget({
    path: '/tmp/active-budget.json',
    read: async () => JSON.stringify(document),
    ...options
  })
}

function readBudgetDocument(document) {
  return readActivePerformanceBudget({
    path: '/tmp/active-budget.json',
    read: async () => JSON.stringify(document)
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
      profileClass: 'endurance',
      appVersion: '0.9.45',
      machineModel: 'Mac16,1',
      buildMode: 'packaged',
      displayScaleFactor: 2,
      operatingSystem: { platform: 'darwin', arch: 'arm64' },
      timing: { warmupMs: 60_000, measurementMs: 600_000, intervalMs: 1_000 }
    },
    evidence: {
      calibrationId: 'a'.repeat(24),
      commit: 'b'.repeat(40),
      executableSha256: 'c'.repeat(64),
      packagePayloadSha256: 'd'.repeat(64),
      calibrationSha256: 'd'.repeat(64),
      calibrationGeneratedAt: '2026-07-10T12:00:00.000Z',
      powerAssertion: 'caffeinate:-d,-i,-s',
      powerAssertionVerified: true,
      runCount: 3,
      runNonces: ['run-1', 'run-2', 'run-3'],
      reportPaths: ['run-1.child.json', 'run-2.child.json', 'run-3.child.json']
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
      },
      perRoleCpuPercent: {
        backend: { maximumAverage: 45, maximumP95: 75 },
        'electron-main': { maximumAverage: 30, maximumP95: 50 },
        'electron-renderer': { maximumAverage: 55, maximumP95: 85 }
      },
      teardown: {
        requireClean: true
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
    profileClass: 'endurance',
    appVersion: '0.9.45',
    machineModel: 'Mac16,1',
    buildMode: 'packaged',
    commit: 'b'.repeat(40),
    executableSha256: 'c'.repeat(64),
    packagePayloadSha256: 'd'.repeat(64),
    displayScaleFactor: 2,
    operatingSystem: { platform: 'darwin', arch: 'arm64', macosVersion: '26.5.1' },
    timing: { warmupMs: 60_000, measurementMs: 600_000, intervalMs: 1_000 }
  }
}

function staticRunContext() {
  const context = runContext()
  delete context.displayScaleFactor
  return context
}

function metrics() {
  return {
    teardownClean: true,
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
    },
    cpuAveragePercentByRole: {
      backend: 25,
      'electron-main': 15,
      'electron-renderer': 35
    },
    cpuP95PercentByRole: {
      backend: 40,
      'electron-main': 25,
      'electron-renderer': 50
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
