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
  isAppTsPath,
  isRustReachableDesktopPath,
  isWindowsIncidentToolingPath,
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
      js: 'true',
      windows_incident_tooling: 'false',
      macos_sentinel: 'false',
      windows_js: 'false',
      windows_installer: 'false'
    })
    assert.deepEqual(scopeToActionOutputs(HEAVY_CODE_SCOPE), {
      kind: 'code',
      windows_heavy: 'true',
      linux_heavy: 'true',
      macos_rust: 'true',
      js: 'true',
      windows_incident_tooling: 'false',
      macos_sentinel: 'true',
      windows_js: 'true',
      windows_installer: 'true'
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
      { kind: CI_SCOPE_KINDS.JS_TEST, ...light, windowsJs: true }
    )
    // Any script, workflow or Rust path keeps the full gates. (App source no
    // Rust code reads is the app-ts kind on pull requests: plan 242 S15.)
    for (const extra of [
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

  it('flags a change to the Windows incident diagnostics tooling (plan 242 S5)', () => {
    for (const path of [
      '.github/workflows/windows.yml',
      'scripts/smoke-windows-stream-performance.mjs',
      'scripts/smoke-windows-mf-probe.mjs',
      'scripts/probe-windows-openh264-comparison.mjs',
      'scripts/lib/windows-incident-runner.mjs',
      'scripts/lib/windows-incident-matrix.test.mjs',
      'scripts/lib/windows-mf-probe.mjs',
      'scripts/lib/windows-openh264-comparison.mjs',
      'scripts/lib/windows-stream-performance.mjs',
      'scripts/lib/windows-owned-pcm-eof.mjs',
      'crates/videorc-backend/src/windows_mf_probe.rs'
    ]) {
      assert.equal(isWindowsIncidentToolingPath(path), true, path)
    }
    for (const path of [
      'crates/videorc-backend/src/main.rs',
      'scripts/lib/windows-local-gates.mjs',
      'apps/desktop/src/main/index.ts',
      '.github/workflows/ci.yml'
    ]) {
      assert.equal(isWindowsIncidentToolingPath(path), false, path)
    }

    const classify = (files) =>
      classifyRepositoryChangeScope({
        env: { GITHUB_EVENT_NAME: 'pull_request', CI_BASE_SHA: 'c'.repeat(40), CI_HEAD_SHA: 'd'.repeat(40) },
        gitChangedFiles: () => files
      })
    assert.equal(
      scopeToActionOutputs(classify(['crates/videorc-backend/src/main.rs'])).windows_incident_tooling,
      'false'
    )
    assert.equal(
      scopeToActionOutputs(
        classify(['crates/videorc-backend/src/main.rs', 'scripts/lib/windows-incident-runner.mjs'])
      ).windows_incident_tooling,
      'true'
    )
  })

  it('lets an app-only pull request skip the Rust jobs, and only a pull request (plan 242 S15)', () => {
    const renderer = 'apps/desktop/src/renderer/src/components/studio/session-panel.tsx'
    const pr = (files) => classifyChangeScope({ eventName: 'pull_request', files })
    const appOnly = pr([renderer, 'apps/desktop/src/renderer/src/lib/x.test.ts', 'plans/1.md'])
    assert.deepEqual(appOnly, {
      kind: CI_SCOPE_KINDS.APP_TS,
      windowsHeavy: false,
      linuxHeavy: false,
      macosRust: false,
      macosSentinel: true,
      windowsJs: true,
      windowsInstaller: false,
      js: true
    })
    assert.deepEqual(scopeToActionOutputs(appOnly), {
      kind: 'app-ts',
      windows_heavy: 'false',
      linux_heavy: 'false',
      macos_rust: 'false',
      js: 'true',
      windows_incident_tooling: 'false',
      macos_sentinel: 'true',
      windows_js: 'true',
      windows_installer: 'false'
    })
    // D7: main, preload and window entry pages still build the installer.
    for (const file of [
      'apps/desktop/src/main/index.ts',
      'apps/desktop/src/preload/index.ts',
      'apps/desktop/src/renderer/index.html'
    ]) {
      assert.equal(pr([renderer, file]).windowsInstaller, true, file)
    }
    // Rule 1 of the source prompt: main keeps the full suite.
    assert.deepEqual(classifyChangeScope({ eventName: 'push', files: [renderer] }), {
      ...HEAVY_CODE_SCOPE
    })
    // Every desktop file a Rust crate reads, and everything outside the app
    // source, keeps every gate.
    for (const extra of [
      'apps/desktop/src/renderer/src/styles.css',
      'apps/desktop/src/main/window-palette.ts',
      'apps/desktop/src/shared/backend-rpc-contract.ts',
      'apps/desktop/src/renderer/src/assets/buddy/default/idle.webp',
      'apps/desktop/package.json',
      'apps/desktop/vitest.config.ts',
      'apps/desktop/resources/buddy/manifest.json',
      'protocol-fixtures/high-risk-contracts.json',
      'crates/videorc-backend/src/main.rs',
      'scripts/lib/ci-change-scope.mjs',
      '.github/workflows/ci.yml',
      'pnpm-lock.yaml'
    ]) {
      assert.deepEqual(pr([renderer, extra]), { ...HEAVY_CODE_SCOPE }, extra)
    }
  })

  it('goes red when a Rust-read desktop file hides in an app-only diff (plan 242 S15)', () => {
    // "Hide a real change from it on purpose and confirm CI goes red": the
    // palette Rust compiles into the served pages changes inside an
    // otherwise app-only pull request; every Rust job must still run.
    const scope = classifyChangeScope({
      eventName: 'pull_request',
      files: [
        'apps/desktop/src/renderer/src/components/sidebar.tsx',
        'apps/desktop/src/main/window-palette.ts'
      ]
    })
    const outputs = scopeToActionOutputs(scope)
    assert.equal(outputs.macos_rust, 'true')
    assert.equal(outputs.windows_heavy, 'true')
    assert.equal(outputs.linux_heavy, 'true')
    assert.equal(isRustReachableDesktopPath('apps/desktop/src/main/window-palette.ts'), true)
    assert.equal(isAppTsPath('apps/desktop/src/main/window-palette.ts'), false)
  })
})
