#!/usr/bin/env node

// Plan 178 U5: put the build under test on the lab machine.
//
//   pnpm live:install --build release
//   pnpm live:install --build candidate:<run-id|sha>
//   pnpm live:install --rollback
//
// Options: --app-path <path> (default /Applications/Videorc.app),
// --repo <owner/name> (default TheOrcDev/videorc), --feed-url <url>
// (default the app's own update feed), --json (print the install record).
//
// Only a Videorc.app signed with the Videorc Developer ID (team C2PA37RB58)
// installs; a release must also pass Gatekeeper. The record lands in
// <lab dir>/install.json.

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { labDir } from './lib/config.mjs'
import { DEFAULT_APP_PATH, installBuild, rollbackInstall } from './lib/install-flow.mjs'
import { InstallRefusal, createRunner } from './lib/install-runner.mjs'
import { DEFAULT_REPO, RELEASE_FEED_URL, parseBuildSpec } from './lib/install-sources.mjs'

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      build: { type: 'string' },
      rollback: { type: 'boolean', default: false },
      'app-path': { type: 'string', default: DEFAULT_APP_PATH },
      repo: { type: 'string', default: DEFAULT_REPO },
      'feed-url': { type: 'string', default: RELEASE_FEED_URL },
      json: { type: 'boolean', default: false }
    }
  })
  if (process.platform !== 'darwin') {
    throw new Error('live:install runs on the macOS lab machine only.')
  }
  if (values.rollback === Boolean(values.build)) {
    throw new Error('Pass exactly one of --build <release|candidate:<run-id|sha>> or --rollback.')
  }
  const appPath = resolve(values['app-path'])
  if (!appPath.endsWith('.app')) {
    throw new Error('--app-path must end in .app.')
  }
  const common = {
    appPath,
    labDir: labDir(),
    runner: createRunner(),
    log: (line) => console.log(line)
  }
  const record = values.rollback
    ? await rollbackInstall(common)
    : await installBuild({
        ...common,
        spec: parseBuildSpec(values.build),
        repo: values.repo,
        feedUrl: values['feed-url']
      })
  if (values.json) {
    console.log(JSON.stringify(record, null, 2))
  }
}

main().catch((error) => {
  if (error instanceof InstallRefusal) {
    console.error(`live:install REFUSED (${error.code}): ${error.message}`)
    process.exit(2)
  }
  console.error(`live:install FAILED: ${error.message}`)
  process.exit(1)
})
