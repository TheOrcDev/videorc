import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { join } from 'node:path'

import {
  classifyProcess,
  collectProcessCensus,
  ownedProcessLedgerPaths,
  parseProcessTable,
  pruneDeadOwnedProcessRecords,
  readOwnedProcessLedgers,
  summarizeRows
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
