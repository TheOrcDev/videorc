#!/usr/bin/env node
// Plan 178 U12. Headless Claude triage of published live-lab runs.
//
//   pnpm live:triage [--since <iso>] [--run <dir>] [--dry-run] [--json]
//
// For each run folder with published.json and no triaged.json: gather the
// verdict summary, the harness clone's git log and the issue threads U10
// recorded, run `claude -p` read-only (no Bash, no edits, no network tools)
// with config/live-lab/claude-settings.json, then post one validated comment
// per issue and write triaged.json. Refuses when policy.triage is not true or
// a run is live (run lock held). Never starts a stream. --dry-run writes
// nothing, posts nothing and prints the prompt and the claude argv.
//
// Exit codes: 0 done (or nothing to do), 2 refused (policy, lock), 1 error.

import { join } from 'node:path'

import { workDir } from './lib/config.mjs'
import { runsDirOf } from './lib/harness.mjs'
import { loadPolicy } from './lib/policy.mjs'
import { checkCanTriage, findRunsToTriage, triageRun } from './lib/triage.mjs'

function parseArgs(argv) {
  const out = { since: null, run: null, dryRun: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--since') out.since = argv[++index] ?? null
    else if (arg === '--run') out.run = argv[++index] ?? null
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--json') out.json = true
    else throw new Error(`unknown argument ${arg}`)
  }
  if (out.since !== null && !Number.isFinite(Date.parse(out.since))) {
    throw new Error('--since needs an ISO time')
  }
  return out
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`live:triage: ${error.message}`)
  process.exit(1)
}

const work = workDir()
const { policy, problems } = await loadPolicy()
const gate = await checkCanTriage({ workDir: work, policy, problems })
if (!gate.ok) {
  console.error(`REFUSED (${gate.reason})`)
  if (!args.dryRun) process.exit(2)
  console.error('dry run continues; nothing is invoked or posted')
}

const runs = args.run
  ? [args.run]
  : await findRunsToTriage({ runsDir: runsDirOf(work), since: args.since })
if (!runs.length) {
  console.log('live:triage: nothing to triage')
  process.exit(0)
}

const results = []
let failed = false
for (const runDir of runs) {
  const record = await triageRun({
    runDir: join(runDir),
    dryRun: args.dryRun,
    deps: { log: (line) => console.log(line) }
  })
  results.push(record)
  if (record.status === 'error') failed = true
  if (args.dryRun) {
    console.log(
      `--- ${record.runId}: claude ${(record.argv ?? record.claude?.args ?? []).join(' ')}`
    )
    console.log(record.prompt ?? '')
  } else {
    console.log(`${record.runId}: ${record.status}${record.reason ? ` (${record.reason})` : ''}`)
  }
}
if (args.json) console.log(JSON.stringify(results, null, 2))
process.exit(failed ? 1 : 0)
