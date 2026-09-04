import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

const MAX_HEALTH_EVENTS_IN_ERROR = 8
const MAX_DIAGNOSTIC_LENGTH = 500

export function assertTerminalRecordingStop({
  scenarioLabel = 'Recording',
  started,
  stopped,
  healthEvents = [],
  healthLookupError
} = {}) {
  if (isTerminalRecordingStop({ started, stopped })) {
    return
  }

  const expectedSessionId = nonemptyString(started?.sessionId)
  const stoppedSessionId = nonemptyString(stopped?.sessionId)
  const stoppedState = nonemptyString(stopped?.state)

  const expected = `${expectedSessionId ?? 'missing session ID'}/idle`
  const received = `${stoppedSessionId ?? 'missing session ID'}/${stoppedState ?? 'missing state'}`
  const details = [
    `[${scenarioLabel}] session.stop did not confirm terminal idle for the started session ` +
      `(expected ${expected}; received ${received}).`
  ]
  const terminalMessage = compactDiagnostic(stopped?.message)
  if (terminalMessage) {
    details.push(`Terminal message: ${terminalMessage}.`)
  }

  const healthContext = formatHealthContext(healthEvents)
  if (healthContext) {
    details.push(`Health events: ${healthContext}.`)
  } else if (healthLookupError) {
    details.push(
      `Health lookup failed: ${compactDiagnostic(healthLookupError.message ?? healthLookupError)}.`
    )
  } else {
    details.push('Health events: none returned.')
  }

  throw new Error(details.join(' '))
}

export function isTerminalRecordingStop({ started, stopped } = {}) {
  const expectedSessionId = nonemptyString(started?.sessionId)
  const stoppedSessionId = nonemptyString(stopped?.sessionId)
  return Boolean(
    expectedSessionId && stoppedSessionId === expectedSessionId && stopped?.state === 'idle'
  )
}

export async function assertFinalizedRecordingStop({
  scenarioLabel = 'Recording',
  started,
  stopped,
  loadHealthEvents
} = {}) {
  let healthEvents = []
  let healthLookupError
  const terminalStop = isTerminalRecordingStop({ started, stopped })
  const outputPath = nonemptyString(stopped?.outputPath)
  const publishedMp4 = outputPath && extname(outputPath).toLowerCase() === '.mp4'

  if ((!terminalStop || !publishedMp4) && typeof loadHealthEvents === 'function') {
    try {
      healthEvents =
        (await loadHealthEvents(
          nonemptyString(started?.sessionId) ?? nonemptyString(stopped?.sessionId)
        )) ?? []
    } catch (error) {
      healthLookupError = error
    }
  }

  assertTerminalRecordingStop({
    scenarioLabel,
    started,
    stopped,
    healthEvents,
    healthLookupError
  })
  assertPublishedRecordingMp4({
    scenarioLabel,
    stopped,
    healthEvents,
    healthLookupError
  })
}

export function assertNoZeroByteScenarioMkvs(options = {}) {
  const emptyPaths = zeroByteScenarioMkvPaths(options)
  if (emptyPaths.length === 0) {
    return
  }

  const scenarioLabel = options.scenarioLabel ?? 'Recording'
  throw new Error(
    `[${scenarioLabel}] Found zero-byte MKV artifact(s) scoped to the completed scenario: ` +
      emptyPaths.join(', ')
  )
}

export function assertNoZeroByteMkvsCreatedAfter(options = {}) {
  const emptyPaths = zeroByteMkvsCreatedAfter(options)
  if (emptyPaths.length === 0) {
    return
  }

  const scenarioLabel = options.scenarioLabel ?? 'Recording'
  const startupError = compactDiagnostic(options.startupError?.message ?? options.startupError)
  throw new Error(
    `[${scenarioLabel}] session.start failed and left new zero-byte MKV artifact(s): ` +
      `${emptyPaths.join(', ')}${startupError ? `. Startup error: ${startupError}.` : ''}`
  )
}

export function assertPublishedRecordingMp4({
  scenarioLabel = 'Recording',
  stopped,
  healthEvents = [],
  healthLookupError
} = {}) {
  const outputPath = nonemptyString(stopped?.outputPath)
  if (outputPath && extname(outputPath).toLowerCase() === '.mp4') {
    return
  }

  const details = [
    `[${scenarioLabel}] Recording reached idle without publishing the required MP4 ` +
      `(received ${outputPath ?? 'missing output path'}).`
  ]
  const healthContext = formatHealthContext(healthEvents)
  if (healthContext) {
    details.push(`Health events: ${healthContext}.`)
  } else if (healthLookupError) {
    details.push(
      `Health lookup failed: ${compactDiagnostic(healthLookupError.message ?? healthLookupError)}.`
    )
  } else {
    details.push('Health events: none returned.')
  }
  throw new Error(details.join(' '))
}

export function snapshotScenarioMkvPaths({
  outputDirectory,
  exists = existsSync,
  readDirectory = readdirSync
} = {}) {
  if (!nonemptyString(outputDirectory)) {
    return []
  }
  const outputRoot = resolve(outputDirectory)
  if (!exists(outputRoot)) {
    return []
  }
  return readDirectory(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.mkv')
    .map((entry) => join(outputRoot, entry.name))
    .sort()
}

export function zeroByteMkvsCreatedAfter({
  outputDirectory,
  beforePaths = [],
  exists = existsSync,
  readDirectory = readdirSync,
  stat = statSync
} = {}) {
  const before = new Set(beforePaths.map((path) => resolve(path)))
  return snapshotScenarioMkvPaths({ outputDirectory, exists, readDirectory }).filter((path) => {
    if (before.has(path) || !exists(path)) {
      return false
    }
    const metadata = stat(path)
    return metadata.isFile() && metadata.size === 0
  })
}

export function zeroByteScenarioMkvPaths({
  outputDirectory,
  sessionId,
  outputPaths = [],
  exists = existsSync,
  readDirectory = readdirSync,
  stat = statSync
} = {}) {
  if (!nonemptyString(outputDirectory)) {
    return []
  }

  const outputRoot = resolve(outputDirectory)
  if (!exists(outputRoot)) {
    return []
  }

  const candidates = new Set()
  for (const outputPath of outputPaths) {
    addOutputPathCandidates(candidates, outputRoot, outputPath)
  }

  const scopedSessionId = nonemptyString(sessionId)
  if (scopedSessionId) {
    for (const entry of readDirectory(outputRoot, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        extname(entry.name).toLowerCase() === '.mkv' &&
        entry.name.includes(scopedSessionId)
      ) {
        candidates.add(join(outputRoot, entry.name))
      }
    }
  }

  return [...candidates].sort().filter((candidate) => {
    if (!exists(candidate)) {
      return false
    }
    const metadata = stat(candidate)
    return metadata.isFile() && metadata.size === 0
  })
}

function addOutputPathCandidates(candidates, outputRoot, outputPath) {
  if (!nonemptyString(outputPath)) {
    return
  }

  const resolvedPath = resolve(outputPath)
  if (dirname(resolvedPath) !== outputRoot) {
    return
  }

  const extension = extname(resolvedPath).toLowerCase()
  if (extension === '.mkv') {
    candidates.add(resolvedPath)
  } else if (extension === '.mp4') {
    candidates.add(join(outputRoot, `${basename(resolvedPath, extname(resolvedPath))}.mkv`))
  }
}

function formatHealthContext(healthEvents) {
  if (!Array.isArray(healthEvents) || healthEvents.length === 0) {
    return null
  }

  return healthEvents
    .slice(-MAX_HEALTH_EVENTS_IN_ERROR)
    .map((event) => {
      const level = compactDiagnostic(event?.level) ?? 'unknown-level'
      const code = compactDiagnostic(event?.code) ?? 'unknown-code'
      const message = compactDiagnostic(event?.message)
      return `[${level}/${code}]${message ? ` ${message}` : ''}`
    })
    .join(' | ')
}

function compactDiagnostic(value) {
  if (value == null) {
    return null
  }
  const compacted = String(value).replace(/\s+/g, ' ').trim()
  return compacted ? compacted.slice(0, MAX_DIAGNOSTIC_LENGTH) : null
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
