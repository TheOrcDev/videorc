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
  classifyBackendExit,
  describeBackendCrashRecord,
  readBackendCrashLog,
  shouldRecordBackendExit,
  windowsCrashStatusName,
  type BackendCrashRecord
} from './backend-crash-log'
import {
  BackendRuntimeOwner,
  claimDurableBackendPid,
  settleBackendRuntimeExit
} from './backend-runtime-owner'

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
  it('records every exit main did not ask for, a clean recycle included', () => {
    expect(shouldRecordBackendExit({ cause: 'unexpected', code: 1 })).toBe(true)
    expect(shouldRecordBackendExit({ cause: 'unexpected', code: null })).toBe(true)
    expect(shouldRecordBackendExit({ cause: 'crashed', code: 3221225477 })).toBe(true)
    expect(shouldRecordBackendExit({ cause: 'recycled', code: 0 })).toBe(true)
  })

  it('skips clean and signal-only stops main asked for', () => {
    expect(shouldRecordBackendExit({ cause: 'stopped', code: 0 })).toBe(false)
    expect(shouldRecordBackendExit({ cause: 'stopped', code: null })).toBe(false)
  })

  it('keeps stops main asked for that still reported a non-zero code', () => {
    expect(shouldRecordBackendExit({ cause: 'stopped', code: 101 })).toBe(true)
  })
})

describe('classifyBackendExit', () => {
  it("marks main's own stop intentional whatever the exit reports", () => {
    for (const [code, signal, platform] of [
      [0, null, 'darwin'],
      [null, 'SIGKILL', 'darwin'],
      // TerminateProcess / taskkill from main report code 1 on Windows.
      [1, null, 'win32'],
      [null, 'SIGKILL', 'win32']
    ] as const) {
      expect(classifyBackendExit({ markedByMain: true, code, signal, platform })).toEqual({
        cause: 'stopped',
        intentional: true,
        windowsStatus: null
      })
    }
  })

  it('marks a planned recycle (exit 0, no signal, nobody asked) intentional', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(classifyBackendExit({ markedByMain: false, code: 0, signal: null, platform })).toEqual(
        { cause: 'recycled', intentional: true, windowsStatus: null }
      )
    }
  })

  it('keeps an outside kill on Windows (code 1, unmarked) unintentional', () => {
    expect(
      classifyBackendExit({ markedByMain: false, code: 1, signal: null, platform: 'win32' })
    ).toEqual({ cause: 'unexpected', intentional: false, windowsStatus: null })
    expect(
      classifyBackendExit({
        markedByMain: false,
        code: null,
        signal: 'SIGKILL',
        platform: 'darwin'
      })
    ).toEqual({ cause: 'unexpected', intentional: false, windowsStatus: null })
    expect(
      classifyBackendExit({ markedByMain: false, code: 101, signal: null, platform: 'darwin' })
    ).toEqual({ cause: 'unexpected', intentional: false, windowsStatus: null })
  })

  it('names Windows crash codes in both forms Node reports, even during a stop', () => {
    for (const [code, name] of [
      [3221225477, 'STATUS_ACCESS_VIOLATION'],
      [-1073741819, 'STATUS_ACCESS_VIOLATION'],
      [3221226356, 'STATUS_HEAP_CORRUPTION'],
      [-1073740940, 'STATUS_HEAP_CORRUPTION'],
      [0xc0000409, 'STATUS_STACK_BUFFER_OVERRUN']
    ] as const) {
      expect(windowsCrashStatusName(code, 'win32')).toBe(name)
      for (const markedByMain of [false, true]) {
        expect(
          classifyBackendExit({ markedByMain, code, signal: null, platform: 'win32' })
        ).toEqual({ cause: 'crashed', intentional: false, windowsStatus: name })
      }
    }
  })

  it('names nothing off Windows or for ordinary codes', () => {
    expect(windowsCrashStatusName(3221225477, 'darwin')).toBeNull()
    expect(windowsCrashStatusName(1, 'win32')).toBeNull()
    expect(windowsCrashStatusName(0, 'win32')).toBeNull()
    expect(windowsCrashStatusName(null, 'win32')).toBeNull()
  })
})

// The supervisor reads the mark from the runtime state at the exit event.
// Each of main's own termination paths must have set it before it signals,
// so an exit delivered during the kill itself already sees it.
describe('supervisor exit marks', () => {
  function exitIsIntentional(
    owner: BackendRuntimeOwner<object>,
    runtime: ReturnType<BackendRuntimeOwner<object>['start']>,
    code: number | null,
    signal: NodeJS.Signals | null
  ): boolean {
    const settlement = settleBackendRuntimeExit(owner, runtime, 101, () => false)
    return classifyBackendExit({
      markedByMain: settlement.wasIntentional,
      code,
      signal,
      platform: 'win32'
    }).intentional
  }

  it('reads an own stop as intentional (pre-READY and receipt-wait stops)', () => {
    for (const begin of ['beginShutdown', 'beginShutdownReceiptWait'] as const) {
      const owner = new BackendRuntimeOwner<object>()
      const runtime = owner.start({})
      owner.recordOwnedPid(runtime, 101)
      owner[begin](runtime)
      expect(exitIsIntentional(owner, runtime, 1, null)).toBe(true)
    }
  })

  it('reads the kill after a failed ownership claim as intentional, even mid-kill', () => {
    const owner = new BackendRuntimeOwner<object>()
    const runtime = owner.start({})
    let intentional: boolean | null = null
    expect(() =>
      claimDurableBackendPid(owner, runtime, 101, {
        persist: () => {
          throw new Error('ledger is read-only')
        },
        // The exit event fires while the kill is still on the stack.
        terminate: () => {
          intentional = exitIsIntentional(owner, runtime, 1, null)
        }
      })
    ).toThrow()
    expect(intentional).toBe(true)
  })

  it('reads an unmarked exit as unintentional and an unmarked exit 0 as a recycle', () => {
    const killed = new BackendRuntimeOwner<object>()
    const killedRuntime = killed.start({})
    killed.recordOwnedPid(killedRuntime, 101)
    expect(exitIsIntentional(killed, killedRuntime, 1, null)).toBe(false)

    const recycled = new BackendRuntimeOwner<object>()
    const recycledRuntime = recycled.start({})
    recycled.recordOwnedPid(recycledRuntime, 101)
    expect(exitIsIntentional(recycled, recycledRuntime, 0, null)).toBe(true)
  })

  it('settles once when the exit lands before the stop finishes reading it', () => {
    const owner = new BackendRuntimeOwner<object>()
    const runtime = owner.start({})
    owner.recordOwnedPid(runtime, 101)
    owner.beginShutdown(runtime)
    // The close event settles first; the stop's own finalize call comes after.
    expect(settleBackendRuntimeExit(owner, runtime, 101, () => false)).toMatchObject({
      completed: true,
      wasCurrent: true,
      wasIntentional: true
    })
    expect(settleBackendRuntimeExit(owner, runtime, 101, () => false)).toMatchObject({
      wasCurrent: false,
      wasIntentional: true
    })
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

  it('strips tracing ANSI colour codes so the record reads as plain text', () => {
    const tail = new BackendStderrTail()
    tail.push('\u001b[2m2026-08-23T14:13:03Z\u001b[0m \u001b[32m INFO\u001b[0m ready.')
    expect(tail.snapshot()).toEqual(['2026-08-23T14:13:03Z  INFO ready.'])
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

  it('keeps a Windows crash name through the file and leaves older records without one', () => {
    const path = backendCrashLogPath(tempUserData())
    const named = record({
      code: 3221225477,
      signal: null,
      windowsStatus: 'STATUS_ACCESS_VIOLATION'
    })
    const plain = record({ at: '2026-08-23T09:00:00.000Z' })
    expect(plain).not.toHaveProperty('windowsStatus')
    appendBackendCrashRecord(path, named, [plain])
    const [readNamed, readPlain] = readBackendCrashLog(path)
    expect(readNamed.windowsStatus).toBe('STATUS_ACCESS_VIOLATION')
    expect(readPlain).not.toHaveProperty('windowsStatus')
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
    expect(
      describeBackendCrashRecord(
        record({ code: -1073740940, signal: null, windowsStatus: 'STATUS_HEAP_CORRUPTION' })
      )
    ).toBe(
      'generation 2 exited (code 0xC0000374 STATUS_HEAP_CORRUPTION) after 12.3s, restart attempt 1'
    )
  })
})
