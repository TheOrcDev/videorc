// Only ordinary PR CI is eligible. Dispatches (including requested artifacts),
// tag runs, and every release/sign/promotion workflow are outside this boundary.
const WORKFLOWS = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/windows.yml',
  '.github/workflows/linux.yml',
  '.github/workflows/gpui-compile.yml'
])

export function obsoletePullRequestRun(run, pull) {
  if (run.status === 'completed' || run.event !== 'pull_request') return false
  if (!WORKFLOWS.has(run.path?.split('@')[0])) return false
  if (!pull.head.repo?.id || run.head_repository?.id !== pull.head.repo.id) return false
  if (run.head_branch !== pull.head.ref) return false
  // GitHub removes PR associations from some runs after the PR closes. The
  // repository ID and branch still identify those; a different linked PR does not.
  if (run.pull_requests?.length && !run.pull_requests.some((pr) => pr.number === pull.number)) {
    return false
  }
  return pull.state === 'closed' || run.head_sha !== pull.head.sha
}

export async function cancelObsoletePullRequestRuns({ github, owner, repo, pullNumber }) {
  // Read current state rather than trusting a delayed synchronize/closed event.
  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber })
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
    owner,
    repo,
    event: 'pull_request',
    branch: pull.head.ref,
    per_page: 100
  })
  const cancelled = []
  for (const run of runs) {
    if (!obsoletePullRequestRun(run, pull)) continue
    try {
      // Normal concurrency cancellation can leave an always() summary queued.
      // Force-cancel only the obsolete, allow-listed PR run, never a release caller.
      await github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel', {
        owner,
        repo,
        run_id: run.id
      })
      cancelled.push(run.id)
    } catch (error) {
      if (error.status !== 409) throw error // It may have completed during the request.
    }
  }
  return cancelled
}
