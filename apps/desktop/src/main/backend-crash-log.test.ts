import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  BACKEND_CRASH_LOG_LIMIT,
  BACKEND_CRASH_STDERR_LINE_CHARS,
  BACKEND_CRASH_STDERR_TAIL_LINES,
  BackendStderrTail,
  appendBackendCrashRecord,
  backendCrashLogPath,
  buildBackendCrashRecord,
  describeBackendCrashRecord,
  readBackendCrashLog,
  shouldRecordBackendExit,
  type BackendCrashRecord
} from './backend-crash-log'

const tempDirs: string[] = []

function tempUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-crash-log-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function record(overrides: Partial<BackendCrashRecord> = {}): BackendCrashRecord {
  return buildBackendCrashRecord({
    at: '2026-08-23T10:00:00.000Z',
    generation: 2,
    code: null,
    signal: 'SIGKILL',
    attempt: 1,
    uptimeMs: 12_345,
    intentional: false,
    stderrTail: ['2026-08-23T10:00:00Z  INFO videorc_backend: ready', '{"panic":"boom"}'],
    ...overrides
  })
}

describe('shouldRecordBackendExit', () => {
  it('records every non-intentional exit, even a clean-looking one', () => {
    expect(shouldRecordBackendExit({ intentional: false, code: 0, signal: null })).toBe(true)
    expect(shouldRecordBackendExit({ intentional: false, code: null, signal: 'SIGKILL' })).toBe(
      true
    )
  })

  it('skips intentional clean stops and signal-only intentional stops', () => {
    expect(shouldRecordBackendExit({ intentional: true, code: 0, signal: null })).toBe(false)
    expect(shouldRecordBackendExit({ intentional: true, code: null, signal: 'SIGTERM' })).toBe(
      false
    )
  })

  it('keeps intentional stops that still reported a non-zero code', () => {
    expect(shouldRecordBackendExit({ intentional: true, code: 101, signal: null })).toBe(true)
  })
})

describe('BackendStderrTail', () => {
  it('keeps only the newest lines and truncates long ones', () => {
    const tail = new BackendStderrTail()
    for (let index = 0; index < BACKEND_CRASH_STDERR_TAIL_LINES + 10; index += 1) {
      tail.push(`line ${index}`)
    }
    tail.push('')
    tail.push('   ')
    tail.push('x'.repeat(BACKEND_CRASH_STDERR_LINE_CHARS + 50))
    const lines = tail.snapshot()
    expect(lines).toHaveLength(BACKEND_CRASH_STDERR_TAIL_LINES)
    expect(lines[0]).toBe('line 11')
    expect(lines.at(-1)).toHaveLength(BACKEND_CRASH_STDERR_LINE_CHARS)
    expect(lines.at(-1)?.endsWith('…')).toBe(true)
  })

  it('snapshots are copies', () => {
    const tail = new BackendStderrTail()
    tail.push('a')
    const first = tail.snapshot()
    tail.push('b')
    expect(first).toEqual(['a'])
    expect(tail.snapshot()).toEqual(['a', 'b'])
  })
})

describe('backend crash log persistence', () => {
  it('round-trips a record through the real file system, most recent first', () => {
    const path = backendCrashLogPath(tempUserData())
    expect(readBackendCrashLog(path)).toEqual([])

    const first = record({ at: '2026-08-23T10:00:00.000Z', generation: 1 })
    const second = record({
      at: '2026-08-23T10:00:05.000Z',
      generation: 2,
      code: 101,
      signal: null
    })
    let records = appendBackendCrashRecord(path, first, [])
    records = appendBackendCrashRecord(path, second, records)

    expect(records.map((entry) => entry.generation)).toEqual([2, 1])
    expect(readBackendCrashLog(path)).toEqual(records)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })

  it('keeps only the newest BACKEND_CRASH_LOG_LIMIT records', () => {
    const path = backendCrashLogPath(tempUserData())
    let records: BackendCrashRecord[] = []
    for (let generation = 1; generation <= BACKEND_CRASH_LOG_LIMIT + 3; generation += 1) {
      records = appendBackendCrashRecord(path, record({ generation }), records)
    }
    expect(records).toHaveLength(BACKEND_CRASH_LOG_LIMIT)
    expect(records[0].generation).toBe(BACKEND_CRASH_LOG_LIMIT + 3)
    expect(readBackendCrashLog(path).map((entry) => entry.generation)).toEqual(
      records.map((entry) => entry.generation)
    )
  })

  it('writes atomically: temp file then rename, never a direct write', () => {
    const writes: string[] = []
    const renames: Array<[string, string]> = []
    const made: string[] = []
    appendBackendCrashRecord('/userData/backend-crashes.json', record(), [], {
      writeFile: (target) => {
        writes.push(target)
      },
      rename: (from, to) => {
        renames.push([from, to])
      },
      makeDir: (target) => {
        made.push(target)
      }
    })
    expect(made).toEqual(['/userData'])
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toBe('/userData/backend-crashes.json')
    expect(writes[0].startsWith('/userData/backend-crashes.json.')).toBe(true)
    expect(renames).toEqual([[writes[0], '/userData/backend-crashes.json']])
  })

  it('tolerates missing, corrupt, and foreign-shaped files', () => {
    expect(readBackendCrashLog('/nope', { readFile: () => '{not json' })).toEqual([])
    expect(
      readBackendCrashLog('/nope', {
        readFile: () => {
          throw new Error('ENOENT')
        }
      })
    ).toEqual([])
    expect(readBackendCrashLog('/nope', { readFile: () => '{"records": 4}' })).toEqual([])
    expect(readBackendCrashLog('/nope', { readFile: () => '[1, "x", null, {}]' })).toEqual([])
  })

  it('normalizes partial records and accepts a bare array', () => {
    const records = readBackendCrashLog('/nope', {
      readFile: () =>
        JSON.stringify([
          { at: '2026-08-23T10:00:00.000Z', code: 'bad', stderrTail: ['ok', 7, null] },
          { at: '2026-08-23T09:00:00.000Z', generation: 3, signal: '', uptimeMs: -5 }
        ])
    })
    expect(records).toEqual([
      {
        at: '2026-08-23T10:00:00.000Z',
        generation: 0,
        code: null,
        signal: null,
        attempt: null,
        uptimeMs: 0,
        intentional: false,
        stderrTail: ['ok']
      },
      {
        at: '2026-08-23T09:00:00.000Z',
        generation: 3,
        code: null,
        signal: null,
        attempt: null,
        uptimeMs: 0,
        intentional: false,
        stderrTail: []
      }
    ])
  })

  it('caps the stderr tail inside a record on build and on read', () => {
    const longTail = Array.from({ length: 80 }, (_, index) => `l${index}`)
    const built = record({ stderrTail: longTail })
    expect(built.stderrTail).toHaveLength(BACKEND_CRASH_STDERR_TAIL_LINES)
    expect(built.stderrTail[0]).toBe('l30')
    const read = readBackendCrashLog('/nope', {
      readFile: () => JSON.stringify([{ at: 'x', stderrTail: longTail }])
    })
    expect(read[0].stderrTail).toHaveLength(BACKEND_CRASH_STDERR_TAIL_LINES)
  })
})

describe('describeBackendCrashRecord', () => {
  it('names the exit, uptime, and restart attempt', () => {
    expect(describeBackendCrashRecord(record())).toBe(
      'generation 2 exited (signal SIGKILL) after 12.3s, restart attempt 1'
    )
    expect(
      describeBackendCrashRecord(
        record({ code: 101, signal: null, attempt: null, intentional: true, uptimeMs: 500 })
      )
    ).toBe('generation 2 exited (code 101) after 500ms, intentional')
  })
})
