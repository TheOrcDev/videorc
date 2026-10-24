#!/usr/bin/env node
import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import {
  parseReleaseRepository,
  parseReleaseSourceSha,
  reuseReleaseCiGateOrExplain
} from './lib/reuse-release-ci-gates.mjs'

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

export async function main({
  env = process.env,
  fetchImpl = fetch,
  argv = process.argv,
  output = console
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
    result = await reuseReleaseCiGateOrExplain({
      api: (path) => githubApi(path, token, fetchImpl),
      repository,
      sha,
      lookup
    })
  } catch (error) {
    output.error(`reuse-release-ci-gates: ${error.code ?? 'error'}: ${error.message}`)
    result = { reused: false, reason: 'lookup-failed', detail: error.message, headSha: sha }
  }

  if (result.reused) {
    output.log(
      `Reusing ${result.jobName} from ${result.workflowPath} run ${result.runId} for ${result.headSha}.`
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
    `html_url=${result.htmlUrl ?? ''}`
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
