import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  RELEASE_CI_GATE_SPECS,
  ReuseReleaseCiError,
  findFirstReusableReleaseCiGate,
  jobProvesGate,
  parseReleaseRepository,
  parseReleaseSourceSha,
  resolveReleaseCiGateLookup,
  reuseReleaseCiGateOrExplain
} from './reuse-release-ci-gates.mjs'
import { main as reuseCli, sameSourceShas } from '../reuse-release-ci-gates.mjs'

const sha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const thirdSha = 'c'.repeat(40)

function greenSteps(specId) {
  return RELEASE_CI_GATE_SPECS[specId].jobs[0].requiredSteps.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success'
  }))
}

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
    steps: greenSteps('windows-js-job'),
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
    name: 'gates / Windows release Rust gates',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/TheOrcDev/videorc/actions/runs/22/job/2200',
    steps: greenSteps('windows-rust-gates'),
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
      jobNames: ['JS (format + lint + tests)'],
      workflowPath: '.github/workflows/ci.yml',
      htmlUrl: 'https://github.com/TheOrcDev/videorc/actions/runs/11/job/1100',
      headSha: sha
    })
  })

  it('prefers the Windows JS gate job when that exact-commit job already passed', async () => {
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
          jobs: [
            windowsGatesSuccessJob(),
            windowsGatesSuccessJob({
              id: 2201,
              name: 'gates / Windows release JS gates',
              steps: greenSteps('windows-js-gates')
            })
          ]
        }
      })
    })
    assert.equal(result.reused, true)
    assert.equal(result.specId, 'windows-js-gates')
    assert.equal(result.jobName, 'gates / Windows release JS gates')
  })

  it('never reuses the green aggregator that only reports the two gate jobs', async () => {
    const aggregator = windowsGatesSuccessJob({
      id: 2202,
      name: 'gates / Windows release source gates',
      steps: [{ name: 'Require every Windows gate job', conclusion: 'success' }]
    })
    for (const lookup of ['windows-rust', 'windows-js']) {
      const result = await findFirstReusableReleaseCiGate({
        lookup,
        repository: 'TheOrcDev/videorc',
        sha,
        api: apiFrom({
          [`/repos/TheOrcDev/videorc/actions/workflows/windows.yml/runs?head_sha=${sha}&per_page=20`]:
            { workflow_runs: [windowsGatesSuccessRun()] },
          [`/repos/TheOrcDev/videorc/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`]: {
            workflow_runs: []
          },
          '/repos/TheOrcDev/videorc/actions/runs/22/jobs?per_page=100': { jobs: [aggregator] }
        })
      })
      assert.equal(result.reused, false, lookup)
    }
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

  it('refuses a skip twin that shares the gate name but ran no gate step (0.28.1)', async () => {
    const twin = windowsGatesSuccessJob({
      steps: [
        { name: 'Set up job', conclusion: 'success' },
        {
          name: 'Skip heavy Windows source gates for an allow-listed docs or version-only change',
          conclusion: 'success'
        },
        { name: 'Complete job', conclusion: 'success' }
      ]
    })
    const result = await findFirstReusableReleaseCiGate({
      lookup: 'windows-rust',
      repository: 'TheOrcDev/videorc',
      sha,
      api: apiFrom({
        [`/repos/TheOrcDev/videorc/actions/workflows/windows.yml/runs?head_sha=${sha}&per_page=20`]:
          { workflow_runs: [windowsGatesSuccessRun()] },
        '/repos/TheOrcDev/videorc/actions/runs/22/jobs?per_page=100': { jobs: [twin] }
      })
    })
    assert.equal(result.reused, false)
  })

  it('refuses a green job that is missing one required step, or ran it red', () => {
    const gate = RELEASE_CI_GATE_SPECS['windows-rust-gates'].jobs[0]
    const steps = greenSteps('windows-rust-gates')
    assert.equal(jobProvesGate(windowsGatesSuccessJob(), gate), true)
    assert.equal(jobProvesGate(windowsGatesSuccessJob({ steps: steps.slice(1) }), gate), false)
    assert.equal(
      jobProvesGate(
        windowsGatesSuccessJob({
          steps: steps.map((step, index) =>
            index === 1 ? { ...step, conclusion: 'skipped' } : step
          )
        }),
        gate
      ),
      false
    )
  })

  it('reuses a same-source ancestor when the release commit only has a skip twin', async () => {
    const result = await findFirstReusableReleaseCiGate({
      lookup: 'windows-rust',
      repository: 'TheOrcDev/videorc',
      sha,
      sourceShas: [sha, otherSha],
      api: apiFrom({
        [`/repos/TheOrcDev/videorc/actions/workflows/windows.yml/runs?head_sha=${sha}&per_page=20`]:
          { workflow_runs: [windowsGatesSuccessRun()] },
        '/repos/TheOrcDev/videorc/actions/runs/22/jobs?per_page=100': {
          jobs: [windowsGatesSuccessJob({ steps: [] })]
        },
        [`/repos/TheOrcDev/videorc/actions/workflows/windows.yml/runs?head_sha=${otherSha}&per_page=20`]:
          { workflow_runs: [windowsGatesSuccessRun({ id: 44, head_sha: otherSha })] },
        '/repos/TheOrcDev/videorc/actions/runs/44/jobs?per_page=100': {
          jobs: [windowsGatesSuccessJob({ id: 4400 })]
        }
      })
    })
    assert.equal(result.reused, true)
    assert.equal(result.reason, 'ancestor-same-source')
    assert.equal(result.headSha, sha)
    assert.equal(result.sourceSha, otherSha)
    assert.equal(result.runId, 44)
  })

  it('refuses a candidate list that does not start with the release commit', async () => {
    await assert.rejects(
      () =>
        findFirstReusableReleaseCiGate({
          lookup: 'linux-rust',
          repository: 'TheOrcDev/videorc',
          sha,
          sourceShas: [otherSha],
          api: async () => assert.fail('must not call GitHub')
        }),
      (error) => error instanceof ReuseReleaseCiError && error.code === 'source-sha'
    )
  })

  it('walks first-parent history only while CI would skip the gate for the diff', () => {
    const seen = []
    const shas = sameSourceShas({
      sha,
      lookup: 'windows-rust',
      history: () => [sha, otherSha, thirdSha, 'd'.repeat(40)],
      classify: ({ env }) => {
        seen.push(env.CI_BASE_SHA)
        assert.equal(env.GITHUB_EVENT_NAME, 'push')
        assert.equal(env.CI_HEAD_SHA, sha)
        // The diff from thirdSha already holds code, so the walk stops there.
        return { windowsHeavy: env.CI_BASE_SHA !== otherSha }
      }
    })
    assert.deepEqual(shas, [sha, otherSha])
    assert.deepEqual(seen, [otherSha, thirdSha])
  })

  it('falls back to the exact commit when git or the lookup is unknown', () => {
    const boom = () => {
      throw new Error('shallow clone')
    }
    assert.deepEqual(sameSourceShas({ sha, lookup: 'windows-rust', history: boom }), [sha])
    assert.deepEqual(
      sameSourceShas({ sha, lookup: 'nope', history: () => assert.fail('no walk') }),
      [sha]
    )
    assert.deepEqual(
      sameSourceShas({
        sha,
        lookup: 'linux-rust',
        history: () => [sha, otherSha],
        classify: boom
      }),
      [sha]
    )
  })

  it('exposes the Windows JS lookup as the Windows JS gates then the CI JS job', () => {
    assert.deepEqual(
      resolveReleaseCiGateLookup('windows-js').map((spec) => spec.id),
      ['windows-js-gates', 'windows-js-job']
    )
    assert.deepEqual(
      resolveReleaseCiGateLookup('windows-rust').map((spec) => spec.id),
      ['windows-rust-gates']
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
        sourceShasFor: ({ sha: release }) => [release],
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
                    html_url: 'https://example.test/job/3300',
                    steps: greenSteps('linux-rust-job')
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
