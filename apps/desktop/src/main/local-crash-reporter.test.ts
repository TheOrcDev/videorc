import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CrashReporterStartOptions } from 'electron'

import {
  LOCAL_CRASH_REPORTER_OPTIONS,
  localCrashDumpsPath,
  startLocalCrashReporter
} from './local-crash-reporter'

describe('startLocalCrashReporter', () => {
  it('keeps dumps under userData and never uploads', () => {
    const calls: string[] = []
    const started: CrashReporterStartOptions[] = []
    const ok = startLocalCrashReporter('/ud', {
      setCrashDumpsPath: (path) => calls.push(`path:${path}`),
      start: (options) => {
        calls.push('start')
        started.push(options)
      }
    })
    expect(ok).toBe(true)
    expect(calls).toEqual([`path:${join('/ud', 'Crashpad')}`, 'start'])
    expect(started).toEqual([{ uploadToServer: false }])
    expect(started[0].submitURL).toBeUndefined()
    expect(LOCAL_CRASH_REPORTER_OPTIONS.uploadToServer).toBe(false)
    expect(localCrashDumpsPath('/ud')).toBe(join('/ud', 'Crashpad'))
  })

  it('reports and swallows a start failure', () => {
    const errors: unknown[] = []
    const ok = startLocalCrashReporter('/ud', {
      setCrashDumpsPath: () => {},
      start: () => {
        throw new Error('crashpad unavailable')
      },
      onError: (error) => errors.push(error)
    })
    expect(ok).toBe(false)
    expect(errors).toHaveLength(1)
  })
})
