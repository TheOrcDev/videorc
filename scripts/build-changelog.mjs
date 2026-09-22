#!/usr/bin/env node
// Compiles changelog/*.md into the published changelog.json.
//
//   node scripts/build-changelog.mjs                # validate + write dist/changelog/changelog.json
//   node scripts/build-changelog.mjs --check        # validate only, write nothing
//   node scripts/build-changelog.mjs --out <path>   # custom output path
//
// The JSON is uploaded to every release storage origin next to the update feed
// during the release flow and consumed by videorc-web (/changelog,
// /releases/<version>) and the desktop "What's new" panel. See
// changelog/README.md for the entry format.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { buildChangelogJson, loadChangelogEntries } from './lib/changelog.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const outIndex = args.indexOf('--out')
  const outPath = outIndex !== -1
    ? resolve(args[outIndex + 1] ?? '')
    : join(repoRoot, 'dist', 'changelog', 'changelog.json')

  const entries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  console.log(`changelog: ${entries.length} entries valid (latest ${entries[0].version})`)

  if (checkOnly) {
    return
  }

  const document = buildChangelogJson(entries, { generatedAt: new Date().toISOString() })
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`)
  console.log(`changelog: wrote ${outPath}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
