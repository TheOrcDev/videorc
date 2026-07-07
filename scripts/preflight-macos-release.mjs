#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluateMacosReleasePreflight,
  formatMacosReleasePreflightReport
} from './lib/macos-release-preflight.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const releaseDir = join(repoRoot, 'apps', 'desktop', 'release')
  const tools = {
    codesign: commandExists('codesign'),
    spctl: commandExists('spctl'),
    notarytool: xcrunToolExists('notarytool'),
    stapler: xcrunToolExists('stapler')
  }
  const paths = {
    macEntitlements: existsSync(
      join(repoRoot, 'apps', 'desktop', 'build-resources', 'entitlements.mac.plist')
    ),
    releaseOutputDir: await canWriteDirectory(releaseDir)
  }
  const signing = {
    keychainIdentity: hasDeveloperIdIdentity()
  }

  const result = evaluateMacosReleasePreflight({
    platform: process.platform,
    env: process.env,
    tools,
    paths,
    signing
  })

  const report = formatMacosReleasePreflightReport(result)
  if (result.ok) {
    console.log(report)
    process.exit(0)
  }

  console.error(report)
  process.exit(1)
}

function commandExists(command) {
  const result = spawnSync(
    '/bin/sh',
    ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`],
    {
      stdio: 'ignore'
    }
  )
  return result.status === 0
}

function xcrunToolExists(tool) {
  const result = spawnSync('xcrun', ['--find', tool], { stdio: 'ignore' })
  return result.status === 0
}

// True when the keychain holds a "Developer ID Application" codesigning
// identity — the primary signing path electron-builder auto-detects. Output is
// inspected but never logged (identity hashes are not printed).
function hasDeveloperIdIdentity() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return false
  }
  return /Developer ID Application:/.test(result.stdout)
}

async function canWriteDirectory(directory) {
  const probePath = join(directory, '.videorc-release-preflight.tmp')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(probePath, 'ok\n', { flag: 'w' })
    await rm(probePath, { force: true })
    return true
  } catch {
    await rm(probePath, { force: true }).catch(() => {})
    return false
  }
}

main().catch((error) => {
  console.error(`macos-release-preflight: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
