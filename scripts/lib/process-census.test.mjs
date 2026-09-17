import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { join } from 'node:path'

import {
  classifyProcess,
  collectProcessCensus,
  collectProcessResourceDetails,
  collectStableProcessResourceCheckpoint,
  compareProcessResourceCheckpoints,
  ownedProcessLedgerPaths,
  parseProcessTable,
  parseWindowsProcessTable,
  processTreeRows,
  pruneDeadOwnedProcessRecords,
  readOwnedProcessLedgers,
  summarizeRows,
  verifyCleanProcessStateBeforeRecovery
} from './process-census.mjs'

test('ownedProcessLedgerPaths mirrors the desktop owned-process ledger locations', () => {
  const workspaceRoot = '/repo/videorc'
  const workspaceKey = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16)

  assert.deepEqual(
    ownedProcessLedgerPaths({
      appDataDir: '/tmp/app-data',
      userDataDir: '/tmp/user-data',
      workspaceRoot
    }),
    [
      join('/tmp/app-data', 'Videorc', 'owned-processes', 'global.json'),
      join('/tmp/user-data', 'owned-processes', `${workspaceKey}.json`)
    ]
  )
})

test('readOwnedProcessLedgers filters invalid records and dedupes pids', () => {
  const files = new Map([
    [
      '/tmp/global.json',
      JSON.stringify([
        { pid: 111, label: 'cargo-run-videorc-backend', startedAt: '2026-06-20T10:00:00.000Z' },
        { pid: 111, label: 'duplicate', startedAt: '2026-06-20T10:00:01.000Z' },
        { pid: 1, label: 'invalid', startedAt: '2026-06-20T10:00:02.000Z' },
        { pid: 222, label: 42, startedAt: '2026-06-20T10:00:03.000Z' }
      ])
    ],
    [
      '/tmp/workspace.json',
      JSON.stringify([
        { pid: 333, label: 'native-preview-helper', startedAt: '2026-06-20T10:00:04.000Z' }
      ])
    ]
  ])

  assert.deepEqual(
    readOwnedProcessLedgers(['/tmp/global.json', '/tmp/workspace.json'], {
      readFile: (path) => files.get(path)
    }),
    [
      {
        pid: 111,
        label: 'cargo-run-videorc-backend',
        startedAt: '2026-06-20T10:00:00.000Z',
        ledgerPath: '/tmp/global.json'
      },
      {
        pid: 333,
        label: 'native-preview-helper',
        startedAt: '2026-06-20T10:00:04.000Z',
        ledgerPath: '/tmp/workspace.json'
      }
    ]
  )
})

test('parseProcessTable keeps command args with spaces and classifies Videorc roles', () => {
  const rows = parseProcessTable(`
  101   1 100 2048 /opt/homebrew/bin/pnpm pnpm dev
  102 101 100 4096 /Users/orc/.cargo/bin/cargo cargo run --quiet -p videorc-backend --bin videorc-backend
  103 102 100 8192 /repo/target/debug/videorc-backend /repo/target/debug/videorc-backend
  104 101 100 1024 /Applications/Electron.app/Contents/MacOS/Electron /Applications/Electron.app/Contents/MacOS/Electron --type=renderer --foo bar
  105 101 100 1024 /usr/local/bin/native_preview_host_helper native_preview_host_helper
`)

  assert.equal(rows.length, 5)
  assert.equal(
    rows[3].args,
    '/Applications/Electron.app/Contents/MacOS/Electron --type=renderer --foo bar'
  )
  assert.equal(classifyProcess(rows[0]), 'tooling')
  assert.equal(classifyProcess(rows[1]), 'cargo')
  assert.equal(classifyProcess(rows[2]), 'backend')
  assert.equal(classifyProcess(rows[3]), 'electron-renderer')
  assert.equal(classifyProcess(rows[4]), 'native-preview-helper')
})

test('classifyProcess does not count launcher wrappers as backend or preview helpers', () => {
  assert.equal(
    classifyProcess({
      command: '/bin/sh',
      args: 'sh -c /repo/target/debug/videorc-backend --port 1234'
    }),
    'other'
  )
  assert.equal(
    classifyProcess({
      command: '/opt/homebrew/bin/node',
      args: 'node scripts/launch.mjs /repo/target/debug/native_preview_host_helper'
    }),
    'other'
  )
})

test('classifyProcess identifies auxiliary Electron renderers independently', () => {
  for (const role of ['notes', 'comments', 'captions']) {
    assert.equal(
      classifyProcess({
        command: 'C:\\Program Files\\Videorc\\Videorc.exe',
        args: `--type=renderer --videorc-renderer-role=${role}`
      }),
      `electron-renderer-${role}`
    )
  }
  assert.equal(
    classifyProcess({
      command: 'C:\\Program Files\\Videorc\\Videorc.exe',
      args: '--type=renderer --videorc-renderer-role=main'
    }),
    'electron-renderer'
  )
})

test('classifyProcess uses the exact argv executable when macOS truncates comm', () => {
  assert.equal(
    classifyProcess({
      command: 'target/debug/vid',
      args: 'target/debug/videorc-backend --port 1234'
    }),
    'backend'
  )
  assert.equal(
    classifyProcess({
      command: '/Users/orcdev/pr',
      args: '"/repo/build/native_preview_host_helper" --stdio'
    }),
    'native-preview-helper'
  )
})

test('classifyProcess counts electron-vite under the Videorc workspace as tooling', () => {
  assert.equal(
    classifyProcess({
      command: '/opt/homebrew/bin/node',
      args: '/Users/orcdev/projects/videorc/node_modules/electron-vite/bin/electron-vite.js dev'
    }),
    'tooling'
  )
})

test('classifyProcess counts an esbuild service under the Videorc workspace as tooling', () => {
  assert.equal(
    classifyProcess({
      command: '/Users/orcdev/projects/videorc/node_modules/@esbuild/darwin-arm64/bin/esbuild',
      args: '/Users/orcdev/projects/videorc/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.6 --ping'
    }),
    'tooling'
  )
})

test('classifyProcess still counts the Electron app executable as electron-main', () => {
  assert.equal(
    classifyProcess({
      command:
        '/Users/orcdev/projects/videorc/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      args: '/Users/orcdev/projects/videorc/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .'
    }),
    'electron-main'
  )
  assert.equal(
    classifyProcess({
      command: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
      args: '"C:\\repo\\node_modules\\electron\\dist\\electron.exe" .'
    }),
    'electron-main'
  )
})

test('classifyProcess does not count arbitrary Videorc workspace descendants as electron-main', () => {
  assert.equal(
    classifyProcess({
      command: '/opt/homebrew/bin/node',
      args: '/Users/orcdev/projects/videorc/scripts/preview-lifecycle-probe.mjs'
    }),
    'other'
  )
})

test('parseWindowsProcessTable normalizes CIM process JSON and classifies Videorc roles', () => {
  const rows = parseWindowsProcessTable(`[
    {
      "ProcessId": 301,
      "ParentProcessId": 300,
      "CreationDate": "2026-07-18T12:00:00.000000-04:00",
      "WorkingSetSize": 4194304,
      "KernelModeTime": 10000000,
      "UserModeTime": 20000000,
      "ExecutablePath": "C:\\\\repo\\\\target\\\\debug\\\\videorc-backend.exe",
      "CommandLine": "\\"C:\\\\repo\\\\target\\\\debug\\\\videorc-backend.exe\\" --port 1234"
    },
    {
      "ProcessId": 302,
      "ParentProcessId": 301,
      "CreationDate": "2026-07-18T12:00:01.000000-04:00",
      "WorkingSetSize": 2097152,
      "KernelModeTime": 3000000,
      "UserModeTime": 4000000,
      "ExecutablePath": null,
      "CommandLine": "\\"C:\\\\repo\\\\vendor\\\\ffmpeg\\\\bin\\\\ffmpeg.exe\\" -version"
    },
    {
      "ProcessId": 303,
      "ParentProcessId": 301,
      "CreationDate": "2026-07-18T12:00:02.000000-04:00",
      "WorkingSetSize": 1048576,
      "KernelModeTime": 5000000,
      "UserModeTime": 6000000,
      "ExecutablePath": "C:\\\\repo\\\\target\\\\debug\\\\native_preview_host_helper.exe",
      "CommandLine": null
    }
  ]`)

  assert.deepEqual(
    rows.map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      rssKb: row.rssKb,
      cpuTimeMs: row.cpuTimeMs,
      creationDate: row.creationDate,
      command: row.command,
      role: classifyProcess(row)
    })),
    [
      {
        pid: 301,
        ppid: 300,
        pgid: null,
        rssKb: 4096,
        cpuTimeMs: 3000,
        creationDate: '2026-07-18T12:00:00.000000-04:00',
        command: 'C:\\repo\\target\\debug\\videorc-backend.exe',
        role: 'backend'
      },
      {
        pid: 302,
        ppid: 301,
        pgid: null,
        rssKb: 2048,
        cpuTimeMs: 700,
        creationDate: '2026-07-18T12:00:01.000000-04:00',
        command: 'C:\\repo\\vendor\\ffmpeg\\bin\\ffmpeg.exe',
        role: 'ffmpeg'
      },
      {
        pid: 303,
        ppid: 301,
        pgid: null,
        rssKb: 1024,
        cpuTimeMs: 1100,
        creationDate: '2026-07-18T12:00:02.000000-04:00',
        command: 'C:\\repo\\target\\debug\\native_preview_host_helper.exe',
        role: 'native-preview-helper'
      }
    ]
  )
})

test('parseWindowsProcessTable accepts a single CIM process object', () => {
  const rows = parseWindowsProcessTable(`{
    "ProcessId": 404,
    "ParentProcessId": 12,
    "WorkingSetSize": 1024,
    "ExecutablePath": null,
    "CommandLine": "C:\\\\Windows\\\\System32\\\\cmd.exe /c echo ok"
  }`)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 404)
  assert.equal(rows[0].command, 'C:\\Windows\\System32\\cmd.exe')
})

test('collectProcessCensus reports alive and dead ledger records without killing anything', async () => {
  const files = new Map([
    [
      '/tmp/global.json',
      JSON.stringify([
        { pid: 111, label: 'cargo-run-videorc-backend', startedAt: '2026-06-20T10:00:00.000Z' },
        { pid: 222, label: 'native-preview-helper', startedAt: '2026-06-20T10:00:01.000Z' }
      ])
    ]
  ])
  const table = parseProcessTable(`
  111   1 900 2048 /Users/orc/.cargo/bin/cargo cargo run --quiet -p videorc-backend --bin videorc-backend
  333   1 900 1024 /Applications/Electron.app/Contents/MacOS/Electron Electron
`)

  const census = await collectProcessCensus({
    ledgerPaths: ['/tmp/global.json'],
    pgid: 900,
    readFile: (path) => files.get(path),
    readProcessTable: async () => table
  })

  assert.deepEqual(
    census.aliveRecords.map((record) => record.pid),
    [111]
  )
  assert.deepEqual(
    census.deadRecords.map((record) => record.pid),
    [222]
  )
  assert.equal(census.processGroupRows.length, 2)
  assert.deepEqual(summarizeRows(census.processRows).cargo, { count: 1, rssKb: 2048 })
})

test('processTreeRows and rootPid census include the complete Windows app tree', async () => {
  const table = parseWindowsProcessTable(`[
    {"ProcessId": 100, "ParentProcessId": 1, "WorkingSetSize": 1024, "ExecutablePath": "C:\\\\Videorc.exe"},
    {"ProcessId": 101, "ParentProcessId": 100, "WorkingSetSize": 2048, "ExecutablePath": "C:\\\\Videorc.exe", "CommandLine": "C:\\\\Videorc.exe --type=renderer"},
    {"ProcessId": 102, "ParentProcessId": 100, "WorkingSetSize": 4096, "ExecutablePath": "C:\\\\videorc-backend.exe"},
    {"ProcessId": 103, "ParentProcessId": 102, "WorkingSetSize": 8192, "ExecutablePath": "C:\\\\ffmpeg.exe"},
    {"ProcessId": 200, "ParentProcessId": 1, "WorkingSetSize": 16384, "ExecutablePath": "C:\\\\unrelated.exe"}
  ]`)

  assert.deepEqual(
    processTreeRows(table, 100).map((row) => row.pid),
    [100, 101, 102, 103]
  )
  const census = await collectProcessCensus({
    ledgerPaths: [],
    rootPid: 100,
    readProcessTable: async () => table
  })
  assert.deepEqual(
    census.processGroupRows.map((row) => row.pid),
    [100, 101, 102, 103]
  )
  assert.deepEqual(Object.keys(census.summary).sort(), [
    'backend',
    'electron-main',
    'electron-renderer',
    'ffmpeg'
  ])
})

test('collectProcessResourceDetails records macOS physical footprint and open files at checkpoints', async () => {
  const census = {
    processRows: [{ pid: 111, role: 'backend' }]
  }
  const details = await collectProcessResourceDetails(census, {
    platform: 'darwin',
    exec: async (command) =>
      command === 'footprint'
        ? { stdout: 'Auxiliary data:\n    phys_footprint: 123456 B\n' }
        : { stdout: 'p111\nfcwd\nftxt\nf0\nf1\n' }
  })

  assert.deepEqual(details.rows, [
    {
      pid: 111,
      role: 'backend',
      physicalFootprintBytes: 123456,
      openFileCount: 2
    }
  ])
  assert.deepEqual(details.totals, { physicalFootprintBytes: 123456, openFileCount: 2 })
  assert.deepEqual(details.coverage, {
    physicalFootprintBytes: {
      requested: 1,
      succeeded: 1,
      complete: true,
      byRole: { backend: { requested: 1, succeeded: 1, complete: true } }
    },
    openFileCount: {
      requested: 1,
      succeeded: 1,
      complete: true,
      byRole: { backend: { requested: 1, succeeded: 1, complete: true } }
    }
  })
})

test('stable resource checkpoints retry a transient process and retain complete persistent rows', async () => {
  const persistent = {
    processRows: [
      { pid: 111, role: 'electron-main' },
      { pid: 222, role: 'backend' }
    ]
  }
  const withTransientSampler = {
    processRows: [...persistent.processRows, { pid: 333, role: 'other' }]
  }
  const censuses = [persistent, withTransientSampler, persistent, persistent]
  let resourcesCollected = 0

  const result = await collectStableProcessResourceCheckpoint({
    collectCensus: async () => censuses.shift(),
    collectResources: async (census) => {
      resourcesCollected += 1
      const rows = census.processRows.map((row) => ({
        ...row,
        physicalFootprintBytes: row.pid * 1_000,
        openFileCount: row.pid
      }))
      return completeResourceCheckpoint(rows)
    },
    settleMs: 0
  })

  assert.equal(resourcesCollected, 1)
  assert.deepEqual(
    result.checkpoint.rows.map((row) => row.pid),
    [111, 222]
  )
  assert.deepEqual(result.checkpoint.stability, {
    attempts: 4,
    consecutiveIdentitySamples: 2,
    excludedObservers: []
  })
})

test('stable resource checkpoints exclude only the exact backend resource sampler observer', async () => {
  const persistent = [
    { pid: 111, ppid: 1, role: 'electron-main', command: '/app/Videorc', args: 'Videorc' },
    { pid: 222, ppid: 111, role: 'backend', command: '/app/videorc-backend', args: '' }
  ]
  const censuses = [333, 444].map((pid) => ({
    processRows: [
      ...persistent,
      {
        pid,
        ppid: 222,
        role: 'other',
        command: '/bin/ps',
        args: 'ps -axo pid=,ppid=,rss=,comm='
      }
    ]
  }))

  const result = await collectStableProcessResourceCheckpoint({
    collectCensus: async () => censuses.shift(),
    collectResources: async (census) =>
      completeResourceCheckpoint(
        census.processRows.map((row) => ({
          ...row,
          physicalFootprintBytes: row.pid * 1_000,
          openFileCount: row.pid
        }))
      ),
    settleMs: 0
  })

  assert.deepEqual(
    result.checkpoint.rows.map((row) => row.pid),
    [111, 222]
  )
  assert.deepEqual(result.checkpoint.stability, {
    attempts: 2,
    consecutiveIdentitySamples: 2,
    excludedObservers: [
      {
        pid: 333,
        role: 'other',
        command: '/bin/ps',
        args: 'ps -axo pid=,ppid=,rss=,comm='
      },
      {
        pid: 444,
        role: 'other',
        command: '/bin/ps',
        args: 'ps -axo pid=,ppid=,rss=,comm='
      }
    ]
  })
})

test('stable resource checkpoints retain unrelated other processes', async () => {
  const census = {
    processRows: [
      { pid: 222, ppid: 1, role: 'backend', command: '/app/videorc-backend', args: '' },
      { pid: 555, ppid: 222, role: 'other', command: '/bin/ps', args: 'ps aux' }
    ]
  }
  let collectedRows = []
  const result = await collectStableProcessResourceCheckpoint({
    collectCensus: async () => census,
    collectResources: async (stableCensus) => {
      collectedRows = stableCensus.processRows
      return completeResourceCheckpoint(
        stableCensus.processRows.map((row) => ({
          ...row,
          physicalFootprintBytes: row.pid * 1_000,
          openFileCount: row.pid
        }))
      )
    },
    settleMs: 0
  })

  assert.deepEqual(
    collectedRows.map((row) => row.pid),
    [222, 555]
  )
  assert.deepEqual(result.checkpoint.stability.excludedObservers, [])
})

test('stable resource checkpoints retry incomplete resource coverage', async () => {
  const census = { processRows: [{ pid: 111, role: 'backend' }] }
  let attempts = 0
  const result = await collectStableProcessResourceCheckpoint({
    collectCensus: async () => census,
    collectResources: async () => {
      attempts += 1
      return attempts === 1
        ? {
            rows: [
              {
                pid: 111,
                role: 'backend',
                physicalFootprintBytes: null,
                openFileCount: 1
              }
            ],
            coverage: {
              physicalFootprintBytes: { requested: 1, succeeded: 0, complete: false },
              openFileCount: { requested: 1, succeeded: 1, complete: true }
            },
            totals: { physicalFootprintBytes: null, openFileCount: 1 }
          }
        : completeResourceCheckpoint([
            {
              pid: 111,
              role: 'backend',
              physicalFootprintBytes: 111_000,
              openFileCount: 1
            }
          ])
    },
    settleMs: 0
  })

  assert.equal(attempts, 2)
  assert.equal(result.checkpoint.coverage.physicalFootprintBytes.complete, true)
})

test('resource checkpoint totals stay null when the last footprint sample is incomplete', async () => {
  const census = {
    processRows: [
      { pid: 111, role: 'backend' },
      { pid: 222, role: 'native-preview-helper' }
    ]
  }
  const collect = (failedFootprintPid = null) =>
    collectProcessResourceDetails(census, {
      platform: 'darwin',
      exec: async (command, args) => {
        const pid = Number(args[command === 'footprint' ? 1 : 2])
        if (command === 'footprint') {
          if (pid === failedFootprintPid) throw new Error('footprint failed')
          return { stdout: `phys_footprint: ${pid * 1000} B\n` }
        }
        return { stdout: `p${pid}\nfcwd\nftxt\nf0\nf1\n` }
      }
    })

  const first = await collect()
  const last = await collect(222)
  const comparison = compareProcessResourceCheckpoints(first, last)

  assert.equal(last.totals.physicalFootprintBytes, null)
  assert.deepEqual(last.coverage.physicalFootprintBytes, {
    requested: 2,
    succeeded: 1,
    complete: false,
    byRole: {
      backend: { requested: 1, succeeded: 1, complete: true },
      'native-preview-helper': { requested: 1, succeeded: 0, complete: false }
    }
  })
  assert.equal(comparison.metrics.physicalFootprintBytes.comparable, false)
  assert.equal(comparison.metrics.physicalFootprintBytes.delta, null)
  assert.deepEqual(comparison.metrics.physicalFootprintBytes.reasons, [
    'last coverage incomplete (1/2)'
  ])
  assert.equal(comparison.metrics.openFileCount.comparable, true)
  assert.equal(comparison.metrics.openFileCount.delta, 0)
})

test('resource checkpoint comparison reports helper PID replacement as non-comparable', async () => {
  const collect = (helperPid) =>
    collectProcessResourceDetails(
      {
        processRows: [
          { pid: 111, role: 'backend' },
          { pid: helperPid, role: 'native-preview-helper' }
        ]
      },
      {
        platform: 'darwin',
        exec: async (command, args) => {
          const pid = Number(args[command === 'footprint' ? 1 : 2])
          return command === 'footprint'
            ? { stdout: `phys_footprint: ${pid * 1000} B\n` }
            : { stdout: `p${pid}\nfcwd\nftxt\nf0\n` }
        }
      }
    )

  const first = await collect(222)
  const last = await collect(333)
  const comparison = compareProcessResourceCheckpoints(first, last)

  assert.deepEqual(comparison.processContinuity, {
    comparable: false,
    pidContinuity: false,
    roleContinuity: true,
    firstCount: 2,
    lastCount: 2,
    retainedPids: [111],
    removedPids: [222],
    addedPids: [333],
    roleChanges: [],
    replacements: [{ role: 'native-preview-helper', removedPids: [222], addedPids: [333] }],
    byRole: {
      backend: {
        firstPids: [111],
        lastPids: [111],
        retainedPids: [111],
        removedPids: [],
        addedPids: [],
        pidContinuity: true,
        countContinuity: true
      },
      'native-preview-helper': {
        firstPids: [222],
        lastPids: [333],
        retainedPids: [],
        removedPids: [222],
        addedPids: [333],
        pidContinuity: false,
        countContinuity: true
      }
    }
  })
  assert.equal(comparison.metrics.physicalFootprintBytes.comparable, false)
  assert.equal(comparison.metrics.physicalFootprintBytes.delta, null)
  assert.match(
    comparison.metrics.physicalFootprintBytes.reasons.join('\n'),
    /native-preview-helper 222 -> 333/
  )
})

test('pruneDeadOwnedProcessRecords removes only records whose pids are gone', async () => {
  const files = new Map([
    [
      '/tmp/global.json',
      JSON.stringify([
        { pid: 111, label: 'videorc-backend', startedAt: '2026-06-20T10:00:00.000Z' },
        { pid: 222, label: 'native-preview-helper', startedAt: '2026-06-20T10:00:01.000Z' }
      ])
    ]
  ])
  const table = parseProcessTable(`
  111   1 900 2048 /repo/target/debug/videorc-backend target/debug/videorc-backend
`)

  const pruned = await pruneDeadOwnedProcessRecords({
    ledgerPaths: ['/tmp/global.json'],
    readFile: (path) => files.get(path),
    writeFile: (path, contents) => files.set(path, contents),
    readProcessTable: async () => table
  })

  assert.equal(pruned.length, 1)
  assert.deepEqual(
    pruned[0].removed.map((record) => record.pid),
    [222]
  )
  assert.deepEqual(JSON.parse(files.get('/tmp/global.json')), [
    { pid: 111, label: 'videorc-backend', startedAt: '2026-06-20T10:00:00.000Z' }
  ])
})

test('verifyCleanProcessStateBeforeRecovery preserves the original failure before pruning', async () => {
  const expected = new Error('ledger was not empty')
  const calls = []

  await assert.rejects(
    verifyCleanProcessStateBeforeRecovery({
      verify: async () => {
        calls.push('verify')
        throw expected
      },
      recover: async () => {
        calls.push('recover')
      }
    }),
    (error) => error === expected
  )
  assert.deepEqual(calls, ['verify', 'recover'])
})

test('verifyCleanProcessStateBeforeRecovery reports recovery failure without replacing verification failure', async () => {
  const verificationFailure = new Error('ledger was not empty')
  const verificationStack = verificationFailure.stack
  const recoveryFailure = new Error('could not rewrite ledger')
  const calls = []

  await assert.rejects(
    verifyCleanProcessStateBeforeRecovery({
      verify: async () => {
        calls.push('verify')
        throw verificationFailure
      },
      recover: async () => {
        calls.push('recover')
        throw recoveryFailure
      }
    }),
    (error) => {
      assert.equal(error, verificationFailure)
      assert.equal(error.message, 'ledger was not empty')
      assert.equal(error.stack, verificationStack)
      assert.equal(error.recoveryError, recoveryFailure)
      return true
    }
  )
  assert.deepEqual(calls, ['verify', 'recover'])
})

function completeResourceCheckpoint(rows) {
  const byRole = Object.fromEntries(
    [...new Set(rows.map((row) => row.role))].map((role) => {
      const count = rows.filter((row) => row.role === role).length
      return [role, { requested: count, succeeded: count, complete: count > 0 }]
    })
  )
  return {
    rows,
    coverage: {
      physicalFootprintBytes: {
        requested: rows.length,
        succeeded: rows.length,
        complete: rows.length > 0,
        byRole
      },
      openFileCount: {
        requested: rows.length,
        succeeded: rows.length,
        complete: rows.length > 0,
        byRole
      }
    },
    totals: {
      physicalFootprintBytes: rows.reduce((total, row) => total + row.physicalFootprintBytes, 0),
      openFileCount: rows.reduce((total, row) => total + row.openFileCount, 0)
    }
  }
}
