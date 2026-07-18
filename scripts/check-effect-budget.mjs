// Effect-budget ratchet (useEffect elimination plan E7).
//
// Counts `useEffect(` occurrences per renderer source file and compares them
// against the checked-in budget. Any file EXCEEDING its budget — or a new
// file using useEffect without a budget entry — fails the gate: prefer an
// effect event (external events), a render-synced bridge (state → external
// sync), or moving the logic into the mutating handler (derived state).
// When a file drops below budget, the gate asks you to ratchet the budget
// down so the win is locked in. Run with --update to rewrite the budget from
// reality after intentional changes.
//
// Test files are exempt: effects inside tests exercise the real hooks.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

const ROOT = new URL('..', import.meta.url).pathname
const RENDERER_DIR = join(ROOT, 'apps/desktop/src/renderer/src')
const BUDGET_PATH = join(ROOT, 'scripts/effect-budget.json')

function sourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) {
      continue
    }
    files.push(path)
  }
  return files
}

function countEffects(path) {
  return (readFileSync(path, 'utf8').match(/useEffect\(/g) ?? []).length
}

const counts = {}
for (const file of sourceFiles(RENDERER_DIR)) {
  const count = countEffects(file)
  if (count > 0) {
    counts[relative(ROOT, file)] = count
  }
}

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BUDGET_PATH, `${JSON.stringify(sorted, null, 2)}\n`)
  console.log(`effect budget updated: ${Object.keys(sorted).length} files`)
  process.exit(0)
}

let budget
try {
  budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
} catch {
  console.error(
    `effect budget missing or unreadable at ${BUDGET_PATH}; run with --update to create it`
  )
  process.exit(1)
}

const failures = []
const improvements = []
for (const [file, count] of Object.entries(counts)) {
  const allowed = budget[file]
  if (allowed === undefined) {
    failures.push(`${file}: ${count} useEffect(s) in a file with no budget entry`)
  } else if (count > allowed) {
    failures.push(`${file}: ${count} useEffect(s), budget is ${allowed}`)
  } else if (count < allowed) {
    improvements.push(`${file}: ${count} < budget ${allowed}`)
  }
}
for (const file of Object.keys(budget)) {
  if (!(file in counts)) {
    improvements.push(`${file}: 0 < budget ${budget[file]} (file effect-free or removed)`)
  }
}

if (failures.length > 0) {
  console.error('effect budget FAIL — the useEffect count only goes DOWN:')
  for (const failure of failures) {
    console.error(`  ${failure}`)
  }
  console.error(
    'Use an effect event, a render-synced bridge, or the mutating handler; or lower another budget and run scripts/check-effect-budget.mjs --update with justification.'
  )
  process.exit(1)
}

if (improvements.length > 0) {
  console.error('effect budget FAIL — wins must be locked in (ratchet down):')
  for (const improvement of improvements) {
    console.error(`  ${improvement}`)
  }
  console.error('Run: node scripts/check-effect-budget.mjs --update')
  process.exit(1)
}

const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
console.log(`effect budget OK: ${total} useEffect(s) across ${Object.keys(counts).length} files`)
