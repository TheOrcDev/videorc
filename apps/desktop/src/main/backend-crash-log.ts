import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { BackendCrashRecord } from '../shared/backend'

// Backend crash evidence that survives supervisor restarts and app relaunches.
//
// Before this file the supervisor kept exit code/signal in memory and stderr
// in a 200-line ring that died with the process, so a support bundle exported
// after "Backend crashed, restarting (attempt 3)" started at the NEXT
// generation's "backend ready" and said nothing about the crash. Every exit
// worth keeping now lands in `userData/backend-crashes.json` (last 5, most
// recent first) together with the dying process's last stderr lines, and
// rides into the bundle via runtimeInfo.backendCrashes.
//
// Everything here is pure/injected so the policy is unit-testable; index.ts
// wires it to the stderr handler and finalizeBackendRuntimeExit.

export type { BackendCrashRecord } from '../shared/backend'

/** Records kept on disk. Five covers the whole restart ladder (5 attempts). */
export const BACKEND_CRASH_LOG_LIMIT = 5
/** Stderr lines kept per generation for the record. */
export const BACKEND_CRASH_STDERR_TAIL_LINES = 50
/** Per-line cap so a runaway log line cannot bloat the record. */
export const BACKEND_CRASH_STDERR_LINE_CHARS = 400

export function backendCrashLogPath(userDataDir: string): string {
  return join(userDataDir, 'backend-crashes.json')
}

/** Bounded ring of the newest stderr lines for ONE backend generation. */
export class BackendStderrTail {
  private readonly lines: string[] = []

  constructor(
    private readonly maxLines = BACKEND_CRASH_STDERR_TAIL_LINES,
    private readonly maxLineChars = BACKEND_CRASH_STDERR_LINE_CHARS
  ) {}

  push(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }
    this.lines.push(truncateStderrLine(stripAnsi(trimmed), this.maxLineChars))
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines)
    }
  }

  snapshot(): string[] {
    return [...this.lines]
  }
}

// tracing's default fmt layer colours stderr (ANSI SGR sequences); a crash
// record is read by humans in JSON, so keep the words and drop the paint.
// eslint-disable-next-line no-control-regex -- the escape byte is the point.
const ANSI_SGR_PATTERN = /\u001b\[[0-9;]*m/g

export function stripAnsi(line: string): string {
  return line.replace(ANSI_SGR_PATTERN, '')
}

export function truncateStderrLine(
  line: string,
  maxChars = BACKEND_CRASH_STDERR_LINE_CHARS
): string {
  if (line.length <= maxChars) {
    return line
  }
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`
}

/** Every non-intentional exit is a crash. An intentional stop that still
 * reports a non-zero code is worth keeping too (the backend failed while we
 * asked it to shut down); a clean or signal-only intentional stop is not —
 * SIGTERM/SIGKILL is how the supervisor stops the process on purpose. */
export function shouldRecordBackendExit({
  intentional,
  code
}: {
  intentional: boolean
  code: number | null
  signal?: string | null
}): boolean {
  if (!intentional) {
    return true
  }
  return typeof code === 'number' && code !== 0
}

export interface BackendCrashLogStore {
  readFile?: (path: string) => string
  writeFile?: (path: string, contents: string) => void
  rename?: (from: string, to: string) => void
  makeDir?: (path: string) => void
}

export function readBackendCrashLog(
  path: string,
  { readFile = (target) => readFileSync(target, 'utf8') }: BackendCrashLogStore = {}
): BackendCrashRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFile(path))
  } catch {
    // Missing or corrupt evidence must never block startup or the bundle.
    return []
  }
  const records = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.records)
      ? parsed.records
      : []
  return records
    .map((record) => normalizeBackendCrashRecord(record))
    .filter((record): record is BackendCrashRecord => record !== null)
    .slice(0, BACKEND_CRASH_LOG_LIMIT)
}

/** Prepend one record, keep the newest `BACKEND_CRASH_LOG_LIMIT`, and write the
 * file atomically (temp file + rename) so a crash mid-write cannot leave a
 * half-written JSON that hides all earlier evidence. Returns the new list
 * (most recent first). Throws on write failure — the caller logs and keeps
 * the in-memory copy. */
export function appendBackendCrashRecord(
  path: string,
  record: BackendCrashRecord,
  existing: readonly BackendCrashRecord[],
  {
    writeFile = (target, contents) => writeFileSync(target, contents),
    rename = (from, to) => renameSync(from, to),
    makeDir = (target) => mkdirSync(target, { recursive: true })
  }: BackendCrashLogStore = {}
): BackendCrashRecord[] {
  const next = [record, ...existing].slice(0, BACKEND_CRASH_LOG_LIMIT)
  makeDir(dirname(path))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFile(temp, `${JSON.stringify({ schemaVersion: 1, records: next }, null, 2)}\n`)
  rename(temp, path)
  return next
}

export function buildBackendCrashRecord({
  at,
  generation,
  code,
  signal,
  attempt,
  uptimeMs,
  intentional,
  stderrTail
}: {
  at: string
  generation: number
  code: number | null
  signal: string | null
  attempt: number | null
  uptimeMs: number
  intentional: boolean
  stderrTail: readonly string[]
}): BackendCrashRecord {
  return {
    at,
    generation,
    code,
    signal,
    attempt,
    uptimeMs: Math.max(0, Math.round(uptimeMs)),
    intentional,
    stderrTail: stderrTail
      .slice(-BACKEND_CRASH_STDERR_TAIL_LINES)
      .map((line) => truncateStderrLine(line))
  }
}

/** One-line human summary for logs and the Diagnostics tab. */
export function describeBackendCrashRecord(record: BackendCrashRecord): string {
  const exit =
    record.signal !== null
      ? `signal ${record.signal}`
      : record.code !== null
        ? `code ${record.code}`
        : 'unknown exit'
  const attempt = record.attempt !== null ? `, restart attempt ${record.attempt}` : ''
  return `generation ${record.generation} exited (${exit}) after ${formatUptime(record.uptimeMs)}${attempt}${record.intentional ? ', intentional' : ''}`
}

function formatUptime(uptimeMs: number): string {
  if (uptimeMs < 1_000) {
    return `${uptimeMs}ms`
  }
  if (uptimeMs < 60_000) {
    return `${(uptimeMs / 1_000).toFixed(1)}s`
  }
  return `${Math.round(uptimeMs / 60_000)}min`
}

function normalizeBackendCrashRecord(value: unknown): BackendCrashRecord | null {
  if (!isRecord(value)) {
    return null
  }
  if (typeof value.at !== 'string' || !value.at) {
    return null
  }
  return {
    at: value.at,
    generation: finiteInteger(value.generation) ?? 0,
    code: finiteInteger(value.code),
    signal: typeof value.signal === 'string' && value.signal ? value.signal : null,
    attempt: finiteInteger(value.attempt),
    uptimeMs: Math.max(0, finiteInteger(value.uptimeMs) ?? 0),
    intentional: value.intentional === true,
    stderrTail: Array.isArray(value.stderrTail)
      ? value.stderrTail
          .filter((line): line is string => typeof line === 'string')
          .slice(-BACKEND_CRASH_STDERR_TAIL_LINES)
          .map((line) => truncateStderrLine(line))
      : []
  }
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
