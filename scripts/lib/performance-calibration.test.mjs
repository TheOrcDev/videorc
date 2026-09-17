import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { parseArgs, portableCalibrationReportPaths } from '../aggregate-performance-calibration.mjs'
import {
  createDetachedPreviewCalibrationEvidence,
  detachedPreviewCalibrationProvenance,
  DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS,
  inspectDetachedPreviewCalibrationSample
} from './detached-preview-calibration.mjs'
import {
  aggregatePackagedPerformanceCalibration,
  PerformanceCalibrationError,
  validatePackagedPerformanceCalibrationReports
} from './performance-calibration.mjs'

const COMMIT = 'a'.repeat(40)
const EXECUTABLE_SHA256 = 'b'.repeat(64)
const PACKAGE_PAYLOAD_SHA256 = 'c'.repeat(64)
const MIB = 1024 * 1024

describe('packaged performance calibration', () => {
  it('aggregates exactly three comparable detailed runs without inventing thresholds', () => {
    const reports = calibrationReports()
    const { summary, budgetCandidate } = aggregatePackagedPerformanceCalibration({
      reports,
      reportPaths: ['/tmp/one.child.json', '/tmp/two.child.json', '/tmp/three.child.json']
    })

    assert.equal(summary.schemaVersion, 1)
    assert.equal(summary.runCount, 3)
    assert.equal(summary.provenance.executableSha256, EXECUTABLE_SHA256)
    assert.equal(summary.provenance.packagePayloadSha256, PACKAGE_PAYLOAD_SHA256)
    assert.equal(summary.provenance.powerAssertion, 'caffeinate:-d,-i,-s')
    assert.equal(summary.provenance.powerAssertionVerified, true)
    assert.equal(summary.provenance.displayScaleFactor, 2)
    assert.equal(summary.provenance.profileClass, 'endurance')
    assert.equal(summary.provenance.appVersion, '0.9.45')
    assert.equal(summary.provenance.detachedPreviewGeometry.stableAcrossMeasurement, true)
    assert.equal(summary.comparabilityPolicy.maxCadenceRelativeRange, 0.1)
    assert.equal(summary.observed.cadence.presentFps.median, 60)
    assert.equal(summary.observed.memoryMiB.maximumOwnedRss.median, 402)
    assert.equal(summary.observed.memoryMiB.ownedRss.slopePerMinute.median, 2)
    assert.equal(summary.observed.memoryMiB.ownedRss.secondHalfSlopePerMinute.median, 1)
    assert.equal(summary.observed.memoryMiB.ownedRss.plateauGrowth.median, 4)
    assert.equal(summary.observed.memoryMiB.perRole.backend.slopePerMinute.median, 2)
    assert.equal(summary.observed.resources.physicalFootprintMiB.growth.median, 8)
    assert.equal(summary.observed.resources.physicalFootprintMiB.perRole.backend.growth.median, 2)
    assert.equal(summary.observed.cpuPercentByRole.backend.average.median, 10)
    assert.equal(summary.observed.cpuPercentByRole.backend.p95.median, 20)
    assert.equal(budgetCandidate.schemaVersion, 1)
    assert.equal(budgetCandidate.evidence.calibrationId, summary.calibrationId)
    assert.equal(budgetCandidate.evidence.powerAssertion, 'caffeinate:-d,-i,-s')
    assert.equal(budgetCandidate.evidence.powerAssertionVerified, true)
    assert.equal(budgetCandidate.evidence.packagePayloadSha256, PACKAGE_PAYLOAD_SHA256)
    assert.match(budgetCandidate.evidence.calibrationSha256, /^[0-9a-f]{64}$/)
    assert.equal(budgetCandidate.scope.profileClass, 'endurance')
    assert.equal(budgetCandidate.scope.appVersion, '0.9.45')
    assert.equal(budgetCandidate.status, 'candidate')
    assert.equal(budgetCandidate.enforcement, 'disabled')
    assert.equal(budgetCandidate.thresholds, null)
    assert.equal(budgetCandidate.activation.reviewRequired, true)
  })

  it('uses the observed pipeline scale for headless reports without display metadata', () => {
    const reports = calibrationReports()
    for (const report of reports) {
      report.metadata.displayScaleFactor = null
      report.metrics.pipeline.bounds.scaleFactor = 1
      report.metrics.detachedPreviewGeometry = completeDetachedPreviewGeometry({ scaleFactor: 1 })
      report.metadata.detachedPreviewGeometry = detachedPreviewCalibrationProvenance(
        report.metrics.detachedPreviewGeometry
      )
    }

    const { summary, budgetCandidate } = aggregatePackagedPerformanceCalibration({ reports })

    assert.equal(summary.provenance.displayScaleFactor, 1)
    assert.equal(budgetCandidate.scope.displayScaleFactor, 1)
  })

  it('calibrates a distinct three-run packaged short-sentinel window', () => {
    const reports = calibrationReports().map(shortSentinelReport)

    const { summary, budgetCandidate } = aggregatePackagedPerformanceCalibration({ reports })

    assert.equal(summary.provenance.profileClass, 'short-sentinel')
    assert.deepEqual(summary.timing, {
      warmupMs: 60_000,
      measurementMs: 120_000,
      intervalMs: 1_000
    })
    assert.equal(budgetCandidate.scope.profileClass, 'short-sentinel')
  })

  it('calibrates three full lifecycle-churn runs without fabricating preview cadence', () => {
    const reports = calibrationReports().map((report) => {
      report.scenario = 'lifecycle-churn'
      report.metadata.appRole = 'lifecycle-churn'
      delete report.metadata.detachedPreviewGeometry
      delete report.metrics.detachedPreviewGeometry
      delete report.metrics.pipeline
      return report
    })

    const { summary, budgetCandidate } = aggregatePackagedPerformanceCalibration({ reports })

    assert.equal(summary.scenario, 'lifecycle-churn')
    assert.deepEqual(summary.observed.cadence, {})
    assert.equal(summary.observed.memoryMiB.maximumOwnedRss.median, 402)
    assert.equal(summary.observed.cpuPercentByRole.backend.p95.median, 20)
    assert.equal(summary.observed.resources.physicalFootprintMiB.growth.median, 8)
    assert.equal(budgetCandidate.scope.scenario, 'lifecycle-churn')
  })

  it('binds a workflow-owned hardware class without also binding a transient machine model', () => {
    const reports = calibrationReports().map(shortSentinelReport)
    for (const report of reports) {
      report.metadata.hardwareClass = 'github-hosted-macos-15-arm64-standard'
    }

    const { budgetCandidate } = aggregatePackagedPerformanceCalibration({ reports })

    assert.equal(budgetCandidate.scope.hardwareClass, 'github-hosted-macos-15-arm64-standard')
    assert.equal('machineModel' in budgetCandidate.scope, false)
  })

  for (const [name, mutate, expected] of [
    [
      'missing display scale evidence',
      (report) => {
        report.metadata.displayScaleFactor = null
        delete report.metrics.pipeline.bounds
      },
      /effective display scale factor was missing/
    ],
    [
      'nonpositive display metadata',
      (report) => {
        report.metadata.displayScaleFactor = 0
      },
      /metadata display scale factor was nonpositive/
    ],
    [
      'nonpositive observed pipeline scale',
      (report) => {
        report.metrics.pipeline.bounds.scaleFactor = 0
      },
      /pipeline bounds scale factor was nonpositive/
    ],
    [
      'metadata and pipeline display scale disagreement',
      (report) => {
        report.metrics.pipeline.bounds.scaleFactor = 1
      },
      /metadata display scale factor 2 disagreed with pipeline bounds scale factor 1/
    ]
  ]) {
    it(`rejects ${name}`, () => {
      const reports = calibrationReports()
      mutate(reports[1])

      assert.throws(
        () => aggregatePackagedPerformanceCalibration({ reports }),
        (error) => error instanceof PerformanceCalibrationError && expected.test(error.message)
      )
    })
  }

  it('accepts recording/device reports without pretending wire or frame-pipeline metrics exist', () => {
    for (const scenario of ['real-devices-1080p', 'record-4k', 'record-4k-stream-1080p']) {
      const reports = calibrationReports().map((report) => {
        report.scenario = scenario
        report.timing = {
          warmupMs: report.timing.warmupMs,
          measurementMs: report.timing.measurementMs,
          sampleIntervalMs: report.timing.intervalMs
        }
        report.metrics.processEndurance = { timing: { intervalMs: 1_000 } }
        delete report.metrics.pipeline.wireKibPerSecond
        delete report.metrics.pipeline.framePipeline
        delete report.metadata.detachedPreviewGeometry
        delete report.metrics.detachedPreviewGeometry
        delete report.metrics.sampling.powerAssertion
        delete report.metrics.sampling.powerAssertionVerified
        return report
      })
      const { summary } = aggregatePackagedPerformanceCalibration({ reports })

      assert.equal(summary.scenario, scenario)
      assert.equal(summary.timing.intervalMs, 1_000)
      assert.equal('wireKibPerSecond' in summary.observed.cadence, false)
    }
  })

  it('requires valid wall-clock sampling evidence for every recording/device scenario', () => {
    for (const scenario of ['real-devices-1080p', 'record-4k', 'record-4k-stream-1080p']) {
      const reports = calibrationReports().map((report) => {
        report.scenario = scenario
        delete report.metrics.sampling
        return report
      })

      assert.throws(
        () => aggregatePackagedPerformanceCalibration({ reports }),
        (error) =>
          error instanceof PerformanceCalibrationError &&
          /wall-clock sampling evidence was missing/.test(error.message)
      )
    }
  })

  it('retains strict wire and zero-readback metrics for native-preview calibration', () => {
    const reports = calibrationReports()
    delete reports[1].metrics.pipeline.wireKibPerSecond
    delete reports[2].metrics.pipeline.framePipeline

    assert.throws(
      () => aggregatePackagedPerformanceCalibration({ reports }),
      /wireKibPerSecond was missing|frame-pipeline metrics were missing/
    )
  })

  it('accepts the shared one-deadline jitter allowance with truthful counts', () => {
    const reports = calibrationReports()
    for (const report of reports) {
      report.metrics.memory.samples = 599
      report.metrics.memory.totalRss.samples = 599
      report.metrics.memory.ownedRss.samples = 599
      for (const role of Object.values(report.metrics.memory.roles)) role.rssSamples = 599
      report.metrics.sampling.collectedSamples = 599
      report.metrics.sampling.skippedDeadlineCount = 1
      report.metrics.sampling.observations = report.metrics.sampling.observations.filter(
        ({ sampleIndex }) => sampleIndex !== 300
      )
    }

    assert.equal(aggregatePackagedPerformanceCalibration({ reports }).summary.runCount, 3)
  })

  it('rejects materially inconsistent cadence, RSS, footprint, and trend runs', () => {
    for (const [mutate, expected] of [
      [(reports) => (reports[2].metrics.pipeline.presentFps = 45), /present FPS relative range/],
      [
        (reports) => {
          reports[2].metrics.memory.maxOwnedRssKb = 800 * 1024
          reports[2].metrics.memory.ownedRss.max = 800 * 1024
        },
        /owned RSS maximum relative range/
      ],
      [
        (reports) => {
          const comparison = reports[2].metrics.resourceCheckpoints.comparison.metrics
          for (const row of reports[2].metrics.resourceCheckpoints.last.rows) {
            row.physicalFootprintBytes = 200 * MIB
          }
          comparison.physicalFootprintBytes.last = 800 * MIB
          comparison.physicalFootprintBytes.delta =
            comparison.physicalFootprintBytes.last - comparison.physicalFootprintBytes.first
        },
        /final physical footprint relative range/
      ],
      [
        (reports) => (reports[2].metrics.memory.ownedRss.slopePerMinute = 80 * 1024),
        /owned RSS slope range/
      ]
    ]) {
      const reports = calibrationReports()
      mutate(reports)
      assert.throws(
        () => aggregatePackagedPerformanceCalibration({ reports }),
        (error) => error instanceof PerformanceCalibrationError && expected.test(error.message)
      )
    }
  })

  it('treats signed trend noise near zero as comparable', () => {
    const reports = calibrationReports()
    for (const [index, valueMiB] of [-1, 0, 1].entries()) {
      reports[index].metrics.memory.ownedRss.slopePerMinute = valueMiB * 1024
      reports[index].metrics.memory.ownedRss.secondHalfSlopePerMinute = valueMiB * 512
      reports[index].metrics.memory.ownedRss.plateauGrowth = valueMiB * 1024
    }

    assert.deepEqual(validatePackagedPerformanceCalibrationReports(reports), [])
  })

  for (const [field, label] of [
    ['plateauGrowthRssKb', 'backend RSS plateau growth'],
    ['slopeRssKbPerMinute', 'backend RSS slope'],
    ['secondHalfSlopeRssKbPerMinute', 'backend RSS second-half slope']
  ]) {
    it(`rejects per-role ${field} spread even when the owned aggregate cancels`, () => {
      const reports = calibrationReports()
      reports[0].metrics.memory.roles.backend[field] = -4 * 1024
      reports[1].metrics.memory.roles.backend[field] = 0
      reports[2].metrics.memory.roles.backend[field] = 8 * 1024

      assert.throws(
        () => aggregatePackagedPerformanceCalibration({ reports }),
        (error) => error instanceof PerformanceCalibrationError && error.message.includes(label)
      )
    })
  }

  it('rejects missing or extra reports before considering their contents', () => {
    assert.deepEqual(
      validatePackagedPerformanceCalibrationReports(calibrationReports().slice(0, 2)),
      ['expected exactly 3 detailed child reports; received 2']
    )
    assert.deepEqual(
      validatePackagedPerformanceCalibrationReports([...calibrationReports(), detailedReport(4)]),
      ['expected exactly 3 detailed child reports; received 4']
    )
  })

  for (const [name, mutate, expected] of [
    ['dirty provenance', (reports) => (reports[1].metadata.dirty = true), /provenance was dirty/],
    [
      'non-packaged mode',
      (reports) => {
        reports[1].metadata.buildMode = 'development'
        reports[1].metadata.expectedBuildMode = 'development'
      },
      /expected packaged build mode/
    ],
    [
      'mismatched commit',
      (reports) => (reports[1].metadata.commit = 'c'.repeat(40)),
      /commit did not match run 1/
    ],
    [
      'mismatched executable hash',
      (reports) => (reports[1].metadata.executable.sha256 = 'd'.repeat(64)),
      /executable SHA-256 did not match run 1/
    ],
    [
      'mismatched packaged payload hash',
      (reports) => (reports[1].metadata.packagePayload.sha256 = 'e'.repeat(64)),
      /packaged app payload SHA-256 did not match run 1/
    ],
    [
      'mismatched profile class',
      (reports) => (reports[1].metadata.profileClass = 'short-sentinel'),
      /short-sentinel measurement overlapped|profile class did not match run 1/
    ],
    [
      'mismatched app version',
      (reports) => (reports[1].metadata.appVersion = '0.9.46'),
      /app version did not match run 1/
    ],
    [
      'mismatched machine',
      (reports) => (reports[1].metadata.machineModel = 'Mac99,9'),
      /machine model did not match run 1/
    ],
    [
      'mismatched OS',
      (reports) => (reports[1].metadata.operatingSystem.macosVersion = '99.0'),
      /operating system did not match run 1/
    ],
    [
      'mismatched durations',
      (reports) => {
        reports[1].timing.measurementMs = 601_000
        reports[1].metrics.memory.samples = 601
        reports[1].metrics.memory.ownedRss.durationMs = 600_000
        reports[1].metrics.memory.ownedRss.samples = 601
        reports[1].metrics.memory.totalRss.durationMs = 600_000
        reports[1].metrics.memory.totalRss.samples = 601
        for (const role of Object.values(reports[1].metrics.memory.roles)) role.rssSamples = 601
        reports[1].metrics.sampling.expectedSamples = 601
        reports[1].metrics.sampling.collectedSamples = 601
        reports[1].metrics.sampling.observations.push({
          sampleIndex: 600,
          scheduledAtMs: 600_000,
          observedAtMs: 600_050
        })
        reports[1].metrics.sampling.measurementElapsedMs = 601_000
      },
      /performance window identity did not match report timing|timing did not match run 1/
    ],
    [
      'mismatched metadata performance window',
      (reports) => (reports[1].metadata.performanceWindow.measurementMs = 120_000),
      /performance window identity did not match report timing/
    ],
    [
      'unclean teardown',
      (reports) => (reports[1].metrics.teardownClean = false),
      /teardown was not clean/
    ],
    [
      'missing detailed metrics',
      (reports) => delete reports[1].metrics.memory.roles.backend.slopeRssKbPerMinute,
      /slopeRssKbPerMinute was missing/
    ],
    [
      'missing CPU p95',
      (reports) => delete reports[1].metrics.cpuP95PercentByRole.backend,
      /backend CPU p95 metric was missing/
    ],
    [
      'missing sampling evidence',
      (reports) => delete reports[1].metrics.sampling,
      /sampling evidence/
    ],
    [
      'sleep-contaminated sampling evidence',
      (reports) => {
        reports[1].metrics.sampling.skippedDeadlineCount = 197
        reports[1].metrics.sampling.maxSampleGapMs = 198_000
      },
      /sampling skipped too many|sampling max gap/
    ],
    [
      'impossible sampling counts',
      (reports) => (reports[1].metrics.sampling.skippedDeadlineCount = 1),
      /collected plus skipped counts/
    ],
    [
      'incomparable footprint',
      (reports) => {
        reports[1].metrics.resourceCheckpoints.comparison.metrics.physicalFootprintBytes.comparable = false
      },
      /physicalFootprintBytes checkpoints were missing or not comparable/
    ],
    [
      'duplicate run nonce',
      (reports) => (reports[1].metadata.runNonce = reports[0].metadata.runNonce),
      /run nonces were not unique/
    ],
    [
      'missing power assertion',
      (reports) => (reports[1].metadata.powerAssertion = null),
      /power assertion/
    ],
    [
      'unverified power assertion',
      (reports) => (reports[1].metadata.powerAssertionVerified = false),
      /not verified at runtime/
    ],
    [
      'power assertion missing at measurement end',
      (reports) => (reports[1].metrics.sampling.powerAssertionVerified = false),
      /not verified at measurement end/
    ],
    [
      'inconsistent role population',
      (reports) => {
        reports[1].metrics.memory.roles['native-preview-helper'] = memoryRole(1)
        reports[1].metrics.cpuAveragePercentByRole['native-preview-helper'] = 1
      },
      /memory roles did not match run 1/
    ],
    [
      'missing detached preview geometry evidence',
      (reports) => delete reports[1].metrics.detachedPreviewGeometry,
      /detached preview geometry evidence was missing/
    ],
    [
      'wrong detached preview measurement-end size',
      (reports) => {
        reports[1].metrics.detachedPreviewGeometry.phases.measurementEnd.samples[0].nativeBounds = {
          x: 100,
          y: 128,
          width: 440,
          height: 247
        }
      },
      /measurementEnd sample 1 native bounds were not exact 960x540/
    ],
    [
      'hidden detached preview measurement-end surface',
      (reports) => {
        reports[1].metrics.detachedPreviewGeometry.phases.measurementEnd.samples[0].surface.visible = false
      },
      /measurementEnd sample 1 native surface was not live, visible CAMetalLayer geometry/
    ],
    [
      'detached preview geometry drift',
      (reports) => {
        reports[1].metrics.detachedPreviewGeometry.phases.measurementEnd.samples[0].stabilityKey =
          'drifted-geometry'
      },
      /measurementEnd sample 1 stability key did not match the run geometry/
    ]
  ]) {
    it(`rejects ${name}`, () => {
      const reports = calibrationReports()
      mutate(reports)
      assert.throws(
        () => aggregatePackagedPerformanceCalibration({ reports }),
        (error) => error instanceof PerformanceCalibrationError && expected.test(error.message)
      )
    })
  }
})

describe('performance calibration CLI arguments', () => {
  it('requires exactly three child paths and derives a separate candidate path', () => {
    assert.deepEqual(parseArgs(['--output', '/tmp/calibration.json', 'a', 'b', 'c']), {
      reportPaths: ['a', 'b', 'c'],
      outputPath: '/tmp/calibration.json',
      budgetCandidatePath: '/tmp/calibration.budget-candidate.json'
    })
    assert.throws(() => parseArgs(['a', 'b']), /exactly 3 detailed child report paths/)
  })

  it('stores report references relative to the portable artifact bundle', () => {
    assert.deepEqual(
      portableCalibrationReportPaths({
        reportPaths: [
          '/tmp/evidence/run-1.child.json',
          '/tmp/evidence/run-2.child.json',
          '/tmp/evidence/run-3.child.json'
        ],
        outputPath: '/tmp/evidence/calibration.json'
      }),
      ['run-1.child.json', 'run-2.child.json', 'run-3.child.json']
    )
  })
})

describe('versioned performance budget schemas', () => {
  it('keeps candidates unenforced and reserves an explicit reviewed active shape', () => {
    const candidate = readJsonFixture(
      '../../config/performance-budgets/v1/budget-candidate.schema.json'
    )
    const active = readJsonFixture('../../config/performance-budgets/v1/active-budget.schema.json')

    assert.equal(candidate.properties.thresholds.type, 'null')
    assert.equal(candidate.properties.enforcement.const, 'disabled')
    assert.equal(active.properties.status.const, 'active')
    assert.equal(active.properties.kind.const, 'videorc.performance-budget-set')
    assert.ok(active.$defs.thresholds.required.includes('memoryMiB'))
    assert.ok(active.$defs.profile.required.includes('approval'))
  })
})

function calibrationReports() {
  return [detailedReport(1), detailedReport(2), detailedReport(3)]
}

function detailedReport(index) {
  const footprintGrowthBytes = index * MIB
  const firstRows = resourceRows(100 * MIB)
  const lastRows = resourceRows(100 * MIB + footprintGrowthBytes)
  const totalRss = memorySeries(index, 690)
  const ownedRss = memorySeries(index, 390)
  const detachedPreviewGeometry = completeDetachedPreviewGeometry()
  return {
    schemaVersion: 1,
    scenario: 'detached-native-preview',
    mode: 'gate',
    generatedAt: `2026-07-10T12:00:0${index}.000Z`,
    verdict: 'pass',
    checks: [{ ok: true, status: 'pass', message: 'truthful packaged native run' }],
    metadata: {
      capturedAt: `2026-07-10T11:59:5${index}.000Z`,
      commit: COMMIT,
      dirty: false,
      machineModel: 'Mac16,1',
      operatingSystem: {
        platform: 'darwin',
        release: '25.5.0',
        macosVersion: '26.5',
        arch: 'arm64'
      },
      displayScaleFactor: 2,
      profileClass: 'endurance',
      appVersion: '0.9.45',
      performanceWindow: { warmupMs: 60_000, measurementMs: 600_000, intervalMs: 1_000 },
      buildMode: 'packaged',
      expectedBuildMode: 'packaged',
      runNonce: `run-${index}-1234567890`,
      powerAssertion: 'caffeinate:-d,-i,-s',
      powerAssertionVerified: true,
      executable: {
        path: '/Applications/Videorc.app/Contents/MacOS/Videorc',
        sha256: EXECUTABLE_SHA256
      },
      packagePayload: {
        algorithm: 'sha256-packaged-code-manifest-v1',
        sha256: PACKAGE_PAYLOAD_SHA256
      },
      appRole: 'detached-native-preview',
      source: { width: 1280, height: 720, fps: 60 },
      outputs: [{ role: 'preview', width: 1280, height: 720, fps: 60 }],
      detachedPreviewGeometry: detachedPreviewCalibrationProvenance(detachedPreviewGeometry)
    },
    timing: { warmupMs: 60_000, measurementMs: 600_000, intervalMs: 1_000 },
    metrics: {
      teardownClean: true,
      sampling: {
        expectedSamples: 600,
        collectedSamples: 600,
        skippedDeadlineCount: 0,
        observations: Array.from({ length: 600 }, (_, sampleIndex) => ({
          sampleIndex,
          scheduledAtMs: sampleIndex * 1_000,
          observedAtMs: sampleIndex * 1_000 + 50
        })),
        maxSampleGapMs: 1_050,
        measurementElapsedMs: 600_000,
        powerAssertion: 'caffeinate:-d,-i,-s',
        powerAssertionVerified: true
      },
      detachedPreviewGeometry,
      pipeline: {
        frames: 35_400,
        framesPerSecond: 58 + index,
        wireKibPerSecond: 62 + index,
        presentFps: 58 + index,
        intervalP95Ms: 18 + index,
        intervalP99Ms: 22 + index,
        transport: 'native-surface',
        backing: 'cametal-layer',
        bounds: { scaleFactor: 2 },
        framePipeline: {
          consumer: 'native-preview',
          gpuReadbacks: 0,
          yuvFramesConverted: 0
        }
      },
      memory: {
        samples: 600,
        maxTotalRssKb: totalRss.max,
        maxOwnedRssKb: ownedRss.max,
        totalRss,
        ownedRss,
        roles: {
          backend: memoryRole(index),
          'electron-main': memoryRole(index),
          'electron-renderer': memoryRole(index),
          'electron-gpu': memoryRole(index)
        }
      },
      cpuAveragePercentByRole: {
        backend: 8 + index,
        'electron-main': 10 + index,
        'electron-renderer': 12 + index,
        'electron-gpu': 7 + index
      },
      cpuP95PercentByRole: {
        backend: 18 + index,
        'electron-main': 20 + index,
        'electron-renderer': 24 + index,
        'electron-gpu': 14 + index
      },
      resourceCheckpoints: {
        first: { rows: firstRows },
        last: { rows: lastRows },
        comparison: {
          processContinuity: { comparable: true },
          metrics: {
            physicalFootprintBytes: {
              comparable: true,
              first: total(firstRows, 'physicalFootprintBytes'),
              last: total(lastRows, 'physicalFootprintBytes'),
              delta: footprintGrowthBytes * firstRows.length
            },
            openFileCount: { comparable: true, first: 40, last: 40, delta: 0 }
          }
        }
      },
      thresholds: { minSamples: 600, minDurationMs: 599_000 }
    }
  }
}

function completeDetachedPreviewGeometry({ scaleFactor = 2 } = {}) {
  const phases = Object.fromEntries(
    Object.entries(DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS).map(
      ([phaseName, requiredSamples]) => {
        const samples = Array.from({ length: requiredSamples }, (_, index) => ({
          observedAt: `2026-07-10T12:00:${String(index).padStart(2, '0')}.000Z`,
          ...inspectDetachedPreviewCalibrationSample(
            {
              open: true,
              visible: true,
              mode: 'floating',
              nativeOwnsPlacement: true,
              contentBounds: { x: 100, y: 128, width: 960, height: 540 }
            },
            {
              state: 'live',
              transport: 'native-surface',
              backing: 'cametal-layer',
              bounds: {
                screenX: 100,
                screenY: 128,
                width: 960,
                height: 540,
                scaleFactor,
                visible: true
              }
            }
          )
        }))
        return [
          phaseName,
          {
            phase: phaseName,
            requiredSamples,
            attempts: requiredSamples,
            pass: true,
            failure: null,
            samples
          }
        ]
      }
    )
  )
  return createDetachedPreviewCalibrationEvidence(phases)
}

function memorySeries(index, baseMiB) {
  return {
    samples: 600,
    startAtMs: 1_000,
    endAtMs: 600_000,
    durationMs: 599_000,
    min: baseMiB * 1024,
    max: (baseMiB + 10 + index) * 1024,
    firstMedian: baseMiB * 1024,
    lastMedian: (baseMiB + index * 2) * 1024,
    plateauGrowth: index * 2 * 1024,
    slopePerMinute: index * 1024,
    secondHalfSlopePerMinute: index * 512
  }
}

function shortSentinelReport(report) {
  report.metadata.profileClass = 'short-sentinel'
  report.metadata.performanceWindow.measurementMs = 120_000
  report.timing.measurementMs = 120_000
  report.metrics.memory.samples = 120
  for (const series of [report.metrics.memory.totalRss, report.metrics.memory.ownedRss]) {
    series.samples = 120
    series.endAtMs = 120_000
    series.durationMs = 119_000
  }
  for (const role of Object.values(report.metrics.memory.roles)) role.rssSamples = 120
  report.metrics.sampling = {
    ...report.metrics.sampling,
    expectedSamples: 120,
    collectedSamples: 120,
    observations: Array.from({ length: 120 }, (_, sampleIndex) => ({
      sampleIndex,
      scheduledAtMs: sampleIndex * 1_000,
      observedAtMs: sampleIndex * 1_000 + 50
    })),
    maxSampleGapMs: 1_050,
    measurementElapsedMs: 120_000
  }
  return report
}

function memoryRole(index) {
  return {
    maxCount: 1,
    maxRssKb: (100 + index) * 1024,
    firstMedianRssKb: 90 * 1024,
    lastMedianRssKb: (90 + index * 2) * 1024,
    plateauGrowthRssKb: index * 2 * 1024,
    slopeRssKbPerMinute: index * 1024,
    secondHalfSlopeRssKbPerMinute: index * 512,
    rssSamples: 600,
    minMeasuredCount: 1,
    maxMeasuredCount: 1
  }
}

function resourceRows(baseBytes) {
  return ['backend', 'electron-main', 'electron-renderer', 'electron-gpu'].map((role, index) => ({
    pid: 100 + index,
    role,
    physicalFootprintBytes: baseBytes,
    openFileCount: 10
  }))
}

function total(rows, key) {
  return rows.reduce((sum, row) => sum + row[key], 0)
}

function readJsonFixture(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
}
