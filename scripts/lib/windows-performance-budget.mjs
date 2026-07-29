import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export class WindowsPerformanceBudgetError extends Error {
  constructor(failures) {
    super(`Windows performance budget was invalid or did not match:\n${failures.join('\n')}`)
    this.name = 'WindowsPerformanceBudgetError'
    this.failures = failures
  }
}

export async function loadWindowsPerformanceBudget({
  path,
  profileId,
  context,
  read = readFile,
  requireComparison = false,
  verifyArtifact = verifyWindowsPerformanceBudgetArtifact
}) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new WindowsPerformanceBudgetError([
      'VIDEORC_WINDOWS_PERF_BUDGET_PATH is required for a Windows performance gate'
    ])
  }
  let document
  try {
    document = JSON.parse(await read(path, 'utf8'))
  } catch (error) {
    throw new WindowsPerformanceBudgetError([
      `could not read Windows performance budget ${path}: ${error?.message ?? String(error)}`
    ])
  }
  const validationFailures = validateWindowsPerformanceBudget(document, { requireComparison })
  if (validationFailures.length > 0) throw new WindowsPerformanceBudgetError(validationFailures)
  const strictScope = requireComparison || isRecord(document.comparison)

  const profiles = document.profiles.filter((profile) =>
    profileId
      ? profile.id === profileId
      : windowsBudgetScopeFailures(profile.scope, context, {
          requireComparison: strictScope
        }).length === 0
  )
  if (profiles.length === 0) {
    throw new WindowsPerformanceBudgetError([
      profileId
        ? `Windows performance budget did not contain profile ${profileId}`
        : `Windows performance budget did not contain a profile for ${formatContext(context)}`
    ])
  }
  if (profiles.length > 1) {
    throw new WindowsPerformanceBudgetError([
      `Windows performance budget matched multiple profiles for ${formatContext(context)}: ${profiles.map((profile) => profile.id).join(', ')}`
    ])
  }
  const profile = profiles[0]
  const scopeFailures = windowsBudgetScopeFailures(profile.scope, context, {
    requireComparison: strictScope
  })
  scopeFailures.push(...windowsBudgetPayloadScopeFailures(document, profile, context))
  if (scopeFailures.length > 0) {
    throw new WindowsPerformanceBudgetError([
      `Windows performance budget profile ${profile.id} did not match: ${scopeFailures.join('; ')}`
    ])
  }
  if (strictScope) {
    const artifactFailures = await verifyWindowsPerformanceBudgetArtifacts({
      document,
      budgetPath: path,
      verifyArtifact
    })
    if (artifactFailures.length > 0) {
      throw new WindowsPerformanceBudgetError(artifactFailures)
    }
  }
  return { path, profile, document }
}

export function validateWindowsPerformanceBudget(document, options = {}) {
  const failures = []
  if (document?.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (document?.kind !== 'videorc.windows-performance-budget-set') {
    failures.push('kind must be videorc.windows-performance-budget-set')
  }
  const allowedStatuses =
    options.allowDraft === true ? new Set(['active', 'draft']) : new Set(['active'])
  if (!allowedStatuses.has(document?.status)) {
    failures.push(
      options.allowDraft === true ? 'status must be active or draft' : 'status must be active'
    )
  }
  const comparisonBound = isRecord(document?.comparison)
  const comparisonRequired = options.requireComparison === true
  const budgetCandidatePayloadValid = lowercaseSha256(document?.candidatePayloadSha256)
  if (!budgetCandidatePayloadValid) {
    failures.push('candidatePayloadSha256 must be a lowercase SHA-256 digest')
  }
  if (comparisonRequired && !comparisonBound) {
    failures.push('comparison-bound budget evidence was missing')
  }
  if (comparisonBound || comparisonRequired) {
    if (!sha256(document?.candidateSha256)) failures.push('candidateSha256 was invalid')
    if (comparisonBound) validateComparisonBinding(document.comparison, failures)
    if (document.status === 'active') {
      if (!nonEmptyString(document.reviewedBy))
        failures.push('active comparison budget reviewedBy was missing')
      if (!nonEmptyString(document.reviewedAt))
        failures.push('active comparison budget reviewedAt was missing')
    }
  }
  if (!Array.isArray(document?.profiles) || document.profiles.length === 0) {
    failures.push('profiles must contain at least one reviewed profile')
    return failures
  }
  const ids = new Set()
  for (const [index, profile] of document.profiles.entries()) {
    const label = `profile ${index + 1}`
    if (!nonEmptyString(profile?.id)) failures.push(`${label} id was missing`)
    else if (ids.has(profile.id)) failures.push(`${label} id ${profile.id} was duplicated`)
    else ids.add(profile.id)
    validateScope(profile?.scope, label, failures, {
      requireRelease: comparisonBound || comparisonRequired
    })
    validateEvidence(
      profile?.evidence,
      profile?.scope,
      label,
      failures,
      comparisonBound || comparisonRequired,
      document?.comparison
    )
    validateThresholds(profile?.thresholds, label, failures, comparisonBound || comparisonRequired)
    const profileCandidatePayloadValid = lowercaseSha256(profile?.candidatePayloadSha256)
    if (!profileCandidatePayloadValid) {
      failures.push(`${label} candidatePayloadSha256 must be a lowercase SHA-256 digest`)
    } else if (
      budgetCandidatePayloadValid &&
      profile.candidatePayloadSha256 !== document.candidatePayloadSha256
    ) {
      failures.push(`${label} candidatePayloadSha256 did not match the budget candidate payload`)
    }
    if (
      (comparisonBound || comparisonRequired) &&
      normalizeSha256(profile?.candidateSha256) !== normalizeSha256(document.candidateSha256)
    ) {
      failures.push(`${label} candidateSha256 did not match the budget candidate`)
    }
  }
  return failures
}

export function evaluateWindowsPerformanceBudget(profile, metrics) {
  const failures = []
  const thresholds = profile?.thresholds
  const memory = metrics?.processTree?.memory?.summary
  const cpu = metrics?.processTree?.cpu?.summary?.byRole
  const bmp = metrics?.bmp
  const totalCpu =
    metrics?.processTree?.cpu?.summary?.totalP95Percent ??
    metrics?.processTree?.cpu?.summary?.total?.p95Percent
  const gpu = metrics?.gpu?.summary ?? metrics?.gpu

  if (Number.isFinite(thresholds?.maximumTotalCpuP95Percent)) {
    requireAtMost(
      failures,
      'total process-tree p95 CPU',
      totalCpu,
      thresholds.maximumTotalCpuP95Percent
    )
  }
  requireAtMost(
    failures,
    'total process-tree RSS',
    memory?.maxTotalRssKb,
    thresholds?.maximumTotalRssMiB * 1024
  )
  requireAtMost(
    failures,
    'total process-tree RSS slope',
    memory?.totalRss?.slopePerMinute,
    thresholds?.maximumTotalRssSlopeMiBPerMinute * 1024
  )
  if (thresholds?.bmp?.mode === 'disabled') {
    requireAtMost(failures, 'BMP request count', bmp?.requestCount, thresholds.bmp.maximumRequests)
    requireAtMost(failures, 'BMP bytes', bmp?.bytes, thresholds.bmp.maximumBytes)
  } else {
    requireAtMost(
      failures,
      'BMP polling interval p95',
      bmp?.intervalP95Ms,
      thresholds?.bmp?.maximumIntervalP95Ms
    )
    requireAtLeast(
      failures,
      'BMP advanced frames',
      bmp?.advancedFrames,
      thresholds?.bmp?.minimumAdvancedFrames
    )
  }
  if (isRecord(thresholds?.gpu)) {
    requireAtMost(
      failures,
      'GPU engine p95',
      gpu?.engineBusyP95Percent,
      thresholds.gpu.maximumEngineP95Percent
    )
    requireAtMost(
      failures,
      'GPU dedicated memory',
      gpu?.dedicatedMaxMiB,
      thresholds.gpu.maximumDedicatedMiB
    )
    requireAtMost(failures, 'GPU shared memory', gpu?.sharedMaxMiB, thresholds.gpu.maximumSharedMiB)
  }
  for (const [role, roleThresholds] of Object.entries(thresholds?.roles ?? {}).sort()) {
    const memoryMetrics = memory?.roles?.[role]
    const cpuMetrics = cpu?.[role]
    requireAtMost(
      failures,
      `${role} RSS`,
      memoryMetrics?.maxRssKb,
      roleThresholds.maximumRssMiB * 1024
    )
    requireAtMost(
      failures,
      `${role} RSS slope`,
      memoryMetrics?.slopeRssKbPerMinute,
      roleThresholds.maximumRssSlopeMiBPerMinute * 1024
    )
    requireAtMost(
      failures,
      `${role} average CPU`,
      cpuMetrics?.averagePercent,
      roleThresholds.maximumAverageCpuPercent
    )
    requireAtMost(
      failures,
      `${role} p95 CPU`,
      cpuMetrics?.p95Percent,
      roleThresholds.maximumP95CpuPercent
    )
  }
  if (metrics?.teardownClean !== true) failures.push('app-owned process teardown was not clean')
  return failures
}

function validateScope(scope, label, failures, options = {}) {
  if (!isRecord(scope)) {
    failures.push(`${label} scope was missing`)
    return
  }
  for (const field of ['scenario', 'hardwareClass', 'profileClass', 'buildMode']) {
    if (!nonEmptyString(scope[field])) failures.push(`${label} scope ${field} was missing`)
  }
  if (scope.buildMode !== 'packaged') failures.push(`${label} scope buildMode must be packaged`)
  if (scope.operatingSystem?.platform !== 'win32' || !nonEmptyString(scope.operatingSystem?.arch)) {
    failures.push(`${label} scope must target a Windows platform and architecture`)
  }
  if (options.requireRelease === true && !nonEmptyString(scope.operatingSystem?.release)) {
    failures.push(`${label} scope operatingSystem.release was missing`)
  }
  for (const field of ['warmupMs', 'measurementMs', 'intervalMs']) {
    if (!positiveInteger(scope.timing?.[field]))
      failures.push(`${label} scope timing ${field} was invalid`)
  }
}

function validateEvidence(evidence, scope, label, failures, comparisonBound, comparison) {
  if (!isRecord(evidence)) {
    failures.push(`${label} evidence was missing`)
    return
  }
  const expectedRunCount = windowsBudgetEvidenceRunCount(scope)
  if (evidence.runCount !== expectedRunCount) {
    failures.push(`${label} evidence runCount must be ${expectedRunCount}`)
  }
  const reportPaths = evidence.reportPaths
  if (
    !Array.isArray(reportPaths) ||
    reportPaths.length !== expectedRunCount ||
    !reportPaths.every(nonEmptyString) ||
    new Set(reportPaths.map(canonicalEvidencePath)).size !== expectedRunCount
  ) {
    failures.push(
      `${label} evidence must retain ${expectedRunCount === 3 ? 'three' : expectedRunCount} report path${expectedRunCount === 1 ? '' : 's'}`
    )
  }
  if (!nonEmptyString(evidence.calibrationSha256) || !sha256(evidence.calibrationSha256)) {
    failures.push(`${label} evidence calibrationSha256 was invalid`)
  }
  if (comparisonBound) {
    if (!nonEmptyString(evidence.calibrationPath)) {
      failures.push(`${label} evidence calibrationPath was missing`)
    }
    for (const field of ['reportSha256']) {
      if (
        !Array.isArray(evidence[field]) ||
        evidence[field].length !== expectedRunCount ||
        !evidence[field].every(sha256) ||
        new Set(evidence[field].map(normalizeSha256)).size !== expectedRunCount
      ) {
        failures.push(
          `${label} evidence ${field} must retain ${expectedRunCount} SHA-256 digest${expectedRunCount === 1 ? '' : 's'}`
        )
      }
    }
    if (
      !Array.isArray(evidence.comparisonPaths) ||
      evidence.comparisonPaths.length !== 6 ||
      !evidence.comparisonPaths.every(nonEmptyString) ||
      new Set(evidence.comparisonPaths.map(canonicalEvidencePath)).size !== 6
    ) {
      failures.push(`${label} evidence must retain six comparison paths`)
    }
    if (
      !Array.isArray(evidence.comparisonSha256) ||
      evidence.comparisonSha256.length !== 6 ||
      !evidence.comparisonSha256.every(sha256) ||
      new Set(evidence.comparisonSha256.map((digest) => digest.toLocaleLowerCase('en-US'))).size !==
        6
    ) {
      failures.push(`${label} evidence must retain six comparison SHA-256 digests`)
    }
    if (
      Array.isArray(evidence.comparisonPaths) &&
      Array.isArray(comparison?.reportPaths) &&
      !equalArrays(evidence.comparisonPaths, comparison.reportPaths)
    ) {
      failures.push(`${label} evidence comparisonPaths did not match the budget comparison`)
    }
    if (
      Array.isArray(evidence.comparisonSha256) &&
      Array.isArray(comparison?.reportSha256) &&
      !equalSha256Arrays(evidence.comparisonSha256, comparison.reportSha256)
    ) {
      failures.push(`${label} evidence comparisonSha256 did not match the budget comparison`)
    }
  }
}

async function verifyWindowsPerformanceBudgetArtifacts({ document, budgetPath, verifyArtifact }) {
  const references = [
    {
      label: 'comparison aggregate',
      path: document.comparison.aggregatePath,
      expectedSha256: document.comparison.aggregateSha256
    },
    ...document.comparison.reportPaths.map((path, index) => ({
      label: `comparison report ${index + 1}`,
      path,
      expectedSha256: document.comparison.reportSha256[index]
    })),
    ...document.profiles.flatMap((profile) => [
      {
        label: `profile ${profile.id} calibration aggregate`,
        path: profile.evidence.calibrationPath,
        expectedSha256: profile.evidence.calibrationSha256
      },
      ...profile.evidence.reportPaths.map((path, index) => ({
        label: `profile ${profile.id} calibration report ${index + 1}`,
        path,
        expectedSha256: profile.evidence.reportSha256[index]
      }))
    ])
  ]
  return (
    await Promise.all(
      references.map(async (reference) => {
        const artifactPath = resolve(dirname(budgetPath), reference.path.trim())
        const expectedSha256 = normalizeSha256(reference.expectedSha256)
        try {
          const actualSha256 = await verifyArtifact({
            path: artifactPath,
            expectedSha256,
            label: reference.label,
            budgetPath
          })
          if (!sha256(actualSha256)) {
            return `${reference.label} verifier did not return a SHA-256 digest for ${artifactPath}`
          }
          if (normalizeSha256(actualSha256) !== expectedSha256) {
            return `${reference.label} SHA-256 did not match ${artifactPath}`
          }
          return null
        } catch (error) {
          return `could not verify ${reference.label} ${artifactPath}: ${error?.message ?? String(error)}`
        }
      })
    )
  ).filter(Boolean)
}

async function verifyWindowsPerformanceBudgetArtifact({ path }) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

function validateThresholds(thresholds, label, failures, comparisonBound) {
  if (!isRecord(thresholds)) {
    failures.push(`${label} thresholds were missing`)
    return
  }
  for (const field of ['maximumTotalRssMiB', 'maximumTotalRssSlopeMiBPerMinute']) {
    if (!positiveNumber(thresholds[field]))
      failures.push(`${label} thresholds ${field} was invalid`)
  }
  if (!isRecord(thresholds.bmp)) {
    failures.push(`${label} BMP thresholds were missing`)
  } else if (thresholds.bmp.mode === 'disabled') {
    if (thresholds.bmp.maximumRequests !== 0 || thresholds.bmp.maximumBytes !== 0) {
      failures.push(`${label} disabled BMP thresholds must require zero requests and bytes`)
    }
  } else {
    if (comparisonBound && thresholds.bmp.mode !== 'required') {
      failures.push(`${label} BMP mode must be required or disabled`)
    }
    if (!positiveNumber(thresholds.bmp.maximumIntervalP95Ms)) {
      failures.push(`${label} BMP maximumIntervalP95Ms was invalid`)
    }
    if (!positiveInteger(thresholds.bmp.minimumAdvancedFrames)) {
      failures.push(`${label} BMP minimumAdvancedFrames was invalid`)
    }
  }
  if (comparisonBound) {
    if (!positiveNumber(thresholds.maximumTotalCpuP95Percent)) {
      failures.push(`${label} thresholds maximumTotalCpuP95Percent was invalid`)
    }
    for (const field of ['maximumEngineP95Percent', 'maximumDedicatedMiB', 'maximumSharedMiB']) {
      if (!positiveNumber(thresholds.gpu?.[field])) {
        failures.push(`${label} GPU threshold ${field} was invalid`)
      }
    }
  }
  const requiredRoles = ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg']
  for (const role of requiredRoles) {
    const roleThresholds = thresholds.roles?.[role]
    for (const field of [
      'maximumRssMiB',
      'maximumRssSlopeMiBPerMinute',
      'maximumAverageCpuPercent',
      'maximumP95CpuPercent'
    ]) {
      if (!positiveNumber(roleThresholds?.[field])) {
        failures.push(`${label} ${role} threshold ${field} was invalid`)
      }
    }
  }
}

function validateComparisonBinding(comparison, failures) {
  if (!nonEmptyString(comparison.aggregatePath)) {
    failures.push('comparison aggregatePath was missing')
  }
  if (!sha256(comparison.aggregateSha256)) {
    failures.push('comparison aggregateSha256 was invalid')
  }
  if (
    !Array.isArray(comparison.reportPaths) ||
    comparison.reportPaths.length !== 6 ||
    !comparison.reportPaths.every(nonEmptyString) ||
    new Set(comparison.reportPaths.map(canonicalEvidencePath)).size !== 6
  ) {
    failures.push('comparison must retain six report paths')
  }
  if (
    !Array.isArray(comparison.reportSha256) ||
    comparison.reportSha256.length !== 6 ||
    !comparison.reportSha256.every(sha256) ||
    new Set(comparison.reportSha256.map((digest) => digest.toLocaleLowerCase('en-US'))).size !== 6
  ) {
    failures.push('comparison must retain six report SHA-256 digests')
  }
}

function windowsBudgetPayloadScopeFailures(document, profile, context) {
  const actual = context?.candidatePayloadSha256
  if (!lowercaseSha256(actual)) {
    return [`candidatePayloadSha256 ${actual ?? 'missing'} was not a lowercase SHA-256 digest`]
  }
  const failures = []
  if (actual !== document.candidatePayloadSha256) {
    failures.push(
      `candidatePayloadSha256 ${actual} != ${document.candidatePayloadSha256 ?? 'missing'}`
    )
  }
  if (actual !== profile.candidatePayloadSha256) {
    failures.push(
      `profile candidatePayloadSha256 ${actual} != ${profile.candidatePayloadSha256 ?? 'missing'}`
    )
  }
  return failures
}

function windowsBudgetScopeFailures(scope, context, options = {}) {
  const failures = []
  for (const field of ['scenario', 'hardwareClass', 'profileClass', 'buildMode']) {
    if (scope?.[field] !== context?.[field]) {
      failures.push(`${field} ${context?.[field] ?? 'missing'} != ${scope?.[field] ?? 'missing'}`)
    }
  }
  for (const field of ['platform', 'arch']) {
    if (scope?.operatingSystem?.[field] !== context?.operatingSystem?.[field]) {
      failures.push(
        `operatingSystem.${field} ${context?.operatingSystem?.[field] ?? 'missing'} != ${scope?.operatingSystem?.[field] ?? 'missing'}`
      )
    }
  }
  if (
    options.requireComparison === true &&
    scope?.operatingSystem?.release !== context?.operatingSystem?.release
  ) {
    failures.push(
      `operatingSystem.release ${context?.operatingSystem?.release ?? 'missing'} != ${scope?.operatingSystem?.release ?? 'missing'}`
    )
  }
  for (const field of ['warmupMs', 'measurementMs', 'intervalMs']) {
    if (scope?.timing?.[field] !== context?.timing?.[field]) {
      failures.push(
        `timing.${field} ${context?.timing?.[field] ?? 'missing'} != ${scope?.timing?.[field] ?? 'missing'}`
      )
    }
  }
  return failures
}

function requireAtMost(failures, label, value, maximum) {
  if (!Number.isFinite(value)) failures.push(`${label} metric was missing`)
  else if (!Number.isFinite(maximum)) failures.push(`${label} budget threshold was missing`)
  else if (value > maximum) failures.push(`${label} ${value} exceeded ${maximum}`)
}

function requireAtLeast(failures, label, value, minimum) {
  if (!Number.isFinite(value)) failures.push(`${label} metric was missing`)
  else if (!Number.isFinite(minimum)) failures.push(`${label} budget threshold was missing`)
  else if (value < minimum) failures.push(`${label} ${value} was below ${minimum}`)
}

function formatContext(context) {
  return `scenario=${context?.scenario ?? 'missing'}, hardwareClass=${context?.hardwareClass ?? 'missing'}, platform=${context?.operatingSystem?.platform ?? 'missing'}`
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function canonicalEvidencePath(value) {
  return resolve('/', value.trim().replaceAll('\\', '/')).toLocaleLowerCase('en-US')
}

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function sha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function lowercaseSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function normalizeSha256(value) {
  return typeof value === 'string' ? value.toLocaleLowerCase('en-US') : value
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function equalSha256Arrays(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => normalizeSha256(value) === normalizeSha256(right[index]))
  )
}

function windowsBudgetEvidenceRunCount(scope) {
  return scope?.scenario === '1080p60-av-endurance' && scope?.timing?.measurementMs === 600_000
    ? 1
    : 3
}
