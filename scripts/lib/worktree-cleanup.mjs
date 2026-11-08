// Which worktrees are finished and safe to remove (pnpm clean:worktrees, AGENTS.md
// "Cleanup After Merge"). Pure helpers: scripts/clean-worktrees.mjs gathers the facts.

// Paths whose mtime counts as activity: git operations, Rust builds, smoke evidence.
export const ACTIVITY_PATHS = [
  'target/debug',
  'target/debug/deps',
  'target/release/deps',
  'apps/desktop/out',
  'docs/acceptance/artifacts'
]
export const GIT_ACTIVITY_FILES = ['HEAD', 'index', 'logs/HEAD']

export function parseWorktreeList(porcelain) {
  const worktrees = []
  let current = null
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      const path = line.slice('worktree '.length)
      current = { path, head: null, branch: null, locked: false, prunable: false }
      worktrees.push(current)
    } else if (!current) {
      continue
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length)
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true
    }
  }
  return worktrees
}

export const isInside = (dir, root) => dir === root || dir.startsWith(`${root.replace(/\/$/, '')}/`)

// `lsof -d cwd -Fpcn` output -> [{ pid, command, cwd }], without this process itself.
export function parseLsofCwds(output, selfPid) {
  const cwds = []
  let pid = null
  let command = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('c')) command = line.slice(1)
    else if (line.startsWith('n') && pid !== selfPid)
      cwds.push({ pid, command, cwd: line.slice(1) })
  }
  return cwds
}

// Linux reads /proc instead, because Arch and minimal images do not ship lsof. Same
// result as parseLsofCwds. A process this user may not inspect (EACCES), like those lsof
// -w skips, or one gone since the listing (ENOENT, ESRCH) is left out.
const SKIPPED_PROC_ERRORS = new Set(['EACCES', 'ENOENT', 'ESRCH'])
export function readProcCwds(proc, selfPid) {
  const cwds = []
  for (const entry of proc.readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === selfPid) continue
    try {
      const cwd = proc.readlink(`/proc/${entry}/cwd`)
      const command = proc.readFile(`/proc/${entry}/comm`).trim()
      cwds.push({ pid: Number(entry), command, cwd })
    } catch (error) {
      if (!SKIPPED_PROC_ERRORS.has(error?.code)) throw error
    }
  }
  return cwds
}

// Squash merges leave a branch unreachable from main, so `git branch --merged` cannot tell.
// A branch is done only when the local HEAD is a merged PR's head or behind it: anything
// else means local commits that never reached main.
export function mergedPrFor(worktree, mergedPrs, isAncestor = () => false) {
  if (!worktree.branch || !worktree.head) return { pr: null, sameBranch: null }
  const sameBranch = mergedPrs
    .filter((pr) => pr.headRefName === worktree.branch)
    .sort((a, b) => b.number - a.number)
  const pr =
    sameBranch.find((candidate) => candidate.headRefOid === worktree.head) ??
    sameBranch.find((candidate) => isAncestor(worktree.head, candidate.headRefOid)) ??
    null
  return { pr, sameBranch: sameBranch[0] ?? null }
}

const keep = (reason) => ({ action: 'keep', reason })

// facts: { worktree, isMain, isCurrent, exists, users, merged, onMain, dirty, idleHours }
export function decideWorktree(facts, { minIdleHours }) {
  const { worktree, merged } = facts
  if (facts.isMain) return keep('main checkout')
  if (!facts.exists || worktree.prunable) {
    return { action: 'prune', reason: 'directory already gone' }
  }
  if (worktree.locked) return keep('locked (git worktree lock)')
  if (facts.isCurrent) return keep('this command runs in it')
  if (facts.users.length > 0) return keep(`in use by ${facts.users.join(', ')}`)

  let done
  if (worktree.branch) {
    if (merged.pr) done = `PR #${merged.pr.number} merged`
    else if (merged.sameBranch) {
      return keep(`HEAD is not the head of merged PR #${merged.sameBranch.number}`)
    } else return keep('no merged PR for this branch')
  } else if (facts.onMain) {
    done = 'detached checkout already on origin/main'
  } else {
    return keep('detached HEAD has commits not on origin/main')
  }

  if (facts.dirty) return keep('uncommitted or untracked files')
  if (facts.idleHours < minIdleHours) {
    return keep(`touched ${facts.idleHours.toFixed(1)}h ago (under ${minIdleHours}h)`)
  }
  return { action: 'remove', reason: done }
}
