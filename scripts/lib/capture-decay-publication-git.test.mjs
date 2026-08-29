import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

import {
  assertCaptureDecayCurrentProtectedMain,
  assertCaptureDecayD3PublicationMode,
  assertCaptureDecayD3PublicationTrackedTreeClean,
  assertCaptureDecayProtectedPublicationRef,
  CaptureDecayPublicationRefError
} from './capture-decay-publication-git.mjs'

const execFileAsync = promisify(execFile)

describe('capture-decay publication verifier mode', () => {
  it('allows exact promotion only while acceptance is exactly accepted', () => {
    const accepted = { status: 'accepted' }
    assert.equal(assertCaptureDecayD3PublicationMode(accepted, { exactPromotion: true }), accepted)
    for (const status of ['pending', 'satisfied']) {
      assert.throws(
        () => assertCaptureDecayD3PublicationMode({ status }, { exactPromotion: true }),
        /requires D3 acceptance status exactly accepted/
      )
    }
  })

  it('keeps exact promotion and regular release modes disjoint', () => {
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationMode(
          { status: 'accepted' },
          { exactPromotion: true, regularRelease: true }
        ),
      /mutually exclusive/
    )
    assert.throws(
      () => assertCaptureDecayD3PublicationMode({ status: 'accepted' }, { regularRelease: true }),
      /regular macOS release workflow may not rebuild it/
    )
    assert.doesNotThrow(() =>
      assertCaptureDecayD3PublicationMode({ status: 'satisfied' }, { regularRelease: true })
    )
  })
})

async function withGitRepository(run) {
  const repository = await mkdtemp(join(tmpdir(), 'videorc-capture-publication-git-'))
  try {
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.email', 'tests@videorc.invalid'], {
      cwd: repository
    })
    await execFileAsync('git', ['config', 'user.name', 'Videorc Tests'], { cwd: repository })
    await writeFile(join(repository, 'tracked.txt'), 'committed\n')
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository })
    await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository })
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
      cwd: repository
    })
    await run(repository)
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}

describe('capture-decay publication tracked source boundary', () => {
  it('accepts ignored and untracked release output without hiding tracked source edits', async () => {
    await withGitRepository(async (repository) => {
      await writeFile(join(repository, 'release-output.dmg'), 'generated')
      await assert.doesNotReject(
        assertCaptureDecayD3PublicationTrackedTreeClean({ repoRoot: repository })
      )

      await writeFile(join(repository, 'tracked.txt'), 'mutated by a build step\n')
      await assert.rejects(
        assertCaptureDecayD3PublicationTrackedTreeClean({ repoRoot: repository }),
        /tracked source changes/
      )
    })
  })

  it('rejects staged tracked changes as well as unstaged ones', async () => {
    await withGitRepository(async (repository) => {
      await writeFile(join(repository, 'tracked.txt'), 'staged mutation\n')
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository })

      await assert.rejects(
        assertCaptureDecayD3PublicationTrackedTreeClean({ repoRoot: repository }),
        /tracked source changes/
      )
    })
  })
})

describe('capture-decay protected publication ref', () => {
  it('accepts a protected manual dispatch only at current origin/main', async () => {
    await withGitRepository(async (repository) => {
      const headCommit = await gitHead(repository)
      assert.deepEqual(
        await assertCaptureDecayProtectedPublicationRef({
          env: publicationEnv({ headCommit }),
          repoRoot: repository
        }),
        {
          eventName: 'workflow_dispatch',
          headCommit,
          originDefaultCommit: headCommit,
          ref: 'refs/heads/main',
          refName: 'main',
          refType: 'branch',
          repository: 'TheOrcDev/videorc'
        }
      )
    })
  })

  it('rejects unprotected refs before trusting their local Git shape', async () => {
    await withGitRepository(async (repository) => {
      const headCommit = await gitHead(repository)
      await assert.rejects(
        assertCaptureDecayProtectedPublicationRef({
          env: publicationEnv({ headCommit, protectedRef: false }),
          repoRoot: repository
        }),
        publicationRefCode('unprotected-ref')
      )
    })
  })

  it('rejects workflow_dispatch from a protected non-default branch', async () => {
    await withGitRepository(async (repository) => {
      await execFileAsync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: repository })
      await writeFile(join(repository, 'feature.txt'), 'unmerged release code\n')
      await execFileAsync('git', ['add', 'feature.txt'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'feature'], { cwd: repository })
      const headCommit = await gitHead(repository)

      await assert.rejects(
        assertCaptureDecayProtectedPublicationRef({
          env: publicationEnv({
            headCommit,
            ref: 'refs/heads/feature',
            refName: 'feature'
          }),
          repoRoot: repository
        }),
        publicationRefCode('dispatch-ref-not-default-branch')
      )
    })
  })

  it('rejects workflow_dispatch when the checkout is ahead of current origin/main', async () => {
    await withGitRepository(async (repository) => {
      await writeFile(join(repository, 'tracked.txt'), 'local main advance\n')
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'local advance'], {
        cwd: repository
      })
      const headCommit = await gitHead(repository)

      await assert.rejects(
        assertCaptureDecayProtectedPublicationRef({
          env: publicationEnv({ headCommit }),
          repoRoot: repository
        }),
        publicationRefCode('default-branch-not-current')
      )
    })
  })

  it('accepts a protected v* tag behind current origin/main when the tag is still reachable', async () => {
    await withGitRepository(async (repository) => {
      const headCommit = await gitHead(repository)
      await execFileAsync('git', ['tag', 'v1.2.3'], { cwd: repository })
      await writeFile(join(repository, 'tracked.txt'), 'main advanced after the release tag\n')
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'advance main'], {
        cwd: repository
      })
      const originDefaultCommit = await gitHead(repository)
      await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', originDefaultCommit], {
        cwd: repository
      })
      await execFileAsync('git', ['checkout', '--quiet', '--detach', headCommit], {
        cwd: repository
      })
      const result = await assertCaptureDecayProtectedPublicationRef({
        env: publicationEnv({
          eventName: 'push',
          headCommit,
          ref: 'refs/tags/v1.2.3',
          refName: 'v1.2.3',
          refType: 'tag'
        }),
        repoRoot: repository
      })
      assert.equal(result.headCommit, headCommit)
      assert.equal(result.originDefaultCommit, originDefaultCommit)
      assert.notEqual(result.originDefaultCommit, result.headCommit)
    })
  })

  it('rejects a protected v* tag created from an unmerged commit', async () => {
    await withGitRepository(async (repository) => {
      await execFileAsync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: repository })
      await writeFile(join(repository, 'feature.txt'), 'unmerged tagged release code\n')
      await execFileAsync('git', ['add', 'feature.txt'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'feature'], { cwd: repository })
      await execFileAsync('git', ['tag', 'v1.2.4'], { cwd: repository })
      const headCommit = await gitHead(repository)

      await assert.rejects(
        assertCaptureDecayProtectedPublicationRef({
          env: publicationEnv({
            eventName: 'push',
            headCommit,
            ref: 'refs/tags/v1.2.4',
            refName: 'v1.2.4',
            refType: 'tag'
          }),
          repoRoot: repository
        }),
        publicationRefCode('release-tag-not-on-default-branch')
      )
    })
  })

  it('rejects a stale or synthetic trigger ref even when GITHUB_SHA matches HEAD', async () => {
    await withGitRepository(async (repository) => {
      const mainCommit = await gitHead(repository)
      await writeFile(join(repository, 'tracked.txt'), 'new main commit\n')
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'advance'], { cwd: repository })
      const headCommit = await gitHead(repository)
      await execFileAsync('git', ['checkout', '--quiet', '--detach', headCommit], {
        cwd: repository
      })
      await execFileAsync('git', ['update-ref', 'refs/heads/main', mainCommit], { cwd: repository })

      await assert.rejects(
        assertCaptureDecayProtectedPublicationRef({
          env: publicationEnv({ headCommit }),
          repoRoot: repository
        }),
        publicationRefCode('trigger-ref-mismatch')
      )
    })
  })
})

describe('capture-decay publication-boundary main authority', () => {
  it('queries GitHub and accepts only the checkout that is still current protected main', async () => {
    const headCommit = 'a'.repeat(40)
    let request = null
    const result = await assertCaptureDecayCurrentProtectedMain({
      env: publicationEnv({ headCommit }),
      fetchImpl: async (...args) => {
        request = args
        return {
          ok: true,
          json: async () => ({ object: { sha: headCommit } })
        }
      },
      headCommit
    })

    assert.deepEqual(result, {
      currentMainCommit: headCommit,
      headCommit,
      repository: 'TheOrcDev/videorc'
    })
    assert.equal(request[0], 'https://api.github.com/repos/TheOrcDev/videorc/git/ref/heads/main')
    assert.equal(request[1].headers.authorization, 'Bearer publication-test-token')
    assert.equal(request[1].redirect, 'error')
  })

  it('rejects publication when protected main advances after the workflow gate', async () => {
    const headCommit = 'a'.repeat(40)
    await assert.rejects(
      assertCaptureDecayCurrentProtectedMain({
        env: publicationEnv({ headCommit }),
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ object: { sha: 'b'.repeat(40) } })
        }),
        headCommit
      }),
      publicationRefCode('default-branch-advanced-at-publication')
    )
  })

  it('fails closed on an unavailable or malformed authoritative GitHub response', async () => {
    const headCommit = 'a'.repeat(40)
    for (const fetchImpl of [
      async () => ({ ok: false, status: 503 }),
      async () => ({ ok: true, json: async () => ({ object: { sha: 'not-a-commit' } }) })
    ]) {
      await assert.rejects(
        assertCaptureDecayCurrentProtectedMain({
          env: publicationEnv({ headCommit }),
          fetchImpl,
          headCommit
        }),
        (error) =>
          error instanceof CaptureDecayPublicationRefError &&
          ['github-main-ref-request-failed', 'github-main-ref-response-invalid'].includes(
            error.code
          )
      )
    }
  })
})

function publicationEnv({
  apiToken = 'publication-test-token',
  eventName = 'workflow_dispatch',
  headCommit,
  protectedRef = true,
  ref = 'refs/heads/main',
  refName = 'main',
  refType = 'branch'
}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: eventName,
    GITHUB_REF: ref,
    GITHUB_REF_NAME: refName,
    GITHUB_REF_PROTECTED: protectedRef ? 'true' : 'false',
    GITHUB_REF_TYPE: refType,
    GITHUB_REPOSITORY: 'TheOrcDev/videorc',
    GITHUB_SHA: headCommit,
    VIDEORC_GITHUB_API_TOKEN: apiToken
  }
}

function publicationRefCode(code) {
  return (error) => error instanceof CaptureDecayPublicationRefError && error.code === code
}

async function gitHead(repository) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8'
  })
  return stdout.trim()
}
