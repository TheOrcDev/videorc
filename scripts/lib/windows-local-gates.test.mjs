import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertInstalledWindowsCandidateIdentity,
  assertWindowsCandidateBindingUnchanged,
  assertWindowsCandidatePayloadIdentity,
  assertWindowsCandidatePayloadsIdentical,
  assertWindowsCandidateVerificationUnchanged,
  assertWindowsPackagedPayloadPaths,
  assertWindowsReleaseCandidateArtifactIdentity,
  assertSafeSevenZipArchiveEntries,
  buildWindowsLocalGateSteps,
  classifyWindowsLocalGateStepExit,
  createWindowsLocalGateManifest,
  evaluateWindowsLocalGateHost,
  formatWindowsLocalGatePlan,
  extractWindowsInstallerPayloadIdentity,
  inspectCanonicalWindowsReleaseCandidate,
  parseSevenZipTechnicalListing,
  revalidateInstalledWindowsCandidate,
  resolveBundledSevenZipPath,
  sanitizeWindowsLocalGateChildEnvironment,
  verifyInstalledWindowsCandidate,
  windowsCandidateBoundEnvironment,
  windowsLocalGateStepCandidateExecutable,
  windowsSupportBundleVerifierCommand,
  windowsLocalGateManifestPath,
  windowsLocalGateOutputDir
} from './windows-local-gates.mjs'
import {
  packagedAppPayloadManifestSha256,
  WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS
} from './performance-contract.mjs'
import { WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS } from './windows-d3d11-media.mjs'

// resolve() emits platform separators, so path assertions must not hardcode
// '/' — these tests run on both macOS and Windows boxes.
function posixPath(value) {
  return value.replaceAll('\\', '/')
}

describe('evaluateWindowsLocalGateHost', () => {
  it('accepts Windows 11 x64 hosts', () => {
    const result = evaluateWindowsLocalGateHost({
      platform: 'win32',
      arch: 'x64',
      release: '10.0.22631'
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.failures, [])
  })

  it('blocks non-Windows and old Windows hosts explicitly', () => {
    assert.match(
      evaluateWindowsLocalGateHost({ platform: 'darwin', arch: 'arm64' }).failures.join('\n'),
      /requires Windows 11 x64/
    )
    assert.match(
      evaluateWindowsLocalGateHost({
        platform: 'win32',
        arch: 'x64',
        release: '10.0.19045'
      }).failures.join('\n'),
      /requires Windows 11 build 22000/
    )
  })

  it('cannot use the unsupported-host escape hatch for an unknown release build', () => {
    const result = evaluateWindowsLocalGateHost({
      allowUnsupportedBuild: true,
      arch: 'x64',
      platform: 'win32',
      release: 'unknown',
      requireKnownBuild: true
    })
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /parseable Windows build number/)
  })
})

describe('sanitizeWindowsLocalGateChildEnvironment', () => {
  it('removes release, signing, and pilot credentials from every child process', () => {
    const inheritedSelection = Object.fromEntries(
      WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS.map((name) => [name, 'ambient-selection'])
    )
    assert.deepEqual(
      sanitizeWindowsLocalGateChildEnvironment({
        AZURE_CLIENT_SECRET: 'secret',
        VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'secret',
        VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'secret',
        VIDEORC_WINDOWS_SIGNING_ACCOUNT_NAME: 'secret',
        VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256: 'untrusted-app-digest',
        VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256: 'untrusted-payload-digest',
        ...inheritedSelection,
        VIDEORC_RELEASE_ID: '0.9.45-alpha.1',
        PATH: 'safe'
      }),
      { VIDEORC_RELEASE_ID: '0.9.45-alpha.1', PATH: 'safe' }
    )
  })
})

describe('Windows candidate payload binding', () => {
  const executableSha256 = 'a'.repeat(64)
  const components = WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.map((relativePath, index) => {
    const sha256 = index === 0 ? executableSha256 : String(index + 1).repeat(64)
    return {
      relativePath,
      sha256,
      identityKind: 'sha256',
      identity: sha256
    }
  })
  const payloadSpecs = WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.map((relativePath) => ({
    relativePath,
    requiresCodeSignature: false
  }))
  const packagePayload = {
    root: 'C:/Program Files/Videorc',
    algorithm: 'sha256-packaged-code-manifest-v1',
    sha256: packagedAppPayloadManifestSha256(components, { payloadSpecs }),
    components,
    unsignedComponents: []
  }
  const stagedPackagePayload = {
    ...packagePayload,
    root: '/repo/apps/desktop/release/win-unpacked'
  }
  const installedPackagePayload = { ...packagePayload, root: '/installed' }
  const installerPackagePayload = { ...packagePayload, root: '$PLUGINSDIR/app-64.7z' }
  const installerSha256 = 'b'.repeat(64)
  const publisher = 'Videorc, Inc.'
  const signature = { status: 'Valid', publisher, timestampPresent: true }
  const manifest = {
    acceptanceRecordUrl: null,
    acceptanceStatus: 'pending',
    architecture: 'x64',
    bundleVersion: '0.9.45',
    channel: 'alpha',
    displayVersion: '0.9.45 alpha 1',
    filename: 'Videorc-0.9.45-win-x64.exe',
    knownIssuesUrl: 'https://www.videorc.com/windows-alpha',
    minimumOS: 'Windows 11 or later',
    minimumWindows: 'Windows 11 or later',
    objectKey: 'releases/windows/0.9.45-alpha.1/Videorc-0.9.45-win-x64.exe',
    platform: 'windows',
    product: 'Videorc',
    publisherName: publisher,
    releaseId: '0.9.45-alpha.1',
    releasedAt: '2026-07-18T00:00:00.000Z',
    releaseNotesUrl: 'https://www.videorc.com/releases/0.9.45-alpha.1',
    sha256: installerSha256,
    signingStatus: 'signed',
    sizeBytes: 1234,
    sourceCommit: 'a'.repeat(40)
  }
  const releaseCandidate = {
    releaseDirectory: '/repo/apps/desktop/release',
    manifestPath: '/repo/apps/desktop/release/release.json',
    manifestSha256: 'c'.repeat(64),
    manifest,
    installerPath: '/repo/apps/desktop/release/Videorc-0.9.45-win-x64.exe',
    installerSha256,
    installerSizeBytes: manifest.sizeBytes,
    installerSignature: signature,
    installerPayloadArchiveRelativePath: '$PLUGINSDIR/app-64.7z',
    installerPayloadArchiveSha256: 'd'.repeat(64),
    installerPackagePayload,
    stagedExecutablePath: '/repo/apps/desktop/release/win-unpacked/Videorc.exe',
    stagedExecutableSha256: executableSha256,
    stagedExecutableSignature: signature,
    stagedPackagePayload
  }

  it('creates child digest inputs only from a complete verified packaged payload', () => {
    assert.equal(assertWindowsCandidatePayloadIdentity(packagePayload), packagePayload)
    assert.deepEqual(windowsCandidateBoundEnvironment({ executableSha256, packagePayload }), {
      VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256: executableSha256,
      VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256: packagePayload.sha256
    })
  })

  it('rejects missing components, mixed executable identity, and uppercase digests', () => {
    assert.throws(
      () =>
        assertWindowsCandidatePayloadIdentity({
          ...packagePayload,
          components: packagePayload.components.slice(0, -1)
        }),
      /every required file/
    )
    assert.throws(
      () =>
        windowsCandidateBoundEnvironment({
          executableSha256: 'b'.repeat(64),
          packagePayload
        }),
      /did not match the executable/
    )
    assert.throws(
      () =>
        assertWindowsCandidatePayloadIdentity({
          ...packagePayload,
          sha256: packagePayload.sha256.toUpperCase()
        }),
      /valid lowercase/
    )
  })

  it('opens the canonical release manifest, installer, staged app, and staged payload bytes', async () => {
    const inspectedPaths = []
    const inspected = await inspectCanonicalWindowsReleaseCandidate({
      repoRoot: '/repo',
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit,
      installerSha256,
      expectedAppSha256: executableSha256,
      expectedPayloadSha256: packagePayload.sha256,
      expectedPublisher: publisher,
      platform: 'win32',
      readManifest: async () => Buffer.from(JSON.stringify(manifest)),
      inspectArtifactPath: async (path) => inspectedPaths.push(posixPath(path)),
      hashInstaller: async (path) => {
        assert.match(posixPath(path), /apps\/desktop\/release\/Videorc-0\.9\.45-win-x64\.exe$/)
        return installerSha256
      },
      inspectInstallerSignature: async () => signature,
      hashStagedExecutable: async (path) => {
        assert.match(posixPath(path), /apps\/desktop\/release\/win-unpacked\/Videorc\.exe$/)
        return executableSha256
      },
      inspectStagedExecutableSignature: async () => signature,
      inspectStagedPayload: async () => stagedPackagePayload,
      extractInstallerPayload: async () => ({
        archiveRelativePath: '$PLUGINSDIR/app-64.7z',
        archiveSha256: 'd'.repeat(64),
        packagePayload: installerPackagePayload
      }),
      readArtifactMetadata: async () => ({ size: manifest.sizeBytes })
    })

    assert.equal(inspected.installerSha256, installerSha256)
    assert.equal(inspected.stagedExecutableSha256, executableSha256)
    assert.equal(inspected.stagedPackagePayload.sha256, packagePayload.sha256)
    assert.deepEqual(
      inspectedPaths,
      [
        'apps/desktop/release/release.json',
        'apps/desktop/release/Videorc-0.9.45-win-x64.exe',
        'apps/desktop/release/win-unpacked/Videorc.exe',
        'apps/desktop/release/win-unpacked/resources/app.asar',
        'apps/desktop/release/win-unpacked/resources/videorc-backend.exe',
        'apps/desktop/release/win-unpacked/resources/ffmpeg/bin/ffmpeg.exe',
        'apps/desktop/release/win-unpacked/resources/ffmpeg/bin/ffprobe.exe'
      ].map((path) => posixPath(resolve('/repo', path)))
    )

    await assert.rejects(
      inspectCanonicalWindowsReleaseCandidate({
        repoRoot: '/repo',
        releaseId: manifest.releaseId,
        sourceCommit: manifest.sourceCommit,
        installerSha256,
        expectedAppSha256: executableSha256,
        expectedPayloadSha256: packagePayload.sha256,
        expectedPublisher: publisher,
        platform: 'win32',
        readManifest: async () => Buffer.from(JSON.stringify(manifest)),
        inspectArtifactPath: async () => undefined,
        hashInstaller: async () => 'f'.repeat(64),
        inspectInstallerSignature: async () => signature,
        hashStagedExecutable: async () => executableSha256,
        inspectStagedExecutableSignature: async () => signature,
        inspectStagedPayload: async () => stagedPackagePayload,
        extractInstallerPayload: async () => ({
          archiveRelativePath: '$PLUGINSDIR/app-64.7z',
          archiveSha256: 'd'.repeat(64),
          packagePayload: installerPackagePayload
        }),
        readArtifactMetadata: async () => ({ size: manifest.sizeBytes })
      }),
      /installer bytes did not match release\.json/
    )

    let extractionAttempted = false
    await assert.rejects(
      inspectCanonicalWindowsReleaseCandidate({
        repoRoot: '/repo',
        releaseId: manifest.releaseId,
        sourceCommit: manifest.sourceCommit,
        installerSha256,
        expectedAppSha256: executableSha256,
        expectedPayloadSha256: packagePayload.sha256,
        expectedPublisher: publisher,
        platform: 'win32',
        readManifest: async () => Buffer.from(JSON.stringify(manifest)),
        inspectArtifactPath: async () => undefined,
        hashInstaller: async () => installerSha256,
        inspectInstallerSignature: async () => ({ ...signature, status: 'NotSigned' }),
        hashStagedExecutable: async () => executableSha256,
        inspectStagedExecutableSignature: async () => signature,
        inspectStagedPayload: async () => stagedPackagePayload,
        extractInstallerPayload: async () => {
          extractionAttempted = true
          return {
            archiveRelativePath: '$PLUGINSDIR/app-64.7z',
            archiveSha256: 'd'.repeat(64),
            packagePayload: installerPackagePayload
          }
        },
        readArtifactMetadata: async () => ({ size: manifest.sizeBytes })
      }),
      /before payload extraction Authenticode status must be Valid/
    )
    assert.equal(extractionAttempted, false)
  })

  it('extracts exactly one canonical NSIS app-64.7z payload and removes its scratch tree', async () => {
    let scratchRoot = null
    let extractionCount = 0
    let listingCount = 0
    const operations = []
    const extracted = await extractWindowsInstallerPayloadIdentity({
      installerPath: '/repo/apps/desktop/release/Videorc-0.9.45-win-x64.exe',
      repoRoot: '/repo',
      platform: 'win32',
      arch: 'x64',
      resolveSevenZipPath: async () => '/bundled/7za.exe',
      listArchive: async ({ archivePath }) => {
        listingCount += 1
        operations.push(`list:${listingCount}`)
        if (listingCount === 1) {
          assert.match(posixPath(archivePath), /Videorc-0\.9\.45-win-x64\.exe$/)
          return [
            { path: '$PLUGINSDIR\\app-64.7z', size: 13, isDirectory: false, unsafeLink: false }
          ]
        }
        assert.match(posixPath(archivePath), /\$PLUGINSDIR\/app-64\.7z$/)
        return WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.map((path) => ({
          path,
          size: 32,
          isDirectory: false,
          unsafeLink: false
        }))
      },
      extractArchive: async ({ archivePath, outputDirectory }) => {
        extractionCount += 1
        operations.push(`extract:${extractionCount}`)
        scratchRoot ??= join(outputDirectory, '..')
        if (extractionCount === 1) {
          assert.match(posixPath(archivePath), /Videorc-0\.9\.45-win-x64\.exe$/)
          await mkdir(join(outputDirectory, '$PLUGINSDIR'), { recursive: true })
          await writeFile(join(outputDirectory, '$PLUGINSDIR', 'app-64.7z'), 'inner archive')
          return
        }
        assert.match(posixPath(archivePath), /\$PLUGINSDIR\/app-64\.7z$/)
        for (const [index, relativePath] of WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.entries()) {
          const path = join(outputDirectory, relativePath)
          await mkdir(join(path, '..'), { recursive: true })
          await writeFile(path, `installer-component-${index}`)
        }
      }
    })

    assert.equal(extractionCount, 2)
    assert.equal(listingCount, 2)
    assert.deepEqual(operations, ['list:1', 'extract:1', 'list:2', 'extract:2'])
    assert.equal(extracted.archiveRelativePath, '$PLUGINSDIR/app-64.7z')
    assert.match(extracted.archiveSha256, /^[a-f0-9]{64}$/)
    assert.equal(extracted.packagePayload.root, '$PLUGINSDIR/app-64.7z')
    assert.equal(extracted.packagePayload.components.length, 5)
    await assert.rejects(stat(scratchRoot), /ENOENT/)
  })

  it('rejects duplicate, unsafe, and oversized archive listings before extraction', async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'videorc-nsis-duplicate-list-'))
    let extracted = false
    await assert.rejects(
      extractWindowsInstallerPayloadIdentity({
        installerPath: '/repo/apps/desktop/release/Videorc-0.9.45-win-x64.exe',
        repoRoot: '/repo',
        platform: 'win32',
        arch: 'x64',
        makeTemporaryDirectory: async () => scratchRoot,
        resolveSevenZipPath: async () => '/bundled/7za.exe',
        listArchive: async () => [
          { path: '$PLUGINSDIR\\app-64.7z', size: 13, isDirectory: false },
          { path: '$pluginsdir/app-64.7z', size: 13, isDirectory: false }
        ],
        extractArchive: async () => {
          extracted = true
        }
      }),
      /duplicate normalized path/
    )
    assert.equal(extracted, false)
    await assert.rejects(stat(scratchRoot), /ENOENT/)

    const innerScratchRoot = await mkdtemp(join(tmpdir(), 'videorc-nsis-unsafe-inner-list-'))
    let listingCount = 0
    let extractionCount = 0
    await assert.rejects(
      extractWindowsInstallerPayloadIdentity({
        installerPath: '/repo/apps/desktop/release/Videorc-0.9.45-win-x64.exe',
        repoRoot: '/repo',
        platform: 'win32',
        arch: 'x64',
        makeTemporaryDirectory: async () => innerScratchRoot,
        resolveSevenZipPath: async () => '/bundled/7za.exe',
        listArchive: async () => {
          listingCount += 1
          return listingCount === 1
            ? [{ path: '$PLUGINSDIR\\app-64.7z', size: 13, isDirectory: false }]
            : [{ path: 'resources/CON.txt', size: 1, isDirectory: false }]
        },
        extractArchive: async ({ outputDirectory }) => {
          extractionCount += 1
          await mkdir(join(outputDirectory, '$PLUGINSDIR'), { recursive: true })
          await writeFile(join(outputDirectory, '$PLUGINSDIR', 'app-64.7z'), 'inner archive')
        }
      }),
      /unsafe normalized path/
    )
    assert.equal(listingCount, 2)
    assert.equal(extractionCount, 1, 'unsafe inner listing must fail before inner extraction')
    await assert.rejects(stat(innerScratchRoot), /ENOENT/)

    assert.throws(
      () =>
        parseSevenZipTechnicalListing(
          ['Path = ..\\outside.exe', 'Size = 1', 'Folder = -'].join('\n'),
          { label: 'unsafe fixture' }
        ),
      /unsafe normalized path/
    )
    for (const path of ['resources/CON.txt', 'resources/question?.dll']) {
      assert.throws(
        () =>
          assertSafeSevenZipArchiveEntries([{ path, size: 1, isDirectory: false }], {
            label: 'Windows filename fixture'
          }),
        /unsafe normalized path/
      )
    }
    assert.throws(
      () =>
        assertSafeSevenZipArchiveEntries(
          [{ path: 'large.bin', size: 4 * 1024 * 1024 * 1024 + 1, isDirectory: false }],
          { label: 'oversized fixture' }
        ),
      /oversized entry/
    )
  })

  it('cleans scratch state when validation immediately after mkdtemp fails', async () => {
    let cleaned = null
    await assert.rejects(
      extractWindowsInstallerPayloadIdentity({
        installerPath: '/repo/apps/desktop/release/Videorc-0.9.45-win-x64.exe',
        repoRoot: '/repo',
        platform: 'win32',
        arch: 'x64',
        makeTemporaryDirectory: async () => 'relative-scratch',
        removeTemporaryDirectory: async (path) => {
          cleaned = path
        }
      }),
      /temporary directory must be absolute/
    )
    assert.equal(cleaned, 'relative-scratch')
  })

  it('rejects dependency resolution that escapes to an ancestor node_modules tree', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'videorc-sevenzip-repo-'))
    const ancestorRoot = await mkdtemp(join(tmpdir(), 'videorc-sevenzip-ancestor-'))
    const ancestorPackage = join(ancestorRoot, 'node_modules', 'electron-builder', 'package.json')
    try {
      await mkdir(join(repoRoot, 'node_modules'), { recursive: true })
      await mkdir(join(ancestorPackage, '..'), { recursive: true })
      await writeFile(ancestorPackage, '{}')
      await assert.rejects(
        resolveBundledSevenZipPath({
          repoRoot,
          platform: 'win32',
          arch: 'x64',
          createRequireFrom: () => ({ resolve: () => ancestorPackage })
        }),
        /outside this repository's dependency tree/
      )
    } finally {
      await Promise.all([
        rm(repoRoot, { recursive: true, force: true }),
        rm(ancestorRoot, { recursive: true, force: true })
      ])
    }
  })

  it('resolves only the pinned repository-local 7zip-bin Windows executable', async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const executable = await resolveBundledSevenZipPath({
      repoRoot,
      platform: 'win32',
      arch: 'x64'
    })
    assert.match(posixPath(executable), /\/node_modules\/\.pnpm\/7zip-bin@5\.2\.0\//)
    assert.match(posixPath(executable), /\/7zip-bin\/win\/x64\/7za\.exe$/)
  })

  it('rejects a signed installer A paired with staged payload B', () => {
    const mixedComponents = stagedPackagePayload.components.map((component, index) => {
      if (index !== 1) return component
      const sha256 = 'e'.repeat(64)
      return { ...component, sha256, identity: sha256 }
    })
    const payloadB = {
      ...stagedPackagePayload,
      components: mixedComponents,
      sha256: packagedAppPayloadManifestSha256(mixedComponents, { payloadSpecs })
    }
    assert.throws(
      () =>
        assertWindowsReleaseCandidateArtifactIdentity(
          { ...releaseCandidate, stagedPackagePayload: payloadB },
          {
            repoRoot: '/repo',
            releaseId: manifest.releaseId,
            sourceCommit: manifest.sourceCommit,
            installerSha256,
            expectedAppSha256: executableSha256,
            expectedPayloadSha256: payloadB.sha256,
            expectedPublisher: publisher,
            platform: 'win32'
          }
        ),
      /NSIS installer and staged candidate.*component-for-component/
    )
  })

  it('rejects an installed payload component reached through a symlink or junction', async () => {
    const installedRoot = await mkdtemp(join(tmpdir(), 'videorc-installed-payload-'))
    const externalRoot = await mkdtemp(join(tmpdir(), 'videorc-external-payload-'))
    const externalResources = join(externalRoot, 'resources')
    try {
      await writeFile(join(installedRoot, 'Videorc.exe'), 'installed app')
      for (const relativePath of WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.slice(1)) {
        const path = join(externalResources, relativePath.slice('resources/'.length))
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, relativePath)
      }
      await symlink(
        externalResources,
        join(installedRoot, 'resources'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      await assert.rejects(
        assertWindowsPackagedPayloadPaths(join(installedRoot, 'Videorc.exe')),
        /alias or junction/
      )
    } finally {
      await Promise.all([
        rm(installedRoot, { recursive: true, force: true }),
        rm(externalRoot, { recursive: true, force: true })
      ])
    }
  })

  it('rejects a candidate payload that changes between parent-gate steps', () => {
    const expected = { executableSha256, packagePayload }
    assert.equal(
      assertWindowsCandidateBindingUnchanged(expected, {
        executableSha256,
        packagePayload
      }),
      expected
    )

    const changedComponents = packagePayload.components.map((component, index) => {
      if (index !== 1) return component
      const sha256 = 'e'.repeat(64)
      return { ...component, sha256, identity: sha256 }
    })
    const changedPackagePayload = {
      ...packagePayload,
      components: changedComponents,
      sha256: packagedAppPayloadManifestSha256(changedComponents, { payloadSpecs })
    }
    assert.throws(
      () =>
        assertWindowsCandidateBindingUnchanged(expected, {
          executableSha256,
          packagePayload: changedPackagePayload
        }),
      /payload changed/
    )
  })

  it('locates only candidate-bound local-gate steps', () => {
    const steps = buildWindowsLocalGateSteps({ repoRoot: 'C:/repo' })
    assert.match(
      posixPath(
        windowsLocalGateStepCandidateExecutable(
          steps.find(
            (step) => step.label === 'protected physical Windows RTMP matrix (automatic default)'
          )
        )
      ),
      /win-unpacked\/Videorc\.exe$/
    )
    assert.equal(
      windowsLocalGateStepCandidateExecutable(
        steps.find((step) => step.label === 'strict Windows support-bundle verification')
      ),
      null
    )
  })

  it('admits only a clean source-bound registered NSIS candidate with attested payload bytes', async () => {
    const env = {
      VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED: '1',
      VIDEORC_RELEASE_ID: '0.9.45-alpha.1',
      VIDEORC_RELEASE_SOURCE_COMMIT: 'a'.repeat(40),
      VIDEORC_RELEASE_EXPECTED_SHA256: 'b'.repeat(64),
      VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256: executableSha256,
      VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256: packagePayload.sha256,
      VIDEORC_WINDOWS_PUBLISHER_NAME: 'Videorc, Inc.'
    }
    const inspectFacts = async () => ({
      signature: { status: 'Valid', publisher: 'Videorc, Inc.', timestampPresent: true },
      productVersion: '0.9.45.0',
      registration: {
        matched: true,
        scope: 'HKCU',
        displayName: 'Videorc',
        displayVersion: '0.9.45',
        uninstallCommandPresent: true,
        uninstallerSignature: {
          status: 'Valid',
          publisher: 'Videorc, Inc.',
          timestampPresent: true
        }
      }
    })
    const verify = (overrides = {}) =>
      verifyInstalledWindowsCandidate({
        executablePath: '/installed/Videorc.exe',
        repoRoot: '/repo',
        env,
        platform: 'win32',
        inspectFacts,
        hashExecutable: async () => executableSha256,
        inspectPayload: async () => installedPackagePayload,
        inspectPayloadPaths: async () => '/installed',
        inspectExecutablePath: async (path) => path,
        inspectGit: async () => ({ head: env.VIDEORC_RELEASE_SOURCE_COMMIT, status: '' }),
        inspectReleaseCandidate: async () => releaseCandidate,
        ...overrides
      })

    const verified = await verify()
    assert.equal(verified.executableSha256, executableSha256)
    assert.equal(verified.packagePayload.sha256, packagePayload.sha256)
    assert.equal(verified.releaseCandidate.installerSha256, installerSha256)
    assert.equal(verified.git.clean, true)
    const allowedPostBuildChanges = [
      'docs/acceptance/windows-d3d11-performance-budget.json',
      'docs/acceptance/2026-07-30-windows-d3d11-media.md',
      'docs/adr/0001-obs-parity-native-capture-architecture.md',
      'docs/windows-dev-loop.md',
      'docs/windows-port-plan.md',
      'docs/acceptance/windows-app-acceptance-template.md',
      'plans/040-windows-d3d11-shared-texture-media-path.md',
      'plans/README.md'
    ]
    const verifiedAfterReview = await verify({
      inspectGit: async () => ({
        head: env.VIDEORC_RELEASE_SOURCE_COMMIT,
        changedPaths: allowedPostBuildChanges
      })
    })
    assert.equal(verifiedAfterReview.git.clean, false)
    assert.deepEqual(
      verifiedAfterReview.git.allowedPostBuildChanges,
      [...allowedPostBuildChanges].sort()
    )
    await assert.rejects(
      verify({ inspectGit: async () => ({ head: 'f'.repeat(40), status: '' }) }),
      /did not match.*HEAD/
    )
    await assert.rejects(
      verify({
        inspectGit: async () => ({ head: env.VIDEORC_RELEASE_SOURCE_COMMIT, status: ' M app' })
      }),
      /outside the Plan 040 documentation allowlist/
    )
    await assert.rejects(
      verify({
        inspectGit: async () => ({
          head: env.VIDEORC_RELEASE_SOURCE_COMMIT,
          changedPaths: ['scripts/smoke-windows-d3d11-media.mjs']
        })
      }),
      /outside the Plan 040 documentation allowlist/
    )
    await assert.rejects(
      verify({ hashExecutable: async () => 'f'.repeat(64) }),
      /does not match the verified private candidate/
    )
    await assert.rejects(
      verify({
        inspectExecutablePath: async () => {
          throw new Error('installed candidate executable path must not traverse an alias')
        }
      }),
      /must not traverse an alias/
    )
    await assert.rejects(
      verify({
        env: { ...env, VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256: 'f'.repeat(64) }
      }),
      /payload.*did not match/
    )
    await assert.rejects(
      verify({
        inspectFacts: async () => ({ ...(await inspectFacts()), registration: { matched: false } })
      }),
      /registered Videorc NSIS install/
    )
    await assert.rejects(
      verify({
        inspectReleaseCandidate: async () => ({
          ...releaseCandidate,
          installerSha256: 'f'.repeat(64)
        })
      }),
      /installer bytes did not match release\.json/
    )
    const mixedComponents = packagePayload.components.map((component) => {
      if (component.relativePath !== 'resources/app.asar') return component
      const sha256 = 'e'.repeat(64)
      return { ...component, sha256, identity: sha256 }
    })
    const mixedPayloadSha256 = packagedAppPayloadManifestSha256(mixedComponents, { payloadSpecs })
    await assert.rejects(
      verify({
        env: {
          ...env,
          VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256: mixedPayloadSha256
        },
        inspectPayload: async () => ({
          ...installedPackagePayload,
          components: mixedComponents,
          sha256: mixedPayloadSha256
        }),
        inspectReleaseCandidate: async () => ({
          ...releaseCandidate,
          stagedPackagePayload: {
            ...stagedPackagePayload,
            components: mixedComponents,
            sha256: mixedPayloadSha256
          }
        })
      }),
      /NSIS installer and staged candidate.*component-for-component/
    )

    assert.equal(
      await revalidateInstalledWindowsCandidate({
        expectedCandidate: verified,
        verifyCandidate: async () => verified
      }),
      verified
    )
    const changedManifest = {
      ...verified,
      releaseCandidate: {
        ...verified.releaseCandidate,
        manifestSha256: 'f'.repeat(64)
      }
    }
    assert.throws(
      () => assertWindowsCandidateVerificationUnchanged(verified, changedManifest),
      /manifestSha256 changed/
    )
    await assert.rejects(
      revalidateInstalledWindowsCandidate({
        expectedCandidate: verified,
        verifyCandidate: async () => changedManifest
      }),
      /manifestSha256 changed/
    )
    await assert.rejects(
      revalidateInstalledWindowsCandidate({
        expectedCandidate: verified,
        repoRoot: '/repo',
        env,
        platform: 'win32',
        inspectFacts,
        hashExecutable: async () => executableSha256,
        inspectPayload: async () => installedPackagePayload,
        inspectPayloadPaths: async () => '/installed',
        inspectExecutablePath: async (path) => path,
        inspectReleaseCandidate: async () => releaseCandidate,
        inspectGit: async () => ({
          head: env.VIDEORC_RELEASE_SOURCE_COMMIT,
          changedPaths: ['scripts/smoke-windows-stream-performance.mjs']
        })
      }),
      /outside the Plan 040 documentation allowlist/
    )
  })
})

describe('assertInstalledWindowsCandidateIdentity', () => {
  const valid = {
    executablePath: 'C:/Users/test/AppData/Local/Programs/Videorc/Videorc.exe',
    releaseId: '0.9.45-alpha.1',
    sourceCommit: 'a'.repeat(40),
    installerSha256: 'b'.repeat(64),
    expectedAppSha256: 'c'.repeat(64),
    actualAppSha256: 'c'.repeat(64),
    expectedPublisher: 'Videorc, Inc.',
    signature: {
      status: 'Valid',
      publisher: 'Videorc, Inc.',
      timestampPresent: true
    },
    productVersion: '0.9.45.0',
    registration: {
      matched: true,
      scope: 'HKCU',
      displayName: 'Videorc',
      displayVersion: '0.9.45',
      uninstallCommandPresent: true,
      uninstallerSignature: {
        status: 'Valid',
        publisher: 'Videorc, Inc.',
        timestampPresent: true
      }
    }
  }

  it('returns a sanitized binding for the exact verified installed candidate', () => {
    assert.deepEqual(assertInstalledWindowsCandidateIdentity(valid), {
      verified: true,
      executableName: 'Videorc.exe',
      releaseId: '0.9.45-alpha.1',
      sourceCommit: 'a'.repeat(40),
      installerSha256: 'b'.repeat(64),
      expectedAppSha256: 'c'.repeat(64),
      actualAppSha256: 'c'.repeat(64),
      publisherName: 'Videorc, Inc.',
      signatureStatus: 'Valid',
      timestampPresent: true,
      productVersion: '0.9.45.0',
      registration: {
        matched: true,
        scope: 'HKCU',
        displayName: 'Videorc',
        displayVersion: '0.9.45',
        uninstallCommandPresent: true,
        uninstallerSignatureStatus: 'Valid',
        uninstallerTimestampPresent: true
      }
    })
  })

  it('rejects hash, signature, publisher, timestamp, and version mismatches', () => {
    for (const override of [
      { actualAppSha256: 'd'.repeat(64) },
      { signature: { ...valid.signature, status: 'NotSigned' } },
      { signature: { ...valid.signature, publisher: 'Impostor' } },
      { signature: { ...valid.signature, timestampPresent: false } },
      { releaseId: '0.9.45-alpha.2' },
      { productVersion: '0.9.44.0' },
      { registration: { ...valid.registration, matched: false } },
      { registration: { ...valid.registration, displayVersion: '0.9.44' } },
      {
        registration: {
          ...valid.registration,
          uninstallerSignature: {
            ...valid.registration.uninstallerSignature,
            publisher: 'Impostor'
          }
        }
      }
    ]) {
      assert.throws(() => assertInstalledWindowsCandidateIdentity({ ...valid, ...override }))
    }
  })
})

describe('buildWindowsLocalGateSteps', () => {
  it('includes package preflight, package build, and packaged recording smoke', () => {
    const steps = buildWindowsLocalGateSteps({ repoRoot: 'C:/repo' })
    const labels = steps.map((step) => step.label)

    assert.deepEqual(labels, [
      'desktop unit tests',
      'exact Windows D3D11 Rust test discovery and focused tests',
      'complete Windows backend test suite',
      'complete Windows backend clippy',
      'backend capture-input seam tests',
      'backend FIFO seam tests',
      'owned process lifecycle cleanup smoke',
      'build release backend',
      'fetch pinned Windows FFmpeg',
      'Windows package preflight',
      'package desktop Windows dir',
      'packaged recording and bundled-background smoke',
      'native Windows ScreenOnly D3D11 zero-copy smoke',
      'native Windows D3D11 Media Foundation encoded-bridge matrix',
      'recording-time Windows D3D11 native-preview smoke',
      'protected physical Windows RTMP matrix (forced D3D11/MF)',
      'protected physical Windows RTMP matrix (automatic default)',
      'physical Windows live microphone controls smoke',
      'strict Windows support-bundle verification'
    ])
    const packaged = steps.find(
      (step) => step.label === 'packaged recording and bundled-background smoke'
    )
    assert.deepEqual(packaged.args, ['smoke:packaged:bundled'])
    assert.match(
      posixPath(packaged.env.VIDEORC_PACKAGED_APP_EXECUTABLE),
      /C:\/repo\/apps\/desktop\/release\/win-unpacked\/Videorc\.exe$/
    )
    assert.match(
      posixPath(packaged.env.VIDEORC_SMOKE_OUTPUT_DIR),
      /C:\/repo\/docs\/acceptance\/artifacts\/windows\/\d{4}-\d{2}-\d{2}$/
    )
    assert.deepEqual(
      steps.find((step) => step.label === 'native Windows ScreenOnly D3D11 zero-copy smoke').args,
      ['smoke:windows-native-screen', '--', '--d3d11', '--require-d3d11']
    )
    assert.deepEqual(
      steps.find(
        (step) => step.label === 'native Windows D3D11 Media Foundation encoded-bridge matrix'
      ).args,
      [
        'smoke:windows-encoded-bridge',
        '--',
        '--profiles',
        '1080p30,1080p60',
        '--d3d11',
        '--require-d3d11'
      ]
    )
    assert.deepEqual(
      steps.find((step) => step.label === 'recording-time Windows D3D11 native-preview smoke').args,
      ['smoke:recording-native-preview', '--', '--d3d11', '--require-d3d11']
    )
    const forcedStreamPerformance = steps.find(
      (step) => step.label === 'protected physical Windows RTMP matrix (forced D3D11/MF)'
    )
    assert.deepEqual(forcedStreamPerformance.args, [
      'smoke:windows-stream-performance',
      '--',
      '--gate',
      '--bridge',
      'mf',
      '--require-bridge',
      '--d3d11',
      '--require-d3d11',
      '--profiles',
      '1080p30,1080p60',
      '--path-evidence',
      'forced'
    ])
    assert.equal(forcedStreamPerformance.blockedExitCode, 2)
    assert.match(
      posixPath(forcedStreamPerformance.blockedReportPath),
      /stream-performance-forced\/aggregate\.json$/
    )
    assert.match(
      posixPath(forcedStreamPerformance.env.VIDEORC_SMOKE_OUTPUT_DIR),
      /stream-performance-forced$/
    )
    const automaticStreamPerformance = steps.find(
      (step) => step.label === 'protected physical Windows RTMP matrix (automatic default)'
    )
    assert.deepEqual(automaticStreamPerformance.args, [
      'smoke:windows-stream-performance',
      '--',
      '--gate',
      '--profiles',
      '1080p30,1080p60',
      '--path-evidence',
      'default'
    ])
    assert.equal(automaticStreamPerformance.blockedExitCode, 2)
    assert.match(
      posixPath(automaticStreamPerformance.blockedReportPath),
      /stream-performance-default\/aggregate\.json$/
    )
    assert.match(
      posixPath(automaticStreamPerformance.env.VIDEORC_SMOKE_OUTPUT_DIR),
      /stream-performance-default$/
    )
    assert.doesNotMatch(automaticStreamPerformance.args.join(' '), /--bridge|--d3d11/)
    assert.deepEqual(steps.at(-2).args, ['smoke:windows-live-audio-controls'])
    assert.equal(steps.at(-2).blockedExitCode, 2)
    assert.match(
      posixPath(steps.at(-2).blockedReportPath),
      /live-audio-controls\/windows-live-audio-controls\.json$/
    )
    assert.match(
      posixPath(steps.at(-2).env.VIDEORC_WINDOWS_SUPPORT_BUNDLE_PATH),
      /C:\/repo\/docs\/acceptance\/artifacts\/windows\/\d{4}-\d{2}-\d{2}\/support-bundle\.json$/
    )
    assert.equal(steps.at(-1).command, 'pnpm')
    assert.deepEqual(steps.at(-1).args.slice(0, 3), [
      'support-bundle:verify',
      '--',
      steps.at(-2).env.VIDEORC_WINDOWS_SUPPORT_BUNDLE_PATH
    ])
    assert.equal(steps.at(-1).args.at(-1), '--windows-acceptance')
    assert.match(
      posixPath(windowsLocalGateOutputDir(steps)),
      /C:\/repo\/docs\/acceptance\/artifacts\/windows\/\d{4}-\d{2}-\d{2}$/
    )
  })

  it('preserves an explicit physical-device blocker instead of reporting a failure', () => {
    const step = buildWindowsLocalGateSteps({ repoRoot: 'C:/repo' }).find(
      (candidate) => candidate.label === 'physical Windows live microphone controls smoke'
    )

    assert.equal(classifyWindowsLocalGateStepExit(step, 0), 'passed')
    assert.equal(classifyWindowsLocalGateStepExit(step, 2), 'blocked')
    assert.equal(classifyWindowsLocalGateStepExit(step, 1), 'failed')
  })

  it('runs physical smokes against an installed signed candidate without rebuilding it', () => {
    const steps = buildWindowsLocalGateSteps({
      repoRoot: 'C:/repo',
      packagedAppExecutable: 'C:/Users/test/AppData/Local/Programs/Videorc/Videorc.exe',
      useExistingCandidate: true
    })
    const labels = steps.map((step) => step.label)

    assert.equal(labels.includes('package desktop Windows dir'), false)
    assert.equal(labels.includes('fetch pinned Windows FFmpeg'), false)
    const packaged = steps.find(
      (step) => step.label === 'packaged recording and bundled-background smoke'
    )
    assert.match(
      posixPath(packaged.env.VIDEORC_PACKAGED_APP_EXECUTABLE),
      /Programs\/Videorc\/Videorc\.exe$/
    )
    assert.match(
      posixPath(
        packaged.env.VIDEORC_SMOKE_FFMPEG_PATH ?? steps.at(-3).env.VIDEORC_SMOKE_FFMPEG_PATH
      ),
      /Programs\/Videorc\/resources\/ffmpeg\/bin\/ffmpeg\.exe$/
    )
  })

  it('allows the Windows acceptance artifact directory to be pinned', () => {
    const steps = buildWindowsLocalGateSteps({
      acceptanceDir: 'docs/acceptance/artifacts/windows/2026-07-08-lab-1',
      repoRoot: 'C:/repo'
    })

    const packaged = steps.find(
      (step) => step.label === 'packaged recording and bundled-background smoke'
    )
    assert.match(
      posixPath(packaged.env.VIDEORC_SMOKE_OUTPUT_DIR),
      /C:\/repo\/docs\/acceptance\/artifacts\/windows\/2026-07-08-lab-1$/
    )
  })

  it('formats host blockers and commands for dry-run evidence', () => {
    const report = formatWindowsLocalGatePlan({
      host: evaluateWindowsLocalGateHost({ platform: 'darwin', arch: 'arm64' }),
      steps: buildWindowsLocalGateSteps({ repoRoot: '/repo' })
    })

    assert.match(report, /windows-local-gates: plan/)
    assert.match(report, /evidence output:/)
    assert.match(report, /windows-local-gates\.manifest\.json/)
    assert.match(report, /support-bundle:verify/)
    assert.match(report, /--windows-acceptance/)
    assert.match(report, /windows-app-acceptance-template\.md/)
    assert.match(report, /\[blocked\] host: requires Windows 11 x64/)
    assert.match(report, /smoke:process-lifecycle/)
    assert.match(report, /package:preflight:windows/)
    assert.match(report, /smoke:packaged:bundled/)
    assert.match(report, /smoke:windows-native-screen/)
    assert.match(report, /smoke:windows-stream-performance/)
    assert.match(report, /smoke:recording-native-preview/)
    assert.match(report, /smoke:windows-live-audio-controls/)
    assert.match(report, /strict Windows support-bundle verification/)
  })

  it('builds an acceptance manifest with host, evidence, and command state', () => {
    const steps = buildWindowsLocalGateSteps({
      acceptanceDir: 'docs/acceptance/artifacts/windows/2026-07-08-lab-1',
      repoRoot: 'C:/repo'
    })
    const outputDir = windowsLocalGateOutputDir(steps)
    const manifest = createWindowsLocalGateManifest({
      host: evaluateWindowsLocalGateHost({
        platform: 'win32',
        arch: 'x64',
        release: '10.0.22631'
      }),
      steps,
      repoRoot: 'C:/repo',
      outputDir,
      platform: 'win32',
      arch: 'x64',
      release: '10.0.22631',
      startedAt: new Date('2026-07-08T12:00:00.000Z')
    })

    assert.equal(manifest.status, 'pending')
    assert.equal(manifest.startedAt, '2026-07-08T12:00:00.000Z')
    assert.equal(manifest.host.ok, true)
    assert.equal(manifest.host.build, 22631)
    assert.equal(manifest.candidateIdentity, null)
    assert.equal(manifest.evidence.runManifest, windowsLocalGateManifestPath({ outputDir }))
    assert.deepEqual(manifest.evidence.supportBundleVerifierCommand, [
      'pnpm',
      'support-bundle:verify',
      '--',
      join(outputDir, 'support-bundle.json'),
      '--windows-acceptance'
    ])
    assert.match(manifest.evidence.acceptanceTemplate, /windows-app-acceptance-template\.md$/)
    assert.equal(manifest.steps.length, steps.length)
    const processSmoke = manifest.steps.find(
      (step) => step.label === 'owned process lifecycle cleanup smoke'
    )
    assert.deepEqual(processSmoke.env, {
      VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'process-lifecycle')
    })

    const packagedSmoke = manifest.steps.find(
      (step) => step.label === 'packaged recording and bundled-background smoke'
    )
    assert.deepEqual(
      {
        ...packagedSmoke,
        env: {
          VIDEORC_PACKAGED_APP_EXECUTABLE: '<packaged-app>',
          VIDEORC_SMOKE_OUTPUT_DIR: '<output-dir>'
        }
      },
      {
        index: packagedSmoke.index,
        label: 'packaged recording and bundled-background smoke',
        command: 'pnpm',
        args: ['smoke:packaged:bundled'],
        env: {
          VIDEORC_PACKAGED_APP_EXECUTABLE: '<packaged-app>',
          VIDEORC_SMOKE_OUTPUT_DIR: '<output-dir>'
        },
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        error: null
      }
    )
    assert.match(
      posixPath(packagedSmoke.env.VIDEORC_PACKAGED_APP_EXECUTABLE),
      /C:\/repo\/apps\/desktop\/release\/win-unpacked\/Videorc\.exe$/
    )
    assert.equal(packagedSmoke.env.VIDEORC_SMOKE_OUTPUT_DIR, outputDir)

    const verifierStep = manifest.steps.at(-1)
    assert.equal(verifierStep.label, 'strict Windows support-bundle verification')
    assert.equal(verifierStep.command, manifest.evidence.supportBundleVerifierCommand[0])
    assert.deepEqual(verifierStep.args, manifest.evidence.supportBundleVerifierCommand.slice(1))
    assert.equal(verifierStep.status, 'pending')
  })

  it('formats the support bundle acceptance verifier command', () => {
    assert.deepEqual(windowsSupportBundleVerifierCommand(), [
      'pnpm',
      'support-bundle:verify',
      '--',
      '<support-bundle.json>',
      '--windows-acceptance'
    ])
  })
})
