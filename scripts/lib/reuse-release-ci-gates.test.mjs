import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  ReuseReleaseCiError,
  findFirstReusableReleaseCiGate,
  parseReleaseRepository,
  parseReleaseSourceSha,
  resolveReleaseCiGateLookup,
  reuseReleaseCiGateOrExplain
} from './reuse-release-ci-gates.mjs'
import { main as reuseCli } from '../reuse-release-ci-gates.mjs'

const sha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)

function jsSuccessRun(overrides = {}) {
  return {
    id: 11,
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    repository: { full_name: 'TheOrcDev/videorc' },
    html_url: 'https://github.com/TheOrcDev/videorc/actions/runs/11',
    ...overrides
  }
}

function jsSuccessJob(overrides = {}) {
  return {
    id: 1100,
    name: 'JS (format + lint + tests)',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/TheOrcDev/videorc/actions/runs/11/job/1100',
    ...overrides
  }
}

function windowsGatesSuccessRun(overrides = {}) {
  return {
    id: 22,
    path: '.github/workflows/windows.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    repository: { full_name: 'TheOrcDev/videorc' },
    html_url: 'https://github.com/TheOrcDev/videorc/actions/runs/22',
    ...overrides
  }
}

function windowsGatesSuccessJob(overrides = {}) {
  return {
    id: 2200,
    name: 'gates / Windows release source gates',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/TheOrcDev/videorc/actions/runs/22/job/2200',
    ...overrides
  }
}

function apiFrom(routes) {
  return async (path) => {
    const value = routes[path]
    if (value === undefined) throw new Error(`unexpected GitHub path ${path}`)
    return typeof value === 'function' ? value() : value
  }
}

describe('reuse-release-ci-gates', () => {
  it('rejects a non-canonical source SHA or repository', () => {
    assert.throws(
      () => parseReleaseSourceSha('abc'),
      (error) => {
        return error instanceof ReuseReleaseCiError && error.code === 'source-sha'
      }
    )
    assert.throws(
      () => parseReleaseRepository('videorc'),
      (error) => {
        return error instanceof ReuseReleaseCiError && error.code === 'repository'
      }
    )
  })

  it('reuses a successful JS job on the exact main push SHA even when the workflow was cancelled', async () => {
    const result = await findFirstReusableReleaseCiGate({
      lookup: 'windows-js',
      repository: 'TheOrcDev/videorc',
      sha,
      api: apiFrom({
        [`/repos/TheOrcDev/videorc/actions/workflows/windows.yml/runs?head_sha=${sha}&per_page=20`]:
          {
            workflow_runs: [windowsGatesSuccessRun({ event: 'pull_request' })]
          },
        [`/repos/TheOrcDev/videorc/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`]: {
          workflow_runs: [jsSuccessRun()]
        },
        '/repos/TheOrcDev/videorc/actions/runs/11/jobs?per_page=100': {
          jobs: [
            jsSuccessJob(),
            {
              id: 1101,
              name: 'Rust (test + clippy + fmt)',
              status: 'completed',
              conclusion: 'cancelled'
            }
          ]
        }
      })
    })
    assert.deepEqual(result, {
      reused: true,
      reason: 'exact-commit-job-success',
      specId: 'windows-js-job',
      runId: 11,
      jobId: 1100,
      jobName: 'JS (format + lint + tests)',
      workflowPath: '.github/workflows/ci.yml',
      htmlUrl: 'https://github.com/TheOrcDev/videorc/actions/runs/11/job/1100',
      headSha: sha
    })
  })

  it('prefers the Windows source-gate job when that exact-commit job already passed', async () => {
    const result = await findFirstReusableReleaseCiGate({
      lookup: 'windows-js',
      repository: 'TheOrcDev/videorc',
      sha,
      api: apiFrom({
        [`/repos/TheOrcDev/videorc/actions/workflows/windows.yml/runs?head_sha=${sha}&per_page=20`]:
          {
            workflow_runs: [windowsGatesSuccessRun()]
          },
        '/repos/TheOrcDev/videorc/actions/runs/22/jobs?per_page=100': {
          jobs: [windowsGatesSuccessJob()]
        }
      })
    })
    assert.equal(result.reused, true)
    assert.equal(result.specId, 'windows-source-gates')
    assert.equal(result.jobName, 'gates / Windows release source gates')
  })

  it('refuses a job from another commit, a pull_request event, or a failed/cancelled job', async () => {
    const api = apiFrom({
      [`/repos/TheOrcDev/videorc/actions/workflows/windows.yml/runs?head_sha=${sha}&per_page=20`]: {
        workflow_runs: [
          windowsGatesSuccessRun({ head_sha: otherSha }),
          windowsGatesSuccessRun({ id: 23, event: 'pull_request' }),
          windowsGatesSuccessRun({ id: 24, head_branch: 'cursor/faster' }),
          windowsGatesSuccessRun({ id: 25 })
        ]
      },
      '/repos/TheOrcDev/videorc/actions/runs/25/jobs?per_page=100': {
        jobs: [windowsGatesSuccessJob({ conclusion: 'cancelled' })]
      }
    })
    const result = await findFirstReusableReleaseCiGate({
      lookup: 'windows-rust',
      repository: 'TheOrcDev/videorc',
      sha,
      api
    })
    assert.equal(result.reused, false)
    assert.equal(result.reason, 'no-successful-job-for-exact-commit')
  })

  it('refuses a successful installer job as a substitute for Windows Rust source gates', async () => {
    const result = await findFirstReusableReleaseCiGate({
      lookup: 'windows-rust',
      repository: 'TheOrcDev/videorc',
      sha,
      api: apiFrom({
        [`/repos/TheOrcDev/videorc/actions/workflows/windows.yml/runs?head_sha=${sha}&per_page=20`]:
          {
            workflow_runs: [windowsGatesSuccessRun()]
          },
        '/repos/TheOrcDev/videorc/actions/runs/22/jobs?per_page=100': {
          jobs: [
            {
              id: 2299,
              name: 'Windows installer artifact',
              status: 'completed',
              conclusion: 'success'
            }
          ]
        }
      })
    })
    assert.equal(result.reused, false)
  })

  it('fails open when GitHub returns a malformed list so the release still runs its own gates', async () => {
    const result = await reuseReleaseCiGateOrExplain({
      lookup: 'linux-rust',
      repository: 'TheOrcDev/videorc',
      sha,
      api: async () => ({})
    })
    assert.equal(result.reused, false)
    assert.equal(result.reason, 'github-response')
  })

  it('exposes the Windows JS lookup as source-gates then the CI JS job', () => {
    assert.deepEqual(
      resolveReleaseCiGateLookup('windows-js').map((spec) => spec.id),
      ['windows-source-gates', 'windows-js-job']
    )
  })
})

describe('reuse-release-ci-gates CLI', () => {
  it('writes reused=false when no token is present and does not call GitHub', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-reuse-ci-'))
    const outputFile = join(directory, 'github-output')
    const logs = []
    try {
      const result = await reuseCli({
        env: {
          EXPECTED_SOURCE_COMMIT: sha,
          GITHUB_REPOSITORY: 'TheOrcDev/videorc',
          GITHUB_OUTPUT: outputFile
        },
        argv: ['node', 'reuse-release-ci-gates.mjs', '--spec', 'linux-rust'],
        fetchImpl: () => assert.fail('must not call GitHub without a token'),
        output: { log: (line) => logs.push(line), error: () => {} }
      })
      assert.equal(result.reused, false)
      assert.equal(result.reason, 'missing-token')
      assert.match(await readFile(outputFile, 'utf8'), /reused=false/)
      assert.match(logs.join('\n'), /no GitHub token/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('records a trusted exact-commit reuse in GITHUB_OUTPUT', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-reuse-ci-'))
    const outputFile = join(directory, 'github-output')
    try {
      const result = await reuseCli({
        env: {
          GH_TOKEN: 'test-token',
          GITHUB_SHA: sha,
          GITHUB_REPOSITORY: 'TheOrcDev/videorc',
          GITHUB_OUTPUT: outputFile
        },
        argv: ['node', 'reuse-release-ci-gates.mjs', '--spec', 'linux-rust'],
        fetchImpl: async (url) => {
          assert.match(url, /api\.github\.com/)
          if (url.includes('/actions/workflows/linux.yml/runs')) {
            return {
              ok: true,
              json: async () => ({
                workflow_runs: [
                  {
                    id: 33,
                    path: '.github/workflows/linux.yml',
                    event: 'push',
                    head_branch: 'main',
                    head_sha: sha,
                    repository: { full_name: 'TheOrcDev/videorc' },
                    html_url: 'https://example.test/run/33'
                  }
                ]
              })
            }
          }
          if (url.includes('/actions/runs/33/jobs')) {
            return {
              ok: true,
              json: async () => ({
                jobs: [
                  {
                    id: 3300,
                    name: 'Linux gates (FFmpeg policy + Rust compile/test)',
                    status: 'completed',
                    conclusion: 'success',
                    html_url: 'https://example.test/job/3300'
                  }
                ]
              })
            }
          }
          throw new Error(`unexpected ${url}`)
        },
        output: { log: () => {}, error: () => {} }
      })
      assert.equal(result.reused, true)
      assert.equal(result.runId, 33)
      assert.match(await readFile(outputFile, 'utf8'), /reused=true/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
