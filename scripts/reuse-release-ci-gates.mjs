#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { classifyRepositoryChangeScope } from './ci-change-scope.mjs'
import {
  RELEASE_CI_GATE_SCOPE_FLAGS,
  parseReleaseRepository,
  parseReleaseSourceSha,
  reuseReleaseCiGateOrExplain
} from './lib/reuse-release-ci-gates.mjs'

const MAX_ANCESTORS = 20
// Only a diff of these kinds can separate a release commit from the commit
// whose gates it reuses (plan 242 D2). A js-test diff is not one: the Windows
// Rust job's ownership loop runs Node test files.
const SAME_SOURCE_KINDS = Object.freeze(['version-release', 'docs-record', 'docs'])

async function githubApi(path, token, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`GitHub GET ${path} failed (${response.status}): ${detail.slice(0, 200)}`)
  }
  return response.json()
}

function firstParentHistory(sha, cwd) {
  const output = execFileSync(
    'git',
    ['rev-list', '--first-parent', `--max-count=${MAX_ANCESTORS + 1}`, sha],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return output.split('\n').filter(Boolean)
}

/**
 * [releaseSha, ...ancestors] whose diff to the release commit is version,
 * changelog or docs only, and that CI would skip this gate family for. Walks
 * first-parent history and stops at the first ancestor that fails either.
 * Any git failure means exact-commit reuse only.
 */
export function sameSourceShas({
  sha,
  lookup,
  cwd = process.cwd(),
  history = firstParentHistory,
  classify = classifyRepositoryChangeScope
}) {
  const flag = RELEASE_CI_GATE_SCOPE_FLAGS[lookup]
  if (!flag) return [sha]
  let commits
  try {
    commits = history(sha, cwd)
  } catch {
    return [sha]
  }
  if (commits[0] !== sha) return [sha]
  const shas = [sha]
  for (const ancestor of commits.slice(1)) {
    let scope
    try {
      scope = classify({
        env: { GITHUB_EVENT_NAME: 'push', CI_BASE_SHA: ancestor, CI_HEAD_SHA: sha },
        cwd
      })
    } catch {
      break
    }
    if (!SAME_SOURCE_KINDS.includes(scope?.kind) || scope?.[flag] !== false) break
    shas.push(ancestor)
  }
  return shas
}

export async function main({
  env = process.env,
  fetchImpl = fetch,
  argv = process.argv,
  output = console,
  sourceShasFor = sameSourceShas
} = {}) {
  const specIndex = argv.indexOf('--spec')
  const lookup = specIndex >= 0 ? argv[specIndex + 1] : undefined
  const sha = parseReleaseSourceSha(env.EXPECTED_SOURCE_COMMIT || env.GITHUB_SHA)
  const repository = parseReleaseRepository(env.GITHUB_REPOSITORY)
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  if (!token) {
    output.log('reuse-release-ci-gates: no GitHub token; running the local gates.')
    return writeOutput(env, { reused: false, reason: 'missing-token', headSha: sha })
  }

  let result
  try {
    const sourceShas = sourceShasFor({ sha, lookup })
    result = await reuseReleaseCiGateOrExplain({
      api: (path) => githubApi(path, token, fetchImpl),
      repository,
      sha,
      lookup,
      sourceShas
    })
  } catch (error) {
    output.error(`reuse-release-ci-gates: ${error.code ?? 'error'}: ${error.message}`)
    result = { reused: false, reason: 'lookup-failed', detail: error.message, headSha: sha }
  }

  if (result.reused) {
    const from =
      result.reason === 'ancestor-same-source'
        ? `ancestor ${result.sourceSha} (its diff to ${result.headSha} is one CI skips this gate for)`
        : result.headSha
    output.log(
      `Reusing ${result.jobName} from ${result.workflowPath} run ${result.runId} for ${from}.`
    )
    if (result.htmlUrl) output.log(result.htmlUrl)
  } else {
    output.log(
      `No reusable CI gate for ${lookup} on ${sha}: ${result.reason}. Running the local gates.`
    )
  }
  return writeOutput(env, result)
}

async function writeOutput(env, result) {
  const lines = [
    `reused=${result.reused === true}`,
    `reason=${result.reason ?? ''}`,
    `run_id=${result.runId ?? ''}`,
    `job_name=${result.jobName ?? ''}`,
    `html_url=${result.htmlUrl ?? ''}`,
    `source_sha=${result.sourceSha ?? result.headSha ?? ''}`
  ]
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`reuse-release-ci-gates: ${error.code ?? 'error'}: ${error.message}`)
    process.exitCode = 1
  })
}
