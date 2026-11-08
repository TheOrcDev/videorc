const SHA_RE = /^[a-f0-9]{40}$/
const ALLOWED_EVENTS = Object.freeze(['push', 'workflow_dispatch'])

export const RELEASE_CI_GATE_SPECS = Object.freeze({
  'windows-js-job': Object.freeze({
    id: 'windows-js-job',
    workflowFile: 'ci.yml',
    jobNames: Object.freeze(['JS (format + lint + tests)'])
  }),
  'windows-source-gates': Object.freeze({
    id: 'windows-source-gates',
    workflowFile: 'windows.yml',
    jobNames: Object.freeze(['gates / Windows release source gates'])
  }),
  'linux-rust-job': Object.freeze({
    id: 'linux-rust-job',
    workflowFile: 'linux.yml',
    jobNames: Object.freeze(['Linux gates (FFmpeg policy + Rust compile/test)'])
  })
})

export const RELEASE_CI_GATE_LOOKUPS = Object.freeze({
  'windows-js': Object.freeze(['windows-source-gates', 'windows-js-job']),
  'windows-rust': Object.freeze(['windows-source-gates']),
  'linux-rust': Object.freeze(['linux-rust-job'])
})

export class ReuseReleaseCiError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReuseReleaseCiError'
    this.code = code
  }
}

function requireReuse(condition, code, message) {
  if (!condition) throw new ReuseReleaseCiError(code, message)
}

export function resolveReleaseCiGateSpec(id) {
  const spec = RELEASE_CI_GATE_SPECS[id]
  requireReuse(spec, 'unknown-spec', `Unknown release CI reuse spec: ${id}.`)
  return spec
}

export function resolveReleaseCiGateLookup(id) {
  const specIds = RELEASE_CI_GATE_LOOKUPS[id]
  requireReuse(specIds, 'unknown-spec', `Unknown release CI reuse lookup: ${id}.`)
  return specIds.map(resolveReleaseCiGateSpec)
}

export function parseReleaseSourceSha(value) {
  const sha = String(value ?? '')
    .trim()
    .toLowerCase()
  requireReuse(
    SHA_RE.test(sha),
    'source-sha',
    'Source commit must be a lowercase 40-character SHA.'
  )
  return sha
}

export function parseReleaseRepository(value) {
  const repository = String(value ?? '').trim()
  requireReuse(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    'repository',
    'GITHUB_REPOSITORY must be owner/repo.'
  )
  return repository
}

function workflowPath(file) {
  return `.github/workflows/${file}`
}

function jobSucceeded(job, jobNames) {
  return (
    job && jobNames.includes(job.name) && job.status === 'completed' && job.conclusion === 'success'
  )
}

function runIsTrusted(run, { repository, sha, workflowFile }) {
  const headSha = String(run?.head_sha ?? '').toLowerCase()
  const repoName = run?.repository?.full_name
  return (
    run &&
    run.path === workflowPath(workflowFile) &&
    ALLOWED_EVENTS.includes(run.event) &&
    run.head_branch === 'main' &&
    headSha === sha &&
    (repoName == null || repoName === repository)
  )
}

export async function findReusableReleaseCiGate({ api, repository, sha, spec, maxRuns = 20 }) {
  requireReuse(typeof api === 'function', 'api', 'GitHub API function is required.')
  const exactSha = parseReleaseSourceSha(sha)
  const exactRepository = parseReleaseRepository(repository)
  requireReuse(
    spec?.workflowFile && Array.isArray(spec.jobNames),
    'spec',
    'Reuse spec is incomplete.'
  )

  const listed = await api(
    `/repos/${exactRepository}/actions/workflows/${spec.workflowFile}/runs?head_sha=${exactSha}&per_page=${maxRuns}`
  )
  requireReuse(
    Array.isArray(listed?.workflow_runs),
    'github-response',
    'GitHub returned no workflow run list.'
  )

  for (const run of listed.workflow_runs) {
    if (
      !runIsTrusted(run, {
        repository: exactRepository,
        sha: exactSha,
        workflowFile: spec.workflowFile
      })
    ) {
      continue
    }
    const jobs = await api(`/repos/${exactRepository}/actions/runs/${run.id}/jobs?per_page=100`)
    requireReuse(Array.isArray(jobs?.jobs), 'github-response', 'GitHub returned no job list.')
    const job = jobs.jobs.find((entry) => jobSucceeded(entry, spec.jobNames))
    if (!job) continue
    return {
      reused: true,
      reason: 'exact-commit-job-success',
      specId: spec.id,
      runId: run.id,
      jobId: job.id,
      jobName: job.name,
      workflowPath: run.path,
      htmlUrl: job.html_url ?? run.html_url,
      headSha: exactSha
    }
  }

  return {
    reused: false,
    reason: 'no-successful-job-for-exact-commit',
    specId: spec.id,
    headSha: exactSha
  }
}

export async function findFirstReusableReleaseCiGate({
  api,
  repository,
  sha,
  lookup,
  specIds,
  maxRuns
}) {
  const specs = specIds ? specIds.map(resolveReleaseCiGateSpec) : resolveReleaseCiGateLookup(lookup)
  let lastMiss = null
  for (const spec of specs) {
    const result = await findReusableReleaseCiGate({ api, repository, sha, spec, maxRuns })
    if (result.reused) return result
    lastMiss = result
  }
  return lastMiss ?? { reused: false, reason: 'no-successful-job-for-exact-commit' }
}

export async function reuseReleaseCiGateOrExplain(options) {
  try {
    return await findFirstReusableReleaseCiGate(options)
  } catch (error) {
    if (error instanceof ReuseReleaseCiError && error.code === 'github-response') {
      return { reused: false, reason: error.code, detail: error.message }
    }
    throw error
  }
}
