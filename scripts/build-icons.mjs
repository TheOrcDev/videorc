#!/usr/bin/env node
// Builds the app's icon components from a licensed SVG export.
//
//   pnpm icons:build [--source vendor/icons] [--out apps/desktop/src/renderer/src/components/icons.generated.tsx]
//
// The source folder holds one SVG per icon, named after the component
// (alert-circle.svg -> AlertCircle). Nothing else in the repo reads that
// folder, so a licence that forbids committing the SVGs can keep it local
// (see docs/icon-set.md) while the generated module is what ships.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { buildIconModule } from './lib/icon-build.mjs'

// Nucleo's open-source allowance is 100 icons. The build refuses to exceed it
// rather than leaving the count to whoever last added a glyph — a licence
// limit nobody checks is a licence limit you break.
const LICENCE_ICON_LIMIT = Number(process.env.VIDEORC_ICON_LIMIT ?? 100)

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const repoRoot = resolve(import.meta.dirname, '..')
const sourceDir = resolve(repoRoot, flag('source', 'vendor/icons'))
const outFile = resolve(
  repoRoot,
  flag('out', 'apps/desktop/src/renderer/src/components/icons.generated.tsx')
)

if (!existsSync(sourceDir)) {
  console.error(
    `icons: no export folder at ${sourceDir}\n` +
      'Export the licensed set as individual SVGs into that folder first — see docs/icon-set.md.'
  )
  process.exit(1)
}

const files = readdirSync(sourceDir)
  .filter((name) => name.toLowerCase().endsWith('.svg'))
  .sort()
  .map((name) => ({ name, contents: readFileSync(join(sourceDir, name), 'utf8') }))

if (files.length === 0) {
  console.error(`icons: ${sourceDir} contains no .svg files`)
  process.exit(1)
}
if (files.length > LICENCE_ICON_LIMIT) {
  console.error(
    `icons: ${files.length} icons exceeds the ${LICENCE_ICON_LIMIT}-icon licence allowance.\n` +
      'Consolidate duplicate meanings in components/icons.tsx before adding more.'
  )
  process.exit(1)
}

let module
try {
  module = buildIconModule(files)
} catch (error) {
  console.error(`icons: ${error.message}`)
  process.exit(1)
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, module)
console.log(
  `icons: built ${files.length} component(s) -> ${outFile.replace(`${repoRoot}/`, '')} ` +
    `(${LICENCE_ICON_LIMIT - files.length} under the licence allowance)`
)
