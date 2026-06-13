#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { validateSupportBundle } from './lib/support-bundle-verifier.mjs'

function parseArgs(argv) {
  const args = { json: false }
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--json':
        args.json = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`)
        }
        positionals.push(arg)
    }
  }
  args.file = positionals[0]
  return args
}

const HELP = `Verify a Videorc support bundle JSON file.

Usage: node scripts/verify-support-bundle.mjs <bundle.json> [--json]

Exits 0 when required sections exist and sensitive values are redacted.`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.file) {
    console.log(HELP)
    process.exit(args.file ? 0 : 2)
  }

  const text = await readFile(args.file, 'utf8')
  const bundle = JSON.parse(text)
  const result = validateSupportBundle(bundle)

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.ok) {
    console.log(`Support bundle OK: ${args.file}`)
    if (result.warnings.length) {
      console.log(`Warnings: ${result.warnings.join('; ')}`)
    }
  } else {
    console.error(`Support bundle failed verification: ${args.file}`)
    for (const failure of result.failures) {
      console.error(`- ${failure}`)
    }
  }

  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
