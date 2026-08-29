#!/usr/bin/env node

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveMacosD3DestinationBindingFromRelease } from './lib/macos-d3-destination-binding-plan.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultReleaseDir = join(repoRoot, 'apps', 'desktop', 'release')

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const releaseDir = resolve(
    options.releaseDir ?? process.env.VIDEORC_RELEASE_DIR ?? defaultReleaseDir
  )
  const manifestPath = resolve(
    options.manifest ??
      process.env.VIDEORC_RELEASE_MANIFEST_PATH ??
      join(releaseDir, 'release.json')
  )
  const result = await deriveMacosD3DestinationBindingFromRelease({
    env: process.env,
    includeChangelog: options.includeChangelog,
    manifestPath,
    releaseDir
  })
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${result.destinationBinding.sha256}\n`)
  }
}

function parseArgs(args) {
  const options = { includeChangelog: true, json: false, manifest: null, releaseDir: null }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      options.json = true
      continue
    }
    if (argument === '--without-changelog') {
      options.includeChangelog = false
      continue
    }
    if (argument === '--manifest' || argument === '--release-dir') {
      const value = args[index + 1]?.trim()
      if (!value) throw new Error(`${argument} requires a path`)
      index += 1
      if (argument === '--manifest') options.manifest = value
      else options.releaseDir = value
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

main().catch((error) => {
  console.error(`macos-d3-destination-binding: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
