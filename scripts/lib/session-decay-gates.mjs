export const SESSION_DECAY_THRESHOLDS = Object.freeze({
  sourceCoverageRatio: 0.9,
  sourceMinFreshnessRatio: 0.9,
  sourceFreshRateSlackFps: 2,
  sourceMaxServedAgeMs: 200,
  bridgeCoverageRatio: 0.95,
  bridgeMaxDegradedRatio: 0.05
})

const SOURCE_KEYS = Object.freeze({
  screen: {
    fresh: 'compositorScreenSourceFreshServes',
    held: 'compositorScreenSourceHeldServes',
    age: 'compositorScreenSourceServedAgeMaxMs'
  },
  camera: {
    fresh: 'compositorCameraSourceFreshServes',
    held: 'compositorCameraSourceHeldServes',
    age: 'compositorCameraSourceServedAgeMaxMs'
  }
})

const WRITER_FAILURE_CODES = new Set([
  'encoder-bridge-writer-leaked',
  'encoder-bridge-writer-lingering'
])

function ratio(numerator, denominator) {
  return Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : null
}

function readNonNegativeNumber(diagnostics, key, failures) {
  const value = diagnostics?.[key]
  if (value === undefined || value === null) {
    failures.push(`${key} is missing`)
    return 0
  }
  if (!Number.isFinite(value) || value < 0) {
    failures.push(`${key} must be a finite non-negative number`)
    return 0
  }
  return value
}

export function evaluateSessionDecayEvidence({
  diagnostics,
  requestedSources,
  targetFps,
  elapsedMs
}) {
  const failures = []
  if (!Number.isFinite(targetFps) || targetFps <= 0) {
    failures.push('targetFps must be a finite positive number')
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    failures.push('elapsedMs must be a finite positive number')
  }
  if (!requestedSources || typeof requestedSources !== 'object') {
    failures.push('requestedSources must identify screen and camera requirements')
  }
  const elapsedSeconds = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs / 1000 : null
  const expectedFrames =
    elapsedSeconds != null && Number.isFinite(targetFps) && targetFps > 0
      ? elapsedSeconds * targetFps
      : null
  const sources = {}

  for (const source of ['screen', 'camera']) {
    if (!requestedSources?.[source]) continue
    const keys = SOURCE_KEYS[source]
    const freshServes = readNonNegativeNumber(diagnostics, keys.fresh, failures)
    const heldServes = readNonNegativeNumber(diagnostics, keys.held, failures)
    const servedAgeMaxMs = readNonNegativeNumber(diagnostics, keys.age, failures)
    const totalServes = freshServes + heldServes
    sources[source] = {
      freshServes,
      heldServes,
      totalServes,
      servedAgeMaxMs,
      coverageRatio: ratio(totalServes, expectedFrames),
      freshRateFps: ratio(freshServes, elapsedSeconds),
      freshnessRatio: ratio(freshServes, totalServes)
    }
    if (
      sources[source].coverageRatio == null ||
      sources[source].coverageRatio < SESSION_DECAY_THRESHOLDS.sourceCoverageRatio
    ) {
      failures.push(
        `${source} coverage ${formatRatio(sources[source].coverageRatio)} is below ${(SESSION_DECAY_THRESHOLDS.sourceCoverageRatio * 100).toFixed(0)}%`
      )
    }
    if (
      sources[source].freshnessRatio == null ||
      sources[source].freshnessRatio < SESSION_DECAY_THRESHOLDS.sourceMinFreshnessRatio
    ) {
      failures.push(
        `${source} freshness ${formatRatio(sources[source].freshnessRatio)} is below ${(SESSION_DECAY_THRESHOLDS.sourceMinFreshnessRatio * 100).toFixed(0)}%`
      )
    }
    const minimumFreshRate = targetFps - SESSION_DECAY_THRESHOLDS.sourceFreshRateSlackFps
    if (
      !Number.isFinite(minimumFreshRate) ||
      sources[source].freshRateFps == null ||
      sources[source].freshRateFps < minimumFreshRate
    ) {
      failures.push(
        `${source} fresh rate ${formatNumber(sources[source].freshRateFps, 2)}fps is below ${formatNumber(minimumFreshRate, 2)}fps`
      )
    }
    if (servedAgeMaxMs > SESSION_DECAY_THRESHOLDS.sourceMaxServedAgeMs) {
      failures.push(
        `${source} served age ${servedAgeMaxMs.toFixed(0)}ms exceeds ${SESSION_DECAY_THRESHOLDS.sourceMaxServedAgeMs}ms`
      )
    }
  }

  const freshFrames = readNonNegativeNumber(diagnostics, 'encoderBridgeFreshFrames', failures)
  const repeatedFrames = readNonNegativeNumber(diagnostics, 'encoderBridgeRepeatedFrames', failures)
  const syntheticFrames = readNonNegativeNumber(
    diagnostics,
    'encoderBridgeSyntheticFrames',
    failures
  )
  const inputFrames = freshFrames + repeatedFrames + syntheticFrames
  const bridge = {
    freshFrames,
    repeatedFrames,
    syntheticFrames,
    inputFrames,
    coverageRatio: ratio(inputFrames, expectedFrames),
    degradedRatio: ratio(repeatedFrames + syntheticFrames, inputFrames)
  }
  if (
    bridge.coverageRatio == null ||
    bridge.coverageRatio < SESSION_DECAY_THRESHOLDS.bridgeCoverageRatio
  ) {
    failures.push(
      `bridge coverage ${formatRatio(bridge.coverageRatio)} is below ${(SESSION_DECAY_THRESHOLDS.bridgeCoverageRatio * 100).toFixed(0)}%`
    )
  }
  if (
    bridge.degradedRatio == null ||
    bridge.degradedRatio > SESSION_DECAY_THRESHOLDS.bridgeMaxDegradedRatio
  ) {
    failures.push(
      `bridge degraded input ${formatRatio(bridge.degradedRatio)} exceeds ${(SESSION_DECAY_THRESHOLDS.bridgeMaxDegradedRatio * 100).toFixed(0)}%`
    )
  }

  return { failures, sources, bridge }
}

function formatNumber(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

function formatRatio(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a'
}

/**
 * Parse the authoritative `recording-frame-accounting` message emitted after
 * writer teardown. The parser intentionally returns missing fields as absent;
 * evaluateSessionDecayEvidence then fails closed on each required counter.
 */
export function parseRecordingFrameAccounting(message) {
  const text = typeof message === 'string' ? message : ''
  const duration = text.match(/duration\s+([\d.]+)s\s+@\s+target\s+([\d.]+)\s+fps/i)
  const serves = text.match(
    /source serves:\s*screen\s+(\d+)\s+fresh\s*\/\s*(\d+)\s+held\s*\(oldest\s+(\d+)ms\),\s*camera\s+(\d+)\s+fresh\s*\/\s*(\d+)\s+held\s*\(oldest\s+(\d+)ms\)/i
  )
  const bridge = text.match(
    /bridge input:\s*(\d+)\s*\((\d+)\s+fresh,\s*(\d+)\s+repeat,\s*(\d+)\s+synthetic\)/i
  )
  const lifecycle = text.match(
    /encoderBridgeLifecycle\s+liveOuter=(\d+)\s+liveFifo=(\d+)\s+liveResources=(\d+)\s+detached=(\d+)\s+teardownDurationMs=(\d+)/
  )
  const diagnostics = {}
  if (serves) {
    Object.assign(diagnostics, {
      compositorScreenSourceFreshServes: Number(serves[1]),
      compositorScreenSourceHeldServes: Number(serves[2]),
      compositorScreenSourceServedAgeMaxMs: Number(serves[3]),
      compositorCameraSourceFreshServes: Number(serves[4]),
      compositorCameraSourceHeldServes: Number(serves[5]),
      compositorCameraSourceServedAgeMaxMs: Number(serves[6])
    })
  }
  if (bridge) {
    Object.assign(diagnostics, {
      encoderBridgeInputFrames: Number(bridge[1]),
      encoderBridgeFreshFrames: Number(bridge[2]),
      encoderBridgeRepeatedFrames: Number(bridge[3]),
      encoderBridgeSyntheticFrames: Number(bridge[4])
    })
  }
  return {
    elapsedMs: duration ? Number(duration[1]) * 1000 : null,
    targetFps: duration ? Number(duration[2]) : null,
    diagnostics,
    writerLifecycle: lifecycle
      ? {
          liveOuter: Number(lifecycle[1]),
          liveFifo: Number(lifecycle[2]),
          liveResources: Number(lifecycle[3]),
          detached: Number(lifecycle[4]),
          teardownDurationMs: Number(lifecycle[5])
        }
      : null
  }
}

/**
 * The backend emits writer failures and final frame accounting before the
 * session's terminal recording.status on the same ordered reliable event lane.
 * Receiving that terminal event is therefore the deterministic delivery
 * barrier for exact-once lifecycle evaluation.
 */
export async function waitForSessionTerminalStatus({
  events,
  sessionId,
  timeoutMs,
  pollIntervalMs = 25,
  now = Date.now,
  sleep = (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs))
}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('terminal recording status requires a session id')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('terminal recording status timeout must be a finite positive number')
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('terminal recording status poll interval must be a finite positive number')
  }

  const deadline = now() + timeoutMs
  while (true) {
    const terminalEvent = (Array.isArray(events) ? events : []).find(
      (event) =>
        event?.event === 'recording.status' &&
        event?.payload?.sessionId === sessionId &&
        (event?.payload?.state === 'idle' || event?.payload?.state === 'failed')
    )
    if (terminalEvent) return terminalEvent.payload

    const remainingMs = deadline - now()
    if (remainingMs <= 0) {
      throw new Error(`session ${sessionId} timed out waiting for terminal recording.status`)
    }
    await sleep(Math.min(pollIntervalMs, remainingMs))
  }
}

export function evaluateSessionDecayLifecycleEvents({ events, sessionId }) {
  const matchingEvents = (Array.isArray(events) ? events : []).filter(
    (event) =>
      (event?.event === 'health.event' || event?.event === 'session.log') &&
      event?.payload?.sessionId === sessionId &&
      typeof event?.payload?.code === 'string'
  )
  const codes = new Set(matchingEvents.map((event) => event.payload.code))
  const failures = []
  const accountingEvents = matchingEvents.filter(
    (event) => event.payload.code === 'recording-frame-accounting'
  )
  const accountingEvent = accountingEvents.length === 1 ? accountingEvents[0] : null
  const accounting = accountingEvent
    ? parseRecordingFrameAccounting(accountingEvent.payload.message)
    : null
  if (accountingEvents.length === 0) {
    failures.push(`session ${sessionId} is missing recording-frame-accounting`)
  } else if (accountingEvents.length !== 1) {
    failures.push(
      `session ${sessionId} reported ${accountingEvents.length} recording-frame-accounting events; expected exactly one`
    )
  } else {
    if (!Number.isFinite(accounting.elapsedMs) || accounting.elapsedMs <= 0) {
      failures.push(`session ${sessionId} final accounting has no valid duration`)
    }
    if (!Number.isFinite(accounting.targetFps) || accounting.targetFps <= 0) {
      failures.push(`session ${sessionId} final accounting has no valid target fps`)
    }
    const input = accounting.diagnostics.encoderBridgeInputFrames
    const components =
      accounting.diagnostics.encoderBridgeFreshFrames +
      accounting.diagnostics.encoderBridgeRepeatedFrames +
      accounting.diagnostics.encoderBridgeSyntheticFrames
    if (!Number.isFinite(input) || !Number.isFinite(components)) {
      failures.push(`session ${sessionId} final accounting has no bridge input counters`)
    } else if (input !== components) {
      failures.push(
        `session ${sessionId} final accounting bridge input ${input} does not match components ${components}`
      )
    }
    const writer = accounting.writerLifecycle
    if (!writer) {
      failures.push(`session ${sessionId} final accounting has no writer lifecycle counters`)
    } else {
      const countEntries = [
        ['outer', writer.liveOuter],
        ['fifo', writer.liveFifo],
        ['resources', writer.liveResources],
        ['detached', writer.detached]
      ]
      for (const [label, value] of countEntries) {
        if (!Number.isFinite(value) || value < 0) {
          failures.push(
            `session ${sessionId} final accounting writer ${label} must be a finite non-negative number`
          )
        }
      }
      if (!Number.isFinite(writer.teardownDurationMs) || writer.teardownDurationMs < 0) {
        failures.push(
          `session ${sessionId} final accounting writer teardown duration must be a finite non-negative number`
        )
      }
      if (
        countEntries.every(([, value]) => Number.isFinite(value) && value >= 0) &&
        countEntries.some(([, value]) => value !== 0)
      ) {
        failures.push(
          `session ${sessionId} final accounting reports live writer resources ` +
            `(outer=${writer.liveOuter}, fifo=${writer.liveFifo}, resources=${writer.liveResources}, detached=${writer.detached})`
        )
      }
    }
  }
  for (const code of WRITER_FAILURE_CODES) {
    if (codes.has(code)) {
      failures.push(`session ${sessionId} reported ${code}`)
    }
  }
  return { failures, codes: [...codes], accounting }
}
