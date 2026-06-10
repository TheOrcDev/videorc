import { describe, expect, it } from 'vitest'

import { OwnedProcessRegistry, ownedProcessLedgerPath, type OwnedProcessRecord } from './backend-owned-processes'

describe('OwnedProcessRegistry', () => {
  it('records and removes owned child processes in a workspace-scoped ledger', () => {
    let ledger = ''
    const registry = new OwnedProcessRegistry({
      ledgerPath: '/tmp/videorc-owned.json',
      now: () => '2026-06-11T10:00:00.000Z',
      readFile: () => ledger,
      writeFile: (_path, contents) => {
        ledger = contents
      },
      makeDir: () => undefined
    })

    registry.record(1234, 'backend')
    registry.record(5678, 'native-preview-helper')
    registry.remove(1234)

    expect(JSON.parse(ledger)).toEqual([
      {
        pid: 5678,
        label: 'native-preview-helper',
        startedAt: '2026-06-11T10:00:00.000Z'
      }
    ])
  })

  it('reaps only pids recorded in the ledger and never substring-matches command lines', () => {
    const records: OwnedProcessRecord[] = [
      { pid: 111, label: 'backend', startedAt: '2026-06-11T10:00:00.000Z' },
      { pid: 111, label: 'backend duplicate', startedAt: '2026-06-11T10:00:01.000Z' },
      { pid: 222, label: 'current process', startedAt: '2026-06-11T10:00:02.000Z' }
    ]
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let written = ''
    let scheduled: (() => void) | null = null
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
      schedule: (callback) => {
        scheduled = callback
        return 0
      }
    })

    const stale = registry.reapStale()
    const runScheduled = scheduled as (() => void) | null
    expect(runScheduled).not.toBeNull()
    runScheduled?.()

    expect(stale.map((record) => record.pid)).toEqual([111])
    expect(kills).toEqual([
      { pid: 111, signal: 'SIGTERM' },
      { pid: 111, signal: 'SIGKILL' }
    ])
    expect(JSON.parse(written)).toEqual([])
  })

  it('uses different ledger files for different worktrees', () => {
    const first = ownedProcessLedgerPath('/Users/orc/Library/Application Support/Videorc', '/repo/one')
    const second = ownedProcessLedgerPath('/Users/orc/Library/Application Support/Videorc', '/repo/two')

    expect(first).not.toEqual(second)
    expect(first).toContain('owned-processes')
    expect(second).toContain('owned-processes')
  })
})
