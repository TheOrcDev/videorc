import { describe, expect, it } from 'vitest'

import {
  OwnedProcessRegistry,
  globalOwnedProcessLedgerPath,
  ownedProcessLedgerPath,
  type OwnedProcessProbeResult,
  type OwnedProcessRecord
} from './backend-owned-processes'

describe('OwnedProcessRegistry', () => {
  const processIdentity = (pid: number) => ({
    birthToken: `birth-${pid}`,
    executablePath: '/Applications/Videorc.app/Contents/Resources/videorc-backend'
  })
  const originalIdentity = processIdentity(111)
  const probeAlive = (alive: Set<number>) => (pid: number) =>
    alive.has(pid)
      ? ({ state: 'live', identity: processIdentity(pid) } as const)
      : ({ state: 'dead' } as const)

  it('treats an ENOENT ledger as empty, then records and removes owned child processes', () => {
    let ledger = ''
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      now: () => '2026-06-11T10:00:00.000Z',
      readFile: () => {
        if (!ledger) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        return ledger
      },
      writeFile: (_path, contents) => {
        ledger = contents
      },
      makeDir: () => undefined,
      probeProcess: (pid) => ({ state: 'live', identity: processIdentity(pid) })
    })

    registry.record(1234, 'backend')
    registry.record(5678, 'native-preview-helper')
    registry.remove(1234)

    expect(JSON.parse(ledger)).toEqual([
      {
        pid: 5678,
        label: 'native-preview-helper',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: processIdentity(5678)
      }
    ])
  })

  it('refuses to record a live process when its exact identity cannot be captured', () => {
    let probeAttempts = 0
    let writes = 0
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      readFile: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      writeFile: () => {
        writes += 1
      },
      makeDir: () => undefined,
      probeProcess: () => {
        probeAttempts += 1
        return { state: 'unprobeable' }
      },
      sleep: () => undefined
    })

    expect(() => registry.record(5678, 'native-preview-helper')).toThrow(
      'exact process identity is unavailable'
    )
    expect(probeAttempts).toBe(3)
    expect(writes).toBe(0)
  })

  it('reaps only an identity-matched ledger pid and never substring-matches command lines', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 111,
        label: 'backend',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: processIdentity(111)
      },
      {
        pid: 111,
        label: 'backend duplicate',
        startedAt: '2026-06-11T10:00:01.000Z',
        identity: processIdentity(111)
      },
      { pid: 222, label: 'current process', startedAt: '2026-06-11T10:00:02.000Z' }
    ]
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let written = ''
    const alive = new Set([111])
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 222,
      platform: 'darwin',
      readFile: () => JSON.stringify(records),
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined,
      killProcess: (pid, signal) => {
        kills.push({ pid, signal })
        if (signal === 'SIGKILL') alive.delete(pid)
      },
      probeProcess: probeAlive(alive),
      sleep: () => undefined
    })

    const result = registry.reapStale()

    expect(result.attempted.map((record) => record.pid)).toEqual([111])
    expect(result.confirmedDead.map((record) => record.pid)).toEqual([111])
    expect(result.unconfirmed).toEqual([])
    expect(kills).toEqual([
      { pid: 111, signal: 'SIGTERM' },
      { pid: 111, signal: 'SIGKILL' }
    ])
    expect(JSON.parse(written)).toEqual([])
  })

  it('reaps ledger pids on win32 with a single hard kill (no signal ladder)', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 111,
        label: 'backend',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: processIdentity(111)
      },
      { pid: 222, label: 'current process', startedAt: '2026-06-11T10:00:02.000Z' }
    ]
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let written = ''
    const alive = new Set([111])
    const registry = new OwnedProcessRegistry({
      ledgerPath: 'C:\\videorc\\owned-processes\\owned.json',
      currentPid: 222,
      platform: 'win32',
      readFile: () => JSON.stringify(records),
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined,
      killProcess: (pid, signal) => {
        kills.push({ pid, signal })
        alive.delete(pid)
      },
      probeProcess: probeAlive(alive),
      sleep: () => undefined
    })

    const result = registry.reapStale()

    expect(result.attempted.map((record) => record.pid)).toEqual([111])
    expect(result.unconfirmed).toEqual([])
    // Node maps every signal to TerminateProcess on Windows, so the reap is
    // one hard kill with no scheduled follow-up.
    expect(kills).toEqual([{ pid: 111, signal: 'SIGKILL' }])
    expect(JSON.parse(written)).toEqual([])
  })

  it('retains exact ledger evidence when process death cannot be confirmed', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 111,
        label: 'backend',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: processIdentity(111)
      }
    ]
    let written = ''
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 222,
      platform: 'darwin',
      readFile: () => JSON.stringify(records),
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined,
      killProcess: () => {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
      },
      probeProcess: () => ({ state: 'live', identity: processIdentity(111) }),
      sleep: () => undefined
    })

    const result = registry.reapStale({ killGraceMs: 1, confirmTimeoutMs: 1 })

    expect(result.confirmedDead).toEqual([])
    expect(result.unconfirmed.map((record) => record.pid)).toEqual([111])
    expect(JSON.parse(written)).toEqual(records)
  })

  it('prunes a reused pid without signalling its new occupant', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 111,
        label: 'backend',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: originalIdentity
      }
    ]
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let written = ''
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 222,
      platform: 'darwin',
      readFile: () => JSON.stringify(records),
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined,
      killProcess: (pid, signal) => kills.push({ pid, signal }),
      probeProcess: () => ({
        state: 'live',
        identity: { ...originalIdentity, birthToken: 'birth-reused' }
      }),
      sleep: () => undefined
    })

    const result = registry.reapStale()

    expect(result.attempted).toEqual([])
    expect(result.identityMismatches.map((record) => record.pid)).toEqual([111])
    expect(result.unconfirmed).toEqual([])
    expect(kills).toEqual([])
    expect(JSON.parse(written)).toEqual([])
  })

  it('reports a reused live pid as no longer owned during in-memory reconciliation', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 111,
        label: 'backend',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: originalIdentity
      }
    ]
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 222,
      readFile: () => JSON.stringify(records),
      writeFile: () => undefined,
      makeDir: () => undefined,
      probeProcess: () => ({
        state: 'live',
        identity: { ...originalIdentity, birthToken: 'birth-reused' }
      })
    })

    expect(registry.probeRecordedOwnership(111)).toBe('gone')
  })

  it('retains in-memory ownership when the recorded identity still matches or is unprobeable', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 111,
        label: 'backend',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: originalIdentity
      }
    ]
    const registry = (probeProcess: () => OwnedProcessProbeResult) =>
      new OwnedProcessRegistry({
        ledgerPath: '/tmp/videorc-owned.json',
        currentPid: 222,
        readFile: () => JSON.stringify(records),
        writeFile: () => undefined,
        makeDir: () => undefined,
        probeProcess
      })

    expect(
      registry(() => ({ state: 'live', identity: originalIdentity })).probeRecordedOwnership(111)
    ).toBe('owned')
    expect(registry(() => ({ state: 'unprobeable' })).probeRecordedOwnership(111)).toBe(
      'unconfirmed'
    )
  })

  it('retains a live legacy record without signalling the unidentified process', () => {
    const records: OwnedProcessRecord[] = [
      { pid: 111, label: 'legacy-backend', startedAt: '2026-06-11T10:00:00.000Z' }
    ]
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let written = ''
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 222,
      platform: 'darwin',
      readFile: () => JSON.stringify(records),
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined,
      killProcess: (pid, signal) => kills.push({ pid, signal }),
      probeProcess: () => ({ state: 'live', identity: processIdentity(111) }),
      sleep: () => undefined
    })

    const result = registry.reapStale()

    expect(result.attempted).toEqual([])
    expect(result.confirmedDead).toEqual([])
    expect(result.identityMismatches).toEqual([])
    expect(result.unconfirmed.map((record) => record.pid)).toEqual([111])
    expect(kills).toEqual([])
    expect(JSON.parse(written)).toEqual(records)
  })

  it('retains an identified record when the exact identity probe fails', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 111,
        label: 'backend',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: processIdentity(111)
      }
    ]
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let written = ''
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 222,
      platform: 'darwin',
      readFile: () => JSON.stringify(records),
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined,
      killProcess: (pid, signal) => kills.push({ pid, signal }),
      probeProcess: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      },
      sleep: () => undefined
    })

    const result = registry.reapStale()

    expect(result.attempted).toEqual([])
    expect(result.confirmedDead).toEqual([])
    expect(result.identityMismatches).toEqual([])
    expect(result.unconfirmed.map((record) => record.pid)).toEqual([111])
    expect(kills).toEqual([])
    expect(JSON.parse(written)).toEqual(records)
  })

  it('prunes a record when the exact pid probe confirms the process is dead', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 111,
        label: 'backend',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: processIdentity(111)
      }
    ]
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let written = ''
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 222,
      platform: 'darwin',
      readFile: () => JSON.stringify(records),
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined,
      killProcess: (pid, signal) => kills.push({ pid, signal }),
      probeProcess: () => ({ state: 'dead' }),
      sleep: () => undefined
    })

    const result = registry.reapStale()

    expect(result.attempted).toEqual([])
    expect(result.confirmedDead.map((record) => record.pid)).toEqual([111])
    expect(result.identityMismatches).toEqual([])
    expect(result.unconfirmed).toEqual([])
    expect(kills).toEqual([])
    expect(JSON.parse(written)).toEqual([])
  })

  it('fails closed when an ownership ledger is unreadable or corrupt', () => {
    const unreadable = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-unreadable.json',
      readFile: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
      makeDir: () => undefined,
      writeFile: () => undefined
    })
    const corrupt = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-corrupt.json',
      readFile: () => '{not-json',
      makeDir: () => undefined,
      writeFile: () => undefined
    })

    expect(() => unreadable.reapStale()).toThrow('Could not read owned process ledger')
    expect(() => corrupt.reapStale()).toThrow('Could not parse owned process ledger')
  })

  it('uses different ledger files for different worktrees', () => {
    const first = ownedProcessLedgerPath(
      '/Users/orc/Library/Application Support/Videorc',
      '/repo/one'
    )
    const second = ownedProcessLedgerPath(
      '/Users/orc/Library/Application Support/Videorc',
      '/repo/two'
    )

    expect(first).not.toEqual(second)
    expect(first).toContain('owned-processes')
    expect(second).toContain('owned-processes')
  })

  it('uses one global ledger across isolated userData directories', () => {
    const first = globalOwnedProcessLedgerPath('/Users/orc/Library/Application Support', 'Videorc')
    const second = globalOwnedProcessLedgerPath('/Users/orc/Library/Application Support', 'Videorc')

    expect(first).toEqual(second)
    expect(first).toContain('Videorc')
    expect(first).toContain('owned-processes')
  })

  it('reaps stale pids from every configured ledger once', () => {
    const ledgers = new Map<string, string>([
      [
        '/tmp/videorc-global.json',
        JSON.stringify([
          {
            pid: 111,
            label: 'backend',
            startedAt: '2026-06-11T10:00:00.000Z',
            identity: processIdentity(111)
          },
          {
            pid: 333,
            label: 'helper',
            startedAt: '2026-06-11T10:00:02.000Z',
            identity: processIdentity(333)
          }
        ])
      ],
      [
        '/tmp/videorc-workspace.json',
        JSON.stringify([
          {
            pid: 111,
            label: 'backend duplicate',
            startedAt: '2026-06-11T10:00:01.000Z',
            identity: processIdentity(111)
          },
          { pid: 222, label: 'current process', startedAt: '2026-06-11T10:00:02.000Z' }
        ])
      ]
    ])
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const alive = new Set([111, 333])
    const registry = new OwnedProcessRegistry({
      ledgerPath: ['/tmp/videorc-global.json', '/tmp/videorc-workspace.json'],
      currentPid: 222,
      platform: 'darwin',
      readFile: (path) => ledgers.get(path) ?? '',
      writeFile: (path, contents) => {
        ledgers.set(path, contents)
      },
      makeDir: () => undefined,
      killProcess: (pid, signal) => {
        kills.push({ pid, signal })
        if (signal === 'SIGKILL') alive.delete(pid)
      },
      probeProcess: probeAlive(alive),
      sleep: () => undefined
    })

    const result = registry.reapStale()

    expect(result.attempted.map((record) => record.pid)).toEqual([111, 333])
    expect(result.unconfirmed).toEqual([])
    expect(kills).toEqual([
      { pid: 111, signal: 'SIGTERM' },
      { pid: 333, signal: 'SIGTERM' },
      { pid: 111, signal: 'SIGKILL' },
      { pid: 333, signal: 'SIGKILL' }
    ])
    expect(JSON.parse(ledgers.get('/tmp/videorc-global.json') ?? '')).toEqual([])
    expect(JSON.parse(ledgers.get('/tmp/videorc-workspace.json') ?? '')).toEqual([])
  })
})
