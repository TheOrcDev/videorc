import type { UpdaterLogEntry } from '../shared/backend'

// The updater's own log: electron-updater's logger plus Videorc's
// `[auto-update]` lines. A packaged build has no console, so before this every
// updater line went nowhere and a support bundle could not say why an update
// kept failing (Windows field report, 2026-11-10: every 0.21.0 download was
// thrown away by a timed-out signature check, and the bundle had no trace).
// The last lines ride into the bundle via runtimeInfo.updater; each line also
// goes to a sink (main points it at the rotating backend.log).

export const UPDATER_LOG_CAPACITY = 40
/** electron-updater logs whole block-map range lists; keep a line readable. */
export const UPDATER_LOG_MESSAGE_MAX_CHARS = 600

export type UpdaterLogLevel = UpdaterLogEntry['level']
export type UpdaterLogSink = (level: UpdaterLogLevel, message: string) => void

export interface UpdaterLog {
  info: (message?: unknown) => void
  warn: (message?: unknown) => void
  error: (message?: unknown) => void
  /** electron-updater's debug lines are dropped. */
  debug: (message: string) => void
  setSink: (sink: UpdaterLogSink) => void
  /** Oldest first. */
  snapshot: () => UpdaterLogEntry[]
}

export function updaterLogMessage(message: unknown): string {
  const text =
    message instanceof Error
      ? message.message
      : typeof message === 'string'
        ? message
        : message === undefined
          ? ''
          : safeJson(message)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > UPDATER_LOG_MESSAGE_MAX_CHARS
    ? `${flat.slice(0, UPDATER_LOG_MESSAGE_MAX_CHARS - 1)}…`
    : flat
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function createUpdaterLog({
  capacity = UPDATER_LOG_CAPACITY,
  now = () => new Date(),
  sink = () => {}
}: {
  capacity?: number
  now?: () => Date
  sink?: UpdaterLogSink
} = {}): UpdaterLog {
  const entries: UpdaterLogEntry[] = []
  let currentSink = sink

  const record = (level: UpdaterLogLevel, raw: unknown): void => {
    const message = updaterLogMessage(raw)
    if (!message) {
      return
    }
    entries.push({ at: now().toISOString(), level, message })
    if (entries.length > capacity) {
      entries.splice(0, entries.length - capacity)
    }
    try {
      currentSink(level, message)
    } catch {
      // A broken sink must never break an update.
    }
  }

  return {
    info: (message) => record('info', message),
    warn: (message) => record('warn', message),
    error: (message) => record('error', message),
    debug: () => {},
    setSink: (next) => {
      currentSink = next
    },
    snapshot: () => entries.map((entry) => ({ ...entry }))
  }
}
