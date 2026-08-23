import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  BACKEND_LOG_FILE_MAX_BYTES,
  BACKEND_LOG_FILE_MAX_FILES,
  RotatingLogFile,
  backendLogFilePath,
  formatBackendLogFileLine
} from './backend-log-file'

const tempDirs: string[] = []

function tempUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-backend-log-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('formatBackendLogFileLine', () => {
  it('is one line per entry with timestamp and level', () => {
    expect(formatBackendLogFileLine('warn', 'a\nb', '2026-08-23T10:00:00.000Z')).toBe(
      '2026-08-23T10:00:00.000Z [warn] a\\nb\n'
    )
    expect(formatBackendLogFileLine('info', '\u001b[32m INFO\u001b[0m ok', 'T')).toBe(
      'T [info]  INFO ok\n'
    )
  })
})

describe('RotatingLogFile', () => {
  it('defaults to 2 files x 2 MB under userData/logs', () => {
    expect(BACKEND_LOG_FILE_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(BACKEND_LOG_FILE_MAX_FILES).toBe(2)
    expect(backendLogFilePath('/ud')).toBe(join('/ud', 'logs', 'backend.log'))
    const sink = new RotatingLogFile({ path: '/ud/logs/backend.log' })
    expect(sink.rotatedPaths()).toEqual(['/ud/logs/backend.log', '/ud/logs/backend.log.1'])
  })

  it('creates the directory lazily and appends on the real file system', () => {
    const path = backendLogFilePath(tempUserData())
    const sink = new RotatingLogFile({ path })
    expect(existsSync(path)).toBe(false)
    sink.write('one\n')
    sink.write('two\n')
    expect(readFileSync(path, 'utf8')).toBe('one\ntwo\n')
  })

  it('rotates when the next line would exceed the budget and keeps only maxFiles', () => {
    const path = backendLogFilePath(tempUserData())
    const sink = new RotatingLogFile({ path, maxBytes: 20, maxFiles: 2 })
    sink.write('aaaaaaaaaa\n') // 11 bytes
    sink.write('bbbbbbbbbb\n') // would make 22 > 20 → rotate
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('aaaaaaaaaa\n')
    expect(readFileSync(path, 'utf8')).toBe('bbbbbbbbbb\n')
    sink.write('cccccccccc\n') // rotate again: .1 replaced, no .2
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('bbbbbbbbbb\n')
    expect(readFileSync(path, 'utf8')).toBe('cccccccccc\n')
    expect(existsSync(`${path}.2`)).toBe(false)
    expect(statSync(path).size).toBeLessThanOrEqual(20)
  })

  it('resumes the byte count from an existing file across launches', () => {
    const path = backendLogFilePath(tempUserData())
    new RotatingLogFile({ path, maxBytes: 20 }).write('aaaaaaaaaa\n')
    const relaunched = new RotatingLogFile({ path, maxBytes: 20 })
    relaunched.write('bbbbbbbbbb\n')
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('aaaaaaaaaa\n')
    expect(readFileSync(path, 'utf8')).toBe('bbbbbbbbbb\n')
  })

  it('never lets one oversized line block logging: it rotates then writes it', () => {
    const path = backendLogFilePath(tempUserData())
    const sink = new RotatingLogFile({ path, maxBytes: 8 })
    sink.write('short\n')
    sink.write('this line is longer than the budget\n')
    expect(readFileSync(path, 'utf8')).toBe('this line is longer than the budget\n')
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('short\n')
  })

  it('disables itself after the first failure and reports it once', () => {
    const errors: unknown[] = []
    let attempts = 0
    const sink = new RotatingLogFile({
      path: '/ud/logs/backend.log',
      fs: {
        makeDir: () => {},
        sizeOf: () => 0,
        appendFile: () => {
          attempts += 1
          throw new Error('EACCES')
        }
      },
      onError: (error) => {
        errors.push(error)
      }
    })
    sink.write('a\n')
    sink.write('b\n')
    sink.write('c\n')
    expect(attempts).toBe(1)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('EACCES')
  })

  it('disables itself explicitly when the live file cannot be rotated', () => {
    const errors: unknown[] = []
    const appended: string[] = []
    const sink = new RotatingLogFile({
      path: '/ud/logs/backend.log',
      maxBytes: 4,
      fs: {
        makeDir: () => {},
        sizeOf: () => 0,
        remove: () => {},
        rename: () => {
          throw new Error('EBUSY')
        },
        appendFile: (_target, contents) => {
          appended.push(contents)
        }
      },
      onError: (error) => {
        errors.push(error)
      }
    })
    sink.write('abc\n')
    sink.write('def\n')
    sink.write('ghi\n')
    expect(appended).toEqual(['abc\n'])
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('EBUSY')
  })
})
