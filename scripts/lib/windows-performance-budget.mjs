import { readFile } from 'node:fs/promises'

export class WindowsPerformanceBudgetError extends Error {
  constructor(failures) {
    super(`Windows performance budget was invalid or did not match:\n${failures.join('\n')}`)
    this.name = 'WindowsPerformanceBudgetError'
    this.failures = failures
  }
}

export async function loadWindowsPerformanceBudget({ path, profileId, context, read = readFile }) {
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
  const validationFailures = validateWindowsPerformanceBudget(document)
  if (validationFailures.length > 0) throw new WindowsPerformanceBudgetError(validationFailures)

  const profiles = document.profiles.filter((profile) =>
    profileId
      ? profile.id === profileId
      : windowsBudgetScopeFailures(profile.scope, context).length === 0
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
  const scopeFailures = windowsBudgetScopeFailures(profile.scope, context)
  if (scopeFailures.length > 0) {
    throw new WindowsPerformanceBudgetError([
      `Windows performance budget profile ${profile.id} did not match: ${scopeFailures.join('; ')}`
    ])
  }
  return { path, profile }
}

export function validateWindowsPerformanceBudget(document) {
  const failures = []
  if (document?.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (document?.kind !== 'videorc.windows-performance-budget-set') {
    failures.push('kind must be videorc.windows-performance-budget-set')
  }
  if (document?.status !== 'active') failures.push('status must be active')
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
    validateScope(profile?.scope, label, failures)
    validateEvidence(profile?.evidence, label, failures)
    validateThresholds(profile?.thresholds, label, failures)
  }
  return failures
}

export function evaluateWindowsPerformanceBudget(profile, metrics) {
  const failures = []
  const thresholds = profile?.thresholds
  const memory = metrics?.processTree?.memory?.summary
  const cpu = metrics?.processTree?.cpu?.summary?.byRole
  const bmp = metrics?.bmp

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

function validateScope(scope, label, failures) {
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
  for (const field of ['warmupMs', 'measurementMs', 'intervalMs']) {
    if (!positiveInteger(scope.timing?.[field]))
      failures.push(`${label} scope timing ${field} was invalid`)
  }
}

function validateEvidence(evidence, label, failures) {
  if (!isRecord(evidence)) {
    failures.push(`${label} evidence was missing`)
    return
  }
  if (evidence.runCount !== 3) failures.push(`${label} evidence runCount must be 3`)
  if (!Array.isArray(evidence.reportPaths) || evidence.reportPaths.length !== 3) {
    failures.push(`${label} evidence must retain three report paths`)
  }
  if (
    !nonEmptyString(evidence.calibrationSha256) ||
    !/^[0-9a-f]{64}$/i.test(evidence.calibrationSha256)
  ) {
    failures.push(`${label} evidence calibrationSha256 was invalid`)
  }
}

function validateThresholds(thresholds, label, failures) {
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
  } else {
    if (!positiveNumber(thresholds.bmp.maximumIntervalP95Ms)) {
      failures.push(`${label} BMP maximumIntervalP95Ms was invalid`)
    }
    if (!positiveInteger(thresholds.bmp.minimumAdvancedFrames)) {
      failures.push(`${label} BMP minimumAdvancedFrames was invalid`)
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

function windowsBudgetScopeFailures(scope, context) {
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

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}
