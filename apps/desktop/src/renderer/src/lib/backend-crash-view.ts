import type { BackendCrashRecord } from './backend'

export interface BackendCrashView {
  /** "code 101" / "signal SIGKILL" / "unknown exit". */
  exit: string
  /** Restart ladder position, or null when no restart was scheduled. */
  attempt: number | null
  uptime: string
  /** The one stderr line most likely to explain the exit: a Rust panic-hook
   * line when present, otherwise the last line the process printed. */
  headline: string | null
  /** Rust panic hook payload when the tail carries one. */
  panic: { message: string; location: string | null; thread: string | null } | null
  intentional: boolean
}

const PANIC_LINE_PREFIX = '{"panic":'

export function backendCrashExitLabel(record: Pick<BackendCrashRecord, 'code' | 'signal'>): string {
  if (record.signal) return `signal ${record.signal}`
  if (record.code !== null) return `code ${record.code}`
  return 'unknown exit'
}

export function formatBackendUptime(uptimeMs: number): string {
  if (uptimeMs < 1_000) return `${Math.max(0, Math.round(uptimeMs))}ms`
  if (uptimeMs < 60_000) return `${(uptimeMs / 1_000).toFixed(1)}s`
  if (uptimeMs < 3_600_000) return `${Math.round(uptimeMs / 60_000)}min`
  return `${(uptimeMs / 3_600_000).toFixed(1)}h`
}

export function parseBackendPanicLine(line: string): BackendCrashView['panic'] {
  const trimmed = line.trim()
  if (!trimmed.startsWith(PANIC_LINE_PREFIX)) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const value = parsed as Record<string, unknown>
    if (typeof value.panic !== 'string') return null
    return {
      message: value.panic,
      location: typeof value.location === 'string' ? value.location : null,
      thread: typeof value.thread === 'string' ? value.thread : null
    }
  } catch {
    return null
  }
}

export function backendCrashView(record: BackendCrashRecord): BackendCrashView {
  let panic: BackendCrashView['panic'] = null
  let panicLine: string | null = null
  for (let index = record.stderrTail.length - 1; index >= 0; index -= 1) {
    const parsed = parseBackendPanicLine(record.stderrTail[index])
    if (parsed) {
      panic = parsed
      panicLine = record.stderrTail[index]
      break
    }
  }
  const lastLine = record.stderrTail.at(-1) ?? null
  return {
    exit: backendCrashExitLabel(record),
    attempt: record.attempt,
    uptime: formatBackendUptime(record.uptimeMs),
    headline: panic
      ? `panic: ${panic.message}${panic.location ? ` (${panic.location})` : ''}`
      : (panicLine ?? lastLine),
    panic,
    intentional: record.intentional
  }
}

/** Most recent record, or null. Records are stored most recent first. */
export function latestBackendCrash(
  records: readonly BackendCrashRecord[] | undefined
): BackendCrashRecord | null {
  return records?.[0] ?? null
}
