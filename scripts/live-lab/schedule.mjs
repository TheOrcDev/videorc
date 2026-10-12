#!/usr/bin/env node

// Plan 178 U11: the live lab's daily schedule.
//
//   pnpm live:schedule tick              what the scheduler runs every 300 s
//   pnpm live:schedule status [--json] [--no-control]
//   pnpm live:schedule install-agent [--force] [--force-user]
//   pnpm live:schedule uninstall-agent [--force] [--force-user]
//
// The scheduler (plan 179) is a launchd agent on macOS
// (~/Library/LaunchAgents/com.videorc.live-lab.plist in gui/<uid>) and a
// systemd user timer on Linux (~/.config/systemd/user/videorc-live-lab.timer
// starting videorc-live-lab.service). Both install only for the policy's
// labUser (videorc-lab when the policy has none or does not load).
//
// The table is config/live-lab/schedule.json, read in the policy timezone.
// A slot runs once a day inside [slot, slot + grace]; a missed slot is
// recorded and skipped, never run late. State: <work dir>/schedule-state.json.
// Logs: <work dir>/logs/schedule-<date>.log.

import { homedir, userInfo } from 'node:os'
import { parseArgs } from 'node:util'

import { LAB_USER, workDir } from './lib/config.mjs'
import { requireLabPlatform } from './lib/platform.mjs'
import { loadPolicy } from './lib/policy.mjs'
import { heldRunLock } from './lib/schedule-actions.mjs'
import { AgentRefusal, installAgent, uninstallAgent } from './lib/schedule-agent.mjs'
import { formatStatus, gatherStatus } from './lib/schedule-status.mjs'
import { runTick } from './lib/schedule-tick.mjs'

const USAGE = [
  'Usage: live:schedule <tick | status [--json] [--no-control] | install-agent | uninstall-agent> [--force] [--force-user]',
  '  install-agent    macOS: the launchd agent in ~/Library/LaunchAgents; Linux: the systemd user timer in ~/.config/systemd/user',
  '  uninstall-agent  removes it; both refuse while a run holds the run lock unless --force'
].join('\n')

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      'no-control': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'force-user': { type: 'boolean', default: false }
    }
  })
  const [command] = positionals
  if (positionals.length !== 1) throw new Error(USAGE)

  if (command === 'tick') {
    const result = await runTick()
    process.exitCode = result.exitCode
    return
  }
  if (command === 'status') {
    const status = await gatherStatus({ checkControl: !values['no-control'] })
    if (values.json) console.log(JSON.stringify(status, null, 2))
    else console.log(formatStatus(status).join('\n'))
    return
  }
  if (command === 'install-agent' || command === 'uninstall-agent') {
    const platform = process.platform
    requireLabPlatform(platform, 'The schedule agent')
    // The policy only names the lab user here; the tick still refuses to run
    // without a valid one.
    const loaded = await loadPolicy().catch((error) => ({
      policy: null,
      problems: [error.message]
    }))
    if (!loaded.policy) {
      console.log(
        `The policy did not load (${loaded.problems[0] ?? 'no reason given'}); expecting the default lab user ${LAB_USER}.`
      )
    }
    const held = await heldRunLock(workDir())
    const options = {
      platform,
      labUser: loaded.policy?.labUser ?? LAB_USER,
      home: homedir(),
      uid: process.getuid(),
      username: userInfo().username,
      forceUser: values['force-user'],
      force: values.force,
      lockHolder: held?.describe ?? null,
      log: (line) => console.log(line)
    }
    if (command === 'install-agent') await installAgent(options)
    else await uninstallAgent(options)
    return
  }
  throw new Error(USAGE)
}

main().catch((error) => {
  if (error instanceof AgentRefusal) {
    console.error(`live:schedule REFUSED: ${error.message}`)
    process.exit(2)
  }
  console.error(`live:schedule failed: ${error.message}`)
  process.exit(1)
})
