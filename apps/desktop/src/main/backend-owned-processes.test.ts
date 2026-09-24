import { describe, expect, it } from 'vitest'

import {
  OwnedProcessRegistry,
  globalOwnedProcessLedgerPath,
  linuxProcessBirthToken,
  linuxProcessStatIsDead,
  linuxProcessStatState,
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

  it('signals one recorded process only while its exact identity still matches', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 111,
        label: 'backend',
        startedAt: '2026-06-11T10:00:00.000Z',
        identity: originalIdentity
      }
    ]
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let probe: OwnedProcessProbeResult = { state: 'live', identity: originalIdentity }
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 222,
      readFile: () => JSON.stringify(records),
      writeFile: () => undefined,
      makeDir: () => undefined,
      killProcess: (pid, signal) => kills.push({ pid, signal }),
      probeProcess: () => probe
    })

    expect(registry.signalRecordedOwnership(111, 'SIGKILL')).toBe('signalled')
    expect(kills).toEqual([{ pid: 111, signal: 'SIGKILL' }])

    probe = {
      state: 'live',
      identity: { ...originalIdentity, birthToken: 'birth-reused' }
    }
    expect(registry.signalRecordedOwnership(111, 'SIGKILL')).toBe('gone')
    probe = { state: 'unprobeable' }
    expect(registry.signalRecordedOwnership(111, 'SIGKILL')).toBe('unconfirmed')
    expect(kills).toEqual([{ pid: 111, signal: 'SIGKILL' }])
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

  it('re-stamps a recorded process whose executable path changed after exec, then reaps it', () => {
    // Linux dev mode: ~/.cargo/bin/cargo (rustup proxy) is recorded, then it
    // execs the toolchain cargo. Same birth token, new executable path.
    const proxyIdentity = { birthToken: 'boot-4242', executablePath: '/home/dev/.cargo/bin/cargo' }
    const toolchainIdentity = {
      birthToken: 'boot-4242',
      executablePath: '/home/dev/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/cargo'
    }
    let ledger = ''
    let currentIdentity = proxyIdentity
    const alive = new Set([4242])
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 1,
      platform: 'linux',
      now: () => '2026-09-24T00:00:00.000Z',
      readFile: () => {
        if (!ledger) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return ledger
      },
      writeFile: (_path, contents) => {
        ledger = contents
      },
      makeDir: () => undefined,
      killProcess: (pid, signal) => {
        kills.push({ pid, signal })
        if (signal === 'SIGKILL') alive.delete(pid)
      },
      probeProcess: (pid) =>
        alive.has(pid) ? { state: 'live', identity: currentIdentity } : { state: 'dead' },
      sleep: () => undefined
    })

    registry.record(4242, 'cargo-run-videorc-backend')
    currentIdentity = toolchainIdentity

    expect(registry.refreshIdentity(4242, 'cargo-run-videorc-backend')).toBe('refreshed')
    expect(JSON.parse(ledger)).toEqual([
      {
        pid: 4242,
        label: 'cargo-run-videorc-backend',
        startedAt: '2026-09-24T00:00:00.000Z',
        identity: toolchainIdentity
      }
    ])
    expect(registry.refreshIdentity(4242, 'cargo-run-videorc-backend')).toBe('unchanged')

    const result = registry.reapStale()
    expect(result.attempted.map((record) => record.pid)).toEqual([4242])
    expect(result.confirmedDead.map((record) => record.pid)).toEqual([4242])
    expect(result.identityMismatches).toEqual([])
    expect(kills).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' }
    ])
  })

  it('never re-stamps a reused pid: a different birth token leaves the record alone', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 4242,
        label: 'cargo-run-videorc-backend',
        startedAt: '2026-09-24T00:00:00.000Z',
        identity: { birthToken: 'boot-old', executablePath: '/home/dev/.cargo/bin/cargo' }
      }
    ]
    let writes = 0
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 1,
      platform: 'linux',
      readFile: () => JSON.stringify(records),
      writeFile: () => {
        writes += 1
      },
      makeDir: () => undefined,
      probeProcess: () => ({
        state: 'live',
        identity: { birthToken: 'boot-new', executablePath: '/usr/bin/sleep' }
      }),
      sleep: () => undefined
    })

    expect(registry.refreshIdentity(4242, 'cargo-run-videorc-backend')).toBe('skipped')
    expect(writes).toBe(0)
  })

  it('without the READY re-stamp an exec path change is an identity mismatch and is not signalled', () => {
    // Documents the pre-fix Linux behaviour that timed out smoke:backend-single-instance.
    const records: OwnedProcessRecord[] = [
      {
        pid: 4242,
        label: 'cargo-run-videorc-backend',
        startedAt: '2026-09-24T00:00:00.000Z',
        identity: { birthToken: 'boot-4242', executablePath: '/home/dev/.cargo/bin/cargo' }
      }
    ]
    const kills: number[] = []
    let written = ''
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 1,
      platform: 'linux',
      readFile: () => JSON.stringify(records),
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined,
      killProcess: (pid) => {
        kills.push(pid)
      },
      probeProcess: () => ({
        state: 'live',
        identity: {
          birthToken: 'boot-4242',
          executablePath: '/home/dev/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/cargo'
        }
      }),
      sleep: () => undefined
    })

    const result = registry.reapStale()
    expect(result.identityMismatches.map((record) => record.pid)).toEqual([4242])
    expect(result.attempted).toEqual([])
    expect(kills).toEqual([])
    expect(JSON.parse(written)).toEqual([])
  })

  it('treats a zombie probe result as confirmed dead and prunes it without signalling', () => {
    const records: OwnedProcessRecord[] = [
      {
        pid: 4242,
        label: 'cargo-run-videorc-backend',
        startedAt: '2026-09-24T00:00:00.000Z',
        identity: { birthToken: 'boot-4242', executablePath: '/home/dev/.cargo/bin/cargo' }
      }
    ]
    const kills: number[] = []
    let written = ''
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      currentPid: 1,
      platform: 'linux',
      readFile: () => JSON.stringify(records),
      writeFile: (_path, contents) => {
        written = contents
      },
      makeDir: () => undefined,
      killProcess: (pid) => {
        kills.push(pid)
      },
      // What probeLinuxProcess returns for a `Z` state after the fix.
      probeProcess: () => ({ state: 'dead' }),
      sleep: () => undefined
    })

    const result = registry.reapStale()
    expect(result.confirmedDead.map((record) => record.pid)).toEqual([4242])
    expect(result.attempted).toEqual([])
    expect(kills).toEqual([])
    expect(JSON.parse(written)).toEqual([])
  })

  it('refreshIdentity on win32 and darwin is a no-op when the probe still matches', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      let writes = 0
      const registry = new OwnedProcessRegistry({
        ledgerPath: '/tmp/videorc-owned.json',
        currentPid: 1,
        platform,
        readFile: () =>
          JSON.stringify([
            {
              pid: 111,
              label: 'videorc-backend',
              startedAt: '2026-09-24T00:00:00.000Z',
              identity: processIdentity(111)
            }
          ]),
        writeFile: () => {
          writes += 1
        },
        makeDir: () => undefined,
        probeProcess: (pid) => ({ state: 'live', identity: processIdentity(pid) }),
        sleep: () => undefined
      })
      expect(registry.refreshIdentity(111, 'videorc-backend')).toBe('unchanged')
      expect(writes).toBe(0)
    }
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

describe('linux /proc/<pid>/stat parsing', () => {
  // A real stat line: pid (comm with spaces and parens) state ppid ... starttime at field 22.
  const running =
    '4242 (cargo run (dev)) S 4100 4242 4100 0 -1 4194560 1200 0 0 0 3 1 0 0 20 0 3 0 987654 12345678 900 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0 0 0 0 0 0 0 0 0\n'
  const zombie = running.replace(') S ', ') Z ')

  it('reads the state letter after the parenthesised command', () => {
    expect(linuxProcessStatState(running)).toBe('S')
    expect(linuxProcessStatState(zombie)).toBe('Z')
    expect(linuxProcessStatState('garbage')).toBeUndefined()
  })

  it('reads the start time as the birth token regardless of parentheses in the command', () => {
    expect(linuxProcessBirthToken(running)).toBe('987654')
    expect(linuxProcessBirthToken(zombie)).toBe('987654')
  })

  it('treats zombie and dead states as dead, everything else as alive', () => {
    expect(linuxProcessStatIsDead(zombie)).toBe(true)
    expect(linuxProcessStatIsDead(running.replace(') S ', ') X '))).toBe(true)
    expect(linuxProcessStatIsDead(running)).toBe(false)
    expect(linuxProcessStatIsDead(running.replace(') S ', ') D '))).toBe(false)
    expect(linuxProcessStatIsDead('')).toBe(false)
  })
})
