const SHA_RE = /^[a-f0-9]{40}$/
const ALLOWED_EVENTS = Object.freeze(['push', 'workflow_dispatch'])

// A gate counts as passed only when every listed job succeeded AND ran each
// of its required steps. The skip-twin jobs share their gate's name, so a
// name and a green conclusion prove nothing: the 0.28.1 Windows alpha reused
// a 3-second Ubuntu skip as "Windows Rust gates passed" (plan 242 S1).
function gateJob(name, requiredSteps) {
  return Object.freeze({ name, requiredSteps: Object.freeze([...requiredSteps]) })
}

export const RELEASE_CI_GATE_SPECS = Object.freeze({
  'windows-js-job': Object.freeze({
    id: 'windows-js-job',
    workflowFile: 'ci.yml',
    jobs: Object.freeze([
      gateJob('JS (format + lint + tests)', [
        'Format check',
        'Lint',
        'Typecheck',
        'Desktop tests',
        'Node logic tests'
      ])
    ])
  }),
  'windows-source-gates': Object.freeze({
    id: 'windows-source-gates',
    workflowFile: 'windows.yml',
    jobs: Object.freeze([
      gateJob('gates / Windows release source gates', [
        'Clippy',
        'Source and audio ownership (25 stability passes)',
        'Test (3 stability passes)',
        'Rust format',
        'Desktop tests',
        'TypeScript',
        'ESLint'
      ])
    ])
  }),
  'linux-rust-job': Object.freeze({
    id: 'linux-rust-job',
    workflowFile: 'linux.yml',
    jobs: Object.freeze([
      gateJob('Linux gates (FFmpeg policy + Rust compile/test)', ['Clippy', 'Test'])
    ])
  })
})

export const RELEASE_CI_GATE_LOOKUPS = Object.freeze({
  'windows-js': Object.freeze(['windows-source-gates', 'windows-js-job']),
  'windows-rust': Object.freeze(['windows-source-gates']),
  'linux-rust': Object.freeze(['linux-rust-job'])
})

// The change-scope flag that says whether CI runs this gate family for a diff.
// An ancestor's gates stand in for the release commit only when CI itself
// would skip that family for the diff between them (plan 242 D2).
export const RELEASE_CI_GATE_SCOPE_FLAGS = Object.freeze({
  'windows-js': 'js',
  'windows-rust': 'windowsHeavy',
  'linux-rust': 'linuxHeavy'
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

function stepSucceeded(job, stepName) {
  return (job.steps ?? []).some((step) => step?.name === stepName && step.conclusion === 'success')
}

/** True when this job is the gate: right name, green, and every required step ran green. */
export function jobProvesGate(job, gate) {
  return Boolean(
    job &&
    job.name === gate.name &&
    job.status === 'completed' &&
    job.conclusion === 'success' &&
    gate.requiredSteps.every((stepName) => stepSucceeded(job, stepName))
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
    spec?.workflowFile && Array.isArray(spec.jobs) && spec.jobs.length > 0,
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
    const proven = spec.jobs.map((gate) => jobs.jobs.find((entry) => jobProvesGate(entry, gate)))
    if (proven.some((job) => !job)) continue
    const [job] = proven
    return {
      reused: true,
      reason: 'exact-commit-job-success',
      specId: spec.id,
      runId: run.id,
      jobId: job.id,
      jobName: job.name,
      jobNames: proven.map((entry) => entry.name),
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

/**
 * Tries the release commit first, then each same-source ancestor in order.
 * `sourceShas` is [releaseSha, ...ancestors]; the caller builds it so that
 * every ancestor's diff to the release commit is one CI skips this gate
 * family for. Without it only the exact commit counts.
 */
export async function findFirstReusableReleaseCiGate({
  api,
  repository,
  sha,
  lookup,
  specIds,
  maxRuns,
  sourceShas
}) {
  const specs = specIds ? specIds.map(resolveReleaseCiGateSpec) : resolveReleaseCiGateLookup(lookup)
  const releaseSha = parseReleaseSourceSha(sha)
  const candidates = sourceShas?.length ? sourceShas.map(parseReleaseSourceSha) : [releaseSha]
  requireReuse(
    candidates[0] === releaseSha,
    'source-sha',
    'The candidate list must start with the release commit.'
  )
  let lastMiss = null
  for (const candidate of candidates) {
    for (const spec of specs) {
      const result = await findReusableReleaseCiGate({
        api,
        repository,
        sha: candidate,
        spec,
        maxRuns
      })
      if (result.reused) {
        if (candidate === releaseSha) return result
        return {
          ...result,
          reason: 'ancestor-same-source',
          headSha: releaseSha,
          sourceSha: candidate
        }
      }
      if (candidate === releaseSha) lastMiss = result
    }
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
