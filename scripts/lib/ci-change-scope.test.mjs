import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyRepositoryChangeScope } from '../ci-change-scope.mjs'
import {
  CI_SCOPE_KINDS,
  HEAVY_CODE_SCOPE,
  classifyChangeScope,
  isBlankGitSha,
  isDocsPath,
  isDocsRecordPath,
  isJsTestPath,
  isVersionOnlyPackageJson,
  isVersionReleasePath,
  scopeToActionOutputs
} from './ci-change-scope.mjs'

const desktopPackage = {
  name: '@videorc/desktop',
  version: '0.13.0',
  private: true,
  scripts: { start: 'electron .' }
}

describe('ci-change-scope', () => {
  it('fails closed for dispatch, empty diffs, unsafe paths, and non-version package.json edits', () => {
    assert.deepEqual(classifyChangeScope({ eventName: 'workflow_dispatch', files: ['docs/releases/0.13.0.md'] }), {
      ...HEAVY_CODE_SCOPE
    })
    assert.deepEqual(classifyChangeScope({ eventName: 'pull_request', files: [] }), { ...HEAVY_CODE_SCOPE })
    assert.deepEqual(
      classifyChangeScope({ eventName: 'pull_request', files: ['../secret'] }),
      { ...HEAVY_CODE_SCOPE }
    )
    assert.deepEqual(
      classifyChangeScope({
        eventName: 'pull_request',
        files: ['apps/desktop/package.json'],
        packageJsonBefore: desktopPackage,
        packageJsonAfter: { ...desktopPackage, version: '0.14.0', private: false }
      }),
      { ...HEAVY_CODE_SCOPE }
    )
    assert.deepEqual(
      classifyChangeScope({
        eventName: 'pull_request',
        files: ['apps/desktop/package.json', 'crates/videorc-backend/src/lib.rs'],
        packageJsonBefore: desktopPackage,
        packageJsonAfter: { ...desktopPackage, version: '0.14.0' }
      }),
      { ...HEAVY_CODE_SCOPE }
    )
    assert.equal(isBlankGitSha('0000000000000000000000000000000000000000'), true)
    assert.equal(isBlankGitSha('d19c6b9e6eda35d3cd988ff2b74f8131db051a0e'), false)
  })

  it('classifies docs-record and version-release change sets without weakening code PRs', () => {
    assert.equal(isDocsRecordPath('docs/releases/0.13.0.md'), true)
    assert.equal(isDocsRecordPath('docs/acceptance/windows-alpha/0.13.0-alpha.1.json'), true)
    assert.equal(isDocsRecordPath('docs/acceptance/windows-app-acceptance-template.md'), false)
    assert.equal(isVersionReleasePath('changelog/0.13.0-beta.1.md'), true)
    assert.equal(isVersionReleasePath('apps/desktop/package.json'), true)
    assert.equal(isVersionReleasePath('package.json'), false)

    assert.equal(
      isVersionOnlyPackageJson(desktopPackage, { ...desktopPackage, version: '0.14.0' }),
      true
    )
    assert.equal(isVersionOnlyPackageJson(desktopPackage, desktopPackage), false)

    const docs = classifyChangeScope({
      eventName: 'pull_request',
      files: [
        'docs/releases/0.13.0.md',
        'docs/acceptance/windows-alpha/0.13.0-alpha.1.json',
        'docs/acceptance/linux-alpha/0.13.0-alpha.1.json'
      ]
    })
    assert.deepEqual(docs, {
      kind: CI_SCOPE_KINDS.DOCS_RECORD,
      windowsHeavy: false,
      linuxHeavy: false,
      macosRust: false,
      js: false
    })

    const version = classifyChangeScope({
      eventName: 'push',
      files: [
        'apps/desktop/package.json',
        'changelog/0.14.0-beta.1.md',
        'changelog/0.14.0-alpha.1.md',
        'docs/releases/0.14.0.md'
      ],
      packageJsonBefore: desktopPackage,
      packageJsonAfter: { ...desktopPackage, version: '0.14.0' }
    })
    assert.deepEqual(version, {
      kind: CI_SCOPE_KINDS.VERSION_RELEASE,
      windowsHeavy: false,
      linuxHeavy: false,
      macosRust: false,
      js: true
    })

    const changelogOnly = classifyChangeScope({
      eventName: 'pull_request',
      files: ['changelog/0.14.0-alpha.1.md']
    })
    assert.equal(changelogOnly.kind, CI_SCOPE_KINDS.VERSION_RELEASE)
    assert.equal(changelogOnly.js, true)
    assert.equal(changelogOnly.windowsHeavy, false)

    assert.deepEqual(scopeToActionOutputs(version), {
      kind: 'version-release',
      windows_heavy: 'false',
      linux_heavy: 'false',
      macos_rust: 'false',
      js: 'true'
    })
    assert.deepEqual(scopeToActionOutputs(HEAVY_CODE_SCOPE), {
      kind: 'code',
      windows_heavy: 'true',
      linux_heavy: 'true',
      macos_rust: 'true',
      js: 'true'
    })
  })

  it('lets docs-only and JS-test-only change sets skip every heavy job but keep JS', () => {
    assert.equal(isDocsPath('docs/distribution.md'), true)
    assert.equal(isDocsPath('plans/212-linux-beta-readiness.md'), true)
    assert.equal(isDocsPath('README.md'), true)
    assert.equal(isDocsPath('apps/desktop/README.md'), false)
    assert.equal(isDocsPath('crates/videorc-backend/notes.md'), false)
    assert.equal(isJsTestPath('apps/desktop/src/renderer/src/components/tabs/settings-layout.test.ts'), true)
    assert.equal(isJsTestPath('scripts/lib/ci-change-scope.test.mjs'), true)
    assert.equal(isJsTestPath('apps/desktop/src/main/index.ts'), false)
    assert.equal(isJsTestPath('crates/videorc-backend/tests/fixture.test.js'), false)
    assert.equal(isJsTestPath('.github/workflows/x.test.mjs'), false)

    const light = { windowsHeavy: false, linuxHeavy: false, macosRust: false, js: true }
    assert.deepEqual(
      classifyChangeScope({ eventName: 'pull_request', files: ['docs/distribution.md', 'README.md'] }),
      { kind: CI_SCOPE_KINDS.DOCS, ...light }
    )
    assert.deepEqual(
      classifyChangeScope({
        eventName: 'pull_request',
        files: ['apps/desktop/src/renderer/src/app-shell.test.tsx', 'plans/210-x.md']
      }),
      { kind: CI_SCOPE_KINDS.JS_TEST, ...light }
    )
    // Any app, script, workflow or Rust path keeps the full gates.
    for (const extra of [
      'apps/desktop/src/renderer/src/app-shell.tsx',
      'scripts/lib/ci-change-scope.mjs',
      '.github/workflows/ci.yml',
      'crates/videorc-backend/src/main.rs',
      'package.json',
      'pnpm-lock.yaml'
    ]) {
      assert.deepEqual(
        classifyChangeScope({ eventName: 'pull_request', files: ['docs/a.md', 'scripts/a.test.mjs', extra] }),
        { ...HEAVY_CODE_SCOPE },
        extra
      )
    }
    assert.deepEqual(
      classifyChangeScope({ eventName: 'workflow_dispatch', files: ['docs/a.md'] }),
      { ...HEAVY_CODE_SCOPE }
    )
  })

  it('reads the repository diff fail-closed and uses two-dot ranges on push', () => {
    const ranges = []
    const scope = classifyRepositoryChangeScope({
      env: {
        GITHUB_EVENT_NAME: 'push',
        CI_BASE_SHA: 'a'.repeat(40),
        CI_HEAD_SHA: 'b'.repeat(40)
      },
      gitChangedFiles: ({ range }) => {
        ranges.push(range)
        return ['apps/desktop/package.json']
      },
      readJson: (ref) =>
        ref.startsWith('a') ? desktopPackage : { ...desktopPackage, version: '0.14.0' }
    })
    assert.deepEqual(ranges, [`${'a'.repeat(40)}..${'b'.repeat(40)}`])
    assert.equal(scope.kind, CI_SCOPE_KINDS.VERSION_RELEASE)

    const blank = classifyRepositoryChangeScope({
      env: {
        GITHUB_EVENT_NAME: 'push',
        CI_BASE_SHA: '0'.repeat(40),
        CI_HEAD_SHA: 'b'.repeat(40)
      },
      gitChangedFiles: () => ['docs/releases/0.13.0.md']
    })
    assert.equal(blank.kind, CI_SCOPE_KINDS.CODE)

    const prRanges = []
    classifyRepositoryChangeScope({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        CI_BASE_SHA: 'c'.repeat(40),
        CI_HEAD_SHA: 'd'.repeat(40)
      },
      gitChangedFiles: ({ range }) => {
        prRanges.push(range)
        return ['docs/releases/0.13.0.md']
      }
    })
    assert.deepEqual(prRanges, [`${'c'.repeat(40)}...${'d'.repeat(40)}`])
  })
})
