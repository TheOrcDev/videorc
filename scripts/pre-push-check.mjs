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

// Every tool runs as `node <script>` without a shell, so a Node or repo path
// with spaces (C:\Program Files\nodejs) needs no quoting on Windows.
const desktop = join(root, 'apps/desktop')
const tools = {
  prettier: join(root, 'node_modules/prettier/bin/prettier.cjs'),
  oxlint: join(root, 'node_modules/oxlint/bin/oxlint'),
  tsc: join(desktop, 'node_modules/typescript-native/bin/tsc')
}
for (const [name, path] of Object.entries(tools)) {
  if (!existsSync(path)) fail(`dependencies are missing (no ${name}). Run \`pnpm install\`.`)
}

let fallbackBase = ''
try {
  fallbackBase = git(['merge-base', 'HEAD', 'origin/main'])
} catch {
  // No origin/main here: a new branch is then checked against nothing older.
}

const ranges = pushRanges(readFileSync(0, 'utf8'), fallbackBase)
// The checks read this checkout's files, so they must be the pushed ones: the
// pushed branch is checked out here, and the files it touches are committed.
const headSha = git(['rev-parse', 'HEAD'])
for (const { ref, head } of ranges) {
  if (head !== headSha) {
    fail(
      `${ref} is at ${head.slice(0, 9)} but this checkout is at ${headSha.slice(0, 9)}; push it from its own checkout so the hook checks what you push.`
    )
  }
}
const changed = new Set()
for (const { base, head } of ranges) {
  try {
    const out = git(['diff', '--name-only', '-z', `${base}...${head}`])
    for (const file of out.split('\0').filter(Boolean)) changed.add(file)
  } catch {
    fail(`could not diff ${base.slice(0, 9)}...${head.slice(0, 9)}; fetch and retry.`)
  }
}
if (changed.size) {
  const dirty = execFileSync('git', ['status', '--porcelain', '-z', '--', ...changed], {
    cwd: root,
    encoding: 'utf8'
  })
    .split('\0')
    .filter(Boolean)
  if (dirty.length) {
    fail(
      `uncommitted changes in files this push touches (${dirty.length}); commit or stash them so the hook checks what you push.`
    )
  }
}
// Deleted files stay in `changed` (they decide the typecheck) but have no
// contents to format or lint.
const present = [...changed].filter((file) => existsSync(join(root, file)))

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const formatScope = new Set()
for (const pattern of formatCheckGlobs(pkg.scripts['format:check'])) {
  for (const file of globSync(pattern, { cwd: root })) formatScope.add(file)
}
const plan = prePushPlan([...changed], present, formatScope)

// The checks run side by side; a check's output prints only when it fails.
function run(label, command, args, cwd = root) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', (error) => resolve({ label, ok: false, output: String(error) }))
    child.on('close', (code) => resolve({ label, ok: code === 0, output }))
  })
}

const node = process.execPath
const checks = [run('em dashes', node, [join(root, 'scripts/check-em-dashes.mjs')])]
if (plan.format.length)
  checks.push(run('format', node, [tools.prettier, '--check', ...plan.format]))
if (plan.lint.length) checks.push(run('lint', node, [tools.oxlint, ...plan.lint]))
if (plan.typecheck) {
  // `pnpm typecheck`, without pnpm's startup.
  for (const project of ['tsconfig.node.json', 'tsconfig.web.json']) {
    checks.push(
      run(`typecheck (${project})`, node, [tools.tsc, '--noEmit', '-p', project], desktop)
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
