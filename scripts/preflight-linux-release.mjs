#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findChangelogEntry, loadChangelogEntries } from './lib/changelog.mjs'
import {
  evaluateLinuxReleasePreflight,
  formatLinuxReleasePreflightReport
} from './lib/linux-release-preflight.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const packageJson = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8')
  )
  const releaseId = process.env.VIDEORC_RELEASE_ID?.trim() ?? ''
  const changelogEntries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  const changelogEntry = findChangelogEntry(changelogEntries, releaseId)
  const result = evaluateLinuxReleasePreflight({
    arch: process.arch,
    changelogEntrySupportsLinux: changelogEntry?.platforms?.includes('linux') ?? false,
    env: process.env,
    gitClean: isGitClean(),
    packageVersion: packageJson.version,
    paths: {
      ffmpegPin: existsSync(join(repoRoot, 'vendor', 'ffmpeg', 'linux-pin.json')),
      ffmpegPolicy: existsSync(join(repoRoot, 'vendor', 'ffmpeg', 'README.md')),
      icon: existsSync(join(repoRoot, 'apps', 'desktop', 'build-resources', 'icon.icns')),
      releaseOutputDir: await canWriteDirectory(join(repoRoot, 'apps', 'desktop', 'release'))
    },
    platform: process.platform,
    tools: {
      cargo: commandExists('cargo'),
      git: commandExists('git'),
      pnpm: commandExists('pnpm')
    }
  })

  const report = formatLinuxReleasePreflightReport(result)
  if (result.ok) {
    console.log(report)
    return
  }
  console.error(report)
  process.exitCode = 1
}

function commandExists(command) {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0
}

function isGitClean() {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  return result.status === 0 && result.stdout.trim().length === 0
}

async function canWriteDirectory(directory) {
  const probe = join(directory, '.videorc-linux-release-preflight.tmp')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(probe, 'ok\n')
    await rm(probe, { force: true })
    return true
  } catch {
    await rm(probe, { force: true }).catch(() => {})
    return false
  }
}

main().catch((error) => {
  console.error(`linux-release-preflight: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
