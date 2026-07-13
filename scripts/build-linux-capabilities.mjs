#!/usr/bin/env node
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { buildLinuxCapabilities, readRuntimeCapabilities } from './lib/linux-capabilities.mjs'

const artifactPath = process.argv[2]
let outputPath = process.argv[3]

if (!artifactPath) {
  console.error('Usage: node scripts/build-linux-capabilities.mjs <artifactPath> [outputPath] [runtimeCapabilitiesPath]')
  process.exit(1)
}

if (!outputPath) {
  outputPath = resolve('apps/desktop/release/linux-capabilities.json')
}

const runtimeCapabilitiesPath = process.argv[4]

let runtimeCapabilities = {}
if (runtimeCapabilitiesPath) {
  runtimeCapabilities = (await readRuntimeCapabilities(runtimeCapabilitiesPath)) || {}
}

const buildInfo = await (async () => {
  try {
    const desktopPackage = JSON.parse(readFileSync(resolve('apps/desktop/package.json'), 'utf8'))
    const rootPackage = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    return {
      ...runtimeCapabilities,
      repositoryVersion: rootPackage.version,
      rootVersion: rootPackage.version,
      selected: runtimeCapabilities.selected ?? {},
      policy: runtimeCapabilities.policy ?? runtimeCapabilities.fallbackPolicy,
      requestedMode: runtimeCapabilities.requestedMode,
      notes: runtimeCapabilities.notes,
      packageVersion: desktopPackage.version
    }
  } catch {
    return runtimeCapabilities
  }
})
()

const payload = buildLinuxCapabilities({
  artifactPath: resolve(artifactPath),
  runtimeCapabilities: {
    ...buildInfo,
    repositoryVersion: buildInfo.repositoryVersion ?? null,
    rootVersion: buildInfo.rootVersion ?? null
  }
})

await mkdir(dirname(resolve(process.cwd(), outputPath)), { recursive: true })
const outDir = resolve(process.cwd(), outputPath)
await writeFile(outDir, JSON.stringify(payload, null, 2) + '\n', 'utf8')

const shaPath = `${outDir}.sha256`
try {
  const binary = readFileSync(artifactPath)
  const { createHash } = await import('node:crypto')
  const checksum = createHash('sha256')
  checksum.update(binary)
  await writeFile(shaPath, `${checksum.digest('hex')}  ${artifactPath}\\n`, 'utf8')
} catch {
  // Optional checksum file. Build pipelines treat this as informational.
}

console.log(`linux-capabilities: wrote ${outDir}`)
