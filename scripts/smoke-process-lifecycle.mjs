import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import {
  collectProcessCensus,
  formatCensus,
  ownedProcessLedgerPaths,
  pruneDeadOwnedProcessRecords,
  verifyCleanProcessStateBeforeRecovery,
  waitForCleanProcessState,
  waitForNoLiveProcessState
} from './lib/process-census.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-process-lifecycle-'))
const appDataDir = join(stateRoot, 'app-data')
const userDataDir = join(stateRoot, 'user-data')
const ledgerPaths = ownedProcessLedgerPaths({
  appDataDir,
  userDataDir,
  workspaceRoot: repoRoot
})
const injectStaleLedger = process.env.VIDEORC_SMOKE_INJECT_STALE_LEDGER === '1'

let launched

try {
  launched = await launchDevApp({
    env: {
      VIDEORC_APP_DATA_DIR: appDataDir,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_DISABLE_BACKEND_REAP: '0',
      VIDEORC_SMOKE_COMMAND_SERVER: '1'
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (/Reaping|Backend exited|Native preview host helper|error|panic/i.test(line)) {
        console.log(line)
      }
    }
  })

  const running = await collectProcessCensus({
    ledgerPaths,
    pgid: launched.process.pid
  })
  console.log('\n=== running process census ===')
  console.log(formatCensus(running))

  assert.ok(running.records.length > 0, 'running app should record at least one owned process')
  assert.ok(
    running.aliveRecords.length > 0,
    'running app should have at least one live owned process record'
  )
} finally {
  if (launched) {
    let gracefulQuitCompleted = false
    try {
      await requestSmokeCommand(
        launched.connections['preview-motion-ready'],
        'app-quit',
        {},
        { timeoutMs: 2000 }
      )
      await waitForCleanProcessState({
        ledgerPaths,
        pgid: launched.process.pid,
        timeoutMs: 10000
      })
      gracefulQuitCompleted = true
    } catch (error) {
      console.warn(
        `Graceful app quit failed; using forced launcher teardown: ${error?.message ?? error}`
      )
    }
    if (!gracefulQuitCompleted) await launched.stop()
  }

  console.log('\n=== teardown process census ===')
  const stopped = await waitForNoLiveProcessState({
    ledgerPaths,
    pgid: launched?.process?.pid,
    timeoutMs: 10000
  })
  console.log(formatCensus(stopped))

  if (injectStaleLedger) {
    const ledgerPath = ledgerPaths[0]
    await mkdir(dirname(ledgerPath), { recursive: true })
    await writeFile(
      ledgerPath,
      `${JSON.stringify(
        [
          {
            pid: 2_147_483_647,
            label: 'injected-dead-process-record',
            startedAt: '2000-01-01T00:00:00.000Z'
          }
        ],
        null,
        2
      )}\n`
    )
    console.log(`Injected an isolated stale ledger record at ${ledgerPath}`)
  }

  try {
    const clean = await verifyCleanProcessStateBeforeRecovery({
      verify: () =>
        waitForCleanProcessState({
          ledgerPaths,
          pgid: launched?.process?.pid,
          timeoutMs: 1000
        }),
      recover: async () => {
        const pruned = await pruneDeadOwnedProcessRecords({ ledgerPaths })
        for (const entry of pruned) {
          console.log(
            `recovery pruned ${entry.removed.length} dead owned process record(s) from ${entry.ledgerPath}`
          )
        }
      }
    })
    console.log('\n=== clean process census ===')
    console.log(formatCensus(clean))
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}

console.log('Process lifecycle smoke OK - owned process records and process group cleaned up.')
