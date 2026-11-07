#!/usr/bin/env node
// pnpm clean:worktrees [--apply] [--idle-hours=N]
// Lists, and with --apply removes, worktrees whose work is already on main (a merged PR
// with exactly this HEAD, or a detached checkout of origin/main) together with their
// builds. Dry run by default. Rules: AGENTS.md "Cleanup After Merge".
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  statfsSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ACTIVITY_PATHS,
  GIT_ACTIVITY_FILES,
  decideWorktree,
  isInside,
  mergedPrFor,
  parseLsofCwds,
  parseWorktreeList,
  readProcCwds
} from './lib/worktree-cleanup.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const usage = 'Usage: pnpm clean:worktrees [--apply] [--idle-hours=N]  (default: dry run, 12h)'

let apply = false
let minIdleHours = 12
for (const arg of process.argv.slice(2)) {
  if (arg === '--') continue
  else if (arg === '--apply') apply = true
  else if (arg.startsWith('--idle-hours=')) {
    minIdleHours = Number(arg.slice('--idle-hours='.length))
    if (!Number.isFinite(minIdleHours) || minIdleHours < 0) throw new Error(`Invalid ${arg}`)
  } else if (arg === '--help' || arg === '-h') {
    console.log(usage)
    process.exit(0)
  } else throw new Error(`Unknown argument ${arg}\n${usage}`)
}
if (process.platform === 'win32') throw new Error('clean:worktrees runs on macOS and Linux.')

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  }).trim()
// --no-optional-locks: status must not rewrite a worktree's index and reset its idle clock.
const git = (cwd, ...args) => run('git', ['-C', cwd, '--no-optional-locks', ...args])
const tryGit = (...args) => {
  try {
    return git(...args)
  } catch {
    return null
  }
}
const tilde = (path) => (isInside(path, homedir()) ? `~${path.slice(homedir().length)}` : path)
const freeGb = () => {
  const { bavail, bsize } = statfsSync(repoRoot)
  return (bavail * bsize) / 1024 ** 3
}

const linuxProc = {
  readFile: (path) => readFileSync(path, 'utf8'),
  readdir: (path) => readdirSync(path),
  readlink: (path) => readlinkSync(path)
}

function processCwds() {
  if (process.platform === 'linux') return readProcCwds(linuxProc, process.pid)
  try {
    return parseLsofCwds(run('lsof', ['-nP', '-w', '-d', 'cwd', '-Fpcn']), process.pid)
  } catch (error) {
    // lsof exits 1 when it could not inspect some processes; its output is still complete
    // for this user's processes, which are the only ones that can hold a worktree.
    if (typeof error.stdout === 'string' && error.stdout) {
      return parseLsofCwds(error.stdout, process.pid)
    }
    throw new Error(`Cannot list process working directories with lsof: ${error.message}`)
  }
}
const usersOf = (path, cwds) => {
  const users = cwds.filter(({ cwd }) => isInside(cwd, path))
  const shown = users.slice(0, 3).map(({ command, pid }) => `${command} ${pid}`)
  return users.length > 3 ? [...shown, `${users.length - 3} more`] : shown
}

function lastActivityMs(path) {
  let gitDir = null
  try {
    gitDir = readFileSync(join(path, '.git'), 'utf8')
      .match(/^gitdir: (.+)$/m)?.[1]
      .trim()
  } catch {
    /* No .git file: only the build paths count. */
  }
  const paths = [
    ...(gitDir ? GIT_ACTIVITY_FILES.map((file) => resolve(path, gitDir, file)) : []),
    ...ACTIVITY_PATHS.map((relative) => join(path, relative))
  ]
  let latest = 0
  for (const candidate of paths) {
    try {
      latest = Math.max(latest, statSync(candidate).mtimeMs)
    } catch {
      /* Missing path: no activity there. */
    }
  }
  return latest
}

try {
  git(repoRoot, 'fetch', '--quiet', 'origin', 'main')
} catch (error) {
  // A stale origin/main only makes fewer detached checkouts look finished.
  console.warn(
    `warning: git fetch origin main failed, using the local origin/main: ${error.message}`
  )
}
let mergedPrs
try {
  mergedPrs = JSON.parse(
    run(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--limit',
        '5000',
        '--json',
        'number,headRefName,headRefOid'
      ],
      { cwd: repoRoot }
    )
  )
} catch (error) {
  throw new Error(`gh pr list failed (is gh signed in?): ${error.stderr || error.message}`)
}

const worktrees = parseWorktreeList(git(repoRoot, 'worktree', 'list', '--porcelain'))
const here = realpathSync(process.cwd())
const self = realpathSync(repoRoot)
// False when either commit is missing locally: unknown never counts as merged.
const isAncestor = (commit, of) =>
  tryGit(repoRoot, 'merge-base', '--is-ancestor', commit, of) !== null
const cwds = processCwds()
const now = Date.now()
const plan = worktrees.map((worktree, index) => {
  const exists = existsSync(worktree.path)
  const path = exists ? realpathSync(worktree.path) : worktree.path
  const facts = {
    worktree,
    isMain: index === 0,
    isCurrent: path === self || isInside(here, path),
    exists,
    users: exists ? usersOf(path, cwds) : [],
    merged: mergedPrFor(worktree, mergedPrs, isAncestor),
    onMain: !worktree.branch && Boolean(worktree.head) && isAncestor(worktree.head, 'origin/main'),
    // A status git cannot read counts as dirty: keep what we cannot inspect.
    dirty: exists && tryGit(path, 'status', '--porcelain', '--untracked-files=normal') !== '',
    idleHours: exists ? (now - lastActivityMs(path)) / 3_600_000 : Infinity
  }
  return { worktree, path, decision: decideWorktree(facts, { minIdleHours }) }
})

const order = { remove: 0, prune: 1, keep: 2 }
plan.sort((a, b) => order[a.decision.action] - order[b.decision.action])
for (const { path, worktree, decision } of plan) {
  const label = worktree.branch ?? `detached ${worktree.head?.slice(0, 9)}`
  console.log(
    `${decision.action.toUpperCase().padEnd(7)}${tilde(path)}  [${label}]  ${decision.reason}`
  )
}
const removals = plan.filter(({ decision }) => decision.action === 'remove')
const prunes = plan.filter(({ decision }) => decision.action === 'prune')
const freeBefore = freeGb()
console.log(
  `\n${removals.length} to remove, ${prunes.length} to prune, ${plan.length - removals.length - prunes.length} kept. ${freeBefore.toFixed(1)} GB free.`
)
if (!apply) {
  console.log('Dry run: nothing removed. Re-run with --apply to remove them.')
  process.exit(0)
}

let failures = 0
for (const { worktree, path, decision } of removals) {
  // Re-check right before deleting: a session may have started in it since the scan.
  const users = usersOf(path, processCwds())
  if (users.length > 0) {
    console.log(`kept    ${tilde(path)}: in use by ${users.join(', ')}`)
    continue
  }
  try {
    // No --force: git refuses a worktree that gained changes since the scan.
    git(repoRoot, 'worktree', 'remove', path)
  } catch (error) {
    failures += 1
    console.log(`FAILED  ${tilde(path)}: ${(error.stderr || error.message).trim()}`)
    continue
  }
  // Delete the local branch only while it still points at the merged head.
  if (
    worktree.branch &&
    tryGit(repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`) ===
      worktree.head
  ) {
    git(repoRoot, 'branch', '-D', worktree.branch)
  }
  console.log(`removed ${tilde(path)} (${decision.reason})`)
}
git(repoRoot, 'worktree', 'prune')
const freeAfter = freeGb()
console.log(
  `\nFreed ${(freeAfter - freeBefore).toFixed(1)} GB (${freeBefore.toFixed(1)} -> ${freeAfter.toFixed(1)} GB free).`
)
if (failures > 0) {
  console.error(`${failures} worktree(s) could not be removed; see FAILED lines above.`)
  process.exit(1)
}
