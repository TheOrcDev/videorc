import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export const ACTIVE_PERFORMANCE_BUDGET_SCHEMA_VERSION = 1
export const CROSS_MACHINE_NATIVE_CADENCE = loadCrossMachineNativeCadence()

const REQUIRED_ROLES = ['backend', 'electron-main', 'electron-renderer']

export class ActivePerformanceBudgetError extends Error {
  constructor(failures) {
    super(`Active performance budget was invalid or did not match:\n${failures.join('\n')}`)
    this.name = 'ActivePerformanceBudgetError'
    this.failures = failures
  }
}

export function activePerformanceBudgetRequest(env = process.env) {
  const path = nonEmptyString(env.VIDEORC_PERF_ACTIVE_BUDGET_PATH)
  const profileId = nonEmptyString(env.VIDEORC_PERF_ACTIVE_BUDGET_PROFILE)
  const required = env.VIDEORC_PERF_REQUIRE_ACTIVE_BUDGET === '1'
  if (profileId && !path) {
    throw new ActivePerformanceBudgetError([
      'VIDEORC_PERF_ACTIVE_BUDGET_PROFILE requires VIDEORC_PERF_ACTIVE_BUDGET_PATH'
    ])
  }
  if (required && !path) {
    throw new ActivePerformanceBudgetError([
      'VIDEORC_PERF_ACTIVE_BUDGET_PATH is required for this performance gate'
    ])
  }
  return path ? { path, profileId } : null
}

export async function readActivePerformanceBudget({ path, read = readFile }) {
  let document
  try {
    document = JSON.parse(await read(path, 'utf8'))
  } catch (error) {
    throw new ActivePerformanceBudgetError([
      `could not read active budget ${path}: ${error?.message ?? String(error)}`
    ])
  }
  const failures = validateActivePerformanceBudgetDocument(document)
  if (failures.length > 0) throw new ActivePerformanceBudgetError(failures)
  return Object.freeze({ path, document: deepFreeze(document) })
}

export function preflightActivePerformanceBudget({ budget, profileId, context }) {
  const path = budget?.path
  const document = budget?.document
  if (!isRecord(document)) {
    throw new ActivePerformanceBudgetError([
      'validated active budget document was missing during static profile preflight'
    ])
  }

  if (profileId) {
    const profile = document.profiles.find((candidate) => candidate.id === profileId)
    if (!profile) {
      throw new ActivePerformanceBudgetError([
        `active budget did not contain profile ${profileId} for ${formatStaticContext(context)}`
      ])
    }
    const scopeFailures = performanceBudgetStaticScopeMismatches(
      profile.scope,
      context,
      profile.evidence
    )
    if (scopeFailures.length > 0) {
      throw new ActivePerformanceBudgetError([
        `active budget profile ${profile.id} did not match the prelaunch run: ${scopeFailures.join('; ')}`
      ])
    }
    return staticPreflightResult(path, profileId, [profile])
  }

  const candidates = document.profiles.filter(
    (profile) =>
      performanceBudgetStaticScopeMismatches(profile.scope, context, profile.evidence).length === 0
  )
  if (candidates.length === 0) {
    throw new ActivePerformanceBudgetError([
      `active budget did not contain a statically matching profile for ${formatStaticContext(context)}`
    ])
  }
  if (candidates.length > 1 && !profilesDifferOnlyByDisplayScale(candidates)) {
    throw new ActivePerformanceBudgetError([
      `active budget multiple static profiles did not differ only by displayScaleFactor for ${formatStaticContext(context)}: ${candidates.map((profile) => profile.id).join(', ')}`
    ])
  }
  return staticPreflightResult(path, null, candidates)
}

export function preflightActivePerformanceBudgetArtifact({ budget, profileId, context }) {
  const path = budget?.path
  const document = budget?.document
  if (!isRecord(document)) {
    throw new ActivePerformanceBudgetError([
      'validated active budget document was missing during artifact profile preflight'
    ])
  }
  if (!profileId) {
    throw new ActivePerformanceBudgetError([
      'artifact preflight requires an explicit active budget profile id'
    ])
  }
  const profile = document.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) {
    throw new ActivePerformanceBudgetError([
      `active budget did not contain artifact profile ${profileId}`
    ])
  }
  const failures = performanceBudgetArtifactScopeMismatches(
    profile.scope,
    context,
    profile.evidence
  )
  if (failures.length > 0) {
    throw new ActivePerformanceBudgetError([
      `active budget profile ${profile.id} did not match the packaged artifact: ${failures.join('; ')}`
    ])
  }
  return staticPreflightResult(path, profileId, [profile])
}

export function selectActivePerformanceBudget({ budget, profileId, context }) {
  const path = budget?.path
  const document = budget?.document
  if (!isRecord(document)) {
    throw new ActivePerformanceBudgetError([
      'validated active budget document was missing during profile selection'
    ])
  }

  const candidates = profileId
    ? document.profiles.filter((profile) => profile.id === profileId)
    : document.profiles.filter((profile) =>
        performanceBudgetScopeMatches(profile.scope, context, profile.evidence)
      )
  if (candidates.length === 0) {
    const requested = profileId ? `profile ${profileId}` : 'a matching profile'
    throw new ActivePerformanceBudgetError([
      `active budget did not contain ${requested} for ${formatContext(context)}`
    ])
  }
  if (candidates.length > 1) {
    throw new ActivePerformanceBudgetError([
      `active budget contained multiple matching profiles for ${formatContext(context)}: ${candidates.map((profile) => profile.id).join(', ')}`
    ])
  }
  const profile = candidates[0]
  const scopeFailures = performanceBudgetScopeMismatches(profile.scope, context, profile.evidence)
  if (scopeFailures.length > 0) {
    throw new ActivePerformanceBudgetError([
      `active budget profile ${profile.id} did not match the run: ${scopeFailures.join('; ')}`
    ])
  }
  return {
    path,
    profile,
    probeConfig: activePerformanceBudgetProbeConfig(profile)
  }
}

export async function loadActivePerformanceBudget({ path, profileId, context, read = readFile }) {
  const budget = await readActivePerformanceBudget({ path, read })
  return selectActivePerformanceBudget({ budget, profileId, context })
}

export function validateActivePerformanceBudgetDocument(document) {
  const failures = []
  if (document?.schemaVersion !== ACTIVE_PERFORMANCE_BUDGET_SCHEMA_VERSION) {
    failures.push('active budget schemaVersion was missing or unsupported')
  }
  if (document?.kind !== 'videorc.performance-budget-set') {
    failures.push('active budget kind was not videorc.performance-budget-set')
  }
  if (document?.status !== 'active') failures.push('active budget status was not active')
  if (!Array.isArray(document?.profiles) || document.profiles.length === 0) {
    failures.push('active budget profiles were missing')
    return failures
  }
  const ids = new Set()
  for (const [index, profile] of document.profiles.entries()) {
    const label = `profile ${index + 1}`
    if (!nonEmptyString(profile?.id)) failures.push(`${label} id was missing`)
    else if (ids.has(profile.id)) failures.push(`${label} id ${profile.id} was duplicated`)
    else ids.add(profile.id)
    validateScope(profile?.scope, label, failures)
    validateEvidence(profile?.evidence, label, failures)
    validateThresholds(profile?.thresholds, label, failures)
    validateApproval(profile?.approval, label, failures)
  }
  return failures
}

export function performanceBudgetScopeMatches(scope, context, evidence) {
  return performanceBudgetScopeMismatches(scope, context, evidence).length === 0
}

export function activePerformanceBudgetProbeConfig(profile) {
  const thresholds = profile.thresholds
  return {
    cadence: {
      minPresentFps: Math.max(
        thresholds.cadence.minimumPresentFps,
        CROSS_MACHINE_NATIVE_CADENCE.minimumPresentFps
      ),
      maxIntervalP95Ms: Math.min(
        thresholds.cadence.maximumIntervalP95Ms,
        CROSS_MACHINE_NATIVE_CADENCE.maximumIntervalP95Ms
      )
    },
    pipeline: {
      maxStatusFetchesPerSecond: thresholds.pipeline.maximumStatusFetchesPerSecond,
      maxWireKibPerSecond: thresholds.pipeline.maximumWireKibPerSecond
    },
    memory: {
      maxTotalRssMb: thresholds.memoryMiB.maximumTotalRss,
      maxOwnedRssMb: thresholds.memoryMiB.maximumOwnedRss,
      maxOwnedSlopeMbPerMinute: thresholds.memoryMiB.maximumOwnedSlopePerMinute,
      maxOwnedSecondHalfSlopeMbPerMinute: thresholds.memoryMiB.maximumOwnedSecondHalfSlopePerMinute,
      maxOwnedPlateauGrowthMb: thresholds.memoryMiB.maximumOwnedPlateauGrowth,
      maxRoleRssMb: mapRoles(thresholds.perRoleMemoryMiB, 'maximumRss'),
      maxRoleSlopeMbPerMinute: mapRoles(thresholds.perRoleMemoryMiB, 'maximumSlopePerMinute'),
      maxRoleSecondHalfSlopeMbPerMinute: mapRoles(
        thresholds.perRoleMemoryMiB,
        'maximumSecondHalfSlopePerMinute'
      ),
      maxRolePlateauGrowthMb: mapRoles(thresholds.perRoleMemoryMiB, 'maximumPlateauGrowth')
    },
    resources: {
      maxPhysicalFootprintGrowthMb: thresholds.resources.maximumPhysicalFootprintGrowthMiB,
      maxOpenFileGrowth: thresholds.resources.maximumOpenFileGrowth
    },
    cpu: {
      maxAveragePercentByRole: mapRoles(thresholds.perRoleCpuPercent, 'maximumAverage'),
      maxP95PercentByRole: mapRoles(thresholds.perRoleCpuPercent, 'maximumP95')
    },
    teardown: { requireClean: thresholds.teardown.requireClean }
  }
}

export function evaluateActivePerformanceBudget({ profile, metrics, metricContract = 'preview' }) {
  if (!['preview', 'recording', 'lifecycle'].includes(metricContract)) {
    throw new ActivePerformanceBudgetError([
      `unknown active budget metric contract ${metricContract}`
    ])
  }
  const config = activePerformanceBudgetProbeConfig(profile)
  const metricFailures = []
  const thresholdFailures = []
  const pipeline = metrics?.pipeline
  if (metricContract !== 'lifecycle') {
    requireAtLeast(
      metricFailures,
      thresholdFailures,
      'present FPS',
      pipeline?.presentFps,
      config.cadence.minPresentFps,
      'fps'
    )
    requireAtLeast(
      metricFailures,
      thresholdFailures,
      'measured frame delta rate',
      pipeline?.framesPerSecond,
      config.cadence.minPresentFps,
      'fps'
    )
    requireAtMost(
      metricFailures,
      thresholdFailures,
      'present interval p95',
      pipeline?.intervalP95Ms,
      config.cadence.maxIntervalP95Ms,
      'ms'
    )
  }
  if (metricContract === 'preview') {
    requireAtMost(
      metricFailures,
      thresholdFailures,
      'status fetch rate',
      pipeline?.statusHttpFetchesPerSecond,
      config.pipeline.maxStatusFetchesPerSecond,
      '/s'
    )
    requireAtMost(
      metricFailures,
      thresholdFailures,
      'WebSocket wire rate',
      pipeline?.wireKibPerSecond,
      config.pipeline.maxWireKibPerSecond,
      'KiB/s'
    )
  }

  const memory = metrics?.memory
  requireAtMostKb(
    metricFailures,
    thresholdFailures,
    'total process tree RSS',
    memory?.maxTotalRssKb,
    config.memory.maxTotalRssMb
  )
  requireAtMostKb(
    metricFailures,
    thresholdFailures,
    'owned process RSS',
    memory?.maxOwnedRssKb,
    config.memory.maxOwnedRssMb
  )
  requireAtMostKb(
    metricFailures,
    thresholdFailures,
    'owned process RSS slope',
    memory?.ownedRss?.slopePerMinute,
    config.memory.maxOwnedSlopeMbPerMinute,
    'MiB/min'
  )
  requireAtMostKb(
    metricFailures,
    thresholdFailures,
    'owned process RSS second-half slope',
    memory?.ownedRss?.secondHalfSlopePerMinute,
    config.memory.maxOwnedSecondHalfSlopeMbPerMinute,
    'MiB/min'
  )
  requireAtMostKb(
    metricFailures,
    thresholdFailures,
    'owned process RSS plateau growth',
    memory?.ownedRss?.plateauGrowth,
    config.memory.maxOwnedPlateauGrowthMb
  )
  for (const role of Object.keys(profile.thresholds.perRoleMemoryMiB).sort()) {
    const roleMetrics = memory?.roles?.[role]
    requireAtMostKb(
      metricFailures,
      thresholdFailures,
      `${role} RSS`,
      roleMetrics?.maxRssKb,
      config.memory.maxRoleRssMb[role]
    )
    requireAtMostKb(
      metricFailures,
      thresholdFailures,
      `${role} RSS slope`,
      roleMetrics?.slopeRssKbPerMinute,
      config.memory.maxRoleSlopeMbPerMinute[role],
      'MiB/min'
    )
    requireAtMostKb(
      metricFailures,
      thresholdFailures,
      `${role} RSS second-half slope`,
      roleMetrics?.secondHalfSlopeRssKbPerMinute,
      config.memory.maxRoleSecondHalfSlopeMbPerMinute[role],
      'MiB/min'
    )
    requireAtMostKb(
      metricFailures,
      thresholdFailures,
      `${role} RSS plateau growth`,
      roleMetrics?.plateauGrowthRssKb,
      config.memory.maxRolePlateauGrowthMb[role]
    )
  }

  const resources = metrics?.resourceCheckpoints?.comparison?.metrics
  requireComparableDelta(
    metricFailures,
    thresholdFailures,
    'physical footprint growth',
    resources?.physicalFootprintBytes,
    config.resources.maxPhysicalFootprintGrowthMb * 1024 * 1024,
    'bytes'
  )
  requireComparableDelta(
    metricFailures,
    thresholdFailures,
    'open-file growth',
    resources?.openFileCount,
    config.resources.maxOpenFileGrowth,
    'files'
  )

  for (const role of Object.keys(profile.thresholds.perRoleCpuPercent).sort()) {
    requireAtMost(
      metricFailures,
      thresholdFailures,
      `${role} average CPU`,
      metrics?.cpuAveragePercentByRole?.[role],
      config.cpu.maxAveragePercentByRole[role],
      '%'
    )
    requireAtMost(
      metricFailures,
      thresholdFailures,
      `${role} p95 CPU`,
      metrics?.cpuP95PercentByRole?.[role],
      config.cpu.maxP95PercentByRole[role],
      '%'
    )
  }
  if (config.teardown.requireClean) {
    if (typeof metrics?.teardownClean !== 'boolean') {
      metricFailures.push('clean teardown metric was missing or invalid')
    } else if (!metrics.teardownClean) {
      thresholdFailures.push('app-owned teardown was not clean')
    }
  }
  return { config, metricFailures, thresholdFailures }
}

function performanceBudgetScopeMismatches(scope, context, evidence) {
  const failures = performanceBudgetStaticScopeMismatches(scope, context, evidence)
  if (scope?.displayScaleFactor !== context?.displayScaleFactor) {
    failures.push(
      `displayScaleFactor ${context?.displayScaleFactor ?? 'missing'} != ${scope?.displayScaleFactor ?? 'missing'}`
    )
  }
  return failures
}

function performanceBudgetStaticScopeMismatches(scope, context, evidence) {
  const failures = performanceBudgetArtifactScopeMismatches(scope, context, evidence)
  if (scope?.machineModel !== undefined && scope.machineModel !== context?.machineModel) {
    failures.push(
      `machineModel ${context?.machineModel ?? 'missing'} != ${scope.machineModel ?? 'missing'}`
    )
  }
  if (scope?.hardwareClass !== undefined && scope.hardwareClass !== context?.hardwareClass) {
    failures.push(
      `hardwareClass ${context?.hardwareClass ?? 'missing'} != ${scope.hardwareClass ?? 'missing'}`
    )
  }
  for (const field of ['platform', 'arch', 'macosVersion']) {
    const expected = scope?.operatingSystem?.[field]
    if (expected !== undefined && expected !== context?.operatingSystem?.[field]) {
      failures.push(
        `operatingSystem.${field} ${context?.operatingSystem?.[field] ?? 'missing'} != ${expected}`
      )
    }
  }
  return failures
}

function performanceBudgetArtifactScopeMismatches(scope, context, evidence) {
  const failures = []
  for (const field of ['scenario', 'profileClass', 'appVersion', 'buildMode']) {
    if (scope?.[field] !== context?.[field]) {
      failures.push(`${field} ${context?.[field] ?? 'missing'} != ${scope?.[field] ?? 'missing'}`)
    }
  }
  for (const field of ['warmupMs', 'measurementMs', 'intervalMs']) {
    if (scope?.timing?.[field] !== context?.timing?.[field]) {
      failures.push(
        `timing.${field} ${context?.timing?.[field] ?? 'missing'} != ${scope?.timing?.[field] ?? 'missing'}`
      )
    }
  }
  if (
    scope?.buildMode === 'packaged' &&
    evidence?.packagePayloadSha256 !== context?.packagePayloadSha256
  ) {
    failures.push(
      `packagePayloadSha256 ${context?.packagePayloadSha256 ?? 'missing'} != ${evidence?.packagePayloadSha256 ?? 'missing'}`
    )
  }
  return failures
}

function profilesDifferOnlyByDisplayScale(profiles) {
  const staticScopes = new Set(profiles.map((profile) => stableJson(staticScope(profile.scope))))
  const displayScales = new Set(profiles.map((profile) => profile.scope.displayScaleFactor))
  return staticScopes.size === 1 && displayScales.size === profiles.length
}

function staticScope(scope) {
  const { displayScaleFactor: _displayScaleFactor, ...value } = scope
  return value
}

function staticPreflightResult(path, profileId, candidates) {
  return Object.freeze({
    path,
    profileId,
    candidateProfileIds: Object.freeze(candidates.map((profile) => profile.id))
  })
}

function validateScope(scope, label, failures) {
  if (!isRecord(scope)) {
    failures.push(`${label} scope was missing`)
    return
  }
  if (!nonEmptyString(scope.scenario)) failures.push(`${label} scope scenario was missing`)
  if (!['short-sentinel', 'endurance'].includes(scope.profileClass)) {
    failures.push(`${label} scope profileClass was missing or invalid`)
  }
  if (!exactScopeBinding(scope.appVersion)) {
    failures.push(`${label} scope appVersion was missing or invalid`)
  }
  const hasMachineModel = scope.machineModel !== undefined
  const hasHardwareClass = scope.hardwareClass !== undefined
  const machineModel = exactScopeBinding(scope.machineModel)
  const hardwareClass = exactScopeBinding(scope.hardwareClass)
  if (hasMachineModel === hasHardwareClass) {
    failures.push(`${label} scope must bind exactly one of machineModel or hardwareClass`)
  }
  if (hasMachineModel && !machineModel) {
    failures.push(`${label} scope machineModel must be an exact non-wildcard value`)
  }
  if (hasHardwareClass && !hardwareClass) {
    failures.push(`${label} scope hardwareClass must be an exact non-wildcard value`)
  }
  if (!['development', 'packaged'].includes(scope.buildMode)) {
    failures.push(`${label} scope buildMode was invalid`)
  }
  if (!Number.isFinite(scope.displayScaleFactor) || scope.displayScaleFactor <= 0) {
    failures.push(`${label} scope displayScaleFactor was missing or invalid`)
  }
  if (!isRecord(scope.operatingSystem)) {
    failures.push(`${label} scope operatingSystem was invalid`)
  } else {
    if (!exactScopeBinding(scope.operatingSystem.platform)) {
      failures.push(`${label} scope operatingSystem.platform was missing or invalid`)
    }
    if (!exactScopeBinding(scope.operatingSystem.arch)) {
      failures.push(`${label} scope operatingSystem.arch was missing or invalid`)
    }
  }
  if (!isRecord(scope.timing)) {
    failures.push(`${label} scope timing was missing or invalid`)
  } else {
    for (const field of ['warmupMs', 'measurementMs', 'intervalMs']) {
      if (!Number.isInteger(scope.timing[field]) || scope.timing[field] <= 0) {
        failures.push(`${label} scope timing.${field} was missing or invalid`)
      }
    }
    if (scope.profileClass === 'endurance' && scope.timing.measurementMs < 600_000) {
      failures.push(`${label} endurance profile measurement was shorter than 600000ms`)
    }
    if (scope.profileClass === 'short-sentinel' && scope.timing.measurementMs >= 600_000) {
      failures.push(`${label} short-sentinel profile overlapped the endurance window`)
    }
  }
}

function validateEvidence(evidence, label, failures) {
  if (!isRecord(evidence)) {
    failures.push(`${label} evidence was missing`)
    return
  }
  if (!/^[0-9a-f]{24}$/i.test(evidence.calibrationId ?? '')) {
    failures.push(`${label} evidence calibrationId was invalid`)
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(evidence.commit ?? '')) {
    failures.push(`${label} evidence commit was invalid`)
  }
  if (!/^[0-9a-f]{64}$/i.test(evidence.executableSha256 ?? '')) {
    failures.push(`${label} evidence executableSha256 was invalid`)
  }
  if (!/^[0-9a-f]{64}$/i.test(evidence.packagePayloadSha256 ?? '')) {
    failures.push(`${label} evidence packagePayloadSha256 was invalid`)
  }
  if (!/^[0-9a-f]{64}$/i.test(evidence.calibrationSha256 ?? '')) {
    failures.push(`${label} evidence calibrationSha256 was invalid`)
  }
  if (!validIsoDate(evidence.calibrationGeneratedAt)) {
    failures.push(`${label} evidence calibrationGeneratedAt was invalid`)
  }
  if (evidence.powerAssertion !== 'caffeinate:-d,-i,-s') {
    failures.push(`${label} evidence powerAssertion was missing or invalid`)
  }
  if (evidence.powerAssertionVerified !== true) {
    failures.push(`${label} evidence powerAssertionVerified was not true`)
  }
  if (evidence.runCount !== 3) failures.push(`${label} evidence runCount was not 3`)
  if (
    !Array.isArray(evidence.runNonces) ||
    evidence.runNonces.length !== 3 ||
    evidence.runNonces.some((value) => !nonEmptyString(value)) ||
    new Set(evidence.runNonces).size !== 3
  ) {
    failures.push(`${label} evidence runNonces must contain exactly 3 unique values`)
  }
  if (
    !Array.isArray(evidence.reportPaths) ||
    evidence.reportPaths.length !== 3 ||
    evidence.reportPaths.some((value) => !nonEmptyString(value))
  ) {
    failures.push(`${label} evidence reportPaths were missing or invalid`)
  }
}

function validateThresholds(thresholds, label, failures) {
  if (!isRecord(thresholds)) {
    failures.push(`${label} thresholds were missing`)
    return
  }
  const required = [
    ['cadence.minimumPresentFps', thresholds.cadence?.minimumPresentFps, true],
    ['cadence.maximumIntervalP95Ms', thresholds.cadence?.maximumIntervalP95Ms, true],
    [
      'pipeline.maximumStatusFetchesPerSecond',
      thresholds.pipeline?.maximumStatusFetchesPerSecond,
      false
    ],
    ['pipeline.maximumWireKibPerSecond', thresholds.pipeline?.maximumWireKibPerSecond, false],
    ['memoryMiB.maximumTotalRss', thresholds.memoryMiB?.maximumTotalRss, true],
    ['memoryMiB.maximumOwnedRss', thresholds.memoryMiB?.maximumOwnedRss, true],
    [
      'memoryMiB.maximumOwnedSlopePerMinute',
      thresholds.memoryMiB?.maximumOwnedSlopePerMinute,
      false
    ],
    [
      'memoryMiB.maximumOwnedSecondHalfSlopePerMinute',
      thresholds.memoryMiB?.maximumOwnedSecondHalfSlopePerMinute,
      false
    ],
    ['memoryMiB.maximumOwnedPlateauGrowth', thresholds.memoryMiB?.maximumOwnedPlateauGrowth, false],
    [
      'resources.maximumPhysicalFootprintGrowthMiB',
      thresholds.resources?.maximumPhysicalFootprintGrowthMiB,
      false
    ],
    ['resources.maximumOpenFileGrowth', thresholds.resources?.maximumOpenFileGrowth, false]
  ]
  for (const [field, value, positive] of required) {
    if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
      failures.push(`${label} threshold ${field} was missing or invalid`)
    }
  }
  if (
    Number.isFinite(thresholds.cadence?.minimumPresentFps) &&
    thresholds.cadence.minimumPresentFps < CROSS_MACHINE_NATIVE_CADENCE.minimumPresentFps
  ) {
    failures.push(`${label} minimumPresentFps weakened the cross-machine native cadence floor`)
  }
  if (
    Number.isFinite(thresholds.cadence?.maximumIntervalP95Ms) &&
    thresholds.cadence.maximumIntervalP95Ms > CROSS_MACHINE_NATIVE_CADENCE.maximumIntervalP95Ms
  ) {
    failures.push(`${label} maximumIntervalP95Ms weakened the cross-machine native cadence floor`)
  }
  if (!isRecord(thresholds.perRoleMemoryMiB)) {
    failures.push(`${label} perRoleMemoryMiB thresholds were missing`)
    return
  }
  for (const role of REQUIRED_ROLES) {
    if (!isRecord(thresholds.perRoleMemoryMiB[role])) {
      failures.push(`${label} ${role} thresholds were missing`)
    }
  }
  for (const [role, values] of Object.entries(thresholds.perRoleMemoryMiB)) {
    for (const [field, positive] of [
      ['maximumRss', true],
      ['maximumSlopePerMinute', false],
      ['maximumSecondHalfSlopePerMinute', false],
      ['maximumPlateauGrowth', false]
    ]) {
      const value = values?.[field]
      if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
        failures.push(`${label} ${role}.${field} threshold was missing or invalid`)
      }
    }
  }
  if (!isRecord(thresholds.perRoleCpuPercent)) {
    failures.push(`${label} perRoleCpuPercent thresholds were missing`)
  } else {
    for (const role of REQUIRED_ROLES) {
      if (!isRecord(thresholds.perRoleCpuPercent[role])) {
        failures.push(`${label} ${role} CPU thresholds were missing`)
      }
    }
    for (const [role, values] of Object.entries(thresholds.perRoleCpuPercent)) {
      for (const field of ['maximumAverage', 'maximumP95']) {
        if (!Number.isFinite(values?.[field]) || values[field] < 0) {
          failures.push(`${label} ${role}.${field} CPU threshold was missing or invalid`)
        }
      }
      if (
        Number.isFinite(values?.maximumAverage) &&
        Number.isFinite(values?.maximumP95) &&
        values.maximumP95 < values.maximumAverage
      ) {
        failures.push(`${label} ${role}.maximumP95 CPU threshold was below maximumAverage`)
      }
    }
  }
  if (thresholds.teardown?.requireClean !== true) {
    failures.push(`${label} teardown.requireClean was not true`)
  }
}

function validateApproval(approval, label, failures) {
  if (
    !nonEmptyString(approval?.reviewedBy) ||
    !validIsoDate(approval?.reviewedAt) ||
    !nonEmptyString(approval?.rationale)
  ) {
    failures.push(`${label} approval was missing or invalid`)
  }
}

function mapRoles(roles, field) {
  return Object.fromEntries(Object.entries(roles).map(([role, values]) => [role, values[field]]))
}

function requireAtMost(metricFailures, thresholdFailures, label, actual, maximum, unit) {
  if (!Number.isFinite(actual)) {
    metricFailures.push(`${label} metric was missing or invalid`)
  } else if (actual > maximum) {
    thresholdFailures.push(`${label} ${format(actual)}${unit} exceeded ${format(maximum)}${unit}`)
  }
}

function requireAtLeast(metricFailures, thresholdFailures, label, actual, minimum, unit) {
  if (!Number.isFinite(actual)) {
    metricFailures.push(`${label} metric was missing or invalid`)
  } else if (actual < minimum) {
    thresholdFailures.push(`${label} ${format(actual)}${unit} was below ${format(minimum)}${unit}`)
  }
}

function requireAtMostKb(
  metricFailures,
  thresholdFailures,
  label,
  actualKb,
  maximumMb,
  unit = 'MiB'
) {
  if (!Number.isFinite(actualKb)) {
    metricFailures.push(`${label} metric was missing or invalid`)
    return
  }
  const actualMb = actualKb / 1024
  if (actualMb > maximumMb) {
    thresholdFailures.push(
      `${label} ${format(actualMb)}${unit} exceeded ${format(maximumMb)}${unit}`
    )
  }
}

function requireComparableDelta(
  metricFailures,
  thresholdFailures,
  label,
  comparison,
  maximum,
  unit
) {
  if (comparison?.comparable !== true || !Number.isFinite(comparison?.delta)) {
    metricFailures.push(`${label} metric was missing or not comparable`)
  } else if (comparison.delta > maximum) {
    thresholdFailures.push(
      `${label} ${format(comparison.delta)}${unit} exceeded ${format(maximum)}${unit}`
    )
  }
}

function formatContext(context) {
  return `scenario=${context?.scenario ?? 'missing'}, machine=${context?.machineModel ?? 'missing'}, hardwareClass=${context?.hardwareClass ?? 'missing'}, build=${context?.buildMode ?? 'missing'}, displayScaleFactor=${context?.displayScaleFactor ?? 'missing'}`
}

function formatStaticContext(context) {
  return `scenario=${context?.scenario ?? 'missing'}, profileClass=${context?.profileClass ?? 'missing'}, appVersion=${context?.appVersion ?? 'missing'}, machine=${context?.machineModel ?? 'missing'}, hardwareClass=${context?.hardwareClass ?? 'missing'}, build=${context?.buildMode ?? 'missing'}`
}

function loadCrossMachineNativeCadence() {
  const path = new URL(
    '../../config/performance-budgets/v1/cross-machine-native-cadence.json',
    import.meta.url
  )
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (
    value?.schemaVersion !== 1 ||
    value?.kind !== 'videorc.cross-machine-native-cadence-invariant' ||
    !Number.isFinite(value?.minimumPresentFps) ||
    value.minimumPresentFps <= 0 ||
    !Number.isFinite(value?.maximumIntervalP95Ms) ||
    value.maximumIntervalP95Ms <= 0
  ) {
    throw new Error('Cross-machine native cadence invariant was missing or invalid.')
  }
  return Object.freeze(value)
}

function exactScopeBinding(value) {
  const normalized = nonEmptyString(value)
  return normalized && !/[*?]/.test(normalized) ? normalized : null
}

function format(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function validIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
