import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

import {
  assertCaptureDecayD3SatisfiedSourceState,
  captureDecayD3SensitiveChangedPaths
} from './capture-decay-release-acceptance.mjs'
import {
  assertCaptureDecayCurrentProtectedMain,
  captureDecayD3CommittedChangedPaths,
  captureDecayD3DesktopPackageVersionOnlyChange,
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

describe('satisfied capture-decay committed drift boundary', () => {
  it('reports committed edits, deletes, and both sides of renames without UI/docs noise loss', async () => {
    await withGitRepository(async (repository) => {
      const backendDir = join(repository, 'crates/videorc-backend/src')
      const scriptDir = join(repository, 'scripts')
      const uiDir = join(repository, 'apps/desktop/src/renderer/src/components/ui')
      const docsDir = join(repository, 'docs/releases')
      await Promise.all(
        [backendDir, scriptDir, uiDir, docsDir].map((directory) =>
          mkdir(directory, { recursive: true })
        )
      )
      const recoveryPath = join(backendDir, 'capture_recovery.rs')
      const gatePath = join(scriptDir, 'smoke-capture-decay-soak.mjs')
      const uiPath = join(uiDir, 'button.tsx')
      const runbookPath = join(docsDir, 'release-runbook.md')
      await writeFile(recoveryPath, 'pub fn recover() {}\n')
      await writeFile(gatePath, 'export const gate = true\n')
      await writeFile(uiPath, 'export const AboutTab = null\n')
      await writeFile(runbookPath, '# Release\n')
      await execFileAsync('git', ['add', '.'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'published D3 source'], {
        cwd: repository
      })
      const publicationSourceCommit = await gitHead(repository)

      const renamedPath = join(docsDir, 'capture-recovery-history.rs')
      await rename(recoveryPath, renamedPath)
      await rm(gatePath)
      await writeFile(uiPath, 'export const AboutTab = "updated"\n')
      await writeFile(runbookPath, '# Release\n\nUpdated after D3.\n')
      await execFileAsync('git', ['add', '-A'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'later release'], {
        cwd: repository
      })

      const changedPaths = await captureDecayD3CommittedChangedPaths({
        fromCommit: publicationSourceCommit,
        repoRoot: repository
      })
      assert.deepEqual(changedPaths.sort(), [
        'apps/desktop/src/renderer/src/components/ui/button.tsx',
        'crates/videorc-backend/src/capture_recovery.rs',
        'docs/releases/capture-recovery-history.rs',
        'docs/releases/release-runbook.md',
        'scripts/smoke-capture-decay-soak.mjs'
      ])
      assert.deepEqual(captureDecayD3SensitiveChangedPaths(changedPaths), [
        'crates/videorc-backend/src/capture_recovery.rs',
        'scripts/smoke-capture-decay-soak.mjs'
      ])
      assert.throws(
        () =>
          assertCaptureDecayD3SatisfiedSourceState({
            changedPaths,
            publicationSourceIsAncestor: true
          }),
        (error) => error?.code === 'satisfied-sensitive-source-diff'
      )
    })
  })

  it('allows only the desktop package version field to change after D3 publication', async () => {
    await withGitRepository(async (repository) => {
      const desktopDirectory = join(repository, 'apps/desktop')
      const packagePath = join(desktopDirectory, 'package.json')
      await mkdir(desktopDirectory, { recursive: true })
      await writeFile(
        packagePath,
        `${JSON.stringify({ name: '@videorc/desktop', version: '1.0.0', scripts: { build: 'vite' } }, null, 2)}\n`
      )
      await execFileAsync('git', ['add', '.'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'published D3 package'], {
        cwd: repository
      })
      const publicationSourceCommit = await gitHead(repository)

      await writeFile(
        packagePath,
        `${JSON.stringify({ name: '@videorc/desktop', version: '1.0.1', scripts: { build: 'vite' } }, null, 2)}\n`
      )
      await execFileAsync('git', ['add', '.'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'bump release version'], {
        cwd: repository
      })
      assert.equal(
        await captureDecayD3DesktopPackageVersionOnlyChange({
          fromCommit: publicationSourceCommit,
          repoRoot: repository
        }),
        true
      )
      const versionChangedPaths = await captureDecayD3CommittedChangedPaths({
        fromCommit: publicationSourceCommit,
        repoRoot: repository
      })
      assert.deepEqual(
        captureDecayD3SensitiveChangedPaths(versionChangedPaths, {
          desktopPackageVersionOnlyChange: true
        }),
        []
      )

      await writeFile(
        packagePath,
        `${JSON.stringify({ name: '@videorc/desktop', version: '1.0.2', scripts: { build: 'vite --mode changed' } }, null, 2)}\n`
      )
      await execFileAsync('git', ['add', '.'], { cwd: repository })
      await execFileAsync('git', ['commit', '--quiet', '-m', 'change build behavior'], {
        cwd: repository
      })
      assert.equal(
        await captureDecayD3DesktopPackageVersionOnlyChange({
          fromCommit: publicationSourceCommit,
          repoRoot: repository
        }),
        false
      )
      assert.deepEqual(
        captureDecayD3SensitiveChangedPaths(
          await captureDecayD3CommittedChangedPaths({
            fromCommit: publicationSourceCommit,
            repoRoot: repository
          })
        ),
        ['apps/desktop/package.json']
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
