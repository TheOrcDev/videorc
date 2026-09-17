import { describe, expect, it } from 'vitest'

import type { BackendCrashRecord } from './backend'
import {
  backendCrashExitLabel,
  backendCrashView,
  formatBackendUptime,
  latestBackendCrash,
  parseBackendPanicLine
} from './backend-crash-view'

const record = (overrides: Partial<BackendCrashRecord> = {}): BackendCrashRecord => ({
  at: '2026-08-23T10:00:00.000Z',
  generation: 3,
  code: null,
  signal: 'SIGKILL',
  attempt: 2,
  uptimeMs: 4_200,
  intentional: false,
  stderrTail: ['INFO ready', 'WARN something'],
  ...overrides
})

describe('backendCrashView', () => {
  it('labels signal, code, and unknown exits', () => {
    expect(backendCrashExitLabel({ code: null, signal: 'SIGKILL' })).toBe('signal SIGKILL')
    expect(backendCrashExitLabel({ code: 101, signal: null })).toBe('code 101')
    expect(backendCrashExitLabel({ code: null, signal: null })).toBe('unknown exit')
  })

  it('formats uptime at a glance', () => {
    expect(formatBackendUptime(250)).toBe('250ms')
    expect(formatBackendUptime(4_200)).toBe('4.2s')
    expect(formatBackendUptime(150_000)).toBe('3min')
    expect(formatBackendUptime(7_200_000)).toBe('2.0h')
  })

  it('prefers the Rust panic-hook line over the last stderr line', () => {
    const view = backendCrashView(
      record({
        code: 101,
        signal: null,
        stderrTail: [
          'INFO ready',
          '{"panic":"ring starvation","location":"compositor.rs:42","thread":"compositor"}',
          "thread 'compositor' panicked at compositor.rs:42",
          'note: run with RUST_BACKTRACE=1'
        ]
      })
    )
    expect(view.exit).toBe('code 101')
    expect(view.headline).toBe('panic: ring starvation (compositor.rs:42)')
    expect(view.panic).toEqual({
      message: 'ring starvation',
      location: 'compositor.rs:42',
      thread: 'compositor'
    })
  })

  it('falls back to the last stderr line, then to null', () => {
    expect(backendCrashView(record()).headline).toBe('WARN something')
    expect(backendCrashView(record({ stderrTail: [] })).headline).toBeNull()
    expect(backendCrashView(record()).attempt).toBe(2)
    expect(backendCrashView(record()).uptime).toBe('4.2s')
  })

  it('ignores panic-looking lines that are not valid JSON', () => {
    expect(parseBackendPanicLine('{"panic": oops')).toBeNull()
    expect(parseBackendPanicLine('{"panic":5}')).toBeNull()
    expect(parseBackendPanicLine('plain line')).toBeNull()
  })

  it('takes the first record as the latest (stored most recent first)', () => {
    expect(latestBackendCrash(undefined)).toBeNull()
    expect(latestBackendCrash([])).toBeNull()
    expect(
      latestBackendCrash([record({ generation: 9 }), record({ generation: 1 })])?.generation
    ).toBe(9)
  })
})
