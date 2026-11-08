#!/usr/bin/env node

// Plan 178 U5 / plan 179: put the build under test on the lab machine.
//
// macOS:
//   pnpm live:install --build release
//   pnpm live:install --build candidate:<run-id|sha>
//   pnpm live:install --rollback
// Linux:
//   pnpm live:install --build file:<AppImage> [--sha256 <hex>]
//   pnpm live:install --build local:<dir>
//   pnpm live:install --build release   (refused while latest-linux.yml is not public)
//   pnpm live:install --rollback
//
// Options: --app-path <path> (default /Applications/Videorc.app on macOS,
// ~/.local/share/videorc-lab/Videorc on Linux), --repo <owner/name> (default
// TheOrcDev/videorc), --feed-url <url> (default the app's own update feed),
// --sha256 <hex> (file: only), --json (print the install record), --help.
//
// macOS installs only a Videorc.app signed with the Videorc Developer ID
// (team C2PA37RB58); a release must also pass Gatekeeper. Linux builds are
// unsigned: an AppImage installs only when its sha512/sha256 matched, and a
// local: build is recorded as source local-build. The record lands in
// <lab dir>/install.json.

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { labDir } from './lib/config.mjs'
import { defaultAppPath, installBuild, rollbackInstall } from './lib/install-flow.mjs'
import { InstallRefusal, createRunner } from './lib/install-runner.mjs'
import { DEFAULT_REPO, RELEASE_FEED_URL, parseBuildSpec } from './lib/install-sources.mjs'
import { LINUX, MACOS, requireLabPlatform } from './lib/platform.mjs'

const USAGE = {
  [MACOS]: `pnpm live:install --build release                 the public macOS feed (latest-mac.yml)
pnpm live:install --build candidate:<run-id|sha>  a lab-candidate-macos.yml artifact
pnpm live:install --rollback                      swap back to the app it replaced

Options: --app-path <path> (default ${defaultAppPath('darwin')}),
--repo <owner/name> (default ${DEFAULT_REPO}), --feed-url <url> (default the
app's own update feed), --json (print the install record).

Only a Videorc.app signed with the Videorc Developer ID (team C2PA37RB58)
installs; a release must also pass Gatekeeper.`,
  [LINUX]: `pnpm live:install --build file:<AppImage> [--sha256 <hex>]
    an AppImage you downloaded; its sha256 comes from --sha256, else
    <AppImage>.sha256, else release.json next to it
pnpm live:install --build local:<dir>
    an unpacked build from this machine (apps/desktop/release/linux-unpacked);
    no hash exists, so it is recorded as source local-build
pnpm live:install --build release
    latest-linux.yml (refused while the Linux Alpha feed is not public)
pnpm live:install --rollback
    swap back to the build it replaced

Options: --app-path <dir> (default ${defaultAppPath('linux')}),
--feed-url <url>, --json (print the install record).

The AppImage is extracted (no FUSE) into the install dir after its hash
matched; the harness runs <app-path>/videorc.`
}

async function main() {
  const lab = requireLabPlatform(process.platform, 'live:install')
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      build: { type: 'string' },
      rollback: { type: 'boolean', default: false },
      'app-path': { type: 'string' },
      repo: { type: 'string', default: DEFAULT_REPO },
      'feed-url': { type: 'string', default: RELEASE_FEED_URL },
      sha256: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help) {
    console.log(USAGE[lab])
    return
  }
  if (values.rollback === Boolean(values.build)) {
    throw new Error(
      lab === LINUX
        ? 'Pass exactly one of --build <file:<AppImage>|local:<dir>|release> or --rollback.'
        : 'Pass exactly one of --build <release|candidate:<run-id|sha>> or --rollback.'
    )
  }
  const appPath = resolve(values['app-path'] ?? defaultAppPath())
  if (lab === MACOS && !appPath.endsWith('.app')) {
    throw new Error('--app-path must end in .app.')
  }
  const spec = values.build ? parseBuildSpec(values.build) : null
  if (values.sha256 !== undefined && spec?.kind !== 'file') {
    throw new Error('--sha256 goes with --build file:<AppImage> only.')
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
        spec,
        repo: values.repo,
        feedUrl: values['feed-url'],
        sha256: values.sha256 ?? null
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
