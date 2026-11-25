import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { load } from 'js-yaml'
import { cancelObsoletePullRequestRuns, obsoletePullRequestRun } from './ci-run-cleanup.mjs'

const pull = {
  number: 42,
  state: 'open',
  head: { ref: 'feature', sha: 'current', repo: { id: 7 } }
}
const run = {
  id: 100,
  status: 'queued',
  event: 'pull_request',
  path: '.github/workflows/windows.yml',
  head_branch: 'feature',
  head_sha: 'old',
  head_repository: { id: 7 },
  pull_requests: [{ number: 42 }]
}

test('stale heads and closed PRs are retired, including detached PR associations', () => {
  assert.equal(obsoletePullRequestRun(run, pull), true)
  assert.equal(obsoletePullRequestRun({ ...run, head_sha: 'current' }, pull), false)
  assert.equal(
    obsoletePullRequestRun(
      { ...run, head_sha: 'current', pull_requests: [] },
      { ...pull, state: 'closed' }
    ),
    true
  )
})

test('release workflows, dispatches, tags, forks and unrelated PRs are never retired', () => {
  for (const changed of [
    { path: '.github/workflows/release-windows-alpha.yml' },
    { path: '.github/workflows/release-windows-gates.yml' },
    { path: '.github/workflows/sign-windows-alpha.yml' },
    { path: '.github/workflows/promote-windows-alpha.yml' },
    { event: 'workflow_dispatch' },
    { event: 'push', head_branch: 'v0.38.0' },
    { head_repository: { id: 8 } },
    { head_repository: null },
    { head_branch: 'other-feature' },
    { pull_requests: [{ number: 43 }] },
    { status: 'completed' }
  ]) {
    assert.equal(
      obsoletePullRequestRun({ ...run, ...changed }, { ...pull, state: 'closed' }),
      false
    )
  }
})

test('cleanup reads fresh PR state and force-cancels only obsolete runs', async () => {
  const calls = []
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pull }) },
      actions: { listWorkflowRunsForRepo: 'list' }
    },
    paginate: async (_, options) => {
      assert.equal(options.event, 'pull_request')
      assert.equal(options.branch, 'feature')
      return [run, { ...run, id: 101, head_sha: 'current' }, { ...run, id: 102 }]
    },
    request: async (route, args) => {
      assert.ok(route.endsWith('/force-cancel'))
      calls.push(args.run_id)
      if (args.run_id === 102) throw Object.assign(new Error('Finished'), { status: 409 })
    }
  }
  assert.deepEqual(
    await cancelObsoletePullRequestRuns({ github, owner: 'owner', repo: 'repo', pullNumber: 42 }),
    [100]
  )
  assert.deepEqual(calls, [100, 102])
})

test('privileged cleanup checks out only trusted code and cannot start normal CI jobs', () => {
  const workflow = load(
    readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  )
  assert.deepEqual(workflow.on.pull_request_target.types, ['synchronize', 'closed'])
  const cleanup = workflow.jobs['retire-obsolete-pr-runs']
  assert.equal(cleanup.if, "github.event_name == 'pull_request_target'")
  assert.equal(cleanup.steps[0].with.ref, '${{ github.event.repository.default_branch }}')
  assert.equal(cleanup.steps[0].with['persist-credentials'], false)
  assert.equal(workflow.jobs.scope.if, "github.event_name != 'pull_request_target'")
  assert.ok(workflow.jobs.js.if.includes('!cancelled()'))
  assert.equal(workflow.concurrency['cancel-in-progress'], true)
  assert.ok(workflow.concurrency.group.includes('cleanup-pr-'))
})
