import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const PERFORMANCE_REPORT_SCHEMA_VERSION = 1
export const MACOS_CAFFEINATE_POWER_ASSERTION = 'caffeinate:-d,-i,-s'
const MACOS_CAFFEINATE_REQUIRED_ASSERTION_TYPES = [
  'PreventUserIdleDisplaySleep',
  'PreventUserIdleSystemSleep',
  'PreventSystemSleep'
]

export function performanceBuildMode(env = process.env) {
  return env.VIDEORC_SMOKE_PACKAGED_APP === '1' || env.VIDEORC_PERF_APP_EXECUTABLE
    ? 'packaged'
    : 'development'
}

export function performanceMode({ argv = process.argv.slice(2), env = process.env } = {}) {
  const gate = argv.includes('--gate') || env.VIDEORC_PERF_MODE === 'gate'
  const reportOnly = argv.includes('--report-only') || env.VIDEORC_PERF_MODE === 'report-only'
  if (gate && reportOnly) {
    throw new Error('Choose exactly one performance mode: --gate or --report-only.')
  }
  return gate ? 'gate' : 'report-only'
}

export function summarizeNumericSeries(samples, { warmupMs = 0, tailWindowMs = 120000 } = {}) {
  const normalized = samples
    .map((sample) => ({
      atMs: finiteNumber(sample.atMs),
      value: finiteNumber(sample.value)
    }))
    .filter((sample) => Number.isFinite(sample.atMs) && Number.isFinite(sample.value))
    .sort((left, right) => left.atMs - right.atMs)

  if (normalized.length === 0) {
    return emptySeriesSummary()
  }

  const originMs = normalized[0].atMs
  const measured = normalized.filter((sample) => sample.atMs - originMs >= warmupMs)
  const effective = measured.length > 0 ? measured : normalized
  const startMs = effective[0].atMs
  const endMs = effective.at(-1).atMs
  const firstWindowEnd = Math.min(endMs, startMs + tailWindowMs)
  const lastWindowStart = Math.max(startMs, endMs - tailWindowMs)
  const firstWindow = effective.filter((sample) => sample.atMs <= firstWindowEnd)
  const lastWindow = effective.filter((sample) => sample.atMs >= lastWindowStart)
  const secondHalfStart = startMs + (endMs - startMs) / 2
  const secondHalf = effective.filter((sample) => sample.atMs >= secondHalfStart)
  const firstMedian = median(firstWindow.map((sample) => sample.value))
  const lastMedian = median(lastWindow.map((sample) => sample.value))

  return {
    samples: effective.length,
    startAtMs: startMs,
    endAtMs: endMs,
    durationMs: Math.max(0, endMs - startMs),
    min: Math.min(...effective.map((sample) => sample.value)),
    max: Math.max(...effective.map((sample) => sample.value)),
    firstMedian,
    lastMedian,
    plateauGrowth: lastMedian - firstMedian,
    slopePerMinute: linearSlopePerMinute(effective),
    secondHalfSlopePerMinute: linearSlopePerMinute(secondHalf)
  }
}

export function evaluateSeriesGate(
  summary,
  {
    label = 'series',
    minSamples,
    maxValue,
    maxPlateauGrowth,
    maxSlopePerMinute,
    maxSecondHalfSlopePerMinute
  } = {}
) {
  const failures = []
  if (Number.isFinite(minSamples) && summary.samples < minSamples) {
    failures.push(`${label} had ${summary.samples} samples; expected at least ${minSamples}`)
  }
  addMaximumFailure(failures, `${label} maximum`, summary.max, maxValue)
  addMaximumFailure(
    failures,
    `${label} first/last median growth`,
    summary.plateauGrowth,
    maxPlateauGrowth
  )
  addMaximumFailure(
    failures,
    `${label} regression slope per minute`,
    summary.slopePerMinute,
    maxSlopePerMinute
  )
  addMaximumFailure(
    failures,
    `${label} second-half slope per minute`,
    summary.secondHalfSlopePerMinute,
    maxSecondHalfSlopePerMinute
  )
  return failures
}

export function evaluateScenarioTruth({
  frames,
  audioRequired = false,
  audioStreams,
  expectedTransport,
  actualTransport,
  expectedBacking,
  actualBacking,
  teardownClean
} = {}) {
  const failures = []
  if (frames !== undefined && (!Number.isFinite(frames) || frames <= 0)) {
    failures.push(`frame progress was ${String(frames)}; expected more than zero frames`)
  }
  if (audioRequired && (!Number.isInteger(audioStreams) || audioStreams < 1)) {
    failures.push('required audio stream was missing')
  }
  if (expectedTransport && actualTransport !== expectedTransport) {
    failures.push(
      `preview transport was ${actualTransport ?? 'missing'}; expected ${expectedTransport}`
    )
  }
  if (expectedBacking && actualBacking !== expectedBacking) {
    failures.push(`preview backing was ${actualBacking ?? 'missing'}; expected ${expectedBacking}`)
  }
  if (teardownClean === false) {
    failures.push('app-owned process teardown was not clean')
  }
  return failures
}

export function evaluateExplicitFallbackStatus({
  expectedTransport,
  actualTransport,
  expectedBacking,
  actualBacking,
  fallbackMessage,
  fallbackLabel = 'fallback'
} = {}) {
  const failures = evaluateScenarioTruth({
    expectedTransport,
    actualTransport,
    expectedBacking,
    actualBacking
  })
  const message = typeof fallbackMessage === 'string' ? fallbackMessage.trim() : ''
  if (!message) {
    failures.push('explicit fallback reason/message was missing')
    return failures
  }
  if (!message.toLowerCase().includes(String(fallbackLabel).toLowerCase())) {
    failures.push(`fallback reason/message did not identify ${fallbackLabel}`)
  }
  if (!/fallback/i.test(message)) {
    failures.push('fallback reason/message did not explicitly identify a fallback')
  }
  return failures
}

export function evaluateChildPerformanceRun({
  exit,
  report,
  startedAtMs,
  mode,
  expectedScenario,
  expectedMetadata,
  requireCleanProvenance = false
}) {
  const failures = []
  const commandPassed = exit?.code === 0 && !exit?.signal && !exit?.error
  const generatedAtMs = Date.parse(report?.generatedAt ?? '')
  const reportFresh =
    report?.schemaVersion === PERFORMANCE_REPORT_SCHEMA_VERSION &&
    Number.isFinite(generatedAtMs) &&
    generatedAtMs >= startedAtMs - 1000
  const verdictPassed = report?.verdict === 'pass'
  const verdictObserved = report?.verdict === 'observation'
  const verdictAccepted = verdictPassed || (mode === 'report-only' && verdictObserved)
  if (!commandPassed) {
    failures.push(
      `scenario command failed: code=${exit?.code} signal=${exit?.signal ?? 'none'} error=${exit?.error ?? 'none'}`
    )
  }
  if (!reportFresh) {
    failures.push('scenario did not produce a fresh versioned child performance report')
  }
  if (reportFresh && expectedScenario && report.scenario !== expectedScenario) {
    failures.push(
      `child performance scenario was ${report.scenario ?? 'missing'}; expected ${expectedScenario}`
    )
  }
  if (reportFresh && report.mode !== mode) {
    failures.push(`child performance mode was ${report.mode ?? 'missing'}; expected ${mode}`)
  }
  if (reportFresh && expectedMetadata) {
    failures.push(
      ...evaluateChildPerformanceMetadata({
        actual: report.metadata,
        expected: expectedMetadata,
        requireCleanProvenance
      })
    )
  }
  if (reportFresh && !verdictAccepted) {
    failures.push(
      mode === 'gate'
        ? `child performance verdict was ${report?.verdict ?? 'missing'}; expected pass`
        : `child performance verdict was ${report?.verdict ?? 'missing'}; expected pass or observation`
    )
  }
  return {
    ok: failures.length === 0,
    failures,
    commandPassed,
    reportFresh,
    verdictPassed,
    verdictObserved,
    verdictAccepted
  }
}

export async function collectPerformanceMetadata({ cwd = process.cwd(), env = process.env } = {}) {
  const executablePath = env.VIDEORC_PERF_APP_EXECUTABLE
    ? resolve(cwd, env.VIDEORC_PERF_APP_EXECUTABLE)
    : null
  const powerAssertion = nonEmptyString(env.VIDEORC_PERF_POWER_ASSERTION)
  const [
    commit,
    dirty,
    machineModel,
    macosVersion,
    displayScale,
    executableSha256,
    powerAssertionVerified
  ] = await Promise.all([
    commandOutput('git', ['rev-parse', 'HEAD'], cwd),
    commandOutput('git', ['status', '--porcelain'], cwd),
    commandOutput('sysctl', ['-n', 'hw.model']),
    commandOutput('sw_vers', ['-productVersion']),
    displayScaleFactor(),
    executablePath ? sha256FileOrNull(executablePath) : null,
    currentMacosCaffeinatePowerAssertionVerified({ env })
  ])
  return {
    capturedAt: new Date().toISOString(),
    commit: commit || null,
    dirty: Boolean(dirty),
    machineModel: machineModel || null,
    hardwareClass: performanceHardwareClass(env),
    operatingSystem: {
      platform: platform(),
      release: release(),
      macosVersion: macosVersion || null,
      arch: arch()
    },
    displayScaleFactor: displayScale,
    buildMode: performanceBuildMode(env),
    expectedBuildMode: nonEmptyString(env.VIDEORC_PERF_EXPECT_BUILD_MODE),
    runNonce: nonEmptyString(env.VIDEORC_PERF_RUN_NONCE),
    powerAssertion,
    powerAssertionVerified,
    executable: executablePath
      ? {
          path: executablePath,
          sha256: executableSha256
        }
      : null,
    appRole: env.VIDEORC_PERF_APP_ROLE || null,
    source: {
      width: positiveNumber(env.VIDEORC_PERF_SOURCE_WIDTH),
      height: positiveNumber(env.VIDEORC_PERF_SOURCE_HEIGHT),
      fps: positiveNumber(env.VIDEORC_PERF_SOURCE_FPS)
    },
    outputs: jsonArray(env.VIDEORC_PERF_OUTPUTS_JSON)
  }
}

export async function currentMacosCaffeinatePowerAssertionVerified({
  env = process.env,
  pid = process.pid,
  osPlatform = platform()
} = {}) {
  const declaredAssertion = nonEmptyString(env.VIDEORC_PERF_POWER_ASSERTION)
  if (!declaredAssertion) return null
  if (osPlatform !== 'darwin' || declaredAssertion !== MACOS_CAFFEINATE_POWER_ASSERTION) {
    return false
  }
  const assertions = await commandOutput('/usr/bin/pmset', ['-g', 'assertions'])
  return macosCaffeinatePowerAssertionVerified(assertions, pid)
}

export function macosCaffeinatePowerAssertionVerified(assertions, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const assertionTypes = new Set()
  let currentAssertionType = null
  for (const line of String(assertions ?? '').split('\n')) {
    const owner =
      /^\s*pid \d+\(caffeinate\):.*\b(Prevent(?:UserIdle)?(?:Display|System)Sleep)\b.*named: "caffeinate command-line tool"/.exec(
        line
      )
    if (owner) {
      currentAssertionType = owner[1]
      continue
    }
    if (/^\s*pid \d+\(/.test(line)) {
      currentAssertionType = null
      continue
    }
    if (
      currentAssertionType &&
      line.includes('caffeinate asserting on behalf of') &&
      line.includes(`(pid ${pid})`)
    ) {
      assertionTypes.add(currentAssertionType)
    }
  }
  return MACOS_CAFFEINATE_REQUIRED_ASSERTION_TYPES.every((type) => assertionTypes.has(type))
}

export function performanceWrapperMetadataAfterChild(wrapperMetadata, childMetadata) {
  const reconciledMetadata = performanceMetadataWithObservedDisplayScale(
    wrapperMetadata,
    childMetadata?.displayScaleFactor
  )
  if (!wrapperMetadata?.powerAssertion) return reconciledMetadata
  return {
    ...reconciledMetadata,
    powerAssertionVerified:
      childMetadata?.powerAssertion === wrapperMetadata.powerAssertion &&
      childMetadata?.powerAssertionVerified === true
  }
}

export function performanceMetadataWithObservedDisplayScale(metadata, observedScaleFactor) {
  if (metadata?.displayScaleFactor !== null && metadata?.displayScaleFactor !== undefined) {
    return metadata
  }
  const displayScaleFactor = positiveNumber(observedScaleFactor)
  return displayScaleFactor ? { ...metadata, displayScaleFactor } : metadata
}

export function performanceHardwareClass(env = process.env) {
  return nonEmptyString(env.VIDEORC_PERF_HARDWARE_CLASS)
}

export function evaluateChildPerformanceMetadata({ actual, expected, requireCleanProvenance }) {
  const failures = []
  const expectedBuildMode = expected?.expectedBuildMode ?? expected?.buildMode
  if (!['development', 'packaged'].includes(expectedBuildMode)) {
    failures.push('wrapper expected build mode was missing or invalid')
  } else {
    if (expected?.buildMode !== expectedBuildMode) {
      failures.push(
        `wrapper build mode was ${expected?.buildMode ?? 'missing'}; expected ${expectedBuildMode}`
      )
    }
    if (actual?.expectedBuildMode !== expectedBuildMode) {
      failures.push(
        `child expected build mode was ${actual?.expectedBuildMode ?? 'missing'}; expected ${expectedBuildMode}`
      )
    }
    if (actual?.buildMode !== expectedBuildMode) {
      failures.push(
        `child build mode was ${actual?.buildMode ?? 'missing'}; expected ${expectedBuildMode}`
      )
    }
  }

  const expectedNonce = nonEmptyString(expected?.runNonce)
  if (!expectedNonce) {
    failures.push('wrapper performance run nonce was missing')
  } else if (actual?.runNonce !== expectedNonce) {
    failures.push(
      `child performance run nonce was ${actual?.runNonce ?? 'missing'}; expected ${expectedNonce}`
    )
  }
  if ((actual?.hardwareClass ?? null) !== (expected?.hardwareClass ?? null)) {
    failures.push(
      `child hardware class was ${actual?.hardwareClass ?? 'missing'}; expected ${expected?.hardwareClass ?? 'missing'}`
    )
  }
  if ((actual?.powerAssertion ?? null) !== (expected?.powerAssertion ?? null)) {
    failures.push(
      `child power assertion was ${actual?.powerAssertion ?? 'missing'}; expected ${expected?.powerAssertion ?? 'missing'}`
    )
  }
  if (expected?.powerAssertion && actual?.powerAssertionVerified !== true) {
    failures.push('child macOS power assertion was declared but not verified at runtime')
  }

  if (requireCleanProvenance) {
    if (!validGitCommit(expected?.commit)) {
      failures.push('wrapper commit provenance was missing or invalid')
    }
    if (expected?.dirty !== false) {
      failures.push('wrapper commit provenance was dirty')
    }
    if (!validGitCommit(actual?.commit)) {
      failures.push('child commit provenance was missing or invalid')
    } else if (validGitCommit(expected?.commit) && actual.commit !== expected.commit) {
      failures.push(`child commit ${actual.commit} did not match wrapper commit ${expected.commit}`)
    }
    if (actual?.dirty !== false) {
      failures.push('child commit provenance was dirty')
    }
  }

  if (expectedBuildMode === 'packaged') {
    const expectedHash = expected?.executable?.sha256
    const actualHash = actual?.executable?.sha256
    if (!validSha256(expectedHash)) {
      failures.push('wrapper packaged executable SHA-256 was missing or invalid')
    }
    if (!validSha256(actualHash)) {
      failures.push('child packaged executable SHA-256 was missing or invalid')
    } else if (validSha256(expectedHash) && actualHash !== expectedHash) {
      failures.push('child packaged executable SHA-256 did not match the wrapper executable')
    }
  }

  return failures
}

export function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', rejectHash)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolveHash(hash.digest('hex')))
  })
}

export function createPerformanceReport({ scenario, mode, metadata, timing, metrics, checks }) {
  const normalizedChecks = (checks ?? []).map(normalizePerformanceCheck)
  const verdict = normalizedChecks.some((check) => check.status === 'fail')
    ? 'fail'
    : normalizedChecks.some((check) => check.status === 'observation')
      ? 'observation'
      : 'pass'
  return {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    scenario,
    mode,
    generatedAt: new Date().toISOString(),
    metadata,
    timing,
    verdict,
    checks: normalizedChecks,
    metrics
  }
}

export async function writePerformanceReport(
  report,
  { path = process.env.VIDEORC_PERF_REPORT_PATH, root = process.env.VIDEORC_PERF_ARTIFACT_DIR } = {}
) {
  const reportPath = resolve(
    path ??
      join(
        root ?? 'docs/acceptance/artifacts/performance',
        `${safeName(report.scenario)}-${timestampForPath()}.json`
      )
  )
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return reportPath
}

export function passingCheck(message) {
  return { ok: true, status: 'pass', message }
}

export function observationCheck(message) {
  return { ok: null, status: 'observation', message }
}

export function failingChecks(messages) {
  return messages.map((message) => ({ ok: false, status: 'fail', message }))
}

function normalizePerformanceCheck(check) {
  if (typeof check === 'string') {
    return { ok: false, status: 'fail', message: check }
  }
  if (check?.status === 'observation') {
    return { ...check, ok: null, status: 'observation' }
  }
  if (check?.status === 'fail') {
    return { ...check, ok: false, status: 'fail' }
  }
  // Compatibility for the first performance-report consumers, which expressed
  // report-only budget misses as passing checks with this stable prefix. Keeping
  // the normalization here prevents an observed regression from becoming a
  // machine-readable PASS while those callers migrate to observationCheck().
  if (check?.ok === true && /^report-only observation:/i.test(check?.message ?? '')) {
    return { ...check, ok: null, status: 'observation' }
  }
  const ok = check?.status === 'pass' || check?.ok === true
  return { ...check, ok, status: ok ? 'pass' : 'fail' }
}

function emptySeriesSummary() {
  return {
    samples: 0,
    startAtMs: null,
    endAtMs: null,
    durationMs: 0,
    min: null,
    max: null,
    firstMedian: null,
    lastMedian: null,
    plateauGrowth: null,
    slopePerMinute: null,
    secondHalfSlopePerMinute: null
  }
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function linearSlopePerMinute(samples) {
  if (samples.length < 2) return 0
  const originMs = samples[0].atMs
  const points = samples.map((sample) => ({
    x: (sample.atMs - originMs) / 60000,
    y: sample.value
  }))
  const meanX = points.reduce((total, point) => total + point.x, 0) / points.length
  const meanY = points.reduce((total, point) => total + point.y, 0) / points.length
  let numerator = 0
  let denominator = 0
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY)
    denominator += (point.x - meanX) ** 2
  }
  return denominator === 0 ? 0 : numerator / denominator
}

function addMaximumFailure(failures, label, actual, maximum) {
  if (!Number.isFinite(maximum) || !Number.isFinite(actual)) return
  if (actual > maximum) {
    failures.push(`${label} ${formatNumber(actual)} exceeded ${formatNumber(maximum)}`)
  }
}

async function commandOutput(command, args, cwd) {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function displayScaleFactor() {
  if (platform() !== 'darwin') return null
  const output = await commandOutput('system_profiler', ['SPDisplaysDataType', '-json'])
  if (!output) return null
  try {
    const parsed = JSON.parse(output)
    const displays =
      parsed.SPDisplaysDataType?.flatMap((entry) => entry.spdisplays_ndrvs ?? []) ?? []
    const display =
      displays.find((candidate) => candidate.spdisplays_main === 'spdisplays_yes') ?? displays[0]
    if (!display) return null
    if (
      display.spdisplays_retina === 'spdisplays_yes' ||
      /retina/i.test(display.spdisplays_pixelresolution ?? '')
    ) {
      return 2
    }
    const physicalWidth = firstDimension(display._spdisplays_pixels)
    const logicalWidth = firstDimension(display._spdisplays_resolution)
    return physicalWidth && logicalWidth ? physicalWidth / logicalWidth : 1
  } catch {
    return null
  }
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : Number.NaN
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function jsonArray(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function sha256FileOrNull(path) {
  try {
    return await sha256File(path)
  } catch {
    return null
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function validGitCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)
}

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function firstDimension(value) {
  const match = String(value ?? '').match(/^(\d+)\s*x/i)
  const number = Number(match?.[1])
  return Number.isFinite(number) && number > 0 ? number : null
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function safeName(value) {
  return String(value ?? 'performance')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
