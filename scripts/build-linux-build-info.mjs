#!/usr/bin/env node
import { resolve } from 'node:path'
import { writeLinuxBuildInfo } from './lib/linux-build-info.mjs'

const artifactPath = process.argv[2]
const outputPath = resolve(process.argv[3] || 'apps/desktop/release/linux-build-info.json')

if (!artifactPath) {
  console.error('Usage: node scripts/build-linux-build-info.mjs <artifactPath> [outputPath]')
  process.exit(1)
}

await writeLinuxBuildInfo({ artifactPath: resolve(artifactPath), outputPath })
