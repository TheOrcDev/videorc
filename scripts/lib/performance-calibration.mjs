import { createHash } from 'node:crypto'

import { PERFORMANCE_REPORT_SCHEMA_VERSION } from './performance-contract.mjs'
import {
  detachedPreviewCalibrationProvenance,
  DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS,
  DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE,
  DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE
} from './detached-preview-calibration.mjs'
import {
  performanceSamplingEvidenceFailures,
  performanceSamplingInvariants
} from './performance-sampling-schedule.mjs'

export const PERFORMANCE_CALIBRATION_SCHEMA_VERSION = 1
export const PERFORMANCE_BUDGET_CANDIDATE_SCHEMA_VERSION = 1
export const PERFORMANCE_CALIBRATION_RUN_COUNT = 3
export const PERFORMANCE_CALIBRATION_MIN_WARMUP_MS = 60_000
export const PERFORMANCE_CALIBRATION_MIN_MEASUREMENT_MS = 600_000
export const PERFORMANCE_CALIBRATION_MIN_SHORT_MEASUREMENT_MS = 120_000

// These are comparability tolerances, not product performance budgets. Three
// 10-minute runs that spread beyond these bands represent materially different
// host/load conditions and must be repeated instead of being averaged together.
// Signed trend metrics use the run's RSS/footprint as their scale so tiny
// positive/negative allocator noise around zero remains comparable.
export const PERFORMANCE_CALIBRATION_COMPARABILITY_POLICY = Object.freeze({
  maxCadenceRelativeRange: 0.1,
  maxLatencyRelativeRange: 0.25,
  maxRssRelativeRange: 0.15,
  maxRoleRssRelativeRange: 0.2,
  maxFootprintRelativeRange: 0.15,
  maxTrendRangeFractionOfMemoryScale: 0.05,
  nearZeroTrendFractionOfMemoryScale: 0.01
})

const PREVIEW_SCENARIOS = new Set([
  'docked-native-preview',
  'detached-native-preview',
  'studio-live-mic-visuals'
])
const DETACHED_PREVIEW_SCENARIO = 'detached-native-preview'
const RECORDING_SCENARIOS = new Set([
  'real-devices-1080p',
  'record-1080p60',
  'record-vertical-4k30',
  'record-4k',
  'record-4k-stream-1080p'
])
const LIFECYCLE_SCENARIOS = new Set(['lifecycle-churn'])
const SUPPORTED_SCENARIOS = new Set([
  ...PREVIEW_SCENARIOS,
  ...RECORDING_SCENARIOS,
  ...LIFECYCLE_SCENARIOS
])
const REQUIRED_MEMORY_ROLES = ['backend', 'electron-main', 'electron-renderer']
const SERIES_FIELDS = [
  'samples',
  'durationMs',
  'min',
  'max',
  'firstMedian',
  'lastMedian',
  'plateauGrowth',
  'slopePerMinute',
  'secondHalfSlopePerMinute'
]
const ROLE_FIELDS = [
  'maxCount',
  'maxRssKb',
  'firstMedianRssKb',
  'lastMedianRssKb',
  'plateauGrowthRssKb',
  'slopeRssKbPerMinute',
  'secondHalfSlopeRssKbPerMinute',
  'rssSamples',
  'minMeasuredCount',
  'maxMeasuredCount'
]

export class PerformanceCalibrationError extends Error {
  constructor(failures) {
    super(`Performance calibration reports were not comparable:\n${failures.join('\n')}`)
    this.name = 'PerformanceCalibrationError'
    this.failures = failures
  }
}

export function aggregatePackagedPerformanceCalibration({ reports, reportPaths = [] }) {
  const failures = validatePackagedPerformanceCalibrationReports(reports)
  if (failures.length > 0) throw new PerformanceCalibrationError(failures)

  const generatedAt = new Date().toISOString()
  const first = reports[0]
  const roleNames = Object.keys(first.metrics.memory.roles).sort()
  const cpuRoleNames = Object.keys(first.metrics.cpuAveragePercentByRole).sort()
  const cadence = LIFECYCLE_SCENARIOS.has(first.scenario)
    ? {}
    : {
        presentFps: observedMetric(reports, (report) => report.metrics.pipeline.presentFps, 'fps'),
        measuredFramesPerSecond: observedMetric(
          reports,
          (report) => report.metrics.pipeline.framesPerSecond,
          'fps'
        ),
        intervalP95Ms: observedMetric(
          reports,
          (report) => report.metrics.pipeline.intervalP95Ms,
          'ms'
        ),
        intervalP99Ms: observedMetric(
          reports,
          (report) => report.metrics.pipeline.intervalP99Ms,
          'ms'
        )
      }
  if (PREVIEW_SCENARIOS.has(first.scenario)) {
    cadence.wireKibPerSecond = observedMetric(
      reports,
      (report) => report.metrics.pipeline.wireKibPerSecond,
      'KiB/s'
    )
  }
  const observed = {
    cadence,
    memoryMiB: {
      maximumTotalRss: observedMetric(
        reports,
        (report) => report.metrics.memory.maxTotalRssKb / 1024,
        'MiB'
      ),
      maximumOwnedRss: observedMetric(
        reports,
        (report) => report.metrics.memory.maxOwnedRssKb / 1024,
        'MiB'
      ),
      totalRss: observedMemorySeries(reports, 'totalRss'),
      ownedRss: observedMemorySeries(reports, 'ownedRss'),
      perRole: Object.fromEntries(
        roleNames.map((role) => [role, observedMemoryRole(reports, role)])
      )
    },
    cpuAveragePercentByRole: Object.fromEntries(
      cpuRoleNames.map((role) => [
        role,
        observedMetric(reports, (report) => report.metrics.cpuAveragePercentByRole[role], 'percent')
      ])
    ),
    cpuPercentByRole: Object.fromEntries(
      cpuRoleNames.map((role) => [
        role,
        {
          average: observedMetric(
            reports,
            (report) => report.metrics.cpuAveragePercentByRole[role],
            'percent'
          ),
          p95: observedMetric(
            reports,
            (report) => report.metrics.cpuP95PercentByRole[role],
            'percent'
          )
        }
      ])
    ),
    resources: observedResources(reports, roleNames)
  }
  const provenance = {
    commit: first.metadata.commit,
    executableSha256: first.metadata.executable.sha256,
    packagePayloadSha256: first.metadata.packagePayload.sha256,
    machineModel: first.metadata.machineModel,
    hardwareClass: first.metadata.hardwareClass ?? null,
    operatingSystem: first.metadata.operatingSystem,
    displayScaleFactor: effectiveDisplayScaleFactor(first),
    profileClass: first.metadata.profileClass,
    appVersion: first.metadata.appVersion,
    buildMode: 'packaged',
    powerAssertion: first.metadata.powerAssertion,
    powerAssertionVerified: first.metadata.powerAssertionVerified,
    appRole: first.metadata.appRole,
    source: first.metadata.source,
    outputs: first.metadata.outputs,
    ...(first.scenario === DETACHED_PREVIEW_SCENARIO
      ? { detachedPreviewGeometry: first.metadata.detachedPreviewGeometry }
      : {})
  }
  const timing = calibrationTiming(first)
  const runs = reports.map((report, index) => ({
    index: index + 1,
    reportPath: reportPaths[index] ?? null,
    generatedAt: report.generatedAt,
    runNonce: report.metadata.runNonce,
    samples: report.metrics.memory.samples,
    measurementDurationMs: report.metrics.memory.ownedRss.durationMs,
    teardownClean: report.metrics.teardownClean
  }))
  const calibrationId = calibrationIdentifier({ provenance, timing, runs })
  const summary = {
    schemaVersion: PERFORMANCE_CALIBRATION_SCHEMA_VERSION,
    kind: 'videorc.performance-calibration',
    generatedAt,
    calibrationId,
    scenario: first.scenario,
    runCount: reports.length,
    provenance,
    timing,
    comparabilityPolicy: PERFORMANCE_CALIBRATION_COMPARABILITY_POLICY,
    runs,
    observed
  }
  return {
    summary,
    budgetCandidate: createPerformanceBudgetCandidate(summary)
  }
}

export function validatePackagedPerformanceCalibrationReports(reports) {
  if (!Array.isArray(reports) || reports.length !== PERFORMANCE_CALIBRATION_RUN_COUNT) {
    return [
      `expected exactly ${PERFORMANCE_CALIBRATION_RUN_COUNT} detailed child reports; received ${Array.isArray(reports) ? reports.length : 0}`
    ]
  }

  const failures = reports.flatMap((report, index) => validateDetailedReport(report, index))
  if (failures.length > 0) return failures

  const first = reports[0]
  const consistentFields = [
    ['scenario', (report) => report.scenario],
    ['commit', (report) => report.metadata.commit],
    ['executable SHA-256', (report) => report.metadata.executable.sha256],
    ['packaged app payload SHA-256', (report) => report.metadata.packagePayload.sha256],
    ['machine model', (report) => report.metadata.machineModel],
    ['hardware class', (report) => report.metadata.hardwareClass ?? null],
    ['operating system', (report) => report.metadata.operatingSystem],
    ['display scale', (report) => effectiveDisplayScaleFactor(report)],
    ['profile class', (report) => report.metadata.profileClass],
    ['app version', (report) => report.metadata.appVersion],
    ['power assertion', (report) => report.metadata.powerAssertion],
    ['power assertion verification', (report) => report.metadata.powerAssertionVerified],
    ['app role', (report) => report.metadata.appRole],
    ['source', (report) => report.metadata.source],
    ['outputs', (report) => report.metadata.outputs],
    ['timing', (report) => calibrationTiming(report)],
    ['memory roles', (report) => Object.keys(report.metrics.memory.roles).sort()],
    ['CPU roles', (report) => Object.keys(report.metrics.cpuAveragePercentByRole).sort()],
    ['CPU p95 roles', (report) => Object.keys(report.metrics.cpuP95PercentByRole).sort()],
    ['measurement thresholds', (report) => report.metrics.thresholds]
  ]
  if (first.scenario === DETACHED_PREVIEW_SCENARIO) {
    consistentFields.push([
      'detached preview geometry',
      (report) => report.metadata.detachedPreviewGeometry
    ])
  }
  for (const [label, select] of consistentFields) {
    const expected = stableJson(select(first))
    reports.slice(1).forEach((report, index) => {
      if (stableJson(select(report)) !== expected) {
        failures.push(`run ${index + 2} ${label} did not match run 1`)
      }
    })
  }

  const nonces = reports.map((report) => report.metadata.runNonce)
  if (new Set(nonces).size !== PERFORMANCE_CALIBRATION_RUN_COUNT) {
    failures.push('performance run nonces were not unique across all three reports')
  }
  failures.push(...validateObservedComparability(reports))
  return failures
}

export function createPerformanceBudgetCandidate(calibration) {
  return {
    schemaVersion: PERFORMANCE_BUDGET_CANDIDATE_SCHEMA_VERSION,
    kind: 'videorc.performance-budget-candidate',
    status: 'candidate',
    enforcement: 'disabled',
    generatedAt: calibration.generatedAt,
    calibrationId: calibration.calibrationId,
    scope: {
      scenario: calibration.scenario,
      profileClass: calibration.provenance.profileClass,
      appVersion: calibration.provenance.appVersion,
      buildMode: calibration.provenance.buildMode,
      ...(calibration.provenance.hardwareClass
        ? { hardwareClass: calibration.provenance.hardwareClass }
        : { machineModel: calibration.provenance.machineModel }),
      operatingSystem: calibration.provenance.operatingSystem,
      displayScaleFactor: calibration.provenance.displayScaleFactor,
      appRole: calibration.provenance.appRole,
      source: calibration.provenance.source,
      outputs: calibration.provenance.outputs,
      timing: calibration.timing
    },
    evidence: {
      calibrationId: calibration.calibrationId,
      commit: calibration.provenance.commit,
      executableSha256: calibration.provenance.executableSha256,
      packagePayloadSha256: calibration.provenance.packagePayloadSha256,
      calibrationSha256: canonicalSha256(calibration),
      calibrationGeneratedAt: calibration.generatedAt,
      powerAssertion: calibration.provenance.powerAssertion,
      powerAssertionVerified: calibration.provenance.powerAssertionVerified,
      runCount: calibration.runCount,
      runNonces: calibration.runs.map((run) => run.runNonce),
      reportPaths: calibration.runs.map((run) => run.reportPath)
    },
    comparabilityPolicy: calibration.comparabilityPolicy,
    observed: calibration.observed,
    thresholds: null,
    activation: {
      reviewRequired: true,
      note: 'Observed values are evidence, not limits. Populate and review thresholds explicitly before wiring an active gate.'
    }
  }
}

function validateObservedComparability(reports) {
  const policy = PERFORMANCE_CALIBRATION_COMPARABILITY_POLICY
  const failures = []
  if (!LIFECYCLE_SCENARIOS.has(reports[0].scenario)) {
    addRelativeRangeFailure(
      failures,
      'present FPS',
      reports.map((report) => report.metrics.pipeline.presentFps),
      policy.maxCadenceRelativeRange
    )
    addRelativeRangeFailure(
      failures,
      'present interval p95',
      reports.map((report) => report.metrics.pipeline.intervalP95Ms),
      policy.maxLatencyRelativeRange
    )
  }
  addRelativeRangeFailure(
    failures,
    'owned RSS maximum',
    reports.map((report) => report.metrics.memory.maxOwnedRssKb),
    policy.maxRssRelativeRange
  )
  addRelativeRangeFailure(
    failures,
    'total RSS maximum',
    reports.map((report) => report.metrics.memory.maxTotalRssKb),
    policy.maxRssRelativeRange
  )

  for (const role of Object.keys(reports[0].metrics.memory.roles).sort()) {
    addRelativeRangeFailure(
      failures,
      `${role} RSS maximum`,
      reports.map((report) => report.metrics.memory.roles[role].maxRssKb),
      policy.maxRoleRssRelativeRange
    )
    const roleRssScale = median(reports.map((report) => report.metrics.memory.roles[role].maxRssKb))
    for (const [label, select] of [
      [
        `${role} RSS plateau growth`,
        (report) => report.metrics.memory.roles[role].plateauGrowthRssKb
      ],
      [`${role} RSS slope`, (report) => report.metrics.memory.roles[role].slopeRssKbPerMinute],
      [
        `${role} RSS second-half slope`,
        (report) => report.metrics.memory.roles[role].secondHalfSlopeRssKbPerMinute
      ]
    ]) {
      addSignedTrendSpreadFailure(failures, label, reports.map(select), roleRssScale, policy)
    }
  }

  const ownedRssScale = median(reports.map((report) => report.metrics.memory.maxOwnedRssKb))
  for (const [label, select] of [
    ['owned RSS plateau growth', (report) => report.metrics.memory.ownedRss.plateauGrowth],
    ['owned RSS slope', (report) => report.metrics.memory.ownedRss.slopePerMinute],
    [
      'owned RSS second-half slope',
      (report) => report.metrics.memory.ownedRss.secondHalfSlopePerMinute
    ]
  ]) {
    addSignedTrendSpreadFailure(failures, label, reports.map(select), ownedRssScale, policy)
  }

  for (const role of Object.keys(reports[0].metrics.cpuAveragePercentByRole).sort()) {
    for (const [label, field] of [
      [`${role} average CPU`, 'cpuAveragePercentByRole'],
      [`${role} p95 CPU`, 'cpuP95PercentByRole']
    ]) {
      addRelativeRangeFailure(
        failures,
        label,
        reports.map((report) => report.metrics[field][role]),
        policy.maxLatencyRelativeRange
      )
    }
  }

  const firstFootprints = reports.map(
    (report) => report.metrics.resourceCheckpoints.comparison.metrics.physicalFootprintBytes.first
  )
  const lastFootprints = reports.map(
    (report) => report.metrics.resourceCheckpoints.comparison.metrics.physicalFootprintBytes.last
  )
  addRelativeRangeFailure(
    failures,
    'initial physical footprint',
    firstFootprints,
    policy.maxFootprintRelativeRange
  )
  addRelativeRangeFailure(
    failures,
    'final physical footprint',
    lastFootprints,
    policy.maxFootprintRelativeRange
  )
  addSignedTrendSpreadFailure(
    failures,
    'physical footprint growth',
    reports.map(
      (report) => report.metrics.resourceCheckpoints.comparison.metrics.physicalFootprintBytes.delta
    ),
    median(firstFootprints),
    policy
  )
  return failures
}

function addRelativeRangeFailure(failures, label, values, maximumRelativeRange) {
  const center = Math.abs(median(values))
  const range = Math.max(...values) - Math.min(...values)
  const relativeRange = center > 0 ? range / center : range === 0 ? 0 : Number.POSITIVE_INFINITY
  if (relativeRange > maximumRelativeRange) {
    failures.push(
      `${label} relative range ${formatRatio(relativeRange)} exceeded the calibration comparability limit ${formatRatio(maximumRelativeRange)}`
    )
  }
}

function addSignedTrendSpreadFailure(failures, label, values, memoryScale, policy) {
  const rangeFraction = (Math.max(...values) - Math.min(...values)) / memoryScale
  if (rangeFraction > policy.maxTrendRangeFractionOfMemoryScale) {
    failures.push(
      `${label} range was ${formatRatio(rangeFraction)} of the memory scale; comparability limit ${formatRatio(policy.maxTrendRangeFractionOfMemoryScale)}`
    )
  }
  const nearZero = memoryScale * policy.nearZeroTrendFractionOfMemoryScale
  const signs = new Set(
    values.map((value) =>
      value > nearZero ? 'positive' : value < -nearZero ? 'negative' : 'near-zero'
    )
  )
  if (signs.has('positive') && signs.has('negative')) {
    failures.push(`${label} changed material sign across calibration runs`)
  }
}

export function formatPerformanceCalibrationSummary(calibration) {
  const observed = calibration.observed
  const lines = [
    `Calibration ${calibration.calibrationId}`,
    `${calibration.runCount} packaged ${calibration.scenario} runs on ${calibration.provenance.machineModel}`,
    `commit provenance ${calibration.provenance.commit}; executable ${calibration.provenance.executableSha256}; app payload ${calibration.provenance.packagePayloadSha256}`,
    `${calibration.provenance.profileClass} profile; app ${calibration.provenance.appVersion}; warm-up ${calibration.timing.warmupMs}ms; measurement ${calibration.timing.measurementMs}ms; interval ${calibration.timing.intervalMs}ms`,
    `owned RSS maximum median ${format(observed.memoryMiB.maximumOwnedRss.median)}MiB, max ${format(observed.memoryMiB.maximumOwnedRss.max)}MiB`,
    `owned RSS slope median ${format(observed.memoryMiB.ownedRss.slopePerMinute.median)}MiB/min, second-half ${format(observed.memoryMiB.ownedRss.secondHalfSlopePerMinute.median)}MiB/min`,
    `owned RSS plateau growth median ${format(observed.memoryMiB.ownedRss.plateauGrowth.median)}MiB`,
    `physical footprint growth median ${format(observed.resources.physicalFootprintMiB.growth.median)}MiB`
  ]
  if (observed.cadence.presentFps) {
    lines.splice(
      4,
      0,
      `present FPS median ${format(observed.cadence.presentFps.median)}, min ${format(observed.cadence.presentFps.min)}`,
      `interval p95 median ${format(observed.cadence.intervalP95Ms.median)}ms, max ${format(observed.cadence.intervalP95Ms.max)}ms`
    )
  }
  for (const [role, metrics] of Object.entries(observed.memoryMiB.perRole)) {
    lines.push(
      `${role}: max RSS median ${format(metrics.maximumRss.median)}MiB; slope ${format(metrics.slopePerMinute.median)}MiB/min; plateau ${format(metrics.plateauGrowth.median)}MiB`
    )
  }
  return lines.join('\n')
}

function validateDetailedReport(report, index) {
  const label = `run ${index + 1}`
  const failures = []
  if (report?.schemaVersion !== PERFORMANCE_REPORT_SCHEMA_VERSION) {
    failures.push(`${label} report schema version was missing or unsupported`)
  }
  if (!SUPPORTED_SCENARIOS.has(report?.scenario)) {
    failures.push(`${label} was not a supported detailed performance scenario`)
  }
  if (report?.mode !== 'gate' || report?.verdict !== 'pass') {
    failures.push(`${label} was not a passing gate report`)
  }
  if (!validIsoDate(report?.generatedAt)) failures.push(`${label} generatedAt was invalid`)
  if (!Array.isArray(report?.checks) || report.checks.length === 0) {
    failures.push(`${label} checks were missing`)
  } else if (report.checks.some((check) => check?.status !== 'pass' || check?.ok !== true)) {
    failures.push(`${label} contained a non-passing check`)
  }

  const metadata = report?.metadata
  if (metadata?.buildMode !== 'packaged' || metadata?.expectedBuildMode !== 'packaged') {
    failures.push(`${label} did not prove expected packaged build mode`)
  }
  if (!validGitCommit(metadata?.commit)) failures.push(`${label} commit was missing or invalid`)
  if (metadata?.dirty !== false) failures.push(`${label} commit provenance was dirty`)
  if (!nonEmptyString(metadata?.runNonce)) failures.push(`${label} run nonce was missing`)
  if (metadata?.powerAssertion !== 'caffeinate:-d,-i,-s') {
    failures.push(`${label} macOS display/system power assertion was missing or invalid`)
  }
  if (metadata?.powerAssertionVerified !== true) {
    failures.push(`${label} macOS display/system power assertion was not verified at runtime`)
  }
  if (!nonEmptyString(metadata?.machineModel)) failures.push(`${label} machine model was missing`)
  if (!validOperatingSystem(metadata?.operatingSystem)) {
    failures.push(`${label} macOS identity was missing or invalid`)
  }
  validateDisplayScaleFactor(report, label, failures)
  if (!validSha256(metadata?.executable?.sha256)) {
    failures.push(`${label} packaged executable SHA-256 was missing or invalid`)
  }
  if (!validSha256(metadata?.packagePayload?.sha256)) {
    failures.push(`${label} packaged app payload SHA-256 was missing or invalid`)
  }
  if (!nonEmptyString(metadata?.appRole)) failures.push(`${label} app role was missing`)
  if (!['short-sentinel', 'endurance'].includes(metadata?.profileClass)) {
    failures.push(`${label} profile class was missing or invalid`)
  }
  if (!nonEmptyString(metadata?.appVersion)) failures.push(`${label} app version was missing`)
  if (!validSource(metadata?.source)) failures.push(`${label} source metadata was incomplete`)
  if (!validOutputs(metadata?.outputs)) failures.push(`${label} output metadata was incomplete`)

  const timing = calibrationTiming(report)
  if (stableJson(metadata?.performanceWindow) !== stableJson(timing)) {
    failures.push(`${label} performance window identity did not match report timing`)
  }
  if (!finiteAtLeast(timing?.warmupMs, PERFORMANCE_CALIBRATION_MIN_WARMUP_MS)) {
    failures.push(`${label} warm-up was shorter than ${PERFORMANCE_CALIBRATION_MIN_WARMUP_MS}ms`)
  }
  const minimumMeasurementMs =
    metadata?.profileClass === 'short-sentinel'
      ? PERFORMANCE_CALIBRATION_MIN_SHORT_MEASUREMENT_MS
      : PERFORMANCE_CALIBRATION_MIN_MEASUREMENT_MS
  if (!finiteAtLeast(timing?.measurementMs, minimumMeasurementMs)) {
    failures.push(`${label} measurement was shorter than ${minimumMeasurementMs}ms`)
  }
  if (
    metadata?.profileClass === 'short-sentinel' &&
    Number.isFinite(timing?.measurementMs) &&
    timing.measurementMs >= PERFORMANCE_CALIBRATION_MIN_MEASUREMENT_MS
  ) {
    failures.push(`${label} short-sentinel measurement overlapped the endurance window`)
  }
  if (!positiveFinite(timing?.intervalMs)) failures.push(`${label} sample interval was invalid`)

  const metrics = report?.metrics
  if (metrics?.teardownClean !== true) failures.push(`${label} teardown was not clean`)
  if (!LIFECYCLE_SCENARIOS.has(report?.scenario)) {
    validatePipeline(metrics?.pipeline, report?.scenario, label, failures)
  }
  validateMemory(metrics?.memory, timing, label, failures)
  validateSampling(metrics?.sampling, metrics?.memory, timing, metadata, label, failures, {
    requirePowerAssertionBoundary: PREVIEW_SCENARIOS.has(report?.scenario)
  })
  if (report?.scenario === DETACHED_PREVIEW_SCENARIO) {
    validateDetachedPreviewGeometry(report, label, failures)
  }
  validateCpu(metrics?.cpuAveragePercentByRole, metrics?.cpuP95PercentByRole, label, failures)
  validateResources(metrics?.resourceCheckpoints, label, failures)
  if (!isRecord(metrics?.thresholds)) failures.push(`${label} measurement thresholds were missing`)
  return failures
}

function validateSampling(
  sampling,
  memory,
  timing,
  metadata,
  label,
  failures,
  { requirePowerAssertionBoundary }
) {
  if (!isRecord(sampling)) {
    failures.push(`${label} wall-clock sampling evidence was missing`)
    return
  }
  if (!positiveFinite(timing?.measurementMs) || !positiveFinite(timing?.intervalMs)) {
    return
  }
  failures.push(
    ...performanceSamplingEvidenceFailures(sampling, timing.measurementMs, timing.intervalMs).map(
      (failure) => `${label} ${failure}`
    )
  )
  if (sampling.collectedSamples !== memory?.samples) {
    failures.push(`${label} sampling collectedSamples disagreed with memory samples`)
  }
  if (requirePowerAssertionBoundary) {
    if (sampling.powerAssertion !== metadata?.powerAssertion) {
      failures.push(`${label} sampling power assertion disagreed with provenance`)
    }
    if (sampling.powerAssertionVerified !== true) {
      failures.push(`${label} sampling power assertion was not verified at measurement end`)
    }
  }
}

function validateDetachedPreviewGeometry(report, label, failures) {
  const evidence = report?.metrics?.detachedPreviewGeometry
  const provenance = report?.metadata?.detachedPreviewGeometry
  if (!isRecord(evidence)) {
    failures.push(`${label} detached preview geometry evidence was missing`)
    return
  }
  if (!isRecord(provenance)) {
    failures.push(`${label} detached preview geometry provenance was missing`)
  }

  const expectedContract = {
    mode: 'detached',
    surfaceSize: DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE,
    windowSize: DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE,
    phaseSampleCounts: DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS,
    transport: 'native-surface',
    backing: 'cametal-layer'
  }
  if (evidence.schemaVersion !== 1) {
    failures.push(`${label} detached preview geometry schema version was missing or unsupported`)
  }
  if (stableJson(evidence.contract) !== stableJson(expectedContract)) {
    failures.push(`${label} detached preview geometry contract was missing or inconsistent`)
  }
  if (evidence.pass !== true) {
    failures.push(`${label} detached preview geometry did not pass across the measurement boundary`)
  }
  if (!nonEmptyString(evidence.stabilityKey)) {
    failures.push(`${label} detached preview geometry stability key was missing`)
  }
  if (!Array.isArray(evidence.failures) || evidence.failures.length > 0) {
    failures.push(`${label} detached preview geometry contained failures`)
  }

  const expectedScaleFactor = effectiveDisplayScaleFactor(report)
  for (const [phaseName, requiredSamples] of Object.entries(
    DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS
  )) {
    validateDetachedPreviewGeometryPhase(
      evidence?.phases?.[phaseName],
      phaseName,
      requiredSamples,
      evidence.stabilityKey,
      expectedScaleFactor,
      label,
      failures
    )
  }

  if (isRecord(provenance) && Array.isArray(evidence?.phases?.measurementEnd?.samples)) {
    const derivedProvenance = detachedPreviewCalibrationProvenance(evidence)
    if (stableJson(provenance) !== stableJson(derivedProvenance)) {
      failures.push(
        `${label} detached preview geometry provenance disagreed with detailed evidence`
      )
    }
    if (provenance.scaleFactor !== expectedScaleFactor) {
      failures.push(`${label} detached preview geometry scale disagreed with display provenance`)
    }
  }
}

function validateDetachedPreviewGeometryPhase(
  phase,
  phaseName,
  requiredSamples,
  stabilityKey,
  expectedScaleFactor,
  label,
  failures
) {
  if (!isRecord(phase)) {
    failures.push(`${label} detached preview geometry ${phaseName} phase was missing`)
    return
  }
  if (
    phase.phase !== phaseName ||
    phase.requiredSamples !== requiredSamples ||
    phase.pass !== true ||
    phase.failure !== null
  ) {
    failures.push(`${label} detached preview geometry ${phaseName} phase did not pass its contract`)
  }
  if (!Number.isInteger(phase.attempts) || phase.attempts < requiredSamples) {
    failures.push(`${label} detached preview geometry ${phaseName} attempts were incomplete`)
  }
  if (!Array.isArray(phase.samples) || phase.samples.length < requiredSamples) {
    failures.push(
      `${label} detached preview geometry ${phaseName} captured ${phase?.samples?.length ?? 0}/${requiredSamples} required samples`
    )
    return
  }
  phase.samples.forEach((sample, index) => {
    validateDetachedPreviewGeometrySample(
      sample,
      `${label} detached preview geometry ${phaseName} sample ${index + 1}`,
      stabilityKey,
      expectedScaleFactor,
      failures
    )
  })
}

function validateDetachedPreviewGeometrySample(
  sample,
  sampleLabel,
  stabilityKey,
  expectedScaleFactor,
  failures
) {
  if (!isRecord(sample) || sample.ready !== true) {
    failures.push(`${sampleLabel} was not ready`)
    return
  }
  if (!Array.isArray(sample.failures) || sample.failures.length > 0) {
    failures.push(`${sampleLabel} contained inspection failures`)
  }
  if (sample.stabilityKey !== stabilityKey) {
    failures.push(`${sampleLabel} stability key did not match the run geometry`)
  }

  const previewBounds = sample.previewBounds
  const nativeBounds = sample.nativeBounds
  if (!exactDetachedPreviewBounds(previewBounds)) {
    failures.push(`${sampleLabel} preview bounds were not exact 960x540 geometry`)
  }
  if (!exactDetachedPreviewBounds(nativeBounds)) {
    failures.push(`${sampleLabel} native bounds were not exact 960x540 geometry`)
  }
  if (
    !isRecord(previewBounds) ||
    !isRecord(nativeBounds) ||
    previewBounds.x !== nativeBounds.x ||
    previewBounds.y !== nativeBounds.y
  ) {
    failures.push(`${sampleLabel} preview and native origins were not aligned`)
  }

  const window = sample.window
  if (
    window?.open !== true ||
    window?.visible !== true ||
    window?.mode !== 'floating' ||
    window?.nativeOwnsPlacement !== true
  ) {
    failures.push(`${sampleLabel} detached preview window was not open, visible, and native-owned`)
  }
  const surface = sample.surface
  if (
    surface?.state !== 'live' ||
    surface?.transport !== 'native-surface' ||
    surface?.backing !== 'cametal-layer' ||
    surface?.visible !== true
  ) {
    failures.push(`${sampleLabel} native surface was not live, visible CAMetalLayer geometry`)
  }
  if (!positiveFinite(surface?.scaleFactor) || surface.scaleFactor !== expectedScaleFactor) {
    failures.push(`${sampleLabel} native surface scale disagreed with display provenance`)
  }

  const derivedStabilityKey = JSON.stringify({
    previewBounds,
    nativeBounds,
    scaleFactor: surface?.scaleFactor
  })
  if (sample.stabilityKey !== derivedStabilityKey) {
    failures.push(`${sampleLabel} stability key disagreed with its geometry fields`)
  }
}

function exactDetachedPreviewBounds(bounds) {
  return (
    isRecord(bounds) &&
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    bounds.width === DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE.width &&
    bounds.height === DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE.height
  )
}

function validatePipeline(pipeline, scenario, label, failures) {
  for (const field of [
    'frames',
    'framesPerSecond',
    'presentFps',
    'intervalP95Ms',
    'intervalP99Ms'
  ]) {
    if (!Number.isFinite(pipeline?.[field])) failures.push(`${label} pipeline.${field} was missing`)
  }
  if (!(pipeline?.frames > 0)) failures.push(`${label} frame progress was missing`)
  if (pipeline?.transport !== 'native-surface' || pipeline?.backing !== 'cametal-layer') {
    failures.push(`${label} did not prove native CAMetalLayer presentation`)
  }
  if (PREVIEW_SCENARIOS.has(scenario)) {
    if (!Number.isFinite(pipeline?.wireKibPerSecond)) {
      failures.push(`${label} pipeline.wireKibPerSecond was missing`)
    }
    const framePipeline = pipeline?.framePipeline
    if (
      framePipeline?.consumer !== 'native-preview' ||
      framePipeline?.gpuReadbacks !== 0 ||
      framePipeline?.yuvFramesConverted !== 0
    ) {
      failures.push(`${label} native frame-pipeline metrics were missing or inconsistent`)
    }
  }
}

function calibrationTiming(report) {
  return {
    warmupMs: report?.timing?.warmupMs,
    measurementMs: report?.timing?.measurementMs,
    intervalMs:
      report?.timing?.intervalMs ??
      report?.timing?.sampleIntervalMs ??
      report?.metrics?.processEndurance?.timing?.intervalMs
  }
}

function effectiveDisplayScaleFactor(report) {
  const metadataScaleFactor = report?.metadata?.displayScaleFactor
  return metadataScaleFactor === null || metadataScaleFactor === undefined
    ? report?.metrics?.pipeline?.bounds?.scaleFactor
    : metadataScaleFactor
}

function validateDisplayScaleFactor(report, label, failures) {
  const metadataScaleFactor = report?.metadata?.displayScaleFactor
  const observedScaleFactor = report?.metrics?.pipeline?.bounds?.scaleFactor
  const hasMetadataScaleFactor = metadataScaleFactor !== null && metadataScaleFactor !== undefined
  const hasObservedScaleFactor = observedScaleFactor !== null && observedScaleFactor !== undefined

  if (hasMetadataScaleFactor && !positiveFinite(metadataScaleFactor)) {
    failures.push(`${label} metadata display scale factor was nonpositive or invalid`)
  }
  if (hasObservedScaleFactor && !positiveFinite(observedScaleFactor)) {
    failures.push(`${label} pipeline bounds scale factor was nonpositive or invalid`)
  }
  if (!positiveFinite(effectiveDisplayScaleFactor(report))) {
    failures.push(`${label} effective display scale factor was missing or invalid`)
  }
  if (
    positiveFinite(metadataScaleFactor) &&
    positiveFinite(observedScaleFactor) &&
    Math.abs(metadataScaleFactor - observedScaleFactor) > Number.EPSILON
  ) {
    failures.push(
      `${label} metadata display scale factor ${metadataScaleFactor} disagreed with pipeline bounds scale factor ${observedScaleFactor}`
    )
  }
}

function validateMemory(memory, timing, label, failures) {
  for (const field of ['samples', 'maxTotalRssKb', 'maxOwnedRssKb']) {
    if (!Number.isFinite(memory?.[field])) failures.push(`${label} memory.${field} was missing`)
  }
  for (const name of ['totalRss', 'ownedRss']) {
    for (const field of SERIES_FIELDS) {
      if (!Number.isFinite(memory?.[name]?.[field])) {
        failures.push(`${label} memory.${name}.${field} was missing`)
      }
    }
  }
  const samplingInvariants =
    positiveFinite(timing?.measurementMs) && positiveFinite(timing?.intervalMs)
      ? performanceSamplingInvariants(timing.measurementMs, timing.intervalMs)
      : null
  const minimumDuration = samplingInvariants?.minDurationMs ?? 0
  const minimumSamples = samplingInvariants?.minSamples ?? 0
  for (const name of ['totalRss', 'ownedRss']) {
    if ((memory?.[name]?.durationMs ?? 0) < minimumDuration) {
      failures.push(`${label} memory.${name} did not cover the declared duration`)
    }
    if ((memory?.[name]?.samples ?? 0) < minimumSamples) {
      failures.push(`${label} memory.${name} did not contain the declared sample count`)
    }
  }
  if ((memory?.samples ?? 0) < minimumSamples) {
    failures.push(`${label} memory sample count did not cover the declared duration`)
  }
  if (
    Number.isFinite(memory?.maxTotalRssKb) &&
    Number.isFinite(memory?.totalRss?.max) &&
    memory.maxTotalRssKb !== memory.totalRss.max
  ) {
    failures.push(`${label} total RSS maximum disagreed with its detailed series`)
  }
  if (
    Number.isFinite(memory?.maxOwnedRssKb) &&
    Number.isFinite(memory?.ownedRss?.max) &&
    memory.maxOwnedRssKb !== memory.ownedRss.max
  ) {
    failures.push(`${label} owned RSS maximum disagreed with its detailed series`)
  }
  if (!isRecord(memory?.roles)) {
    failures.push(`${label} per-role memory metrics were missing`)
    return
  }
  for (const role of REQUIRED_MEMORY_ROLES) {
    if (!isRecord(memory.roles[role])) failures.push(`${label} ${role} memory metrics were missing`)
  }
  for (const [role, roleMetrics] of Object.entries(memory.roles)) {
    for (const field of ROLE_FIELDS) {
      if (!Number.isFinite(roleMetrics?.[field])) {
        failures.push(`${label} memory.roles.${role}.${field} was missing`)
      }
    }
  }
}

function validateCpu(cpuAverage, cpuP95, label, failures) {
  if (!isRecord(cpuAverage) || !isRecord(cpuP95)) {
    failures.push(`${label} per-role CPU metrics were missing`)
    return
  }
  for (const role of REQUIRED_MEMORY_ROLES) {
    if (!Number.isFinite(cpuAverage[role])) {
      failures.push(`${label} ${role} CPU average metric was missing`)
    }
    if (!Number.isFinite(cpuP95[role])) failures.push(`${label} ${role} CPU p95 metric was missing`)
  }
  for (const [role, value] of Object.entries(cpuAverage)) {
    if (!Number.isFinite(value))
      failures.push(`${label} CPU average metric for ${role} was invalid`)
  }
  for (const [role, value] of Object.entries(cpuP95)) {
    if (!Number.isFinite(value)) failures.push(`${label} CPU p95 metric for ${role} was invalid`)
    if (Number.isFinite(value) && Number.isFinite(cpuAverage[role]) && value < cpuAverage[role]) {
      failures.push(`${label} ${role} CPU p95 was below its average`)
    }
  }
}

function validateResources(checkpoints, label, failures) {
  const comparison = checkpoints?.comparison
  if (comparison?.processContinuity?.comparable !== true) {
    failures.push(`${label} resource process continuity was not comparable`)
  }
  for (const metric of ['physicalFootprintBytes', 'openFileCount']) {
    const value = comparison?.metrics?.[metric]
    if (
      value?.comparable !== true ||
      !Number.isFinite(value?.first) ||
      !Number.isFinite(value?.last) ||
      !Number.isFinite(value?.delta)
    ) {
      failures.push(`${label} ${metric} checkpoints were missing or not comparable`)
    } else if (value.delta !== value.last - value.first) {
      failures.push(`${label} ${metric} checkpoint delta was internally inconsistent`)
    }
  }
  for (const checkpointName of ['first', 'last']) {
    const checkpoint = checkpoints?.[checkpointName]
    if (!Array.isArray(checkpoint?.rows) || checkpoint.rows.length === 0) {
      failures.push(`${label} ${checkpointName} resource rows were missing`)
      continue
    }
    for (const row of checkpoint.rows) {
      if (
        !nonEmptyString(row?.role) ||
        !Number.isFinite(row?.physicalFootprintBytes) ||
        !Number.isFinite(row?.openFileCount)
      ) {
        failures.push(`${label} ${checkpointName} resource row was incomplete`)
      }
    }
    for (const metric of ['physicalFootprintBytes', 'openFileCount']) {
      const rowTotal = checkpoint.rows.reduce((total, row) => total + row[metric], 0)
      const reportedTotal = comparison?.metrics?.[metric]?.[checkpointName]
      if (Number.isFinite(reportedTotal) && rowTotal !== reportedTotal) {
        failures.push(`${label} ${checkpointName} ${metric} total disagreed with resource rows`)
      }
    }
  }
}

function observedMemorySeries(reports, seriesName) {
  const select = (field) => (report) => report.metrics.memory[seriesName][field] / 1024
  return {
    firstWindowMedian: observedMetric(reports, select('firstMedian'), 'MiB'),
    lastWindowMedian: observedMetric(reports, select('lastMedian'), 'MiB'),
    maximum: observedMetric(reports, select('max'), 'MiB'),
    plateauGrowth: observedMetric(reports, select('plateauGrowth'), 'MiB'),
    slopePerMinute: observedMetric(reports, select('slopePerMinute'), 'MiB/min'),
    secondHalfSlopePerMinute: observedMetric(reports, select('secondHalfSlopePerMinute'), 'MiB/min')
  }
}

function observedMemoryRole(reports, role) {
  const select = (field, divisor = 1024) =>
    observedMetric(reports, (report) => report.metrics.memory.roles[role][field] / divisor, 'MiB')
  return {
    maximumCount: observedMetric(
      reports,
      (report) => report.metrics.memory.roles[role].maxCount,
      'processes'
    ),
    maximumRss: select('maxRssKb'),
    firstWindowMedianRss: select('firstMedianRssKb'),
    lastWindowMedianRss: select('lastMedianRssKb'),
    plateauGrowth: select('plateauGrowthRssKb'),
    slopePerMinute: {
      ...select('slopeRssKbPerMinute'),
      unit: 'MiB/min'
    },
    secondHalfSlopePerMinute: {
      ...select('secondHalfSlopeRssKbPerMinute'),
      unit: 'MiB/min'
    }
  }
}

function observedResources(reports, roleNames) {
  const footprint = (checkpoint, role) => (report) => {
    const rows = report.metrics.resourceCheckpoints[checkpoint].rows
    return (
      rows
        .filter((row) => !role || row.role === role)
        .reduce((total, row) => total + row.physicalFootprintBytes, 0) /
      (1024 * 1024)
    )
  }
  const openFiles = (checkpoint) => (report) =>
    report.metrics.resourceCheckpoints[checkpoint].rows.reduce(
      (total, row) => total + row.openFileCount,
      0
    )
  return {
    physicalFootprintMiB: {
      first: observedMetric(reports, footprint('first'), 'MiB'),
      last: observedMetric(reports, footprint('last'), 'MiB'),
      growth: observedMetric(
        reports,
        (report) =>
          report.metrics.resourceCheckpoints.comparison.metrics.physicalFootprintBytes.delta /
          (1024 * 1024),
        'MiB'
      ),
      perRole: Object.fromEntries(
        roleNames.map((role) => [
          role,
          {
            first: observedMetric(reports, footprint('first', role), 'MiB'),
            last: observedMetric(reports, footprint('last', role), 'MiB'),
            growth: observedMetric(
              reports,
              (report) => footprint('last', role)(report) - footprint('first', role)(report),
              'MiB'
            )
          }
        ])
      )
    },
    openFileCount: {
      first: observedMetric(reports, openFiles('first'), 'files'),
      last: observedMetric(reports, openFiles('last'), 'files'),
      growth: observedMetric(
        reports,
        (report) => report.metrics.resourceCheckpoints.comparison.metrics.openFileCount.delta,
        'files'
      )
    }
  }
}

function observedMetric(reports, select, unit) {
  const values = reports.map(select)
  return {
    unit,
    values,
    min: Math.min(...values),
    median: median(values),
    max: Math.max(...values)
  }
}

function calibrationIdentifier({ provenance, timing, runs }) {
  return createHash('sha256')
    .update(
      stableJson({
        commit: provenance.commit,
        executableSha256: provenance.executableSha256,
        packagePayloadSha256: provenance.packagePayloadSha256,
        machineModel: provenance.machineModel,
        hardwareClass: provenance.hardwareClass,
        profileClass: provenance.profileClass,
        appVersion: provenance.appVersion,
        operatingSystem: provenance.operatingSystem,
        timing,
        runNonces: runs.map((run) => run.runNonce)
      })
    )
    .digest('hex')
    .slice(0, 24)
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[1]
}

function canonicalSha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function format(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function formatRatio(value) {
  return Number.isFinite(value) ? value.toFixed(3) : 'infinite'
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validOperatingSystem(value) {
  return (
    isRecord(value) &&
    value.platform === 'darwin' &&
    nonEmptyString(value.release) &&
    nonEmptyString(value.macosVersion) &&
    nonEmptyString(value.arch)
  )
}

function validSource(value) {
  return (
    isRecord(value) &&
    positiveFinite(value.width) &&
    positiveFinite(value.height) &&
    positiveFinite(value.fps)
  )
}

function validOutputs(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (output) =>
        nonEmptyString(output?.role) &&
        positiveFinite(output?.width) &&
        positiveFinite(output?.height) &&
        positiveFinite(output?.fps)
    )
  )
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0
}

function finiteAtLeast(value, minimum) {
  return Number.isFinite(value) && value >= minimum
}

function validIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validGitCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)
}

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}
