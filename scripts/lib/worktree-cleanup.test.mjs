import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideWorktree,
  isInside,
  mergedPrFor,
  parseLsofCwds,
  parseWorktreeList
} from './worktree-cleanup.mjs'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const branchTree = { path: '/wt/feature', head: HEAD, branch: 'fix/thing', locked: false }
const detachedTree = { path: '/wt/test-run', head: HEAD, branch: null, locked: false }
const finished = (worktree, overrides = {}) => ({
  worktree: { prunable: false, ...worktree },
  isMain: false,
  isCurrent: false,
  exists: true,
  users: [],
  merged: mergedPrFor(worktree, [{ number: 1150, headRefName: 'fix/thing', headRefOid: HEAD }]),
  onMain: true,
  dirty: false,
  idleHours: 48,
  ...overrides
})
const decide = (facts) => decideWorktree(facts, { minIdleHours: 12 })

test('parseWorktreeList reads branch, detached, locked and prunable entries', () => {
  const porcelain = [
    'worktree /repo',
    `HEAD ${HEAD}`,
    'branch refs/heads/main',
    '',
    'worktree /wt/a',
    `HEAD ${OTHER}`,
    'detached',
    'locked still testing',
    '',
    'worktree /wt/gone',
    `HEAD ${HEAD}`,
    'branch refs/heads/fix/gone',
    'prunable gitdir file points to non-existent location',
    ''
  ].join('\n')
  assert.deepEqual(parseWorktreeList(porcelain), [
    { path: '/repo', head: HEAD, branch: 'main', locked: false, prunable: false },
    { path: '/wt/a', head: OTHER, branch: null, locked: true, prunable: false },
    { path: '/wt/gone', head: HEAD, branch: 'fix/gone', locked: false, prunable: true }
  ])
})

test('isInside matches the directory and its children, not a sibling with the same prefix', () => {
  assert.equal(isInside('/p/videorc-wt-205', '/p/videorc-wt-205'), true)
  assert.equal(isInside('/p/videorc-wt-205/apps/desktop', '/p/videorc-wt-205'), true)
  assert.equal(isInside('/p/videorc-wt-205b', '/p/videorc-wt-205'), false)
})

test('parseLsofCwds pairs each cwd with its process and drops the caller', () => {
  const output = [
    'p10',
    'cnode',
    'n/wt/feature',
    'p11',
    'czsh',
    'n/repo',
    'p12',
    'cnode',
    'n/x'
  ].join('\n')
  assert.deepEqual(parseLsofCwds(output, 12), [
    { pid: 10, command: 'node', cwd: '/wt/feature' },
    { pid: 11, command: 'zsh', cwd: '/repo' }
  ])
})

test('a branch is done only when its HEAD is a merged PR head or behind one', () => {
  const prs = [
    { number: 900, headRefName: 'fix/thing', headRefOid: OTHER },
    { number: 1150, headRefName: 'fix/thing', headRefOid: HEAD },
    { number: 1151, headRefName: 'fix/other', headRefOid: HEAD }
  ]
  const ahead = { ...branchTree, head: 'c'.repeat(40) }
  assert.equal(mergedPrFor(branchTree, prs).pr.number, 1150)
  assert.equal(mergedPrFor(ahead, prs).pr, null)
  assert.equal(mergedPrFor(ahead, prs).sameBranch.number, 1150)
  const behindPr900 = (commit, of) => commit === ahead.head && of === OTHER
  assert.equal(mergedPrFor(ahead, prs, behindPr900).pr.number, 900)
  assert.deepEqual(mergedPrFor(detachedTree, prs), { pr: null, sameBranch: null })
})

test('removes a clean, idle worktree whose PR merged with this HEAD', () => {
  assert.deepEqual(decide(finished(branchTree)), { action: 'remove', reason: 'PR #1150 merged' })
})

test('removes a clean, idle detached checkout of origin/main', () => {
  assert.deepEqual(decide(finished(detachedTree)), {
    action: 'remove',
    reason: 'detached checkout already on origin/main'
  })
})

test('keeps branches whose work never reached main', () => {
  const unpushed = { ...branchTree, head: 'c'.repeat(40) }
  assert.match(
    decide(
      finished(unpushed, {
        merged: mergedPrFor(unpushed, [{ number: 7, headRefName: 'fix/thing', headRefOid: HEAD }])
      })
    ).reason,
    /not the head of merged PR #7/
  )
  assert.equal(
    decide(finished(branchTree, { merged: { pr: null, sameBranch: null } })).reason,
    'no merged PR for this branch'
  )
  assert.equal(
    decide(finished(detachedTree, { onMain: false })).reason,
    'detached HEAD has commits not on origin/main'
  )
})

test('keeps anything dirty, recent, locked, in use or current, and never the main checkout', () => {
  assert.equal(decide(finished(branchTree, { dirty: true })).action, 'keep')
  assert.match(decide(finished(branchTree, { idleHours: 2 })).reason, /touched 2\.0h ago/)
  assert.equal(
    decide(finished({ ...branchTree, locked: true })).reason,
    'locked (git worktree lock)'
  )
  assert.equal(
    decide(finished(branchTree, { users: ['cargo 4242'] })).reason,
    'in use by cargo 4242'
  )
  assert.equal(decide(finished(branchTree, { isCurrent: true })).reason, 'this command runs in it')
  assert.equal(decide(finished(branchTree, { isMain: true })).reason, 'main checkout')
})

test('a worktree whose directory is gone is only pruned', () => {
  assert.equal(decide(finished(branchTree, { exists: false })).action, 'prune')
})
