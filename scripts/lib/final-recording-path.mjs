import { existsSync } from 'node:fs'

const DEFAULT_POLL_MS = 250

export async function resolveFinalRecordingPath({
  started,
  stopped,
  recordingStatusEvents = [],
  healthEvents = [],
  stopRequestedAt = 0,
  timeoutMs = 60000,
  pollMs = DEFAULT_POLL_MS,
  exists = existsSync,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const startedWaitingAt = now()

  while (now() - startedWaitingAt <= timeoutMs) {
    const candidates = orderedRecordingPathCandidates({
      started,
      stopped,
      recordingStatusEvents,
      stopRequestedAt,
    })

    const finalPath = candidates.find((path) => !isTemporaryMkvPath(path) && exists(path))
    if (finalPath) return finalPath

    const fallbackPath = candidates.find((path) => isTemporaryMkvPath(path) && exists(path))
    if (fallbackPath && mp4ExportFailed(healthEvents, stopRequestedAt, stopped?.sessionId ?? started?.sessionId)) {
      return fallbackPath
    }

    await sleep(pollMs)
  }

  return null
}

export function orderedRecordingPathCandidates({ started, stopped, recordingStatusEvents = [], stopRequestedAt = 0 } = {}) {
  const sessionId = stopped?.sessionId ?? started?.sessionId ?? null
  const rawPaths = []

  for (const status of [...recordingStatusEvents].reverse()) {
    if ((status.receivedAt ?? 0) < stopRequestedAt) continue
    if (sessionId && status.sessionId && status.sessionId !== sessionId) continue
    if (status.outputPath) rawPaths.push(status.outputPath)
  }

  if (stopped?.outputPath) rawPaths.push(stopped.outputPath)
  if (started?.outputPath) rawPaths.push(started.outputPath)

  const candidates = []
  for (const path of rawPaths) {
    if (!path) continue
    if (isTemporaryMkvPath(path)) candidates.push(path.replace(/\.mkv$/i, '.mp4'))
    candidates.push(path)
  }

  return unique(candidates)
}

function mp4ExportFailed(healthEvents, stopRequestedAt, sessionId) {
  return healthEvents.some((event) => {
    if ((event.receivedAt ?? 0) < stopRequestedAt) return false
    if (sessionId && event.sessionId && event.sessionId !== sessionId) return false
    return event.code === 'mp4-export-failed'
  })
}

function isTemporaryMkvPath(path) {
  return /\.mkv$/i.test(path ?? '')
}

function unique(values) {
  return [...new Set(values)]
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
