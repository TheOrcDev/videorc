#!/usr/bin/env node
// Plan 242 S20: the pre-push hook. Runs format, lint and typecheck on the files
// this push changes, the same checks CI runs, in a few seconds. A hook, not a
// line in AGENTS.md, because agents skip steps. Fails closed: a check that
// cannot run blocks the push. `git push --no-verify` skips it.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatCheckGlobs, prePushPlan, pushRanges } from './lib/pre-push-check.mjs'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const started = Date.now()

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(`pre-push: ${message}`)
  console.error('pre-push: fix it and push again, or skip once with `git push --no-verify`.')
  process.exit(1)
}

if (!existsSync(join(root, 'node_modules/.bin/oxlint'))) {
  fail('dependencies are missing (no node_modules/.bin/oxlint). Run `pnpm install`.')
}

let fallbackBase = ''
try {
  fallbackBase = git(['merge-base', 'HEAD', 'origin/main'])
} catch {
  // No origin/main here: a new branch is then checked against nothing older.
}

const ranges = pushRanges(readFileSync(0, 'utf8'), fallbackBase)
const changed = new Set()
for (const { base, head } of ranges) {
  try {
    const out = git(['diff', '--name-only', '--diff-filter=ACMR', '-z', `${base}...${head}`])
    for (const file of out.split('\0').filter(Boolean)) changed.add(file)
  } catch {
    fail(`could not diff ${base.slice(0, 9)}...${head.slice(0, 9)}; fetch and retry.`)
  }
}
// A file deleted later in the same push is gone from the work tree.
const present = [...changed].filter((file) => existsSync(join(root, file)))

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const formatScope = new Set()
for (const pattern of formatCheckGlobs(pkg.scripts['format:check'])) {
  for (const file of globSync(pattern, { cwd: root })) formatScope.add(file)
}
const plan = prePushPlan(present, formatScope)

// The checks run side by side; a check's output prints only when it fails.
function run(label, command, args, cwd = root) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: process.platform === 'win32' })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', (error) => resolve({ label, ok: false, output: String(error) }))
    child.on('close', (code) => resolve({ label, ok: code === 0, output }))
  })
}

const bin = (name) => join(root, 'node_modules/.bin', name)
const desktop = join(root, 'apps/desktop')
const tsc = join(desktop, 'node_modules/typescript-native/bin/tsc')
const checks = [run('em dashes', process.execPath, [join(root, 'scripts/check-em-dashes.mjs')])]
if (plan.format.length) checks.push(run('format', bin('prettier'), ['--check', ...plan.format]))
if (plan.lint.length) checks.push(run('lint', bin('oxlint'), plan.lint))
if (plan.typecheck) {
  // `pnpm typecheck`, without pnpm's startup.
  for (const project of ['tsconfig.node.json', 'tsconfig.web.json']) {
    checks.push(
      run(`typecheck (${project})`, process.execPath, [tsc, '--noEmit', '-p', project], desktop)
    )
  }
}
const failed = (await Promise.all(checks)).filter((check) => !check.ok)
for (const check of failed) {
  console.error(`\npre-push: ${check.label}:\n${check.output.trim()}`)
}
if (failed.length) fail(`${failed.map((check) => check.label).join(', ')} failed.`)

console.log(
  `pre-push: ${present.length} changed files; format ${plan.format.length}, lint ${plan.lint.length}, typecheck ${plan.typecheck ? 'yes' : 'no'} (${((Date.now() - started) / 1000).toFixed(1)} s)`
)
