#!/usr/bin/env node
// Plan 178 U6 (plan 176 L2). One live-lab run on the lab machine.
//
//   pnpm live:run --scenario <name> --trigger schedule|on-demand|manual
//        [--build release|candidate] [--privacy unlisted|public|private] [--json]
//
// Scenario params: VIDEORC_LIVE_LAB_SCENARIO_PARAMS='{"marathonHours":4}'.
// Exit codes, the RUN_DIR line and the flow are documented in lib/harness.mjs;
// the scenario format in lib/step-engine.mjs. Every run goes through the
// owner's policy (canStart) and the run lock, and stops within 60 s on any
// kill switch (STOP file, control.json, policy change, Studio end, Ctrl-C).

import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { labDir, readConfig, workDir } from './lib/config.mjs'
import { countRunsToday, executeRun, gatherMachineFacts, runsDirOf } from './lib/harness.mjs'
import { readInstallRecord } from './lib/install-swap.mjs'
import { fetchControlFromUrl, stopFilePath } from './lib/kill-switch.mjs'
import { loadPolicy } from './lib/policy.mjs'
import { createQuotaLedger } from './lib/quota-ledger.mjs'
import { acquireRunLock, processAlive, readRunLock, releaseRunLock } from './lib/run-lock.mjs'
import { createSessionStarter } from './lib/session.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const scenariosDir = join(import.meta.dirname, 'scenarios')
const work = workDir()
const lab = labDir()

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function loadScenario(name) {
  // parseRunArgs already limited the name to [a-z0-9-].
  const path = join(scenariosDir, `${name}.mjs`)
  if (!(await exists(path))) return null
  const module = await import(pathToFileURL(path).href)
  return module.default ?? null
}

const ledger = createQuotaLedger({ dir: lab })

const result = await executeRun({
  argv: process.argv.slice(2),
  deps: {
    workDir: work,
    scenarioParamsText: process.env.VIDEORC_LIVE_LAB_SCENARIO_PARAMS,
    loadPolicy: () => loadPolicy(),
    readPolicyText: (path) => readFile(path, 'utf8'),
    readInstallRecord: () => readInstallRecord(lab),
    loadScenario,
    quotaUnitsToday: () => ledger.today().units,
    fetchControl: async () => {
      const { policy } = await loadPolicy()
      if (!policy) throw new Error('policy missing or invalid')
      return fetchControlFromUrl(policy.killSwitchUrl)
    },
    stopFilePath: stopFilePath(work),
    stopFileExists: () => exists(stopFilePath(work)),
    readRunLock: () => readRunLock({ dir: work }),
    acquireRunLock: ({ runId }) => acquireRunLock({ dir: work, runId }),
    releaseRunLock: ({ runId }) => releaseRunLock({ dir: work, runId, pid: process.pid }),
    processAlive,
    countRunsToday: (day, timeZone) => countRunsToday({ runsDir: runsDirOf(work), day, timeZone }),
    machineFacts: () => gatherMachineFacts({ repoRoot }),
    startSession: async (options) =>
      createSessionStarter({
        config: await readConfig(lab),
        install: await readInstallRecord(lab),
        workDir: work
      })(options),
    attachSignals: true
  }
})

process.exitCode = result.exitCode
// Let stdout drain, then leave even if a stray handle lingers.
setTimeout(() => process.exit(result.exitCode), 1000)
